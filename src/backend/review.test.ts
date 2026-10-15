import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewIssue } from "../shared/protocol.ts";
import type { StepCtx } from "./pipeline.ts";
import { collectReviewSnapshot, crawlReviewTargets, deterministicSourceFindings, deterministicUnderwritingFindings, parseReviewIssues, reviewWithRetry, runFullSiteReview, runReviewLoop, type ReviewFinding, type ReviewSnapshot } from "./review.ts";

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

test("crawl reviews required trust pages, every product and first archives only", async () => {
  const calls: string[] = [];
  const ctx = {
    wp: async (_method: string, path: string) => {
      calls.push(path);
      if (path.startsWith("wp/v2/pages")) return path.includes("page=1") ? ["home", "about", "contact", "faq", "shipping", "returns", "privacy-policy", "cart", "checkout", "my-account", "terms", "sample-page"].map((slug, i) => ({ id: i + 1, slug, link: `https://shop.test/${slug === "home" ? "" : slug + "/"}` })) : [];
      if (path.startsWith("wp/v2/posts")) return [];
      if (path.startsWith("wc/v3/products/categories")) return path.includes("page=1") ? [{ id: 7, name: "Travel", slug: "travel", count: 17 }] : [];
      if (/wc\/v3\/products\/\d+\/variations/.test(path)) return [];
      if (path.startsWith("wc/v3/products")) return path.includes("page=1") ? Array.from({ length: 17 }, (_, i) => ({ id: i + 1, slug: `bag-${i + 1}`, permalink: `https://shop.test/product/bag-${i + 1}/` })) : [];
      throw new Error(path);
    },
  } as unknown as StepCtx;
  const result = await crawlReviewTargets(ctx);
  assert.equal(result.targets.filter((x) => x.kind === "product").length, 17);
  for (const path of ["/", "/about/", "/contact/", "/faq/", "/shipping/", "/returns/", "/privacy-policy/", "/terms/", "/shop/", "/product-category/travel/"]) assert(result.targets.some((x) => x.path === path), path);
  assert(!result.targets.some((x) => /cart|checkout|my-account|sample-page|\/page\/|\?s=/.test(x.path)));
  assert(!calls.some((x) => x.startsWith("wp/v2/posts")), "blog posts are outside the review scope");
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

test("pagination accepts only WordPress's explicit page-past-end 400", async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, slug: `about-${i}`, link: `https://shop.test/about-${i}/` }));
  const ctx = { wp: async (_method: string, path: string) => {
    if (path.startsWith("wp/v2/pages")) {
      if (/(?:\?|&)page=1(?:&|$)/.test(path)) return hundred;
      throw new Error("HTTP 400: The page number requested is larger than the number of pages available.");
    }
    return [];
  } } as unknown as StepCtx;
  assert.equal((await crawlReviewTargets(ctx)).targets.filter((x) => x.kind === "page").length, 0);
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

test("a malformed review reply is retried once with the parse error, then fails closed (live failure 2026-10-15)", async () => {
  const good = JSON.stringify({ issues: [] });
  const prompts: string[] = [];
  const replies = ["{\"issues\":[{\"key\":\"x\" \"level\":\"P1\"}]}", good];
  const findings = await reviewWithRetry(async (extra) => { prompts.push(extra); return { text: replies.shift()!, cost: 0 }; });
  assert.deepEqual(findings, []);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /not valid/);
  await assert.rejects(reviewWithRetry(async () => ({ text: "not json", cost: 0 })));
});

const completeReviewPages = ["home", "about", "contact", "shipping", "returns", "privacy-policy", "terms"].map((slug, index) => ({
  id: index + 1, slug, link: `https://shop.test/${slug === "home" ? "" : `${slug}/`}`, title: { rendered: slug }, status: "publish",
}));

