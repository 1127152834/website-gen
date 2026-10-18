/** 邮件预审来源生命周期：同步、短事务、无网络。删除只保留去身份 attempt 用量账。 */
import type { DatabaseSync } from "node:sqlite";
import { reprojectCases } from "./mail-case-projector.ts";
import { sourceTransaction } from "./mail-triage-source.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
type SourceInvalidationReason = "stale" | "missing" | "explicit_delete";
type ScopeInvalidationReason = "disable" | "scope_removed" | "mailbox_delete" | "abandon";
type Row = Record<string, unknown>;

const decode = (value: unknown): unknown => { try { return JSON.parse(String(value)); } catch { return undefined; } };
const objectValue = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const provenanceValue = (value: unknown): Row | null => objectValue(typeof value === "string" ? decode(value) : value);
const supportIds = (value: unknown): string[] => {
  const provenance = provenanceValue(value);
  return provenance && Array.isArray(provenance.supportSourceIds) && provenance.supportSourceIds.every((id) => typeof id === "string")
    ? [...new Set(provenance.supportSourceIds as string[])] : [];
};
const validIndependent = (value: unknown): boolean => {
  const provenance = provenanceValue(value);
  return Boolean(provenance && provenance.kind === "independent_manual"
    && Array.isArray(provenance.supportSourceIds) && provenance.supportSourceIds.length === 0
    && typeof provenance.verifiedAt === "number" && Number.isFinite(provenance.verifiedAt) && provenance.verifiedAt > 0
    && typeof provenance.reason === "string" && provenance.reason.trim());
};
const validDerived = (value: unknown): boolean => {
  const provenance = provenanceValue(value);
  return Boolean(provenance && provenance.kind === "source_derived" && Array.isArray(provenance.supportSourceIds)
    && provenance.supportSourceIds.length > 0 && provenance.supportSourceIds.every((id) => typeof id === "string"));
};
const strictTaskDerived = (value: unknown): boolean => {
  const provenance = provenanceValue(value);
  if (!provenance || Object.keys(provenance).sort().join(",") !== "kind,reason,supportSourceIds,verifiedAt") return false;
  if (provenance.kind !== "source_derived" || provenance.verifiedAt !== null || provenance.reason !== null
    || !Array.isArray(provenance.supportSourceIds) || !provenance.supportSourceIds.length
    || !provenance.supportSourceIds.every((id) => typeof id === "string")) return false;
  const ids = provenance.supportSourceIds as string[];
  return JSON.stringify(ids) === JSON.stringify([...new Set(ids)].sort());
};
const references = (value: unknown, needle: string): boolean => {
  if (value === needle) return true;
  if (Array.isArray(value)) return value.some((item) => references(item, needle));
  return value !== null && typeof value === "object" && Object.values(value as Row).some((item) => references(item, needle));
};
const provenanceReferences = (value: unknown, sourceId: string): boolean => {
  return supportIds(value).includes(sourceId);
};

function evidenceValue(raw: unknown): { sourceId: string; quote: string }[] | null {
  const value = typeof raw === "string" ? decode(raw) : raw;
  return Array.isArray(value) && value.every((item) => {
    const row = objectValue(item); return row && typeof row.sourceId === "string" && typeof row.quote === "string";
  }) ? value as { sourceId: string; quote: string }[] : null;
}

function activeDerived(raw: unknown, active: Set<string>): string[] | null {
  const ids = supportIds(raw);
  return validDerived(raw) && ids.every((id) => active.has(id)) ? ids : null;
}

const eventSourceVersion = (slot: unknown): number | null => /^\d+:/.test(String(slot)) ? Number(String(slot).split(":")[0]) : null;

