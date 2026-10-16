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
import type { MailCredentials, MailTransport, RemoteMessage } from "./mailbox-transport.ts";
import type { HostingerExec } from "./hostinger.ts";
import type { Push } from "../shared/protocol.ts";
import { FakeMailTransport, fakeRawMail } from "./testing.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function seedMailbox(input: {
  dir: string;
  key: Buffer;
  syncedAt?: number;
  uidValidity?: string;
  messages?: { uid: number; seen?: boolean; size?: number; subject?: string }[];
}) {
  const db = openDb(join(input.dir, "website-gen.sqlite"));
  migrate(db);
  const state = input.syncedAt == null ? {} : {
    folders: { INBOX: { uidValidity: input.uidValidity ?? "1", syncedAt: input.syncedAt } },
  };
  db.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,created_at) VALUES(1,'mail',?,'hint',0)").run(seal(input.key, "token"));
  db.prepare("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,credential_ciphertext,sync_state_json) VALUES(1,1,'o','r','mail@example.test','example.test',?,?)")
    .run(seal(input.key, JSON.stringify({ address: "mail@example.test", password: "saved" })), JSON.stringify(state));
  for (const message of input.messages ?? []) {
    db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,subject,seen,size,body_text) VALUES(1,'INBOX',?,?,?,?,?)")
      .run(message.uid, message.subject ?? `cached-${message.uid}`, message.seen ? 1 : 0, message.size ?? 10, `body-${message.uid}`);
  }
  db.close();
}

const remoteMessage = (uid: number, input: { seen?: boolean; size?: number; uidValidity?: string; source?: boolean } = {}): RemoteMessage => ({
  uid,
  folder: "INBOX",
  uidValidity: input.uidValidity ?? "1",
  flags: input.seen ? ["\\Seen"] : [],
  size: input.size ?? 10,
  source: input.source ? fakeRawMail({ from: "sender@example.test", to: ["mail@example.test"], subject: `remote-${uid}`, text: `body-${uid}` }) : undefined,
});

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

