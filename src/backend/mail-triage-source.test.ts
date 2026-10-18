import assert from "node:assert/strict";
import test from "node:test";
import { parseMailText } from "./mailbox-parser.ts";
import { createMailboxService } from "./mailbox-service.ts";
import { FakeMailTransport, fakeRawMail, key, setup } from "./testing.ts";
import { MIGRATIONS } from "./migrations.ts";
import { openDb, migrate } from "./db.ts";

import * as sourceModule from "./mail-triage-source.ts";
function sources() { return sourceModule; }
const raw = (text = "Please provide the documents.", id = "<same@example.test>") => fakeRawMail({ from: '"Support, Team" <sender@example.test>', to: ["support@nordicpaws.com"], subject: "Review", text, messageId: id });
const locator = (uid: number, uidValidity = "100") => ({ mailboxId: 1, folder: "INBOX", uidValidity, uid });
function fixture() {
  const { db } = setup({ cachedMailbox: { password: "Fixture1!" } });
  db.exec(`INSERT INTO model_providers(id,name,protocol,base_url,models_json,created_at) VALUES(1,'offline','openai','https://never.example.test','[]',0);
    INSERT INTO model_roles(role,provider_id,model_id,thinking) VALUES('mail_triage',1,'offline','off');
    UPDATE mail_triage_settings SET enabled=1,state='enabled',consent_provider_revision=1;
    INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(1,1,'authorized','100',0,0);`);
  const fake = new FakeMailTransport(); fake.passwords.set("support@nordicpaws.com", "Fixture1!");
  const events: unknown[] = [];
  const service = createMailboxService({ db, key, accounts: () => { throw new Error("no account calls"); }, transport: () => fake, push: (event) => events.push(event) });
  return { db, fake, service, events };
}
const count = (db: ReturnType<typeof fixture>["db"], table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

test("B28/B33 raw OTP and body distinguish sources despite identical Message-ID; line endings only normalize", async () => {
  const { fingerprintSource, registerCachedSource, sourceConflicts } = sources();
  const { db, service } = fixture();
  try {
    const a = await parseMailText(raw("Your code is 123456.")); const b = await parseMailText(raw("Your code is 654321."));
    assert.notEqual(fingerprintSource(key, a).sourceHash, fingerprintSource(key, b).sourceHash);
    assert.equal(fingerprintSource(key, { ...a, text: "a\r\nb" }).sourceHash, fingerprintSource(key, { ...a, text: "a\nb" }).sourceHash);
    assert.notEqual(fingerprintSource(Buffer.alloc(32), a).sourceHash, fingerprintSource(key, a).sourceHash);
    const first = registerCachedSource(db, { locator: locator(1), mail: a, observedAt: 1 }, key);
    const second = registerCachedSource(db, { locator: locator(2), mail: b, observedAt: 2 }, key);
    assert.notEqual(first.sourceId, second.sourceId);
    assert.deepEqual(sourceConflicts(db, first.sourceId), [second.sourceId]);
    assert.equal(registerCachedSource(db, { locator: locator(1), mail: a, observedAt: 3 }, key).isNew, false);
    assert.equal(count(db, "mail_triage_jobs"), 2);
  } finally { await service.close(); db.close(); }
});

test("B29/B30 three streamed cache writes have three durable jobs regardless of one SSE; metadata resync is idempotent", async () => {
  const { db, fake, service, events } = fixture();
  try {
    fake.seed("support@nordicpaws.com", "INBOX", [1,2,3].map((uid) => ({ uid, uidValidity: "100", folder: "INBOX", flags: [], size: 200, source: raw(`Document ${uid}`, `<${uid}@example.test>`) })));
    await service.messages({ mailboxId: 1, folder: "INBOX" });
    assert.equal(count(db, "mail_triage_sources"), 3); assert.equal(count(db, "mail_triage_jobs"), 3);
    assert.equal(events.length, 1);
    await service.withInboxSnapshot(1, (snapshot) => assert.deepEqual(snapshot, { uidValidity: "100", maxUid: 3, complete: true }));
    assert.equal(count(db, "mail_triage_jobs"), 3);
    assert.equal(db.prepare("SELECT sum(seen) AS n FROM mail_messages").get()!.n, 0); assert.equal(fake.sent.length, 0);
    assert.ok(String(db.prepare("SELECT context_version FROM mail_triage_jobs LIMIT 1").get()!.context_version).startsWith("pending-source:"));
  } finally { await service.close(); db.close(); }
});

test("B55 UIDVALIDITY reset revokes old alias/job fences before same UID replacement; incomplete snapshots never remove mail", async () => {
  const { registerCachedSource, reconcileFolderSnapshot } = sources(); const { db, service } = fixture();
  try {
    const mail = await parseMailText(raw()); const old = registerCachedSource(db, { locator: locator(42), mail, observedAt: 1 }, key);
    db.prepare("UPDATE mail_triage_jobs SET state='running',lease_token='old-worker',lease_expires_at=9999").run();
    reconcileFolderSnapshot(db, { mailboxId: 1, folder: "INBOX", uidValidity: "100", presentUids: [], complete: false }, 2);
    assert.equal(db.prepare("SELECT state FROM mail_triage_sources WHERE id=?").get(old.sourceId)!.state, "active");
    const next = registerCachedSource(db, { locator: locator(42, "200"), mail: { ...mail, text: "New application" }, observedAt: 3 }, key);
    assert.notEqual(next.sourceId, old.sourceId);
    assert.equal(db.prepare("SELECT active FROM mail_triage_source_aliases WHERE uid_validity='100'").get()!.active, 0);
    const job = db.prepare("SELECT state,lease_token FROM mail_triage_jobs WHERE source_id=?").get(old.sourceId)!;
    assert.equal(job.state, "stale_source"); assert.equal(job.lease_token, null);
    assert.equal(db.prepare("SELECT source_version FROM mail_triage_sources WHERE id=?").get(old.sourceId)!.source_version, 2);
    reconcileFolderSnapshot(db, { mailboxId: 1, folder: "INBOX", uidValidity: "200", presentUids: [], complete: true }, 4);
    assert.equal(db.prepare("SELECT state FROM mail_triage_sources WHERE id=?").get(next.sourceId)!.state, "missing");
  } finally { await service.close(); db.close(); }
});

for (const table of ["mail_messages", "mail_triage_sources", "mail_triage_jobs"]) test(`B57 cache/source/job transaction rolls back if ${table} write fails`, async () => {
  const { db, fake, service } = fixture();
  try {
    db.exec(`CREATE TRIGGER fixture_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;`);
    fake.seed("support@nordicpaws.com", "INBOX", [{ uid: 1, uidValidity: "100", folder: "INBOX", flags: [], size: 200, source: raw() }]);
    await assert.rejects(service.messages({ mailboxId: 1, folder: "INBOX" }), /fixture write failure/);
    for (const name of ["mail_messages", "mail_triage_sources", "mail_triage_source_aliases", "mail_triage_jobs"]) assert.equal(count(db, name), 0);
  } finally { await service.close(); db.close(); }
});

test("B61 parser marks missing/link-only content incomplete and records structured sender addresses", async () => {
  const normal = await parseMailText(raw()); assert.equal(normal.bodyComplete, true); assert.deepEqual(normal.fromAddresses, ["sender@example.test"]);
  for (const body of ["", "https://untrusted.example.test/document"]) {
    const mail = await parseMailText(raw(body)); assert.equal(mail.bodyComplete, false); assert.ok(mail.bodyIssue);
  }
});

test("snapshot callbacks are not deduped/lost and async commits fail without committing their synchronous writes", async () => {
  const { db, service } = fixture();
  try {
    const seen: number[] = [];
    await Promise.all([service.withInboxSnapshot(1, () => { seen.push(1); }), service.withInboxSnapshot(1, () => { seen.push(2); })]);
    assert.deepEqual(seen, [1,2]);
    await assert.rejects(service.withInboxSnapshot(1, async () => { db.exec("UPDATE mail_triage_settings SET version=99"); }), /同步|synchronous/);
    assert.equal(db.prepare("SELECT version FROM mail_triage_settings").get()!.version, 1);
  } finally { await service.close(); db.close(); }
});

test("legacy fabricated identity remains readable but activation fails closed", async () => {
  const { db, fake, service } = fixture();
  try {
    Object.defineProperty(fake, "streamMessages", { value: undefined });
    fake.seed("support@nordicpaws.com", "INBOX", [{ uid: 1, folder: "INBOX", flags: [], size: 200, source: raw() }]);
    assert.equal((await service.messages({ mailboxId: 1, folder: "INBOX" })).total, 1);
    assert.equal(count(db, "mail_triage_sources"), 0); assert.equal(db.prepare("SELECT uid_validity FROM mail_messages").get()!.uid_validity, null);
    await assert.rejects(service.withInboxSnapshot(1, () => undefined), /UIDVALIDITY/);
  } finally { await service.close(); db.close(); }
});

test("016 preserves v15 bodies as unverified; recovery repairs only complete current generation after authorized watermark", async () => {
  const { recoverCachedSources } = sources();
  const old = openDb(":memory:");
  try { for (const sql of MIGRATIONS.slice(0,15)) old.exec(sql); old.exec("PRAGMA user_version=15"); migrate(old); assert.ok(old.prepare("PRAGMA table_info(mail_messages)").all().some((r) => r.name === "body_complete")); } finally { old.close(); }
  const { db, fake, service } = fixture();
  try {
    fake.seed("support@nordicpaws.com", "INBOX", [1,2,3].map((uid) => ({ uid, uidValidity: "100", folder: "INBOX", flags: [], size: 200, source: raw(`Message ${uid}`, `<${uid}@example.test>`) })));
    await service.messages({ mailboxId: 1, folder: "INBOX" });
    db.exec("DELETE FROM mail_triage_jobs; UPDATE mail_triage_scope SET baseline_uid=1; UPDATE mail_messages SET body_complete=0,body_issue=NULL WHERE uid=2;");
    assert.equal(recoverCachedSources(db, key, { limit: 1 }), 1); assert.equal(count(db, "mail_triage_jobs"), 1);
    assert.equal(recoverCachedSources(db, key, { limit: 1 }), 0);
    assert.equal(db.prepare("SELECT a.uid FROM mail_triage_jobs j JOIN mail_triage_source_aliases a ON a.source_id=j.source_id").get()!.uid, 3);
  } finally { await service.close(); db.close(); }
});

test("sync pending obligation hook is transactional even while paused; thenables cannot escape commit", async () => {
  const { db, fake, service } = fixture(); await service.close();
  db.exec("UPDATE mail_triage_settings SET state='paused_budget'");
  let modelCalls = 0; const beforeFetch = globalThis.fetch; globalThis.fetch = async () => { modelCalls++; throw new Error("no model/network"); };
  const pending: string[] = [];
  const hooked = createMailboxService({ db, key, accounts: () => [], transport: () => fake, push: () => {}, triageSourceHooks: { onPendingSource(input) { assert.ok(input.jobId); pending.push(input.jobId); assert.equal(db.prepare("SELECT state FROM mail_triage_jobs WHERE id=?").get(input.jobId)!.state, "paused_budget"); } } });
  try {
    fake.seed("support@nordicpaws.com", "INBOX", [{ uid: 1, uidValidity: "100", folder: "INBOX", flags: [], size: 100, source: raw() }]);
    await hooked.withInboxSnapshot(1, () => undefined); assert.equal(pending.length, 1); assert.equal(modelCalls, 0);
    await assert.rejects(hooked.withInboxSnapshot(1, () => { db.exec("UPDATE mail_triage_settings SET version=77"); return { then() {} }; }), /同步|synchronous/);
    assert.equal(db.prepare("SELECT version FROM mail_triage_settings").get()!.version, 1);
    await assert.rejects(hooked.withInboxSnapshot(1, () => hooked.withInboxSnapshot(1, () => undefined)), /再次进入/);
  } finally { globalThis.fetch = beforeFetch; await hooked.close(); db.close(); }
});

test("a throwing pending hook rolls cache/source/job back instead of losing initial review obligation", async () => {
  const { db, fake, service } = fixture(); await service.close();
  const hooked = createMailboxService({ db, key, accounts: () => [], transport: () => fake, push: () => {}, triageSourceHooks: { onPendingSource() { throw new Error("projector unavailable"); } } });
  try {
    fake.seed("support@nordicpaws.com", "INBOX", [{ uid: 1, uidValidity: "100", folder: "INBOX", flags: [], size: 100, source: raw() }]);
    await assert.rejects(hooked.withInboxSnapshot(1, () => undefined), /projector unavailable/);
    for (const name of ["mail_messages", "mail_triage_sources", "mail_triage_jobs"]) assert.equal(count(db, name), 0);
  } finally { await hooked.close(); db.close(); }
});

test("unverified v15 cache is refetched once, failed/oversize placeholders stay persistently incomplete without retry loops", async () => {
  const { db, fake, service } = fixture();
  try {
    db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,subject,body_text) VALUES(1,'INBOX',1,'legacy','legacy placeholder')").run();
    db.exec(`UPDATE mailboxes SET sync_state_json='{"folders":{"INBOX":{"uidValidity":"100","syncedAt":0}}}'`);
    let downloads = 0;
    const original = fake.streamMessages.bind(fake);
    fake.streamMessages = async function* (creds, folder, known) { for await (const event of original(creds, folder, known)) { if (event.kind === "message" && event.message.source) downloads++; yield event; } };
    fake.seed("support@nordicpaws.com", "INBOX", [{ uid: 1, uidValidity: "100", folder: "INBOX", flags: [], size: 30*1024*1024, source: Buffer.alloc(0) }]);
    await service.withInboxSnapshot(1, () => undefined);
    assert.equal(downloads, 1); assert.equal(db.prepare("SELECT body_complete FROM mail_messages").get()!.body_complete, 0);
    assert.equal(db.prepare("SELECT body_issue FROM mail_messages").get()!.body_issue, "oversized");
    assert.equal(db.prepare("SELECT state FROM mail_triage_jobs").get()!.state, "needs_review");
    await service.withInboxSnapshot(1, () => undefined); assert.equal(downloads, 1);
  } finally { await service.close(); db.close(); }
});

