import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  MAIL_CATEGORIES,
  MAIL_TRIAGE_LIMITS,
  type BackfillBatch,
  type BackfillPreview,
  type CaseDetail,
  type BoardCasePage,
  type CaseSummary,
  type ContactMapping,
  type JobView,
  type PageResult,
  type MailMessageAnnotationsResult,
  type Provenance,
  type ReviewRow,
  type ReviewSourcePreview,
  type TriageResult,
  type TriageSettings,
  type TriageStatus,
} from "../shared/mail-triage-types.ts";
import {
  BackfillPreviewSchema,
  BackfillBatchResultSchema,
  CaseIdInputSchema,
  CaseDetailOutputSchema,
  CaseListSchema,
  CaseSummaryOutputSchema,
  ConfigureTriageSchema,
  ContactMappingSchema,
  ContactMappingOutputSchema,
  ContactMailboxIdsSchema,
  ContactSenderAddressesSchema,
  ContactDomainsSchema,
  ContactRemoveResultSchema,
  EnqueueTriageSchema,
  JobMutationSchema,
  JobViewSchema,
  MutationMetaSchema,
  PageRequestSchema,
  PersistedProjectedCaseSchema,
  PersistedValidatedAssessmentSchema,
  ProvenanceSchema,
  EvidenceRefSchema,
  ReminderSettingsSchema,
  ReviewQueueSchema,
  MessageAnnotationsInputSchema,
  SourceIdInputSchema,
  SourceReaderRefSchema,
  SourceIdsSchema,
  HistoricalPreviewTokenSchema,
} from "./mail-triage-schema.ts";
import type { MailboxService } from "./mailbox-service.ts";
import { isStrictIndependentProvenance, projectCase, registerPendingReview, type CaseEvent, type SupportSource } from "./mail-case-projector.ts";
import { invalidateSource, invalidateTriageScope } from "./mail-triage-lifecycle.ts";
import { cacheReadIdentity, cachedParsedMessage, fingerprintSource, registerHistoricalCachedSource, verifiedUidValidity, type SourceRegistrationHooks } from "./mail-triage-source.ts";
import type { TriageWorker } from "./mail-triage-worker.ts";
import { applyManualDecision, getSourceManualVersion, undoManualDecision, type ManualMutationResult } from "./mail-triage-actions.ts";
import { approveNotificationRouting as approveNotificationRoutingRecord, getEvaluationStatus, recordNotificationAudit, saveEvaluationReport as saveEvaluationReportRecord, type EvaluationStatus, type Qualification } from "./mail-triage-evaluation.ts";

type Row = Record<string, unknown>;
export interface ServerActor { userId: number }
export interface MailTriageService {
  settings(): TriageSettings;
  status(): TriageStatus;
  result(input: { sourceId: string }): TriageResult | null;
  casesList(input: unknown): BoardCasePage;
  caseDetail(input: { caseId: string }): CaseDetail | null;
  reviewQueue(input: unknown): PageResult<ReviewRow>;
  messageAnnotations(input: unknown): MailMessageAnnotationsResult;
  sourcePreview(input: unknown): ReviewSourcePreview;
  evaluationStatus(input: unknown): EvaluationStatus | null;
  saveEvaluationReport(input: unknown): Qualification;
  approveNotificationRouting(input: unknown): Qualification;
  auditOutcome(input: unknown): { paused: boolean; recheckAssessmentIds: string[]; recheckSourceIds: string[] };
  configure(input: unknown): Promise<TriageSettings>;
  backfillPreview(input: unknown): BackfillPreview;
  enqueue(input: unknown): BackfillBatch;
  retry(input: unknown): JobView;
  cancel(input: unknown): JobView;
  contactsList(input: unknown): PageResult<ContactMapping>;
  contactsSave(input: unknown): ContactMapping;
  contactsRemove(input: unknown): { id: string; version: number };
  correct(input: unknown): ManualMutationResult;
  link(input: unknown): ManualMutationResult;
  split(input: unknown): ManualMutationResult;
  confirmCase(input: unknown): ManualMutationResult;
  independentFact(input: unknown): ManualMutationResult;
  appeal(input: unknown): ManualMutationResult;
  undo(input: unknown): { version: number; affectedSourceIds: string[] };
  readonly sourceHooks: SourceRegistrationHooks;
  readonly lifecycleHooks: {
    invalidateScope(input: { mailboxIds: number[]; reason: "disable" | "scope_removed" | "mailbox_delete" | "abandon" }, now: number): { abortSourceIds: string[] };
    invalidateSource(sourceId: string, reason: "stale" | "missing" | "explicit_delete", now: number): void;
    abortSources(sourceIds: string[]): void;
  };
  start(): void;
  stopAccepting(): void;
  close(): Promise<void>;
}

const json = (value: unknown) => JSON.stringify(value);
function authoritativeJson<T>(value: unknown, schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, label: string): T {
  let decoded: unknown;
  try { decoded = JSON.parse(String(value)); } catch { throw new Error(`数据完整性错误：${label}不是有效JSON`); }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw new Error(`数据完整性错误：${label}结构无效，请人工核对`);
  return parsed.data;
}
function untrustedPreviewJson(value: string): unknown { try { return JSON.parse(value); } catch { throw new Error("补审预览无效"); } }
const canonicalValue = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalValue)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([name, item]) => [name, canonicalValue(item)]))
    : value;
