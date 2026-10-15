// 模型层：提供方（协议 + 地址 + 加密的 Key + 模型参数）和用途路由都存在 SQLite，运行时组装成 pi-ai 的 Models。
// 模型参数取自 pi-ai 自带的目录，入库时不存 api / provider / baseUrl，运行时由提供方那一行补上。
import type { DatabaseSync } from "node:sqlite";
import { createModels, createProvider, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { ModelRole, ProviderSummary, RoleSummary } from "../shared/protocol.ts";
import { seal, unseal } from "./secrets.ts";

export const ROLES: ModelRole[] = ["agent", "vision", "bulk", "review"];
type Protocol = ProviderSummary["protocol"];
type AnyModel = Model<"openai-completions" | "anthropic-messages">;
type StoredModel = Omit<AnyModel, "api" | "provider" | "baseUrl">;
const API = { openai: "openai-completions", anthropic: "anthropic-messages" } as const;

interface ProviderRow {
  id: number;
  name: string;
  protocol: Protocol;
  base_url: string;
  api_key_ciphertext: Uint8Array | null;
  api_key_hint: string | null;
  models_json: string;
}

const providerRows = (db: DatabaseSync) => db.prepare("SELECT * FROM model_providers ORDER BY id").all() as unknown as ProviderRow[];
const toModel = (row: ProviderRow, m: StoredModel) => ({ ...m, api: API[row.protocol], provider: `p${row.id}`, baseUrl: row.base_url }) as AnyModel;
const modelsOf = (row: ProviderRow) => (JSON.parse(row.models_json) as StoredModel[]).map((m) => toModel(row, m));

export function seedModelDefaults(db: DatabaseSync): void {
  if ((db.prepare("SELECT count(*) AS n FROM model_providers").get() as { n: number }).n > 0) return;
  const catalog = Object.values(DEEPSEEK_MODELS).map(({ api: _a, provider: _p, baseUrl: _b, ...m }) => m);
  db.exec("BEGIN");
  try {
    const ins = db.prepare("INSERT INTO model_providers (name, protocol, base_url, models_json, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id");
    const openai = (ins.get("DeepSeek（OpenAI 格式）", "openai", "https://api.deepseek.com", JSON.stringify(catalog), Date.now()) as { id: number }).id;
    // compat 是 OpenAI 格式专用的兼容参数，不能带到 Anthropic 格式
    ins.get("DeepSeek（Anthropic 格式）", "anthropic", "https://api.deepseek.com/anthropic", JSON.stringify(catalog.map(({ compat: _c, ...m }) => m)), Date.now());
    const role = db.prepare("INSERT INTO model_roles (role, provider_id, model_id, thinking) VALUES (?, ?, ?, ?)");
    role.run("agent", openai, "deepseek-v4-pro", "high");
    role.run("vision", openai, "deepseek-flash", "low");
    role.run("bulk", openai, "deepseek-flash", "low");
    role.run("review", openai, "deepseek-v4-pro", "high");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function listProviders(db: DatabaseSync): ProviderSummary[] {
  return providerRows(db).map((row) => ({
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    hasKey: row.api_key_ciphertext !== null,
    keyHint: row.api_key_hint,
    models: modelsOf(row).map((m) => ({ id: m.id, name: m.name, vision: m.input.includes("image"), thinkingLevels: getSupportedThinkingLevels(m) })),
  }));
}

/** 同一家服务（同一域名）的多个提供方共用一个 Key，例如 DeepSeek 的两种格式。 */
export function setProviderKey(db: DatabaseSync, key: Buffer, providerId: number, apiKey: string): void {
  const value = apiKey.trim();
  if (!value) throw new Error("请填写 API Key");
  const rows = providerRows(db);
  const target = rows.find((r) => r.id === providerId);
  if (!target) throw new Error(`提供方 ${providerId} 不存在`);
  const host = new URL(target.base_url).host;
  const upd = db.prepare("UPDATE model_providers SET api_key_ciphertext = ?, api_key_hint = ? WHERE id = ?");
  for (const r of rows) if (new URL(r.base_url).host === host) upd.run(seal(key, value), value.slice(-4), r.id);
}

export function listRoles(db: DatabaseSync): RoleSummary[] {
  const providers = new Map(providerRows(db).map((r) => [r.id, r]));
  const rows = db.prepare("SELECT role, provider_id, model_id, thinking FROM model_roles").all() as { role: ModelRole; provider_id: number; model_id: string; thinking: string }[];
  return ROLES.flatMap((role) => {
    const r = rows.find((x) => x.role === role);
    if (!r) return [];
    const p = providers.get(r.provider_id)!;
    const problem = !p.api_key_ciphertext
      ? `「${p.name}」还没有设置 Key`
      : !modelsOf(p).some((m) => m.id === r.model_id) ? `模型 ${r.model_id} 已不在「${p.name}」的列表里` : null;
    return [{ role, providerId: r.provider_id, modelId: r.model_id, thinking: r.thinking, ready: problem === null, problem }];
  });
}

export function setRole(db: DatabaseSync, role: ModelRole, choice: { providerId: number; modelId: string; thinking: string }): void {
  if (!ROLES.includes(role)) throw new Error(`未知用途 ${role}`);
  const row = providerRows(db).find((r) => r.id === choice.providerId);
  if (!row) throw new Error(`提供方 ${choice.providerId} 不存在`);
  const model = modelsOf(row).find((m) => m.id === choice.modelId);
  if (!model) throw new Error(`模型 ${choice.modelId} 不在「${row.name}」的列表里`);
  if (role === "vision" && !model.input.includes("image")) throw new Error(`看图用途需要能看图的模型，${model.id} 只支持文字`);
  if (!getSupportedThinkingLevels(model).includes(choice.thinking as ModelThinkingLevel)) {
    throw new Error(`${model.id} 不支持思考强度「${choice.thinking}」`);
  }
  db.prepare("UPDATE model_roles SET provider_id = ?, model_id = ?, thinking = ? WHERE role = ?").run(choice.providerId, choice.modelId, choice.thinking, role);
}

/** 发一句极短的请求验证 Key 和地址（只回复 OK），30 秒超时。 */
export async function pingModel(models: ReturnType<typeof createModels>, model: AnyModel) {
  const t0 = Date.now();
  const msg = await models.completeSimple(
    model,
    { messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: t0 }] },
    { signal: AbortSignal.timeout(30_000), maxTokens: 2000 },
  );
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    const raw = msg.errorMessage ?? "请求失败";
    throw new Error(/401|unauthori[sz]ed|invalid.*key|authentication/i.test(raw) ? "Key 无效，请检查后重新设置" : raw);
  }
  const reply = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  return { ms: Date.now() - t0, reply: reply.slice(0, 40), cost: msg.usage.cost.total };
}

