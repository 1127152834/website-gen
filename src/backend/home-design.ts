// 分类、首页和元数据均基于已经上架的真实商品生成，避免模板占位或空分类。
import { claimProblems, esc } from "./content.ts";

export interface DesignProduct { id: number; name: string; permalink: string; image: string; sourceCategory: string; facts: string }
export interface CategoryDesign { name: string; slug: string; description: string; productIds: number[] }
export interface HomepageDesign { heading: string; subheading: string; heroProductId: number; categorySlugs: string[]; featuredProductIds: number[] }
export interface PageMetadata { key: string; description: string; ogDescription: string }

export function categoryDesignPrompt(products: DesignProduct[]): string {
  return `Group these real products by buyer use (for example commuting, travel, fitness, organization), not by a supplier taxonomy. Every category must have products and every product must be assigned. Do not invent product capabilities. Reply JSON only: {"categories":[{"name":string,"slug":string,"description":string,"productIds":number[]}]}. PRODUCTS: ${JSON.stringify(products)}`;
}
export function homepageDesignPrompt(products: DesignProduct[], categories: CategoryDesign[]): string {
  return `Design a compact ecommerce homepage using only these real products and categories. On mobile a real product image and product link must appear before long marketing copy. No testimonials, history, discounts or unsupported claims. Reply JSON only: {"heading":string,"subheading":string,"heroProductId":number,"categorySlugs":string[],"featuredProductIds":number[]}. DATA: ${JSON.stringify({ products, categories })}`;
}
export function metadataPrompt(pages: { key: string; title: string; facts: string }[]): string {
  // 商品的 CJ 原始资料可能很长：提示词里只给前 2000 字，校验仍对照完整资料
  const bounded = pages.map((p) => ({ ...p, facts: p.facts.slice(0, 2000) }));
  return `Write a unique factual search description and a separate social sharing description for every page. description: at most 150 characters. ogDescription: at most 190 characters. No unsupported claims or repeated boilerplate. Reply JSON only: {"metadata":[{"key":string,"description":string,"ogDescription":string}]}. PAGES: ${JSON.stringify(bounded)}`;
}
export function parseCategoryDesign(text: string): CategoryDesign[] { return json(text).categories as CategoryDesign[]; }
export function parseHomepageDesign(text: string): HomepageDesign { return json(text) as unknown as HomepageDesign; }
export function parsePageMetadata(text: string): PageMetadata[] { return json(text).metadata as PageMetadata[]; }
const json = (text: string) => { const t = text.replace(/^```(?:json)?\s*|```\s*$/gm, "").trim(); return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)) as Record<string, any>; };
const slugOk = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
const GROUNDED_CLAIMS = [
  /\b(?:sale|discount|save)\b|\b\d+%\s*off\b/i,
  /\b(?:waterproof|water[- ]resistant|scratch[- ]resistant|fire[- ]resistant|durable|heavy[- ]duty|lightweight|ergonomic)\b/i,
  /\b(?:leather|nylon|polyester|cotton|canvas|wool|silk|steel|aluminum|bamboo|ceramic)\b/i,
  /\b(?:machine washable|wipe clean|dishwasher safe|dry clean)\b/i,
];
const groundedClaimProblems = (text: string, facts: string) => GROUNDED_CLAIMS.flatMap((pattern) => {
  const claim = pattern.exec(text)?.[0];
  return claim && !pattern.test(facts) ? [`claim "${claim}" is not supported by source facts`] : [];
});

export function checkCategoryDesign(categories: CategoryDesign[], products: DesignProduct[]): string[] {
  if (!Array.isArray(categories) || categories.length === 0) return ["at least one category is required"];
  const valid = new Set(products.map((p) => p.id)), assigned = new Set<number>(), slugs = new Set<string>();
  const out: string[] = [];
  for (const c of categories) {
    if (!c.name?.trim() || !slugOk(c.slug) || !c.description?.trim()) out.push("each category needs a name, kebab-case slug and description");
    if (slugs.has(c.slug)) out.push(`duplicate category slug ${c.slug}`); slugs.add(c.slug);
    if (!Array.isArray(c.productIds) || c.productIds.length === 0) out.push(`${c.slug}: category is empty`);
    for (const id of c.productIds ?? []) { if (!valid.has(id)) out.push(`${c.slug}: unknown product ${id}`); assigned.add(id); }
    out.push(...claimProblems(`${c.name} ${c.description}`).map((problem) => `${c.slug}: ${problem}`));
    const facts = products.filter((p) => c.productIds?.includes(p.id)).map((p) => p.facts).join("\n");
    out.push(...groundedClaimProblems(`${c.name} ${c.description}`, facts).map((problem) => `${c.slug}: ${problem}`));
  }
  for (const id of valid) if (!assigned.has(id)) out.push(`product ${id} is not assigned to a use category`);
  return out;
}

