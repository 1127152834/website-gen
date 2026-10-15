import { test } from "node:test";
import assert from "node:assert/strict";
import { listChanges, revertChange } from "./changes.ts";
import type { StepCtx, SiteRow } from "./pipeline.ts";
import { siteTools } from "./site-tools.ts";
import { setup } from "./testing.ts";

test("AI main-image, category and metadata fixes are allowlisted changesets and fully revertible", async () => {
  const { db, siteId } = setup();
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId) as unknown as SiteRow;
  const product = {
    id: 9, name: "Travel Bag", short_description: "A useful bag.", description: "<p>Source-backed copy.</p>",
    images: [{ id: 1, src: "https://img/side.jpg" }, { id: 2, src: "https://img/full.jpg" }],
    categories: [{ id: 10, name: "Old", slug: "old" }],
  };
  const metadata = { target_type: "product", target_id: 9, description: "Old factual description for this product page that is long enough.", og_description: "Old factual social description for this product page that is long enough." };
  const ctx = {
    d: { db, now: () => 1000 }, site, domain: "shop.test",
    form: { brand: "Store", categories: "Travel" }, entity: {}, emit: () => {},
    save: () => {},
    wp: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.startsWith("wc/v3/products/9")) return structuredClone(product);
      if (method === "PUT" && path === "wc/v3/products/9") { Object.assign(product, structuredClone(body)); return structuredClone(product); }
      if (method === "GET" && path.startsWith("wc/v3/products/categories")) return [{ id: 10 }, { id: 20 }];
      if (method === "GET" && path.startsWith("site-agent/v1/metadata?")) return structuredClone(metadata);
      if (method === "POST" && path === "site-agent/v1/metadata") { Object.assign(metadata, structuredClone(body)); return structuredClone(metadata); }
      throw new Error(`${method} ${path}`);
    },
  } as unknown as StepCtx;
  const tools = Object.fromEntries(siteTools(ctx).map((x) => [x.name, x.run]));

  assert.equal((await tools.update_product_main_image({ summary: "选择完整商品主图", id: 9, image_id: 999 })).ok, false);
  assert.equal((await tools.update_product_main_image({ summary: "选择完整商品主图", id: 9, image_id: 2 })).ok, true);
  assert.deepEqual(product.images.map((x) => x.id), [2, 1]);
  assert.equal((await tools.update_product_categories({ summary: "按用途分类", id: 9, category_ids: [20] })).ok, true);
  assert.deepEqual(product.categories, [{ id: 20 }]);
  assert.equal((await tools.update_meta({
    summary: "补充商品摘要", target_type: "product", target_id: 9,
    description: "A factual travel bag description based only on the listed product details.",
    og_description: "See the Travel Bag and its listed, source-backed product details before checkout.",
  })).ok, true);
  assert.match(metadata.description, /factual travel bag/);
  assert.equal(listChanges(db, siteId).length, 3);

  for (const change of listChanges(db, siteId)) await revertChange(ctx, change.id);
  assert.deepEqual(product.images.map((x) => x.id), [1, 2]);
  assert.deepEqual(product.categories.map((x) => x.id), [10]);
  assert.match(metadata.description, /^Old factual/);
});
