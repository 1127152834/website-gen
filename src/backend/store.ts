// 流水线后半段：CJ 选品 → AI 文案与政策 → 商店配置 → 页面 → 上架商品 → QA 验收。
// 都通过伴侣插件注册得到的应用密码调站点 REST（wp/v2、wc/v3、site-agent/v1），不经过 Hostinger。
// AI 只写文字；定价、运费、规格拆分、事实核对都由代码完成。
import { join } from "node:path";
import { brandFromDomain } from "../shared/forms.ts";
import { retailPrice, RULES } from "../shared/rules.ts";
import { parseCandidates, parseDetail, splitVariants, type Candidate } from "./cj.ts";
import {
  buildPages, checkCopy, checkPolicies, checkProductCopy, claimProblems, cleanHtml, copyPrompt, PAGE_SLUGS, parseJsonReply,
  parsePolicies, policyPrompt, productPrompt, screenPrompt, type Facts, type Policies, type SiteCopy, type Style,
} from "./content.ts";
import { PermanentError } from "./jobs.ts";
import type { BackStepKey, StepCtx, StepResult } from "./pipeline.ts";
import { BrowserUnavailable } from "./qa-browser.ts";
import { mailStatus } from "./mail.ts";

export type Pick = Candidate & { status: "pending" | "done" | "skipped"; productId?: number; reason?: string };
interface Spec { copy: SiteCopy; policies: Policies }

export interface QaCheck {
  id: string;
  name: string;
  level: "block" | "warn";
  ok: boolean;
  detail: string;
}
export interface QaReport {
  at: number;
  checks: QaCheck[];
  shots: { name: string; file: string }[];
}

/** 商品不能上架（资料不全、价格不在区间、AI 两次都没写对等）：跳过它，换下一个候选。 */
class Skip extends Error {}

// 规则 4.2.2 的硬性排除；儿童玩具、仿牌等需要理解语义的交给 AI 筛查
const EXCLUDE = /\b(batter(y|ies)|rechargeable|lithium|liquid|essential oil|lotion|serum|shampoo|perfume|cosmetic|food|snack|supplement|vitamin|medical|baby|babies|infant|toddler|kids?|child(ren)?|knife|knives|gun|adult|sexy|lingerie)\b/i;
const ZONE = "Contiguous US";
// 本土 48 州 + DC
const CONTIGUOUS = "AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

export const splitCategories = (s: string) => s.split(/[,，、;；\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 5);
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function facts(ctx: StepCtx): Facts {
  return {
    brand: ctx.form.brand.trim() || brandFromDomain(ctx.domain),
    domain: ctx.domain,
    email: ctx.entity.supportEmail === "auto" ? `support@${ctx.domain}` : ctx.entity.supportEmail.trim(),
    categories: splitCategories(ctx.form.categories),
    entity: ctx.entity,
  };
}

/** "1 Main St, Austin, TX 78701, United States" → 拆成 Woo 店铺地址字段；不是美国地址就整串放进第一行。 */
export function parseUsAddress(address: string): { street: string; city: string; state: string; zip: string } {
  const m = /^(.+?),\s*([^,]+?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?(?:,\s*(?:USA|US|United States(?: of America)?))?\s*$/i.exec(address.trim());
  return m ? { street: m[1], city: m[2], state: m[3].toUpperCase(), zip: m[4] } : { street: address.trim(), city: "", state: "", zip: "" };
}

/** 调模型并校验；不合格时把问题告诉模型重写一次，还不行就报错。 */
async function ask<T>(ctx: StepCtx, task: string, prompt: string, parse: (text: string) => T, check: (v: T) => string[]): Promise<T> {
  let problems: string[] = [];
  let extra = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, cost } = await ctx.d.ai("bulk", prompt + extra);
    let value: T | undefined;
    try {
      value = parse(text);
      problems = check(value);
    } catch {
      problems = ["the reply was not in the requested format"];
    }
    ctx.emit("ai_text", { task, cost, ok: problems.length === 0, preview: text.slice(0, 400) });
    if (problems.length === 0) return value!;
    ctx.emit("warn", { message: `${task}没通过检查，让 AI 改：${problems.slice(0, 5).join("; ")}` });
    extra = `\n\nYour previous reply had these problems. Fix all of them and reply again in full:\n- ${problems.join("\n- ")}`;
  }
  throw new Error(`${task}：AI 两次都没写对（${problems.slice(0, 3).join("; ")}）`);
}

