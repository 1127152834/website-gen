import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { afterEach } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantEvent } from "../shared/protocol.ts";
import { migrate } from "./db.ts";
import { createAssistant, type AssistantSessionFactoryOptions, type AssistantSessionLike } from "./assistant.ts";
import type { AssistantToolDefinition } from "./assistant-tools.ts";
import { openRestrictedSession, restrictedResourceLoader, restrictedToolSelection } from "./agent-session.ts";
import { createProviderConfig, setRole } from "./models.ts";
import { gristToolDefinitions } from "./grist-tools.ts";
import { gristClient } from "./grist.ts";
import { Value } from "typebox/value";

const cleanupTasks: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) await cleanup();
});

class FakeSession implements AssistantSessionLike {
  messages: unknown[] = [];
  isStreaming = false;
  aborted = 0;
  disposed = 0;
  prompts: string[] = [];
  listeners: Array<(event: any) => void> = [];
  async prompt(text: string): Promise<void> { this.prompts.push(text); this.messages.push({ role: "user", content: text }); }
  async abort(): Promise<void> { this.aborted++; }
  dispose(): void { this.disposed++; }
  subscribe(listener: (event: any) => void): () => void { this.listeners.push(listener); return () => {}; }
  emit(event: any): void { for (const listener of this.listeners) listener(event); }
}

