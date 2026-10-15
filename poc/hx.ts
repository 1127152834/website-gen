// POC：经 Hostinger 官方 MCP 执行单个操作。
// 用法：node --env-file=.env poc/hx.ts <operation> '<json params>'
// 参数里写 "$secret:<名字>" 会替换成本机生成的强密码（存 poc/out/secrets.json，已被 git 忽略），输出里一律脱敏。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [op, raw = "{}"] = process.argv.slice(2);
if (!op) throw new Error("usage: hx.ts <operation> '<json params>'");
const token = process.env.HOSTINGER_TOKEN_MAIN;
if (!token) throw new Error("HOSTINGER_TOKEN_MAIN missing in .env");

mkdirSync("poc/out", { recursive: true });
const SECRETS = "poc/out/secrets.json";
const secrets: Record<string, string> = existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, "utf8")) : {};
// 满足 WP（大小写 + 数字）和邮箱（再加特殊字符）的密码规则
const newSecret = () => `Aa1!${randomBytes(15).toString("base64url")}`;
const params = JSON.parse(raw, (_k, v) => {
  if (typeof v !== "string" || !v.startsWith("$secret:")) return v;
  const name = v.slice("$secret:".length);
  secrets[name] ??= newSecret();
  writeFileSync(SECRETS, JSON.stringify(secrets, null, 2));
  return secrets[name];
});
const redact = (s: string) => Object.values(secrets).reduce((acc, v) => acc.split(v).join("***"), s);

const client = new Client({ name: "website-gen-poc", version: "0.0.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ["node_modules/@hostinger/mcp/src/servers/all.js"],
  env: { HOSTINGER_API_TOKEN: token, PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
  stderr: "ignore",
}));
const t0 = performance.now();
// 部署主题/插件是逐个文件上传，可能超过 MCP SDK 默认的 60 秒超时
const res = await client.callTool({ name: "execute", arguments: { operation: op, params } }, undefined, { timeout: 10 * 60_000 });
const ms = Math.round(performance.now() - t0);
await client.close();

const text = redact((res.content as { text?: string }[]).map((c) => c.text ?? "").join(""));
const file = `poc/out/hx-${op}-${Date.now()}.json`;
writeFileSync(file, text);
console.log(`${res.isError ? "✘" : "✔"} ${op} ${ms}ms → ${file}`);
console.log(text.length > 1500 ? text.slice(0, 1500) + " …" : text);
if (res.isError) process.exitCode = 1;