const spec = (ctx: StepCtx): Spec => {
  if (!ctx.site.spec_json) throw new Error("还没有生成文案");
  return JSON.parse(ctx.site.spec_json) as Spec;
};

export function storeSteps(ctx: StepCtx): Record<BackStepKey, () => Promise<StepResult>> {
  const { form, wp } = ctx;
  const lo = form.priceMin, hi = form.priceMax;
  const inRange = (price: number) => (lo == null || price >= lo) && (hi == null || price <= hi);
  const categoryIds = new Map<string, number>();

  async function ensureCategory(keyword: string): Promise<number> {
    const slug = slugify(keyword);
    if (!categoryIds.has(slug)) {
      const found = (await wp("GET", `wc/v3/products/categories?slug=${slug}`)) as { id: number }[];
      categoryIds.set(slug, found[0]?.id ?? ((await wp("POST", "wc/v3/products/categories", { name: titleCase(keyword), slug })) as { id: number }).id);
    }
    return categoryIds.get(slug)!;
  }

  async function upsertPage(slug: string, title: string, content: string): Promise<number> {
    const found = (await wp("GET", `wp/v2/pages?slug=${slug}&status=publish,draft,pending,private&context=edit&_fields=id`)) as { id: number }[];
    const body = { slug, title, content, status: "publish" };
    return ((await wp("POST", found[0] ? `wp/v2/pages/${found[0].id}` : "wp/v2/pages", body)) as { id: number }).id;
  }

  async function applyStyle(style: Style) {
    const [theme] = (await wp("GET", "wp/v2/themes?status=active")) as { stylesheet: string; _links?: Record<string, { href: string }[]> }[];
    const id = /global-styles\/(\d+)/.exec(theme?._links?.["wp:user-global-styles"]?.[0]?.href ?? "")?.[1];
    if (!id) throw new Error("找不到全局样式");
    let body: { styles: unknown; settings: unknown } = { styles: {}, settings: {} };
    if (style !== "default") {
      const variations = (await wp("GET", `wp/v2/global-styles/themes/${theme.stylesheet}/variations`)) as { title?: string; styles?: unknown; settings?: unknown }[];
      const v = variations.find((x) => x.title?.toLowerCase() === style);
      if (v) body = { styles: v.styles ?? {}, settings: v.settings ?? {} };
    }
    await wp("POST", `wp/v2/global-styles/${id}`, body);
  }

  async function listProduct(pick: Pick, featured: boolean): Promise<number> {
    const sku = `WG-${pick.pid.slice(-10)}`;
    const [existing] = (await wp("GET", `wc/v3/products?sku=${sku}&status=any`)) as { id: number; status: string }[];
    if (existing?.status === "publish") return existing.id;
    // 上次建到一半（草稿）就中断了：删掉重建，保证规格完整
    if (existing) await wp("DELETE", `wc/v3/products/${existing.id}?force=true`);

    const cj = parseDetail(await ctx.d.cj(`/product/query?pid=${pick.pid}`));
    if (cj.images.length === 0) throw new Skip("CJ 资料里没有图片");
    const options = splitVariants(cj.keyNames, cj.variants.map((v) => v.key));
    const variants = cj.variants.map((v, i) => ({ ...v, attrs: options[i], price: retailPrice(v.cost) })).filter((v) => inRange(v.price));
    if (variants.length === 0) throw new Skip("没有售价落在区间内的规格");

    const copy = await ask(ctx, `改写商品 ${pick.pid}`, productPrompt(facts(ctx), {
      name: cj.name, category: cj.category, materials: cj.materials, description: cj.description,
      options: [...new Set(variants.flatMap((v) => Object.values(v.attrs)))],
    }), (t) => parseJsonReply(t) as { title: string; short_description: string; description_html: string; image_alt: string }, checkProductCopy)
      .catch((e: Error) => {
        throw new Skip(e.message);
      });
    const size = (v: (typeof variants)[number]) => ({
      weight: (v.weight / 1000).toFixed(3), // CJ 是克，Woo 默认千克
      dimensions: { length: (v.length / 10).toFixed(1), width: (v.width / 10).toFixed(1), height: (v.height / 10).toFixed(1) }, // 毫米 → 厘米
    });
    const base = {
      name: copy.title, status: "draft", sku, featured,
      short_description: cleanHtml(copy.short_description), description: cleanHtml(copy.description_html),
      images: cj.images.slice(0, 4).map((src, i) => ({ src, alt: i ? `${copy.image_alt} (${i + 1})` : copy.image_alt })),
      categories: [{ id: await ensureCategory(pick.keyword) }],
      // 只在后台留 CJ 商品 ID 方便追溯，前台不显示
      meta_data: [{ key: "_source_cj_pid", value: pick.pid }],
    };
    let id: number;
    if (variants.length === 1) {
      id = ((await wp("POST", "wc/v3/products", { ...base, type: "simple", regular_price: variants[0].price.toFixed(2), ...size(variants[0]) })) as { id: number }).id;
    } else {
      const names = Object.keys(variants[0].attrs);
      id = ((await wp("POST", "wc/v3/products", {
        ...base, type: "variable",
        attributes: names.map((name) => ({ name, visible: true, variation: true, options: [...new Set(variants.map((v) => v.attrs[name]))] })),
      })) as { id: number }).id;
      const batch = (await wp("POST", `wc/v3/products/${id}/variations/batch`, {
        create: variants.map((v, i) => ({
          sku: `${sku}-${i + 1}`, regular_price: v.price.toFixed(2), manage_stock: false, stock_status: "instock",
          attributes: Object.entries(v.attrs).map(([name, option]) => ({ name, option })), ...size(v),
        })),
      })) as { create: { id?: number; error?: { message?: string } }[] };
      const failed = batch.create.filter((x) => !x.id);
      if (failed.length) throw new Error(`${failed.length} 个规格没建成：${failed[0].error?.message ?? "未知原因"}`);
    }
    await wp("PUT", `wc/v3/products/${id}`, { status: "publish" });
    return id;
  }

  return {
    async products_pick() {
      if (ctx.site.picks_json) return { status: "done", detail: "沿用已选好的商品" };
      const keywords = splitCategories(form.categories);
      const found: Candidate[] = [];
      for (const keyWord of keywords) {
        for (let page = 1; page <= 3 && found.filter((c) => c.keyword === keyWord).length < form.count * 3; page++) {
          const q = new URLSearchParams({ keyWord, page: String(page), size: "50", orderBy: "1", sort: "desc" });
          // 按售价区间反推成本区间，先在 CJ 那边筛掉一大半
          if (lo != null) q.set("startSellPrice", Math.max(0, (lo - 1) / RULES.markup).toFixed(2));
          if (hi != null) q.set("endSellPrice", ((hi + 1) / RULES.markup).toFixed(2));
          const batch = parseCandidates(await ctx.d.cj(`/product/listV2?${q}`), keyWord);
          found.push(...batch);
          if (batch.length < 50) break;
        }
      }
      const seen = new Set<string>();
      const candidates = found.filter((c) => !seen.has(c.pid) && seen.add(c.pid) && !EXCLUDE.test(c.name) && (inRange(retailPrice(c.costMin)) || inRange(retailPrice(c.costMax))));
      if (candidates.length === 0) throw new PermanentError(`CJ 上没找到符合「${keywords.join("、")}」和售价区间的商品，换个类目关键词或放宽售价区间`);

      const screened = await ask(ctx, "选品筛查", screenPrompt(keywords, candidates.slice(0, 150).map(({ pid, name }) => ({ pid, name }))),
        (t) => parseJsonReply(t) as { keep: string[] }, (v) => (Array.isArray(v?.keep) ? [] : ['"keep" must be an array of pid strings']));
      const keep = new Set(screened.keep.map(String));
      const ok = candidates.filter((c) => keep.has(c.pid));
      if (ok.length === 0) throw new PermanentError("AI 筛查后没有可以合规销售的商品，换个类目关键词再试");

      // 各类目轮流取，同一类目按 CJ 上架次数（热度）排；多备一些，上架失败时顶上
      const lists = keywords.map((kw) => ok.filter((c) => c.keyword === kw).sort((a, b) => b.listed - a.listed));
      const want = Math.ceil(form.count * 1.5) + 2;
      const picks: Pick[] = [];
      for (let i = 0; picks.length < want && lists.some((l) => l[i]); i++) for (const l of lists) if (l[i] && picks.length < want) picks.push({ ...l[i], status: "pending" });
      ctx.save("picks_json", JSON.stringify(picks));
      return { status: "done", detail: `CJ 搜到 ${found.length} 个，筛查后 ${ok.length} 个可用，备选 ${picks.length} 个（目标 ${form.count} 个）` };
    },

    async content() {
      if (ctx.site.spec_json) return { status: "done", detail: "沿用已生成的文案" };
      const f = facts(ctx);
      const copy = await ask(ctx, "站点文案", copyPrompt(f), (t) => parseJsonReply(t) as SiteCopy, (c) => checkCopy(c, f));
      const policies = await ask(ctx, "政策页", policyPrompt(f), parsePolicies, (p) => checkPolicies(p, f));
      ctx.save("spec_json", JSON.stringify({ copy, policies } satisfies Spec));
      return { status: "done", detail: `标语「${copy.tagline}」，风格 ${copy.style}，FAQ ${copy.faq.length} 条，政策页 4 个` };
    },

    async store_setup() {
      const { copy } = spec(ctx);
      const f = facts(ctx);
      await wp("POST", "site-agent/v1/site", {
        // 建站期间不让搜索引擎收录（维护页没有 noindex），上线时再打开
        options: { blogname: f.brand, blogdescription: copy.tagline, blog_public: 0 },
        info: { entity: f.entity.name, email: f.email, phone: f.entity.phone, address: f.entity.address, announcement: `Free US shipping on orders over $${RULES.freeShippingOver}` },
      });
      const a = parseUsAddress(f.entity.address);
      await wp("POST", "wc/v3/settings/general/batch", {
        update: [
          { id: "woocommerce_store_address", value: a.street },
          { id: "woocommerce_store_city", value: a.city },
          { id: "woocommerce_store_postcode", value: a.zip },
          { id: "woocommerce_default_country", value: a.state ? `US:${a.state}` : "US" },
          { id: "woocommerce_allowed_countries", value: "specific" },
          { id: "woocommerce_specific_allowed_countries", value: ["US"] },
          { id: "woocommerce_ship_to_countries", value: "" },
          { id: "woocommerce_currency", value: "USD" },
          { id: "woocommerce_calc_taxes", value: "no" },
        ],
      });
      await wp("POST", "wc/v3/settings/account/batch", { update: [{ id: "woocommerce_enable_guest_checkout", value: "yes" }] });

      const zones = (await wp("GET", "wc/v3/shipping/zones")) as { id: number; name: string }[];
      const zone = zones.find((z) => z.name === ZONE) ?? ((await wp("POST", "wc/v3/shipping/zones", { name: ZONE })) as { id: number });
      await wp("PUT", `wc/v3/shipping/zones/${zone.id}/locations`, CONTIGUOUS.map((s) => ({ code: `US:${s}`, type: "state" })));
      const methods = (await wp("GET", `wc/v3/shipping/zones/${zone.id}/methods`)) as { method_id: string }[];
      if (!methods.some((m) => m.method_id === "free_shipping")) {
        await wp("POST", `wc/v3/shipping/zones/${zone.id}/methods`, { method_id: "free_shipping", settings: { requires: "min_amount", min_amount: String(RULES.freeShippingOver) } });
      }
      if (!methods.some((m) => m.method_id === "flat_rate")) {
        await wp("POST", `wc/v3/shipping/zones/${zone.id}/methods`, { method_id: "flat_rate", settings: { title: "Standard shipping", cost: String(RULES.flatRate) } });
      }

      let style = `风格 ${copy.style}`;
      try {
        await applyStyle(copy.style);
      } catch (e) {
        style = "风格没设置成功，用主题默认";
        ctx.emit("warn", { message: `设置风格失败：${(e as Error).message}` });
      }
      return { status: "done", detail: `店名 ${f.brand}；美国本土 48 州满 $${RULES.freeShippingOver} 包邮，否则 $${RULES.flatRate}；不收销售税；${style}` };
    },

    async pages() {
      const { copy, policies } = spec(ctx);
      const ids: Record<string, number> = {};
      for (const page of buildPages(copy, policies, facts(ctx))) {
        // 隐私政策页要管理员权限才能编辑，交给伴侣插件发布并设置
        ids[page.slug] = page.slug === "privacy-policy"
          ? ((await wp("POST", "site-agent/v1/privacy-page", { title: page.title, content: page.content })) as { id: number }).id
          : await upsertPage(page.slug, page.title, page.content);
      }
      await wp("POST", "site-agent/v1/site", { options: { show_on_front: "page", page_on_front: ids.home } });
      await wp("POST", "wc/v3/settings/advanced/batch", { update: [{ id: "woocommerce_terms_page_id", value: String(ids.terms) }] });
      return { status: "done", detail: `${Object.keys(ids).length} 个页面；首页、隐私政策页、条款页已设置` };
    },

    async products() {
      const picks = JSON.parse(ctx.site.picks_json ?? "[]") as Pick[];
      let done = picks.filter((p) => p.status === "done").length;
      const deadline = performance.now() + 90_000; // 每次最多跑 90 秒，任务租约不会过期，界面也能看到进度
      for (const pick of picks) {
        if (done >= form.count) break;
        if (pick.status !== "pending") continue;
        if (performance.now() > deadline) return { progress: `已上架 ${done}/${form.count}` };
        try {
          pick.productId = await listProduct(pick, done < 8);
          pick.status = "done";
          done++;
        } catch (e) {
          if (!(e instanceof Skip || e instanceof PermanentError)) throw e; // 网络等临时错误：保存进度后重试
          pick.status = "skipped";
          pick.reason = e.message;
          ctx.emit("warn", { message: `跳过商品 ${pick.pid}（${pick.name.slice(0, 40)}）：${e.message}` });
        } finally {
          ctx.save("picks_json", JSON.stringify(picks));
        }
        if (pick.status === "done") ctx.emit("ai_text", { task: "上架商品", preview: `已上架 ${done}/${form.count}：${pick.name.slice(0, 60)}` });
      }
      if (done === 0) throw new PermanentError("一个商品都没有上架成功，看日志里跳过的原因");
      return { status: "done", detail: done < form.count ? `上架 ${done} 个（目标 ${form.count}，合适的候选不够）` : `上架 ${done} 个商品` };
    },

    async qa() {
      const report = await runQa(ctx);
      ctx.save("qa_json", JSON.stringify(report));
      const blocking = report.checks.filter((c) => c.level === "block" && !c.ok);
      const warnings = report.checks.filter((c) => c.level === "warn" && !c.ok);
      if (blocking.length) throw new PermanentError(`QA 有 ${blocking.length} 项没通过：${blocking.map((c) => c.name).join("、")}`);
      return { status: "done", detail: `${report.checks.filter((c) => c.ok).length}/${report.checks.length} 项通过${warnings.length ? `，${warnings.length} 个提醒` : ""}` };
    },
  };
}

