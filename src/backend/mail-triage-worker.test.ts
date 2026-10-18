import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { openDb, migrate } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";
import { setup, key } from "./testing.ts";
import { createProviderConfig, setRole } from "./models.ts";
import { registerPendingReview } from "./mail-case-projector.ts";
import { registerCachedSource } from "./mail-triage-source.ts";
import { createTriageQueue } from "./mail-triage-queue.ts";
import { createTriageScheduler } from "./mail-triage-scheduler.ts";
import { buildTriageContext } from "./mail-triage-context.ts";
import {
  TriageModelError,
  type TriageModelCaller,
} from "./mail-triage-model.ts";
import { createTriageWorker, commitAssessment } from "./mail-triage-worker.ts";
import { applyManualDecision } from "./mail-triage-actions.ts";
import { approveNotificationRouting, saveEvaluationReport, type EvaluationReport } from "./mail-triage-evaluation.ts";
import type { ParsedSafeMessage } from "./mailbox-parser.ts";

function fixture() {
  const { db } = setup({ cachedMailbox: { password: "fixture" } });
  let now = Date.parse("2026-10-16T12:00:00Z");
  const providerId = createProviderConfig(db, key, {
    name: "fixture",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "fake",
    models: [
      {
        id: "fixture",
        name: "fixture",
        contextWindow: 128000,
        maxOutputTokens: 8192,
        vision: false,
        thinkingLevels: ["off"],
      },
    ],
  });
  setRole(db, "mail_triage", {
    providerId,
    modelId: "fixture",
    thinking: "off",
  });
  db.exec(
    "UPDATE mail_triage_settings SET enabled=1,state='enabled',consent_provider_revision=1; INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,effective_at) VALUES(1,1,'authorized','100',0)",
  );
  const source = (uid = 1) => {
    const text = "No action required.";
    const mail: ParsedSafeMessage = {
      messageId: `<${uid}@fixture>`,
      from: "Sender",
      fromAddresses: ["sender@fixture.test"],
      to: ["recipient@fixture.test"],
      cc: [],
      subject: "Notice",
      date: now,
      text,
      snippet: text,
      inReplyTo: null,
      references: [],
      attachments: [],
      bodyComplete: true,
      bodyIssue: null,
    };
    db.prepare(
      `INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,attachments_json) VALUES(1,'INBOX',?,'100',?,?,?,?,?,?,?,?,?,'[]','[]')`,
    ).run(
      uid,
      JSON.stringify(mail.from),
      JSON.stringify(mail.fromAddresses),
      JSON.stringify(mail.to),
      "[]",
      mail.subject,
      now,
      text,
      1,
      mail.messageId,
    );
    return registerCachedSource(
      db,
      {
        locator: { mailboxId: 1, folder: "INBOX", uidValidity: "100", uid },
        mail,
        observedAt: now,
      },
      key,
      {
        onPendingSource: (p) => {
          registerPendingReview(db, {
            sourceId: p.sourceId,
            sourceVersion: p.sourceVersion,
            configEpoch: p.configEpoch,
            now,
          });
        },
      },
    ).sourceId;
  };
  const id = source();
  const clock = () => now;
  let available = true;
  const queue = createTriageQueue(db, clock, {
    jitter: () => 0,
    isMailboxAvailable: () => available,
  });
  const scheduler = createTriageScheduler(1);
  const jobs = () =>
    db.prepare("SELECT * FROM mail_triage_jobs ORDER BY generation,id").all();
  const counts = () => ({
    attempts: Number(
      db.prepare("SELECT count(*) n FROM mail_triage_attempts").get()!.n,
    ),
    assessments: Number(
      db.prepare("SELECT count(*) n FROM mail_triage_assessments").get()!.n,
    ),
  });
  const good = (sourceId = id) =>
    JSON.stringify({
      schemaVersion: 1,
      primaryCategory: "general_other",
      tag: "普通通知",
      summary: "邮件称无需处理",
      caseSuggestion: {
        providerCandidate: null,
        applicationId: null,
        candidateCaseId: null,
        matchBasis: [],
        needsReview: true,
      },
      events: [
        {
          kind: "notification",
          evidence: [{ sourceId, quote: "No action required." }],
        },
      ],
      actions: [],
      completionSuggestions: [],
      uncertainties: [],
      requiresHumanReview: true,
    });
  const worker = (
    callOnce: TriageModelCaller,
    push = () => {},
    shared = scheduler,
    workspaceKey: string = randomUUID(),
  ) =>
    createTriageWorker({
      db,
      key,
      workspaceKey,
      queue,
      scheduler: shared,
      callOnce,
      clock,
      push,
      isMailboxAvailable: () => available,
    });
  return {
    db,
    id,
    source,
    clock,
    queue,
    scheduler,
    jobs,
    counts,
    good,
    worker,
    advance(ms: number) {
      now += ms;
    },
    unavailable() {
      available = false;
    },
    close() {
      scheduler.close();
      db.close();
    },
  };
}
function suspended() {
  let resolve!: (v: {
    text: string;
    usage: { inputTokens: null; outputTokens: null; estimatedCost: null };
  }) => void;
  const promise = new Promise<{
    text: string;
    usage: { inputTokens: null; outputTokens: null; estimatedCost: null };
  }>((r) => (resolve = r));
  return {
    promise,
    resolve(text: string) {
      resolve({
        text,
        usage: { inputTokens: null, outputTokens: null, estimatedCost: null },
      });
    },
  };
}

