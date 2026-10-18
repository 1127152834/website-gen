// “放弃站点”是可恢复的后台任务：先写永久墓碑，再逐步删除远端资源；每个写操作都重读确认。
import type { DatabaseSync } from "node:sqlite";
import { listAll, type HostingerExec } from "./hostinger.ts";
import { enqueue, PermanentError, requeue, type Job } from "./jobs.ts";

export const ABANDON_JOB = "domain.abandon";

const STEPS = [
  ["local_mail", "停止监听并清除本地邮件"],
  ["remote_mail", "删除邮箱与别名"],
  ["website", "删除网站"],
  ["domain_renewal", "关闭域名自动续费"],
  ["finalize", "标记为已放弃"],
] as const;

type StepKey = (typeof STEPS)[number][0];
type Obj = Record<string, unknown>;

export interface AbandonDeps {
  db: DatabaseSync;
  hostinger(accountId: number): HostingerExec;
  stopDomain(domain: string): void | Promise<void>;
  emit?(event: { siteId: string | null; kind: "step" | "warn" | "error"; payload: Record<string, unknown> }): void;
  now?: () => number;
  triageLifecycleHooks?: AbandonLifecycleHooks;
}

export interface AbandonLifecycleHooks {
  invalidateScope(input: { mailboxIds: number[]; reason: "abandon" }, now: number): { abortSourceIds: string[] };
  invalidateSource(sourceId: string, reason: "explicit_delete", now: number): void;
  abortSources?(sourceIds: string[]): void;
}

export interface AbandonStatus {
  id: number;
  status: "queued" | "running" | "failed" | "done";
  domain: string;
  retryable: boolean;
  error?: string;
  steps: { key: StepKey; name: string; status: "pending" | "running" | "done" | "failed"; detail?: string }[];
  updatedAt: number;
}

const domainName = (value: unknown) => String(value ?? "").trim().replace(/\.$/, "").toLowerCase();
const object = (value: unknown): Obj => value && typeof value === "object" ? value as Obj : {};
const scalar = (value: unknown): string | null => typeof value === "string" || typeof value === "number" ? String(value) : null;
const at = (value: unknown, ...path: string[]): unknown => path.reduce((current, key) => object(current)[key], value);
const first = (value: unknown, paths: string[][]): string | null => {
  for (const path of paths) {
    const result = scalar(at(value, ...path));
    if (result != null && result !== "") return result;
  }
  return null;
};
const idOf = (value: unknown) => first(value, [["id"], ["subscription_id"], ["subscriptionId"]]);
const mailOrderId = (value: unknown) => first(value, [["id"], ["order_id"], ["orderId"]]);
const mailOrderDomain = (value: unknown) => domainName(first(value, [["domain", "name"], ["domain"]]));

function emit(deps: AbandonDeps, siteId: number | null, step: StepKey, message: string, kind: "step" | "warn" | "error" = "step") {
  deps.emit?.({ siteId: siteId == null ? null : String(siteId), kind, payload: { step, name: STEPS.find(([key]) => key === step)![1], message } });
}

