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
import type { BrowseInput } from "./qa-browser.ts";
import type { ZoneGroup } from "./mail.ts";
import type { BatchForm } from "../shared/forms.ts";
import { PROVISION_STEPS } from "../shared/protocol.ts";

export const key = randomBytes(32);
export const DOMAIN = "nordicpaws.com";
export const EMAIL = `support@${DOMAIN}`;
export const RESOURCES = join(import.meta.dirname, "../../resources");
export const THEME_VERSION = /Version:\s*([\d.]+)/.exec(readFileSync(join(RESOURCES, "theme/obel/style.css"), "utf8"))![1];

export function setup() {
  const db = openDb(":memory:");
  migrate(db);
  db.prepare("INSERT INTO hostinger_accounts (id, label, token_ciphertext, token_hint, status, created_at) VALUES (1, '主账号', ?, 'abcd', 'ok', 0)").run(seal(key, "tok"));
  db.prepare("INSERT INTO hosting_orders VALUES (1, 1010129013, 'hostinger_unlimited_v6', 'active', '2026-10-03')").run();
  db.prepare("INSERT INTO domains VALUES (1, 7, ?, 'domain', 'active', '2027-10-01', '2026-10-01')").run(DOMAIN);
  const form: BatchForm = {
    entity: { kind: "company", name: "Nordic Paws LLC", address: "1 Main St, Austin, TX 78701", supportEmail: "auto", phone: "+1 512 555 0100", processingDays: [1, 3], transitDays: [5, 10] },
    sites: [{ domain: DOMAIN, categories: "dog beds, pet blankets", count: 2, priceMin: null, priceMax: null, brand: "" }],
  };
  const { siteIds } = createBatch(db, form, 0);
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
    // 邮箱：域名有一个邮箱订单，还没有邮箱；DNS 只有 Hostinger 的默认 MX 和 SPF，缺 DKIM 和 DMARC
    mailOrders: [{ id: "OR1", status: "active", domain: { name: DOMAIN } }],
    mailboxes: [] as { id: string; address: string; status: string }[],
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
    pages: new Map<number, Page>([
      [3, { id: 3, slug: "privacy-policy", title: "Privacy Policy", content: "draft", status: "draft" }],
      ...["shop", "cart", "checkout", "my-account"].map((slug, i): [number, Page] => [10 + i, { id: 10 + i, slug, title: slug, content: "", status: "publish" }]),
    ]),
    settings: {} as Record<string, unknown>,
    styles: null as unknown,
    failSiteWrites: false,
    // 伴侣插件的 SMTP：保存的设置、发出的测试邮件；failSmtp 模拟密码错误
    smtp: null as null | { host: string; port: number; username: string; password: string; from_email: string },
    sentMails: [] as { to: string; subject: string; viaSmtp: boolean }[],
    failSmtp: false,
    zones: [] as { id: number; name: string; locations: unknown[]; methods: { method_id: string; enabled: boolean; settings: unknown }[] }[],
    categories: [] as { id: number; name: string; slug: string }[],
    products: [] as { id: number; sku: string; status: string; name: string; type: string; price?: string; images: unknown[]; variations: { id: number; price: string }[]; description: string; short_description: string; featured: boolean }[],
  };
  const json = (v: unknown, status = 200) => Response.json(v, { status });

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
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
    if (path === "site-agent/v1/health") return json({ wp: "7.1.3", woocommerce: "11.2.1", theme: `obel ${THEME_VERSION}` });
    if (path === "site-agent/v1/site") {
      if (method === "POST" && wp.failSiteWrites) return json({ message: "boom" }, 500);
      if (method === "POST") {
        Object.assign(wp.options, body.options ?? {});
        if (body.info) wp.info = body.info;
      }
      return json({ options: wp.options, info: wp.info });
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
      return json([...wp.pages.values()].filter((p) => slugs.includes(p.slug) && statuses.includes(p.status) && !hidden(p)).map((p) => ({ id: p.id, slug: p.slug, status: p.status, title: { raw: p.title, rendered: p.title }, content: { raw: p.content, rendered: p.content } })));
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
      if (m[2] === "locations") return json((zone.locations = body));
      if (method === "POST") zone.methods.push({ method_id: body.method_id, enabled: true, settings: body.settings });
      return json(zone.methods);
    }
    if (path === "wc/v3/products/categories") {
      if (method === "POST") wp.categories.push({ id: nextId++, name: body.name, slug: body.slug });
      return json(method === "POST" ? wp.categories.at(-1) : wp.categories.filter((c) => c.slug === q.get("slug")));
    }
    if (path === "wc/v3/products" && method === "GET") return json(q.has("sku") ? wp.products.filter((p) => p.sku === q.get("sku")) : wp.products);
    if (path === "wc/v3/products") {
      const p = { id: nextId++, variations: [], ...body, price: body.regular_price };
      wp.products.push(p);
      return json(p, 201);
    }
    if ((m = /^wc\/v3\/products\/(\d+)\/variations\/batch$/.exec(path))) {
      const p = wp.products.find((x) => x.id === Number(m![1]))!;
      const created = body.create.map((v: { regular_price: string }) => ({ id: nextId++, price: v.regular_price }));
      p.variations.push(...created);
      return json({ create: created });
    }
    if ((m = /^wc\/v3\/products\/(\d+)$/.exec(path))) {
      const product = wp.products.find((x) => x.id === Number(m![1]));
      if (!product) return json({ message: "Invalid ID." }, 404);
      if (method !== "GET") Object.assign(product, body);
      return json(product);
    }
    if (path === "wc/store/v1/products") {
      return json(wp.products.filter((p) => p.status === "publish").map((p) => {
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
    ? [{ variantKey: "Light Grey-S", variantSellPrice: 5.99, variantWeight: 800, variantLength: 450, variantWidth: 400, variantHeight: 100 }, { variantKey: "Light Grey-M", variantSellPrice: 7.4, variantWeight: 1000, variantLength: 550, variantWidth: 450, variantHeight: 100 }]
    : [{ variantKey: "Brown", variantSellPrice: 4.1, variantWeight: 300, variantLength: 700, variantWidth: 500, variantHeight: 10 }];
  return Promise.resolve({
    pid, productNameEn: pid === "1001" ? "Dog Bed" : "Pet Blanket", categoryName: "Pet Supplies", materialNameEnSet: ["Cloth"],
    description: "<p>Soft cloth.</p>", productImageSet: ["https://img/a.jpg", "https://img/b.jpg"], productKeyEn: pid === "1001" ? "Color-Size" : "Color", variants,
  });
}

export const POLICIES = `=== SHIPPING ===
<h2>Processing and delivery</h2><p>We process orders within 1–3 business days. Delivery takes 5 to 10 business days after shipping. We ship only within the contiguous United States.</p>
<p>Shipping is free on orders of $49 or more. Otherwise a flat rate of $4.99 applies. Questions? Email ${EMAIL}.</p>
=== RETURNS ===
<h2>Returns</h2><p>You may return items within 30 days of delivery. If an item arrives damaged or wrong, we pay the return shipping.</p>
<ul><li>Refunds go to your original payment method within 5-7 business days after we receive the return.</li><li>We do not offer exchanges.</li></ul><p>Contact ${EMAIL}.</p>
=== PRIVACY ===
<h2>Who we are</h2><p>This store is operated by Nordic Paws LLC. We collect your name, address, email and order details to fulfil orders. Payments are handled by Stripe and PayPal. Our site is hosted by Hostinger. Contact ${EMAIL} with any privacy question.</p>
=== TERMS ===
<h2>Terms</h2><p>These terms govern your use of this store, operated by Nordic Paws LLC. By placing an order you agree to these terms and to our shipping and returns policies. Contact ${EMAIL} with any question about these terms.</p>`;

/** 模拟模型：第一次写站点文案时编了成立年份，检查不通过后第二次改好。 */
export function fakeAi(log: string[]) {
  let copyCalls = 0;
  return async (_role: string, prompt: string) => {
    let text: string;
    if (prompt.startsWith("You pick products")) {
      text = JSON.stringify({ keep: [...prompt.matchAll(/"pid":"(\d+)"/g)].map((m) => m[1]) });
      log.push("screen");
    } else if (prompt.startsWith("You write the website copy")) {
      const faq = Array.from({ length: 8 }, (_, i) => ({ q: `Question ${i + 1}?`, a: "Orders ship within 1-3 business days and arrive in 5-10 business days." }));
      text = JSON.stringify({
        tagline: "Cozy beds for happy dogs", style: "editorial", hero: { heading: "Rest easy, pup", subheading: "Soft beds and blankets for dogs." },
        about: [copyCalls++ === 0 ? "Founded in 2015 by dog lovers." : "Nordic Paws sells dog beds and blankets.", "We are operated by Nordic Paws LLC."], faq,
      });
      log.push("copy");
    } else if (prompt.startsWith("You write the legal")) {
      text = POLICIES;
      log.push("policies");
    } else {
      text = '```json\n{"title":"Cozy Dog Bed","short_description":"A soft bed.","description_html":"<p style=\\"x\\">Soft cloth bed.</p>","image_alt":"Grey dog bed"}\n```';
      log.push("product");
    }
    return { text, cost: 0.001 };
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
    browse: async (input) => ({ shots: input.pages.map((p) => ({ name: p.name, file: `${p.name}.png` })), problems: [] }),
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

