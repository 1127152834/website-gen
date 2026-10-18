import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SourceLocator } from "../shared/mail-triage-types.ts";
import { SourceLocatorSchema } from "./mail-triage-schema.ts";
import type { ParsedSafeMessage } from "./mailbox-parser.ts";

export interface RegisteredSource { sourceId: string; sourceVersion: number; isNew: boolean }
export interface PendingSource extends RegisteredSource { locator: SourceLocator; mail: ParsedSafeMessage; observedAt: number; jobId: string | null; configEpoch: number }
/** 后续 projector 同步幂等写入 review_new_mail；键为 sourceId/sourceVersion/configEpoch，不依赖模型就绪。禁止网络/异步。 */
export interface SourceRegistrationHooks {
  onPendingSource?: (source: PendingSource) => void;
  /** 来源状态已经在当前同步 SAVEPOINT 内变更；钩子必须同步清理支持集，不得 abort/await。 */
  onSourceInvalidated?: (input: { sourceId: string; reason: "stale" | "missing" | "explicit_delete"; now: number }) => void;
}

const lines = (value: string) => value.replace(/\r\n?/g, "\n");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? lines(item) : item);
export function fingerprintSource(key: Buffer, mail: ParsedSafeMessage): { sourceHash: string; criticalHeadersHash: string } {
  const derived = createHmac("sha256", key).update("mail-triage.source-key.v1\0").digest();
  const headers = [mail.messageId, mail.from, mail.fromAddresses, mail.to, mail.cc, mail.subject, mail.date, mail.inReplyTo, mail.references];
  const digest = (domain: string, value: unknown) => createHmac("sha256", derived).update(domain).update("\0").update(canonical(value)).digest("hex");
  return {
    sourceHash: digest("mail-triage.source.v1", [...headers, mail.text, mail.attachments.map((a) => [a.partId, a.name, a.type, a.size])]),
    criticalHeadersHash: digest("mail-triage.critical-headers.v1", headers),
  };
}

/** Opaque, workspace-keyed cache generation identity. It is a UI freshness hint, never an authorization token. */
export function cacheReadIdentity(key: Buffer, locator: SourceLocator, fingerprints: { sourceHash: string; criticalHeadersHash: string }): string {
  const derived=createHmac("sha256",key).update("mail-triage.read-identity-key.v1\0").digest();
  return createHmac("sha256",derived).update("mail-triage.read-identity.v1\0")
    .update(JSON.stringify([locator.mailboxId,locator.folder,locator.uidValidity,locator.uid,fingerprints.sourceHash,fingerprints.criticalHeadersHash])).digest("hex");
}