const canonical = (value: unknown): string => JSON.stringify(canonicalValue(value));
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const unique = <T>(values: T[]) => [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b), "en"));
const atomic = <T>(db: DatabaseSync, work: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try { const value = work(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
};

function actorId(actor: ServerActor | null): string {
  if (!actor || !Number.isSafeInteger(actor.userId) || actor.userId <= 0) throw new Error("人工写操作缺少经过验证的服务端操作者");
  return `user:${actor.userId}`;
}
function pagination(input: unknown) { return PageRequestSchema.parse(input ?? {}); }
function viewJob(row: Row): JobView {
  return { jobId: String(row.id), sourceId: String(row.source_id), state: row.state as JobView["state"], version: Number(row.attempt_seq), updatedAt: Number(row.updated_at), lastError: row.last_error == null ? null : String(row.last_error) };
}

export function createMailTriageService(deps: {
  db: DatabaseSync; key: Buffer; mailboxes: MailboxService; worker: TriageWorker; clock: () => number; push: () => void; readOnly: boolean; actor: ServerActor | null;
}): MailTriageService {
  const { db, key, mailboxes, worker, clock } = deps;
  let stopped = false;
  let reminderTimer: ReturnType<typeof setInterval> | undefined;
  let lastReminderKey = "";
  const projectionValidityCache = new Map<string, 0 | 1>();
  db.function("mail_triage_projection_valid", { deterministic: true, directOnly: true }, (value) => {
    const serialized=String(value),cached=projectionValidityCache.get(serialized);
    if(cached!==undefined)return cached;
    let valid:0|1=0;
    try { valid=PersistedProjectedCaseSchema.safeParse(JSON.parse(serialized)).success?1:0; }
    catch { /* malformed persisted projection fails closed */ }
    if(projectionValidityCache.size>=12_000)projectionValidityCache.delete(projectionValidityCache.keys().next().value!);
    projectionValidityCache.set(serialized,valid);
    return valid;
  });
  const writable = () => { if (deps.readOnly) throw new Error("只读工作区不能修改邮件预审设置"); return actorId(deps.actor); };
  const deferredChanged = (sourceId?: string) => queueMicrotask(() => {
    try {
      if (stopped) return;
      if (sourceId && !db.prepare("SELECT 1 FROM mail_triage_sources WHERE id=?").get(sourceId)) return;
      worker.wake(); deps.push();
    } catch { /* 工作区可能已关闭；SSE 不是持久任务源。 */ }
  });
  const deferredLocalChanged = () => queueMicrotask(() => {
    try { if (!stopped) deps.push(); }
    catch { /* 工作区可能已关闭；SSE 不是持久任务源。 */ }
  });
  const readSettings = (): TriageSettings => {
    const row = db.prepare("SELECT * FROM mail_triage_settings WHERE id=1").get()!;
    const reminderSettings = authoritativeJson(row.reminder_settings_json, ReminderSettingsSchema, "提醒设置");
    const role = db.prepare("SELECT provider_id,model_id,thinking FROM model_roles WHERE role='mail_triage'").get();
    const mailboxIds = (db.prepare("SELECT mailbox_id FROM mail_triage_scope WHERE state='authorized' AND epoch=? ORDER BY mailbox_id").all(row.config_epoch) as Row[]).map(item => Number(item.mailbox_id));
    return {
      enabled: row.enabled === 1, state: row.state as TriageSettings["state"], configEpoch: Number(row.config_epoch), modelConfigRevision: Number(row.model_config_revision), version: Number(row.version),
      mailboxIds, mode: row.mode as TriageSettings["mode"], modelBinding: role ? { providerId: Number(role.provider_id), modelId: String(role.model_id), thinking: String(role.thinking) } : null,
      dailyAttemptLimit: Number(row.daily_attempt_limit), consentProviderRevision: row.consent_provider_revision == null ? null : Number(row.consent_provider_revision), reminderEnabled: row.reminder_enabled === 1, reminderSettings, autoNotifications: row.auto_notifications === 1 && Boolean(role && getEvaluationStatus(db,{providerId:Number(role.provider_id),modelId:String(role.model_id),modelConfigRevision:Number(row.model_config_revision),promptVersion:1,ruleVersion:1,schemaVersion:1})?.state==="approved"),
    };
  };
  const requireMailboxIds = (ids: number[]) => {
    const normalized = unique(ids);
    if (normalized.length !== ids.length) throw new Error("邮箱范围包含重复项");
    for (const id of normalized) {
      const row = db.prepare("SELECT status FROM mailboxes WHERE id=?").get(id);
      if (!row || ["deleting", "closed", "deleted"].includes(String(row.status))) throw new Error(`邮箱 ${id} 不可用`);
    }
    return normalized;
  };
  const authorizedSourcePredicate = (alias: string) => `${alias}.state='active' AND EXISTS(SELECT 1 FROM mail_triage_scope scope
    JOIN mail_triage_settings cfg ON cfg.id=1 AND cfg.enabled=1 AND cfg.state<>'disabled' AND scope.epoch=cfg.config_epoch
    JOIN mailboxes box ON box.id=${alias}.mailbox_id AND box.status NOT IN ('deleting','closed','deleted')
    JOIN mail_triage_source_aliases auth_alias ON auth_alias.source_id=${alias}.id AND auth_alias.mailbox_id=${alias}.mailbox_id AND auth_alias.active=1 AND auth_alias.uid_validity=scope.uid_validity
    WHERE scope.mailbox_id=${alias}.mailbox_id AND scope.state='authorized' AND scope.effective_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM abandoned_domains abandoned WHERE abandoned.domain=box.domain COLLATE NOCASE))`;
  const authorizedSourceIds = (): Set<string> => new Set((db.prepare(`SELECT DISTINCT s.id FROM mail_triage_sources s WHERE ${authorizedSourcePredicate("s")}`)
    .all() as Row[]).map(row => String(row.id)));
  const runtimeProvenanceAuthorized = (value: Provenance, authorized: Set<string>): boolean => isStrictIndependentProvenance(value)
    || value.kind === "source_derived" && value.supportSourceIds.length > 0 && value.supportSourceIds.every(id => authorized.has(id));
  const strictIndependentProvenanceSql = (expression: string) => `(
    json_valid(${expression}) AND (SELECT count(*) FROM json_each(${expression}))=4
    AND json_extract(${expression},'$.kind')='independent_manual'
    AND json_type(${expression},'$.supportSourceIds')='array' AND json_array_length(${expression},'$.supportSourceIds')=0
    AND json_type(${expression},'$.verifiedAt')='integer' AND json_extract(${expression},'$.verifiedAt')>0
    AND json_type(${expression},'$.reason')='text' AND length(trim(json_extract(${expression},'$.reason')))>0)`;
  const sourceIdsAuthorizedSql = (expression: string, alias: string) => `(
    json_valid(${expression}) AND json_type(${expression})='array' AND json_array_length(${expression})>0
    AND NOT EXISTS(SELECT 1 FROM json_each(${expression}) ${alias}_id
      WHERE ${alias}_id.type<>'text' OR NOT EXISTS(
        SELECT 1 FROM mail_triage_sources ${alias}_source
        WHERE ${alias}_source.id=${alias}_id.value AND ${authorizedSourcePredicate(`${alias}_source`)})))`;
  const provenanceAuthorizedSql = (expression: string, alias: string) => `(
    ${strictIndependentProvenanceSql(expression)} OR (
      json_valid(${expression}) AND (SELECT count(*) FROM json_each(${expression}))=4
      AND json_extract(${expression},'$.kind')='source_derived'
      AND json_type(${expression},'$.verifiedAt')='null' AND json_type(${expression},'$.reason')='null'
      AND ${sourceIdsAuthorizedSql(`json_extract(${expression},'$.supportSourceIds')`, alias)}))`;
  const humanProvenanceAuthorizedSql = (expression: string, alias: string) => `(
    ${strictIndependentProvenanceSql(expression)} OR (
      ${provenanceAuthorizedSql(expression, alias)} AND json_extract(${expression},'$.kind')='source_derived'
      AND NOT EXISTS(SELECT 1 FROM json_each(${expression},'$.supportSourceIds') ${alias}_human_id
        WHERE NOT EXISTS(SELECT 1 FROM mail_triage_sources ${alias}_human_source
          WHERE ${alias}_human_source.id=${alias}_human_id.value AND ${alias}_human_source.trust='human_confirmed'
            AND ${authorizedSourcePredicate(`${alias}_human_source`)}))))`;
  const evidenceAuthorizedSql = (expression: string, alias: string) => `(
    json_valid(${expression}) AND json_type(${expression})='array'
    AND NOT EXISTS(SELECT 1 FROM json_each(${expression}) ${alias}_evidence
      WHERE ${alias}_evidence.type<>'object' OR (SELECT count(*) FROM json_each(${alias}_evidence.value))<>2
        OR json_type(${alias}_evidence.value,'$.sourceId')<>'text' OR json_type(${alias}_evidence.value,'$.quote')<>'text'
        OR NOT EXISTS(SELECT 1 FROM mail_triage_sources ${alias}_evidence_source
          WHERE ${alias}_evidence_source.id=json_extract(${alias}_evidence.value,'$.sourceId') AND ${authorizedSourcePredicate(`${alias}_evidence_source`)})))`;
  const eventSourceVersionSql = (alias: string) => `(CASE WHEN instr(${alias}.event_slot,':')>1
    AND substr(${alias}.event_slot,1,instr(${alias}.event_slot,':')-1) NOT GLOB '*[^0-9]*'
    THEN CAST(substr(${alias}.event_slot,1,instr(${alias}.event_slot,':')-1) AS INTEGER) ELSE 1 END)`;
  const eventAuthorizedPredicate = (alias: string) => `(
    (json_extract(${alias}.provenance_json,'$.kind')='independent_manual'
      AND ${strictIndependentProvenanceSql(`${alias}.provenance_json`)}
      AND json_valid(${alias}.evidence_json) AND json_type(${alias}.evidence_json)='array' AND json_array_length(${alias}.evidence_json)=0)
    OR (json_extract(${alias}.provenance_json,'$.kind')='source_derived'
      AND ${provenanceAuthorizedSql(`${alias}.provenance_json`, `${alias}_provenance`)}
      AND ${alias}.source_id IS NOT NULL AND EXISTS(SELECT 1 FROM mail_triage_sources ${alias}_source
        WHERE ${alias}_source.id=${alias}.source_id AND ${authorizedSourcePredicate(`${alias}_source`)}
          AND ${alias}_source.source_version=${eventSourceVersionSql(alias)})
      AND ${evidenceAuthorizedSql(`${alias}.evidence_json`, `${alias}_refs`)}))`;
  const caseAuthorizedPredicate = (alias: string) => `(
    mail_triage_projection_valid(${alias}.projection_json)=1
    AND ${provenanceAuthorizedSql(`${alias}.identity_provenance_json`, `${alias}_identity`)}
    AND NOT EXISTS(SELECT 1 FROM json_each(${alias}.projection_json,'$.tasks') ${alias}_task
      WHERE NOT ${provenanceAuthorizedSql(`json_extract(${alias}_task.value,'$.provenance')`, `${alias}_task_provenance`)})
    AND NOT EXISTS(SELECT 1 FROM mail_case_events ${alias}_event WHERE ${alias}_event.case_id=${alias}.id
      AND ${alias}_event.decision_cycle=json_extract(${alias}.projection_json,'$.decisionCycle')
      AND NOT ${eventAuthorizedPredicate(`${alias}_event`)})
    AND NOT EXISTS(SELECT 1 FROM mail_case_manual_decisions ${alias}_manual WHERE ${alias}_manual.case_id=${alias}.id
      AND NOT ${provenanceAuthorizedSql(`${alias}_manual.provenance_json`, `${alias}_manual_provenance`)})
    AND (json_extract(${alias}.projection_json,'$.column') IS NULL OR json_extract(${alias}.projection_json,'$.column') NOT IN ('awaiting_platform','results')
      OR (json_extract(${alias}.projection_json,'$.column')='awaiting_platform' AND (
        EXISTS(SELECT 1 FROM mail_case_events ${alias}_wait_event WHERE ${alias}_wait_event.case_id=${alias}.id
          AND ${alias}_wait_event.decision_cycle=json_extract(${alias}.projection_json,'$.decisionCycle')
          AND ${eventAuthorizedPredicate(`${alias}_wait_event`)}
          AND (${alias}_wait_event.kind IN ('application_submitted','review_started')
            OR ${alias}_wait_event.kind='reconsideration_accepted' AND ${humanProvenanceAuthorizedSql(`${alias}_wait_event.provenance_json`, `${alias}_wait_human`)}))
        OR EXISTS(SELECT 1 FROM json_each(${alias}.projection_json,'$.tasks') ${alias}_awaiting_task
          WHERE json_extract(${alias}_awaiting_task.value,'$.state')='awaiting_external')))
      OR (json_extract(${alias}.projection_json,'$.column')='results' AND (
        EXISTS(SELECT 1 FROM mail_case_events ${alias}_result_event WHERE ${alias}_result_event.case_id=${alias}.id
          AND ${alias}_result_event.decision_cycle=json_extract(${alias}.projection_json,'$.decisionCycle')
          AND ${eventAuthorizedPredicate(`${alias}_result_event`)}
          AND ${humanProvenanceAuthorizedSql(`${alias}_result_event.provenance_json`, `${alias}_result_human`)}
          AND ((${alias}_result_event.kind='application_approved' AND json_extract(${alias}.projection_json,'$.decision')='approved')
            OR (${alias}_result_event.kind='application_declined' AND json_extract(${alias}.projection_json,'$.decision')='declined')
            OR (${alias}_result_event.kind='application_withdrawn' AND json_extract(${alias}.projection_json,'$.decision')='withdrawn')))
        OR EXISTS(SELECT 1 FROM mail_case_manual_decisions ${alias}_result_manual WHERE ${alias}_result_manual.case_id=${alias}.id
          AND ${alias}_result_manual.object_id=${alias}.id
          AND ${alias}_result_manual.field='decision'
          AND ${alias}_result_manual.undo_of IS NULL
          AND NOT EXISTS(SELECT 1 FROM mail_case_manual_decisions ${alias}_result_manual_undo
            WHERE ${alias}_result_manual_undo.undo_of=${alias}_result_manual.id)
          AND ${humanProvenanceAuthorizedSql(`${alias}_result_manual.provenance_json`, `${alias}_result_manual_human`)}
          AND COALESCE(json_extract(${alias}_result_manual.after_json,'$.decision'),json_extract(${alias}_result_manual.after_json,'$'))=json_extract(${alias}.projection_json,'$.decision'))))))`;
  const assertProjectionIntegrity = () => {
    const invalid = db.prepare(`SELECT c.id FROM mail_application_cases c
      WHERE ${provenanceAuthorizedSql("c.identity_provenance_json", "integrity_identity")}
        AND mail_triage_projection_valid(c.projection_json)=0 LIMIT 1`).get();
    if (invalid) throw new Error("数据完整性错误：事项投影结构无效，请人工核对");
  };
  const request = (requestId: string, operation: string, inputHash: string): Row | undefined => {
    const row = db.prepare("SELECT * FROM mail_triage_requests WHERE request_id=? AND operation=?").get(requestId, operation);
    if (row && row.canonical_input_hash !== inputHash) throw new Error("requestId 已用于不同内容");
    return row;
  };
  const remember = (requestId: string, operation: string, inputHash: string, result: unknown) => db.prepare(
    "INSERT INTO mail_triage_requests(request_id,operation,canonical_input_hash,result_ref_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(request_id,operation) DO UPDATE SET result_ref_json=excluded.result_ref_json",
  ).run(requestId, operation, inputHash, json(result), clock());

  const sourceHooks: SourceRegistrationHooks = {
    onPendingSource(source) {
      registerPendingReview(db, { sourceId: source.sourceId, sourceVersion: source.sourceVersion, configEpoch: source.configEpoch, now: source.observedAt });
      deferredChanged(source.sourceId);
    },
    onSourceInvalidated(input) { invalidateSource(db, input.sourceId, input.reason, input.now); },
  };
  const lifecycleHooks = {
    invalidateScope(input: { mailboxIds: number[]; reason: "disable" | "scope_removed" | "mailbox_delete" | "abandon" }, now: number) { return invalidateTriageScope(db, input, now); },
    invalidateSource(sourceId: string, reason: "stale" | "missing" | "explicit_delete", now: number) { invalidateSource(db, sourceId, reason, now); },
    abortSources(sourceIds: string[]) { worker.abortSources(sourceIds); },
  };
  const localReminders = (): (ReviewRow & { reminderKey: string })[] => {
    assertProjectionIntegrity();
    const cfg = db.prepare("SELECT reminder_enabled,reminder_settings_json FROM mail_triage_settings WHERE id=1").get();
    if (cfg?.reminder_enabled !== 1) return [];
    const reminder = authoritativeJson(cfg.reminder_settings_json, ReminderSettingsSchema, "提醒设置");
    const { followUpDays, leadDays } = reminder;
    const now = clock(), day = 24 * 60 * 60 * 1000;
    const rows = db.prepare(`SELECT t.id,t.case_id,t.version,t.state,t.deadline_at,c.updated_at case_updated_at FROM mail_case_tasks t
      JOIN mail_application_cases c ON c.id=t.case_id
      WHERE ${caseAuthorizedPredicate("c")} AND ${provenanceAuthorizedSql("t.provenance_json", "reminder_task")}
        AND t.state IN ('open','blocked','awaiting_external') AND ((t.deadline_at IS NOT NULL AND t.deadline_at<=?) OR (t.state='awaiting_external' AND c.updated_at<=?))
      ORDER BY t.id`).all(now + leadDays * day, now - followUpDays * day) as Row[];
    return rows.flatMap(row => {
      const taskId = String(row.id), caseId = String(row.case_id), version = Number(row.version), result: (ReviewRow & { reminderKey: string })[] = [];
      if (row.deadline_at != null) {
        const deadline = Number(row.deadline_at), state = deadline <= now ? "overdue" : "upcoming";
        result.push({ reminderKey: `mail-triage:${caseId}:${taskId}:${version}:${state}:${deadline}`, sourceId: null, jobId: null, caseId, state, reason: state === "overdue" ? "事项已逾期，请人工核对" : "事项临期，请人工核对", updatedAt: deadline, mailboxId:null,mailboxAddress:null,mailDate:null,sourceVersion:null,manualVersion:null,sourceState:null,sourceTrust:null,tag:null,summary:null,displayError:null,readerRef:null });
      }
      if (row.state === "awaiting_external" && Number(row.case_updated_at) <= now - followUpDays * day) result.push({ reminderKey: `mail-triage:${caseId}:${taskId}:${version}:waiting:${followUpDays}`, sourceId: null, jobId: null, caseId, state: "waiting_too_long", reason: `人工建议：已等待超过${followUpDays}天，请决定是否跟进`, updatedAt: Number(row.case_updated_at), mailboxId:null,mailboxAddress:null,mailDate:null,sourceVersion:null,manualVersion:null,sourceState:null,sourceTrust:null,tag:null,summary:null,displayError:null,readerRef:null });
      return result;
    });
  };
  const eventLabel = (kind: string): string => ({
    application_submitted: "提交申请", review_started: "开始审核", materials_received: "资料已收",
    agreement_sent: "协议已发送", signature_completed: "签名已完成", application_conditionally_approved: "有条件批准",
    application_approved: "申请获批", application_declined: "申请被拒", application_withdrawn: "申请撤回",
    reconsideration_accepted: "复审已受理", account_activated: "账户已开通", account_restricted: "账户受限",
    account_suspended: "账户暂停", account_disabled: "账户停用", account_closed: "账户关闭",
    notification: "邮件通知", request_action: "需要处理", review_new_mail: "新邮件待核对",
  } as Record<string,string>)[kind] ?? "申请进展";
  const displayForCase = (row: Row, persisted: ReturnType<typeof PersistedProjectedCaseSchema.parse>, authorized: Set<string>) => {
    const identityProvenance=authoritativeJson(row.identity_provenance_json,ProvenanceSchema,"申请身份来源");
    if(!runtimeProvenanceAuthorized(identityProvenance,authorized))throw new Error("数据完整性错误：申请身份包含未授权来源，请人工核对");
    for(const task of persisted.tasks)if(!runtimeProvenanceAuthorized(task.provenance,authorized))throw new Error("数据完整性错误：事项投影包含未授权来源，请人工核对");
    const sourceRows = db.prepare(`SELECT s.id,s.source_version,s.state,s.trust,s.mailbox_id,s.observed_at,s.source_hash,s.critical_headers_hash,box.address,
        a.folder,a.uid_validity,a.uid,m.uid cached_uid,m.date,a.active
      FROM mail_case_sources cs JOIN mail_triage_sources s ON s.id=cs.source_id
      JOIN mailboxes box ON box.id=s.mailbox_id
      LEFT JOIN mail_triage_source_aliases a ON a.source_id=s.id AND a.mailbox_id=s.mailbox_id AND a.active=1
      LEFT JOIN mail_messages m ON m.mailbox_id=a.mailbox_id AND m.folder=a.folder AND m.uid_validity=a.uid_validity AND m.uid=a.uid
      WHERE cs.case_id=? ORDER BY s.observed_at DESC,s.id,a.folder,a.uid`).all(String(row.id)) as Row[];
    const seenSources=new Set<string>(),visible=sourceRows.filter(source=>{const id=String(source.id);if(seenSources.has(id)||!authorized.has(id))return false;seenSources.add(id);return true;});
    const addresses = unique(visible.map(source=>String(source.address)));
    const openTasks = persisted.tasks.filter(task=>task.state==="open"||task.state==="blocked");
    const latest = visible[0];
    let tag = openTasks.some(task=>task.kind==="reply") ? "需要回复" : openTasks.some(task=>task.kind==="action") ? "需要处理" : openTasks.some(task=>task.kind==="review") ? "需要核对" : persisted.decision==="approved" ? "申请获批" : persisted.decision==="declined" ? "申请被拒" : "进度更新";
    let summary = openTasks[0]?.title ?? persisted.decisionExplanation ?? (persisted.milestones.at(-1) ? eventLabel(persisted.milestones.at(-1)!) : null);
    for (const source of visible) {
      const assessment = db.prepare("SELECT validated_json,support_source_ids_json FROM mail_triage_assessments WHERE source_id=? AND stale=0 ORDER BY created_at DESC,id DESC LIMIT 1").get(String(source.id)) as Row | undefined;
      if (!assessment) continue;
      const support = authoritativeJson(assessment.support_source_ids_json, SourceIdsSchema, "评估支持来源");
      if (!support.every(id=>authorized.has(id))) continue;
      const parsed = authoritativeJson(assessment.validated_json, PersistedValidatedAssessmentSchema, "预审评估");
      tag = parsed.tag; summary = parsed.summary; break;
    }
    const summaryDto = {
      caseId:String(row.id),version:Number(row.version),manualVersion:Number(row.manual_version),identityState:row.identity_state,
      column:persisted.column,provider:row.provider==null?null:String(row.provider),siteId:row.site_id==null?null:Number(row.site_id),
      siteLabel:row.site_domain==null?null:String(row.site_domain),applicationId:row.application_identity==null?null:String(row.application_identity),
      mailboxAddress:addresses[0]??null,mailboxCount:addresses.length,mailboxAddresses:addresses,tag,openTaskCount:openTasks.length,
      nextStep:openTasks[0]?.title??null,latestValidSummary:summary,latestValidAt:latest==null?null:Number(latest.observed_at),
      requiresReply:persisted.requiresReply,requiresAction:persisted.requiresAction,requiresReview:persisted.requiresReview,
    };
    return { summary: CaseSummaryOutputSchema.parse(summaryDto), sources: visible };
  };
  const scanLocalReminders = () => {
    const reminders = localReminders(), next = hash(reminders.map(row => row.reminderKey));
    if (!reminders.length) { lastReminderKey = ""; return; }
    if (next === lastReminderKey) return;
    lastReminderKey = next;
    try { deps.push(); } catch { /* 本地提醒只重投影；推送失败不发信、不调用模型。 */ }
  };
  const manual = (kind: "correct" | "link" | "split" | "confirm_case" | "independent_fact" | "appeal_requested", raw: unknown): ManualMutationResult => {
    writable();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("人工操作参数无效");
    const envelope={...(raw as Record<string,unknown>)},sourceRef=envelope.sourceRef,readIdentity=envelope.readIdentity;
    delete envelope.sourceRef;delete envelope.readIdentity;
    if(kind==="correct"&&(sourceRef!==undefined||readIdentity!==undefined)){
      const ref=SourceReaderRefSchema.parse(sourceRef),identity=z.string().regex(/^[a-f0-9]{64}$/).parse(readIdentity);
      const preview=mailboxes.sourcePreview({sourceId:ref.sourceId,sourceVersion:ref.sourceVersion});
      const actual=preview.sourceRef,messageIdentity=preview.message.readIdentity;
      if(actual.sourceId!==ref.sourceId||actual.sourceVersion!==ref.sourceVersion||actual.mailboxId!==ref.mailboxId||actual.folder!==ref.folder||actual.uidValidity!==ref.uidValidity||actual.uid!==ref.uid||messageIdentity!==identity)throw new Error("来源世代已变化，请重新读取邮件后再更正");
    }
    const result = applyManualDecision(db, { ...envelope, kind } as never, deps.actor!, clock());
    worker.abortSources(result.affectedSourceIds);
    deferredLocalChanged();
    return result;
  };

  const service: MailTriageService = {
    settings: readSettings,
    status() {
      assertProjectionIntegrity();
      const cfg = readSettings();
      const count = (sql: string, ...params: (string | number | null)[]) => Number(db.prepare(sql).get(...params)?.n ?? 0);
      return {
        enabled: cfg.enabled, state: cfg.state, configEpoch: cfg.configEpoch,
        needsActionCaseCount: count(`SELECT count(*) n FROM mail_application_cases c WHERE ${caseAuthorizedPredicate("c")} AND json_extract(c.projection_json,'$.column')='needs_you'`),
        awaitingCaseCount: count(`SELECT count(*) n FROM mail_application_cases c WHERE ${caseAuthorizedPredicate("c")} AND json_extract(c.projection_json,'$.column')='awaiting_platform'`),
        resultCaseCount: count(`SELECT count(*) n FROM mail_application_cases c WHERE ${caseAuthorizedPredicate("c")} AND json_extract(c.projection_json,'$.column')='results'`),
        unlinkedMailCount: count(`SELECT count(*) n FROM mail_triage_sources s WHERE ${authorizedSourcePredicate("s")} AND NOT EXISTS(SELECT 1 FROM mail_case_sources cs WHERE cs.source_id=s.id)`),
        unreviewedMailCount: count(`SELECT count(*) n FROM mail_triage_sources s WHERE ${authorizedSourcePredicate("s")} AND NOT EXISTS(SELECT 1 FROM mail_triage_assessments a JOIN mail_triage_jobs aj ON aj.id=a.job_id WHERE a.source_id=s.id AND a.stale=0 AND aj.source_version=s.source_version AND aj.config_epoch=(SELECT config_epoch FROM mail_triage_settings WHERE id=1))`),
        failedMailCount: count(`SELECT count(DISTINCT s.id) n FROM mail_triage_sources s JOIN mail_triage_jobs j ON j.source_id=s.id AND j.source_version=s.source_version AND j.config_epoch=(SELECT config_epoch FROM mail_triage_settings WHERE id=1) WHERE ${authorizedSourcePredicate("s")} AND j.state IN ('failed','blocked_config','stale_source')`),
        openTaskCount: count(`SELECT count(*) n FROM mail_case_tasks t JOIN mail_application_cases c ON c.id=t.case_id WHERE ${caseAuthorizedPredicate("c")} AND ${provenanceAuthorizedSql("t.provenance_json", "status_task")} AND t.state IN ('open','blocked')`),
        auditPendingMailCount: count(`SELECT count(*) n FROM mail_triage_audit_positions ap JOIN mail_triage_audit_counters ac USING(provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version) JOIN mail_triage_qualifications q USING(provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version) JOIN mail_triage_assessments a ON a.id=ap.assessment_id JOIN mail_triage_jobs j ON j.id=a.job_id JOIN mail_triage_sources s ON s.id=a.source_id WHERE (ap.sampled=1 OR (q.unresolved_recheck=1 AND ap.sequence>ac.last_passed_boundary)) AND (ap.verdict IS NULL OR ap.verdict='missed_action') AND a.stale=0 AND j.source_version=s.source_version AND j.config_epoch=(SELECT config_epoch FROM mail_triage_settings WHERE id=1) AND ${authorizedSourcePredicate("s")} AND ${sourceIdsAuthorizedSql("a.support_source_ids_json", "status_audit")}`),
        dailyAttemptsUsed: count("SELECT count(*) n FROM mail_triage_attempts WHERE budget_day=? AND outcome<>'not_dispatched'", new Date(clock()).toISOString().slice(0, 10)),
        dailyAttemptLimit: cfg.dailyAttemptLimit,
      };
    },
    result(input) {
      const { sourceId: id } = SourceIdInputSchema.parse(input);
      const row = db.prepare("SELECT id,mailbox_id,source_version,state,trust FROM mail_triage_sources WHERE id=?").get(id);
      const authorized = authorizedSourceIds();
      if (!row || !authorized.has(id)) return null;
      const assessment = db.prepare("SELECT validated_json,support_source_ids_json,grade FROM mail_triage_assessments WHERE source_id=? AND stale=0 ORDER BY created_at DESC,id DESC LIMIT 1").get(id);
      const job = db.prepare("SELECT state FROM mail_triage_jobs WHERE source_id=? ORDER BY updated_at DESC,id DESC LIMIT 1").get(id);
      let safeAssessment: TriageResult["assessment"] = null, grade = assessment ? assessment.grade as TriageResult["grade"] : null;
      if (assessment) {
        const persisted = authoritativeJson(assessment.validated_json, PersistedValidatedAssessmentSchema, "预审评估");
        const evidenceIds = new Set([
          ...persisted.events.flatMap(item => item.evidence.map(evidence => evidence.sourceId)),
          ...persisted.actions.flatMap(item => item.evidence.map(evidence => evidence.sourceId)),
          ...persisted.completionSuggestions.flatMap(item => item.evidence.map(evidence => evidence.sourceId)),
        ]);
        const supportIds = authoritativeJson(assessment.support_source_ids_json, SourceIdsSchema, "评估支持来源");
        if ([...evidenceIds, ...supportIds].every(sourceId => authorized.has(sourceId))) safeAssessment = {
          schemaVersion: persisted.schemaVersion, primaryCategory: persisted.primaryCategory, tag: persisted.tag, summary: persisted.summary,
          caseSuggestion: { providerCandidate: persisted.caseSuggestion.providerCandidate, applicationId: persisted.caseSuggestion.applicationId, candidateCaseId: persisted.caseSuggestion.candidateCaseId, matchBasis: [...persisted.caseSuggestion.matchBasis], needsReview: persisted.caseSuggestion.needsReview },
          events: persisted.events.map(event => ({ kind: event.kind, evidence: event.evidence.map(evidence => ({ sourceId: evidence.sourceId, quote: evidence.quote })) })),
          actions: persisted.actions.map(action => ({ kind: action.kind, title: action.title, requestedItems: [...action.requestedItems], deadlineRaw: action.deadlineRaw, satisfiesTaskIds: [...action.satisfiesTaskIds], evidence: action.evidence.map(evidence => ({ sourceId: evidence.sourceId, quote: evidence.quote })) })),
          completionSuggestions: persisted.completionSuggestions.map(item => ({ taskId: item.taskId, evidence: item.evidence.map(evidence => ({ sourceId: evidence.sourceId, quote: evidence.quote })) })),
          uncertainties: [...persisted.uncertainties], requiresHumanReview: persisted.requiresHumanReview,
        };
        else grade = "needs_review";
      }
      const manualVersion = getSourceManualVersion(db, id);
      if (safeAssessment) for (const field of ["tag", "category"] as const) {
        const manual = db.prepare("SELECT after_json FROM mail_case_manual_decisions WHERE case_id IS NULL AND object_id=? AND field=? ORDER BY applied_version DESC,id DESC LIMIT 1").get(id, field);
        if (!manual) continue;
        const value = authoritativeJson(manual.after_json, { safeParse(value: unknown) {
          if (!value || typeof value !== "object") return { success: false } as const;
          const record = value as Record<string, unknown>;
          if (!Number.isSafeInteger(record.sourceVersion)) return { success: false } as const;
          if (Number(record.sourceVersion) !== Number(row.source_version)) return { success: true, data: null } as const;
          const candidate = record[field];
          if (field === "tag") return typeof candidate === "string" && Array.from(candidate).length >= 2 && Array.from(candidate).length <= 6 && /^\p{Script=Han}+$/u.test(candidate)
            ? { success: true, data: candidate } as const : { success: false } as const;
          return typeof candidate === "string" && (MAIL_CATEGORIES as readonly string[]).includes(candidate)
            ? { success: true, data: candidate } as const : { success: false } as const;
        } }, "人工预审覆盖");
        if (value === null) continue;
        if (field === "tag") safeAssessment.tag = String(value);
        else safeAssessment.primaryCategory = String(value) as NonNullable<TriageResult["assessment"]>["primaryCategory"];
      }
      return { sourceId: String(row.id), sourceVersion: Number(row.source_version), manualVersion, sourceState: row.state as TriageResult["sourceState"], sourceTrust: row.trust as TriageResult["sourceTrust"], mailboxId: Number(row.mailbox_id), assessment: safeAssessment, grade, jobState: job ? job.state as TriageResult["jobState"] : null };
    },
    casesList(input) {
      assertProjectionIntegrity();
      const raw = CaseListSchema.parse(input ?? {});
      const { page, pageSize } = raw;
      const authorized=authorizedSourceIds();
      const predicates=[caseAuthorizedPredicate("c")],params:(string|number)[]=[];
      if(raw.column!==undefined){predicates.push("json_extract(c.projection_json,'$.column')=?");params.push(raw.column);}
      if(raw.site!==undefined){predicates.push("sites.domain=?");params.push(raw.site);}
      if(raw.provider!==undefined){predicates.push("c.provider=?");params.push(raw.provider);}
      if(raw.query!==undefined){predicates.push("instr(lower(COALESCE(sites.domain,'')||' '||COALESCE(c.provider,'')||' '||COALESCE(c.application_identity,'')),?)>0");params.push(raw.query.toLocaleLowerCase());}
      if(raw.mailboxId!==undefined||raw.mailboxAddress!==undefined){
        const mailboxPredicates=["cs_filter.case_id=c.id",authorizedSourcePredicate("s_filter")];
        if(raw.mailboxId!==undefined){mailboxPredicates.push("s_filter.mailbox_id=?");params.push(raw.mailboxId);}
        if(raw.mailboxAddress!==undefined){mailboxPredicates.push("box_filter.address=?");params.push(raw.mailboxAddress);}
        predicates.push(`EXISTS(SELECT 1 FROM mail_case_sources cs_filter JOIN mail_triage_sources s_filter ON s_filter.id=cs_filter.source_id JOIN mailboxes box_filter ON box_filter.id=s_filter.mailbox_id WHERE ${mailboxPredicates.join(" AND ")})`);
      }
      const fromWhere=`FROM mail_application_cases c LEFT JOIN sites ON sites.id=c.site_id WHERE ${predicates.join(" AND ")}`;
      const facetFromWhere=`FROM mail_application_cases c LEFT JOIN sites ON sites.id=c.site_id WHERE ${caseAuthorizedPredicate("c")}`;
      const total=Number(db.prepare(`SELECT count(*) n ${fromWhere}`).get(...params)?.n??0);
      const totals={needs_you:0,awaiting_platform:0,results:0};
      for(const row of db.prepare(`SELECT json_extract(c.projection_json,'$.column') column,count(*) n ${fromWhere} GROUP BY column`).all(...params) as Row[]){const column=String(row.column) as keyof typeof totals;if(column in totals)totals[column]=Number(row.n);}
      const facetValues=(column:string)=>unique((db.prepare(`SELECT DISTINCT ${column} value ${facetFromWhere} AND ${column} IS NOT NULL ORDER BY value`).all() as Row[]).map(row=>String(row.value)));
      const mailboxRows=db.prepare(`SELECT DISTINCT box_facet.address value FROM mail_application_cases c LEFT JOIN sites ON sites.id=c.site_id
        JOIN mail_case_sources cs_facet ON cs_facet.case_id=c.id
        JOIN mail_triage_sources s_facet ON s_facet.id=cs_facet.source_id
        JOIN mailboxes box_facet ON box_facet.id=s_facet.mailbox_id
        WHERE ${caseAuthorizedPredicate("c")} AND ${authorizedSourcePredicate("s_facet")} ORDER BY value`).all() as Row[];
      const facets={sites:facetValues("sites.domain"),mailboxes:unique(mailboxRows.map(row=>String(row.value))),providers:facetValues("c.provider")};
      const rows=db.prepare(`SELECT c.*,sites.domain site_domain ${fromWhere} ORDER BY c.updated_at DESC,c.id LIMIT ? OFFSET ?`).all(...params,pageSize,(page-1)*pageSize) as Row[];
      const items=rows.map(row=>displayForCase(row,authoritativeJson(row.projection_json,PersistedProjectedCaseSchema,"事项投影"),authorized).summary);
      const result:BoardCasePage={items,total,page,pageSize,columnTotals:totals,facets};
      return result;
    },
    caseDetail(input) {
      const { caseId } = CaseIdInputSchema.parse(input);
      const row = db.prepare(`SELECT c.*,sites.domain site_domain,
        CASE WHEN ${caseAuthorizedPredicate("c")} THEN 1 ELSE 0 END case_authorized
        FROM mail_application_cases c LEFT JOIN sites ON sites.id=c.site_id WHERE c.id=?`).get(caseId);
      if (!row) return null;
      const persisted = authoritativeJson(row.projection_json, PersistedProjectedCaseSchema, "事项投影"), authorized = authorizedSourceIds();
      const supportIds = new Set(persisted.tasks.flatMap(task => task.provenance.supportSourceIds));
      if ([...supportIds].some(sourceId => !authorized.has(sourceId))) throw new Error("数据完整性错误：事项投影包含未授权来源，请人工核对");
      const display=displayForCase(row,persisted,authorized);
      if(Number(row.case_authorized)!==1)return null;
      const sourceIds=display.sources.map(source=>String(source.id));
      const projection: CaseDetail["projection"] = { caseId: persisted.caseId, version: persisted.version, identityState: persisted.identityState, column: persisted.column, stage: persisted.stage, decision: persisted.decision, decisionCycle: persisted.decisionCycle, decisionExplanation: persisted.decisionExplanation, milestones: [...persisted.milestones], tasks: persisted.tasks.map(task => ({ id: task.id, kind: task.kind, state: task.state, title: task.title, requestedItems: [...task.requestedItems], deadlineRaw: task.deadlineRaw, deadlineAt: task.deadlineAt, snoozedUntil: task.snoozedUntil, provenance: { supportSourceIds: [...task.provenance.supportSourceIds], kind: task.provenance.kind, verifiedAt: task.provenance.verifiedAt, reason: task.provenance.reason } })), sourceUnavailable: persisted.sourceUnavailable, requiresReply: persisted.requiresReply, requiresAction: persisted.requiresAction, requiresReview: persisted.requiresReview };
      const sourceViews=display.sources.map(source=>{
        let sourceTag:string|null=null,sourceSummary:string|null=null;
        const assessment=db.prepare("SELECT validated_json,support_source_ids_json FROM mail_triage_assessments WHERE source_id=? AND stale=0 ORDER BY created_at DESC,id DESC LIMIT 1").get(String(source.id)) as Row|undefined;
        if(assessment){const support=authoritativeJson(assessment.support_source_ids_json,SourceIdsSchema,"评估支持来源");if(support.every(id=>authorized.has(id))){const parsed=authoritativeJson(assessment.validated_json,PersistedValidatedAssessmentSchema,"预审评估");sourceTag=parsed.tag;sourceSummary=parsed.summary;}}
        let readerRef=null;
        if(source.folder!=null&&source.cached_uid!=null){const cached=db.prepare("SELECT * FROM mail_messages WHERE mailbox_id=? AND folder=? AND uid_validity=? AND uid=?").get(Number(source.mailbox_id),String(source.folder),String(source.uid_validity),Number(source.uid)) as Row|undefined;try{if(cached){const fingerprints=fingerprintSource(key,cachedParsedMessage(cached));if(fingerprints.sourceHash===String(source.source_hash)&&fingerprints.criticalHeadersHash===String(source.critical_headers_hash))readerRef={caseId,sourceId:String(source.id),sourceVersion:Number(source.source_version),mailboxId:Number(source.mailbox_id),folder:String(source.folder),uidValidity:String(source.uid_validity),uid:Number(source.uid)};}}catch{/* malformed/expired cache is not a reader capability */}}
        return {sourceId:String(source.id),sourceVersion:Number(source.source_version),manualVersion:getSourceManualVersion(db,String(source.id)),sourceState:String(source.state),sourceTrust:String(source.trust),mailboxId:Number(source.mailbox_id),mailboxAddress:String(source.address),observedAt:Number(source.observed_at),mailDate:source.date==null?null:Number(source.date),tag:sourceTag,summary:sourceSummary,readerRef};
      });
      const currentSourceVersions=new Map(sourceViews.map(source=>[source.sourceId,source.sourceVersion]));
      const cycleEvents:CaseEvent[]=[];
      const timeline=(db.prepare("SELECT id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json FROM mail_case_events WHERE case_id=? ORDER BY observed_at,id").all(caseId) as Row[]).flatMap(event=>{
        const provenance=authoritativeJson(event.provenance_json,ProvenanceSchema,"事件来源");
        if(!runtimeProvenanceAuthorized(provenance,authorized))return [];
        const sourceId=event.source_id==null?null:String(event.source_id);
        const evidence=authoritativeJson(event.evidence_json,EvidenceRefSchema.array(),"事件证据");
        if(provenance.kind==="independent_manual"&&evidence.length!==0)return [];
        if(sourceId===null&&provenance.kind!=="independent_manual")return [];
        if(sourceId!==null&&!authorized.has(sourceId))return [];
        const sourceVersion=/^\d+:/.test(String(event.event_slot))?Number(String(event.event_slot).split(":")[0]):1;
        if(sourceId!==null&&currentSourceVersions.get(sourceId)!==sourceVersion)return [];
        if(evidence.some(item=>!authorized.has(item.sourceId)))return [];
        cycleEvents.push({id:String(event.id),caseId,sourceId,sourceVersion,eventSlot:String(event.event_slot),kind:String(event.kind) as CaseEvent["kind"],decisionCycle:Number(event.decision_cycle),claimedAt:event.claimed_at==null?null:Number(event.claimed_at),observedAt:Number(event.observed_at),evidence,provenance});
        return [{id:String(event.id),sourceId:event.source_id==null?null:String(event.source_id),kind:String(event.kind),label:eventLabel(String(event.kind)),decisionCycle:Number(event.decision_cycle),claimedAt:event.claimed_at==null?null:Number(event.claimed_at),observedAt:Number(event.observed_at),evidence}];
      });
      const sourceLabels=new Map(sourceViews.map(source=>[source.sourceId,{label:source.mailboxAddress,date:source.mailDate??source.observedAt}]));
      const evidence=timeline.flatMap(event=>event.evidence.map(item=>{const source=sourceLabels.get(item.sourceId);return{sourceId:item.sourceId,quote:item.quote,observedAt:event.observedAt,sourceLabel:source?.label??"已授权来源",sourceDate:source?.date??event.observedAt};})).slice(0,3);
      const cycles=[...new Set(timeline.map(event=>event.decisionCycle))].sort((a,b)=>a-b);
      const currentCycle={cycle:persisted.decisionCycle,decision:persisted.decision,explanation:persisted.decisionExplanation??null,current:true};
      const cycleSources:SupportSource[]=sourceViews.map(source=>({id:source.sourceId,state:source.sourceState as SupportSource["state"],trust:source.sourceTrust as SupportSource["trust"],version:source.sourceVersion}));
      const historicalCycles=cycles.filter(cycle=>cycle!==persisted.decisionCycle).map(cycle=>{const events=cycleEvents.filter(event=>event.decisionCycle===cycle);const value=projectCase({caseId,version:Number(row.version),identityState:row.identity_state as CaseDetail["identityState"],events,tasks:[],manualDecisions:[],sources:cycleSources,now:clock(),identityProvenance:authoritativeJson(row.identity_provenance_json,ProvenanceSchema,"申请身份来源")});const last=events.sort((a,b)=>a.observedAt-b.observedAt||a.id.localeCompare(b.id)).at(-1);return{cycle,decision:value.decision,explanation:value.decisionExplanation??(value.decision==="unknown"?null:last?eventLabel(last.kind):null),current:false};});
      const manualRecords=(db.prepare("SELECT id,field,reason,created_at,provenance_json FROM mail_case_manual_decisions WHERE case_id=? ORDER BY created_at DESC,id DESC LIMIT 50").all(caseId) as Row[]).flatMap(item=>{const provenance=authoritativeJson(item.provenance_json,ProvenanceSchema,"人工记录来源");if(!runtimeProvenanceAuthorized(provenance,authorized))return[];return[{id:String(item.id),field:String(item.field),reason:String(item.reason),createdAt:Number(item.created_at),label:"人工记录" as const}];});
      return CaseDetailOutputSchema.parse({...display.summary,projection,sourceIds,sources:sourceViews,timeline,evidence,currentCycle,historicalCycles,manualRecords});
    },
    reviewQueue(input) {
      const raw = ReviewQueueSchema.parse(input), filter = raw.filter;
      const { page, pageSize } = raw;
      if (filter === "notifications") {
        const reminders = localReminders();
        return { items: reminders.slice((page - 1) * pageSize, page * pageSize).map(({ reminderKey: _key, ...row }) => row), total: reminders.length, page, pageSize };
      }
      const params:(string|number)[]=[];
      let sql = `SELECT s.id source_id,s.mailbox_id,s.source_version,s.state source_state,s.trust source_trust,s.observed_at,m.address mailbox_address,
        (SELECT mm.date FROM mail_triage_source_aliases a JOIN mail_messages mm ON mm.mailbox_id=a.mailbox_id AND mm.folder=a.folder AND mm.uid_validity=a.uid_validity AND mm.uid=a.uid WHERE a.source_id=s.id AND a.active=1 ORDER BY a.folder,a.uid LIMIT 1) mail_date,
        (SELECT count(*) FROM mail_triage_source_aliases a WHERE a.source_id=s.id AND a.active=1) alias_count,
        (SELECT case_id FROM mail_case_sources cs WHERE cs.source_id=s.id ORDER BY case_id LIMIT 1) case_id,
        (SELECT count(*) FROM mail_case_sources cs WHERE cs.source_id=s.id) case_count,
        (SELECT folder FROM mail_triage_source_aliases a WHERE a.source_id=s.id AND a.active=1 ORDER BY folder,uid LIMIT 1) folder,
        (SELECT uid_validity FROM mail_triage_source_aliases a WHERE a.source_id=s.id AND a.active=1 ORDER BY folder,uid LIMIT 1) uid_validity,
        (SELECT uid FROM mail_triage_source_aliases a WHERE a.source_id=s.id AND a.active=1 ORDER BY folder,uid LIMIT 1) uid,
        j.id job_id,COALESCE(j.state,'unreviewed') state,j.last_error reason,COALESCE(j.updated_at,s.observed_at) updated_at
        FROM mail_triage_sources s JOIN mailboxes m ON m.id=s.mailbox_id LEFT JOIN mail_triage_jobs j ON j.id=(SELECT id FROM mail_triage_jobs x WHERE x.source_id=s.id AND x.source_version=s.source_version AND x.config_epoch=(SELECT config_epoch FROM mail_triage_settings WHERE id=1) ORDER BY updated_at DESC,id DESC LIMIT 1) WHERE ${authorizedSourcePredicate("s")}`;
      if (filter === "unreviewed") sql += " AND NOT EXISTS(SELECT 1 FROM mail_triage_assessments a JOIN mail_triage_jobs aj ON aj.id=a.job_id WHERE a.source_id=s.id AND a.stale=0 AND aj.source_version=s.source_version AND aj.config_epoch=(SELECT config_epoch FROM mail_triage_settings WHERE id=1))";
      else if (filter === "unlinked") sql += " AND NOT EXISTS(SELECT 1 FROM mail_case_sources cs WHERE cs.source_id=s.id)";
      else if (filter === "failed") sql += " AND j.state IN ('failed','blocked_config','stale_source')";
      else if (filter === "review") sql += " AND j.state='needs_review'";
      else if (filter === "audit") sql += ` AND EXISTS(SELECT 1 FROM mail_triage_assessments a JOIN mail_triage_jobs aj ON aj.id=a.job_id JOIN mail_triage_audit_positions ap ON ap.assessment_id=a.id JOIN mail_triage_audit_counters ac USING(provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version) JOIN mail_triage_qualifications q USING(provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version) WHERE a.source_id=s.id AND a.stale=0 AND aj.source_version=s.source_version AND aj.config_epoch=(SELECT config_epoch FROM mail_triage_settings WHERE id=1) AND (ap.sampled=1 OR (q.unresolved_recheck=1 AND ap.sequence>ac.last_passed_boundary)) AND (ap.verdict IS NULL OR ap.verdict='missed_action') AND ${sourceIdsAuthorizedSql("a.support_source_ids_json", "queue_audit")})`;
      else if(filter==="notification_mail")sql+=` AND EXISTS(SELECT 1 FROM mail_triage_assessments safe_a JOIN mail_triage_jobs safe_j ON safe_j.id=safe_a.job_id
        JOIN mail_triage_settings safe_cfg ON safe_cfg.id=1 AND safe_cfg.auto_notifications=1
        JOIN mail_triage_qualifications safe_q ON safe_q.provider_id=safe_j.provider_id AND safe_q.model_id=safe_j.model_id AND safe_q.model_config_revision=safe_j.model_config_revision AND safe_q.prompt_version=safe_j.prompt_version AND safe_q.rule_version=safe_j.rule_version AND safe_q.schema_version=safe_j.schema_version
        JOIN mail_triage_audit_positions safe_ap ON safe_ap.assessment_id=safe_a.id AND safe_ap.provider_id=safe_j.provider_id AND safe_ap.model_id=safe_j.model_id AND safe_ap.model_config_revision=safe_j.model_config_revision AND safe_ap.prompt_version=safe_j.prompt_version AND safe_ap.rule_version=safe_j.rule_version AND safe_ap.schema_version=safe_j.schema_version
        WHERE safe_a.source_id=s.id AND safe_a.stale=0 AND safe_j.source_version=s.source_version AND safe_j.config_epoch=safe_cfg.config_epoch AND safe_q.notification_state='approved' AND safe_q.unresolved_recheck=0
          AND ((safe_ap.sampled=0 AND (safe_ap.verdict IS NULL OR safe_ap.verdict='passed')) OR (safe_ap.sampled=1 AND safe_ap.verdict='passed'))
          AND safe_a.grade='evidence_complete' AND json_extract(safe_a.validated_json,'$.requiresHumanReview')=0
          AND json_array_length(safe_a.validated_json,'$.uncertainties')=0 AND json_array_length(safe_a.validated_json,'$.actions')=0 AND json_array_length(safe_a.validated_json,'$.completionSuggestions')=0
          AND json_extract(safe_a.validated_json,'$.primaryCategory') IN ('general_other','progress')
          AND NOT EXISTS(SELECT 1 FROM json_each(safe_a.validated_json,'$.events') event WHERE json_extract(event.value,'$.kind')<>'notification')
          AND NOT EXISTS(SELECT 1 FROM json_each(safe_a.validated_json,'$.applicationRestrictions') restriction WHERE restriction.value<>'notification_qualification_required')
          AND ${sourceIdsAuthorizedSql("safe_a.support_source_ids_json","safe_notification_support")})`;
      if(raw.mailboxId!==undefined){sql+=" AND s.mailbox_id=?";params.push(raw.mailboxId);}
      if(raw.query){sql+=" AND (instr(lower(m.address),?)>0 OR EXISTS(SELECT 1 FROM mail_triage_assessments search_a JOIN mail_triage_jobs search_j ON search_j.id=search_a.job_id WHERE search_a.source_id=s.id AND search_a.stale=0 AND search_j.source_version=s.source_version AND search_j.config_epoch=(SELECT config_epoch FROM mail_triage_settings WHERE id=1) AND instr(lower(json_extract(search_a.validated_json,'$.summary')),?)>0))";const query=raw.query.toLocaleLowerCase();params.push(query,query);}
      const total = Number(db.prepare(`SELECT count(*) n FROM (${sql})`).get(...params)!.n);
      const items = (db.prepare(`${sql} ORDER BY updated_at DESC,source_id LIMIT ? OFFSET ?`).all(...params,pageSize, (page - 1) * pageSize) as Row[]).map(row => {
        const sourceId=String(row.source_id),sourceVersion=Number(row.source_version);
        let current: ReturnType<MailTriageService["result"]> = null,displayError:string|null=null;
        try { current=service.result({sourceId}); } catch(error) {
          if(error instanceof Error&&error.message.startsWith("数据完整性错误：预审评估"))displayError=error.message;
          else throw error;
        }
        const assessment=current?.assessment??null;
        const caseId=row.case_id==null?null:String(row.case_id),readerRef=Number(row.alias_count)===1&&Number(row.case_count)===1&&caseId?{caseId,sourceId,sourceVersion,mailboxId:Number(row.mailbox_id),folder:String(row.folder),uidValidity:String(row.uid_validity),uid:Number(row.uid)}:null;
        return {sourceId,jobId:row.job_id==null?null:String(row.job_id),caseId,state:String(row.state),reason:row.reason==null?null:String(row.reason),updatedAt:Number(row.updated_at),mailboxId:Number(row.mailbox_id),mailboxAddress:String(row.mailbox_address),mailDate:row.mail_date==null?null:Number(row.mail_date),sourceVersion,manualVersion:current?.manualVersion??getSourceManualVersion(db,sourceId),sourceState:row.source_state as ReviewRow["sourceState"],sourceTrust:row.source_trust as ReviewRow["sourceTrust"],tag:assessment?.tag??null,summary:assessment?.summary??null,displayError,readerRef};
      });
      return { items, total, page, pageSize };
    },
    messageAnnotations(raw) {
      const input=MessageAnnotationsInputSchema.parse(raw),requested=new Map(input.messages.map(item=>[item.uid,item.readIdentity]));
      if(!requested.size)return{items:[]};
      const placeholders=[...requested].map(()=>"?").join(",");
      const rows=db.prepare(`SELECT mm.uid,mm.uid_validity,s.id source_id,s.source_version,s.source_hash,s.critical_headers_hash,s.trust,
        a.validated_json,a.grade,j.state job_state,sa.folder,sa.mailbox_id,
        COALESCE((SELECT MAX(md.applied_version) FROM mail_case_manual_decisions md WHERE md.case_id IS NULL AND md.object_id=s.id),0) manual_version,
        (SELECT md.after_json FROM mail_case_manual_decisions md WHERE md.case_id IS NULL AND md.object_id=s.id AND md.field='tag' ORDER BY md.applied_version DESC,md.id DESC LIMIT 1) tag_override
        FROM mail_messages mm
        JOIN mail_triage_source_aliases sa ON sa.mailbox_id=mm.mailbox_id AND sa.folder=mm.folder AND sa.uid_validity=mm.uid_validity AND sa.uid=mm.uid AND sa.active=1
        JOIN mail_triage_sources s ON s.id=sa.source_id AND s.mailbox_id=sa.mailbox_id
        JOIN mail_triage_settings cfg ON cfg.id=1 AND cfg.enabled=1 AND cfg.state<>'disabled'
        JOIN mail_triage_scope scope ON scope.mailbox_id=s.mailbox_id AND scope.epoch=cfg.config_epoch AND scope.state='authorized' AND scope.uid_validity=sa.uid_validity AND scope.effective_at IS NOT NULL
        JOIN model_roles role ON role.role='mail_triage'
        JOIN mail_triage_jobs j ON j.id=(SELECT candidate.id FROM mail_triage_jobs candidate WHERE candidate.source_id=s.id AND candidate.source_version=s.source_version AND candidate.config_epoch=cfg.config_epoch AND candidate.provider_id=role.provider_id AND candidate.model_id=role.model_id AND candidate.model_config_revision=cfg.model_config_revision AND candidate.prompt_version=1 AND candidate.rule_version=1 AND candidate.schema_version=1 ORDER BY candidate.updated_at DESC,candidate.id DESC LIMIT 1)
        JOIN mail_triage_assessments a ON a.job_id=j.id AND a.source_id=s.id AND a.stale=0
        JOIN mailboxes box ON box.id=s.mailbox_id AND box.status NOT IN ('deleting','closed','deleted')
        WHERE mm.mailbox_id=? AND mm.folder=? AND mm.uid IN (${placeholders}) AND ${authorizedSourcePredicate("s")}
          AND ${sourceIdsAuthorizedSql("a.support_source_ids_json","annotation_support")}
        ORDER BY mm.uid`).all(input.mailboxId,input.folder,...requested.keys()) as Row[];
      const items=rows.flatMap(row=>{
        const locator={mailboxId:Number(row.mailbox_id),folder:String(row.folder),uidValidity:String(row.uid_validity),uid:Number(row.uid)};
        const readIdentity=cacheReadIdentity(key,locator,{sourceHash:String(row.source_hash),criticalHeadersHash:String(row.critical_headers_hash)}),expected=requested.get(locator.uid);
        if(!expected||expected.length!==readIdentity.length||!timingSafeEqual(Buffer.from(expected),Buffer.from(readIdentity)))return[];
        const assessment=authoritativeJson(row.validated_json,PersistedValidatedAssessmentSchema,"预审评估");
        let tag=assessment.tag;
        if(row.tag_override!=null){const override=authoritativeJson(row.tag_override,{safeParse(value:unknown){if(!value||typeof value!=="object")return{success:false}as const;const record=value as Record<string,unknown>,candidate=record.tag;if(Number(record.sourceVersion)!==Number(row.source_version)||typeof candidate!=="string"||Array.from(candidate).length<2||Array.from(candidate).length>6||!/^\p{Script=Han}+$/u.test(candidate))return{success:false}as const;return{success:true,data:String(candidate)}as const;}},"人工预审覆盖");tag=String(override);}
        return[{uid:locator.uid,readIdentity,sourceId:String(row.source_id),sourceVersion:Number(row.source_version),manualVersion:Number(row.manual_version),tag,summary:assessment.summary,grade:row.grade as MailMessageAnnotationsResult["items"][number]["grade"],reviewState:row.job_state as MailMessageAnnotationsResult["items"][number]["reviewState"],sourceRef:{sourceId:String(row.source_id),sourceVersion:Number(row.source_version),...locator}}];
      });
      return{items};
    },
    sourcePreview(raw) {
      const base=deps.mailboxes.sourcePreview(raw as {sourceId:string;sourceVersion:number});
      let result:ReturnType<MailTriageService["result"]>;
      try{result=service.result({sourceId:base.sourceRef.sourceId});}catch(error){if(error instanceof Error&&error.message.startsWith("数据完整性错误：预审评估"))return{...base,assessment:null,grade:null,displayError:error.message};throw error;}
      if(!result||result.sourceVersion!==base.sourceRef.sourceVersion)throw new Error("source_unavailable");
      return {...base,assessment:result.assessment,grade:result.grade,displayError:null};
    },
    evaluationStatus(raw) {
      if(!raw||typeof raw!=="object"||!("providerId" in raw)||!("modelId" in raw))throw new Error("版本tuple无效");
      return getEvaluationStatus(db,raw as Parameters<typeof getEvaluationStatus>[1]);
    },
    saveEvaluationReport(raw) { writable(); return saveEvaluationReportRecord(db, raw as Parameters<typeof saveEvaluationReportRecord>[1], deps.actor!, clock()); },
    approveNotificationRouting(raw) { writable(); return approveNotificationRoutingRecord(db, raw as Parameters<typeof approveNotificationRoutingRecord>[1], deps.actor!, clock()); },
    auditOutcome(raw) { writable(); const result=recordNotificationAudit(db, raw as Parameters<typeof recordNotificationAudit>[1], deps.actor!, clock());const sourceIds=result.recheckAssessmentIds.length?(db.prepare(`SELECT DISTINCT s.id FROM mail_triage_assessments a JOIN json_each(?) pending ON pending.value=a.id JOIN mail_triage_jobs j ON j.id=a.job_id JOIN mail_triage_sources s ON s.id=a.source_id WHERE a.stale=0 AND j.source_version=s.source_version AND j.config_epoch=(SELECT config_epoch FROM mail_triage_settings WHERE id=1) AND ${authorizedSourcePredicate("s")} AND ${sourceIdsAuthorizedSql("a.support_source_ids_json","audit_result_support")} ORDER BY s.id`).all(JSON.stringify(result.recheckAssessmentIds)) as Row[]).map(row=>String(row.id)):[];deferredLocalChanged(); return {...result,recheckSourceIds:sourceIds}; },
    async configure(raw) {
      const by = writable();
      const input = ConfigureTriageSchema.parse(raw);
      const mailboxIds = requireMailboxIds(input.mailboxIds);
      const inputHash = hash({ ...input, mailboxIds });
      const prior = request(input.requestId, "configure", inputHash);
      if (!input.enabled) {
        if (!prior) {
          const aborted = atomic(db, () => {
            const current = db.prepare("SELECT version,reminder_enabled,reminder_settings_json FROM mail_triage_settings WHERE id=1").get()!;
            if (Number(current.version) !== input.expectedVersion) throw new Error("设置版本冲突");
            const reminderSettings = input.reminderSettings ?? authoritativeJson(current.reminder_settings_json, ReminderSettingsSchema, "提醒设置");
            db.prepare("UPDATE mail_triage_settings SET mode=?,daily_attempt_limit=?,reminder_enabled=?,reminder_settings_json=?,auto_notifications=0 WHERE id=1").run(input.mode, input.dailyAttemptLimit, (input.reminderEnabled ?? (current.reminder_enabled === 1)) ? 1 : 0, json(reminderSettings));
            const result = invalidateTriageScope(db, { mailboxIds: [], reason: "disable" }, clock());
            remember(input.requestId, "configure", inputHash, { disabled: true, actor: by });
            return result.abortSourceIds;
          });
          worker.abortSources(aborted); deferredChanged();
        }
        return readSettings();
      }
      if (!input.modelBinding || input.consentProviderRevision == null) throw new Error("启用邮件预审必须明确模型绑定和服务商revision");
      const binding = input.modelBinding, consentProviderRevision = input.consentProviderRevision;
      const provider = db.prepare("SELECT id,config_revision,api_key_ciphertext,models_json FROM model_providers WHERE id=?").get(binding.providerId);
      const decodedModels = provider ? (() => { try { return JSON.parse(String(provider.models_json)); } catch { throw new Error("数据完整性错误：模型目录不是有效JSON"); } })() : [];
      if (!Array.isArray(decodedModels) || decodedModels.some(item => !item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string")) throw new Error("数据完整性错误：模型目录结构无效");
      const models = decodedModels as { id: string }[];
      if (!provider || !provider.api_key_ciphertext || !models.some(model => model.id === binding.modelId)) throw new Error("邮件预审角色尚未就绪");
      if (Number(provider.config_revision) !== consentProviderRevision) throw new Error("模型服务商配置已变化，请重新同意正文外发目的地");
      const before = readSettings();
      const authorityUnchanged = before.enabled && ["enabled", "paused_budget", "paused_audit"].includes(before.state)
        && before.mode === input.mode && before.dailyAttemptLimit === input.dailyAttemptLimit
        && before.consentProviderRevision === consentProviderRevision
        && before.modelBinding?.providerId === binding.providerId && before.modelBinding.modelId === binding.modelId
        && before.modelBinding.thinking === binding.thinking
        && json(before.mailboxIds) === json(mailboxIds);
      if (authorityUnchanged) {
        if (!prior) atomic(db, () => {
          const current = db.prepare("SELECT enabled,state,version,config_epoch,model_config_revision,mode,daily_attempt_limit,consent_provider_revision FROM mail_triage_settings WHERE id=1").get()!;
          if (Number(current.version) !== input.expectedVersion) throw new Error("设置版本冲突");
          const currentRole = db.prepare("SELECT provider_id,model_id,thinking FROM model_roles WHERE role='mail_triage'").get();
          const currentMailboxIds = (db.prepare("SELECT mailbox_id FROM mail_triage_scope WHERE state='authorized' AND epoch=? ORDER BY mailbox_id").all(current.config_epoch) as Row[]).map(row => Number(row.mailbox_id));
          if (current.enabled !== 1 || current.state !== before.state || Number(current.config_epoch) !== before.configEpoch
            || Number(current.model_config_revision) !== before.modelConfigRevision || current.mode !== before.mode
            || Number(current.daily_attempt_limit) !== before.dailyAttemptLimit || Number(current.consent_provider_revision) !== before.consentProviderRevision
            || Number(currentRole?.provider_id) !== binding.providerId || String(currentRole?.model_id) !== binding.modelId || String(currentRole?.thinking) !== binding.thinking
            || json(currentMailboxIds) !== json(mailboxIds)) throw new Error("预审权威配置已变化");
          const reminderSettings = input.reminderSettings ?? before.reminderSettings;
          const changed = db.prepare("UPDATE mail_triage_settings SET reminder_enabled=?,reminder_settings_json=?,version=version+1 WHERE id=1 AND version=?").run((input.reminderEnabled ?? before.reminderEnabled) ? 1 : 0, json(reminderSettings), input.expectedVersion);
          if (changed.changes !== 1) throw new Error("设置版本冲突");
          remember(input.requestId, "configure", inputHash, { reminderOnly: true, actor: by });
        });
        if (!prior) deferredLocalChanged();
        return readSettings();
      }
      const recovering = !prior && before.state === "initializing" && !before.enabled && before.version === input.expectedVersion
        && before.mode === input.mode && before.dailyAttemptLimit === input.dailyAttemptLimit
        && before.reminderEnabled === (input.reminderEnabled ?? before.reminderEnabled)
        && canonical(before.reminderSettings) === canonical(input.reminderSettings ?? before.reminderSettings)
        && before.consentProviderRevision === consentProviderRevision
        && before.modelBinding?.providerId === binding.providerId && before.modelBinding.modelId === binding.modelId
        && before.modelBinding.thinking === binding.thinking
        && json(before.mailboxIds) === json(mailboxIds);
      if (recovering) atomic(db, () => remember(input.requestId, "configure", inputHash, { epoch: before.configEpoch, resumed: true, actor: by }));
      else if (!prior) {
        const aborted = atomic(db, () => {
          const cfg = db.prepare("SELECT version,config_epoch,model_config_revision FROM mail_triage_settings WHERE id=1").get()!;
          if (Number(cfg.version) !== input.expectedVersion) throw new Error("设置版本冲突");
          const epoch = Number(cfg.config_epoch) + 1, revision = Number(cfg.model_config_revision) + 1;
          db.prepare("INSERT INTO model_roles(role,provider_id,model_id,thinking) VALUES('mail_triage',?,?,?) ON CONFLICT(role) DO UPDATE SET provider_id=excluded.provider_id,model_id=excluded.model_id,thinking=excluded.thinking").run(binding.providerId, binding.modelId, binding.thinking);
          const sourceIds = (db.prepare("SELECT id FROM mail_triage_sources WHERE state='active'").all() as Row[]).map(row => String(row.id));
          db.prepare("UPDATE mail_triage_jobs SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,last_error='configuration_changed',updated_at=? WHERE state<>'cancelled'").run(clock());
          db.prepare("UPDATE mail_triage_settings SET enabled=0,state='initializing',config_epoch=?,model_config_revision=?,version=version+1,mode=?,daily_attempt_limit=?,consent_provider_revision=?,reminder_enabled=?,reminder_settings_json=?,auto_notifications=0 WHERE id=1").run(epoch, revision, input.mode, input.dailyAttemptLimit, consentProviderRevision, (input.reminderEnabled ?? before.reminderEnabled) ? 1 : 0, json(input.reminderSettings ?? before.reminderSettings));
          db.prepare("UPDATE mail_triage_scope SET state='revoked',scope_version=scope_version+1 WHERE mailbox_id NOT IN (SELECT value FROM json_each(?))").run(json(mailboxIds));
          for (const mailboxId of mailboxIds) db.prepare("INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at,scope_version) VALUES(?,?,'authorized',NULL,0,NULL,1) ON CONFLICT(mailbox_id) DO UPDATE SET epoch=excluded.epoch,state='authorized',uid_validity=NULL,baseline_uid=0,effective_at=NULL,scope_version=mail_triage_scope.scope_version+1").run(mailboxId, epoch);
          remember(input.requestId, "configure", inputHash, { epoch, actor: by });
          return sourceIds;
        });
        worker.abortSources(aborted);
      }
      const cfg = readSettings();
      if (cfg.state === "enabled" && cfg.enabled) return cfg;
      if (cfg.state !== "initializing") throw new Error("预审设置不在可恢复的初始化状态");
      for (const mailboxId of mailboxIds) {
        const scope = db.prepare("SELECT uid_validity,effective_at FROM mail_triage_scope WHERE mailbox_id=? AND epoch=? AND state='authorized'").get(mailboxId, cfg.configEpoch);
        if (!scope) throw new Error("邮箱授权范围已变化");
        if (scope.uid_validity == null || scope.effective_at == null) {
          await mailboxes.withInboxSnapshot(mailboxId, snapshot => {
            const current = db.prepare("SELECT state,config_epoch FROM mail_triage_settings WHERE id=1").get()!;
            if (current.state !== "initializing" || Number(current.config_epoch) !== cfg.configEpoch) throw new Error("初始化世代已变化");
            const changed = db.prepare("UPDATE mail_triage_scope SET uid_validity=?,baseline_uid=?,effective_at=?,scope_version=scope_version+1 WHERE mailbox_id=? AND epoch=? AND state='authorized' AND effective_at IS NULL").run(snapshot.uidValidity, snapshot.maxUid, clock(), mailboxId, cfg.configEpoch);
            if (changed.changes !== 1) throw new Error("初始化水位并发冲突");
          });
          await mailboxes.withInboxSnapshot(mailboxId, () => undefined);
        }
      }
      atomic(db, () => {
        const incomplete = db.prepare("SELECT 1 FROM mail_triage_scope WHERE epoch=? AND state='authorized' AND (uid_validity IS NULL OR effective_at IS NULL) LIMIT 1").get(cfg.configEpoch);
        if (incomplete) throw new Error("仍有邮箱水位未完成");
        const changed = db.prepare("UPDATE mail_triage_settings SET enabled=1,state='enabled' WHERE id=1 AND state='initializing' AND config_epoch=?").run(cfg.configEpoch);
        if (changed.changes !== 1) throw new Error("初始化提交冲突");
        remember(input.requestId, "configure", inputHash, { epoch: cfg.configEpoch, completed: true, actor: by });
      });
      deferredChanged();
      return readSettings();
    },
    backfillPreview(raw) {
      const input = BackfillPreviewSchema.parse(raw), mailboxIds = requireMailboxIds(input.mailboxIds), now = clock();
      const cfg = readSettings();
      if (!cfg.enabled || cfg.state !== "enabled" || mailboxIds.some(id => !cfg.mailboxIds.includes(id))) throw new Error("补审范围未授权");
      const since = now - input.days * 24 * 60 * 60 * 1000;
      const rows = db.prepare(`SELECT m.* FROM mail_messages m
        JOIN mail_triage_scope scope ON scope.mailbox_id=m.mailbox_id
        JOIN mail_triage_settings settings ON settings.id=1 AND settings.enabled=1 AND settings.state='enabled' AND scope.epoch=settings.config_epoch
        JOIN mailboxes box ON box.id=m.mailbox_id AND box.status NOT IN ('deleting','closed','deleted')
        WHERE m.mailbox_id IN (SELECT value FROM json_each(?)) AND scope.state='authorized' AND scope.uid_validity=m.uid_validity AND scope.effective_at IS NOT NULL
          AND m.folder='INBOX' AND m.body_complete=1 AND length(trim(m.body_text))>0 AND COALESCE(m.date,0)>=?
          AND NOT EXISTS(SELECT 1 FROM abandoned_domains abandoned WHERE abandoned.domain=box.domain COLLATE NOCASE)
        ORDER BY m.date DESC,m.mailbox_id,m.uid LIMIT ?`).all(json(mailboxIds), since, MAIL_TRIAGE_LIMITS.historyBatchSize) as Row[];
      const entries = rows.flatMap(row => {
        const locator = { mailboxId: Number(row.mailbox_id), folder: String(row.folder), uidValidity: String(row.uid_validity), uid: Number(row.uid) };
        if (!mailboxes.isAvailable(locator.mailboxId) || !verifiedUidValidity(locator.uidValidity)) return [];
        const fingerprints = fingerprintSource(key, cachedParsedMessage(row));
        return [{ locator, ...fingerprints }];
      }), expiresAt = now + 10 * 60_000;
      const scopes = db.prepare("SELECT mailbox_id,scope_version,uid_validity FROM mail_triage_scope WHERE mailbox_id IN (SELECT value FROM json_each(?)) ORDER BY mailbox_id").all(json(mailboxIds));
      const payload = Buffer.from(json({ v: 1, configEpoch: cfg.configEpoch, mailboxIds, entries, scopeHash: hash(scopes), expiresAt })).toString("base64url");
      const signature = createHmac("sha256", key).update(`mail-triage.preview.v1\0${payload}`).digest("base64url");
      return { previewId: `${payload}.${signature}`, count: entries.length, limit: MAIL_TRIAGE_LIMITS.historyBatchSize, expiresAt };
    },
    enqueue(raw) {
      writable();
      const input = EnqueueTriageSchema.parse(raw);
      const directSourceIds = "sourceIds" in input ? unique(input.sourceIds) : [];
      const inputHash = hash("previewId" in input ? { previewId: input.previewId } : { sourceIds: directSourceIds });
      const old = request(input.requestId, "enqueue", inputHash);
      if (old?.result_ref_json) return authoritativeJson(old.result_ref_json, BackfillBatchResultSchema, "补审批次结果");
      const cfg = readSettings();
      if (!cfg.enabled || cfg.state !== "enabled" || !cfg.modelBinding || cfg.consentProviderRevision == null) throw new Error("邮件预审尚未启用");
      let sourceIds: string[] = [], preview: ReturnType<typeof HistoricalPreviewTokenSchema.parse> | null = null;
      if ("previewId" in input) {
        const [payload, signature, extra] = input.previewId.split(".");
        if (!payload || !signature || extra) throw new Error("补审预览无效");
        const expected = createHmac("sha256", key).update(`mail-triage.preview.v1\0${payload}`).digest();
        const actual = Buffer.from(signature, "base64url");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("补审预览无效");
        const parsedPreview = HistoricalPreviewTokenSchema.safeParse(untrustedPreviewJson(Buffer.from(payload, "base64url").toString()));
        if (!parsedPreview.success) throw new Error("补审预览无效");
        preview = parsedPreview.data;
        if (preview.expiresAt < clock() || preview.configEpoch !== cfg.configEpoch) throw new Error("补审预览已过期或范围已变化");
        if (preview.mailboxIds.some(id => !cfg.mailboxIds.includes(id))) throw new Error("补审范围已变化，请重新预览");
        const scopes = db.prepare("SELECT mailbox_id,scope_version,uid_validity FROM mail_triage_scope WHERE mailbox_id IN (SELECT value FROM json_each(?)) ORDER BY mailbox_id").all(json(preview.mailboxIds));
        if (hash(scopes) !== preview.scopeHash) throw new Error("补审范围已变化，请重新预览");
      } else sourceIds = directSourceIds;
      if ((preview?.entries.length ?? sourceIds.length) > MAIL_TRIAGE_LIMITS.historyBatchSize) throw new Error("单批最多补审200封");
      const result = atomic(db, () => {
        const role = db.prepare("SELECT provider_id,model_id FROM model_roles WHERE role='mail_triage'").get()!;
        const jobIds: string[] = [];
        if (preview) {
          for (const entry of preview.entries) {
            if (!mailboxes.isAvailable(entry.locator.mailboxId)) throw new Error("补审邮箱生命周期已变化，请重新预览");
            const row = db.prepare(`SELECT m.* FROM mail_messages m JOIN mail_triage_scope scope ON scope.mailbox_id=m.mailbox_id
              JOIN mail_triage_settings settings ON settings.id=1 AND settings.enabled=1 AND settings.state='enabled' AND settings.config_epoch=? AND scope.epoch=settings.config_epoch
              JOIN mailboxes box ON box.id=m.mailbox_id AND box.status NOT IN ('deleting','closed','deleted')
              WHERE m.mailbox_id=? AND m.folder=? AND m.uid_validity=? AND m.uid=? AND m.body_complete=1 AND length(trim(m.body_text))>0
                AND scope.state='authorized' AND scope.uid_validity=m.uid_validity AND scope.effective_at IS NOT NULL
                AND NOT EXISTS(SELECT 1 FROM abandoned_domains abandoned WHERE abandoned.domain=box.domain COLLATE NOCASE)`)
              .get(cfg.configEpoch, entry.locator.mailboxId, entry.locator.folder, entry.locator.uidValidity, entry.locator.uid) as Row | undefined;
            if (!row) throw new Error("补审范围或本地正文已变化，请重新预览");
            const mail = cachedParsedMessage(row), fingerprints = fingerprintSource(key, mail);
            if (fingerprints.sourceHash !== entry.sourceHash || fingerprints.criticalHeadersHash !== entry.criticalHeadersHash) throw new Error("补审来源内容已变化，请重新预览");
            const source = registerHistoricalCachedSource(db, { locator: entry.locator, mail, observedAt: Number(row.date ?? clock()) }, key, sourceHooks);
            sourceIds.push(source.sourceId);
          }
          sourceIds = unique(sourceIds);
        }
        for (const sourceId of sourceIds) {
          const source = db.prepare(`SELECT id,source_version FROM mail_triage_sources s WHERE id=? AND state='active'
            AND EXISTS(SELECT 1 FROM mail_triage_scope scope WHERE scope.mailbox_id=s.mailbox_id AND scope.state='authorized' AND scope.epoch=?)
            AND EXISTS(SELECT 1 FROM mail_triage_source_aliases a JOIN mail_messages m ON m.mailbox_id=a.mailbox_id AND m.folder=a.folder AND m.uid=a.uid AND m.uid_validity=a.uid_validity WHERE a.source_id=s.id AND a.active=1 AND a.folder='INBOX' AND m.body_complete=1)`
            ).get(sourceId, cfg.configEpoch);
          if (!source) throw new Error("补审来源已失效或未授权");
          const context = `pending-source:${sourceId}:${source.source_version}`, id = randomUUID();
          db.prepare(`INSERT OR IGNORE INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,generation,config_epoch,state,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1,1,?,1,?,'queued',1,?,?)`).run(id, sourceId, source.source_version, role.provider_id, role.model_id, cfg.modelConfigRevision, context, cfg.configEpoch, clock(), clock());
          const job = db.prepare("SELECT id FROM mail_triage_jobs WHERE source_id=? AND source_version=? AND config_epoch=? ORDER BY priority,id LIMIT 1").get(sourceId, source.source_version, cfg.configEpoch);
          if (job) jobIds.push(String(job.id));
          registerPendingReview(db, { sourceId, sourceVersion: Number(source.source_version), configEpoch: cfg.configEpoch, now: clock() });
        }
        const value = { requestId: input.requestId, jobIds: unique(jobIds), sourceIds };
        remember(input.requestId, "enqueue", inputHash, value); return value;
      });
      deferredChanged(); return result;
    },
    retry(raw) {
      writable(); const input = JobMutationSchema.parse(raw), inputHash = hash(input);
      const old = request(input.requestId, "retry", inputHash); if (old?.result_ref_json) return authoritativeJson(old.result_ref_json, JobViewSchema, "重试结果");
      const result = atomic(db, () => {
        const row = db.prepare("SELECT * FROM mail_triage_jobs WHERE id=?").get(input.jobId);
        if (!row || Number(row.attempt_seq) !== input.expectedVersion) throw new Error("任务版本冲突");
        if (!["failed", "needs_review", "blocked_config", "stale_source", "paused_budget"].includes(String(row.state))) throw new Error("当前任务不可重试");
        db.prepare("UPDATE mail_triage_jobs SET state='queued',next_attempt_at=0,last_error=NULL,updated_at=? WHERE id=?").run(clock(), input.jobId);
        const value = viewJob(db.prepare("SELECT * FROM mail_triage_jobs WHERE id=?").get(input.jobId)!); remember(input.requestId, "retry", inputHash, value); return value;
      }); deferredChanged(); return result;
    },
    cancel(raw) {
      writable(); const input = JobMutationSchema.parse(raw), inputHash = hash(input);
      const old = request(input.requestId, "cancel", inputHash); if (old?.result_ref_json) return authoritativeJson(old.result_ref_json, JobViewSchema, "取消结果");
      const sourceId = String(db.prepare("SELECT source_id FROM mail_triage_jobs WHERE id=? AND attempt_seq=?").get(input.jobId, input.expectedVersion)?.source_id ?? "");
      if (!sourceId) throw new Error("任务版本冲突");
      worker.abortSources([sourceId]);
      const value = viewJob(db.prepare("SELECT * FROM mail_triage_jobs WHERE id=?").get(input.jobId)!);
      atomic(db, () => remember(input.requestId, "cancel", inputHash, value)); deferredChanged(); return value;
    },
    contactsList(raw) {
      const { page, pageSize } = pagination(raw), total = Number(db.prepare("SELECT count(*) n FROM mail_triage_contact_groups").get()!.n);
      const items = (db.prepare("SELECT * FROM mail_triage_contact_groups ORDER BY confirmed_at DESC,id LIMIT ? OFFSET ?").all(pageSize, (page - 1) * pageSize) as Row[]).map(row => ({ id: String(row.id), providerKey: String(row.provider_key), siteId: row.site_id == null ? null : Number(row.site_id), mailboxIds: authoritativeJson(row.mailbox_ids_json, ContactMailboxIdsSchema, "联系人邮箱范围"), senderAddresses: authoritativeJson(row.sender_addresses_json, ContactSenderAddressesSchema, "联系人地址"), domains: authoritativeJson(row.domains_json, ContactDomainsSchema, "联系人域名"), version: Number(row.version), reason: String(row.reason), confirmedAt: Number(row.confirmed_at) }));
      return { items, total, page, pageSize };
    },
    contactsSave(raw) {
      if (!raw || typeof raw !== "object" || Object.keys(raw).some(key => !["requestId", "expectedVersion", "reason", "mapping"].includes(key))) throw new Error("联系人映射参数无效");
      const by = writable(), envelope = raw as { requestId?: unknown; expectedVersion?: unknown; reason?: unknown; mapping?: unknown };
      const meta = MutationMetaSchema.parse({ requestId: envelope.requestId, expectedVersion: envelope.expectedVersion, reason: envelope.reason });
      const mapping = ContactMappingSchema.parse(envelope.mapping);
      const mailboxIds = requireMailboxIds(unique(mapping.mailboxIds)), addresses = unique(mapping.senderAddresses.map(value => value.toLowerCase())), domains = unique(mapping.domains.map(value => value.toLowerCase()));
      if (mapping.siteId != null && !db.prepare("SELECT 1 FROM sites WHERE id=?").get(mapping.siteId)) throw new Error("站点不属于当前工作区");
      const inputHash = hash({ expectedVersion: meta.expectedVersion, reason: meta.reason, mapping: { ...mapping, mailboxIds, senderAddresses: addresses, domains } });
      const oldRequest = request(meta.requestId, "contacts.save", inputHash); if (oldRequest?.result_ref_json) return authoritativeJson(oldRequest.result_ref_json, ContactMappingOutputSchema, "联系人保存结果");
      const id = mapping.id ?? randomUUID();
      const value = atomic(db, () => {
        const current = db.prepare("SELECT version FROM mail_triage_contact_groups WHERE id=?").get(id);
        if (Number(current?.version ?? 0) !== meta.expectedVersion) throw new Error("联系人映射版本冲突");
        if (current) db.prepare("DELETE FROM mail_triage_contact_groups WHERE id=?").run(id);
        const version = meta.expectedVersion + 1, now = clock();
        db.prepare("INSERT INTO mail_triage_contact_groups(id,provider_key,site_id,mailbox_ids_json,sender_addresses_json,domains_json,version,reason,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, mapping.providerKey.trim(), mapping.siteId, json(mailboxIds), json(addresses), json(domains), version, meta.reason, by, now);
        for (const mailboxId of mailboxIds) for (const address of addresses) db.prepare("INSERT INTO mail_triage_contacts(id,provider,site_id,mailbox_id,address,version,reason,confirmed_by,confirmed_at,group_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), mapping.providerKey.trim(), mapping.siteId, mailboxId, address, version, meta.reason, by, now, id);
        const result: ContactMapping = { id, providerKey: mapping.providerKey.trim(), siteId: mapping.siteId, mailboxIds, senderAddresses: addresses, domains, version, reason: meta.reason, confirmedAt: now };
        remember(meta.requestId, "contacts.save", inputHash, result); return result;
      }); deferredChanged(); return value;
    },
    contactsRemove(raw) {
      writable(); const input = MutationMetaSchema.extend({ id: ContactMappingSchema.shape.id.unwrap() }).parse(raw), inputHash = hash(input);
      const old = request(input.requestId, "contacts.remove", inputHash); if (old?.result_ref_json) return authoritativeJson(old.result_ref_json, ContactRemoveResultSchema, "联系人删除结果");
      const value = atomic(db, () => {
        const row = db.prepare("SELECT version FROM mail_triage_contact_groups WHERE id=?").get(input.id);
        if (!row || Number(row.version) !== input.expectedVersion) throw new Error("联系人映射版本冲突");
        db.prepare("DELETE FROM mail_triage_contact_groups WHERE id=?").run(input.id);
        const result = { id: input.id, version: input.expectedVersion + 1 }; remember(input.requestId, "contacts.remove", inputHash, result); return result;
      }); deferredChanged(); return value;
    },
    correct(raw) { return manual("correct", raw); },
    link(raw) { return manual("link", raw); },
    split(raw) { return manual("split", raw); },
    confirmCase(raw) { return manual("confirm_case", raw); },
    independentFact(raw) { return manual("independent_fact", raw); },
    appeal(raw) { return manual("appeal_requested", raw); },
    undo(raw) {
      writable();
      const result = undoManualDecision(db, raw as never, deps.actor!, clock());
      worker.abortSources(result.affectedSourceIds);
      deferredLocalChanged();
      return result;
    },
    sourceHooks, lifecycleHooks,
    start() {
      if (deps.readOnly || reminderTimer) return;
      reminderTimer = setInterval(() => { try { scanLocalReminders(); } catch { /* DB关闭或坏行留待下轮，不调用模型。 */ } }, 60_000); reminderTimer.unref();
    },
    stopAccepting() { worker.stopAccepting(); },
    async close() { stopped = true; if (reminderTimer) clearInterval(reminderTimer); reminderTimer = undefined; await worker.close(); },
  };
  return service;
}
