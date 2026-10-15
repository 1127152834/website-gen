import { test } from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "./content.ts";
import type { CjProduct } from "./cj.ts";
import {
  buildPublishableVariants, checkProductAnalysis, checkUnitReview, deterministicDimensionProblems, type ProductAnalysis, type ProductVariantInput,
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

void facts;
