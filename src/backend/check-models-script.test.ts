import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

test("check-models probes the four seeded roles without resolving unconfigured translation", async () => {
  const source = readFileSync(new URL("../../scripts/check-models.ts", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "");
  const javascript = stripTypeScriptTypes(source, { mode: "strip" });
  const resolvedRoles: string[] = [];
  const pingedModels: string[] = [];
  const providers = [
    { id: 1, name: "OpenAI fixture", models: [{ id: "provider-openai" }] },
    { id: 2, name: "Anthropic fixture", models: [{ id: "provider-anthropic" }] },
  ];
  const runtime = {
    models: {
      getModel: (provider: string, model: string) => ({ id: `${provider}/${model}`, api: "fixture" }),
    },
    resolve: (role: string) => {
      resolvedRoles.push(role);
      if (role === "translation") throw new Error("translation must remain unconfigured in this probe");
      return { model: { id: `role-${role}`, api: "fixture" }, thinking: "off" };
    },
  };
  const context = {
    randomBytes: () => Buffer.alloc(32),
    migrate: () => undefined,
    openDb: () => ({}),
    buildRuntime: () => runtime,
    listProviders: () => providers,
    pingModel: async (_models: unknown, model: { id: string }) => {
      pingedModels.push(model.id);
      return { ms: 1, reply: "OK", cost: 0 };
    },
    ROLES: ["agent", "vision", "bulk", "review", "translation"],
    seedModelDefaults: () => undefined,
    setProviderKey: () => undefined,
    process: { env: { DEEPSEEK_API_KEY: "fixture-key" } },
    console: { log: () => undefined },
    Buffer,
  };

  await vm.runInNewContext(`(async () => { ${javascript} })()`, context);

  assert.deepEqual(resolvedRoles, ["agent", "vision", "bulk", "review"]);
  assert.deepEqual(pingedModels, ["p1/provider-openai", "p2/provider-anthropic", "role-agent", "role-vision", "role-bulk", "role-review"]);
});
