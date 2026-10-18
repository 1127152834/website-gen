import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ASSISTANT_EXCLUDED_METHODS, assistantRpcToolByMethod } from "./assistant-tools.ts";
import { migrate, openDb } from "./db.ts";
import { createWorkspace } from "./index.ts";
import type { MailboxService } from "./mailbox-service.ts";
import { reprojectCases } from "./mail-case-projector.ts";
import { createMailTriageService, type MailTriageService } from "./mail-triage-service.ts";
import type { TriageWorker } from "./mail-triage-worker.ts";
import { workspaceRpcRisk } from "./workspace-rpc-policy.ts";
import { createProviderConfig, deleteProviderConfig, updateProviderConfig, type ProviderModelInput } from "./models.ts";
import { cacheReadIdentity, cachedParsedMessage, fingerprintSource, registerCachedSource } from "./mail-triage-source.ts";
import { seal } from "./secrets.ts";
import { FakeMailTransport, setup, key } from "./testing.ts";
import { approveNotificationRouting, recordNotificationAudit, registerNotificationAudit, saveEvaluationReport, type EvaluationReport } from "./mail-triage-evaluation.ts";

const model: ProviderModelInput = { id: "triage-model", name: "Triage", contextWindow: 32_000, maxOutputTokens: 4_096, vision: false, thinkingLevels: ["off"] };
const derived = (ids: string[]) => ({ supportSourceIds: ids, kind: "source_derived" as const, verifiedAt: null, reason: null });
const independent = (reason: string, verifiedAt: number) => ({ supportSourceIds: [], kind: "independent_manual" as const, verifiedAt, reason });
const message = (text = "Please send the requested document") => ({ messageId: `<${randomUUID()}@example.test>`, from: "Sender <sender@example.test>", fromAddresses: ["sender@example.test"], to: ["support@nordicpaws.com"], cc: [], subject: "Application update", date: 100, text, snippet: text, inReplyTo: null, references: [], attachments: [], bodyComplete: true, bodyIssue: null });
const cacheMessage = (db: ReturnType<typeof setup>["db"], mailboxId: number, uid: number, validity: string, text = "Please send the requested document") => db.prepare("INSERT OR REPLACE INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,snippet,body_complete,message_id,references_json,attachments_json) VALUES(?,'INBOX',?,?,?, ?, '[]','[]','Application update',100,?,?,1,?,'[]','[]')").run(mailboxId, uid, validity, '"Sender"', '["sender@example.test"]', text, text, `<${mailboxId}-${uid}@example.test>`);
const qualifiedReport=(tuple:EvaluationReport["tuple"]):EvaluationReport=>({tuple,datasetSource:"user_authorized_redacted_mail",humanLabelsConfirmed:true,redactedRealMail:true,total:100,strata:{actionRequired:20,finalOrConditionalDecision:20,associationConflict:20,quotedOldRequest:20,incompleteContent:20},missedActionCount:0,incorrectCriticalTransitionCount:0,incorrectCriticalAssociationCount:0,injectionRegression:{independentSet:true,total:5,failures:0},artifactHash:"a".repeat(64)});

function fixture(options: { actor?: boolean; failSecond?: boolean } = {}) {
  const { db } = setup({ cachedMailbox: { password: "fixture" } });
  db.prepare("INSERT INTO mailboxes(account_id,order_id,remote_id,address,domain,status,credential_ciphertext) SELECT account_id,'OR2','cached-2','other@nordicpaws.com',domain,'active',credential_ciphertext FROM mailboxes WHERE id=1").run();
  const providerId = createProviderConfig(db, key, { name: "Triage", protocol: "openai", baseUrl: "https://models.example.test/v1", apiKey: "fixture-key", models: [model] });
  let service!: MailTriageService, failed = false;
  const snapshots = new Map<number, number>();
  const mailboxes = {
    isAvailable: () => true,
    async withInboxSnapshot<T>(mailboxId: number, commit: (snapshot: { uidValidity: string; maxUid: number; complete: true }) => T): Promise<T> {
      snapshots.set(mailboxId, (snapshots.get(mailboxId) ?? 0) + 1);
      if (mailboxId === 2 && options.failSecond && !failed) { failed = true; throw new Error("fixture snapshot crash"); }
      if ((snapshots.get(mailboxId) ?? 0) === 1) { cacheMessage(db, mailboxId, 10, `uv-${mailboxId}`); registerCachedSource(db, { locator: { mailboxId, folder: "INBOX", uidValidity: `uv-${mailboxId}`, uid: 10 }, mail: message("baseline"), observedAt: 99 }, key, service.sourceHooks); }
      const result = commit({ uidValidity: `uv-${mailboxId}`, maxUid: 10, complete: true });
      if ((snapshots.get(mailboxId) ?? 0) % 2 === 0) { cacheMessage(db, mailboxId, 11, `uv-${mailboxId}`); registerCachedSource(db, { locator: { mailboxId, folder: "INBOX", uidValidity: `uv-${mailboxId}`, uid: 11 }, mail: message(), observedAt: 101 }, key, service.sourceHooks); }
      return result;
    },
  } as unknown as MailboxService;
  const workerState = { wakes: 0, callers: 0, aborts: [] as string[] };
  const worker: TriageWorker = { start() {}, wake() { workerState.wakes++; }, abortSources(ids) { workerState.aborts.push(...ids); }, stopAccepting() {}, async close() {} };
  service = createMailTriageService({ db, key, mailboxes, worker, clock: () => 100, push: () => {}, readOnly: false, actor: options.actor === false ? null : { userId: 7 } });
  return { db, service, providerId, snapshots, workerState };
}