test("partial stream keeps previously cached missing UID and source active until a complete snapshot", async () => {
  const { db, fake, service } = fixture();
  try {
    fake.seed("support@nordicpaws.com", "INBOX", [1,2].map((uid) => ({ uid, uidValidity: "100", folder: "INBOX", flags: [], size: 100, source: raw(`body ${uid}`, `<${uid}@example.test>`) })));
    await service.withInboxSnapshot(1, () => undefined);
    fake.streamMessages = async function* () { yield { kind: "mailbox", uidValidity: "100" }; throw new Error("interrupted snapshot"); };
    await assert.rejects(service.withInboxSnapshot(1, () => undefined), /interrupted snapshot/);
    assert.equal(count(db, "mail_messages"), 2); assert.equal(db.prepare("SELECT count(*) AS n FROM mail_triage_sources WHERE state='active'").get()!.n, 2);
  } finally { await service.close(); db.close(); }
});

test("trash immediately revokes the cached locator fence before later lifecycle cleanup", async () => {
  const { db, fake, service } = fixture();
  try {
    fake.seed("support@nordicpaws.com", "INBOX", [{ uid: 1, uidValidity: "100", folder: "INBOX", flags: [], size: 100, source: raw() }]);
    await service.withInboxSnapshot(1, () => undefined);
    db.exec("UPDATE mail_triage_jobs SET state='running',lease_token='trash-worker'");
    await service.trash({ mailboxId: 1, folder: "INBOX", uid: 1, confirmed: true });
    assert.equal(db.prepare("SELECT active FROM mail_triage_source_aliases").get()!.active, 0);
    assert.equal(db.prepare("SELECT lease_token FROM mail_triage_jobs").get()!.lease_token, null);
    assert.equal(db.prepare("SELECT state FROM mail_triage_jobs").get()!.state, "stale_source");
  } finally { await service.close(); db.close(); }
});

