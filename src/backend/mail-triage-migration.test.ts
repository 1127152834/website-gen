import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate, openDb } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";
import { listRoles } from "./models.ts";
import { seal } from "./secrets.ts";
import { TRIAGE_STATES, type TriageState } from "../shared/mail-triage-types.ts";

test("triage settings persist disabled to initializing to enabled across database reopens", () => {
  const directory = mkdtempSync(join(tmpdir(), "website-gen-triage-init-"));
  const path = join(directory, "workspace.sqlite");
  let db = openDb(path);
  try {
    migrate(db);
    assert.deepEqual({ ...db.prepare("SELECT enabled,state,version FROM mail_triage_settings WHERE id=1").get() }, { enabled: 0, state: "disabled", version: 1 });
    const intermediate: TriageState = "initializing";
    db.exec("BEGIN");
    const started = db.prepare("UPDATE mail_triage_settings SET state=?,version=version+1 WHERE id=1 AND state='disabled' AND version=1").run(intermediate);
    assert.equal(started.changes, 1);
    db.exec("COMMIT");
    db.close();
    db = openDb(path);
    migrate(db);
    assert.ok(TRIAGE_STATES.includes(intermediate));
    assert.deepEqual({ ...db.prepare("SELECT enabled,state,version FROM mail_triage_settings WHERE id=1").get() }, { enabled: 0, state: "initializing", version: 2 });
    const completed = db.prepare("UPDATE mail_triage_settings SET state='enabled',enabled=1,version=version+1 WHERE id=1 AND state='initializing' AND version=2").run();
    assert.equal(completed.changes, 1);
    db.close();
    db = openDb(path);
    assert.deepEqual({ ...db.prepare("SELECT enabled,state,version FROM mail_triage_settings WHERE id=1").get() }, { enabled: 1, state: "enabled", version: 3 });
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("R18 migration021 preserves legacy receipts and adds fail-closed binding/review columns", () => {
  const db = openDb(":memory:");
  try {
    for (const sql of MIGRATIONS.slice(0, 20)) db.exec(sql);
    db.exec("PRAGMA user_version=20");
    db.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,created_at) VALUES(1,'fixture',?,'x',1)").run(Buffer.from("sealed"));
    db.exec("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain) VALUES(1,1,'o','r','a@example.test','example.test')");
    db.prepare("INSERT INTO mail_triage_send_receipts(id,request_id,mailbox_id,smtp_status,selected_task_ids_json,created_at) VALUES(?,?,1,'failed','[]',1)").run(randomUUID(), randomUUID());
    migrate(db);
    const row = db.prepare("SELECT binding_json,review_state,review_code FROM mail_triage_send_receipts").get()!;
    assert.deepEqual({ ...row }, { binding_json: null, review_state: "none", review_code: null });
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, MIGRATIONS.length);
  } finally { db.close(); }
});

test("R19 migration022 preserves legacy qualification history and adds immutable reports plus source-independent audit positions", () => {
  const db=openDb(":memory:");try{
    for(const sql of MIGRATIONS.slice(0,21))db.exec(sql);db.exec("PRAGMA user_version=21");
    db.prepare("INSERT INTO mail_triage_qualifications(id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,evidence_hash,strata_counts_json,missed_action_count,approved_by,approved_at) VALUES('legacy',1,'model',1,1,1,1,?,'{}',0,'user:1',10)").run("c".repeat(64));
    migrate(db);const legacy=db.prepare("SELECT id,evidence_hash,approved_by,approved_at,current_report_hash,approval_revision,notification_state FROM mail_triage_qualifications WHERE id='legacy'").get()!;
    assert.deepEqual({...legacy},{id:"legacy",evidence_hash:"c".repeat(64),approved_by:"user:1",approved_at:10,current_report_hash:null,approval_revision:0,notification_state:"not_qualified"});
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,22);assert.deepEqual(db.prepare("PRAGMA foreign_key_list(mail_triage_audit_positions)").all(),[]);assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  }finally{db.close();}
});

