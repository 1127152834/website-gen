// 批次与站点：可选域名、创建批次（站点 + 任务一起入库）、进度查询、失败重试。
import type { DatabaseSync } from "node:sqlite";
import { PROVISION_STEPS, type BatchSummary, type FreeDomain, type SiteProgress, type StepState } from "../shared/protocol.ts";
import { validateBatch, type BatchForm } from "../shared/forms.ts";
import { enqueue, requeue } from "./jobs.ts";

export const PROVISION_JOB = "site.provision";

/** 已同步、在任何账号下都还没有网站、也没在别的批次里用过的域名。 */
export function listFreeDomains(db: DatabaseSync): FreeDomain[] {
  const rows = db.prepare(`
    SELECT d.domain, d.account_id, a.label, d.expires_at,
      EXISTS (SELECT 1 FROM mail_orders m WHERE m.domain = d.domain) AS has_mail
    FROM domains d JOIN hostinger_accounts a ON a.id = d.account_id
    WHERE (d.status IS NULL OR d.status = 'active') AND d.domain <> ''
      AND NOT EXISTS (SELECT 1 FROM hosting_websites w WHERE w.domain = d.domain)
      AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.domain = d.domain)
    ORDER BY d.domain`).all() as { domain: string; account_id: number; label: string; expires_at: string | null; has_mail: number }[];
  return rows.map((r) => ({ domain: r.domain, accountId: r.account_id, accountLabel: r.label, hasMail: Boolean(r.has_mail), expiresAt: r.expires_at }));
}

export function createBatch(db: DatabaseSync, form: BatchForm, now: number): { batchId: number; siteIds: number[] } {
  const errors = Object.values(validateBatch(form));
  if (errors.length > 0) throw new Error(errors[0]);
  const free = new Set(listFreeDomains(db).map((d) => d.domain));
  for (const s of form.sites) if (!free.has(s.domain)) throw new Error(`域名 ${s.domain} 不可用：可能已经有网站，或已在其他批次里`);

  db.exec("BEGIN");
  try {
    const batchId = (db.prepare("INSERT INTO batches (entity_json, created_at) VALUES (?, ?) RETURNING id").get(JSON.stringify(form.entity), now) as { id: number }).id;
    const insSite = db.prepare("INSERT INTO sites (batch_id, domain, form_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id");
    const siteIds = form.sites.map((s) => {
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
    SELECT b.id, b.created_at, count(s.id) AS total,
      sum(s.status = 'done') AS done, sum(s.status = 'failed') AS failed,
      sum(s.status IN ('queued','running','waiting')) AS active
    FROM batches b LEFT JOIN sites s ON s.batch_id = b.id
    GROUP BY b.id ORDER BY b.id DESC`).all() as Record<string, number>[];
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
  const sites = db.prepare("SELECT id, batch_id, domain, status, last_error, updated_at, launched_at FROM sites WHERE batch_id = ? ORDER BY id").all(batchId) as {
    id: number; batch_id: number; domain: string; status: SiteProgress["status"]; last_error: string | null; updated_at: number; launched_at: number | null;
  }[];
  return sites.map((s) => {
    const steps = siteSteps(db, s.id);
    const completed = steps.filter((x) => x.status === "done" || x.status === "skipped").length;
    const current = s.status === "done" ? null : steps.find((x) => x.status !== "done" && x.status !== "skipped");
    return { id: s.id, batchId: s.batch_id, domain: s.domain, status: s.status, completed, currentStep: current?.name ?? null, lastError: s.last_error, updatedAt: s.updated_at, launchedAt: s.launched_at };
  });
}

/** 失败的站从失败的那一步重新开始。 */
export function retrySite(db: DatabaseSync, siteId: number, now: number): void {
  const job = db.prepare("SELECT id FROM jobs WHERE site_id = ? AND type = ? ORDER BY id DESC LIMIT 1").get(siteId, PROVISION_JOB) as { id: number } | undefined;
  if (!job) throw new Error(`站点 ${siteId} 没有建站任务`);
  db.prepare("DELETE FROM provision_steps WHERE site_id = ? AND status = 'failed'").run(siteId);
  db.prepare("UPDATE sites SET status = 'queued', last_error = NULL, updated_at = ? WHERE id = ?").run(now, siteId);
  requeue(db, job.id, now);
}
