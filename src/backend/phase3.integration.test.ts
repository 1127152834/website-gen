import test from "node:test";
import assert from "node:assert/strict";
import { siteSteps } from "./batches.ts";
import { listChanges } from "./changes.ts";
import { provisionSite, siteContext } from "./pipeline.ts";
import { launchSite } from "./launch.ts";
import { runQa, storeSteps } from "./store.ts";
import { parsePolicies } from "./content.ts";
import { companionRules } from "../shared/rules.ts";
import type { SiteReview } from "../shared/protocol.ts";
import { deps, DOMAIN, fakeAi, fakeBrowse, fakeHostinger, fakeSite, fakeVision, POLICIES, runToEnd, setup } from "./testing.ts";
import { FALLBACK_STYLE, toObelGlobalStyles } from "./style.ts";

// 所有服务均为进程内替身，任何未建模的请求都会抛错，不连接外部服务。
test("phase3 source pipeline uses shared rules, actual variant images, vision main photo, use categories and per-page metadata", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  const visited = new Set<string>();
  let visualCalls = 0;
  const d = deps(db, exec, fetchImpl, [], {
    browse: async (input) => { for (const p of input.pages) visited.add(p.path); return fakeBrowse(fetchImpl)(input); },
    vision: async (prompt, images) => {
      visualCalls++;
      if (prompt.startsWith("Choose the clearest main photo")) return { text: JSON.stringify({ mainImage: images[1].url, reason: "Full item outline and complete product are visible", completeProductVisible: true }), cost: 0 };
      return fakeVision(prompt, images);
    },
  });
  try {
    await runToEnd(d, siteId);
    const ctx = siteContext(d, siteId);
    assert.deepEqual(wp.rules, companionRules(ctx.entity));
    assert.equal(wp.options.woocommerce_feature_order_attribution_enabled, "no");
    assert.equal(wp.defaultsRemoved, true);
    assert.match(wp.info.announcement, /\$49 or more/);
    assert.doesNotMatch(JSON.stringify(wp.info), /Express/);
    const product = wp.products.find((p) => p.type === "variable")!;
    assert.equal((product.images[0] as { src: string }).src, "https://img/b.jpg");
    assert.deepEqual(product.variations.map((v) => (v as unknown as { image: { src: string } }).image.src), ["https://img/grey-s.jpg", "https://img/grey-m.jpg"]);
    assert.match(product.description, /Light Grey S.*Light Grey M/);
    assert.ok(wp.categories.some((c) => c.slug === "rest-at-home"));
    const branding = JSON.parse(ctx.site.spec_json!).branding;
    assert.equal(branding.generator, "website-gen");
    assert.equal(branding.installed, true);
    assert.equal(wp.options.custom_logo, branding.logoMediaId);
    assert.equal(wp.options.site_icon, branding.iconMediaId);
    assert(wp.media.has(branding.logoMediaId) && wp.media.has(branding.iconMediaId));
    const beforeMedia = wp.media.size;
    await storeSteps(ctx).products();
    assert.equal(wp.media.size, beforeMedia, "completed branding is not generated or uploaded twice");
    const home = [...wp.pages.values()].find((p) => p.slug === "home")!;
    assert.ok(home.content.indexOf("wg-mobile-first-product") < home.content.indexOf("wg-home-intro"));
    assert.match(home.content, /https:\/\/img\/b\.jpg/);
    assert.match(home.content, /product-category\/rest-at-home/);
    for (const slug of ["home", "about", "contact", "faq", "shipping", "returns", "privacy-policy", "terms", "shop"]) assert.ok(visited.has(slug === "home" ? "/" : `/${slug}/`), slug);
    for (const p of wp.products) { assert.ok(visited.has(`/product/${p.id}/`)); assert.ok(wp.metadata.has(`product:${p.id}`)); }
    assert.ok(wp.metadata.has("home:0") && wp.metadata.has("shop:0"));
    assert.ok(wp.categories.every((c) => wp.metadata.has(`product_cat:${c.id}`)));
    const review = JSON.parse(ctx.site.qa_json!).review as SiteReview;
    assert.equal(review.passed, true);
    assert.equal(review.rounds, 0);
    assert.equal(review.issues.filter((i) => i.id.startsWith("config-") && /payment gateway/i.test(i.evidence)).length, 1);
    assert.ok(review.issues.some((i) => i.status === "needs_you" && /Stripe.*支付账户/.test(i.fix)));
    assert.match(JSON.parse(ctx.site.qa_json!).reviewFactsHash, /^[a-f0-9]{64}$/, "source fingerprint survives final QA serialization");
    assert.equal(visualCalls, 9 + wp.products.length + wp.categories.length + wp.products.length + 1, "trust pages including terms, plus product photo choices and style");
  } finally { db.close(); }
});

