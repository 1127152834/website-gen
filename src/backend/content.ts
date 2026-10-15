// 站点文案与政策：AI 只按给定事实写，代码负责事实核对和禁用说法拦截，最后拼成区块标记写进页面。
import { range, RULES } from "../shared/rules.ts";
import type { EntityForm } from "../shared/forms.ts";

export interface Facts {
  brand: string;
  domain: string;
  email: string;
  categories: string[];
  entity: EntityForm;
  /** 隐私政策只能描述实际启用的功能；未提供时按当前建站基线处理。 */
  features?: { analytics?: boolean; advertising?: boolean; newsletter?: boolean; orderAttribution?: boolean };
}

export interface SiteCopy {
  tagline: string;
  style: Style;
  hero: { heading: string; subheading: string };
  about: string[];
  faq: { q: string; a: string }[];
}

export interface Policies {
  shipping: string;
  returns: string;
  privacy: string;
  terms: string;
}

/** Obel 自带的风格变体（主题 styles/ 目录），AI 只能从中选 */
export const STYLES = ["default", "editorial", "dark"] as const;
export type Style = (typeof STYLES)[number];

// ---- 提示词 ----

const factLines = (f: Facts) => [
  `Store: ${f.brand} (${f.domain}), an online store selling ${f.categories.join(", ")} to customers in the United States.`,
  `Operated by: ${f.entity.name} (${f.entity.kind === "company" ? "a company" : "an individual seller"}), ${f.entity.address}.`,
  `Customer support: email ${f.email}, phone ${f.entity.phone}. No business hours are given, so never state hours.`,
  `Order processing: ${range(f.entity.processingDays)} business days. Transit: ${range(f.entity.transitDays)} business days after shipping.`,
  `Shipping area: ${RULES.region} only. No international shipping.`,
  `Shipping cost: free on orders of $${RULES.freeShippingOver} or more; otherwise a flat rate of $${RULES.flatRate}.`,
  `Returns: accepted within ${RULES.returnDays} days of delivery. The customer pays return shipping unless the item arrived damaged, defective or wrong, in which case we pay. Return address: ${f.entity.address}.`,
  `Refunds: issued to the original payment method within ${range(RULES.refundDays)} business days after we receive the return. No exchanges.`,
  'Payments: "Available payment methods are shown at checkout." No payment gateway is promised until it is actually connected.',
  `Platform: WordPress with WooCommerce, hosted by Hostinger. Order attribution is ${f.features?.orderAttribution ? "enabled" : "disabled"}. Analytics: ${f.features?.analytics ? "enabled" : "disabled"}. Advertising pixels: ${f.features?.advertising ? "enabled" : "disabled"}. Newsletter: ${f.features?.newsletter ? "enabled" : "disabled"}.`,
  "We do not sell or share personal information.",
].map((l) => `- ${l}`).join("\n");

const RULES_FOR_WRITING = `Writing rules:
- American English, plain and friendly. Use only the facts above.
- Never invent founders, founding years, team size, awards, press mentions, certifications, product origin, warehouses or business hours.
- No reviews or testimonials. No health, safety, medical or environmental claims. No "best", "#1" or superlatives you cannot prove.
- Never mention suppliers, dropshipping, marketplaces or where products are sourced.`;

export function copyPrompt(f: Facts): string {
  return `You write the website copy for a new US online store.
FACTS:
${factLines(f)}

${RULES_FOR_WRITING}

Reply with JSON only:
{"tagline": string (max 60 chars),
 "style": one of ${JSON.stringify(STYLES)} (the visual style that fits these products best),
 "hero": {"heading": string (max 60 chars), "subheading": string (max 160 chars)},
 "about": string[] (2-4 short paragraphs for the About page: what the store sells and how it serves customers; mention who operates it),
 "faq": [{"q": string, "a": string}] (exactly 8, about ordering, shipping, returns, refunds, payment and contact; answers must match the facts exactly)}`;
}

