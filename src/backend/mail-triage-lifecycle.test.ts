import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { FakeMailTransport, fakeRawMail, key, setup } from "./testing.ts";
import { createMailboxService } from "./mailbox-service.ts";
import { MIGRATIONS } from "./migrations.ts";
import { parseMailText } from "./mailbox-parser.ts";
import { registerCachedSource } from "./mail-triage-source.ts";
import { applyAssessment } from "./mail-case-projector.ts";
import { prepareMailSend, settleMailSendAccepted, settleMailSendFailure } from "./mail-triage-send.ts";
import type { ValidatedAssessment } from "./mail-triage-analyzer.ts";
import {
  invalidateSource,
  invalidateTriageScope,
  purgeExpiredSources,
  rebuildSupportedCase,
} from "./mail-triage-lifecycle.ts";

const DAY = 24 * 60 * 60 * 1000;
const derived = (ids: string[]) => JSON.stringify({ supportSourceIds: ids, kind: "source_derived", verifiedAt: null, reason: null });
const independent = (reason = "后台人工核验", verifiedAt = 100) => JSON.stringify({ supportSourceIds: [], kind: "independent_manual", verifiedAt, reason });

function fixture() {
  const { db } = setup({ cachedMailbox: { password: "fixture" } });
  db.exec(`
    INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at)
      VALUES(1,1,'authorized','100',0,0);
    INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,observed_at)
      VALUES('source-a',1,'hash-a','headers-a',10),('source-b',1,'hash-b','headers-b',20);
    INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id)
      VALUES(1,'INBOX','100',1,'source-a'),(1,'INBOX','100',2,'source-b');
    INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,config_epoch,state,lease_token,lease_expires_at,attempt_seq,manual_versions_json)
      VALUES('job-a','source-a',1,1,'fixture',1,1,1,1,'context-a-b',1,'running','lease-a',999999,1,'[["case-derived",2]]'),
            ('job-b','source-b',1,1,'fixture',1,1,1,1,'context-b',1,'queued',NULL,NULL,0,'[["case-derived",2]]');
    INSERT INTO mail_triage_attempts(id,job_id,attempt_seq,budget_day,reserved_at,deadline_at,outcome,usage_json)
      VALUES('attempt-b','job-b',1,'2026-10-16',20,80,'succeeded','{"inputTokens":12,"outputTokens":3}');
  `);
  return db;
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function insertDerivedCase(db: DatabaseSync, sourceId = "source-b", caseId = "case-derived") {
  const sentinel = "SENTINEL-APP-9042";
  db.prepare(`INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,created_at,updated_at)
    VALUES(?,'confirmed','fixture',?,?,?,1,1)`).run(caseId, sentinel, derived([sourceId]), JSON.stringify({ summary: sentinel, quote: `quote:${sentinel}` }));
  db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'candidate')").run(caseId, sourceId);
  db.prepare(`INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json)
    VALUES(?,?,?,?, 'application_submitted',20,?,?)`).run(`event-${caseId}`, caseId, sourceId, "1:submitted", JSON.stringify([{ sourceId, quote: `quote:${sentinel}` }]), derived([sourceId]));
  db.prepare(`INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,requested_items_json,provenance_json)
    VALUES(?,?,?,'reply','reply','reply',?,'[]',?)`).run(`task-${caseId}`, caseId, `event-${caseId}`, `reply:${sentinel}`, derived([sourceId]));
  db.prepare(`INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at)
    VALUES(?,?, 'fixture',?,'tag',1,2,'我看过',?,?,?,30)`).run(`manual-${caseId}`, caseId, caseId, JSON.stringify({ tag: sentinel }), JSON.stringify({ tag: `人工:${sentinel}` }), derived([sourceId]));
  db.prepare(`INSERT INTO mail_triage_assessments(id,job_id,source_id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,prompt_hash,validated_json,support_source_ids_json,grade,created_at)
    VALUES(?, 'job-b', ?,1,'fixture',1,1,1,1,'prompt',?,?,'evidence_complete',20)`).run(`assessment-${caseId}`, sourceId, JSON.stringify({ summary: sentinel, evidence: `quote:${sentinel}` }), JSON.stringify([sourceId]));
  db.prepare(`INSERT INTO mail_triage_requests(request_id,operation,canonical_input_hash,result_ref_json,created_at)
    VALUES('request-derived','mail.triage.result','hash',?,20)`).run(JSON.stringify({ sourceId, caseId, summary: sentinel }));
  db.prepare(`INSERT INTO mail_triage_send_receipts(id,request_id,mailbox_id,reply_source_id,smtp_status,message_id,selected_task_ids_json,created_at)
    VALUES('receipt-derived','send-derived',1,?,'smtp_accepted',?, ?,20)`).run(sourceId, `<${sentinel}@fixture>`, JSON.stringify([`task-${caseId}`]));
  db.prepare(`INSERT INTO mail_triage_send_receipts(id,request_id,mailbox_id,reply_source_id,smtp_status,selected_task_ids_json,created_at)
    VALUES('receipt-cross','send-cross',1,'source-a','smtp_accepted',?,20)`).run(JSON.stringify([`task-${caseId}`]));
  db.prepare(`INSERT INTO mail_triage_requests(request_id,operation,canonical_input_hash,result_ref_json,created_at)
    VALUES('request-task','mail.tasks.result','hash',?,20)`).run(JSON.stringify({ taskId: `task-${caseId}` }));
  return sentinel;
}

