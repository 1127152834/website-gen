import { test } from "node:test";
import assert from "node:assert/strict";
import { dueReverts, listChanges, revertChange } from "./changes.ts";
import { siteContext } from "./pipeline.ts";
import { localTime, siteTools } from "./site-tools.ts";
import { deps, fakeHostinger, fakeSite, runToEnd, setup } from "./testing.ts";

/** 先用模拟环境把站建好，再拿到这个站的工具。 */
async function builtSite() {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  const d = deps(db, exec, fetchImpl, events);
  await runToEnd(d, siteId);
  const tools = () => Object.fromEntries(siteTools(siteContext(d, siteId)).map((t) => [t.name, t.run]));
  const page = (slug: string) => [...wp.pages.values()].find((p) => p.slug === slug)!;
  return { db, d, siteId, wp, events, tools, page };
}

test("a copy change is checked, applied to the pages and recorded with a snapshot; revert restores it", async () => {
  const { db, siteId, wp, tools, page, d } = await builtSite();
  const homeBefore = page("home").content;

  // 编造的说法被拦下，什么都不改
  const bad = await tools().update_copy({ summary: "改标题", hero_heading: "Award-winning beds since 2010" });
  assert.equal(bad.ok, false);
  assert.match(JSON.stringify(bad.problems), /awards|founding years/);
  assert.equal(listChanges(db, siteId).length, 0);

  const ok = await tools().update_copy({ summary: "首页标题改成黑五促销", hero_heading: "Black Friday: cozy beds for every pup", tagline: "Beds dogs love" });
  assert.equal(ok.ok, true);
  assert.match(page("home").content, /Black Friday: cozy beds for every pup/);
  assert.equal(wp.options.blogdescription, "Beds dogs love");
  assert.equal(JSON.parse((db.prepare("SELECT spec_json FROM sites WHERE id = ?").get(siteId) as { spec_json: string }).spec_json).copy.hero.heading, "Black Friday: cozy beds for every pup");
  const [change] = listChanges(db, siteId);
  assert.equal(change.summary, "首页标题改成黑五促销");
  assert.deepEqual(change.targets.sort(), ["文案底稿", "站点标语与页脚信息", "页面 /home/"].sort(), "unchanged about/faq pages are not part of the change");

  await revertChange(siteContext(d, siteId), change.id);
  assert.equal(page("home").content, homeBefore);
  assert.equal(wp.options.blogdescription, "Cozy beds for happy dogs");
  assert.equal(listChanges(db, siteId)[0].status, "reverted");
  await assert.rejects(revertChange(siteContext(d, siteId), change.id), /已经回滚过了/);
});

test("reverting an older change is refused when the same content was changed again later", async () => {
  const { db, siteId, tools, d } = await builtSite();
  await tools().update_copy({ summary: "第一次", hero_heading: "First heading" });
  await tools().update_copy({ summary: "第二次", hero_heading: "Second heading" });
  const [second, first] = listChanges(db, siteId);
  await assert.rejects(revertChange(siteContext(d, siteId), first.id), /又被改过/);
  // 按顺序先回滚较晚的，再回滚较早的
  await revertChange(siteContext(d, siteId), second.id);
  await revertChange(siteContext(d, siteId), first.id);
});

test("a failure halfway through restores what was already written and records nothing", async () => {
  const { db, siteId, wp, tools, page } = await builtSite();
  const homeBefore = page("home").content;
  wp.failSiteWrites = true; // 页面写完后，写站点标语时出错
  await assert.rejects(tools().update_copy({ summary: "改标语", hero_heading: "New heading", tagline: "New tagline" }), /HTTP 500/);
  assert.equal(page("home").content, homeBefore);
  assert.equal(listChanges(db, siteId).length, 0);
});

test("policies must keep the store's promises; announcement, product text and style changes are revertible", async () => {
  const { db, siteId, wp, tools, d } = await builtSite();
  const policy = await tools().update_policy({ summary: "改运费", name: "shipping", html: "<p>Shipping costs $9.99. Orders ship in 2 business days.</p>" });
  assert.equal(policy.ok, false);

  assert.equal((await tools().update_announcement({ summary: "公告改成促销", text: "Black Friday: 20% off dog beds" })).ok, true);
  assert.equal((wp.info as Record<string, string>).announcement, "Black Friday: 20% off dog beds");
  assert.equal((wp.info as Record<string, string>).email, "support@nordicpaws.com", "other footer details are kept");

  const product = wp.products[0];
  const r = await tools().update_product({ summary: "改商品名", id: product.id, name: "Plush Donut Dog Bed", description_html: "<p class=\"x\">Soft and round.</p>" });
  assert.equal(r.ok, true);
  assert.equal(product.name, "Plush Donut Dog Bed");
  assert.equal(product.description, "<p>Soft and round.</p>");

  assert.equal((await tools().update_style({ summary: "换成默认风格", style: "default" })).ok, true);
  assert.deepEqual(wp.styles, { styles: {}, settings: {} });

  // 三条变更互不相干，可以任意顺序回滚
  for (const c of listChanges(db, siteId)) await revertChange(siteContext(d, siteId), c.id);
  assert.equal((wp.info as Record<string, string>).announcement, "Free US shipping on orders over $49");
  assert.equal(product.name, "Cozy Dog Bed");
  assert.deepEqual(wp.styles, { styles: { typography: { fontFamily: "serif" } }, settings: {} });
});

test("a scheduled revert becomes due at its time", async () => {
  const { db, siteId, tools, d } = await builtSite();
  await tools().update_announcement({ summary: "促销", text: "Weekend sale" });
  const [c] = listChanges(db, siteId);
  assert.equal((await tools().schedule_revert({ change_id: c.id, at: localTime(d.now() - 3_600_000) })).ok, false, "past times are refused");
  const at = localTime(d.now() + 3_600_000);
  assert.equal((await tools().schedule_revert({ change_id: c.id, at })).ok, true);
  assert.deepEqual(dueReverts(db, Date.parse(at) - 1), []);
  assert.deepEqual(dueReverts(db, Date.parse(at)).map((x) => x.id), [c.id]);
});

test("pi session messages become chat items with each tool call merged with its result", async () => {
  const { toChatItems } = await import("./agent.ts");
  const items = toChatItems([
    { role: "user", content: "把公告改成促销" },
    { role: "assistant", content: [{ type: "thinking", thinking: "先读站点" }, { type: "toolCall", id: "c1", name: "get_site", arguments: {} }] },
    { role: "toolResult", toolCallId: "c1", toolName: "get_site", content: [{ type: "text", text: '{"ok":true}' }], isError: false },
    { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "update_announcement", arguments: { text: "x" } }] },
    { role: "toolResult", toolCallId: "c2", toolName: "update_announcement", content: [{ type: "text", text: '{"ok":false,"problems":["too long"]}' }], isError: false },
    { role: "assistant", content: [{ type: "text", text: "公告没改成功" }], stopReason: "stop" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "429" },
  ]);
  assert.deepEqual(items.map((i) => (i.role === "tool" ? `${i.name}:${i.ok}` : `${i.role}:${i.role === "assistant" ? i.text || i.error || "" : i.text}`)), [
    "user:把公告改成促销", "assistant:", "get_site:true", "update_announcement:false", "assistant:公告没改成功", "assistant:429",
  ]);
});