function reviewFixture(options: { text?: string; reply?: string; site?: unknown; entity?: unknown; payments?: unknown; products?: Record<string, unknown>[]; pages?: Record<string, unknown>[] } = {}) {
  const prompts: string[] = [], visualPrompts: string[] = [], browseInputs: unknown[] = [];
  const site = { qa_json: null as string | null, spec_json: "{}", picks_json: JSON.stringify([{ productId: 8, source: { marker: "CJ-ONLY-BAG" } }, { productId: 9, source: { marker: "CJ-NOT-ON-PAGE" } }]) };
  const entity = options.entity ?? { name: "Harbor Goods LLC", address: "7428 Harbor Avenue, Portland, OR 97205", supportEmail: "support@shop.test", phone: "+1 207 736 1829", processingDays: [1, 3], transitDays: [5, 10] };
  const pageRows = options.pages ?? completeReviewPages;
  const ctx = {
    domain: "shop.test", site, entity,
    save: (_column: string, value: string) => { site.qa_json = value; }, emit: () => {},
    wp: async (_method: string, path: string) => {
      if (path.startsWith("wp/v2/pages")) return pageRows;
      if (path.startsWith("wc/v3/products/categories")) return [];
      if (/products\/\d+\/variations/.test(path)) return [];
      if (path.startsWith("wc/v3/products")) return options.products ?? [{ id: 8, name: "Travel Bag", slug: "bag", permalink: "https://shop.test/product/bag/" }, { id: 9, name: "Special Umbrella", slug: "umbrella", permalink: "https://shop.test/product/umbrella/" }];
      if (path === "site-agent/v1/site") return options.site ?? { options: { custom_logo: 12, site_icon: 13 }, info: {} };
      if (path === "wc/v3/payment_gateways") return options.payments ?? [{ id: "stripe", enabled: true }];
      if (path === "wc/v3/settings/general/woocommerce_currency") return { value: "USD" };
      if (path === "wc/v3/shipping/zones") return [];
      if (path === "site-agent/v1/metadata") return {};
      throw new Error(path);
    },
    d: {
      now: () => 1, workDir: "qa", ai: async (_role: string, prompt: string) => { prompts.push(prompt); return { text: options.reply ?? '{"issues":[]}', cost: 0 }; },
      browse: async (input: { pages: { name: string; path: string }[]; cart?: unknown }) => {
        browseInputs.push(input);
        const footerLinks = completeReviewPages.slice(1).map((page) => ({ url: page.link, text: page.slug, location: "footer" as const }));
        return { problems: [], shots: [], captures: [...input.pages, { name: "cart", path: "/cart/" }, { name: "home-mobile", path: "/" }].map((p) => {
          const email = (entity as { supportEmail?: string }).supportEmail === "auto" ? "support@shop.test" : (entity as { supportEmail?: string }).supportEmail ?? "support@shop.test";
          const phone = (entity as { phone?: string }).phone ?? "+1 207 736 1829";
          const body = `${options.text ?? "Travel Bag"}\n${(entity as { name?: string }).name ?? "Harbor Goods LLC"}\n${email}\n${phone}\n${(entity as { address?: string }).address ?? "7428 Harbor Avenue, Portland, OR 97205"}${p.path === "/shipping/" ? "\nOrders ship in 2-3 business days. Customers may cancel before shipment." : ""}${/^\/(?:product|shop)\//.test(p.path) ? "\n$19.99 USD" : ""}`;
          const sections = { header: "Harbor Goods", body, footer: `${(entity as { name?: string }).name ?? "Harbor Goods LLC"} | ${email} | ${phone} | ${(entity as { address?: string }).address ?? "7428 Harbor Avenue, Portland, OR 97205"}` };
          return { ...p, url: `https://shop.test${p.path}`, text: `${sections.header}\n${sections.body}\n${sections.footer}`, sections, links: footerLinks, linkStatuses: footerLinks.map((link) => ({ url: link.url, status: 200 })), status: 200, productLinks: ["https://shop.test/product/bag/"], shot: "shot.png" };
        }) };
      },
    },
  } as unknown as StepCtx;
  const vision = async (prompt: string) => { visualPrompts.push(prompt); return { text: '{"issues":[]}', cost: 0 }; };
  return { ctx, prompts, visualPrompts, browseInputs, vision };
}

test("trust review sends long page text once with only on-page product facts and explicit focus/limit", async () => {
  const text = "Travel Bag " + "long page body ".repeat(5000), f = reviewFixture({ text });
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.equal(report.passed, true);
  assert.equal(f.prompts.length, 10, "one text request per target, not per chunk or shopping flow");
  assert.equal(f.visualPrompts.length, 10);
  const home = f.prompts.find((p) => p.includes("PAGE URL:\nhttps://shop.test/\n"))!;
  for (const phrase of [/at most 5 issues per page/i, /Returns\/refund/i, /About us/i, /Contact/i, /CJ source/i, /logo/i, /favicon/i, /payment/i, /ignore.*outside/i]) assert.match(home, phrase);
  assert.equal(home.split(text).length, 2, "full page text occurs exactly once");
  assert.match(home, /CJ-ONLY-BAG/);
  assert.doesNotMatch(home, /CJ-NOT-ON-PAGE|Special Umbrella/);
  assert(f.browseInputs.every((input) => !(input as { cart?: unknown }).cart));
});

