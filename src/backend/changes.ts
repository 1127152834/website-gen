// 内容变更集：每次修改前先读出线上的当前内容（快照），再写入新内容，写完重新读一遍作为「改之后」，一起记成一条变更。
// 回滚时先确认内容在这之后没被别的修改动过，再把快照写回去。改到一半出错，已经写入的部分立即还原。
import type { DatabaseSync } from "node:sqlite";
import type { ChangeSummary } from "../shared/protocol.ts";
import type { StepCtx } from "./pipeline.ts";

export type MetadataTargetType = "home" | "shop" | "page" | "product" | "product_cat";
export type Target =
  | { kind: "page"; slug: string }
  | { kind: "site" }
  | { kind: "styles" }
  | { kind: "product"; id: number }
  | { kind: "metadata"; targetType: MetadataTargetType; targetId: number }
  | { kind: "spec" };

type State = Record<string, unknown>;
interface Op { target: Target; before: State; after: State }


export const targetLabel = (t: Target) =>
  t.kind === "page" ? `页面 /${t.slug}/` : t.kind === "site" ? "站点标语与页脚信息" : t.kind === "styles" ? "全局样式"
  : t.kind === "product" ? `商品 #${t.id}` : t.kind === "metadata" ? `SEO ${t.targetType} #${t.targetId}` : "文案底稿";

/** 键顺序无关的比较（WordPress 返回的 JSON 键顺序可能和写入时不同） */
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as State)[k])}`).join(",")}}`
  : JSON.stringify(v ?? null);
export const same = (a: unknown, b: unknown) => stable(a) === stable(b);

async function userStylesId(ctx: StepCtx): Promise<string> {
  const [theme] = (await ctx.wp("GET", "wp/v2/themes?status=active")) as { _links?: Record<string, { href: string }[]> }[];
  const id = /global-styles\/(\d+)/.exec(theme?._links?.["wp:user-global-styles"]?.[0]?.href ?? "")?.[1];
  if (!id) throw new Error("找不到全局样式");
  return id;
}

async function read(ctx: StepCtx, t: Target): Promise<State> {
  switch (t.kind) {
    case "page": {
      // 隐私政策页店长在 REST 里看不到，走伴侣插件
      if (t.slug === "privacy-policy") return (await ctx.wp("GET", "site-agent/v1/privacy-page")) as State;
      const [p] = (await ctx.wp("GET", `wp/v2/pages?slug=${t.slug}&status=publish,draft,private&context=edit&_fields=id,title,content`)) as { id: number; title: { raw: string }; content: { raw: string } }[];
      if (!p) throw new Error(`页面 /${t.slug}/ 不存在`);
      return { id: p.id, title: p.title.raw, content: p.content.raw };
    }
    case "site": {
      const s = (await ctx.wp("GET", "site-agent/v1/site")) as { options: { blogdescription: string }; info: State };
      return { tagline: s.options.blogdescription, info: s.info };
    }
    case "styles": {
      const g = (await ctx.wp("GET", `wp/v2/global-styles/${await userStylesId(ctx)}?context=edit`)) as { styles?: unknown; settings?: unknown };
      return { styles: g.styles ?? {}, settings: g.settings ?? {} };
    }
    case "product": {
      const p = (await ctx.wp("GET", `wc/v3/products/${t.id}`)) as {
        name: string; short_description: string; description: string;
        images?: { id: number; src?: string; alt?: string }[]; categories?: { id: number; name?: string; slug?: string }[];
      };
      return {
        name: p.name, short_description: p.short_description, description: p.description,
        images: p.images ?? [], categories: p.categories ?? [],
      };
    }
    case "metadata":
      return (await ctx.wp("GET", `site-agent/v1/metadata?target_type=${t.targetType}&target_id=${t.targetId}`)) as State;
    case "spec":
      return JSON.parse(ctx.site.spec_json ?? "{}") as State;
  }
}

async function write(ctx: StepCtx, t: Target, s: State): Promise<void> {
  switch (t.kind) {
    case "page":
      if (t.slug === "privacy-policy") await ctx.wp("POST", "site-agent/v1/privacy-page", { title: s.title, content: s.content });
      else await ctx.wp("POST", `wp/v2/pages/${s.id}`, { title: s.title, content: s.content });
      return;
    case "site":
      await ctx.wp("POST", "site-agent/v1/site", { options: { blogdescription: s.tagline }, info: s.info });
      return;
    case "styles":
      await ctx.wp("POST", `wp/v2/global-styles/${await userStylesId(ctx)}`, { styles: s.styles, settings: s.settings });
      return;
    case "product":
      await ctx.wp("PUT", `wc/v3/products/${t.id}`, s);
      return;
    case "metadata":
      await ctx.wp("POST", "site-agent/v1/metadata", {
        target_type: t.targetType, target_id: t.targetId,
        description: s.description, og_description: s.og_description,
      });
      return;
    case "spec":
      ctx.save("spec_json", JSON.stringify(s));
  }
}

