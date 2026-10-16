import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openDb } from "./db.ts";
import { handleRequest } from "./rpc.ts";
import { seal, unseal } from "./secrets.ts";

test("workspaces keep account RPC, keys, push listeners and screenshot files separate", async () => {
  const { createWorkspace } = await import("./index.ts");
  const root = mkdtempSync(join(tmpdir(), "website-workspaces-"));
  const aDir = join(root, "a");
  const bDir = join(root, "b");
  const aKey = randomBytes(32);
  const bKey = randomBytes(32);
  const a = createWorkspace({ userDir: aDir, key: aKey });
  const b = createWorkspace({ userDir: bDir, key: bKey });
  try {
    const db = openDb(join(bDir, "website-gen.sqlite"));
    db.prepare("INSERT INTO hostinger_accounts(label, token_ciphertext, token_hint, created_at) VALUES (?, ?, ?, ?)").run("B only", seal(bKey, "b-secret"), "cret", Date.now());
    const row = db.prepare("SELECT token_ciphertext FROM hostinger_accounts").get() as { token_ciphertext: Uint8Array };
    assert.equal(unseal(bKey, row.token_ciphertext), "b-secret");
    assert.throws(() => unseal(aKey, row.token_ciphertext));
    db.close();
    const rpc = (workspace: typeof a, method: string, params?: unknown) => handleRequest(workspace.handlers, { kind: "req", id: 1, method, params });
    assert.deepEqual(await rpc(a, "accounts.list"), { kind: "res", id: 1, ok: true, result: [] });
    const accounts = await rpc(b, "accounts.list");
    assert.ok(accounts.ok && (accounts.result as { label: string }[])[0].label === "B only");
    assert.deepEqual(await rpc(a, "accounts.domains", { id: 1 }), { kind: "res", id: 1, ok: true, result: [] });
    // 即使 QA 记录中混入别人的绝对路径，也不能把文件带回本用户的响应。
    mkdirSync(join(bDir, "work", "qa"), { recursive: true });
    const foreign = join(bDir, "work", "qa", "foreign.png");
    writeFileSync(foreign, "foreign image");
    const ownDb = openDb(join(aDir, "website-gen.sqlite"));
    ownDb.prepare("INSERT INTO batches(entity_json, created_at) VALUES ('{}', ?)").run(Date.now());
    ownDb.prepare("INSERT INTO sites(batch_id, domain, form_json, created_at, updated_at, qa_json) VALUES (1, 'a.example', '{}', ?, ?, ?)").run(Date.now(), Date.now(), JSON.stringify({ checks: [], shots: [{ name: "foreign", file: foreign }] }));
    ownDb.close();
    const qa = await rpc(a, "sites.qa", { siteId: 1 });
    assert.ok(qa.ok);
    assert.deepEqual((qa.result as { shots: unknown[] }).shots, []);
    let aChanges = 0;
    let bChanges = 0;
    const offA = a.subscribe(() => aChanges++);
    const offB = b.subscribe(() => bChanges++);
    await rpc(a, "accounts.sync", { id: 999 });
    assert.equal(aChanges, 1);
    assert.equal(bChanges, 0);
    offA(); offB();
  } finally {
    await a.close(); await b.close();
    rmSync(root, { recursive: true, force: true });
  }
  const response = await handleRequest(a.handlers, { kind: "req", id: 1, method: "accounts.list" });
  assert.equal(response.ok, false);
});

test("workspace manager validates user IDs and opens one workspace per user", async () => {
  const { WorkspaceManager } = await import("./workspaces.ts");
  const root = mkdtempSync(join(tmpdir(), "website-manager-"));
  const manager = new WorkspaceManager({ dataDir: root, masterKey: randomBytes(32) });
  try {
    assert.throws(() => manager.open("../escape"));
    assert.equal(manager.open(1), manager.open(1));
    assert.notEqual(manager.open(1), manager.open(2));
    await manager.close(1);
    assert.equal(manager.get(1), undefined);
    assert.ok(manager.get(2));
  } finally {
    await manager.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("transient read-only workspaces reject modifications and are always closed without becoming active", async () => {
  const { WorkspaceManager } = await import("./workspaces.ts");
  const root = mkdtempSync(join(tmpdir(), "website-manager-readonly-"));
  const manager = new WorkspaceManager({ dataDir: root, masterKey: randomBytes(32) });
  let closed: { handlers: Record<string, (params: unknown) => unknown> } | undefined;
  try {
    manager.open(3);
    await manager.close(3);
    const path = join(root, "users", "3", "website-gen.sqlite");
    const seed = openDb(path);
    seed.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,created_at) VALUES(1,'cached only',x'00','hint',1)").run();
    seed.prepare("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,monitoring) VALUES(1,1,'o','r','support@cached.example','cached.example',0)").run();
    seed.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,subject,body_text) VALUES(1,'INBOX',1,'Cached subject','Cached body')").run();
    seed.close();
    const before = readFileSync(path);
    const beforeTime = statSync(path).mtimeMs;
    await manager.withReadOnly(3, async (workspace) => {
      closed = workspace;
      assert.deepEqual(await workspace.handlers["sites.all"]({}), []);
      assert.throws(() => workspace.handlers["templates.remove"]({ id: 1 }), /只读/);
      const cached = await workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" }) as { total: number };
      assert.equal(cached.total, 1);
      assert.equal((await workspace.handlers["mail.message"]({ mailboxId: 1, folder: "INBOX", uid: 1 }) as { text: string }).text, "Cached body");
      await assert.rejects(Promise.resolve().then(() => workspace.handlers["mail.message"]({ mailboxId: 1, folder: "INBOX", uid: 2 })), /缓存|只读/);
      assert.ok((await workspace.handlers["mail.folders"]({ mailboxId: 1 }) as { path: string }[]).some((folder) => folder.path === "INBOX"));
      assert.equal(manager.get(3), undefined);
    });
    assert.equal(manager.get(3), undefined);
    assert.throws(() => closed!.handlers["sites.all"]({}), /关闭/);
    assert.deepEqual(readFileSync(path), before, "只读查询不能改数据库字节");
    assert.equal(statSync(path).mtimeMs, beforeTime);
    await assert.rejects(manager.withReadOnly(3, async () => { throw new Error("failed read"); }), /failed read/);
    assert.equal(manager.get(3), undefined);
    await assert.rejects(manager.withReadOnly(4, async () => []), /open|打开|database|数据库/i);
    assert.equal(existsSync(join(root, "users", "4")), false, "读取不存在的工作区不能创建目录或数据库");
    const active = manager.open(3);
    await manager.withReadOnly(3, async (workspace) => {
      assert.notEqual(workspace, active, "在线目标也必须使用独立只读连接，不能复用可写工作区");
      assert.equal((await workspace.handlers["mail.messages"]({ mailboxId: 1, folder: "INBOX" }) as { total: number }).total, 1);
    });
    assert.equal(manager.get(3), active);
  } finally {
    await manager.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
});
