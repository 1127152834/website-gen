import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPages, checkCopy, checkPolicies, claimProblems, copyPrompt, filterCandidatesForCategories, htmlToBlocks, parsePolicies, screenPrompt, type Facts, type Policies, type SiteCopy } from "./content.ts";
import { costRange, parseDetail, splitVariants } from "./cj.ts";
import { parseUsAddress } from "./store.ts";

const facts: Facts = {
  brand: "Nordic Paws", domain: "nordicpaws.com", email: "support@nordicpaws.com", categories: ["dog beds"],
  entity: { kind: "company", name: "Nordic Paws LLC", address: "1 Main St", supportEmail: "auto", phone: "+1 512 555 0100", processingDays: [1, 3], transitDays: [5, 10] },
};
const pad = " This sentence only makes the document long enough to count as a real policy page for the length check.".repeat(2);
const good = (): Policies => ({
  shipping: `<p>Orders ship in 1-3 business days and arrive in 5 to 10 business days. Free shipping on orders of $49 or more, otherwise $4.99. Email support@nordicpaws.com. If an order is delayed, we notify you with a revised shipping date. You may accept the delay or cancel for a full refund. Request cancellation before shipment. For a lost parcel, contact us so we can check tracking, open a carrier investigation, communicate the outcome, and resolve the lost parcel.${pad}</p>`,
  returns: `<p>Contact support@nordicpaws.com to request a return within 30 days after delivery. Wait for approval and return instructions; once approved, ship the item back promptly to 1 Main St. The customer pays return shipping unless the item is damaged, defective, or wrong. After we receive and inspect the returned item, we initiate the refund to the original payment method within 5–7 business days of receiving it. Your bank may need additional time to post the credit, and bank timing varies.${pad}</p>`,
  privacy: `<p>Nordic Paws LLC runs this store. Email support@nordicpaws.com.${pad}</p>`,
  terms: `<p>Nordic Paws LLC runs this store. Email support@nordicpaws.com. Available payment methods are shown at checkout.${pad}</p>`,
});

test("policies that state every promised fact pass, also after WordPress typography", () => {
  assert.deepEqual(checkPolicies(good(), facts), []);
  const rendered = good();
  rendered.returns = rendered.returns.replace("5–7", "5&#8211;7");
  assert.deepEqual(checkPolicies(rendered, facts), []);
});

test("every generated policy includes the exact legal operator name and address", () => {
  const copy: SiteCopy = {
    tagline: "Beds for dogs", style: "default", hero: { heading: "Dog beds", subheading: "Browse dog beds." },
    about: ["Nordic Paws sells dog beds."],
    faq: Array.from({ length: 8 }, (_, i) => ({ q: `Question ${i + 1}`, a: "Contact support for help." })),
  };
  const pages = buildPages(copy, good(), facts);
  for (const slug of ["shipping", "returns", "privacy-policy", "terms"]) {
    const page = pages.find((candidate) => candidate.slug === slug);
    assert.ok(page, `${slug} page is generated`);
    assert.match(page.content, new RegExp(`\\b${facts.entity.name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`));
    assert.ok(page.content.includes(facts.entity.address), `${slug} contains the exact business address`);
  }
});

test("policies with a missing fact or an invented number are rejected", () => {
  const p = good();
  p.returns = p.returns.replace("within 30 days", "within 60 days");
  p.shipping += "<p>Express shipping costs $12.</p>";
  const problems = checkPolicies(p, facts).join("\n");
  assert.match(problems, /return window/);
  assert.match(problems, /"60 days?" is not in the facts/);
  assert.match(problems, /"\$12" is not in the facts/);
});

