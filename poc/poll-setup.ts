// POC：轮询 Hostinger 建站进度，直到不再是 running（最多 10 分钟）。
// 用法：node --env-file=.env poc/poll-setup.ts <domain>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setTimeout as sleep } from "node:timers/promises";

const domain = process.argv[2];
if (!domain) throw new Error("usage: poll-setup.ts <domain>");
const client = new Client({ name: "website-gen-poc", version: "0.0.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ["node_modules/@hostinger/mcp/src/servers/all.js"],
  env: { HOSTINGER_API_TOKEN: process.env.HOSTINGER_TOKEN_MAIN ?? "", PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
  stderr: "ignore",
}));

const t0 = Date.now();
let last = "";
while (Date.now() - t0 < 10 * 60_000) {
  const res = await client.callTool({ name: "execute", arguments: { operation: "hosting_websites_list-setups", params: { domain } } });
  const text = (res.content as { text?: string }[]).map((c) => c.text ?? "").join("");
  const setup = JSON.parse(text)?.[0];
  const status = setup?.status ?? "missing";
  const elapsed = Math.round((Date.now() - t0) / 1000);
  if (status !== last) { console.log(`[${elapsed}s] ${status} ${JSON.stringify(setup)}`); last = status; }
  if (status !== "running") break;
  await sleep(15_000);
}
await client.close();
