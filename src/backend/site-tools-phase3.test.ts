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

test("QA source images and exact per-variation images are allowlisted and revertible", async () => {
  const { db, siteId } = setup();
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId) as unknown as SiteRow;
  const source = {
    product: {
      pid: "source-123", name: "Dog Bed", category: "Dog Beds", materials: [], description: "Grey small and brown large dog beds.",
      images: ["https://img/source-main.jpg"], keyNames: ["Color", "Size"], variants: [
        { key: "Grey-S", cost: 5, weight: 100, length: 10, width: 10, height: 10, image: "https://img/grey-s.jpg" },
        { key: "Brown-L", cost: 6, weight: 100, length: 20, width: 20, height: 20, image: "https://img/brown-l.jpg" },
      ],
    },
    analysis: {
      title: "Dog Bed", short_description: "Grey Small and Brown Large options.", description_html: "<p>Grey Small and Brown Large options.</p>",
      materials_and_care_html: null, image_alt: "Dog bed", mainImage: "https://img/source-main.jpg",
      metaDescription: "Dog beds in the listed options.", ogDescription: "See dog beds in the listed options.", variants: [
        { sourceKey: "Grey-S", buyerName: "Grey Small", clear: true, pieceCount: null, components: [], color: "Grey", evidence: "Grey" },
        { sourceKey: "Brown-L", buyerName: "Brown Large", clear: true, pieceCount: null, components: [], color: "Brown", evidence: "brown" },
      ],
    }, unitReview: { questionable: [] },
  };
  const product = {
    id: 9, sku: "WG-source-123", name: "Dog Bed", short_description: "Old supplier labels.", description: "<p>Old supplier labels.</p>",
    images: [{ id: 1, src: "https://img/bad.jpg" }], variations: [{ id: 91 }, { id: 92 }], meta_data: [],
  };
  site.picks_json = JSON.stringify([{ productId: 9, source }]);
  const variations = [
    { id: 91, sku: "WG-source-123-1", attributes: [{ name: "Option", option: "Grey Small" }], image: { id: 1, src: "https://img/bad.jpg" } },
    { id: 92, sku: "WG-source-123-2", attributes: [{ name: "Option", option: "Brown Large" }], image: { id: 1, src: "https://img/bad.jpg" } },
  ];
  const ctx = {
    d: { db, now: () => 1000 }, site, domain: "shop.test", form: { brand: "Store", categories: "Dog Beds" }, entity: {}, emit: () => {}, save: () => {},
    wp: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.startsWith("wc/v3/products/9/variations?")) return structuredClone(variations);
      const vm = /^wc\/v3\/products\/9\/variations\/(\d+)$/.exec(path);
      if (vm) {
        const variation = variations.find((x) => x.id === Number(vm[1]))!;
        if (method === "PUT") Object.assign(variation, structuredClone(body));
        return structuredClone(variation);
      }
      if (method === "GET" && path.startsWith("wc/v3/products/9")) return structuredClone(product);
      if (method === "PUT" && path === "wc/v3/products/9") { Object.assign(product, structuredClone(body)); return structuredClone(product); }
      throw new Error(`${method} ${path}`);
    },
  } as unknown as StepCtx;
  const tools = Object.fromEntries(siteTools(ctx).map((x) => [x.name, x.run]));

  assert.equal((await tools.update_product_main_image({ summary: "source image", id: 9, image_url: "https://evil.test/a.jpg" })).ok, false);
  assert.equal((await tools.update_product_main_image({ summary: "source image", id: 9, image_url: "https://img/source-main.jpg" })).ok, true);
  assert.equal(product.images[0].src, "https://img/source-main.jpg");
  product.variations.push({ id: 93 });
  assert.equal((await tools.update_product_variation_images({ summary: "incomplete variation set", id: 9 })).ok, false);
  assert.equal((await tools.update_product({ summary: "incomplete option copy", id: 9, short_description: "Choose Grey Small or Brown Large." })).ok, false);
  product.variations.pop();
  const changesBeforeConflict = listChanges(db, siteId).length;
  variations[0].attributes = [{ name: "Color", option: "Brown" }, { name: "Size", option: "L" }];
  assert.equal((await tools.update_product_variation_images({ summary: "conflicting exact mapping", id: 9 })).ok, false);
  assert.equal(listChanges(db, siteId).length, changesBeforeConflict);
  assert.equal(variations[0].image.src, "https://img/bad.jpg");
  variations[0].attributes = [{ name: "Option", option: "Grey Small" }];
  assert.equal((await tools.update_product_variation_images({ summary: "variant images", id: 9 })).ok, true);
  assert.deepEqual(variations.map((x) => x.image.src), ["https://img/grey-s.jpg", "https://img/brown-l.jpg"]);
  assert.equal((await tools.update_product_variation_images({ summary: "already correct", id: 9 })).change_id, null);
  assert.equal((await tools.update_product({
    summary: "actual option copy", id: 9, name: "Dog Bed", short_description: "Choose Grey Small or Brown Large.",
    description_html: "<p>Available in Grey Small and Brown Large.</p>",
  })).ok, true);
  assert.match(product.description, /Grey Small and Brown Large/);

  for (const change of listChanges(db, siteId)) await revertChange(ctx, change.id);
  assert.deepEqual(product.images, [{ id: 1, src: "https://img/bad.jpg" }]);
  assert.deepEqual(variations.map((x) => x.image.src), ["https://img/bad.jpg", "https://img/bad.jpg"]);
});
