import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { confirmationParamEntries } from "./confirmation-params.ts";

const component = readFileSync(new URL("./global-assistant.tsx", import.meta.url), "utf8");

test("confirmation parameters use readable labels for destructive Grist and site actions", () => {
  assert.deepEqual(confirmationParamEntries({
    docId: "doc-1",
    tableId: "Orders",
    recordIds: [7, 9],
    siteId: 42,
    email: "owner@example.test",
    to: ["buyer@example.test"],
  }), [
    { label: "文档", value: "doc-1" },
    { label: "表", value: "Orders" },
    { label: "行 ID", value: "[7, 9]" },
    { label: "站点编号", value: "42" },
    { label: "邮箱", value: "owner@example.test" },
    { label: "收件人", value: "[\"buyer@example.test\"]" },
  ]);
});

test("confirmation parameters handle absent and empty values without throwing", () => {
  assert.deepEqual(confirmationParamEntries(undefined), []);
  assert.deepEqual(confirmationParamEntries(null), []);
  assert.deepEqual(confirmationParamEntries({}), []);
  assert.deepEqual(confirmationParamEntries({ subject: "", replyTo: null, cc: [], fields: {} }), [
    { label: "主题", value: "（空）" },
    { label: "回复邮件", value: "（空）" },
    { label: "抄送", value: "[]" },
    { label: "修改内容", value: "{}" },
  ]);
});

test("confirmation parameters render arrays and objects as compact text", () => {
  assert.deepEqual(confirmationParamEntries({
    records: [{ id: 3, fields: { Name: "新品", Enabled: true } }],
  }), [
    { label: "记录", value: '[{"id":3,"fields":{"Name":"新品","Enabled":true}}]' },
  ]);
});

test("confirmation parameters truncate long values without losing the total length hint", () => {
  const value = "长".repeat(140);
  const [entry] = confirmationParamEntries({ text: value });
  assert.equal(entry.label, "正文");
  assert.equal(entry.value, `${"长".repeat(117)}…（共 140 字符）`);
});

test("confirmation parameters keep angle brackets and Chinese parameter names as plain text", () => {
  assert.deepEqual(confirmationParamEntries({ 自定义参数: "<script>alert(1)</script>" }), [
    { label: "自定义参数", value: "<script>alert(1)</script>" },
  ]);
});

test("confirmation parameter labels truncate long emoji text without splitting code points", () => {
  const label = "😀".repeat(50);
  assert.deepEqual(confirmationParamEntries({ [label]: "值" }), [
    { label: `${"😀".repeat(37)}…（共 50 字符）`, value: "值" },
  ]);
});

test("confirmation card keeps the tool description before an always-visible parameter list", () => {
  const card = component.slice(component.indexOf("function ConfirmCard"), component.indexOf("export function GlobalAssistant"));
  assert.ok(card.indexOf("item.description") < card.indexOf("<dl"));
  assert.match(card, /confirmationParamEntries\(item\.args\)/);
  assert.match(card, /className="min-w-0 rounded-xl/);
  assert.match(card, /<dt className="max-w-\[40%\] shrink-0 break-all/);
  assert.doesNotMatch(card, /<details|<summary/);
});
