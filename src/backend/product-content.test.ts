import { test } from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "./content.ts";
import type { CjProduct } from "./cj.ts";
import {
  buildPublishableVariants, checkProductAnalysis, copyCoversVariant, productAnalysisPrompt, checkUnitReview, deterministicDimensionProblems, reconcileActualVariations, type ProductAnalysis, type ProductVariantInput,
} from "./product-content.ts";

const facts: Facts = {
  brand: "Carry Co", domain: "carry.example", email: "help@carry.example", categories: ["travel bags"],
  entity: { kind: "company", name: "Carry LLC", address: "1 Main St", supportEmail: "auto", phone: "+1 555 0100", processingDays: [1, 3], transitDays: [5, 10] },
};
const product: CjProduct = {
  pid: "p1", name: "Travel Organizer Set", category: "Packing Organizers", materials: ["Nylon"],
  description: "Black 2pcs set includes a large organizer and small organizer. Blue 3pcs contents are not specified. Nylon shell.",
  images: ["https://img/whole.jpg", "https://img/black.jpg"], keyNames: ["Color", "Set"],
  variants: [
    { key: "Black-2pcs", cost: 5, weight: 500, length: 300, width: 200, height: 100, image: "https://img/black.jpg" },
    { key: "Blue-3pcs", cost: 6, weight: 600, length: 27000, width: 200, height: 100 },
  ],
};
const inputs: ProductVariantInput[] = [
  { ...product.variants[0], attrs: { Color: "Black", Set: "2pcs" } },
  { ...product.variants[1], attrs: { Color: "Blue", Set: "3pcs" } },
];
const analysis = (): ProductAnalysis => ({
  title: "Travel Organizer Set — Black 2-Piece Set", short_description: "Choose the Black 2-Piece Set.",
  description_html: "<p>Black 2-Piece Set includes a large organizer and small organizer.</p>",
  materials_and_care_html: "<p>Nylon shell.</p>", image_alt: "Black travel organizer set", mainImage: "https://img/whole.jpg",
  metaDescription: "Black two-piece travel organizer set with one large and one small organizer.",
  ogDescription: "See the Black Two-Piece Set with a large organizer and a small organizer.",
  variants: [
    { sourceKey: "Black-2pcs", buyerName: "Black 2-Piece Set", clear: true, pieceCount: 2, components: ["large organizer", "small organizer"], color: "Black", evidence: "Black 2pcs set" },
    { sourceKey: "Blue-3pcs", buyerName: "Blue Three-Piece Set", clear: false, pieceCount: 3, components: [], color: "Blue", evidence: "Blue 3pcs" },
  ],
});

test("variant analysis excludes unclear variants and retains exact variant image", () => {
  const a = analysis();
  assert.deepEqual(checkProductAnalysis(a, product, inputs), []);
  const publishable = buildPublishableVariants(product, a, { questionable: [] }, inputs);
  assert.equal(publishable.length, 1);
  assert.equal(publishable[0].key, "Black-2pcs");
  assert.equal(publishable[0].image, "https://img/black.jpg");
  assert.deepEqual(publishable[0].safeDimensions, { length: 300, width: 200, height: 100 });
});

test("unclear variants cannot be silently omitted from analysis or marked clear without facts", () => {
  const a = analysis();
  a.variants.pop();
  assert.match(checkProductAnalysis(a, product, inputs).join("\n"), /missing analysis for source variant Blue-3pcs/);
  const b = analysis();
  b.variants[1].clear = true;
  b.description_html += "<p>Blue Three-Piece Set.</p>";
  assert.match(checkProductAnalysis(b, product, inputs).join("\n"), /at least|components|clear variant|copy must cover|pieceCount|evidence/);
});

test("malformed AI schemas are rejected without throwing or failing open", () => {
  assert.doesNotThrow(() => checkProductAnalysis(null as unknown as ProductAnalysis, product, inputs));
  assert.match(checkProductAnalysis(null as unknown as ProductAnalysis, product, inputs).join("\n"), /must be an object/);
  const malformed = analysis();
  malformed.variants = [null as unknown as ProductAnalysis["variants"][number]];
  assert.doesNotThrow(() => checkProductAnalysis(malformed, product, inputs));
  assert.match(checkProductAnalysis(malformed, product, inputs).join("\n"), /each variant analysis must be an object/);
  assert.doesNotThrow(() => checkUnitReview({ questionable: [null] } as unknown as Parameters<typeof checkUnitReview>[0], inputs));
  assert.match(checkUnitReview({ questionable: [null] } as unknown as Parameters<typeof checkUnitReview>[0], inputs).join("\n"), /must be an object/);
});

test("a set cannot borrow component facts from another variant or hide its piece count", () => {
  const a = analysis();
  a.variants[1] = { sourceKey: "Blue-3pcs", buyerName: "Blue Set", clear: true, pieceCount: 3, components: ["large organizer"], color: "Blue", evidence: "Blue 3pcs" };
  a.description_html += "<p>Blue Set includes a large organizer.</p>";
  const problems = checkProductAnalysis(a, product, inputs).join("\n");
  assert.match(problems, /component "large organizer" is not supported/);
  assert.match(problems, /buyerName must state its sourced piece count/);
});

