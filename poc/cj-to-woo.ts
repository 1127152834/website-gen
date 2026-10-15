// POC：CJ 只当商品资料库 → DeepSeek 改写文案并拆分规格 → 通过 Woo REST（伴侣插件的应用密码）建可变商品。
// 不做 CJ 店铺授权、不刊登、不下单。用法：node --env-file=.env poc/cj-to-woo.ts <domain> <cj pid>
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

const [domain, pid] = process.argv.slice(2);
if (!domain || !pid) throw new Error("usage: cj-to-woo.ts <domain> <cj pid>");

// 1) CJ 只读：商品详情（含规格）
const cjToken: string = JSON.parse(readFileSync("poc/out/cj-token.json", "utf8")).accessToken;
const cj = new Client({ name: "website-gen-poc", version: "0.0.0" });
await cj.connect(new StreamableHTTPClientTransport(new URL(`https://developers.cjdropshipping.com/mcp/${cjToken}`)));
const raw = (await cj.callTool({ name: "get_product_detail", arguments: { pid } })).content as { text?: string }[];
await cj.close();
const text = raw.map((c) => c.text ?? "").join("");
const p = JSON.parse(text.slice(text.indexOf("{")));
type Variant = { variantKey: string; variantSellPrice: number; variantImage: string; variantWeight: number; variantLength: number; variantWidth: number; variantHeight: number };
const variants: Variant[] = p.variants;
console.log(`✔ CJ ${p.productSku}: ${p.productNameEn} | ${variants.length} variants | cost ${p.sellPrice}`);

// 2) DeepSeek 改写：美式英语、不编造事实；把 "Brown S" 这类组合拆成属性
const models = createModels();
models.setProvider(deepseekProvider());
const model = models.getModel("deepseek", "deepseek-flash")!;
const facts = {
  name: p.productNameEn, category: p.categoryName, material: p.materialNameEnSet,
  description: String(p.description).replace(/<[^>]+>/g, "\n").replace(/\n{2,}/g, "\n").trim().slice(0, 3000),
  variantKeys: variants.map((v) => v.variantKey),
};
const prompt = `You write product listings for a US online pet store. Rewrite the product below.
Rules: American English; only use facts present in the input; no medical, certification, origin or "best/#1" claims; no reviews; no mention of CJ, dropshipping or the supplier.
Split every variant key into named attributes (for example "Brown S" -> {"Color":"Brown","Size":"S"}); use proper capitalization (S, M, L, XL).
Return "variants" in exactly the same order and count as INPUT.variantKeys, copying each key unchanged into "key".
Reply with JSON only:
{"title": string (max 70 chars), "short_description": string (1-2 sentences), "description_html": string (<p> and <ul> only),
 "attributes": [{"name": string, "values": string[]}], "variants": [{"key": string, "attributes": {"<name>": "<value>"}}], "image_alt": string}
INPUT: ${JSON.stringify(facts)}`;
const ai = await models.completeSimple(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { reasoning: "low" });
if (ai.stopReason === "error") throw new Error(ai.errorMessage);
const out = JSON.parse(ai.content.filter((c) => c.type === "text").map((c) => c.text).join("").replace(/^```(json)?|```$/gm, "").trim());
// 按顺序对应（AI 会把 "Brown xl" 规范成 "XL"），再用忽略大小写的 key 兜底校验
const norm = (s: string) => s.trim().toLowerCase();
const aiVariants: { key: string; attributes: Record<string, string> }[] = out.variants ?? [];
const valid = out.title && Array.isArray(out.attributes) && aiVariants.length === variants.length
  && aiVariants.every((v, i) => norm(v.key) === norm(variants[i].variantKey) && Object.keys(v.attributes ?? {}).length > 0);
if (!valid) throw new Error(`AI output failed validation: keys ${JSON.stringify(aiVariants.map((v) => v.key))} vs ${JSON.stringify(variants.map((v) => v.variantKey))}`);
const byKey = new Map(variants.map((v, i) => [v.variantKey, aiVariants[i].attributes]));
const variationNames = new Set(aiVariants.flatMap((v) => Object.keys(v.attributes)));
console.log(`✔ AI rewrite ($${ai.usage.cost.total.toFixed(4)}): "${out.title}" | attributes ${out.attributes.map((a: { name: string; values: string[] }) => `${a.name}[${a.values.join("/")}]`).join(" ")}`);

// 3) 定价：成本 × 2.5，尾数 .99（价格由代码算，不让 AI 定）
const price = (cost: number) => (Math.floor(cost * 2.5) + 0.99).toFixed(2);

// 4) Woo REST：先建可变商品，再批量建规格
const { username, password } = JSON.parse(readFileSync("poc/out/secrets.json", "utf8"))[`companion_${domain}`];
const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
async function wc(path: string, body: unknown) {
  const res = await fetch(`https://${domain}/wp-json/wc/v3${path}`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}
const sku = `SUC-${pid.slice(-8)}`;
const images = (p.productImageSet as string[]).slice(0, 4).map((src, i) => ({ src, alt: `${out.image_alt}${i ? ` (${i + 1})` : ""}` }));
const t0 = performance.now();
const product = await wc("/products", {
  name: out.title, type: "variable", status: "publish", sku,
  short_description: out.short_description, description: out.description_html, images,
  // 只有规格里真正用到的属性（如颜色、尺码）才是可选规格；材质、洗涤说明等只作为参数展示
  attributes: out.attributes.map((a: { name: string; values: string[] }) => ({ name: a.name, visible: true, variation: variationNames.has(a.name), options: a.values })),
  meta_data: [{ key: "_source_cj_pid", value: pid }],
});
console.log(`✔ product #${product.id} created (${Math.round(performance.now() - t0)}ms, images ${product.images.length})`);
const batch = await wc(`/products/${product.id}/variations/batch`, {
  create: variants.map((v, i) => ({
    sku: `${sku}-${i + 1}`,
    regular_price: price(Number(v.variantSellPrice)),
    attributes: Object.entries(byKey.get(v.variantKey) as Record<string, string>).map(([name, option]) => ({ name, option })),
    weight: String(v.variantWeight / 1000), // CJ 是克
    dimensions: { length: String(v.variantLength / 10), width: String(v.variantWidth / 10), height: String(v.variantHeight / 10) }, // CJ 是毫米
    manage_stock: false, stock_status: "instock",
  })),
});
const created = batch.create.filter((v: { id: number }) => v.id);
console.log(`✔ ${created.length}/${variants.length} variations: ${created.map((v: { sku: string; price: string }) => `${v.sku}=$${v.price}`).join(", ")}`);

// 5) 从公开的商店接口核对
const pub = await (await fetch(`https://${domain}/wp-json/wc/store/v1/products/${product.id}`)).json();
console.log(`✔ store API: "${pub.name}" | $${(pub.prices.price_range?.min_amount ?? pub.prices.price) / 100}–$${(pub.prices.price_range?.max_amount ?? pub.prices.price) / 100} | ${pub.images.length} images | ${pub.permalink}`);
writeFileSync(`poc/out/cj-to-woo-${pid}.json`, JSON.stringify({ ai: out, product: { id: product.id, permalink: product.permalink } }, null, 2));
