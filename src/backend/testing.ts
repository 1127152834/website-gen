// 测试用的模拟环境（不是测试文件本身）：Hostinger MCP、站点（伴侣插件 + WordPress / WooCommerce REST）、CJ、模型。
// 行为按 POC 实测：写操作可能 500 但实际已执行、建站要轮询、卸载插件是异步的、店长看不到隐私政策页等。
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "./db.ts";
import { createBatch, siteSteps } from "./batches.ts";
import { HostingerError, type HostingerExec } from "./hostinger.ts";
import { PermanentError } from "./jobs.ts";
import { provisionSite, UNWANTED_PLUGINS, type PipelineDeps } from "./pipeline.ts";
import { launchSite } from "./launch.ts";
import { seal, unseal } from "./secrets.ts";
import type { Browse, BrowseInput } from "./qa-browser.ts";
import type { ZoneGroup } from "./mail.ts";
import type { BatchForm } from "../shared/forms.ts";
import { PROVISION_STEPS } from "../shared/protocol.ts";
import { FALLBACK_STYLE } from "./style.ts";
import type { VisionComplete } from "./vision.ts";
import type { MailAttachment } from "../shared/mail-types.ts";
import type { MailCredentials, MailTransport, OutgoingMessage, RemoteFolder, RemoteMessage, SendResult } from "./mailbox-transport.ts";

export const key = randomBytes(32);
export const DOMAIN = "nordicpaws.com";
export const EMAIL = `support@${DOMAIN}`;
export const RESOURCES = join(import.meta.dirname, "../../resources");
export const THEME_VERSION = /Version:\s*([\d.]+)/.exec(readFileSync(join(RESOURCES, "theme/obel/style.css"), "utf8"))![1];

export function setup(options: { cachedMailbox?: { accountId?: number; address?: string; domain?: string; password: string } } = {}) {
  const db = openDb(":memory:");
  migrate(db);
  db.prepare("INSERT INTO hostinger_accounts (id, label, token_ciphertext, token_hint, status, created_at) VALUES (1, '主账号', ?, 'abcd', 'ok', 0)").run(seal(key, "tok"));
  if (options.cachedMailbox?.accountId === 2)
    db.prepare("INSERT INTO hostinger_accounts (id, label, token_ciphertext, token_hint, status, created_at) VALUES (2, '其他账号', ?, 'efgh', 'ok', 0)").run(seal(key, "other-token"));
  db.prepare("INSERT INTO hosting_orders VALUES (1, 1010129013, 'hostinger_unlimited_v6', 'active', '2026-10-03')").run();
  db.prepare("INSERT INTO domains VALUES (1, 7, ?, 'domain', 'active', '2027-10-01', '2026-10-01')").run(DOMAIN);
  if (options.cachedMailbox) {
    const accountId = options.cachedMailbox.accountId ?? 1;
    const address = options.cachedMailbox.address ?? EMAIL;
    const domain = options.cachedMailbox.domain ?? DOMAIN;
    db.prepare(`INSERT INTO mailboxes(account_id,order_id,remote_id,address,domain,status,credential_ciphertext)
      VALUES (?, 'OR1', ?, ?, ?, 'active', ?)`)
      .run(accountId, `cached-${accountId}`, address, domain, seal(key, JSON.stringify({ address, password: options.cachedMailbox.password })));
  }
  const form: BatchForm = {
    entity: { kind: "company", name: "Nordic Paws LLC", address: "1 Main St, Austin, TX 78701", supportEmail: "auto", phone: "+1 512 555 0100", processingDays: [1, 3], transitDays: [5, 10] },
    sites: [{ domain: DOMAIN, supportEmail: EMAIL, categories: "dog beds, pet blankets", count: 2, priceMin: null, priceMax: null, brand: "" }],
  };
  const { siteIds } = createBatch(db, form, 0, [{ domain: DOMAIN, accountId: 1, mailboxes: [{ address: EMAIL }], defaultEmail: EMAIL }]);
  return { db, siteId: siteIds[0] };
}

