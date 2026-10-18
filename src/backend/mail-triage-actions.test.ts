import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { setup } from "./testing.ts";
import type { Fence, Provenance } from "../shared/mail-triage-types.ts";
import type { ValidatedAssessment } from "./mail-triage-analyzer.ts";
import { applyManualDecision, undoManualDecision, type ManualMutation } from "./mail-triage-actions.ts";
import { applyAssessment, reprojectCases, registerPendingReview } from "./mail-case-projector.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const caseId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const actor = { userId: 7 };
const derived = (ids: string[]): Provenance => ({ supportSourceIds: ids, kind: "source_derived", verifiedAt: null, reason: null });
const independent = (reason = "已在平台后台逐项核验", verifiedAt = 100): Provenance => ({ supportSourceIds: [], kind: "independent_manual", verifiedAt, reason });

function fixture() {
  const { db } = setup({ cachedMailbox: { password: "fixture" } });
  db.exec("UPDATE mail_triage_settings SET enabled=1,state='enabled'; INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(1,1,'authorized','100',0,0)");
  db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,trust,observed_at) VALUES(?,1,'h','h','contact_mapped',100)").run(sourceId);
  db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,attachments_json) VALUES(1,'INBOX',1,'100','\"Sender\"','[\"support@fixture.test\"]','[]','[]','APP-2',90,'APP-2 new material','1','<fixture>','[]','[]')").run();
  db.prepare("INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id) VALUES(1,'INBOX','100',1,?)").run(sourceId);
  db.prepare("INSERT INTO mail_triage_contacts(id,provider,mailbox_id,address,reason,confirmed_by,confirmed_at) VALUES('mapping','Fixture',1,'support@fixture.test','fixture','actor',1)").run();
  db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,version,manual_version) VALUES(?,'confirmed','Fixture','APP-1',?,'{}',1,0)").run(caseId, JSON.stringify(independent()));
  db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'fixture')").run(caseId, sourceId);
  db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:request', 'request_action',1,100,'[]',?)").run(eventId, caseId, sourceId, JSON.stringify(derived([sourceId])));
  db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,requested_items_json,provenance_json) VALUES(?,?,?,'passport','action','passport','提交护照','[\"护照\"]',?)").run(taskId, caseId, eventId, JSON.stringify(derived([sourceId])));
  db.exec("BEGIN IMMEDIATE"); try { reprojectCases(db, { caseIds: [caseId], now: 100 }); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
  return db;
}

function mutation(value: ManualMutation["kind"] extends never ? never : ManualMutation): ManualMutation { return value; }

test("B15/B26 typed correction uses case manual CAS and keeps a field-level lock", () => {
  const db = fixture();
  try {
    const input = mutation({ kind: "correct", target: { type: "task", id: taskId }, field: "state", value: "dismissed", requestId: randomUUID(), expectedVersion: 0, reason: "该请求已被人工确认无需处理" });
    const first = applyManualDecision(db, input, actor);
    assert.equal(first.version, 1);
    assert.equal(JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json)).tasks.find((task: { id: string }) => task.id === taskId).state, "dismissed");
    assert.throws(() => applyManualDecision(db, { ...input, requestId: randomUUID() }, actor), /version_conflict/);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_manual_decisions WHERE object_id=? AND field='state'").get(taskId)!.n, 1);
  } finally { db.close(); }
});

test("B41 deadline correction requires raw/parsed consistency and snooze stays local", () => {
  const db = fixture();
  try {
    assert.throws(() => applyManualDecision(db, mutation({ kind: "correct", target: { type: "task", id: taskId }, field: "deadline", value: { deadlineRaw: "2026-11-01", deadlineAt: 1 }, requestId: randomUUID(), expectedVersion: 0, reason: "人工查看平台截止时间" }), actor), /deadline/);
    const snooze = applyManualDecision(db, mutation({ kind: "correct", target: { type: "task", id: taskId }, field: "snoozedUntil", value: 200, requestId: randomUUID(), expectedVersion: 0, reason: "明天再提醒" }), actor);
    assert.equal(snooze.version, 1);
    assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(taskId)!.state, "open");
  } finally { db.close(); }
});

