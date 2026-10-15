import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewIssue } from "../shared/protocol.ts";
import type { StepCtx } from "./pipeline.ts";
import { collectReviewSnapshot, crawlReviewTargets, deterministicSourceFindings, parseReviewIssues, runFullSiteReview, runReviewLoop, splitReviewText, type ReviewFinding, type ReviewSnapshot } from "./review.ts";

const issue = (id: string, level: ReviewIssue["level"] = "P1", status: ReviewIssue["status"] = "open"): ReviewIssue => ({
  id, level, kind: "product", page: "Product", url: "https://shop.test/product/bag/",
  evidence: "The page says 27m.", why: "The dimension is outside a plausible bag range.", fix: "Confirm the actual dimension.", status,
});

test("review issue parsing is strict and creates stable ids from semantic keys", () => {
  const reply = (evidence: string) => JSON.stringify({ issues: [{
    key: "dimension:product-12:length", level: "P1", kind: "product", page: "Product: Bag",
    url: "https://shop.test/product/bag/", evidence, why: "27m is not plausible for a bag.",
    fix: "Verify the real measurement before publishing.", needs_real_data: true,
  }] });
  const a = parseReviewIssues(reply("Visible specification: 27m."), "shot.png")[0];
  const b = parseReviewIssues(reply("The product table visibly says 27m."), "shot2.png")[0];
  assert.equal(a.issue.id, b.issue.id);
  assert.equal(a.issue.status, "needs_you");
  assert.equal(a.action, undefined, "real-data issues can never carry an automatic action");
  assert.equal(a.issue.shot, "shot.png");
  const otherPage = parseReviewIssues(reply("Visible specification: 27m.").replace("/product/bag/", "/product/other/"))[0];
  assert.notEqual(a.issue.id, otherPage.issue.id, "the same semantic key on different pages must not collide");

  assert.throws(() => parseReviewIssues(JSON.stringify({ issues: [{
    key: "x", level: "P0", kind: "product", page: "x", url: "x", evidence: "x", why: "x", fix: "x", needs_real_data: false,
  }] })), /level/);
  // 不在允许列表的动作只丢掉动作，问题保留为未修；不能让一条坏建议作废整份复核（实测 2026-10-15）
  const unsafe = parseReviewIssues(JSON.stringify({ issues: [{
    key: "x", level: "P2", kind: "copy", page: "x", url: "x", evidence: "x", why: "x", fix: "x", needs_real_data: false,
    action: { tool: "delete_everything", params: {} },
  }] }))[0];
  assert.equal(unsafe.action, undefined);
  assert.equal(unsafe.issue.status, "open");

  const guarded = parseReviewIssues(JSON.stringify({ issues: [{
    key: "dimension:x", level: "P1", kind: "product", page: "x", url: "https://shop.test/x/",
    evidence: "Size is listed as 27m", why: "The actual measurement is unknown", fix: "Verify and replace it", needs_real_data: false,
    action: { tool: "update_product", params: { summary: "修正尺寸", id: 1, description_html: "27 cm" } },
  }] }))[0];
  assert.equal(guarded.issue.status, "needs_you", "the model cannot bypass real-data safeguards with a false flag");
  assert.equal(guarded.action, undefined);
});

test("auto-fix loop re-reviews after each change, stops at two rounds and keeps needs_you P1 open", async () => {
  let collects = 0, inspections = 0, applies = 0;
  const snapshot = {
    targets: [], captures: [{ name: "product", path: "/product/bag/", url: "https://shop.test/product/bag/", text: "ok", shot: "bag.png" }],
    products: [], categories: [], sourceFacts: [], spec: {}, config: {},
  } satisfies ReviewSnapshot;
  const actionable = (): ReviewFinding => ({
    issue: issue("product-copy"), needsRealData: false,
    action: { tool: "update_product", params: { summary: "修正文案", id: 1, name: `Bag ${inspections}` } },
  });
  const realData = (): ReviewFinding => ({ issue: issue("product-dimension", "P1", "needs_you"), needsRealData: true });
  const persisted: number[] = [];
  const review = await runReviewLoop({
    now: () => 1234,
    collect: async () => { collects++; return snapshot; },
    inspect: async () => { inspections++; return [actionable(), realData()]; },
    apply: async () => { applies++; return true; },
    persist: (r) => persisted.push(r.rounds),
  });
  assert.equal(review.rounds, 2);
  assert.equal(collects, 3, "initial review plus one fresh crawl after each fix round");
  assert.equal(inspections, 3);
  assert.equal(applies, 2, "third finding is not applied because the two-round ceiling is reached");
  assert.equal(review.passed, false);
  assert.equal(review.issues.find((x) => x.id === "product-dimension")?.status, "needs_you");
  assert.deepEqual(persisted, [0, 1, 1, 2, 2]);
});