test("migration 015 adds disabled triage storage without changing v14 bindings, keys or cached mail", () => {
  const db = openDb(":memory:");
  try {
    for (const sql of MIGRATIONS.slice(0, 14)) db.exec(sql);
    db.exec("PRAGMA user_version = 14");
    const ciphertext = seal(randomBytes(32), "sealed-fixture-key");
    db.prepare("INSERT INTO model_providers (id,name,protocol,base_url,api_key_ciphertext,models_json,created_at) VALUES (1,'fixture','openai','https://models.example.test',?,'[]',1)").run(ciphertext);
    for (const role of ["agent", "vision", "bulk", "review", "translation"]) {
      db.prepare("INSERT INTO model_roles VALUES (?,1,?,'off')").run(role, `${role}-model`);
    }
    db.prepare("INSERT INTO hostinger_accounts (id,label,token_ciphertext,token_hint,created_at) VALUES (1,'fixture',?,'aled',1)").run(Buffer.from("sealed-account"));
    db.exec("INSERT INTO mailboxes (id,account_id,order_id,remote_id,address,domain) VALUES (1,1,'o','r','a@example.test','example.test'); INSERT INTO mail_messages (mailbox_id,folder,uid,subject,body_text) VALUES (1,'INBOX',8,'old subject','old body')");
    const bindings = db.prepare("SELECT * FROM model_roles ORDER BY role").all();
    const cache = db.prepare("SELECT * FROM mail_messages").get();
    migrate(db);
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    for (const name of ["mail_triage_settings", "mail_triage_scope", "mail_triage_contacts", "mail_triage_sources", "mail_triage_source_aliases", "mail_triage_jobs", "mail_triage_attempts", "mail_triage_assessments", "mail_application_cases", "mail_case_sources", "mail_case_events", "mail_case_tasks", "mail_case_manual_decisions", "mail_triage_send_receipts", "mail_triage_qualifications", "mail_triage_audits", "mail_triage_requests"]) assert.ok(names.has(name), `missing table ${name}`);
    assert.deepEqual(db.prepare("SELECT * FROM model_roles ORDER BY role").all(), bindings);
    assert.deepEqual(db.prepare("SELECT api_key_ciphertext FROM model_providers WHERE id=1").get()?.api_key_ciphertext, new Uint8Array(ciphertext));
    assert.deepEqual({ ...db.prepare("SELECT * FROM mail_messages").get() }, { ...cache, uid_validity: null, body_complete: 0, body_issue: null, from_addresses_json: "[]" });
    assert.equal(db.prepare("SELECT config_revision FROM model_providers").get()?.config_revision, 1);
    const settings = db.prepare("SELECT * FROM mail_triage_settings").get()!;
    assert.equal(settings.enabled, 0);
    assert.equal(settings.state, "disabled");
    assert.equal(settings.mode, "auto_suggest");
    assert.equal(settings.daily_attempt_limit, 500);
    assert.equal(settings.auto_notifications, 0);
    const role = listRoles(db).find((item) => item.role === "mail_triage");
    assert.ok(role);
    assert.equal(role.providerId, 0);
    assert.equal(role.modelId, "");
    assert.equal(role.ready, false);
    assert.match(role.problem!, /邮件预审/);
    assert.equal(new Set(listRoles(db).map((item) => item.role)).size, 6);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
    migrate(db);
    assert.deepEqual(db.prepare("SELECT * FROM model_roles ORDER BY role").all(), bindings);
  } finally { db.close(); }
});

test("triage boundary schemas reject client actors, non-UUID ids and untrusted extra output fields", async () => {
  const schema = await import("./mail-triage-schema.ts");
  assert.deepEqual(schema.PageRequestSchema.parse({}), { page: 1, pageSize: 30 });
  assert.equal(schema.PageRequestSchema.safeParse({ pageSize: 101 }).success, false);
  assert.equal(schema.MutationMetaSchema.safeParse({ requestId: randomUUID(), expectedVersion: 0, reason: "核验", actor: "forged" }).success, false);
  assert.equal(schema.MutationMetaSchema.safeParse({ requestId: "bad", expectedVersion: 0, reason: "核验" }).success, false);
  assert.equal(schema.MutationMetaSchema.safeParse({ requestId: randomUUID(), expectedVersion: 0, reason: "核验" }).success, true);
  assert.equal(schema.TriageConfigSchema.parse({}).enabled, false);
  assert.equal(schema.TriageConfigSchema.parse({}).mode, "auto_suggest");
  assert.equal(schema.TriageConfigSchema.parse({}).autoNotifications, false);
  const output = { schemaVersion: 1, primaryCategory: "action_request", tag: "补件请求", summary: "请补充资料", caseSuggestion: { providerCandidate: null, applicationId: null, candidateCaseId: null, matchBasis: [], needsReview: true }, events: [], actions: [{ kind: "reply", title: "回复资料", requestedItems: ["资料"], deadlineRaw: null, satisfiesTaskIds: [], evidence: [{ sourceId: randomUUID(), quote: "Please reply" }] }], completionSuggestions: [], uncertainties: [], requiresHumanReview: true };
  assert.deepEqual(schema.AssessmentOutputSchema.parse(output), output);
  for (const tag of ["一", "七个汉字的长标签", "Reply", "补件123"]) assert.equal(schema.AssessmentOutputSchema.safeParse({ ...output, tag }).success, false);
  assert.equal(schema.AssessmentOutputSchema.safeParse({ ...output, confidence: 0.99 }).success, false);
  assert.equal(schema.AssessmentOutputSchema.safeParse({ ...output, actions: [{ ...output.actions[0], satisfiesTaskIds: ["invented-id"] }] }).success, false);
  assert.equal(schema.AssessmentOutputSchema.safeParse({ ...output, caseSuggestion: { ...output.caseSuggestion, candidateCaseId: "case_123" } }).success, false);
});

