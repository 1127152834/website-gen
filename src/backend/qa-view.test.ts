import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createWorkspace } from "./index.ts";
import { openDb } from "./db.ts";
import { friendlyReviewPageLabel, qaView } from "./qa-view.ts";
import type { QaReport } from "./store.ts";
import type { QaView, ReviewIssue } from "../shared/protocol.ts";

const fixture = () => {
  const root = mkdtempSync(join(import.meta.dirname, "../../.phase3-backup/qa-view-"));
  const work = join(root, "work"); mkdirSync(join(work, "qa"), { recursive: true });
  const own = join(work, "qa", "page.png"), foreign = join(root, "foreign.png");
  writeFileSync(own, Buffer.from("89504e470d0a1a0a", "hex")); writeFileSync(foreign, "private");
  const issue = { id: "product-size", level: "P1" as const, kind: "product" as const, page: "Product", url: "https://example.com/product/1/", evidence: "27m", why: "Unverified measurement", fix: "Provide real dimensions", status: "needs_you" as const };
  const report: QaReport = { at: 123, checks: [], shots: [{ name: "own", file: own }, { name: "foreign", file: foreign }], review: { at: 123, rounds: 2, passed: false, issues: [{ ...issue, shot: own }, { ...issue, id: "foreign", shot: foreign }, { ...issue, id: "data-url", shot: "data:image/png;base64,cHJpdmF0ZQ==" }] } };
  return { root, work, report };
};

test("QA view converts own review screenshots and drops foreign paths and model-supplied data URLs", () => {
  const { work, report } = fixture(); const result = qaView(report, work);
  assert.equal(result.shots.length, 1); assert.match(result.shots[0].src, /^data:image\/png;base64,/);
  assert.equal(result.review?.rounds, 2); assert.equal(result.review?.passed, false);
  assert.match(result.review!.issues[0].shot!, /^data:image\/png;base64,/);
  assert.equal(result.review!.issues[1].shot, undefined); assert.equal(result.review!.issues[2].shot, undefined);
  assert.ok(!JSON.stringify(result).includes('"file":'));
});

test("sites.qa returns the fixed QaView contract including review, with per-workspace screenshot isolation", async () => {
  const { root, report } = fixture(); const workspace = createWorkspace({ userDir: root, key: randomBytes(32) });
  const db = openDb(join(root, "website-gen.sqlite"));
  try {
    db.prepare("INSERT INTO batches(entity_json,created_at) VALUES ('{}',0)").run();
    db.prepare("INSERT INTO sites(batch_id,domain,form_json,created_at,updated_at,qa_json) VALUES (1,'qa.example','{}',0,0,?)").run(JSON.stringify(report));
    const result = await workspace.handlers["sites.qa"]({ siteId: 1 }) as QaView;
    assert.equal(result.at, 123); assert.equal(result.review!.rounds, 2); assert.equal(result.review!.passed, false);
    assert.equal(result.review!.issues[0].status, "needs_you"); assert.match(result.review!.issues[0].shot!, /^data:image\/png;base64,/);
    assert.equal(result.shots.length, 1); assert.equal(result.review!.issues[1].shot, undefined);
  } finally { db.close(); await workspace.close(); }
});


test("QA view also renders a checkpoint containing only the in-progress review", () => {
  const { work, report } = fixture();
  const partial = qaView({ review: report.review } as QaReport, work);
  assert.equal(partial.at, 123); assert.deepEqual(partial.checks, []); assert.deepEqual(partial.shots, []);
  assert.equal(partial.review!.rounds, 2);
});

test("QA view maps legacy capture ids to friendly Chinese labels and marks only safe open issues fixable", () => {
  assert.equal(friendlyReviewPageLabel("page-27-about", "https://shop.test/about/"), "关于我们");
  assert.equal(friendlyReviewPageLabel("product-8-travel-duffel", "https://shop.test/product/travel-duffel/"), "商品：Travel Duffel");
  assert.equal(friendlyReviewPageLabel("category-7-travel-1", "https://shop.test/product-category/travel/"), "分类：Travel");
  assert.equal(friendlyReviewPageLabel("Site-wide", "https://shop.test/"), "全站");
  assert.equal(friendlyReviewPageLabel("Payment setup", "https://shop.test/wp-admin/admin.php?page=wc-settings"), "支付设置");

  const { work, report } = fixture();
  report.review!.issues = [
    { ...report.review!.issues[0], id: "image", page: "product-8-travel-duffel", status: "open", evidence: "Main image has a barcode collage", why: "商品主图包含条码拼图", fix: "换成干净的商品主图" },
    { ...report.review!.issues[0], id: "facts", page: "product-8-travel-duffel", status: "needs_you", why: "缺少真实尺寸", fix: "请补充商品实际尺寸" },
  ];
  const result = qaView(report, work);
  assert.equal(result.review!.issues[0].page, "商品：Travel Duffel");
  assert.equal((result.review!.issues[0] as ReviewIssue & { fixable?: boolean }).fixable, true);
  assert.equal((result.review!.issues[1] as ReviewIssue & { fixable?: boolean }).fixable, false);

  (report as QaReport & { reviewFindings?: unknown[] }).reviewFindings = [{ issue: report.review!.issues[1], needsRealData: false, action: { tool: "update_policy", params: { summary: "坏动作", name: "returns" } } }];
  report.review!.issues[1] = { ...report.review!.issues[1], status: "open" };
  assert.equal((qaView(report, work).review!.issues[1] as ReviewIssue & { fixable?: boolean }).fixable, false, "invalid persisted action is not advertised as fixable");
  report.review!.issues[1] = { ...report.review!.issues[1], page: "商品：Fancy Bed", url: "https://shop.test/product/123/" };
  (report as QaReport & { reviewFindings?: unknown[] }).reviewFindings = [{ issue: report.review!.issues[1], needsRealData: true, action: { tool: "update_product", params: { summary: "不应执行", id: 123, name: "Fancy Bed" } } }];
  const guarded = qaView(report, work).review!.issues[1] as ReviewIssue & { fixable?: boolean };
  assert.equal(guarded.page, "商品：Fancy Bed"); assert.equal(guarded.fixable, false);
  assert.doesNotThrow(() => friendlyReviewPageLabel("product-8-bad", "https://shop.test/product/%E0%A4%A/"));
});

test("QA report presents the redesigned Chinese issue groups and one-click actions", () => {
  const source = readFileSync(join(import.meta.dirname, "../renderer/src/features/sites/components/qa-report.tsx"), "utf8");
  for (const text of ["待处理", "需要你补充", "已修复", "一键修复全部", "重新复核", "页面原文", "查看修复记录"]) assert.match(source, new RegExp(text));
});

test("persisted real-data guard overrides even a statically supported image fix", () => {
  const { work, report } = fixture();
  const issue: ReviewIssue = { ...report.review!.issues[0], status: "open", why: "主图与实际商品不符", fix: "确认真实商品后更换主图", evidence: "Wrong main image" };
  report.review!.issues = [issue];
  report.reviewFindings = [{ issue, needsRealData: true }];
  assert.equal(qaView(report, work).review!.issues[0].fixable, false);
});