export function policyPrompt(f: Facts): string {
  return `You write the legal and policy pages for a new US online store.
FACTS:
${factLines(f)}

${RULES_FOR_WRITING}
- Write the exact numbers from the facts (for example "${range(f.entity.processingDays)} business days", "$${RULES.freeShippingOver}"). Do not add any other day counts or dollar amounts.
- Use simple HTML only: <h2>, <h3>, <p>, <ul>, <li>, <strong>, <a>. No nested lists, no tables, no inline styles.
- Include the support email in each document. Privacy and terms must name the operator (${f.entity.name}).
- The returns document must give the complete procedure: request within ${RULES.returnDays} days after delivery by contacting support; wait for approval/instructions; once approved, send the item back promptly to the stated return address; customer pays return postage except for damaged, defective or wrong items; after we receive and inspect the return, we initiate the refund to the original payment method within ${range(RULES.refundDays)} business days of receiving it. Say that the customer's bank may need additional time to post the credit, but do not promise a bank-processing day count.
- The shipping document must explain: if shipment will be delayed, we notify the customer with a revised date and ask them to accept the delay or cancel for a full refund; cancellation requests are accepted before shipment; for a parcel that appears lost, contact support so tracking can be checked and a carrier investigation opened, then we communicate and resolve the result. Do not invent fixed response or investigation times.
- State exactly "Available payment methods are shown at checkout." Do not name Stripe, PayPal, cards, wallets, or any other gateway.
- The privacy document must match the enabled/disabled features in FACTS. Do not describe order-attribution cookies when order attribution is disabled.

Write four documents in this exact format, nothing else:
=== SHIPPING ===
(shipping policy HTML)
=== RETURNS ===
(returns and refunds policy HTML)
=== PRIVACY ===
(privacy policy HTML: what we collect, why, who we share it with (payment processors, hosting), cookies, rights of California residents, contact)
=== TERMS ===
(terms of service HTML)`;
}

export function productPrompt(f: Facts, p: { name: string; category: string; materials: string[]; description: string; options: string[] }): string {
  return `You write product listings for ${f.brand}, a US online store selling ${f.categories.join(", ")}. Rewrite the product below.
${RULES_FOR_WRITING}
- Only use facts present in INPUT. If INPUT says nothing about a property, leave it out.
Reply with JSON only:
{"title": string (max 70 chars, no brand names), "short_description": string (1-2 sentences),
 "description_html": string (<p>, <ul>, <li> only), "image_alt": string (describes the product photo, max 100 chars)}
INPUT: ${JSON.stringify(p)}`;
}

/** 选品筛查：只保留和类目相符、可以合规销售的商品。 */
export function screenPrompt(categories: string[], items: { pid: string; name: string }[]): string {
  return `You pick products for a US online store selling: ${categories.join(", ")}.
Keep a product only if it clearly belongs to one of those categories AND it is none of these: battery-powered or rechargeable devices, liquids, gels, cosmetics, food, supplements, medicine or medical devices, items for babies or children under 12, toys, weapons, adult products, counterfeit or branded/licensed goods (brand names, characters, sports teams).
Reply with JSON only: {"keep": string[]} listing the pid of every product to keep.
PRODUCTS: ${JSON.stringify(items)}`;
}

// ---- 解析 ----

export function parseJsonReply(text: string): unknown {
  const t = text.replace(/^```(?:json)?\s*|```\s*$/gm, "").trim();
  return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
}

export function parsePolicies(text: string): Policies {
  const part = (name: string) => {
    const m = new RegExp(`===\\s*${name}\\s*===([\\s\\S]*?)(?====\\s*[A-Z]+\\s*===|$)`).exec(text);
    return (m?.[1] ?? "").replace(/^```(?:html)?\s*|```\s*$/gm, "").trim();
  };
  return { shipping: part("SHIPPING"), returns: part("RETURNS"), privacy: part("PRIVACY"), terms: part("TERMS") };
}

// ---- 检查：返回给 AI 看的英文问题列表，空数组表示通过 ----

