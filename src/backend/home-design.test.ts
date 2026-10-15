import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAiHomepage, checkCategoryDesign, checkHomepageDesign, checkPageMetadata, type CategoryDesign, type DesignProduct, type HomepageDesign } from "./home-design.ts";

const products: DesignProduct[] = [
  { id: 1, name: "Black Commuter Bag", permalink: "/product/commuter/", image: "https://img/1.jpg", sourceCategory: "bag", facts: "Black shoulder bag" },
  { id: 2, name: "Packing Organizer", permalink: "/product/organizer/", image: "https://img/2.jpg", sourceCategory: "bag", facts: "Travel packing organizer" },
];
const categories: CategoryDesign[] = [
  { name: "Daily Commute", slug: "daily-commute", description: "Bags for everyday carry.", productIds: [1] },
  { name: "Travel Organization", slug: "travel-organization", description: "Organizers for packing.", productIds: [2] },
];
const home: HomepageDesign = { heading: "Carry what your day needs", subheading: "Shop real bags by use.", heroProductId: 1, categorySlugs: categories.map((c) => c.slug), featuredProductIds: [1, 2] };

test("AI categories assign every real product by use", () => {
  assert.deepEqual(checkCategoryDesign(categories, products), []);
  assert.match(checkCategoryDesign(categories.slice(0, 1), products).join("\n"), /product 2 is not assigned/);
});

test("category, homepage and metadata high-risk claims must exist in their source facts", () => {
  const invented = structuredClone(categories);
  invented[0].description = "A waterproof choice for everyday carry.";
  assert.match(checkCategoryDesign(invented, products).join("\n"), /not supported by source facts/);
  const inventedHome = { ...home, subheading: "Shop durable waterproof bags." };
  assert.match(checkHomepageDesign(inventedHome, products, categories).join("\n"), /not supported by source facts/);
  const metadata = [{ key: "product-1", description: "A waterproof commuter bag.", ogDescription: "Carry it daily." }];
  assert.match(checkPageMetadata(metadata, ["product-1"], [{ key: "product-1", facts: products[0].facts }]).join("\n"), /not supported by source facts/);
});

test("homepage uses real images and puts a product before marketing copy", () => {
  assert.deepEqual(checkHomepageDesign(home, products, categories), []);
  const html = buildAiHomepage(home, products, categories);
  assert.ok(html.indexOf("wg-mobile-first-product") < html.indexOf("wg-home-intro"));
  assert.match(html, /https:\/\/img\/1\.jpg/);
  assert.match(html, /\/product-category\/daily-commute\//);
  assert.doesNotMatch(html, /wp:html/);
});

test("every page receives unique meta and OG descriptions", () => {
  assert.deepEqual(checkPageMetadata([
    { key: "home", description: "Shop bags by real everyday use.", ogDescription: "Explore bags selected for commuting and travel." },
    { key: "product-1", description: "See the Black Commuter Bag.", ogDescription: "A closer look at the Black Commuter Bag." },
  ], ["home", "product-1"]), []);
  assert.match(checkPageMetadata([{ key: "home", description: "Same", ogDescription: "One" }], ["home", "product-1"]).join("\n"), /missing metadata for product-1/);
});