test("Task12 approved current tuple routes only persisted safe notification and durably samples it", async()=>{
  const f=fixture(),job=f.jobs()[0],tuple={providerId:Number(job.provider_id),modelId:String(job.model_id),modelConfigRevision:Number(job.model_config_revision),promptVersion:Number(job.prompt_version),ruleVersion:Number(job.rule_version),schemaVersion:Number(job.schema_version)};
  const report:EvaluationReport={tuple,datasetSource:"user_authorized_redacted_mail",humanLabelsConfirmed:true,redactedRealMail:true,total:100,strata:{actionRequired:20,finalOrConditionalDecision:20,associationConflict:20,quotedOldRequest:20,incompleteContent:20},missedActionCount:0,incorrectCriticalTransitionCount:0,incorrectCriticalAssociationCount:0,injectionRegression:{independentSet:true,total:5,failures:0},artifactHash:"d".repeat(64)};
  const actor={userId:7},saved=saveEvaluationReport(f.db,{report,requestId:randomUUID(),expectedVersion:0,reason:"保存评估"},actor,f.clock());approveNotificationRouting(f.db,{tuple,reportHash:saved.reportHash,requestId:randomUUID(),expectedVersion:saved.approvalRevision,reason:"批准通知分流"},actor,f.clock());
  const safe=JSON.parse(f.good());safe.caseSuggestion.needsReview=false;safe.requiresHumanReview=false;
  const w=f.worker(async()=>response(JSON.stringify(safe)));try{w.start();await until(()=>f.counts().assessments===1);assert.equal(f.db.prepare("SELECT count(*) n FROM mail_triage_audit_positions WHERE sampled=1").get()!.n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM mail_triage_audits WHERE sampled=1").get()!.n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM mail_case_tasks WHERE obligation_key='review_new_mail'").get()!.n,0);}finally{await w.close();f.close();}
});
const response = (text: string) => ({
  text,
  usage: { inputTokens: null, outputTokens: null, estimatedCost: null },
});
async function until(check: () => boolean) {
  for (let n = 0; n < 150; n++) {
    if (check()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  assert.ok(check(), "condition not reached");
}

test("B31 pending outbox is prepared and wire-preflighted before reservation; push only after durable commit", async () => {
  const f = fixture();
  let calls = 0;
  const w = f.worker(
    async (req, _signal, prepared) => {
      calls++;
      assert.ok(prepared?.wireHash);
      assert.equal(f.counts().attempts, 1);
      assert.equal(
        req.input.contextVersion.startsWith("pending-source:"),
        false,
      );
      return response(f.good());
    },
    () => {
      assert.equal(f.db.isTransaction, false);
      assert.equal(f.counts().assessments, 1);
    },
  );
  try {
    w.start();
    await until(() => f.counts().assessments === 1);
    assert.equal(calls, 1);
    assert.equal(f.jobs()[0].state, "needs_review");
  } finally {
    await w.close();
    f.close();
  }
});

test("B32 real caller dispatches at most three times with persistent 30s/120s backoff", async () => {
  const f = fixture();
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    const e = new TriageModelError("http_5xx");
    e.dispatched = true;
    throw e;
  });
  try {
    w.start();
    await until(() => f.jobs()[0].state === "retry_wait");
    f.advance(30000);
    w.wake();
    await until(() => calls === 2 && f.jobs()[0].state === "retry_wait");
    f.advance(120000);
    w.wake();
    await until(() => f.jobs()[0].state === "failed");
    f.advance(999999);
    w.wake();
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(calls, 3);
    assert.equal(f.counts().attempts, 3);
  } finally {
    await w.close();
    f.close();
  }
});

for (const change of [
  "cancel",
  "disable",
  "source",
  "locator",
  "epoch",
  "provider",
  "lifecycle",
] as const)
  test(`B35/B60 response before commit rejects ${change} without sensitive assessment`, async () => {
    const f = fixture();
    const s = suspended();
    let calls = 0;
    const w = f.worker(async () => {
      calls++;
      return s.promise;
    });
    try {
      w.start();
      await until(() => calls === 1);
      if (change === "cancel") w.abortSources([f.id]);
      if (change === "disable")
        f.db.exec("UPDATE mail_triage_settings SET enabled=0,state='disabled'");
      if (change === "source")
        f.db.exec(
          "UPDATE mail_triage_sources SET source_version=source_version+1",
        );
      if (change === "locator")
        f.db.exec("UPDATE mail_triage_source_aliases SET active=0");
      if (change === "epoch")
        f.db.exec(
          "UPDATE mail_triage_settings SET config_epoch=config_epoch+1",
        );
      if (change === "provider")
        f.db.exec(
          "UPDATE model_providers SET config_revision=config_revision+1",
        );
      if (change === "lifecycle") f.unavailable();
      s.resolve(f.good());
      await until(() => f.jobs()[0].state !== "running");
      assert.equal(f.counts().assessments, 0);
      assert.equal(f.counts().attempts, 1);
      assert.notEqual(
        f.db.prepare("SELECT outcome FROM mail_triage_attempts").get()!.outcome,
        "reserved",
      );
    } finally {
      await w.close();
      f.close();
    }
  });

test("R26 post-dispatch purpose loss settles once as blocked_config without retry or assessment",async()=>{
  const f=fixture();let calls=0;
  const w=f.worker(async()=>{calls++;f.db.exec("DELETE FROM model_roles WHERE role='mail_triage'");return response(f.good());});
  try{
    w.start();await until(()=>f.jobs()[0].state!=="running"&&f.jobs()[0].state!=="queued");
    assert.equal(calls,1);assert.equal(f.jobs().length,1);assert.equal(f.jobs()[0].state,"blocked_config",JSON.stringify(f.jobs()[0]));assert.equal(f.jobs()[0].last_error,"missing_purpose");assert.equal(f.counts().assessments,0);
    const attempt=f.db.prepare("SELECT outcome,usage_json FROM mail_triage_attempts").get()!;assert.equal(attempt.outcome,"failed");assert.ok(attempt.usage_json);
  }finally{await w.close();f.close();}
});

test("R26 post-dispatch persisted task corruption is a sanitized terminal integrity failure",async()=>{
  const f=fixture();let calls=0;
  const w=f.worker(async()=>{calls++;f.db.exec("UPDATE mail_case_tasks SET requested_items_json='{}'");return response(f.good());});
  try{
    w.start();await until(()=>f.jobs()[0].state!=="running"&&f.jobs()[0].state!=="queued");
    assert.equal(calls,1);assert.equal(f.jobs().length,1);assert.equal(f.jobs()[0].state,"failed");assert.equal(f.jobs()[0].last_error,"context_integrity");assert.equal(f.counts().assessments,0);
    const attempt=f.db.prepare("SELECT outcome,usage_json FROM mail_triage_attempts").get()!;assert.equal(attempt.outcome,"failed");assert.ok(attempt.usage_json);assert.equal(JSON.stringify(f.jobs()[0]).includes("requested_items"),false);
  }finally{await w.close();f.close();}
});

test("B41 manual change reprojects without rerunning model, preserving pending review", async () => {
  const f = fixture();
  const s = suspended();
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    return s.promise;
  });
  try {
    w.start();
    await until(() => calls === 1);
    f.db.exec(
      "UPDATE mail_application_cases SET manual_version=manual_version+1,version=version+1",
    );
    s.resolve(f.good());
    await until(() => f.jobs()[0].state !== "running");
    assert.equal(calls, 1);
    assert.equal(f.jobs().length, 1);
    assert.equal(f.counts().assessments, 0);
    assert.ok(
      f.db
        .prepare(
          "SELECT 1 FROM mail_case_tasks WHERE obligation_key='review_new_mail'",
        )
        .get(),
    );
  } finally {
    await w.close();
    f.close();
  }
});

test("B47 persistent context successors stop after two, never an infinite model loop", async () => {
  const f = fixture();
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    f.db.exec("UPDATE mail_triage_scope SET scope_version=scope_version+1");
    return response(f.good());
  });
  try {
    w.start();
    await until(
      () =>
        f.jobs().length === 3 &&
        f.jobs().every((j) => j.state !== "running" && j.state !== "queued"),
    );
    assert.equal(calls, 3);
    assert.equal(f.jobs().length, 3);
    assert.equal(f.jobs()[2].state, "needs_review");
    assert.equal(f.counts().assessments, 0);
  } finally {
    await w.close();
    f.close();
  }
});