function cancelJobsForCases(db: DatabaseSync, caseIds: string[], now: number): void {
  if (!caseIds.length) return;
  for (const row of db.prepare("SELECT id,manual_versions_json FROM mail_triage_jobs WHERE manual_versions_json IS NOT NULL").all()) {
    const decoded = decode(row.manual_versions_json);
    const vector = Array.isArray(decoded) ? decoded : decoded && typeof decoded === "object" && (decoded as { v?: unknown }).v === 2 && Array.isArray((decoded as { cases?: unknown }).cases) ? (decoded as { cases: unknown[] }).cases : [];
    if (!vector.some((entry) => Array.isArray(entry) && caseIds.includes(String(entry[0])))) continue;
    const cleared = Array.isArray(decoded) ? [] : { v: 2, cases: [], sources: [] };
    db.prepare(`UPDATE mail_triage_jobs SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=0,
      manual_versions_json=?,updated_at=?,last_error='context_source_invalidated' WHERE id=?`).run(JSON.stringify(cleared), now, row.id);
  }
}

function cancelJobsForContextSource(db: DatabaseSync, sourceId: string, now: number): void {
  for (const row of db.prepare("SELECT id,manual_versions_json FROM mail_triage_jobs WHERE manual_versions_json IS NOT NULL").all()) {
    const decoded = decode(row.manual_versions_json);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || (decoded as { v?: unknown }).v !== 2) continue;
    const sources = Array.isArray((decoded as { sources?: unknown }).sources) ? (decoded as { sources: unknown[] }).sources : [];
    if (!sources.some((entry) => Array.isArray(entry) && String(entry[0]) === sourceId)) continue;
    db.prepare(`UPDATE mail_triage_jobs SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=0,
      manual_versions_json='{"v":2,"cases":[],"sources":[]}',updated_at=?,last_error='context_source_invalidated' WHERE id=?`).run(now, row.id);
  }
}

function affectedCases(db: DatabaseSync, sourceId: string): string[] {
  const ids = new Set<string>();
  for (const row of db.prepare("SELECT case_id FROM mail_case_sources WHERE source_id=? UNION SELECT case_id FROM mail_case_events WHERE source_id=?").all(sourceId, sourceId)) ids.add(String(row.case_id));
  for (const row of db.prepare("SELECT id,identity_provenance_json,projection_json FROM mail_application_cases").all()) {
    if (references(decode(row.identity_provenance_json), sourceId) || references(decode(row.projection_json), sourceId)) ids.add(String(row.id));
  }
  for (const [table, columns] of [
    ["mail_case_events", ["evidence_json", "provenance_json"]],
    ["mail_case_tasks", ["requested_items_json", "provenance_json"]],
    ["mail_case_manual_decisions", ["before_json", "after_json", "provenance_json"]],
  ] as const) {
    for (const row of db.prepare(`SELECT case_id,${columns.join(",")} FROM ${table}`).all()) {
      if (columns.some((column) => references(decode(row[column]), sourceId))) ids.add(String(row.case_id));
    }
  }
  return [...ids].sort();
}

function cancelSourceJobs(db: DatabaseSync, sourceId: string, now: number): void {
  db.prepare(`UPDATE mail_triage_jobs SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,
      next_attempt_at=0,updated_at=?,last_error='source_invalidated'
    WHERE source_id=? AND state<>'cancelled'`).run(now, sourceId);
}

function deleteEmptyUnsupportedCases(db: DatabaseSync, caseIds: string[]): string[] {
  const remaining: string[] = [];
  for (const caseId of caseIds) {
    const row = db.prepare("SELECT identity_provenance_json FROM mail_application_cases WHERE id=?").get(caseId);
    if (!row) continue;
    const identity = decode(row.identity_provenance_json);
    const hasFacts = Boolean(db.prepare(`SELECT 1 FROM mail_case_events WHERE case_id=? UNION ALL
      SELECT 1 FROM mail_case_tasks WHERE case_id=? UNION ALL SELECT 1 FROM mail_case_manual_decisions WHERE case_id=? LIMIT 1`).get(caseId, caseId, caseId));
    if (!hasFacts && !validIndependent(identity)) db.prepare("DELETE FROM mail_application_cases WHERE id=?").run(caseId);
    else remaining.push(caseId);
  }
  return remaining;
}