function fixture(options: { timeout?: number; tools?: AssistantToolDefinition[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "assistant-test-"));
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const manual = join(dir, "manual.md");
  writeFileSync(manual, "# 手册\n\n## 批量建站\n先创建批次，再检查站点。\n\n### 填写站点\n每个域名一行。\n\n## 邮箱\n在站点页处理。", "utf8");
  const events: AssistantEvent[] = [];
  const sessions: FakeSession[] = [];
  let latest: AssistantSessionFactoryOptions | undefined;
  const assistant = createAssistant({
    userDir: dir,
    db,
    key: () => Buffer.alloc(32, 1),
    manualPath: manual,
    confirmationTimeoutMs: options.timeout ?? 1000,
    getToolDefinitions: () => options.tools ?? [],
    onEvent: (event) => events.push(event),
    createSession: async (input) => {
      latest = input;
      const value = new FakeSession();
      sessions.push(value);
      return value;
    },
  });
  cleanupTasks.push(async () => {
    await assistant.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { assistant, db, events, sessions, tools: () => latest!.tools, systemPrompt: () => latest!.systemPrompt };
}

const riskyTool = (run: (args: any) => unknown = () => ({ ok: true })): AssistantToolDefinition => ({
  method: "sites.launch",
  name: "launch_site",
  description: "上线站点",
  parameters: Type.Object({ siteId: Type.Number(), password: Type.Optional(Type.String()) }),
  risk: "confirm",
  run,
});

const gristBusinessData = {
  records: [{ id: 1, fields: {
    password: "business password", token: "token=business-value", credential: { secret: "business credential" },
    SSN: "000-00-0001", bankAccount: "0000123456", notes: '{"password":"also business data"}',
  } }],
};

for (const [name, args, risk] of [
  ["grist_list_records", { docId: "doc", tableId: "T" }, "read"],
  ["grist_add_records", { docId: "doc", tableId: "T", records: [{ fields: { Name: "new" } }] }, "write"],
  ["grist_remove_records", { docId: "doc", tableId: "T", recordIds: [1] }, "confirm"],
] as const) {
  test(`assistant preserves all Grist business cells in ${risk} tool results`, async () => {
    const client = gristClient({ baseUrl: "https://8.8.8.8", apiKey: "own-grist-key", fetch: async () => Response.json(gristBusinessData) });
    const f = fixture({ tools: gristToolDefinitions(() => client) });
    await f.assistant.history();
    const running = f.tools().find((tool) => tool.name === name)!.run(args);
    if (risk === "confirm") {
      const confirmation = f.events.find((event) => event.type === "confirm");
      assert.ok(confirmation && confirmation.type === "confirm");
      await f.assistant.confirm(confirmation.id, true);
    }
    assert.deepEqual(await running, gristBusinessData);
  });
}

test("assistant preserves cross-user Grist cells but still sanitizes cross-user RPC results", async () => {
  const rpc: AssistantToolDefinition = { method: "sites.all", name: "sites_all", description: "站点", parameters: Type.Object({}), risk: "read", run: () => [] };
  const f = fixture({ tools: [rpc, ...gristToolDefinitions(() => { throw new Error("must not open local Grist"); })] });
  f.assistant.setAdminCapability({
    listUsers: async () => [],
    query: async () => [{ userId: 2, username: "reader", result: gristBusinessData }],
  });
  await f.assistant.history();
  const tool = f.tools().find((tool) => tool.name === "admin_query_user_data")!;
  assert.deepEqual(await tool.run({ method: "grist_list_records", params: { docId: "doc", tableId: "T" } }),
    [{ userId: 2, username: "reader", result: gristBusinessData }]);
  const rpcResult = await tool.run({ method: "sites.all" });
  assert.doesNotMatch(JSON.stringify(rpcResult), /business password|business-value|business credential/);
});

test("Grist settings RPC does not inherit the shared tools' raw-data exception", async () => {
  const f = fixture({ tools: [{
    method: "grist.settings.get", name: "grist_settings_status", description: "连接状态", parameters: Type.Object({}), risk: "read",
    run: () => ({ configured: true, apiKey: "own-key-must-not-leak", keyHint: "1234", password: "hidden" }),
  }] });
  f.assistant.setAdminCapability({
    listUsers: async () => [],
    query: async () => [{ username: "reader", result: { apiKey: "other-key-must-not-leak", keyHint: "5678" } }],
  });
  await f.assistant.history();
  assert.deepEqual(await f.tools().find((tool) => tool.name === "grist_settings_status")!.run({}), { configured: true, keyHint: "1234" });
  assert.deepEqual(await f.tools().find((tool) => tool.name === "admin_query_user_data")!.run({ method: "grist.settings.get" }),
    [{ username: "reader", result: { keyHint: "5678" } }]);
});

test("assistant Grist errors still hide the configured API Key in HTTP and network failures", async () => {
  const key = "opaque-own-grist-key-round1";
  for (const fetch of [
    async () => Response.json({ error: `Rejected ${key}; Authorization: Bearer ${key}` }, { status: 403 }),
    async () => { throw new Error(`Connection failed with ${key}`); },
  ]) {
    const client = gristClient({ baseUrl: "https://8.8.8.8", apiKey: key, fetch });
    const f = fixture({ tools: gristToolDefinitions(() => client) });
    await f.assistant.history();
    const result = await f.tools().find((tool) => tool.name === "grist_list_records")!.run({ docId: "doc", tableId: "T" });
    assert.equal((result as { ok: boolean }).ok, false);
    assert.match(JSON.stringify(result), /已隐藏/);
    assert.ok(!JSON.stringify(result).includes(key));
  }
});

test("admin schema exposes shared Grist reads by tool name but never Grist write or confirm tools", async () => {
  const f = fixture({ tools: gristToolDefinitions(() => { throw new Error("must not call real Grist"); }) });
  const calls: unknown[] = [];
  f.assistant.setAdminCapability({
    listUsers: async () => [],
    query: async (input) => { calls.push(input); return [{ username: "reader", result: [] }]; },
  });
  await f.assistant.history();
  const query = f.tools().find((tool) => tool.name === "admin_query_user_data")!;
  assert.equal(Value.Check(query.parameters, { method: "grist_query_document", params: { docId: "d", sql: "SELECT * FROM T" } }), true);
  assert.equal(Value.Check(query.parameters, { method: "grist_add_records" }), false);
  assert.equal(Value.Check(query.parameters, { method: "grist_remove_records" }), false);
  assert.deepEqual(await query.run({ method: "grist_get_tables", params: { docId: "d" }, userId: 2 }), [{ username: "reader", result: [] }]);
  assert.deepEqual(calls, [{ method: "grist_get_tables", params: { docId: "d" }, userId: 2 }]);
  await f.assistant.close();
});

test("embedded pi disables built-ins and disk resources, exposing only explicit tools", () => {
  assert.deepEqual(restrictedToolSelection([{ name: "one" }, { name: "two" }]), { noTools: "builtin", tools: ["one", "two"] });
  const resources = restrictedResourceLoader("system");
  assert.deepEqual(resources.getExtensions().extensions, []);
  assert.deepEqual(resources.getSkills().skills, []);
  assert.deepEqual(resources.getPrompts().prompts, []);
  assert.deepEqual(resources.getAgentsFiles().agentsFiles, []);
  assert.equal(resources.getSystemPrompt(), "system");
});

test("real pi session exposes only the whitelist and ignores disk context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assistant-real-pi-"));
  writeFileSync(join(dir, "AGENTS.md"), "DISK_CANARY_MUST_NOT_LOAD", "utf8");
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const key = Buffer.alloc(32, 3);
  const providerId = createProviderConfig(db, key, {
    name: "Fake",
    protocol: "openai",
    baseUrl: "https://models.example.test/v1",
    apiKey: "fake-key-never-called",
    models: [{ id: "fake-model", name: "Fake Model", contextWindow: 8192, maxOutputTokens: 1024, vision: false, thinkingLevels: ["off"] }],
  });
  setRole(db, "agent", { providerId, modelId: "fake-model", thinking: "off" });
  const session = await openRestrictedSession({
    cwd: dir,
    sessionDir: join(dir, "sessions"),
    agentDir: join(dir, "agent"),
    db,
    key,
    systemPrompt: "ONLY_THIS_SYSTEM_PROMPT",
    tools: [{ name: "only_allowed", description: "test", parameters: Type.Object({}), run: () => ({ ok: true }) }],
  });
  try {
    assert.deepEqual(session.getActiveToolNames(), ["only_allowed"]);
    assert.match(session.systemPrompt, /^ONLY_THIS_SYSTEM_PROMPT/);
    assert.doesNotMatch(session.systemPrompt, /DISK_CANARY/);
  } finally {
    await session.abort();
    session.dispose();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history without an agent model returns a clear Chinese setup message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assistant-no-model-"));
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const assistant = createAssistant({ userDir: dir, db, key: () => Buffer.alloc(32), getToolDefinitions: () => [], onEvent: () => {} });
  cleanupTasks.push(async () => { await assistant.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(() => assistant.history(), /建站与对话.*设置页配置模型和 Key/);
});

test("assistant records page context but hides it from displayed history", async () => {
  const f = fixture();
  await f.assistant.history();
  assert.match(f.systemPrompt(), /^所有对用户可见的文字（包括调用工具前的说明）都用中文。/);
  await f.assistant.send("我在看什么？", "/sites/12/overview");
  assert.equal(f.sessions[0].prompts[0], "[当前页面：/sites/12/overview；请用中文回复]\n我在看什么？");
  const history = await f.assistant.history();
  assert.deepEqual(history.items, [{ role: "user", text: "我在看什么？" }]);
});

test("assistant keeps the Chinese hint on consecutive prompts and strips the new context format", async () => {
  const f = fixture();
  await f.assistant.send("第一次", "/sites/12/overview");
  await f.assistant.send("第二次", "/tables；part");
  f.sessions[0].messages.push({ role: "user", content: "[当前页面：/path；part]\n旧格式" });
  assert.deepEqual(f.sessions[0].prompts, [
    "[当前页面：/sites/12/overview；请用中文回复]\n第一次",
    "[当前页面：/tables；part；请用中文回复]\n第二次",
  ]);
  const history = await f.assistant.history();
  assert.deepEqual(history.items, [
    { role: "user", text: "第一次" },
    { role: "user", text: "第二次" },
    { role: "user", text: "旧格式" },
  ]);
});

test("manual tool reads only the matching section", async () => {
  const f = fixture();
  await f.assistant.history();
  const tool = f.tools().find((candidate) => candidate.name === "read_user_manual")!;
  const result = await tool.run({ query: "批量建站" }) as { content: string };
  assert.match(result.content, /先创建批次/);
  assert.match(result.content, /每个域名一行/, "读取父章节必须包含子章节，而非仅返回标题");
  assert.doesNotMatch(result.content, /站点页处理/);
});

test("confirm tool waits, sanitizes confirmation and audits successful approval", async () => {
  let calls = 0;
  const f = fixture({ tools: [riskyTool(() => { calls++; return { ok: true, token: "leak", hint: "kept" }; })] });
  await f.assistant.history();
  const running = f.tools().find((candidate) => candidate.name === "launch_site")!.run({ siteId: 7, password: "secret" });
  await new Promise((resolve) => setImmediate(resolve));
  const confirmation = f.events.find((event) => event.type === "confirm");
  assert.ok(confirmation && confirmation.type === "confirm");
  assert.deepEqual(confirmation.args, { siteId: 7 });
  assert.equal(calls, 0);
  assert.equal(await f.assistant.confirm(confirmation.id, true), true);
  assert.deepEqual(await running, { ok: true, hint: "kept" });
  assert.equal(calls, 1);
  const row = f.db.prepare("SELECT tool, params_json, risk, confirmed, success FROM assistant_tool_audit").get() as any;
  assert.deepEqual({ ...row }, { tool: "launch_site", params_json: '{"siteId":7}', risk: "confirm", confirmed: 1, success: 1 });
});

test("audit prewrite failure fails closed before a write tool can run", async () => {
  let calls = 0;
  const write: AssistantToolDefinition = { name: "write_once", description: "普通修改", parameters: Type.Object({}), risk: "write", run: () => { calls++; return { ok: true }; } };
  const f = fixture({ tools: [write] });
  f.db.exec(`CREATE TRIGGER reject_audit_insert BEFORE INSERT ON assistant_tool_audit BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`);
  await f.assistant.history();
  const result = await f.tools().find((tool) => tool.name === "write_once")!.run({});
  assert.deepEqual(result, { ok: false, error: "审计记录失败，没有执行" });
  assert.equal(calls, 0);
});

test("audit finalization failure preserves a successful business result and warns against retry", async () => {
  let calls = 0;
  const write: AssistantToolDefinition = { name: "write_once", description: "普通修改", parameters: Type.Object({}), risk: "write", run: () => { calls++; return { ok: true, changed: 1 }; } };
  const f = fixture({ tools: [write] });
  f.db.exec(`CREATE TRIGGER reject_audit_update BEFORE UPDATE ON assistant_tool_audit BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`);
  await f.assistant.history();
  const result = await f.tools().find((tool) => tool.name === "write_once")!.run({});
  assert.deepEqual(result, { ok: true, changed: 1, auditWarning: "操作已经完成，但审计状态更新失败；请勿重复执行。" });
  assert.equal(calls, 1);
  const row = f.db.prepare("SELECT success, error FROM assistant_tool_audit").get() as any;
  assert.deepEqual({ ...row }, { success: 0, error: "pending" });
});

test("cancel and timeout never execute confirm tools", async () => {
  let calls = 0;
  const f = fixture({ timeout: 15, tools: [riskyTool(() => { calls++; })] });
  await f.assistant.history();
  const tool = f.tools().find((candidate) => candidate.name === "launch_site")!;
  const cancelled = tool.run({ siteId: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const first = f.events.find((event) => event.type === "confirm")!;
  assert.equal(await f.assistant.confirm(first.id, false), true);
  assert.deepEqual(await cancelled, { ok: false, cancelled: true, error: "用户未确认，没有执行" });
  const timedOut = tool.run({ siteId: 2 });
  assert.deepEqual(await timedOut, { ok: false, cancelled: true, error: "用户未确认，没有执行" });
  assert.equal(calls, 0);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM assistant_tool_audit WHERE success=0").get() as { n: number }).n, 2);
});

test("stop and reset cancel every pending confirmation", async () => {
  const f = fixture({ tools: [riskyTool()] });
  await f.assistant.history();
  const tool = f.tools().find((candidate) => candidate.name === "launch_site")!;
  const stopped = tool.run({ siteId: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  await f.assistant.abort();
  assert.equal((await stopped as any).cancelled, true);
  await f.assistant.history();
  const currentTool = f.tools().find((candidate) => candidate.name === "launch_site")!;
  const reset = currentTool.run({ siteId: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.assistant.history()).pending.length, 1, "新对话必须取消真正挂起的确认，而非仅拒绝旧工具");
  await f.assistant.reset();
  assert.equal((await reset as any).cancelled, true);
  assert.equal(f.sessions[0].aborted >= 1, true);
  assert.equal(f.sessions.length, 3);
});

test("a stale confirm tool cannot create a new confirmation after stop", async () => {
  const f = fixture({ timeout: 10, tools: [riskyTool()] });
  await f.assistant.history();
  const stale = f.tools().find((tool) => tool.name === "launch_site")!;
  await f.assistant.abort();
  const result = await stale.run({ siteId: 99 });
  assert.equal(f.events.some((event) => event.type === "confirm"), false);
  assert.deepEqual(result, { ok: false, cancelled: true, error: "对话已停止或切换，没有执行" });
});

test("a confirmed tool cancelled by an immediate stop is audited as confirmed but unsuccessful", async () => {
  const f = fixture({ tools: [riskyTool()] });
  await f.assistant.history();
  const running = f.tools().find((candidate) => candidate.name === "launch_site")!.run({ siteId: 9 });
  await new Promise((resolve) => setImmediate(resolve));
  const confirmation = f.events.find((event) => event.type === "confirm")!;
  void f.assistant.confirm(confirmation.id, true);
  await f.assistant.abort();
  assert.equal((await running as any).cancelled, true);
  const row = f.db.prepare("SELECT confirmed, success FROM assistant_tool_audit ORDER BY id DESC LIMIT 1").get() as any;
  assert.deepEqual({ ...row }, { confirmed: 1, success: 0 });
});

test("a rejected prompt from a detached old session cannot emit an error", async () => {
  const f = fixture();
  await f.assistant.history();
  let rejectPrompt!: (error: Error) => void;
  f.sessions[0].prompt = () => new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
  await f.assistant.send("test", "/");
  const stopping = f.assistant.abort();
  rejectPrompt(new Error("apiKey=should-not-leak"));
  await stopping;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.events.some((event) => event.type === "error"), false);
});

test("concurrent sends are rejected before pi marks itself streaming", async () => {
  const f = fixture();
  await f.assistant.history();
  let release!: () => void;
  f.sessions[0].prompt = () => new Promise<void>((resolve) => { release = resolve; });
  await f.assistant.send("first", "/");
  await assert.rejects(() => f.assistant.send("second", "/"), /还在回复/);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await f.assistant.send("third", "/");
});

test("admin tools are absent by default, read-only, and disappear immediately after revocation", async () => {
  const read: AssistantToolDefinition = { method: "sites.list", name: "list_sites", description: "站点列表", parameters: Type.Object({}), risk: "read", run: () => [] };
  const write: AssistantToolDefinition = { method: "sites.retry", name: "retry_site", description: "重试", parameters: Type.Object({}), risk: "write", run: () => ({ ok: true }) };
  const f = fixture({ tools: [read, write] });
  await f.assistant.history();
  assert.equal(f.tools().some((tool) => tool.name.startsWith("admin_")), false);
  const queries: unknown[] = [];
  await f.assistant.setAdminCapability({
    listUsers: async () => [{ id: 1, username: "alice" }, { id: 2, username: "bob" }],
    query: async (input) => { queries.push(input); return [{ username: "alice", result: [] }]; },
  });
  await f.assistant.history();
  const adminQuery = f.tools().find((tool) => tool.name === "admin_query_user_data")!;
  assert.deepEqual(await adminQuery.run({ method: "sites.list" }), [{ username: "alice", result: [] }]);
  assert.deepEqual(await adminQuery.run({ method: "sites.retry" }), { ok: false, error: "只允许跨用户执行已登记的只读查询" });
  assert.equal(queries.length, 1);
  await f.assistant.setAdminCapability(undefined);
  await f.assistant.history();
  assert.equal(f.tools().some((tool) => tool.name.startsWith("admin_")), false);
});

test("revocation is synchronous and a stale session cannot execute tools", async () => {
  let writes = 0;
  const write: AssistantToolDefinition = { method: "sites.retry", name: "retry_site", description: "重试", parameters: Type.Object({}), risk: "write", run: () => { writes++; return { ok: true }; } };
  const f = fixture({ tools: [write] });
  await f.assistant.history();
  const stale = f.tools().find((tool) => tool.name === "retry_site")!;
  f.assistant.setAdminCapability({ listUsers: async () => [], query: async () => [] });
  f.sessions[0].emit({ type: "agent_settled", aborted: true });
  assert.equal(f.events.some((event) => event.type === "settled"), false);
  assert.deepEqual(await stale.run({}), { ok: false, cancelled: true, error: "对话已停止或切换，没有执行" });
  assert.equal(writes, 0);
  await f.assistant.history();
  assert.equal(f.tools().some((tool) => tool.name === "admin_list_users"), true);
});

test("an approval arriving at or after expiresAt is rejected even before the timer callback runs", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const f = fixture({ timeout: 1000, tools: [riskyTool()] });
    await f.assistant.history();
    const running = f.tools().find((tool) => tool.name === "launch_site")!.run({ siteId: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    const confirmation = f.events.find((event) => event.type === "confirm")!;
    now = confirmation.expiresAt;
    assert.equal(await f.assistant.confirm(confirmation.id, true), false);
    assert.equal((await running as any).cancelled, true);
  } finally {
    Date.now = realNow;
  }
});

test("a new session waits for the detached session to finish aborting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assistant-barrier-"));
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const manual = join(dir, "manual.md");
  writeFileSync(manual, "# 手册", "utf8");
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
  let created = 0;
  const assistant = createAssistant({
    userDir: dir, db, key: () => Buffer.alloc(32), manualPath: manual,
    getToolDefinitions: () => [], onEvent: () => {},
    createSession: async () => {
      created++;
      const value = new FakeSession();
      if (created === 1) value.abort = async () => { await abortGate; };
      return value;
    },
  });
  cleanupTasks.push(async () => { await assistant.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  await assistant.history();
  assistant.setAdminCapability({ listUsers: async () => [], query: async () => [] });
  const reopening = assistant.history();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created, 1);
  releaseAbort();
  await reopening;
  assert.equal(created, 2);
});
