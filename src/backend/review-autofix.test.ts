import { test } from "node:test";
import assert from "node:assert/strict";
import { listChanges, revertChange } from "./changes.ts";
import type { SiteRow, StepCtx } from "./pipeline.ts";
import { runFullSiteReview } from "./review.ts";
import { setup } from "./testing.ts";

const emptyReview = '{"issues":[]}';
const pages = ["home", "about", "contact", "faq", "shipping", "returns", "privacy-policy", "terms"].map((slug, index) => ({
  id: index + 1,
  slug,
  link: `https://shop.test/${slug === "home" ? "" : `${slug}/`}`,
  status: "publish",
  title: { raw: slug, rendered: slug },
  content: { raw: `<p>${slug}</p>`, rendered: `<p>${slug}</p>` },
}));

const goodStoreCopy = {
  tagline: "Comfortable beds for cats",
  style: "editorial",
  hero: { heading: "A quieter place to rest", subheading: "Cat beds selected for everyday indoor comfort." },
  about: [
    "Harbor Cat Goods LLC operates this independent online store for cat beds chosen for ordinary rest at home. We present the actual catalog plainly, keep product option names consistent, and avoid claims that are not supported by supplier records.",
    "Our published catalog currently focuses on cat beds and the real options shown on each product page. Product descriptions are written from the available source facts so shoppers can compare the listed choices without invented materials, measurements, or set contents.",
    "Orders and support are handled by Harbor Cat Goods LLC for customers in the contiguous United States. For questions about a product or an order, contact support@shop.test and our team will respond with the information available for that listing.",
  ],
  faq: [
    { q: "What do you sell?", a: "We sell the cat beds shown in the current catalog." },
    { q: "Where do you deliver?", a: "We deliver within the contiguous United States." },
    { q: "How can I compare options?", a: "Use the option names shown on each product page." },
    { q: "Can I ask a product question?", a: "Email support@shop.test before ordering." },
    { q: "Where are policies shown?", a: "Shipping and returns details are available in the linked policy pages." },
    { q: "Are unsupported specifications added?", a: "No. Product copy is limited to supported source facts." },
    { q: "How do I contact the store?", a: "Contact support@shop.test for order assistance." },
    { q: "Which payment methods are accepted?", a: "Available payment methods are shown at checkout." },
  ],
};

function reviewIssue(key: string, fields: Record<string, unknown>) {
  return JSON.stringify({ issues: [{
    key,
    focus: "product_consistency",
    level: "P2",
    kind: "product",
    page: "Product: Cat Bed",
    url: "https://shop.test/product/cat-bed/",
    evidence: "Visible product inconsistency.",
    why: "The published product does not match its source facts.",
    fix: "Correct the published product from its persisted source facts.",
    needs_real_data: false,
    ...fields,
  }] });
}

