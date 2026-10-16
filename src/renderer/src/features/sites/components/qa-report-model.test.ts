import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { QaView, ReviewIssue } from "../../../../../shared/protocol.ts";
import { groupQaIssues, issueTitle, needsYouGuidance, qaCounts, qaPassed } from "./qa-report-model.ts";

const issue = (id: string, level: ReviewIssue["level"], status: ReviewIssue["status"], fixable = false): ReviewIssue => ({
  id, level, status, fixable, kind: "copy", page: "首页", url: "https://example.com/", evidence: "原文", why: `${id} 的原因。后一句`, fix: "修改",
});

test("QA 问题按待处理、需补充、已修复分组，并在组内把 P1 放前面", () => {
  const groups = groupQaIssues([
    issue("fixed", "P2", "fixed"), issue("open-p3", "P3", "open"), issue("needs", "P1", "needs_you"), issue("open-p1", "P1", "open"),
  ]);
  assert.deepEqual(groups.open.map((item) => item.id), ["open-p1", "open-p3"]);
  assert.deepEqual(groups.needsYou.map((item) => item.id), ["needs"]);
  assert.deepEqual(groups.fixed.map((item) => item.id), ["fixed"]);
});

test("QA 摘要只把 open 且 fixable 的问题计入一键修复数量", () => {
  assert.deepEqual(qaCounts([
    issue("a", "P1", "open", true), issue("b", "P2", "open"), issue("c", "P1", "needs_you", true), issue("d", "P3", "fixed", true),
  ]), { p1: 2, suggestions: 1, needsYou: 1, fixed: 1, fixable: 1 });
});

test("问题标题保留原语言并截取第一句，不翻译旧英文记录", () => {
  assert.equal(issueTitle("Missing address. Add the real address."), "Missing address.");
  assert.equal(issueTitle("退货期限没有写清楚。请补充天数。"), "退货期限没有写清楚。");
});

test("整体通过同时要求 AI 复核通过且没有阻断规则失败", () => {
  const qa = (ok: boolean): QaView => ({ at: 1, shots: [], review: { at: 1, rounds: 0, passed: true, issues: [] }, checks: [{ id: "payment", name: "支付", level: "block", ok, detail: "" }] });
  assert.equal(qaPassed(qa(true)), true);
  assert.equal(qaPassed(qa(false)), false);
  assert.equal(qaPassed(null), false);
});

test("待补充旧英文记录保留原 fix，并额外给出中文资料指引", () => {
  const identity = { ...issue("identity", "P1", "needs_you"), why: "Legal business identity is missing", fix: "Add the legal company name and address." };
  assert.match(needsYouGuidance(identity), /当前批次.*入口.*维护人员.*经营主体/);
  assert.doesNotMatch(needsYouGuidance(identity), /新建批次/);
  assert.equal(identity.fix, "Add the legal company name and address.");
  assert.match(needsYouGuidance({ ...identity, why: "Product dimensions are missing", fix: "Add width and height" }), /实际长、宽、高/);
  assert.match(needsYouGuidance({ ...identity, why: "Set contents are unclear", fix: "List every included component" }), /套装/);
});

test("移动端把实时进度放在报告内容之前，桌面仍放在右侧末列", () => {
  const source = readFileSync(new URL("../../../pages/qa-report.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-label="修复进度" className="[^"]*order-first[^"]*xl:order-last/);
});

test("QA 运行记录由 Query 读取，事件订阅只合并实时日志", () => {
  const source = readFileSync(new URL("../../../pages/qa-report.tsx", import.meta.url), "utf8");
  assert.match(source, /useRpcData<QaRun\[]>\("qa\.runs", siteId == null \? null : \{ siteId \}\)/);
  assert.doesNotMatch(source, /call<QaRun\[]>\("qa\.runs"/);
  assert.match(source, /useEffect\(\(\) => onEvent/);
  const eventEffect = source.slice(source.indexOf("useEffect(() => onEvent"), source.indexOf("}), [siteId]);") + 14);
  assert.doesNotMatch(eventEffect, /reloadRuns|refreshRuns/);
  assert.match(source, /setInterval\(\(\) => \{ void reloadRuns\(\); \}, 2_000\)/);
});