test("B37/B54 independent fact is explicit and undo appends compensation audit", () => {
  const db = fixture();
  try {
    assert.throws(() => applyManualDecision(db, mutation({ kind: "independent_fact", caseId, fact: { type: "decision", value: "approved" }, verifiedAt: 0, requestId: randomUUID(), expectedVersion: 0, reason: "平台核验" }), actor));
    const applied = applyManualDecision(db, mutation({ kind: "independent_fact", caseId, fact: { type: "decision", value: "approved" }, verifiedAt: 123, requestId: randomUUID(), expectedVersion: 0, reason: "已在平台后台逐项核验" }), actor);
    const undone = undoManualDecision(db, { decisionId: applied.decisionId, requestId: randomUUID(), expectedVersion: applied.version, reason: "录入错误，撤销该独立事实" }, actor);
    assert.equal(undone.version, applied.version + 1);
    const audit = db.prepare("SELECT undo_of FROM mail_case_manual_decisions WHERE undo_of=?").get(applied.decisionId);
    assert.equal(audit?.undo_of, applied.decisionId);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_manual_decisions WHERE id=?").get(applied.decisionId)!.n, 1);
  } finally { db.close(); }
});

test("B51 appeal_requested starts one pending cycle and replay is idempotent", () => {
  const db = fixture();
  try {
    const requestId = randomUUID();
    const input = mutation({ kind: "appeal_requested", caseId, requestId, expectedVersion: 0, reason: "已人工确认复审申请提交" });
    const first = applyManualDecision(db, input, actor), replay = applyManualDecision(db, input, actor);
    assert.deepEqual(replay, first);
    const projection = JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json));
    assert.equal(projection.decisionCycle, 2);
    assert.equal(projection.decision, "pending");
    assert.ok(projection.milestones.includes("待确认受理"));
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_events WHERE case_id=? AND kind='reconsideration_requested'").get(caseId)!.n, 1);
    undoManualDecision(db, { decisionId: first.decisionId, requestId: randomUUID(), expectedVersion: first.version, reason: "撤销误录复审" }, actor);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_events WHERE case_id=? AND kind IN ('reconsideration_requested','review_required')").get(caseId)!.n, 0);
  } finally { db.close(); }
});

test("R17 source correction uses its own CAS clock and rejects an old body generation", () => {
  const db = fixture();
  try {
    const requestId = randomUUID();
    const input = mutation({ kind: "correct", target: { type: "source", id: sourceId, sourceVersion: 1 }, field: "tag", value: "材料补交", requestId, expectedVersion: 0, reason: "人工按原文纠正标签" });
    const result = applyManualDecision(db, input, actor);
    assert.equal(result.version, 1);
    assert.equal(db.prepare("SELECT source_version FROM mail_triage_sources WHERE id=?").get(sourceId)!.source_version, 1);
    const audit = db.prepare("SELECT provenance_json,after_json FROM mail_case_manual_decisions WHERE id=?").get(result.decisionId)!;
    assert.equal(JSON.parse(String(audit.provenance_json)).kind, "source_derived");
    assert.equal(JSON.parse(String(audit.after_json)).sourceVersion, 1);
    const later = applyManualDecision(db, mutation({ kind: "correct", target: { type: "source", id: sourceId, sourceVersion: 1 }, field: "tag", value: "资料补交", requestId: randomUUID(), expectedVersion: 1, reason: "再次核对原文" }), actor);
    assert.throws(() => undoManualDecision(db, { decisionId: result.decisionId, requestId: randomUUID(), expectedVersion: later.version, reason: "不能越过后续同字段纠正" }, actor), /undo_conflict/);
    assert.throws(() => applyManualDecision(db, mutation({ kind: "correct", target: { type: "source", id: sourceId, sourceVersion: 2 }, field: "tag", value: "材料补交", requestId: randomUUID(), expectedVersion: 2, reason: "旧正文页面" }), actor), /source_version_conflict/);
    assert.throws(() => applyManualDecision(db, { ...input, requestId: randomUUID() }, actor), /version_conflict/);
  } finally { db.close(); }
});