/** 模拟 Hostinger：建站第二次轮询才完成；装插件返回 500 但实际已装好（POC 实测的行为）。 */
export function fakeHostinger(opts: { websiteAlreadyThere?: boolean } = {}) {
  const st = {
    websites: new Set<string>(opts.websiteAlreadyThere ? [DOMAIN] : []),
    setup: null as null | { status: string; polls: number },
    installed: false,
    maintenance: "disabled",
    // Hostinger 新站默认装的插件；卸载是异步的，下一次列表才消失
    plugins: new Map<string, string>([["hostinger", "active"], ["hostinger-ai-assistant", "active"], ["hostinger-easy-onboarding", "active"], ["hostinger-reach", "active"]]),
    uninstallQueued: [] as string[],
    // 邮箱：域名有一个已申请的 active 邮箱；流水线只复核，绝不会代替用户创建邮箱
    mailOrders: [{ id: "OR1", status: "active", domain: { name: DOMAIN } }],
    mailboxes: [{ id: "AC1", address: EMAIL, status: "active" }] as { id: string; address: string; status: string }[],
    aliases: [] as { address: string }[],
    zone: [
      { name: "@", type: "MX", ttl: 14400, records: [{ content: "5 mx1.hostinger.com.", is_disabled: false }, { content: "10 mx2.hostinger.com.", is_disabled: false }] },
      { name: "@", type: "TXT", ttl: 3600, records: [{ content: '"v=spf1 include:_spf.mail.hostinger.com ~all"', is_disabled: false }] },
    ] as ZoneGroup[],
    dnsUpdates: 0,
    themes: new Map<string, { status: string; version: string }>([["twentytwentyfive", { status: "active", version: "1.5" }]]),
    pluginDeploys: [] as string[],
    calls: [] as string[],
  };
  const exec: HostingerExec = async (op, p = {}) => {
    st.calls.push(op);
    const params = p as Record<string, any>;
    switch (op) {
      case "domains_portfolio_list":
        return [{ domain: DOMAIN, status: "active" }];
      case "hosting_websites_list": {
        const data = [...st.websites].filter((d) => !params.domain || d === params.domain).map((domain) => ({ domain, username: "u1" }));
        return { data, meta: { total: data.length } };
      }
      case "hosting_websites_start-setup":
        st.setup = { status: "running", polls: 0 };
        return { domain: params.domain, username: "u1", status: "running" };
      case "hosting_websites_list-setups":
        if (!st.setup) return [];
        if (st.setup.status === "running" && ++st.setup.polls >= 2) {
          st.setup.status = "completed";
          st.websites.add(DOMAIN);
          st.installed = true;
        }
        return [{ domain: DOMAIN, username: "u1", status: st.setup.status }];
      case "wordpress_installations_list":
        return st.installed ? [{ id: "31100468", username: "u1", domain: DOMAIN }] : [];
      case "hosting_ssl_status":
        return { status: "active" };
      case "wordpress_maintenance_show-status":
        return { status: st.maintenance };
      case "wordpress_maintenance_toggle":
        st.maintenance = params.enabled ? "enabled" : "disabled";
        throw new HostingerError("HTTP 500: [Hosting:9999] Request failed", 500);
      case "wordpress_plugins_uninstall":
        st.uninstallQueued.push(...params.plugins);
        return {};
      case "wordpress_plugins_list-installed": {
        const list = [...st.plugins].map(([name, status]) => ({ name, status }));
        for (const n of st.uninstallQueued.splice(0)) st.plugins.delete(n);
        return list;
      }
      case "wordpress_plugins_install":
        for (const n of params.plugins) st.plugins.set(n, "active");
        throw new HostingerError("HTTP 500: [Hosting:9999] Request failed", 500);
      case "wordpress_plugins_activate":
        st.plugins.set(params.plugin, "active");
        return {};
      case "wordpress_themes_list-installed":
        return [...st.themes].map(([name, t]) => ({ name, ...t }));
      case "hosting_deploy-wordpress-theme": {
        for (const t of st.themes.values()) t.status = "inactive";
        const version = /Version:\s*([\d.]+)/.exec(readFileSync(join(params.themePath, "style.css"), "utf8"))![1];
        st.themes.set(params.slug, { status: params.activate ? "active" : "inactive", version });
        return { status: "success" };
      }
      case "hosting_deploy-wordpress-plugin":
        st.plugins.set(params.slug, "inactive");
        st.pluginDeploys.push(params.pluginPath);
        return { status: "success" };
      case "mail_orders_list":
        return { data: st.mailOrders, meta: { total: st.mailOrders.length } };
      case "mail_mailboxes_list": {
        const data = st.mailboxes.filter((m) => !params.search || m.address.includes(params.search));
        return { data, meta: { total: data.length } };
      }
      case "mail_mailboxes_create-mailbox":
        st.mailboxes.push({ id: `AC${st.mailboxes.length + 1}`, address: `${params.local_part}@${DOMAIN}`, status: "active" });
        return {};
      case "mail_mailboxes_change-mailbox-password": {
        const box = st.mailboxes.find((m) => m.id === params.mailboxId) as ({ password?: string } & (typeof st.mailboxes)[number]) | undefined;
        if (!box) throw new HostingerError("HTTP 404: mailbox not found", 404);
        box.password = params.password;
        throw new HostingerError("HTTP 500: [Hosting:9999] Request failed", 500);
      }
      case "mail_aliases_list":
        return { data: st.aliases, meta: { total: st.aliases.length } };
      case "mail_aliases_create-alias":
        st.aliases.push({ address: `${params.local_part}@${DOMAIN}` });
        return {};
      case "dns_records_list":
        return structuredClone(st.zone);
      case "dns_snapshots_list":
        return [{ id: 500 + st.dnsUpdates, reason: "Zone records update request" }];
      case "dns_records_validate":
        return { message: "Request accepted" };
      case "dns_records_update":
        // overwrite：同名同类型整组替换
        for (const g of params.zone as ZoneGroup[]) {
          st.zone = st.zone.filter((z) => !(z.name === g.name && z.type === g.type));
          st.zone.push({ ...g, records: g.records.map((r) => ({ ...r, is_disabled: false })) });
        }
        st.dnsUpdates++;
        throw new HostingerError("HTTP 500: [Hosting:9999] Request failed", 500);
      case "wordpress_login_create-links":
        return { login: `${DOMAIN}/create_autologin_abc.php` };
      default:
        throw new Error(`unexpected operation ${op}`);
    }
  };
  return { st, exec };
}