const FORBIDDEN: [RegExp, string][] = [
  [/\bFDA\b/i, "FDA claims"],
  [/clinically|doctor[- ]recommended|vet(erinarian)?[- ](recommended|approved)/i, "medical or professional endorsements"],
  [/made in (the )?(usa|u\.s\.a?\.?|america)/i, '"Made in USA"'],
  [/\bawards?\b|award-winning|as seen (on|in)\b/i, "awards or press mentions"],
  [/#1\b|number one|best[- ]sell(ing|er)/i, '"#1" or "best-selling"'],
  [/\b(since|founded|established)\s+(in\s+)?(19|20)\d\d\b/i, "founding years"],
  [/\d+\+?\s+years? of experience/i, "years of experience"],
  [/\bcertifi(ed|cation)\b/i, "certifications"],
  [/\b(cj ?dropshipping|dropship\w*|aliexpress|alibaba|1688|temu)\b/i, "suppliers or dropshipping"],
  [/testimonial|customers love|★/i, "reviews or testimonials"],
  [/non[- ]?toxic|eco[- ]friendly|hypoallergenic|anti[- ]?bacterial|\borganic\b|biodegradable/i, "unproven health or environmental claims"],
];

export function claimProblems(text: string): string[] {
  const plain = stripTags(text);
  return FORBIDDEN.filter(([re]) => re.test(plain)).map(([re, what]) => `remove ${what} ("${re.exec(plain)![0]}")`);
}

const unofferedShippingProblems = (text: string, where: string) => {
  const match = /\b(?:express|expedited|overnight|same[- ]day|next[- ]day)\s+(?:shipping|delivery)\b|\b(?:shipping|delivery)\s+(?:by\s+)?(?:express|expedited|overnight|same[- ]day|next[- ]day)\b/i.exec(stripTags(text));
  return match ? [`${where}: remove unoffered shipping service ("${match[0]}")`] : [];
};

/** 去标签并解开实体（WordPress 输出时会把 1-3 排版成 1&#8211;3） */
const stripTags = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n))).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** 数字区间统一写法：1–3 / 1 - 3 / 1 to 3 → 1-3；30-day → 30 day */
const norm = (html: string) => stripTags(html).toLowerCase().replace(/(\d)\s*(?:[–—-]|to)\s*(\d)/g, "$1-$2").replace(/(\d)-(?=days?\b)/g, "$1 ");
const span = ([a, b]: [number, number]) => (a === b ? `${a}` : `${a}-${b}`);

/** 承诺类文字里出现的天数和金额，必须是事实里有的数字（防止 AI 自己编出「2 天发货」「$5 运费」）。 */
function numberProblems(html: string, f: Facts, where: string): string[] {
  const p = f.entity.processingDays, t = f.entity.transitDays;
  const days = new Set([...p, ...t, p[0] + t[0], p[1] + t[1], RULES.returnDays, ...RULES.refundDays].map(String));
  const money = new Set([RULES.freeShippingOver, RULES.flatRate].map((n) => n.toFixed(2)));
  const text = norm(html);
  const out: string[] = [];
  for (const m of text.matchAll(/(\d+)(?:-(\d+))?[\s-]*(?:business |calendar |working )?days?\b/g)) {
    const bad = [m[1], m[2]].filter((n) => n && !days.has(n));
    if (bad.length) out.push(`${where}: "${m[0]}" is not in the facts`);
  }
  for (const m of text.matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)) {
    if (!money.has(Number(m[1]).toFixed(2))) out.push(`${where}: "$${m[1]}" is not in the facts`);
  }
  return out;
}

export function checkCopy(c: SiteCopy, f: Facts): string[] {
  const out: string[] = [];
  if (!c.tagline || c.tagline.length > 80) out.push("tagline is missing or too long");
  if (!STYLES.includes(c.style)) out.push(`style must be one of ${STYLES.join(", ")}`);
  if (!c.hero?.heading || !c.hero?.subheading) out.push("hero heading and subheading are required");
  if (!Array.isArray(c.about) || c.about.length < 2) out.push("about needs 2-4 paragraphs");
  if (!Array.isArray(c.faq) || c.faq.length < 6 || c.faq.some((x) => !x.q || !x.a)) out.push("faq needs 8 questions with answers");
  if (out.length) return out;
  const all = [c.tagline, c.hero.heading, c.hero.subheading, ...c.about, ...c.faq.flatMap((x) => [x.q, x.a])].join("\n");
  const payment = c.faq.map((x) => x.a).join("\n");
  if (!payment.includes("Available payment methods are shown at checkout.")) out.push("faq must use the exact checkout payment wording");
  if (/stripe|paypal|visa|mastercard|american express|apple pay|google pay/i.test(payment)) out.push("faq must not promise a payment gateway");
  return [...out, ...claimProblems(all), ...unofferedShippingProblems(all, "site copy"), ...numberProblems(payment, f, "faq")];
}