test("B16 manual link rechecks every mailbox source and split moves only selected event ownership", () => {
  const db = fixture();
  const source2 = "55555555-5555-4555-8555-555555555555", event2 = "66666666-6666-4666-8666-666666666666";
  try {
    db.exec("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,status) VALUES(2,1,'fixture-2','remote-2','other@fixture.test','fixture.test','active'); INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(2,1,'authorized','200',0,0)");
    db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,trust,observed_at) VALUES(?,2,'h2','h2','unconfirmed',101)").run(source2);
    db.prepare("INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id) VALUES(2,'INBOX','200',1,?)").run(source2);
    const linked = applyManualDecision(db, mutation({ kind: "link", caseId, sourceIds: [source2], requestId: randomUUID(), expectedVersion: 0, reason: "人工核对为同一申请" }), actor);
    assert.equal(linked.version, 1);
    assert.equal(db.prepare("SELECT manual_locked FROM mail_case_sources WHERE case_id=? AND source_id=?").get(caseId, source2)!.manual_locked, 1);
    assert.throws(() => applyManualDecision(db, mutation({ kind: "link", caseId, sourceIds: [randomUUID()], requestId: randomUUID(), expectedVersion: 1, reason: "无权限来源" }), actor), /source_not_authorized/);
    db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:notice','notification',1,101,'[]',?)").run(event2, caseId, source2, JSON.stringify(derived([source2])));
    const split = applyManualDecision(db, mutation({ kind: "split", caseId, eventIds: [event2], newIdentity: { provider: "Fixture", siteId: null, applicationId: "APP-2" }, requestId: randomUUID(), expectedVersion: 1, reason: "原邮件同时包含另一申请，人工拆分" }), actor);
    const newCaseId = String(split.after.caseId);
    assert.equal(db.prepare("SELECT case_id FROM mail_case_events WHERE id=?").get(event2)!.case_id, newCaseId);
    assert.equal(db.prepare("SELECT case_id FROM mail_case_events WHERE id=?").get(eventId)!.case_id, caseId);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_events WHERE case_id=? AND source_id=?").get(newCaseId, sourceId)!.n, 0);
  } finally { db.close(); }
});

test("B49 source confirmation is not an independent platform fact", () => {
  const db = fixture();
  try {
    const result = applyManualDecision(db, mutation({ kind: "correct", target: { type: "source", id: sourceId, sourceVersion: 1 }, field: "sourceTrust", value: "human_confirmed", requestId: randomUUID(), expectedVersion: 0, reason: "人工确认这封邮件的来源" }), actor);
    assert.equal(db.prepare("SELECT trust FROM mail_triage_sources WHERE id=?").get(sourceId)!.trust, "human_confirmed");
    const provenance = JSON.parse(String(db.prepare("SELECT provenance_json FROM mail_case_manual_decisions WHERE id=?").get(result.decisionId)!.provenance_json));
    assert.equal(provenance.kind, "source_derived");
    assert.notEqual(provenance.kind, "independent_manual");
  } finally { db.close(); }
});