test("interrupted upgrade refresh retains old unverified reader cache without authorizing it", async () => {
  const { db, fake, service } = fixture();
  try {
    db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,subject,body_text) VALUES(1,'INBOX',42,'legacy','visible old cache')").run();
    db.exec(`UPDATE mailboxes SET sync_state_json='{"folders":{"INBOX":{"uidValidity":"100","syncedAt":0}}}'`);
    fake.streamMessages = async function* () { yield { kind: "mailbox", uidValidity: "100" }; throw new Error("upgrade interrupted"); };
    await assert.rejects(service.withInboxSnapshot(1, () => undefined), /upgrade interrupted/);
    assert.equal(db.prepare("SELECT body_text FROM mail_messages WHERE uid=42").get()?.body_text, "visible old cache");
    assert.equal(count(db, "mail_triage_sources"), 0); assert.equal(count(db, "mail_triage_jobs"), 0);
  } finally { await service.close(); db.close(); }
});

test("snapshot revalidates mailbox lifecycle immediately before the authorization commit", async () => {
  const { db, fake, service } = fixture(); await service.close(); let committed = false;
  const guarded = createMailboxService({ db, key, accounts: () => [], transport: () => fake, push() { db.prepare("INSERT INTO abandoned_domains(domain,abandoned_at) VALUES('nordicpaws.com',1)").run(); } });
  try {
    fake.seed("support@nordicpaws.com", "INBOX", [{ uid: 1, uidValidity: "100", folder: "INBOX", flags: [], size: 100, source: raw() }]);
    await assert.rejects(guarded.withInboxSnapshot(1, () => { committed = true; }), /放弃/); assert.equal(committed, false);
  } finally { await guarded.close(); db.close(); }
});

