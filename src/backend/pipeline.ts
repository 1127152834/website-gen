// 建站流水线。前半段（本文件）：预检 → 建网站并装 WordPress → SSL 与维护模式 → WooCommerce → Obel 主题 → 伴侣插件部署与注册；
// 后半段（store.ts）：选品 → AI 文案与政策 → 商店配置 → 页面 → 上架商品 → QA。
// 每次调用从第一个没完成的步骤接着跑；要等 Hostinger 时返回 { waitMs }，由任务队列稍后再调。
// Hostinger 的写操作可能 500 但实际已经成功（POC 实测），所以写完一律用只读接口确认，不信返回值。
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVISION_STEPS, type ModelRole, type RunEventKind, type SiteStatus, type StepKey, type StepState } from "../shared/protocol.ts";
import type { EntityForm, SiteForm } from "../shared/forms.ts";
import { HostingerError, listAll, type HostingerExec } from "./hostinger.ts";
import { PermanentError } from "./jobs.ts";
import { seal, unseal } from "./secrets.ts";
import { companionHealth, EnrollRejected, enrollCompanion, prepareCompanion, type CompanionCreds } from "./companion.ts";
import type { CjGet } from "./cj.ts";
import type { Browse } from "./qa-browser.ts";
import type { VisionComplete } from "./vision.ts";
import type { BrandRenderer } from "./branding.ts";
import { storeSteps } from "./store.ts";
import { ensureMailbox, mailDns, mailSetup } from "./mail.ts";
import { enableSmtp, imapHasSubject, type InboxCheck, type MailboxCreds } from "./smtp.ts";
import { siteFetch } from "./site-fetch.ts";

export interface PipelineDeps {
  db: DatabaseSync;
  key: Buffer;
  hostinger: (accountId: number) => HostingerExec;
  fetch: typeof fetch;
  emit: (e: { batchId: number; siteId: number; kind: RunEventKind; payload: Record<string, unknown> }) => void;
  /** 打包进应用的资源目录（主题、伴侣插件模板） */
  resourcesDir: string;
  /** 放每个站专用插件副本的目录 */
  workDir: string;
  now: () => number;
  pollMs?: number;
  /** 单个步骤最多等多久 */
  maxWaitMs?: number;
  /** 按用途调模型，返回纯文本和花费（美元） */
  ai: (role: ModelRole, prompt: string) => Promise<{ text: string; cost: number }>;
  cj: CjGet;
  /** 看图用途单独接收图片，不能用仅文本的 ai() 冒充视觉判断。 */
  vision?: VisionComplete;
  /** QA 文字抓取与截图；缺少浏览器时整站复核阻断，不视为完成。 */
  browse?: Browse;
  /** 品牌 PNG 渲染；正式使用 Playwright，测试注入进程内替身。 */
  renderBranding?: BrandRenderer;
  /** 查客服邮箱收件箱（确认测试邮件送达）；默认用 IMAP */
  inbox?: InboxCheck;
  /** 用 IMAP 登录邮箱验证密码；没有就不尝试（例如用默认密码登录已有邮箱） */
  login?: (creds: MailboxCreds) => Promise<void>;
}

export interface SiteRow {
  id: number;
  batch_id: number;
  domain: string;
  status: SiteStatus;
  account_id: number | null;
  order_id: number | null;
  hostinger_username: string | null;
  wp_software_id: string | null;
  wp_admin_ciphertext: Uint8Array | null;
  enroll_ciphertext: Uint8Array | null;
  enroll_generation: number | null;
  companion_ciphertext: Uint8Array | null;
  form_json: string;
  picks_json: string | null;
  spec_json: string | null;
  qa_json: string | null;
  launched_at: number | null;
  mailbox_ciphertext: Uint8Array | null;
}

export interface StepRow { status: StepState["status"]; detail: string | null; started_at: number }

/** done/skipped：完成；wait：要等外部（不占并发名额）；progress：没做完但有进展，马上接着跑 */
export type StepResult = { status: "done" | "skipped"; detail: string } | { wait: string } | { progress: string };