test("resolved findings remain as fixed history and a review without unresolved P1 passes", async () => {
  let pass = 0;
  const snapshot = {
    targets: [], captures: [{ name: "product", path: "/product/bag/", url: "https://shop.test/product/bag/", text: "ok", shot: "bag.png" }],
    products: [], categories: [], sourceFacts: [], spec: {}, config: {},
  } satisfies ReviewSnapshot;
  const review = await runReviewLoop({
    now: () => 9,
    collect: async () => snapshot,
    inspect: async () => pass++ === 0 ? [{
      issue: issue("copy-p2", "P2"), needsRealData: false,
      action: { tool: "update_product", params: { summary: "fix", id: 1, name: "Bag" } },
    }] : [],
    apply: async () => true,
  });
  assert.equal(review.rounds, 1);
  assert.equal(review.passed, true);
  assert.equal(review.issues[0].status, "fixed");
});

test("an earlier issue is not marked fixed when its page was not captured in the fresh review", async () => {
  const snapshot = {
    targets: [], captures: [{ name: "home", path: "/", url: "https://shop.test/", text: "ok", shot: "home.png" }],
    products: [], categories: [], sourceFacts: [], spec: {}, config: {},
  } satisfies ReviewSnapshot;
  const old = issue("missing-product-page");
  const review = await runReviewLoop({
    now: () => 1, collect: async () => snapshot, inspect: async () => [], apply: async () => false,
    previous: { at: 0, rounds: 0, passed: false, issues: [old] },
  });
  assert.equal(review.issues[0].status, "open");
  assert.equal(review.passed, false);
});

test("crawl enumerates REST pagination, all products and category/shop archive pages", async () => {
  const calls: string[] = [];
  const ctx = {
    wp: async (_method: string, path: string) => {
      calls.push(path);
      if (path.startsWith("wp/v2/pages")) return path.includes("page=1") ? [{ id: 1, slug: "home", link: "https://shop.test/" }] : [];
      if (path.startsWith("wp/v2/posts")) return [];
      if (path.startsWith("wc/v3/products/categories")) return path.includes("page=1") ? [{ id: 7, name: "Travel", slug: "travel", count: 17 }] : [];
      if (/wc\/v3\/products\/\d+\/variations/.test(path)) return [];
      if (path.startsWith("wc/v3/products")) return path.includes("page=1") ? Array.from({ length: 17 }, (_, i) => ({ id: i + 1, slug: `bag-${i + 1}`, permalink: `https://shop.test/product/bag-${i + 1}/` })) : [];
      throw new Error(path);
    },
  } as unknown as StepCtx;
  const result = await crawlReviewTargets(ctx);
  assert.equal(result.targets.filter((x) => x.kind === "product").length, 17);
  assert(result.targets.some((x) => x.path === "/shop/page/2/"));
  assert(result.targets.some((x) => x.path === "/product-category/travel/page/2/"));
  assert(result.targets.some((x) => x.name === "search-products" && x.path.startsWith("/?s=")));
  assert(result.targets.some((x) => x.name === "search-no-results"));
  assert(calls.every((x) => /(?:\?|&)page=\d+/.test(x)), "every collection and variation request uses explicit pagination");
});

test("full snapshot collection fails closed when a legacy browser fake omits page text", async () => {
  const ctx = {
    domain: "shop.test", site: { products_json: "[]", spec_json: "{}" },
    wp: async (_method: string, path: string) => {
      if (path.startsWith("wp/v2/pages")) return path.includes("page=1") ? [{ id: 1, slug: "home", link: "https://shop.test/" }] : [];
      if (path.startsWith("wp/v2/posts")) return [];
      if (path.startsWith("wc/v3/products/categories")) return [];
      if (path.startsWith("wc/v3/products")) return [];
      throw new Error(path);
    },
    d: { browse: async () => ({ shots: [], problems: [] }) },
  } as unknown as StepCtx;
  await assert.rejects(collectReviewSnapshot(ctx, "https://login.test", "qa"), /抓取不完整/);
});