function insertRestoreCandidate(db: DatabaseSync, suffix: string, taskProvenance: string): string {
  const caseId = `case-restore-${suffix}`, eventId = `event-restore-${suffix}`, taskId = `task-restore-${suffix}`;
  db.prepare(`INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json)
    VALUES(?,'confirmed','Fixture',?,?,'{}')`).run(caseId, `APP-${suffix}`, independent("fixture identity", 1));
  db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,'source-a','fixture'),(?,'source-b','fixture')").run(caseId, caseId);
  db.prepare(`INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json)
    VALUES(?,?,'source-a','1:request','action_required',10,?,?)`).run(
      eventId, caseId, JSON.stringify([{ sourceId: "source-a", quote: "Please send passport" }]), derived(["source-a"]));
  db.prepare(`INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,state,title,requested_items_json,provenance_json)
    VALUES(?,?,?,'passport','action','["passport"]','resolved_by_evidence','Submit passport','["passport"]',?)`)
    .run(taskId, caseId, eventId, taskProvenance);
  return taskId;
}

function jsonText(db: DatabaseSync): string {
  const specs: [string, string[]][] = [
    ["mail_triage_assessments", ["validated_json", "support_source_ids_json"]],
    ["mail_application_cases", ["identity_provenance_json", "projection_json"]],
    ["mail_case_events", ["evidence_json", "provenance_json"]],
    ["mail_case_tasks", ["requested_items_json", "provenance_json"]],
    ["mail_case_manual_decisions", ["before_json", "after_json", "provenance_json"]],
    ["mail_triage_send_receipts", ["selected_task_ids_json", "binding_json"]],
    ["mail_triage_requests", ["result_ref_json"]],
    ["mail_triage_jobs", ["manual_versions_json"]],
  ];
  return specs.flatMap(([table, columns]) => db.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all()
    .flatMap((row) => columns.map((column) => String(row[column] ?? "")))).join("\n");
}

test("B30/B31 scope revocation cancels source jobs, revokes leases, and returns ids for post-commit abort", () => {
  const db = fixture();
  try {
    const result = invalidateTriageScope(db, { mailboxIds: [1], reason: "scope_removed" }, 50);
    assert.deepEqual(result.abortSourceIds, ["source-a", "source-b"]);
    assert.deepEqual(db.prepare("SELECT state,lease_token FROM mail_triage_jobs ORDER BY id").all().map((row) => ({ ...row })), [
      { state: "cancelled", lease_token: null }, { state: "cancelled", lease_token: null },
    ]);
    assert.equal(db.prepare("SELECT state FROM mail_triage_scope WHERE mailbox_id=1").get()!.state, "revoked");
  } finally { db.close(); }
});

test("fix1 disable advances the global fence even when no mailbox scope is authorized", () => {
  const db = fixture();
  try {
    db.prepare("UPDATE mail_triage_scope SET state='revoked'").run();
    const before = db.prepare("SELECT config_epoch,version FROM mail_triage_settings WHERE id=1").get()!;
    assert.deepEqual(invalidateTriageScope(db, { mailboxIds: [], reason: "disable" }, 51), { abortSourceIds: [] });
    const after = db.prepare("SELECT enabled,state,config_epoch,version FROM mail_triage_settings WHERE id=1").get()!;
    assert.deepEqual({ ...after }, { enabled: 0, state: "disabled", config_epoch: Number(before.config_epoch) + 1, version: Number(before.version) + 1 });
  } finally { db.close(); }
});

test("fix1 deleting context source B removes A-owned assessment/job and anonymizes its attempt", () => {
  const db = fixture();
  try {
    insertDerivedCase(db);
    db.prepare("UPDATE mail_triage_assessments SET source_id='source-a',support_source_ids_json='[\"source-a\",\"source-b\"]' WHERE id='assessment-case-derived'").run();
    db.prepare("UPDATE mail_triage_jobs SET source_id='source-a' WHERE id='job-b'").run();
    invalidateSource(db, "source-b", "explicit_delete", 60);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_triage_assessments WHERE id='assessment-case-derived'").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_triage_jobs WHERE id='job-b'").get()!.n, 0);
    assert.equal(db.prepare("SELECT job_id FROM mail_triage_attempts WHERE id='attempt-b'").get()!.job_id, null);
  } finally { db.close(); }
});

test("B36/B53 stale is historical-only immediately, then seven-day purge removes every sensitive derivative", () => {
  const db = fixture();
  try {
    const sentinel = insertDerivedCase(db);
    invalidateSource(db, "source-b", "stale", 100);
    const projection = JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id='case-derived'").get()!.projection_json));
    assert.equal(projection.requiresReview, true);
    assert.equal(projection.sourceUnavailable, true);
    assert.match(jsonText(db), new RegExp(sentinel));
    assert.equal(purgeExpiredSources(db, 100 + 7 * DAY - 1), 0);
    assert.equal(purgeExpiredSources(db, 100 + 7 * DAY), 1);
    assert.doesNotMatch(jsonText(db), new RegExp(sentinel));
    assert.equal(db.prepare("SELECT job_id FROM mail_triage_attempts WHERE id='attempt-b'").get()!.job_id, null);
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT usage_json FROM mail_triage_attempts WHERE id='attempt-b'").get()!.usage_json)), { inputTokens: 12, outputTokens: 3 });
  } finally { db.close(); }
});