test("phase3 AI low-contrast style falls back before writing WordPress global styles", async () => {
  const { db, siteId } = setup(); const { st, exec } = fakeHostinger(); const { fetchImpl, wp } = fakeSite(st);
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  const d = deps(db, exec, fetchImpl, events, { vision: async (prompt, images) => prompt.startsWith("Design a restrained ecommerce") ? { text: JSON.stringify({ ...FALLBACK_STYLE, palette: { ...FALLBACK_STYLE.palette, text: "#FFFFFF" } }), cost: 0 } : fakeVision(prompt, images) });
  try { await runToEnd(d, siteId); assert.deepEqual(wp.styles, toObelGlobalStyles(FALLBACK_STYLE)); assert.ok(events.some((e) => String(e.payload.message).includes("安全保底"))); } finally { db.close(); }
});

test("phase3 P1 needing real data leaves QA failed with exact evidence and cannot launch", async () => {
  const { db, siteId } = setup(); const { st, exec } = fakeHostinger(); const { fetchImpl, wp } = fakeSite(st);
  const ai = fakeAi([]);
  const d = deps(db, exec, fetchImpl, [], { ai: async (role, prompt) => {
    if (prompt.startsWith("You are the final compliance reviewer") && prompt.includes(`PAGE URL:\nhttps://${DOMAIN}/product/`)) {
      const url = /PAGE URL:\n(https:[^\s]+)\n/.exec(prompt)![1];
      return { text: JSON.stringify({ issues: [{ key: "actual-length", level: "P1", kind: "product", page: "Product dimensions", url, evidence: "Length is not confirmed in source facts", why: "实际尺寸需要供应商资料证明", fix: "请提供经过确认的长度和单位", needs_real_data: true }] }), cost: 0 };
    }
    return ai(role, prompt);
  } });
  try {
    // 失败信息只给中文小结；具体证据和待办在复核报告里
    await assert.rejects(runToEnd(d, siteId), /关键问题未解决.*需要你补充资料/);
    const qa = JSON.parse(siteContext(d, siteId).site.qa_json!);
    assert.ok(qa.review.issues.some((i: { fix: string }) => i.fix === "请提供经过确认的长度和单位"));
    assert.equal(qa.review.passed, false);
    assert.ok(qa.review.issues.some((i: { status: string }) => i.status === "needs_you"));
    assert.equal(siteSteps(db, siteId).find((s) => s.key === "qa")!.status, "failed");
    assert.equal(listChanges(db, siteId).length, 0);
    assert.ok(wp.products.length);
    await assert.rejects(launchSite(d, siteId), /全部完成后才能上线/);
    assert.equal(st.maintenance, "enabled");
  } finally { db.close(); }
});

test("phase3 missing browser captures cannot falsely pass AI QA", async () => {
  const { db, siteId } = setup(); const { st, exec } = fakeHostinger(); const { fetchImpl } = fakeSite(st);
  const d = deps(db, exec, fetchImpl, [], { browse: async () => ({ shots: [], problems: [] }) });
  try {
    await assert.rejects(runToEnd(d, siteId), /复核报告/);
    const qa = JSON.parse(siteContext(d, siteId).site.qa_json!);
    assert.equal(qa.review.passed, false);
    assert.ok(qa.review.issues.some((i: { level: string; status: string; evidence: string }) => i.level === "P1" && i.status === "open" && /抓取不完整/.test(i.evidence)));
  } finally { db.close(); }
});


