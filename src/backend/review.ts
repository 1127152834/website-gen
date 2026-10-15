// 阶段三整站复核：REST 枚举全部页面/商品/分类，再用浏览器取正文和整页截图。
// 文本与视觉模型只提出有证据的问题；可安全修改的动作走 siteTools -> changeset，最多修两轮。
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ReviewIssue, SiteReview } from "../shared/protocol.ts";
import { RULES } from "../shared/rules.ts";
import type { StepCtx } from "./pipeline.ts";
import type { BrowseCapture } from "./qa-browser.ts";
import { siteTools } from "./site-tools.ts";
import type { VisionComplete } from "./vision.ts";
import { deterministicDimensionProblems, type ProductAnalysis, type UnitReview } from "./product-content.ts";
import { splitVariants, type CjProduct } from "./cj.ts";

const PAGE_SIZE = 100;
const ARCHIVE_PAGE_SIZE = 16;
const MAX_TEXT = 32_000;
const ACTIONS = ["update_copy", "update_policy", "update_product", "update_product_main_image", "update_product_categories", "update_meta"] as const;
type ActionName = (typeof ACTIONS)[number];

export interface ReviewAction { tool: ActionName; params: Record<string, unknown> }
export interface ReviewFinding { issue: ReviewIssue; action?: ReviewAction; needsRealData: boolean; semanticKey?: string }
export interface ReviewTarget { name: string; path: string; kind: "page" | "post" | "product" | "category" | "archive"; targetId?: number }
export interface ReviewSnapshot {
  targets: ReviewTarget[];
  captures: BrowseCapture[];
  products: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  sourceFacts: unknown;
  spec: unknown;
  config: unknown;
}

interface RawIssue {
  key: string;
  level: "P1" | "P2" | "P3";
  kind: ReviewIssue["kind"];
  page: string;
  url: string;
  evidence: string;
  why: string;
  fix: string;
  needs_real_data: boolean;
  action?: { tool: string; params: Record<string, unknown> };
}

const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const jsonReply = (text: string): unknown => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const source = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(source);
};
const issueId = (kind: string, url: string, key: string) => `${kind}-${createHash("sha256").update(`${url.trim().toLowerCase()}|${key.trim().toLowerCase()}`).digest("hex").slice(0, 16)}`;
const needsVerifiedFacts = (v: RawIssue) => {
  const text = `${v.evidence}\n${v.why}\n${v.fix}`;
  const facts = /\b(dimensions?|measurements?|units?|sizes?|piece count|components?|set contents?|materials?|fabric|leather|certification|proof)\b/i.test(text);
  const unavailable = /\b(27\s*m|missing|unknown|unclear|ambiguous|unsupported|unverified|verify|confirm|actual|real data|source does not|no (?:source|proof|evidence))\b/i.test(text);
  return facts && unavailable;
};
const validActionParams = (tool: ActionName, p: Record<string, unknown>) => {
  if (!string(p.summary)) return false;
  const id = () => Number.isInteger(p.id) && Number(p.id) > 0;
  if (tool === "update_copy") return ["tagline", "hero_heading", "hero_subheading", "about", "faq"].some((x) => p[x] !== undefined);
  if (tool === "update_policy") return ["shipping", "returns", "privacy", "terms"].includes(String(p.name)) && string(p.html);
  if (tool === "update_product") return id() && ["name", "short_description", "description_html"].some((x) => p[x] !== undefined);
  if (tool === "update_product_main_image") return id() && Number.isInteger(p.image_id) && Number(p.image_id) > 0;
  if (tool === "update_product_categories") return id() && Array.isArray(p.category_ids) && p.category_ids.length > 0 && p.category_ids.every((x) => Number.isInteger(x) && Number(x) > 0);
  return ["home", "shop", "page", "product", "product_cat"].includes(String(p.target_type))
    && Number.isInteger(p.target_id) && Number(p.target_id) >= 0 && string(p.description) && string(p.og_description);
};

