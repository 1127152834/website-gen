import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent } from "./db.ts";
import { claimDue } from "./jobs.ts";
import { siteContext } from "./pipeline.ts";
import { startQaRun, runQaJob, qaRuns } from "./qa-runs.ts";
import { deps, fakeHostinger, fakeSite, runToEnd, setup, DOMAIN } from "./testing.ts";
import type { ReviewIssue } from "../shared/protocol.ts";
import { parseReviewIssues } from "./review.ts";
import { revertChange } from "./changes.ts";

async function fixture() {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  const d = deps(db, exec, fetchImpl, []);
  d.emit = (event) => { appendEvent(db, { ...event, batchId: String(event.batchId), siteId: String(event.siteId) }); };
  await runToEnd(d, siteId);
  db.prepare("UPDATE jobs SET status = 'done'").run();
  const ctx = siteContext(d, siteId);
  const seed = (issues: ReviewIssue[], reviewFindings: unknown[] = []) => {
    const report = JSON.parse(ctx.site.qa_json!);
    report.review = { at: 1, rounds: 2, passed: false, issues };
    report.reviewFindings = reviewFindings;
    ctx.save("qa_json", JSON.stringify(report));
    db.prepare("UPDATE provision_steps SET status = 'failed' WHERE site_id = ? AND step = 'qa'").run(siteId);
    db.prepare("UPDATE sites SET status = 'failed' WHERE id = ?").run(siteId);
  };
  const work = async () => {
    const [job] = claimDue(db, d.now(), 1, 600000);
    assert.ok(job);
    await runQaJob(d, job);
    db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(job.id);
  };
  return { db, d, wp, siteId, seed, work };
}
const issue = (id: string, status: ReviewIssue["status"] = "open"): ReviewIssue => ({
  id, level: "P1", kind: "seo", page: "about", url: `https://${DOMAIN}/about/`, evidence: "Missing store summary", why: "页面摘要不完整", fix: "补齐与页面一致的摘要", status,
});

test("QA run reserves one per-site slot immediately and history survives a service reload", async () => {
  const f = await fixture();
  const { runId } = startQaRun(f.d, { siteId: f.siteId, kind: "recheck" });
  assert.equal(typeof runId, "string");
  assert.throws(() => startQaRun(f.d, { siteId: f.siteId, kind: "fixAll" }), /正在.*复核|已有.*任务/);
  const runs = qaRuns(f.db, f.siteId);
  assert.equal(runs[0].id, runId);
  assert.equal(runs[0].status, "queued");
  assert.equal(runs[0].events[0].stage, "queued");
  await f.work();
  assert.equal(qaRuns(f.db, f.siteId)[0].status, "done");
  assert.ok(qaRuns(f.db, f.siteId)[0].events.some((event) => event.stage === "finished"));
  f.db.close();
});

