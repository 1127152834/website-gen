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
import { provisionSite, siteContext, type PipelineDeps } from "./pipeline.ts";
import { createChats } from "./agent.ts";
import { dueReverts, listChanges, revertChange, scheduleRevert } from "./changes.ts";
import { ensureMailbox, mailDns, mailSetup, mailStatus } from "./mail.ts";
import { enableSmtp, imapHasSubject, resetMailboxPassword, saveMailboxPassword, sendTestEmail, smtpStatus } from "./smtp.ts";
import { launchSite } from "./launch.ts";
import { buildRuntime, completeText, listProviders, listRoles, pingModel, seedModelDefaults, setProviderKey, setRole } from "./models.ts";
import { browseWithEdge } from "./qa-browser.ts";
import { secretHint, unseal } from "./secrets.ts";
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
const launching = new Set<number>();

/** 流水线和上线用到的外部依赖 */
function pipelineDeps(): PipelineDeps {
  const key = requireKey();
  return {
    db, key, fetch, resourcesDir,
    hostinger: (accountId) => hostinger.forAccount(accountId, accountToken(db, key, accountId)),
    emit: (e) => emit({ batchId: String(e.batchId), siteId: String(e.siteId), kind: e.kind, payload: e.payload }),
    workDir,
    now: Date.now,
    ai: (role, prompt) => completeText(db, key, role, prompt),
    cj: (path) => (cj ??= createCj(db, key))(path),
    browse: browseWithEdge,
  };
}