test("Fix1 split undo refuses real projector facts created after the split", () => {
  const db = fixture();
  try {
    const split = applyManualDecision(db, mutation({ kind: "split", caseId, eventIds: [eventId], newIdentity: { provider: "Fixture", siteId: null, applicationId: "APP-2" }, requestId: randomUUID(), expectedVersion: 0, reason: "拆分另一申请" }), actor);
    const newCaseId = String(split.after.caseId);
    db.exec("BEGIN IMMEDIATE"); try { registerPendingReview(db, { sourceId, sourceVersion: 1, configEpoch: 1, now: 200 }); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_tasks WHERE case_id=? AND obligation_key='review_new_mail'").get(newCaseId)!.n, 1);
    assert.throws(() => undoManualDecision(db, { decisionId: split.decisionId, requestId: randomUUID(), expectedVersion: split.version, reason: "不得删除后续真实事实" }, actor), /undo_conflict/);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_application_cases WHERE id=?").get(newCaseId)!.n, 1);
  } finally { db.close(); }
});

test("Fix1 appeal undo refuses a real reconsideration acceptance", () => {
  const db = fixture();
  try {
    db.exec("UPDATE mail_triage_sources SET trust='human_confirmed'; UPDATE mail_messages SET body_text='APP-1 accepted',snippet='APP-1 accepted'");
    db.prepare("UPDATE mail_case_sources SET manual_locked=1 WHERE case_id=? AND source_id=?").run(caseId, sourceId);
    const appeal = applyManualDecision(db, mutation({ kind: "appeal_requested", caseId, requestId: randomUUID(), expectedVersion: 0, reason: "已提交复审" }), actor);
    const fence: Fence = { jobId: randomUUID(), leaseToken: "lease", attemptSeq: 1, configEpoch: 1, sourceVersion: 1, contextVersion: "accepted", manualVersion: 0 };
    db.prepare("INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,config_epoch,state,lease_token,lease_expires_at,attempt_seq,manual_version) VALUES(?,?,1,1,'fixture',1,1,1,1,'accepted',1,'running','lease',1000,1,0)").run(fence.jobId, sourceId);
    const quote = "accepted";
    const assessment: ValidatedAssessment = { schemaVersion: 1, primaryCategory: "progress", tag: "复审受理", summary: "平台已受理", caseSuggestion: { providerCandidate: "Fixture", applicationId: "APP-1", candidateCaseId: caseId, matchBasis: [], needsReview: false }, events: [{ kind: "reconsideration_accepted", evidence: [{ sourceId, quote }] }], actions: [], completionSuggestions: [], uncertainties: [], requiresHumanReview: false, grade: "evidence_complete", usage: null, evidenceLocations: [{ path: "/events/0/evidence/0", sourceId, quote, locations: [{ field: "text", segment: "current_body", start: 6, end: 14, coordinateUnit: "utf16" }] }], applicationRestrictions: [] };
    db.exec("BEGIN IMMEDIATE"); try { applyAssessment(db, { sourceId, assessment, fence, now: 300 }); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_events WHERE case_id=? AND kind='reconsideration_accepted'").get(caseId)!.n, 1);
    assert.throws(() => undoManualDecision(db, { decisionId: appeal.decisionId, requestId: randomUUID(), expectedVersion: appeal.version, reason: "不能留下孤立受理" }, actor), /undo_conflict/);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_events WHERE id=?").get(String(appeal.after.eventId))!.n, 1);
  } finally { db.close(); }
});

test("Fix1 link and identity undo restore every persisted field", () => {
  const db = fixture();
  try {
    const link = applyManualDecision(db, mutation({ kind: "link", caseId, sourceIds: [sourceId], requestId: randomUUID(), expectedVersion: 0, reason: "人工关联" }), actor);
    undoManualDecision(db, { decisionId: link.decisionId, requestId: randomUUID(), expectedVersion: link.version, reason: "撤销关联" }, actor);
    assert.deepEqual({ ...db.prepare("SELECT match_basis,manual_locked FROM mail_case_sources WHERE case_id=? AND source_id=?").get(caseId, sourceId) }, { match_basis: "fixture", manual_locked: 0 });
    const priorProvenance = String(db.prepare("SELECT identity_provenance_json FROM mail_application_cases WHERE id=?").get(caseId)!.identity_provenance_json);
    const confirmed = applyManualDecision(db, mutation({ kind: "confirm_case", caseId, identity: { provider: "Other", siteId: null, applicationId: "APP-9" }, requestId: randomUUID(), expectedVersion: 2, reason: "纠正身份" }), actor);
    undoManualDecision(db, { decisionId: confirmed.decisionId, requestId: randomUUID(), expectedVersion: confirmed.version, reason: "撤销身份纠正" }, actor);
    assert.equal(db.prepare("SELECT identity_provenance_json FROM mail_application_cases WHERE id=?").get(caseId)!.identity_provenance_json, priorProvenance);
  } finally { db.close(); }
});

test("Fix1 every case mutation and undo reject a partially revoked linked case", () => {
  const operations = [
    () => mutation({ kind: "link", caseId, sourceIds: [sourceId], requestId: randomUUID(), expectedVersion: 0, reason: "link" }),
    () => mutation({ kind: "split", caseId, eventIds: [eventId], newIdentity: { provider: "Fixture", siteId: null, applicationId: "APP-2" }, requestId: randomUUID(), expectedVersion: 0, reason: "split" }),
    () => mutation({ kind: "confirm_case", caseId, identity: { provider: "Fixture", siteId: null, applicationId: "APP-1" }, requestId: randomUUID(), expectedVersion: 0, reason: "confirm" }),
    () => mutation({ kind: "independent_fact", caseId, fact: { type: "stage", value: "reviewing" }, verifiedAt: 123, requestId: randomUUID(), expectedVersion: 0, reason: "fact" }),
    () => mutation({ kind: "appeal_requested", caseId, requestId: randomUUID(), expectedVersion: 0, reason: "appeal" }),
  ];
  for (const operation of operations) {
    const db = fixture(); try {
      const revoked = randomUUID();
      db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,state,observed_at) VALUES(?,1,?,?,'missing',1)").run(revoked, revoked, revoked);
      db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'old')").run(caseId, revoked);
      assert.throws(() => applyManualDecision(db, operation(), actor), /case_not_authorized/);
    } finally { db.close(); }
  }
  const db = fixture(); try {
    const applied = applyManualDecision(db, mutation({ kind: "independent_fact", caseId, fact: { type: "stage", value: "reviewing" }, verifiedAt: 123, requestId: randomUUID(), expectedVersion: 0, reason: "fact" }), actor);
    const revoked = randomUUID(); db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,state,observed_at) VALUES(?,1,?,?,'missing',1)").run(revoked, revoked, revoked);
    db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'old')").run(caseId, revoked);
    assert.throws(() => undoManualDecision(db, { decisionId: applied.decisionId, requestId: randomUUID(), expectedVersion: applied.version, reason: "undo" }, actor), /case_not_authorized/);
  } finally { db.close(); }
});

