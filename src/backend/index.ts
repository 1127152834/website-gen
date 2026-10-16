// 每个用户一个工作区：数据库、凭据、连接池、任务和对话都只在这个闭包里。
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelRole, Push, RunEvent } from "../shared/protocol.ts";
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
import { ensureMailbox, hasDefaultMailboxPassword, mailDns, mailSetup, mailStatus, setDefaultMailboxPassword } from "./mail.ts";
import { enableSmtp, imapHasSubject, imapLogin, resetMailboxPassword, saveMailboxPassword, sendTestEmail, smtpStatus } from "./smtp.ts";
import { launchSite } from "./launch.ts";
import {
  completeText,
  createProviderConfig,
  deleteProviderConfig,
  fetchProviderModels,
  listProviders,
  listRoles,
  MODEL_PROVIDER_PRESETS,
  setProviderKey,
  setRole,
  testProviderModel,
  updateProviderConfig,
  type ProviderModelInput,
} from "./models.ts";
import { assertPublicBaseUrl } from "./net-guard.ts";
import { browseWithEdge } from "./qa-browser.ts";
import { secretHint, unseal } from "./secrets.ts";
import type { QaReport } from "./store.ts";
import { qaView } from "./qa-view.ts";
import type { Handlers } from "./rpc.ts";
import { allSites, getOverview } from "./overview.ts";
import { listTemplates, removeTemplate, saveTemplate } from "./entity-templates.ts";
import { ABANDON_JOB, abandonStatus, queueAbandon, retryAbandon, runAbandon } from "./abandon.ts";
import type { MailTransportFactory } from "./mailbox-transport.ts";
import { createMailboxService } from "./mailbox-service.ts";
import { createGristService } from "./grist-settings.ts";
import type { GristClient } from "./grist.ts";
import { createAssistant, type AssistantAdminCapability } from "./assistant.ts";
import { assistantRpcToolByMethod, assistantRpcToolDefinitions } from "./assistant-tools.ts";
import { gristToolDefinitions } from "./grist-tools.ts";

export interface Workspace {
  handlers: Handlers;
  setAssistantAdminCapability(capability: AssistantAdminCapability | undefined): void;
  gristClient(): GristClient;
  mailAttachment(input: { mailboxId: number; folder: string; uid: number; partId: string }): Promise<{ name: string; type: string; size: number; data: Buffer }>;
  subscribe(listener: (msg: Push) => void): () => void;
  close(): Promise<void>;
}

