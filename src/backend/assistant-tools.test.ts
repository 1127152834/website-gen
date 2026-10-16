import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspace } from "./index.ts";
import {
  ASSISTANT_EXCLUDED_METHODS,
  ASSISTANT_RPC_TOOLS,
  assistantRpcToolDefinitions,
  sanitizeAssistantValue,
} from "./assistant-tools.ts";

test("每个 workspace RPC 都被助手登记表或不暴露清单明确分类", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-tools-"));
  const workspace = createWorkspace({ userDir: root, key: randomBytes(32) });
  try {
    const exposed = new Set(ASSISTANT_RPC_TOOLS.map((tool) => tool.method));
    const excluded = new Set(Object.keys(ASSISTANT_EXCLUDED_METHODS));
    assert.equal(exposed.size, ASSISTANT_RPC_TOOLS.length, "RPC 工具 method 不能重复");
    assert.equal(new Set(ASSISTANT_RPC_TOOLS.map((tool) => tool.name)).size, ASSISTANT_RPC_TOOLS.length, "RPC 工具 name 不能重复");
    for (const method of Object.keys(workspace.handlers)) {
      assert.notEqual(exposed.has(method), excluded.has(method), `${method} 必须且只能归入一个分类`);
    }
    for (const method of ["chat.history", "chat.send", "chat.abort", "chat.reset", "events.since"])
      assert.match(ASSISTANT_EXCLUDED_METHODS[method] ?? "", /内部|对话|推送/);
  } finally {
    await workspace.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("敏感 RPC 不暴露，清单写明原因", () => {
  for (const method of [
    "accounts.add", "models.create", "models.update", "models.setKey", "cj.setKey",
    "mail.defaultPassword.set", "mail.password", "mail.credential.save", "smtp.enable",
    "grist.settings.save", "grist.testConnection", "grist.mcpToken.generate",
  ]) {
    assert.ok(ASSISTANT_EXCLUDED_METHODS[method], `${method} 应不暴露`);
    assert.match(ASSISTANT_EXCLUDED_METHODS[method], /密码|密钥|Token|Key|凭据|明文/);
  }
  assert.match(ASSISTANT_EXCLUDED_METHODS["grist.mcpToken.status"] ?? "", /内部|令牌/);
  assert.match(ASSISTANT_EXCLUDED_METHODS["grist.mcpToken.revoke"] ?? "", /页面|令牌/);
});

test("共用 Grist 工具已替代重复 RPC，并保留设置状态入口", () => {
  const duplicateMethods = [
    "grist.listOrgs", "grist.listWorkspaces", "grist.listDocs", "grist.getDocInfo", "grist.getTables",
    "grist.getTableColumns", "grist.listRecords", "grist.addRecords", "grist.updateRecords",
  ];
  const exposed = new Set(ASSISTANT_RPC_TOOLS.map((tool) => tool.method));
  assert.equal(exposed.has("grist.settings.get"), true);
  for (const method of duplicateMethods) {
    assert.equal(exposed.has(method), false, `${method} 不应重复注册`);
    assert.equal(ASSISTANT_EXCLUDED_METHODS[method], "与共用的 grist_* 工具重复");
  }
});

test("经营主体天数范围使用 OpenAI 兼容的定长数组 schema", () => {
  for (const method of ["templates.save", "batches.create"]) {
    const schema = JSON.parse(JSON.stringify(ASSISTANT_RPC_TOOLS.find((tool) => tool.method === method)!.parameters));
    const entity = schema.properties.entity;
    for (const key of ["processingDays", "transitDays"]) {
      assert.deepEqual(entity.properties[key], {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: { type: "integer" },
      });
    }
  }
});

test("深度清理敏感字段并保留 hint，RPC 工具校验参数且清理结果", async () => {
  const dirty = {
    password: "p", token: "t", apiKey: "k", secret_note: "s", ciphertext: "c", credential: "x",
    apiKeyHint: "1234", passwordHint: "已设置", passwordSet: "明文不能借状态字段漏出", secretAsset: "也不能被 set 后缀误保留",
    credentialSaved: true, tokenStatus: "原始状态字符串不保留", nested: [{ ok: 1, access_token: "hidden" }],
  };
  assert.deepEqual(sanitizeAssistantValue(dirty), {
    apiKeyHint: "1234", passwordHint: "已设置", credentialSaved: true, nested: [{ ok: 1 }],
  });

  const definitions = assistantRpcToolDefinitions({
    "sites.get": (params) => ({ params, nested: { password: "no", keyHint: "yes" } }),
  });
  const tool = definitions.find((item) => item.method === "sites.get")!;
  assert.deepEqual(await tool.run({ siteId: 3 }), { params: { siteId: 3 }, nested: { keyHint: "yes" } });
  await assert.rejects(() => Promise.resolve(tool.run({ siteId: 3, userId: 99 })), /Unexpected|additional|property|参数/i);
});

test("删除、资源创建、发信、放弃、上线和改密码操作都要求确认", () => {
  const risk = Object.fromEntries(ASSISTANT_RPC_TOOLS.map((tool) => [tool.method, tool.risk]));
  for (const method of [
    "templates.remove", "accounts.remove", "models.delete", "batches.create", "sites.launch", "sites.retry",
    "mail.fix", "mail.credential.reset", "mail.trash", "mail.delete", "mail.send", "smtp.resetPassword", "smtp.test",
    "changes.revert", "abandon.start", "abandon.retry",
  ]) assert.equal(risk[method], "confirm", method);
});