test("production review saves a synthetic unresolved P1 instead of losing the report when vision is unavailable", async () => {
  let saved = "";
  const ctx = {
    domain: "shop.test", site: { id: 1, qa_json: null },
    d: { now: () => 55 }, save: (_column: string, value: string) => { saved = value; },
  } as unknown as StepCtx;
  const review = await runFullSiteReview(ctx, { loginUrl: "https://login.test" });
  assert.equal(review.passed, false);
  assert.equal(review.issues[0].level, "P1");
  assert.match(review.issues[0].evidence, /vision/i);
  assert.deepEqual((JSON.parse(saved) as { review: { passed: boolean } }).review.passed, false);
});

test("long page text is reviewed in lossless bounded chunks", () => {
  const text = "x".repeat(70_001);
  const chunks = splitReviewText(text);
  assert.equal(chunks.join(""), text);
  assert(chunks.every((x) => x.length <= 32_000));
});

test("pagination accepts only WordPress's explicit page-past-end 400", async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, slug: `p-${i}`, link: `https://shop.test/p-${i}/` }));
  const ctx = { wp: async (_method: string, path: string) => {
    if (path.startsWith("wp/v2/pages")) {
      if (/(?:\?|&)page=1(?:&|$)/.test(path)) return hundred;
      throw new Error("HTTP 400: The page number requested is larger than the number of pages available.");
    }
    return [];
  } } as unknown as StepCtx;
  assert.equal((await crawlReviewTargets(ctx)).targets.filter((x) => x.kind === "page").length, 100);
});

test("questionable dimensions and unclear source variants deterministically become needs_you", () => {
  const capture = { name: "product-8-bag", path: "/product/bag/", url: "https://shop.test/product/bag/", text: "Bag", shot: "bag.png" };
  const snapshot: ReviewSnapshot = {
    targets: [{ name: capture.name, path: capture.path, kind: "product", targetId: 8 }], captures: [capture], products: [], categories: [], spec: {}, config: {},
    sourceFacts: [{ productId: 8, source: {
      product: { pid: "p", name: "Travel Bag", category: "Bags", materials: [], description: "Length 27m", images: [], keyNames: ["Style"], variants: [{ key: "Mystery set", cost: 1, weight: 1, length: 27000, width: 1, height: 1 }] },
      analysis: { title: "Bag", short_description: "Bag", description_html: "<p>Bag</p>", materials_and_care_html: null, image_alt: "Bag", mainImage: "x", metaDescription: "Bag", ogDescription: "Bag", variants: [{ sourceKey: "Mystery set", buyerName: "Mystery", clear: false, pieceCount: null, components: [], color: null, evidence: "unclear" }] },
      unitReview: { questionable: [{ sourceKey: "Mystery set", fields: ["length"], reason: "27m is implausible" }] },
    } }],
  };
  const findings = deterministicSourceFindings(snapshot);
  assert.equal(findings.length, 2);
  assert(findings.every((x) => x.issue.level === "P2" && x.issue.status === "needs_you" && !x.action));
});

test("a changed source-facts fingerprint lets a successfully re-reviewed needs_you issue close", async () => {
  const old = issue("source-old", "P2", "needs_you");
  const snapshot = { targets: [], captures: [{ name: "p", path: "/product/bag/", url: old.url, text: "ok", shot: "x" }], products: [], categories: [], sourceFacts: [{ verified: true }], spec: {}, config: {} } satisfies ReviewSnapshot;
  const review = await runReviewLoop({ now: () => 1, collect: async () => snapshot, inspect: async () => [], apply: async () => false,
    previous: { at: 0, rounds: 0, passed: true, issues: [old] }, previousFactsHash: "old" });
  assert.equal(review.issues[0].status, "fixed");
});

test("fix rounds are reserved before writes so a partial failure cannot reset the retry budget", async () => {
  const snapshot = { targets: [], captures: [{ name: "p", path: "/product/bag/", url: issue("x").url, text: "ok", shot: "x" }], products: [], categories: [], sourceFacts: [], spec: {}, config: {} } satisfies ReviewSnapshot;
  const finding = (id: string): ReviewFinding => ({ issue: issue(id, "P2"), needsRealData: false, action: { tool: "update_product", params: { summary: id, id: 1, name: "Bag" } } });
  let calls = 0;
  const first = await runReviewLoop({ now: () => 1, collect: async () => snapshot, inspect: async () => [finding("a"), finding("b")], maxRounds: 1,
    apply: async () => { calls++; if (calls === 2) throw new Error("validation failed"); return true; } });
  assert.equal(first.rounds, 1);
  const retry = await runReviewLoop({ now: () => 2, collect: async () => snapshot, inspect: async () => [finding("c")], previous: first, maxRounds: 2, apply: async () => true });
  assert.equal(retry.rounds, 2);
});