const configure = (providerId: number, requestId = randomUUID(), expectedVersion = 1) => ({ requestId, expectedVersion, reason: "明确同意把所选邮箱正文发送给该服务商预审", enabled: true, mailboxIds: [1, 2], mode: "auto_suggest" as const, modelBinding: { providerId, modelId: model.id, thinking: "off" }, dailyAttemptLimit: 500, consentProviderRevision: 1 });

test("Task9 RPC risk table is explicit and unknown methods fail closed at the caller", () => {
  assert.equal(workspaceRpcRisk("mail.triage.settings"), "read");
  assert.equal(workspaceRpcRisk("mail.triage.configure"), "confirm");
  assert.equal(workspaceRpcRisk("mail.triage.enqueue"), "confirm");
  assert.equal(workspaceRpcRisk("mail.open"), undefined);
  assert.equal(workspaceRpcRisk("mail.triage.unknown"), undefined);
});

test("B31 manual writes fail closed without a verified server actor", () => {
  const { db, service } = fixture({ actor: false });
  try { assert.throws(() => service.contactsSave({ requestId: randomUUID(), expectedVersion: 0, reason: "fixture", mapping: { providerKey: "provider", siteId: null, mailboxIds: [1], senderAddresses: ["sender@example.test"], domains: [] } }), /服务端操作者/); }
  finally { db.close(); }
});

test("B35/B36 initializing resumes only unfinished watermarks and registers post-snapshot mail", async () => {
  const { db, service, providerId, snapshots } = fixture({ failSecond: true }); const input = configure(providerId);
  try {
    await assert.rejects(service.configure(input), /snapshot crash/);
    assert.equal(service.settings().state, "initializing");
    assert.equal(db.prepare("SELECT baseline_uid FROM mail_triage_scope WHERE mailbox_id=1").get()!.baseline_uid, 10);
    assert.equal(db.prepare("SELECT effective_at FROM mail_triage_scope WHERE mailbox_id=2").get()!.effective_at, null);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_jobs j JOIN mail_triage_sources s ON s.id=j.source_id WHERE s.mailbox_id=1").get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_jobs j JOIN mail_triage_source_aliases a ON a.source_id=j.source_id WHERE a.mailbox_id=1 AND a.uid=10").get()!.n, 0);
    await service.configure(input);
    assert.equal(service.settings().state, "enabled"); assert.equal(snapshots.get(1), 2); assert.equal(snapshots.get(2), 3);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_jobs j JOIN mail_triage_sources s ON s.id=j.source_id WHERE s.mailbox_id=2").get()!.n, 1);
  } finally { db.close(); }
});

test("B36 restart recovery with a new request id keeps completed baselines", async () => {
  const { db, service, providerId, snapshots } = fixture({ failSecond: true });
  try {
    await assert.rejects(service.configure(configure(providerId)), /snapshot crash/);
    const interrupted = service.settings(), epoch = interrupted.configEpoch;
    await service.configure(configure(providerId, randomUUID(), interrupted.version));
    assert.equal(service.settings().configEpoch, epoch);
    assert.equal(snapshots.get(1), 2);
  } finally { db.close(); }
});

test("B61 newly created mailboxes are not silently added to an existing authorization", async () => {
  const { db, service, providerId } = fixture();
  try {
    await service.configure(configure(providerId));
    db.prepare("INSERT INTO mailboxes(account_id,order_id,remote_id,address,domain,status,credential_ciphertext) SELECT account_id,'OR3','cached-3','new@nordicpaws.com',domain,'active',credential_ciphertext FROM mailboxes WHERE id=1").run();
    const mailboxId = Number(db.prepare("SELECT max(id) id FROM mailboxes").get()!.id);
    cacheMessage(db, mailboxId, 12, "uv-new"); const source = registerCachedSource(db, { locator: { mailboxId, folder: "INBOX", uidValidity: "uv-new", uid: 12 }, mail: message(), observedAt: 102 }, key, service.sourceHooks);
    assert.equal(service.settings().mailboxIds.includes(mailboxId), false);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_jobs WHERE source_id=?").get(source.sourceId)!.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_sources WHERE source_id=?").get(source.sourceId)!.n, 0);
  } finally { db.close(); }
});

test("B37 pending review is transactional even with no model job", () => {
  const { db, service } = fixture();
  try {
    db.exec("UPDATE mail_triage_settings SET state='initializing',enabled=0,config_epoch=2; INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(1,2,'authorized','uv-1',0,1)");
    cacheMessage(db, 1, 1, "uv-1"); const source = registerCachedSource(db, { locator: { mailboxId: 1, folder: "INBOX", uidValidity: "uv-1", uid: 1 }, mail: message(), observedAt: 2 }, key, service.sourceHooks);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_jobs WHERE source_id=?").get(source.sourceId)!.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_tasks t JOIN mail_case_sources cs ON cs.case_id=t.case_id WHERE cs.source_id=? AND t.obligation_key='review_new_mail'").get(source.sourceId)!.n, 1);
  } finally { db.close(); }
});

test("B40 provider baseUrl revision atomically blocks bound triage and invalidates old consent", async () => {
  const { db, service, providerId } = fixture();
  try {
    await service.configure(configure(providerId));
    const aborted = updateProviderConfig(db, key, providerId, { name: "Triage", protocol: "openai", baseUrl: "https://changed.example.test/v1", apiKey: "", models: [model] });
    const settings = service.settings(); assert.equal(settings.enabled, false); assert.equal(settings.state, "blocked_config"); assert.equal(settings.consentProviderRevision, null);
    assert.equal(db.prepare("SELECT config_revision FROM model_providers WHERE id=?").get(providerId)!.config_revision, 2); assert.ok(aborted.length >= 2);
  } finally { db.close(); }
});