test("review ignores out-of-focus model findings and caps merged findings to five per page in severity order", async () => {
  const reply = JSON.stringify({ issues: [
    { key: "seo", level: "P1", kind: "seo", focus: "seo", page: "Home", url: "https://shop.test/", evidence: "Missing metadata", why: "SEO", fix: "Add metadata", needs_real_data: false },
    ...Array.from({ length: 9 }, (_, i) => ({ key: `trust-${i}`, level: i === 8 ? "P1" : "P2", kind: "copy", focus: "store_trust", page: "Home", url: "https://shop.test/", evidence: `Demo leftover ${i}`, why: "Demo content", fix: "Remove demo copy", needs_real_data: false })),
  ] });
  const f = reviewFixture({ reply });
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  for (const url of new Set(report.issues.map((i) => i.url))) {
    const rows = report.issues.filter((i) => i.url === url);
    assert.equal(rows.length, 5);
    assert.equal(rows[0].level, "P1");
    assert(rows.every((i) => i.kind !== "seo"));
  }
  assert.equal(report.passed, false);
});

test("placeholder operator/address and missing custom logo/favicon are deterministic needs-you trust findings", async () => {
  const f = reviewFixture({ site: { options: { custom_logo: 0, site_icon: 0 }, info: {} }, entity: { name: "Test Store LLC", address: "1 Main St, Austin, TX 78701" } });
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  const evidence = report.issues.map((i) => `${i.evidence} ${i.fix}`).join("\n");
  assert.match(evidence, /Test Store LLC/);
  assert.match(evidence, /1 Main St/);
  assert.match(evidence, /custom logo/i);
  assert.match(evidence, /site icon|favicon/i);
  assert(report.issues.filter((i) => /placeholder/i.test(i.why)).every((i) => i.status === "needs_you"));
});

test("review history cannot grow beyond five issues per page across repeated reviews", async () => {
  const url = "https://shop.test/product/bag/";
  const snapshot: ReviewSnapshot = { targets: [], captures: [{ name: "p", path: "/product/bag/", url, text: "Bag", shot: "bag.png" }], products: [], categories: [], sourceFacts: [], spec: {}, config: {} };
  const previous = { at: 0, rounds: 0, passed: true, issues: Array.from({ length: 5 }, (_, i) => issue(`old-${i}`, "P2", "needs_you")) };
  const report = await runReviewLoop({ now: () => 1, previous, collect: async () => snapshot, inspect: async () => Array.from({ length: 5 }, (_, i) => ({ issue: issue(`new-${i}`, i === 4 ? "P1" : "P2"), needsRealData: false })), apply: async () => false });
  assert.equal(report.issues.length, 5);
  assert.equal(report.issues[0].level, "P1");
  assert.equal(report.passed, false);
});

test("real trust facts changing can resolve a previous needs_you without changing CJ data", async () => {
  const f = reviewFixture({ entity: { name: "Test Store LLC", address: "1 Main St" } });
  let report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  const placeholderId = report.issues.find((i) => /placeholders/.test(i.evidence))!.id;
  f.ctx.entity.name = "Harbor Goods LLC"; f.ctx.entity.address = "7428 Harbor Avenue, Portland, OR 97205";
  report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.equal(report.issues.find((i) => i.id === placeholderId)?.status, "fixed");
});

test("cosmetic findings cannot bypass scope by labelling themselves trust/product/policy", async () => {
  const reply = JSON.stringify({ issues: [
    { focus: "store_trust", evidence: "The contact phone font is small" },
    { focus: "product_consistency", evidence: "Product image gallery has too much whitespace" },
    { focus: "operator_policy", evidence: "Returns policy typography is plain" },
  ].map((v, i) => ({ ...v, key: `cosmetic-${i}`, level: "P1", kind: "visual", page: "Page", url: "https://shop.test/", why: "Improve layout and styling", fix: "Adjust CSS", needs_real_data: false })) });
  const f = reviewFixture({ reply });
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.deepEqual(report.issues, []);
});

test("overlapping product names cannot leak off-page CJ facts", async () => {
  const f = reviewFixture({ products: [{ id: 8, name: "Travel Bag", permalink: "https://shop.test/product/bag/" }, { id: 9, name: "Bag", permalink: "https://shop.test/product/other-bag/" }] });
  await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  const home = f.prompts.find((p) => p.includes("PAGE URL:\nhttps://shop.test/\n"))!;
  assert.match(home, /CJ-ONLY-BAG/);
  assert.doesNotMatch(home, /CJ-NOT-ON-PAGE/);
});

test("review preserves three-way page concurrency", async () => {
  const f = reviewFixture(); let active = 0, peak = 0;
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: async () => {
    peak = Math.max(peak, ++active); await new Promise((resolve) => setTimeout(resolve, 2)); active--;
    return { text: '{"issues":[]}', cost: 0 };
  } });
  assert.equal(report.passed, true);
  assert.equal(peak, 3);
});