/**
 * 应用一组修改（每项是对某个对象的部分字段覆盖），记成一条变更集。没有任何实际变化时返回 null。
 */
export async function applyChange(
  ctx: StepCtx, summary: string, edits: { target: Target; patch: State }[], initiator: ChangeSummary["initiator"] = "pi",
): Promise<number | null> {
  const ops: Op[] = [];
  try {
    for (const { target, patch } of edits) {
      const before = await read(ctx, target);
      const wanted = { ...before, ...patch };
      if (same(before, wanted)) continue;
      // 先登记恢复点再写：即使写成功后的核验读取失败，这一项也会进入 catch 回滚。
      const op: Op = { target, before, after: wanted };
      ops.push(op);
      await write(ctx, target, wanted);
      // 以写入后的实际内容为准：WordPress 保存时会过滤 HTML
      op.after = await read(ctx, target);
    }
    if (ops.length === 0) return null;
    // DB 记录也是事务的一部分；插入失败时不能把已经写到 WordPress 的内容留在外面。
    const id = (ctx.d.db.prepare("INSERT INTO changesets (site_id, summary, initiator, ops_json, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .get(ctx.site.id, summary, initiator, JSON.stringify(ops), ctx.d.now()) as { id: number }).id;
    ctx.emit("ai_tool", { change: id, summary, targets: ops.map((o) => targetLabel(o.target)) });
    return id;
  } catch (e) {
    for (const op of ops.reverse()) await write(ctx, op.target, op.before).catch(() => {});
    throw e;
  }
}

export async function revertChange(ctx: StepCtx, changeId: number): Promise<void> {
  const db = ctx.d.db;
  const row = db.prepare("SELECT ops_json, status FROM changesets WHERE id = ? AND site_id = ?").get(changeId, ctx.site.id) as { ops_json: string; status: string } | undefined;
  if (!row) throw new Error(`没有变更 #${changeId}`);
  if (row.status !== "applied") throw new Error(`变更 #${changeId} 已经回滚过了`);
  const ops = JSON.parse(row.ops_json) as Op[];
  // 之后又被改过的对象不覆盖，免得把更新的修改一起冲掉
  for (const op of ops) {
    if (!same(await read(ctx, op.target), op.after)) {
      throw new Error(`「${targetLabel(op.target)}」在变更 #${changeId} 之后又被改过，不能直接回滚；先回滚更晚的变更，或在后台手动改回`);
    }
  }
  for (const op of [...ops].reverse()) await write(ctx, op.target, op.before);
  db.prepare("UPDATE changesets SET status = 'reverted', reverted_at = ?, revert_error = NULL WHERE id = ?").run(ctx.d.now(), changeId);
}

export function scheduleRevert(db: DatabaseSync, siteId: number, changeId: number, at: number | null): void {
  const r = db.prepare("UPDATE changesets SET revert_at = ? WHERE id = ? AND site_id = ? AND status = 'applied'").run(at, changeId, siteId);
  if (r.changes === 0) throw new Error(`变更 #${changeId} 不存在或已经回滚`);
}

/** 到期的定时恢复（关机期间错过的，开机后马上补上） */
export const dueReverts = (db: DatabaseSync, now: number) =>
  db.prepare("SELECT id, site_id FROM changesets WHERE status = 'applied' AND revert_at IS NOT NULL AND revert_at <= ? AND revert_error IS NULL ORDER BY id DESC").all(now) as { id: number; site_id: number }[];

export function listChanges(db: DatabaseSync, siteId: number, limit = 50): ChangeSummary[] {
  const rows = db.prepare("SELECT * FROM changesets WHERE site_id = ? ORDER BY id DESC LIMIT ?").all(siteId, limit) as {
    id: number; summary: string; initiator: ChangeSummary["initiator"]; status: ChangeSummary["status"]; ops_json: string;
    created_at: number; revert_at: number | null; reverted_at: number | null; revert_error: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id, summary: r.summary, initiator: r.initiator, status: r.status, createdAt: r.created_at, revertAt: r.revert_at,
    revertedAt: r.reverted_at, revertError: r.revert_error, targets: (JSON.parse(r.ops_json) as Op[]).map((o) => targetLabel(o.target)),
  }));
}