test("fixIssue records a you changeset, only re-reviews affected page, and completes QA/site after no P1", async () => {
  const f = await fixture();
  const item = issue("metadata-about");
  const unrelated = { ...issue("contact-open"), level: "P2" as const, kind: "config" as const, page: "联系我们", url: `https://${DOMAIN}/contact/`, evidence: "Unverified operator contact detail" };
  const text = "Discover our store and explore a practical selection of everyday pet products.";
  f.seed([item, unrelated], [{ issue: item, needsRealData: false, action: { tool: "update_meta", params: { summary: "补齐关于页摘要", target_type: "page", target_id: [...f.wp.pages.values()].find((page) => page.slug === "about")!.id, description: text, og_description: text } } }]);
  const paths: string[][] = [];
  const browse = f.d.browse!;
  f.d.browse = async (input) => { paths.push(input.pages.map((page) => page.path)); return browse(input); };
  startQaRun(f.d, { siteId: f.siteId, issueId: item.id, kind: "fixIssue" });
  await f.work();
  const changes = f.db.prepare("SELECT * FROM changesets WHERE initiator = 'you'").all();
  assert.equal(changes.length, 1);
  assert.ok(paths.length >= 2);
  assert.ok(paths.every((pages) => pages.length === 1 && pages[0] === "/about/"), JSON.stringify(paths));
  const report = JSON.parse((f.db.prepare("SELECT qa_json FROM sites WHERE id = ?").get(f.siteId) as {qa_json:string}).qa_json);
  assert.equal(report.review.issues.find((entry: ReviewIssue) => entry.id === item.id)?.status, "fixed");
  assert.equal(report.review.issues.find((entry: ReviewIssue) => entry.id === unrelated.id)?.status, "open", "单项复核不清除无关页面的问题");
  assert.equal(f.db.prepare("SELECT status FROM sites WHERE id = ?").get(f.siteId)?.status, "done");
  assert.equal(f.db.prepare("SELECT status FROM provision_steps WHERE site_id = ? AND step = 'qa'").get(f.siteId)?.status, "done");
  const run = qaRuns(f.db, f.siteId)[0];
  assert.equal(run.result?.fixed, 1);
  assert.ok(run.events.some((event) => event.changesetId && event.stage === "applied"));
  assert.ok(run.events.some((event) => event.stage === "review-page" && /1\/1/.test(event.message)));
  await revertChange(siteContext(f.d, f.siteId), (changes[0] as { id: number }).id);
  assert.equal(f.db.prepare("SELECT status FROM changesets WHERE id = ?").get((changes[0] as { id: number }).id)?.status, "reverted");
  f.db.close();
});