function clearSensitiveDerivatives(db: DatabaseSync, sourceId: string, now: number): void {
  const caseIds = affectedCases(db, sourceId);
  cancelJobsForContextSource(db, sourceId, now);
  cancelJobsForCases(db, caseIds, now);
  const affectedAssessments = (db.prepare("SELECT id,job_id,source_id,support_source_ids_json,validated_json FROM mail_triage_assessments ORDER BY id").all() as Row[])
    .filter((row) => row.source_id === sourceId || references(decode(row.support_source_ids_json), sourceId) || references(decode(row.validated_json), sourceId));
  const jobIds = [...new Set([
    ...(db.prepare("SELECT id FROM mail_triage_jobs WHERE source_id=?").all(sourceId) as Row[]).map((row) => String(row.id)),
    ...affectedAssessments.map((row) => String(row.job_id)),
  ])];
  const assessmentIds = affectedAssessments.map((row) => String(row.id));
  const removedIds = new Set<string>([sourceId, ...jobIds, ...assessmentIds]);
  const priorTaskIds = caseIds.flatMap((caseId) => (db.prepare("SELECT id FROM mail_case_tasks WHERE case_id=?").all(caseId) as Row[]).map((row) => String(row.id)));
  const removedEventIds = new Set<string>();
  const active = new Set((db.prepare("SELECT id FROM mail_triage_sources WHERE id<>? AND state='active'").all(sourceId) as Row[]).map((row) => String(row.id)));

  // 先去身份化 attempt，再删 job；ON DELETE SET NULL 保留单调用量账且不留 case/source 向量。
  for (const jobId of jobIds) db.prepare("UPDATE mail_triage_attempts SET job_id=NULL WHERE job_id=?").run(jobId);
  for (const jobId of jobIds) db.prepare("DELETE FROM mail_triage_jobs WHERE id=?").run(jobId);
  for (const assessment of affectedAssessments) db.prepare("DELETE FROM mail_triage_assessments WHERE id=?").run(String(assessment.id));

  for (const row of db.prepare("SELECT id,case_id,source_id,evidence_json,provenance_json FROM mail_case_events ORDER BY id").all()) {
    const evidence = evidenceValue(row.evidence_json);
    const touched = row.source_id === sourceId || references(evidence, sourceId) || provenanceReferences(row.provenance_json, sourceId)
      || (caseIds.includes(String(row.case_id)) && (evidence === null || (!validDerived(row.provenance_json) && !validIndependent(row.provenance_json))));
    if (!touched) continue;
    if (validIndependent(row.provenance_json)) {
      db.prepare("UPDATE mail_case_events SET source_id=NULL,evidence_json='[]' WHERE id=?").run(row.id); continue;
    }
    // 当前Task6 producer不会生成混合支持事件；生命周期不能把剩余quote误当作对原kind的语义证明。
    removedEventIds.add(String(row.id)); db.prepare("DELETE FROM mail_case_events WHERE id=?").run(row.id);
  }
  for (const id of removedEventIds) removedIds.add(id);
  for (const row of db.prepare("SELECT id,case_id,event_id,kind,state,object,title,requested_items_json,deadline_raw,deadline_at,provenance_json FROM mail_case_tasks ORDER BY id").all()) {
    const event = db.prepare("SELECT source_id,event_slot,provenance_json FROM mail_case_events WHERE id=? AND case_id=?").get(row.event_id, row.case_id);
    const requested = decode(row.requested_items_json);
    const touched = provenanceReferences(row.provenance_json, sourceId) || references(requested, sourceId)
      || (caseIds.includes(String(row.case_id)) && (!Array.isArray(requested) || (!validDerived(row.provenance_json) && !validIndependent(row.provenance_json))));
    if (!touched && validDerived(row.provenance_json)) continue;
    if (touched && validIndependent(row.provenance_json)) {
      removedIds.add(String(row.id)); db.prepare("DELETE FROM mail_case_tasks WHERE id=?").run(row.id); continue;
    }
    const origin = event?.source_id == null ? null : String(event.source_id);
    const eventSupport = event ? activeDerived(event.provenance_json, active) : null;
    const source = origin ? db.prepare("SELECT source_version FROM mail_triage_sources WHERE id=? AND state='active'").get(origin) : undefined;
    const taskSupport = supportIds(row.provenance_json);
    const taskShape = Array.isArray(requested) && requested.every((item) => typeof item === "string")
      && row.object === JSON.stringify((requested as string[]).map((item) => item.normalize("NFC").trim().toLowerCase()).sort())
      && typeof row.title === "string" && row.title.length > 0;
    const manuallyRewritten = Boolean(db.prepare("SELECT 1 FROM mail_case_manual_decisions d WHERE d.case_id=? AND d.object_id=? AND d.undo_of IS NULL AND NOT EXISTS(SELECT 1 FROM mail_case_manual_decisions u WHERE u.undo_of=d.id) LIMIT 1").get(row.case_id, row.id));
    const sent = (db.prepare("SELECT smtp_status,binding_json FROM mail_triage_send_receipts").all() as Row[])
      .some((receipt) => {
        if (receipt.smtp_status !== "smtp_accepted") return false;
        const binding = decode(receipt.binding_json);
        if (!binding || typeof binding !== "object" || (binding as { v?: unknown }).v !== 1 || !Array.isArray((binding as { tasks?: unknown }).tasks)) return true;
        const tasks = (binding as { tasks: unknown[] }).tasks;
        if (!tasks.every((task) => task && typeof task === "object" && typeof (task as { id?: unknown }).id === "string")) return true;
        return tasks.some((task) => (task as { id: string }).id === String(row.id));
      });
    const canRestoreOriginalRequest = row.state === "resolved_by_evidence" && row.kind !== "review" && origin !== null
      && strictTaskDerived(row.provenance_json) && eventSupport?.length === 1 && eventSupport[0] === origin && taskSupport.length === 2
      && taskSupport.includes(origin) && taskSupport.includes(sourceId)
      && source && eventSourceVersion(event!.event_slot) === Number(source.source_version) && taskShape && !manuallyRewritten && !sent;
    if (canRestoreOriginalRequest) db.prepare("UPDATE mail_case_tasks SET state='open',version=version+1,provenance_json=? WHERE id=?")
      .run(event!.provenance_json, row.id);
    else { removedIds.add(String(row.id)); db.prepare("DELETE FROM mail_case_tasks WHERE id=?").run(row.id); }
  }
  for (const row of db.prepare("SELECT id,case_id,provenance_json,before_json,after_json FROM mail_case_manual_decisions ORDER BY id").all()) {
    const before = decode(row.before_json), after = decode(row.after_json);
    const touched = provenanceReferences(row.provenance_json, sourceId) || references(before, sourceId) || references(after, sourceId)
      || (caseIds.includes(String(row.case_id)) && (!validDerived(row.provenance_json) && !validIndependent(row.provenance_json)));
    if (!touched && (validIndependent(row.provenance_json) || validDerived(row.provenance_json))) continue;
    if (touched && validIndependent(row.provenance_json)) {
      removedIds.add(String(row.id)); db.prepare("DELETE FROM mail_case_manual_decisions WHERE id=?").run(row.id); continue;
    }
    // strict Provenance没有逐字段snapshot producer；任一侧触及B或混合支持都不能局部继承。
    removedIds.add(String(row.id)); db.prepare("DELETE FROM mail_case_manual_decisions WHERE id=?").run(row.id);
  }
  for (const row of db.prepare("SELECT id,site_id,provider,application_identity,identity_provenance_json FROM mail_application_cases ORDER BY id").all()) {
    if (!caseIds.includes(String(row.id))) continue;
    const untouchedIndependent = validIndependent(row.identity_provenance_json) && !references(decode(row.identity_provenance_json), sourceId);
    const untouchedDerived = !provenanceReferences(row.identity_provenance_json, sourceId) && activeDerived(row.identity_provenance_json, active);
    if (untouchedIndependent || untouchedDerived) continue;
    db.prepare(`UPDATE mail_application_cases SET identity_state='unconfirmed_case',site_id=NULL,provider=NULL,application_identity=NULL,
      identity_provenance_json='{"supportSourceIds":[],"kind":"source_derived","verifiedAt":null,"reason":null}',projection_json='{}',updated_at=? WHERE id=?`).run(now, row.id);
  }
  db.prepare("DELETE FROM mail_case_sources WHERE source_id=?").run(sourceId);
  for (const id of priorTaskIds) if (!db.prepare("SELECT 1 FROM mail_case_tasks WHERE id=?").get(id)) removedIds.add(id);
  for (const row of db.prepare("SELECT id,reply_source_id,selected_task_ids_json,binding_json FROM mail_triage_send_receipts").all()) {
    const decoded = decode(row.selected_task_ids_json); const malformed = !Array.isArray(decoded); const selected = Array.isArray(decoded) ? decoded : [];
    const next = selected.filter((id) => !removedIds.has(String(id)) && db.prepare("SELECT 1 FROM mail_case_tasks WHERE id=?").get(String(id)));
    const binding = decode(row.binding_json);
    const scrubBinding = references(binding, sourceId) || [...removedIds].some((id) => references(binding, id));
    if (row.reply_source_id === sourceId) db.prepare("UPDATE mail_triage_send_receipts SET reply_source_id=NULL,message_id=NULL,selected_task_ids_json=?,binding_json=NULL WHERE id=?").run(JSON.stringify(next), row.id);
    else if (malformed || next.length !== selected.length || scrubBinding) db.prepare("UPDATE mail_triage_send_receipts SET selected_task_ids_json=?,binding_json=CASE WHEN ? THEN NULL ELSE binding_json END WHERE id=?").run(JSON.stringify(next), scrubBinding ? 1 : 0, row.id);
  }
  for (const row of db.prepare("SELECT request_id,operation,result_ref_json FROM mail_triage_requests WHERE result_ref_json IS NOT NULL").all()) {
    const value = decode(row.result_ref_json);
    if ([...removedIds].some((id) => references(value, id))) db.prepare("UPDATE mail_triage_requests SET result_ref_json=NULL WHERE request_id=? AND operation=?").run(row.request_id, row.operation);
  }
  db.prepare("UPDATE mail_triage_source_aliases SET active=0 WHERE source_id=?").run(sourceId);
  db.prepare("UPDATE mail_triage_sources SET state='deleted',missing_since=COALESCE(missing_since,?) WHERE id=?").run(now, sourceId);

  const remaining = deleteEmptyUnsupportedCases(db, caseIds);
  const removedCaseIds = caseIds.filter((caseId) => !remaining.includes(caseId));
  for (const id of removedCaseIds) removedIds.add(id);
  if (removedCaseIds.length) for (const row of db.prepare("SELECT request_id,operation,result_ref_json FROM mail_triage_requests WHERE result_ref_json IS NOT NULL").all()) {
    const value = decode(row.result_ref_json);
    if (removedCaseIds.some((id) => references(value, id))) db.prepare("UPDATE mail_triage_requests SET result_ref_json=NULL WHERE request_id=? AND operation=?").run(row.request_id, row.operation);
  }
  if (removedCaseIds.length) for (const row of db.prepare("SELECT id,manual_versions_json FROM mail_triage_jobs WHERE manual_versions_json IS NOT NULL").all()) {
    const decoded = decode(row.manual_versions_json);
    if (Array.isArray(decoded)) {
      const next = decoded.filter((entry) => !Array.isArray(entry) || !removedCaseIds.includes(String(entry[0])));
      if (next.length !== decoded.length) db.prepare("UPDATE mail_triage_jobs SET manual_versions_json=? WHERE id=?").run(JSON.stringify(next), row.id);
    } else if (decoded && typeof decoded === "object" && (decoded as { v?: unknown }).v === 2) {
      const value = decoded as { v: 2; cases?: unknown; sources?: unknown }, cases = Array.isArray(value.cases) ? value.cases : [];
      const next = cases.filter((entry) => !Array.isArray(entry) || !removedCaseIds.includes(String(entry[0])));
      if (next.length !== cases.length) db.prepare("UPDATE mail_triage_jobs SET manual_versions_json=? WHERE id=?").run(JSON.stringify({ v: 2, cases: next, sources: Array.isArray(value.sources) ? value.sources : [] }), row.id);
    }
  }
  if (remaining.length) reprojectCases(db, { caseIds: remaining, now });
}

