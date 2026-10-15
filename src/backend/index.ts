// 后台进程（utilityProcess）入口：所有业务逻辑都在这里。
// 主进程每接入一个界面窗口（或后台重启后），就送来一个 MessagePort；事件广播给所有在连的窗口。
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { MessagePortMain } from "electron";
import type { BackendMessage, ModelRole, Push, Request, RunEvent } from "../shared/protocol.ts";
import type { BatchForm } from "../shared/forms.ts";
import { accountToken, addAccount, listAccounts, listDomains, removeAccount, syncWithStoredToken } from "./accounts.ts";
import { batchSites, createBatch, listBatches, listFreeDomains, PROVISION_JOB, retrySite, siteSteps } from "./batches.ts";
import { createCj, setCjKey, type CjGet } from "./cj.ts";
import { appendEvent, eventsForSite, eventsSince, migrate, openDb, schemaVersion } from "./db.ts";
import { createHostingerPool } from "./hostinger.ts";
import { createRunner, recoverStale } from "./jobs.ts";
import { provisionSite } from "./pipeline.ts";
import { buildRuntime, completeText, listProviders, listRoles, pingModel, seedModelDefaults, setProviderKey, setRole } from "./models.ts";
import { browseWithEdge } from "./qa-browser.ts";
import { secretHint } from "./secrets.ts";
import type { QaReport } from "./store.ts";
import { handleRequest, type Handlers } from "./rpc.ts";

const [userData, resourcesDir] = process.argv.slice(2);
if (!userData || !resourcesDir) throw new Error("backend: missing userData / resources path arguments");
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

// CJ 限速是整个账号每秒 1 次，所有建站任务共用一个客户端
let cj: CjGet | null = null;
const workDir = join(userData, "work");

// ---- 建站任务队列：后台进程里只有这一个消费者，启动时上次没跑完的任务全部重新排队 ----
recoverStale(db, Number.MAX_SAFE_INTEGER);
const runner = createRunner({
  db,
  concurrency: 3,
  handlers: {
    [PROVISION_JOB]: (job) => {
      const key = requireKey();
      return provisionSite({
        db, key, fetch, resourcesDir,
        hostinger: (accountId) => hostinger.forAccount(accountId, accountToken(db, key, accountId)),
        emit: (e) => emit({ batchId: String(e.batchId), siteId: String(e.siteId), kind: e.kind, payload: e.payload }),
        workDir,
        now: Date.now,
        ai: (role, prompt) => completeText(db, key, role, prompt),
        cj: (path) => (cj ??= createCj(db, key))(path),
        browse: browseWithEdge,
      }, job.siteId!);
    },
  },
  onSettled: (job, outcome, error) => {
    if (outcome === "failed" || outcome === "retry") {
      db.prepare("UPDATE sites SET status = ?, updated_at = ? WHERE id = ?").run(outcome === "failed" ? "failed" : "waiting", Date.now(), job.siteId);
      if (outcome === "retry") emit({ siteId: String(job.siteId), kind: "warn", payload: { message: `第 ${job.attempts + 1} 次出错，${30 * (job.attempts + 1)} 秒后自动重试：${error}` } });
    }
    if (outcome === "done") {
      // 新站建好了，刷新该账号的资源快照
      const row = db.prepare("SELECT account_id FROM sites WHERE id = ?").get(job.siteId) as { account_id: number | null } | undefined;
      if (row?.account_id != null) void sync(row.account_id).catch(() => {});
    }
    push({ kind: "changed", topic: "batches" });
  },
});
const tick = () => {
  if (masterKey) void runner.tick();
};
setInterval(tick, 2000);

const handlers: Handlers = {
  "system.info": () => ({
    electron: process.versions.electron,
    node: process.versions.node,
    sqlite: process.versions.sqlite,
    dbPath,
    schemaVersion: schemaVersion(db),
  }),
  "events.since": (p) => eventsSince(db, Number((p as { afterSeq?: number } | undefined)?.afterSeq ?? 0)),

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

  "domains.free": () => listFreeDomains(db),
  "batches.list": () => listBatches(db),
  "batches.sites": (p) => batchSites(db, Number((p as { batchId: number }).batchId)),
  "batches.create": (p) => {
    const r = createBatch(db, p as BatchForm, Date.now());
    push({ kind: "changed", topic: "batches" });
    tick();
    return r;
  },
  "sites.steps": (p) => siteSteps(db, Number((p as { siteId: number }).siteId)),
  "sites.events": (p) => eventsForSite(db, String((p as { siteId: number }).siteId)),
  // QA 报告；截图转成 data URL 给界面显示（只读 work/qa 目录下的文件）
  "sites.qa": (p) => {
    const row = db.prepare("SELECT qa_json FROM sites WHERE id = ?").get(Number((p as { siteId: number }).siteId)) as { qa_json: string | null } | undefined;
    if (!row?.qa_json) return null;
    const report = JSON.parse(row.qa_json) as QaReport;
    const root = resolve(workDir, "qa") + sep;
    return {
      ...report,
      shots: report.shots.flatMap((s) => {
        const file = resolve(s.file);
        if (!file.startsWith(root)) return [];
        try {
          return [{ name: s.name, src: `data:image/png;base64,${readFileSync(file).toString("base64")}` }];
        } catch {
          return [];
        }
      }),
    };
  },
  "cj.status": () => ({ keyHint: secretHint(db, "cj.apiKey") }),
  "cj.setKey": async (p) => {
    await setCjKey(db, requireKey(), String((p as { apiKey: string }).apiKey ?? ""));
    cj = null;
    return { keyHint: secretHint(db, "cj.apiKey") };
  },
  "sites.retry": (p) => {
    retrySite(db, Number((p as { siteId: number }).siteId), Date.now());
    push({ kind: "changed", topic: "batches" });
    tick();
    return { ok: true };
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