/** 严格解析模型结果；不接受缺证据、未知级别/类型/动作，避免“复核成功”来自宽松容错。 */
export function parseReviewIssues(text: string, shot?: string): ReviewFinding[] {
  const root = jsonReply(text);
  if (!object(root) || !Array.isArray(root.issues)) throw new Error("复核模型必须返回 {issues:[...]}");
  const levels = new Set(["P1", "P2", "P3"]), kinds = new Set(["copy", "policy", "product", "visual", "seo", "config", "other"]);
  return root.issues.map((value, index) => {
    if (!object(value)) throw new Error(`复核问题 #${index + 1} 不是对象`);
    for (const field of ["key", "level", "kind", "page", "url", "evidence", "why", "fix"] as const) {
      if (!string(value[field])) throw new Error(`复核问题 #${index + 1} 缺少 ${field}`);
    }
    if (!levels.has(value.level as string)) throw new Error(`复核问题 #${index + 1} 的 level 无效`);
    if (!kinds.has(value.kind as string)) throw new Error(`复核问题 #${index + 1} 的 kind 无效`);
    if (typeof value.needs_real_data !== "boolean") throw new Error(`复核问题 #${index + 1} 缺少 needs_real_data`);
    let action: ReviewAction | undefined;
    if (value.action != null) {
      if (!object(value.action) || !ACTIONS.includes(value.action.tool as ActionName) || !object(value.action.params)
        || !validActionParams(value.action.tool as ActionName, value.action.params)) {
        throw new Error(`复核问题 #${index + 1} 的 action 不在允许列表`);
      }
      action = { tool: value.action.tool as ActionName, params: value.action.params };
    }
    const raw = value as unknown as RawIssue;
    const realData = raw.needs_real_data || needsVerifiedFacts(raw);
    return {
      issue: {
        id: issueId(raw.kind, raw.url, raw.key), level: raw.level, kind: raw.kind, page: raw.page.trim(), url: raw.url.trim(),
        evidence: raw.evidence.trim(), why: raw.why.trim(), fix: raw.fix.trim(), status: realData ? "needs_you" : "open",
        ...(shot ? { shot } : {}),
      },
      action: realData ? undefined : action,
      needsRealData: realData, semanticKey: raw.key.trim(),
    };
  });
}

async function paged<T>(ctx: StepCtx, endpoint: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 100; page++) {
    let rows: T[];
    try {
      rows = (await ctx.wp("GET", `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`)) as T[];
    } catch (e) {
      // WordPress 对恰好 100 的倍数会在“多取一页”时回 400，而不是空数组；只吞这一种明确的分页终点。
      if (page > 1 && e instanceof Error && /HTTP 400.*page number requested is larger than the number of pages available/i.test(e.message)) return out;
      throw e;
    }
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
  throw new Error(`REST 分页超过 100 页：${endpoint}`);
}

const pathname = (link: unknown, fallback: string) => {
  try { return new URL(String(link)).pathname || fallback; } catch { return fallback; }
};

