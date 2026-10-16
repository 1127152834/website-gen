import { test } from "node:test";
import assert from "node:assert/strict";
import { siteContext } from "./pipeline.ts";
import { storeSteps } from "./store.ts";
import { deps, fakeHostinger, fakeSite, setup } from "./testing.ts";

test("products_pick removes category mismatches before screening even when AI keeps every pid", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const { fetchImpl } = fakeSite(st);
  let screened = "";
  const names = ["Cat Bed", "Dog and Cat Bed", "Dog Bowl", "Dog Bed"];
  const d = deps(db, exec, fetchImpl, [], {
    cj: async () => ({ content: [{ productList: names.map((nameEn, i) => ({ id: String(i), nameEn, sellPrice: "5", bigImage: "https://img/bed.jpg", listedNum: 10 - i })) }] }),
    ai: async (_role, prompt) => { screened = prompt; return { text: JSON.stringify({ keep: ["0", "1", "2", "3"] }), cost: 0 }; },
  });
  try {
    const ctx = siteContext(d, siteId);
    ctx.form.categories = "dog beds";
    await storeSteps(ctx).products_pick();
    const picks = JSON.parse(ctx.site.picks_json!) as { name: string }[];
    assert.deepEqual(picks.map((pick) => pick.name), ["Dog and Cat Bed", "Dog Bed"]);
    const sent = JSON.parse(screened.split("PRODUCTS: ")[1]) as { name: string }[];
    assert.deepEqual(sent.map((pick) => pick.name), ["Dog and Cat Bed", "Dog Bed"]);
  } finally { db.close(); }
});
