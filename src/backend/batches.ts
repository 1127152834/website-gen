// 批次与站点：可选域名、创建批次（站点 + 任务一起入库）、进度查询、失败重试。
import type { DatabaseSync } from "node:sqlite";
import { PROVISION_STEPS, type BatchSummary, type DomainMailboxes, type FreeDomain, type SiteProgress, type StepState } from "../shared/protocol.ts";
import { validateBatch, type BatchForm } from "../shared/forms.ts";
import { enqueue, requeue } from "./jobs.ts";
import { selectDomainMailbox } from "./site-mailbox.ts";

export const PROVISION_JOB = "site.provision";

/** 已同步、在任何账号下都还没有网站、也没在别的批次里用过的域名。 */
export function listFreeDomains(db: DatabaseSync): FreeDomain[] {
  const rows = db.prepare(`
    SELECT d.domain, d.account_id, a.label, d.expires_at,
      EXISTS (SELECT 1 FROM mail_orders m WHERE m.domain = d.domain) AS has_mail
    FROM domains d JOIN hostinger_accounts a ON a.id = d.account_id
    WHERE (d.status IS NULL OR d.status = 'active') AND d.domain <> ''
      AND NOT EXISTS (SELECT 1 FROM abandoned_domains x WHERE x.domain = d.domain COLLATE NOCASE)
      AND NOT EXISTS (SELECT 1 FROM hosting_websites w WHERE w.domain = d.domain COLLATE NOCASE)
      AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.domain = d.domain COLLATE NOCASE)
    ORDER BY d.domain`).all() as { domain: string; account_id: number; label: string; expires_at: string | null; has_mail: number }[];
  return rows.map((r) => ({ domain: r.domain.toLowerCase(), accountId: r.account_id, accountLabel: r.label, hasMail: Boolean(r.has_mail), expiresAt: r.expires_at }));
}

