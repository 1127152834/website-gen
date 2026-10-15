// 任务队列：jobs 表 + 租约。认领时上租约，崩溃后租约过期的任务被收回重跑；
// 处理函数返回 { waitMs } 表示「等会儿再来」，改约到稍后且不消耗重试次数、不占并发名额。
import type { DatabaseSync } from "node:sqlite";

/** 不该重试的错误（例如域名已有网站、参数被 Hostinger 拒绝），直接标记失败。 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export interface Job {
  id: number;
  type: string;
  siteId: number | null;
  attempts: number;
  maxAttempts: number;
}

export type JobHandler = (job: Job) => Promise<{ waitMs: number } | void>;

const BACKOFF_MS = 30_000;

export function enqueue(db: DatabaseSync, type: string, siteId: number | null, now: number): number {
  return (db.prepare("INSERT INTO jobs (type, site_id, run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id").get(type, siteId, now, now, now) as { id: number }).id;
}

export function claimDue(db: DatabaseSync, now: number, limit: number, leaseMs: number): Job[] {
  if (limit <= 0) return [];
  const rows = db.prepare(`
    UPDATE jobs SET status = 'running', lease_until = ?, updated_at = ?
    WHERE id IN (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at, id LIMIT ?)
    RETURNING id, type, site_id, attempts, max_attempts`).all(now + leaseMs, now, now, limit) as { id: number; type: string; site_id: number | null; attempts: number; max_attempts: number }[];
  return rows.map((r) => ({ id: r.id, type: r.type, siteId: r.site_id, attempts: r.attempts, maxAttempts: r.max_attempts }));
}

/** 应用重启时调用：上次没跑完（租约已过期）的任务重新排队。 */
export function recoverStale(db: DatabaseSync, now: number): number {
  return Number(db.prepare("UPDATE jobs SET status = 'queued', lease_until = NULL, updated_at = ? WHERE status = 'running' AND lease_until < ?").run(now, now).changes);
}

/** 失败的任务重新开始（界面上的「重试」）。 */
export function requeue(db: DatabaseSync, jobId: number, now: number): void {
  db.prepare("UPDATE jobs SET status = 'queued', attempts = 0, run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(now, now, jobId);
}

export function createRunner(opts: {
  db: DatabaseSync;
  handlers: Record<string, JobHandler>;
  concurrency?: number;
  leaseMs?: number;
  now?: () => number;
  /** 每个任务跑完（不论成败）后回调，用来推送界面刷新 */
  onSettled?: (job: Job, outcome: "done" | "waiting" | "retry" | "failed", error?: string) => void;
}) {
  const { db, handlers, concurrency = 3, leaseMs = 10 * 60_000, now = Date.now, onSettled } = opts;
  const running = new Set<number>();

  async function run(job: Job) {
    const handler = handlers[job.type];
    try {
      if (!handler) throw new PermanentError(`没有处理 ${job.type} 的程序`);
      const result = await handler(job);
      if (result?.waitMs) {
        db.prepare("UPDATE jobs SET status = 'queued', run_at = ?, lease_until = NULL, updated_at = ? WHERE id = ?").run(now() + result.waitMs, now(), job.id);
        onSettled?.(job, "waiting");
      } else {
        db.prepare("UPDATE jobs SET status = 'done', lease_until = NULL, updated_at = ? WHERE id = ?").run(now(), job.id);
        onSettled?.(job, "done");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const attempts = job.attempts + 1;
      const final = e instanceof PermanentError || attempts >= job.maxAttempts;
      db.prepare("UPDATE jobs SET status = ?, attempts = ?, run_at = ?, last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?")
        .run(final ? "failed" : "queued", attempts, now() + BACKOFF_MS * attempts, message, now(), job.id);
      onSettled?.(job, final ? "failed" : "retry", message);
    }
  }

  return {
    /** 认领空闲名额数量的到期任务并等它们跑完；周期性调用即可（重叠调用安全）。 */
    async tick(): Promise<void> {
      const jobs = claimDue(db, now(), concurrency - running.size, leaseMs);
      for (const j of jobs) running.add(j.id);
      await Promise.all(jobs.map((j) => run(j).finally(() => running.delete(j.id))));
    },
  };
}
