// 商品内容的 AI 合同：模型负责从 CJ 原始资料中整理，代码负责逐项追溯、剔除不清楚的规格和可疑尺寸。
import type { Facts } from "./content.ts";
import { claimProblems, cleanHtml } from "./content.ts";
import { splitVariants, type CjProduct, type CjVariant } from "./cj.ts";

export interface ProductVariantInput extends CjVariant {
  attrs: Record<string, string>;
  sourceAttrs?: Record<string, string>;
}

export interface AnalyzedVariant {
  sourceKey: string;
  buyerName: string;
  clear: boolean;
  pieceCount: number | null;
  components: string[];
  color: string | null;
  evidence: string;
}

export interface ProductAnalysis {
  title: string;
  short_description: string;
  description_html: string;
  materials_and_care_html: string | null;
  image_alt: string;
  mainImage: string;
  metaDescription: string;
  ogDescription: string;
  variants: AnalyzedVariant[];
}

export interface UnitReview {
  questionable: { sourceKey: string; fields: ("length" | "width" | "height")[]; reason: string }[];
}

export interface PublishableVariant extends ProductVariantInput {
  buyerName: string;
  pieceCount: number | null;
  components: string[];
  color: string | null;
  safeDimensions: { length: number; width: number; height: number } | null;
}

export interface WooVariationFacts {
  id: number;
  sku?: string;
  attributes: { name: string; option: string }[];
}

export interface ActualVariationContext {
  inputs: ProductVariantInput[];
  analysis: ProductAnalysis;
  sourceByVariationId: Map<number, ProductVariantInput>;
  problems: string[];
}