export function checkHomepageDesign(home: HomepageDesign, products: DesignProduct[], categories: CategoryDesign[]): string[] {
  const ids = new Set(products.map((p) => p.id)), slugs = new Set(categories.map((c) => c.slug));
  const out: string[] = [];
  if (!home.heading?.trim() || !home.subheading?.trim()) out.push("homepage heading and subheading are required");
  if (!ids.has(home.heroProductId)) out.push("heroProductId must be a real product");
  if (!Array.isArray(home.featuredProductIds) || home.featuredProductIds.length === 0 || home.featuredProductIds.some((id) => !ids.has(id))) out.push("featuredProductIds must contain real products");
  if (!Array.isArray(home.categorySlugs) || home.categorySlugs.length === 0 || home.categorySlugs.some((s) => !slugs.has(s))) out.push("categorySlugs must contain real categories");
  out.push(...claimProblems(`${home.heading} ${home.subheading}`));
  const referenced = new Set([home.heroProductId, ...(home.featuredProductIds ?? []), ...categories.filter((c) => home.categorySlugs?.includes(c.slug)).flatMap((c) => c.productIds)]);
  out.push(...groundedClaimProblems(`${home.heading} ${home.subheading}`, products.filter((p) => referenced.has(p.id)).map((p) => p.facts).join("\n")));
  return out;
}

export function checkPageMetadata(metadata: PageMetadata[], keys: string[], pages: { key: string; facts: string }[] = []): string[] {
  const out: string[] = [], seen = new Set<string>(), descriptions = new Set<string>();
  for (const m of metadata ?? []) {
    if (!keys.includes(m.key)) out.push(`unknown metadata key ${m.key}`); seen.add(m.key);
    if (!m.description || m.description.length > 160) out.push(`${m.key}: description is missing or too long`);
    if (!m.ogDescription || m.ogDescription.length > 200) out.push(`${m.key}: ogDescription is missing or too long`);
    if (descriptions.has(m.description)) out.push(`${m.key}: description must be unique`); descriptions.add(m.description);
    out.push(...claimProblems(`${m.description} ${m.ogDescription}`).map((problem) => `${m.key}: ${problem}`));
    const facts = pages.find((p) => p.key === m.key)?.facts;
    if (facts != null) out.push(...groundedClaimProblems(`${m.description} ${m.ogDescription}`, facts).map((problem) => `${m.key}: ${problem}`));
  }
  for (const key of keys) if (!seen.has(key)) out.push(`missing metadata for ${key}`);
  return out;
}

export function buildAiHomepage(home: HomepageDesign, products: DesignProduct[], categories: CategoryDesign[]): string {
  const byId = new Map(products.map((p) => [p.id, p])), hero = byId.get(home.heroProductId)!;
  const categoryCards = home.categorySlugs.map((slug) => categories.find((c) => c.slug === slug)!).filter(Boolean).map((c) => {
    const product = byId.get(c.productIds[0])!;
    return `<!-- wp:column --><div class="wp-block-column"><!-- wp:image {"linkDestination":"custom"} --><figure class="wp-block-image"><a href="/product-category/${esc(c.slug)}/"><img src="${esc(product.image)}" alt="${esc(product.name)}"></a></figure><!-- /wp:image --><!-- wp:heading {"level":3} --><h3 class="wp-block-heading"><a href="/product-category/${esc(c.slug)}/">${esc(c.name)}</a></h3><!-- /wp:heading --><!-- wp:paragraph --><p>${esc(c.description)}</p><!-- /wp:paragraph --></div><!-- /wp:column -->`;
  }).join("");
  const featured = home.featuredProductIds.map((id) => byId.get(id)).filter((p): p is DesignProduct => Boolean(p)).map((p) => `<!-- wp:column --><div class="wp-block-column"><!-- wp:image {"linkDestination":"custom"} --><figure class="wp-block-image"><a href="${esc(p.permalink)}"><img src="${esc(p.image)}" alt="${esc(p.name)}"></a></figure><!-- /wp:image --><!-- wp:paragraph --><p><strong><a href="${esc(p.permalink)}">${esc(p.name)}</a></strong></p><!-- /wp:paragraph --></div><!-- /wp:column -->`).join("");
  return `<!-- wp:group {"className":"wg-mobile-first-product","layout":{"type":"constrained"}} --><div class="wp-block-group wg-mobile-first-product"><!-- wp:image {"linkDestination":"custom"} --><figure class="wp-block-image"><a href="${esc(hero.permalink)}"><img src="${esc(hero.image)}" alt="${esc(hero.name)}"></a></figure><!-- /wp:image --><!-- wp:paragraph --><p><a href="${esc(hero.permalink)}">Shop ${esc(hero.name)}</a></p><!-- /wp:paragraph --></div><!-- /wp:group -->
<!-- wp:group {"className":"wg-home-intro","layout":{"type":"constrained"}} --><div class="wp-block-group wg-home-intro"><!-- wp:heading {"level":1} --><h1 class="wp-block-heading">${esc(home.heading)}</h1><!-- /wp:heading --><!-- wp:paragraph --><p>${esc(home.subheading)}</p><!-- /wp:paragraph --><!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/shop/">Shop all products</a></div><!-- /wp:button --></div><!-- /wp:buttons --></div><!-- /wp:group -->
<!-- wp:columns {"className":"wg-category-grid"} --><div class="wp-block-columns wg-category-grid">${categoryCards}</div><!-- /wp:columns -->
<!-- wp:columns {"className":"wg-product-grid"} --><div class="wp-block-columns wg-product-grid">${featured}</div><!-- /wp:columns -->`;
}