const BACK_STEPS = ["products_pick", "content", "store_setup", "pages", "products", "qa"] as const;
export type BackStepKey = (typeof BACK_STEPS)[number];

/** 后半段步骤能用到的东西 */
export interface StepCtx {
  d: PipelineDeps;
  site: SiteRow;
  domain: string;
  entity: EntityForm;
  form: SiteForm;
  save: (col: keyof SiteRow, value: SiteRow[keyof SiteRow]) => void;
  emit: (kind: RunEventKind, payload: Record<string, unknown>) => void;
  hx: HostingerExec;
  /** Hostinger 写操作：5xx 返回 UNKNOWN（调用方查状态确认），4xx 抛 PermanentError */
  act: (op: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Hostinger 的 WordPress 安装标识 { username, software } */
  inst: () => { username: string; software: string };
  /** 用伴侣插件的应用密码调站点 REST，path 不带 /wp-json/ 前缀 */
  wp: (method: string, path: string, body?: unknown) => Promise<unknown>;
}

export const UNKNOWN = Symbol("unknown");
const INSTALL_WAIT = "已提交安装，等待 Hostinger 完成";
/** Hostinger 新站默认装的插件里不需要的三个（AI 助手会在后台和结账页弹侧边栏）；Hostinger Tools 管维护模式，保留 */
export const UNWANTED_PLUGINS = ["hostinger-ai-assistant", "hostinger-easy-onboarding", "hostinger-reach"];
const SSL_WAIT = "已申请 SSL 证书，等待签发";

/** 读出站点并准备好对它操作要用的东西：Hostinger 调用（带日志）、写操作确认、站点 REST。流水线和上线共用。 */
export function siteContext(d: PipelineDeps, siteId: number): StepCtx {
  const { db, key } = d;
  const row = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId) as unknown as SiteRow | undefined;
  if (!row) throw new PermanentError(`站点 ${siteId} 不存在`);
  const site: SiteRow = row;
  const assertActive = () => {
    if (db.prepare("SELECT 1 FROM abandoned_domains WHERE domain = ? COLLATE NOCASE").get(site.domain)) {
      throw new PermanentError("这个域名已进入放弃流程，不能继续建站、上线或修改");
    }
  };
  assertActive();
  const entity = JSON.parse((db.prepare("SELECT entity_json FROM batches WHERE id = ?").get(site.batch_id) as { entity_json: string }).entity_json) as EntityForm;
  const { domain } = site;
  const emit = (kind: RunEventKind, payload: Record<string, unknown>) => d.emit({ batchId: site.batch_id, siteId, kind, payload });

  const save = (col: keyof SiteRow, value: SiteRow[keyof SiteRow]) => {
    assertActive();
    db.prepare(`UPDATE sites SET ${col} = ?, updated_at = ? WHERE id = ?`).run(value, d.now(), siteId);
    (site as unknown as Record<string, unknown>)[col] = value;
  };