test("fix1 initialized scope registers new complete and incomplete mail while second mailbox still initializes", async () => {
  const { registerCachedSource, recoverCachedSources } = sources(); const { db, service } = fixture();
  try {
    db.exec(`UPDATE mail_triage_settings SET enabled=0,state='initializing';
      INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain) VALUES(2,1,'o2','b2','other@example.test','example.test');
      INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(2,1,'revoked',NULL,0,NULL);`);
    const pending: number[] = []; const hooks = { onPendingSource(input: sourceModule.PendingSource) { pending.push(input.locator.uid); } };
    registerCachedSource(db, { locator: locator(1), mail: await parseMailText(raw()), observedAt: 1 }, key, hooks);
    registerCachedSource(db, { locator: locator(2), mail: await parseMailText(raw("")), observedAt: 2 }, key, hooks);
    assert.deepEqual(pending, [1,2]); assert.equal(count(db, "mail_triage_jobs"), 2);
    assert.equal(db.prepare("SELECT state FROM mail_triage_jobs WHERE source_id=(SELECT source_id FROM mail_triage_source_aliases WHERE uid=1)").get()!.state, "queued");
    assert.equal(db.prepare("SELECT state FROM mail_triage_jobs WHERE source_id=(SELECT source_id FROM mail_triage_source_aliases WHERE uid=2)").get()!.state, "needs_review");
    db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,body_complete,body_issue,body_text) VALUES(1,'INBOX',3,'100',0,'missing_body','')").run();
    assert.equal(recoverCachedSources(db, key, { hooks }), 1); assert.deepEqual(pending, [1,2,3]);
    assert.equal(db.prepare("SELECT enabled FROM mail_triage_settings").get()!.enabled, 0);
  } finally { await service.close(); db.close(); }
});