test("B37/B54 explicit delete drops ordinary manual relabel/link but preserves strictly verified independent fact", () => {
  const db = fixture();
  try {
    const sentinel = insertDerivedCase(db);
    db.prepare(`INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,created_at,updated_at)
      VALUES('case-independent','confirmed','fixture','HUMAN-ONLY',?,'{}',1,1)`).run(independent());
    db.prepare(`INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json)
      VALUES('event-independent','case-independent','source-b','1:manual','application_submitted',20,'[]',?)`).run(independent());
    db.prepare(`INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,requested_items_json,provenance_json)
      VALUES('task-independent','case-independent','event-independent','review','review','manual','人工核验','[]',?)`).run(independent());
    db.prepare(`INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,created_at,updated_at)
      VALUES('case-manual-only','confirmed','fixture','DERIVED-ID',?,'{}',1,1)`).run(derived(["source-b"]));
    db.prepare(`INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at)
      VALUES('manual-independent-only','case-manual-only','fixture','case-manual-only','tag',1,2,'独立平台核验','{}','{"tag":"人工事实"}',?,100)`).run(independent("独立平台核验", 100));
    db.prepare(`INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at)
      VALUES('manual-independent-leaky','case-manual-only','fixture','case-manual-only','tag',2,3,'错误独立标记','{}',?,?,101)`)
      .run(JSON.stringify({ sourceId: "source-b", quote: sentinel }), independent("错误独立标记", 101));
    invalidateSource(db, "source-b", "explicit_delete", 200);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_manual_decisions WHERE id='manual-case-derived'").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_manual_decisions WHERE id='manual-independent-leaky'").get()!.n, 0);
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT selected_task_ids_json FROM mail_triage_send_receipts WHERE id='receipt-cross'").get()!.selected_task_ids_json)), []);
    assert.equal(db.prepare("SELECT result_ref_json FROM mail_triage_requests WHERE request_id='request-task'").get()!.result_ref_json, null);
    const event = db.prepare("SELECT source_id,evidence_json,provenance_json FROM mail_case_events WHERE id='event-independent'").get()!;
    assert.equal(event.source_id, null);
    assert.deepEqual(JSON.parse(String(event.evidence_json)), []);
    assert.equal(JSON.parse(String(event.provenance_json)).kind, "independent_manual");
    assert.equal(db.prepare("SELECT application_identity FROM mail_application_cases WHERE id='case-independent'").get()!.application_identity, "HUMAN-ONLY");
    assert.equal(db.prepare("SELECT source_id FROM mail_case_events WHERE case_id='case-manual-only' AND kind='review_required'").get()!.source_id, null);
    assert.doesNotMatch(jsonText(db), new RegExp(sentinel));
  } finally { db.close(); }
});

test("fix2 R12 clears mixed critical/manual facts without an actual producer contract", () => {
  const db = fixture();
  try {
    const identity = derived(["source-a", "source-b"]);
    const eventProvenance = JSON.stringify({ supportSourceIds: ["source-a", "source-b"], kind: "source_derived", verifiedAt: null, reason: null });
    db.prepare(`INSERT INTO mail_application_cases(id,identity_state,site_id,provider,application_identity,identity_provenance_json,projection_json) VALUES('case-mixed','confirmed',NULL,'fixture','APP-A',?,'{}')`).run(identity);
    db.exec("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES('case-mixed','source-a','fixture'),('case-mixed','source-b','fixture')");
    db.prepare(`INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json) VALUES
      ('event-a-mixed-critical','case-mixed','source-a','1:a','application_approved',1,?,?),
      ('event-b-origin','case-mixed','source-b','1:b','review_started',3,?,?)`)
      .run(JSON.stringify([{ sourceId: "source-a", quote: "A fact" }, { sourceId: "source-b", quote: "B fact" }]), eventProvenance,
        JSON.stringify([{ sourceId: "source-a", quote: "A" }, { sourceId: "source-b", quote: "B" }]), eventProvenance);
    db.prepare(`INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at)
      VALUES('manual-a-only','case-mixed','fixture','case-mixed','tag',0,1,'A-only','{"value":"old-a"}','{"value":"new-a"}',?,3)`).run(derived(["source-a"]));
    db.prepare(`INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at)
      VALUES('manual-one-sided','case-mixed','fixture','case-mixed','tag',1,2,'仅before可分',?,?,?,4)`).run(
        JSON.stringify([{ sourceId: "source-a", value: "old-a" }, { sourceId: "source-b", value: "old-b" }]),
        JSON.stringify({ value: "combined" }), eventProvenance);
    invalidateSource(db, "source-b", "explicit_delete", 100);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_events WHERE id IN ('event-a-mixed-critical','event-b-origin')").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_manual_decisions WHERE id='manual-one-sided'").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_manual_decisions WHERE id='manual-a-only'").get()!.n, 1);
    const identityRow = db.prepare("SELECT identity_state,application_identity FROM mail_application_cases WHERE id='case-mixed'").get();
    assert.ok(!identityRow || (identityRow.identity_state === "unconfirmed_case" && identityRow.application_identity === null));
  } finally { db.close(); }
});