test("site payment needs_you survives even when five P1 page findings fill the page cap", async () => {
  const reply = JSON.stringify({ issues: Array.from({ length: 5 }, (_, i) => ({ key: `p1-${i}`, level: "P1", focus: "store_trust", kind: "copy", page: "Home", url: "https://shop.test/", evidence: `Demo leftover ${i}`, why: "Placeholder demo content", fix: "Remove demo copy", needs_real_data: false })) });
  const f = reviewFixture({ payments: [], reply, site: { options: { custom_logo: 0, site_icon: 0 }, info: {} } });
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  const home = report.issues.filter((i) => i.url === "https://shop.test/");
  assert.equal(home.length, 5); assert(home.every((i) => i.level === "P1"));
  const payment = report.issues.find((i) => i.page === "Payment setup")!;
  assert.equal(payment.status, "needs_you"); assert.match(payment.url, /wp-admin\/admin.php/); assert.equal(payment.shot, undefined);
});

test("correct URL with mismatched capture name fails closed instead of skipping review", async () => {
  const f = reviewFixture(); const browse = f.ctx.d.browse!;
  f.ctx.d.browse = async (input) => { const result = await browse(input); return { ...result, captures: result.captures?.map((c) => ({ ...c, name: "wrong-name" })) }; };
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.equal(report.passed, false); assert.match(report.issues[0].evidence, /抓取不完整/); assert.equal(f.prompts.length, 0);
});

test("a missing visible phone needs real data only when the actual store facts lack it", async () => {
  const reply = JSON.stringify({ issues: [{ key: "contact-phone", focus: "store_trust", level: "P2", kind: "copy", page: "Contact details", url: "https://shop.test/", evidence: "The contact phone number is missing from the page", why: "Contact details are incomplete", fix: "Display the supplied phone number", needs_real_data: false }] });
  for (const [phone, expected] of [["+1 207 736 1829", "open"], ["", "needs_you"]] as const) {
    const f = reviewFixture({ reply, entity: { name: "Harbor Goods LLC", address: "7428 Harbor Avenue", phone } });
    const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
    assert(report.issues.every((i) => i.status === expected), phone);
  }
});

test("vague and perfunctory About copy remains in scope without admitting cosmetic complaints", async () => {
  const reply = JSON.stringify({ issues: [{ key: "about-boilerplate", focus: "operator_policy", level: "P2", kind: "copy", page: "About us", url: "https://shop.test/about/", evidence: "About copy is vague and perfunctory, not store-specific", why: "It lacks concrete detail and is not believable", fix: "Use the supplied operator facts to explain the store", needs_real_data: false }] });
  const f = reviewFixture();
  f.ctx.d.ai = async (_role, prompt) => { f.prompts.push(prompt); return { text: prompt.includes("PAGE URL:\nhttps://shop.test/about/\n") ? reply : '{"issues":[]}', cost: 0 }; };
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.equal(report.issues.length, 1); assert.equal(report.issues[0].url, "https://shop.test/about/");
});

function underwritingSnapshot(): ReviewSnapshot {
  const entity = {
    name: "Harbor Goods LLC",
    address: "7428 Harbor Avenue, Portland, OR 97205",
    supportEmail: "support@shop.test",
    phone: "+1 (207) 736-1829",
  };
  const definitions = [
    ["home", "/", "Home"],
    ["about", "/about/", "About"],
    ["contact", "/contact/", "Contact"],
    ["shipping", "/shipping/", "Shipping"],
    ["returns", "/returns/", "Returns and Refunds"],
    ["privacy-policy", "/privacy-policy/", "Privacy Policy"],
    ["terms", "/terms/", "Terms and Conditions"],
  ] as const;
  const footerLinks = definitions.slice(1).map(([slug, path, title]) => ({ url: `https://shop.test${path}`, text: title, location: "footer" as const, slug }));
  const captures = definitions.map(([slug, path, title]) => {
    const policy = slug === "shipping" ? "Orders ship in 2-3 business days. You may cancel an order before shipment." : "";
    const sections = {
      header: "Harbor Goods",
      body: `${title}\nHarbor Goods LLC\nsupport@shop.test\n+1 207 736 1829\n7428 Harbor Avenue, Portland, OR 97205\n${policy}\nPrice: $19.99 USD`,
      footer: "Harbor Goods LLC | support@shop.test | (207) 736-1829 | 7428 Harbor Avenue, Portland, OR 97205",
    };
    return {
      name: slug, path, url: `https://shop.test${path}`, text: `${sections.header}\n${sections.body}\n${sections.footer}`,
      sections, links: footerLinks, linkStatuses: footerLinks.map((link) => ({ url: link.url, status: 200 })), status: 200,
    };
  });
  return {
    targets: [], captures, products: [], categories: [], sourceFacts: [], spec: {},
    config: { domain: "shop.test", currency: "USD", entity },
    pages: definitions.slice(1).map(([slug, path, title], index) => ({ id: index + 1, slug, link: `https://shop.test${path}`, title: { rendered: title }, status: "publish" })),
  } as unknown as ReviewSnapshot;
}

