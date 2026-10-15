// pi 改站点内容用的工具。L0 只读；L1 直接执行，但每次都先拍快照记成变更集，可整体回滚（方案 4.7 / 4.8）。
// 文案和政策仍然存在 spec_json 里，页面由代码按它重新渲染，所以事实核对、禁用说法检查和建站时完全一样。
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { range, RULES } from "../shared/rules.ts";
import { applyChange, listChanges, revertChange, scheduleRevert, type MetadataTargetType, type Target } from "./changes.ts";
import { buildPages, checkCopy, checkPolicies, claimProblems, cleanHtml, STYLES, type Policies, type SiteCopy, type Style } from "./content.ts";
import type { StepCtx } from "./pipeline.ts";
import { facts } from "./store.ts";
import { buildAiHomepage, type CategoryDesign, type DesignProduct, type HomepageDesign } from "./home-design.ts";
import { splitVariants, type CjProduct } from "./cj.ts";
import { checkProductAnalysis, unitReviewCopyProblems, type ProductAnalysis, type UnitReview } from "./product-content.ts";

export interface SiteTool {
  name: string;
  /** L0 只读，L1 自动执行 + 快照 */
  risk: "L0" | "L1";
  description: string;
  parameters: TSchema;
  run: (params: any) => Promise<Record<string, unknown>>;
}

interface Spec { copy: SiteCopy; policies: Policies; design?: { completed: boolean; categories: CategoryDesign[]; home: HomepageDesign; products?: DesignProduct[] } }
const POLICY_SLUG = { shipping: "shipping", returns: "returns", privacy: "privacy-policy", terms: "terms" } as const;
const summary = Type.String({ description: "一句中文，说明这次改了什么（会显示在变更记录里）" });
const metadataTargetTypes = ["home", "shop", "page", "product", "product_cat"] as const;
interface ProductSource { product: CjProduct; analysis: ProductAnalysis; unitReview: UnitReview }
const sourceValue = (value: unknown): ProductSource | undefined => {
  try { return (typeof value === "string" ? JSON.parse(value) : value) as ProductSource; } catch { return undefined; }
};
const words = (value: string) => new Set(value.toLowerCase().replace(/<[^>]+>/g, " ").match(/[a-z0-9]+/g) ?? []);
const onlyRemovesFacts = (before: string, after: string) => {
  const old = words(before);
  return [...words(after)].every((word) => old.has(word));
};
/** 本地时间 "2026-12-01 00:00"，给模型和人看的都是这个格式 */
export const localTime = (ts: number) => {
  const t = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
};

