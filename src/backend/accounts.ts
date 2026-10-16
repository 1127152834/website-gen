// Hostinger 账号：接入时先用 Token 调一次只读接口验证，通过后只存密文；同步把四类资源存成该账号的最新快照。
import type { DatabaseSync } from "node:sqlite";
import type { AccountSummary, DomainSummary } from "../shared/protocol.ts";
import { HostingerError, listAll, type HostingerExec } from "./hostinger.ts";
import { seal, unseal } from "./secrets.ts";

const friendly = (e: unknown): string => {
  if (e instanceof HostingerError && (e.status === 401 || e.status === 403)) return "Token 无效或已被撤销，请在 hPanel 重新生成";
  return e instanceof Error ? e.message : String(e);
};

export async function addAccount(db: DatabaseSync, key: Buffer, input: { label: string; token: string }, exec: HostingerExec): Promise<number> {
  const label = input.label.trim();
  const token = input.token.trim();
  if (!label) throw new Error("请填写账号名称");
  if (!token) throw new Error("请填写 API Token");
  try {
    await exec("hosting_orders_list", {});
  } catch (e) {
    throw new Error(friendly(e));
  }
  const row = db
    .prepare("INSERT INTO hostinger_accounts (label, token_ciphertext, token_hint, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .get(label, seal(key, token), token.slice(-4), Date.now()) as { id: number };
  return row.id;
}

export function accountToken(db: DatabaseSync, key: Buffer, id: number): string {
  const row = db.prepare("SELECT token_ciphertext FROM hostinger_accounts WHERE id = ?").get(id) as { token_ciphertext: Uint8Array } | undefined;
  if (!row) throw new Error(`账号 ${id} 不存在`);
  return unseal(key, row.token_ciphertext);
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));
const flag = (v: unknown) => (v == null ? null : v ? 1 : 0);