test("Fix1 fresh result validation rolls the entire mutation back", () => {
  const db = fixture(); try {
    db.exec("CREATE TRIGGER corrupt_projection AFTER UPDATE OF projection_json ON mail_application_cases BEGIN UPDATE mail_application_cases SET projection_json='{}' WHERE id=NEW.id; END");
    assert.throws(() => applyManualDecision(db, mutation({ kind: "correct", target: { type: "task", id: taskId }, field: "state", value: "dismissed", requestId: randomUUID(), expectedVersion: 0, reason: "测试严格输出" }), actor));
    db.exec("DROP TRIGGER corrupt_projection");
    assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(taskId)!.state, "open");
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_manual_decisions").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_requests WHERE operation='manual.apply'").get()!.n, 0);
  } finally { db.close(); }
});

test("Fix1 fresh safe DTO count limits also roll the mutation back", () => {
  const db = fixture(); try {
    const insert = db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,requested_items_json,provenance_json) VALUES(?,?,?,?,'action',?,'额外材料','[]',?)");
    for (let index = 0; index < 1024; index++) insert.run(randomUUID(), caseId, eventId, `extra-${index}`, `extra-${index}`, JSON.stringify(derived([sourceId])));
    db.exec("BEGIN IMMEDIATE"); try { reprojectCases(db, { caseIds: [caseId], now: 110 }); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
    assert.throws(() => applyManualDecision(db, mutation({ kind: "independent_fact", caseId, fact: { type: "stage", value: "reviewing" }, verifiedAt: 120, requestId: randomUUID(), expectedVersion: 0, reason: "测试DTO数量边界" }), actor));
    assert.equal(db.prepare("SELECT manual_version FROM mail_application_cases WHERE id=?").get(caseId)!.manual_version, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_manual_decisions").get()!.n, 0);
  } finally { db.close(); }
});

test("Fix2 corrupted link before-fence cannot target an unrelated case", () => {
  const db = fixture(), victimCaseId = randomUUID(), victimEventId = randomUUID(), victimTaskId = randomUUID();
  try {
    db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json) VALUES(?,'confirmed','Victim','VICTIM',?,'{}')").run(victimCaseId, JSON.stringify(independent("victim", 50)));
    db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'victim')").run(victimCaseId, sourceId);
    db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:victim','notification',50,'[]',?)").run(victimEventId, victimCaseId, sourceId, JSON.stringify(derived([sourceId])));
    db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,provenance_json) VALUES(?,?,?,'victim','review','victim','受保护事实',?)").run(victimTaskId, victimCaseId, victimEventId, JSON.stringify(derived([sourceId])));
    db.exec("BEGIN IMMEDIATE"); try { reprojectCases(db, { caseIds: [victimCaseId], now: 50 }); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
    const link = applyManualDecision(db, mutation({ kind: "link", caseId, sourceIds: [sourceId], requestId: randomUUID(), expectedVersion: 0, reason: "人工关联" }), actor);
    const audit = db.prepare("SELECT before_json FROM mail_case_manual_decisions WHERE id=?").get(link.decisionId)!;
    const corrupted = JSON.parse(String(audit.before_json));
    corrupted.fence = [{ case: { id: victimCaseId }, sources: [], events: [], tasks: [] }];
    db.prepare("UPDATE mail_case_manual_decisions SET before_json=? WHERE id=?").run(JSON.stringify(corrupted), link.decisionId);
    const beforeUndo = db.serialize(), undoRequestId = randomUUID();
    assert.throws(() => undoManualDecision(db, { decisionId: link.decisionId, requestId: undoRequestId, expectedVersion: link.version, reason: "不得跨case删除" }, actor), /audit_snapshot_invalid|undo_conflict/);
    assert.deepEqual(db.serialize(), beforeUndo);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_events WHERE id=?").get(victimEventId)!.n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_tasks WHERE id=?").get(victimTaskId)!.n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_requests WHERE request_id=?").get(undoRequestId)!.n, 0);
  } finally { db.close(); }
});