test("underwriting deterministic baseline accepts one complete and internally consistent store", () => {
  assert.deepEqual(deterministicUnderwritingFindings(underwritingSnapshot()), []);
});

test("underwriting accepts a generated operator paragraph without swallowing its address or following sentence", () => {
  const snapshot = underwritingSnapshot();
  const about = snapshot.captures.find((capture) => capture.path === "/about/")! as typeof snapshot.captures[number] & { sections: { body: string } };
  about.sections.body += "\nOperated by Harbor Goods LLC, 7428 Harbor Avenue, Portland, OR 97205. The customer comes first.";
  assert.deepEqual(deterministicUnderwritingFindings(snapshot), []);
});

test("underwriting requires the exact legal name in the page body rather than accepting only the footer", () => {
  const snapshot = underwritingSnapshot();
  const about = snapshot.captures.find((capture) => capture.path === "/about/")! as typeof snapshot.captures[number] & { sections: { body: string; footer: string } };
  about.sections.body = about.sections.body.replace("Harbor Goods LLC", "Harbor Goods");
  assert.match(about.sections.footer, /Harbor Goods LLC/);
  const finding = deterministicUnderwritingFindings(snapshot).find((row) => row.semanticKey === "underwriting-legal-name-missing-about");
  assert(finding); assert.equal(finding.issue.level, "P1");
});

test("underwriting consistency catches a different legal entity spelling with exact page evidence", () => {
  const snapshot = underwritingSnapshot();
  const about = snapshot.captures.find((capture) => capture.path === "/about/")! as typeof snapshot.captures[number] & { sections: { body: string } };
  about.sections.body += "\nOperated by Harbour Goods LLC";
  about.text += "\nOperated by Harbour Goods LLC";
  const findings = deterministicUnderwritingFindings(snapshot);
  const mismatch = findings.find((finding) => /legal business name/i.test(finding.issue.why) && /Harbour Goods LLC/.test(finding.issue.evidence));
  assert(mismatch); assert.equal(mismatch.issue.level, "P1"); assert.equal(mismatch.issue.kind, "config"); assert.equal(mismatch.issue.url, "https://shop.test/about/");
});

test("underwriting legal-name comparison treats different casing as a mismatch", () => {
  const snapshot = underwritingSnapshot();
  const contact = snapshot.captures.find((capture) => capture.path === "/contact/")! as typeof snapshot.captures[number] & { sections: { body: string } };
  contact.sections.body = contact.sections.body.replace("Harbor Goods LLC", "HARBOR GOODS LLC");
  const evidence = deterministicUnderwritingFindings(snapshot).filter((row) => row.issue.url === contact.url).map((row) => row.issue.evidence).join("\n");
  assert.match(evidence, /HARBOR GOODS LLC/); assert.match(evidence, /Expected legal business name is absent/);
});

test("underwriting email consistency rejects every foreign or different email address", () => {
  const snapshot = underwritingSnapshot();
  const contact = snapshot.captures.find((capture) => capture.path === "/contact/")! as typeof snapshot.captures[number] & { sections: { body: string } };
  contact.sections.body += "\nWholesale: sales@foreign.example";
  const findings = deterministicUnderwritingFindings(snapshot);
  assert(findings.some((finding) => finding.issue.url === contact.url && /sales@foreign\.example/.test(finding.issue.evidence) && /email/i.test(finding.issue.why)));
});

test("underwriting phone comparison ignores formatting but catches different digits", () => {
  const valid = underwritingSnapshot();
  assert(!deterministicUnderwritingFindings(valid).some((finding) => /phone/i.test(finding.issue.why)));
  const changed = underwritingSnapshot();
  const contact = changed.captures.find((capture) => capture.path === "/contact/")! as typeof changed.captures[number] & { sections: { body: string } };
  contact.sections.body += "\nCall (503) 555-0198";
  const findings = deterministicUnderwritingFindings(changed);
  assert(findings.some((finding) => finding.issue.url === contact.url && /\(503\) 555-0198/.test(finding.issue.evidence) && /phone/i.test(finding.issue.why)));
});

