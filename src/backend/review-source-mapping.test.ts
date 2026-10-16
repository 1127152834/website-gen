import assert from "node:assert/strict";
import test from "node:test";
import type { CjProduct } from "./cj.ts";
import { reconcileActualVariations, type ProductAnalysis } from "./product-content.ts";

const product: CjProduct = {
  pid: "source-123",
  name: "Cat Bed",
  category: "Pet Beds",
  materials: [],
  description: "Grey-S and Brown-L cat beds.",
  images: ["https://img.test/cat-bed.jpg"],
  keyNames: ["Color", "Size"],
  // 故意与旧站点可能实际发布的顺序相反，证明恢复资料不能只信 SKU 序号。
  variants: [
    { key: "Brown-L", cost: 7, weight: 1, length: 1, width: 1, height: 1, image: "https://img.test/brown-l.jpg" },
    { key: "Grey-S", cost: 5, weight: 1, length: 1, width: 1, height: 1, image: "https://img.test/grey-s.jpg" },
  ],
};

const analysis: ProductAnalysis = {
  title: "Cat Bed",
  short_description: "Choose a cat bed.",
  description_html: "<p>Choose a cat bed.</p>",
  materials_and_care_html: null,
  image_alt: "Cat bed",
  mainImage: product.images[0],
  metaDescription: "Cat bed.",
  ogDescription: "Cat bed.",
  variants: product.variants.map((variant) => ({
    sourceKey: variant.key,
    buyerName: variant.key,
    clear: true,
    pieceCount: null,
    components: [],
    color: null,
    evidence: variant.key,
  })),
};

test("recovered source does not map an unmatched Woo Option by bare SKU order", () => {
  const actual = reconcileActualVariations(product, analysis, [{
    id: 91,
    sku: "WG-source-123-1",
    attributes: [{ name: "Option", option: "Historical Label" }],
  }], { trustSkuOrder: false });
  assert.match(actual.problems.join("\n"), /no exact CJ source mapping/i);
  assert.equal(actual.sourceByVariationId.size, 0);
});

test("recovered source never trusts a regenerated buyerName that points at the wrong raw variant", () => {
  const swapped: ProductAnalysis = {
    ...analysis,
    variants: [
      { ...analysis.variants[0], buyerName: "Grey" },
      { ...analysis.variants[1], buyerName: "Brown" },
    ],
  };
  const actual = reconcileActualVariations(product, swapped, [{
    id: 91,
    sku: "WG-source-123-1",
    attributes: [{ name: "Option", option: "Grey" }],
  }], { trustSkuOrder: false });
  assert.match(actual.problems.join("\n"), /no exact CJ source mapping/i);
  assert.equal(actual.sourceByVariationId.size, 0);
});

test("recovered source maps a single Woo Option only to an exact raw CJ Option value", () => {
  const rawOptions = { ...product, keyNames: [] };
  const renamed: ProductAnalysis = {
    ...analysis,
    variants: analysis.variants.map((variant, index) => ({ ...variant, buyerName: `Generated Label ${index + 1}` })),
  };
  const actual = reconcileActualVariations(rawOptions, renamed, [{
    id: 91,
    sku: "WG-source-123-1",
    attributes: [{ name: "Option", option: "Grey-S" }],
  }], { trustSkuOrder: false });
  assert.deepEqual(actual.problems, []);
  assert.equal(actual.sourceByVariationId.get(91)?.key, "Grey-S");
});

test("recovered source rejects an ambiguous duplicated raw CJ Option value", () => {
  const duplicated = { ...product, keyNames: [], variants: [product.variants[1], { ...product.variants[1], image: "https://img.test/duplicate.jpg" }] };
  const actual = reconcileActualVariations(duplicated, analysis, [{
    id: 91,
    attributes: [{ name: "Option", option: "Grey-S" }],
  }], { trustSkuOrder: false });
  assert.match(actual.problems.join("\n"), /ambiguous CJ source mapping/i);
  assert.equal(actual.sourceByVariationId.size, 0);
});

test("recovered source still maps exact raw Woo attributes", () => {
  const actual = reconcileActualVariations(product, analysis, [{
    id: 91,
    sku: "WG-source-123-1",
    attributes: [{ name: "Color", option: "Grey" }, { name: "Size", option: "S" }],
  }], { trustSkuOrder: false });
  assert.deepEqual(actual.problems, []);
  assert.equal(actual.sourceByVariationId.get(91)?.key, "Grey-S");
});

test("existing stored sources keep default SKU-order reconciliation", () => {
  const actual = reconcileActualVariations(product, analysis, [{
    id: 91,
    sku: "WG-source-123-1",
    attributes: [{ name: "Option", option: "Historical Label" }],
  }]);
  assert.deepEqual(actual.problems, []);
  assert.equal(actual.sourceByVariationId.get(91)?.key, "Brown-L");
});
