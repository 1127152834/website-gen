import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { openAdminStore } from "./admin-db.ts";
import { createAssistantAdminAccess } from "./assistant-access.ts";
import type { GristClient } from "../backend/grist.ts";
import { gristClient } from "../backend/grist.ts";

async function fixture() {
  const admin = openAdminStore(":memory:");
  const owner = await admin.addUser({ username: "owner", password: "owner password", role: "admin", now: 1 });
  const other = await admin.addUser({ username: "other", password: "other password", now: 1 });
  const calls: { userId: number; method: string; params: unknown }[] = [];
  const open = (userId: number) => ({ handlers: {
      "sites.all": (params: unknown) => { calls.push({ userId, method: "sites.all", params }); return [{ domain: `${userId}.example`, password: "hidden", nested: { apiKey: "hidden", keyHint: "1234" } }]; },
      "models.delete": () => { throw new Error("must never execute"); },
    } });
  const access = (actorId: number) => createAssistantAdminAccess({ actorId, admin, workspaceManager: {
    open() { throw new Error("must use the read-only capability even for enabled users"); },
    withReadOnly: async (userId, read) => read(open(userId)),
  } });
  return { admin, owner, other, calls, access };
}

test("assistant admin queries group data by username and sanitize every user's result", async () => {
  const f = await fixture();
  try {
    const access = f.access(f.owner.id);
    assert.deepEqual(await access.listUsers(), [{ id: f.owner.id, username: "owner" }, { id: f.other.id, username: "other" }]);
    const result = await access.query({ method: "sites.all", params: {} });
    assert.deepEqual(result, [
      { userId: f.owner.id, username: "owner", result: [{ domain: `${f.owner.id}.example`, nested: { keyHint: "1234" } }] },
      { userId: f.other.id, username: "other", result: [{ domain: `${f.other.id}.example`, nested: { keyHint: "1234" } }] },
    ]);
    assert.equal(f.calls.length, 2);
  } finally { f.admin.close(); }
});

test("ordinary users are denied even when directly invoking the cross-user capability", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.access(f.other.id).listUsers(), /管理员/);
    await assert.rejects(f.access(f.other.id).query({ method: "sites.all" }), /管理员/);
    assert.equal(f.calls.length, 0);
  } finally { f.admin.close(); }
});

test("cross-user writes, confirms, internal and unregistered methods are rejected before opening targets", async () => {
  const f = await fixture();
  try {
    for (const method of ["models.delete", "batches.create", "assistant.send", "mail.password", "grist_remove_records", "grist_add_records", "grist_update_table_column", "toString", "missing.read"]) {
      await assert.rejects(f.access(f.owner.id).query({ method, userId: f.other.id }), /只读|查询/);
    }
    await assert.rejects(f.access(f.owner.id).query({ method: "sites.all", userId: "../1" }), /用户/);
    assert.equal(f.calls.length, 0);
  } finally { f.admin.close(); }
});

test("admin can use shared read-only Grist definitions across users but cannot use Grist writes", async () => {
  const f = await fixture();
  try {
    let writes = 0;
    const access = createAssistantAdminAccess({ actorId: f.owner.id, admin: f.admin, workspaceManager: {
      open() { throw new Error("must use read-only"); },
      async withReadOnly(userId, read) { return read({ handlers: {}, gristClient: () => ({
        getTables: () => ({ tables: [{ id: `User${userId}`, secret: "hidden" }] }),
        addRecords: () => { writes++; },
      }) as unknown as GristClient }); },
    } });
    assert.deepEqual(await access.query({ method: "grist_get_tables", params: { docId: "doc" } }), [
      { userId: f.owner.id, username: "owner", result: { tables: [{ id: `User${f.owner.id}`, secret: "hidden" }] } },
      { userId: f.other.id, username: "other", result: { tables: [{ id: `User${f.other.id}`, secret: "hidden" }] } },
    ]);
    await assert.rejects(access.query({ method: "grist_add_records", params: { docId: "doc", tableId: "T", records: [{ fields: {} }] } }), /只读/);
    assert.equal(writes, 0);
  } finally { f.admin.close(); }
});