test("underwriting address consistency catches a different street address", () => {
  const snapshot = underwritingSnapshot();
  const privacy = snapshot.captures.find((capture) => capture.path === "/privacy-policy/")! as typeof snapshot.captures[number] & { sections: { body: string } };
  privacy.sections.body += "\nMail: 91 Market Street, Seattle, WA 98101";
  const findings = deterministicUnderwritingFindings(snapshot);
  assert(findings.some((finding) => finding.issue.url === privacy.url && /91 Market Street, Seattle, WA 98101/.test(finding.issue.evidence) && /address/i.test(finding.issue.why)));
});

test("underwriting completeness catches a policy link missing from one page footer", () => {
  const snapshot = underwritingSnapshot();
  const home = snapshot.captures.find((capture) => capture.path === "/")! as typeof snapshot.captures[number] & { links: { url: string; text: string; location: string }[] };
  home.links = home.links.filter((link) => !link.url.endsWith("/returns/"));
  const findings = deterministicUnderwritingFindings(snapshot);
  assert(findings.some((finding) => finding.issue.url === home.url && /Returns\/refund/.test(finding.issue.evidence) && /footer/i.test(finding.issue.why)));
});

test("underwriting footer check rejects a foreign URL even when its label and path look correct", () => {
  const snapshot = underwritingSnapshot();
  const home = snapshot.captures.find((capture) => capture.path === "/")! as typeof snapshot.captures[number] & { links: { url: string; text: string; location: string }[] };
  home.links = home.links.map((link) => link.url.endsWith("/returns/") ? { ...link, url: "https://foreign.example/returns/" } : link);
  const finding = deterministicUnderwritingFindings(snapshot).find((row) => row.issue.url === home.url && /Returns\/refund/.test(row.issue.evidence));
  assert(finding); assert.match(finding.issue.why, /published.*this store/i);
});