/** REST 分页枚举，不依赖第一页“碰巧包含全部内容”。 */
export async function crawlReviewTargets(ctx: StepCtx): Promise<{
  targets: ReviewTarget[]; products: Record<string, unknown>[]; categories: Record<string, unknown>[];
}> {
  // 公开视图能读到店长在 edit context 看不到的隐私政策页。
  const pages = await paged<Record<string, unknown>>(ctx, "wp/v2/pages?status=publish&_fields=id,slug,link,title");
  const posts = await paged<Record<string, unknown>>(ctx, "wp/v2/posts?status=publish&_fields=id,slug,link,title");
  const products = await paged<Record<string, unknown>>(ctx, "wc/v3/products?status=publish&_fields=id,name,slug,permalink,description,short_description,images,categories,attributes,variations,meta_data");
  const categories = await paged<Record<string, unknown>>(ctx, "wc/v3/products/categories?hide_empty=true&_fields=id,name,slug,count");
  for (const product of products) {
    if (Array.isArray(product.meta_data)) product.meta_data = product.meta_data.filter((item) => object(item) && item.key === "_source_cj_facts");
    const id = Number(product.id);
    if (id > 0) product.variation_details = await paged<Record<string, unknown>>(ctx, `wc/v3/products/${id}/variations?_fields=id,description,attributes,image,dimensions,weight,meta_data`);
  }
  const targets: ReviewTarget[] = [];
  for (const page of pages) {
    const slug = String(page.slug ?? "page");
    targets.push({ name: `page-${page.id}-${slug}`, path: pathname(page.link, `/${slug}/`), kind: "page", targetId: Number(page.id) });
  }
  for (const post of posts) {
    const slug = String(post.slug ?? "post");
    targets.push({ name: `post-${post.id}-${slug}`, path: pathname(post.link, `/${slug}/`), kind: "post", targetId: Number(post.id) });
  }
  for (const product of products) {
    const slug = String(product.slug ?? product.id);
    targets.push({ name: `product-${product.id}-${slug}`, path: pathname(product.permalink, `/product/${slug}/`), kind: "product", targetId: Number(product.id) });
  }
  const productPages = Math.max(1, Math.ceil(products.length / ARCHIVE_PAGE_SIZE));
  for (let page = 1; page <= productPages; page++) {
    targets.push({ name: `shop-${page}`, path: page === 1 ? "/shop/" : `/shop/page/${page}/`, kind: "archive" });
  }
  for (const category of categories) {
    const slug = String(category.slug ?? category.id), count = Number(category.count ?? 0);
    const countPages = Math.max(1, Math.ceil(count / ARCHIVE_PAGE_SIZE));
    for (let page = 1; page <= countPages; page++) {
      targets.push({
        name: `category-${category.id}-${slug}-${page}`,
        path: page === 1 ? `/product-category/${slug}/` : `/product-category/${slug}/page/${page}/`,
        kind: "category", targetId: Number(category.id),
      });
    }
  }
  if (products.length) {
    const term = String(products[0].name ?? products[0].slug ?? "product").trim().split(/\s+/)[0] || "product";
    targets.push({ name: "search-products", path: `/?s=${encodeURIComponent(term)}`, kind: "archive" });
    targets.push({ name: "search-no-results", path: "/?s=phase3-review-no-such-product-7f4d2", kind: "archive" });
  }
  const unique = [...new Map(targets.map((x) => [x.path, x])).values()];
  return { targets: unique, products, categories };
}

export async function collectReviewSnapshot(ctx: StepCtx, loginUrl: string, outDir: string): Promise<ReviewSnapshot> {
  if (!ctx.d.browse) throw new Error("整站 AI 复核需要浏览器，不能跳过");
  const { targets, products, categories } = await crawlReviewTargets(ctx);
  if (targets.length === 0) throw new Error("整站 AI 复核没有找到任何公开页面");
  const first = products[0];
  const firstVariation = Array.isArray(first?.variations) ? Number(first.variations[0]) : 0;
  const result = await ctx.d.browse({
    loginUrl, origin: `https://${ctx.domain}`, outDir,
    pages: targets.map((x) => ({ name: x.name, path: x.path })),
    cart: first ? { addPath: `/?add-to-cart=${firstVariation || Number(first.id)}`, expect: String(first.name ?? "") } : undefined,
  });
  const capturedPaths = new Set(result.captures?.map((x) => x.path));
  const missing = targets.filter((x) => !capturedPaths.has(x.path));
  if (!result.captures || missing.length) {
    throw new Error(`整站 AI 复核抓取不完整：缺少 ${missing.slice(0, 5).map((x) => x.path).join(", ") || `${targets.length} 个目标`}`);
  }
  if (result.problems.length) throw new Error(`整站 AI 复核抓取失败：${result.problems.join("；")}`);
  const site = await ctx.wp("GET", "site-agent/v1/site");
  const zones = await ctx.wp("GET", "wc/v3/shipping/zones") as { id: number }[];
  const shipping = await Promise.all(zones.map(async (zone) => ({ zone, methods: await ctx.wp("GET", `wc/v3/shipping/zones/${zone.id}/methods`) })));
  const [payments, metadata] = await Promise.all([
    ctx.wp("GET", "wc/v3/payment_gateways"),
    ctx.wp("GET", "site-agent/v1/metadata"),
  ]);
  return {
    targets, captures: result.captures, products, categories,
    sourceFacts: JSON.parse(ctx.site.picks_json || "[]"), spec: JSON.parse(ctx.site.spec_json || "{}"),
    config: { site, shipping, payments, metadata },
  };
}