export function checkPolicies(p: Policies, f: Facts): string[] {
  const out: string[] = [];
  const need = (where: keyof Policies, label: string, ...needles: string[]) => {
    const text = norm(p[where]);
    for (const n of needles) if (!text.includes(n.toLowerCase())) out.push(`${where} policy must state ${label} ("${n}")`);
  };
  for (const k of ["shipping", "returns", "privacy", "terms"] as const) if (stripTags(p[k]).trim().length < 200) out.push(`${k} policy is missing or too short`);
  if (out.length) return out;
  need("shipping", "the processing time", `${span(f.entity.processingDays)} business day`);
  need("shipping", "the transit time", `${span(f.entity.transitDays)} business day`);
  need("shipping", "the free shipping threshold and flat rate", `$${RULES.freeShippingOver}`, `$${RULES.flatRate}`);
  need("shipping", "the support email", f.email);
  need("returns", "the return window", `${RULES.returnDays} day`);
  need("returns", "the refund time", `${span(RULES.refundDays)} business day`);
  need("returns", "the support email", f.email);
  const shipping = norm(p.shipping), returns = norm(p.returns);
  const requirePattern = (where: string, text: string, label: string, pattern: RegExp) => { if (!pattern.test(text)) out.push(`${where} policy must explain ${label}`); };
  requirePattern("returns", returns, "how to request a return", /\b(request|contact)\b[\s\S]*\breturn\b|\breturn\b[\s\S]*\b(request|contact)\b/);
  // 只看「30 天从签收起算」这一事实，不限定词序（怎么申请由上一条检查）
  requirePattern("returns", returns, `a return request within ${RULES.returnDays} days after delivery`, new RegExp(`\\bwithin\\s+${RULES.returnDays} days?\\s+(?:after|of|from)\\s+(?:the\\s+)?(?:date\\s+of\\s+)?(?:delivery|receiving|receipt)\\b`));
  requirePattern("returns", returns, "approval or instructions before sending", /\b(approval|approved|authorization|instructions)\b/);
  requirePattern("returns", returns, "sending the item back", /\b(send|ship|mail)\b[\s\S]*\b(back|return)/);
  requirePattern("returns", returns, "inspection after receipt", /\binspect(?:ion|ed|ing)?\b/);
  requirePattern("returns", returns, "refund initiation to the original payment method", /\b(initiat\w*|issu\w*)\b[\s\S]*\boriginal payment method\b/);
  const refundWindow = span(RULES.refundDays).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  requirePattern("returns", returns, `our ${span(RULES.refundDays)} business-day refund initiation measured from receiving the return`, new RegExp(`\\b(initiat\\w*|issu\\w*)\\b[\\s\\S]{0,120}\\bwithin\\s+${refundWindow} business days?\\b[\\s\\S]{0,100}\\b(receiv\\w*|receipt)\\b`));
  requirePattern("returns", returns, "variable additional bank posting time without a promised count", /\bbank\b[\s\S]{0,100}\b(additional|vary|varies|variable)\b[\s\S]{0,80}\b(time|timing|days?)\b/);
  requirePattern("returns", returns, "who pays return shipping and damaged/defective/wrong exceptions", /\b(customers?|you|buyers?)\b[^.]{0,60}\breturn shipping\b[\s\S]*\b(damaged|defective|wrong)\b/);
  requirePattern("shipping", shipping, "delay notice and revised date", /\b(delay\w*|late)\b[\s\S]*\b(notif\w*|email|contact)\b[\s\S]*\b(revised|new|updated)\b[\s\S]*\bdate\b/);
  requirePattern("shipping", shipping, "accepting a delay or cancelling for a full refund", /\b(accept|consent|agree)\w*\b[\s\S]*\b(cancel)\w*\b[\s\S]*\b(full )?refund\b/);
  requirePattern("shipping", shipping, "cancellation before shipment", /\bcancel\w*\b[\s\S]*\bbefore\b[\s\S]*\b(ship|dispatch)/);
  requirePattern("shipping", shipping, "lost parcel tracking and carrier investigation", /\b(lost|missing)\b[\s\S]*\btrack\w*\b[\s\S]*\b(carrier|shipping provider)\b[\s\S]*\binvestigat\w*\b/);
  requirePattern("shipping", shipping, "lost parcel resolution", /\b(lost|missing)\b[\s\S]*\b(resolve|resolution|outcome|refund|replacement)\b/);
  need("privacy", "the operator and email", f.entity.name, f.email);
  need("terms", "the operator and email", f.entity.name, f.email);
  const all = Object.values(p).join("\n");
  if (!all.includes("Available payment methods are shown at checkout.")) out.push("policies must use the exact checkout payment wording");
  if (/stripe|paypal|visa|mastercard|american express|apple pay|google pay/i.test(all)) out.push("policies must not promise a payment gateway");
  // 写明「已关闭、不使用」是对的；只拒绝把订单归因写成在用
  const describesAttribution = stripTags(p.privacy).split(/(?<=[.!?])\s+/).some((x) => /order[- ]attribution|sourcebuster|sbjs_/i.test(x) && !/\b(disabled|not|never|no)\b|n't\b/i.test(x));
  if (!f.features?.orderAttribution && describesAttribution) out.push("privacy must not describe disabled order attribution");
  return [
    ...out,
    ...claimProblems(Object.values(p).join("\n")),
    ...unofferedShippingProblems(Object.values(p).join("\n"), "policies"),
    ...numberProblems(p.shipping, f, "shipping"),
    ...numberProblems(p.returns, f, "returns"),
  ];
}

export function checkProductCopy(c: { title?: string; short_description?: string; description_html?: string; image_alt?: string }): string[] {
  if (!c.title || !c.short_description || !c.description_html || !c.image_alt) return ["title, short_description, description_html and image_alt are all required"];
  const out = c.title.length > 80 ? ["title is too long"] : [];
  return [...out, ...claimProblems([c.title, c.short_description, c.description_html, c.image_alt].join("\n"))];
}

// ---- 区块标记 ----

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 只留 strong/em/a/br；a 只留 href。WordPress 保存时还会再按 kses 过滤一遍。 */
const inline = (html: string) =>
  html.replace(/<(?!\/?(strong|em|a|br)\b)[^>]*>/gi, "")
    .replace(/<a\b[^>]*?href="([^"]*)"[^>]*>/gi, (_m, href: string) => (/^(https?:|mailto:|tel:|\/)/i.test(href) ? `<a href="${href}">` : "<a>"))
    .trim();