/** 模拟站点：伴侣插件的注册接口（真的读取部署出去的 enroll.php 校验令牌）+ 流水线用到的 WordPress / WooCommerce REST。 */
export function fakeSite(st: ReturnType<typeof fakeHostinger>["st"], opts: { rejectFirst?: boolean } = {}) {
  let enrolledGen = 0;
  let rejectNext = opts.rejectFirst ?? false;
  let nextId = 100;
  type Page = { id: number; slug: string; title: string; content: string; status: string };
  const wp = {
    options: { blogname: "", blogdescription: "", blog_public: 1, show_on_front: "posts", page_on_front: 0, wp_page_for_privacy_policy: 3, woocommerce_coming_soon: "yes" } as Record<string, unknown>,
    info: {} as Record<string, string>,
    rules: {} as Record<string, unknown>,
    metadata: new Map<string, { target_type: string; target_id: number; description: string; og_description: string; exists: boolean }>(),
    defaultsRemoved: false,
    pages: new Map<number, Page>([
      [3, { id: 3, slug: "privacy-policy", title: "Privacy Policy", content: "draft", status: "draft" }],
      ...["shop", "cart", "checkout", "my-account"].map((slug, i): [number, Page] => [10 + i, { id: 10 + i, slug, title: slug, content: "", status: "publish" }]),
    ]),
    settings: {} as Record<string, unknown>,
    styles: null as unknown,
    media: new Map<number, { id: number; slug: string; media_type: string; mime_type: string; source_url: string }>(),
    failSiteWrites: false,
    // 伴侣插件的 SMTP：保存的设置、发出的测试邮件；failSmtp 模拟密码错误
    smtp: null as null | { host: string; port: number; username: string; password: string; from_email: string },
    sentMails: [] as { to: string; subject: string; viaSmtp: boolean }[],
    failSmtp: false,
    zones: [] as { id: number; name: string; locations: unknown[]; methods: { instance_id: number; method_id: string; enabled: boolean; settings: unknown }[] }[],
    categories: [] as { id: number; name: string; slug: string; description?: string }[],
    products: [] as { id: number; sku: string; status: string; name: string; type: string; price?: string; images: unknown[]; variations: { id: number; price: string }[]; description: string; short_description: string; featured: boolean; categories?: { id: number }[]; meta_data?: { key: string; value: unknown }[]; [key: string]: any }[],
  };
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const paginate = <T>(rows: T[], q: URLSearchParams) => {
    const count = Number(q.get("per_page") || 100), page = Number(q.get("page") || 1);
    return rows.slice((page - 1) * count, page * count);
  };

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = u.pathname.replace(/^\/wp-json\//, "");
    const q = u.searchParams;

    // 公共 DNS（DoH）：答案来自模拟的 Hostinger 区域，名称服务器是 Hostinger 的
    if (u.hostname === "cloudflare-dns.com") {
      const name = q.get("name")!;
      const type = q.get("type")!;
      const code = { NS: 2, CNAME: 5, MX: 15, TXT: 16 }[type]!;
      const rel = name === DOMAIN ? "@" : name.slice(0, -(DOMAIN.length + 1));
      const answers = type === "NS" ? ["ns1.dns-parking.com.", "ns2.dns-parking.com."]
        : (st.zone.find((z) => z.name === rel && z.type === type)?.records ?? []).filter((r) => !r.is_disabled).map((r) => r.content);
      return json({ Status: answers.length ? 0 : 3, Answer: answers.map((data) => ({ type: code, data })) });
    }
    // 访客看到的前台：维护模式或 Woo「即将上线」时是维护页
    if (!u.pathname.startsWith("/wp-json/")) {
      const hidden = st.maintenance === "enabled" || wp.options.woocommerce_coming_soon === "yes";
      return new Response(hidden ? "<h1>Coming Soon</h1>" : "<h1>Rest easy, pup</h1>", { headers: { "Content-Type": "text/html" } });
    }
    if (path === "site-agent/v1/enroll") {
      const php = readFileSync(join(st.pluginDeploys.at(-1)!, "enroll.php"), "utf8");
      const hash = /'token_hash' => '([0-9a-f]+)'/.exec(php)![1];
      const gen = Number(/'generation' => (\d+)/.exec(php)![1]);
      const token = new Headers(init?.headers).get("X-Site-Agent-Enroll") ?? "";
      const ok = !rejectNext && gen > enrolledGen && createHash("sha256").update(token).digest("hex") === hash;
      rejectNext = false;
      if (!ok) return json({}, 403);
      enrolledGen = gen;
      return json({ username: "site-agent", password: "app pass word 1234" });
    }
    // 其余接口都要带注册拿到的应用密码
    if (new Headers(init?.headers).get("Authorization") !== "Basic " + Buffer.from("site-agent:app pass word 1234").toString("base64") && !path.startsWith("wc/store/")) return json({ message: "unauthorized" }, 401);
    if (path === "wp/v2/posts") return json([]);
    if (path === "site-agent/v1/health") return json({ wp: "7.1.3", woocommerce: "11.2.1", theme: `obel ${THEME_VERSION}` });
    if (path === "wp/v2/media") {
      if (method === "POST") {
        if (!(body.file instanceof Blob) || body.file.type !== "image/png") return json({ message: "PNG media required" }, 400);
        const media = { id: nextId++, slug: String(body.slug), media_type: "image", mime_type: "image/png", source_url: `https://${DOMAIN}/wp-content/uploads/${body.file.name}` };
        wp.media.set(media.id, media);
        return json(media, 201);
      }
      return json([...wp.media.values()].filter((m) => !q.has("slug") || m.slug === q.get("slug")));
    }
    if (path === "site-agent/v1/site") {
      if (method === "POST" && wp.failSiteWrites) return json({ message: "boom" }, 500);
      if (method === "POST") {
        Object.assign(wp.options, body.options ?? {});
        if (body.info) wp.info = body.info;
        if (body.rules) wp.rules = body.rules;
      }
      return json({ options: wp.options, info: wp.info, rules: wp.rules });
    }
    if (path === "site-agent/v1/cleanup-defaults") {
      wp.defaultsRemoved = true;
      wp.options.woocommerce_feature_order_attribution_enabled = "no";
      for (const [id, p] of wp.pages) if (p.slug === "sample-page") wp.pages.delete(id);
      return json({ ok: true });
    }
    if (path === "site-agent/v1/metadata") {
      const type = body?.target_type ?? q.get("target_type");
      const id = body?.target_id ?? q.get("target_id");
      const key = `${type}:${id}`;
      if (method === "POST") {
        if (body.description === "" && body.og_description === "") wp.metadata.delete(key);
        else wp.metadata.set(key, { target_type: type, target_id: Number(id), description: body.description, og_description: body.og_description, exists: true });
      }
      if (!type) return json({ items: Object.fromEntries([...wp.metadata].map(([key, value]) => [key === "home:0" ? "home" : key === "shop:0" ? "shop" : key, value])) });
      return json(wp.metadata.get(key) ?? { target_type: type, target_id: Number(id), description: "", og_description: "", exists: false });
    }
    if (path === "site-agent/v1/smtp") {
      if (method === "POST") wp.smtp = body.enabled === false ? null : { host: body.host, port: body.port, username: body.username, password: body.password, from_email: body.from_email };
      return json({ enabled: Boolean(wp.smtp), host: wp.smtp?.host ?? null, username: wp.smtp?.username ?? null });
    }
    if (path === "site-agent/v1/smtp/test") {
      if (wp.smtp && wp.failSmtp) return json({ ok: false, smtp: true, error: "SMTP Error: Could not authenticate." });
      wp.sentMails.push({ to: body.to, subject: body.subject, viaSmtp: Boolean(wp.smtp) });
      return json({ ok: true, smtp: Boolean(wp.smtp), error: null });
    }
    if (path === "site-agent/v1/privacy-page" && method === "GET") {
      const page = wp.pages.get(Number(wp.options.wp_page_for_privacy_policy))!;
      return json({ id: page.id, title: page.title, content: page.content });
    }
    if (path === "site-agent/v1/privacy-page") {
      const existing = [...wp.pages.values()].find((p) => p.slug === "privacy-policy");
      const page = { ...(existing ?? { id: nextId++ }), slug: "privacy-policy", status: "publish", title: body.title, content: body.content } as Page;
      wp.pages.set(page.id, page);
      wp.options.wp_page_for_privacy_policy = page.id;
      return json({ id: page.id });
    }
    if (path === "wp/v2/pages" && method === "GET") {
      const slugs = q.get("slug")?.split(",") ?? [...wp.pages.values()].map((p) => p.slug);
      const statuses = (q.get("status") ?? "publish").split(",");
      // 和真实站点一样：店长在编辑上下文里看不到被设为隐私政策页的那一页
      const hidden = (p: Page) => q.get("context") === "edit" && p.id === wp.options.wp_page_for_privacy_policy;
      return json(paginate([...wp.pages.values()].filter((p) => slugs.includes(p.slug) && statuses.includes(p.status) && !hidden(p)), q).map((p) => ({ id: p.id, slug: p.slug, link: `https://${DOMAIN}/${p.slug === "home" ? "" : p.slug + "/"}`, status: p.status, title: { raw: p.title, rendered: p.title }, content: { raw: p.content, rendered: p.content } })));
    }
    let m: RegExpExecArray | null;
    if (path === "wp/v2/pages" || (m = /^wp\/v2\/pages\/(\d+)$/.exec(path))) {
      const id = path === "wp/v2/pages" ? nextId++ : Number(m![1]);
      const page = { ...(wp.pages.get(id) ?? { id }), ...body } as Page;
      wp.pages.set(id, page);
      return json(page);
    }
    if (path === "wp/v2/themes") return json([{ stylesheet: "obel", _links: { "wp:user-global-styles": [{ href: `https://${DOMAIN}/wp-json/wp/v2/global-styles/9` }] } }]);
    if (path === "wp/v2/global-styles/themes/obel/variations") return json([{ title: "Editorial", styles: { typography: { fontFamily: "serif" } }, settings: {} }]);
    if (path === "wp/v2/global-styles/9") return json(method === "GET" ? (wp.styles ?? { styles: {}, settings: {} }) : (wp.styles = body));
    if ((m = /^wc\/v3\/settings\/(\w+)\/batch$/.exec(path))) {
      for (const { id, value } of body.update) wp.settings[id] = value;
      return json({ update: body.update });
    }
    if (path === "wc/v3/settings/general/woocommerce_currency") return json({ value: wp.settings.woocommerce_currency ?? "GBP" });
    if (path === "wc/v3/shipping/zones") {
      if (method === "POST") wp.zones.push({ id: nextId++, name: body.name, locations: [], methods: [] });
      return json(method === "POST" ? wp.zones.at(-1) : wp.zones);
    }
    if ((m = /^wc\/v3\/shipping\/zones\/(\d+)\/(locations|methods)$/.exec(path))) {
      const zone = wp.zones.find((z) => z.id === Number(m![1]))!;
      if (m[2] === "locations") return json(method === "GET" ? zone.locations : (zone.locations = body));
      if (method === "POST") zone.methods.push({ instance_id: nextId++, method_id: body.method_id, enabled: body.enabled ?? true, settings: body.settings });
      return json(zone.methods);
    }
    if ((m = /^wc\/v3\/shipping\/zones\/(\d+)\/methods\/(\d+)$/.exec(path))) {
      const method = wp.zones.find((z) => z.id === Number(m![1]))?.methods.find((x) => x.instance_id === Number(m![2]));
      if (!method) return json({ message: "No shipping method" }, 404);
      if (body) Object.assign(method, body);
      return json(method);
    }
    if (path === "wc/v3/products/categories") {
      if (method === "POST") wp.categories.push({ id: nextId++, name: body.name, slug: body.slug, description: body.description });
      return json(method === "POST" ? wp.categories.at(-1) : paginate(wp.categories.filter((c) => !q.has("slug") || c.slug === q.get("slug")).map((c) => ({ ...c, count: wp.products.filter((p) => p.categories?.some((x) => x.id === c.id)).length })), q));
    }
    if ((m = /^wc\/v3\/products\/categories\/(\d+)$/.exec(path))) {
      const category = wp.categories.find((c) => c.id === Number(m![1]));
      if (method === "PUT") Object.assign(category!, body);
      return json(category);
    }
    if (path === "wc/v3/products" && method === "GET") return json(paginate(wp.products.filter((p) => (!q.has("sku") || p.sku === q.get("sku")) && (!q.has("status") || q.get("status") === "any" || p.status === q.get("status"))), q));
    if (path === "wc/v3/products") {
      const p = { id: nextId++, variations: [], ...body, price: body.regular_price };
      wp.products.push(p);
      return json(p, 201);
    }
    if ((m = /^wc\/v3\/products\/(\d+)\/variations\/batch$/.exec(path))) {
      const p = wp.products.find((x) => x.id === Number(m![1]))!;
      const created = body.create.map((v: { regular_price: string }) => ({ ...v, id: nextId++, price: v.regular_price }));
      p.variations.push(...created);
      return json({ create: created });
    }
    if ((m = /^wc\/v3\/products\/(\d+)\/variations\/(\d+)$/.exec(path))) {
      const p = wp.products.find((x) => x.id === Number(m![1]));
      const variation = p?.variations.find((x) => x.id === Number(m![2]));
      if (!variation) return json({ message: "Invalid variation ID." }, 404);
      if (method === "PUT") Object.assign(variation, body);
      return json(variation);
    }
    if ((m = /^wc\/v3\/products\/(\d+)\/variations$/.exec(path))) {
      return json(paginate(wp.products.find((p) => p.id === Number(m![1]))?.variations ?? [], q));
    }
    if ((m = /^wc\/v3\/products\/(\d+)$/.exec(path))) {
      const product = wp.products.find((x) => x.id === Number(m![1]));
      if (!product) return json({ message: "Invalid ID." }, 404);
      if (method === "DELETE") { wp.products.splice(wp.products.indexOf(product), 1); return json({ deleted: true }); }
      if (method !== "GET") Object.assign(product, body);
      return json(product);
    }
    if (path === "wc/store/v1/products") {
      return json(paginate(wp.products.filter((p) => p.status === "publish"), q).map((p) => {
        const cents = (p.variations.length ? p.variations.map((v) => v.price) : [p.price!]).map((x) => String(Math.round(Number(x) * 100)));
        return {
          id: p.id, name: p.name, type: p.type, permalink: `https://${DOMAIN}/product/${p.id}/`, description: p.description, short_description: p.short_description,
          images: p.images, variations: p.variations.map((v) => ({ id: v.id })),
          prices: { price: cents[0], currency_minor_unit: 2, price_range: cents.length > 1 ? { min_amount: cents.sort()[0], max_amount: cents.sort().at(-1) } : null },
        };
      }));
    }
    if (path === "wc/v3/payment_gateways") return json([{ id: "cod", enabled: false }]);
    throw new Error(`unexpected request ${method} ${path}`);
  }) as typeof fetch;
  return { fetchImpl, wp };
}