const reviewRules = () => ({
  free_shipping_over: RULES.freeShippingOver, paid_shipping: RULES.flatRate, region: RULES.region,
  return_days: RULES.returnDays, refund_business_days: RULES.refundDays,
});

function reviewContext(snapshot: ReviewSnapshot, capture: BrowseCapture) {
  const target = snapshot.targets.find((x) => x.name === capture.name);
  const matching = snapshot.products.filter((p) => Number(p.id) === target?.targetId || capture.text.includes(String(p.name ?? "\0")));
  if (matching.length) {
    const ids = new Set(matching.map((p) => Number(p.id)));
    const source = Array.isArray(snapshot.sourceFacts) ? snapshot.sourceFacts.filter((p) => object(p) && ids.has(Number(p.productId))) : [];
    return { products: matching, source };
  }
  // 非商品页只需列表/变体摘要来核对数量、标题和入口，避免把所有长描述静默截断。
  return {
    products: snapshot.products.map((p) => ({ id: p.id, name: p.name, slug: p.slug, categories: p.categories, attributes: p.attributes, variations: p.variations })),
    source: [],
  };
}

const redactSecrets = (text: string) => text.replace(/\b(password|api[_ -]?key|authorization|access[_ -]?token)\s*[:=]\s*\S+/gi, "$1=[redacted]");

export function splitReviewText(text: string): string[] {
  return text.length ? Array.from({ length: Math.ceil(text.length / MAX_TEXT) }, (_, i) => text.slice(i * MAX_TEXT, (i + 1) * MAX_TEXT)) : [""];
}

function textPrompt(snapshot: ReviewSnapshot, capture: BrowseCapture, pageText: string, chunk: number, totalChunks: number) {
  const context = reviewContext(snapshot, capture);
  const productJson = JSON.stringify(context.products), sourceJson = JSON.stringify(context.source), configJson = JSON.stringify(snapshot.config);
  if (productJson.length > 160_000 || sourceJson.length > 160_000 || configJson.length > 80_000) {
    throw new Error(`Page ${capture.name} facts exceed the safe review context; refusing a partial review`);
  }
  return `You are the final compliance reviewer for a US English WooCommerce store. Review ONLY the supplied page, against the fixed store rules, actual WooCommerce/site configuration and source product facts. Check policy/product/checkout shipping consistency, titles versus every variant, units and dimensions, unsupported materials/certifications/discounts, WordPress sample/default content, result counts, payment claims, metadata and missing procedures. Never guess missing dimensions, set contents or materials.\n\nReturn strict JSON only: {"issues":[{"key":"stable semantic key scoped to URL","level":"P1|P2|P3","kind":"copy|policy|product|visual|seo|config|other","page":"buyer-readable page name","url":"absolute URL","evidence":"exact visible text or precise observed fact","why":"why it conflicts","fix":"specific correction","needs_real_data":true|false,"action":{"tool":"update_copy|update_policy|update_product|update_product_main_image|update_product_categories|update_meta","params":{}}}]}. Omit action when no allowlisted tool can safely fix it. An empty issues array is valid. Any actual dimensions, set contents or material proof missing from source facts MUST use needs_real_data=true and no action. Tool params must be complete and include summary.\n\nSTORE RULES:\n${JSON.stringify(reviewRules())}\nACTUAL CONFIGURATION:\n${configJson}\nSOURCE FACTS:\n${sourceJson}\nPRODUCT RECORDS:\n${productJson}\nPAGE URL:\n${capture.url}\nPAGE TEXT CHUNK ${chunk}/${totalChunks}:\n${redactSecrets(pageText)}`;
}