test("an incomplete return, delay, cancellation or lost-parcel SOP is rejected", () => {
  const p = good();
  p.shipping = `<p>Orders ship in 1-3 business days and arrive in 5-10 business days. Free over $49, otherwise $4.99. Email support@nordicpaws.com.${pad}</p>`;
  p.returns = `<p>Returns are accepted within 30 days. Refunds take 5-7 business days. Email support@nordicpaws.com.${pad}</p>`;
  const problems = checkPolicies(p, facts).join("\n");
  assert.match(problems, /delay notice/);
  assert.match(problems, /cancellation before shipment/);
  assert.match(problems, /lost parcel tracking/);
  assert.match(problems, /approval or instructions/);
  assert.match(problems, /inspection after receipt/);
});

test("the 30-day return-request window must start from delivery, not the order date", () => {
  const p = good();
  p.returns = p.returns.replace("within 30 days after delivery", "within 30 days after the order date");
  assert.match(checkPolicies(p, facts).join("\n"), /return request within 30 days after delivery/);
});

test("correct policies phrased differently by the AI still pass (live wording, 2026-10-15)", () => {
  const p = good();
  p.returns = `<h2>Returns</h2><p>We accept returns within 30 days of delivery. Contact support at support@nordicpaws.com within 30 days of delivery to request a return. Wait for approval and instructions from support. Once approved, send the item back promptly to: 1 Main St. You pay return shipping unless the item arrived damaged, defective, or wrong. After we receive and inspect the return, we initiate the refund to the original payment method within 5–7 business days after we receive the return. Your bank may need additional time to post the credit.${pad}</p>`;
  p.privacy += "<p>Analytics is disabled. Order attribution is disabled, and we do not use order-attribution cookies.</p>";
  assert.deepEqual(checkPolicies(p, facts), []);
  // 肯定地描述在用订单归因仍然拒绝
  const q = good();
  q.privacy += "<p>We use order attribution cookies (sbjs_) to understand where orders come from.</p>";
  assert.match(checkPolicies(q, facts).join("\n"), /disabled order attribution/);
});

test("specific payment gateways are rejected until connected", () => {
  const p = good();
  p.terms += "<p>We accept Stripe and PayPal.</p>";
  assert.match(checkPolicies(p, facts).join("\n"), /must not promise a payment gateway/);
});

test("unoffered Express and expedited shipping are rejected in policies and site copy", () => {
  const p = good();
  p.shipping += "<p>Express shipping is available.</p>";
  assert.match(checkPolicies(p, facts).join("\n"), /remove unoffered shipping service/);
  const copy: SiteCopy = {
    tagline: "Beds for dogs", style: "default", hero: { heading: "Dog beds", subheading: "Browse dog beds." },
    about: [
      "Nordic Paws is an online store operated by Nordic Paws LLC from 1 Main St. We focus on one thing: dog beds, chosen for everyday comfort at home.",
      "Every order ships within the contiguous United States. Orders are processed in 1-3 business days and usually arrive in 5-10 business days after dispatch.",
      "If something is not right, you can request a return within 30 days of delivery. Questions about an order? Email support@nordicpaws.com and our team will help.",
    ],
    faq: Array.from({ length: 8 }, (_, i) => ({ q: `Question ${i + 1}`, a: i === 0 ? "Available payment methods are shown at checkout." : "Expedited delivery is available." })),
  };
  assert.match(checkCopy(copy, facts).join("\n"), /remove unoffered shipping service/);
});

test("unprovable claims are caught without flagging ordinary words", () => {
  assert.equal(claimProblems("Founded in 2015, our award-winning, non-toxic beds").length, 3);
  assert.deepEqual(claimProblems("A rewarding nap on a soft bed."), []);
});

