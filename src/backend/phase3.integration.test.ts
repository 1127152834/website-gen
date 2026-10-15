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
    const home = [...wp.pages.values()].find((p) => p.slug === "home")!;
    assert.ok(home.content.indexOf("wg-mobile-first-product") < home.content.indexOf("wg-home-intro"));
    assert.match(home.content, /https:\/\/img\/b\.jpg/);
    assert.match(home.content, /product-category\/rest-at-home/);
    for (const p of wp.pages.values()) if (p.status === "publish") assert.ok(visited.has(p.slug === "home" ? "/" : `/${p.slug}/`), p.slug);
    for (const p of wp.products) { assert.ok(visited.has(`/product/${p.id}/`)); assert.ok(wp.metadata.has(`product:${p.id}`)); }
    assert.ok(wp.metadata.has("home:0") && wp.metadata.has("shop:0"));
    assert.ok(wp.categories.every((c) => wp.metadata.has(`product_cat:${c.id}`)));
    const review = JSON.parse(ctx.site.qa_json!).review as SiteReview;
    assert.equal(review.passed, true);
    assert.equal(review.rounds, 0);
    assert.match(JSON.parse(ctx.site.qa_json!).reviewFactsHash, /^[a-f0-9]{64}$/, "source fingerprint survives final QA serialization");
    assert.ok(visualCalls > wp.pages.size + wp.products.length);
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
      return { text: JSON.stringify({ issues: [{ key: "actual-length", level: "P1", kind: "product", page: "Product dimensions", url, evidence: "Length is not confirmed in source facts", why: "The actual measurement needs supplier evidence", fix: "Provide a verified length and its unit", needs_real_data: true }] }), cost: 0 };
    }
    return ai(role, prompt);
  } });
  try {
    await assert.rejects(runToEnd(d, siteId), /Provide a verified length and its unit/);
    const qa = JSON.parse(siteContext(d, siteId).site.qa_json!);
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
    await assert.rejects(runToEnd(d, siteId), /抓取不完整/);
    const qa = JSON.parse(siteContext(d, siteId).site.qa_json!);
    assert.equal(qa.review.passed, false);
    assert.ok(qa.review.issues.some((i: { level: string; status: string }) => i.level === "P1" && i.status === "open"));
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
        { key: "copy-summary", level: "P1", kind: "seo", page: "Product summary", url, evidence: "Summary still requires correction", why: "A persistent test finding", fix: "Correct the factual summary", needs_real_data: false, action: { tool: "update_meta", params: { summary: "Correct product summary", target_type: "product", target_id: Number(/\/product\/(\d+)\//.exec(url)![1]), description: `Current factual home page summary revision ${++revisions} for all real products.`, og_description: `Current factual sharing summary revision ${revisions} for all real products.` } } },
        { key: "material-proof", level: "P2", kind: "product", page: "Material proof", url, evidence: "Material proof needs real documentation", why: "AI cannot invent proof", fix: "Supply material evidence", needs_real_data: true },
      ] }), cost: 0 };
    }
    return ai(role, prompt);
  } });
  try {
    await assert.rejects(runToEnd(d, siteId), /Correct the factual summary/);
    let review = JSON.parse(siteContext(d, siteId).site.qa_json!).review as SiteReview;
    assert.equal(review.rounds, 2); assert.equal(review.passed, false);
    assert.ok(review.issues.some((i) => i.status === "needs_you"));
    assert.equal(listChanges(db, siteId).length, 2);
    await assert.rejects(provisionSite(d, siteId), /Correct the factual summary/);
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
    const shipping = [...wp.pages.values()].find((p) => p.slug === "shipping")!;
    const broken = "<p>Shipping policy awaiting repair.</p>"; shipping.content = broken;
    d.ai = async (role, prompt) => {
      if (prompt.startsWith("You are the final compliance reviewer") && prompt.includes(`PAGE URL:\nhttps://${DOMAIN}/shipping/\n`) && prompt.includes("Shipping policy awaiting repair")) {
        return { text: JSON.stringify({ issues: [{ key: "shipping-procedure", level: "P1", kind: "policy", page: "Shipping policy", url: `https://${DOMAIN}/shipping/`, evidence: "Shipping policy awaiting repair", why: "The delay, cancellation and lost parcel procedures are absent", fix: "Restore the complete source-backed shipping policy", needs_real_data: false, action: { tool: "update_policy", params: { summary: "修复完整运输政策", name: "shipping", html: parsePolicies(POLICIES).shipping } } }] }), cost: 0 };
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
