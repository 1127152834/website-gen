// POC：Hostinger 官方 MCP。
// 1) 不需要 Token：本机起 MCP 进程，用 search 拿方案用到的全部操作的参数 schema → poc/out/hostinger-ops.json
// 2) 需要 Token：对 .env 里每个 HOSTINGER_TOKEN_<标签> 起一个进程，只跑只读操作，统计资源并测延迟
// 用法：npm run poc:hostinger
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OPS = [
  "hosting_orders_list", "hosting_websites_list", "hosting_websites_create", "hosting_websites_start-setup", "hosting_websites_list-setups",
  "agency-hosting_websites_list-plan", "agency-hosting_website-setups_create", "agency-hosting_website-setups_status",
  "hosting_deploy-wordpress-plugin", "hosting_deploy-wordpress-theme", "hosting_import-wordpress-website",
  "hosting_ssl_install", "hosting_ssl_status", "hosting_ssl_toggle-https-redirect",
  "wordpress_installations_install", "wordpress_installations_list", "wordpress_plugins_install", "wordpress_plugins_activate",
  "wordpress_themes_activate", "wordpress_login_create-links", "wordpress_maintenance_toggle",
  "domains_portfolio_list", "domains_portfolio_get", "dns_records_list", "dns_records_update", "dns_records_validate", "dns_snapshots_list", "dns_snapshots_restore",
  "mail_orders_list", "mail_orders_plan", "mail_mailboxes_list", "mail_mailboxes_create-mailbox",
];
// 有 Token 时执行的只读操作（不改动任何东西）
const READ_ONLY = ["hosting_orders_list", "hosting_websites_list", "domains_portfolio_list", "mail_orders_list"];

const SERVER = "node_modules/@hostinger/mcp/src/servers/all.js";

async function connect(token?: string) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" };
  if (token) env.HOSTINGER_API_TOKEN = token;
  const client = new Client({ name: "website-gen-poc", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "ignore" }));
  return client;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");

// 1) schema：不带 Token，只调用纯本地的 search
const schemaClient = await connect();
const tools = (await schemaClient.listTools()).tools.map((t) => t.name);
console.log("MCP tools:", tools.join(", "));
const ops: Record<string, unknown> = {};
const missing: string[] = [];
for (const op of OPS) {
  const res = await schemaClient.callTool({ name: "search", arguments: { query: op.replace(/[_-]/g, " "), limit: 10 } });
  const hit = (JSON.parse(text(res).startsWith("[") ? text(res) : "[]") as { operation: string }[]).find((r) => r.operation === op);
  if (hit) ops[op] = hit; else missing.push(op);
}
await schemaClient.close();
mkdirSync("poc/out", { recursive: true });
writeFileSync("poc/out/hostinger-ops.json", JSON.stringify(ops, null, 2));
console.log(`schemas: ${Object.keys(ops).length}/${OPS.length} found → poc/out/hostinger-ops.json`);
if (missing.length) console.log("not found by exact name:", missing.join(", "));

// 2) 只读调用：每个账号一个 MCP 进程
const accounts = Object.entries(process.env).filter(([k, v]) => k.startsWith("HOSTINGER_TOKEN_") && v);
if (accounts.length === 0) console.log("no HOSTINGER_TOKEN_* set in .env → skip read-only calls");
for (const [key, token] of accounts) {
  const label = key.slice("HOSTINGER_TOKEN_".length);
  const client = await connect(token);
  for (const op of READ_ONLY) {
    const t0 = performance.now();
    const res = await client.callTool({ name: "execute", arguments: { operation: op, params: {} } });
    const ms = Math.round(performance.now() - t0);
    const body = text(res);
    if (res.isError) { console.log(`✘ [${label}] ${op} ${ms}ms → ${body.slice(0, 200)}`); continue; }
    const data = JSON.parse(body);
    const items = Array.isArray(data) ? data : data?.data ?? data;
    const count = Array.isArray(items) ? items.length : "?";
    console.log(`✔ [${label}] ${op} ${ms}ms → ${count} items`);
    writeFileSync(`poc/out/hostinger-${label.toLowerCase()}-${op}.json`, JSON.stringify(data, null, 2));
  }
  await client.close();
}