/** 模拟 CJ：两个类目各搜到商品，其中一个带 Baby 字样（硬规则排除）。 */
export function fakeCj(path: string) {
  if (path.startsWith("/product/listV2")) {
    const kw = new URLSearchParams(path.split("?")[1]).get("keyWord");
    const list = kw === "dog beds"
      ? [{ id: "1001", nameEn: "Dog Bed", bigImage: "https://img/1.jpg", sellPrice: "5.99 -- 7.40", listedNum: 554 }, { id: "1002", nameEn: "Baby Pet Bed", bigImage: "https://img/2.jpg", sellPrice: "3.00", listedNum: 9 }]
      : [{ id: "2001", nameEn: "Pet Blanket", bigImage: "https://img/3.jpg", sellPrice: "4.10", listedNum: 120 }];
    return Promise.resolve({ content: [{ productList: list }] });
  }
  const pid = new URLSearchParams(path.split("?")[1]).get("pid")!;
  const variants = pid === "1001"
    ? [{ variantKey: "Light Grey-S", variantImage: "https://img/grey-s.jpg", variantSellPrice: 5.99, variantWeight: 800, variantLength: 450, variantWidth: 400, variantHeight: 100 }, { variantKey: "Light Grey-M", variantImage: "https://img/grey-m.jpg", variantSellPrice: 7.4, variantWeight: 1000, variantLength: 550, variantWidth: 450, variantHeight: 100 }]
    : [{ variantKey: "Brown", variantImage: "https://img/brown.jpg", variantSellPrice: 4.1, variantWeight: 300, variantLength: 700, variantWidth: 500, variantHeight: 10 }];
  return Promise.resolve({
    pid, productNameEn: pid === "1001" ? "Dog Bed" : "Pet Blanket", categoryName: "Pet Supplies", materialNameEnSet: ["Cloth"],
    description: "<p>Soft cloth.</p>", productImageSet: ["https://img/a.jpg", "https://img/b.jpg"], productKeyEn: pid === "1001" ? "Color-Size" : "Color", variants,
  });
}

