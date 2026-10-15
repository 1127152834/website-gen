// 运营总览只读取当前工作区的快照，不发起外部调用。
import type { DatabaseSync } from "node:sqlite";
import { batchSites, listBatches } from "./batches.ts";
import type { QaView, SiteProgress, SiteStatus } from "../shared/protocol.ts";

export interface Overview {
  counts: Record<SiteStatus | "total" | "launched", number>;
  runningBatches: ReturnType<typeof listBatches>;
  attention: { siteId: number; domain: string; reasons: string[]; tab: string }[];
  expiringDomains: { accountId: number; accountLabel: string; domain: string; expiresAt: string; daysLeft: number }[];
}

export function allSites(db: DatabaseSync): SiteProgress[] {
  return listBatches(db).flatMap((batch) => batchSites(db, batch.id));
}

export function getOverview(db: DatabaseSync, now = Date.now()): Overview {
  const sites = allSites(db);
  const counts: Overview["counts"] = { total: sites.length, queued: 0, running: 0, waiting: 0, done: 0, failed: 0, launched: 0 };
  for (const site of sites) { counts[site.status]++; if (site.launchedAt != null) counts.launched++; }
  const reports = new Map((db.prepare("SELECT id, qa_json, mailbox_ciphertext FROM sites").all() as { id: number; qa_json: string | null; mailbox_ciphertext: Uint8Array | null }[]).map((row) => [row.id, row]));
  const attention = sites.flatMap((site) => {
    const row = reports.get(site.id)!;
    const reasons: string[] = [];
    let tab = "overview";
    if (site.status === "failed") reasons.push(site.lastError ? `建站失败：${site.lastError}` : "建站失败，请检查日志后重试");
    if (row.qa_json) {
      const qa = JSON.parse(row.qa_json) as QaView;
      if (qa.checks?.some((check) => !check.ok)) { reasons.push("QA 检查存在未通过项"); tab = "qa"; }
      const needs = qa.review?.issues.filter((issue) => issue.status === "needs_you").length ?? 0;
      if (needs) { reasons.push(`复核有 ${needs} 项待你补充`); tab = "qa"; }
    }
    if (site.status === "done" && !row.mailbox_ciphertext) {
      const mailbox = db.prepare("SELECT status FROM provision_steps WHERE site_id = ? AND step = 'mailbox'").get(site.id) as { status: string } | undefined;
      if (mailbox?.status !== "done") { reasons.push("客服邮箱尚未配置，请开通后检查并修复"); if (tab === "overview") tab = "mail"; }
    }
    if (site.status === "done" && site.launchedAt == null) reasons.push("上线前请确认支付接入与买家流程");
    return reasons.length ? [{ siteId: site.id, domain: site.domain, reasons, tab }] : [];
  });
  const expiringDomains = (db.prepare("SELECT d.account_id, a.label, d.domain, d.expires_at FROM domains d JOIN hostinger_accounts a ON a.id = d.account_id WHERE d.expires_at IS NOT NULL AND d.domain <> ''").all() as { account_id: number; label: string; domain: string; expires_at: string }[])
    .map((d) => ({ accountId: d.account_id, accountLabel: d.label, domain: d.domain, expiresAt: d.expires_at, daysLeft: Math.ceil((Date.parse(d.expires_at) - now) / 86_400_000) }))
    .filter((d) => Number.isFinite(d.daysLeft) && Date.parse(d.expiresAt) >= now && Date.parse(d.expiresAt) <= now + 30 * 86_400_000)
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  return { counts, runningBatches: listBatches(db).filter((batch) => batch.active > 0), attention, expiringDomains };
}
