// 模型层：每个用户可以维护自己的提供方、独立 Key、模型目录和用途路由。
// 数据库存 pi-ai 可直接使用的模型形状；RPC 只返回安全的展示字段，绝不返回 Key 明文。
import type { DatabaseSync } from "node:sqlite";
import { createModels, createProvider, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { ModelRole, ProviderSummary, RoleSummary } from "../shared/protocol.ts";
import { seal, unseal } from "./secrets.ts";
import { withModelRetry } from "./model-retry.ts";

export const ROLES: ModelRole[] = ["agent", "vision", "bulk", "review"];
type Protocol = ProviderSummary["protocol"];
type AnyModel = Model<"openai-completions" | "anthropic-messages">;
type StoredModel = Omit<AnyModel, "api" | "provider" | "baseUrl">;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const API = { openai: "openai-completions", anthropic: "anthropic-messages" } as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "max"] as const;
const ROLE_NAMES: Record<ModelRole, string> = { agent: "建站与对话", vision: "看截图", bulk: "批量文案", review: "合规审查" };

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ProviderModelInput {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  thinkingLevels: string[];
  price?: ModelPrice;
}

export interface ProviderModel extends ProviderModelInput {}

export interface ProviderDetail extends Omit<ProviderSummary, "models"> {
  models: ProviderModel[];
}

export interface ModelProviderPreset {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
}

export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  { id: "deepseek-openai", name: "DeepSeek（OpenAI 格式）", protocol: "openai", baseUrl: "https://api.deepseek.com" },
  { id: "deepseek-anthropic", name: "DeepSeek（Anthropic 格式）", protocol: "anthropic", baseUrl: "https://api.deepseek.com/anthropic" },
  { id: "openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "openrouter", name: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "siliconflow", name: "硅基流动", protocol: "openai", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "moonshot", name: "Moonshot", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "zhipu", name: "智谱", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "qwen", name: "通义千问（DashScope）", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "custom", name: "自定义", protocol: "openai", baseUrl: "" },
];

interface ProviderRow {
  id: number;
  name: string;
  protocol: Protocol;
  base_url: string;
  api_key_ciphertext: Uint8Array | null;
  api_key_hint: string | null;
  models_json: string;
  created_at: number;
}

const providerRows = (db: DatabaseSync) => db.prepare("SELECT * FROM model_providers ORDER BY id").all() as unknown as ProviderRow[];
const toModel = (row: ProviderRow, model: StoredModel) => ({ ...model, api: API[row.protocol], provider: `p${row.id}`, baseUrl: row.base_url }) as AnyModel;
const storedModelsOf = (row: ProviderRow) => JSON.parse(row.models_json) as StoredModel[];
const modelsOf = (row: ProviderRow) => storedModelsOf(row).map((model) => toModel(row, model));

function cleanName(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new Error(`请填写${label}`);
  if (result.length > 120) throw new Error(`${label}不能超过 120 个字符`);
  return result;
}

function cleanBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Base URL 格式不正确");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Base URL 只能使用 http 或 https");
  if (url.username || url.password) throw new Error("Base URL 不能包含账号或密码");
  if (url.search || url.hash) throw new Error("Base URL 不能包含查询参数或片段");
  return url.toString().replace(/\/$/, "");
}