async function runQa(ctx: StepCtx): Promise<QaReport> {
  const { wp } = ctx;
  const f = facts(ctx);
  const checks: QaCheck[] = [];
  const add = (id: string, name: string, level: QaCheck["level"], ok: boolean, detail: string) => checks.push({ id, name, level, ok, detail });
  // 检查时站点明确拒绝（权限、接口不存在）记为没通过；网络超时等临时错误往外抛，由任务队列稍后重跑 QA
  const attempt = async (id: string, name: string, level: QaCheck["level"], fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof PermanentError)) throw e;
      add(id, name, level, false, `检查本身出错：${e.message}`);
    }
  };
  const decode = (s: string) => s.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n))).replace(/&nbsp;/g, " ");

  // 页面：流水线建的 8 个 + Woo 自带的 4 个（页眉页脚都链接到这些地址）
  const slugs = [...PAGE_SLUGS, "shop", "cart", "checkout", "my-account"];
  const pages = (await wp("GET", `wp/v2/pages?slug=${slugs.join(",")}&per_page=50&_fields=id,slug,status,content`)) as { id: number; slug: string; status: string; content: { rendered: string } }[];
  const bySlug = new Map(pages.filter((p) => p.status === "publish").map((p) => [p.slug, p]));
  const missing = slugs.filter((s) => !bySlug.has(s));
  add("pages", "必需页面都已发布", "block", missing.length === 0, missing.length ? `缺少：${missing.join(", ")}` : `${slugs.length} 个页面`);

  await attempt("site", "首页、隐私页和联系方式已设置", "block", async () => {
    const s = (await wp("GET", "site-agent/v1/site")) as { options: Record<string, unknown>; info: Record<string, string> };
    const problems = [
      s.options.show_on_front !== "page" || Number(s.options.page_on_front) !== bySlug.get("home")?.id ? "首页没设成「Home」页面" : "",
      Number(s.options.wp_page_for_privacy_policy) !== bySlug.get("privacy-policy")?.id ? "隐私政策页没设置" : "",
      !s.info.email || !s.info.phone || !s.info.address ? "页脚联系方式不全" : "",
    ].filter(Boolean);
    add("site", "首页、隐私页和联系方式已设置", "block", problems.length === 0, problems.join("；") || "页脚显示邮箱、电话、地址");
    add("noindex", "建站期间不让搜索引擎收录", "warn", Number(s.options.blog_public) === 0, Number(s.options.blog_public) === 0 ? "上线时再打开" : "搜索引擎收录是开着的");
  });

  const policyHtml = (slug: string) => decode(bySlug.get(slug)?.content.rendered ?? "");
  const pol: Policies = { shipping: policyHtml("shipping"), returns: policyHtml("returns"), privacy: policyHtml("privacy-policy"), terms: policyHtml("terms") };
  const policyProblems = checkPolicies(pol, f);
  add("policies", "政策页写明了运费、时效、退货和联系方式", "block", policyProblems.length === 0, policyProblems.slice(0, 5).join("; ") || "和表单及默认规则一致");

  const products = (await wp("GET", "wc/store/v1/products?per_page=100")) as {
    id: number; name: string; type: string; permalink: string; description: string; short_description: string;
    images: unknown[]; variations?: { id: number }[]; prices: { price: string; currency_minor_unit: number; price_range?: { min_amount: string; max_amount: string } | null };
  }[];
  const money = (p: (typeof products)[number], v: string) => Number(v) / 10 ** p.prices.currency_minor_unit;
  const badProducts = products.filter((p) => {
    const [min, max] = p.prices.price_range ? [money(p, p.prices.price_range.min_amount), money(p, p.prices.price_range.max_amount)] : [money(p, p.prices.price), money(p, p.prices.price)];
    return p.images.length === 0 || !(min > 0) || (ctx.form.priceMin != null && min < ctx.form.priceMin) || (ctx.form.priceMax != null && max > ctx.form.priceMax);
  });
  add("products", "商品有图、有价格且在售价区间内", "block", products.length > 0 && badProducts.length === 0,
    products.length === 0 ? "店里没有商品" : badProducts.length ? `有问题的商品：${badProducts.map((p) => p.name).slice(0, 5).join("、")}` : `${products.length} 个商品`);
  add("count", "商品数量达到目标", "warn", products.length >= ctx.form.count, `${products.length}/${ctx.form.count}`);

  const claimText = [...[...bySlug.values()].map((p) => p.content.rendered), ...products.flatMap((p) => [p.name, p.description, p.short_description])].join("\n");
  const claims = claimProblems(decode(claimText));
  add("claims", "没有虚构或无法证实的宣传", "block", claims.length === 0, claims.slice(0, 5).join("; ") || "页面和商品文案都检查过");

  await attempt("shipping", "运费设置", "block", async () => {
    const zone = ((await wp("GET", "wc/v3/shipping/zones")) as { id: number; name: string }[]).find((z) => z.name === ZONE);
    const methods = zone ? ((await wp("GET", `wc/v3/shipping/zones/${zone.id}/methods`)) as { method_id: string; enabled: boolean }[]) : [];
    const has = (id: string) => methods.some((m) => m.method_id === id && m.enabled);
    add("shipping", "运费设置", "block", has("free_shipping") && has("flat_rate"), zone ? `满 $${RULES.freeShippingOver} 包邮 / $${RULES.flatRate}` : "没有配送区域");
  });

  await attempt("currency", "币种为美元", "block", async () => {
    const c = (await wp("GET", "wc/v3/settings/general/woocommerce_currency")) as { value: string };
    add("currency", "币种为美元", "block", c.value === "USD", c.value);
  });

  await attempt("ssl", "SSL 证书有效", "block", async () => {
    const ssl = (await ctx.hx("hosting_ssl_status", { username: ctx.site.hostinger_username, domain: ctx.domain })) as { status?: string };
    add("ssl", "SSL 证书有效", "block", ssl.status === "active", ssl.status ?? "未知");
  });

  await attempt("payments", "已连接支付方式", "warn", async () => {
    const gateways = (await wp("GET", "wc/v3/payment_gateways")) as { id: string; enabled: boolean }[];
    const on = gateways.filter((g) => g.enabled).map((g) => g.id);
    add("payments", "已连接支付方式", "warn", on.length > 0, on.length ? on.join(", ") : "待你操作：在 WooCommerce 里连接 Stripe 和 PayPal（需要你本人登录授权）");
  });

  // 客服邮箱和邮件 DNS 只提醒不阻断：站点能卖货，但邮件收发会出问题
  const mail = await mailStatus(ctx);
  if (mail.onDomain) {
    add("mailbox", "客服邮箱能收信", "warn", mail.mailbox === "active",
      !mail.hasOrder ? `${f.domain} 没有 Hostinger 邮箱订单，${f.email} 收不到邮件` : !mail.mailbox ? `${f.email} 还没有创建` : mail.mailbox === "active" ? f.email : `${f.email} 状态是 ${mail.mailbox}`);
    if (mail.dns) {
      const bad = mail.dns.checks.filter((c) => !c.ok);
      add("mail_dns", "邮件 DNS（MX、SPF、DKIM、DMARC）", "warn", bad.length === 0,
        bad.length ? bad.map((c) => `${c.key}：${c.detail}`).join("；") + "。到站点页点「检查并修复」" : "四项都正确");
    }
  }
  add("images", "商品图片版权", "warn", false, "图片来自 CJ 商品资料，正式上线前建议换成供应商授权或自己拍摄的图片");

  // 浏览器里看一遍：管理员登录后绕过维护模式，截图首页、商品列表、商品页，并把一个商品加入购物车走到结账页
  const shots: QaReport["shots"] = [];
  if (!ctx.d.browse) {
    add("render", "页面能正常显示并能加购到结账", "warn", false, "这台电脑上没有可用的浏览器，跳过了页面截图");
  } else {
    await attempt("render", "页面能正常显示并能加购到结账", "block", async () => {
      const links = (await ctx.hx("wordpress_login_create-links", { username: ctx.site.hostinger_username, software: ctx.site.wp_software_id })) as { login: string };
      const first = products[0];
      const { copy } = spec(ctx);
      const r = await ctx.d.browse!({
        loginUrl: `https://${links.login.replace(/^https?:\/\//, "")}`,
        origin: `https://${ctx.domain}`,
        outDir: join(ctx.d.workDir, "qa", ctx.domain),
        pages: [
          { name: "home", path: "/", expect: copy.hero.heading },
          { name: "shop", path: "/shop/", expect: first?.name },
          ...(first ? [{ name: "product", path: new URL(first.permalink).pathname, expect: first.name }] : []),
          { name: "contact", path: "/contact/", expect: f.email },
        ],
        cart: first ? { addPath: `/?add-to-cart=${first.variations?.[0]?.id ?? first.id}`, expect: first.name } : undefined,
      }).catch((e: Error) => {
        if (e instanceof BrowserUnavailable) return null;
        throw e;
      });
      if (!r) {
        add("render", "页面能正常显示并能加购到结账", "warn", false, "这台电脑上启动不了 Edge，跳过了页面截图");
        return;
      }
      shots.push(...r.shots);
      add("render", "页面能正常显示并能加购到结账", "block", r.problems.length === 0, r.problems.join("；") || `${r.shots.length} 张截图`);
    });
  }
  return { at: ctx.d.now(), checks, shots };
}
