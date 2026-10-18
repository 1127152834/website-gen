/** 持久队列编排。调度许可只在真实传输排空后释放；所有提交复核同一短SQL事务。 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAIL_TRIAGE_LIMITS, type Fence } from "../shared/mail-triage-types.ts";
import { buildTriageContext, TriageContextError, type TriageInput } from "./mail-triage-context.ts";
import {
  prepareTriageRequest,
  analyzeTriage,
  TriageAnalysisError,
  type ValidatedAssessment,
} from "./mail-triage-analyzer.ts";
import {
  preflightTriageRequest,
  TriageModelError,
  type TriageModelCaller,
  type ModelUsage,
} from "./mail-triage-model.ts";
import {
  hasReservedTriageFence,
  type JobLease,
  type TriageQueue,
  type TriageFailure,
} from "./mail-triage-queue.ts";
import type { TriageScheduler } from "./mail-triage-scheduler.ts";
import { applyAssessment, reprojectCases } from "./mail-case-projector.ts";
import { canAutoRouteNotification, getEvaluationStatus, registerNotificationAudit } from "./mail-triage-evaluation.ts";

type Row = Record<string, unknown>;
export interface TriageWorker {
  start(): void;
  wake(): void;
  abortSources(ids: string[]): void;
  stopAccepting(): void;
  close(): Promise<void>;
}
export interface TriageWorkerDeps {
  db: DatabaseSync;
  key: Buffer;
  workspaceKey: string;
  queue: TriageQueue;
  scheduler: TriageScheduler;
  callOnce: TriageModelCaller;
  clock: () => number;
  push: () => void;
  /** 与mailbox-service相同的同步deleting/closed guard；生产接线不得省略。 */
  isMailboxAvailable?: (mailboxId: number) => boolean;
}
interface GuardSnapshot {
  sources: string;
  locators: string;
  cases: Row[];
  provider: string;
}
export interface CommitContext {
  key: Buffer;
  input: TriageInput;
  clock: () => number;
  promptHash: string;
  snapshot: GuardSnapshot;
  isMailboxAvailable?: (mailboxId: number) => boolean;
}
const json = (value: unknown) => JSON.stringify(value);
function atomic<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function snapshot(db: DatabaseSync, input: TriageInput): GuardSnapshot {
  const ids = json(input.authorizedSources.map((s) => s.id));
  return {
    sources: json(
      db
        .prepare(
          "SELECT id,mailbox_id,source_hash,critical_headers_hash,source_version,state,trust FROM mail_triage_sources WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
        )
        .all(ids),
    ),
    locators: json(
      db
        .prepare(
          "SELECT a.*,s.scope_version,s.uid_validity AS scope_uid,s.state AS scope_state,s.epoch,s.baseline_uid,s.effective_at,b.status FROM mail_triage_source_aliases a JOIN mail_triage_scope s ON s.mailbox_id=a.mailbox_id JOIN mailboxes b ON b.id=a.mailbox_id WHERE a.source_id IN (SELECT value FROM json_each(?)) ORDER BY a.mailbox_id,a.folder,a.uid_validity,a.uid",
        )
        .all(ids),
    ),
    cases: db
      .prepare(
        "SELECT c.id,c.version,c.manual_version,cs.manual_locked,cs.match_basis FROM mail_application_cases c JOIN mail_case_sources cs ON cs.case_id=c.id WHERE cs.source_id=? ORDER BY c.id",
      )
      .all(input.source.id),
    provider: json(
      db
        .prepare(
          "SELECT p.id,p.config_revision,r.provider_id,r.model_id,r.thinking FROM model_providers p JOIN model_roles r ON r.provider_id=p.id WHERE r.role='mail_triage'",
        )
        .get(),
    ),
  };
}
interface ManualVectorV2 { v: 2; cases: [string, number][]; sources: [string, number][] }
function sourceManualClock(db: DatabaseSync, sourceId: string): number {
  return Number(db.prepare("SELECT COALESCE(MAX(applied_version),0) n FROM mail_case_manual_decisions WHERE case_id IS NULL AND object_id=?").get(sourceId)!.n);
}
export function buildManualVersionVector(db: DatabaseSync, input: Pick<TriageInput, "authorizedSources">, cases: Row[]): string {
  const value: ManualVectorV2 = {
    v: 2,
    cases: cases.map(c => [String(c.id), Number(c.manual_version)] as [string, number]).sort((a, b) => a[0].localeCompare(b[0], "en")),
    sources: input.authorizedSources.map(source => [source.id, sourceManualClock(db, source.id)] as [string, number]).sort((a, b) => a[0].localeCompare(b[0], "en")),
  };
  return json(value);
}
/** 只读旧case版本元数据；绝不把已移出授权上下文的正文或人工备注取回来。 */
function manualVersionsChanged(
  db: DatabaseSync,
  prior: string | null | undefined,
  input: Pick<TriageInput, "authorizedSources">,
  cases: Row[],
): boolean {
  if (prior == null) return true;
  let before: unknown;
  try {
    before = JSON.parse(prior);
  } catch {
    return true;
  }
  // 已有attempt的v1只有case向量，无法证明source人工baseline，必须fail closed。
  if (Array.isArray(before)) return true;
  if (!before || typeof before !== "object" || (before as { v?: unknown }).v !== 2) return true;
  const vector = before as Partial<ManualVectorV2>;
  if (
    !Array.isArray(vector.cases) || !Array.isArray(vector.sources) ||
    ![...vector.cases, ...vector.sources].every(
      (v) =>
        Array.isArray(v) &&
        v.length === 2 &&
        typeof v[0] === "string" &&
        Number.isSafeInteger(v[1]) &&
        v[1] >= 0,
    )
  )
    return true;
  const old = new Map<string, number>(vector.cases as [string, number][]);
  const current = new Map(
    cases.map((c) => [String(c.id), Number(c.manual_version)]),
  );
  for (const [id, version] of old) {
    const now = current.has(id)
      ? current.get(id)
      : db
          .prepare(
            "SELECT manual_version FROM mail_application_cases WHERE id=?",
          )
          .get(id)?.manual_version;
    if (now === undefined || Number(now) !== version) return true;
  }
  if ([...current].some(([id, version]) => !old.has(id) && version > 0)) return true;
  const oldSources = new Map<string, number>(vector.sources as [string, number][]);
  const currentSources = new Map(input.authorizedSources.map(source => [source.id, sourceManualClock(db, source.id)]));
  for (const [id, version] of oldSources) {
    const now = currentSources.has(id) ? currentSources.get(id) : sourceManualClock(db, id);
    if (now === undefined || now !== version) return true;
  }
  return [...currentSources].some(([id, version]) => !oldSources.has(id) && version > 0);
}
function mailboxAllowed(
  input: TriageInput,
  guard: TriageWorkerDeps["isMailboxAvailable"],
): boolean {
  return (
    !guard || input.authorizedSources.every((s) => guard(s.mailboxId) === true)
  );
}
function matchingJob(db: DatabaseSync, f: Fence, now: number): Row | undefined {
  return db
    .prepare(
      "SELECT * FROM mail_triage_jobs WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>? AND attempt_seq=? AND config_epoch=? AND source_version=? AND context_version=? AND manual_version=?",
    )
    .get(
      f.jobId,
      f.leaseToken,
      now,
      f.attemptSeq,
      f.configEpoch,
      f.sourceVersion,
      f.contextVersion,
      f.manualVersion,
    );
}
function settle(
  db: DatabaseSync,
  f: Fence,
  state: string,
  now: number,
  usage: ModelUsage | null = null,
  lastError: string | null = null,
) {
  db.prepare(
    "UPDATE mail_triage_attempts SET outcome=?,settled_at=?,usage_json=? WHERE job_id=? AND attempt_seq=? AND outcome='reserved'",
  ).run(
    state === "succeeded" || state === "needs_review"
      ? "succeeded"
      : state === "cancelled"
        ? "cancelled"
        : "failed",
    now,
    usage ? json(usage) : null,
    f.jobId,
    f.attemptSeq,
  );
  db.prepare(
    "UPDATE mail_triage_jobs SET state=?,last_error=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=? AND attempt_seq=?",
  ).run(state,lastError, now, f.jobId, f.leaseToken, f.attemptSeq);
}
function successor(db: DatabaseSync, j: Row, fresh: TriageInput, now: number) {
  if (Number(j.generation) >= 3) return;
  const t = fresh.tuple;
  db.prepare(
    `INSERT OR IGNORE INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,generation,config_epoch,priority,manual_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(),
    fresh.source.id,
    fresh.sourceVersion,
    t.providerId,
    t.modelId,
    t.modelConfigRevision,
    t.promptVersion,
    t.ruleVersion,
    t.schemaVersion,
    fresh.contextVersion,
    Number(j.generation) + 1,
    fresh.configEpoch,
    Number(j.priority),
    fresh.manualVersion,
    now,
    now,
  );
}
/** 缺少进程内可信上下文快照时fail closed；不接受模型构造的版本或hash作为授权。 */
export function commitAssessment(
  db: DatabaseSync,
  fence: Fence,
  assessment: ValidatedAssessment,
  context?: CommitContext,
): "applied" | "stale" | "cancelled" | "manual_reproject" | import("./mail-triage-context.ts").TriageContextErrorCode {
  if (!context) return "stale";
  return atomic(db, () => {
    const c = context,
      now = c.clock();
    const existing = db
      .prepare("SELECT state FROM mail_triage_jobs WHERE id=?")
      .get(fence.jobId);
    if (existing?.state === "cancelled") {
      db.prepare(
        "UPDATE mail_triage_attempts SET usage_json=? WHERE job_id=? AND attempt_seq=?",
      ).run(
        assessment.usage ? json(assessment.usage) : null,
        fence.jobId,
        fence.attemptSeq,
      );
      return "cancelled";
    }
    const j = matchingJob(db, fence, now);
    if (!j) return "stale";
    const cfg = db
      .prepare("SELECT * FROM mail_triage_settings WHERE id=1")
      .get()!;
    const purpose=db.prepare("SELECT 1 FROM model_roles r JOIN model_providers p ON p.id=r.provider_id WHERE r.role='mail_triage' AND r.model_id<>''").get();
    if(!purpose){
      settle(db,fence,"blocked_config",now,assessment.usage,"missing_purpose");
      db.prepare("UPDATE mail_triage_settings SET state='blocked_config' WHERE id=1 AND enabled=1 AND config_epoch=?").run(fence.configEpoch);
      return "missing_purpose";
    }
    if (
      j.source_id !== c.input.source.id ||
      c.input.contextVersion !== fence.contextVersion ||
      !hasReservedTriageFence(db, fence, now) ||
      cfg.enabled !== 1 ||
      !["enabled", "paused_budget"].includes(String(cfg.state)) ||
      cfg.config_epoch !== fence.configEpoch ||
      !mailboxAllowed(c.input, c.isMailboxAvailable)
    ) {
      settle(db, fence, "stale_source", now, assessment.usage);
      return "stale";
    }
    if(cfg.model_config_revision!==c.input.tuple.modelConfigRevision){
      settle(db,fence,"blocked_config",now,assessment.usage,"missing_purpose");
      db.prepare("UPDATE mail_triage_settings SET state='blocked_config' WHERE id=1 AND enabled=1 AND config_epoch=?").run(fence.configEpoch);
      return "missing_purpose";
    }
    const actual = snapshot(db, c.input);
    const primary = db
      .prepare(
        "SELECT source_hash,source_version,state FROM mail_triage_sources WHERE id=?",
      )
      .get(c.input.source.id);
    const oldSources = JSON.parse(c.snapshot.sources) as Row[];
    const oldPrimary = oldSources.find((s) => s.id === c.input.source.id);
    if (
      !primary ||
      primary.state !== "active" ||
      primary.source_version !== fence.sourceVersion ||
      primary.source_hash !== oldPrimary?.source_hash
    ) {
      settle(db, fence, "stale_source", now, assessment.usage);
      return "stale";
    }
    if(actual.provider!==c.snapshot.provider){
      settle(db,fence,"blocked_config",now,assessment.usage,"missing_purpose");
      db.prepare("UPDATE mail_triage_settings SET state='blocked_config' WHERE id=1 AND enabled=1 AND config_epoch=?").run(fence.configEpoch);
      return "missing_purpose";
    }
    // Exact locator generations cannot be relaxed into a context successor.
    const aliases = (raw: string) =>
      (JSON.parse(raw) as Row[]).map(({ scope_version, ...r }) => r);
    if (json(aliases(actual.locators)) !== json(aliases(c.snapshot.locators))) {
      settle(db, fence, "stale_source", now, assessment.usage);
      return "stale";
    }
    for (const [column, key] of [
      ["provider_id", "providerId"],
      ["model_id", "modelId"],
      ["model_config_revision", "modelConfigRevision"],
      ["prompt_version", "promptVersion"],
      ["rule_version", "ruleVersion"],
      ["schema_version", "schemaVersion"],
    ] as const) {
      if (j[column] !== c.input.tuple[key]) {
        settle(db,fence,"failed",now,assessment.usage,"context_integrity");
        return "context_integrity";
      }
    }
    const manualChanged = manualVersionsChanged(
      db,
      String(j.manual_versions_json ?? ""),
      c.input,
      actual.cases,
    );
    if (manualChanged) {
      reprojectCases(db, {
        caseIds: actual.cases.map((row) => String(row.id)),
        now,
      });
      settle(db, fence, "needs_review", now, assessment.usage);
      return "manual_reproject";
    }
    let fresh: TriageInput;
    try {
      fresh = buildTriageContext(
        db,
        c.key,
        c.input.source.id,
        fence.configEpoch,
        { fence, now },
      );
    } catch(error) {
      if(!(error instanceof TriageContextError))throw error;
      const state=error.code==="stale_source"?"stale_source":error.code==="missing_purpose"?"blocked_config":error.code==="input_too_large"?"needs_review":"failed";
      const diagnostic=error.code==="stale_source"?"authorization_changed":error.code;
      settle(db,fence,state,now,assessment.usage,diagnostic);
      if(state==="blocked_config")db.prepare("UPDATE mail_triage_settings SET state='blocked_config' WHERE id=1 AND enabled=1 AND config_epoch=?").run(fence.configEpoch);
      return error.code;
    }
    if (
      fresh.contextVersion !== fence.contextVersion ||
      actual.sources !== c.snapshot.sources ||
      actual.locators !== c.snapshot.locators ||
      json(actual.cases) !== json(c.snapshot.cases)
    ) {
      settle(
        db,
        fence,
        Number(j.generation) >= 3 ? "needs_review" : "stale_source",
        now,
        assessment.usage,
      );
      successor(db, j, fresh, now);
      return "stale";
    }
    if (
      !db
        .prepare(
          "SELECT 1 FROM mail_triage_attempts WHERE job_id=? AND attempt_seq=? AND outcome='reserved'",
        )
        .get(fence.jobId, fence.attemptSeq)
    )
      return "stale";
    const assessmentId=randomUUID(),qualification=getEvaluationStatus(db,c.input.tuple);
    const autoRoute=canAutoRouteNotification({assessment,qualification,enabled:cfg.auto_notifications===1});
    applyAssessment(db, {
      sourceId: c.input.source.id,
      assessment,
      fence,
      now,
      releaseTemporaryReview:autoRoute,
    });
    const t = c.input.tuple;
    db.prepare(
      `INSERT INTO mail_triage_assessments(id,job_id,source_id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,prompt_hash,validated_json,support_source_ids_json,grade,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      assessmentId,
      fence.jobId,
      c.input.source.id,
      t.providerId,
      t.modelId,
      t.modelConfigRevision,
      t.promptVersion,
      t.ruleVersion,
      t.schemaVersion,
      c.promptHash,
      json(assessment),
      json(c.input.authorizedSources.map((s) => s.id)),
      assessment.grade,
      now,
    );
    if(autoRoute){
      const audit=registerNotificationAudit(db,{assessmentId,tuple:t},now);
      db.prepare("INSERT INTO mail_triage_audits(id,assessment_id,sequence,sampled,last_passed_boundary) VALUES(?,?,?,?,?)").run(randomUUID(),assessmentId,audit.sequence,audit.sampled?1:0,qualification?.lastPassedBoundary??0);
    }
    settle(
      db,
      fence,
      assessment.grade === "needs_review" ? "needs_review" : "succeeded",
      now,
      assessment.usage,
    );
    return "applied";
  });
}

