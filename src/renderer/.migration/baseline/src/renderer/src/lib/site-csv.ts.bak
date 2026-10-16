import { validateBatch, type SiteForm } from "../../../shared/forms.ts";

// RFC 4180 的引号、双引号转义、逗号和换行；不执行单元格中的公式。
export function parseSiteCsv(text: string): SiteForm[] {
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false, closed = false;
  const input = text.replace(/^\uFEFF/, "");
  if (input.length > 1_000_000) throw new Error("CSV 不能超过 1 MB");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) { if (char === '"') { if (input[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += char; continue; }
    if (char === '"') { if (field || closed) throw new Error("CSV 引号格式不正确"); quoted = true; }
    else if (char === ",") { row.push(field); field = ""; closed = false; }
    else if (char === "\r" || char === "\n") { if (char === "\r" && input[i + 1] === "\n") i++; row.push(field); if (row.some((cell) => cell.trim())) rows.push(row); row = []; field = ""; closed = false; }
    else { if (closed && char.trim()) throw new Error("CSV 引号后只能是分隔符"); if (!closed) field += char; }
  }
  if (quoted) throw new Error("CSV 有未闭合的引号");
  row.push(field); if (row.some((cell) => cell.trim())) rows.push(row);
  if (rows.length < 2) throw new Error("CSV 需要表头和至少一行站点");
  if (rows.length > 201) throw new Error("每次最多导入 200 个站点");
  const aliases: Record<string, string> = { domain: "domain", 域名: "domain", brand: "brand", 品牌: "brand", niche: "categories", categories: "categories", 类目: "categories", count: "count", 数量: "count", price_min: "priceMin", pricemin: "priceMin", 最低售价: "priceMin", price_max: "priceMax", pricemax: "priceMax", 最高售价: "priceMax" };
  const header = rows.shift()!.map((cell) => aliases[cell.trim().toLowerCase()]);
  if (!header.includes("domain") || !header.includes("categories")) throw new Error("表头至少包含 domain 和 niche（或 categories）");
  const known = header.filter(Boolean);
  if (new Set(known).size !== known.length) throw new Error("CSV 存在重复列");
  const sites = rows.map((cells, index) => {
    if (cells.length !== header.length) throw new Error(`第 ${index + 2} 行的列数与表头不一致`);
    const values = Object.fromEntries(header.flatMap((key, i) => key ? [[key, cells[i].trim()]] : []));
    const number = (value: string | undefined) => value ? Number(value) : null;
    const site: SiteForm = { domain: values.domain.toLowerCase(), categories: values.categories, brand: values.brand ?? "", count: values.count ? Number(values.count) : 20, priceMin: number(values.priceMin), priceMax: number(values.priceMax) };
    if ([site.priceMin, site.priceMax].some((price) => price != null && (!Number.isFinite(price) || price <= 0))) throw new Error(`第 ${index + 2} 行售价必须为正数`);
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(site.domain)) throw new Error(`第 ${index + 2} 行域名格式不正确`);
    return site;
  });
  const errors = validateBatch({ entity: { kind: "company", name: "校验", address: "校验", phone: "校验", supportEmail: "auto", processingDays: [0, 1], transitDays: [1, 2] }, sites });
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join("；"));
  return sites;
}