test("cross-user shared Grist records preserve business columns while errors hide each user's API Key", async () => {
  const f = await fixture();
  try {
    let failing = false;
    const records = { records: [{ id: 1, fields: {
      password: "business password", token: "token=business-value", credential: "business credential",
      SSN: "000-00-0001", bankAccount: "0000123456",
    } }] };
    const access = createAssistantAdminAccess({ actorId: f.owner.id, admin: f.admin, workspaceManager: {
      open() { throw new Error("must use read-only"); },
      async withReadOnly(userId, read) {
        const key = `opaque-grist-key-user-${userId}`;
        return read({ handlers: {}, gristClient: () => gristClient({
          baseUrl: "https://8.8.8.8", apiKey: key,
          fetch: async () => failing ? Response.json({ error: `Rejected ${key}` }, { status: 403 }) : Response.json(records),
        }) });
      },
    } });
    const query = { method: "grist_list_records", params: { docId: "doc", tableId: "T" } };
    assert.deepEqual(await access.query(query), [
      { userId: f.owner.id, username: "owner", result: records },
      { userId: f.other.id, username: "other", result: records },
    ]);
    failing = true;
    const errors = await access.query(query) as { result: { ok: boolean; error: string } }[];
    assert.equal(errors.length, 2);
    assert.ok(errors.every(({ result }) => result.ok === false && result.error.includes("已隐藏")));
    assert.doesNotMatch(JSON.stringify(errors), /opaque-grist-key-user-/);
    await assert.rejects(access.query({ method: "grist.listRecords", params: query.params }), /只读/);
  } finally { f.admin.close(); }
});

test("cached cross-user capabilities expire immediately on demotion or disable", async () => {
  const f = await fixture();
  try {
    const access = f.access(f.owner.id);
    await access.query({ method: "sites.all", userId: f.other.id });
    f.admin.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(f.owner.id);
    await assert.rejects(access.query({ method: "sites.all" }), /管理员/);
    f.admin.db.prepare("UPDATE users SET role = 'admin', disabled = 1 WHERE id = ?").run(f.owner.id);
    await assert.rejects(access.listUsers(), /管理员/);
    assert.equal(f.calls.length, 1);
  } finally { f.admin.close(); }
});

test("disabled target data uses a transient read-only workspace instead of reactivating its tasks", async () => {
  const f = await fixture();
  try {
    f.admin.db.prepare("UPDATE users SET disabled=1 WHERE id=?").run(f.other.id);
    let transient = 0;
    const access = createAssistantAdminAccess({ actorId: f.owner.id, admin: f.admin, workspaceManager: {
      open() { throw new Error("disabled workspace must not be activated"); },
      async withReadOnly(userId, read) {
        transient++;
        assert.equal(userId, f.other.id);
        return read({ handlers: { "sites.all": () => [{ domain: "disabled.example" }] } });
      },
    } });
    assert.deepEqual(await access.query({ method: "sites.all", userId: f.other.id }), [
      { userId: f.other.id, username: "other", result: [{ domain: "disabled.example" }] },
    ]);
    assert.equal(transient, 1);
  } finally { f.admin.close(); }
});

test("demotion while awaiting a target read prevents the result from being returned", async () => {
  const f = await fixture();
  try {
    let finish!: (value: unknown) => void;
    const access = createAssistantAdminAccess({ actorId: f.owner.id, admin: f.admin, workspaceManager: {
      open() { throw new Error("must use read-only"); },
      async withReadOnly(_userId, read) { return read({ handlers: { "sites.all": () => new Promise((resolve) => { finish = resolve; }) } }); },
    } });
    const pending = access.query({ method: "sites.all", userId: f.other.id });
    f.admin.db.prepare("UPDATE users SET role='user' WHERE id=?").run(f.owner.id);
    finish([{ private: "must not return" }]);
    await assert.rejects(pending, /管理员/);
  } finally { f.admin.close(); }
});

test("container build retains the assistant business manual", () => {
  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  const ignored = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY \. \./);
  assert.doesNotMatch(ignored, /^(?:docs\/?|\*\.md|\*\*\/\*\.md)$/m);
  assert.match(readFileSync(new URL("../../docs/user-manual.md", import.meta.url), "utf8"), /独立站 AI 工厂/);
});