for (const unavailable of ["missing_role", "unconsented_revision"]) test(`fix1 initial review seam survives ${unavailable} without forged model tuple`, async () => {
  const { registerCachedSource, recoverCachedSources } = sources(); const { db, service } = fixture();
  try {
    if (unavailable === "missing_role") db.exec("DELETE FROM model_roles WHERE role='mail_triage'");
    else db.exec("UPDATE model_providers SET config_revision=2");
    const pending: sourceModule.PendingSource[] = [];
    const mail = await parseMailText(raw());
    const registered = registerCachedSource(db, { locator: locator(1), mail, observedAt: 1 }, key, { onPendingSource(input) { pending.push(input); } });
    assert.equal(pending.length, 1); assert.equal(pending[0].sourceId, registered.sourceId); assert.equal(pending[0].jobId, null);
    assert.equal(count(db, "mail_triage_jobs"), 0); assert.equal(count(db, "mail_triage_sources"), 1);
    db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,body_complete,body_text) VALUES(1,'INBOX',1,'100',1,'complete cached body')").run();
    if (unavailable === "missing_role") db.exec("INSERT INTO model_roles(role,provider_id,model_id,thinking) VALUES('mail_triage',1,'offline','off')");
    else db.exec("UPDATE mail_triage_settings SET consent_provider_revision=2");
    assert.equal(recoverCachedSources(db, key), 1); assert.equal(count(db, "mail_triage_jobs"), 1);
  } finally { await service.close(); db.close(); }
});

