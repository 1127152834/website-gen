// POC：部署站点伴侣插件 → 激活 → 本机用一次性令牌注册拿到应用密码 → 健康检查 → 令牌重放必须被拒。
// 用法：node --env-file=.env poc/enroll.ts <domain> <hostinger username> <wp software id>
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [domain, username, software] = process.argv.slice(2);
if (!domain || !username || !software) throw new Error("usage: enroll.ts <domain> <username> <software>");

// 1) 该站专用的插件副本：模板 + enroll.php（只存令牌哈希，15 分钟过期）
const token = randomBytes(32).toString("base64url");
const dir = resolve(`poc/out/companion-${domain}/site-companion`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
cpSync("resources/site-companion", dir, { recursive: true });
const hash = createHash("sha256").update(token).digest("hex");
writeFileSync(`${dir}/enroll.php`, `<?php\nreturn array( 'token_hash' => '${hash}', 'expires' => ${Math.floor(Date.now() / 1000) + 15 * 60} );\n`);

const client = new Client({ name: "website-gen-poc", version: "0.0.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ["node_modules/@hostinger/mcp/src/servers/all.js"],
  env: { HOSTINGER_API_TOKEN: process.env.HOSTINGER_TOKEN_MAIN ?? "", PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
  stderr: "ignore",
}));
async function exec(operation: string, params: object) {
  const t0 = performance.now();
  const r = await client.callTool({ name: "execute", arguments: { operation, params } }, undefined, { timeout: 10 * 60_000 });
  const text = (r.content as { text?: string }[]).map((c) => c.text ?? "").join("");
  console.log(`${r.isError ? "✘" : "✔"} ${operation} ${Math.round(performance.now() - t0)}ms ${r.isError ? text.slice(0, 200) : ""}`);
  return { ok: !r.isError, text };
}

// 2) 部署 + 激活。Hostinger 写操作可能 500 但实际已完成（POC 实测），所以失败后用只读接口确认
await exec("hosting_deploy-wordpress-plugin", { domain, slug: "site-companion", pluginPath: dir });
const act = await exec("wordpress_plugins_activate", { username, software, plugin: "site-companion" });
if (!act.ok) {
  const list = await exec("wordpress_plugins_list-installed", { username, software });
  const plugins = JSON.parse(list.text) as { slug?: string; status?: string }[];
  console.log("  verify:", JSON.stringify(plugins.find((p) => p.slug === "site-companion") ?? "not installed"));
}
await client.close();

// 3) 注册：HTTPS + 一次性令牌，换回应用密码（只返回这一次）
const base = `https://${domain}/wp-json/site-agent/v1`;
const enroll = await fetch(`${base}/enroll`, { method: "POST", headers: { "X-Site-Agent-Enroll": token } });
const body = await enroll.json() as { username?: string; password?: string; code?: string; message?: string };
if (!enroll.ok || !body.password) throw new Error(`enroll failed: HTTP ${enroll.status} ${body.code} ${body.message}`);
console.log(`✔ enroll HTTP ${enroll.status} → user ${body.username}, app password received (${body.password.length} chars)`);
const SECRETS = "poc/out/secrets.json";
const secrets = existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, "utf8")) : {};
secrets[`companion_${domain}`] = { username: body.username, password: body.password };
writeFileSync(SECRETS, JSON.stringify(secrets, null, 2));

// 4) 用应用密码调健康检查
const auth = "Basic " + Buffer.from(`${body.username}:${body.password}`).toString("base64");
const health = await fetch(`${base}/health`, { headers: { Authorization: auth } });
console.log(`${health.ok ? "✔" : "✘"} health HTTP ${health.status} →`, await health.text());

// 5) 同一个令牌再来一次，必须 403
const replay = await fetch(`${base}/enroll`, { method: "POST", headers: { "X-Site-Agent-Enroll": token } });
console.log(`${replay.status === 403 ? "✔" : "✘"} replay with same token → HTTP ${replay.status} (expect 403)`);