const failure = (error: unknown): TriageFailure => {
  if(error instanceof TriageContextError)return{code:error.code,retryable:false};
  if (error instanceof TriageAnalysisError)
    return { code: error.code, retryable: false };
  if (error instanceof TriageModelError)
    return {
      code: error.code,
      retryable: ["http_429", "http_5xx", "network_error", "timeout"].includes(
        error.code,
      ),
      retryAfterMs: error.retryAfterMs,
    };
  return { code: "request_failed", retryable: false };
};
export function createTriageWorker(deps: TriageWorkerDeps): TriageWorker {
  const { db, queue, scheduler, clock } = deps;
  if (deps.isMailboxAvailable?.constructor.name === "AsyncFunction")
    throw new TypeError("邮箱guard必须同步");
  let accepting = false,
    closed = false,
    running: Promise<void> | null = null,
    poll: ReturnType<typeof setInterval> | undefined;
  let admission: AbortController | undefined,
    requestAbort: AbortController | undefined,
    activeJobId: string | undefined,
    activeSources = new Set<string>();
  const push = () => {
    try {
      deps.push();
    } catch {
      /* SSE不是持久任务源，推送失败不得重发。 */
    }
  };
  async function runOne() {
    const priority = queue.peekPriority();
    if (!priority || !accepting) return;
    admission = new AbortController();
    let release: (() => void) | undefined,
      lease: JobLease | null = null,
      fence: Fence | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined,
      renew: ReturnType<typeof setInterval> | undefined;
    let callerError: unknown,
      usage: ModelUsage | null = null,
      attemptId: string | undefined;
    try {
      // 此signal仅用于等待许可。取得后永不abort它，防止scheduler提前释放活跃传输。
      release = await scheduler.acquire(
        deps.workspaceKey,
        priority,
        admission.signal,
      );
      admission = undefined;
      if (!accepting) return;
      lease = queue.claim();
      if (!lease) return;
      activeJobId = lease.jobId;
      activeSources = new Set([lease.sourceId]);
      requestAbort = new AbortController();
      const input = buildTriageContext(
        db,
        deps.key,
        lease.sourceId,
        lease.configEpoch,
      );
      activeSources = new Set(input.authorizedSources.map((source) => source.id));
      if (!mailboxAllowed(input, deps.isMailboxAvailable))
        throw new TriageModelError("stale_source");
      if (lease.attemptSeq > 0) {
        const cases = snapshot(db, input).cases;
        const manual = manualVersionsChanged(db, lease.manualVersionsJson, input, cases);
        if (manual) {
          atomic(db, () => {
            const j = db.prepare("SELECT * FROM mail_triage_jobs WHERE id=? AND state='running' AND lease_token=? AND attempt_seq=?").get(lease!.jobId, lease!.leaseToken, lease!.attemptSeq);
            if (!j) return;
            reprojectCases(db, { caseIds: cases.map(c => String(c.id)), now: clock() });
            db.prepare("UPDATE mail_triage_jobs SET state='needs_review',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(clock(), j.id as string);
          });
          push();
          return;
        }
      }
      if (lease.attemptSeq > 0 && input.contextVersion !== lease.contextVersion) {
        // 已有请求的上下文不能原地重绑；人工操作永远优先，绝不重跑来对抗人工。
        atomic(db, () => {
          const j = db
            .prepare(
              "SELECT * FROM mail_triage_jobs WHERE id=? AND state='running' AND lease_token=? AND attempt_seq=?",
            )
            .get(lease!.jobId, lease!.leaseToken, lease!.attemptSeq);
          if (!j) return;
          const cases = snapshot(db, input).cases;
          db.prepare(
            "UPDATE mail_triage_jobs SET state=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?",
          ).run(
            Number(j.generation) >= 3
              ? "needs_review"
              : "stale_source",
            clock(),
            j.id as string,
          );
          successor(db, j, input, clock());
        });
        push();
        return;
      }
      lease = queue.prepareContext(lease, {
        contextVersion: input.contextVersion,
        manualVersion: input.manualVersion,
        manualVersionsJson: buildManualVersionVector(db, input, snapshot(db, input).cases),
        tuple: input.tuple,
      });
      if (!lease) return;
      const request = prepareTriageRequest(input),
        guard = snapshot(db, input);
      const prepared = await preflightTriageRequest(
        request,
        { db, key: deps.key },
        requestAbort.signal,
      );
      if (!accepting || requestAbort.signal.aborted) return;
      const latest = buildTriageContext(
        db,
        deps.key,
        input.source.id,
        input.configEpoch,
      );
      if (manualVersionsChanged(db, lease.manualVersionsJson, latest, snapshot(db, latest).cases)) {
        atomic(db, () => {
          const j = db.prepare("SELECT * FROM mail_triage_jobs WHERE id=? AND state='running' AND lease_token=? AND attempt_seq=?").get(lease!.jobId, lease!.leaseToken, lease!.attemptSeq);
          if (!j) return;
          reprojectCases(db, { caseIds: snapshot(db, latest).cases.map(c => String(c.id)), now: clock() });
          db.prepare("UPDATE mail_triage_jobs SET state='needs_review',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(clock(), j.id as string);
        });
        push();
        return;
      }
      if (
        latest.contextVersion !== input.contextVersion ||
        json(snapshot(db, input)) !== json(guard) ||
        !mailboxAllowed(latest, deps.isMailboxAvailable)
      )
        throw new TriageModelError("stale_source");
      const permit = queue.reserveAttempt(lease);
      fence = permit.fence;
      attemptId = String(
        db
          .prepare(
            "SELECT id FROM mail_triage_attempts WHERE job_id=? AND attempt_seq=?",
          )
          .get(fence.jobId, fence.attemptSeq)!.id,
      );
      const remaining = permit.deadlineAt - clock();
      if (remaining <= 0) throw new TriageModelError("timeout");
      deadline = setTimeout(
        () => requestAbort?.abort(new DOMException("请求超时", "TimeoutError")),
        remaining,
      );
      deadline.unref();
      renew = setInterval(() => {
        try {
          if (!queue.renew(fence!))
            requestAbort?.abort(new DOMException("租约失效", "AbortError"));
        } catch {
          requestAbort?.abort(new DOMException("租约失效", "AbortError"));
        }
      }, MAIL_TRIAGE_LIMITS.leaseRenewMs);
      renew.unref();
      const signal = requestAbort.signal;
      const assessment = await analyzeTriage(
        request,
        async (req, s) => {
          try {
            const result = await deps.callOnce(req, s, prepared);
            usage = result.usage;
            return result;
          } catch (error) {
            callerError = error;
            throw error;
          }
        },
        signal,
      );
      const outcome = commitAssessment(db, fence, assessment, {
        key: deps.key,
        input,
        clock,
        promptHash: request.promptHash,
        snapshot: guard,
        isMailboxAvailable: deps.isMailboxAvailable,
      });
      if (outcome !== "cancelled") push();
    } catch (error) {
      if (fence) {
        // Only an explicit error from the actual caller is proof of zero-dispatch.
        if (
          callerError === error &&
          error instanceof TriageModelError &&
          !error.dispatched
        ) {
          const knownZeroFailure =
            closed && requestAbort?.signal.aborted && error.code === "cancelled"
              ? { code: "timeout", retryable: true }
              : failure(error);
          queue.settleNotDispatched(fence, knownZeroFailure, attemptId);
        } else {
          queue.retry(
            fence,
            requestAbort?.signal.aborted
              ? { code: "timeout", retryable: true }
              : failure(error),
          );
          // revocation/epoch/lease expiry can invalidate queue.retry: consume the attempt, never save assessment.
          atomic(db, () => {
            if (matchingJob(db, fence!, clock()))
              settle(db, fence!, "stale_source", clock(), usage);
            else
              db.prepare(
                "UPDATE mail_triage_attempts SET outcome='unknown',settled_at=?,usage_json=? WHERE job_id=? AND attempt_seq=? AND outcome='reserved'",
              ).run(
                clock(),
                usage ? json(usage) : null,
                fence!.jobId,
                fence!.attemptSeq,
              );
          });
          if (usage)
            db.prepare(
              "UPDATE mail_triage_attempts SET usage_json=? WHERE job_id=? AND attempt_seq=?",
            ).run(json(usage), fence.jobId, fence.attemptSeq);
        }
        push();
      } else if (lease && accepting) {
        // Deterministic preflight failure spends no request budget and cannot spin forever.
        const code = failure(error).code;
        const state =
          code === "stale_source"
            ? "stale_source"
            : [
                  "input_too_large",
                  "invalid_evidence",
                  "response_too_large",
                ].includes(code)
              ? "needs_review"
              : [
                    "missing_purpose",
                    "missing_model_binding",
                    "missing_api_key",
                    "unsupported_protocol",
                    "config_error",
                  ].includes(code)
                ? "blocked_config"
                : "failed";
        atomic(db, () => {
          db.prepare(
            "UPDATE mail_triage_jobs SET state=?,last_error=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=? AND attempt_seq=?",
          ).run(
            state,
            code === "stale_source" ? "authorization_changed" : code,
            clock(),
            lease!.jobId,
            lease!.leaseToken,
            lease!.attemptSeq,
          );
          if (state === "blocked_config")
            db.prepare(
              "UPDATE mail_triage_settings SET state='blocked_config' WHERE id=1 AND enabled=1 AND config_epoch=?",
            ).run(lease!.configEpoch);
        });
        push();
      }
    } finally {
      if (deadline) clearTimeout(deadline);
      if (renew) clearInterval(renew);
      try {
        // FK清理可能已将job_id置NULL；保留进程内无业务含义的attempt UUID才能结清最小去身份化账。
        if (attemptId)
          db.prepare(
            "UPDATE mail_triage_attempts SET outcome='unknown',settled_at=?,usage_json=? WHERE id=? AND outcome='reserved'",
          ).run(clock(), usage ? json(usage) : null, attemptId);
        if (lease && !fence) queue.release(lease);
      } finally {
        requestAbort = undefined;
        activeJobId = undefined;
        activeSources.clear();
        admission = undefined;
        release?.();
      }
    }
  }
  function wake() {
    if (!accepting || closed || running) return;
    running = (async () => {
      queue.recover();
      await runOne();
    })()
      .catch(() => {
        /* 持久状态在下轮recover；不持久化任意异常消息。 */
      })
      .finally(() => {
        running = null;
        try {
          if (accepting && queue.peekPriority()) queueMicrotask(wake);
        } catch {
          /* 持久DB故障等待下次唤醒，不产生unhandled rejection。 */
        }
      });
  }
  const stopAccepting = () => {
    accepting = false;
    if (poll) clearInterval(poll);
    poll = undefined;
    admission?.abort();
  };
  return {
    start() {
      if (closed || accepting) return;
      accepting = true;
      poll = setInterval(wake, 1000);
      poll.unref();
      wake();
    },
    wake,
    abortSources(ids) {
      queue.cancel(ids, "cancelled");
      const cancelsActiveContext = ids.some((id) => activeSources.has(id));
      const jobId = activeJobId;
      if (cancelsActiveContext && jobId) atomic(db, () => {
        db.prepare("UPDATE mail_triage_attempts SET outcome='cancelled',settled_at=? WHERE outcome='reserved' AND job_id=?").run(clock(), jobId);
        db.prepare("UPDATE mail_triage_jobs SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,last_error='cancelled',updated_at=? WHERE id=? AND state<>'cancelled'").run(clock(), jobId);
      });
      if (cancelsActiveContext)
        requestAbort?.abort(new DOMException("来源取消", "AbortError"));
      push();
    },
    stopAccepting,
    async close() {
      closed = true;
      stopAccepting();
      requestAbort?.abort(new DOMException("工作区关闭", "AbortError"));
      await running;
    },
  };
}
