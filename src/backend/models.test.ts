import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { migrate, openDb } from "./db.ts";
import { buildRuntime, listProviders, listRoles, seedModelDefaults, setProviderKey, setRole } from "./models.ts";

const key = randomBytes(32);
const fresh = () => {
  const db = openDb(":memory:");
  migrate(db);
  seedModelDefaults(db);
  return db;
};
const byProtocol = (db: ReturnType<typeof fresh>, protocol: "openai" | "anthropic") => listProviders(db).find((p) => p.protocol === protocol)!;

test("defaults: two DeepSeek providers (OpenAI and Anthropic formats) and four roles, seeded once", () => {
  const db = fresh();
  seedModelDefaults(db);
  const providers = listProviders(db);
  assert.deepEqual(providers.map((p) => [p.protocol, p.baseUrl]), [
    ["openai", "https://api.deepseek.com"],
    ["anthropic", "https://api.deepseek.com/anthropic"],
  ]);
  assert.deepEqual(providers[0].models.map((m) => m.id).sort(), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.deepEqual(listRoles(db).map((r) => [r.role, r.modelId, r.thinking]), [
    ["agent", "deepseek-v4-pro", "high"],
    ["vision", "deepseek-flash", "low"],
    ["bulk", "deepseek-flash", "low"],
    ["review", "deepseek-v4-pro", "high"],
  ]);
});

test("an API key is stored encrypted and shared by providers on the same host", () => {
  const db = fresh();
  setProviderKey(db, key, byProtocol(db, "openai").id, "sk-test-abcd1234");
  const providers = listProviders(db);
  assert.deepEqual(providers.map((p) => [p.hasKey, p.keyHint]), [[true, "1234"], [true, "1234"]]);
  const raw = db.prepare("SELECT api_key_ciphertext FROM model_providers").all() as { api_key_ciphertext: Uint8Array }[];
  for (const r of raw) assert.ok(!Buffer.from(r.api_key_ciphertext).toString("latin1").includes("sk-test"));
});

test("roles report a missing key until the provider has one", () => {
  const db = fresh();
  assert.ok(listRoles(db).every((r) => !r.ready && /Key/.test(r.problem ?? "")));
  setProviderKey(db, key, byProtocol(db, "openai").id, "sk-test-1");
  assert.ok(listRoles(db).every((r) => r.ready && r.problem === null));
});

test("setRole rejects models that cannot do the job", () => {
  const db = fresh();
  const openai = byProtocol(db, "openai").id;
  assert.throws(() => setRole(db, "vision", { providerId: openai, modelId: "deepseek-v4-pro", thinking: "high" }), /看图/);
  assert.throws(() => setRole(db, "agent", { providerId: openai, modelId: "no-such-model", thinking: "high" }), /模型/);
  assert.throws(() => setRole(db, "agent", { providerId: openai, modelId: "deepseek-v4-pro", thinking: "low" }), /思考强度/);
  setRole(db, "agent", { providerId: openai, modelId: "deepseek-flash", thinking: "low" });
  assert.equal(listRoles(db).find((r) => r.role === "agent")?.modelId, "deepseek-flash");
});

test("the runtime resolves each role to a pi-ai model with the right protocol, endpoint and key", async () => {
  const db = fresh();
  setProviderKey(db, key, byProtocol(db, "openai").id, "sk-test-xyz");
  setRole(db, "review", { providerId: byProtocol(db, "anthropic").id, modelId: "deepseek-v4-pro", thinking: "high" });

  const runtime = buildRuntime(db, key);
  const agent = runtime.resolve("agent");
  assert.equal(agent.model.api, "openai-completions");
  assert.equal(agent.model.baseUrl, "https://api.deepseek.com");
  assert.equal(agent.thinking, "high");

  const review = runtime.resolve("review");
  assert.equal(review.model.api, "anthropic-messages");
  assert.equal(review.model.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal((review.model as { compat?: unknown }).compat, undefined); // OpenAI 专用的兼容参数不能带到 Anthropic 格式

  assert.equal((await runtime.models.getAuth(review.model))?.auth.apiKey, "sk-test-xyz");
});