test("the policy reply format is split into four documents and turned into core blocks", () => {
  const p = parsePolicies("=== SHIPPING ===\n<h2>A</h2>\n=== RETURNS ===\n<ul><li>x</li><li>y</li></ul>\n=== PRIVACY ===\n<p>p</p>\n=== TERMS ===\n<p>t</p>");
  assert.deepEqual(Object.keys(p), ["shipping", "returns", "privacy", "terms"]);
  assert.equal(htmlToBlocks(p.shipping), '<!-- wp:heading -->\n<h2 class="wp-block-heading">A</h2>\n<!-- /wp:heading -->');
  assert.equal((htmlToBlocks(p.returns).match(/<!-- wp:list-item -->/g) ?? []).length, 2);
  assert.equal(htmlToBlocks('<p onclick="x">Hi <script>bad()</script><a href="javascript:1">l</a></p>'), "<!-- wp:paragraph -->\n<p>Hi bad()<a>l</a></p>\n<!-- /wp:paragraph -->");
});

test("CJ variant keys split into named attributes, or fall back to one option", () => {
  assert.deepEqual(splitVariants(["Color", "Size"], ["Light Grey-S", "Light Grey-M"]), [{ Color: "Light Grey", Size: "S" }, { Color: "Light Grey", Size: "M" }]);
  assert.deepEqual(splitVariants(["Color", "Size"], ["Dark-Blue-S"]), [{ Option: "Dark-Blue-S" }]);
  assert.deepEqual(costRange("5.99 -- 7.40"), [5.99, 7.4]);
});

test("CJ variant images are preserved for per-variation image assignment", () => {
  const product = parseDetail({ pid: "1", productNameEn: "Bag", categoryName: "Bags", productImageSet: ["https://img/main.jpg"], variants: [
    { variantKey: "Black", variantSellPrice: "5.00", variantImage: "https://img/black.jpg" },
    { variantKey: "Blue", variantSellPrice: "6.00", variantImage: "javascript:bad" },
  ] });
  assert.equal(product.variants[0].image, "https://img/black.jpg");
  assert.equal(product.variants[1].image, undefined);
});

test("US addresses are split into Woo store fields", () => {
  assert.deepEqual(parseUsAddress("1 Main St, Suite 2, Austin, TX 78701, United States"), { street: "1 Main St, Suite 2", city: "Austin", state: "TX", zip: "78701" });
  assert.equal(parseUsAddress("Flat 3, 8 Queen's Road, Hong Kong").state, "");
});

// 实测 2026-10-15：「关于我们」只有一句套话；支付网关审核会看这一页是否像真实在经营的商家
test("a one-line About page is rejected; a concrete one naming the operator and contact passes", () => {
  const base: SiteCopy = {
    tagline: "Beds for dogs", style: "default", hero: { heading: "Dog beds", subheading: "Browse dog beds." },
    about: ["Nordic Paws sells dog beds.", "We ship to the US."],
    faq: Array.from({ length: 8 }, (_, i) => ({ q: `Question ${i + 1}`, a: "Contact support for help." })),
  };
  assert.match(checkCopy(base, facts).join("\n"), /about/i);
  const concrete: SiteCopy = { ...base, about: [
    "Nordic Paws is an online store operated by Nordic Paws LLC from 1 Main St. We focus on one thing: dog beds, chosen for everyday comfort at home.",
    "Every order ships within the contiguous United States. Orders are processed in 1-3 business days and usually arrive in 5-10 business days after dispatch.",
    "If something is not right, you can request a return within 30 days of delivery. Questions about an order? Email support@nordicpaws.com and our team will help.",
  ] };
  assert.deepEqual(checkCopy(concrete, facts).filter((x) => /about/i.test(x)), []);
});

test("strict category filtering keeps the named target and rejects another target or product type", () => {
  const candidates = [
    { pid: "cat-bed", name: "Plush Cat Bed" },
    { pid: "shared-bed", name: "Washable Dog and Cat Bed" },
    { pid: "dog-bowl", name: "Raised Dog Bowl" },
    { pid: "dog-bed", name: "Orthopedic Dog Bed" },
  ];
  assert.deepEqual(filterCandidatesForCategories(["dog beds"], candidates).map((x) => x.pid), ["shared-bed", "dog-bed"]);
  assert.deepEqual(filterCandidatesForCategories(["baby clothing"], [
    { name: "Kids Clothing Set" }, { name: "Baby and Kids Clothing Set" }, { name: "Baby Feeding Bowl" },
  ]).map((x) => x.name), ["Baby and Kids Clothing Set"]);
  assert.deepEqual(filterCandidatesForCategories(["women's bags"], [
    { name: "Men's Travel Bag" }, { name: "Men and Women Tote Bag" }, { name: "Women's Walking Shoes" },
  ]).map((x) => x.name), ["Men and Women Tote Bag"]);
});