test("B58 last daily permit can commit while paused_budget and never dispatches a 501st", async () => {
  const f = fixture();
  f.db.exec("UPDATE mail_triage_settings SET daily_attempt_limit=1");
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    return response(f.good());
  });
  try {
    w.start();
    await until(() => f.jobs()[0].state !== "running" && calls === 1);
    assert.equal(f.counts().assessments, 1);
    assert.equal(
      f.db.prepare("SELECT state FROM mail_triage_settings").get()!.state,
      "paused_budget",
    );
    assert.equal(calls, 1);
  } finally {
    await w.close();
    f.close();
  }
});

for (const kind of ["known-zero", "invalid-json", "unknown"] as const)
  test(`B33 ledger ${kind} refunds only proven caller zero-dispatch`, async () => {
    const f = fixture();
    const w = f.worker(async () => {
      if (kind === "invalid-json") return response("not JSON");
      if (kind === "unknown") throw new Error("untrusted remote error");
      throw new TriageModelError("config_error");
    });
    try {
      w.start();
      await until(() =>
        ["failed", "blocked_config"].includes(String(f.jobs()[0].state)),
      );
      assert.equal(f.counts().attempts, 1);
      assert.equal(
        f.db
          .prepare(
            "SELECT count(*) n FROM mail_triage_attempts WHERE outcome<>'not_dispatched'",
          )
          .get()!.n,
        kind === "known-zero" ? 0 : 1,
      );
      assert.equal(f.counts().assessments, 0);
    } finally {
      await w.close();
      f.close();
    }
  });

test("B53 real cancellation keeps global permit and close pending until transport drained; shutdown is not user cancel", async () => {
  const f = fixture(),
    g = fixture(),
    shared = createTriageScheduler(1);
  const s = suspended();
  let calls = 0,
    other = 0,
    aborted = false,
    closed = false;
  const w = f.worker(
    async (_req, signal) => {
      calls++;
      signal.addEventListener("abort", () => (aborted = true));
      return s.promise;
    },
    () => {},
    shared,
    "one",
  );
  const v = g.worker(
    async () => {
      other++;
      return response(g.good());
    },
    () => {},
    shared,
    "two",
  );
  try {
    w.start();
    await until(() => calls === 1);
    v.start();
    const closing = w.close().then(() => (closed = true));
    await until(() => aborted);
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(other, 0);
    assert.equal(closed, false);
    s.resolve(f.good());
    await closing;
    await until(() => other === 1);
    assert.notEqual(f.jobs()[0].state, "cancelled");
    assert.equal(f.counts().assessments, 0);
  } finally {
    await w.close();
    await v.close();
    shared.close();
    f.close();
    g.close();
  }
});

test("old fence and missing commit snapshot fail closed", () => {
  const f = fixture();
  try {
    assert.equal(
      commitAssessment(
        f.db,
        {
          jobId: "missing",
          leaseToken: "old",
          attemptSeq: 1,
          configEpoch: 1,
          sourceVersion: 1,
          contextVersion: "old",
          manualVersion: 0,
        },
        {} as never,
      ),
      "stale",
    );
  } finally {
    f.close();
  }
});

test("B34 known-zero preserves monotonic audit sequence and excludes only proven zero from budget", async () => {
  const f = fixture();
  const w = f.worker(async () => {
    throw new TriageModelError("config_error");
  });
  try {
    w.start();
    await until(() => f.jobs()[0].state === "blocked_config");
    assert.equal(f.jobs()[0].attempt_seq, 1);
    assert.equal(
      f.db.prepare("SELECT outcome FROM mail_triage_attempts").get()!.outcome,
      "not_dispatched",
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM mail_triage_attempts WHERE outcome<>'not_dispatched'",
        )
        .get()!.n,
      0,
    );
    const old = f.db.prepare("SELECT * FROM mail_triage_jobs").get()!;
    f.db.exec(
      "UPDATE mail_triage_settings SET state='enabled'; UPDATE mail_triage_jobs SET state='queued'",
    );
    const lease = f.queue.claim()!;
    const permit = f.queue.reserveAttempt(lease);
    assert.equal(permit.fence.attemptSeq, 2);
    f.queue.settleNotDispatched(
      {
        jobId: String(old.id),
        leaseToken: String(old.lease_token),
        attemptSeq: 1,
        configEpoch: 1,
        sourceVersion: 1,
        contextVersion: String(old.context_version),
        manualVersion: Number(old.manual_version),
      },
      { code: "config_error", retryable: false },
    );
    assert.equal(
      f.db
        .prepare("SELECT outcome FROM mail_triage_attempts WHERE attempt_seq=2")
        .get()!.outcome,
      "reserved",
    );
  } finally {
    await w.close();
    f.close();
  }
});

test("B36 waiting for scheduler does not claim/start lease, and close removes admission", async () => {
  const f = fixture(),
    shared = createTriageScheduler(1);
  const release = await shared.acquire(
    "busy",
    "new",
    new AbortController().signal,
  );
  let calls = 0;
  const w = f.worker(
    async () => {
      calls++;
      return response(f.good());
    },
    () => {},
    shared,
    "waiting",
  );
  try {
    w.start();
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(f.jobs()[0].state, "queued");
    assert.equal(f.jobs()[0].lease_token, null);
    await w.close();
    release();
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(calls, 0);
    assert.equal(f.counts().attempts, 0);
  } finally {
    release();
    shared.close();
    await w.close();
    f.close();
  }
});

test("B31 placeholder collision stops caller and releases permit for canonical job", async () => {
  const f = fixture();
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    return response(f.good());
  });
  try {
    const input = buildTriageContext(f.db, key, f.id, 1);
    const canonical = f.queue.enqueue({
      sourceId: f.id,
      sourceVersion: 1,
      tuple: input.tuple,
      contextVersion: input.contextVersion,
      generation: 1,
      configEpoch: 1,
      priority: "new",
    });
    f.db
      .prepare("UPDATE mail_triage_jobs SET created_at=created_at+1 WHERE id=?")
      .run(canonical);
    w.start();
    await until(() => f.jobs().some((j) => j.state === "cancelled"));
    await until(() => f.counts().assessments === 1);
    assert.equal(calls, 1);
    assert.equal(f.counts().attempts, 1);
  } finally {
    await w.close();
    f.close();
  }
});

test("B53 virtual clock renews15s, aborts persisted60s deadline, and waits for drain", async (t) => {
  const f = fixture();
  let calls = 0,
    aborted = false;
  const s = suspended();
  const w = f.worker(async (_r, signal) => {
    calls++;
    signal.addEventListener("abort", () => (aborted = true));
    return s.promise;
  });
  try {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    w.start();
    await until(() => calls === 1);
    const before = Number(f.jobs()[0].lease_expires_at);
    f.advance(15000);
    t.mock.timers.tick(15000);
    assert.equal(Number(f.jobs()[0].lease_expires_at), before + 15000);
    f.advance(45000);
    t.mock.timers.tick(45000);
    assert.equal(aborted, true);
    assert.equal(f.jobs()[0].state, "running");
    s.resolve(f.good());
    await until(() => f.jobs()[0].state === "retry_wait");
    assert.equal(f.counts().assessments, 0);
    assert.equal(f.counts().attempts, 1);
  } finally {
    await w.close();
    t.mock.timers.reset();
    f.close();
  }
});