function visualPrompt(capture: BrowseCapture) {
  return `Review this full-page screenshot of ${capture.url}. Check whether the main product image clearly shows the complete item, whether there are blank areas, horizontal overflow, broken galleries, template leftovers, "0 items" with visible products, blog-style product search results, misleading payment logos, and whether real products/category entry points are visible above the fold on mobile. Return strict JSON: {"issues":[{"key":"stable semantic key","level":"P1|P2|P3","kind":"visual|product|seo|other","page":"name","url":"${capture.url}","evidence":"precise visible fact","why":"impact","fix":"specific fix","needs_real_data":true|false}]}. Visual review must not propose actions because screenshots do not carry trusted object IDs. Empty issues is valid.`;
}

function actionMatchesTarget(action: ReviewAction, target: ReviewTarget | undefined, path: string): boolean {
  const id = Number(action.params.id);
  if (["update_product", "update_product_main_image", "update_product_categories"].includes(action.tool)) return target?.kind === "product" && target.targetId === id;
  if (action.tool === "update_copy") return ["home", "about", "faq"].includes(path === "/" ? "home" : path.replace(/^\/+|\/+$/g, ""));
  if (action.tool === "update_policy") {
    const expected: Record<string, string> = { shipping: "shipping", returns: "returns", privacy: "privacy-policy", terms: "terms" };
    return target?.kind === "page" && path.replace(/^\/+|\/+$/g, "") === expected[String(action.params.name)];
  }
  if (action.tool === "update_meta") {
    const type = String(action.params.target_type), targetId = Number(action.params.target_id);
    if (path === "/") return type === "home" && targetId === 0;
    if (path === "/shop/") return type === "shop" && targetId === 0;
    const expected = target?.kind === "page" ? "page" : target?.kind === "product" ? "product" : target?.kind === "category" ? "product_cat" : "";
    return type === expected && targetId === target?.targetId;
  }
  return false;
}

interface StoredSource { product: CjProduct; analysis: ProductAnalysis; unitReview: UnitReview }
export function deterministicSourceFindings(snapshot: ReviewSnapshot): ReviewFinding[] {
  if (!Array.isArray(snapshot.sourceFacts)) return [];
  const out: ReviewFinding[] = [];
  for (const value of snapshot.sourceFacts) {
    if (!object(value) || !object(value.source) || !object(value.source.product) || !object(value.source.analysis) || !object(value.source.unitReview)) continue;
    const productId = Number(value.productId), source = value.source as unknown as StoredSource;
    const target = snapshot.targets.find((x) => x.kind === "product" && x.targetId === productId);
    const capture = snapshot.captures.find((x) => x.name === target?.name);
    if (!capture) continue;
    const attrs = splitVariants(source.product.keyNames, source.product.variants.map((x) => x.key));
    const dimensions = source.product.variants.flatMap((variant, i) => deterministicDimensionProblems(source.product, { ...variant, attrs: attrs[i] ?? { Option: variant.key } }));
    const questionable = Array.isArray(source.unitReview.questionable) ? source.unitReview.questionable : [];
    if (questionable.length || dimensions.length) {
      const key = "source-dimensions-withheld";
      out.push({ semanticKey: key, needsRealData: true, issue: {
        id: issueId("product", capture.url, key), level: "P2", kind: "product", page: `Product #${productId}`, url: capture.url,
        evidence: `Questionable source measurements were omitted pending verification: ${[...dimensions, ...questionable.map((x) => `${x.sourceKey}: ${x.reason}`)].join("; ")}`,
        why: "Publishing a guessed correction would misrepresent the product.", fix: "Provide verified supplier measurements and units, then regenerate the product copy.", status: "needs_you", ...(capture.shot ? { shot: capture.shot } : {}),
      } });
    }
    const unclear = Array.isArray(source.analysis.variants) ? source.analysis.variants.filter((x) => x.clear === false) : [];
    if (unclear.length) {
      const key = "source-variants-withheld";
      out.push({ semanticKey: key, needsRealData: true, issue: {
        id: issueId("product", capture.url, key), level: "P2", kind: "product", page: `Product #${productId}`, url: capture.url,
        evidence: `Unverified variants were excluded from sale: ${unclear.map((x) => x.sourceKey).join(", ")}`,
        why: "The delivered piece count or components are unclear in the supplier facts.", fix: "Provide verified set contents/components for these variants before publishing them.", status: "needs_you", ...(capture.shot ? { shot: capture.shot } : {}),
      } });
    }
  }
  return out;
}

