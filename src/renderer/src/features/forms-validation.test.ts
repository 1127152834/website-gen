import assert from "node:assert/strict";
import test from "node:test";
import { accountSchema } from "./accounts/validation.ts";
import { changePasswordSchema, loginSchema } from "./auth/validation.ts";
import { cjKeySchema, mailboxPasswordSchema, providerSchema } from "./settings/validation.ts";
import { addUserSchema, resetPasswordSchema } from "./users/validation.ts";

test("认证表单提供中文的客户端校验", () => {
  assert.equal(loginSchema.safeParse({ username: " ", password: "" }).success, false);
  const mismatch = changePasswordSchema.safeParse({ oldPassword: "old-password", newPassword: "new-password", confirm: "another-password" });
  assert.equal(mismatch.success, false);
  assert.match(mismatch.error?.issues[0]?.message ?? "", /不一致/);
});

test("用户与账号凭据表单拒绝空值和短密码", () => {
  assert.equal(addUserSchema.safeParse({ username: "", password: "short", role: "user" }).success, false);
  assert.equal(resetPasswordSchema.safeParse({ password: "short" }).success, false);
  assert.equal(accountSchema.safeParse({ label: "主账号", token: "secret-token" }).success, true);
});

test("设置表单保留密钥留空语义并校验地址", () => {
  const base = { presetId: "custom", name: "厂商", protocol: "openai", baseUrl: "https://api.example.com/v1", apiKey: "", hasKey: true, keyHint: "1234", models: [] } as const;
  assert.equal(providerSchema.safeParse(base).success, true);
  assert.equal(providerSchema.safeParse({ ...base, baseUrl: "not-a-url" }).success, false);
  assert.equal(cjKeySchema.safeParse({ apiKey: " " }).success, false);
  assert.equal(mailboxPasswordSchema.safeParse({ password: "12345678" }).success, true);
});

test("厂商模型校验把中文错误定位到具体模型字段", () => {
  const result = providerSchema.safeParse({ presetId: "custom", name: "厂商", protocol: "openai", baseUrl: "https://api.example.com/v1", apiKey: "key", hasKey: false, keyHint: null, models: [{ id: "", name: "", vision: false, thinkingLevels: ["off"], contextWindow: 0, maxOutputTokens: 0 }] });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues.map((issue) => issue.path), [["models", 0, "id"], ["models", 0, "contextWindow"], ["models", 0, "maxOutputTokens"]]);
  assert.match(result.error?.issues[0]?.message ?? "", /模型 ID/);
});