test("B58 actual installed adapter uses prepared wire on final daily permit, 501st zero fetch", async () => {
  const f = fixture();
  const { completeTriageOnce } = await import("./mail-triage-model.ts");
  f.advance(Date.now() - f.clock());
  f.db.exec("UPDATE mail_triage_settings SET daily_attempt_limit=1");
  let fetches = 0;
  const w = f.worker((r, s, prepared) =>
    completeTriageOnce(r, s, {
      db: f.db,
      key,
      prepared,
      fetch: async () => {
        fetches++;
        const text = f.good();
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    }),
  );
  try {
    w.start();
    await until(
      () => f.jobs()[0].state !== "running" && f.jobs()[0].state !== "queued",
    );
    assert.equal(f.counts().assessments, 1);
    assert.equal(fetches, 1);
    f.source(2);
    w.wake();
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(fetches, 1);
    assert.equal(f.counts().attempts, 1);
  } finally {
    await w.close();
    f.close();
  }
});

for (const mode of ["consent", "hash", "tuple"] as const)
  test(`B35 full transaction fence rejects changed ${mode}`, async () => {
    const f = fixture(),
      s = suspended();
    let calls = 0;
    const w = f.worker(async () => {
      calls++;
      return s.promise;
    });
    try {
      w.start();
      await until(() => calls === 1);
      if (mode === "consent")
        f.db.exec(
          "UPDATE mail_triage_settings SET consent_provider_revision=99",
        );
      if (mode === "hash")
        f.db.exec("UPDATE mail_triage_sources SET source_hash='changed'");
      if (mode === "tuple")
        f.db.exec("UPDATE mail_triage_jobs SET rule_version=2");
      s.resolve(f.good());
      await until(() => f.jobs()[0].state !== "running");
      assert.equal(f.counts().assessments, 0);
      assert.equal(f.counts().attempts, 1);
    } finally {
      await w.close();
      f.close();
    }
  });

test("migration017 preserves 001-016 and every reserved/unknown/anonymized audit, index and foreign-key semantics", () => {
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(MIGRATIONS.slice(0, 16)))
      .digest("hex"),
    "15510658c7d9927af2d1d93178d3c2c6991b9b8fdf8b255c458662eb20e35eaa",
  );
  const db = openDb(":memory:");
  try {
    for (const sql of MIGRATIONS.slice(0, 16)) db.exec(sql);
    db.exec("PRAGMA user_version=16");
    db.exec(`INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,status,created_at) VALUES(1,'fixture',X'00','0000','ok',0);
 INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,status) VALUES(1,1,'o','r','mail@example.test','example.test','active');
 INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,observed_at) VALUES('source',1,'h','h',0);
 INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,config_epoch) VALUES('job','source',1,1,'m',1,1,1,1,'ctx',1);`);
    for (const [id, job, seq, outcome] of [
      ["reserved", "job", 1, "reserved"],
      ["unknown", "job", 2, "unknown"],
      ["anonymous", null, 3, "unknown"],
    ] as const)
      db.prepare(
        "INSERT INTO mail_triage_attempts(id,job_id,attempt_seq,budget_day,reserved_at,deadline_at,outcome,usage_json) VALUES(?,?,?,'2026-10-16',10,60010,?,'{\"inputTokens\":4}')",
      ).run(id, job, seq, outcome);
    const before = db
      .prepare("SELECT * FROM mail_triage_attempts ORDER BY id")
      .all();
    migrate(db);
    assert.deepEqual(
      db.prepare("SELECT * FROM mail_triage_attempts ORDER BY id").all(),
      before,
    );
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='index' AND name='mail_triage_attempts_budget'",
        )
        .get(),
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.prepare(
      "UPDATE mail_triage_attempts SET outcome='not_dispatched' WHERE id='reserved'",
    ).run();
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO mail_triage_attempts(id,job_id,attempt_seq,budget_day,reserved_at,deadline_at) VALUES('duplicate','job',1,'2026-10-16',0,0)",
        )
        .run(),
    );
    db.exec("DELETE FROM mail_triage_jobs WHERE id='job'");
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM mail_triage_attempts WHERE job_id IS NULL",
        )
        .get()!.n,
      3,
    );
  } finally {
    db.close();
  }
});

test("B53/R17 startup with attempted NULL manual vector fails closed after deadline+30", async () => {
  const f = fixture();
  const lease = f.queue.claim()!;
  const input = buildTriageContext(f.db, key, f.id, 1);
  const bound = f.queue.prepareContext(lease, {
    contextVersion: input.contextVersion,
    manualVersion: input.manualVersion,
    tuple: input.tuple,
  })!;
  f.queue.reserveAttempt(bound);
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    return response(f.good());
  });
  try {
    f.advance(89999);
    w.start();
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(calls, 0);
    f.advance(1);
    w.wake();
    await until(() => f.jobs().some(row => row.state === "needs_review"));
    assert.equal(calls, 0);
    assert.equal(f.counts().assessments, 0);
    assert.equal(f.counts().attempts, 1);
    assert.equal(
      f.db
        .prepare("SELECT outcome FROM mail_triage_attempts WHERE attempt_seq=1")
        .get()!.outcome,
      "unknown",
    );
  } finally {
    await w.close();
    f.close();
  }
});

test("B41 manual edit during retry_wait reprojects without another model request", async () => {
  const f = fixture();
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    const e = new TriageModelError("http_5xx");
    e.dispatched = true;
    throw e;
  });
  try {
    w.start();
    await until(() => f.jobs()[0].state === "retry_wait");
    f.db.exec(
      "UPDATE mail_application_cases SET manual_version=manual_version+1,version=version+1",
    );
    f.advance(30000);
    w.wake();
    await until(
      () =>
        !["queued", "running", "retry_wait"].includes(
          String(f.jobs()[0].state),
        ),
    );
    assert.equal(f.jobs()[0].state, "needs_review");
    assert.equal(calls, 1);
    assert.equal(f.counts().attempts, 1);
    assert.equal(f.jobs().length, 1);
  } finally {
    await w.close();
    f.close();
  }
});