test("R18/R12 real writer: failed/unknown preserve actual A reply restoration, accepted prevents it", () => {
  const { db } = setup({ cachedMailbox: { password: "fixture" } });
  const sourceA = "11111111-1111-4111-8111-111111111111", sourceB = "33333333-3333-4333-8333-333333333333";
  const caseId = "22222222-2222-4222-8222-222222222222", jobA = "44444444-4444-4444-8444-444444444444", jobB = "55555555-5555-4555-8555-555555555555";
  const fenceA = { jobId: jobA, leaseToken: "lease-a", attemptSeq: 1, configEpoch: 1, sourceVersion: 1, contextVersion: "context-a", manualVersion: 0 };
  const fenceB = { ...fenceA, jobId: jobB, leaseToken: "lease-b", contextVersion: "context-b" };
  try {
    db.exec("UPDATE mail_triage_settings SET enabled=1,state='enabled'; INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,effective_at) VALUES(1,1,'authorized','100',0)");
    db.prepare("INSERT INTO mail_triage_contacts(id,provider,mailbox_id,address,reason,confirmed_by,confirmed_at) VALUES('mapping','Fixture',1,'support@fixture.test','fixture','actor',1)").run();
    db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json) VALUES(?,'confirmed','Fixture','APP-001',?)").run(caseId, independent("人工确认身份", 1));
    const addSource = (id: string, uid: number, text: string, observedAt: number, jobId: string, lease: string, context: string) => {
      db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,trust,observed_at) VALUES(?,1,?,?, 'human_confirmed',?)").run(id, `hash-${uid}`, `headers-${uid}`, observedAt);
      db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,attachments_json)
        VALUES(1,'INBOX',?,'100','"Sender"','["support@fixture.test"]','[]','[]','APP-001',?,?,1,?,'[]','[]')`).run(uid, observedAt - 10, text, `<${uid}@fixture>`);
      db.prepare("INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id) VALUES(1,'INBOX','100',?,?)").run(uid, id);
      db.prepare(`INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,config_epoch,state,lease_token,lease_expires_at,attempt_seq)
        VALUES(?,?,1,1,'fixture',1,1,1,1,?,1,'running',?,1000,1)`).run(jobId, id, context, lease);
    };
    addSource(sourceA, 1, "APP-001 Please send passport", 100, jobA, "lease-a", "context-a");
    const request: ValidatedAssessment = { schemaVersion: 1, primaryCategory: "action_request", tag: "材料待补", summary: "请提交护照",
      caseSuggestion: { providerCandidate: "Fixture", applicationId: "APP-001", candidateCaseId: caseId, matchBasis: [], needsReview: false },
      events: [], actions: [{ kind: "reply", title: "回复护照问题", requestedItems: [], deadlineRaw: null, deadlineAt: null, satisfiesTaskIds: [], evidence: [{ sourceId: sourceA, quote: "Please send passport" }] }],
      completionSuggestions: [], uncertainties: [], requiresHumanReview: false, grade: "evidence_complete", usage: null,
      evidenceLocations: [{ path: "/actions/0/evidence/0", sourceId: sourceA, quote: "Please send passport", locations: [{ field: "text", segment: "current_body", start: 8, end: 28, coordinateUnit: "utf16" }] }], applicationRestrictions: [] };
    transaction(db, () => applyAssessment(db, { sourceId: sourceA, assessment: request, fence: fenceA, now: 100 }));
    const taskId = String(db.prepare("SELECT id FROM mail_case_tasks WHERE case_id=? AND kind='reply'").get(caseId)!.id);
    const completionText = "APP-001 We received your passport. B-PRIVATE-COMPLETION";
    addSource(sourceB, 2, completionText, 200, jobB, "lease-b", "context-b");
    const completion: ValidatedAssessment = { ...request, primaryCategory: "progress", tag: "材料已收", summary: "已收到护照 B-PRIVATE-COMPLETION", actions: [],
      completionSuggestions: [{ taskId, evidence: [{ sourceId: sourceB, quote: "We received your passport." }] }],
      evidenceLocations: [{ path: "/completionSuggestions/0/evidence/0", sourceId: sourceB, quote: "We received your passport.", locations: [{ field: "text", segment: "current_body", start: 8, end: 34, coordinateUnit: "utf16" }] }] };
    transaction(db, () => applyAssessment(db, { sourceId: sourceB, assessment: completion, fence: fenceB, now: 200 }));
    assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(taskId)!.state, "resolved_by_evidence");
    for (const status of ["failed", "unknown"] as const) {
      const prepared = prepareMailSend(db, { mailboxId: 1, caseId, selectedTaskIds: [taskId], replySourceId: sourceA, canonicalContent: { fixture: status } }, 210);
      settleMailSendFailure(db, prepared.receiptId, status);
    }
    db.prepare(`INSERT INTO mail_triage_assessments(id,job_id,source_id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,prompt_hash,validated_json,support_source_ids_json,grade,created_at)
      VALUES('assessment-b',?,?,1,'fixture',1,1,1,1,'prompt',?,?,'evidence_complete',200)`).run(jobB, sourceB, JSON.stringify(completion), JSON.stringify([sourceA, sourceB]));
    invalidateSource(db, sourceB, "explicit_delete", 300);
    const restored = db.prepare("SELECT state,title,requested_items_json,provenance_json FROM mail_case_tasks WHERE id=?").get(taskId)!;
    assert.equal(restored.state, "open");
    assert.equal(restored.title, "回复护照问题");
    assert.deepEqual(JSON.parse(String(restored.requested_items_json)), []);
    assert.deepEqual(JSON.parse(String(restored.provenance_json)).supportSourceIds, [sourceA]);
    const projection = JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json));
    assert.equal(projection.column, "needs_you");
    assert.doesNotMatch(jsonText(db), /B-PRIVATE-COMPLETION/);

    // SMTP accepted 先持久化真实 writer 绑定；随后即使 C 完成来源删除，也不得恢复为未发送。
    const sourceC = "77777777-7777-4777-8777-777777777777", jobC = "88888888-8888-4888-8888-888888888888";
    addSource(sourceC, 3, "APP-001 We received your passport. C-PRIVATE-COMPLETION", 400, jobC, "lease-c", "context-c");
    const fenceC = { ...fenceA, jobId: jobC, leaseToken: "lease-c", contextVersion: "context-c" };
    const completionC: ValidatedAssessment = { ...completion, summary: "已收到护照 C-PRIVATE-COMPLETION",
      completionSuggestions: [{ taskId, evidence: [{ sourceId: sourceC, quote: "We received your passport." }] }],
      evidenceLocations: [{ path: "/completionSuggestions/0/evidence/0", sourceId: sourceC, quote: "We received your passport.", locations: [{ field: "text", segment: "current_body", start: 8, end: 34, coordinateUnit: "utf16" }] }] };
    transaction(db, () => applyAssessment(db, { sourceId: sourceC, assessment: completionC, fence: fenceC, now: 400 }));
    assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(taskId)!.state, "resolved_by_evidence");
    const accepted = prepareMailSend(db, { mailboxId: 1, caseId, selectedTaskIds: [taskId], replySourceId: sourceA, canonicalContent: { fixture: "accepted" } }, 410);
    settleMailSendAccepted(db, { receiptId: accepted.receiptId, caseId, selectedTaskIds: [taskId], messageId: "<accepted-r12@fixture>", appended: true, replySourceId: sourceA }, 411);
    invalidateSource(db, sourceC, "explicit_delete", 500);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_tasks WHERE id=?").get(taskId)!.n, 0);
    assert.equal(db.prepare("SELECT binding_json FROM mail_triage_send_receipts WHERE id=?").get(accepted.receiptId)!.binding_json, null);
    assert.doesNotMatch(jsonText(db), /C-PRIVATE-COMPLETION/);
  } finally { db.close(); }
});

test("fix2 malformed receipt task vectors are durably normalized after referenced task deletion", () => {
  const db = fixture();
  try {
    insertDerivedCase(db);
    db.prepare(`INSERT INTO mail_triage_send_receipts(id,request_id,mailbox_id,reply_source_id,smtp_status,selected_task_ids_json,created_at)
      VALUES('receipt-object','object',1,'source-a','prepared',?,1),('receipt-null','null',1,'source-a','prepared','null',1)`)
      .run(JSON.stringify({ taskId: "task-case-derived", secret: "SENTINEL-APP-9042" }));
    invalidateSource(db, "source-b", "explicit_delete", 120);
    assert.deepEqual(db.prepare("SELECT id,selected_task_ids_json FROM mail_triage_send_receipts WHERE id IN ('receipt-object','receipt-null') ORDER BY id").all().map((row) => ({ ...row })), [
      { id: "receipt-null", selected_task_ids_json: "[]" }, { id: "receipt-object", selected_task_ids_json: "[]" },
    ]);
    assert.doesNotMatch(jsonText(db), /SENTINEL-APP-9042/);
  } finally { db.close(); }
});

test("fix3 R12 rejects malformed or fake task provenance instead of reopening it", () => {
  const db = fixture();
  try {
    const taskIds = [
      insertRestoreCandidate(db, "unknown-kind", JSON.stringify({ supportSourceIds: ["source-a", "source-b"], kind: "unknown" })),
      insertRestoreCandidate(db, "missing-fields", JSON.stringify({ supportSourceIds: ["source-a", "source-b"], kind: "source_derived" })),
      insertRestoreCandidate(db, "fake-independent", JSON.stringify({ supportSourceIds: ["source-a", "source-b"], kind: "independent_manual", verifiedAt: 1, reason: "not independent" })),
    ];
    invalidateSource(db, "source-b", "explicit_delete", 130);
    for (const taskId of taskIds) assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks WHERE id=?").get(taskId)!.n, 0);
  } finally { db.close(); }
});

test("fix3 R12 treats malformed completed-send vectors as a restoration blocker", () => {
  for (const [suffix, selected] of [
    ["direct", { taskId: "task-restore-direct" }],
    ["ambiguous", { opaqueCompletedSend: true }],
  ] as const) {
    const db = fixture();
    try {
      const taskId = insertRestoreCandidate(db, suffix, derived(["source-a", "source-b"]));
      db.prepare(`INSERT INTO mail_triage_send_receipts(id,request_id,mailbox_id,reply_source_id,smtp_status,selected_task_ids_json,created_at)
        VALUES(?,?,1,'source-a','smtp_accepted',?,20)`).run(`receipt-${suffix}`, `send-${suffix}`, JSON.stringify(selected));
      invalidateSource(db, "source-b", "explicit_delete", 140);
      assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks WHERE id=?").get(taskId)!.n, 0, suffix);
      assert.equal(db.prepare("SELECT selected_task_ids_json FROM mail_triage_send_receipts WHERE id=?").get(`receipt-${suffix}`)!.selected_task_ids_json, "[]");
    } finally { db.close(); }
  }
});

test("fix1 malformed JSON shapes fail closed without blocking privacy deletion", () => {
  const db = fixture();
  try {
    db.exec(`INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json) VALUES('case-malformed','confirmed','secret','SECRET-ID','null','{}');
      INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES('case-malformed','source-b','fixture');
      INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json) VALUES('event-malformed','case-malformed','source-a','1:bad','notification',1,'{}','null');
      INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json) VALUES('event-missing-fields','case-malformed','source-a','1:bad-object','notification',1,'[]','{}');
      INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,provenance_json) VALUES('task-malformed','case-malformed','event-missing-fields','bad','review','bad','secret','[]');
      INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at) VALUES('manual-malformed','case-malformed','fixture','case-malformed','tag',1,2,'bad','null','{}','[]',1);
      UPDATE mail_triage_jobs SET manual_versions_json='{}' WHERE id='job-a';`);
    assert.doesNotThrow(() => invalidateSource(db, "source-b", "explicit_delete", 110));
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_events WHERE id IN ('event-malformed','event-missing-fields')").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks WHERE id='task-malformed'").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_manual_decisions WHERE id='manual-malformed'").get()!.n, 0);
    const c = db.prepare("SELECT provider,application_identity FROM mail_application_cases WHERE id='case-malformed'").get();
    assert.ok(!c || (c.provider === null && c.application_identity === null));
  } finally { db.close(); }
});

test("B59/RF5 source cleanup cannot borrow an identical cross-mailbox copy and cancelled work cannot revive", () => {
  const db = fixture();
  try {
    db.exec(`INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,status,monitoring) VALUES(2,1,'o2','r2','copy@example.test','example.test','active',0);
      INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(2,1,'authorized','200',0,0);
      INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,observed_at) VALUES('source-copy',2,'hash-b','headers-b',21);`);
    insertDerivedCase(db);
    db.prepare("UPDATE mail_triage_jobs SET manual_versions_json=? WHERE id='job-a'")
      .run(JSON.stringify({ v: 2, cases: [], sources: [["source-b", 0]] }));
    invalidateSource(db, "source-b", "explicit_delete", 300);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_triage_assessments WHERE source_id='source-copy'").get()!.n, 0);
    assert.equal(db.prepare("SELECT state FROM mail_triage_jobs WHERE id='job-b'").get(), undefined);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_triage_jobs WHERE manual_versions_json LIKE '%case-derived%'").get()!.n, 0);
    assert.deepEqual({ ...db.prepare("SELECT state,manual_versions_json,last_error FROM mail_triage_jobs WHERE id='job-a'").get() }, {
      state: "cancelled", manual_versions_json: '{"v":2,"cases":[],"sources":[]}', last_error: "context_source_invalidated",
    });
  } finally { db.close(); }
});

test("R10 migration/projector accepts only valid independent source-less events and rebuild remains auditable", () => {
  const db = fixture();
  try {
    db.prepare(`INSERT INTO mail_application_cases(id,identity_state,identity_provenance_json,projection_json) VALUES('case-source-less','confirmed',?,'{}')`).run(independent());
    const malformed = [
      {},
      { supportSourceIds: [], reason: "人工核验", verifiedAt: 1 },
      { kind: "independent_manual", reason: "人工核验", verifiedAt: 1 },
      { kind: "independent_manual", supportSourceIds: [], verifiedAt: 1 },
      { kind: "independent_manual", supportSourceIds: [], reason: " ", verifiedAt: 1 },
      { kind: "independent_manual", supportSourceIds: [], reason: "人工核验" },
      { kind: "independent_manual", supportSourceIds: [], reason: "人工核验", verifiedAt: null },
      { kind: "independent_manual", supportSourceIds: "not-an-array", reason: "人工核验", verifiedAt: 1 },
    ];
    for (const [index, provenance] of malformed.entries()) {
      assert.throws(() => db.prepare(`INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json)
        VALUES(?, 'case-source-less',NULL,?,'review_required',1,'[]',?)`).run(`bad-null-${index}`, `manual:bad:${index}`, JSON.stringify(provenance)), /constraint/i);
    }
    for (const [index, evidence] of ["null", "{}", "[null]", "[\"quoted mail\"]"].entries()) {
      assert.throws(() => db.prepare(`INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json)
        VALUES(?, 'case-source-less',NULL,?,'review_required',1,?,?)`).run(`bad-evidence-${index}`, `manual:evidence:${index}`, evidence, independent()), /constraint/i);
    }
    db.prepare(`INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json)
      VALUES('good-null','case-source-less',NULL,'manual:good','review_required',1,'[]',?)`).run(independent());
    db.prepare(`INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,provenance_json)
      VALUES('good-null-task','case-source-less','good-null','manual-review','review','manual-review','人工事实待核对',?)`).run(independent());
    rebuildSupportedCase(db, "case-source-less");
    const projection = JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id='case-source-less'").get()!.projection_json));
    assert.equal(projection.requiresReview, true);
  } finally { db.close(); }
});

test("R10 migration019 preserves legacy event/task ids, rows, composite FK, and indexes", () => {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  try {
    for (const migration of MIGRATIONS.slice(0, 18)) db.exec(migration);
    db.exec(`INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,status,created_at) VALUES(1,'fixture',X'00','none','ok',0);
      INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain) VALUES(1,1,'o','r','a@example.test','example.test');
      INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,observed_at) VALUES('legacy-source',1,'hash','headers',1);
      INSERT INTO mail_application_cases(id,projection_json) VALUES('legacy-case','{}');
      INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json)
        VALUES('legacy-event','legacy-case','legacy-source','1:legacy','review_required',1,'[]','{"supportSourceIds":["legacy-source"],"kind":"source_derived","verifiedAt":null,"reason":null}');
      INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,provenance_json)
        VALUES('legacy-task','legacy-case','legacy-event','legacy','review','legacy','legacy','{"supportSourceIds":["legacy-source"],"kind":"source_derived","verifiedAt":null,"reason":null}');`);
    db.exec(MIGRATIONS[18]!);
    assert.equal(db.prepare("SELECT event_id FROM mail_case_tasks WHERE id='legacy-task'").get()!.event_id, "legacy-event");
    assert.equal(db.prepare("SELECT source_id FROM mail_case_events WHERE id='legacy-event'").get()!.source_id, "legacy-source");
    const eventIndexes = db.prepare("PRAGMA index_list('mail_case_events')").all().map((row) => String(row.name));
    const taskIndexes = db.prepare("PRAGMA index_list('mail_case_tasks')").all().map((row) => String(row.name));
    assert.ok(eventIndexes.includes("mail_case_events_sourceless_slot"));
    assert.ok(eventIndexes.includes("mail_case_events_observed"));
    assert.ok(taskIndexes.includes("mail_case_tasks_state"));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const composite = db.prepare("PRAGMA foreign_key_list('mail_case_tasks')").all().filter((row) => row.table === "mail_case_events");
    assert.deepEqual(composite.map((row) => [row.from, row.to, row.on_delete]), [["event_id", "id", "CASCADE"], ["case_id", "case_id", "CASCADE"]]);
    assert.throws(() => db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,provenance_json) VALUES('bad-fk','legacy-case','missing','x','review','x','x',?)").run(independent()), /foreign key/i);
    db.prepare("DELETE FROM mail_case_events WHERE id='legacy-event'").run();
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks WHERE id='legacy-task'").get()!.n, 0);
  } finally { db.close(); }
});

test("B30/B36/B62 real mailbox fake flow cleans a complete-snapshot miss and aborts only after commit", async () => {
  const db = fixture();
  db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,attachments_json)
    VALUES(1,'INBOX',2,'100','"Sender"','["sender@fixture.test"]','[]','[]','fixture',20,'body',1,'<fixture>','[]','[]')`).run();
  db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,attachments_json)
    VALUES(1,'INBOX',1,'100','"Sender"','["sender@fixture.test"]','[]','[]','keep',10,'keep',1,'<keep>','[]','[]')`).run();
  db.prepare("UPDATE mailboxes SET sync_state_json=? WHERE id=1").run(JSON.stringify({ folders: { INBOX: { uidValidity: "100" } } }));
  const fake = new FakeMailTransport(); fake.passwords.set("support@nordicpaws.com", "fixture"); fake.seed("support@nordicpaws.com", "INBOX", [
    { uid: 1, uidValidity: "100", folder: "INBOX", flags: [], size: 10, source: fakeRawMail({ from: "sender@fixture.test", to: ["support@nordicpaws.com"], subject: "keep", text: "keep" }) },
  ]);
  const aborted: string[][] = [];
  const service = createMailboxService({
    db, key, accounts: () => [], transport: () => fake, push: () => {},
    triageLifecycleHooks: {
      invalidateSource: (sourceId, reason, now) => invalidateSource(db, sourceId, reason, now),
      abortSources: (ids) => { assert.equal(db.isTransaction, false); aborted.push(ids); },
    },
  });
  try {
    await service.withInboxSnapshot(1, () => undefined);
    assert.equal(db.prepare("SELECT state FROM mail_triage_sources WHERE id='source-b'").get()!.state, "missing");
    assert.equal(db.prepare("SELECT state FROM mail_triage_jobs WHERE id='job-b'").get()!.state, "cancelled");
    assert.deepEqual(aborted, [["source-b"]]);
  } finally { await service.close(); db.close(); }
});

test("B36 exact full-fingerprint recovery reuses one same-mailbox source but never a cross-mailbox copy", async () => {
  const { db } = setup({ cachedMailbox: { password: "fixture" } });
  try {
    db.exec(`INSERT INTO model_providers(id,name,protocol,base_url,models_json,created_at) VALUES(1,'offline','openai','https://never.example.test','[]',0);
      INSERT INTO model_roles(role,provider_id,model_id,thinking) VALUES('mail_triage',1,'offline','off');
      UPDATE mail_triage_settings SET enabled=1,state='enabled',consent_provider_revision=1;
      INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(1,1,'authorized','100',0,0);
      INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain) VALUES(2,1,'o2','r2','copy@example.test','example.test');
      INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(2,1,'authorized','200',0,0);`);
    const mail = await parseMailText(fakeRawMail({ from: "sender@fixture.test", to: ["support@nordicpaws.com"], subject: "same", text: "same full body", messageId: "<same@fixture>" }));
    const first = registerCachedSource(db, { locator: { mailboxId: 1, folder: "INBOX", uidValidity: "100", uid: 1 }, mail, observedAt: 1 }, key);
    invalidateSource(db, first.sourceId, "missing", 2);
    const restored = registerCachedSource(db, { locator: { mailboxId: 1, folder: "INBOX", uidValidity: "100", uid: 2 }, mail, observedAt: 3 }, key);
    assert.equal(restored.sourceId, first.sourceId);
    assert.equal(db.prepare("SELECT state FROM mail_triage_sources WHERE id=?").get(first.sourceId)!.state, "active");
    const copy = registerCachedSource(db, { locator: { mailboxId: 2, folder: "INBOX", uidValidity: "200", uid: 1 }, mail, observedAt: 4 }, key);
    assert.notEqual(copy.sourceId, first.sourceId);
  } finally { db.close(); }
});

test("B53/B59 trash fences before fake remote I/O and only confirmed success performs explicit sensitive cleanup", async () => {
  const db = fixture(); const sentinel = insertDerivedCase(db);
  db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,attachments_json)
    VALUES(1,'INBOX',2,'100','"Sender"','["sender@fixture.test"]','[]','[]','fixture',20,'body',1,'<fixture>','[]','[]')`).run();
  const fake = new FakeMailTransport(); fake.passwords.set("support@nordicpaws.com", "fixture");
  fake.seed("support@nordicpaws.com", "INBOX", [{ uid: 2, uidValidity: "100", folder: "INBOX", flags: [], size: 10, source: fakeRawMail({ from: "sender@fixture.test", to: ["support@nordicpaws.com"], subject: "fixture", text: "body" }) }]);
  const originalMove = fake.moveToTrash.bind(fake); let remoteSawFence = false;
  fake.moveToTrash = async (...args) => { remoteSawFence = db.prepare("SELECT state FROM mail_triage_jobs WHERE id='job-b'").get()!.state === "cancelled"; return originalMove(...args); };
  const service = createMailboxService({
    db, key, accounts: () => [], transport: () => fake, push: () => {},
    triageLifecycleHooks: {
      invalidateSource: (sourceId, reason, now) => invalidateSource(db, sourceId, reason, now),
      abortSources: () => {},
    },
  });
  try {
    await service.trash({ mailboxId: 1, folder: "INBOX", uid: 2, confirmed: true });
    assert.equal(remoteSawFence, true);
    assert.equal(db.prepare("SELECT state FROM mail_triage_sources WHERE id='source-b'").get()!.state, "deleted");
    assert.doesNotMatch(jsonText(db), new RegExp(sentinel));
  } finally { await service.close(); db.close(); }
});

