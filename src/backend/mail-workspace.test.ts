import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkspace } from "./index.ts";
import { openDb, migrate } from "./db.ts";
import { handleRequest } from "./rpc.ts";
import { seal } from "./secrets.ts";
import type { MailTransport } from "./mailbox-transport.ts";
import type { HostingerExec } from "./hostinger.ts";
import { FakeMailTransport } from "./testing.ts";

test("mail RPC uses only the authenticated workspace: A cannot list, read or reset B's mailbox", async () => {
  const prefix = resolve(tmpdir(), "website-mail-isolation-");
  const root = mkdtempSync(prefix);
  const aKey = randomBytes(32), bKey = randomBytes(32);
  let network = 0;
  const noNetwork = async (): Promise<never> => { network++; throw new Error("测试禁止任何真实网络"); };
  const transport: MailTransport = {
    verify: noNetwork, listFolders: noNetwork, fetchMessages: noNetwork, fetchMessage: noNetwork,
    setSeen: noNetwork, moveToTrash: noNetwork, downloadAttachment: noNetwork, send: noNetwork, idle: noNetwork,
  };
  const a = createWorkspace({ userDir: join(root, "a"), key: aKey, dependencies: { mailTransport: () => transport } });
  const b = createWorkspace({ userDir: join(root, "b"), key: bKey, dependencies: { mailTransport: () => transport } });
  try {
    const db = openDb(join(root, "b", "website-gen.sqlite"));
    db.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,created_at) VALUES(1,'B only',?,'hint',0)").run(seal(bKey, "B-token"));
    db.prepare("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,credential_ciphertext) VALUES(42,1,'o','r','private@b.example','b.example',?)").run(seal(bKey, JSON.stringify({ address: "private@b.example", password: "B-password" })));
    db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,subject,body_text) VALUES(42,'INBOX',8,'B private','only B')").run();
    db.close();
    const rpc = (workspace: typeof a, method: string, params?: unknown) => handleRequest(workspace.handlers, { kind: "req", id: 1, method, params });
    const own = await rpc(b, "mail.list");
    assert.ok(own.ok);
    assert.equal((own.result as { address: string }[])[0]?.address, "private@b.example");
    assert.doesNotMatch(JSON.stringify(own), /B-password|credential_ciphertext|B-token/);
    const reveal = await rpc(b, "mail.password", { mailboxId: 42 });
    assert.ok(reveal.ok);
    assert.equal((reveal.result as { password: string }).password, "B-password");
    assert.deepEqual(await rpc(a, "mail.password", { mailboxId: 42 }), { kind: "res", id: 1, ok: true, result: null });
    assert.deepEqual(await rpc(a, "mail.list", { userId: "b" }), { kind: "res", id: 1, ok: true, result: [] });
    for (const method of ["mail.message", "mail.messages", "mail.folders", "mail.credential.reset", "mail.credential.retryDefault", "mail.delete", "mail.monitor"]) {
      const result = await rpc(a, method, { mailboxId: 42, folder: "INBOX", uid: 8, userId: "b", accountId: 1, confirmed: true, enabled: true });
      assert.equal(result.ok, false, method);
      assert.doesNotMatch(JSON.stringify(result), /B private|only B|B-password/);
    }
    await assert.rejects(a.mailAttachment({ mailboxId: 42, folder: "INBOX", uid: 8, partId: "1" }));
    assert.equal(network, 0);
  } finally {
    await a.close(); await b.close();
    if (!resolve(root).startsWith(prefix)) throw new Error("临时目录越界");
    rmSync(root, { recursive: true, force: true });
  }
});