test("stale messages return cached rows without waiting for the background refresh and publish its flag change", async () => {
  const prefix = resolve(tmpdir(), "website-mail-stale-cache-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  seedMailbox({ dir, key, syncedAt: Date.now() - 60_000, messages: [{ uid: 1, seen: false, subject: "cached" }] });
  const started = deferred(), release = deferred(), changed = deferred<Push>();
  let calls = 0;
  class BlockingTransport extends FakeMailTransport {
    override async *streamMessages(credentials: MailCredentials, folder: string) {
      await this.verify(credentials);
      calls++;
      yield { kind: "mailbox" as const, uidValidity: "1" };
      started.resolve();
      await release.promise;
      yield { kind: "message" as const, message: remoteMessage(1, { seen: true }) };
    }
  }
  const transport = new BlockingTransport();
  transport.passwords.set("mail@example.test", "saved");
  const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
  const unsubscribe = workspace.subscribe((event) => {
    if (event.kind === "mail" && event.event.type === "changed") changed.resolve(event);
  });
  try {
    const request = workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" }) as Promise<{ items: { subject: string; seen: boolean }[] }>;
    const concurrent = workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" }) as Promise<{ items: { subject: string; seen: boolean }[] }>;
    await started.promise;
    const outcome = await Promise.race([
      request.then((value) => ({ kind: "result" as const, value })),
      new Promise<{ kind: "blocked" }>((resolveRace) => setImmediate(() => resolveRace({ kind: "blocked" }))),
    ]);
    assert.equal(outcome.kind, "result");
    if (outcome.kind === "result") assert.deepEqual(outcome.value.items.map((item) => [item.subject, item.seen]), [["cached", false]]);
    const concurrentOutcome = await Promise.race([
      concurrent.then((value) => ({ kind: "result" as const, value })),
      new Promise<{ kind: "blocked" }>((resolveRace) => setImmediate(() => resolveRace({ kind: "blocked" }))),
    ]);
    assert.equal(concurrentOutcome.kind, "result");
    if (concurrentOutcome.kind === "result") assert.deepEqual(concurrentOutcome.value.items.map((item) => [item.subject, item.seen]), [["cached", false]]);
    assert.equal(calls, 1);
    release.resolve();
    const pushed = await changed.promise;
    assert.deepEqual(pushed, { kind: "mail", event: { type: "changed", mailboxId: 1, folder: "INBOX" } });
  } finally {
    release.resolve();
    unsubscribe();
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two concurrent cold-cache message reads share one synchronization", async () => {
  const prefix = resolve(tmpdir(), "website-mail-cold-dedup-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  seedMailbox({ dir, key });
  const started = deferred(), release = deferred();
  let calls = 0;
  class BlockingTransport extends FakeMailTransport {
    override async *streamMessages(credentials: MailCredentials, folder: string) {
      await this.verify(credentials);
      calls++;
      started.resolve();
      await release.promise;
      yield { kind: "mailbox" as const, uidValidity: "1" };
      yield { kind: "message" as const, message: remoteMessage(1, { source: true }) };
    }
  }
  const transport = new BlockingTransport();
  transport.passwords.set("mail@example.test", "saved");
  const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
  try {
    const first = workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" }) as Promise<{ total: number }>;
    const second = workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" }) as Promise<{ total: number }>;
    await started.promise;
    release.resolve();
    assert.deepEqual((await Promise.all([first, second])).map((result) => result.total), [1, 1]);
    assert.equal(calls, 1);
  } finally {
    release.resolve();
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("folder reads share one request and reuse the result inside the TTL", async () => {
  const prefix = resolve(tmpdir(), "website-mail-folder-cache-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  seedMailbox({ dir, key });
  const started = deferred(), release = deferred();
  let calls = 0;
  class BlockingTransport extends FakeMailTransport {
    override async listFolders(credentials: MailCredentials) {
      await this.verify(credentials);
      calls++;
      started.resolve();
      await release.promise;
      return [{ path: "INBOX", name: "Inbox", specialUse: "\\Inbox" }];
    }
  }
  const transport = new BlockingTransport();
  transport.passwords.set("mail@example.test", "saved");
  const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
  try {
    const first = workspace.handlers["mail.folders"]({ mailboxId: 1 });
    const second = workspace.handlers["mail.folders"]({ mailboxId: 1 });
    await started.promise;
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    const db = openDb(join(dir, "website-gen.sqlite"));
    db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,seen) VALUES(1,'INBOX',99,0)").run();
    db.close();
    assert.deepEqual(await workspace.handlers["mail.folders"]({ mailboxId: 1 }), [{ path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 1, unread: 1 }]);
    assert.equal(calls, 1);
  } finally {
    release.resolve();
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saving credentials invalidates the cached folder list", async () => {
  const prefix = resolve(tmpdir(), "website-mail-folder-invalidate-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  seedMailbox({ dir, key });
  let calls = 0;
  class CountingTransport extends FakeMailTransport {
    override async listFolders(credentials: MailCredentials) {
      calls++;
      return super.listFolders(credentials);
    }
  }
  const transport = new CountingTransport();
  transport.passwords.set("mail@example.test", "saved");
  const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
  try {
    await workspace.handlers["mail.folders"]({ mailboxId: 1 });
    await workspace.handlers["mail.folders"]({ mailboxId: 1 });
    assert.equal(calls, 1);
    await workspace.handlers["mail.credential.save"]({ mailboxId: 1, password: "saved" });
    const afterSave = calls;
    await workspace.handlers["mail.folders"]({ mailboxId: 1 });
    assert.equal(calls, afterSave + 1);
  } finally {
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an old in-flight folder load cannot overwrite the cache after credentials change", async () => {
  const prefix = resolve(tmpdir(), "website-mail-folder-generation-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  seedMailbox({ dir, key });
  const oldStarted = deferred(), releaseOld = deferred();
  let oldCalls = 0, newCalls = 0;
  class CredentialAwareTransport extends FakeMailTransport {
    override async listFolders(credentials: MailCredentials) {
      await this.verify(credentials);
      if (credentials.password === "saved") {
        oldCalls++;
        oldStarted.resolve();
        await releaseOld.promise;
        return [{ path: "Old", name: "Old", specialUse: null }];
      }
      newCalls++;
      return [{ path: "New", name: "New", specialUse: null }];
    }
  }
  const transport = new CredentialAwareTransport();
  transport.passwords.set("mail@example.test", "saved");
  const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
  try {
    const oldLoad = workspace.handlers["mail.folders"]({ mailboxId: 1 });
    await oldStarted.promise;
    transport.passwords.set("mail@example.test", "replacement");
    await workspace.handlers["mail.credential.save"]({ mailboxId: 1, password: "replacement" });
    assert.deepEqual(await workspace.handlers["mail.folders"]({ mailboxId: 1 }), [
      { path: "New", name: "New", specialUse: null, total: 0, unread: 0 },
    ]);
    releaseOld.resolve();
    assert.deepEqual(await oldLoad, [{ path: "Old", name: "Old", specialUse: null, total: 0, unread: 0 }]);
    assert.deepEqual(await workspace.handlers["mail.folders"]({ mailboxId: 1 }), [
      { path: "New", name: "New", specialUse: null, total: 0, unread: 0 },
    ]);
    assert.deepEqual([oldCalls, newCalls], [1, 1]);
  } finally {
    releaseOld.resolve();
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("folder metadata is loaded again after its TTL expires", async () => {
  const prefix = resolve(tmpdir(), "website-mail-folder-ttl-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  seedMailbox({ dir, key });
  let calls = 0, now = 1_800_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  class CountingTransport extends FakeMailTransport {
    override async listFolders(credentials: MailCredentials) {
      calls++;
      return super.listFolders(credentials);
    }
  }
  const transport = new CountingTransport();
  transport.passwords.set("mail@example.test", "saved");
  const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
  try {
    await workspace.handlers["mail.folders"]({ mailboxId: 1 });
    now += 9 * 60_000;
    await workspace.handlers["mail.folders"]({ mailboxId: 1 });
    assert.equal(calls, 1);
    now += 2 * 60_000;
    await workspace.handlers["mail.folders"]({ mailboxId: 1 });
    assert.equal(calls, 2);
  } finally {
    Date.now = realNow;
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected background refresh records lastError and the next stale read retries", async () => {
  const prefix = resolve(tmpdir(), "website-mail-background-retry-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  seedMailbox({ dir, key, syncedAt: Date.now() - 60_000, messages: [{ uid: 1 }] });
  const releaseFailure = deferred();
  const completed = [deferred(), deferred()];
  let attempts = 0;
  class RetryTransport extends FakeMailTransport {
    override async *streamMessages(credentials: MailCredentials, folder: string) {
      await this.verify(credentials);
      const attempt = attempts++;
      try {
        if (attempt === 0) {
          await releaseFailure.promise;
          throw new Error("controlled refresh failure");
        }
        yield { kind: "mailbox" as const, uidValidity: "1" };
        yield { kind: "message" as const, message: remoteMessage(1) };
      } finally {
        completed[attempt]?.resolve();
      }
    }
  }
  const transport = new RetryTransport();
  transport.passwords.set("mail@example.test", "saved");
  const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
  try {
    const cached = await workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" }) as { total: number };
    assert.equal(cached.total, 1);
    releaseFailure.resolve();
    await completed[0].promise;
    let lastError: string | null = null;
    for (let turn = 0; turn < 20 && !lastError; turn++) {
      await new Promise<void>((done) => setImmediate(done));
      lastError = ((await workspace.handlers["mail.list"](undefined)) as { lastError: string | null }[])[0]?.lastError ?? null;
    }
    assert.match(lastError ?? "", /controlled refresh failure/);
    assert.equal((await workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" }) as { total: number }).total, 1);
    await completed[1].promise;
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(attempts, 2);
    assert.equal(((await workspace.handlers["mail.list"](undefined)) as { lastError: string | null }[])[0]?.lastError, null);
  } finally {
    releaseFailure.resolve();
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-Seen flag change publishes changed after an earlier snapshot", async () => {
  const prefix = resolve(tmpdir(), "website-mail-other-flags-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  let now = 1_800_000_000_000;
  seedMailbox({ dir, key, syncedAt: now - 60_000, messages: [{ uid: 1 }] });
  const realNow = Date.now;
  Date.now = () => now;
  const completed = [deferred(), deferred()];
  let calls = 0, flags: string[] = [];
  class FlagTransport extends FakeMailTransport {
    override async *streamMessages(credentials: MailCredentials, folder: string) {
      await this.verify(credentials);
      const call = calls++;
      try {
        yield { kind: "mailbox" as const, uidValidity: "1" };
        yield { kind: "message" as const, message: { ...remoteMessage(1), flags: [...flags] } };
      } finally {
        completed[call]?.resolve();
      }
    }
  }
  const transport = new FlagTransport();
  transport.passwords.set("mail@example.test", "saved");
  const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
  const events: unknown[] = [];
  const unsubscribe = workspace.subscribe((event) => { if (event.kind === "mail") events.push(event.event); });
  try {
    await workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" });
    await completed[0].promise;
    await new Promise<void>((done) => setImmediate(done));
    events.length = 0;
    flags = ["\\Flagged"];
    now += 31_000;
    await workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" });
    await completed[1].promise;
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(events, [{ type: "changed", mailboxId: 1, folder: "INBOX" }]);
  } finally {
    Date.now = realNow;
    unsubscribe();
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sync after markSeen does not publish a duplicate changed event", async () => {
  const prefix = resolve(tmpdir(), "website-mail-seen-snapshot-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  let now = 1_800_000_000_000;
  seedMailbox({ dir, key, syncedAt: now - 60_000, messages: [{ uid: 1 }] });
  const realNow = Date.now;
  Date.now = () => now;
  const completed = [deferred(), deferred()];
  let calls = 0, seen = false;
  class SeenTransport extends FakeMailTransport {
    override async *streamMessages(credentials: MailCredentials, folder: string) {
      await this.verify(credentials);
      const call = calls++;
      try {
        yield { kind: "mailbox" as const, uidValidity: "1" };
        yield { kind: "message" as const, message: remoteMessage(1, { seen }) };
      } finally {
        completed[call]?.resolve();
      }
    }

    override async setSeen(credentials: MailCredentials, folder: string, uid: number, value: boolean) {
      await this.verify(credentials);
      assert.equal(folder, "INBOX");
      assert.equal(uid, 1);
      seen = value;
    }
  }
  const transport = new SeenTransport();
  transport.passwords.set("mail@example.test", "saved");
  const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
  const events: unknown[] = [];
  const unsubscribe = workspace.subscribe((event) => { if (event.kind === "mail") events.push(event.event); });
  try {
    await workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" });
    await completed[0].promise;
    await new Promise<void>((done) => setImmediate(done));
    events.length = 0;
    await workspace.handlers["mail.seen"]({ mailboxId: 1, folder: "INBOX", uid: 1, seen: true });
    assert.deepEqual(events, [{ type: "changed", mailboxId: 1, folder: "INBOX", uid: 1 }]);
    events.length = 0;

    now += 31_000;
    await workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" });
    await completed[1].promise;
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(events, []);
  } finally {
    Date.now = realNow;
    unsubscribe();
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-Seen flag change after workspace restart publishes changed only once", async () => {
  const prefix = resolve(tmpdir(), "website-mail-restart-flags-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  let now = 1_800_000_000_000;
  seedMailbox({ dir, key, syncedAt: now - 60_000, messages: [{ uid: 1 }] });
  const realNow = Date.now;
  Date.now = () => now;
  const completed = [deferred(), deferred(), deferred()];
  let calls = 0, flags: string[] = [];
  class RestartFlagTransport extends FakeMailTransport {
    override async *streamMessages(credentials: MailCredentials, folder: string) {
      await this.verify(credentials);
      const call = calls++;
      try {
        yield { kind: "mailbox" as const, uidValidity: "1" };
        yield { kind: "message" as const, message: { ...remoteMessage(1), flags: [...flags] } };
      } finally {
        completed[call]?.resolve();
      }
    }
  }
  const transport = new RestartFlagTransport();
  transport.passwords.set("mail@example.test", "saved");
  let first = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
  let second: ReturnType<typeof createWorkspace> | undefined;
  try {
    await first.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" });
    await completed[0].promise;
    await new Promise<void>((done) => setImmediate(done));
    await first.close();

    flags = ["\\Flagged"];
    now += 31_000;
    second = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
    const events: unknown[] = [];
    const unsubscribe = second.subscribe((event) => { if (event.kind === "mail") events.push(event.event); });
    try {
      await second.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" });
      await completed[1].promise;
      await new Promise<void>((done) => setImmediate(done));
      assert.deepEqual(events, [{ type: "changed", mailboxId: 1, folder: "INBOX" }]);

      events.length = 0;
      now += 31_000;
      await second.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" });
      await completed[2].promise;
      await new Promise<void>((done) => setImmediate(done));
      assert.deepEqual(events, []);
    } finally {
      unsubscribe();
    }
  } finally {
    Date.now = realNow;
    await first.close();
    await second?.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "a remote deletion publishes changed", remote: [] as RemoteMessage[], expected: [{ type: "changed", mailboxId: 1, folder: "INBOX" }] },
  { name: "a remote seen-flag change publishes changed", remote: [remoteMessage(1, { seen: true })], expected: [{ type: "changed", mailboxId: 1, folder: "INBOX" }] },
  { name: "a UIDVALIDITY reset publishes changed instead of new", remote: [remoteMessage(1, { uidValidity: "2", source: true })], expected: [{ type: "changed", mailboxId: 1, folder: "INBOX" }] },
  { name: "an unchanged mailbox publishes no event", remote: [remoteMessage(1)], expected: [] },
  { name: "a new INBOX message keeps the new event", remote: [remoteMessage(1), remoteMessage(2, { source: true })], expected: [{ type: "new", mailboxId: 1, folder: "INBOX", uid: 2, unreadCount: 2 }] },
]) {
  test(scenario.name, async () => {
    const prefix = resolve(tmpdir(), "website-mail-diff-event-");
    const dir = mkdtempSync(prefix), key = randomBytes(32);
    seedMailbox({ dir, key, syncedAt: Date.now() - 60_000, uidValidity: "1", messages: [{ uid: 1 }] });
    const completed = deferred();
    class DiffTransport extends FakeMailTransport {
      override async *streamMessages(credentials: MailCredentials, folder: string) {
        try {
          await this.verify(credentials);
          yield { kind: "mailbox" as const, uidValidity: scenario.remote[0]?.uidValidity ?? "1" };
          for (const message of scenario.remote) yield { kind: "message" as const, message };
        } finally {
          completed.resolve();
        }
      }
    }
    const transport = new DiffTransport();
    transport.passwords.set("mail@example.test", "saved");
    const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => transport } });
    const events: unknown[] = [];
    const unsubscribe = workspace.subscribe((event) => { if (event.kind === "mail") events.push(event.event); });
    try {
      await workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" });
      await completed.promise;
      await new Promise<void>((done) => setImmediate(done));
      assert.deepEqual(events, scenario.expected);
    } finally {
      unsubscribe();
      await workspace.close();
      if (!resolve(dir).startsWith(prefix)) throw new Error("temporary directory escaped prefix");
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
