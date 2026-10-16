import type { ReviewIssue } from "../shared/protocol.ts";

export type ReviewFixKind = "main-image" | "variation-images" | "product-copy" | "store-copy" | "policy-text" | "metadata";

export interface ReviewLocationSnapshot {
  targets?: { name: string; path: string; kind: string; targetId?: number }[];
  captures?: { name: string; path: string; url: string }[];
  products?: Record<string, unknown>[];
  categories?: Record<string, unknown>[];
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 仅判断已持久化动作是否仍满足复核 planner 的静态参数约束，不调用模型。 */
export function isReviewActionShape(action: unknown): boolean {
  if (!record(action) || !nonempty(action.tool) || !record(action.params) || !nonempty(action.params.summary)) return false;
  const p = action.params, id = () => Number.isInteger(p.id) && Number(p.id) > 0;
  if (action.tool === "update_copy") return ["tagline", "hero_heading", "hero_subheading", "about", "faq"].some((key) => p[key] !== undefined);
  if (action.tool === "update_policy") return ["shipping", "returns", "privacy", "terms"].includes(String(p.name)) && nonempty(p.html);
  if (action.tool === "update_product") return id() && ["name", "short_description", "description_html"].some((key) => p[key] !== undefined);
  if (action.tool === "update_product_variation_images") return id();
  if (action.tool === "update_product_main_image") {
    const hasImageId = Object.prototype.hasOwnProperty.call(p, "image_id");
    const hasImageUrl = Object.prototype.hasOwnProperty.call(p, "image_url");
    const imageId = Number.isInteger(p.image_id) && Number(p.image_id) > 0;
    const imageUrl = nonempty(p.image_url) && /^https:\/\//i.test(p.image_url);
    return id() && hasImageId !== hasImageUrl && (hasImageId ? imageId : imageUrl);
  }
  if (action.tool === "update_product_categories") return id() && Array.isArray(p.category_ids) && p.category_ids.length > 0 && p.category_ids.every((value) => Number.isInteger(value) && Number(value) > 0);
  if (action.tool === "update_meta") return ["home", "shop", "page", "product", "product_cat"].includes(String(p.target_type))
    && Number.isInteger(p.target_id) && Number(p.target_id) >= 0 && nonempty(p.description) && nonempty(p.og_description);
  return false;
}

const PAGE_LABELS: Record<string, string> = {
  "": "首页", home: "首页", about: "关于我们", "about-us": "关于我们", contact: "联系我们", "contact-us": "联系我们",
  faq: "常见问题", shipping: "配送政策", "shipping-policy": "配送政策", returns: "退货与退款", return: "退货与退款",
  "returns-policy": "退货与退款", refund: "退货与退款", "refund-policy": "退货与退款", "returns-refund": "退货与退款",
  privacy: "隐私政策", "privacy-policy": "隐私政策", terms: "服务条款", "terms-of-service": "服务条款",
  "terms-and-conditions": "服务条款", shop: "商店",
};

const titleFromSlug = (value: string) => {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch {}
  return decoded.replace(/^\d+-/, "").replace(/-\d+$/, "").split(/[-_]+/).filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
};

export function friendlyReviewPageLabel(page: string, url: string, snapshot?: ReviewLocationSnapshot): string {
  if (page === "Site-wide" || page === "全站") return "全站";
  if (page === "Payment setup" || page === "支付设置" || /[?&]page=wc-settings(?:&|$)/.test(url)) return "支付设置";
  if (/^(?:商品|分类)：\S/.test(page)) return page;
  const capture = snapshot?.captures?.find((item) => item.url === url || item.name === page);
  const target = snapshot?.targets?.find((item) => item.name === capture?.name || item.name === page || item.path === capture?.path);
  const path = (() => { try { return new URL(url).pathname; } catch { return capture?.path ?? ""; } })();
  const slug = path.replace(/^\/+|\/+$/g, "").split("/").at(-1) ?? "";
  const pageMatch = /^(?:page-\d+-)?(.+)$/.exec(page)?.[1]?.toLowerCase();
  const known = PAGE_LABELS[pageMatch ?? ""] ?? PAGE_LABELS[slug.toLowerCase()];
  if (known) return known;

  const productId = target?.kind === "product" ? target.targetId : Number(/^product-(\d+)-/.exec(page)?.[1]);
  const product = snapshot?.products?.find((item) => Number(item.id) === productId);
  if (target?.kind === "product" || /^product(?:-|\s*#|:)/i.test(page) || /\/product\//.test(path)) {
    const current = /^Product:\s*(.+)$/i.exec(page)?.[1];
    const legacy = /^product-\d+-(.+)$/i.exec(page)?.[1];
    const name = typeof product?.name === "string" && product.name.trim() ? product.name.trim() : current ?? titleFromSlug(legacy ?? slug);
    return `商品：${name || `#${productId}`}`;
  }
  const categoryId = target?.kind === "category" ? target.targetId : Number(/^category-(\d+)-/.exec(page)?.[1]);
  const category = snapshot?.categories?.find((item) => Number(item.id) === categoryId);
  if (target?.kind === "category" || /^category(?:-|:)/i.test(page) || /\/product-category\//.test(path)) {
    const current = /^Category:\s*(.+)$/i.exec(page)?.[1];
    const legacy = /^category-\d+-(.+?)(?:-1)?$/i.exec(page)?.[1];
    const name = typeof category?.name === "string" && category.name.trim() ? category.name.trim() : current ?? titleFromSlug(legacy ?? slug);
    return `分类：${name || `#${categoryId}`}`;
  }
  if (/^[\u3400-\u9fff]/.test(page)) return page;
  return PAGE_LABELS[slug.toLowerCase()] ?? page;
}

export function reviewIssueFixKind(issue: ReviewIssue, snapshot?: ReviewLocationSnapshot): ReviewFixKind | undefined {
  if (issue.status !== "open") return undefined;
  // 只按问题本身（证据、原因）分类；「怎么改」里常列出几种备选做法，拿来分类会误判
  const text = `${issue.page}\n${issue.evidence}\n${issue.why}`;
  const path = (() => { try { return new URL(issue.url).pathname; } catch { return ""; } })();
  if (issue.kind === "policy" && /(?:shipping|returns?|refund|privacy|terms|配送|退货|退款|隐私|条款)/i.test(`${path} ${issue.page}`)) return "policy-text";
  // 新复核不接收 SEO 问题；这里只让旧报告中能唯一落到真实页面的摘要问题继续使用安全 planner。
  if (issue.kind === "seo" && /^https?:\/\//i.test(issue.url) && !/\/wp-admin\//i.test(path)) return "metadata";
  const product = /\/product\//.test(path) || /^商品[:：]|^Product[:\s#-]/i.test(issue.page)
    || snapshot?.captures?.some((capture) => capture.url === issue.url && snapshot.targets?.some((target) => target.name === capture.name && target.kind === "product"));
  if (product && ["product", "visual", "copy"].includes(issue.kind)) {
    // 描述/标题与实际选项或资料不符，优先当作商品文字问题
    if (/(?:description|title|copy|bullet|描述|标题|文案)/i.test(text)
      && /(?:mismatch|inconsisten|contradict|disagree|differ|unsupported|stale|cannot order|does not match|不符|不一致|矛盾|对不上|无依据|过时)/i.test(text)) return "product-copy";
    if (/(?:variation|variant|规格|款式|选项)/i.test(text) && /(?:image|photo|picture|图片|照片)/i.test(text)
      && /(?:same|shared|identical|missing|mismatch|wrong|different|相同|共用|缺少|不符|错误|不同)/i.test(text)) return "variation-images";
    if (/(?:image|photo|picture|主图|图片|照片)/i.test(text)
      && /(?:main|primary|featured|wrong|different item|animal|species|text overlay|size label|watermark|barcode|collage|cropped|unclear|blurry|主图|错误|不是同一商品|文字覆盖|尺寸标注|水印|条码|拼图|裁切|模糊)/i.test(text)) return "main-image";
    if (/(?:title|description|copy|variant|variation|option|colour|color|size|feature|标题|描述|文案|规格|款式|选项|颜色|尺寸|功能)/i.test(text)
      && /(?:mismatch|inconsisten|contradict|differ|unsupported|wrong|inaccurate|does not match|不符|不一致|矛盾|不同|无依据|错误|不准确)/i.test(text)) return "product-copy";
  }
  if (!product && issue.kind === "copy" && /(?:catalog|categor|dog bed|cat bed|目录|分类|商品范围)/i.test(text)
    && /(?:mismatch|inconsisten|contradict|differ|unrelated|does not match|actual|match|不符|不一致|矛盾|无关|实际)/i.test(text)) return "store-copy";
  return undefined;
}

export function reviewIssueFixable(issue: ReviewIssue, snapshot?: ReviewLocationSnapshot, hasValidatedAction = false): boolean {
  return issue.status === "open" && (hasValidatedAction || reviewIssueFixKind(issue, snapshot) !== undefined);
}