function invalidateSourceInTransaction(db: DatabaseSync, sourceId: string, reason: SourceInvalidationReason, now: number): void {
  const row = db.prepare("SELECT state FROM mail_triage_sources WHERE id=?").get(sourceId) as { state: string } | undefined;
  if (!row) return;
  cancelSourceJobs(db, sourceId, now);
  if (reason === "explicit_delete") {
    clearSensitiveDerivatives(db, sourceId, now);
    return;
  }
  if (row.state === "active") db.prepare("UPDATE mail_triage_sources SET state=?,source_version=source_version+1,missing_since=? WHERE id=?").run(reason, now, sourceId);
  else db.prepare("UPDATE mail_triage_sources SET state=CASE WHEN state='deleted' THEN state ELSE ? END,missing_since=COALESCE(missing_since,?) WHERE id=?").run(reason, now, sourceId);
  db.prepare("UPDATE mail_triage_source_aliases SET active=0 WHERE source_id=?").run(sourceId);
  db.prepare("UPDATE mail_triage_assessments SET stale=1,stale_at=COALESCE(stale_at,?) WHERE source_id=?").run(now, sourceId);
  const cases = affectedCases(db, sourceId);
  cancelJobsForCases(db, cases, now);
  if (cases.length) reprojectCases(db, { caseIds: cases, now });
}