export function siteTools(ctx: StepCtx): SiteTool[] {
  const { wp, d } = ctx;
  const spec = (): Spec => {
    if (!ctx.site.spec_json) throw new Error("这个站还没有生成文案");
    return JSON.parse(ctx.site.spec_json) as Spec;
  };
  const changed = (id: number | null, what: string) => (id === null ? { ok: true, change_id: null, note: "内容和现在一样，没有修改" } : { ok: true, change_id: id, note: `${what}，已记录为变更 #${id}，可以回滚` });
  const pageEdit = (slug: string, c: SiteCopy, p: Policies): { target: Target; patch: Record<string, unknown> } => {
    if (slug === "home") {
      const design = spec().design;
      if (design?.completed && design.products?.length) {
        const home = { ...design.home, heading: c.hero.heading, subheading: c.hero.subheading };
        return { target: { kind: "page", slug }, patch: { title: "Home", content: buildAiHomepage(home, design.products, design.categories) } };
      }
    }
    const page = buildPages(c, p, facts(ctx)).find((x) => x.slug === slug)!;
    return { target: { kind: "page", slug }, patch: { title: page.title, content: page.content } };
  };
  const designEdits = (mutate: (design: NonNullable<Spec["design"]>) => boolean): { target: Target; patch: Record<string, unknown> }[] => {
    if (!ctx.site.spec_json) return [];
    const current = spec(), design = current.design;
    if (!design?.completed || !design.products?.length) return [];
    const next = structuredClone(design);
    if (!mutate(next)) return [];
    const home = { ...next.home, heading: current.copy.hero.heading, subheading: current.copy.hero.subheading };
    return [
      { target: { kind: "spec" }, patch: { design: next } },
      { target: { kind: "page", slug: "home" }, patch: { title: "Home", content: buildAiHomepage(home, next.products!, next.categories) } },
    ];
  };

  return [
    {
      name: "get_site", risk: "L0",
      description: "Store overview: name, tagline, announcement bar, contact details, pages, product count, style, store rules (shipping/returns, fixed) and the latest changes. Call this first.",
      parameters: Type.Object({}),
      run: async () => {
        const s = (await wp("GET", "site-agent/v1/site")) as { options: Record<string, unknown>; info: Record<string, string> };
        const pages = (await wp("GET", "wp/v2/pages?per_page=50&_fields=slug,title")) as { slug: string; title: { rendered: string } }[];
        const products = (await wp("GET", "wc/v3/products?per_page=100&_fields=id")) as unknown[];
        const f = facts(ctx);
        return {
          ok: true, domain: ctx.domain, name: s.options.blogname, tagline: s.options.blogdescription, launched: Boolean(ctx.site.launched_at),
          announcement: s.info.announcement, contact: { operator: s.info.entity, email: s.info.email, phone: s.info.phone, address: s.info.address },
          pages: pages.map((p) => ({ slug: p.slug, title: p.title.rendered })), product_count: products.length, styles_available: STYLES,
          rules: {
            processing: `${range(f.entity.processingDays)} business days`, transit: `${range(f.entity.transitDays)} business days`, region: RULES.region,
            free_shipping_over: RULES.freeShippingOver, flat_rate: RULES.flatRate, return_days: RULES.returnDays, refund: `${range(RULES.refundDays)} business days`,
          },
          recent_changes: listChanges(d.db, ctx.site.id, 5).map((c) => ({ id: c.id, summary: c.summary, status: c.status })),
        };
      },
    },
    {
      name: "get_copy", risk: "L0",
      description: "Current site copy: tagline, home hero heading and subheading, About paragraphs (the first also appears on the home page) and the FAQ.",
      parameters: Type.Object({}),
      run: async () => ({ ok: true, copy: spec().copy }),
    },
    {
      name: "get_policy", risk: "L0",
      description: "Current HTML of one policy page.",
      parameters: Type.Object({ name: Type.Union([Type.Literal("shipping"), Type.Literal("returns"), Type.Literal("privacy"), Type.Literal("terms")]) }),
      run: async ({ name }: { name: keyof Policies }) => ({ ok: true, html: spec().policies[name] }),
    },
    {
      name: "list_products", risk: "L0",
      description: "Products with id, name, price and status. Optional search text.",
      parameters: Type.Object({ search: Type.Optional(Type.String()) }),
      run: async ({ search }: { search?: string }) => ({
        ok: true,
        products: await wp("GET", `wc/v3/products?per_page=50&_fields=id,name,price,status${search ? `&search=${encodeURIComponent(search)}` : ""}`),
      }),
    },
    {
      name: "get_product", risk: "L0",
      description: "One product's name, short description and description HTML.",
      parameters: Type.Object({ id: Type.Integer() }),
      run: async ({ id }: { id: number }) => ({ ok: true, product: await wp("GET", `wc/v3/products/${id}?_fields=id,name,price,short_description,description,permalink`) }),
    },
    {
      name: "list_changes", risk: "L0",
      description: "Recent changes to this store (newest first), with status and scheduled revert time.",
      parameters: Type.Object({}),
      run: async () => ({
        ok: true,
        changes: listChanges(d.db, ctx.site.id, 20).map((c) => ({ id: c.id, summary: c.summary, status: c.status, targets: c.targets, revert_at: c.revertAt && new Date(c.revertAt).toISOString() })),
      }),
    },
    {
      name: "update_copy", risk: "L1",
      description: "Change the tagline, home hero, About paragraphs or FAQ. Pass only the fields to change; about and faq replace the whole list. Applied immediately and recorded as a change that can be reverted. The text is checked against the store facts and banned claims.",
      parameters: Type.Object({
        summary,
        tagline: Type.Optional(Type.String()),
        hero_heading: Type.Optional(Type.String()),
        hero_subheading: Type.Optional(Type.String()),
        about: Type.Optional(Type.Array(Type.String())),
        faq: Type.Optional(Type.Array(Type.Object({ q: Type.String(), a: Type.String() }))),
      }),
      run: async (p: { summary: string; tagline?: string; hero_heading?: string; hero_subheading?: string; about?: string[]; faq?: { q: string; a: string }[] }) => {
        const { copy, policies } = spec();
        const next: SiteCopy = {
          ...copy,
          tagline: p.tagline ?? copy.tagline,
          hero: { heading: p.hero_heading ?? copy.hero.heading, subheading: p.hero_subheading ?? copy.hero.subheading },
          about: p.about ?? copy.about,
          faq: p.faq ?? copy.faq,
        };
        const problems = checkCopy(next, facts(ctx));
        if (problems.length) return { ok: false, problems };
        const id = await applyChange(ctx, p.summary, [
          pageEdit("home", next, policies), pageEdit("about", next, policies), pageEdit("faq", next, policies),
          { target: { kind: "site" }, patch: { tagline: next.tagline } },
          { target: { kind: "spec" }, patch: { copy: next } },
        ]);
        return changed(id, "文案已更新");
      },
    },
    {
      name: "update_policy", risk: "L1",
      description: "Replace one policy page (simple HTML: h2, h3, p, ul, li, strong, a). Shipping/returns numbers, the support email and the operator name must stay exactly as in the store rules.",
      parameters: Type.Object({ summary, name: Type.Union([Type.Literal("shipping"), Type.Literal("returns"), Type.Literal("privacy"), Type.Literal("terms")]), html: Type.String() }),
      run: async (p: { summary: string; name: keyof Policies; html: string }) => {
        const { copy, policies } = spec();
        const next = { ...policies, [p.name]: p.html };
        const problems = checkPolicies(next, facts(ctx));
        if (problems.length) return { ok: false, problems };
        const id = await applyChange(ctx, p.summary, [pageEdit(POLICY_SLUG[p.name], copy, next), { target: { kind: "spec" }, patch: { policies: next } }]);
        return changed(id, "政策页已更新");
      },
    },
    {
      name: "update_announcement", risk: "L1",
      description: "Change the announcement bar text at the top of every page (max 90 characters), for example a promotion.",
      parameters: Type.Object({ summary, text: Type.String() }),
      run: async (p: { summary: string; text: string }) => {
        const text = p.text.trim();
        const problems = [...(text.length === 0 || text.length > 90 ? ["text must be 1-90 characters"] : []), ...claimProblems(text)];
        if (problems.length) return { ok: false, problems };
        const { info } = (await wp("GET", "site-agent/v1/site")) as { info: Record<string, string> };
        const id = await applyChange(ctx, p.summary, [{ target: { kind: "site" }, patch: { info: { ...info, announcement: text } } }]);
        return changed(id, "公告栏已更新");
      },
    },
    {
      name: "update_style", risk: "L1",
      description: `Switch the store's visual style to one of the theme presets: ${STYLES.join(", ")}.`,
      parameters: Type.Object({ summary, style: Type.Union(STYLES.map((s) => Type.Literal(s))) }),
      run: async (p: { summary: string; style: Style }) => {
        let state = { styles: {}, settings: {} };
        if (p.style !== "default") {
          const [theme] = (await wp("GET", "wp/v2/themes?status=active")) as { stylesheet: string }[];
          const v = ((await wp("GET", `wp/v2/global-styles/themes/${theme.stylesheet}/variations`)) as { title?: string; styles?: object; settings?: object }[])
            .find((x) => x.title?.toLowerCase() === p.style);
          if (!v) return { ok: false, problems: [`style ${p.style} is not available`] };
          state = { styles: v.styles ?? {}, settings: v.settings ?? {} };
        }
        const id = await applyChange(ctx, p.summary, [{ target: { kind: "styles" }, patch: state }]);
        return changed(id, `风格已切换为 ${p.style}`);
      },
    },
    {
      name: "update_product", risk: "L1",
      description: "Change a product's name, short description or description HTML (p, ul, li, strong, em). Prices cannot be changed here.",
      parameters: Type.Object({
        summary, id: Type.Integer(),
        name: Type.Optional(Type.String()), short_description: Type.Optional(Type.String()), description_html: Type.Optional(Type.String()),
      }),
      run: async (p: { summary: string; id: number; name?: string; short_description?: string; description_html?: string }) => {
        const current = (await wp("GET", `wc/v3/products/${p.id}?_fields=id,name,short_description,description,meta_data`)) as {
          name: string; short_description: string; description: string; meta_data?: { key: string; value: unknown }[];
        };
        const patch: Record<string, string> = {};
        if (p.name !== undefined) patch.name = p.name.trim();
        if (p.short_description !== undefined) patch.short_description = cleanHtml(p.short_description);
        if (p.description_html !== undefined) patch.description = cleanHtml(p.description_html);
        const problems = [...(patch.name !== undefined && (patch.name.length === 0 || patch.name.length > 80) ? ["name must be 1-80 characters"] : []), ...claimProblems(Object.values(patch).join("\n"))];
        const picks = JSON.parse(ctx.site.picks_json ?? "[]") as { productId?: number; source?: ProductSource }[];
        const source = sourceValue(current.meta_data?.find((x) => x.key === "_source_cj_facts")?.value)
          ?? picks.find((x) => x.productId === p.id)?.source;
        if (source?.product && source.analysis && source.unitReview) {
          const attrs = splitVariants(source.product.keyNames, source.product.variants.map((v) => v.key));
          const analyzedKeys = new Set(source.analysis.variants.map((v) => v.sourceKey));
          const inputs = source.product.variants.map((variant, i) => ({ ...variant, attrs: attrs[i] })).filter((v) => analyzedKeys.has(v.key));
          const next: ProductAnalysis = {
            ...source.analysis,
            title: patch.name ?? current.name,
            short_description: patch.short_description ?? current.short_description,
            description_html: patch.description ?? current.description,
            // 当前商品 description 已经是合并后的最终正文，不能把原材料段重复拼一次。
            materials_and_care_html: null,
          };
          problems.push(...checkProductAnalysis(next, source.product, inputs), ...unitReviewCopyProblems(source.unitReview, next, inputs));
        } else {
          // 老站没有 CJ 快照时只允许删除/收紧现有文字，不能凭模型加入任何新事实。
          if (patch.name !== undefined && !onlyRemovesFacts(current.name, patch.name)) problems.push("source facts are missing; product name may only remove existing words");
          if (patch.short_description !== undefined && !onlyRemovesFacts(current.short_description, patch.short_description)) problems.push("source facts are missing; short description may only remove existing words");
          if (patch.description !== undefined && !onlyRemovesFacts(current.description, patch.description)) problems.push("source facts are missing; description may only remove existing words");
        }
        if (problems.length) return { ok: false, problems };
        const linked = patch.name === undefined ? [] : designEdits((design) => {
          const item = design.products?.find((x) => x.id === p.id);
          if (!item || item.name === patch.name) return false;
          item.name = patch.name!;
          return true;
        });
        const id = await applyChange(ctx, p.summary, [{ target: { kind: "product", id: p.id }, patch }, ...linked]);
        return changed(id, `商品 #${p.id} 已更新`);
      },
    },
    {
      name: "update_product_main_image", risk: "L1",
      description: "Choose one of a product's existing gallery images as its main image. The image id must already belong to this product.",
      parameters: Type.Object({ summary, id: Type.Integer(), image_id: Type.Integer() }),
      run: async (p: { summary: string; id: number; image_id: number }) => {
        const product = (await wp("GET", `wc/v3/products/${p.id}?_fields=id,images`)) as { images?: { id: number; src?: string; alt?: string }[] };
        const images = product.images ?? [];
        const selected = images.find((x) => x.id === p.image_id);
        if (!selected) return { ok: false, problems: [`image ${p.image_id} does not belong to product ${p.id}`] };
        const ordered = [selected, ...images.filter((x) => x.id !== p.image_id)];
        const linked = selected.src ? designEdits((design) => {
          const item = design.products?.find((x) => x.id === p.id);
          if (!item || item.image === selected.src) return false;
          item.image = selected.src!;
          return true;
        }) : [];
        const id = await applyChange(ctx, p.summary, [{ target: { kind: "product", id: p.id }, patch: { images: ordered } }, ...linked], "pi");
        return changed(id, `商品 #${p.id} 主图已更新`);
      },
    },
    {
      name: "update_product_categories", risk: "L1",
      description: "Replace a product's use-based categories with existing WooCommerce category ids.",
      parameters: Type.Object({ summary, id: Type.Integer(), category_ids: Type.Array(Type.Integer(), { minItems: 1, maxItems: 8 }) }),
      run: async (p: { summary: string; id: number; category_ids: number[] }) => {
        const ids = [...new Set(p.category_ids)];
        if (ids.length === 0 || ids.length > 8) return { ok: false, problems: ["category_ids must contain 1-8 ids"] };
        const all = (await wp("GET", "wc/v3/products/categories?per_page=100&hide_empty=false&_fields=id,slug")) as { id: number; slug?: string }[];
        const missing = ids.filter((id) => !all.some((x) => x.id === id));
        if (missing.length) return { ok: false, problems: [`unknown category ids: ${missing.join(", ")}`] };
        const selectedSlugs = new Set(all.filter((x) => ids.includes(x.id)).map((x) => x.slug).filter((x): x is string => Boolean(x)));
        const knownSlugs = new Set(all.map((x) => x.slug).filter((x): x is string => Boolean(x)));
        const linked = designEdits((design) => {
          const designSlugs = new Set(design.categories.map((x) => x.slug));
          if (![...selectedSlugs].some((x) => designSlugs.has(x))) return false;
          let changed = false;
          for (const category of design.categories) {
            if (!knownSlugs.has(category.slug)) continue;
            const has = category.productIds.includes(p.id), wants = selectedSlugs.has(category.slug);
            if (wants && !has) { category.productIds.push(p.id); changed = true; }
            if (!wants && has) { category.productIds = category.productIds.filter((x) => x !== p.id); changed = true; }
          }
          const empty = new Set(design.categories.filter((x) => x.productIds.length === 0).map((x) => x.slug));
          if (empty.size) {
            design.categories = design.categories.filter((x) => !empty.has(x.slug));
            design.home.categorySlugs = design.home.categorySlugs.filter((x) => !empty.has(x));
          }
          return changed;
        });
        const id = await applyChange(ctx, p.summary, [{ target: { kind: "product", id: p.id }, patch: { categories: ids.map((x) => ({ id: x })) } }, ...linked], "pi");
        return changed(id, `商品 #${p.id} 分类已更新`);
      },
    },
    {
      name: "update_meta", risk: "L1",
      description: "Write an accurate, unique meta description and OG description for a home, shop, page, product or product category target.",
      parameters: Type.Object({
        summary,
        target_type: Type.Union(metadataTargetTypes.map((x) => Type.Literal(x))), target_id: Type.Integer(),
        description: Type.String({ minLength: 50, maxLength: 180 }), og_description: Type.String({ minLength: 50, maxLength: 220 }),
      }),
      run: async (p: { summary: string; target_type: MetadataTargetType; target_id: number; description: string; og_description: string }) => {
        const description = p.description.trim(), og = p.og_description.trim();
        const problems = [
          ...(description.length < 50 || description.length > 180 ? ["description must be 50-180 characters"] : []),
          ...(og.length < 50 || og.length > 220 ? ["og_description must be 50-220 characters"] : []),
          ...claimProblems(`${description}\n${og}`),
        ];
        if (problems.length) return { ok: false, problems };
        const id = await applyChange(ctx, p.summary, [{
          target: { kind: "metadata", targetType: p.target_type, targetId: p.target_id },
          patch: { description, og_description: og },
        }], "pi");
        return changed(id, `${p.target_type} #${p.target_id} 摘要已更新`);
      },
    },
    {
      name: "revert_change", risk: "L1",
      description: "Undo a change by id, restoring the snapshot taken before it. Fails if the same content was changed again afterwards (revert the later change first).",
      parameters: Type.Object({ change_id: Type.Integer() }),
      run: async ({ change_id }: { change_id: number }) => {
        await revertChange(ctx, change_id);
        return { ok: true, note: `变更 #${change_id} 已回滚` };
      },
    },
    {
      name: "schedule_revert", risk: "L1",
      description: "Schedule a change to be reverted automatically, for example to end a promotion. `at` is the owner's local date and time as \"YYYY-MM-DD HH:mm\" (the computer's time zone; do not convert time zones). Runs when the app is open; if the computer was off, it runs right after the app starts.",
      parameters: Type.Object({ change_id: Type.Integer(), at: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$" }) }),
      run: async ({ change_id, at }: { change_id: number; at: string }) => {
        const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(at.trim());
        // 按这台电脑的本地时间解析，时区换算交给代码，不让模型算
        const when = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime() : Number.NaN;
        if (!Number.isFinite(when) || when <= d.now()) return { ok: false, problems: ['at must be a future local time written as "YYYY-MM-DD HH:mm"'] };
        scheduleRevert(d.db, ctx.site.id, change_id, when);
        return { ok: true, note: `变更 #${change_id} 将在本地时间 ${localTime(when)} 自动回滚` };
      },
    },
  ];
}