async function inspectSnapshot(ctx: StepCtx, snapshot: ReviewSnapshot, vision: VisionComplete): Promise<ReviewFinding[]> {
  const all: ReviewFinding[] = [];
  for (const capture of snapshot.captures) {
    if (!capture.shot) throw new Error(`页面 ${capture.name} 没有截图，视觉复核不能跳过`);
    const chunks = splitReviewText(capture.text);
    const visualResult = await vision(visualPrompt(capture), [{ name: capture.name, file: capture.shot }]);
    ctx.emit("ai_text", { task: `整站视觉复核：${capture.name}`, cost: visualResult.cost, preview: visualResult.text.slice(0, 400) });
    const pageFindings = [...parseReviewIssues(visualResult.text, capture.shot)];
    for (let i = 0; i < chunks.length; i++) {
      const textResult = await ctx.d.ai("review", textPrompt(snapshot, capture, chunks[i], i + 1, chunks.length));
      ctx.emit("ai_text", { task: `整站文本复核：${capture.name} ${i + 1}/${chunks.length}`, cost: textResult.cost, preview: textResult.text.slice(0, 400) });
      pageFindings.push(...parseReviewIssues(textResult.text, capture.shot));
    }
    for (const finding of pageFindings) {
      finding.issue.url = capture.url;
      finding.issue.id = issueId(finding.issue.kind, capture.url, finding.semanticKey ?? finding.issue.id);
      const target = snapshot.targets.find((x) => x.name === capture.name);
      const action = finding.action;
      if (action && !actionMatchesTarget(action, target, capture.path)) finding.action = undefined;
      all.push(finding);
    }
  }
  all.push(...deterministicSourceFindings(snapshot));
  return [...new Map(all.map((x) => [x.issue.id, x])).values()];
}

export interface ReviewLoopDeps {
  now: () => number;
  collect: () => Promise<ReviewSnapshot>;
  inspect: (snapshot: ReviewSnapshot) => Promise<ReviewFinding[]>;
  apply: (finding: ReviewFinding) => Promise<boolean>;
  persist?: (review: SiteReview, factsHash: string) => void;
  previous?: SiteReview;
  previousFactsHash?: string;
  maxRounds?: number;
}

const combineHistory = (previous: ReviewIssue[], current: ReviewFinding[], reviewedUrls: Set<string>, factsChanged: boolean): ReviewIssue[] => {
  const now = new Map(current.map((x) => [x.issue.id, x.issue]));
  const history = previous.map((old) => {
    const fresh = now.get(old.id);
    if (fresh) { now.delete(old.id); return fresh; }
    // 真实资料不会因模型某轮漏报而凭空补齐；其余问题未再出现才记为已修复。
    return (old.status === "needs_you" && !factsChanged) || !reviewedUrls.has(old.url) ? old : { ...old, status: "fixed" as const };
  });
  return [...history, ...now.values()];
};