test("fix1 trash is locator-scoped and preserves a second valid same-mailbox alias and its facts", async () => {
  const db = fixture(); insertDerivedCase(db);
  db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,attachments_json)
    VALUES(1,'INBOX',2,'100','"Sender"','["sender@fixture.test"]','[]','[]','fixture',20,'body',1,'<fixture>','[]','[]')`).run();
  db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,attachments_json)
    VALUES(1,'Archive',3,'100','"Sender"','["sender@fixture.test"]','[]','[]','fixture copy',20,'body',1,'<fixture>','[]','[]')`).run();
  db.prepare("INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id) VALUES(1,'Archive','100',3,'source-b')").run();
  const fake = new FakeMailTransport(); fake.passwords.set("support@nordicpaws.com", "fixture");
  fake.seed("support@nordicpaws.com", "INBOX", [{ uid: 2, uidValidity: "100", folder: "INBOX", flags: [], size: 10, source: fakeRawMail({ from: "sender@fixture.test", to: ["support@nordicpaws.com"], subject: "fixture", text: "body" }) }]);
  const aborted: string[][] = [];
  const service = createMailboxService({ db, key, accounts: () => [], transport: () => fake, push: () => {}, triageLifecycleHooks: {
    invalidateSource: (id, reason, now) => invalidateSource(db, id, reason, now),
    abortSources: (ids) => aborted.push(ids),
  } });
  try {
    await service.trash({ mailboxId: 1, folder: "INBOX", uid: 2, confirmed: true });
    assert.equal(db.prepare("SELECT state FROM mail_triage_sources WHERE id='source-b'").get()!.state, "active");
    assert.equal(db.prepare("SELECT active FROM mail_triage_source_aliases WHERE source_id='source-b' AND folder='Archive'").get()!.active, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_events WHERE id='event-case-derived'").get()!.n, 1);
    assert.deepEqual(aborted, [["source-b"]]);
  } finally { await service.close(); db.close(); }
});