test("R17 retry with unchanged context detects source manual clocks, including context source B", async () => {
  const f = fixture();
  const sourceB = f.source(2);
  const caseA = String(f.db.prepare("SELECT case_id FROM mail_case_sources WHERE source_id=? ORDER BY case_id LIMIT 1").get(f.id)!.case_id);
  f.db.prepare("INSERT OR IGNORE INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'fixture-context')").run(caseA, sourceB);
  f.db.prepare("DELETE FROM mail_triage_jobs WHERE source_id=?").run(sourceB);
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    const error = new TriageModelError("http_5xx");
    error.dispatched = true;
    throw error;
  });
  try {
    w.start();
    await until(() => f.jobs().some(row => row.source_id === f.id && row.state === "retry_wait"));
    const job = f.jobs().find(row => row.source_id === f.id)!;
    const vector = JSON.parse(String(job.manual_versions_json));
    assert.equal(vector.v, 2);
    assert.deepEqual(vector.sources.map((entry: [string, number]) => entry[0]).sort(), [f.id, sourceB].sort());
    applyManualDecision(f.db, { kind: "correct", target: { type: "source", id: sourceB, sourceVersion: 1 }, field: "tag", value: "人工纠正", requestId: randomUUID(), expectedVersion: 0, reason: "人工按原文纠正上下文邮件" }, { userId: 7 }, f.clock());
    f.advance(30_000);
    w.wake();
    await until(() => f.jobs().some(row => row.source_id === f.id && row.state === "needs_review"));
    assert.equal(calls, 1);
    assert.equal(f.counts().assessments, 0);
  } finally {
    await w.close();
    f.close();
  }
});

test("B47 changed context before retry produces one persistent successor instead of mutating attempted job", async () => {
  const f = fixture();
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    if (calls === 1) {
      const e = new TriageModelError("http_5xx");
      e.dispatched = true;
      throw e;
    }
    return response(f.good());
  });
  try {
    w.start();
    await until(() => f.jobs()[0].state === "retry_wait");
    const original = String(f.jobs()[0].context_version);
    f.db.exec("UPDATE mail_triage_scope SET scope_version=scope_version+1");
    f.advance(30000);
    w.wake();
    await until(() => f.counts().assessments === 1);
    assert.equal(calls, 2);
    assert.equal(f.jobs().length, 2);
    assert.equal(f.jobs()[0].context_version, original);
    assert.equal(f.jobs()[1].generation, 2);
  } finally {
    await w.close();
    f.close();
  }
});

test("B60 source deletion during dispatched request retains only anonymized settled ledger", async () => {
  const f = fixture(),
    s = suspended();
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    return s.promise;
  });
  try {
    w.start();
    await until(() => calls === 1);
    f.db.prepare("DELETE FROM mail_triage_sources WHERE id=?").run(f.id);
    s.resolve(f.good());
    await until(
      () =>
        f.db.prepare("SELECT outcome FROM mail_triage_attempts").get()!
          .outcome !== "reserved",
    );
    assert.equal(f.counts().assessments, 0);
    const row = f.db.prepare("SELECT * FROM mail_triage_attempts").get()!;
    assert.equal(row.job_id, null);
    assert.equal(row.outcome, "unknown");
    assert.equal(JSON.stringify(row).includes(f.id), false);
  } finally {
    await w.close();
    f.close();
  }
});

test("B31 input/window preflight rejects without reserve or caller and leaves visible review", async () => {
  const f = fixture();
  f.db.exec(
    "UPDATE model_providers SET models_json=json_set(models_json,'$[0].contextWindow',100,'$[0].maxTokens',10)",
  );
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    return response(f.good());
  });
  try {
    w.start();
    await until(
      () => !["running", "queued"].includes(String(f.jobs()[0].state)),
    );
    assert.equal(calls, 0);
    assert.equal(f.counts().attempts, 0);
    assert.equal(f.jobs()[0].state, "needs_review");
    assert.ok(
      f.db
        .prepare(
          "SELECT 1 FROM mail_case_tasks WHERE obligation_key='review_new_mail'",
        )
        .get(),
    );
  } finally {
    await w.close();
    f.close();
  }
});

test("R8 zero-dispatch audit never reduces seq and three later real attempts still exhaust at seq4", async () => {
  const f = fixture();
  let first = true,
    real = 0;
  const w = f.worker(async () => {
    if (first) {
      first = false;
      throw new TriageModelError("config_error");
    }
    real++;
    const e = new TriageModelError("http_5xx");
    e.dispatched = true;
    throw e;
  });
  try {
    w.start();
    await until(() => f.jobs()[0].state === "blocked_config");
    f.db.exec(
      "UPDATE mail_triage_settings SET state='enabled'; UPDATE mail_triage_jobs SET state='queued'",
    );
    w.wake();
    await until(() => real === 1 && f.jobs()[0].state === "retry_wait");
    f.advance(30000);
    w.wake();
    await until(() => real === 2 && f.jobs()[0].state === "retry_wait");
    f.advance(120000);
    w.wake();
    await until(() => f.jobs()[0].state === "failed");
    assert.equal(real, 3);
    assert.equal(f.jobs()[0].attempt_seq, 4);
    assert.equal(f.counts().attempts, 4);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM mail_triage_attempts WHERE outcome<>'not_dispatched'",
        )
        .get()!.n,
      3,
    );
  } finally {
    await w.close();
    f.close();
  }
});

test("R8 release cannot release a reserved lease or revive a cancelled job", () => {
  const f = fixture();
  try {
    const original = f.queue.claim()!;
    const input = buildTriageContext(f.db, key, f.id, 1);
    const lease = f.queue.prepareContext(original, {
      contextVersion: input.contextVersion,
      manualVersion: input.manualVersion,
      tuple: input.tuple,
    })!;
    f.queue.release(original);
    assert.equal(f.jobs()[0].state, "running");
    f.queue.reserveAttempt(lease);
    f.queue.release({ ...lease, attemptSeq: 1 });
    assert.equal(f.jobs()[0].state, "running");
    f.queue.cancel([f.id], "cancelled");
    f.queue.release({ ...lease, attemptSeq: 1 });
    assert.equal(f.jobs()[0].state, "cancelled");
  } finally {
    f.close();
  }
});

test("R8 zero-dispatch from obsolete epoch cannot pause a newer configuration", async () => {
  const f = fixture();
  const w = f.worker(async () => {
    f.db.exec("UPDATE mail_triage_settings SET config_epoch=config_epoch+1");
    throw new TriageModelError("config_error");
  });
  try {
    w.start();
    await until(
      () => f.jobs()[0].state !== "queued" && f.jobs()[0].state !== "running",
    );
    assert.equal(
      f.db.prepare("SELECT state FROM mail_triage_settings").get()!.state,
      "enabled",
    );
    assert.equal(f.jobs()[0].state, "stale_source");
    assert.equal(
      f.db.prepare("SELECT outcome FROM mail_triage_attempts").get()!.outcome,
      "not_dispatched",
    );
  } finally {
    await w.close();
    f.close();
  }
});