test("Fix2 every high-risk audit rejects missing, non-array, or malformed fences without side effects", () => {
  const cases: { name: string; input: () => ManualMutation; column: "before_json" | "after_json"; corrupt: (raw: string) => string }[] = [
    { name: "split missing before fence", input: () => mutation({ kind: "split", caseId, eventIds: [eventId], newIdentity: { provider: "Fixture", siteId: null, applicationId: "APP-2" }, requestId: randomUUID(), expectedVersion: 0, reason: "拆分" }), column: "before_json", corrupt: raw => { const value = JSON.parse(raw); delete value.fence; return JSON.stringify(value); } },
    { name: "identity non-array before fence", input: () => mutation({ kind: "confirm_case", caseId, identity: { provider: "Fixture", siteId: null, applicationId: "APP-9" }, requestId: randomUUID(), expectedVersion: 0, reason: "确认" }), column: "before_json", corrupt: raw => { const value = JSON.parse(raw); value.fence = {}; return JSON.stringify(value); } },
    { name: "appeal corrupt after snapshot", input: () => mutation({ kind: "appeal_requested", caseId, requestId: randomUUID(), expectedVersion: 0, reason: "复审" }), column: "after_json", corrupt: () => JSON.stringify("corrupt") },
    { name: "link missing after fence", input: () => mutation({ kind: "link", caseId, sourceIds: [sourceId], requestId: randomUUID(), expectedVersion: 0, reason: "关联" }), column: "after_json", corrupt: raw => { const value = JSON.parse(raw); delete value.fence; return JSON.stringify(value); } },
    { name: "split non-array after fence", input: () => mutation({ kind: "split", caseId, eventIds: [eventId], newIdentity: { provider: "Fixture", siteId: null, applicationId: "APP-2" }, requestId: randomUUID(), expectedVersion: 0, reason: "拆分" }), column: "after_json", corrupt: raw => { const value = JSON.parse(raw); value.fence = null; return JSON.stringify(value); } },
  ];
  for (const item of cases) {
    const db = fixture();
    try {
      const applied = applyManualDecision(db, item.input(), actor);
      const row = db.prepare(`SELECT ${item.column} value FROM mail_case_manual_decisions WHERE id=?`).get(applied.decisionId)!;
      db.prepare(`UPDATE mail_case_manual_decisions SET ${item.column}=? WHERE id=?`).run(item.corrupt(String(row.value)), applied.decisionId);
      const beforeUndo = db.serialize(), undoRequestId = randomUUID();
      assert.throws(() => undoManualDecision(db, { decisionId: applied.decisionId, requestId: undoRequestId, expectedVersion: applied.version, reason: `拒绝损坏审计 ${item.name}` }, actor), /audit_snapshot_invalid/, item.name);
      assert.deepEqual(db.serialize(), beforeUndo, item.name);
      assert.equal(db.prepare("SELECT count(*) n FROM mail_case_manual_decisions WHERE undo_of=?").get(applied.decisionId)!.n, 0, item.name);
      assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_requests WHERE request_id=?").get(undoRequestId)!.n, 0, item.name);
    } finally { db.close(); }
  }
});

