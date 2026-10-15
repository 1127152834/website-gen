import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { siteSteps } from "./batches.ts";
import { PermanentError } from "./jobs.ts";
import { provisionSite, UNWANTED_PLUGINS } from "./pipeline.ts";
import { launchSite } from "./launch.ts";
import { unseal } from "./secrets.ts";
import type { BrowseInput } from "./qa-browser.ts";
import { PROVISION_STEPS } from "../shared/protocol.ts";
import { deps, DOMAIN, EMAIL, fakeAi, fakeHostinger, fakeSite, key, runToEnd, setup, THEME_VERSION } from "./testing.ts";

test("a new site goes through every step: built on Hostinger, filled from CJ and AI, then checked by QA", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  const aiLog: string[] = [];
  let browsed: BrowseInput | null = null;
  const waits = await runToEnd(deps(db, exec, fetchImpl, events, {
    ai: fakeAi(aiLog),
    browse: async (input) => {
      browsed = input;
      return { shots: [{ name: "home", file: "home.png" }], problems: [] };
    },
  }), siteId);

  assert.ok(waits >= 1, "waited for the WordPress install");
  const steps = siteSteps(db, siteId);
  assert.equal(steps.length, PROVISION_STEPS.length);
  assert.ok(steps.every((s) => s.status === "done" || s.status === "skipped"), JSON.stringify(steps.filter((s) => s.status !== "done")));
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId) as Record<string, any>;
  assert.equal(site.status, "done");
  assert.equal(site.wp_software_id, "31100468");
  assert.equal(st.plugins.get("woocommerce"), "active");
  assert.deepEqual(st.themes.get("obel"), { status: "active", version: THEME_VERSION });
  for (const p of UNWANTED_PLUGINS) assert.ok(!st.plugins.has(p), `${p} uninstalled`);
  assert.equal(st.plugins.get("hostinger"), "active", "Hostinger Tools stays (it runs maintenance mode)");
  assert.equal(steps.find((s) => s.key === "plugins_cleanup")!.status, "done");
  assert.equal(st.maintenance, "enabled", "still hidden until launch");
  assert.deepEqual(JSON.parse(unseal(key, site.companion_ciphertext)), { username: "site-agent", password: "app pass word 1234" });

  // 文案：编造的成立年份被拦下，AI 改写后通过
  assert.deepEqual(aiLog.filter((x) => x === "copy").length, 2);
  assert.ok(events.some((e) => e.kind === "warn" && String(e.payload.message).includes("founding years")));

  // 商店配置和页面
  assert.equal(wp.options.blogname, "Nordicpaws");
  assert.equal(wp.options.blog_public, 0, "hidden from search engines while building");
  assert.equal(wp.info.email, EMAIL);
  assert.equal(wp.settings.woocommerce_currency, "USD");
  assert.equal(wp.settings.woocommerce_default_country, "US:TX");
  assert.deepEqual(wp.zones[0].methods.map((m) => m.method_id).sort(), ["flat_rate", "free_shipping"]);
  assert.equal((wp.zones[0].locations as unknown[]).length, 49, "48 states + DC");
  assert.deepEqual(wp.styles, { styles: { typography: { fontFamily: "serif" } }, settings: {} });
  const pages = [...wp.pages.values()];
  const home = pages.find((p) => p.slug === "home")!;
  assert.equal(wp.options.page_on_front, home.id);
  assert.equal(wp.options.wp_page_for_privacy_policy, 3, "the draft privacy page is reused and published");
  assert.equal(wp.pages.get(3)!.status, "publish");
  assert.match(wp.pages.get(3)!.content, /<!-- wp:paragraph -->/);
  assert.equal(wp.settings.woocommerce_terms_page_id, String(pages.find((p) => p.slug === "terms")!.id));

  // 商品：Baby 被排除；规格按 CJ 的属性名拆分；价格由代码按 ×2.5 +.99 算
  assert.equal(wp.products.length, 2);
  assert.ok(wp.products.every((p) => p.status === "publish"));
  const bed = wp.products.find((p) => p.type === "variable")!;
  assert.deepEqual(bed.variations.map((v) => v.price), ["14.99", "18.99"]);
  assert.equal(bed.description, "<p>Soft cloth bed.</p>", "attributes stripped from AI html");
  assert.equal(wp.products.find((p) => p.type === "simple")!.price, "10.99");

  // QA：通过，阻断项没有失败；截图走的是一次性登录链接
  const qa = JSON.parse(site.qa_json) as { checks: { id: string; level: string; ok: boolean; detail: string }[] };
  assert.deepEqual(qa.checks.filter((c) => c.level === "block" && !c.ok), []);
  assert.equal(browsed!.loginUrl, `https://${DOMAIN}/create_autologin_abc.php`);
  assert.ok(browsed!.cart!.addPath.includes("add-to-cart="));

  // 日志里有调用记录，但绝不能出现密码
  const log = JSON.stringify(events);
  assert.ok(log.includes("hosting_websites_start-setup"));
  assert.ok(!log.includes(JSON.parse(unseal(key, site.wp_admin_ciphertext)).password));
  assert.ok(!log.includes("app pass word 1234"));
});