test("migration 015 creates queue and provenance indexes and enforces locator ownership", () => {
  const db = openDb(":memory:");
  try {
    migrate(db);
    const indexes = db.prepare("SELECT tbl_name, name FROM sqlite_master WHERE type='index'").all();
    for (const [table, columns] of [
      ["mail_triage_jobs", ["state", "next_attempt_at", "priority"]], ["mail_triage_jobs", ["source_id", "config_epoch"]],
      ["mail_triage_attempts", ["budget_day"]], ["mail_triage_sources", ["mailbox_id", "state"]],
      ["mail_triage_source_aliases", ["source_id", "active"]], ["mail_case_events", ["case_id", "observed_at"]],
      ["mail_case_tasks", ["case_id", "state"]], ["mail_triage_audits", ["sampled", "reviewed_at"]],
    ] as const) assert.ok(indexes.some((index) => index.tbl_name === table && JSON.stringify(db.prepare(`PRAGMA index_info('${index.name}')`).all().map((row) => row.name)) === JSON.stringify(columns)), `missing index ${table}(${columns})`);
    db.prepare("INSERT INTO hostinger_accounts (id,label,token_ciphertext,token_hint,created_at) VALUES (1,'fixture',?,'aled',1)").run(Buffer.from("sealed"));
    db.exec("INSERT INTO mailboxes (id,account_id,order_id,remote_id,address,domain) VALUES (1,1,'o','r1','a@example.test','example.test'), (2,1,'o','r2','b@example.test','example.test')");
    const sourceId = randomUUID();
    db.prepare("INSERT INTO mail_triage_sources (id,mailbox_id,source_hash,critical_headers_hash,observed_at) VALUES (?,1,'hash','headers',1)").run(sourceId);
    db.prepare("INSERT INTO mail_triage_source_aliases (mailbox_id,folder,uid_validity,uid,source_id) VALUES (1,'INBOX','v1',1,?)").run(sourceId);
    assert.throws(() => db.prepare("INSERT INTO mail_triage_source_aliases (mailbox_id,folder,uid_validity,uid,source_id) VALUES (1,'INBOX','v1',1,?)").run(sourceId), /UNIQUE/);
    assert.throws(() => db.prepare("INSERT INTO mail_triage_source_aliases (mailbox_id,folder,uid_validity,uid,source_id) VALUES (2,'INBOX','v1',1,?)").run(sourceId), /FOREIGN KEY/);
    assert.throws(() => db.prepare("UPDATE mail_triage_sources SET state='unreviewed'").run(), /CHECK/);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("migration 020 backfills grouped contacts and cascades only their materialized flat rows", () => {
  const db = openDb(":memory:");
  try {
    for (const sql of MIGRATIONS.slice(0, 19)) db.exec(sql);
    db.exec("PRAGMA user_version=19");
    db.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,created_at) VALUES(1,'fixture',?,'x',1)").run(Buffer.from("sealed"));
    db.exec("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain) VALUES(1,1,'o','r','a@example.test','example.test')");
    const id = randomUUID();
    db.prepare("INSERT INTO mail_triage_contacts(id,provider,mailbox_id,address,version,reason,confirmed_by,confirmed_at) VALUES(?,'Provider',1,'Sender@Example.test',3,'legacy','actor',9)").run(id);
    migrate(db);
    const group = db.prepare("SELECT * FROM mail_triage_contact_groups WHERE id=?").get(id)!;
    assert.deepEqual(JSON.parse(String(group.mailbox_ids_json)), [1]);
    assert.deepEqual(JSON.parse(String(group.sender_addresses_json)), ["sender@example.test"]);
    assert.equal(group.version, 3);
    assert.equal(db.prepare("SELECT group_id FROM mail_triage_contacts WHERE id=?").get(id)!.group_id, id);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mail_triage_contacts'").all().map(row => row.name);
    assert.ok(indexes.includes("mail_triage_contacts_group_mailbox_address"));
    assert.throws(() => db.prepare("INSERT INTO mail_triage_contacts(id,provider,mailbox_id,address,reason,confirmed_by,confirmed_at,group_id) VALUES(?,'Provider',1,'Sender@Example.test','duplicate','actor',10,?)").run(randomUUID(), id), /UNIQUE/);
    assert.throws(() => db.prepare("INSERT INTO mail_triage_contacts(id,provider,mailbox_id,address,reason,confirmed_by,confirmed_at,group_id) VALUES(?,'Provider',1,'other@example.test','cross workspace','actor',10,?)").run(randomUUID(), randomUUID()), /FOREIGN KEY/);
    db.prepare("DELETE FROM mail_triage_contact_groups WHERE id=?").run(id);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_triage_contacts").get()!.n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});
