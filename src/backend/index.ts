// 后台进程（utilityProcess）入口：所有业务逻辑都在这里。
// 主进程每接入一个界面窗口（或后台重启后），就送来一个 MessagePort；事件广播给所有在连的窗口。
import { join } from "node:path";
import type { MessagePortMain } from "electron";
import type { BackendMessage, Request, RunEvent } from "../shared/protocol.ts";
import { appendEvent, eventsSince, migrate, openDb, schemaVersion } from "./db.ts";
import { handleRequest, type Handlers } from "./rpc.ts";

const userData = process.argv[2];
if (!userData) throw new Error("backend: missing userData path argument");
const dbPath = join(userData, "website-gen.sqlite");
const db = openDb(dbPath);
migrate(db);

const ports = new Set<MessagePortMain>();
const send = (port: MessagePortMain, msg: BackendMessage) => port.postMessage(msg);
const emit = (e: Parameters<typeof appendEvent>[1]) => {
  const event: RunEvent = appendEvent(db, e);
  for (const port of ports) send(port, { kind: "event", event });
};

// ponytail: 示例任务只用来演示事件流，P1 建站流水线落地后删除
const DEMO_STEPS = ["预检", "创建网站", "安装 WordPress", "部署伴侣插件", "安装 WooCommerce", "导入商品", "QA 验收"];
function startDemo() {
  const siteId = `demo-${Date.now()}`;
  DEMO_STEPS.forEach((name, i) =>
    setTimeout(() => emit({
      siteId,
      kind: "step",
      payload: { step: i + 1, total: DEMO_STEPS.length, name, status: i === DEMO_STEPS.length - 1 ? "done" : "running" },
    }), (i + 1) * 500),
  );
  return { siteId };
}

const handlers: Handlers = {
  "system.info": () => ({
    electron: process.versions.electron,
    node: process.versions.node,
    sqlite: process.versions.sqlite,
    dbPath,
    schemaVersion: schemaVersion(db),
  }),
  "events.since": (p) => eventsSince(db, Number((p as { afterSeq?: number } | undefined)?.afterSeq ?? 0)),
  "demo.start": startDemo,
};

process.parentPort.on("message", (e) => {
  const [port] = e.ports;
  if (!port) return;
  ports.add(port);
  port.on("message", async (m) => send(port, await handleRequest(handlers, m.data as Request)));
  port.on("close", () => ports.delete(port));
  port.start();
});