test("setting the workspace default password attempts every unsaved mailbox and reports counts", async () => {
  const prefix = resolve(tmpdir(), "website-mail-default-setting-");
  const dir = mkdtempSync(prefix), workspaceKey = randomBytes(32);
  const db = openDb(join(dir, "website-gen.sqlite"));
  migrate(db);
  db.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,created_at) VALUES(1,'default',?,'hint',0)").run(seal(workspaceKey, "token"));
  db.prepare("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain) VALUES(1,1,'o','r1','ok@example.test','example.test')").run();
  db.prepare("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain) VALUES(2,1,'o','r2','wrong@example.test','example.test')").run();
  db.close();
  const transport = new FakeMailTransport();
  transport.passwords.set("ok@example.test", "Default1!");
  transport.passwords.set("wrong@example.test", "Different1!");
  const noHostinger: HostingerExec = async (operation) => {
    if (operation === "mail_orders_list") return [];
    throw new Error(`unexpected ${operation}`);
  };
  const workspace = createWorkspace({ userDir: dir, key: workspaceKey, dependencies: {
    mailTransport: () => transport,
    hostingerPool: { forAccount: () => noHostinger, close: async () => {}, closeAll: async () => [] },
  } });
  try {
    const result = await workspace.handlers["mail.defaultPassword.set"]({ password: "Default1!" });
    assert.deepEqual(result, { set: true, succeeded: 1, failed: 1, deferred: 0 });
    const boxes = await workspace.handlers["mail.list"](undefined) as { address: string; credentialSaved: boolean; credentialSource: string | null; monitoring: boolean }[];
    assert.deepEqual(boxes.map((box) => [box.address, box.credentialSaved, box.credentialSource, box.monitoring]), [
      ["ok@example.test", true, "default", true],
      ["wrong@example.test", false, null, false],
    ]);
  } finally {
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abandon waits for submitted SMTP before purging mail, while its tombstone rejects new sends", async () => {
  const prefix = resolve(tmpdir(), "website-mail-drain-");
  const dir = mkdtempSync(prefix), key = randomBytes(32), domain = "drain.example";
  const db = openDb(join(dir, "website-gen.sqlite"));
  migrate(db);
  db.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,created_at) VALUES(1,'drain',?,'hint',0)").run(seal(key, "token"));
  db.prepare("INSERT INTO domains(account_id,external_id,domain,status) VALUES(1,1,?,'active')").run(domain);
  db.prepare("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,credential_ciphertext) VALUES(1,1,'o','r',?,?,?)").run(`a@${domain}`, domain, seal(key, JSON.stringify({ address: `a@${domain}`, password: "saved" })));
  db.close();
  let smtpCalls = 0, release!: () => void, reached!: () => void, autoRenew = true;
  const submitted = new Promise<void>((done) => { reached = done; });
  const unused = async (): Promise<never> => { throw new Error("unexpected network operation"); };
  const transport: MailTransport = {
    verify: unused, listFolders: unused, fetchMessages: unused, fetchMessage: unused,
    setSeen: unused, moveToTrash: unused, downloadAttachment: unused, idle: unused,
    send: async (_credentials, message) => {
      smtpCalls++; reached();
      await new Promise<void>((done) => { release = done; });
      return { messageId: message.messageId, appended: true };
    },
  };
  const exec: HostingerExec = async (operation) => {
    if (operation === "mail_orders_list" || operation === "hosting_websites_list") return [];
    if (operation === "billing_subscriptions_list") return [{ id: "domain-only", type: "domain", domain, is_auto_renewed: autoRenew }];
    if (operation === "billing_subscriptions_disable-auto-renewal") { autoRenew = false; return {}; }
    throw new Error(`unexpected MCP operation ${operation}`);
  };
  const workspace = createWorkspace({ userDir: dir, key, dependencies: {
    mailTransport: () => transport,
    hostingerPool: { forAccount: () => exec, close: async () => {}, closeAll: async () => [] },
  } });
  const rpc = (method: string, params?: unknown) => handleRequest(workspace.handlers, { kind: "req", id: 1, method, params });
  try {
    const sending = rpc("mail.send", { mailboxId: 1, to: ["recipient@example.net"], subject: "test", text: "plain" });
    await submitted;
    const abandoned = await rpc("abandon.start", { domain, accountId: 1, confirmation: domain });
    assert.ok(abandoned.ok);
    const { jobId } = abandoned.result as { jobId: number };
    const view = abandoned.result as { id: number; domain: string; steps: unknown[]; status: string };
    assert.equal(view.id, jobId);
    assert.equal(view.domain, domain);
    assert.equal(view.steps.length, 5);
    assert.ok(["queued", "running"].includes(view.status));
    await new Promise<void>((done) => setImmediate(done));
    const checkDb = openDb(join(dir, "website-gen.sqlite"));
    assert.ok(checkDb.prepare("SELECT credential_ciphertext FROM mailboxes WHERE id=1").get());
    checkDb.close();
    assert.equal((await rpc("mail.send", { mailboxId: 1, to: ["recipient@example.net"], subject: "again", text: "no" })).ok, false);
    assert.equal(smtpCalls, 1);
    release();
    assert.equal((await sending).ok, true);
    let status: { status: string } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await rpc("abandon.status", { jobId });
      assert.ok(result.ok);
      status = result.result as { status: string };
      if (status.status === "done" || status.status === "failed") break;
      await new Promise<void>((done) => setImmediate(done));
    }
    assert.equal(status?.status, "done");
    assert.equal(autoRenew, false);
    const finalDb = openDb(join(dir, "website-gen.sqlite"));
    assert.equal((finalDb.prepare("SELECT count(*) n FROM mailboxes").get() as { n: number }).n, 0);
    finalDb.close();
  } finally {
    release?.();
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("临时目录越界");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace startup resumes saved monitoring without any browser subscriber, and close drains IDLE", async () => {
  const prefix = resolve(tmpdir(), "website-mail-offline-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  const db = openDb(join(dir, "website-gen.sqlite"));
  migrate(db);
  db.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,created_at) VALUES(1,'offline',?,'hint',0)").run(seal(key, "token"));
  db.prepare("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,credential_ciphertext,monitoring) VALUES(1,1,'o','r','a@offline.example','offline.example',?,1)").run(seal(key, JSON.stringify({ address: "a@offline.example", password: "saved" })));
  db.close();
  let idle = 0, indexed = 0;
  const unused = async (): Promise<never> => { throw new Error("unexpected network operation"); };
  const transport: MailTransport = {
    verify: unused, listFolders: unused, fetchMessage: unused, setSeen: unused,
    moveToTrash: unused, downloadAttachment: unused, send: unused,
    fetchMessages: async () => { indexed++; return []; },
    idle: async (_credentials, _onExists, signal) => {
      idle++;
      try { await new Promise<void>((done) => signal.aborted ? done() : signal.addEventListener("abort", () => done(), { once: true })); }
      finally { idle--; }
    },
  };
  const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
  try {
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(idle, 1);
    assert.equal(indexed, 1);
    await workspace.close();
    assert.equal(idle, 0);
    assert.throws(() => workspace.handlers["mail.list"](undefined), /已关闭/);
  } finally {
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("临时目录越界");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("active mixed batches omit abandoned sites while direct detail and history keep them", async () => {
  const prefix = resolve(tmpdir(), "website-mail-history-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  const db = openDb(join(dir, "website-gen.sqlite"));
  migrate(db);
  db.exec(`INSERT INTO batches VALUES(1,'{}',0);
    INSERT INTO sites(id,batch_id,domain,form_json,status,created_at,updated_at,launched_at) VALUES(1,1,'active.example','{}','done',0,0,1);
    INSERT INTO sites(id,batch_id,domain,form_json,status,created_at,updated_at,launched_at,abandoned_at) VALUES(2,1,'history.example','{}','done',0,0,1,2);
    INSERT INTO abandoned_domains(domain,abandoned_at) VALUES('history.example',2);`);
  db.close();
  const workspace = createWorkspace({ userDir: dir, key });
  try {
    const active = await workspace.handlers["batches.sites"]({ batchId: 1 }) as { id: number }[];
    assert.deepEqual(active.map((site) => site.id), [1]);
    const history = await workspace.handlers["sites.history"](undefined) as { id: number; status: string }[];
    assert.deepEqual(history.map((site) => [site.id, site.status]), [[2, "abandoned"]]);
    const detail = await workspace.handlers["sites.get"]({ siteId: 2 }) as { status: string };
    assert.equal(detail.status, "abandoned");
  } finally {
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("临时目录越界");
    rmSync(dir, { recursive: true, force: true });
  }
});
