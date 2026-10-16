import test from "node:test";
import assert from "node:assert/strict";
import { openDb, migrate, schemaVersion } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";
import { siteContext, provisionSite } from "./pipeline.ts";
import { deps, DOMAIN, setup } from "./testing.ts";

test("011 upgrades a populated 010 workspace without losing pipeline history or secrets", () => {
  const db = openDb(":memory:");
  try {
    for (const sql of MIGRATIONS.slice(0, 10)) db.exec(sql);
    db.exec(`PRAGMA user_version = 10;
      INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,created_at) VALUES(1,'原账号',X'1234','hint',0);
      INSERT INTO batches VALUES(1,'{}',0);
      INSERT INTO sites(id,batch_id,domain,form_json,status,created_at,updated_at,mailbox_ciphertext) VALUES(1,1,'kept.example','{}','done',0,0,X'5678');
      INSERT INTO jobs(id,type,site_id,run_at,created_at,updated_at) VALUES(1,'site.provision',1,0,0,0);
      INSERT INTO provision_steps VALUES(1,'precheck','done','原始进度',0,0);
      INSERT INTO changesets(site_id,summary,initiator,ops_json,status,created_at) VALUES(1,'原始变更','you','[]','applied',0);`);
    migrate(db);
    migrate(db);
    assert.equal(schemaVersion(db), MIGRATIONS.length);
    const site = db.prepare("SELECT domain,status,hex(mailbox_ciphertext) AS secret,abandoned_at FROM sites WHERE id=1").get();
    assert.deepEqual({ ...site }, { domain: "kept.example", status: "done", secret: "5678", abandoned_at: null });
    assert.equal((db.prepare("SELECT count(*) n FROM provision_steps").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT count(*) n FROM jobs").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT count(*) n FROM changesets").get() as { n: number }).n, 1);
    db.prepare("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain) VALUES(1,1,'o','r','a@kept.example','kept.example')").run();
    db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,body_text) VALUES(1,'INBOX',1,'cached text')").run();
    assert.throws(() => db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid) VALUES(999,'INBOX',1)").run());
    db.prepare("DELETE FROM mailboxes WHERE id=1").run();
    assert.equal((db.prepare("SELECT count(*) n FROM mail_messages").get() as { n: number }).n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("a domain tombstone blocks even an already-created pipeline context before any new network action", async () => {
  const { db, siteId } = setup();
  let calls = 0;
  const dependencies = deps(db, async () => { calls++; return {}; }, (async () => { calls++; return new Response("{}"); }) as typeof fetch, []);
  const ctx = siteContext(dependencies, siteId);
  try {
    db.prepare("INSERT INTO abandoned_domains(domain,abandoned_at) VALUES(?,1)").run(DOMAIN);
    assert.throws(() => ctx.save("mailbox_ciphertext", new Uint8Array([1])), /放弃/);
    await assert.rejects(ctx.hx("mail_mailboxes_create-mailbox", {}), /放弃/);
    await assert.rejects(ctx.wp("POST", "site-agent/v1/site", {}), /放弃/);
    await assert.rejects(provisionSite(dependencies, siteId), /放弃/);
    assert.equal(calls, 0);
  } finally { db.close(); }
});