const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const supplierCodeName = (value: string) => /^(?:(?:set|style|option|type|model|variant)\s*[-#]?\s*[a-z0-9]+|[a-z]?\d+[a-z]?)$/i.test(value.trim());
const sourceText = (p: CjProduct) => [p.name, p.category, p.description, ...p.materials, ...p.variants.map((v) => v.key)].join("\n");
const sourceHas = (source: string, value: string) => compact(source).includes(compact(value));

export function reconcileActualVariations(product: CjProduct, analysis: ProductAnalysis, variations: WooVariationFacts[], options: { trustSkuOrder?: boolean } = {}): ActualVariationContext {
  const attrs = splitVariants(product.keyNames, product.variants.map((v) => v.key));
  const analyzed = new Map(analysis.variants.map((v) => [v.sourceKey, v]));
  const allRows = product.variants.flatMap((variant, index) => {
    const a = analyzed.get(variant.key);
    return a ? [{ input: { ...variant, attrs: attrs[index] }, analysis: a }] : [];
  });
  const rows = allRows.filter((row) => row.analysis.clear);
  if (variations.length === 0) {
    const inputs = rows.map((x) => x.input);
    return { inputs, analysis: { ...analysis, variants: rows.map((x) => x.analysis) }, sourceByVariationId: new Map(), problems: [] };
  }

  const expectedBaseSku = `WG-${product.pid.slice(-10)}`;
  const sourceByVariationId = new Map<number, ProductVariantInput>();
  const nextVariants: AnalyzedVariant[] = [];
  const inputs: ProductVariantInput[] = [];
  const problems: string[] = [];
  const used = new Set<string>();
  for (const variation of variations) {
    const actual = Object.fromEntries(variation.attributes.map((x) => [x.name, x.option]));
    const option = variation.attributes.length === 1 && compact(variation.attributes[0].name) === "option" ? variation.attributes[0].option : undefined;
    const skuIndex = variation.sku?.startsWith(`${expectedBaseSku}-`) ? Number(variation.sku.slice(expectedBaseSku.length + 1)) - 1 : -1;
    const skuMatches = options.trustSkuOrder !== false && Number.isInteger(skuIndex) && skuIndex >= 0 && skuIndex < rows.length ? [rows[skuIndex]] : [];
    const attrMatches = allRows.filter((row) => variation.attributes.length > 0 && variation.attributes.every(({ name, option: value }) => {
      if (compact(name) === "option") return false;
      const sourceValue = Object.entries(row.input.attrs).find(([key]) => compact(key) === compact(name))?.[1];
      return sourceValue !== undefined && compact(sourceValue) === compact(value);
    }));
    // 恢复出的分析名称不是历史上架顺序证据；恢复模式只接受 CJ 原始规格键或原始 Option 属性的唯一精确值。
    const rawOptionMatches = options.trustSkuOrder === false && option !== undefined ? allRows.filter((row) => {
      const rawOption = Object.entries(row.input.attrs).find(([name]) => compact(name) === "option")?.[1];
      return compact(row.input.key) === compact(option) || rawOption !== undefined && compact(rawOption) === compact(option);
    }) : [];
    const buyerMatches = options.trustSkuOrder === false || option === undefined ? [] : allRows.filter((row) => compact(row.analysis.buyerName) === compact(option));
    if (attrMatches.length > 1 || rawOptionMatches.length > 1 || buyerMatches.length > 1) {
      problems.push(`variation ${variation.id} has an ambiguous CJ source mapping`);
      continue;
    }
    const exactSignals = [skuMatches[0], attrMatches[0], rawOptionMatches[0], buyerMatches[0]].filter((row): row is (typeof rows)[number] => Boolean(row));
    if (new Set(exactSignals.map((row) => row.input.key)).size > 1) {
      problems.push(`variation ${variation.id} has conflicting exact CJ source mappings`);
      continue;
    }
    const matches = exactSignals.length ? [exactSignals[0]] : [];
    if (matches.length !== 1) {
      problems.push(`variation ${variation.id} has ${matches.length ? "an ambiguous" : "no exact"} CJ source mapping`);
      continue;
    }
    const match = matches[0];
    if (!match.analysis.clear) {
      problems.push(`variation ${variation.id} maps to a CJ source variant that was not clear enough to publish`);
      continue;
    }
    if (used.has(match.input.key)) {
      problems.push(`variation ${variation.id} reuses CJ source variant ${match.input.key}`);
      continue;
    }
    used.add(match.input.key);
    const buyerName = variation.attributes.map((x) => x.option.trim()).filter(Boolean).join(" / ");
    if (!buyerName) {
      problems.push(`variation ${variation.id} has no Woo option names`);
      continue;
    }
    const input = { ...match.input, attrs: actual, sourceAttrs: match.input.attrs };
    inputs.push(input);
    nextVariants.push({ ...match.analysis, buyerName });
    sourceByVariationId.set(variation.id, input);
  }
  return { inputs, analysis: { ...analysis, variants: nextVariants }, sourceByVariationId, problems };
}

/** 明显不可能的包类尺寸直接拦截；只删除，不猜测 m 是否本应为 cm。 */
export function deterministicDimensionProblems(product: CjProduct, variant?: ProductVariantInput): string[] {
  const out: string[] = [];
  const bagLike = /\b(bag|backpack|purse|satchel|tote|wallet|packing|organizer|case)\b/i.test(`${product.name} ${product.category}`);
  if (bagLike && variant) {
    for (const field of ["length", "width", "height"] as const) {
      if (!Number.isFinite(variant[field]) || variant[field] < 0) out.push(`${variant.key}: ${field} is not a finite positive measurement`);
      if (variant[field] > 3000) out.push(`${variant.key}: ${field} ${variant[field]} mm exceeds 3 m for a bag-like product`);
    }
  }
  if (bagLike) {
    for (const m of product.description.matchAll(/\b(\d+(?:\.\d+)?)\s*(mm|cm|m|meters?|in(?:ches)?|ft|feet|foot)\b/gi)) {
      const value = Number(m[1]), unit = m[2].toLowerCase();
      const cm = unit === "mm" ? value / 10 : unit === "cm" ? value : unit === "m" || unit.startsWith("meter") ? value * 100 : unit.startsWith("in") ? value * 2.54 : value * 30.48;
      if (cm > 300) out.push(`description contains questionable dimension "${m[0]}"`);
    }
  }
  return out;
}

export function productAnalysisPrompt(f: Facts, product: CjProduct, variants: ProductVariantInput[]): string {
  return `You are preparing one factual WooCommerce product listing for ${f.brand}.
Use only the CJ SOURCE below. Never infer or invent a material, certification, origin, performance claim, discount, care method, included component, capacity, compatibility, or corrected unit.
Analyze every source variant separately. A variant is clear only when the source makes its delivered piece count/components and distinguishing color/style understandable. Mark unclear variants clear=false; do not rescue them by guessing.
When actualWooAttributes are present, use those exact live option names in the copy, but treat only sourceAttributes and the other CJ fields as evidence for factual claims.
Use short buyer-readable variant names. The title and copy must accurately cover every clear variant, including differing piece counts or components. If materials or care instructions are absent, return materials_and_care_html=null. Do not repeat questionable dimensions in any copy.
Choose mainImage only from candidateImages and prefer a clear view of the complete sold product.
The title must be at most 80 characters.
For every variant, evidence must be copied verbatim (an exact substring, no paraphrase) from that variant's sourceKey or sourceAttributes, or from a CJ description sentence that names this variant; when nothing more specific exists, use the variant's sourceKey itself.
Set pieceCount to null and components to [] unless the CJ source explicitly states them for that variant; never assume "1 piece".
Reply with JSON only matching:
{"title":string,"short_description":string,"description_html":string,"materials_and_care_html":string|null,"image_alt":string,"mainImage":string,"metaDescription":string,"ogDescription":string,"variants":[{"sourceKey":string,"buyerName":string,"clear":boolean,"pieceCount":number|null,"components":string[],"color":string|null,"evidence":string}]}
SITE CATEGORIES: ${JSON.stringify(f.categories)}
CJ SOURCE: ${JSON.stringify({ name: product.name, category: product.category, materials: product.materials, description: product.description, candidateImages: product.images, variants: variants.map((v) => ({ sourceKey: v.key, attributes: v.attrs, sourceAttributes: v.sourceAttrs ?? v.attrs, actualWooAttributes: v.attrs, variantImage: v.image, dimensionsMm: { length: v.length, width: v.width, height: v.height }, weightGrams: v.weight })) })}`;
}

export function parseProductAnalysis(text: string): ProductAnalysis {
  const clean = text.replace(/^```(?:json)?\s*|```\s*$/gm, "").trim();
  return JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)) as ProductAnalysis;
}