/** 与 WordPress 无关的循环核心，便于用纯 fake 精确验证两轮上限、历史和 needs_you。 */
export async function runReviewLoop(deps: ReviewLoopDeps): Promise<SiteReview> {
  const maxRounds = Math.min(2, Math.max(0, deps.maxRounds ?? 2));
  let rounds = Math.min(2, Math.max(0, deps.previous?.rounds ?? 0));
  let history = deps.previous?.issues ?? [];
  let snapshot = await deps.collect();
  for (;;) {
    const factsHash = createHash("sha256").update(JSON.stringify(snapshot.sourceFacts)).digest("hex");
    const findings = await deps.inspect(snapshot);
    const factsChanged = Boolean(deps.previousFactsHash && deps.previousFactsHash !== factsHash);
    history = combineHistory(history, findings, new Set(snapshot.captures.map((x) => x.url)), factsChanged);
    let review: SiteReview = { at: deps.now(), rounds, passed: !history.some((x) => x.level === "P1" && x.status !== "fixed"), issues: history };
    deps.persist?.(review, factsHash);
    const actionable = findings.filter((x) => x.issue.status === "open" && x.action);
    if (rounds >= maxRounds || actionable.length === 0) return review;
    rounds++;
    review = { ...review, at: deps.now(), rounds };
    deps.persist?.(review, factsHash);
    let changed = false;
    let fixFailed = false;
    const seen = new Set<string>();
    for (const finding of actionable) {
      const key = JSON.stringify(finding.action);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        changed = await deps.apply(finding) || changed;
      } catch (e) {
        fixFailed = true;
        finding.issue.fix = `${finding.issue.fix} Automatic fix failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (fixFailed) deps.persist?.(review, factsHash);
    if (!changed) return review;
    snapshot = await deps.collect();
  }
}

function previousReview(ctx: StepCtx): SiteReview | undefined {
  try { return (JSON.parse(ctx.site.qa_json || "{}") as { review?: SiteReview }).review; } catch { return undefined; }
}

function previousFactsHash(ctx: StepCtx): string | undefined {
  try { return (JSON.parse(ctx.site.qa_json || "{}") as { reviewFactsHash?: string }).reviewFactsHash; } catch { return undefined; }
}

function persistReview(ctx: StepCtx, review: SiteReview, factsHash?: string) {
  let report: Record<string, unknown> = {};
  try { report = JSON.parse(ctx.site.qa_json || "{}"); } catch {}
  const value = JSON.stringify({ ...report, review, ...(factsHash ? { reviewFactsHash: factsHash } : {}) });
  ctx.save("qa_json", value);
  ctx.site.qa_json = value;
}

/** 生产入口：每轮都重新抓全站；任何缺浏览器、缺视觉模型或缺截图都会抛错，绝不伪装成通过。 */
export async function runFullSiteReview(
  ctx: StepCtx,
  input: { loginUrl: string | (() => Promise<string>); outDir?: string; vision?: VisionComplete; maxRounds?: number },
): Promise<SiteReview> {
  const failure = (message: string): SiteReview => {
    const old = previousReview(ctx);
    const issue: ReviewIssue = {
      id: issueId("config", `https://${ctx.domain}/`, "full-review-incomplete"), level: "P1", kind: "config", page: "Full-site review",
      url: `https://${ctx.domain}/`, evidence: message, why: "The required text and visual review did not complete, so the site cannot be treated as reviewed.",
      fix: "Restore the browser and review/vision model, then rerun QA.", status: "open",
    };
    const issues = [...(old?.issues.filter((x) => x.id !== issue.id) ?? []), issue];
    const review = { at: ctx.d.now(), rounds: old?.rounds ?? 0, passed: false, issues } satisfies SiteReview;
    persistReview(ctx, review);
    return review;
  };
  if (!input.vision) return failure("The vision role is not configured.");
  const tools = new Map(siteTools(ctx).map((x) => [x.name, x]));
  try {
    return await runReviewLoop({
      now: ctx.d.now,
      previous: previousReview(ctx),
      previousFactsHash: previousFactsHash(ctx),
      maxRounds: input.maxRounds,
      collect: async () => collectReviewSnapshot(ctx, typeof input.loginUrl === "string" ? input.loginUrl : await input.loginUrl(), input.outDir ?? join(ctx.d.workDir, "qa", ctx.domain, "review")),
      inspect: (snapshot) => inspectSnapshot(ctx, snapshot, input.vision!),
      apply: async (finding) => {
        const action = finding.action;
        if (!action) return false;
        const tool = tools.get(action.tool);
        if (!tool || tool.risk !== "L1") return false;
        const result = await tool.run(action.params);
        return result.ok === true && result.change_id !== null;
      },
      persist: (review, factsHash) => persistReview(ctx, review, factsHash),
    });
  } catch (e) {
    return failure(e instanceof Error ? e.message : String(e));
  }
}
