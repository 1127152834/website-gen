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

function fixture(legacy = false) {
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
  if (legacy) {
    product.attributes = [
      { name: "Color", variation: true, options: ["Grey", "Brown"] },
      { name: "Size", variation: true, options: ["S", "L"] },
    ];
    variations[0].attributes = [{ name: "Color", option: "Grey" }, { name: "Size", option: "S" }];
    variations[1].attributes = [{ name: "Color", option: "Brown" }, { name: "Size", option: "L" }];
  }
  const oldCopy = { ...goodStoreCopy, tagline: "Dog beds for loyal companions", hero: { heading: "Better rest for dogs", subheading: "Dog beds for every nap." }, about: goodStoreCopy.about.map((p) => p.replaceAll("cat", "dog").replaceAll("Cat", "Dog")) };
  if (legacy) product.meta_data = [];
  site.picks_json = JSON.stringify([{ pid: "source-123", name: "Cat Bed", keyword: "cat beds", costMin: 5, costMax: 7, listed: 10, status: "done", productId: 9, ...(!legacy ? { source } : {}) }]);
  db.prepare("UPDATE sites SET picks_json = ? WHERE id = ?").run(site.picks_json, siteId);
  site.spec_json = JSON.stringify({ copy: oldCopy, policies: { shipping: "shipping", returns: "returns", privacy: "privacy", terms: "terms" } });
  site.qa_json = null;
  const siteState = { options: { blogname: "Harbor Cat Goods", blogdescription: oldCopy.tagline, custom_logo: 10, site_icon: 11 }, info: {} as Record<string, unknown> };
  const emitted: { type: string; data: unknown }[] = [];
  let clock = 0;
  const cjCalls: string[] = [];

  const pageNumber = (path: string) => Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? 1);
  const ctx = {
    d: {
      db,
      now: () => ++clock,
      cj: async (path: string) => {
        cjCalls.push(path);
        return {
          pid: "source-123", productNameEn: "Cat Bed", categoryName: "Cat Beds",
          description: "A cat bed offered in grey and brown options.", productKeyEn: "Color-Size",
          productImageSet: ["https://img.test/overlay.jpg", "https://img.test/clean-cat-bed.jpg"],
          variants: [
            { variantKey: "Grey-S", variantSellPrice: 5, variantWeight: 500, variantLength: 40, variantWidth: 30, variantHeight: 10, variantImage: "https://img.test/grey-small.jpg" },
            { variantKey: "Brown-L", variantSellPrice: 7, variantWeight: 700, variantLength: 55, variantWidth: 45, variantHeight: 12, variantImage: "https://img.test/brown-large.jpg" },
          ],
        };
      },
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
        if (prompt.startsWith("Review dimension units only")) return { text: '{"questionable":[]}', cost: 0 };
        if (prompt.startsWith("You write the website copy")) return { text: JSON.stringify(goodStoreCopy), cost: 0 };
        if (prompt.startsWith("You are preparing one factual WooCommerce product listing") && !prompt.includes("QA COPY REPAIR:")) return { text: JSON.stringify(source.analysis), cost: 0 };
        if (prompt.startsWith("You are preparing one factual WooCommerce product listing")) return { text: JSON.stringify({
          ...source.analysis,
          title: "Cozy Cat Bed",
          short_description: legacy ? "A cat bed available in Grey / S and Brown / L." : "A cat bed available in Cloud Grey and Warm Brown.",
          description_html: legacy ? "<p>This cat bed is available in Grey / S and Brown / L.</p>" : "<p>This cat bed is available in Cloud Grey and Warm Brown.</p>",
          variants: [
            { ...source.analysis.variants[0], buyerName: legacy ? "Grey / S" : "Cloud Grey" },
            { ...source.analysis.variants[1], buyerName: legacy ? "Brown / L" : "Warm Brown" },
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
    save: (column: string, value: string) => {
      assert(["picks_json", "spec_json", "qa_json"].includes(column));
      db.prepare(`UPDATE sites SET ${column} = ? WHERE id = ?`).run(value, siteId);
      (site as unknown as Record<string, unknown>)[column] = value;
    },
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
  return { ctx, db, siteId, product, variations, pages, siteState, emitted, vision, source, cjCalls };
}

test("legacy published picks backfill CJ once and repair real-option copy and variation images with changesets", async () => {
  const f = fixture(true);
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.doesNotMatch(f.product.description, /Navy|Extra Large/, "missing source must not leave product-copy planning undefined");
  assert.match(f.product.description, /Grey \/ S.*Brown \/ L/);
  assert.deepEqual(f.variations.map((v) => v.image.src), ["https://img.test/grey-small.jpg", "https://img.test/brown-large.jpg"]);
  assert.equal(report.rounds, 1);
  assert.deepEqual(f.cjCalls, ["/product/query?pid=source-123"]);
  const saved = f.db.prepare("SELECT picks_json FROM sites WHERE id = ?").get(f.siteId) as { picks_json: string };
  const [pick] = JSON.parse(saved.picks_json);
  assert.equal(pick.status, "done");
  assert.equal(pick.source.product.pid, "source-123");
  assert.equal(pick.source.product.variants[1].image, "https://img.test/brown-large.jpg");
  assert(pick.source.analysis && pick.source.unitReview);
  const changes = listChanges(f.db, f.siteId);
  assert(changes.some((c) => c.summary.includes("product-copy")));
  assert(changes.some((c) => c.summary.includes("variation-images")));
  await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.equal(f.cjCalls.length, 1, "persisted source is reused across QA invocations");
});

function copyOnlyFixture(legacy = false) {
  const f = fixture(legacy);
  f.ctx.site.spec_json = JSON.stringify({ copy: goodStoreCopy });
  f.siteState.options.blogdescription = goodStoreCopy.tagline;
  return { ...f, vision: async () => ({ text: emptyReview, cost: 0 }) };
}

test("a valid model product-copy action also hydrates legacy source before grounded write validation", async () => {
  const f = copyOnlyFixture(true);
  const ai = f.ctx.d.ai;
  f.ctx.d.ai = async (role, prompt) => {
    if (prompt.startsWith("You are the final compliance reviewer") && prompt.includes("PAGE URL:\nhttps://shop.test/product/cat-bed/") && /Navy/.test(f.product.description)) {
      return { text: reviewIssue("variation-option-copy", {
        evidence: "The description variant names differ from the actual variation options Grey / S and Brown / L.",
        why: "Product description options mismatch the real variants.",
        fix: "Use actual variation option names.",
        action: { tool: "update_product", params: { id: 9, summary: "修复真实规格文案", name: "Cat Bed", short_description: "A cat bed in Grey / S and Brown / L.", description_html: "<p>A cat bed in Grey / S and Brown / L.</p>" } },
      }), cost: 0 };
    }
    return ai(role, prompt);
  };
  await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.doesNotMatch(f.product.description, /Navy|Extra Large/);
  assert.deepEqual(f.cjCalls, ["/product/query?pid=source-123"]);
  assert(listChanges(f.db, f.siteId).some((c) => c.summary === "修复真实规格文案"), "preserve the valid model action, but hydrate its factual authority first");
});

test("source recovery failure explicitly clears the model fallback action and keeps its exact warning", async () => {
  const f = copyOnlyFixture(true);
  const ai = f.ctx.d.ai;
  f.ctx.d.cj = async (path) => { f.cjCalls.push(path); throw new Error("HTTP 404: removed product"); };
  f.ctx.d.ai = async (role, prompt) => {
    if (prompt.startsWith("You are the final compliance reviewer") && prompt.includes("PAGE URL:\nhttps://shop.test/product/cat-bed/")) {
      return { text: reviewIssue("variation-option-copy", {
        evidence: "The description variant names differ from the real variation options.",
        why: "Product description options mismatch the real variants.",
        action: { tool: "update_product", params: { id: 9, summary: "删除多余文字", description_html: "<p>Choose Navy.</p>" } },
      }), cost: 0 };
    }
    return ai(role, prompt);
  };
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.equal(f.product.description, "<p>Choose Navy or Extra Large.</p>");
  assert.equal(listChanges(f.db, f.siteId).length, 0, "even a deletion-only model fallback must be cleared after recovery fails");
  assert.equal(f.cjCalls.length, 1);
  assert(report.issues.some((i) => i.status === "open" && i.evidence.includes("description variant names")));
  assert(f.emitted.some((e) => e.type === "warn" && /product-copy.*source-123.*HTTP 404: removed product/.test(JSON.stringify(e.data))));
});

for (const failure of [
  { name: "removed", response: null, reason: /source-123.*已移除|source-123.*空资料/ },
  { name: "CJ error", error: "HTTP 404: product removed", reason: /source-123.*HTTP 404: product removed/ },
  { name: "wrong product", response: { pid: "another-product", productNameEn: "Different item" }, reason: /source-123.*不匹配.*another-product/ },
]) {
  test(`missing-source ${failure.name} stays open and logs the exact CJ reason without unsafe writes`, async () => {
    const f = copyOnlyFixture(true);
    f.ctx.d.cj = async (path) => {
      f.cjCalls.push(path);
      if (failure.error) throw new Error(failure.error);
      return failure.response;
    };
    const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
    assert.match(f.product.description, /Navy/);
    assert(report.issues.some((i) => i.status === "open" && i.evidence.includes("description lists")));
    assert(f.emitted.some((e) => e.type === "warn" && /product-copy/.test(JSON.stringify(e.data)) && failure.reason.test(JSON.stringify(e.data))));
    assert.equal(f.cjCalls.length, 1);
    assert.equal(JSON.parse(f.ctx.site.picks_json!)[0].source, undefined);
    assert.equal(listChanges(f.db, f.siteId).length, 0);
  });
}

for (const invalid of [
  { name: "copy contract", title: "A".repeat(81), reason: /checkProductCopy: title is too long/ },
  { name: "ungrounded claim", title: "Waterproof Cat Bed", reason: /grounded-claims: claim.*waterproof.*not supported/i },
]) {
  test(`product-copy diagnoses ${invalid.name} after exactly two failed generations`, async () => {
    const f = copyOnlyFixture();
    const ai = f.ctx.d.ai;
    let attempts = 0;
    f.ctx.d.ai = async (role, prompt) => {
      const reply = await ai(role, prompt);
      if (!prompt.includes("QA COPY REPAIR:")) return reply;
      attempts++;
      return { ...reply, text: JSON.stringify({ ...JSON.parse(reply.text), title: invalid.title }) };
    };
    const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
    assert.equal(attempts, 2);
    assert.match(f.product.description, /Navy/);
    assert(report.issues.some((i) => i.status === "open" && i.evidence.includes("description lists")));
    const warnings = f.emitted.filter((e) => e.type === "warn").map((e) => JSON.stringify(e.data)).join("\n");
    assert.match(warnings, invalid.reason);
    assert.match(warnings, /product-copy.*AI 两次/);
    assert.equal(listChanges(f.db, f.siteId).length, 0);
    assert.equal(f.cjCalls.length, 0);
  });
}

test("failed source analysis caches raw facts, shares failures across findings and retries without refetching CJ", async () => {
  const f = fixture(true);
  const ai = f.ctx.d.ai;
  let attempts = 0;
  f.ctx.d.ai = async (role, prompt) => {
    if (prompt.startsWith("You are preparing one factual WooCommerce product listing") && !prompt.includes("QA COPY REPAIR:")) {
      attempts++;
      return { text: JSON.stringify({ ...f.source.analysis, title: "Waterproof Cat Bed" }), cost: 0 };
    }
    return ai(role, prompt);
  };
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.equal(attempts, 2, "different findings must share one two-attempt source-analysis failure");
  assert.equal(f.cjCalls.length, 1);
  const cached = JSON.parse(f.ctx.site.picks_json!)[0].source;
  assert.equal(cached.product.pid, "source-123");
  assert.equal(cached.analysis, undefined, "unvalidated model output is not authoritative source analysis");
  assert(report.issues.some((i) => i.status === "open" && i.evidence.includes("description lists")));
  assert(f.emitted.some((e) => e.type === "warn" && /product-copy.*文案事实分析失败/.test(JSON.stringify(e.data))));
  assert(f.emitted.some((e) => e.type === "warn" && /variation-images.*文案事实分析失败/.test(JSON.stringify(e.data))));
  f.ctx.d.ai = ai;
  await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.equal(f.cjCalls.length, 1);
  assert.doesNotMatch(f.product.description, /Navy|Extra Large/);
});

test("failed unit review preserves only validated stages and resumes without a second CJ fetch", async () => {
  const f = copyOnlyFixture(true);
  const ai = f.ctx.d.ai;
  let attempts = 0;
  f.ctx.d.ai = async (role, prompt) => {
    if (prompt.startsWith("Review dimension units only")) {
      attempts++;
      return { text: '{"questionable":[{"sourceKey":"missing","fields":[],"reason":""}]}', cost: 0 };
    }
    return ai(role, prompt);
  };
  await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  const cached = JSON.parse(f.ctx.site.picks_json!)[0].source;
  assert(cached.product && cached.analysis);
  assert.equal(cached.unitReview, undefined);
  assert.equal(attempts, 2);
  assert(f.emitted.some((e) => e.type === "warn" && /product-copy.*尺寸单位复核失败/.test(JSON.stringify(e.data))));
  assert.equal(listChanges(f.db, f.siteId).length, 0);
  f.ctx.d.ai = ai;
  await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.equal(f.cjCalls.length, 1);
  assert.doesNotMatch(f.product.description, /Navy|Extra Large/);
});

test("missing pick pid is diagnosed without guessing a CJ identifier", async () => {
  const f = copyOnlyFixture(true);
  f.ctx.site.picks_json = JSON.stringify([{ productId: 9, status: "done" }]);
  await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert(f.emitted.some((e) => e.type === "warn" && /product-copy.*找不到带 pid/.test(JSON.stringify(e.data))));
  assert.equal(f.cjCalls.length, 0);
  assert.equal(listChanges(f.db, f.siteId).length, 0);
});

test("exhausted QA rounds never fetch or regenerate missing legacy source", async () => {
  const f = fixture(true);
  f.ctx.site.qa_json = JSON.stringify({ review: { at: 1, rounds: 2, passed: false, issues: [] } });
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.equal(report.rounds, 2);
  assert.equal(f.cjCalls.length, 0);
  assert.equal(JSON.parse(f.ctx.site.picks_json!)[0].source, undefined);
  assert.equal(listChanges(f.db, f.siteId).length, 0);
});

test("product-copy refuses incomplete live variation options and names the read failure", async () => {
  const f = copyOnlyFixture();
  const wp = f.ctx.wp;
  f.ctx.wp = async (method, path, body) => path.startsWith("wc/v3/products/9/variations?") ? [] : wp(method, path, body);
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert.match(f.product.description, /Navy/);
  assert(report.issues.some((i) => i.status === "open" && i.evidence.includes("description lists")));
  assert(f.emitted.some((e) => e.type === "warn" && /product-copy.*完整且唯一的真实规格选项/.test(JSON.stringify(e.data))));
  assert.equal(listChanges(f.db, f.siteId).length, 0);
});

test("variation-images names the missing CJ variant image and leaves it unresolved", async () => {
  const f = fixture();
  Reflect.deleteProperty(f.source.product.variants[1], "image");
  f.ctx.site.picks_json = JSON.stringify([{ productId: 9, source: f.source }]);
  const report = await runFullSiteReview(f.ctx, { loginUrl: "https://login.test", vision: f.vision });
  assert(f.emitted.some((e) => e.type === "warn" && /variation-images.*缺少对应规格图片.*Brown-L/.test(JSON.stringify(e.data))));
  assert(report.issues.some((i) => i.status === "open" && i.evidence.includes("share the same product image")));
  assert(f.variations.every((v) => v.image.src === "https://img.test/overlay.jpg"));
  assert(!listChanges(f.db, f.siteId).some((c) => c.summary.includes("variation-images")));
});

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