test("fix1 tombstone suppresses recovery registration and pending hooks even before scope/cache cleanup", async () => {
  const { recoverCachedSources } = sources(); const { db, fake, service } = fixture();
  try {
    fake.seed("support@nordicpaws.com", "INBOX", [{ uid: 1, uidValidity: "100", folder: "INBOX", flags: [], size: 100, source: raw() }]);
    await service.withInboxSnapshot(1, () => undefined); db.exec("DELETE FROM mail_triage_jobs; INSERT INTO abandoned_domains(domain,abandoned_at) VALUES('nordicpaws.com',1)");
    let pending = 0; assert.equal(recoverCachedSources(db, key, { hooks: { onPendingSource() { pending++; } } }), 0);
    assert.equal(pending, 0); assert.equal(count(db, "mail_triage_jobs"), 0);
    await service.reconcile(); assert.equal(count(db, "mail_triage_jobs"), 0);
  } finally { await service.close(); db.close(); }
});

test("fix1 startup recovery uses lifecycle guard while mailbox remote deletion is waiting", async () => {
  const { db, fake, service } = fixture(); await service.close();
  let release!: () => void, reached!: () => void;
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  let pending = 0;
  const guarded = createMailboxService({ db, key, transport: () => fake, push: () => {}, triageSourceHooks: { onPendingSource() { pending++; } }, accounts: () => [{ id: 1, exec: async (operation) => {
    if (operation === "mail_mailboxes_delete-mailbox") { reached(); await new Promise<void>((resolve) => { release = resolve; }); return {}; }
    if (operation === "mail_mailboxes_list") return []; throw new Error("unexpected operation");
  } }] });
  try {
    fake.seed("support@nordicpaws.com", "INBOX", [{ uid: 1, uidValidity: "100", folder: "INBOX", flags: [], size: 100, source: raw() }]);
    await guarded.withInboxSnapshot(1, () => undefined); db.exec("DELETE FROM mail_triage_jobs"); pending = 0;
    const deleting = guarded.deleteMailbox({ mailboxId: 1, confirmed: true }); await waiting;
    await guarded.reconcile(); assert.equal(pending, 0); assert.equal(count(db, "mail_triage_jobs"), 0);
    release(); await deleting;
  } finally { release?.(); await guarded.close(); db.close(); }
});

test("task9 fix1 historical admission bypasses only baseline and still requires current scope, lifecycle, and complete body", async () => {
  const { registerHistoricalCachedSource } = sources(); const { db, service } = fixture();
  try {
    db.prepare("UPDATE mail_triage_scope SET baseline_uid=50 WHERE mailbox_id=1").run();
    const mail = await parseMailText(raw("old complete cache"));
    const admitted = registerHistoricalCachedSource(db, { locator: locator(5), mail, observedAt: 1 }, key);
    assert.match(admitted.sourceId, /^[0-9a-f-]{36}$/i); assert.equal(count(db, "mail_triage_jobs"), 0);
    assert.throws(() => registerHistoricalCachedSource(db, { locator: locator(6), mail: { ...mail, bodyComplete: false, text: "" }, observedAt: 1 }, key), /完整/);
    db.prepare("UPDATE mailboxes SET status='deleting' WHERE id=1").run();
    assert.throws(() => registerHistoricalCachedSource(db, { locator: locator(7), mail, observedAt: 1 }, key), /范围已失效/);
  } finally { await service.close(); db.close(); }
});