/** 商品描述等经典 HTML：只留段落、列表和强调，去掉所有属性。 */
export const cleanHtml = (html: string) =>
  html.replace(/<(?!\/?(p|ul|ol|li|strong|em|br)\b)[^>]*>/gi, "").replace(/<(\/?)(p|ul|ol|li|strong|em|br)\b[^>]*>/gi, "<$1$2>").trim();

const p = (html: string) => `<!-- wp:paragraph -->\n<p>${html}</p>\n<!-- /wp:paragraph -->`;
const h = (level: number, html: string) =>
  `<!-- wp:heading${level === 2 ? "" : ` {"level":${level}}`} -->\n<h${level} class="wp-block-heading">${html}</h${level}>\n<!-- /wp:heading -->`;

/** AI 写的简单 HTML → 核心区块（标题、段落、列表），这样以后在编辑器里和让 pi 修改都是正常区块。 */
export function htmlToBlocks(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(/<(h[1-4]|p|ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    if (tag === "ul" || tag === "ol") {
      const items = [...m[2].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((li) => `<!-- wp:list-item -->\n<li>${inline(li[1])}</li>\n<!-- /wp:list-item -->`);
      const attrs = tag === "ol" ? ' {"ordered":true}' : "";
      out.push(`<!-- wp:list${attrs} -->\n<${tag} class="wp-block-list">${items.join("\n")}</${tag}>\n<!-- /wp:list -->`);
    } else if (tag === "p") out.push(p(inline(m[2])));
    else out.push(h(Math.max(2, Number(tag[1])), inline(m[2])));
  }
  return out.join("\n\n");
}

// ---- 页面 ----

export interface PageDef {
  slug: string;
  title: string;
  content: string;
}

export const PAGE_SLUGS = ["home", "about", "contact", "faq", "shipping", "returns", "privacy-policy", "terms"] as const;

export function buildPages(c: SiteCopy, pol: Policies, f: Facts): PageDef[] {
  const mail = `<a href="mailto:${esc(f.email)}">${esc(f.email)}</a>`;
  const tel = `<a href="tel:${esc(f.entity.phone.replace(/[^\d+]/g, ""))}">${esc(f.entity.phone)}</a>`;
  const operator = `${esc(f.brand)} is operated by ${esc(f.entity.name)}, ${esc(f.entity.address)}.`;
  const valueProps = [
    [`Free shipping over $${RULES.freeShippingOver}`, `Orders of $${RULES.freeShippingOver} or more ship free within the contiguous US.`],
    [`${RULES.returnDays}-day returns`, `Return eligible items within ${RULES.returnDays} days of delivery.`],
    ["Here to help", `Questions about an order? Email ${esc(f.email)}.`],
  ];
  const home = [
    `<!-- wp:group {"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|3-xl","bottom":"var:preset|spacing|3-xl"},"blockGap":"var:preset|spacing|lg"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--3-xl);padding-bottom:var(--wp--preset--spacing--3-xl)">
<!-- wp:heading {"textAlign":"center","level":1,"fontSize":"4-xl"} -->
<h1 class="wp-block-heading has-text-align-center has-4-xl-font-size">${esc(c.hero.heading)}</h1>
<!-- /wp:heading -->
<!-- wp:paragraph {"align":"center","fontSize":"lg"} -->
<p class="has-text-align-center has-lg-font-size">${esc(c.hero.subheading)}</p>
<!-- /wp:paragraph -->
<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/shop/">Shop now</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons -->
</div>
<!-- /wp:group -->`,
    `<!-- wp:group {"align":"wide","layout":{"type":"default"}} -->
<div class="wp-block-group alignwide">
${h(2, "Featured products")}
<!-- wp:woocommerce/product-collection {"queryId":1,"query":{"perPage":8,"pages":0,"offset":0,"postType":"product","order":"desc","orderBy":"date","search":"","exclude":[],"inherit":false,"taxQuery":{},"isProductCollectionBlock":true,"featured":true,"woocommerceOnSale":false,"woocommerceStockStatus":["instock","outofstock","onbackorder"],"woocommerceAttributes":[],"woocommerceHandPickedProducts":[]},"displayLayout":{"type":"flex","columns":4,"shrinkColumns":true},"collection":"woocommerce/product-collection/featured","align":"wide"} -->
<div class="wp-block-woocommerce-product-collection alignwide"><!-- wp:woocommerce/product-template -->
<!-- wp:woocommerce/product-image {"isDescendentOfQueryLoop":true} /-->
<!-- wp:post-title {"level":3,"isLink":true,"fontSize":"base"} /-->
<!-- wp:woocommerce/product-price {"isDescendentOfQueryLoop":true} /-->
<!-- /wp:woocommerce/product-template --></div>
<!-- /wp:woocommerce/product-collection -->
${p('<a href="/shop/">View all products</a>')}
</div>
<!-- /wp:group -->`,
    `<!-- wp:columns {"align":"wide"} -->
<div class="wp-block-columns alignwide">${valueProps.map(([t, d]) => `<!-- wp:column -->
<div class="wp-block-column">${h(3, esc(t))}
${p(d)}</div>
<!-- /wp:column -->`).join("\n")}</div>
<!-- /wp:columns -->`,
    `${h(2, `About ${esc(f.brand)}`)}\n${p(esc(c.about[0]))}\n${p('<a href="/about/">More about us</a>')}`,
  ].join("\n\n");

  const faq = c.faq.map((x) => `<!-- wp:details -->
<details class="wp-block-details"><summary>${esc(x.q)}</summary>${p(esc(x.a))}</details>
<!-- /wp:details -->`).join("\n\n");

  return [
    { slug: "home", title: "Home", content: home },
    { slug: "about", title: "About us", content: [...c.about.map((t) => p(esc(t))), p(operator)].join("\n\n") },
    {
      slug: "contact", title: "Contact us",
      content: [
        p(`Questions about an order, shipping or returns? Email us at ${mail} or call ${tel}.`),
        h(2, "Business address"),
        p(`${esc(f.entity.name)}<br>${esc(f.entity.address)}`),
        p('Before contacting us, you may find your answer in our <a href="/faq/">FAQ</a>, <a href="/shipping/">shipping policy</a> or <a href="/returns/">returns policy</a>.'),
      ].join("\n\n"),
    },
    { slug: "faq", title: "Frequently asked questions", content: faq },
    { slug: "shipping", title: "Shipping policy", content: htmlToBlocks(pol.shipping) },
    { slug: "returns", title: "Returns & refunds", content: htmlToBlocks(pol.returns) },
    { slug: "privacy-policy", title: "Privacy policy", content: htmlToBlocks(pol.privacy) },
    { slug: "terms", title: "Terms of service", content: htmlToBlocks(pol.terms) },
  ];
}