test("Fix2 a valid split snapshot still undoes exactly the selected ownership", () => {
  const db = fixture();
  try {
    const split = applyManualDecision(db, mutation({ kind: "split", caseId, eventIds: [eventId], newIdentity: { provider: "Fixture", siteId: null, applicationId: "APP-2" }, requestId: randomUUID(), expectedVersion: 0, reason: "有效拆分" }), actor);
    const newCaseId = String(split.after.caseId);
    undoManualDecision(db, { decisionId: split.decisionId, requestId: randomUUID(), expectedVersion: split.version, reason: "撤销有效拆分" }, actor);
    assert.equal(db.prepare("SELECT case_id FROM mail_case_events WHERE id=?").get(eventId)!.case_id, caseId);
    assert.equal(db.prepare("SELECT case_id FROM mail_case_tasks WHERE id=?").get(taskId)!.case_id, caseId);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_application_cases WHERE id=?").get(newCaseId)!.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_manual_decisions WHERE undo_of=?").get(split.decisionId)!.n, 1);
  } finally { db.close(); }
});

test("Fix3 split and appeal cannot treat an omitted pre-existing safety pair as operation-owned", () => {
  const operations: { name: string; input: () => ManualMutation }[] = [
    { name: "split", input: () => mutation({ kind: "split", caseId, eventIds: [eventId], newIdentity: { provider: "Fixture", siteId: null, applicationId: "APP-2" }, requestId: randomUUID(), expectedVersion: 0, reason: "拆分" }) },
    { name: "appeal", input: () => mutation({ kind: "appeal_requested", caseId, requestId: randomUUID(), expectedVersion: 0, reason: "复审" }) },
  ];
  for (const operation of operations) {
    const db = fixture();
    try {
      const seededEventId = randomUUID(), seededTaskId = randomUUID();
      db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:safety_review:1:account_risk:seed','review_required',1,100,'[]',?)").run(seededEventId, caseId, sourceId, JSON.stringify(derived([sourceId])));
      db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,requested_items_json,provenance_json) VALUES(?,?,?,'safety_review:account_risk','review','safety_review:account_risk','既有安全核对','[]',?)").run(seededTaskId, caseId, seededEventId, JSON.stringify(derived([sourceId])));
      const safetyEvent = db.prepare("SELECT id FROM mail_case_events WHERE case_id=? AND kind='review_required' ORDER BY id LIMIT 1").get(caseId);
      assert.ok(safetyEvent, `${operation.name} fixture must contain a pre-existing safety event`);
      const safetyEventId = String(safetyEvent.id), safetyTask = db.prepare("SELECT id FROM mail_case_tasks WHERE case_id=? AND event_id=? ORDER BY id LIMIT 1").get(caseId, safetyEventId);
      assert.ok(safetyTask, `${operation.name} fixture must contain a pre-existing safety task`);
      const safetyTaskId = String(safetyTask.id), applied = applyManualDecision(db, operation.input(), actor);
      const audit = db.prepare("SELECT before_json FROM mail_case_manual_decisions WHERE id=?").get(applied.decisionId)!;
      const corrupted = JSON.parse(String(audit.before_json));
      corrupted.fence[0].events = corrupted.fence[0].events.filter((row: { id: string }) => row.id !== safetyEventId);
      corrupted.fence[0].tasks = corrupted.fence[0].tasks.filter((row: { id: string }) => row.id !== safetyTaskId);
      db.prepare("UPDATE mail_case_manual_decisions SET before_json=? WHERE id=?").run(JSON.stringify(corrupted), applied.decisionId);
      const beforeUndo = db.serialize(), undoRequestId = randomUUID();
      assert.throws(() => undoManualDecision(db, { decisionId: applied.decisionId, requestId: undoRequestId, expectedVersion: applied.version, reason: "不得把既有安全事实当作本次自产" }, actor), /audit_snapshot_invalid/, operation.name);
      assert.deepEqual(db.serialize(), beforeUndo, operation.name);
      assert.equal(db.prepare("SELECT count(*) n FROM mail_case_events WHERE id=?").get(safetyEventId)!.n, 1, operation.name);
      assert.equal(db.prepare("SELECT count(*) n FROM mail_case_tasks WHERE id=?").get(safetyTaskId)!.n, 1, operation.name);
      assert.equal(db.prepare("SELECT count(*) n FROM mail_case_manual_decisions WHERE undo_of=?").get(applied.decisionId)!.n, 0, operation.name);
      assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_requests WHERE request_id=?").get(undoRequestId)!.n, 0, operation.name);
    } finally { db.close(); }
  }
});