/** 每个事实字段必须能在 CJ 原文或该规格键中找到；证据也必须是原文片段。 */
export function checkProductAnalysis(a: ProductAnalysis, p: CjProduct, inputs: ProductVariantInput[]): string[] {
  const out: string[] = [];
  if (!a || typeof a !== "object") return ["product analysis must be an object"];
  if (typeof a.title !== "string" || typeof a.short_description !== "string" || typeof a.description_html !== "string" || typeof a.image_alt !== "string" || !a.title || !a.short_description || !a.description_html || !a.image_alt) out.push("title, short_description, description_html and image_alt are required strings");
  if (a.title?.length > 80) out.push("title is too long");
  if (typeof a.metaDescription !== "string" || !a.metaDescription || a.metaDescription.length > 160) out.push("metaDescription is missing or longer than 160 characters");
  if (typeof a.ogDescription !== "string" || !a.ogDescription || a.ogDescription.length > 200) out.push("ogDescription is missing or longer than 200 characters");
  if (typeof a.mainImage !== "string" || !p.images.includes(a.mainImage)) out.push("mainImage must be one of the CJ candidate images");
  if (a.materials_and_care_html != null && typeof a.materials_and_care_html !== "string") out.push("materials_and_care_html must be a string or null");
  if (!Array.isArray(a.variants)) return [...out, "variants must be an array"];
  const byKey = new Map(inputs.map((v) => [v.key, v]));
  const seen = new Set<string>();
  for (const v of a.variants) {
    if (!v || typeof v !== "object" || typeof v.sourceKey !== "string") { out.push("each variant analysis must be an object with sourceKey"); continue; }
    const input = byKey.get(v.sourceKey);
    if (!input) { out.push(`unknown source variant ${v.sourceKey}`); continue; }
    if (seen.has(v.sourceKey)) out.push(`duplicate source variant ${v.sourceKey}`);
    seen.add(v.sourceKey);
    const actualWooLabel = input.sourceAttrs ? Object.values(input.attrs).map((value) => value.trim()).filter(Boolean).join(" / ") : null;
    if (typeof v.buyerName !== "string" || !v.buyerName.trim() || (!input.sourceAttrs && supplierCodeName(v.buyerName))) out.push(`${v.sourceKey}: buyerName is not buyer-readable and must not expose a supplier code`);
    if (actualWooLabel !== null && (typeof v.buyerName !== "string" || compact(v.buyerName) !== compact(actualWooLabel))) out.push(`${v.sourceKey}: buyerName must exactly match actual Woo option "${actualWooLabel}"`);
    if (typeof v.clear !== "boolean") out.push(`${v.sourceKey}: clear must be boolean`);
    if (v.pieceCount !== null && (!Number.isInteger(v.pieceCount) || v.pieceCount < 1)) out.push(`${v.sourceKey}: pieceCount must be a positive integer or null`);
    if (!Array.isArray(v.components) || v.components.some((x) => typeof x !== "string" || !x.trim())) out.push(`${v.sourceKey}: components must be an array of non-empty strings`);
    if (v.color !== null && typeof v.color !== "string") out.push(`${v.sourceKey}: color must be a string or null`);
    if (typeof v.evidence !== "string") out.push(`${v.sourceKey}: evidence must be a string`);
    const sourceAttrs = input.sourceAttrs ?? input.attrs;
    const distinguishing = [v.sourceKey, ...Object.values(sourceAttrs)].filter((x) => compact(x).length > 1);
    const matchedDescription = p.description.split(/[\n.!?]+/).filter((segment) => distinguishing.some((value) => sourceHas(segment, value))).join("\n");
    // 多规格商品只接受能和当前规格值落在同一句/行的说明；通用父描述不能证明某个套装实际包含什么。
    const local = `${v.sourceKey}\n${Object.values(sourceAttrs).join("\n")}\n${matchedDescription}`;
    if (typeof v.evidence !== "string" || !v.evidence || !sourceHas(local, v.evidence)) out.push(`${v.sourceKey}: evidence is not traceable to CJ source`);
    if (v.pieceCount != null && !new RegExp(`\\b${v.pieceCount}\\s*(?:pc|pcs|piece|pieces|pack|set)?\\b`, "i").test(local)) out.push(`${v.sourceKey}: pieceCount is not supported by CJ source`);
    for (const component of Array.isArray(v.components) ? v.components : []) if (!sourceHas(local, component)) out.push(`${v.sourceKey}: component "${component}" is not supported by CJ source`);
    if (v.color && !sourceHas(local, v.color)) out.push(`${v.sourceKey}: color "${v.color}" is not supported by CJ source`);
    const setLike = /\b\d+\s*(?:pc|pcs|piece|pieces)|\bset(?:\s*[-#]?\s*\d+)?\b/i.test(`${v.sourceKey} ${v.buyerName} ${Object.keys(sourceAttrs).join(" ")}`);
    if (v.clear && setLike && (v.pieceCount == null || v.pieceCount < 1 || (v.components?.length ?? 0) === 0)) out.push(`${v.sourceKey}: a clear set variant requires a sourced pieceCount and component list`);
    if (!input.sourceAttrs && v.clear && setLike && v.pieceCount != null && !new RegExp(`\\b${v.pieceCount}\\s*[- ]?\\s*(?:pc|pcs|piece|pieces)\\b`, "i").test(v.buyerName)) out.push(`${v.sourceKey}: buyerName must state its sourced piece count`);
    if (!input.sourceAttrs && v.clear && typeof v.color === "string" && v.color && !compact(v.buyerName).includes(compact(v.color))) out.push(`${v.sourceKey}: buyerName must state its sourced color`);
    if (v.clear && v.pieceCount == null && (v.components?.length ?? 0) === 0 && !v.color && Object.keys(sourceAttrs).length === 0) out.push(`${v.sourceKey}: clear variant has no supported distinguishing facts`);
  }
  for (const input of inputs) if (!seen.has(input.key)) out.push(`missing analysis for source variant ${input.key}`);
  if (!a.variants.some((v) => v && typeof v === "object" && v.clear === true)) out.push("at least one variant must be clear enough to publish");
  const published = a.variants.filter((v) => v && typeof v === "object" && v.clear === true && typeof v.buyerName === "string");
  const buyerNames = new Set<string>();
  for (const v of published) {
    const name = compact(v.buyerName);
    if (buyerNames.has(name)) out.push(`clear variants must not collapse into duplicate buyerName "${v.buyerName}"`);
    buyerNames.add(name);
  }
  const copy = compact(`${a.title} ${a.short_description} ${a.description_html}`);
  for (const v of published) if (!copy.includes(compact(v.buyerName))) out.push(`copy must cover clear variant "${v.buyerName}"`);
  const clearCounts = [...new Set(published.flatMap((v) => Number.isInteger(v.pieceCount) && v.pieceCount! > 0 ? [v.pieceCount!] : []))].sort((x, y) => x - y);
  const titleCounts = [...a.title.matchAll(/\b(\d+(?:\s*[/,&]\s*\d+)*)\s*[- ]?(?:piece|pc|pcs)\b/gi)]
    .flatMap((match) => match[1].split(/\s*[/,&]\s*/).map(Number)).filter((n) => Number.isInteger(n));
  const generatedCounts = [...`${a.title}\n${a.short_description}\n${a.description_html}`.matchAll(/\b(\d+)\s*[- ]?(?:piece|pc|pcs)\b/gi)]
    .map((match) => Number(match[1])).filter((n) => Number.isInteger(n));
  for (const count of new Set(generatedCounts)) if (!clearCounts.includes(count)) out.push(`copy advertises ${count} pieces but no clear published variant has that count`);
  for (const count of titleCounts) if (!clearCounts.includes(count)) out.push(`title advertises ${count} pieces but no clear published variant has that count`);
  if (clearCounts.length > 1 && titleCounts.length > 0) {
    for (const count of clearCounts) if (!titleCounts.includes(count)) out.push(`title must be generic or state every published piece count; missing ${count}`);
  }
  const generated = [a.title, a.short_description, a.description_html, a.materials_and_care_html ?? "", a.image_alt, a.metaDescription, a.ogDescription].join("\n");
  out.push(...claimProblems(generated));
  const toMm = (value: number, rawUnit: string) => {
    const unit = rawUnit.toLowerCase();
    return unit === "mm" ? value : unit === "cm" ? value * 10 : unit === "m" || unit.startsWith("meter") ? value * 1000 : unit.startsWith("in") ? value * 25.4 : value * 304.8;
  };
  const sourceDimensionText = [p.description, ...inputs.flatMap((input) => [input.key, ...Object.values(input.sourceAttrs ?? input.attrs)])].join("\n");
  const sourceTextMm = [...sourceDimensionText.matchAll(/\b(\d+(?:\.\d+)?)\s*(mm|cm|m|meters?|in(?:ches)?|ft|feet|foot)\b/gi)]
    .map((match) => toMm(Number(match[1]), match[2]));
  const supportedMm = [...inputs.flatMap((input) => [input.length, input.width, input.height]), ...sourceTextMm].filter((value) => Number.isFinite(value) && value > 0);
  for (const match of generated.matchAll(/\b(\d+(?:\.\d+)?)\s*(mm|cm|m|meters?|in(?:ches)?|ft|feet|foot)\b/gi)) {
    const mm = toMm(Number(match[1]), match[2]);
    if (!supportedMm.some((source) => Math.abs(source - mm) <= 2.5)) out.push(`dimension "${match[0]}" is not supported by CJ source facts`);
  }
  if (/\b(?:supplier|source product|sourced from|marketplace)\b/i.test(generated)) out.push("product copy must not mention its supplier or source marketplace");
  if (/\b(?:sale|discount|save)\b|\b\d+%\s*off\b/i.test(generated) && !/\b(?:sale|discount|save)\b|\b\d+%\s*off\b/i.test(sourceText(p))) out.push("discount or sale language is not supported by CJ source");
  const guardedClaims = [
    /\b(?:machine|hand) wash(?:able)?\b/i, /\bwipe clean\b/i, /\bdishwasher safe\b/i, /\bdry clean\b/i,
    /\bwaterproof\b/i, /\bwater[- ]resistant\b/i, /\bscratch[- ]resistant\b/i, /\bfire[- ]resistant\b/i,
    /\bdurable\b/i, /\bheavy[- ]duty\b/i, /\blightweight\b/i, /\bergonomic\b/i, /\blaptop compatible\b/i,
  ];
  for (const pattern of guardedClaims) {
    const claim = pattern.exec(generated)?.[0];
    if (claim && !pattern.test(sourceText(p))) out.push(`claim "${claim}" is not supported by CJ source`);
  }
  const materialWords = ["leather", "nylon", "polyester", "cotton", "canvas", "wool", "silk", "metal", "steel", "aluminum", "plastic", "rubber", "wood", "bamboo", "ceramic", "glass", "pu"];
  for (const material of materialWords) {
    if (new RegExp(`\\b${material}\\b`, "i").test(generated) && !new RegExp(`\\b${material}\\b`, "i").test(sourceText(p))) out.push(`material "${material}" is not supported by CJ source`);
  }
  for (const input of inputs) {
    if (deterministicDimensionProblems(p, input).length === 0) continue;
    for (const field of ["length", "width", "height"] as const) {
      const mm = input[field], cm = mm / 10, meters = mm / 1000;
      if ([new RegExp(`\\b${mm}\\s*mm\\b`, "i"), new RegExp(`\\b${cm}\\s*cm\\b`, "i"), new RegExp(`\\b${meters}\\s*m(?:eters?)?\\b`, "i")].some((re) => re.test(generated))) {
        out.push(`${input.key}: deterministically questionable ${field} must not be published`);
      }
    }
  }
  if (a.materials_and_care_html) {
    if (p.materials.length === 0) out.push("materials_and_care_html must be null because CJ supplied no materials");
    for (const banned of [/responsibl[ey] sourc/i, /hand(?:made|crafted| finished)/i, /machine wash/i, /dishwasher/i, /wipe clean/i]) {
      if (banned.test(a.materials_and_care_html) && !banned.test(sourceText(p))) out.push(`materials/care claim is not in CJ source: ${banned.source}`);
    }
  }
  for (const problem of deterministicDimensionProblems(p)) if (compact(generated).includes(compact(problem.match(/"([^"]+)"/)?.[1] ?? ""))) out.push("questionable dimension must not be published");
  return out;
}

export function unitReviewPrompt(product: CjProduct, analysis: ProductAnalysis, inputs: ProductVariantInput[]): string {
  return `Review dimension units only. Compare the CJ text, product type, and numeric dimensions. Flag any value whose number/unit is questionable. Never propose or guess a correction. Reply JSON only: {"questionable":[{"sourceKey":string,"fields":["length"|"width"|"height"],"reason":string}]}.
${JSON.stringify({ product: { name: product.name, category: product.category, description: product.description }, copy: { title: analysis.title, description: analysis.description_html }, variants: inputs.map((v) => ({ sourceKey: v.key, dimensionsMm: { length: v.length, width: v.width, height: v.height } })) })}`;
}

export function parseUnitReview(text: string): UnitReview {
  const clean = text.replace(/^```(?:json)?\s*|```\s*$/gm, "").trim();
  return JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)) as UnitReview;
}

export function checkUnitReview(review: UnitReview, inputs: ProductVariantInput[]): string[] {
  if (!review || typeof review !== "object" || !Array.isArray(review.questionable)) return ["questionable must be an array"];
  const keys = new Set(inputs.map((v) => v.key));
  const fields = new Set(["length", "width", "height"]);
  return review.questionable.flatMap((q) => {
    if (!q || typeof q !== "object") return ["each questionable item must be an object"];
    const key = typeof q.sourceKey === "string" ? q.sourceKey : "unknown";
    return [
      !keys.has(key) ? `unknown source variant ${key}` : "",
      typeof q.reason !== "string" || !q.reason.trim() ? `${key}: reason is required` : "",
      !Array.isArray(q.fields) || q.fields.length === 0 || q.fields.some((f) => !fields.has(f)) ? `${key}: invalid fields` : "",
    ].filter(Boolean);
  });
}

export function buildPublishableVariants(product: CjProduct, analysis: ProductAnalysis, review: UnitReview, inputs: ProductVariantInput[]): PublishableVariant[] {
  const byKey = new Map(analysis.variants.map((v) => [v.sourceKey, v]));
  const questionable = new Set(review.questionable.map((q) => q.sourceKey));
  return inputs.flatMap((input) => {
    const a = byKey.get(input.key);
    if (!a?.clear) return [];
    const deterministicBad = deterministicDimensionProblems(product, input).length > 0;
    const allPositive = [input.length, input.width, input.height].every((n) => Number.isFinite(n) && n > 0);
    return [{ ...input, buyerName: a.buyerName, pieceCount: a.pieceCount, components: a.components, color: a.color,
      safeDimensions: !questionable.has(input.key) && !deterministicBad && allPositive ? { length: input.length, width: input.width, height: input.height } : null }];
  });
}

/** AI 单位复核判为可疑的数值也不能留在前台文案里。 */
export function unitReviewCopyProblems(review: UnitReview, analysis: ProductAnalysis, inputs: ProductVariantInput[]): string[] {
  const text = [analysis.title, analysis.short_description, analysis.description_html, analysis.materials_and_care_html ?? "", analysis.metaDescription, analysis.ogDescription].join(" ");
  const byKey = new Map(inputs.map((v) => [v.key, v]));
  const out: string[] = [];
  for (const item of review.questionable) {
    const input = byKey.get(item.sourceKey);
    if (!input) continue;
    for (const field of item.fields) {
      const mm = input[field], cm = mm / 10;
      const forms = [new RegExp(`\\b${mm}(?:\\.0+)?\\s*mm\\b`, "i"), new RegExp(`\\b${cm}(?:\\.0+)?\\s*cm\\b`, "i")];
      if (forms.some((re) => re.test(text))) out.push(`${item.sourceKey}: questionable ${field} must be removed from product copy`);
    }
  }
  return out;
}

export function productCopyFromAnalysis(a: ProductAnalysis) {
  return {
    title: a.title,
    short_description: cleanHtml(a.short_description),
    description_html: cleanHtml([a.description_html, a.materials_and_care_html ?? ""].filter(Boolean).join("\n")),
    image_alt: a.image_alt,
    mainImage: a.mainImage,
    metaDescription: a.metaDescription,
    ogDescription: a.ogDescription,
  };
}