test("a domain that already has a website stops permanently instead of being overwritten", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger({ websiteAlreadyThere: true });
  await assert.rejects(provisionSite(deps(db, exec, fakeSite(st).fetchImpl, []), siteId), PermanentError);
  assert.ok(!st.calls.includes("hosting_websites_start-setup"));
});

test("a rejected enrollment redeploys the companion with a newer generation and then succeeds", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const d = deps(db, exec, fakeSite(st, { rejectFirst: true }).fetchImpl, []);
  await assert.rejects(runToEnd(d, siteId), /重新部署/);
  await runToEnd(d, siteId);
  assert.equal(st.pluginDeploys.length, 2);
  const site = db.prepare("SELECT status FROM sites WHERE id = ?").get(siteId) as { status: string };
  assert.equal(site.status, "done");
});

test("launch turns off maintenance and coming-soon, allows indexing, and confirms visitors see the site", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  const d = deps(db, exec, fetchImpl, []);
  const noPause = async () => {};
  await assert.rejects(launchSite(d, siteId, noPause), /全部完成后才能上线/);
  await runToEnd(d, siteId);

  assert.match(await launchSite(d, siteId, noPause), /访客已经能看到网站/);
  assert.equal(st.maintenance, "disabled");
  assert.equal(wp.options.blog_public, 1);
  assert.equal(wp.options.woocommerce_coming_soon, "no");
  assert.ok((db.prepare("SELECT launched_at FROM sites WHERE id = ?").get(siteId) as { launched_at: number }).launched_at > 0);
  // 再点一次也安全：维护模式已关，不会再切换
  const toggles = st.calls.filter((c) => c === "wordpress_maintenance_toggle").length;
  await launchSite(d, siteId, noPause);
  assert.equal(st.calls.filter((c) => c === "wordpress_maintenance_toggle").length, toggles);
});

test("QA failures stop the site with a report instead of finishing", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const events: unknown[] = [];
  const d = deps(db, exec, fakeSite(st).fetchImpl, events, { browse: async () => ({ shots: [], problems: ["checkout 页面有 PHP 错误"] }) });
  await assert.rejects(runToEnd(d, siteId), (e: Error) => e instanceof PermanentError && /页面能正常显示/.test(e.message));
  const site = db.prepare("SELECT qa_json FROM sites WHERE id = ?").get(siteId) as { qa_json: string };
  const render = (JSON.parse(site.qa_json) as { checks: { id: string; ok: boolean; detail: string }[] }).checks.find((c) => c.id === "render")!;
  assert.equal(render.ok, false);
  assert.match(render.detail, /PHP 错误/);
  assert.equal(siteSteps(db, siteId).find((s) => s.key === "qa")!.status, "failed");
});