/** SAVEPOINT 可嵌入缓存事务；返回 thenable 一律回滚，SQL 从不跨 await。 */
export function sourceTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (work.constructor.name === "AsyncFunction") throw new Error("邮件事务回调必须同步 synchronous");
  const savepoint = `mail_source_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = work();
    if (result != null && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
      // 立即消费意外 Promise 的拒绝；绝不把它当作已提交结果。
      void Promise.resolve(result).catch(() => undefined);
      throw new Error("邮件事务回调必须同步 synchronous，不能返回 Promise/thenable");
    }
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) { db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
}

export const verifiedUidValidity = (value: string | undefined | null): value is string => Boolean(value?.trim()) && value !== "legacy" && !/[\0\r\n]/.test(value!);

function syncHook(result: unknown): void {
  if (result != null && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
    void Promise.resolve(result).catch(() => undefined); throw new Error("来源失效钩子必须同步 synchronous");
  }
}
function invalidateAlias(db: DatabaseSync, alias: { mailbox_id: number; folder: string; uid_validity: string; uid: number; source_id: string }, state: "stale" | "missing" | "explicit_delete", now: number, hooks: SourceRegistrationHooks = {}) {
  db.prepare("UPDATE mail_triage_source_aliases SET active=0 WHERE mailbox_id=? AND folder=? AND uid_validity=? AND uid=?")
    .run(alias.mailbox_id, alias.folder, alias.uid_validity, alias.uid);
  const remaining = Boolean(db.prepare(`SELECT 1 FROM mail_triage_source_aliases a
    JOIN mail_triage_sources s ON s.id=a.source_id AND s.mailbox_id=a.mailbox_id
    WHERE a.source_id=? AND a.mailbox_id=? AND a.active=1 LIMIT 1`).get(alias.source_id, alias.mailbox_id));
  if (!remaining) db.prepare("UPDATE mail_triage_sources SET source_version=source_version+1,state=?,missing_since=? WHERE id=?")
    .run(state === "explicit_delete" ? "deleted" : state, now, alias.source_id);
  db.prepare("UPDATE mail_triage_jobs SET state='stale_source',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE source_id=? AND state<>'cancelled'").run(now, alias.source_id);
  if (!remaining) db.prepare("UPDATE mail_triage_assessments SET stale=1,stale_at=? WHERE source_id=?").run(now, alias.source_id);
  if (!remaining && hooks.onSourceInvalidated) syncHook(hooks.onSourceInvalidated({ sourceId: alias.source_id, reason: state, now }));
  return !remaining;
}

/** 世代变化一旦证实即可撤销 fence，不等待一个可能失败的完整遍历。 */
export function invalidateFolderGeneration(db: DatabaseSync, input: { mailboxId: number; folder: string; uidValidity: string }, now: number, hooks: SourceRegistrationHooks = {}): void {
  sourceTransaction(db, () => {
    const old = db.prepare("SELECT * FROM mail_triage_source_aliases WHERE mailbox_id=? AND folder=? AND uid_validity<>? AND active=1")
      .all(input.mailboxId, input.folder, input.uidValidity) as unknown as Parameters<typeof invalidateAlias>[1][];
    for (const alias of old) invalidateAlias(db, alias, "stale", now, hooks);
  });
}

export function reconcileFolderSnapshot(db: DatabaseSync, input: { mailboxId: number; folder: string; uidValidity: string; presentUids: number[]; complete: boolean }, now: number, hooks: SourceRegistrationHooks = {}): void {
  if (!input.complete || !verifiedUidValidity(input.uidValidity)) return;
  sourceTransaction(db, () => {
    invalidateFolderGeneration(db, input, now, hooks);
    const present = new Set(input.presentUids);
    const aliases = db.prepare("SELECT * FROM mail_triage_source_aliases WHERE mailbox_id=? AND folder=? AND uid_validity=? AND active=1")
      .all(input.mailboxId, input.folder, input.uidValidity) as unknown as Parameters<typeof invalidateAlias>[1][];
    for (const alias of aliases) if (!present.has(alias.uid)) invalidateAlias(db, alias, "missing", now, hooks);
  });
}

/** 本地显式移入废纸篓的立即 fence 断点；完整敏感衍生项清理由 lifecycle 接管。 */
export function invalidateCachedLocator(db: DatabaseSync, locator: SourceLocator, now: number, hooks: SourceRegistrationHooks = {}, reason: "missing" | "explicit_delete" = "missing"): { sourceId: string; lastAlias: boolean } | null {
  return sourceTransaction(db, () => {
    const alias = db.prepare("SELECT * FROM mail_triage_source_aliases WHERE mailbox_id=? AND folder=? AND uid_validity=? AND uid=? AND active=1")
      .get(locator.mailboxId, locator.folder, locator.uidValidity, locator.uid) as unknown as Parameters<typeof invalidateAlias>[1] | undefined;
    return alias ? { sourceId: alias.source_id, lastAlias: invalidateAlias(db, alias, reason, now, hooks) } : null;
  });
}

interface RegistrationAuthorization {
  config_epoch: number; model_config_revision: number; state: string;
  provider_id: number | null; model_id: string | null; provider_revision: number | null; consent_provider_revision: number | null;
}
/** scope 水位决定本地可见登记；全局 initializing/模型配置不能抹掉新信待审义务。 */
function authorization(db: DatabaseSync, locator: SourceLocator, observedAt: number): RegistrationAuthorization | undefined {
  return db.prepare(`SELECT s.config_epoch,s.model_config_revision,s.state,r.provider_id,r.model_id,
      p.config_revision AS provider_revision,s.consent_provider_revision
    FROM mail_triage_settings s JOIN mail_triage_scope scope ON scope.mailbox_id=?
    JOIN mailboxes box ON box.id=scope.mailbox_id
    LEFT JOIN model_roles r ON r.role='mail_triage' LEFT JOIN model_providers p ON p.id=r.provider_id
    WHERE s.id=1 AND ((s.enabled=1 AND s.state<>'disabled') OR s.state='initializing')
      AND scope.state='authorized' AND scope.epoch=s.config_epoch AND scope.uid_validity=?
      AND ?>scope.baseline_uid AND scope.effective_at IS NOT NULL AND ?>=scope.effective_at
      AND NOT EXISTS(SELECT 1 FROM abandoned_domains abandoned WHERE abandoned.domain=box.domain COLLATE NOCASE)`)
    .get(locator.mailboxId, locator.uidValidity, locator.uid, observedAt) as unknown as RegistrationAuthorization | undefined;
}

/** 历史补审只放宽“UID 必须高于启用水位”；当前scope/世代/UIDVALIDITY/邮箱生命周期仍必须有效。 */
function historicalAuthorization(db: DatabaseSync, locator: SourceLocator): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM mail_triage_settings cfg
    JOIN mail_triage_scope scope ON scope.mailbox_id=? AND scope.epoch=cfg.config_epoch AND scope.state='authorized'
    JOIN mailboxes box ON box.id=scope.mailbox_id
    WHERE cfg.id=1 AND cfg.enabled=1 AND cfg.state='enabled' AND scope.uid_validity=? AND scope.effective_at IS NOT NULL
      AND box.status NOT IN ('deleting','closed','deleted')
      AND NOT EXISTS(SELECT 1 FROM abandoned_domains abandoned WHERE abandoned.domain=box.domain COLLATE NOCASE)`)
    .get(locator.mailboxId, locator.uidValidity));
}