test("Set1 supplier codes and duplicate clear buyer names cannot become Woo options", () => {
  const codedProduct: CjProduct = { ...product, description: "Set1 and Set2 are available.", variants: [
    { key: "Set1", cost: 5, weight: 100, length: 100, width: 100, height: 100 },
    { key: "Set2", cost: 6, weight: 100, length: 100, width: 100, height: 100 },
  ] };
  const codedInputs: ProductVariantInput[] = codedProduct.variants.map((v) => ({ ...v, attrs: { Option: v.key } }));
  const a = analysis();
  a.title = "Organizer Options";
  a.short_description = "Choose Organizer Option.";
  a.description_html = "<p>Organizer Option is available.</p>";
  a.variants = codedProduct.variants.map((v) => ({ sourceKey: v.key, buyerName: "Organizer Option", clear: true, pieceCount: null, components: [], color: null, evidence: v.key }));
  const problems = checkProductAnalysis(a, codedProduct, codedInputs).join("\n");
  assert.match(problems, /clear set variant requires a sourced pieceCount and component list/);
  assert.match(problems, /duplicate buyerName/);
  a.variants[0].buyerName = "Set1";
  assert.match(checkProductAnalysis(a, codedProduct, codedInputs).join("\n"), /must not expose a supplier code/);
});

test("a fixed-count title cannot contradict clear 6, 7 and 8-piece variants", () => {
  const setProduct: CjProduct = {
    ...product,
    description: "Pink 6pcs includes 6 packing cubes. Pink 7pcs includes 7 packing cubes. Pink 8pcs includes 8 packing cubes.",
    variants: [6, 7, 8].map((count) => ({ key: `Pink-${count}pcs`, cost: count, weight: 500, length: 300, width: 200, height: 100 })),
  };
  const setInputs: ProductVariantInput[] = setProduct.variants.map((v) => ({ ...v, attrs: { Color: "Pink", Set: v.key.split("-")[1] } }));
  const a: ProductAnalysis = {
    ...analysis(), title: "8-Piece Packing Cube Set",
    short_description: "Choose Pink 6-Piece Set, Pink 7-Piece Set, or Pink 8-Piece Set.",
    description_html: "<p>Pink 6-Piece Set, Pink 7-Piece Set, and Pink 8-Piece Set are available.</p>",
    variants: [6, 7, 8].map((count) => ({ sourceKey: `Pink-${count}pcs`, buyerName: `Pink ${count}-Piece Set`, clear: true, pieceCount: count, components: [`${count} packing cubes`], color: "Pink", evidence: `Pink ${count}pcs` })),
  };
  const problems = checkProductAnalysis(a, setProduct, setInputs).join("\n");
  assert.match(problems, /title must be generic or state every published piece count; missing 6/);
  assert.match(problems, /missing 7/);
  a.title = "6/7/8-Piece Packing Cube Sets";
  assert.deepEqual(checkProductAnalysis(a, setProduct, setInputs), []);
});

test("27 m bag dimensions are rejected and never guessed into a correction", () => {
  const withText = { ...product, description: `${product.description} Length 27m.` };
  assert.match(deterministicDimensionProblems(withText, inputs[1]).join("\n"), /exceeds 3 m/);
  assert.match(deterministicDimensionProblems(withText).join("\n"), /27m/);
  const publishable = buildPublishableVariants(product, analysis(), { questionable: [{ sourceKey: "Black-2pcs", fields: ["length"], reason: "unit is questionable" }] }, inputs);
  assert.equal(publishable[0].safeDimensions, null);
});

