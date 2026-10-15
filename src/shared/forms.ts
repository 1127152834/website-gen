// 建站表单：界面和后台共用同一份校验。只收系统无法自己知道的真实信息，其余由 AI 按规则决定（方案 4.2.1–4.2.2）。

export interface EntityForm {
  kind: "company" | "individual";
  /** 公司法定名称或个人经营者姓名 */
  name: string;
  address: string;
  /** "auto" = 使用各站的 support@域名 */
  supportEmail: string;
  phone: string;
  /** 处理 + 运输时效，你们自己发货的真实能力 */
  shipping: string;
}

export interface SiteForm {
  domain: string;
  categories: string;
  count: number;
  priceMin: number | null;
  priceMax: number | null;
  /** 留空则从域名推断 */
  brand: string;
}

export interface BatchForm {
  entity: EntityForm;
  sites: SiteForm[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const blank = (s: string) => s.trim() === "";

/** 返回「字段路径 → 错误说明」，没有错误时是空对象。 */
export function validateBatch(f: BatchForm): Record<string, string> {
  const e: Record<string, string> = {};
  const { entity } = f;
  if (blank(entity.name)) e["entity.name"] = entity.kind === "company" ? "请填写公司法定名称" : "请填写经营者姓名";
  if (blank(entity.address)) e["entity.address"] = "请填写地址，会显示在页脚和联系页";
  if (entity.supportEmail !== "auto" && !EMAIL.test(entity.supportEmail.trim())) e["entity.supportEmail"] = "请填写有效的邮箱，或选择使用 support@各自域名";
  if (blank(entity.phone)) e["entity.phone"] = "请填写客服电话";
  if (blank(entity.shipping)) e["entity.shipping"] = "请填写处理和运输时效，会写进运输政策";

  if (f.sites.length === 0) e["sites"] = "至少添加一个站";
  const seen = new Set<string>();
  f.sites.forEach((s, i) => {
    if (blank(s.domain)) e[`sites.${i}.domain`] = "请选择域名";
    else if (seen.has(s.domain)) e[`sites.${i}.domain`] = "这个域名在本批次里重复了";
    seen.add(s.domain);
    if (blank(s.categories)) e[`sites.${i}.categories`] = "请填写商品类目";
    if (!Number.isInteger(s.count) || s.count < 1 || s.count > 200) e[`sites.${i}.count`] = "商品数量填 1–200";
    if (s.priceMin != null && s.priceMax != null && (s.priceMin <= 0 || s.priceMin > s.priceMax)) e[`sites.${i}.price`] = "售价区间不正确";
  });
  return e;
}

/** nordicpaws.com → Nordicpaws；glow-lab.store → Glow Lab。更自然的品牌名之后由 AI 改写。 */
export function brandFromDomain(domain: string): string {
  return domain.split(".")[0].split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
