// POC：CJdropshipping 只读验证（不下单、不加购物车、不改任何东西）。
// 1) REST：API Key 换 accessToken（缓存到 poc/out，已被 git 忽略）→ listV2 按美国仓选品
// 2) MCP：试用同一个 Key 连远程 MCP，列出工具并调用只读工具
// 用法：npm run poc:cj
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const API = "https://developers.cjdropshipping.com/api2.0/v1";
const KEY = process.env.CJ_API_KEY;
if (!KEY) throw new Error("CJ_API_KEY missing in .env");
mkdirSync("poc/out", { recursive: true });

// CJ 每个接口 QPS = 1
async function cj(path: string, init: RequestInit & { token?: string } = {}) {
  await sleep(1100);
  const res = await fetch(API + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.token ? { "CJ-Access-Token": init.token } : {}) },
  });
  const body = await res.json() as { code: number; result: boolean; message: string; data: any };
  if (!body.result) throw new Error(`${path} → HTTP ${res.status} code ${body.code}: ${body.message}`);
  return body.data;
}

const TOKEN_FILE = "poc/out/cj-token.json";
let token: string;
if (existsSync(TOKEN_FILE) && new Date(JSON.parse(readFileSync(TOKEN_FILE, "utf8")).accessTokenExpiryDate) > new Date()) {
  token = JSON.parse(readFileSync(TOKEN_FILE, "utf8")).accessToken;
  console.log("✔ accessToken (cached)");
} else {
  const data = await cj("/authentication/getAccessToken", { method: "POST", body: JSON.stringify({ apiKey: KEY }) });
  writeFileSync(TOKEN_FILE, JSON.stringify(data));
  token = data.accessToken;
  console.log(`✔ accessToken obtained, expires ${data.accessTokenExpiryDate}`);
}

// 选品：美国仓有货的狗床，按上架次数排序
const q = new URLSearchParams({ keyWord: "dog bed", countryCode: "US", page: "1", size: "10", orderBy: "1", sort: "desc", startSellPrice: "5", endSellPrice: "40" });
const list = await cj(`/product/listV2?${q}`, { token });
const products = (list?.content ?? []).flatMap((c: any) => c.productList ?? []);
writeFileSync("poc/out/cj-products.json", JSON.stringify(list, null, 2));
console.log(`✔ listV2 "dog bed" US warehouse → ${products.length} products (total ${list?.totalRecords ?? "?"})`);
for (const p of products.slice(0, 5)) console.log(`   ${p.id}  $${p.sellPrice}  US stock ${p.warehouseInventoryNum ?? "?"}  listed ${p.listedNum ?? "?"}  ${String(p.nameEn).slice(0, 60)}`);

// MCP：「apiKey 拼 URL」已下线（服务端实测返回）。accessToken 本身就是 API@<userId>@CJ:<…> 格式，
// 原样（不做 URL 编码）拼在 /mcp/ 后面
try {
  const client = new Client({ name: "website-gen-poc", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`https://developers.cjdropshipping.com/mcp/${token}`)));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log(`✔ MCP ${tools.length} tools: ${tools.join(", ")}`);
  for (const [name, args] of [["list_shops", {}], ["get_warehouses", {}]] as const) {
    if (!tools.includes(name)) continue;
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text?: string }[]).map((c) => c.text ?? "").join("");
    writeFileSync(`poc/out/cj-mcp-${name}.json`, text);
    console.log(`${r.isError ? "✘" : "✔"} MCP ${name} → ${text.slice(0, 200)}`);
  }
  await client.close();
} catch (e) {
  console.log(`✘ MCP failed: ${String(e).slice(0, 300)}`);
}