test("unsupported materials, care, certifications and discounts are rejected", () => {
  const a = analysis();
  a.materials_and_care_html = "<p>Certified genuine leather. Machine wash.</p>";
  a.short_description += " Save 50% today.";
  a.description_html += "<p>Waterproof and machine washable.</p>";
  const problems = checkProductAnalysis(a, product, inputs).join("\n");
  assert.match(problems, /certifications|materials\/care|discount|50%/i);
  assert.match(problems, /discount or sale language/);
  assert.match(problems, /material "leather"/);
  assert.match(problems, /claim "Waterproof"/i);
  assert.match(problems, /claim "machine wash/);
});

test("actual Woo variation options replace stale analysis labels through an exact source mapping", () => {
  const stale = analysis();
  stale.variants[0].buyerName = "Old Black Label";
  const actual = reconcileActualVariations(product, stale, [{
    id: 91, sku: "WG-p1-1", attributes: [{ name: "Color", option: "Black" }, { name: "Set", option: "2pcs" }],
  }]);
  assert.deepEqual(actual.problems, []);
  assert.equal(actual.analysis.variants[0].buyerName, "Black / 2pcs");
  assert.deepEqual(actual.inputs[0].attrs, { Color: "Black", Set: "2pcs" });
  assert.deepEqual(actual.inputs[0].sourceAttrs, { Color: "Black", Set: "2pcs" });
});

test("actual Woo variation reconciliation rejects ambiguous source mappings", () => {
  const duplicate: CjProduct = { ...product, variants: [product.variants[0], { ...product.variants[0] }] };
  const stale = analysis();
  stale.variants = [stale.variants[0], { ...stale.variants[0] }];
  const actual = reconcileActualVariations(duplicate, stale, [{
    id: 91, sku: "", attributes: [{ name: "Color", option: "Black" }, { name: "Set", option: "2pcs" }],
  }]);
  assert.match(actual.problems.join("\n"), /ambiguous/i);
});

test("variation reconciliation fails closed when SKU and exact source attributes disagree", () => {
  const actual = reconcileActualVariations(product, analysis(), [{
    id: 91, sku: "WG-p1-1", attributes: [{ name: "Color", option: "Blue" }, { name: "Set", option: "3pcs" }],
  }]);
  assert.match(actual.problems.join("\n"), /conflicting exact/i);
  assert.equal(actual.sourceByVariationId.size, 0);
});

test("renamed actual Woo options remain authoritative without becoming factual evidence", () => {
  const actual = reconcileActualVariations(product, analysis(), [{
    id: 91, sku: "WG-p1-1", attributes: [{ name: "Option", option: "Bundle A" }],
  }]);
  const repaired: ProductAnalysis = {
    ...actual.analysis, title: "Travel Organizer Bundle", short_description: "Choose Bundle A.",
    description_html: "<p>Bundle A includes a large organizer and small organizer.</p>",
  };
  assert.deepEqual(checkProductAnalysis(repaired, product, actual.inputs), []);
  const unsupported = { ...repaired, description_html: "<p>Bundle A is a 4-piece leather set measuring 999cm.</p>" };
  const problems = checkProductAnalysis(unsupported, product, actual.inputs).join("\n");
  assert.match(problems, /copy advertises 4 pieces/);
  assert.match(problems, /material "leather"/);
  assert.match(problems, /dimension "999cm"/);
});

test("actual Woo labels are not evidence and invented dimensions are rejected", () => {
  const actual = reconcileActualVariations(product, analysis(), [{
    id: 91, sku: "WG-p1-1", attributes: [{ name: "Option", option: "Black 4-Piece Set 999cm" }],
  }]);
  const repaired = { ...actual.analysis, short_description: "Choose Black 4-Piece Set 999cm.", description_html: "<p>Black 4-Piece Set 999cm includes four organizers.</p>" };
  const problems = checkProductAnalysis(repaired, product, actual.inputs).join("\n");
  assert.match(problems, /copy advertises 4 pieces/i);
  assert.match(problems, /dimension "999cm" is not supported/i);
});

test("a source 120 cm measurement does not substring-ground an invented 20 cm claim", () => {
  const measuredProduct: CjProduct = {
    ...product, description: "Black 2pcs set includes a large organizer and small organizer. Overall length 120 cm.",
    variants: [{ ...product.variants[0], length: 300, width: 400, height: 500 }],
  };
  const measuredInputs = [{ ...measuredProduct.variants[0], attrs: { Color: "Black", Set: "2pcs" } }];
  const a = analysis();
  a.variants = [a.variants[0]];
  a.short_description += " Measures 20 cm.";
  assert.match(checkProductAnalysis(a, measuredProduct, measuredInputs).join("\n"), /dimension "20 cm" is not supported/i);
});

void facts;

// 实测 2026-10-16：提示词没说明 evidence 必须逐字摘自资料、件数/组件不能补、标题上限，导致真实商品的修复两次都被校验挡下
test("the product analysis prompt states the evidence, piece-count/components and title-length rules the checker enforces", () => {
  const prompt = productAnalysisPrompt({ brand: "B", categories: ["dog beds"] } as unknown as Facts, { name: "Bed", category: "Pet", materials: [], description: "", images: [] } as unknown as CjProduct, []);
  assert.match(prompt, /evidence must be copied verbatim/i);
  assert.match(prompt, /pieceCount.*null.*components.*\[\]/is);
  assert.match(prompt, /title.*at most 80 characters/i);
});

// 实测 2026-10-16：15 色 × 3 尺寸的商品，要求描述逐个写出「Green bear den / Large」这样的组合，真实修复两次都过不了
test("copy covers a variant when it names the whole option or each of its option values", () => {
  const copy = "Colors: Green bear den, Grey stars Blue, Brown bear. Sizes: Small, Medium, Large.";
  assert.ok(copyCoversVariant(copy, "Green bear den / Large"));
  assert.ok(copyCoversVariant(copy, "Brown bear - Small"));
  assert.ok(copyCoversVariant("Choose the Black 2-Piece Set.", "Black 2-Piece Set"));
  assert.ok(!copyCoversVariant(copy, "Rabbit door curtain / Large"), "a colour missing from the copy is still not covered");
  assert.ok(!copyCoversVariant(copy, "Green bear den / XL"), "a size missing from the copy is still not covered");
});