function registerJob(db: DatabaseSync, input: { locator: SourceLocator; mail: ParsedSafeMessage; observedAt: number }, source: RegisteredSource, hooks: SourceRegistrationHooks) {
  if (input.locator.folder !== "INBOX") return;
  const allowed = authorization(db, input.locator, input.observedAt);
  if (!allowed) return;
  // 这是 durable outbox 的占位键，不是授权上下文 hash。Task7 在首次 reserve attempt 前原子绑定真正的上下文。
  const context = `pending-source:${source.sourceId}:${source.sourceVersion}`;
  const existing = db.prepare("SELECT id FROM mail_triage_jobs WHERE source_id=? AND source_version=? AND config_epoch=? LIMIT 1")
    .get(source.sourceId, source.sourceVersion, allowed.config_epoch);
  if (existing) return;
  let jobId: string | null = null;
  const modelReady = allowed.provider_id !== null && Boolean(allowed.model_id?.trim())
    && allowed.provider_revision !== null && allowed.consent_provider_revision === allowed.provider_revision;
  if (modelReady) {
    jobId = randomUUID();
    // initializing 已完成的 scope 可登记正常 outbox；Task3/7 仍须全局 enabled + state=enabled 才能出站。
    const state = !input.mail.bodyComplete ? "needs_review" : allowed.state === "paused_budget" ? "paused_budget"
      : allowed.state === "enabled" || allowed.state === "initializing" ? "queued" : "blocked_config";
    db.prepare(`INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,
        context_version,generation,config_epoch,state,priority,created_at,updated_at,last_error)
      VALUES(?,?,?,?,?,?,1,1,1,?,1,?,?,0,?,?,?)`).run(jobId, source.sourceId, source.sourceVersion, allowed.provider_id, allowed.model_id,
        allowed.model_config_revision, context, allowed.config_epoch, state, input.observedAt, input.observedAt, input.mail.bodyIssue);
  }
  if (hooks.onPendingSource) {
    if (hooks.onPendingSource.constructor.name === "AsyncFunction") throw new Error("来源登记钩子必须同步 synchronous");
    const result: unknown = hooks.onPendingSource({ ...source, ...input, jobId, configEpoch: allowed.config_epoch });
    if (result != null && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
      void Promise.resolve(result).catch(() => undefined); throw new Error("来源登记钩子必须同步 synchronous");
    }
  }
}