export function createWorkspace(opts: {
  userDir: string; key: Buffer; resourcesDir?: string;
  /** 服务器跨用户查看停用工作区时，不得恢复建站、监听、同步或定时回滚。 */
  backgroundTasks?: boolean;
  /** 管理员跨用户查询：SQLite 只读，不迁移、不创建目录，邮件仅查本地缓存。 */
  readOnly?: boolean;
  /** 测试只注入进程内替身，不触发 MCP 子进程或真实 IMAP / SMTP。 */
  dependencies?: { hostingerPool?: ReturnType<typeof createHostingerPool>; mailTransport?: MailTransportFactory };
}): Workspace {
  const userData = resolve(opts.userDir);
  const backgroundEnabled = opts.backgroundTasks !== false && !opts.readOnly;
  const resourcesDir = opts.resourcesDir ?? resolve(import.meta.dirname, "../../resources");
  if (opts.key.length !== 32) throw new Error("用户密钥必须为 32 字节");
  if (!opts.readOnly) {
    mkdirSync(userData, { recursive: true });
    mkdirSync(join(userData, "work", "qa"), { recursive: true });
    mkdirSync(join(userData, "pi"), { recursive: true });
  }
  let closing = false;
  const background = new Set<Promise<unknown>>();
  const siteWork = new Map<number, Set<Promise<unknown>>>();
  const mailWork = new Map<string, Set<Promise<unknown>>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    background.add(task);
    void task.finally(() => background.delete(task)).catch(() => {});
    return task;
  };
  const trackSite = <T>(siteId: number, task: Promise<T>): Promise<T> => {
    let pending = siteWork.get(siteId);
    if (!pending) siteWork.set(siteId, pending = new Set());
    pending.add(task);
    void task.finally(() => {
      pending.delete(task);
      if (!pending.size) siteWork.delete(siteId);
    }).catch(() => {});
    return task;
  };
  const trackMailbox = <T>(mailboxId: number, task: Promise<T>): Promise<T> => {
    const row = db.prepare("SELECT domain FROM mailboxes WHERE id = ?").get(mailboxId) as { domain: string } | undefined;
    if (!row) return task;
    const domain = row.domain.toLowerCase();
    let pending = mailWork.get(domain);
    if (!pending) mailWork.set(domain, pending = new Set());
    pending.add(task);
    void task.finally(() => {
      pending.delete(task);
      if (!pending.size) mailWork.delete(domain);
    }).catch(() => {});
    return task;
  };
  const dbPath = join(userData, "website-gen.sqlite");
  const db = opts.readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : openDb(dbPath);
  if (!opts.readOnly) migrate(db);
  const grist = createGristService({ db, key: opts.key });

  const listeners = new Set<(msg: Push) => void>();
  const push = (msg: Push) => {
    if (closing) return;
    for (const listener of listeners) {
      try { listener(msg); } catch { /* 推送失败不打断流水线 */ }
    }
  };
  const emit = (e: Parameters<typeof appendEvent>[1]) => {
    if (opts.readOnly) return; // 查询不能为目标用户追加运行日志。
    const event: RunEvent = appendEvent(db, e);
    push({ kind: "event", event });
  };

  const requireKey = () => opts.key;

  const hostinger = opts.dependencies?.hostingerPool ?? createHostingerPool();
  const mailboxes = createMailboxService({
    db, key: opts.key,
    readOnly: opts.readOnly,
    accounts: () => listAccounts(db).map(({ id }) => ({ id, exec: hostinger.forAccount(id, accountToken(db, requireKey(), id)) })),
    transport: opts.dependencies?.mailTransport,
    push: (event) => push({ kind: "mail", event }),
  });
  // 服务启动会打开所有启用用户的工作区；已保存的监听开关不依赖浏览器在线。
  if (backgroundEnabled) void track(mailboxes.reconcile()).catch(() => {});
  const syncing = new Map<number, Promise<unknown>>();
  function sync(id: number) {
    if (closing) return Promise.resolve();
    // 同一账号同时只跑一个同步，重复请求复用正在进行的那个
    let running = syncing.get(id);
    if (!running) {
      running = (async () => {
        const result = await syncWithStoredToken(db, requireKey(), id, (token) => hostinger.forAccount(id, token));
        await mailboxes.sync(id);
        push({ kind: "changed", topic: "mail" });
        return result;
      })().finally(() => {
        syncing.delete(id);
        push({ kind: "changed", topic: "accounts" });
      });
      syncing.set(id, running);
      track(running);
    }
    return running;
  }
  const syncAll = async () => {
    for (const { id } of listAccounts(db)) {
      if (closing) break;
      await sync(id).catch(() => {});
    } // 失败已记录在账号状态里
  };
  // 定时同步不依赖用户是否在线。
  const initialSync = backgroundEnabled ? setTimeout(() => void track(syncAll()), 15_000) : undefined;
  const syncTimer = backgroundEnabled ? setInterval(() => void track(syncAll()), 30 * 60_000) : undefined;

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
      login: imapLogin,
    };
  }

  // ---- 建站任务队列：每个工作区一个消费者，启动时重新排队上次没跑完的任务 ----
  if (backgroundEnabled) recoverStale(db, Number.MAX_SAFE_INTEGER);
  const runner = createRunner({
    db,
    concurrency: 3,
    handlers: {
      [PROVISION_JOB]: (job) => trackSite(job.siteId!, provisionSite(pipelineDeps(), job.siteId!)),
      [ABANDON_JOB]: async (job) => {
        // 墓碑先阻止新的站点操作，再等此前在途的步骤落定，避免远端资源删除后又被建回来。
        const target = db.prepare("SELECT domain FROM abandon_runs WHERE job_id = ?").get(job.id) as { domain: string } | undefined;
        if (target) {
          const ids = db.prepare("SELECT id FROM sites WHERE domain = ? COLLATE NOCASE").all(target.domain) as { id: number }[];
          for (const { id } of ids) {
            await chats.abort(id);
            while (siteWork.get(id)?.size) await Promise.allSettled([...siteWork.get(id)!]);
          }
        }
        await runAbandon({
          db,
          hostinger: (id) => hostinger.forAccount(id, accountToken(db, requireKey(), id)),
          stopDomain: async (domain) => {
            // 已提交的 SMTP 无法“撤回”；等待旧请求落定后再清理，新的请求已被墓碑拒绝。
            const normalized = domain.toLowerCase();
            while (mailWork.get(normalized)?.size) await Promise.allSettled([...mailWork.get(normalized)!]);
            await mailboxes.stopDomain(domain);
          },
          emit,
        }, job);
      },
    },
    onSettled: (job, outcome, error) => {
      if (job.type === ABANDON_JOB) {
        push({ kind: "changed", topic: "batches" });
        push({ kind: "changed", topic: "accounts" });
        push({ kind: "changed", topic: "mail" });
        return;
      }
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
    if (!closing && backgroundEnabled) void track(runner.tick()).catch(() => {});
  };
  const jobTimer = backgroundEnabled ? setInterval(tick, 2000) : undefined;

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
    if (closing) return;
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
  let reverting = false;
  const revertTimer = !backgroundEnabled ? undefined : setInterval(() => {
    if (reverting || closing) return;
    reverting = true;
    void track(runDueReverts()).catch(() => {}).finally(() => { reverting = false; });
  }, 60_000);

  const siteIdOf = (p: unknown) => Number((p as { siteId: number }).siteId);
  const providerBaseUrl = (providerId: number) => {
    const provider = listProviders(db).find((item) => item.id === providerId);
    if (!provider) throw new Error(`模型厂商 ${providerId} 不存在`);
    return provider.baseUrl;
  };

  const handlers: Handlers = {
    ...grist.handlers,
    "assistant.history": () => assistant.history(),
    "assistant.send": async (p) => {
      const input = p as { text?: unknown; page?: unknown } | undefined;
      if (typeof input?.text !== "string" || input.text.length > 100_000) throw new Error("请输入有效的助手消息（不超过 100000 字）");
      await assistant.send(input.text, typeof input.page === "string" ? input.page : undefined);
      return { ok: true };
    },
    "assistant.abort": async () => { await assistant.abort(); return { ok: true }; },
    "assistant.reset": async () => { await assistant.reset(); return { ok: true }; },
    "assistant.confirm": async (p) => {
      const input = p as { id?: unknown; approve?: unknown } | undefined;
      if (typeof input?.id !== "string" || typeof input.approve !== "boolean") throw new Error("确认参数无效");
      return { ok: await assistant.confirm(input.id, input.approve) };
    },
    "overview.get": () => getOverview(db),
    "templates.list": () => listTemplates(db),
    "templates.save": (p) => saveTemplate(db, p),
    "templates.remove": (p) => removeTemplate(db, Number((p as { id: number }).id)),
    "sites.all": () => allSites(db),
    "sites.get": (p) => {
      const siteId = siteIdOf(p);
      const row = db.prepare("SELECT batch_id FROM sites WHERE id = ?").get(siteId) as { batch_id: number } | undefined;
      return row ? batchSites(db, row.batch_id).find((site) => site.id === siteId) ?? null : null;
    },
    "sites.history": () => (db.prepare("SELECT DISTINCT batch_id FROM sites WHERE abandoned_at IS NOT NULL OR EXISTS (SELECT 1 FROM abandoned_domains d WHERE d.domain=sites.domain COLLATE NOCASE)").all() as { batch_id: number }[])
      .flatMap(({ batch_id }) => batchSites(db, batch_id).filter((site) => site.status === "abandoned")),
    "system.info": () => ({
      node: process.versions.node,
      sqlite: process.versions.sqlite,
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
    "models.presets": () => MODEL_PROVIDER_PRESETS,
    "models.providers": () => listProviders(db),
    "models.roles": () => listRoles(db),
    "models.create": async (p) => {
      const input = p as { name: string; protocol: "openai" | "anthropic"; baseUrl: string; apiKey?: string; models?: ProviderModelInput[] };
      await assertPublicBaseUrl(String(input.baseUrl ?? "").trim());
      createProviderConfig(db, requireKey(), input);
      return listProviders(db);
    },
    "models.update": async (p) => {
      const input = p as { providerId: number; name: string; protocol: "openai" | "anthropic"; baseUrl: string; apiKey?: string; models: ProviderModelInput[] };
      await assertPublicBaseUrl(String(input.baseUrl ?? "").trim());
      updateProviderConfig(db, requireKey(), Number(input.providerId), input);
      return listProviders(db);
    },
    "models.delete": (p) => {
      deleteProviderConfig(db, Number((p as { providerId: number }).providerId));
      return listProviders(db);
    },
    "models.fetch": async (p) => {
      const providerId = Number((p as { providerId: number }).providerId);
      await assertPublicBaseUrl(providerBaseUrl(providerId));
      return fetchProviderModels(db, requireKey(), providerId);
    },
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
      await assertPublicBaseUrl(providerBaseUrl(Number(providerId)));
      return testProviderModel(db, requireKey(), Number(providerId), String(modelId));
    },

    "domains.free": () => listFreeDomains(db),
    "batches.list": () => listBatches(db),
    "batches.sites": (p) => batchSites(db, Number((p as { batchId: number }).batchId)).filter((site) => site.status !== "abandoned"),
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
      return qaView(report, workDir);
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
      (db.prepare("SELECT id, domain, launched_at FROM sites WHERE status = 'done' AND abandoned_at IS NULL AND NOT EXISTS (SELECT 1 FROM abandoned_domains d WHERE d.domain = sites.domain COLLATE NOCASE) ORDER BY id DESC").all() as { id: number; domain: string; launched_at: number | null }[])
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
      // 开通邮箱后点一次「修复」就够：有了密码顺带启用交易邮件
      const smtp = mailbox.ok && order && ctx.site.mailbox_ciphertext && !(await smtpStatus(ctx)).enabled ? await enableSmtp(ctx, imapHasSubject) : null;
      const detail = `${mailbox.detail}${dns?.fixed.length ? `；DNS 补上 ${dns.fixed.join("；")}${dns.snapshotId ? `（改动前快照 #${dns.snapshotId}）` : ""}` : ""}${smtp ? `；${smtp.detail}` : ""}`;
      if (mailbox.ok) ctx.emit("step", { step: "mail_fix", name: "检查并修复邮箱", status: "done", detail });
      else ctx.emit("error", { step: "mail_fix", name: "检查并修复邮箱", message: detail });
      return { mailbox: mailbox.detail, dns, smtp };
    },
    "mail.defaultPassword.status": () => ({ set: hasDefaultMailboxPassword(db) }),
    "mail.defaultPassword.set": (p) => {
      const password = (p as { password: string | null }).password;
      setDefaultMailboxPassword(db, requireKey(), password ? String(password) : null);
      return { set: hasDefaultMailboxPassword(db) };
    },
    "mail.password": (p) => {
      const mailboxId = (p as { mailboxId?: number }).mailboxId;
      if (mailboxId != null) {
        // 沿用明确点击“显示密码”的入口，绝不在清单、正文或 SSE 中带出明文。
        const box = db.prepare(`SELECT address,credential_ciphertext FROM mailboxes m WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM abandoned_domains d WHERE d.domain=m.domain COLLATE NOCASE)`).get(Number(mailboxId)) as { address: string; credential_ciphertext: Uint8Array | null } | undefined;
        if (!box?.credential_ciphertext) return null;
        const creds = JSON.parse(unseal(requireKey(), box.credential_ciphertext)) as { address: string; password: string };
        return creds.address.toLowerCase() === box.address.toLowerCase() ? creds : null;
      }
      const row = db.prepare("SELECT mailbox_ciphertext FROM sites WHERE id = ? AND NOT EXISTS (SELECT 1 FROM abandoned_domains d WHERE d.domain=sites.domain COLLATE NOCASE)").get(siteIdOf(p)) as { mailbox_ciphertext: Uint8Array | null } | undefined;
      return row?.mailbox_ciphertext ? (JSON.parse(unseal(requireKey(), row.mailbox_ciphertext)) as { address: string; password: string }) : null;
    },
    "mail.list": () => mailboxes.list(),
    "mail.sync": async () => {
      const result = await mailboxes.sync();
      push({ kind: "changed", topic: "mail" });
      return result;
    },
    "mail.folders": (p) => mailboxes.folders(Number((p as { mailboxId: number }).mailboxId)),
    "mail.messages": (p) => mailboxes.messages(p as Parameters<typeof mailboxes.messages>[0]),
    "mail.message": (p) => mailboxes.message(p as Parameters<typeof mailboxes.message>[0]),
    "mail.credential.save": (p) => mailboxes.saveCredential(p as Parameters<typeof mailboxes.saveCredential>[0]),
    "mail.credential.reset": (p) => mailboxes.resetCredential(p as Parameters<typeof mailboxes.resetCredential>[0]),
    "mail.monitor": (p) => mailboxes.setMonitoring(p as Parameters<typeof mailboxes.setMonitoring>[0]),
    "mail.seen": (p) => mailboxes.markSeen(p as Parameters<typeof mailboxes.markSeen>[0]),
    "mail.trash": (p) => mailboxes.trash(p as Parameters<typeof mailboxes.trash>[0]),
    "mail.delete": (p) => mailboxes.deleteMailbox(p as Parameters<typeof mailboxes.deleteMailbox>[0]),
    "mail.send": (p) => mailboxes.send(p as Parameters<typeof mailboxes.send>[0]),
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
      // 账号外键已清理邮箱；协调器同步关闭该账号的在途监听。
      await mailboxes.reconcile();
      return { ok: true };
    },
    "abandon.start": (p) => {
      const result = queueAbandon(db, p as Parameters<typeof queueAbandon>[1]);
      push({ kind: "changed", topic: "batches" });
      push({ kind: "changed", topic: "accounts" });
      tick();
      return { ...result, ...abandonStatus(db, { jobId: result.jobId }) };
    },
    "abandon.status": (p) => abandonStatus(db, p as Parameters<typeof abandonStatus>[1]),
    "abandon.retry": (p) => {
      const jobId = Number((p as { jobId: number }).jobId);
      retryAbandon(db, jobId);
      tick();
      return abandonStatus(db, { jobId });
    },
  };

  const guarded: Handlers = Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, (params: unknown) => {
    if (closing) throw new Error("工作区已关闭");
    if ((opts.readOnly || opts.backgroundTasks === false) && assistantRpcToolByMethod(method)?.risk !== "read") throw new Error("临时工作区只允许已登记的只读查询");
    const siteId = Number((params as { siteId?: number } | undefined)?.siteId);
    const mailboxId = Number((params as { mailboxId?: number } | undefined)?.mailboxId);
    let task = Promise.resolve().then(() => handler(params));
    if (method.startsWith("mail.") && Number.isSafeInteger(mailboxId) && mailboxId > 0) task = trackMailbox(mailboxId, task);
    return track(Number.isSafeInteger(siteId) && siteId > 0 && !method.startsWith("abandon.") ? trackSite(siteId, task) : task);
  }]));
  function workspaceGristClient(): GristClient {
    if (closing) throw new Error("工作区已关闭");
    return new Proxy(grist.client(), {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (closing) throw new Error("工作区已关闭");
          return track(Promise.resolve().then(() => value.apply(target, args)));
        };
      },
    });
  }
  const assistant = createAssistant({
    userDir: userData, db, key: requireKey,
    getToolDefinitions: () => [...assistantRpcToolDefinitions(guarded), ...gristToolDefinitions(workspaceGristClient)],
    onEvent: (event) => {
      push({ kind: "assistant", event });
      if (event.type === "tool_end") for (const topic of ["accounts", "batches", "changes", "mail"] as const) push({ kind: "changed", topic });
    },
  });
  let closeTask: Promise<void> | undefined;
  return {
    handlers: guarded,
    setAssistantAdminCapability: (capability) => { void assistant.setAdminCapability(capability); },
    gristClient: workspaceGristClient,
    mailAttachment(input) {
      if (closing) return Promise.reject(new Error("工作区已关闭"));
      return track(trackMailbox(input.mailboxId, mailboxes.attachment(input)));
    },
    subscribe(listener) {
      if (closing) throw new Error("工作区已关闭");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      if (closeTask) return closeTask;
      closing = true;
      clearTimeout(initialSync);
      clearInterval(syncTimer);
      clearInterval(jobTimer);
      clearInterval(revertTimer);
      listeners.clear();
      closeTask = (async () => {
        await assistant.close();
        await mailboxes.close();
        await chats.close();
        await runner.stop();
        while (background.size) await Promise.allSettled([...background]);
        await hostinger.closeAll();
        db.close();
      })();
      return closeTask;
    },
  };
}