  // ---- Hostinger 调用：日志里只记操作名、耗时和成败，从不记参数（里面有密码） ----
  let rawExec: HostingerExec | null = null;
  const hx: HostingerExec = async (op, params) => {
    assertActive();
    if (site.account_id == null) throw new Error("站点还没有关联 Hostinger 账号");
    rawExec ??= d.hostinger(site.account_id);
    const t0 = performance.now();
    try {
      const r = await rawExec(op, params);
      emit("mcp", { op, ms: Math.round(performance.now() - t0), ok: true });
      return r;
    } catch (e) {
      emit("mcp", { op, ms: Math.round(performance.now() - t0), ok: false, error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
      throw e;
    }
  };
  /** 写操作：5xx 或说不清的错误先当作「结果未知」，由调用方查状态确认；4xx 是请求本身被拒，不重试。 */
  async function act(op: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await hx(op, params);
    } catch (e) {
      if (!(e instanceof HostingerError) || e.status === 429) throw e;
      if (e.status === null || e.status >= 500) return UNKNOWN;
      throw new PermanentError(`Hostinger 拒绝了 ${op}：${e.message}`);
    }
  }
  const inst = () => ({ username: site.hostinger_username!, software: site.wp_software_id! });

  // ---- 站点 REST：伴侣插件注册得到的应用密码 ----
  async function wp(method: string, path: string, body?: unknown): Promise<unknown> {
    assertActive();
    if (!site.companion_ciphertext) throw new Error("伴侣插件还没注册");
    const creds = JSON.parse(unseal(key, site.companion_ciphertext)) as CompanionCreds;
    const res = await siteFetch(d.fetch, `https://${domain}/wp-json/${path}`, {
      method,
      // 媒体上传交给 fetch 生成 multipart boundary，其余接口仍严格发送 JSON。
      headers: { Authorization: "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64"), ...(body === undefined || body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 非 JSON（例如 PHP 报错页面）
    }
    if (!res.ok) {
      const msg = `${method} ${path.split("?")[0]} 返回 HTTP ${res.status}${(json as { message?: string } | null)?.message ? `：${(json as { message: string }).message}` : ""}`;
      // 参数或权限问题，重试也没用
      throw [400, 401, 403, 404].includes(res.status) ? new PermanentError(msg) : new Error(msg);
    }
    return json;
  }

  return { d, site, domain, entity, form: JSON.parse(site.form_json) as SiteForm, save, emit, hx, act, inst, wp };
}

export async function provisionSite(d: PipelineDeps, siteId: number): Promise<{ waitMs: number } | void> {
  const { db, key } = d;
  const pollMs = d.pollMs ?? 15_000;
  const maxWaitMs = d.maxWaitMs ?? 20 * 60_000;
  const ctx = siteContext(d, siteId);
  const { site, domain, entity, emit, save, hx, act, inst } = ctx;

  // ---- 步骤进度：只在状态或说明变化时写库并发事件，轮询时不刷屏 ----
  const rows = new Map<StepKey, StepRow>(
    (db.prepare("SELECT step, status, detail, started_at FROM provision_steps WHERE site_id = ?").all(siteId) as unknown as (StepRow & { step: StepKey })[])
      .map((r) => [r.step, r]),
  );
  function mark(step: StepKey, status: StepRow["status"], detail: string | null) {
    const prev = rows.get(step);
    if (prev && prev.status === status && prev.detail === detail) return;
    const now = d.now();
    const startedAt = prev && (prev.status === "running" || prev.status === "waiting") ? prev.started_at : now;
    const finishedAt = status === "done" || status === "skipped" || status === "failed" ? now : null;
    db.prepare(`INSERT INTO provision_steps (site_id, step, status, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (site_id, step) DO UPDATE SET status = excluded.status, detail = excluded.detail, started_at = excluded.started_at, finished_at = excluded.finished_at`)
      .run(siteId, step, status, detail, startedAt, finishedAt);
    rows.set(step, { status, detail, started_at: startedAt });
    const i = PROVISION_STEPS.findIndex((s) => s.key === step);
    emit("step", { step, index: i + 1, total: PROVISION_STEPS.length, name: PROVISION_STEPS[i].name, status, detail });
  }
  const setStatus = (status: "running" | "waiting" | "done") =>
    db.prepare("UPDATE sites SET status = ?, last_error = CASE WHEN ? = 'done' THEN NULL ELSE last_error END, updated_at = ? WHERE id = ?").run(status, status, d.now(), siteId);

  const setups = async () => (await hx("hosting_websites_list-setups", { domain })) as { username?: string; status?: string }[];
  const website = async () =>
    ((await listAll(hx, "hosting_websites_list", { domain })) as { domain: string; username?: string }[]).find((w) => w.domain === domain);

  /** 插件或主题：没装（或版本不对）就装，装了没启用就启用，最后以列表里的状态为准。 */
  async function ensureActive(
    kind: "plugin" | "theme", slug: string, install: () => Promise<void>, prevDetail: string | null, isCurrent = (_version?: string) => true,
  ): Promise<{ status: "done" | "skipped"; detail: string } | { wait: string }> {
    const find = async () =>
      ((await hx(`wordpress_${kind}s_list-installed`, inst())) as { name: string; status: string; version?: string }[]).find((x) => x.name === slug);
    let x = await find();
    if (x?.status === "active" && isCurrent(x.version)) return { status: "skipped", detail: `${slug} ${x.version ?? ""} 已是启用状态`.trim() };
    if ((!x || !isCurrent(x.version)) && prevDetail !== INSTALL_WAIT) {
      await install();
      x = await find();
    }
    if (x && x.status !== "active") {
      await act(`wordpress_${kind}s_activate`, { ...inst(), [kind]: slug });
      x = await find();
    }
    return x?.status === "active" && isCurrent(x.version) ? { status: "done", detail: `${slug} ${x.version ?? ""} 已启用`.trim() } : { wait: INSTALL_WAIT };
  }

  const themeVersion = /Version:\s*([\d.]+)/.exec(readFileSync(join(d.resourcesDir, "theme", "obel", "style.css"), "utf8"))?.[1];

  const steps: Record<StepKey, (prev: StepRow | undefined) => Promise<StepResult>> = {
    ...storeSteps(ctx),
    async precheck() {
      if (site.account_id == null) {
        const owner = db.prepare("SELECT account_id FROM domains WHERE domain = ? ORDER BY account_id LIMIT 1").get(domain) as { account_id: number } | undefined;
        if (!owner) throw new PermanentError(`${domain} 不在任何已接入的 Hostinger 账号里`);
        save("account_id", owner.account_id);
      }
      // 以实时列表为准，本地快照可能是半小时前的
      if (await website()) throw new PermanentError(`${domain} 已经有网站了，不会覆盖`);
      // ponytail: 取账号下第一个有效的主机订单；订单多了再让表单选
      const order = db.prepare("SELECT external_id FROM hosting_orders WHERE account_id = ? AND status = 'active' ORDER BY external_id LIMIT 1").get(site.account_id) as { external_id: number } | undefined;
      if (!order) throw new PermanentError("这个账号下没有有效的主机订单");
      save("order_id", order.external_id);
      const label = (db.prepare("SELECT label FROM hostinger_accounts WHERE id = ?").get(site.account_id) as { label: string }).label;
      return { status: "done", detail: `账号「${label}」，主机订单 ${order.external_id}` };
    },

    async create_site() {
      if (!site.wp_admin_ciphertext) {
        const admin = { user: `wg_${randomBytes(3).toString("hex")}`, password: `Aa1!${randomBytes(15).toString("base64url")}` };
        save("wp_admin_ciphertext", seal(key, JSON.stringify(admin)));
      }
      if ((await setups()).length > 0 || (await website())) return { status: "done", detail: "网站已在创建中" };
      const admin = JSON.parse(unseal(key, site.wp_admin_ciphertext!)) as { user: string; password: string };
      const email = entity.supportEmail === "auto" ? `support@${domain}` : entity.supportEmail.trim();
      const r = await act("hosting_websites_start-setup", {
        order_id: site.order_id, type: "wordpress", domain,
        wordpress: { language: "en_US", admin: { user: admin.user, password: admin.password, email } },
      });
      if (r === UNKNOWN && (await setups()).length === 0) throw new Error("创建网站的请求没有得到确认，稍后重试");
      return { status: "done", detail: `已提交，管理员 ${admin.user}` };
    },

    async wait_wordpress() {
      const setup = (await setups())[0];
      if (setup?.status && /fail|error/i.test(setup.status)) throw new PermanentError(`Hostinger 建站失败（${setup.status}）`);
      const username = setup?.username ?? (await website())?.username;
      if (!username) return { wait: "等待 Hostinger 创建网站" };
      if (site.hostinger_username !== username) save("hostinger_username", username);
      // 按域名过滤查不到新站（POC 实测），所以按用户名列出再本地匹配
      const installs = (await listAll(hx, "wordpress_installations_list", { username, ownership: "all" })) as { id: string | number; domain: string }[];
      const install = installs.find((i) => i.domain === domain);
      if (!install) return { wait: `正在安装 WordPress（${setup?.status ?? "处理中"}）` };
      save("wp_software_id", String(install.id));
      return { status: "done", detail: `WordPress 安装 ID ${install.id}` };
    },

    async ssl_maintenance(prev) {
      // 先开维护模式：站点在装好内容之前不对外
      let m = (await hx("wordpress_maintenance_show-status", inst())) as { status?: string };
      if (m.status !== "enabled") {
        await act("wordpress_maintenance_toggle", { ...inst(), enabled: true });
        m = (await hx("wordpress_maintenance_show-status", inst())) as { status?: string };
        if (m.status !== "enabled") return { wait: "等待维护模式生效" };
      }
      const ssl = (await hx("hosting_ssl_status", { username: site.hostinger_username, domain })) as { status?: string; expires_at?: string };
      if (ssl.status !== "active") {
        if (prev?.detail !== SSL_WAIT) await act("hosting_ssl_install", { username: site.hostinger_username, domain });
        return { wait: SSL_WAIT };
      }
      return { status: "done", detail: `维护模式已开启，SSL 有效${ssl.expires_at ? `至 ${ssl.expires_at.slice(0, 10)}` : ""}` };
    },

    async woocommerce(prev) {
      return ensureActive("plugin", "woocommerce", async () => void (await act("wordpress_plugins_install", { ...inst(), plugins: ["woocommerce"] })), prev?.detail ?? null);
    },

    async plugins_cleanup(prev) {
      // 卸载是异步任务：提交一次，之后每次轮询只看列表里还剩没剩
      const left = ((await hx("wordpress_plugins_list-installed", inst())) as { name: string }[]).map((p) => p.name).filter((n) => UNWANTED_PLUGINS.includes(n));
      if (left.length === 0) return prev ? { status: "done", detail: "已卸载 Hostinger AI 助手、Easy Onboarding、Reach" } : { status: "skipped", detail: "没有需要卸载的插件" };
      if (prev?.status !== "waiting") await act("wordpress_plugins_uninstall", { ...inst(), plugins: left });
      return { wait: `正在卸载：${left.join(", ")}` };
    },

    async theme(prev) {
      return ensureActive("theme", "obel", async () => {
        const r = (await act("hosting_deploy-wordpress-theme", { domain, slug: "obel", themePath: join(d.resourcesDir, "theme", "obel"), activate: true })) as
          typeof UNKNOWN | { status?: string; summary?: { failed?: number } };
        if (r !== UNKNOWN && r.status !== "success") throw new Error(`主题上传有 ${r.summary?.failed ?? "部分"} 个文件失败，稍后重试`);
      }, prev?.detail ?? null, (v) => v === themeVersion);
    },

    async companion(prev) {
      // 等待激活时不重新部署；其余情况每次都换一份新令牌、更高代数的副本
      if (!(prev?.status === "waiting" && site.enroll_ciphertext)) {
        const token = randomBytes(32).toString("base64url");
        const generation = d.now();
        save("enroll_ciphertext", seal(key, token));
        save("enroll_generation", generation);
        const dir = prepareCompanion(join(d.resourcesDir, "site-companion"), d.workDir, domain, token, generation, d.now() + 15 * 60_000);
        const r = (await act("hosting_deploy-wordpress-plugin", { domain, slug: "site-companion", pluginPath: dir })) as typeof UNKNOWN | { status?: string };
        if (r !== UNKNOWN && r.status !== "success") throw new Error("伴侣插件上传失败，稍后重试");
      }
      const r = await ensureActive("plugin", "site-companion", async () => {}, INSTALL_WAIT);
      return "wait" in r ? { wait: "等待伴侣插件启用" } : { status: "done", detail: r.detail };
    },

    async mailbox() {
      // 邮箱有问题（没有邮箱订单、席位用完）不让建站失败：记下原因，QA 和站点页会提醒
      const r = await ensureMailbox(ctx);
      if (!r.ok) emit("warn", { message: r.detail });
      return { status: r.ok ? "done" : "skipped", detail: r.detail };
    },

    async mail_dns() {
      const { onDomain, order } = await mailSetup(ctx);
      if (!onDomain || !order) return { status: "skipped", detail: "没有用这个域名的 Hostinger 邮箱，不需要邮件 DNS" };
      const r = await mailDns(ctx, true);
      if (!r.atHostinger) {
        emit("warn", { message: `${domain} 的 DNS 不在 Hostinger，需要在 DNS 服务商那里添加：${r.manual.join("；")}` });
        return { status: "skipped", detail: r.manual.length ? `DNS 不在 Hostinger，需要手动添加 ${r.manual.length} 条记录（见日志）` : "DNS 不在 Hostinger，记录已齐全" };
      }
      return {
        status: "done",
        detail: r.fixed.length
          ? `已补上 ${r.fixed.length} 组记录（${[...new Set(r.fixed.map((f) => f.split(" ")[0]))].join("、")}）${r.snapshotId ? `，改动前的 DNS 快照 #${r.snapshotId}` : ""}`
          : "MX、SPF、DKIM、DMARC 都已正确",
      };
    },

    async smtp() {
      const { onDomain, order } = await mailSetup(ctx);
      if (!onDomain) return { status: "skipped", detail: "客服邮箱不在这个域名上，交易邮件用主机默认发信" };
      if (!order) return { status: "skipped", detail: "这个域名还没有 Hostinger 邮箱：在 hPanel 开通邮箱后，到站点页点「修复」，会一并启用交易邮件" };
      // 发不出去不让建站失败：退回主机默认发信，QA 和站点页提醒
      const r = await enableSmtp(ctx, d.inbox ?? imapHasSubject);
      if (!r.ok) emit("warn", { message: r.detail });
      return { status: r.ok ? "done" : "skipped", detail: r.detail };
    },

    async enroll() {
      if (!site.companion_ciphertext) {
        if (!site.enroll_ciphertext) throw new EnrollRejected("没有可用的注册令牌，需要重新部署伴侣插件");
        const creds = await enrollCompanion(domain, unseal(key, site.enroll_ciphertext), d.fetch);
        save("companion_ciphertext", seal(key, JSON.stringify(creds)));
        save("enroll_ciphertext", null);
      }
      const creds = JSON.parse(unseal(key, site.companion_ciphertext!)) as CompanionCreds;
      const h = await companionHealth(domain, creds, d.fetch);
      return { status: "done", detail: `WordPress ${h.wp}，WooCommerce ${h.woocommerce}，主题 ${h.theme}` };
    },
  };

  setStatus("running");
  for (const { key: step, name } of PROVISION_STEPS) {
    const prev = rows.get(step);
    if (prev?.status === "done" || prev?.status === "skipped") continue;
    if (prev?.status !== "waiting") mark(step, "running", null);
    try {
      const r = await steps[step](prev);
      if ("progress" in r) {
        mark(step, "running", r.progress);
        return { waitMs: 1000 };
      }
      if ("wait" in r) {
        mark(step, "waiting", r.wait);
        if (d.now() - rows.get(step)!.started_at > maxWaitMs) throw new PermanentError(`${name}超过 ${Math.round(maxWaitMs / 60_000)} 分钟仍未完成`);
        setStatus("waiting");
        return { waitMs: pollMs };
      }
      mark(step, r.status, r.detail);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof EnrollRejected) {
        // 令牌失效：退回到「部署伴侣插件」，下次带新令牌重新部署
        db.prepare("DELETE FROM provision_steps WHERE site_id = ? AND step IN ('companion','enroll')").run(siteId);
        save("enroll_ciphertext", null);
      } else {
        mark(step, "failed", message);
      }
      db.prepare("UPDATE sites SET last_error = ?, updated_at = ? WHERE id = ?").run(`${name}：${message}`, d.now(), siteId);
      emit("error", { step, name, message });
      throw e;
    }
  }
  setStatus("done");
}