function fixture() {
  const { db, siteId } = setup();
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId) as unknown as SiteRow;
  const source = {
    product: {
      pid: "source-123",
      name: "Cat Bed",
      category: "Cat Beds",
      materials: [],
      description: "A cat bed offered in grey and brown options.",
      images: ["https://img.test/overlay.jpg", "https://img.test/clean-cat-bed.jpg"],
      keyNames: ["Color", "Size"],
      variants: [
        { key: "Grey-S", cost: 5, weight: 500, length: 40, width: 30, height: 10, image: "https://img.test/grey-small.jpg" },
        { key: "Brown-L", cost: 7, weight: 700, length: 55, width: 45, height: 12, image: "https://img.test/brown-large.jpg" },
      ],
    },
    analysis: {
      title: "Cat Bed",
      short_description: "A cat bed in two listed options.",
      description_html: "<p>A cat bed in Grey Small and Brown Large.</p>",
      materials_and_care_html: null,
      image_alt: "Cat bed",
      mainImage: "https://img.test/clean-cat-bed.jpg",
      metaDescription: "See the listed cat bed options.",
      ogDescription: "Explore the listed cat bed options.",
      variants: [
        { sourceKey: "Grey-S", buyerName: "Grey Small", clear: true, pieceCount: null, components: [], color: "Grey", evidence: "Grey-S" },
        { sourceKey: "Brown-L", buyerName: "Brown Large", clear: true, pieceCount: null, components: [], color: "Brown", evidence: "Brown-L" },
      ],
    },
    unitReview: { questionable: [] },
  };
  const product = {
    id: 9,
    sku: "WG-source-123",
    status: "publish",
    name: "Cat Bed",
    slug: "cat-bed",
    permalink: "https://shop.test/product/cat-bed/",
    short_description: "Available in Navy and Extra Large.",
    description: "<p>Choose Navy or Extra Large.</p>",
    images: [
      { id: 1, src: "https://img.test/overlay.jpg", alt: "Cat bed with 60cm overlay" },
      { id: 2, src: "https://img.test/clean-cat-bed.jpg", alt: "Complete cat bed" },
    ],
    categories: [{ id: 7, name: "Cat Beds", slug: "cat-beds" }],
    attributes: [{ name: "Option", variation: true, options: ["Cloud Grey", "Warm Brown"] }],
    variations: [{ id: 91 }, { id: 92 }],
    meta_data: [{ key: "_source_cj_facts", value: source }],
  };
  const variations = [
    { id: 91, sku: "WG-source-123-1", attributes: [{ name: "Option", option: "Cloud Grey" }], image: { src: "https://img.test/overlay.jpg" } },
    { id: 92, sku: "WG-source-123-2", attributes: [{ name: "Option", option: "Warm Brown" }], image: { src: "https://img.test/overlay.jpg" } },
  ];
  const oldCopy = { ...goodStoreCopy, tagline: "Dog beds for loyal companions", hero: { heading: "Better rest for dogs", subheading: "Dog beds for every nap." }, about: goodStoreCopy.about.map((p) => p.replaceAll("cat", "dog").replaceAll("Cat", "Dog")) };
  site.picks_json = JSON.stringify([{ productId: 9, source }]);
  site.spec_json = JSON.stringify({ copy: oldCopy, policies: { shipping: "shipping", returns: "returns", privacy: "privacy", terms: "terms" } });
  site.qa_json = null;
  const siteState = { options: { blogname: "Harbor Cat Goods", blogdescription: oldCopy.tagline, custom_logo: 10, site_icon: 11 }, info: {} as Record<string, unknown> };
  const emitted: { type: string; data: unknown }[] = [];
  let clock = 0;

  const pageNumber = (path: string) => Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? 1);
  const ctx = {
    d: {
      db,
      now: () => ++clock,
      workDir: ".tmp/review-autofix",
      browse: async (input: { pages: { name: string; path: string }[]; origin: string }) => ({
        shots: [],
        problems: [],
        captures: input.pages.map((target) => {
          const isProduct = target.path === "/product/cat-bed/";
          const page = pages.find((x) => target.path === (x.slug === "home" ? "/" : `/${x.slug}/`));
          const body = isProduct ? `${product.name}\n${product.short_description}\n${product.description}` : page?.content.rendered ?? `${siteState.options.blogdescription}\n${JSON.stringify(JSON.parse(site.spec_json || "{}").copy)}`;
          const footer = "Harbor Cat Goods LLC | support@shop.test | +1 503 555 0142 | 7428 Harbor Avenue, Portland, OR 97205";
          return { ...target, url: input.origin + target.path, text: `${body}\n${footer}`, sections: { header: "Harbor Cat Goods", body, footer }, links: [], linkStatuses: [], productLinks: isProduct || target.path === "/" ? [product.permalink] : [], status: 200, shot: `${target.name}.png` };
        }),
      }),
      ai: async (_role: string, prompt: string) => {
        if (prompt.startsWith("You write the website copy")) return { text: JSON.stringify(goodStoreCopy), cost: 0 };
        if (prompt.startsWith("You are preparing one factual WooCommerce product listing")) return { text: JSON.stringify({
          ...source.analysis,
          title: "Cozy Cat Bed",
          short_description: "A cat bed available in Cloud Grey and Warm Brown.",
          description_html: "<p>This cat bed is available in Cloud Grey and Warm Brown.</p>",
          variants: [
            { ...source.analysis.variants[0], buyerName: "Cloud Grey" },
            { ...source.analysis.variants[1], buyerName: "Warm Brown" },
          ],
        }), cost: 0 };
        if (prompt.startsWith("You are the final compliance reviewer") && prompt.includes("PAGE URL:\nhttps://shop.test/product/cat-bed/")) {
          if (/Navy|Extra Large/.test(`${product.short_description} ${product.description}`)) {
            return { text: reviewIssue("variation-option-copy", { evidence: "The description lists Navy and Extra Large, but the actual variation options are Cloud Grey and Warm Brown.", why: "The description has a mismatch with the actual WooCommerce variation names.", fix: "Regenerate title and descriptions using the actual variation option names." }), cost: 0 };
          }
        }
        return { text: emptyReview, cost: 0 };
      },
    },
    site,
    domain: "shop.test",
    form: { brand: "Harbor Cat Goods", categories: "cat beds" },
    entity: { kind: "company", name: "Harbor Cat Goods LLC", address: "7428 Harbor Avenue, Portland, OR 97205", supportEmail: "support@shop.test", phone: "+1 503 555 0142", processingDays: [1, 3], transitDays: [5, 10] },
    save: (column: string, value: string) => { (site as unknown as Record<string, unknown>)[column] = value; },
    emit: (type: string, data: unknown) => emitted.push({ type, data }),
    wp: async (method: string, path: string, body?: Record<string, unknown>) => {
      if (path.startsWith("wp/v2/pages?")) {
        if (path.includes("slug=")) {
          const slug = new URLSearchParams(path.split("?")[1]).get("slug");
          return pages.filter((x) => x.slug === slug);
        }
        return pageNumber(path) === 1 ? pages : [];
      }
      const pageWrite = /^wp\/v2\/pages\/(\d+)$/.exec(path);
      if (pageWrite && method === "POST") {
        const page = pages.find((x) => x.id === Number(pageWrite[1]))!;
        if (typeof body?.title === "string") page.title = { raw: body.title, rendered: body.title };
        if (typeof body?.content === "string") page.content = { raw: body.content, rendered: body.content };
        return page;
      }
      if (path.startsWith("wc/v3/products/categories?")) return pageNumber(path) === 1 ? product.categories : [];
      if (path.startsWith("wc/v3/products?")) return pageNumber(path) === 1 ? [structuredClone(product)] : [];
      if (path.startsWith("wc/v3/products/9/variations?")) return structuredClone(variations);
      const variationPath = /^wc\/v3\/products\/9\/variations\/(\d+)$/.exec(path);
      if (variationPath) {
        const variation = variations.find((x) => x.id === Number(variationPath[1]))!;
        if (method === "PUT") Object.assign(variation, structuredClone(body));
        return structuredClone(variation);
      }
      if (path.startsWith("wc/v3/products/9")) {
        if (method === "PUT") Object.assign(product, structuredClone(body));
        return structuredClone(product);
      }
      if (path === "site-agent/v1/site") {
        if (method === "POST") {
          if (body?.options && typeof body.options === "object") Object.assign(siteState.options, body.options);
          if (body?.info && typeof body.info === "object") siteState.info = structuredClone(body.info) as Record<string, unknown>;
        }
        return structuredClone(siteState);
      }
      if (path === "wc/v3/payment_gateways") return [{ id: "stripe", enabled: true }];
      if (path === "wc/v3/settings/general/woocommerce_currency") return { value: "USD" };
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as unknown as StepCtx;

  const vision = async (prompt: string) => {
    if (prompt.startsWith("Choose the clearest main photo")) return { text: JSON.stringify({ mainImage: "https://img.test/clean-cat-bed.jpg", reason: "The complete cat bed is visible without labels or overlays.", completeProductVisible: true }), cost: 0 };
    if (prompt.includes("https://shop.test/product/cat-bed/")) {
      if (product.images[0]?.src !== "https://img.test/clean-cat-bed.jpg") {
        const main = JSON.parse(reviewIssue("main-image-overlay", { kind: "visual", evidence: "The main product image has a prominent 60cm text overlay.", why: "A size-label overlay obscures the main product photo.", fix: "Choose a clean complete-item main image without text overlays." }));
        const variants = JSON.parse(reviewIssue("shared-variation-images", { evidence: "Both variations share the same product image even though source variant images differ.", why: "Variation images are identical and do not represent their individual options.", fix: "Assign each variation its exact source image." }));
        return { text: JSON.stringify({ issues: [...main.issues, ...variants.issues] }), cost: 0 };
      }
      if (variations.every((x) => x.image.src === variations[0].image.src)) return { text: reviewIssue("shared-variation-images", { evidence: "Both variations share the same product image even though source variant images differ.", why: "Variation images are identical and do not represent their individual options.", fix: "Assign each variation its exact source image." }), cost: 0 };
    }
    return { text: emptyReview, cost: 0 };
  };
  return { ctx, db, siteId, product, variations, pages, siteState, emitted, vision };
}

test("full-site review code-fixes image, variation, real-option copy and catalog copy without model actions", async () => {
  const f = fixture();
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });

  assert.equal(report.rounds, 1, "all code-mapped findings are repaired in one round without model actions");
  assert.equal(f.product.images[0].src, "https://img.test/clean-cat-bed.jpg");
  assert.deepEqual(f.variations.map((x) => x.image.src), ["https://img.test/grey-small.jpg", "https://img.test/brown-large.jpg"]);
  assert.match(f.product.description, /Cloud Grey/);
  assert.match(f.product.description, /Warm Brown/);
  assert.doesNotMatch(f.product.description, /Navy|Extra Large/);
  assert.match(f.siteState.options.blogdescription, /cats/i);
  assert.doesNotMatch(f.siteState.options.blogdescription, /dogs/i);
  assert(f.emitted.some((e) => e.type === "ai_text" && JSON.stringify(e.data).includes("QA")), "the selected code fix is logged");

  const changes = listChanges(f.db, f.siteId);
  assert(changes.length >= 4, "every repair is recorded as a changeset");
  assert(changes.every((change) => change.status === "applied" && change.initiator === "pi"));
  for (const change of changes) await revertChange(f.ctx, change.id);
  assert.equal(f.product.images[0].src, "https://img.test/overlay.jpg");
  assert(f.variations.every((x) => x.image.src === "https://img.test/overlay.jpg"));
  assert.match(f.product.description, /Navy/);
  assert.match(f.siteState.options.blogdescription, /Dog beds/);
});