// Fix round 1: reviewed retry/accounting and lifecycle regressions.
test("fix1 zero-dispatch timeout is retryable without spending a request or rewinding sequence", async () => {
  const f = fixture();
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    if (calls === 1) throw new TriageModelError("timeout", 45000);
    return response(f.good());
  });
  try {
    w.start();
    await until(
      () => f.jobs()[0].state !== "queued" && f.jobs()[0].state !== "running",
    );
    assert.equal(f.jobs()[0].state, "retry_wait");
    assert.equal(f.jobs()[0].next_attempt_at, f.clock() + 45000);
    assert.equal(f.jobs()[0].attempt_seq, 1);
    assert.equal(
      f.db.prepare("SELECT outcome FROM mail_triage_attempts").get()!.outcome,
      "not_dispatched",
    );
    f.advance(44999);
    w.wake();
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(calls, 1);
    f.advance(1);
    w.wake();
    await until(() => f.counts().assessments === 1);
    assert.equal(calls, 2);
    assert.equal(f.jobs()[0].attempt_seq, 2);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM mail_triage_attempts WHERE outcome<>'not_dispatched'",
        )
        .get()!.n,
      1,
    );
  } finally {
    await w.close();
    f.close();
  }
});

test("fix1 historical nonzero manual version plus pure context change still creates successor", async () => {
  const f = fixture();
  f.db.exec("UPDATE mail_application_cases SET manual_version=5");
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    if (calls === 1) {
      const e = new TriageModelError("http_5xx");
      e.dispatched = true;
      throw e;
    }
    return response(f.good());
  });
  try {
    w.start();
    await until(() => f.jobs()[0].state === "retry_wait");
    f.db.exec("UPDATE mail_triage_scope SET scope_version=scope_version+1");
    f.advance(30000);
    w.wake();
    await until(
      () =>
        f.jobs()[0].state !== "running" && f.jobs()[0].state !== "retry_wait",
    );
    await until(() => f.counts().assessments === 1);
    assert.equal(calls, 2);
    assert.equal(f.jobs().length, 2);
    assert.equal(f.jobs()[1].generation, 2);
  } finally {
    await w.close();
    f.close();
  }
});

for (const unlink of [false, true])
  test(`fix1 lower case manual increment hidden by max blocks retry (unlink=${unlink})`, async () => {
    const f = fixture();
    const old = String(
      f.db.prepare("SELECT id FROM mail_application_cases").get()!.id,
    );
    const high = randomUUID();
    f.db
      .prepare(
        "INSERT INTO mail_application_cases(id,manual_version) VALUES(?,9)",
      )
      .run(high);
    f.db
      .prepare(
        "INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'explicit')",
      )
      .run(high, f.id);
    let calls = 0;
    const w = f.worker(async () => {
      calls++;
      const e = new TriageModelError("http_5xx");
      e.dispatched = true;
      throw e;
    });
    try {
      w.start();
      await until(() => f.jobs()[0].state === "retry_wait");
      assert.equal(f.jobs()[0].manual_version, 9);
      f.db
        .prepare(
          "UPDATE mail_application_cases SET manual_version=manual_version+1,version=version+1 WHERE id=?",
        )
        .run(old);
      if (unlink)
        f.db.prepare("DELETE FROM mail_case_sources WHERE case_id=?").run(old);
      f.advance(30000);
      w.wake();
      await until(
        () =>
          f.jobs()[0].state !== "running" && f.jobs()[0].state !== "retry_wait",
      );
      assert.equal(f.jobs()[0].state, "needs_review");
      assert.equal(calls, 1);
      assert.equal(f.jobs().length, 1);
    } finally {
      await w.close();
      f.close();
    }
  });

test("fix1 source cancellation keeps capacity until caller drained and remains terminal", async () => {
  const a = fixture(),
    b = fixture(),
    shared = createTriageScheduler(1),
    s = suspended();
  let callsA = 0,
    callsB = 0,
    aborted = false;
  const w = a.worker(
    async (_r, signal) => {
      callsA++;
      signal.addEventListener("abort", () => (aborted = true));
      return s.promise;
    },
    () => {},
    shared,
    "source-a",
  );
  const v = b.worker(
    async () => {
      callsB++;
      return response(b.good());
    },
    () => {},
    shared,
    "source-b",
  );
  try {
    w.start();
    await until(() => callsA === 1);
    v.start();
    w.abortSources([a.id]);
    assert.equal(aborted, true);
    assert.equal(a.jobs()[0].state, "cancelled");
    for (let n = 0; n < 3; n++) await new Promise<void>((r) => setImmediate(r));
    assert.equal(callsB, 0);
    assert.equal(a.counts().assessments, 0);
    s.resolve(a.good());
    await until(() => callsB === 1);
    await w.close();
    assert.equal(a.jobs()[0].state, "cancelled");
    assert.equal(a.counts().assessments, 0);
    assert.equal(
      a.db.prepare("SELECT outcome FROM mail_triage_attempts").get()!.outcome,
      "cancelled",
    );
    a.advance(999999);
    a.queue.recover();
    assert.equal(a.jobs()[0].state, "cancelled");
  } finally {
    s.resolve(a.good());
    await w.close();
    await v.close();
    shared.close();
    a.close();
    b.close();
  }
});

test("task8 fix1 revoking context source B cancels suspended primary A and holds scheduler until real drain", async () => {
  const a = fixture(), other = fixture(), shared = createTriageScheduler(1), suspendedA = suspended();
  const contextB = a.source(2);
  const caseA = String(a.db.prepare("SELECT case_id FROM mail_case_sources WHERE source_id=? ORDER BY case_id LIMIT 1").get(a.id)!.case_id);
  a.db.prepare("INSERT OR IGNORE INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'fixture-context')").run(caseA, contextB);
  a.db.prepare("DELETE FROM mail_triage_jobs WHERE source_id=?").run(contextB);
  let callsA = 0, callsOther = 0, aborted = false;
  const w = a.worker(async (_request, signal) => {
    callsA++; signal.addEventListener("abort", () => { aborted = true; }); return suspendedA.promise;
  }, () => {}, shared, "context-A");
  const v = other.worker(async () => { callsOther++; return response(other.good()); }, () => {}, shared, "other");
  try {
    w.start(); await until(() => callsA === 1); v.start();
    w.abortSources([contextB]);
    assert.equal(aborted, true);
    assert.equal(a.db.prepare("SELECT state FROM mail_triage_jobs WHERE source_id=?").get(a.id)!.state, "cancelled");
    for (let n = 0; n < 3; n++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(callsOther, 0);
    assert.equal(a.counts().assessments, 0);
    suspendedA.resolve(a.good());
    await until(() => callsOther === 1);
    await w.close();
    assert.equal(a.counts().assessments, 0);
    assert.equal(a.db.prepare("SELECT outcome FROM mail_triage_attempts ORDER BY reserved_at DESC LIMIT 1").get()!.outcome, "cancelled");
  } finally {
    suspendedA.resolve(a.good()); await w.close(); await v.close(); shared.close(); a.close(); other.close();
  }
});

test("fix1 Prepared caller shutdown before fetch remains recoverable with zero network", async () => {
  const f = fixture();
  const { completeTriageOnce } = await import("./mail-triage-model.ts");
  let entered = false,
    fetches = 0;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => (resume = resolve));
  const w = f.worker(async (r, signal, prepared) => {
    assert.ok(prepared?.wireHash);
    entered = true;
    await gate;
    return completeTriageOnce(r, signal, {
      db: f.db,
      key,
      prepared,
      fetch: async () => {
        fetches++;
        throw new Error("must not fetch after shutdown");
      },
    });
  });
  try {
    w.start();
    await until(() => entered);
    const closing = w.close();
    resume();
    await closing;
    assert.equal(fetches, 0);
    assert.ok(["queued", "retry_wait"].includes(String(f.jobs()[0].state)));
    assert.equal(
      f.db.prepare("SELECT outcome FROM mail_triage_attempts").get()!.outcome,
      "not_dispatched",
    );
    assert.equal(f.jobs()[0].attempt_seq, 1);
    assert.equal(f.counts().assessments, 0);
  } finally {
    resume();
    await w.close();
    f.close();
  }
});

