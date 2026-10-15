// 后台进程（utilityProcess）入口：所有业务逻辑都在这里。
// 主进程每接入一个界面窗口（或后台重启后），就送来一个 MessagePort；事件广播给所有在连的窗口。
import { join } from "node:path";
import type { MessagePortMain } from "electron";
import type { BackendMessage, ModelRole, Push, Request, RunEvent } from "../shared/protocol.ts";
import { addAccount, listAccounts, listDomains, removeAccount, syncWithStoredToken } from "./accounts.ts";
import { appendEvent, eventsSince, migrate, openDb, schemaVersion } from "./db.ts";
import { createHostingerPool } from "./hostinger.ts";
import { buildRuntime, listProviders, listRoles, pingModel, seedModelDefaults, setProviderKey, setRole } from "./models.ts";
import { handleRequest, type Handlers } from "./rpc.ts";

const userData = process.argv[2];
if (!userData) throw new Error("backend: missing userData path argument");
const dbPath = join(userData, "website-gen.sqlite");
const db = openDb(dbPath);
migrate(db);
seedModelDefaults(db);

const ports = new Set<MessagePortMain>();
const send = (port: MessagePortMain, msg: BackendMessage) => port.postMessage(msg);
const push = (msg: Push) => {
  for (const port of ports) send(port, msg);
};
const emit = (e: Parameters<typeof appendEvent>[1]) => {
  const event: RunEvent = appendEvent(db, e);
  push({ kind: "event", event });
};

// 主密钥由主进程在第一条消息里交付；没有它就不能保存或读取任何凭据
let masterKey: Buffer | null = null;
const requireKey = () => {
  if (!masterKey) throw new Error("本机密钥不可用，无法保存或读取账号凭据");
  return masterKey;
};

const hostinger = createHostingerPool();
const syncing = new Map<number, Promise<unknown>>();
function sync(id: number) {
  // 同一账号同时只跑一个同步，重复请求复用正在进行的那个
  let running = syncing.get(id);
  if (!running) {
    running = (async () => syncWithStoredToken(db, requireKey(), id, (token) => hostinger.forAccount(id, token)))().finally(() => {
      syncing.delete(id);
      push({ kind: "changed", topic: "accounts" });
    });
    syncing.set(id, running);
  }
  return running;
}
const syncAll = async () => {
  for (const { id } of listAccounts(db)) await sync(id).catch(() => {}); // 失败已记录在账号状态里
};
// ponytail: 定时器做周期同步，P1 任务队列（jobs 表）落地后改由任务循环调度
setTimeout(() => void syncAll(), 15_000);
setInterval(() => void syncAll(), 30 * 60_000);

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

  "accounts.list": () => listAccounts(db),
  "accounts.domains": (p) => listDomains(db, Number((p as { id: number }).id)),
  "accounts.add": async (p) => {
    const { label, token } = p as { label: string; token: string };
    const key = requireKey();
    // 验证用临时连接；入库后按账号 ID 建正式连接
    const probeId = -Date.now();
    let id: number;
    try {
      id = await addAccount(db, key, { label, token }, hostinger.forAccount(probeId, token));
    } finally {
      void hostinger.close(probeId);
    }
    void sync(id).catch(() => {}); // 首次同步在后台跑，完成后推送 changed
    return { id };
  },
  "models.providers": () => listProviders(db),
  "models.roles": () => listRoles(db),
  "models.setKey": (p) => {
    const { providerId, apiKey } = p as { providerId: number; apiKey: string };
    setProviderKey(db, requireKey(), Number(providerId), String(apiKey ?? ""));
    return listProviders(db);
  },
  "models.setRole": (p) => {
    const { role, providerId, modelId, thinking } = p as { role: ModelRole; providerId: number; modelId: string; thinking: string };
    setRole(db, role, { providerId: Number(providerId), modelId: String(modelId), thinking: String(thinking) });
    return listRoles(db);
  },
  // 发一句极短的请求验证 Key 和地址：只回复 OK
  "models.test": async (p) => {
    const { providerId, modelId } = p as { providerId: number; modelId: string };
    const { models } = buildRuntime(db, requireKey());
    const model = models.getModel(`p${Number(providerId)}`, String(modelId));
    if (!model) throw new Error("这个提供方还没有设置 Key");
    return pingModel(models, model as Parameters<typeof pingModel>[1]);
  },

  "accounts.sync": async (p) => sync(Number((p as { id: number }).id)),
  "accounts.remove": async (p) => {
    const id = Number((p as { id: number }).id);
    await hostinger.close(id);
    removeAccount(db, id);
    return { ok: true };
  },
};

process.parentPort.on("message", (e) => {
  const data = e.data as { type?: string; masterKey?: string | null } | null;
  if (data?.type === "init") {
    masterKey = data.masterKey ? Buffer.from(data.masterKey, "base64") : null;
    return;
  }
  const [port] = e.ports;
  if (!port) return;
  ports.add(port);
  port.on("message", async (m) => send(port, await handleRequest(handlers, m.data as Request)));
  port.on("close", () => ports.delete(port));
  port.start();
});