export function invalidateTriageScope(
  db: DatabaseSync,
  input: { mailboxIds: number[]; reason: ScopeInvalidationReason },
  now: number,
): { abortSourceIds: string[] } {
  return sourceTransaction(db, () => {
    const requested = input.reason === "disable"
      ? (db.prepare("SELECT mailbox_id FROM mail_triage_scope WHERE state='authorized'").all() as Row[]).map((row) => Number(row.mailbox_id))
      : input.mailboxIds;
    const mailboxIds = [...new Set(requested.filter(Number.isSafeInteger))].sort((a, b) => a - b);
    if (input.reason === "disable") db.prepare("UPDATE mail_triage_settings SET enabled=0,state='disabled',config_epoch=config_epoch+1,version=version+1 WHERE id=1").run();
    const ids: string[] = [];
    for (const mailboxId of mailboxIds) {
      db.prepare("UPDATE mail_triage_scope SET state='revoked',epoch=epoch+1,scope_version=scope_version+1 WHERE mailbox_id=?").run(mailboxId);
      for (const row of db.prepare("SELECT id FROM mail_triage_sources WHERE mailbox_id=? AND state<>'deleted' ORDER BY id").all(mailboxId)) {
        const sourceId = String(row.id); ids.push(sourceId); invalidateSourceInTransaction(db, sourceId, "stale", now);
      }
    }
    return { abortSourceIds: [...new Set(ids)].sort() };
  });
}

export function invalidateSource(db: DatabaseSync, sourceId: string, reason: SourceInvalidationReason, now: number): void {
  sourceTransaction(db, () => invalidateSourceInTransaction(db, sourceId, reason, now));
}

export function purgeExpiredSources(db: DatabaseSync, now: number): number {
  return sourceTransaction(db, () => {
    const ids = (db.prepare(`SELECT id FROM mail_triage_sources WHERE state IN ('stale','missing') AND missing_since IS NOT NULL AND missing_since<=? ORDER BY id`)
      .all(now - RETENTION_MS) as Row[]).map((row) => String(row.id));
    for (const id of ids) invalidateSourceInTransaction(db, id, "explicit_delete", now);
    return ids.length;
  });
}

export function rebuildSupportedCase(db: DatabaseSync, caseId: string): void {
  sourceTransaction(db, () => {
    if (!db.prepare("SELECT 1 FROM mail_application_cases WHERE id=?").get(caseId)) return;
    reprojectCases(db, { caseIds: [caseId], now: Date.now() });
  });
}
