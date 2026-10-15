import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