test("B42 preview is read-only; enqueue is idempotent and conflicts on content", async () => {
  const { db, service, providerId } = fixture();
  try {
    await service.configure(configure(providerId)); const before = Number(db.prepare("SELECT count(*) n FROM mail_triage_requests").get()!.n);
    const preview = service.backfillPreview({ mailboxIds: [1], days: 7 }); assert.equal(Number(db.prepare("SELECT count(*) n FROM mail_triage_requests").get()!.n), before); assert.ok(preview.count >= 1);
    const requestId = randomUUID(), first = service.enqueue({ requestId, previewId: preview.previewId }); const rows = Number(db.prepare("SELECT count(*) n FROM mail_triage_jobs").get()!.n);
    assert.deepEqual(service.enqueue({ requestId, previewId: preview.previewId }), first); assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_jobs").get()!.n, rows);
    assert.throws(() => service.enqueue({ requestId, sourceIds: [randomUUID()] }), /不同内容/);
    const stalePreview = service.backfillPreview({ mailboxIds: [1], days: 7 }); db.prepare("UPDATE mail_triage_scope SET scope_version=scope_version+1 WHERE mailbox_id=1").run();
    assert.throws(() => service.enqueue({ requestId: randomUUID(), previewId: stalePreview.previewId }), /范围已变化/);
  } finally { db.close(); }
});

test("Fix1 historical preview admits complete verified local cache without pre-existing source and materializes only on confirm", async () => {
  const { db, service, providerId } = fixture();
  try {
    await service.configure(configure(providerId));
    cacheMessage(db, 1, 5, "uv-1", "old cache only");
    assert.equal(db.prepare("SELECT 1 FROM mail_triage_source_aliases WHERE mailbox_id=1 AND uid=5").get(), undefined);
    const before = db.serialize(), preview = service.backfillPreview({ mailboxIds: [1], days: 7 });
    assert.deepEqual(db.serialize(), before); assert.ok(preview.count >= 1);
    const batch = service.enqueue({ requestId: randomUUID(), previewId: preview.previewId });
    const source = db.prepare("SELECT source_id FROM mail_triage_source_aliases WHERE mailbox_id=1 AND folder='INBOX' AND uid_validity='uv-1' AND uid=5 AND active=1").get()!;
    assert.ok(batch.sourceIds.includes(String(source.source_id)));
    assert.equal(db.prepare("SELECT priority FROM mail_triage_jobs WHERE source_id=?").get(source.source_id)!.priority, 1);
    const jobs = db.prepare("SELECT count(*) n FROM mail_triage_jobs WHERE source_id=?").get(source.source_id)!.n;
    assert.deepEqual(service.enqueue({ requestId: batch.requestId, previewId: preview.previewId }), batch);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_jobs WHERE source_id=?").get(source.source_id)!.n, jobs);
  } finally { db.close(); }
});

test("Fix1 historical preview conflicts if cached content changes before confirmation", async () => {
  const { db, service, providerId } = fixture();
  try {
    await service.configure(configure(providerId)); cacheMessage(db, 1, 6, "uv-1", "first body");
    const preview = service.backfillPreview({ mailboxIds: [1], days: 7 });
    db.prepare("UPDATE mail_messages SET body_text='changed body',snippet='changed body' WHERE mailbox_id=1 AND folder='INBOX' AND uid_validity='uv-1' AND uid=6").run();
    assert.throws(() => service.enqueue({ requestId: randomUUID(), previewId: preview.previewId }), /内容已变化|重新预览/);
    assert.equal(db.prepare("SELECT 1 FROM mail_triage_source_aliases WHERE mailbox_id=1 AND uid=6").get(), undefined);
  } finally { db.close(); }
});

test("B47 grouped contacts materialize exact senders; domains remain non-authenticating metadata", () => {
  const { db, service } = fixture();
  try {
    const saveRequest = { requestId: randomUUID(), expectedVersion: 0, reason: "人工辅助映射", mapping: { providerKey: "Provider", siteId: null, mailboxIds: [1, 2], senderAddresses: ["Sender@Example.test"], domains: ["example.test"] } };
    const saved = service.contactsSave(saveRequest); assert.deepEqual(service.contactsSave(saveRequest), saved);
    assert.equal(saved.senderAddresses[0], "sender@example.test"); assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_contacts WHERE group_id=?").get(saved.id)!.n, 2); assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_contacts WHERE address='example.test'").get()!.n, 0);
    for (const row of db.prepare("SELECT id FROM mail_triage_contacts WHERE group_id=?").all(saved.id)) { assert.match(String(row.id), /^[0-9a-f-]{36}$/i); assert.equal(String(row.id).startsWith(`${saved.id}:`), false); }
    assert.throws(() => service.contactsSave({ requestId: randomUUID(), expectedVersion: 0, reason: "bad", mapping: { id: saved.id, providerKey: "Provider", siteId: null, mailboxIds: [1], senderAddresses: ["sender@example.test"], domains: [] } }), /版本冲突/);
    assert.equal(service.contactsRemove({ requestId: randomUUID(), expectedVersion: saved.version, reason: "remove", id: saved.id }).version, 2); assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_contacts WHERE group_id=?").get(saved.id)!.n, 0);
  } finally { db.close(); }
});