export const POLICIES = `=== SHIPPING ===
<h2>Processing and delivery</h2><p>We process orders within 1–3 business days. Delivery takes 5 to 10 business days after shipping. We ship only within the contiguous United States (48 states and Washington, D.C.).</p>
<p>Shipping is free on orders of $49 or more after discounts, excluding taxes and shipping. Otherwise a flat rate of $4.99 applies. Questions? Email ${EMAIL}.</p>
<p>If shipment is delayed, we notify you with a revised shipping date. You may accept the delay or cancel for a full refund. Contact us to cancel before shipment.</p>
<p>For a lost parcel contact support. We check tracking with the carrier and open an investigation, then communicate the outcome and resolve the loss with a refund or replacement as appropriate.</p>
=== RETURNS ===
<h2>Returns</h2><p>Request a return within 30 days after delivery by contacting ${EMAIL}. Wait for approval and return instructions, then ship the item back promptly to Nordic Paws LLC, 1 Main St, Austin, TX 78701. The customer pays return shipping except for damaged, defective or wrong items, for which we pay.</p>
<p>After we receive and inspect your return, we initiate the refund to your original payment method within 5–7 business days of receiving it. Your bank may take additional time to post the credit; timing varies. We do not offer exchanges.</p>
=== PRIVACY ===
<h2>Who we are</h2><p>This store is operated by Nordic Paws LLC. We collect your name, address, email and order details to fulfil orders. Our site is hosted by Hostinger and uses WordPress with WooCommerce. We use essential cookies for cart, checkout and login. We do not enable analytics, advertising pixels or a newsletter. We do not sell personal information. Contact ${EMAIL} with privacy questions.</p>
=== TERMS ===
<h2>Terms</h2><p>These terms govern your use of this store, operated by Nordic Paws LLC. By placing an order you agree to these terms and to our shipping and returns policies. Available payment methods are shown at checkout. Contact ${EMAIL} with any question about these terms.</p>`;

