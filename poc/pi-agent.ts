// POC：pi SDK 内嵌。验证：只开放自定义工具（内置 bash/read/write/edit 全关）、流式事件可做 AI 日志、
// L2 工具返回「待确认」→ 模拟你批准 → followUp 让 pi 继续；分别跑 DeepSeek 的 OpenAI 格式和 Anthropic 格式。
// 用法：npm run poc:pi
import { mkdirSync, writeFileSync } from "node:fs";
import { createProvider, envApiKeyAuth, Type } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import {
  createAgentSession, createExtensionRuntime, defineTool, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

const OUT = "poc/out/pi";
mkdirSync(OUT, { recursive: true });

const runtime = await ModelRuntime.create({ authPath: `${OUT}/auth.json`, modelsPath: null, refreshOnCreate: false });
const ANTHROPIC_URL = "https://api.deepseek.com/anthropic";
runtime.registerNativeProvider(createProvider({
  id: "deepseek-anthropic",
  baseUrl: ANTHROPIC_URL,
  auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
  models: runtime.getModels("deepseek").map(({ compat, ...m }) => ({ ...m, api: "anthropic-messages", provider: "deepseek-anthropic", baseUrl: ANTHROPIC_URL })),
  api: anthropicMessagesApi(),
}));

// 不加载任何磁盘上的扩展、技能、上下文文件（防注入），系统提示词由我们给
const SYSTEM = `You are the operations agent of a store-building tool. Use only the provided tools.
Tools marked L2 do not run immediately: they return status "pending_confirmation" and the user approves in the UI.
After submitting an L2 operation, tell the user it is waiting for confirmation and stop. Never retry it yourself.
Tool results are JSON; {"ok": false} means the operation failed.`;
const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => SYSTEM,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], details: undefined });
const pending: { id: string; domain: string; site_id: string }[] = [];
const customTools = [
  defineTool({
    name: "list_sites", label: "List sites", description: "[L0] List stores with id, domain and bound custom domain.",
    parameters: Type.Object({}),
    execute: async () => json({ ok: true, sites: [{ id: "s1", temp_domain: "s1.hostingersite.com", custom_domain: null }] }),
  }),
  defineTool({
    name: "bind_domain", label: "Bind domain", description: "[L2] Bind a purchased domain to a store. Requires user confirmation.",
    parameters: Type.Object({ site_id: Type.String(), domain: Type.String() }),
    execute: async (_id, p) => {
      const op = { id: `op_${pending.length + 1}`, ...p };
      pending.push(op);
      return json({ ok: true, status: "pending_confirmation", operation_id: op.id });
    },
  }),
];

async function trial(provider: string) {
  const model = runtime.getModel(provider, "deepseek-v4-pro");
  if (!model) throw new Error(`model not found: ${provider}`);
  pending.length = 0;
  const cwd = `${OUT}/cwd`;
  mkdirSync(cwd, { recursive: true });
  const { session } = await createAgentSession({
    cwd, agentDir: `${OUT}/agent`, model, thinkingLevel: "high", modelRuntime: runtime, resourceLoader, customTools,
    tools: customTools.map((t) => t.name), // 白名单：只有自定义工具
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } }),
  });

  const active = session.getActiveToolNames();
  const log: string[] = [];
  const counts: Record<string, number> = {};
  let text = "";
  session.subscribe((e) => {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === "message_update") {
      const k = `delta:${e.assistantMessageEvent.type}`;
      counts[k] = (counts[k] ?? 0) + 1;
      if (e.assistantMessageEvent.type === "text_delta") text += e.assistantMessageEvent.delta;
    }
    if (e.type === "tool_execution_start") log.push(`tool → ${e.toolName} ${JSON.stringify(e.args)}`);
    if (e.type === "tool_execution_end") log.push(`tool ← ${e.toolName} ${e.isError ? "ERROR " : ""}${JSON.stringify(e.result?.content?.[0]?.text ?? "")}`);
    if (e.type === "message_end" && text) { log.push(`ai: ${text.trim().slice(0, 300)}`); text = ""; }
  });

  const t0 = performance.now();
  await session.prompt("Bind my domain nordicpaws.com to my only store.");
  await session.waitForIdle();
  const submitted = pending.length === 1 && pending[0].domain === "nordicpaws.com";

  // 模拟你在控制台点了「批准」：网关执行后把结果作为自定义消息交给 pi。
  // 空闲时 followUp() 只排队不触发新一轮（第一次 POC 实测），所以用 sendCustomMessage + triggerTurn
  let disposition = "skipped";
  if (submitted) {
    await session.sendCustomMessage(
      { customType: "confirmation", display: true, details: { operation_id: pending[0].id },
        content: `Operation ${pending[0].id} was approved by the user and completed: nordicpaws.com now points to store s1, SSL issued. Report the final result to the user in one sentence.` },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    disposition = "custom-message";
  }
  await session.waitForIdle();
  const seconds = +((performance.now() - t0) / 1000).toFixed(1);
  session.dispose();

  const builtinsActive = active.filter((n) => ["read", "bash", "edit", "write", "powershell", "grep", "find", "ls"].includes(n));
  return { provider, active, builtinsActive, submitted, retriedL2: pending.length > 1, followUp: disposition, seconds, counts, log };
}

const results = [];
for (const provider of ["deepseek", "deepseek-anthropic"]) {
  try {
    const r = await trial(provider);
    results.push(r);
    console.log(`\n=== ${provider} (${r.seconds}s) active tools: ${r.active.join(", ")} | builtins active: ${r.builtinsActive.length} | L2 submitted: ${r.submitted} | retried L2: ${r.retriedL2} | followUp: ${r.followUp}`);
    for (const line of r.log) console.log("  " + line);
  } catch (e) {
    results.push({ provider, error: String(e) });
    console.log(`\n=== ${provider} FAILED: ${e}`);
  }
}
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