/** 用当前配置组装 pi-ai 的 Models；只注册已设置 Key 的提供方。配置改了就重新调用。 */
/** 流水线用：按用途调一次模型，拿回纯文本和花费。 */
export async function completeText(db: DatabaseSync, key: Buffer, role: ModelRole, prompt: string): Promise<{ text: string; cost: number }> {
  const runtime = buildRuntime(db, key);
  const { model, thinking } = runtime.resolve(role);
  const msg = await runtime.models.completeSimple(
    model,
    { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    { reasoning: thinking === "off" ? undefined : (thinking as Exclude<ModelThinkingLevel, "off">), maxTokens: 16_000, signal: AbortSignal.timeout(5 * 60_000) },
  );
  if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(`模型调用失败：${msg.errorMessage ?? msg.stopReason}`);
  return { text: msg.content.filter((c) => c.type === "text").map((c) => c.text).join(""), cost: msg.usage.cost.total };
}

export function buildRuntime(db: DatabaseSync, key: Buffer) {
  const models = createModels();
  for (const row of providerRows(db)) {
    if (!row.api_key_ciphertext) continue;
    const apiKey = unseal(key, row.api_key_ciphertext);
    models.setProvider(createProvider({
      id: `p${row.id}`,
      name: row.name,
      baseUrl: row.base_url,
      auth: { apiKey: { name: `${row.name} API Key`, resolve: async () => ({ auth: { apiKey }, source: "website-gen" }) } },
      models: modelsOf(row),
      api: row.protocol === "openai" ? openAICompletionsApi() : anthropicMessagesApi(),
    }));
  }
  const roles = db.prepare("SELECT role, provider_id, model_id, thinking FROM model_roles").all() as { role: ModelRole; provider_id: number; model_id: string; thinking: string }[];
  return {
    models,
    resolve(role: ModelRole): { model: AnyModel; thinking: ModelThinkingLevel } {
      const r = roles.find((x) => x.role === role);
      const model = r && (models.getModel(`p${r.provider_id}`, r.model_id) as AnyModel | undefined);
      if (!r || !model) throw new Error(`用途「${role}」还不能用：请先给它的提供方设置 Key`);
      return { model, thinking: r.thinking as ModelThinkingLevel };
    },
  };
}
