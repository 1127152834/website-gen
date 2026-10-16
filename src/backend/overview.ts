// 运营总览只读取当前工作区的快照，不发起外部调用。
import type { DatabaseSync } from "node:sqlite";
import { batchSites, listBatches } from "./batches.ts";
import { PROVISION_STEPS, type QaView, type SiteProgress, type SiteStatus } from "../shared/protocol.ts";

export interface Overview {
  counts: Record<SiteStatus | "total" | "launched", number>;
  runningBatches: ReturnType<typeof listBatches>;
  attention: { siteId: number; domain: string; reasons: string[]; tab: string }[];
  expiringDomains: { accountId: number; accountLabel: string; domain: string; expiresAt: string; daysLeft: number }[];
}

export function allSites(db: DatabaseSync): SiteProgress[] {
  return listBatches(db).flatMap((batch) => batchSites(db, batch.id)).filter((site) => site.status !== "abandoned");
}

export function getOverview(db: DatabaseSync, now = Date.now()): Overview {
  const sites = allSites(db);
  const counts: Overview["counts"] = { total: sites.length, queued: 0, running: 0, waiting: 0, done: 0, failed: 0, abandoned: 0, launched: 0 };
  for (const site of sites) { counts[site.status]++; if (site.launchedAt != null) counts.launched++; }
  const reports = new Map((db.prepare("SELECT id, qa_json, mailbox_ciphertext FROM sites").all() as { id: number; qa_json: string | null; mailbox_ciphertext: Uint8Array | null }[]).map((row) => [row.id, row]));
  const attention = sites.flatMap((site) => {
    const row = reports.get(site.id)!;
    const reasons: string[] = [];
    let tab = "overview";
    // 总览只说一句看得懂的中文：问题明细（英文证据、待办）在复核报告和站点页里
    const failedStep = site.status === "failed"
      ? (db.prepare("SELECT step FROM provision_steps WHERE site_id = ? AND status = 'failed' LIMIT 1").get(site.id) as { step: string } | undefined)?.step
      : undefined;
    const qa = row.qa_json ? JSON.parse(row.qa_json) as QaView : null;
    const open = qa?.review?.issues.filter((issue) => issue.status !== "fixed") ?? [];
    const p1 = open.filter((issue) => issue.level === "P1").length;
    const needs = open.filter((issue) => issue.status === "needs_you").length;
    if (site.status === "failed" && failedStep === "qa" && qa) {
      reasons.push(`QA 未通过：${p1 ? `有 ${p1} 个必须先解决的问题` : "有检查项没通过"}`);
      if (needs) reasons.push(`共 ${needs} 项需要你补充真实资料（如商品尺寸、套装内容）`);
      tab = "qa";
    } else if (site.status === "failed") {
      const stepName = PROVISION_STEPS.find((s) => s.key === failedStep)?.name;
      const brief = (site.lastError ?? "").replace(/^[^：]{1,20}：/, "").split(/[；;\n]/)[0].trim();
      reasons.push(`${stepName ? `「${stepName}」` : ""}建站失败${brief ? `：${brief.length > 50 ? `${brief.slice(0, 50)}…` : brief}` : "，请检查日志后重试"}`);
    } else if (qa) {
      if (qa.checks?.some((check) => !check.ok)) { reasons.push("QA 检查有提醒项"); tab = "qa"; }
      if (needs) { reasons.push(`复核有 ${needs} 项需要你补充资料`); tab = "qa"; }
    }
    if (site.status === "done" && !row.mailbox_ciphertext) {
      const mailbox = db.prepare("SELECT status FROM provision_steps WHERE site_id = ? AND step = 'mailbox'").get(site.id) as { status: string } | undefined;
      if (mailbox?.status !== "done") { reasons.push("客服邮箱尚未配置，请开通后检查并修复"); if (tab === "overview") tab = "mail"; }
    }
    if (site.status === "done" && site.launchedAt == null) reasons.push("上线前请确认支付接入与买家流程");
    return reasons.length ? [{ siteId: site.id, domain: site.domain, reasons, tab }] : [];
  });
  const expiringDomains = (db.prepare(`SELECT d.account_id, a.label, d.domain, d.expires_at FROM domains d
    JOIN hostinger_accounts a ON a.id = d.account_id
    WHERE d.expires_at IS NOT NULL AND d.domain <> ''
      AND NOT EXISTS (SELECT 1 FROM abandoned_domains x WHERE x.domain = d.domain COLLATE NOCASE)`).all() as { account_id: number; label: string; domain: string; expires_at: string }[])
    .map((d) => ({ accountId: d.account_id, accountLabel: d.label, domain: d.domain, expiresAt: d.expires_at, daysLeft: Math.ceil((Date.parse(d.expires_at) - now) / 86_400_000) }))
    .filter((d) => Number.isFinite(d.daysLeft) && Date.parse(d.expiresAt) >= now && Date.parse(d.expiresAt) <= now + 30 * 86_400_000)
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  return { counts, runningBatches: listBatches(db).filter((batch) => batch.active > 0), attention, expiringDomains };
}