test("Fix1 configure persists strict reminder settings and omission preserves them", async () => {
  const { db, service, providerId, workerState } = fixture();
  try {
    const configured = await service.configure({ ...configure(providerId), reminderEnabled: true, reminderSettings: { followUpDays: 9, leadDays: 2 } });
    assert.equal(configured.reminderEnabled, true); assert.deepEqual(configured.reminderSettings, { followUpDays: 9, leadDays: 2 });
    const task = db.prepare("SELECT id,case_id FROM mail_case_tasks ORDER BY id LIMIT 1").get()!;
    db.prepare("UPDATE mail_case_tasks SET state='awaiting_external',deadline_at=? WHERE id=?").run(100 + 12 * 60 * 60 * 1000, task.id);
    db.prepare("UPDATE mail_application_cases SET updated_at=? WHERE id=?").run(100 - 10 * 24 * 60 * 60 * 1000, task.case_id);
    const wakes = workerState.wakes;
    const rows = service.reviewQueue({ filter: "notifications" });
    assert.deepEqual(new Set(rows.items.map(row => row.state)), new Set(["upcoming", "waiting_too_long"]));
    assert.match(rows.items.find(row => row.state === "waiting_too_long")!.reason!, /人工建议.*9天/);
    assert.equal(workerState.wakes, wakes);
    const next = await service.configure({ ...configure(providerId, randomUUID(), configured.version) });
    assert.deepEqual(next.reminderSettings, { followUpDays: 9, leadDays: 2 }); assert.equal(next.reminderEnabled, true);
  } finally { db.close(); }
});

