// POC：DeepSeek 在 OpenAI 格式和 Anthropic 格式下的多轮工具调用 + 看图。
// 用法：npm run poc:deepseek    （看图需要先有 poc/out/qa.png）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createModels, createProvider, envApiKeyAuth, Type, type Context, type Model, type Tool } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";

const models = createModels();
models.setProvider(deepseekProvider()); // OpenAI 格式：pi 内置
const ANTHROPIC_URL = "https://api.deepseek.com/anthropic";
models.setProvider(createProvider({ // Anthropic 格式：同一批模型，换协议和地址
  id: "deepseek-anthropic",
  baseUrl: ANTHROPIC_URL,
  auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
  models: models.getModels("deepseek").map(({ compat, ...m }) => ({ ...m, api: "anthropic-messages", provider: "deepseek-anthropic", baseUrl: ANTHROPIC_URL })),
  api: anthropicMessagesApi(),
}));

// 假数据：s2 故意返回失败，按方案 6.2 的约定把错误写在结果正文里
const SITES = [{ id: "s1", domain: "nordicpaws.com" }, { id: "s2", domain: "kitchenly.shop" }, { id: "s3", domain: "glowlab.store" }];
const HEALTH: Record<string, object> = {
  s1: { ok: true, ssl_expires: "2026-12-01" },
  s2: { ok: false, error: "site unreachable: timeout after 10s" },
  s3: { ok: true, ssl_expires: "2026-10-29" },
};
const tools: Tool[] = [
  { name: "list_sites", description: "List all stores with their id and domain.", parameters: Type.Object({}) },
  { name: "get_site_health", description: "Get SSL expiry date and status for one store.", parameters: Type.Object({ site_id: Type.String() }) },
];
const runTool = (name: string, args: Record<string, unknown>) =>
  JSON.stringify(name === "list_sites" ? { ok: true, sites: SITES } : HEALTH[String(args.site_id)] ?? { ok: false, error: "unknown site_id" });

async function toolLoop(model: Model) {
  const ctx: Context = {
    systemPrompt: "You operate a fleet of online stores. Use tools to get facts; never guess.",
    tools,
    messages: [{ role: "user", content: "Which store's SSL certificate expires soonest? Also tell me if any store could not be checked.", timestamp: Date.now() }],
  };
  let calls = 0, cost = 0, thinking = false;
  for (let turn = 1; turn <= 8; turn++) {
    const msg = await models.completeSimple(model, ctx, { reasoning: "high" });
    if (msg.stopReason === "error") throw new Error(msg.errorMessage);
    cost += msg.usage.cost.total;
    thinking ||= msg.content.some((c) => c.type === "thinking" && c.thinking.length > 0);
    ctx.messages.push(msg);
    const toolCalls = msg.content.filter((c) => c.type === "toolCall");
    if (toolCalls.length === 0) {
      const text = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      const correct = /glowlab/i.test(text) && /kitchenly/i.test(text);
      return { turns: turn, calls, cost, thinking, correct, text };
    }
    for (const tc of toolCalls) {
      calls++;
      ctx.messages.push({ role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: [{ type: "text", text: runTool(tc.name, tc.arguments) }], isError: false, timestamp: Date.now() });
    }
  }
  throw new Error("tool loop did not finish in 8 turns");
}

async function vision(model: Model, png: string) {
  const msg = await models.completeSimple(model, {
    messages: [{ role: "user", timestamp: Date.now(), content: [
      { type: "image", data: png, mimeType: "image/png" },
      { type: "text", text: 'Screenshot of a store product page. Reply with JSON only: {"product_name": string, "price": string|null, "add_to_cart_visible": boolean, "issues": string[]}' },
    ] }],
  });
  if (msg.stopReason === "error") throw new Error(msg.errorMessage);
  const text = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  return { cost: msg.usage.cost.total, correct: /59\.99/.test(text), text };
}

const results: Record<string, unknown> = {};
async function run(label: string, fn: () => Promise<Record<string, unknown>>) {
  const t0 = performance.now();
  try {
    const r = await fn();
    results[label] = { ...r, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
    console.log(`✔ ${label}`, JSON.stringify({ ...r, text: undefined, seconds: results[label] && (results[label] as { seconds: number }).seconds }));
  } catch (e) {
    results[label] = { error: String(e) };
    console.log(`✘ ${label}`, String(e));
  }
}

const get = (provider: string, id: string) => {
  const m = models.getModel(provider, id);
  if (!m) throw new Error(`model not found: ${provider}/${id}`);
  return m;
};

for (const provider of ["deepseek", "deepseek-anthropic"]) {
  for (const id of ["deepseek-v4-pro", "deepseek-flash"]) await run(`tools ${provider}/${id}`, () => toolLoop(get(provider, id)));
}
if (existsSync("poc/out/qa.png")) {
  const png = readFileSync("poc/out/qa.png").toString("base64");
  for (const provider of ["deepseek", "deepseek-anthropic"]) await run(`vision ${provider}/deepseek-flash`, () => vision(get(provider, "deepseek-flash"), png));
} else console.log("skip vision: poc/out/qa.png not found");

mkdirSync("poc/out", { recursive: true });
writeFileSync("poc/out/deepseek.json", JSON.stringify(results, null, 2));
console.log("full output → poc/out/deepseek.json");