test("fix1 real reserved job rejects old token and old sequence with valid CommitContext, writes nothing", async () => {
  const f = fixture();
  const { validateAssessment } = await import("./mail-triage-analyzer.ts");
  let calls = 0;
  let oldToken = "",
    oldSeq = 0;
  const w = f.worker(async (r) => {
    calls++;
    const j = f.jobs()[0];
    if (calls === 1) {
      oldToken = String(j.lease_token);
      oldSeq = Number(j.attempt_seq);
      const e = new TriageModelError("http_5xx");
      e.dispatched = true;
      throw e;
    }
    const ids = JSON.stringify(r.input.authorizedSources.map((s) => s.id));
    const context = {
      key,
      input: r.input,
      clock: f.clock,
      promptHash: r.promptHash,
      snapshot: {
        sources: JSON.stringify(
          f.db
            .prepare(
              "SELECT id,mailbox_id,source_hash,critical_headers_hash,source_version,state,trust FROM mail_triage_sources WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
            )
            .all(ids),
        ),
        locators: JSON.stringify(
          f.db
            .prepare(
              "SELECT a.*,s.scope_version,s.uid_validity AS scope_uid,s.state AS scope_state,s.epoch,s.baseline_uid,s.effective_at,b.status FROM mail_triage_source_aliases a JOIN mail_triage_scope s ON s.mailbox_id=a.mailbox_id JOIN mailboxes b ON b.id=a.mailbox_id WHERE a.source_id IN (SELECT value FROM json_each(?)) ORDER BY a.mailbox_id,a.folder,a.uid_validity,a.uid",
            )
            .all(ids),
        ),
        cases: f.db
          .prepare(
            "SELECT c.id,c.version,c.manual_version,cs.manual_locked,cs.match_basis FROM mail_application_cases c JOIN mail_case_sources cs ON cs.case_id=c.id WHERE cs.source_id=? ORDER BY c.id",
          )
          .all(f.id),
        provider: JSON.stringify(
          f.db
            .prepare(
              "SELECT p.id,p.config_revision,r.provider_id,r.model_id,r.thinking FROM model_providers p JOIN model_roles r ON r.provider_id=p.id WHERE r.role='mail_triage'",
            )
            .get(),
        ),
      },
    };
    const current = {
      jobId: String(j.id),
      leaseToken: String(j.lease_token),
      attemptSeq: Number(j.attempt_seq),
      configEpoch: Number(j.config_epoch),
      sourceVersion: Number(j.source_version),
      contextVersion: String(j.context_version),
      manualVersion: Number(j.manual_version),
    };
    assert.notEqual(current.leaseToken, oldToken);
    assert.equal(current.attemptSeq, 2);
    const assessment = validateAssessment(JSON.parse(f.good()), r.input);
    const dump = () =>
      JSON.stringify(
        [
          "mail_triage_assessments",
          "mail_case_events",
          "mail_case_tasks",
          "mail_application_cases",
          "mail_triage_attempts",
          "mail_triage_jobs",
        ].map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()),
      );
    const before = dump();
    assert.equal(
      commitAssessment(
        f.db,
        { ...current, leaseToken: oldToken },
        assessment,
        context,
      ),
      "stale",
    );
    assert.equal(dump(), before);
    assert.equal(
      commitAssessment(
        f.db,
        { ...current, attemptSeq: oldSeq },
        assessment,
        context,
      ),
      "stale",
    );
    assert.equal(dump(), before);
    // Same valid internal context and current fence are a positive control, not a missing-context early return.
    assert.equal(
      commitAssessment(f.db, current, assessment, context),
      "applied",
    );
    return response(f.good());
  });
  try {
    w.start();
    await until(() => f.jobs()[0].state === "retry_wait");
    f.advance(30000);
    w.wake();
    await until(() => f.counts().assessments === 1);
    assert.equal(calls, 2);
  } finally {
    await w.close();
    f.close();
  }
});

test("fix1 zero-dispatch uses consumed-attempt backoff after two real requests, not audit sequence", () => {
  const f = fixture();
  try {
    const raw = f.queue.claim()!;
    const input = buildTriageContext(f.db, key, f.id, 1);
    let lease = f.queue.prepareContext(raw, {
      contextVersion: input.contextVersion,
      manualVersion: input.manualVersion,
      tuple: input.tuple,
    })!;
    for (const wait of [30000, 120000]) {
      const permit = f.queue.reserveAttempt(lease);
      f.queue.retry(permit.fence, { code: "http_5xx", retryable: true });
      f.advance(wait);
      lease = f.queue.claim()!;
    }
    const zero = f.queue.reserveAttempt(lease);
    f.queue.settleNotDispatched(zero.fence, {
      code: "timeout",
      retryable: true,
    });
    assert.equal(f.jobs()[0].state, "retry_wait");
    assert.equal(f.jobs()[0].next_attempt_at, f.clock() + 120000);
    assert.equal(f.jobs()[0].attempt_seq, 3);
    f.advance(120000);
    const final = f.queue.reserveAttempt(f.queue.claim()!);
    assert.equal(final.fence.attemptSeq, 4);
    f.queue.retry(final.fence, { code: "http_5xx", retryable: true });
    assert.equal(f.jobs()[0].state, "failed");
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM mail_triage_attempts WHERE outcome<>'not_dispatched'",
        )
        .get()!.n,
      3,
    );
  } finally {
    f.close();
  }
});