export async function syncAccount(db: DatabaseSync, accountId: number, exec: HostingerExec) {
  let lists: Obj[][];
  try {
    lists = (await Promise.all([
      listAll(exec, "hosting_orders_list"),
      listAll(exec, "hosting_websites_list"),
      listAll(exec, "domains_portfolio_list"),
      listAll(exec, "mail_orders_list"),
    ])) as Obj[][];
  } catch (e) {
    const status = e instanceof HostingerError && (e.status === 401 || e.status === 403) ? "auth_failed" : "error";
    db.prepare("UPDATE hostinger_accounts SET status = ?, last_error = ? WHERE id = ?").run(status, friendly(e), accountId);
    throw e;
  }
  const [orders, websites, domains, mailOrders] = lists;

  // 整体替换该账号的快照：上次有、这次没有的资源随之删除
  db.exec("BEGIN");
  try {
    for (const t of ["hosting_orders", "hosting_websites", "domains", "mail_orders"]) db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(accountId);
    const insOrder = db.prepare("INSERT INTO hosting_orders (account_id, external_id, plan, status, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const o of orders) insOrder.run(accountId, Number(o.id), str((o.plan as Obj | undefined)?.name), str(o.status), str(o.created_at));
    const insSite = db.prepare("INSERT INTO hosting_websites (account_id, domain, username, order_id, website_type, is_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const w of websites) insSite.run(accountId, String(w.domain), str(w.username), w.order_id == null ? null : Number(w.order_id), str(w.website_type), flag(w.is_enabled), str(w.created_at));
    const insDomain = db.prepare("INSERT INTO domains (account_id, external_id, domain, type, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    // 待设置的域名（status=pending_setup）Hostinger 返回 domain=null：存成空字符串，绝不能存成 "null"
    for (const d of domains) insDomain.run(accountId, Number(d.id), str(d.domain) ?? "", str(d.type), str(d.status), str(d.expires_at), str(d.created_at));
    const insMail = db.prepare("INSERT INTO mail_orders (account_id, external_id, domain, plan, status, seats, is_trial, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const m of mailOrders) {
      const plan = m.plan as Obj | undefined;
      insMail.run(accountId, String(m.id), str((m.domain as Obj | undefined)?.name), str(plan?.title ?? plan?.name), str(m.status), m.seats == null ? null : Number(m.seats), flag(m.is_trial), str(m.expires_at));
    }
    db.prepare("UPDATE hostinger_accounts SET status = 'ok', last_error = NULL, last_synced_at = ? WHERE id = ?").run(Date.now(), accountId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { orders: orders.length, websites: websites.length, domains: domains.length, mailOrders: mailOrders.length };
}

/**
 * 解开保存的 Token 再同步。写成 async：解密失败（例如数据拷到另一台电脑、主密钥对不上）也只会变成 Promise 拒绝，
 * 并记在账号状态里，不会在调用方同步抛出、拖垮后台进程。
 */
export async function syncWithStoredToken(db: DatabaseSync, key: Buffer, id: number, execFor: (token: string) => HostingerExec) {
  let token: string;
  try {
    token = accountToken(db, key, id);
  } catch (e) {
    db.prepare("UPDATE hostinger_accounts SET status = 'error', last_error = ? WHERE id = ?")
      .run("无法解开保存的 Token（本机密钥可能已更换），请删除这个账号后重新添加", id);
    throw e;
  }
  return syncAccount(db, id, execFor(token));
}

export function listAccounts(db: DatabaseSync): AccountSummary[] {
  const rows = db.prepare(`
    SELECT a.id, a.label, a.token_hint, a.status, a.last_error, a.last_synced_at,
      (SELECT count(*) FROM hosting_orders   WHERE account_id = a.id) AS orders,
      (SELECT count(*) FROM hosting_websites WHERE account_id = a.id) AS websites,
      (SELECT count(*) FROM domains          WHERE account_id = a.id) AS domains,
      (SELECT count(*) FROM mail_orders      WHERE account_id = a.id) AS mail_orders
    FROM hostinger_accounts a ORDER BY a.id`).all() as Obj[];
  return rows.map((r) => ({
    id: Number(r.id),
    label: String(r.label),
    tokenHint: String(r.token_hint),
    status: r.status as AccountSummary["status"],
    lastError: str(r.last_error),
    lastSyncedAt: r.last_synced_at == null ? null : Number(r.last_synced_at),
    counts: { orders: Number(r.orders), websites: Number(r.websites), domains: Number(r.domains), mailOrders: Number(r.mail_orders) },
  }));
}

export function listDomains(db: DatabaseSync, accountId: number): DomainSummary[] {
  const rows = db.prepare(`
    -- 网站和邮箱可能在别的 Hostinger 账号下（跨账号绑定），所以这里不限账号
    SELECT d.external_id, d.domain,
      CASE WHEN x.domain IS NOT NULL THEN 'abandoned' ELSE d.status END AS status,
      d.expires_at, x.domain IS NOT NULL AS abandoned,
      EXISTS (SELECT 1 FROM hosting_websites w WHERE w.domain = d.domain) AS has_website,
      EXISTS (SELECT 1 FROM mail_orders m WHERE m.domain = d.domain) AS has_mail
    FROM domains d LEFT JOIN abandoned_domains x ON x.domain = d.domain COLLATE NOCASE
    WHERE d.account_id = ? ORDER BY d.domain = '', d.domain`).all(accountId) as Obj[];
  return rows.map((r) => ({
    id: Number(r.external_id),
    domain: String(r.domain),
    status: str(r.status),
    expiresAt: str(r.expires_at),
    hasWebsite: Boolean(r.has_website),
    hasMail: Boolean(r.has_mail),
    abandoned: Boolean(r.abandoned),
  }));
}

/** 只删本地记录和密文，不会动 Hostinger 上的任何资源。 */
export function removeAccount(db: DatabaseSync, id: number): void {
  db.prepare("DELETE FROM hostinger_accounts WHERE id = ?").run(id);
}
