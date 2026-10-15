import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "./db.ts";
import { createBatch, siteSteps } from "./batches.ts";
import { HostingerError, type HostingerExec } from "./hostinger.ts";
import { PermanentError } from "./jobs.ts";
import { provisionSite, type PipelineDeps } from "./pipeline.ts";
import { seal, unseal } from "./secrets.ts";
import type { BatchForm } from "../shared/forms.ts";

const key = randomBytes(32);
const DOMAIN = "nordicpaws.com";

function setup() {
  const db = openDb(":memory:");
  migrate(db);
  db.prepare("INSERT INTO hostinger_accounts (id, label, token_ciphertext, token_hint, status, created_at) VALUES (1, '主账号', ?, 'abcd', 'ok', 0)").run(seal(key, "tok"));
  db.prepare("INSERT INTO hosting_orders VALUES (1, 1010129013, 'hostinger_unlimited_v6', 'active', '2026-10-03')").run();
  db.prepare("INSERT INTO domains VALUES (1, 7, ?, 'domain', 'active', '2027-10-01', '2026-10-01')").run(DOMAIN);
  const form: BatchForm = {
    entity: { kind: "company", name: "Nordic Paws LLC", address: "1 Main St", supportEmail: "auto", phone: "+1 512 555 0100", shipping: "1–3 天处理，5–10 天送达" },
    sites: [{ domain: DOMAIN, categories: "dog beds", count: 20, priceMin: null, priceMax: null, brand: "" }],
  };
  const { siteIds } = createBatch(db, form, 0);
  return { db, siteId: siteIds[0] };
}

/** 模拟 Hostinger：建站第二次轮询才完成；装插件返回 500 但实际已装好（POC 实测的行为）。 */
function fakeHostinger(opts: { websiteAlreadyThere?: boolean } = {}) {
  const st = {
    websites: new Set<string>(opts.websiteAlreadyThere ? [DOMAIN] : []),
    setup: null as null | { status: string; polls: number },
    installed: false,
    plugins: new Map<string, string>([["hostinger", "active"]]),
    themes: new Map<string, string>([["twentytwentyfive", "active"]]),
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
        return { status: "enabled" };
      case "wordpress_plugins_list-installed":
        return [...st.plugins].map(([name, status]) => ({ name, status }));
      case "wordpress_plugins_install":
        for (const n of params.plugins) st.plugins.set(n, "active");
        throw new HostingerError("HTTP 500: [Hosting:9999] Request failed", 500);
      case "wordpress_plugins_activate":
        st.plugins.set(params.plugin, "active");
        return {};
      case "wordpress_themes_list-installed":
        return [...st.themes].map(([name, status]) => ({ name, status }));
      case "hosting_deploy-wordpress-theme":
        for (const k of st.themes.keys()) st.themes.set(k, "inactive");
        st.themes.set(params.slug, params.activate ? "active" : "inactive");
        return { status: "success" };
      case "hosting_deploy-wordpress-plugin":
        st.plugins.set(params.slug, "inactive");
        st.pluginDeploys.push(params.pluginPath);
        return { status: "success" };
      default:
        throw new Error(`unexpected operation ${op}`);
    }
  };
  return { st, exec };
}

/** 模拟插件的注册接口：真的读取部署出去的 enroll.php，校验令牌哈希和代数。 */
function fakeSite(st: ReturnType<typeof fakeHostinger>["st"], opts: { rejectFirst?: boolean } = {}) {
  let enrolledGen = 0;
  let rejectNext = opts.rejectFirst ?? false;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/enroll")) {
      const php = readFileSync(join(st.pluginDeploys.at(-1)!, "enroll.php"), "utf8");
      const hash = /'token_hash' => '([0-9a-f]+)'/.exec(php)![1];
      const gen = Number(/'generation' => (\d+)/.exec(php)![1]);
      const token = new Headers(init?.headers).get("X-Site-Agent-Enroll") ?? "";
      const ok = !rejectNext && gen > enrolledGen && createHash("sha256").update(token).digest("hex") === hash;
      rejectNext = false;
      if (!ok) return new Response("{}", { status: 403 });
      enrolledGen = gen;
      return Response.json({ username: "site-agent", password: "app pass word 1234" });
    }
    if (u.endsWith("/health")) return Response.json({ wp: "7.1.3", woocommerce: "11.2.1", theme: "obel 1.0.0" });
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  return fetchImpl;
}

function deps(db: PipelineDeps["db"], exec: HostingerExec, fetchImpl: typeof fetch, events: unknown[]): PipelineDeps {
  let now = 0;
  return {
    db,
    key,
    hostinger: () => exec,
    fetch: fetchImpl,
    emit: (e) => events.push(e),
    resourcesDir: join(import.meta.dirname, "../../resources"),
    workDir: mkdtempSync(join(tmpdir(), "pipeline-test-")),
    now: () => (now += 1000),
  };
}

async function runToEnd(d: PipelineDeps, siteId: number) {
  let waits = 0;
  for (let i = 0; i < 30; i++) {
    const r = await provisionSite(d, siteId);
    if (!r) return waits;
    waits++;
  }
  throw new Error("pipeline did not finish");
}

test("a new site goes through all front-half steps; Hostinger 500s are verified, not trusted", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const events: unknown[] = [];
  const waits = await runToEnd(deps(db, exec, fakeSite(st), events), siteId);

  assert.ok(waits >= 1, "waited for the WordPress install");
  assert.ok(siteSteps(db, siteId).every((s) => s.status === "done" || s.status === "skipped"));
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId) as Record<string, any>;
  assert.equal(site.status, "done");
  assert.equal(site.wp_software_id, "31100468");
  assert.equal(st.plugins.get("woocommerce"), "active");
  assert.equal(st.themes.get("obel"), "active");
  assert.equal(st.plugins.get("site-companion"), "active");
  assert.deepEqual(JSON.parse(unseal(key, site.companion_ciphertext)), { username: "site-agent", password: "app pass word 1234" });

  // 日志里有 MCP 调用记录，但绝不能出现密码
  const log = JSON.stringify(events);
  assert.ok(log.includes("hosting_websites_start-setup"));
  assert.ok(!log.includes(JSON.parse(unseal(key, site.wp_admin_ciphertext)).password));
  assert.ok(!log.includes("app pass word 1234"));
});

test("a domain that already has a website stops permanently instead of being overwritten", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger({ websiteAlreadyThere: true });
  await assert.rejects(provisionSite(deps(db, exec, fakeSite(st), []), siteId), PermanentError);
  assert.ok(!st.calls.includes("hosting_websites_start-setup"));
});

test("a rejected enrollment redeploys the companion with a newer generation and then succeeds", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const d = deps(db, exec, fakeSite(st, { rejectFirst: true }), []);
  await assert.rejects(runToEnd(d, siteId), /重新部署/);
  await runToEnd(d, siteId);
  assert.equal(st.pluginDeploys.length, 2);
  const site = db.prepare("SELECT status FROM sites WHERE id = ?").get(siteId) as { status: string };
  assert.equal(site.status, "done");
});
