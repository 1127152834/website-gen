import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate, openDb } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";
import {
  buildRuntime,
  completeText,
  createProviderConfig,
  deleteProviderConfig,
  fetchProviderModels,
  listProviders,
  listRoles,
  seedModelDefaults,
  setProviderKey,
  setRole,
  pingModel,
  updateProviderConfig,
  type ProviderModelInput,
} from "./models.ts";
import { seal, unseal } from "./secrets.ts";

const key = randomBytes(32);
const textModel: ProviderModelInput = {
  id: "text-model",
  name: "Text Model",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  vision: false,
  thinkingLevels: ["off", "high"],
  price: { input: 0.1, output: 0.2 },
};
const visionModel: ProviderModelInput = { ...textModel, id: "vision-model", name: "Vision Model", vision: true };

const fresh = () => {
  const db = openDb(":memory:");
  migrate(db);
  seedModelDefaults(db);
  return db;
};
const byProtocol = (db: ReturnType<typeof fresh>, protocol: "openai" | "anthropic") => listProviders(db).find((provider) => provider.protocol === protocol)!;

test("migration 010 preserves legacy DeepSeek provider, key, models and role rows", () => {
  const db = openDb(":memory:");
  for (const sql of MIGRATIONS.slice(0, 9)) db.exec(sql);
  db.exec("PRAGMA user_version = 9");
  const ciphertext = seal(key, "legacy-secret");
  const model = {
    id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", type: "chat", reasoning: true, input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 8_000,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: null },
  };
  const providerId = (db.prepare("INSERT INTO model_providers (name, protocol, base_url, api_key_ciphertext, api_key_hint, models_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .get("DeepSeek（旧工作区）", "openai", "https://api.deepseek.com", ciphertext, "cret", JSON.stringify([model]), 123) as { id: number }).id;
  db.prepare("INSERT INTO model_roles (role, provider_id, model_id, thinking) VALUES (?, ?, ?, ?)").run("agent", providerId, model.id, "high");

  migrate(db);

  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
  const provider = listProviders(db)[0];
  assert.equal(provider.name, "DeepSeek（旧工作区）");
  assert.equal(provider.keyHint, "cret");
  assert.equal(provider.models[0].id, "deepseek-v4-pro");
  assert.equal(listRoles(db).find((role) => role.role === "agent")?.modelId, "deepseek-v4-pro");
  const raw = db.prepare("SELECT api_key_ciphertext FROM model_providers WHERE id = ?").get(providerId) as { api_key_ciphertext: Uint8Array };
  assert.equal(unseal(key, raw.api_key_ciphertext), "legacy-secret");
  assert.doesNotThrow(() => db.prepare("SELECT * FROM entity_templates").all());
});

test("defaults remain compatible and seed only once", () => {
  const db = fresh();
  seedModelDefaults(db);
  const providers = listProviders(db);
  assert.ok(providers.every((provider) => Number.isInteger(provider.configRevision) && provider.configRevision > 0));
  assert.deepEqual(providers.map((provider) => [provider.protocol, provider.baseUrl]), [
    ["openai", "https://api.deepseek.com"],
    ["anthropic", "https://api.deepseek.com/anthropic"],
  ]);
  assert.deepEqual(providers[0].models.map((model) => model.id).sort(), ["deepseek-flash", "deepseek-v4-pro"]);
  const roles = listRoles(db);
  assert.equal(roles.length, 6);
  const translation = roles.find((role) => role.role === "translation");
  assert.deepEqual(translation, {
    role: "translation",
    providerId: 0,
    modelId: "",
    thinking: "off",
    ready: false,
    problem: "未配置「邮件翻译」用途，请前往 设置 → 模型厂商",
  });
});

test("mail triage has no default fallback and its binding does not change translation or agent", async () => {
  const db = fresh();
  try {
    const before = listRoles(db).filter((role) => role.role !== "mail_triage");
    const unconfigured = listRoles(db).find((role) => role.role === "mail_triage");
    assert.deepEqual(unconfigured, { role: "mail_triage", providerId: 0, modelId: "", thinking: "off", ready: false, problem: "未配置「邮件预审」用途，请前往 设置 → 模型厂商" });
    await assert.rejects(() => completeText(db, key, "mail_triage", "fixture"), /用途「邮件预审」尚未配置/);
    const id = createProviderConfig(db, key, { name: "Triage", protocol: "openai", baseUrl: "https://triage.example.test/v1", apiKey: "fixture-key", models: [textModel] });
    setRole(db, "mail_triage", { providerId: id, modelId: textModel.id, thinking: "high" });
    assert.equal(listRoles(db).find((role) => role.role === "mail_triage")?.ready, true);
    assert.deepEqual(listRoles(db).filter((role) => role.role !== "mail_triage"), before);
  } finally { db.close(); }
});

test("provider CRUD returns rich metadata but never returns API keys in clear", () => {
  const db = fresh();
  const id = createProviderConfig(db, key, {
    name: "My Gateway", protocol: "openai", baseUrl: "https://models.example.test/v1/", apiKey: "secret-create-1234", models: [textModel, visionModel],
  });
  let provider = listProviders(db).find((item) => item.id === id)!;
  assert.equal(provider.baseUrl, "https://models.example.test/v1");
  assert.equal(provider.keyHint, "1234");
  assert.equal(provider.models[1].contextWindow, 128_000);
  assert.equal(provider.models[1].maxOutputTokens, 8_192);
  assert.equal(provider.models[1].vision, true);
  assert.ok(!JSON.stringify(provider).includes("secret-create"));

  updateProviderConfig(db, key, id, { name: "My Gateway 2", protocol: "openai", baseUrl: "https://models.example.test/another-path", models: [visionModel] });
  provider = listProviders(db).find((item) => item.id === id)!;
  assert.equal(provider.name, "My Gateway 2");
  assert.equal(provider.protocol, "openai");
  assert.equal(provider.keyHint, "1234");
  let raw = db.prepare("SELECT api_key_ciphertext FROM model_providers WHERE id = ?").get(id) as { api_key_ciphertext: Uint8Array | null };
  assert.ok(raw.api_key_ciphertext);
  assert.equal(unseal(key, raw.api_key_ciphertext), "secret-create-1234");

  updateProviderConfig(db, key, id, { name: "My Gateway 2", protocol: "anthropic", baseUrl: "https://other.example.test", models: [visionModel] });
  provider = listProviders(db).find((item) => item.id === id)!;
  assert.equal(provider.hasKey, false);
  assert.equal(provider.keyHint, null);
  assert.ok(!JSON.stringify(provider).includes("secret-create"));
  raw = db.prepare("SELECT api_key_ciphertext FROM model_providers WHERE id = ?").get(id) as { api_key_ciphertext: Uint8Array | null };
  assert.equal(raw.api_key_ciphertext, null);

  deleteProviderConfig(db, id);
  assert.equal(listProviders(db).some((item) => item.id === id), false);
});

test("keys are encrypted and isolated even when providers use the same host", () => {
  const db = fresh();
  const openai = byProtocol(db, "openai");
  const anthropic = byProtocol(db, "anthropic");
  setProviderKey(db, key, openai.id, "openai-secret-1111");
  let providers = listProviders(db);
  assert.deepEqual(providers.map((provider) => [provider.hasKey, provider.keyHint]), [[true, "1111"], [false, null]]);
  setProviderKey(db, key, anthropic.id, "anthropic-secret-2222");
  providers = listProviders(db);
  assert.deepEqual(providers.map((provider) => provider.keyHint), ["1111", "2222"]);
  const raw = db.prepare("SELECT id, api_key_ciphertext FROM model_providers ORDER BY id").all() as unknown as { id: number; api_key_ciphertext: Uint8Array }[];
  assert.equal(unseal(key, raw[0].api_key_ciphertext), "openai-secret-1111");
  assert.equal(unseal(key, raw[1].api_key_ciphertext), "anthropic-secret-2222");
  assert.ok(raw.every((row) => !Buffer.from(row.api_key_ciphertext).toString("latin1").includes("secret")));
});

test("vision role rejects text-only models and role upsert supports new assignments", () => {
  const db = fresh();
  const id = createProviderConfig(db, key, { name: "Manual", protocol: "openai", baseUrl: "https://manual.example/v1", models: [textModel, visionModel] });
  assert.throws(() => setRole(db, "vision", { providerId: id, modelId: textModel.id, thinking: "high" }), /支持图片/);
  setRole(db, "vision", { providerId: id, modelId: visionModel.id, thinking: "high" });
  assert.equal(listRoles(db).find((role) => role.role === "vision")?.modelId, visionModel.id);
});

test("translation role is configured and persisted independently from other roles", async () => {
  const db = fresh();
  const originalBulk = listRoles(db).find((role) => role.role === "bulk")!;
  const originalAgent = listRoles(db).find((role) => role.role === "agent")!;
  await assert.rejects(() => completeText(db, key, "translation", "hello"), /用途「邮件翻译」尚未配置/);
  const id = createProviderConfig(db, key, {
    name: "Translation Gateway",
    protocol: "openai",
    baseUrl: "https://translation.example/v1",
    apiKey: "translation-secret-3333",
    models: [textModel],
  });

  setRole(db, "translation", { providerId: id, modelId: textModel.id, thinking: "high" });

  const roles = listRoles(db);
  assert.deepEqual(roles.find((role) => role.role === "translation"), {
    role: "translation",
    providerId: id,
    modelId: textModel.id,
    thinking: "high",
    ready: true,
    problem: null,
  });
  assert.deepEqual(roles.find((role) => role.role === "bulk"), originalBulk);
  assert.deepEqual(roles.find((role) => role.role === "agent"), originalAgent);
  assert.deepEqual(
    { ...db.prepare("SELECT role, provider_id, model_id, thinking FROM model_roles WHERE role = 'translation'").get() },
    { role: "translation", provider_id: id, model_id: textModel.id, thinking: "high" },
  );
});

test("fetch models parses OpenAI and Anthropic lists with the provider-specific auth headers", async () => {
  const db = fresh();
  const openai = byProtocol(db, "openai");
  const anthropic = byProtocol(db, "anthropic");
  setProviderKey(db, key, openai.id, "openai-key");
  setProviderKey(db, key, anthropic.id, "anthropic-key");
  const calls: { url: string; headers: Headers }[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    const anthropicCall = String(input).includes("/anthropic/");
    return new Response(JSON.stringify({ data: anthropicCall
      ? [{ id: "claude-test", display_name: "Claude Test", max_input_tokens: 200_000, max_tokens: 16_000, capabilities: { image_input: { supported: true }, effort: { supported: true, low: { supported: true }, high: { supported: true } } } }]
      : [{ id: "deepseek-new", name: "DeepSeek New", context_window: 1_000_000, max_output_tokens: 64_000, input_modalities: ["text", "image"], effort: { supported_levels: ["low", "high"] } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const openaiModels = await fetchProviderModels(db, key, openai.id, fakeFetch);
  const anthropicModels = await fetchProviderModels(db, key, anthropic.id, fakeFetch);
  assert.equal(openaiModels[0].id, "deepseek-new");
  assert.equal(openaiModels[0].contextWindow, 1_000_000);
  assert.equal(openaiModels[0].vision, true);
  assert.deepEqual(openaiModels[0].thinkingLevels, ["off", "low", "high"]);
  assert.equal(anthropicModels[0].name, "Claude Test");
  assert.equal(anthropicModels[0].maxOutputTokens, 16_000);
  assert.equal(anthropicModels[0].vision, true);
  assert.equal(calls[0].url, "https://api.deepseek.com/models");
  assert.equal(calls[0].headers.get("authorization"), "Bearer openai-key");
  assert.equal(calls[1].url, "https://api.deepseek.com/anthropic/v1/models");
  assert.equal(calls[1].headers.get("x-api-key"), "anthropic-key");
  assert.equal(calls[1].headers.get("anthropic-version"), "2023-06-01");
});

test("provider URLs reject embedded secrets and remote errors cannot echo stored keys", async () => {
  const db = fresh();
  assert.throws(() => createProviderConfig(db, key, { name: "Bad URL", protocol: "openai", baseUrl: "https://user:pass@example.test/v1", models: [] }), /账号或密码/);
  assert.throws(() => createProviderConfig(db, key, { name: "Bad Query", protocol: "openai", baseUrl: "https://example.test/v1?token=secret", models: [] }), /查询参数/);
  const provider = byProtocol(db, "openai");
  const secret = "arbitrary-provider-secret";
  setProviderKey(db, key, provider.id, secret);
  let seenRedirect: RequestRedirect | undefined;
  await assert.rejects(
    () => fetchProviderModels(db, key, provider.id, async (_input, init) => {
      seenRedirect = init?.redirect;
      return new Response(`upstream echoed x-api-key: ${secret}`, { status: 500 });
    }),
    (error: Error) => !error.message.includes(secret) && error.message.includes("[已隐藏]"),
  );
  assert.equal(seenRedirect, "error");

  const fakeModels = {
    completeSimple: async () => ({ stopReason: "error", errorMessage: `bad Authorization: Bearer ${secret}`, content: [], usage: { cost: { total: 0 } } }),
  } as unknown as Parameters<typeof pingModel>[0];
  const fakeModel = buildRuntime(db, key).resolve("agent").model;
  await assert.rejects(() => pingModel(fakeModels, fakeModel, [secret]), (error: Error) => !error.message.includes(secret) && error.message.includes("[已隐藏]"));

  const rejectingModels = {
    completeSimple: async () => { throw new Error(`transport rejected x-api-key: ${secret}`); },
  } as unknown as Parameters<typeof pingModel>[0];
  await assert.rejects(() => pingModel(rejectingModels, fakeModel, [secret]), (error: Error) => !error.message.includes(secret) && error.message.includes("[已隐藏]"));
});

test("runtime resolves independent provider keys and unconfigured completeText gives a clear settings path", async () => {
  const db = fresh();
  const openai = byProtocol(db, "openai");
  const anthropic = byProtocol(db, "anthropic");
  setProviderKey(db, key, openai.id, "openai-key");
  setProviderKey(db, key, anthropic.id, "anthropic-key");
  setRole(db, "review", { providerId: anthropic.id, modelId: "deepseek-v4-pro", thinking: "high" });
  const runtime = buildRuntime(db, key);
  assert.equal((await runtime.models.getAuth(runtime.resolve("agent").model))?.auth.apiKey, "openai-key");
  assert.equal((await runtime.models.getAuth(runtime.resolve("review").model))?.auth.apiKey, "anthropic-key");

  deleteProviderConfig(db, openai.id);
  assert.equal(listRoles(db).find((role) => role.role === "agent")?.ready, false);
  await assert.rejects(() => completeText(db, key, "agent", "hello"), /设置 → 模型厂商/);
});