function redactRemoteText(value: string, secrets: string[] = []): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[已隐藏]");
  return result
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi, "$1[已隐藏]")
    .replace(/(x-api-key\s*[:=]\s*)[^\s,;"']+/gi, "$1[已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-…[已隐藏]");
}

function cleanProtocol(value: string): Protocol {
  if (value !== "openai" && value !== "anthropic") throw new Error(`不支持的模型协议：${value}`);
  return value;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function normalizePublicModel(input: ProviderModelInput): ProviderModel {
  const id = cleanName(String(input.id ?? ""), "模型 ID");
  const name = cleanName(String(input.name ?? id), "模型显示名称");
  const contextWindow = Math.max(1, Math.trunc(finiteNonNegative(Number(input.contextWindow), 128_000)));
  const maxOutputTokens = Math.max(1, Math.trunc(finiteNonNegative(Number(input.maxOutputTokens), 8_192)));
  const thinkingLevels = [...new Set((input.thinkingLevels ?? ["off"]).map(String).filter((level) => THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])))];
  if (!thinkingLevels.length) thinkingLevels.push("off");
  const price = input.price ? {
    input: finiteNonNegative(Number(input.price.input), 0),
    output: finiteNonNegative(Number(input.price.output), 0),
    ...(input.price.cacheRead === undefined ? {} : { cacheRead: finiteNonNegative(Number(input.price.cacheRead), 0) }),
    ...(input.price.cacheWrite === undefined ? {} : { cacheWrite: finiteNonNegative(Number(input.price.cacheWrite), 0) }),
  } : undefined;
  return { id, name, contextWindow, maxOutputTokens, vision: Boolean(input.vision), thinkingLevels, ...(price ? { price } : {}) };
}

function toStoredModel(input: ProviderModelInput): StoredModel {
  const model = normalizePublicModel(input);
  const reasoning = model.thinkingLevels.some((level) => level !== "off");
  const thinkingLevelMap = Object.fromEntries(THINKING_LEVELS.filter((level) => level !== "off").map((level) => [level, model.thinkingLevels.includes(level) ? level : null]));
  return {
    id: model.id,
    name: model.name,
    type: "chat",
    reasoning,
    input: model.vision ? ["text", "image"] : ["text"],
    cost: {
      input: model.price?.input ?? 0,
      output: model.price?.output ?? 0,
      cacheRead: model.price?.cacheRead ?? 0,
      cacheWrite: model.price?.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxOutputTokens,
    thinkingLevelMap,
  } as StoredModel;
}

function normalizeModels(inputs: ProviderModelInput[]): StoredModel[] {
  const models = inputs.map(toStoredModel);
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw new Error(`模型 ID 重复：${model.id}`);
    seen.add(model.id);
  }
  return models;
}

function publicModel(model: AnyModel): ProviderModel {
  const price = model.cost && Object.values(model.cost).some((value) => value !== 0) ? {
    input: model.cost.input,
    output: model.cost.output,
    cacheRead: model.cost.cacheRead,
    cacheWrite: model.cost.cacheWrite,
  } : undefined;
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    vision: model.input.includes("image"),
    thinkingLevels: getSupportedThinkingLevels(model),
    ...(price ? { price } : {}),
  };
}

function modelConfigError(role: ModelRole): Error {
  return new Error(`用途「${ROLE_NAMES[role]}」尚未配置可用模型，请前往 设置 → 模型厂商 完成配置`);
}