test("phase3 shipping setup repairs disabled and incorrect existing rates, QA verifies exact rules and region", async () => {
  const { db, siteId } = setup(); const { st, exec } = fakeHostinger(); const { fetchImpl, wp } = fakeSite(st); const d = deps(db, exec, fetchImpl, []);
  try {
    await runToEnd(d, siteId);
    const zone = wp.zones[0]; const count = zone.methods.length;
    zone.methods.forEach((m) => { m.enabled = false; m.settings = { min_amount: "50", cost: "19.99", requires: "coupon", ignore_discounts: "yes" }; });
    zone.locations = [{ code: "US:HI", type: "state" }];
    await storeSteps(siteContext(d, siteId)).store_setup();
    assert.equal(zone.methods.length, count, "updates existing instances instead of duplicating rates");
    assert.ok(zone.methods.every((m) => m.enabled));
    assert.equal(zone.locations.length, 49);
    let qa = await runQa(siteContext(d, siteId));
    assert.equal(qa.checks.find((c) => c.id === "shipping")?.ok, true);
    zone.methods.find((m) => m.method_id === "free_shipping")!.settings = { requires: "min_amount", min_amount: "50", ignore_discounts: "no" };
    qa = await runQa(siteContext(d, siteId));
    assert.equal(qa.checks.find((c) => c.id === "shipping")?.ok, false);
    assert.match(qa.checks.find((c) => c.id === "shipping")!.detail, /\$49/);
  } finally { db.close(); }
});