test("fix1 migration018 preserves001-017, old NULL vectors, all job fields, uniqueness and source cascade", () => {
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(MIGRATIONS.slice(0, 17)))
      .digest("hex"),
    "21f07e493b1a9264c98c9bb7ba3f67c754fb1d594ae7ed2eba501ef6c3a41954",
  );
  const db = openDb(":memory:");
  try {
    for (const sql of MIGRATIONS.slice(0, 17)) db.exec(sql);
    db.exec("PRAGMA user_version=17");
    db.exec(`INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,status,created_at) VALUES(1,'fixture',X'00','0000','ok',0);
 INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,status) VALUES(1,1,'o','r','mail@example.test','example.test','active');
 INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,observed_at) VALUES('source',1,'h','h',0);
 INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,config_epoch,attempt_seq,manual_version,state) VALUES('job','source',1,1,'m',1,1,1,1,'ctx',1,2,9,'retry_wait');
 INSERT INTO mail_triage_attempts(id,job_id,attempt_seq,budget_day,reserved_at,deadline_at,outcome) VALUES('attempt','job',2,'2026-10-16',0,0,'failed');`);
    const before = db
      .prepare("SELECT * FROM mail_triage_jobs WHERE id='job'")
      .get()!;
    migrate(db);
    const after = db
      .prepare("SELECT * FROM mail_triage_jobs WHERE id='job'")
      .get()!;
    const { manual_versions_json, ...rest } = after;
    assert.equal(manual_versions_json, null);
    assert.deepEqual(rest, { ...before });
    assert.throws(() =>
      db.exec("UPDATE mail_triage_jobs SET manual_versions_json='bad json'"),
    );
    db.exec(
      "UPDATE mail_triage_jobs SET manual_versions_json='[[\"case\",9]]'",
    );
    assert.throws(() =>
      db.exec(
        "INSERT INTO mail_triage_jobs SELECT 'duplicate',source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,generation,config_epoch,state,priority,next_attempt_at,lease_token,lease_expires_at,attempt_seq,manual_version,created_at,updated_at,last_error,manual_versions_json FROM mail_triage_jobs WHERE id='job'",
      ),
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec("DELETE FROM mail_triage_sources WHERE id='source'");
    assert.equal(
      db.prepare("SELECT count(*) n FROM mail_triage_jobs").get()!.n,
      0,
    );
    assert.equal(
      db.prepare("SELECT job_id FROM mail_triage_attempts").get()!.job_id,
      null,
    );
  } finally {
    db.close();
  }
});

test("fix1 persisted historical vector survives worker recreation; unknown legacy mismatch fails closed", async () => {
  for (const legacy of [false, true]) {
    const f = fixture();
    f.db.exec("UPDATE mail_application_cases SET manual_version=5");
    let calls = 0;
    const first = f.worker(async () => {
      calls++;
      const e = new TriageModelError("http_5xx");
      e.dispatched = true;
      throw e;
    });
    const next = f.worker(async (r) => {
      calls++;
      assert.equal(JSON.stringify(r).includes("manual_versions_json"), false);
      return response(f.good());
    });
    try {
      first.start();
      await until(() => f.jobs()[0].state === "retry_wait");
      await first.close();
      const persisted = f.jobs()[0].manual_versions_json;
      assert.ok(typeof persisted === "string" && persisted.includes(",5]"));
      if (legacy)
        f.db.exec("UPDATE mail_triage_jobs SET manual_versions_json=NULL");
      f.db.exec("UPDATE mail_triage_scope SET scope_version=scope_version+1");
      f.advance(30000);
      next.start();
      await until(
        () =>
          !["queued", "running", "retry_wait"].includes(
            String(f.jobs()[0].state),
          ),
      );
      if (legacy) {
        assert.equal(f.jobs()[0].state, "needs_review");
        assert.equal(calls, 1);
        assert.equal(f.jobs().length, 1);
      } else {
        await until(() => f.counts().assessments === 1);
        assert.equal(calls, 2);
        assert.equal(f.jobs().length, 2);
      }
    } finally {
      await first.close();
      await next.close();
      f.close();
    }
  }
});

for (const deleted of [false, true])
  test(`fix1 cancelled/deleted before fetch can settle only exact captured proven-zero ledger (deleted=${deleted})`, async () => {
    const f = fixture();
    const { completeTriageOnce } = await import("./mail-triage-model.ts");
    let entered = false,
      fetches = 0;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    const w = f.worker(async (r, signal, prepared) => {
      entered = true;
      await gate;
      return completeTriageOnce(r, signal, {
        db: f.db,
        key,
        prepared,
        fetch: async () => {
          fetches++;
          throw new Error("must not reach fetch");
        },
      });
    });
    try {
      w.start();
      await until(() => entered);
      w.abortSources([f.id]);
      if (deleted)
        f.db.prepare("DELETE FROM mail_triage_sources WHERE id=?").run(f.id);
      resume();
      await w.close();
      assert.equal(fetches, 0);
      assert.equal(
        f.db.prepare("SELECT outcome FROM mail_triage_attempts").get()!.outcome,
        "not_dispatched",
      );
      assert.equal(
        f.db
          .prepare(
            "SELECT count(*) n FROM mail_triage_attempts WHERE outcome<>'not_dispatched'",
          )
          .get()!.n,
        0,
      );
      assert.equal(f.counts().assessments, 0);
      if (deleted) {
        assert.equal(f.jobs().length, 0);
        assert.equal(
          f.db.prepare("SELECT job_id FROM mail_triage_attempts").get()!.job_id,
          null,
        );
      } else assert.equal(f.jobs()[0].state, "cancelled");
    } finally {
      resume();
      await w.close();
      f.close();
    }
  });

test("fix1 final commit treats removed manual-zero association as context, not a fabricated manual edit", async () => {
  const f = fixture();
  let calls = 0;
  const w = f.worker(async () => {
    calls++;
    if (calls === 1)
      f.db.prepare("DELETE FROM mail_case_sources WHERE source_id=?").run(f.id);
    return response(f.good());
  });
  try {
    w.start();
    await until(() => f.counts().assessments === 1);
    assert.equal(calls, 2);
    assert.equal(f.jobs().length, 2);
    assert.equal(f.jobs()[1].generation, 2);
  } finally {
    await w.close();
    f.close();
  }
});

test("fix1 captured UUID settlement never refunds unknown and wrong UUID never refunds cancelled", () => {
  const f = fixture();
  try {
    const raw = f.queue.claim()!;
    const input = buildTriageContext(f.db, key, f.id, 1);
    const lease = f.queue.prepareContext(raw, {
      contextVersion: input.contextVersion,
      manualVersion: input.manualVersion,
      tuple: input.tuple,
    })!;
    const permit = f.queue.reserveAttempt(lease);
    const attempt = String(
      f.db.prepare("SELECT id FROM mail_triage_attempts").get()!.id,
    );
    f.queue.cancel([f.id], "cancelled");
    f.queue.settleNotDispatched(
      permit.fence,
      { code: "timeout", retryable: true },
      randomUUID(),
    );
    assert.equal(
      f.db.prepare("SELECT outcome FROM mail_triage_attempts").get()!.outcome,
      "cancelled",
    );
    f.db
      .prepare("UPDATE mail_triage_attempts SET outcome='unknown' WHERE id=?")
      .run(attempt);
    f.queue.settleNotDispatched(
      permit.fence,
      { code: "timeout", retryable: true },
      attempt,
    );
    assert.equal(
      f.db.prepare("SELECT outcome FROM mail_triage_attempts").get()!.outcome,
      "unknown",
    );
    assert.equal(f.jobs()[0].state, "cancelled");
  } finally {
    f.close();
  }
});