test("the AI screening prompt requires the product main purpose to match the operator category", () => {
  const prompt = screenPrompt(["dog beds"], [{ pid: "1", name: "Dog Bowl" }]);
  assert.match(prompt, /main purpose/i);
  assert.match(prompt, /operator.*wrote/i);
  assert.match(prompt, /compliance/i);
});

test("site copy that narrows a mixed catalog to dogs is rejected", () => {
  const dogOnly: SiteCopy = {
    tagline: "Beds for dogs", style: "default", hero: { heading: "Dog beds", subheading: "Comfortable beds for dogs." },
    about: [
      "Nordic Paws is an online store operated by Nordic Paws LLC from 1 Main St. We focus on dog beds selected for comfortable everyday rest at home.",
      "Every order ships within the contiguous United States. Orders are processed in 1-3 business days and usually arrive in 5-10 business days after dispatch.",
      "If something is not right, you can request a return within 30 days of delivery. Questions about an order? Email support@nordicpaws.com and our team will help.",
    ],
    faq: Array.from({ length: 8 }, (_, i) => ({ q: `Question ${i + 1}`, a: i === 0 ? "Available payment methods are shown at checkout." : "Contact support for help." })),
  };
  const catalog = [
    { name: "Orthopedic Dog Bed", categories: [{ name: "dog beds" }] },
    { name: "Plush Cat Bed", categories: [{ name: "cat beds" }] },
  ];
  assert.match(checkCopy(dogOnly, facts, catalog).join("\n"), /catalog categories/i);
  assert.match(copyPrompt(facts, catalog), /dog beds, cat beds/i);

  const inclusive: SiteCopy = {
    ...dogOnly,
    tagline: "Beds for dogs and cats",
    hero: { heading: "Dog and cat beds", subheading: "Comfortable beds for dogs and cats." },
    about: dogOnly.about.map((paragraph) => paragraph.replace("dog beds", "dog and cat beds")),
  };
  assert.deepEqual(checkCopy(inclusive, facts, catalog).filter((x) => /catalog categories/i.test(x)), []);

  const generic: SiteCopy = {
    ...dogOnly,
    tagline: "Beds for pets",
    hero: { heading: "Pet beds", subheading: "Comfortable beds for household pets." },
    about: dogOnly.about.map((paragraph) => paragraph.replace("dog beds", "pet beds")),
  };
  assert.deepEqual(checkCopy(generic, facts, catalog).filter((x) => /catalog categories/i.test(x)), []);

  const misleadingTagline: SiteCopy = { ...generic, tagline: "Beds for dogs" };
  assert.match(checkCopy(misleadingTagline, facts, catalog).join("\n"), /tagline.*catalog categories/i);
  assert.match(checkCopy({ ...generic, tagline: "Pet beds for dogs" }, facts, catalog).join("\n"), /tagline.*catalog categories/i);

  const unsupportedTarget: SiteCopy = { ...generic, tagline: "Pet beds for babies" };
  assert.match(checkCopy(unsupportedTarget, facts, catalog).join("\n"), /tagline.*catalog categories/i);

  const dogCatalog = [{ name: "Cozy Dog Bed", categories: [{ name: "animals" }] }];
  const dogCopy: SiteCopy = { ...generic, tagline: "Rest easy, pup", hero: { heading: "Rest easy", subheading: "Comfort at home." } };
  assert.deepEqual(checkCopy(dogCopy, facts, dogCatalog).filter((x) => /catalog categories/i.test(x)), []);
});
