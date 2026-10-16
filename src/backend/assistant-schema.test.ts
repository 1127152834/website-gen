import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Model, Tool } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { migrate } from "./db.ts";
import { createWorkspace } from "./index.ts";
import { createAssistant, type AssistantSessionFactoryOptions, type AssistantSessionLike } from "./assistant.ts";
import { assistantRpcToolDefinitions } from "./assistant-tools.ts";
import { gristToolDefinitions } from "./grist-tools.ts";

class SchemaSession implements AssistantSessionLike {
  messages: unknown[] = [];
  isStreaming = false;
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  dispose(): void {}
  subscribe(): () => void { return () => {}; }
}

const SCHEMA_KEYWORDS = new Set([
  "$id", "$schema", "$ref", "$anchor", "$dynamicRef", "$dynamicAnchor", "$vocabulary", "$comment", "$defs", "definitions",
  "type", "enum", "const", "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum",
  "maxLength", "minLength", "pattern", "format", "contentEncoding", "contentMediaType", "contentSchema",
  "maxItems", "minItems", "uniqueItems", "maxContains", "minContains", "items", "contains",
  "maxProperties", "minProperties", "required", "properties", "patternProperties", "additionalProperties", "propertyNames",
  "dependentRequired", "dependentSchemas", "unevaluatedItems", "unevaluatedProperties",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
  "title", "description", "default", "deprecated", "readOnly", "writeOnly", "examples",
]);

function validateSchema(value: unknown, path = "schema"): void {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${path} 必须是对象`);
  const object = value as Record<string, unknown>;
  assert.equal(Object.hasOwn(object, "prefixItems"), false, `${path} 不得包含 prefixItems`);
  assert.equal(Object.hasOwn(object, "additionalItems"), false, `${path} 不得包含 additionalItems`);
  for (const key of Object.keys(object)) assert.ok(SCHEMA_KEYWORDS.has(key), `${path} 含非 JSON Schema 字段 ${key}`);
  if (Object.hasOwn(object, "type")) {
    assert.ok(typeof object.type === "string" || (Array.isArray(object.type) && object.type.every((item) => typeof item === "string")), `${path}.type 必须是 string|string[]`);
  }
  if (Object.hasOwn(object, "items")) {
    assert.ok(object.items && typeof object.items === "object" && !Array.isArray(object.items), `${path}.items 必须是 schema 对象`);
    validateSchema(object.items, `${path}.items`);
  }
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    const children = object[key];
    if (!children || typeof children !== "object" || Array.isArray(children)) continue;
    for (const [name, child] of Object.entries(children)) validateSchema(child, `${path}.${key}.${name}`);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const children = object[key];
    if (Array.isArray(children)) children.forEach((child, index) => validateSchema(child, `${path}.${key}[${index}]`));
  }
  for (const key of ["additionalProperties", "unevaluatedItems", "unevaluatedProperties", "contains", "contentSchema", "not", "if", "then", "else", "propertyNames"]) {
    const child = object[key];
    if (child && typeof child === "object" && !Array.isArray(child)) validateSchema(child, `${path}.${key}`);
  }
}

async function registeredTools(admin: boolean): Promise<Tool[]> {
  const dir = mkdtempSync(join(tmpdir(), "assistant-schema-"));
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const manual = join(dir, "manual.md");
  writeFileSync(manual, "# 手册\n", "utf8");
  let registration: AssistantSessionFactoryOptions | undefined;
  const workspace = createWorkspace({ userDir: join(dir, "workspace"), key: Buffer.alloc(32, 1), backgroundTasks: false });
  const rpc = assistantRpcToolDefinitions(workspace.handlers);
  const shared = gristToolDefinitions(() => workspace.gristClient());
  const assistant = createAssistant({
    userDir: dir,
    db,
    key: () => Buffer.alloc(32),
    manualPath: manual,
    getToolDefinitions: () => [...rpc, ...shared],
    onEvent: () => {},
    createSession: async (options) => { registration = options; return new SchemaSession(); },
  });
  try {
    if (admin) assistant.setAdminCapability({ listUsers: async () => [], query: async () => [] });
    await assistant.history();
    return registration!.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  } finally {
    await assistant.close();
    await workspace.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function openAiPayloadTools(tools: Tool[]): Promise<Array<{ name: string; parameters: unknown }>> {
  let payload: any;
  const model = {
    id: "schema-test", name: "Schema Test", api: "openai-completions", provider: "deepseek",
    baseUrl: "https://schema.invalid/v1", input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false,
    contextWindow: 8192, maxTokens: 1024,
  } as Model<"openai-completions">;
  const stream = streamSimple(model, normalizeContext({ messages: [], tools }), {
    apiKey: "test-key-never-sent",
    onPayload: (value) => { payload = JSON.parse(JSON.stringify(value)); },
    fetch: async () => { throw new Error("fake transport stops after payload capture"); },
  });
  await stream.result();
  assert.ok(payload, "OpenAI adapter 应触发 onPayload");
  return payload.tools.map((tool: any) => ({ name: tool.function.name, parameters: tool.function.parameters }));
}

async function anthropicPayloadTools(tools: Tool[]): Promise<Array<{ name: string; parameters: unknown }>> {
  let payload: any;
  const model = {
    id: "schema-test", name: "Schema Test", api: "anthropic-messages", provider: "anthropic",
    baseUrl: "https://schema.invalid/v1", input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false,
    contextWindow: 8192, maxTokens: 1024,
  } as Model<"anthropic-messages">;
  const stream = streamAnthropic(model, normalizeContext({ messages: [], tools }), {
    apiKey: "test-key-never-sent",
    onPayload: (value) => { payload = JSON.parse(JSON.stringify(value)); },
    fetch: async () => { throw new Error("fake transport stops after payload capture"); },
  });
  await stream.result();
  assert.ok(payload, "Anthropic adapter 应触发 onPayload");
  return payload.tools.map((tool: any) => ({ name: tool.name, parameters: tool.input_schema }));
}

test("模型适配器最终 payload 中全部普通和管理员助手工具都是兼容 JSON Schema", async () => {
  for (const admin of [false, true]) {
    const registered = await registeredTools(admin);
    for (const [adapter, payloadTools] of [
      ["OpenAI Completions", await openAiPayloadTools(registered)],
      ["Anthropic Messages", await anthropicPayloadTools(registered)],
    ] as const) {
      assert.deepEqual(payloadTools.map((tool) => tool.name), registered.map((tool) => tool.name), `${adapter} 工具顺序必须等于实际注册`);
      for (const tool of payloadTools) {
        assert.equal((tool.parameters as Record<string, unknown>).type, "object", `${adapter}/${tool.name} 根 schema 必须是 object`);
        validateSchema(tool.parameters, `${adapter}/${tool.name}`);
        const json = JSON.stringify(tool.parameters);
        assert.doesNotMatch(json, /TypeBox|TSchema|\[object Object\]/i, `${adapter}/${tool.name} 不得泄露非 JSON schema 标记`);
      }
    }
  }
});
