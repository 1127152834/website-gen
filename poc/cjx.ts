// POC：调用单个 CJ MCP 工具。accessToken 来自 poc/out/cj-token.json（先跑 npm run poc:cj），输出里脱敏。
// 用法：node --env-file=.env poc/cjx.ts <tool> '<json args>'
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [tool, raw = "{}"] = process.argv.slice(2);
if (!tool) throw new Error("usage: cjx.ts <tool> '<json args>'");
const token: string = JSON.parse(readFileSync("poc/out/cj-token.json", "utf8")).accessToken;

const client = new Client({ name: "website-gen-poc", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`https://developers.cjdropshipping.com/mcp/${token}`)));
const t0 = performance.now();
const res = await client.callTool({ name: tool, arguments: JSON.parse(raw) }, undefined, { timeout: 5 * 60_000 });
await client.close();

const text = (res.content as { text?: string }[]).map((c) => c.text ?? "").join("").split(token).join("***");
const file = `poc/out/cjx-${tool}-${Date.now()}.json`;
writeFileSync(file, text);
console.log(`${res.isError ? "✘" : "✔"} ${tool} ${Math.round(performance.now() - t0)}ms → ${file}`);
console.log(text.length > 2000 ? text.slice(0, 2000) + " …" : text);
if (res.isError) process.exitCode = 1;
