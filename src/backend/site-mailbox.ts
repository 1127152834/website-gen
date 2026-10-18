import type { DatabaseSync } from "node:sqlite";
import type { DomainMailboxes } from "../shared/protocol.ts";
import { listAll, type HostingerExec } from "./hostinger.ts";

type ExecForAccount = (accountId: number) => HostingerExec;
type RemoteObject = Record<string, unknown>;

export class MailboxSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxSelectionError";
  }
}

const normalizeDomain = (value: string): string => value.trim().toLowerCase().replace(/\.$/, "");
const normalizeEmail = (value: string): string => value.trim().toLowerCase();

function remoteDomain(value: unknown): string {
  if (typeof value === "string") return normalizeDomain(value);
  if (value && typeof value === "object") {
    const object = value as RemoteObject;
    if (typeof object.name === "string") return normalizeDomain(object.name);
    if (typeof object.domain === "string") return normalizeDomain(object.domain);
  }
  return "";
}

/**
 * Read the current Hostinger mailboxes for one workspace-owned domain.
 * The workspace snapshot selects exactly one account; all mailbox facts then come from read-only remote calls.
 */
export async function readDomainMailboxes(db: DatabaseSync, rawDomain: string, execForAccount: ExecForAccount): Promise<DomainMailboxes> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) throw new Error("请先选择域名");

  const owners = db.prepare(`SELECT DISTINCT d.account_id, d.status AS domain_status, a.status AS account_status
    FROM domains d JOIN hostinger_accounts a ON a.id=d.account_id
    WHERE d.domain = ? COLLATE NOCASE`).all(domain) as unknown as { account_id: number; domain_status: string | null; account_status: string }[];
  if (owners.length === 0) throw new Error(`${domain} 不在当前工作区已同步的 Hostinger 域名中`);
  if (new Set(owners.map((owner) => owner.account_id)).size !== 1) throw new Error(`${domain} 同时出现在多个 Hostinger 账号，无法安全判断归属`);
  const owner = owners[0];
  if (owner.domain_status !== "active") throw new Error(`${domain} 的本地域名状态不是 active，请先同步账号`);
  if (owner.account_status !== "ok") throw new Error(`${domain} 所属 Hostinger 账号状态异常，请先重新同步账号`);

  const exec = execForAccount(owner.account_id);
  const portfolio = await listAll(exec, "domains_portfolio_list");
  const remoteDomains = portfolio.filter((item) => item && typeof item === "object" && remoteDomain((item as RemoteObject).domain) === domain) as RemoteObject[];
  if (remoteDomains.length !== 1) {
    throw new Error(remoteDomains.length === 0
      ? `${domain} 已不在所选 Hostinger 账号的当前域名清单中`
      : `${domain} 在所选 Hostinger 账号中出现多条记录，无法安全判断归属`);
  }
  // MCP 的 portfolio 响应未声明 status 必填；有值时必须 active，无值时使用上面的已同步 active 快照。
  const currentDomainStatus = remoteDomains[0].status;
  if (currentDomainStatus != null && String(currentDomainStatus).toLowerCase() !== "active") {
    throw new Error(`${domain} 的 Hostinger 当前状态不是 active`);
  }

  const orderRows = (await listAll(exec, "mail_orders_list", { domain, status: "active" }))
    .filter((item) => item && typeof item === "object" && remoteDomain((item as RemoteObject).domain) === domain) as RemoteObject[];
  for (const order of orderRows) {
    if (order.status == null) throw new Error(`${domain} 的邮箱订单缺少状态，不能确认可用`);
  }
  const orders = orderRows.filter((order) => String(order.status).toLowerCase() === "active");
  const addresses = new Set<string>();
  for (const order of orders) {
    if (order.id == null || String(order.id).trim() === "") throw new Error(`${domain} 的有效邮箱订单缺少 ID`);
    const boxes = await listAll(exec, "mail_mailboxes_list", { orderId: String(order.id) });
    for (const item of boxes) {
      if (!item || typeof item !== "object") throw new Error(`${domain} 的邮箱清单格式无效`);
      const box = item as RemoteObject;
      if (box.status == null) throw new Error(`${domain} 的邮箱缺少状态，不能确认可用`);
      if (String(box.status).toLowerCase() !== "active") continue;
      if (typeof box.address !== "string" || !box.address.includes("@")) throw new Error(`${domain} 的有效邮箱缺少地址`);
      const address = normalizeEmail(box.address);
      if (normalizeDomain(address.split("@").at(-1) ?? "") !== domain) throw new Error(`${address} 与邮箱订单域名 ${domain} 不匹配`);
      addresses.add(address);
    }
  }

  const mailboxes = [...addresses].sort((a, b) => a.localeCompare(b)).map((address) => ({ address }));
  const defaultEmail = mailboxes.length === 1 ? mailboxes[0].address : null;
  return { domain, accountId: owner.account_id, mailboxes, defaultEmail };
}

/** Resolve an optional UI choice against the remotely verified active mailbox list. */
export function selectDomainMailbox(result: DomainMailboxes, requested?: string): string {
  if (result.mailboxes.length === 0) throw new MailboxSelectionError(`${result.domain} 还没有可用邮箱，请先为该站点申请邮箱再建站`);
  const choice = requested?.trim() ? normalizeEmail(requested) : result.defaultEmail;
  if (!choice) throw new MailboxSelectionError(`${result.domain} 有多个邮箱，请选择一个已申请的客服邮箱`);
  const matched = result.mailboxes.find((mailbox) => normalizeEmail(mailbox.address) === choice);
  if (!matched) throw new MailboxSelectionError(`${choice} 不是 ${result.domain} 已申请且可用的邮箱`);
  return normalizeEmail(matched.address);
}