function registerSource(db: DatabaseSync, input: { locator: SourceLocator; mail: ParsedSafeMessage; observedAt: number }, key: Buffer, hooks: SourceRegistrationHooks, history: boolean): RegisteredSource {
  SourceLocatorSchema.parse(input.locator);
  if (!verifiedUidValidity(input.locator.uidValidity)) throw new Error("预审需要真实 UIDVALIDITY");
  if (history && (!input.mail.bodyComplete || !input.mail.text.trim())) throw new Error("历史补审只接受完整本地正文");
  return sourceTransaction(db, () => {
    const { locator, mail, observedAt } = input;
    if (history && !historicalAuthorization(db, locator)) throw new Error("历史补审范围已失效");
    invalidateFolderGeneration(db, locator, observedAt, hooks);
    const hash = fingerprintSource(key, mail);
    const previous = db.prepare(`SELECT s.id,s.source_hash,s.source_version,a.active FROM mail_triage_source_aliases a
      JOIN mail_triage_sources s ON s.id=a.source_id WHERE a.mailbox_id=? AND a.folder=? AND a.uid_validity=? AND a.uid=?`)
      .get(locator.mailboxId, locator.folder, locator.uidValidity, locator.uid) as { id: string; source_hash: string; source_version: number; active: number } | undefined;
    if (previous?.active && previous.source_hash === hash.sourceHash) {
      const result = { sourceId: previous.id, sourceVersion: previous.source_version, isNew: false };
      if (!history) registerJob(db, input, result, hooks); return result;
    }
    if (previous?.active) invalidateAlias(db, { mailbox_id: locator.mailboxId, folder: locator.folder, uid_validity: locator.uidValidity, uid: locator.uid, source_id: previous.id }, "stale", observedAt, hooks);
    const reusableCandidates = mail.bodyComplete ? db.prepare(`SELECT id,source_version,state FROM mail_triage_sources
      WHERE mailbox_id=? AND source_hash=? AND critical_headers_hash=? AND state IN ('active','stale','missing') ORDER BY id LIMIT 2`)
      .all(locator.mailboxId, hash.sourceHash, hash.criticalHeadersHash) as { id: string; source_version: number; state: string }[] : [];
    // 同一邮箱、完整正文指纹及关键头必须唯一；歧义时宁可建新 source，也不借副本恢复旧事实。
    const reusable = reusableCandidates.length === 1 ? reusableCandidates[0] : undefined;
    const result = { sourceId: reusable?.id ?? randomUUID(), sourceVersion: reusable?.source_version ?? 1, isNew: !reusable };
    if (!reusable) db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,observed_at) VALUES(?,?,?,?,?)")
      .run(result.sourceId, locator.mailboxId, hash.sourceHash, hash.criticalHeadersHash, observedAt);
    else if (reusable.state !== "active") db.prepare("UPDATE mail_triage_sources SET state='active',missing_since=NULL,observed_at=? WHERE id=?").run(observedAt, reusable.id);
    db.prepare(`INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id,active) VALUES(?,?,?,?,?,1)
      ON CONFLICT(mailbox_id,folder,uid_validity,uid) DO UPDATE SET source_id=excluded.source_id,active=1`)
      .run(locator.mailboxId, locator.folder, locator.uidValidity, locator.uid, result.sourceId);
    if (!history) registerJob(db, input, result, hooks); return result;
  });
}

export function registerCachedSource(db: DatabaseSync, input: { locator: SourceLocator; mail: ParsedSafeMessage; observedAt: number }, key: Buffer, hooks: SourceRegistrationHooks = {}): RegisteredSource {
  return registerSource(db, input, key, hooks, false);
}

/** 仅供Task9已确认历史preview在短事务中材料化；本函数不建job、不越过当前scope/lifecycle/完整正文检查。 */
export function registerHistoricalCachedSource(db: DatabaseSync, input: { locator: SourceLocator; mail: ParsedSafeMessage; observedAt: number }, key: Buffer, hooks: SourceRegistrationHooks = {}): RegisteredSource {
  return registerSource(db, input, key, hooks, true);
}