/** 模拟模型：第一次写站点文案时编了成立年份，检查不通过后第二次改好。 */
export function fakeAi(log: string[]) {
  let copyCalls = 0;
  return async (_role: string, prompt: string) => {
    let text: string;
    if (prompt.startsWith("You pick products")) {
      text = JSON.stringify({ keep: [...prompt.matchAll(/"pid":"(\d+)"/g)].map((m) => m[1]) });
      log.push("screen");
    } else if (prompt.startsWith("You write the website copy")) {
      const faq = Array.from({ length: 8 }, (_, i) => ({ q: `Question ${i + 1}?`, a: i === 7 ? "Available payment methods are shown at checkout." : "Orders ship within 1-3 business days and arrive in 5-10 business days." }));
      text = JSON.stringify({
        tagline: "Cozy beds for happy dogs", style: "editorial", hero: { heading: "Rest easy, pup", subheading: "Soft beds and blankets for dogs." },
        about: [
          copyCalls++ === 0
            ? "Founded in 2015 by dog lovers, Nordic Paws is an online store operated by Nordic Paws LLC from Austin, TX, focused on dog beds and blankets."
            : "Nordic Paws is an online store operated by Nordic Paws LLC from Austin, TX. We focus on dog beds and blankets chosen for everyday comfort at home.",
          "Every order ships within the contiguous United States, all 48 states plus Washington, D.C. Orders are processed in 1-3 business days and usually arrive in 5-10 business days after dispatch.",
          "If something is not right, you can request a return within 30 days of delivery. Questions about an order? Email support@nordicpaws.com and we will help.",
        ], faq,
      });
      log.push("copy");
    } else if (prompt.startsWith("You write the legal")) {
      text = POLICIES;
      log.push("policies");
    } else if (prompt.startsWith("You are preparing one factual")) {
      const source = JSON.parse(prompt.split("CJ SOURCE: ")[1].split("\n\nYour previous reply")[0]);
      const variants = source.variants.map((v: { sourceKey: string; attributes: Record<string, string> }) => ({ sourceKey: v.sourceKey, buyerName: Object.values(v.attributes).join(" "), clear: true, pieceCount: null, components: [], color: v.attributes.Color ?? null, evidence: v.sourceKey }));
      text = JSON.stringify({ title: source.name === "Dog Bed" ? "Cozy Dog Bed" : "Pet Blanket", short_description: "Soft cloth.", description_html: `<p style="x">Soft cloth ${source.name === "Dog Bed" ? "bed" : "blanket"}.</p><p>Options: ${variants.map((v: { buyerName: string }) => v.buyerName).join(", ")}.</p>`, materials_and_care_html: null, image_alt: source.name, mainImage: source.candidateImages[0], metaDescription: `Shop ${source.name} in the listed options.`, ogDescription: `Explore ${source.name} and available options.`, variants });
      log.push("product");
    } else if (prompt.startsWith("Review dimension units only")) {
      text = '{"questionable":[]}';
      log.push("units");
    } else if (prompt.startsWith("Group these real products")) {
      const products = JSON.parse(prompt.split("PRODUCTS: ")[1]);
      text = JSON.stringify({ categories: [{ name: "Rest at Home", slug: "rest-at-home", description: "Beds and blankets for dogs.", productIds: products.map((p: { id: number }) => p.id) }] });
      log.push("categories");
    } else if (prompt.startsWith("Design a compact ecommerce homepage")) {
      const data = JSON.parse(prompt.split("DATA: ")[1]);
      text = JSON.stringify({ heading: "Rest easy, pup", subheading: "Soft beds and blankets for dogs.", heroProductId: data.products[0].id, categorySlugs: data.categories.map((c: { slug: string }) => c.slug), featuredProductIds: data.products.map((p: { id: number }) => p.id) });
      log.push("homepage");
    } else if (prompt.startsWith("Write a unique factual search")) {
      const pages = JSON.parse(prompt.split("PAGES: ")[1]);
      text = JSON.stringify({ metadata: pages.map((p: { key: string; title: string }) => ({ key: p.key, description: `${p.title}: information and options from Nordic Paws (${p.key}).`, ogDescription: `Explore ${p.title} at Nordic Paws (${p.key}).` })) });
      log.push("metadata");
    } else if (prompt.startsWith("Design two simple, professional brand assets")) {
      text = "{}"; log.push("branding"); // 无效两次会触发同一确定性保底路径。
    } else if (prompt.startsWith("You are the final compliance reviewer")) {
      text = '{"issues":[]}'; log.push("review");
    } else {
      text = '```json\n{"title":"Cozy Dog Bed","short_description":"A soft bed.","description_html":"<p style=\\"x\\">Soft cloth bed.</p>","image_alt":"Grey dog bed"}\n```';
      log.push("product");
    }
    return { text, cost: 0.001 };
  };
}

/** 假视觉响应与文字响应分开，测试不会因只传 URL 而假装调用过视觉模型。 */
export const fakeVision: VisionComplete = async (prompt, images) => {
  if (prompt.startsWith("Choose the clearest main photo")) return { text: JSON.stringify({ mainImage: images.find((i) => i.url)?.url, reason: "Complete product visible in candidate photo", completeProductVisible: true }), cost: 0 };
  if (prompt.startsWith("Design a restrained ecommerce")) return { text: JSON.stringify(FALLBACK_STYLE), cost: 0 };
  return { text: '{"issues":[]}', cost: 0 };
};

