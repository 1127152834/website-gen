import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { request as rawRequest } from "node:http";
import { WorkspaceManager } from "../backend/workspaces.ts";
import type { Push } from "../shared/protocol.ts";
import { createApp, type WorkspaceLike, type WorkspaceManagerLike } from "./http.ts";
import { loadMasterKey } from "./keys.ts";

class FakeWorkspace implements WorkspaceLike {
  handlers;
  listeners = new Set<(push: Push) => void>();
  closed = false;
  constructor(userId: number) { this.handlers = { "test.owner": () => ({ userId }) }; }
  subscribe(listener: (push: Push) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(push: Push) { for (const listener of this.listeners) listener(push); }
  async close() { this.closed = true; }
}
class FakeManager implements WorkspaceManagerLike {
  workspaces = new Map<number, FakeWorkspace>();
  open(userId: number) { let workspace = this.workspaces.get(userId); if (!workspace) { workspace = new FakeWorkspace(userId); this.workspaces.set(userId, workspace); } return workspace; }
  get(userId: number) { return this.workspaces.get(userId); }
  async close(userId: number) { await this.workspaces.get(userId)?.close(); this.workspaces.delete(userId); }
  async closeAll() { for (const workspace of this.workspaces.values()) await workspace.close(); this.workspaces.clear(); }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

test("mail attachment downloads require a ready session and are attachment-only, isolated and nosniff", async () => {
  const { manager, request, post, login } = await setup();
  const path = "/api/mail/attachments?mailboxId=7&folder=INBOX&uid=9&partId=1";
  assert.equal((await request(path)).status, 401);
  const admin = await login("admin", "admin password");
  assert.equal((await request(path, { headers: { Cookie: admin.cookie } })).status, 403);
  await post("/api/password", { old: "admin password", new: "changed password" }, admin.cookie);
  const calls: unknown[] = [];
  const workspace = [...manager.workspaces.values()][0];
  Object.assign(workspace, { mailAttachment: async (input: unknown) => {
    calls.push(input);
    return { name: 'unsafe\r\n<img src="https://tracker.example/pixel">.html', type: "text/html", size: 6, data: Buffer.from("<h1>x") };
  } });
  const response = await request(path, { headers: { Cookie: admin.cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition")!, /^attachment;/);
  assert.doesNotMatch(response.headers.get("content-disposition")!, /[\r\n]/);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "<h1>x");
  assert.deepEqual(calls, [{ mailboxId: 7, folder: "INBOX", uid: 9, partId: "1" }]);
  assert.equal((await request(path.replace("mailboxId=7", "mailboxId=NaN"), { headers: { Cookie: admin.cookie } })).status, 400);
  assert.equal(calls.length, 1);
});

test("mail.send allows base64 attachments while ordinary RPC retains the small request limit", async () => {
  const { manager, post, login } = await setup();
  const admin = await login("admin", "admin password");
  await post("/api/password", { old: "admin password", new: "changed password" }, admin.cookie);
  const workspace = [...manager.workspaces.values()][0];
  Object.assign(workspace.handlers, { "mail.send": () => ({ ok: true }) });
  const params = { data: "a".repeat(1024 * 1024 + 1) };
  assert.equal((await post("/api/rpc", { method: "test.owner", params }, admin.cookie)).status, 400);
  const response = await post("/api/rpc", { method: "mail.send", params }, admin.cookie);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { ok: boolean }).ok, true);
});

async function setup(env: NodeJS.ProcessEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "website-gen-http-"));
  const distDir = join(dataDir, "dist");
  mkdirSync(distDir);
  writeFileSync(join(distDir, "index.html"), "<h1>app</h1>");
  writeFileSync(join(dataDir, "secret.txt"), "never expose this");
  const manager = new FakeManager();
  let now = 1_000;
  const app = await createApp({ dataDir, distDir, workspaceManager: manager, clock: () => now, env: { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin password", ...env }, logger: { log() {}, warn() {}, error() {} } });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
  const post = (path: string, body: unknown, cookie?: string, csrf = true) => request(path, { method: "POST", headers: { "Content-Type": "application/json", ...(csrf ? { "X-Requested-With": "website-gen" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const login = async (username: string, password: string) => {
    const response = await post("/api/login", { username, password });
    return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  return { app, manager, request, post, login, dataDir, distDir, setNow: (value: number) => { now = value; } };
}

test("logged-out API is 401 and a POST without the CSRF header is 403", async () => {
  const { request, post, login } = await setup();
  assert.equal((await request("/api/me")).status, 401);
  assert.equal((await request("/api/unknown")).status, 401);
  assert.equal((await post("/api/logout", {})).status, 401);
  assert.equal((await post("/api/rpc", { method: "test.owner" }, undefined, false)).status, 401);
  const loggedIn = await login("admin", "admin password");
  assert.equal((await post("/api/rpc", { method: "test.owner" }, loggedIn.cookie, false)).status, 403);
});

test("parallel failed logins cannot race past the five-attempt limit", async () => {
  const { post } = await setup();
  const responses = await Promise.all(Array.from({ length: 6 }, () => post("/api/login", { username: " admin ", password: "wrong password" })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [401, 401, 401, 401, 401, 429]);
  assert.equal((await post("/api/login", { username: "admin", password: "admin password" })).status, 429);
});

test("forwarded login IPs are used only when TRUST_PROXY is enabled", async () => {
  for (const trusted of [false, true]) {
    const { request } = await setup({ TRUST_PROXY: trusted ? "1" : "0" });
    const attempt = (ip: string) => request("/api/login", { method: "POST", headers: {
      "X-Requested-With": "website-gen", "X-Forwarded-For": `203.0.113.99, ${ip}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ username: "admin", password: "wrong password" }) });
    for (let index = 0; index < 5; index++) assert.equal((await attempt("192.0.2.1")).status, 401);
    assert.equal((await attempt("192.0.2.2")).status, trusted ? 401 : 429);
  }
});

test("oversized usernames are rejected before login-attempt storage", async () => {
  const { app, post } = await setup();
  assert.equal((await post("/api/login", { username: "x".repeat(1000), password: "wrong password" })).status, 400);
  assert.equal((app.admin.db.prepare("SELECT count(*) AS n FROM login_attempts").get() as { n: number }).n, 0);
});

test("simultaneous logins with different usernames have a bounded scrypt queue", async () => {
  const { post } = await setup();
  const responses = await Promise.all(Array.from({ length: 16 }, (_, index) => post("/api/login", { username: `missing${index}`, password: "wrong password" })));
  assert.ok(responses.some((response) => response.status === 429));
  assert.ok(responses.every((response) => response.status === 401 || response.status === 429));
});

test("initial password must be changed before RPC; two users route to isolated workspaces", async () => {
  const { app, post, login } = await setup();
  const adminLogin = await login("admin", "admin password");
  assert.equal(adminLogin.response.status, 200);
  const blocked = await post("/api/rpc", { kind: "req", id: 1, method: "test.owner" }, adminLogin.cookie);
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json() as { code: string }).code, "password_required");
  assert.equal((await post("/api/password", { old: "admin password", new: "admin password" }, adminLogin.cookie)).status, 400);
  assert.equal((await post("/api/password", { old: "admin password", new: "changed password" }, adminLogin.cookie)).status, 200);
  const adminRpc = await post("/api/rpc", { kind: "req", id: 2, method: "test.owner" }, adminLogin.cookie);
  const adminId = ((await adminRpc.json() as { result: { userId: number } }).result.userId);

  const create = await post("/api/admin/users", { username: "bob", password: "initial bob" }, adminLogin.cookie);
  assert.equal(create.status, 201);
  const bobLogin = await login("bob", "initial bob");
  assert.equal(await post("/api/password", { old: "initial bob", new: "changed bob" }, bobLogin.cookie).then((r) => r.status), 200);
  const bobRpc = await post("/api/rpc", { kind: "req", id: 3, method: "test.owner" }, bobLogin.cookie);
  const bobId = ((await bobRpc.json() as { result: { userId: number } }).result.userId);
  assert.notEqual(adminId, bobId);
  assert.equal(adminId, app.admin.listUsers().find((user) => user.username === "admin")!.id);
  assert.equal(bobId, app.admin.listUsers().find((user) => user.username === "bob")!.id);
});

test("logout invalidates the session", async () => {
  const { request, post, login } = await setup();
  const loggedIn = await login("admin", "admin password");
  assert.equal((await request("/api/me", { headers: { Cookie: loggedIn.cookie } })).status, 200);
  assert.equal((await post("/api/logout", {}, loggedIn.cookie)).status, 200);
  assert.equal((await request("/api/me", { headers: { Cookie: loggedIn.cookie } })).status, 401);
});

test("SSE resets a future cursor and a revoked session receives no later push", async () => {
  const { app, manager, request, post, login } = await setup();
  const loggedIn = await login("admin", "admin password");
  await post("/api/password", { old: "admin password", new: "changed password" }, loggedIn.cookie);
  const resetResponse = await request(`/api/events?afterSeq=${Number.MAX_SAFE_INTEGER}`, { headers: { Cookie: loggedIn.cookie } });
  const resetReader = resetResponse.body!.getReader();
  const resetChunk = new TextDecoder().decode((await resetReader.read()).value);
  assert.match(resetChunk, /"reset":true/);
  await resetReader.cancel();

  const stream = await request("/api/events", { headers: { Cookie: loggedIn.cookie } });
  const reader = stream.body!.getReader();
  await post("/api/logout", {}, loggedIn.cookie);
  const userId = app.admin.findUserByUsername("admin")!.id;
  manager.get(userId)!.emit({ kind: "changed", topic: "accounts" });
  assert.equal((await reader.read()).done, true);
});

test("static SPA fallback cannot traverse outside the frontend directory", async () => {
  const { request } = await setup();
  assert.match(await request("/sites/1").then((response) => response.text()), /<h1>app<\/h1>/);
  const traversal = await request("/%2e%2e%2fsecret.txt");
  assert.equal(traversal.status, 404);
  assert.ok(!(await traversal.text()).includes("never expose this"));
});

test("shutdown closes active SSE streams before waiting for the HTTP server", async () => {
  const { app, request, post, login } = await setup();
  const loggedIn = await login("admin", "admin password");
  await post("/api/password", { old: "admin password", new: "changed password" }, loggedIn.cookie);
  const stream = await request("/api/events", { headers: { Cookie: loggedIn.cookie } });
  const reader = stream.body!.getReader();
  const closing = app.close();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = await Promise.race([closing.then(() => true), new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 500); })]);
    assert.equal(closed, true);
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
    await closing;
  }
});

test("static files cannot follow a directory symlink outside dist", async () => {
  const { request, dataDir, distDir } = await setup();
  const outside = join(dataDir, "private");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "private business data");
  symlinkSync(outside, join(distDir, "foreign"), process.platform === "win32" ? "junction" : "dir");
  const response = await request("/foreign/secret.txt");
  assert.equal(response.status, 404);
  assert.ok(!(await response.text()).includes("private business data"));
});

test("a malformed absolute request target returns 400 instead of rejecting the HTTP listener", async () => {
  const { app } = await setup();
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const status = await new Promise<number>((resolve, reject) => {
    const request = rawRequest({ hostname: "127.0.0.1", port: address.port, path: "http://[", method: "GET" }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    request.setTimeout(1000, () => request.destroy(new Error("请求超时")));
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 400);
});

test("a revoked session cannot dispatch an RPC after finishing a slow request body", async () => {
  const { app, manager, post, login } = await setup();
  const loggedIn = await login("admin", "admin password");
  await post("/api/password", { old: "admin password", new: "changed password" }, loggedIn.cookie);
  let dispatched = false;
  manager.get(1)!.handlers["test.owner"] = () => { dispatched = true; return { userId: 1 }; };
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const body = JSON.stringify({ id: 1, method: "test.owner" });
  const received = new Promise<void>((resolve) => app.server.once("request", () => resolve()));
  let request!: ReturnType<typeof rawRequest>;
  const response = new Promise<number>((resolve, reject) => {
    request = rawRequest({ hostname: "127.0.0.1", port: address.port, path: "/api/rpc", method: "POST", headers: {
      Cookie: loggedIn.cookie, "X-Requested-With": "website-gen", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
    } }, (incoming) => { incoming.resume(); resolve(incoming.statusCode!); });
    request.on("error", reject);
    request.write(body.slice(0, 1));
  });
  await received;
  await post("/api/logout", {}, loggedIn.cookie);
  request.end(body.slice(1));
  assert.equal(await response, 401);
  assert.equal(dispatched, false);
});

test("concurrent disable and enable leave the user enabled with a running workspace", async () => {
  const { app, manager, post, login } = await setup();
  const loggedIn = await login("admin", "admin password");
  await post("/api/password", { old: "admin password", new: "changed password" }, loggedIn.cookie);
  await post("/api/admin/users", { username: "bob", password: "initial bob" }, loggedIn.cookie);
  const bob = app.admin.findUserByUsername("bob")!;
  let finish!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const closing = new Promise<void>((resolve) => { started = resolve; });
  const close = manager.close.bind(manager);
  manager.close = async (id) => { started(); await gate; await close(id); };
  const disable = post(`/api/admin/users/${bob.id}/status`, { disabled: true }, loggedIn.cookie);
  await closing;
  const enable = post(`/api/admin/users/${bob.id}/status`, { disabled: false }, loggedIn.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));
  finish();
  assert.equal((await disable).status, 200);
  assert.equal((await enable).status, 200);
  assert.equal(app.admin.getUser(bob.id)!.disabled, false);
  assert.ok(manager.get(bob.id));
  assert.equal(manager.get(bob.id)!.closed, false);
});

test("SSE signals a replay reset when the requested cursor fell out of its retained buffer", async () => {
  const { manager, request, post, login } = await setup();
  const loggedIn = await login("admin", "admin password");
  await post("/api/password", { old: "admin password", new: "changed password" }, loggedIn.cookie);
  for (let index = 0; index < 1002; index++) manager.get(1)!.emit({ kind: "changed", topic: "accounts" });
  const stream = await request("/api/events?afterSeq=1000000", { headers: { Cookie: loggedIn.cookie } });
  const reader = stream.body!.getReader();
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /"reset":true/);
  } finally { await reader.cancel(); }
});

test("SSE replays only this user's pushes strictly after afterSeq", async () => {
  const { manager, request, post, login } = await setup();
  const loggedIn = await login("admin", "admin password");
  await post("/api/password", { old: "admin password", new: "changed password" }, loggedIn.cookie);
  await post("/api/admin/users", { username: "bob", password: "initial bob" }, loggedIn.cookie);
  manager.get(1)!.emit({ kind: "changed", topic: "accounts" });
  manager.get(1)!.emit({ kind: "changed", topic: "changes" });
  manager.get(2)!.emit({ kind: "changed", topic: "batches" });
  const stream = await request("/api/events?afterSeq=1000000", { headers: { Cookie: loggedIn.cookie } });
  const reader = stream.body!.getReader();
  try {
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /id: 1000001/);
    assert.match(chunk, /"topic":"changes"/);
    assert.doesNotMatch(chunk, /"topic":"accounts"|"topic":"batches"/);
  } finally { await reader.cancel(); }
});

test("real workspaces keep user A's accounts invisible to user B's RPC", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "website-gen-isolation-"));
  const manager = new WorkspaceManager({ dataDir, masterKey: loadMasterKey(dataDir, Buffer.alloc(32, 7).toString("base64")) });
  const app = await createApp({ dataDir, workspaceManager: manager, env: { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin password" }, logger: { log() {}, warn() {}, error() {} } });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const post = (path: string, body: unknown, cookie?: string) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "website-gen", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const login = async (username: string, password: string) => {
    const response = await post("/api/login", { username, password });
    return response.headers.get("set-cookie")!.split(";")[0];
  };
  const adminCookie = await login("admin", "admin password");
  await post("/api/password", { old: "admin password", new: "changed password" }, adminCookie);
  const adminId = app.admin.findUserByUsername("admin")!.id;
  const businessDb = new DatabaseSync(join(dataDir, "users", String(adminId), "website-gen.sqlite"));
  businessDb.prepare("INSERT INTO hostinger_accounts (label, token_ciphertext, token_hint, created_at) VALUES (?, ?, ?, ?)").run("admin-only", Buffer.from("sealed"), "1234", 1);
  businessDb.close();
  const adminAccounts = await post("/api/rpc", { kind: "req", id: 1, method: "accounts.list" }, adminCookie).then((r) => r.json()) as { result: unknown[] };
  assert.equal(adminAccounts.result.length, 1);

  await post("/api/admin/users", { username: "bob", password: "initial bob" }, adminCookie);
  const bobCookie = await login("bob", "initial bob");
  await post("/api/password", { old: "initial bob", new: "changed bob" }, bobCookie);
  const bobAccounts = await post("/api/rpc", { kind: "req", id: 2, method: "accounts.list" }, bobCookie).then((r) => r.json()) as { result: unknown[] };
  assert.deepEqual(bobAccounts.result, []);
});