export function createBatch(db: DatabaseSync, form: BatchForm, now: number, verifiedMailboxes: readonly DomainMailboxes[]): { batchId: number; siteIds: number[] } {
  const errors = Object.values(validateBatch(form));
  if (errors.length > 0) throw new Error(errors[0]);
  if (!Array.isArray(verifiedMailboxes) || verifiedMailboxes.length !== form.sites.length) throw new Error("创建批次前必须逐站实时验证邮箱");

  db.exec("BEGIN IMMEDIATE");
  try {
    const free = new Set(listFreeDomains(db).map((item) => item.domain.toLowerCase()));
    const verifiedByDomain = new Map<string, DomainMailboxes>();
    for (const item of verifiedMailboxes) {
      const key = item.domain.trim().toLowerCase();
      if (!key || verifiedByDomain.has(key)) throw new Error("邮箱验证结果与站点不匹配");
      verifiedByDomain.set(key, item);
    }
    const savedSites = form.sites.map((site) => {
      const domain = site.domain.trim().toLowerCase();
      if (!free.has(domain)) throw new Error(`域名 ${site.domain} 不可用：可能已经有网站，或已在其他批次里`);
      const owners = db.prepare(`SELECT DISTINCT d.account_id, d.status AS domain_status, a.status AS account_status
        FROM domains d JOIN hostinger_accounts a ON a.id=d.account_id WHERE d.domain=? COLLATE NOCASE`).all(domain) as unknown as
        { account_id: number; domain_status: string | null; account_status: string }[];
      if (owners.length !== 1 || owners[0].domain_status !== "active" || owners[0].account_status !== "ok") {
        throw new Error(`${domain} 的 Hostinger 域名归属或状态已变化，请重新选择站点`);
      }
      const verified = verifiedByDomain.get(domain);
      if (!verified || verified.accountId !== owners[0].account_id) throw new Error(`${domain} 的邮箱账号归属已变化，请重新读取邮箱`);
      for (const mailbox of verified.mailboxes) {
        const addressDomain = mailbox.address.trim().toLowerCase().split("@").at(-1);
        if (addressDomain !== domain) throw new Error(`邮箱 ${mailbox.address} 不属于域名 ${domain}`);
      }
      const supportEmail = selectDomainMailbox(verified, site.supportEmail);
      return { ...site, domain, supportEmail };
    });
    if (verifiedByDomain.size !== savedSites.length) throw new Error("邮箱验证结果包含未选择的站点");

    const batchId = (db.prepare("INSERT INTO batches (entity_json, created_at) VALUES (?, ?) RETURNING id").get(JSON.stringify(form.entity), now) as { id: number }).id;
    const insSite = db.prepare("INSERT INTO sites (batch_id, domain, form_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id");
    const siteIds = savedSites.map((s) => {
      const id = (insSite.get(batchId, s.domain, JSON.stringify(s), now, now) as { id: number }).id;
      enqueue(db, PROVISION_JOB, id, now);
      return id;
    });
    db.exec("COMMIT");
    return { batchId, siteIds };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function listBatches(db: DatabaseSync): BatchSummary[] {
  const rows = db.prepare(`
    SELECT b.id, b.created_at,
      sum(CASE WHEN s.id IS NOT NULL AND s.abandoned_at IS NULL AND x.domain IS NULL THEN 1 ELSE 0 END) AS total,
      sum(CASE WHEN s.abandoned_at IS NULL AND x.domain IS NULL AND s.status = 'done' THEN 1 ELSE 0 END) AS done,
      sum(CASE WHEN s.abandoned_at IS NULL AND x.domain IS NULL AND s.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      sum(CASE WHEN s.abandoned_at IS NULL AND x.domain IS NULL AND s.status IN ('queued','running','waiting') THEN 1 ELSE 0 END) AS active
    FROM batches b LEFT JOIN sites s ON s.batch_id = b.id
    LEFT JOIN abandoned_domains x ON x.domain = s.domain COLLATE NOCASE
    GROUP BY b.id HAVING total > 0 ORDER BY b.id DESC`).all() as Record<string, number>[];
  return rows.map((r) => ({ id: r.id, createdAt: r.created_at, total: r.total, done: r.done ?? 0, failed: r.failed ?? 0, active: r.active ?? 0 }));
}

export function siteSteps(db: DatabaseSync, siteId: number): StepState[] {
  const rows = new Map(
    (db.prepare("SELECT step, status, detail, started_at, finished_at FROM provision_steps WHERE site_id = ?").all(siteId) as {
      step: string; status: StepState["status"]; detail: string | null; started_at: number; finished_at: number | null;
    }[]).map((r) => [r.step, r]),
  );
  return PROVISION_STEPS.map(({ key, name }) => {
    const r = rows.get(key);
    return { key, name, status: r?.status ?? "pending", detail: r?.detail ?? null, startedAt: r?.started_at ?? null, finishedAt: r?.finished_at ?? null };
  });
}

export function batchSites(db: DatabaseSync, batchId: number): SiteProgress[] {
  const sites = db.prepare(`SELECT s.id, s.batch_id, s.domain,
    CASE WHEN s.abandoned_at IS NOT NULL OR x.domain IS NOT NULL THEN 'abandoned' ELSE s.status END AS status,
    s.last_error, s.updated_at, s.launched_at
    FROM sites s LEFT JOIN abandoned_domains x ON x.domain = s.domain COLLATE NOCASE
    WHERE s.batch_id = ? ORDER BY s.id`).all(batchId) as {
    id: number; batch_id: number; domain: string; status: SiteProgress["status"]; last_error: string | null; updated_at: number; launched_at: number | null;
  }[];
  return sites.map((s) => {
    const steps = siteSteps(db, s.id);
    const completed = steps.filter((x) => x.status === "done" || x.status === "skipped").length;
    const current = s.status === "done" || s.status === "abandoned" ? null : steps.find((x) => x.status !== "done" && x.status !== "skipped");
    return { id: s.id, batchId: s.batch_id, domain: s.domain, status: s.status, completed, currentStep: current?.name ?? null, lastError: s.last_error, updatedAt: s.updated_at, launchedAt: s.launched_at };
  });
}

/** 失败的站从失败的那一步重新开始。 */
export function retrySite(db: DatabaseSync, siteId: number, now: number): void {
  const abandoned = db.prepare(`SELECT 1 FROM sites s LEFT JOIN abandoned_domains x ON x.domain = s.domain COLLATE NOCASE
    WHERE s.id = ? AND (s.abandoned_at IS NOT NULL OR x.domain IS NOT NULL)`).get(siteId);
  if (abandoned) throw new Error("已放弃的站点不能重试建站");
  const job = db.prepare("SELECT id FROM jobs WHERE site_id = ? AND type = ? ORDER BY id DESC LIMIT 1").get(siteId, PROVISION_JOB) as { id: number } | undefined;
  if (!job) throw new Error(`站点 ${siteId} 没有建站任务`);
  db.prepare("DELETE FROM provision_steps WHERE site_id = ? AND status = 'failed'").run(siteId);
  db.prepare("UPDATE sites SET status = 'queued', last_error = NULL, updated_at = ? WHERE id = ?").run(now, siteId);
  requeue(db, job.id, now);
}
