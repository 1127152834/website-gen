// POC：用 Electron 自带的 Node 跑关键依赖（ELECTRON_RUN_AS_NODE=1）。
// 用法：npm run poc:electron-node
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

console.log(`Electron ${process.versions.electron} / Node ${process.versions.node}`);

// 1) node:sqlite（无需编译原生模块）
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
db.prepare("INSERT INTO t (v) VALUES (?)").run("ok");
console.log("✔ node:sqlite →", db.prepare("SELECT v FROM t").get().v);

// 2) Hostinger MCP：用 Electron 可执行文件 + ELECTRON_RUN_AS_NODE 起子进程
const client = new Client({ name: "electron-node-poc", version: "0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ["node_modules/@hostinger/mcp/src/servers/all.js"],
  env: { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
  stderr: "ignore",
}));
console.log("✔ Hostinger MCP under Electron →", (await client.listTools()).tools.map((t) => t.name).join(", "));
await client.close();

// 3) pi 能加载
const pi = await import("@earendil-works/pi-coding-agent");
const ai = await import("@earendil-works/pi-ai");
console.log("✔ pi loaded →", typeof pi.createAgentSession, typeof ai.createModels);