test("underwriting completeness catches broken internal links with status and exact URL", () => {
  const snapshot = underwritingSnapshot();
  const terms = snapshot.captures.find((capture) => capture.path === "/terms/")! as typeof snapshot.captures[number] & { linkStatuses: { url: string; status: number }[] };
  terms.linkStatuses.push({ url: "https://shop.test/missing/", status: 404 });
  const findings = deterministicUnderwritingFindings(snapshot);
  assert(findings.some((finding) => finding.issue.url === terms.url && /https:\/\/shop\.test\/missing\//.test(finding.issue.evidence) && /404/.test(finding.issue.evidence)));
});

test("underwriting does not treat a missing HTTP response or failed crawled page as passing", () => {
  const snapshot = underwritingSnapshot();
  const terms = snapshot.captures.find((capture) => capture.path === "/terms/")! as typeof snapshot.captures[number] & { status: number; linkStatuses: { url: string; status: number }[] };
  terms.status = 500; terms.linkStatuses.push({ url: "https://shop.test/contact/", status: 0 }, { url: "https://shop.test/unsafe-redirect/", status: 302 });
  const evidence = deterministicUnderwritingFindings(snapshot).filter((row) => row.issue.url === terms.url).map((row) => row.issue.evidence).join("\n");
  assert.match(evidence, /HTTP 500/); assert.match(evidence, /HTTP 0/); assert.match(evidence, /HTTP 302/);
});

test("underwriting flags a configured support email outside the store domain as needs_you", () => {
  const snapshot = underwritingSnapshot();
  (snapshot.config as { entity: { supportEmail: string } }).entity.supportEmail = "owner@gmail.com";
  const finding = deterministicUnderwritingFindings(snapshot).find((row) => row.semanticKey === "underwriting-configured-email-foreign-domain");
  assert(finding); assert.equal(finding.issue.level, "P1"); assert.equal(finding.issue.status, "needs_you");
});

test("underwriting completeness checks published pages, USD, shipping timeframe and cancellation", () => {
  const snapshot = underwritingSnapshot();
  snapshot.pages = (snapshot.pages as { slug: string; status: string }[]).filter((page) => page.slug !== "terms");
  (snapshot.config as { currency: string }).currency = "EUR";
  const shipping = snapshot.captures.find((capture) => capture.path === "/shipping/")! as typeof snapshot.captures[number] & { sections: { body: string } };
  shipping.sections.body = "Harbor Goods LLC ships orders. Price: EUR 19.99";
  shipping.text = `${shipping.sections.body}\n${(shipping as unknown as { sections: { footer: string } }).sections.footer}`;
  const findings = deterministicUnderwritingFindings(snapshot);
  const evidence = findings.map((finding) => `${finding.issue.evidence} ${finding.issue.why}`).join("\n");
  assert.match(evidence, /Terms.*published/i);
  assert.match(evidence, /USD/);
  assert.match(evidence, /shipping timeframe/i);
  assert.match(evidence, /cancellation rule/i);
});

test("underwriting cannot use footer identity to excuse a completely empty About body", () => {
  const snapshot = underwritingSnapshot();
  const about = snapshot.captures.find((capture) => capture.path === "/about/")!;
  about.sections!.body = "";
  assert(deterministicUnderwritingFindings(snapshot).some((f) => f.semanticKey === "underwriting-legal-name-missing-about"));
});

test("underwriting detects changed legal-name case and individual operators in copyright text", () => {
  for (const [expected, observed] of [["Harbor Goods LLC", "Harbor goods LLC"], ["Jordan Avery", "Jordan Avey"]]) {
    const snapshot = underwritingSnapshot();
    (snapshot.config as { entity: { name: string } }).entity.name = expected;
    for (const capture of snapshot.captures) {
      capture.sections!.body = capture.sections!.body.replaceAll("Harbor Goods LLC", expected);
      capture.sections!.footer = `© 2026 ${observed}. All rights reserved.`;
    }
    assert(deterministicUnderwritingFindings(snapshot).some((f) => f.semanticKey === "underwriting-legal-name-mismatch" && f.issue.evidence.includes(observed)), observed);
  }
});

test("underwriting accepts a punctuated verified legal name in generated operator copy", () => {
  const snapshot = underwritingSnapshot(); const expected = "Harbor Goods, Inc.";
  (snapshot.config as { entity: { name: string } }).entity.name = expected;
  for (const capture of snapshot.captures) {
    capture.sections!.body = capture.sections!.body.replaceAll("Harbor Goods LLC", expected) + `\nOperated by ${expected}, 7428 Harbor Avenue, Portland, OR 97205.`;
    capture.sections!.footer = `© 2026 ${expected}. All rights reserved.`;
  }
  assert(!deterministicUnderwritingFindings(snapshot).some((f) => /legal-name/.test(f.semanticKey ?? "")));
});

test("underwriting requires visible contact details and footer legal identity, not just configuration", () => {
  const snapshot = underwritingSnapshot();
  const contact = snapshot.captures.find((c) => c.path === "/contact/")!;
  contact.sections!.body = "Contact Harbor Goods LLC for customer service.";
  contact.sections!.footer = "Our Store";
  const findings = deterministicUnderwritingFindings(snapshot).filter((f) => f.issue.url === contact.url);
  assert(findings.some((f) => /contact.*missing/i.test(f.issue.evidence) && /email.*phone.*address/i.test(f.issue.evidence)));
  assert(findings.some((f) => /footer.*legal/i.test(f.issue.evidence) && f.issue.level === "P1"));
});

test("underwriting requires displayed USD prices on product and populated archive captures", () => {
  const snapshot = underwritingSnapshot();
  snapshot.products = [{ id: 7, name: "Bag" }];
  snapshot.targets.push({ name: "product-7-bag", kind: "product", path: "/product/bag/", targetId: 7 }, { name: "shop", kind: "archive", path: "/shop/" });
  snapshot.captures.push({ ...snapshot.captures[0], name: "product-7-bag", path: "/product/bag/", url: "https://shop.test/product/bag/", sections: { ...snapshot.captures[0].sections!, body: "Travel Bag. Contact us for prices." }, text: "Travel Bag. Contact us for prices." }, { ...snapshot.captures[0], name: "shop", path: "/shop/", url: "https://shop.test/shop/", text: "Bag", sections: { ...snapshot.captures[0].sections!, body: "Bag" } });
  const findings = deterministicUnderwritingFindings(snapshot);
  assert(findings.some((f) => f.issue.url.endsWith("/product/bag/") && /displayed.*USD price/i.test(f.issue.evidence)));
  assert(findings.some((f) => f.issue.url.endsWith("/shop/") && /displayed.*USD price/i.test(f.issue.evidence)));
});

test("underwriting flags WordPress defaults without asking a model", () => {
  const snapshot = underwritingSnapshot(); snapshot.captures[0].sections!.body += "\nHello world! Welcome to WordPress. A WordPress Commenter";
  const findings = deterministicUnderwritingFindings(snapshot);
  assert(findings.some((f) => /Hello world!/.test(f.issue.evidence)));
});

test("a removed deterministic page placeholder closes even when verified business facts do not change", async () => {
  const snapshot = underwritingSnapshot(); snapshot.captures[0].sections!.body += "\nLorem ipsum";
  const first = await runReviewLoop({ now: () => 1, collect: async () => snapshot, inspect: async () => deterministicUnderwritingFindings(snapshot), apply: async () => false });
  const placeholder = first.issues.find((i) => /Lorem ipsum/.test(i.evidence))!; assert(placeholder);
  snapshot.captures[0].sections!.body = snapshot.captures[0].sections!.body.replace("\nLorem ipsum", "");
  const second = await runReviewLoop({ now: () => 2, previous: first, collect: async () => snapshot, inspect: async () => deterministicUnderwritingFindings(snapshot), apply: async () => false });
  assert.equal(second.issues.find((i) => i.id === placeholder.id)?.status, "fixed");
});

test("a browser missing structured underwriting evidence cannot silently pass review", async () => {
  const f = reviewFixture(); const browse = f.ctx.d.browse!;
  f.ctx.d.browse = async (input) => {
    const result = await browse(input);
    return { ...result, captures: result.captures?.map(({ linkStatuses: _omitted, ...capture }) => capture) };
  };
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.equal(report.passed, false); assert.match(report.issues[0].evidence, /结构化证据/); assert.equal(f.prompts.length, 0);
});

test("underwriting accepts the complete entered US address including its country", () => {
  const snapshot = underwritingSnapshot(); const address = "7428 Harbor Avenue, Portland, OR 97205, United States";
  (snapshot.config as { entity: { address: string } }).entity.address = address;
  for (const capture of snapshot.captures) for (const region of ["body", "footer"] as const) capture.sections![region] = capture.sections![region].replaceAll("7428 Harbor Avenue, Portland, OR 97205", address);
  assert(!deterministicUnderwritingFindings(snapshot).some((f) => /address/.test(f.semanticKey ?? "")));
});

test("underwriting compares international customer-service numbers by digits without treating long IDs as phones", () => {
  const snapshot = underwritingSnapshot();
  (snapshot.config as { entity: { phone: string } }).entity.phone = "+44 20 7946 0958";
  for (const capture of snapshot.captures) for (const region of ["body", "footer"] as const) capture.sections![region] = capture.sections![region].replaceAll("+1 207 736 1829", "+44 (20) 7946-0958").replaceAll("(207) 736-1829", "+44 (20) 7946-0958");
  snapshot.captures[0].sections!.body += "\nProduct ID: 100000123456789012345";
  assert(!deterministicUnderwritingFindings(snapshot).some((f) => /phone|contact-details/.test(f.semanticKey ?? "")));
  snapshot.captures[0].sections!.body += "\nCall +44 20 7946 0959";
  assert(deterministicUnderwritingFindings(snapshot).some((f) => f.issue.evidence.includes("+44 20 7946 0959")));
});

test("product names containing policy words are not mistaken for policy pages", () => {
  const snapshot = underwritingSnapshot();
  snapshot.products = [{ id: 7, name: "Shipping Tote" }];
  snapshot.targets.push({ name: "product-7-shipping-tote", kind: "product", path: "/product/shipping-tote/", targetId: 7 });
  snapshot.captures.push({ ...snapshot.captures[0], name: "product-7-shipping-tote", path: "/product/shipping-tote/", url: "https://shop.test/product/shipping-tote/", sections: { ...snapshot.captures[0].sections!, body: "Shipping Tote $19.99 USD" } });
  assert(!deterministicUnderwritingFindings(snapshot).some((f) => f.issue.url.endsWith("/shipping-tote/") && /legal-name-missing/.test(f.semanticKey ?? "")));
});

// 实测 2026-10-15：页脚「© 2026 … Store」被当成地址「2026 … St」，商品页上的 10 位商品编号被当成电话；同一问题在每页各报一遍
const addToFooters = (snapshot: ReviewSnapshot, extra: string) => {
  for (const capture of snapshot.captures as (ReviewSnapshot["captures"][number] & { sections: { footer: string } })[]) {
    capture.sections.footer += extra;
    capture.text += extra;
  }
};

test("a copyright year before a name ending in Store is not read as a street address", () => {
  const snapshot = underwritingSnapshot();
  addToFooters(snapshot, " | © 2026 Harbor Goods Store");
  assert.deepEqual(deterministicUnderwritingFindings(snapshot).filter((row) => row.semanticKey === "underwriting-address-mismatch"), []);
});

test("a bare 10-digit product code is not read as a phone number", () => {
  const snapshot = underwritingSnapshot();
  const home = snapshot.captures[0] as ReviewSnapshot["captures"][number] & { sections: { body: string } };
  home.sections.body += "\nSKU 5321488384"; home.text += "\nSKU 5321488384";
  assert.deepEqual(deterministicUnderwritingFindings(snapshot).filter((row) => row.semanticKey === "underwriting-phone-mismatch"), []);
});

test("the same site-wide problem on every page is reported once with the affected pages", () => {
  const snapshot = underwritingSnapshot();
  addToFooters(snapshot, " | Demo Store");
  const rows = deterministicUnderwritingFindings(snapshot).filter((row) => row.semanticKey === "underwriting-placeholder-content");
  assert.equal(rows.length, 1);
  assert.match(rows[0].issue.evidence, /7 pages/);
});