test("B53 unknown trash outcome stays blocked and retains historical data instead of guessing deletion", async () => {
  const db = fixture(); const sentinel = insertDerivedCase(db);
  db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,attachments_json)
    VALUES(1,'INBOX',2,'100','"Sender"','["sender@fixture.test"]','[]','[]','fixture',20,'body',1,'<fixture>','[]','[]')`).run();
  const fake = new FakeMailTransport(); fake.passwords.set("support@nordicpaws.com", "fixture");
  fake.moveToTrash = async () => { throw new Error("remote outcome unknown"); };
  const service = createMailboxService({ db, key, accounts: () => [], transport: () => fake, push: () => {}, triageLifecycleHooks: {
    invalidateSource: (sourceId, reason, now) => invalidateSource(db, sourceId, reason, now), abortSources: () => {},
  } });
  try {
    await assert.rejects(service.trash({ mailboxId: 1, folder: "INBOX", uid: 2, confirmed: true }), /unknown/);
    assert.equal(db.prepare("SELECT state FROM mail_triage_sources WHERE id='source-b'").get()!.state, "missing");
    assert.equal(db.prepare("SELECT state FROM mail_triage_jobs WHERE id='job-b'").get()!.state, "cancelled");
    assert.match(jsonText(db), new RegExp(sentinel));
  } finally { await service.close(); db.close(); }
});

test("B59 verified mailbox deletion purges source support before FK cascade and keeps anonymous attempt ledger", async () => {
  const db = fixture(); const sentinel = insertDerivedCase(db);
  const box = db.prepare("SELECT account_id,order_id,remote_id FROM mailboxes WHERE id=1").get()!;
  let remoteExists = true;
  const exec = async (operation: string) => {
    if (operation === "mail_mailboxes_delete-mailbox") { remoteExists = false; return { ok: true }; }
    if (operation === "mail_mailboxes_list") return remoteExists ? [{ id: box.remote_id }] : [];
    throw new Error(`unexpected ${operation}`);
  };
  const service = createMailboxService({ db, key, accounts: () => [{ id: Number(box.account_id), exec }], push: () => {}, triageLifecycleHooks: {
    invalidateScope: (input, now) => invalidateTriageScope(db, input, now),
    invalidateSource: (sourceId, reason, now) => invalidateSource(db, sourceId, reason, now),
    abortSources: () => {},
  } });
  try {
    await service.deleteMailbox({ mailboxId: 1, confirmed: true });
    assert.equal(db.prepare("SELECT 1 FROM mailboxes WHERE id=1").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM mail_triage_sources WHERE id='source-b'").get(), undefined);
    assert.equal(db.prepare("SELECT job_id FROM mail_triage_attempts WHERE id='attempt-b'").get()!.job_id, null);
    assert.doesNotMatch(jsonText(db), new RegExp(sentinel));
  } finally { await service.close(); db.close(); }
});