/** 从假站的真实 REST 状态生成页面文字，修复后再次抓取会看到更新，而不是固定通过串。 */
export function fakeBrowse(fetchImpl: typeof fetch): Browse {
  return async (input) => {
    const headers = { Authorization: "Basic " + Buffer.from("site-agent:app pass word 1234").toString("base64") };
    const get = async (path: string) => (await fetchImpl(`https://${DOMAIN}/wp-json/${path}`, { headers })).json();
    const pages = await get("wp/v2/pages?per_page=100") as { slug: string; title: { rendered: string }; content: { rendered: string } }[];
    const products = await get("wc/v3/products?status=publish&per_page=100") as { id: number; name: string; price?: string; variations?: { price: string }[]; description: string; short_description: string }[];
    const site = await get("site-agent/v1/site") as { options: Record<string, unknown>; info: Record<string, string> };
    const htmlText = (html: string | undefined) => (html ?? "")
      .replace(/<\s*(?:br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
    const displayPrice = (product: typeof products[number]) => product.price || product.variations?.[0]?.price || "";
    const names = products.map((p) => `${p.name}${displayPrice(p) ? ` $${displayPrice(p)} USD` : ""}`).join("\n");
    const pagePath = (slug: string) => slug === "home" ? "/" : `/${slug}/`;
    const publishedPages = pages.filter((page) => ["about", "contact", "faq", "shipping", "returns", "privacy-policy", "terms"].includes(page.slug));
    const footerLinks = publishedPages.map((page) => ({ url: new URL(pagePath(page.slug), input.origin).href, text: htmlText(page.title.rendered), location: "footer" as const }));
    const footer = [site.info.entity, site.info.address, site.info.email, site.info.phone].filter(Boolean).join("\n");
    const headerLinks = [
      { url: new URL("/", input.origin).href, text: String(site.options.blogname ?? "Home"), location: "header" as const },
      { url: new URL("/shop/", input.origin).href, text: "Shop", location: "header" as const },
    ];
    const knownStatus = (value: string) => {
      const path = new URL(value, input.origin).pathname;
      if (pages.some((page) => pagePath(page.slug) === path)) return 200;
      if (products.some((product) => `/product/${product.id}/` === path)) return 200;
      if (path.startsWith("/product-category/") || path === "/") return 200;
      return 404;
    };
    const safeAuditUrl = (value: string) => {
      const url = new URL(value, input.origin);
      if (url.origin !== new URL(input.origin).origin || !/^https?:$/.test(url.protocol)) return undefined;
      if (/(?:\/wp-admin(?:\/|$)|\/wp-login\.php(?:\/|$)|\/cart(?:\/|$)|\/checkout(?:\/|$)|\/my-account(?:\/|$))/i.test(url.pathname)
        || /(?:logout|log-out|add-to-cart|remove_item|remove-item|wc-ajax)/i.test(url.pathname + url.search) || url.searchParams.has("_wpnonce")
        || /\.(?:avif|bmp|css|csv|docx?|eot|gif|ico|jpe?g|js|json|mp3|mp4|pdf|png|pptx?|svg|tar|tiff?|ttf|txt|webm|webp|woff2?|xlsx?|xml|zip)$/i.test(url.pathname)) return undefined;
      url.hash = "";
      return url.href;
    };
    const auditKey = (value: string) => {
      const url = new URL(value);
      url.hash = "";
      return url.href;
    };
    const auditCache = new Map<string, number>();
    const capture = (name: string, path: string) => {
      const page = pages.find((p) => (p.slug === "home" ? "/" : `/${p.slug}/`) === path);
      const product = products.find((p) => path === `/product/${p.id}/`);
      const body = [htmlText(page?.title.rendered), htmlText(page?.content.rendered), product?.name, htmlText(product?.description), htmlText(product?.short_description), product && displayPrice(product) ? `$${displayPrice(product)} USD` : "",
        path.startsWith("/shop/") || path.startsWith("/product-category/") || path === "/cart/" || path === "/checkout/" ? names : ""].filter(Boolean).join("\n");
      const bodyLinks = [...(page?.content.rendered.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi) ?? [])]
        .map((match) => ({ url: new URL(match[1], input.origin).href, text: htmlText(match[2]), location: "body" as const }));
      if (path.startsWith("/shop/") || path.startsWith("/product-category/")) bodyLinks.push(...products.map((p) => ({ url: `${input.origin}/product/${p.id}/`, text: p.name, location: "body" as const })));
      const links = [...headerLinks, ...bodyLinks, ...footerLinks];
      const productLinks = links.map((link) => link.url);
      const audited = new Map<string, string>();
      if (input.auditInternalLinks) for (const link of links) {
        const url = safeAuditUrl(link.url);
        if (url && !audited.has(auditKey(url))) audited.set(auditKey(url), url);
      }
      const linkStatuses = input.auditInternalLinks ? [...audited].map(([key, url]) => {
        const status = auditCache.get(key) ?? knownStatus(url);
        auditCache.set(key, status);
        return { url, status };
      }) : undefined;
      const sections = { header: headerLinks.map((link) => link.text).join("\n"), footer, body };
      return { name, path, url: input.origin + path, text: [sections.header, body, footer].filter(Boolean).join("\n\n"), productLinks, sections, links, linkStatuses, status: knownStatus(path), shot: join(input.outDir, `${name}.png`) };
    };
    const captures = [...input.pages.map((p) => capture(p.name, p.path)), ...(input.cart ? [capture("cart", "/cart/"), capture("checkout", "/checkout/")] : []), capture("home-mobile", "/")];
    return { captures, shots: captures.map((p) => ({ name: p.name, file: p.shot })), problems: [] };
  };
}

export function deps(db: PipelineDeps["db"], exec: HostingerExec, fetchImpl: typeof fetch, events: unknown[], extra: Partial<PipelineDeps> = {}): PipelineDeps {
  let now = 0;
  return {
    db,
    key,
    hostinger: () => exec,
    fetch: fetchImpl,
    emit: (e) => events.push(e),
    resourcesDir: RESOURCES,
    workDir: mkdtempSync(join(tmpdir(), "pipeline-test-")),
    now: () => (now += 1000),
    ai: fakeAi([]),
    cj: fakeCj,
    browse: fakeBrowse(fetchImpl),
    vision: fakeVision,
    renderBranding: async (_svg, kind) => Buffer.from(`fake-png-${kind}`),
    inbox: async () => true,
    ...extra,
  };
}

export async function runToEnd(d: PipelineDeps, siteId: number) {
  let waits = 0;
  for (let i = 0; i < 60; i++) {
    const r = await provisionSite(d, siteId);
    if (!r) return waits;
    waits++;
  }
  throw new Error("pipeline did not finish");
}

/** 邮箱管理测试专用的纯内存 IMAP/SMTP；不会创建套接字。 */
export class FakeMailTransport implements MailTransport {
  readonly passwords = new Map<string, string>();
  readonly folders = new Map<string, Map<string, RemoteMessage[]>>();
  readonly sent: { credentials: MailCredentials; message: OutgoingMessage }[] = [];
  readonly idleStarts: { address: string; password: string }[] = [];
  readonly idleStops: string[] = [];
  readonly downloads = new Map<string, Buffer>();

  seed(address: string, folder: string, messages: RemoteMessage[]): void {
    let byFolder = this.folders.get(address.toLowerCase());
    if (!byFolder) { byFolder = new Map(); this.folders.set(address.toLowerCase(), byFolder); }
    byFolder.set(folder, messages.map((message) => ({ ...message, source: message.source ? Buffer.from(message.source) : undefined, flags: [...message.flags] })));
  }

  async verify(credentials: MailCredentials): Promise<void> {
    const expected = this.passwords.get(credentials.address.toLowerCase());
    if (expected == null || expected !== credentials.password) throw new Error("IMAP authentication failed");
  }

  async listFolders(credentials: MailCredentials): Promise<RemoteFolder[]> {
    await this.verify(credentials);
    const names = this.folders.has(credentials.address.toLowerCase())
      ? [...this.folders.get(credentials.address.toLowerCase())!.keys()]
      : ["INBOX", "Sent"];
    return names.map((path) => ({ path, name: path, specialUse: /^sent$/i.test(path) ? "\\Sent" : /^trash$/i.test(path) ? "\\Trash" : /^inbox$/i.test(path) ? "\\Inbox" : null }));
  }

  async fetchMessages(credentials: MailCredentials, folder: string): Promise<RemoteMessage[]> {
    await this.verify(credentials);
    return (this.folders.get(credentials.address.toLowerCase())?.get(folder) ?? []).map((message) => ({ ...message, source: message.source ? Buffer.from(message.source) : undefined, flags: [...message.flags] }));
  }

  async *streamMessages(credentials: MailCredentials, folder: string, known?: { uidValidity?: string; uids: ReadonlySet<number> }) {
    const messages = await this.fetchMessages(credentials, folder);
    const uidValidity = messages[0]?.uidValidity ?? "1";
    yield { kind: "mailbox" as const, uidValidity };
    for (const message of messages) yield {
      kind: "message" as const,
      message: known?.uidValidity === uidValidity && known.uids.has(message.uid) ? { ...message, source: undefined } : message,
    };
  }

  async fetchMessage(credentials: MailCredentials, folder: string, uid: number): Promise<RemoteMessage | null> {
    return (await this.fetchMessages(credentials, folder)).find((message) => message.uid === uid) ?? null;
  }

  async setSeen(credentials: MailCredentials, folder: string, uid: number, seen: boolean): Promise<void> {
    await this.verify(credentials);
    const message = this.folders.get(credentials.address.toLowerCase())?.get(folder)?.find((item) => item.uid === uid);
    if (!message) throw new Error("message missing");
    message.flags = seen ? [...new Set([...message.flags, "\\Seen"])] : message.flags.filter((flag) => flag !== "\\Seen");
  }

  async moveToTrash(credentials: MailCredentials, folder: string, uid: number): Promise<void> {
    await this.verify(credentials);
    const source = this.folders.get(credentials.address.toLowerCase())?.get(folder);
    const index = source?.findIndex((item) => item.uid === uid) ?? -1;
    if (!source || index < 0) throw new Error("message missing");
    const [message] = source.splice(index, 1);
    let trash = this.folders.get(credentials.address.toLowerCase())?.get("Trash");
    if (!trash) { trash = []; this.folders.get(credentials.address.toLowerCase())?.set("Trash", trash); }
    trash.push({ ...message, folder: "Trash" });
  }

  async downloadAttachment(credentials: MailCredentials, folder: string, uid: number, attachment: MailAttachment): Promise<Buffer> {
    await this.verify(credentials);
    const value = this.downloads.get(`${credentials.address}:${folder}:${uid}:${attachment.partId}`);
    if (!value) throw new Error("attachment missing");
    return Buffer.from(value);
  }

  async send(credentials: MailCredentials, message: OutgoingMessage): Promise<SendResult> {
    await this.verify(credentials);
    this.sent.push({ credentials: { ...credentials }, message: { ...message, attachments: message.attachments.map((item) => ({ ...item, content: Buffer.from(item.content) })) } });
    const folders = this.folders.get(credentials.address.toLowerCase()) ?? new Map<string, RemoteMessage[]>();
    this.folders.set(credentials.address.toLowerCase(), folders);
    const sent = folders.get("Sent") ?? [];
    folders.set("Sent", sent);
    if (!sent.some((item) => item.source?.includes(message.messageId))) sent.push({ uid: Math.max(0, ...sent.map((item) => item.uid)) + 1, folder: "Sent", flags: ["\\Seen"], size: Buffer.byteLength(message.text), source: fakeRawMail({ from: message.from, to: message.to, cc: message.cc, subject: message.subject, text: message.text, messageId: message.messageId, inReplyTo: message.inReplyTo, references: message.references }) });
    return { messageId: message.messageId, appended: true };
  }

  async idle(credentials: MailCredentials, _onExists: () => void | Promise<void>, signal: AbortSignal): Promise<void> {
    await this.verify(credentials);
    this.idleStarts.push({ address: credentials.address, password: credentials.password });
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    this.idleStops.push(credentials.address);
  }
}

export function fakeRawMail(input: { from: string; to: string[]; cc?: string[]; subject: string; text?: string; html?: string; messageId?: string; inReplyTo?: string; references?: string[] }): Buffer {
  const headers = [
    `From: ${input.from}`, `To: ${input.to.join(", ")}`, ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${input.subject}`, `Date: ${new Date("2026-10-15T12:00:00Z").toUTCString()}`,
    `Message-ID: ${input.messageId ?? `<fake-${randomBytes(4).toString("hex")}@example.test>`}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []), ...(input.references?.length ? [`References: ${input.references.join(" ")}`] : []),
    "MIME-Version: 1.0", `Content-Type: ${input.html != null ? "text/html" : "text/plain"}; charset=utf-8`, "",
    input.html ?? input.text ?? "",
  ];
  return Buffer.from(headers.join("\r\n"));
}