/** 同 Message-ID/关键头但正文冲突不得合并；仅给后续 projector 一个需人工复核的证据入口。 */
export function sourceConflicts(db: DatabaseSync, sourceId: string): string[] {
  return (db.prepare(`SELECT other.id FROM mail_triage_sources s JOIN mail_triage_sources other
    ON other.mailbox_id=s.mailbox_id AND other.critical_headers_hash=s.critical_headers_hash
    WHERE s.id=? AND other.id<>s.id AND other.source_hash<>s.source_hash AND other.state='active' ORDER BY other.id`).all(sourceId) as { id: string }[]).map((r) => r.id);
}

export function cachedParsedMessage(row: Record<string, unknown>): ParsedSafeMessage {
  return { messageId: row.message_id == null ? null : String(row.message_id), from: JSON.parse(String(row.from_json)),
    fromAddresses: JSON.parse(String(row.from_addresses_json)), to: JSON.parse(String(row.to_json)), cc: JSON.parse(String(row.cc_json)),
    subject: String(row.subject), date: Number(row.date ?? 0), text: String(row.body_text ?? ""), snippet: String(row.snippet),
    inReplyTo: row.in_reply_to == null ? null : String(row.in_reply_to), references: JSON.parse(String(row.references_json)), attachments: JSON.parse(String(row.attachments_json)),
    bodyComplete: row.body_complete === 1, bodyIssue: row.body_issue == null ? null : String(row.body_issue) };
}

/** 启动/每轮同步有界补登记；已验证正文或明确失败的新信均有待审义务，绝不推断旧 NULL 世代。 */
export function recoverCachedSources(db: DatabaseSync, key: Buffer, options: { limit?: number; hooks?: SourceRegistrationHooks; isMailboxAvailable?: (mailboxId: number) => boolean } = {}): number {
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 100)));
  const rows = db.prepare(`SELECT m.* FROM mail_messages m
    JOIN mail_triage_scope scope ON scope.mailbox_id=m.mailbox_id
    JOIN mail_triage_settings cfg ON cfg.id=1
    JOIN mailboxes box ON box.id=m.mailbox_id
    LEFT JOIN mail_triage_source_aliases a ON a.mailbox_id=m.mailbox_id AND a.folder=m.folder AND a.uid_validity=m.uid_validity AND a.uid=m.uid AND a.active=1
    LEFT JOIN mail_triage_sources s ON s.id=a.source_id AND s.state='active'
    WHERE ((cfg.enabled=1 AND cfg.state<>'disabled') OR cfg.state='initializing') AND scope.state='authorized' AND scope.epoch=cfg.config_epoch
      AND NOT EXISTS(SELECT 1 FROM abandoned_domains abandoned WHERE abandoned.domain=box.domain COLLATE NOCASE)
      AND m.folder='INBOX' AND m.uid_validity=scope.uid_validity AND m.uid>scope.baseline_uid
      AND scope.effective_at IS NOT NULL AND ((m.body_complete=1 AND length(trim(m.body_text))>0) OR m.body_issue IS NOT NULL)
      AND (s.id IS NULL OR NOT EXISTS(SELECT 1 FROM mail_triage_jobs j WHERE j.source_id=s.id AND j.source_version=s.source_version AND j.config_epoch=cfg.config_epoch))
    ORDER BY m.mailbox_id,m.uid LIMIT ?`).all(limit) as Record<string, unknown>[];
  let repaired = 0;
  for (const row of rows) {
    const locator = { mailboxId: Number(row.mailbox_id), folder: String(row.folder), uidValidity: String(row.uid_validity), uid: Number(row.uid) };
    if (options.isMailboxAvailable && options.isMailboxAvailable(locator.mailboxId) !== true) continue;
    if (!verifiedUidValidity(locator.uidValidity) || !authorization(db, locator, Date.now())) continue;
    registerCachedSource(db, { locator, mail: cachedParsedMessage(row), observedAt: Date.now() }, key, options.hooks); repaired++;
  }
  return repaired;
}