test("needs_you findings are never written and exhausted two-round state persists across retries", async () => {
  const f = fixture();
  const needsYouVision = async (prompt: string) => {
    if (prompt.startsWith("Choose the clearest main photo")) return f.vision(prompt);
    if (prompt.includes("https://shop.test/product/cat-bed/")) return { text: reviewIssue("unknown-dimensions", {
      level: "P1",
      evidence: "The actual product dimensions are unknown and the source has no proof.",
      why: "Real measurements cannot be inferred.",
      fix: "Confirm the actual dimensions from a verified source.",
      needs_real_data: true,
    }), cost: 0 };
    return { text: emptyReview, cost: 0 };
  };
  f.ctx.site.qa_json = JSON.stringify({ review: { at: 1, rounds: 2, passed: false, issues: [] } });
  const before = listChanges(f.db, f.siteId).length;
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: needsYouVision });
  const retry = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: needsYouVision });

  assert.equal(report.rounds, 2);
  assert.equal(retry.rounds, 2);
  assert.equal(retry.issues.find((x) => /actual product dimensions/i.test(x.evidence))?.status, "needs_you");
  assert.equal(listChanges(f.db, f.siteId).length, before, "needs_you and exhausted retries perform no writes");
});

test("review-created changesets retain conflict-checked rollback", async () => {
  const f = fixture();
  await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision, maxRounds: 1 });
  const imageChange = listChanges(f.db, f.siteId).find((change) => change.summary.includes("main-image"))!;
  f.product.images = [{ id: 77, src: "https://img.test/operator-change.jpg", alt: "Operator replacement" }];
  await assert.rejects(revertChange(f.ctx, imageChange.id), /不能直接回滚|changed/i);
  assert.equal(listChanges(f.db, f.siteId).find((change) => change.id === imageChange.id)?.status, "applied");
});