test("Fix2 reminder-only configure preserves active authority, watermarks, jobs, and attempts", async () => {
  const { db, service, providerId, snapshots, workerState } = fixture();
  try {
    const configured = await service.configure(configure(providerId));
    await new Promise<void>(resolve => setImmediate(resolve));
    snapshots.clear(); workerState.wakes = 0; workerState.callers = 0; workerState.aborts.length = 0;
    cacheMessage(db, 1, 12, "uv-1", "new mail not processed yet");
    const authorityBefore = db.prepare("SELECT enabled,state,config_epoch,model_config_revision,mode,daily_attempt_limit,consent_provider_revision FROM mail_triage_settings WHERE id=1").get();
    const roleBefore = db.prepare("SELECT * FROM model_roles WHERE role='mail_triage'").get();
    const scopesBefore = db.prepare("SELECT * FROM mail_triage_scope ORDER BY mailbox_id").all();
    const jobsBefore = db.prepare("SELECT * FROM mail_triage_jobs ORDER BY id").all();
    const attemptsBefore = db.prepare("SELECT * FROM mail_triage_attempts ORDER BY id").all();
    const requestId = randomUUID();
    const updated = await service.configure({ ...configure(providerId, requestId, configured.version), reminderEnabled: true, reminderSettings: { followUpDays: 8, leadDays: 3 } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(updated.version, configured.version + 1);
    assert.equal(updated.reminderEnabled, true); assert.deepEqual(updated.reminderSettings, { followUpDays: 8, leadDays: 3 });
    assert.deepEqual(db.prepare("SELECT enabled,state,config_epoch,model_config_revision,mode,daily_attempt_limit,consent_provider_revision FROM mail_triage_settings WHERE id=1").get(), authorityBefore);
    assert.deepEqual(db.prepare("SELECT * FROM model_roles WHERE role='mail_triage'").get(), roleBefore);
    assert.deepEqual(db.prepare("SELECT * FROM mail_triage_scope ORDER BY mailbox_id").all(), scopesBefore);
    assert.deepEqual(db.prepare("SELECT * FROM mail_triage_jobs ORDER BY id").all(), jobsBefore);
    assert.deepEqual(db.prepare("SELECT * FROM mail_triage_attempts ORDER BY id").all(), attemptsBefore);
    assert.equal(snapshots.size, 0); assert.equal(workerState.callers, 0); assert.equal(workerState.wakes, 0); assert.deepEqual(workerState.aborts, []);

    const repeated = await service.configure({ ...configure(providerId, requestId, configured.version), reminderEnabled: true, reminderSettings: { followUpDays: 8, leadDays: 3 } });
    assert.deepEqual(repeated, updated); assert.equal(snapshots.size, 0); assert.equal(workerState.wakes, 0);
    await assert.rejects(service.configure({ ...configure(providerId, randomUUID(), configured.version), reminderEnabled: false }), /设置版本冲突/);

    const source = registerCachedSource(db, { locator: { mailboxId: 1, folder: "INBOX", uidValidity: "uv-1", uid: 12 }, mail: message("new mail not processed yet"), observedAt: 102 }, key, service.sourceHooks);
    assert.equal(db.prepare("SELECT state FROM mail_triage_jobs WHERE source_id=?").get(source.sourceId)!.state, "queued");
    assert.equal(db.prepare("SELECT baseline_uid FROM mail_triage_scope WHERE mailbox_id=1").get()!.baseline_uid, 10);
  } finally { db.close(); }
});

test("Fix1 disabled configure accepts null model consent after provider deletion while enable still requires binding", async () => {
  const { db, service, providerId } = fixture();
  try {
    await service.configure(configure(providerId)); deleteProviderConfig(db, providerId);
    const blocked = service.settings();
    const disabled = await service.configure({ requestId: randomUUID(), expectedVersion: blocked.version, reason: "关闭本地预审", enabled: false, mailboxIds: [], mode: "auto_suggest", modelBinding: null, dailyAttemptLimit: 500, consentProviderRevision: null });
    assert.equal(disabled.state, "disabled"); assert.equal(disabled.enabled, false);
    await assert.rejects(service.configure({ requestId: randomUUID(), expectedVersion: disabled.version, reason: "不能隐式启用", enabled: true, mailboxIds: [1], mode: "auto_suggest", modelBinding: null, dailyAttemptLimit: 500, consentProviderRevision: null }), /模型|binding|服务商/);
  } finally { db.close(); }
});

test("Fix1 authoritative JSON fails closed and safe DTOs strip internal projection/assessment metadata", async () => {
  const { db, service, providerId } = fixture();
  try {
    await service.configure(configure(providerId));
    const caseId = String(db.prepare("SELECT id FROM mail_application_cases ORDER BY id LIMIT 1").get()!.id);
    const detail = service.caseDetail({ caseId })!;
    for (const key of ["priority", "reminders", "safetyReviews", "decisionLabel"]) assert.equal(Object.hasOwn(detail.projection as object, key), false);
    db.prepare("UPDATE mail_application_cases SET projection_json='{}' WHERE id=?").run(caseId);
    assert.throws(() => service.caseDetail({ caseId }), /完整性|integrity|投影/);
    const group = service.contactsSave({ requestId: randomUUID(), expectedVersion: 0, reason: "fixture", mapping: { providerKey: "Provider", siteId: null, mailboxIds: [1], senderAddresses: ["sender@example.test"], domains: [] } });
    db.prepare("UPDATE mail_triage_contact_groups SET sender_addresses_json='[\"not-an-email\"]' WHERE id=?").run(group.id);
    assert.throws(() => service.contactsList({}), /完整性|integrity|联系人/);
    db.prepare("UPDATE mail_triage_settings SET reminder_settings_json='{}'").run(); assert.doesNotThrow(() => service.settings());
  } finally { db.close(); }
});

test("Fix1 result validates persisted assessment, strips internal metadata, and never exposes revoked context quotes", async () => {
  const { db, service, providerId } = fixture();
  try {
    await service.configure(configure(providerId));
    const job = db.prepare("SELECT * FROM mail_triage_jobs ORDER BY created_at DESC,id LIMIT 1").get()!, sourceId = String(job.source_id);
    const assessment = (evidenceSourceId: string, extra = false) => ({
      schemaVersion: 1, primaryCategory: "general_other", tag: "普通通知", summary: "本地测试摘要",
      caseSuggestion: { providerCandidate: null, applicationId: null, candidateCaseId: null, matchBasis: [], needsReview: true },
      events: [{ kind: "notification", evidence: [{ sourceId: evidenceSourceId, quote: "requested document" }] }], actions: [], completionSuggestions: [], uncertainties: [], requiresHumanReview: true,
      grade: "needs_review", usage: null, evidenceLocations: [], applicationRestrictions: ["suggest_only"], ...(extra ? { internalSecret: "must-not-leak" } : {}),
    });
    const insert = db.prepare("INSERT INTO mail_triage_assessments(id,job_id,source_id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,prompt_hash,validated_json,support_source_ids_json,grade,created_at) VALUES(?,?,?,?,?,?,?,?,1,'hash',?,?,?,?)");
    insert.run(randomUUID(), job.id, sourceId, job.provider_id, job.model_id, job.model_config_revision, job.prompt_version, job.rule_version, JSON.stringify(assessment(sourceId)), JSON.stringify([sourceId]), "needs_review", 1);
    const visible = service.result({ sourceId })!; assert.ok(visible.assessment);
    for (const key of ["usage", "evidenceLocations", "applicationRestrictions", "grade"]) assert.equal(Object.hasOwn(visible.assessment as object, key), false);
    db.prepare("UPDATE mail_triage_assessments SET validated_json=? WHERE source_id=?").run(JSON.stringify(assessment(sourceId, true)), sourceId);
    assert.throws(() => service.result({ sourceId }), /完整性|评估/);
    db.prepare("DELETE FROM mail_triage_assessments WHERE source_id=?").run(sourceId);
    cacheMessage(db, 1, 12, "uv-1", "context quote"); const context = registerCachedSource(db, { locator: { mailboxId: 1, folder: "INBOX", uidValidity: "uv-1", uid: 12 }, mail: message("context quote"), observedAt: 102 }, key, service.sourceHooks);
    insert.run(randomUUID(), job.id, sourceId, job.provider_id, job.model_id, job.model_config_revision, job.prompt_version, job.rule_version, JSON.stringify(assessment(context.sourceId)), JSON.stringify([sourceId, context.sourceId]), "needs_review", 2);
    db.prepare("UPDATE mail_triage_source_aliases SET active=0 WHERE source_id=?").run(context.sourceId); db.prepare("UPDATE mail_triage_sources SET state='missing' WHERE id=?").run(context.sourceId);
    const hidden = service.result({ sourceId })!; assert.equal(hidden.assessment, null); assert.equal(hidden.grade, "needs_review"); assert.equal(JSON.stringify(hidden).includes("context quote"), false);
  } finally { db.close(); }
});

test("B57/B59 read paths do not mutate the database and budget excludes zero-dispatch attempts", () => {
  const { db, service } = fixture();
  try {
    db.prepare("INSERT INTO mail_triage_attempts(id,job_id,attempt_seq,budget_day,reserved_at,deadline_at,outcome) VALUES(?,NULL,1,'1970-01-01',0,0,?)").run(randomUUID(), "not_dispatched");
    db.prepare("INSERT INTO mail_triage_attempts(id,job_id,attempt_seq,budget_day,reserved_at,deadline_at,outcome) VALUES(?,NULL,1,'1970-01-01',0,0,?)").run(randomUUID(), "failed");
    const before = db.serialize(); service.settings(); const status = service.status(); service.casesList({}); service.reviewQueue({ filter: "unreviewed" }); service.contactsList({});
    assert.equal(status.dailyAttemptsUsed, 1); assert.equal(status.dailyAttemptLimit, 500); assert.deepEqual(db.serialize(), before);
  }
  finally { db.close(); }
});

test("R26 ordinary annotations bind to the rendered cache generation and stay bounded/read-only", async () => {
  const { db, service, providerId } = fixture();
  try {
    const read=(service as MailTriageService & {messageAnnotations(input:unknown):unknown}).messageAnnotations;
    assert.throws(()=>read.call(service,{mailboxId:1,folder:"INBOX",messages:Array.from({length:101},(_,index)=>({uid:index+1,readIdentity:"a".repeat(64)}))}),/100|上限|too/i);
    assert.deepEqual(read.call(service,{mailboxId:1,folder:"INBOX",messages:[]}),{items:[]});
    await service.configure(configure(providerId));
    const job=db.prepare("SELECT * FROM mail_triage_jobs WHERE source_id IN (SELECT source_id FROM mail_triage_source_aliases WHERE mailbox_id=1 AND folder='INBOX' AND uid=11) ORDER BY created_at DESC,id DESC LIMIT 1").get()!;
    const source=db.prepare("SELECT * FROM mail_triage_sources WHERE id=?").get(job.source_id)!;
    const valid={schemaVersion:1,primaryCategory:"general_other",tag:"普通通知",summary:"本地注释摘要",caseSuggestion:{providerCandidate:null,applicationId:null,candidateCaseId:null,matchBasis:[],needsReview:false},events:[{kind:"notification",evidence:[{sourceId:String(source.id),quote:"requested document"}]}],actions:[],completionSuggestions:[],uncertainties:[],requiresHumanReview:false,grade:"evidence_complete",usage:null,evidenceLocations:[],applicationRestrictions:["notification_qualification_required"]};
    db.prepare("INSERT INTO mail_triage_assessments(id,job_id,source_id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,prompt_hash,validated_json,support_source_ids_json,grade,created_at) VALUES(?,?,?,?,?,?,?,?,1,'hash',?,?,?,?)").run(randomUUID(),job.id,source.id,job.provider_id,job.model_id,job.model_config_revision,job.prompt_version,job.rule_version,JSON.stringify(valid),JSON.stringify([source.id]),"evidence_complete",100);
    const locator={mailboxId:1,folder:"INBOX",uidValidity:"uv-1",uid:11};
    const identity=cacheReadIdentity(key,locator,{sourceHash:String(source.source_hash),criticalHeadersHash:String(source.critical_headers_hash)});
    const before=db.serialize(),visible=read.call(service,{mailboxId:1,folder:"INBOX",messages:[{uid:11,readIdentity:identity}]}) as {items:Array<Record<string,unknown>>};
    assert.deepEqual(visible.items.map(item=>({uid:item.uid,tag:item.tag,summary:item.summary,readIdentity:item.readIdentity})),[{uid:11,tag:"普通通知",summary:"本地注释摘要",readIdentity:identity}]);
    assert.deepEqual(db.serialize(),before);
    const tuple={providerId:Number(job.provider_id),modelId:String(job.model_id),modelConfigRevision:Number(job.model_config_revision),promptVersion:Number(job.prompt_version),ruleVersion:Number(job.rule_version),schemaVersion:1};
    const saved=saveEvaluationReport(db,{report:qualifiedReport(tuple),expectedVersion:0,requestId:randomUUID(),reason:"保存真实结构夹具评估"},{userId:7},101);
    approveNotificationRouting(db,{tuple,reportHash:saved.reportHash,expectedVersion:saved.approvalRevision,requestId:randomUUID(),reason:"批准真实结构夹具通知"},{userId:7},102);
    assert.equal(service.reviewQueue({filter:"notification_mail",mailboxId:1,query:"本地注释",page:1,pageSize:30}).total,0,"缺少审计位置必须失败关闭");
    const registration=registerNotificationAudit(db,{assessmentId:String(db.prepare("SELECT id FROM mail_triage_assessments WHERE job_id=?").get(job.id)!.id),tuple},103);
    db.prepare("INSERT INTO mail_triage_audits(id,assessment_id,sequence,sampled) VALUES(?,?,?,?)").run(randomUUID(),db.prepare("SELECT id FROM mail_triage_assessments WHERE job_id=?").get(job.id)!.id,registration.sequence,registration.sampled?1:0);
    assert.equal(service.reviewQueue({filter:"notification_mail",mailboxId:1,query:"本地注释",page:1,pageSize:30}).total,0,"待抽查 sampled 通知不能进入安全列表");
    assert.equal(service.reviewQueue({filter:"audit",page:1,pageSize:30}).total,1);
    const assessmentId=String(db.prepare("SELECT id FROM mail_triage_assessments WHERE job_id=?").get(job.id)!.id);
    recordNotificationAudit(db,{assessmentId,verdict:"correct",expectedVersion:1,requestId:randomUUID(),reason:"人工确认通知无待办"},{userId:7},104);
    const qualified=service.reviewQueue({filter:"notification_mail",mailboxId:1,query:"本地注释",page:1,pageSize:30});
    assert.equal(qualified.total,1);assert.equal(qualified.items[0]!.sourceId,source.id);
    recordNotificationAudit(db,{assessmentId,verdict:"missed_action",expectedVersion:2,requestId:randomUUID(),reason:"复核发现遗漏待办"},{userId:7},105);
    db.prepare("UPDATE mail_triage_jobs SET state='needs_review' WHERE id=?").run(job.id);
    assert.equal(service.reviewQueue({filter:"notification_mail",page:1,pageSize:30}).total,0);
    assert.equal(service.reviewQueue({filter:"audit",page:1,pageSize:30}).total,1);
    assert.equal(service.reviewQueue({filter:"review",page:1,pageSize:30}).total>0,true);
    db.prepare("UPDATE mail_messages SET body_text='changed rendered body',snippet='changed rendered body' WHERE mailbox_id=1 AND folder='INBOX' AND uid_validity='uv-1' AND uid=11").run();
    const changedRow=db.prepare("SELECT * FROM mail_messages WHERE mailbox_id=1 AND folder='INBOX' AND uid_validity='uv-1' AND uid=11").get()!;
    const changedIdentity=cacheReadIdentity(key,locator,fingerprintSource(key,cachedParsedMessage(changedRow)));
    assert.notEqual(changedIdentity,identity);
    assert.deepEqual(read.call(service,{mailboxId:1,folder:"INBOX",messages:[{uid:11,readIdentity:changedIdentity}]}),{items:[]});
  } finally { db.close(); }
});

test("R27 sampled notifications wait for a passed audit while unsampled 101-109 may route",async()=>{
  const {db,service,providerId}=fixture();
  try{
    await service.configure(configure(providerId));
    const template=db.prepare("SELECT * FROM mail_triage_jobs ORDER BY created_at DESC,id DESC LIMIT 1").get()!,tuple={providerId:Number(template.provider_id),modelId:String(template.model_id),modelConfigRevision:Number(template.model_config_revision),promptVersion:Number(template.prompt_version),ruleVersion:Number(template.rule_version),schemaVersion:Number(template.schema_version)};
    const saved=saveEvaluationReport(db,{report:qualifiedReport(tuple),expectedVersion:0,requestId:randomUUID(),reason:"保存110封通知夹具评估"},{userId:7},200);
    approveNotificationRouting(db,{tuple,reportHash:saved.reportHash,expectedVersion:saved.approvalRevision,requestId:randomUUID(),reason:"批准110封通知夹具"},{userId:7},201);
    const assessmentIds:string[]=[];
    for(let index=1;index<=110;index++){
      const uid=1000+index,text=`notification ${index}`;cacheMessage(db,1,uid,"uv-1",text);const source=registerCachedSource(db,{locator:{mailboxId:1,folder:"INBOX",uidValidity:"uv-1",uid},mail:{...message(text),messageId:`<1-${uid}@example.test>`,subject:"Application update"},observedAt:200+index},key);
      const jobId=randomUUID(),assessmentId=randomUUID(),safe={schemaVersion:1,primaryCategory:"general_other",tag:"普通通知",summary:`安全通知 ${index}`,caseSuggestion:{providerCandidate:null,applicationId:null,candidateCaseId:null,matchBasis:[],needsReview:false},events:[{kind:"notification",evidence:[{sourceId:source.sourceId,quote:text}]}],actions:[],completionSuggestions:[],uncertainties:[],requiresHumanReview:false,grade:"evidence_complete",usage:null,evidenceLocations:[],applicationRestrictions:["notification_qualification_required"]};
      db.prepare("INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,config_epoch,state,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?,?,?,?,'succeeded',?,?)").run(jobId,source.sourceId,tuple.providerId,tuple.modelId,tuple.modelConfigRevision,tuple.promptVersion,tuple.ruleVersion,tuple.schemaVersion,`r27-${index}`,service.settings().configEpoch,200+index,200+index);
      db.prepare("INSERT INTO mail_triage_assessments(id,job_id,source_id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,prompt_hash,validated_json,support_source_ids_json,grade,created_at) VALUES(?,?,?,?,?,?,?,?,?,'hash',?,?,?,?)").run(assessmentId,jobId,source.sourceId,tuple.providerId,tuple.modelId,tuple.modelConfigRevision,tuple.promptVersion,tuple.ruleVersion,tuple.schemaVersion,JSON.stringify(safe),JSON.stringify([source.sourceId]),"evidence_complete",200+index);
      const registration=registerNotificationAudit(db,{assessmentId,tuple},200+index);db.prepare("INSERT INTO mail_triage_audits(id,assessment_id,sequence,sampled) VALUES(?,?,?,?)").run(randomUUID(),assessmentId,registration.sequence,registration.sampled?1:0);assessmentIds.push(assessmentId);
    }
    const pendingSafe=service.reviewQueue({filter:"notification_mail",page:1,pageSize:100}),pendingAudit=service.reviewQueue({filter:"audit",page:1,pageSize:100});
    assert.equal(pendingSafe.total,9,"原始未抽样位置101-109可在其他门槛通过时进入安全列表");
    assert.equal(pendingAudit.total,101,"位置1-100及110必须保持待抽查");
    assert.deepEqual(pendingSafe.items.map(item=>item.summary).sort(),Array.from({length:9},(_,i)=>`安全通知 ${101+i}`).sort());
    recordNotificationAudit(db,{assessmentId:assessmentIds[0]!,verdict:"correct",expectedVersion:1,requestId:randomUUID(),reason:"人工确认第一封通知"},{userId:7},400);
    assert.equal(service.reviewQueue({filter:"notification_mail",page:1,pageSize:100}).total,10);
    assert.equal(service.reviewQueue({filter:"audit",page:1,pageSize:100}).total,100);
  }finally{db.close();}
});

test("Task10 seven public RPC handlers enforce schema, confirm risk, exclusion, replay, request conflict, and stale CAS", async () => {
  const root = await mkdtemp(join(tmpdir(), "mail-triage-task10-rpc-")), workspaceKey = randomBytes(32), db = openDb(join(root, "website-gen.sqlite"));
  migrate(db);
  db.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,status,created_at) VALUES(1,'fixture',?,'hint','ok',0)").run(seal(workspaceKey, "token"));
  db.prepare("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,status,monitoring,credential_ciphertext) VALUES(1,1,'order','remote','support@fixture.test','fixture.test','active',0,?)")
    .run(seal(workspaceKey, JSON.stringify({ address: "support@fixture.test", password: "fixture" })));
  db.exec("UPDATE mail_triage_settings SET enabled=1,state='enabled',config_epoch=1; INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(1,1,'authorized','100',0,0)");
  const rows = Array.from({ length: 7 }, (_, index) => ({ sourceId: randomUUID(), caseId: randomUUID(), eventId: randomUUID(), taskId: randomUUID(), uid: index + 1 }));
  for (const [index, row] of rows.entries()) {
    db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,trust,observed_at) VALUES(?,1,?,?,'contact_mapped',?)").run(row.sourceId, `hash-${index}`, `headers-${index}`, 100 + index);
    db.prepare("INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id) VALUES(1,'INBOX','100',?,?)").run(row.uid, row.sourceId);
    db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,version,manual_version) VALUES(?,'confirmed','Fixture',?,?, '{}',1,0)")
      .run(row.caseId, `APP-${index + 1}`, JSON.stringify(independent(`rpc-${index}`, 10 + index)));
    db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'fixture')").run(row.caseId, row.sourceId);
    db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:request','request_action',1,100,'[]',?)").run(row.eventId, row.caseId, row.sourceId, JSON.stringify(derived([row.sourceId])));
    db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,requested_items_json,provenance_json) VALUES(?,?,?,'item','action','item','提交材料','[\"材料\"]',?)").run(row.taskId, row.caseId, row.eventId, JSON.stringify(derived([row.sourceId])));
  }
  db.exec("BEGIN IMMEDIATE"); try { reprojectCases(db, { caseIds: rows.map(row => row.caseId), now: 100 }); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
  db.close();
  const transport = new FakeMailTransport(); transport.passwords.set("support@fixture.test", "fixture");
  const workspace = createWorkspace({ userDir: root, key: workspaceKey, ownerUserId: 7, dependencies: { mailTransport: () => transport, clock: () => 500 } });
  try {
    const setupDecision = await workspace.handlers["mail.triage.correct"]({ target: { type: "source", id: rows[6].sourceId, sourceVersion: 1 }, field: "tag", value: "撤销准备", requestId: randomUUID(), expectedVersion: 0, reason: "准备撤销测试" }) as { decisionId: string; version: number };
    const entries = [
      { method: "mail.triage.correct", input: { target: { type: "source", id: rows[0].sourceId, sourceVersion: 1 }, field: "tag", value: "人工标签", requestId: randomUUID(), expectedVersion: 0, reason: "人工纠正" } },
      { method: "mail.cases.link", input: { caseId: rows[1].caseId, sourceIds: [rows[1].sourceId], requestId: randomUUID(), expectedVersion: 0, reason: "人工关联" } },
      { method: "mail.cases.split", input: { caseId: rows[2].caseId, eventIds: [rows[2].eventId], newIdentity: { provider: "Fixture", siteId: null, applicationId: "APP-SPLIT" }, requestId: randomUUID(), expectedVersion: 0, reason: "人工拆分" } },
      { method: "mail.cases.confirm", input: { caseId: rows[3].caseId, identity: { provider: "Fixture", siteId: null, applicationId: "APP-CONFIRMED" }, requestId: randomUUID(), expectedVersion: 0, reason: "人工确认" } },
      { method: "mail.cases.independentFact", input: { caseId: rows[4].caseId, fact: { type: "stage", value: "reviewing" }, verifiedAt: 400, requestId: randomUUID(), expectedVersion: 0, reason: "平台独立核验" } },
      { method: "mail.cases.appeal", input: { caseId: rows[5].caseId, requestId: randomUUID(), expectedVersion: 0, reason: "确认已经提交复审" } },
      { method: "mail.triage.undo", input: { decisionId: setupDecision.decisionId, requestId: randomUUID(), expectedVersion: setupDecision.version, reason: "撤销人工决定" }, staleFirst: true },
    ];
    for (const entry of entries) {
      assert.equal(workspaceRpcRisk(entry.method), "confirm", entry.method);
      assert.equal(assistantRpcToolByMethod(entry.method), undefined, entry.method);
      assert.ok(ASSISTANT_EXCLUDED_METHODS[entry.method], entry.method);
      await assert.rejects(async () => await Promise.resolve(workspace.handlers[entry.method]({ ...entry.input, extra: true })), /unrecognized|参数|invalid/i, `${entry.method}: strict schema`);
      if (entry.staleFirst) await assert.rejects(async () => await Promise.resolve(workspace.handlers[entry.method]({ ...entry.input, requestId: randomUUID(), expectedVersion: 0 })), /version_conflict/, `${entry.method}: stale CAS`);
      const first = await workspace.handlers[entry.method](entry.input), replay = await workspace.handlers[entry.method](entry.input);
      assert.deepEqual(replay, first, `${entry.method}: replay`);
      await assert.rejects(async () => await Promise.resolve(workspace.handlers[entry.method]({ ...entry.input, reason: `${entry.input.reason}-changed` })), /request_id_conflict/, `${entry.method}: request conflict`);
      if (!entry.staleFirst) await assert.rejects(async () => await Promise.resolve(workspace.handlers[entry.method]({ ...entry.input, requestId: randomUUID() })), /version_conflict/, `${entry.method}: stale CAS`);
    }
  } finally {
    await workspace.close();
    await rm(root, { recursive: true, force: true });
  }
});