test("phase3 auto fixes are snapshotted, stop after two rounds across retries, and preserve needs_you", async () => {
  const { db, siteId } = setup(); const { st, exec } = fakeHostinger(); const { fetchImpl } = fakeSite(st); const ai = fakeAi([]); let revisions = 0; let targetUrl: string | undefined;
  const d = deps(db, exec, fetchImpl, [], { ai: async (role, prompt) => {
    if (prompt.startsWith("You are the final compliance reviewer") && /PAGE URL:\nhttps:[^\s]+\/product\//.test(prompt)) {
      const url = /PAGE URL:\n(https:[^\s]+)\n/.exec(prompt)![1];
      targetUrl ??= url; if (url !== targetUrl) return ai(role, prompt);
      return { text: JSON.stringify({ issues: [
        { key: "copy-summary", level: "P1", kind: "product", focus: "product_consistency", page: "Product summary", url, evidence: "Product description still contradicts the supplier's item", why: "商品摘要一直与来源资料不一致", fix: "修正商品事实摘要", needs_real_data: false, action: { tool: "update_product", params: { summary: "Correct product summary", id: Number(/\/product\/(\d+)\//.exec(url)![1]), short_description: ++revisions % 2 ? "Soft cloth bed." : "Cloth bed." } } },
        { key: "material-proof", level: "P2", kind: "product", page: "Material proof", url, evidence: "Material proof needs real documentation", why: "材质信息没有真实资料证明", fix: "请提供真实的材质证明", needs_real_data: true },
      ] }), cost: 0 };
    }
    return ai(role, prompt);
  } });
  try {
    await assert.rejects(runToEnd(d, siteId), /关键问题未解决/);
    let review = JSON.parse(siteContext(d, siteId).site.qa_json!).review as SiteReview;
    assert.ok(review.issues.some((i) => /修正商品事实摘要/.test(i.fix)));
    assert.equal(review.rounds, 2); assert.equal(review.passed, false);
    assert.ok(review.issues.some((i) => i.status === "needs_you"));
    assert.equal(listChanges(db, siteId).length, 2);
    await assert.rejects(provisionSite(d, siteId), /关键问题未解决/);
    review = JSON.parse(siteContext(d, siteId).site.qa_json!).review as SiteReview;
    assert.equal(review.rounds, 2); assert.equal(listChanges(db, siteId).length, 2, "no third fix round on retry");
    for (const change of listChanges(db, siteId)) assert.equal(change.status, "applied");
  } finally { db.close(); }
});

test("launch never records success while the visitor homepage is still hidden or failing", async () => {
  const { db, siteId } = setup(); const { st, exec } = fakeHostinger(); const { fetchImpl } = fakeSite(st); const d = deps(db, exec, fetchImpl, []);
  try {
    await runToEnd(d, siteId);
    d.fetch = (async (url, init) => new URL(String(url)).pathname.startsWith("/wp-json/") ? fetchImpl(url, init) : new Response("Unavailable", { status: 503 })) as typeof fetch;
    await assert.rejects(launchSite(d, siteId, async () => {}), /未记录上线成功/);
    assert.equal(siteContext(d, siteId).site.launched_at, null);
  } finally { db.close(); }
});


test("phase3 policy auto-fix restores the complete procedure before deterministic QA and leaves a rollback snapshot", async () => {
  const { db, siteId } = setup(); const { st, exec } = fakeHostinger(); const { fetchImpl, wp } = fakeSite(st); const ai = fakeAi([]); const d = deps(db, exec, fetchImpl, []);
  try {
    await runToEnd(d, siteId);
    const returns = [...wp.pages.values()].find((p) => p.slug === "returns")!;
    const broken = "<p>Returns policy awaiting repair.</p>"; returns.content = broken;
    d.ai = async (role, prompt) => {
      if (prompt.startsWith("You are the final compliance reviewer") && prompt.includes(`PAGE URL:\nhttps://${DOMAIN}/returns/\n`) && prompt.includes("Returns policy awaiting repair")) {
        return { text: JSON.stringify({ issues: [{ key: "returns-procedure", level: "P1", kind: "policy", focus: "operator_policy", page: "Returns policy", url: `https://${DOMAIN}/returns/`, evidence: "Returns policy awaiting repair", why: "退货审批、地址和退款时限均未说明", fix: "恢复有资料依据的完整退货政策", needs_real_data: false, action: { tool: "update_policy", params: { summary: "修复完整退货政策", name: "returns", html: parsePolicies(POLICIES).returns } } }] }), cost: 0 };
      }
      return ai(role, prompt);
    };
    const result = await storeSteps(siteContext(d, siteId)).qa();
    assert.ok("status" in result && result.status === "done");
    const qa = JSON.parse(siteContext(d, siteId).site.qa_json!);
    assert.equal(qa.review.rounds, 1); assert.equal(qa.review.passed, true);
    assert.equal(qa.checks.find((c: { id: string }) => c.id === "policies").ok, true);
    assert.ok(qa.review.issues.some((i: { status: string }) => i.status === "fixed"));
    assert.equal(listChanges(db, siteId).length, 1);
    const ops = JSON.parse((db.prepare("SELECT ops_json FROM changesets WHERE site_id = ?").get(siteId) as { ops_json: string }).ops_json);
    assert.equal(ops[0].before.content, broken);
  } finally { db.close(); }
});

test("branding resumes partial rendering, reconciles prior media and repairs remote settings without regeneration", async () => {
  const { db, siteId } = setup(); const { st, exec } = fakeHostinger(); const { fetchImpl, wp } = fakeSite(st);
  let iconFails = true, styleCalls = 0;
  const d = deps(db, exec, fetchImpl, [], {
    renderBranding: async (_svg, kind) => { if (kind === "icon" && iconFails) throw new Error("simulated renderer interruption"); return Buffer.from(`fake-png-${kind}`); },
    vision: async (prompt, images) => { if (prompt.startsWith("Design a restrained ecommerce")) styleCalls++; return fakeVision(prompt, images); },
  });
  try {
    await assert.rejects(runToEnd(d, siteId), /simulated renderer interruption/);
    const partial = JSON.parse(siteContext(d, siteId).site.spec_json!).branding;
    assert(partial.logoMediaId); assert.equal(partial.iconMediaId, undefined); assert.equal(wp.media.size, 1);
    iconFails = false; await runToEnd(d, siteId);
    assert.equal(styleCalls, 1, "interrupted branding resumes with the chosen style"); assert.equal(wp.media.size, 2);
    const ctx = siteContext(d, siteId); const stored = JSON.parse(ctx.site.spec_json!);
    delete stored.branding.logoMediaId; delete stored.branding.iconMediaId; delete stored.branding.installed;
    ctx.save("spec_json", JSON.stringify(stored));
    d.ai = async () => { throw new Error("completed artwork must not call AI again"); };
    await storeSteps(ctx).products();
    assert.equal(wp.media.size, 2, "stable media slug reconciles uploads that succeeded before a lost checkpoint");
    wp.options.custom_logo = 0; wp.options.site_icon = 0;
    await storeSteps(ctx).products();
    const final = JSON.parse(ctx.site.spec_json!).branding;
    assert.equal(wp.options.custom_logo, final.logoMediaId); assert.equal(wp.options.site_icon, final.iconMediaId); assert.equal(wp.media.size, 2);
  } finally { db.close(); }
});

test("underwriter models review terms, business/catalog authenticity and restricted-product evidence, never the shopping flow", async () => {
  for (const scenario of [
    { path: "/terms/", kind: "policy", evidence: "Terms make misleading legal claims about the operating business", why: "条款中的经营主体说法没有依据" },
    { path: "/about/", kind: "copy", evidence: "The About story describes a different business from this catalog", why: "店铺故事与实际销售商品矛盾" },
    { path: "/product/", kind: "product", evidence: "The product description uses a third-party trademark and advertises a restricted product", why: "商品包含受限品和未经证明的第三方品牌说法" },
  ]) {
    const { db, siteId } = setup(); const { st, exec } = fakeHostinger(); const { fetchImpl } = fakeSite(st); const ai = fakeAi([]);
    const prompts: string[] = [];
    const d = deps(db, exec, fetchImpl, [], { ai: async (role, prompt) => {
      if (!prompt.startsWith("You are the final compliance reviewer")) return ai(role, prompt);
      prompts.push(prompt);
      const url = /PAGE URL:\n(https:[^\s]+)\n/.exec(prompt)![1];
      if (new URL(url).pathname.startsWith(scenario.path)) return { text: JSON.stringify({ issues: [{ key: "underwriting-evidence", focus: "underwriting", level: "P1", kind: scenario.kind, page: "Merchant underwriting", url, evidence: scenario.evidence, why: scenario.why, fix: "提交前修正有证据支持的经营主体或商品目录差异", needs_real_data: false }] }), cost: 0 };
      return ai(role, prompt);
    } });
    try {
      await assert.rejects(runToEnd(d, siteId), /关键问题未解决/);
      const report = JSON.parse(siteContext(d, siteId).site.qa_json!).review as SiteReview;
      assert(report.issues.some((i) => i.fix === "提交前修正有证据支持的经营主体或商品目录差异"));
      assert(report.issues.some((i) => i.evidence === scenario.evidence && i.kind === scenario.kind && i.level === "P1"));
      assert(prompts.some((p) => p.includes(`PAGE URL:\nhttps://${DOMAIN}/terms/\n`)));
      assert(prompts.every((p) => !/PAGE URL:\nhttps:[^\n]+\/(?:cart|checkout|my-account|search)\//.test(p)));
      for (const phrase of [/strict payment-gateway merchant underwriter/, /authenticity, data consistency and completeness/, /third-party brand names or trademarks/, /prohibited or restricted products/, /at most 5 issues per page/]) assert.match(prompts[0], phrase);
    } finally { db.close(); }
  }
});

test("deterministic underwriting evidence survives an invalid model response", async () => {
  const { db, siteId } = setup(); const { st, exec } = fakeHostinger(); const { fetchImpl, wp } = fakeSite(st); const d = deps(db, exec, fetchImpl, []);
  try {
    await runToEnd(d, siteId);
    wp.info.entity = "Nordic Paw LLC";
    d.ai = async () => ({ text: "not JSON", cost: 0 });
    const qa = await runQa(siteContext(d, siteId));
    assert.equal(qa.review?.passed, false);
    assert(qa.review?.issues.some((i) => i.kind === "config" && i.level === "P1" && i.evidence.includes("Nordic Paw LLC")), "code-found identity evidence must not depend on model JSON success");
  } finally { db.close(); }
});