export function seedModelDefaults(db: DatabaseSync): void {
  if ((db.prepare("SELECT count(*) AS n FROM model_providers").get() as { n: number }).n > 0) return;
  const catalog = Object.values(DEEPSEEK_MODELS).map(({ api: _api, provider: _provider, baseUrl: _baseUrl, ...model }) => model);
  db.exec("BEGIN");
  try {
    const insert = db.prepare("INSERT INTO model_providers (name, protocol, base_url, models_json, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id");
    const now = Date.now();
    const openai = (insert.get("DeepSeek（OpenAI 格式）", "openai", "https://api.deepseek.com", JSON.stringify(catalog), now) as { id: number }).id;
    insert.get("DeepSeek（Anthropic 格式）", "anthropic", "https://api.deepseek.com/anthropic", JSON.stringify(catalog.map(({ compat: _compat, ...model }) => model)), now);
    const role = db.prepare("INSERT INTO model_roles (role, provider_id, model_id, thinking) VALUES (?, ?, ?, ?)");
    role.run("agent", openai, "deepseek-v4-pro", "high");
    role.run("vision", openai, "deepseek-flash", "low");
    role.run("bulk", openai, "deepseek-flash", "low");
    role.run("review", openai, "deepseek-v4-pro", "high");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listProviders(db: DatabaseSync): ProviderDetail[] {
  return providerRows(db).map((row) => ({
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    hasKey: row.api_key_ciphertext !== null,
    keyHint: row.api_key_hint,
    models: modelsOf(row).map(publicModel),
  }));
}

export function createProviderConfig(db: DatabaseSync, key: Buffer, input: {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey?: string;
  models?: ProviderModelInput[];
}): number {
  const name = cleanName(input.name, "厂商名称");
  const protocol = cleanProtocol(input.protocol);
  const baseUrl = cleanBaseUrl(input.baseUrl);
  const apiKey = input.apiKey?.trim() || null;
  const now = Date.now();
  try {
    return (db.prepare(`INSERT INTO model_providers
      (name, protocol, base_url, api_key_ciphertext, api_key_hint, models_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
      name, protocol, baseUrl, apiKey ? seal(key, apiKey) : null, apiKey ? apiKey.slice(-4) : null,
      JSON.stringify(normalizeModels(input.models ?? [])), now,
    ) as { id: number }).id;
  } catch (error) {
    if (/UNIQUE constraint failed: model_providers\.name/.test(String(error))) throw new Error(`已经有名为「${name}」的模型厂商`);
    throw error;
  }
}

export function updateProviderConfig(db: DatabaseSync, key: Buffer, providerId: number, input: {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey?: string;
  models: ProviderModelInput[];
}): void {
  const current = providerRows(db).find((row) => row.id === providerId);
  if (!current) throw new Error(`模型厂商 ${providerId} 不存在`);
  const name = cleanName(input.name, "厂商名称");
  const protocol = cleanProtocol(input.protocol);
  const baseUrl = cleanBaseUrl(input.baseUrl);
  const apiKey = input.apiKey?.trim();
  const mayKeepStoredKey = !apiKey && protocol === current.protocol && new URL(baseUrl).origin === new URL(current.base_url).origin;
  try {
    db.prepare(`UPDATE model_providers SET name = ?, protocol = ?, base_url = ?, api_key_ciphertext = ?, api_key_hint = ?, models_json = ? WHERE id = ?`).run(
      name,
      protocol,
      baseUrl,
      apiKey ? seal(key, apiKey) : mayKeepStoredKey ? current.api_key_ciphertext : null,
      apiKey ? apiKey.slice(-4) : mayKeepStoredKey ? current.api_key_hint : null,
      JSON.stringify(normalizeModels(input.models)), providerId,
    );
  } catch (error) {
    if (/UNIQUE constraint failed: model_providers\.name/.test(String(error))) throw new Error(`已经有名为「${name}」的模型厂商`);
    throw error;
  }
}

export function deleteProviderConfig(db: DatabaseSync, providerId: number): void {
  if (!providerRows(db).some((row) => row.id === providerId)) throw new Error(`模型厂商 ${providerId} 不存在`);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM model_roles WHERE provider_id = ?").run(providerId);
    db.prepare("DELETE FROM model_providers WHERE id = ?").run(providerId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Key 只更新指定提供方，不再按域名共享。 */
export function setProviderKey(db: DatabaseSync, key: Buffer, providerId: number, apiKey: string): void {
  const value = apiKey.trim();
  if (!value) throw new Error("请填写 API Key");
  if (!providerRows(db).some((row) => row.id === providerId)) throw new Error(`模型厂商 ${providerId} 不存在`);
  db.prepare("UPDATE model_providers SET api_key_ciphertext = ?, api_key_hint = ? WHERE id = ?").run(seal(key, value), value.slice(-4), providerId);
}

function modelsEndpoint(row: ProviderRow): string {
  if (row.protocol === "openai") return `${row.base_url.replace(/\/$/, "")}/models`;
  const base = row.base_url.replace(/\/$/, "");
  return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/** 从提供方拉取模型 ID。目录通常没有能力元数据，因此先给安全默认值，用户仍可手工补全。 */
export async function fetchProviderModels(db: DatabaseSync, key: Buffer, providerId: number, fetchImpl: FetchLike = globalThis.fetch, timeoutMs = 15_000): Promise<ProviderModel[]> {
  const row = providerRows(db).find((provider) => provider.id === providerId);
  if (!row) throw new Error(`模型厂商 ${providerId} 不存在`);
  if (!row.api_key_ciphertext) throw new Error("请先保存这个模型厂商的 API Key");
  const apiKey = unseal(key, row.api_key_ciphertext);
  let response: Response;
  try {
    response = await fetchImpl(modelsEndpoint(row), {
      method: "GET",
      headers: row.protocol === "openai" ? { authorization: `Bearer ${apiKey}`, accept: "application/json" } : { "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") throw new Error(`获取模型列表超时（${Math.ceil(timeoutMs / 1000)} 秒）`);
    throw new Error(`获取模型列表失败：${redactRemoteText((error as Error).message, [apiKey])}`);
  }
  if (!response.ok) {
    const detail = redactRemoteText((await response.text()).slice(0, 300).trim(), [apiKey]);
    if (response.status === 401 || response.status === 403) throw new Error("Key 无效，无法获取模型列表");
    throw new Error(`获取模型列表失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
  }
  const payload = await response.json() as { data?: unknown };
  if (!Array.isArray(payload.data)) throw new Error("模型列表响应格式不正确：缺少 data 数组");
  const existing = new Map(listProviders(db).find((provider) => provider.id === providerId)?.models.map((model) => [model.id, model]) ?? []);
  const found = new Map<string, ProviderModel>();
  for (const item of payload.data) {
    if (!item || typeof item !== "object") continue;
    const raw = item as {
      id?: unknown;
      name?: unknown;
      display_name?: unknown;
      context_window?: unknown;
      context_length?: unknown;
      max_output_tokens?: unknown;
      max_input_tokens?: unknown;
      max_tokens?: unknown;
      input_modalities?: unknown;
      architecture?: { input_modalities?: unknown };
      top_provider?: { max_completion_tokens?: unknown };
      effort?: { supported_levels?: unknown };
      capabilities?: { image_input?: { supported?: unknown }; effort?: Record<string, { supported?: unknown } | unknown> };
      pricing?: { prompt?: unknown; completion?: unknown };
    };
    if (typeof raw.id !== "string" || !raw.id.trim()) continue;
    const id = redactRemoteText(raw.id.trim(), [apiKey]);
    const known = existing.get(id);
    const modalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : Array.isArray(raw.architecture?.input_modalities) ? raw.architecture.input_modalities : [];
    const effortLevels = Array.isArray(raw.effort?.supported_levels)
      ? raw.effort.supported_levels
      : raw.capabilities?.effort && typeof raw.capabilities.effort === "object"
        ? Object.entries(raw.capabilities.effort).filter(([level, value]) => level !== "supported" && typeof value === "object" && value !== null && (value as { supported?: unknown }).supported === true).map(([level]) => level)
        : [];
    const inputPrice = Number(raw.pricing?.prompt);
    const outputPrice = Number(raw.pricing?.completion);
    found.set(id, known ?? normalizePublicModel({
      id,
      name: redactRemoteText(typeof raw.display_name === "string" ? raw.display_name : typeof raw.name === "string" ? raw.name : id, [apiKey]),
      contextWindow: Number(raw.context_window ?? raw.context_length ?? raw.max_input_tokens ?? 128_000),
      maxOutputTokens: Number(raw.max_output_tokens ?? raw.max_tokens ?? raw.top_provider?.max_completion_tokens ?? 8_192),
      vision: modalities.includes("image") || raw.capabilities?.image_input?.supported === true,
      thinkingLevels: ["off", ...effortLevels.map(String)],
      ...(Number.isFinite(inputPrice) && Number.isFinite(outputPrice) ? { price: { input: inputPrice * 1_000_000, output: outputPrice * 1_000_000 } } : {}),
    }));
  }
  if (!found.size) throw new Error("提供方没有返回可用的模型");
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function listRoles(db: DatabaseSync): RoleSummary[] {
  const providers = new Map(providerRows(db).map((row) => [row.id, row]));
  const rows = db.prepare("SELECT role, provider_id, model_id, thinking FROM model_roles").all() as { role: ModelRole; provider_id: number; model_id: string; thinking: string }[];
  return ROLES.map((role) => {
    const choice = rows.find((row) => row.role === role);
    if (!choice) return { role, providerId: 0, modelId: "", thinking: "off", ready: false, problem: `未配置「${ROLE_NAMES[role]}」用途，请前往 设置 → 模型厂商` };
    const provider = providers.get(choice.provider_id);
    const model = provider && modelsOf(provider).find((candidate) => candidate.id === choice.model_id);
    const problem = !provider ? "所选模型厂商已不存在，请重新配置" : !provider.api_key_ciphertext ? `「${provider.name}」还没有设置 Key` : !model ? `模型 ${choice.model_id} 已不在「${provider.name}」的列表里` : role === "vision" && !model.input.includes("image") ? `看截图用途需要支持图片的模型，${model.id} 只支持文字` : null;
    return { role, providerId: choice.provider_id, modelId: choice.model_id, thinking: choice.thinking, ready: problem === null, problem };
  });
}

export function setRole(db: DatabaseSync, role: ModelRole, choice: { providerId: number; modelId: string; thinking: string }): void {
  if (!ROLES.includes(role)) throw new Error(`未知用途 ${role}`);
  const row = providerRows(db).find((provider) => provider.id === choice.providerId);
  if (!row) throw new Error(`模型厂商 ${choice.providerId} 不存在`);
  const model = modelsOf(row).find((candidate) => candidate.id === choice.modelId);
  if (!model) throw new Error(`模型 ${choice.modelId} 不在「${row.name}」的列表里`);
  if (role === "vision" && !model.input.includes("image")) throw new Error(`看截图用途需要支持图片的模型，${model.id} 只支持文字`);
  if (!getSupportedThinkingLevels(model).includes(choice.thinking as ModelThinkingLevel)) throw new Error(`${model.id} 不支持思考强度「${choice.thinking}」`);
  db.prepare(`INSERT INTO model_roles (role, provider_id, model_id, thinking) VALUES (?, ?, ?, ?) ON CONFLICT (role) DO UPDATE SET provider_id = excluded.provider_id, model_id = excluded.model_id, thinking = excluded.thinking`).run(role, choice.providerId, choice.modelId, choice.thinking);
}

/** 发一句极短的请求验证 Key 和地址（只回复 OK），30 秒超时。 */
export async function pingModel(models: ReturnType<typeof createModels>, model: AnyModel, secrets: string[] = []) {
  const startedAt = Date.now();
  let message: Awaited<ReturnType<typeof models.completeSimple>>;
  try {
    message = await models.completeSimple(model, { messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: startedAt }] }, { signal: AbortSignal.timeout(30_000), maxTokens: Math.min(2_000, model.maxTokens) });
  } catch (error) {
    throw new Error(redactRemoteText((error as Error).message || "请求失败", secrets));
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const raw = redactRemoteText(message.errorMessage ?? "请求失败", secrets);
    throw new Error(/401|unauthori[sz]ed|invalid.*key|authentication/i.test(raw) ? "Key 无效，请检查后重新设置" : raw);
  }
  const reply = redactRemoteText(message.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim(), secrets);
  return { ms: Date.now() - startedAt, reply: reply.slice(0, 40), cost: message.usage.cost.total };
}

/** RPC 连接测试：在模型库内部取 Key，确保远端错误即使回显凭据也会先脱敏。 */
export async function testProviderModel(db: DatabaseSync, key: Buffer, providerId: number, modelId: string) {
  const row = providerRows(db).find((provider) => provider.id === providerId);
  if (!row?.api_key_ciphertext) throw new Error("这个模型厂商还没有设置 Key");
  const apiKey = unseal(key, row.api_key_ciphertext);
  const { models } = buildRuntime(db, key);
  const model = models.getModel(`p${providerId}`, modelId) as AnyModel | undefined;
  if (!model) throw new Error(`模型 ${modelId} 不在「${row.name}」的列表里`);
  return pingModel(models, model, [apiKey]);
}

/** 流水线用：按用途调一次模型，拿回纯文本和花费。签名保持不变。 */
export async function completeText(db: DatabaseSync, key: Buffer, role: ModelRole, prompt: string): Promise<{ text: string; cost: number }> {
  const runtime = buildRuntime(db, key);
  const { model, thinking } = runtime.resolve(role);
  const secrets = providerRows(db).flatMap((row) => row.api_key_ciphertext ? [unseal(key, row.api_key_ciphertext)] : []);
  let message: Awaited<ReturnType<typeof runtime.models.completeSimple>>;
  try {
    // 网络中断、超时、限流、5xx 自动重试；返回 stopReason=error 的同样按错误内容判断
    message = await withModelRetry(async () => {
      const m = await runtime.models.completeSimple(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { reasoning: thinking === "off" ? undefined : (thinking as Exclude<ModelThinkingLevel, "off">), maxTokens: Math.min(16_000, model.maxTokens), signal: AbortSignal.timeout(5 * 60_000) });
      if (m.stopReason === "error" || m.stopReason === "aborted") throw new Error(m.errorMessage ?? m.stopReason);
      return m;
    });
  } catch (error) {
    throw new Error(`模型调用失败：${redactRemoteText((error as Error).message || "请求失败", secrets)}`);
  }
  return { text: message.content.filter((part) => part.type === "text").map((part) => part.text).join(""), cost: message.usage.cost.total };
}

/** 设了 Key 的提供方，Key 只在内存里交给 pi-ai，不写日志、不返回界面。 */
export function providersFromDb(db: DatabaseSync, key: Buffer) {
  return providerRows(db).filter((row) => row.api_key_ciphertext).map((row) => {
    const apiKey = unseal(key, row.api_key_ciphertext!);
    return createProvider({ id: `p${row.id}`, name: row.name, baseUrl: row.base_url, auth: { apiKey: { name: `${row.name} API Key`, resolve: async () => ({ auth: { apiKey }, source: "website-gen" }) } }, models: modelsOf(row), api: row.protocol === "openai" ? openAICompletionsApi() : anthropicMessagesApi() });
  });
}

/** 某个用途选的提供方、模型和思考强度。签名保持不变。 */
export const roleChoice = (db: DatabaseSync, role: ModelRole) => db.prepare("SELECT provider_id, model_id, thinking FROM model_roles WHERE role = ?").get(role) as { provider_id: number; model_id: string; thinking: ModelThinkingLevel } | undefined;

/** 组装当前工作区的模型运行时。签名保持不变。 */
export function buildRuntime(db: DatabaseSync, key: Buffer) {
  const models = createModels();
  for (const provider of providersFromDb(db, key)) models.setProvider(provider);
  const roles = db.prepare("SELECT role, provider_id, model_id, thinking FROM model_roles").all() as { role: ModelRole; provider_id: number; model_id: string; thinking: string }[];
  return {
    models,
    resolve(role: ModelRole): { model: AnyModel; thinking: ModelThinkingLevel } {
      const choice = roles.find((row) => row.role === role);
      const model = choice && (models.getModel(`p${choice.provider_id}`, choice.model_id) as AnyModel | undefined);
      if (!choice || !model) throw modelConfigError(role);
      if (role === "vision" && !model.input.includes("image")) throw modelConfigError(role);
      return { model, thinking: choice.thinking as ModelThinkingLevel };
    },
  };
}