/** 必须输入完整域名；队列创建和墓碑写入在同一事务，避免同步窗口重新启用该域名。 */
export function queueAbandon(
  db: DatabaseSync,
  input: { domain: string; confirmation: string; siteId?: number | null; accountId?: number | null },
  now = Date.now(),
  lifecycle?: Pick<AbandonLifecycleHooks, "invalidateScope" | "abortSources">,
): { jobId: number } {
  const domain = domainName(input.domain);
  if (!domain || !domain.includes(".")) throw new Error("请输入有效域名");
  if (domainName(input.confirmation) !== domain) throw new Error(`请输入完整域名 ${domain} 以确认放弃`);
  const siteId = input.siteId == null ? null : Number(input.siteId);
  const accountId = input.accountId == null ? null : Number(input.accountId);
  if (siteId != null) {
    const site = db.prepare("SELECT domain FROM sites WHERE id = ?").get(siteId) as { domain: string } | undefined;
    if (!site || domainName(site.domain) !== domain) throw new Error("站点与确认的域名不一致");
  }
  if (accountId != null) {
    const linked = db.prepare("SELECT 1 FROM domains WHERE account_id = ? AND domain = ? COLLATE NOCASE").get(accountId, domain);
    if (!linked) throw new Error("该账号下没有这个域名");
  }
  if (siteId == null && accountId == null) {
    const known = db.prepare(`SELECT 1 FROM domains WHERE domain = ? COLLATE NOCASE
      UNION ALL SELECT 1 FROM sites WHERE domain = ? COLLATE NOCASE LIMIT 1`).get(domain, domain);
    if (!known) throw new Error("工作区中没有这个域名，不能创建放弃任务");
  }
  const existing = db.prepare(`SELECT r.job_id FROM abandon_runs r JOIN jobs j ON j.id = r.job_id
    WHERE r.domain = ? COLLATE NOCASE ORDER BY r.job_id DESC LIMIT 1`).get(domain) as { job_id: number } | undefined;
  if (existing) return { jobId: existing.job_id };

  let abortSourceIds: string[] = [];
  db.exec("BEGIN");
  try {
    const jobId = enqueue(db, ABANDON_JOB, siteId, now);
    db.prepare("INSERT INTO abandon_runs (job_id, domain, requested_account_id, site_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(jobId, domain, accountId, siteId, now, now);
    const insertStep = db.prepare("INSERT INTO abandon_steps (job_id, step, status) VALUES (?, ?, 'pending')");
    for (const [step] of STEPS) insertStep.run(jobId, step);
    db.prepare(`INSERT INTO abandoned_domains (domain, abandoned_at, abandon_job_id) VALUES (?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET abandoned_at = excluded.abandoned_at, abandon_job_id = excluded.abandon_job_id`)
      .run(domain, now, jobId);
    if (lifecycle) {
      const mailboxIds = (db.prepare("SELECT id FROM mailboxes WHERE domain=? COLLATE NOCASE ORDER BY id").all(domain) as { id: number }[]).map((row) => row.id);
      abortSourceIds = lifecycle.invalidateScope({ mailboxIds, reason: "abandon" }, now).abortSourceIds;
    }
    db.exec("COMMIT");
    try { lifecycle?.abortSources?.(abortSourceIds); } catch { /* 已撤 fence；abort 是提交后最佳努力。 */ }
    return { jobId };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function abandonStatus(
  db: DatabaseSync,
  query: { jobId?: number; domain?: string; siteId?: number; accountId?: number },
): AbandonStatus | null {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (query.jobId != null) { clauses.push("r.job_id = ?"); args.push(Number(query.jobId)); }
  if (query.domain) { clauses.push("r.domain = ? COLLATE NOCASE"); args.push(domainName(query.domain)); }
  if (query.siteId != null) { clauses.push("r.site_id = ?"); args.push(Number(query.siteId)); }
  if (query.accountId != null) { clauses.push("r.requested_account_id = ?"); args.push(Number(query.accountId)); }
  if (clauses.length === 0) throw new Error("缺少放弃任务查询条件");
  const row = db.prepare(`SELECT j.id, j.status, j.last_error, j.updated_at, r.domain
    FROM abandon_runs r JOIN jobs j ON j.id = r.job_id WHERE ${clauses.join(" AND ")} ORDER BY j.id DESC LIMIT 1`).get(...args) as {
      id: number; status: AbandonStatus["status"]; last_error: string | null; updated_at: number; domain: string;
    } | undefined;
  if (!row) return null;
  const stored = new Map((db.prepare("SELECT step, status, detail FROM abandon_steps WHERE job_id = ?").all(row.id) as {
    step: StepKey; status: AbandonStatus["steps"][number]["status"]; detail: string | null;
  }[]).map((step) => [step.step, step]));
  return {
    id: row.id,
    status: row.status,
    domain: row.domain,
    retryable: row.status === "failed",
    ...(row.last_error ? { error: row.last_error } : {}),
    steps: STEPS.map(([key, name]) => {
      const step = stored.get(key);
      return { key, name, status: step?.status ?? "pending", ...(step?.detail ? { detail: step.detail } : {}) };
    }),
    updatedAt: row.updated_at,
  };
}

export function retryAbandon(db: DatabaseSync, jobId: number, now = Date.now()): void {
  const job = db.prepare("SELECT status FROM jobs WHERE id = ? AND type = ?").get(jobId, ABANDON_JOB) as { status: string } | undefined;
  if (!job) throw new Error("放弃任务不存在");
  if (job.status !== "failed") throw new Error("只有失败的放弃任务可以重试");
  db.prepare("UPDATE abandon_steps SET status = 'pending', detail = NULL, started_at = NULL, finished_at = NULL WHERE job_id = ? AND status = 'failed'").run(jobId);
  db.prepare("UPDATE abandon_runs SET updated_at = ? WHERE job_id = ?").run(now, jobId);
  requeue(db, jobId, now);
}

async function verifiedDelete(
  write: () => Promise<unknown>,
  read: () => Promise<unknown[]>,
  remains: (items: unknown[]) => boolean,
  label: string,
): Promise<void> {
  let writeError: unknown;
  try { await write(); } catch (error) { writeError = error; }
  const after = await read();
  if (remains(after)) {
    const suffix = writeError instanceof Error ? `；接口返回：${writeError.message.slice(0, 180)}` : "";
    throw new Error(`${label} 删除后仍然存在，状态未知${suffix}`);
  }
}

const subscriptionOrderRef = (value: unknown) => first(value, [["order_id"], ["orderId"], ["order", "id"], ["resource", "order_id"], ["resource", "id"]]);
const subscriptionDomain = (value: unknown) => domainName(first(value, [
  ["domain"], ["domain_name"], ["resource", "domain"], ["resource", "name"], ["metadata", "domain"], ["product", "domain"], ["item", "domain"],
]));
const subscriptionType = (value: unknown) => (first(value, [
  ["type"], ["product_type"], ["service_type"], ["category"], ["product", "type"], ["product", "category"],
]) ?? "").toLowerCase();

function autoRenewOff(value: unknown): boolean | null {
  for (const path of [["is_auto_renewed"], ["auto_renew"], ["auto_renewal"], ["auto_renew_enabled"], ["renewal", "enabled"]]) {
    const current = at(value, ...path);
    if (typeof current === "boolean") return !current;
    if (typeof current === "number") return current === 0;
  }
  const status = (first(value, [["renewal_status"], ["status"]]) ?? "").toLowerCase();
  if (["not_renewing", "disabled", "off", "cancelled", "canceled"].includes(status)) return true;
  if (["renewing", "enabled", "on", "active"].includes(status)) return false;
  return null;
}

async function disableRenewal(exec: HostingerExec, subscriptionId: string, label: string): Promise<void> {
  const read = async () => listAll(exec, "billing_subscriptions_list");
  const before = (await read()).find((item) => idOf(item) === subscriptionId);
  if (!before) throw new PermanentError(`无法重新找到${label}订阅 ${subscriptionId}，已停止，未猜测其他订阅`);
  if (autoRenewOff(before) === true) return;
  let writeError: unknown;
  try { await exec("billing_subscriptions_disable-auto-renewal", { subscriptionId }); } catch (error) { writeError = error; }
  const after = (await read()).find((item) => idOf(item) === subscriptionId);
  if (!after || autoRenewOff(after) !== true) {
    const suffix = writeError instanceof Error ? `；接口返回：${writeError.message.slice(0, 180)}` : "";
    throw new Error(`${label}订阅 ${subscriptionId} 关闭自动续费后未得到确认${suffix}`);
  }
}

function uniqueSubscription(items: unknown[], predicate: (item: unknown) => boolean, label: string): { id: string; item: unknown } {
  const matches = items.filter(predicate).map((item) => ({ id: idOf(item), item })).filter((item): item is { id: string; item: unknown } => item.id != null);
  const unique = [...new Map(matches.map((item) => [item.id, item])).values()];
  if (unique.length !== 1) throw new PermanentError(`${label}订阅匹配到 ${unique.length} 项，无法唯一识别，任务已停止且没有猜测`);
  return unique[0];
}

async function localMail(deps: AbandonDeps, domain: string): Promise<string> {
  await deps.stopDomain(domain);
  const count = (deps.db.prepare("SELECT count(*) AS n FROM mailboxes WHERE domain = ? COLLATE NOCASE").get(domain) as { n: number }).n;
  const mailboxIds = (deps.db.prepare("SELECT id FROM mailboxes WHERE domain=? COLLATE NOCASE ORDER BY id").all(domain) as { id: number }[]).map((row) => row.id);
  const sourceIds = mailboxIds.length ? (deps.db.prepare(`SELECT id FROM mail_triage_sources WHERE mailbox_id IN (${mailboxIds.map(() => "?").join(",")}) ORDER BY id`).all(...mailboxIds) as { id: string }[]).map((row) => row.id) : [];
  let abortSourceIds = sourceIds;
  deps.db.exec("BEGIN");
  try {
    if (deps.triageLifecycleHooks) {
      abortSourceIds = deps.triageLifecycleHooks.invalidateScope({ mailboxIds, reason: "abandon" }, deps.now?.() ?? Date.now()).abortSourceIds;
      for (const sourceId of sourceIds) deps.triageLifecycleHooks.invalidateSource(sourceId, "explicit_delete", deps.now?.() ?? Date.now());
    }
    deps.db.prepare("UPDATE mailboxes SET monitoring = 0, credential_ciphertext = NULL WHERE domain = ? COLLATE NOCASE").run(domain);
    deps.db.prepare("DELETE FROM mailboxes WHERE domain = ? COLLATE NOCASE").run(domain);
    deps.db.prepare("UPDATE sites SET mailbox_ciphertext = NULL WHERE domain = ? COLLATE NOCASE").run(domain);
    deps.db.exec("COMMIT");
    try { deps.triageLifecycleHooks?.abortSources?.(abortSourceIds); } catch { /* fence 已提交 */ }
  } catch (error) {
    deps.db.exec("ROLLBACK");
    throw error;
  }
  return `已停止监听并删除 ${count} 个本地邮箱的凭据、索引和正文缓存`;
}

async function remoteMail(deps: AbandonDeps, domain: string): Promise<string> {
  const accounts = deps.db.prepare("SELECT id FROM hostinger_accounts ORDER BY id").all() as { id: number }[];
  let deletedBoxes = 0;
  let deletedAliases = 0;
  for (const { id: accountId } of accounts) {
    const exec = deps.hostinger(accountId);
    const orders = (await listAll(exec, "mail_orders_list", { domain })).filter((order) => mailOrderDomain(order) === domain);
    for (const order of orders) {
      const orderId = mailOrderId(order);
      if (!orderId) throw new PermanentError(`${domain} 的邮件订单缺少 ID，无法安全删除`);
      const readAliases = () => listAll(exec, "mail_aliases_list", { orderId });
      for (const alias of await readAliases()) {
        const aliasId = idOf(alias);
        const address = domainName(first(alias, [["address"]]));
        if (!aliasId) throw new PermanentError(`${address || domain} 的邮件别名缺少 ID，无法安全删除`);
        if (!address.endsWith(`@${domain}`)) throw new PermanentError(`邮件订单 ${orderId} 返回了不属于 ${domain} 的别名，已停止且没有删除`);
        await verifiedDelete(
          () => exec("mail_aliases_delete-alias", { aliasId }),
          readAliases,
          (items) => items.some((item) => idOf(item) === aliasId || (address && domainName(first(item, [["address"]])) === address)),
          `别名 ${address || aliasId}`,
        );
        deletedAliases++;
      }
      const readBoxes = () => listAll(exec, "mail_mailboxes_list", { orderId });
      for (const mailbox of await readBoxes()) {
        const mailboxId = idOf(mailbox);
        const address = domainName(first(mailbox, [["address"]]));
        if (!mailboxId) throw new PermanentError(`${address || domain} 的邮箱缺少 ID，无法安全删除`);
        if (!address.endsWith(`@${domain}`)) throw new PermanentError(`邮件订单 ${orderId} 返回了不属于 ${domain} 的邮箱，已停止且没有删除`);
        await verifiedDelete(
          () => exec("mail_mailboxes_delete-mailbox", { mailboxId }),
          readBoxes,
          (items) => items.some((item) => idOf(item) === mailboxId || (address && domainName(first(item, [["address"]])) === address)),
          `邮箱 ${address || mailboxId}`,
        );
        deletedBoxes++;
      }
      if ((await readBoxes()).length === 0) {
        const subscriptions = await listAll(exec, "billing_subscriptions_list");
        const explicit = first(order, [["subscription_id"], ["subscriptionId"]]);
        const subscription = explicit
          ? uniqueSubscription(subscriptions, (item) => idOf(item) === explicit, `${domain} 邮件`)
          : uniqueSubscription(subscriptions, (item) => subscriptionOrderRef(item) === orderId && /mail|email/.test(subscriptionType(item)), `${domain} 邮件`);
        await disableRenewal(exec, subscription.id, `${domain} 邮件`);
      }
    }
  }
  return `已核验删除 ${deletedBoxes} 个邮箱、${deletedAliases} 个别名，并关闭空邮件订单续费`;
}

async function website(deps: AbandonDeps, domain: string): Promise<string> {
  const accounts = deps.db.prepare("SELECT id FROM hostinger_accounts ORDER BY id").all() as { id: number }[];
  let deleted = 0;
  for (const { id: accountId } of accounts) {
    const exec = deps.hostinger(accountId);
    const read = async () => (await listAll(exec, "hosting_websites_list", { domain })).filter((item) => domainName(first(item, [["domain"]])) === domain);
    if ((await read()).length === 0) continue;
    await verifiedDelete(() => exec("hosting_websites_delete", { domain }), read, (items) => items.length > 0, `网站 ${domain}`);
    deleted++;
  }
  deps.db.prepare("DELETE FROM hosting_websites WHERE domain = ? COLLATE NOCASE").run(domain);
  return deleted ? `已删除并核验 ${deleted} 个网站记录` : "没有找到需要删除的网站";
}

async function domainRenewal(deps: AbandonDeps, domain: string, requestedAccountId: number | null): Promise<string> {
  const ownerRows = deps.db.prepare("SELECT DISTINCT account_id FROM domains WHERE domain = ? COLLATE NOCASE ORDER BY account_id").all(domain) as { account_id: number }[];
  const accountIds = requestedAccountId != null ? [requestedAccountId] : ownerRows.map((row) => row.account_id);
  if (accountIds.length === 0) throw new PermanentError(`本地快照中找不到 ${domain} 的所属账号，无法安全关闭域名续费`);
  const candidates: { accountId: number; exec: HostingerExec; id: string; item: unknown }[] = [];
  for (const accountId of accountIds) {
    const exec = deps.hostinger(accountId);
    const subscriptions = await listAll(exec, "billing_subscriptions_list");
    const typed = subscriptions.filter((item) => subscriptionDomain(item) === domain && /domain/.test(subscriptionType(item)));
    for (const item of typed) {
      const id = idOf(item);
      if (id) candidates.push({ accountId, exec, id, item });
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [`${candidate.accountId}:${candidate.id}`, candidate])).values()];
  if (unique.length !== 1) throw new PermanentError(`${domain} 的域名订阅匹配到 ${unique.length} 项，无法唯一识别，任务已停止且没有猜测`);
  await disableRenewal(unique[0].exec, unique[0].id, domain);
  return `已关闭并核验域名订阅 ${unique[0].id} 的自动续费`;
}

async function finalize(deps: AbandonDeps, domain: string, now: number): Promise<string> {
  deps.db.prepare("UPDATE sites SET abandoned_at = ?, mailbox_ciphertext = NULL, updated_at = ? WHERE domain = ? COLLATE NOCASE").run(now, now, domain);
  return `${domain} 已保留在历史中，并永久排除于新批次和邮件监听`;
}

/** runner handler：已完成步骤不会重做，失败步骤可由 abandon.retry 从原处继续。 */
export async function runAbandon(deps: AbandonDeps, job: Job): Promise<void> {
  const run = deps.db.prepare("SELECT domain, requested_account_id, site_id FROM abandon_runs WHERE job_id = ?").get(job.id) as {
    domain: string; requested_account_id: number | null; site_id: number | null;
  } | undefined;
  if (!run) throw new PermanentError(`放弃任务 ${job.id} 缺少目标记录`);
  const now = deps.now ?? Date.now;
  const actions: Record<StepKey, () => Promise<string>> = {
    local_mail: () => localMail(deps, run.domain),
    remote_mail: () => remoteMail(deps, run.domain),
    website: () => website(deps, run.domain),
    domain_renewal: () => domainRenewal(deps, run.domain, run.requested_account_id),
    finalize: () => finalize(deps, run.domain, now()),
  };
  for (const [step, name] of STEPS) {
    const current = deps.db.prepare("SELECT status FROM abandon_steps WHERE job_id = ? AND step = ?").get(job.id, step) as { status: string } | undefined;
    if (current?.status === "done") continue;
    deps.db.prepare("UPDATE abandon_steps SET status = 'running', detail = NULL, started_at = ?, finished_at = NULL WHERE job_id = ? AND step = ?")
      .run(now(), job.id, step);
    deps.db.prepare("UPDATE abandon_runs SET updated_at = ? WHERE job_id = ?").run(now(), job.id);
    emit(deps, run.site_id, step, `开始：${name}`);
    try {
      const detail = await actions[step]();
      deps.db.prepare("UPDATE abandon_steps SET status = 'done', detail = ?, finished_at = ? WHERE job_id = ? AND step = ?")
        .run(detail, now(), job.id, step);
      deps.db.prepare("UPDATE abandon_runs SET updated_at = ? WHERE job_id = ?").run(now(), job.id);
      emit(deps, run.site_id, step, detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.db.prepare("UPDATE abandon_steps SET status = 'failed', detail = ?, finished_at = ? WHERE job_id = ? AND step = ?")
        .run(message, now(), job.id, step);
      deps.db.prepare("UPDATE abandon_runs SET updated_at = ? WHERE job_id = ?").run(now(), job.id);
      emit(deps, run.site_id, step, message, "error");
      throw error;
    }
  }
}