// ---- 建站任务队列：后台进程里只有这一个消费者，启动时上次没跑完的任务全部重新排队 ----
recoverStale(db, Number.MAX_SAFE_INTEGER);
const runner = createRunner({
  db,
  concurrency: 3,
  handlers: {
    [PROVISION_JOB]: (job) => provisionSite(pipelineDeps(), job.siteId!),
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

// ---- pi 对话改内容 ----
const chats = createChats({
  dir: join(userData, "pi"),
  db,
  key: requireKey,
  ctxFor: (siteId) => siteContext(pipelineDeps(), siteId),
  onEvent: (siteId, event) => {
    push({ kind: "chat", siteId, event });
    // 工具可能改了内容，变更列表跟着刷新
    if (event.type === "tool_end" || event.type === "settled") push({ kind: "changed", topic: "changes" });
  },
});

// 定时恢复：每分钟看一次到期的；关机期间错过的，开机后第一次检查就补上
async function runDueReverts() {
  if (!masterKey) return;
  for (const due of dueReverts(db, Date.now())) {
    const ctx = siteContext(pipelineDeps(), due.site_id);
    try {
      await revertChange(ctx, due.id);
      ctx.emit("warn", { message: `定时恢复：变更 #${due.id} 已按计划回滚` });
    } catch (e) {
      db.prepare("UPDATE changesets SET revert_error = ? WHERE id = ?").run((e as Error).message, due.id);
      ctx.emit("error", { step: "revert", name: "定时恢复", message: `变更 #${due.id}：${(e as Error).message}` });
    }
    push({ kind: "changed", topic: "changes" });
  }
}
setInterval(() => void runDueReverts(), 60_000);

const siteIdOf = (p: unknown) => Number((p as { siteId: number }).siteId);

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
  // 一键上线：同一个站同时只跑一次，几十秒内完成，不进任务队列
  // 站点页：流程跑完的站（可以和 pi 对话改内容）
  "sites.list": () =>
    (db.prepare("SELECT id, domain, launched_at FROM sites WHERE status = 'done' ORDER BY id DESC").all() as { id: number; domain: string; launched_at: number | null }[])
      .map((s) => ({ id: s.id, domain: s.domain, launchedAt: s.launched_at })),
  "chat.history": (p) => chats.history(siteIdOf(p)),
  "chat.send": async (p) => {
    await chats.send(siteIdOf(p), String((p as { text: string }).text ?? ""));
    return { ok: true };
  },
  "chat.abort": async (p) => {
    await chats.abort(siteIdOf(p));
    return { ok: true };
  },
  "chat.reset": async (p) => {
    await chats.reset(siteIdOf(p));
    return { ok: true };
  },
  // 客服邮箱与邮件 DNS：检查（只读）、修复（建邮箱 + 补 DNS 记录，你在界面上确认后才调）、查看流水线建邮箱时保存的密码
  "mail.status": (p) => mailStatus(siteContext(pipelineDeps(), siteIdOf(p))),
  "mail.fix": async (p) => {
    const ctx = siteContext(pipelineDeps(), siteIdOf(p));
    const mailbox = await ensureMailbox(ctx);
    const { order } = await mailSetup(ctx);
    const dns = order ? await mailDns(ctx, true) : null;
    const detail = `${mailbox.detail}${dns?.fixed.length ? `；DNS 补上 ${dns.fixed.join("；")}${dns.snapshotId ? `（改动前快照 #${dns.snapshotId}）` : ""}` : ""}`;
    if (mailbox.ok) ctx.emit("step", { step: "mail_fix", name: "检查并修复邮箱", status: "done", detail });
    else ctx.emit("error", { step: "mail_fix", name: "检查并修复邮箱", message: detail });
    return { mailbox: mailbox.detail, dns };
  },
  "mail.password": (p) => {
    const row = db.prepare("SELECT mailbox_ciphertext FROM sites WHERE id = ?").get(siteIdOf(p)) as { mailbox_ciphertext: Uint8Array | null } | undefined;
    return row?.mailbox_ciphertext ? (JSON.parse(unseal(requireKey(), row.mailbox_ciphertext)) as { address: string; password: string }) : null;
  },
  // 交易邮件发信：状态、填已有邮箱的密码（先 IMAP 验证）后启用、发测试邮件、关闭
  "smtp.status": (p) => smtpStatus(siteContext(pipelineDeps(), siteIdOf(p))),
  "smtp.enable": async (p) => {
    const ctx = siteContext(pipelineDeps(), siteIdOf(p));
    const password = (p as { password?: string }).password;
    if (password) await saveMailboxPassword(ctx, password);
    const r = await enableSmtp(ctx, imapHasSubject);
    if (r.ok) ctx.emit("step", { step: "smtp", name: "交易邮件发信", status: "done", detail: r.detail });
    else ctx.emit("warn", { message: r.detail });
    return r;
  },
  // 不知道已有邮箱的密码：由应用生成新密码改掉（你在界面上确认后才调），然后启用发信
  "smtp.resetPassword": async (p) => {
    const ctx = siteContext(pipelineDeps(), siteIdOf(p));
    await resetMailboxPassword(ctx);
    const r = await enableSmtp(ctx, imapHasSubject);
    ctx.emit(r.ok ? "step" : "warn", r.ok ? { step: "smtp", name: "交易邮件发信", status: "done", detail: `已为 ${ctx.site.domain} 的客服邮箱生成新密码；${r.detail}` } : { message: r.detail });
    return r;
  },
  "smtp.test": (p) => sendTestEmail(siteContext(pipelineDeps(), siteIdOf(p)), String((p as { to: string }).to ?? "").trim(), imapHasSubject),
  "smtp.disable": async (p) => {
    await siteContext(pipelineDeps(), siteIdOf(p)).wp("POST", "site-agent/v1/smtp", { enabled: false });
    return { ok: true };
  },
  "changes.list": (p) => listChanges(db, siteIdOf(p)),
  // 回滚由你在界面上点（不是 pi 的工具调用）
  "changes.revert": async (p) => {
    const { siteId, changeId } = p as { siteId: number; changeId: number };
    await revertChange(siteContext(pipelineDeps(), Number(siteId)), Number(changeId));
    push({ kind: "changed", topic: "changes" });
    return { ok: true };
  },
  "changes.cancelSchedule": (p) => {
    const { siteId, changeId } = p as { siteId: number; changeId: number };
    scheduleRevert(db, Number(siteId), Number(changeId), null);
    push({ kind: "changed", topic: "changes" });
    return { ok: true };
  },
  "sites.launch": async (p) => {
    const siteId = Number((p as { siteId: number }).siteId);
    if (launching.has(siteId)) throw new Error("正在上线，请稍候");
    launching.add(siteId);
    try {
      return { detail: await launchSite(pipelineDeps(), siteId) };
    } finally {
      launching.delete(siteId);
      push({ kind: "changed", topic: "batches" });
    }
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