test("fixAll uses at most two fresh rounds, fixes each issue once, and does not spend the pipeline budget", async () => {
  const f = await fixture();
  const targetId = [...f.wp.pages.values()].find((page) => page.slug === "about")!.id;
  const raw = (key: string) => ({ key, focus: "store_trust", level: "P1", kind: "config", page: "关于我们", url: `https://${DOMAIN}/about/`,
    evidence: "The operator claim is unsupported", why: "经营说明缺少可以核对的真实依据", fix: "删除没有依据的经营承诺", needs_real_data: false,
    action: { tool: "update_meta", params: { summary: `修正经营摘要 ${key}`, target_type: "page", target_id: targetId,
      description: `Explore factual store information and practical pet products. Summary version ${key}.`,
      og_description: `Explore factual store information and practical pet products. Summary version ${key}.` } } });
  const a = parseReviewIssues(JSON.stringify({ issues: [raw("a")] }))[0]!;
  f.seed([a.issue], [a]);
  let reviews = 0;
  const ai = f.d.ai;
  f.d.ai = async (role, prompt) => {
    if (role === "review" && prompt.includes(`PAGE URL:\nhttps://${DOMAIN}/about/`)) {
      reviews++;
      return { text: JSON.stringify({ issues: [raw("a"), raw("b"), ...(reviews > 1 ? [raw("c")] : [])] }), cost: 0 };
    }
    return ai(role, prompt);
  };
  startQaRun(f.d, { siteId: f.siteId, kind: "fixAll" });
  await f.work();
  const run = qaRuns(f.db, f.siteId)[0];
  assert.equal(run.events.filter((event) => event.stage === "review-start").length, 2);
  assert.equal(reviews, 2);
  assert.equal(run.events.filter((event) => event.stage === "attempt" && event.issueId === a.issue.id).length, 1);
  assert.equal(run.events.filter((event) => event.stage === "applied").length, 2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM changesets WHERE initiator = 'you'").get()?.n, 2);
  assert.equal(run.result?.passed, false);
  f.db.close();
});

test("recheck performs no user writes and incomplete reviews stay failed in report and history", async () => {
  const f = await fixture();
  f.d.browse = async () => { throw new Error("测试浏览器不可用"); };
  startQaRun(f.d, { siteId: f.siteId, kind: "recheck" });
  await f.work();
  const run = qaRuns(f.db, f.siteId)[0];
  assert.equal(run.result?.passed, false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM changesets WHERE initiator = 'you'").get()?.n, 0);
  assert.equal(f.db.prepare("SELECT status FROM provision_steps WHERE site_id = ? AND step = 'qa'").get(f.siteId)?.status, "failed");
  f.db.close();
});

test("fixAll never writes needs_you and tries each issue once despite two review rounds", async () => {
  const f = await fixture();
  const item = issue("manual-identity", "needs_you");
  item.kind = "config";
  item.evidence = "Legal business name is missing; actual address is unknown";
  item.fix = "请在批次经营主体资料中补充真实公司名称和地址";
  f.seed([item]);
  startQaRun(f.d, { siteId: f.siteId, kind: "fixAll" });
  await f.work();
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM changesets WHERE initiator = 'you'").get()?.n, 0);
  const run = qaRuns(f.db, f.siteId)[0];
  assert.ok(run.events.some((event) => event.stage === "skipped" && event.issueId === item.id && /真实|补充/.test(event.message)));
  assert.ok(run.events.filter((event) => event.stage === "review-start").length <= 2);
  assert.equal(run.result?.passed, false);
  f.db.close();
});

test("fixIssue store-copy re-reviews all pages using the changed shared tagline", async () => {
  const f = await fixture();
  const item = { ...issue("store-catalog"), kind: "copy" as const, evidence: "The store catalog story is unrelated", why: "店铺介绍与实际商品范围不符", fix: "按已上架商品修改店铺文案" };
  const manual = { ...issue("manual-identity", "needs_you"), kind: "config" as const, evidence: "Legal business name is missing; actual address is unknown", why: "经营主体资料需要核实", fix: "提供真实公司名称和地址" };
  f.seed([item, manual], [{ issue: item, needsRealData: false, action: { tool: "update_copy", params: { summary: "修改店铺标语", tagline: "Dog beds and pet blankets for daily comfort." } } }]);
  const paths: string[][] = [];
  const browse = f.d.browse!;
  f.d.browse = async (input) => { paths.push(input.pages.map((page) => page.path)); return browse(input); };
  startQaRun(f.d, { siteId: f.siteId, kind: "fixIssue", issueId: item.id });
  await f.work();
  assert.deepEqual(paths[0], ["/about/"], "规划只抓取原问题页");
  for (const path of ["/", "/about/", "/faq/", "/contact/"]) assert.ok(paths.at(-1)?.includes(path), `全站标语修改也要复核 ${path}`);
  assert.equal(qaRuns(f.db, f.siteId)[0].events.filter((event) => event.stage === "applied").length, 1);
  const report = JSON.parse((f.db.prepare("SELECT qa_json FROM sites WHERE id = ?").get(f.siteId) as {qa_json:string}).qa_json);
  assert.equal(report.review.issues.find((issue: ReviewIssue) => issue.id === manual.id)?.status, "needs_you", "自动修改标语不能充当真实主体资料变化");
  assert.equal(qaRuns(f.db, f.siteId)[0].result?.passed, false);
  f.db.close();
});

test("fixIssue product image re-reviews the product and affected storefront archives", async () => {
  const f = await fixture();
  const product = f.wp.products[0];
  const productUrl = `https://${DOMAIN}/product/${product.id}/`;
  product.images = product.images.map((image, index) => ({ ...(image as object), id: index + 1 }));
  const item = { ...issue("product-image"), kind: "visual" as const, page: `商品：${product.name}`, url: productUrl, evidence: "Wrong main product image", why: "商品主图与实际商品不符", fix: "选择匹配商品的主图" };
  f.seed([item], [{ issue: item, needsRealData: false, action: { tool: "update_product_main_image", params: { summary: "更换商品主图", id: product.id, image_id: 2 } } }]);
  const paths: string[][] = [];
  const browse = f.d.browse!;
  f.d.browse = async (input) => { paths.push(input.pages.map((page) => page.path)); return browse(input); };
  startQaRun(f.d, { siteId: f.siteId, kind: "fixIssue", issueId: item.id });
  await f.work();
  for (const path of ["/", "/shop/", new URL(productUrl).pathname]) assert.ok(paths.at(-1)?.includes(path), `商品图修改也要复核 ${path}`);
  assert.ok(paths.at(-1)?.some((path) => path.startsWith("/product-category/")));
  assert.equal(qaRuns(f.db, f.siteId)[0].events.filter((event) => event.stage === "applied").length, 1);
  f.db.close();
});
