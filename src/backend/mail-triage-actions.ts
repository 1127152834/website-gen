/** 人工纠正、归组、独立核验与补偿撤销。所有写入均为同步单事务。 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { APPLICATION_DECISIONS, APPLICATION_STAGES, MAIL_CATEGORIES, OBLIGATION_STATES, SOURCE_TRUST, type Provenance } from "../shared/mail-triage-types.ts";
import { MutationMetaSchema, PersistedProjectedCaseSchema, ProvenanceSchema } from "./mail-triage-schema.ts";
import { reprojectCases } from "./mail-case-projector.ts";
import type { ServerActor } from "./mail-triage-service.ts";

type Row = Record<string, unknown>;
const uuid = z.uuid();
const reasonText = z.string().trim().min(1).max(2000);
const tag = z.string().refine(value => Array.from(value).length >= 2 && Array.from(value).length <= 6 && /^\p{Script=Han}+$/u.test(value), "标签须为2–6个汉字");
const sourceTarget = z.object({ type: z.literal("source"), id: uuid, sourceVersion: z.number().int().positive() }).strict();
const taskTarget = z.object({ type: z.literal("task"), id: uuid }).strict();
const caseTarget = z.object({ type: z.literal("case"), id: uuid }).strict();
const deadlineValue = z.object({ deadlineRaw: z.string().trim().min(1).max(500).nullable(), deadlineAt: z.number().int().nonnegative().nullable() }).strict();
const identity = z.object({ provider: z.string().trim().min(1).max(200), siteId: z.number().int().positive().nullable(), applicationId: z.string().trim().min(1).max(200) }).strict();
const metaShape = MutationMetaSchema.shape;

const correctSchema = z.union([
  z.object({ kind: z.literal("correct"), target: sourceTarget, field: z.literal("tag"), value: tag, ...metaShape }).strict(),
  z.object({ kind: z.literal("correct"), target: sourceTarget, field: z.literal("category"), value: z.enum(MAIL_CATEGORIES), ...metaShape }).strict(),
  z.object({ kind: z.literal("correct"), target: sourceTarget, field: z.literal("sourceTrust"), value: z.enum(SOURCE_TRUST), ...metaShape }).strict(),
  z.object({ kind: z.literal("correct"), target: taskTarget, field: z.literal("title"), value: z.string().trim().min(1).max(200), ...metaShape }).strict(),
  z.object({ kind: z.literal("correct"), target: taskTarget, field: z.literal("requestedItems"), value: z.array(z.string().trim().min(1).max(500)).max(16), ...metaShape }).strict(),
  z.object({ kind: z.literal("correct"), target: taskTarget, field: z.literal("state"), value: z.enum(OBLIGATION_STATES), ...metaShape }).strict(),
  z.object({ kind: z.literal("correct"), target: taskTarget, field: z.union([z.literal("deadline"), z.literal("deadlineRaw")]), value: deadlineValue, ...metaShape }).strict(),
  z.object({ kind: z.literal("correct"), target: taskTarget, field: z.literal("snoozedUntil"), value: z.number().int().positive().nullable(), ...metaShape }).strict(),
  z.object({ kind: z.literal("correct"), target: caseTarget, field: z.literal("decisionExplanation"), value: z.string().trim().min(1).max(1000).nullable(), ...metaShape }).strict(),
]);
const factSchema = z.union([
  z.object({ type: z.literal("decision"), value: z.enum(APPLICATION_DECISIONS) }).strict(),
  z.object({ type: z.literal("stage"), value: z.enum(APPLICATION_STAGES) }).strict(),
]);
export const ManualMutationSchema = z.union([
  correctSchema,
  z.object({ kind: z.literal("link"), sourceIds: z.array(uuid).min(1).max(32), caseId: uuid, ...metaShape }).strict(),
  z.object({ kind: z.literal("split"), caseId: uuid, eventIds: z.array(uuid).min(1).max(64), newIdentity: identity, ...metaShape }).strict(),
  z.object({ kind: z.literal("confirm_case"), caseId: uuid, identity, ...metaShape }).strict(),
  z.object({ kind: z.literal("independent_fact"), caseId: uuid, fact: factSchema, verifiedAt: z.number().int().positive(), ...metaShape }).strict(),
  z.object({ kind: z.literal("appeal_requested"), caseId: uuid, ...metaShape }).strict(),
]);
export type ManualMutation = z.infer<typeof ManualMutationSchema>;
export const UndoManualDecisionSchema = MutationMetaSchema.extend({ decisionId: uuid }).strict();

export interface ManualMutationResult {
  decisionId: string;
  version: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  affectedTaskIds: string[];
  sourcesToVerify: string[];
  affectedSourceIds: string[];
  projectionBefore: Record<string, unknown>[];
  projectionAfter: Record<string, unknown>[];
}

const safeDiffValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string().max(2000), z.number().finite(), z.boolean(), z.null(),
  z.array(safeDiffValue).max(256),
  z.record(z.string().max(100), safeDiffValue),
]));
const safeDiff = z.record(z.string().max(100), safeDiffValue);
const safeProjection = z.object({
  caseId: uuid, deleted: z.literal(true).optional(), version: z.number().int().nonnegative().optional(),
  manualVersion: z.number().int().nonnegative().optional(), identityState: z.enum(["unconfirmed_case", "confirmed"]).optional(),
  provider: z.string().max(200).nullable().optional(), siteId: z.number().int().positive().nullable().optional(),
  applicationId: z.string().max(200).nullable().optional(), column: z.enum(["needs_you", "awaiting_platform", "results"]).nullable().optional(),
  stage: z.enum(APPLICATION_STAGES).optional(), decision: z.enum(APPLICATION_DECISIONS).optional(), decisionCycle: z.number().int().positive().optional(),
}).strict();
export const ManualMutationResultSchema: z.ZodType<ManualMutationResult> = z.object({
  decisionId: uuid, version: z.number().int().nonnegative(), before: safeDiff, after: safeDiff,
  affectedTaskIds: z.array(uuid).max(1024), sourcesToVerify: z.array(uuid).max(64), affectedSourceIds: z.array(uuid).max(64),
  projectionBefore: z.array(safeProjection).max(128), projectionAfter: z.array(safeProjection).max(128),
}).strict();
const UndoResultSchema = z.object({ version: z.number().int().nonnegative(), affectedSourceIds: z.array(uuid).max(64) }).strict();
const storedIdentity = z.object({ provider: z.string().max(200).nullable(), siteId: z.number().int().positive().nullable(), applicationId: z.string().max(200).nullable() }).strict();
const fenceCaseRow = z.object({ id: uuid, identity_state: z.enum(["unconfirmed_case", "confirmed"]), provider: z.string().nullable(), site_id: z.number().int().positive().nullable(), application_identity: z.string().nullable(), identity_provenance_json: z.string(), version: z.number().int().positive(), manual_version: z.number().int().nonnegative(), projection_json: z.string() }).strict();
const fenceSourceRow = z.object({ source_id: uuid, match_basis: z.string(), manual_locked: z.union([z.literal(0), z.literal(1)]), source_version: z.number().int().positive() }).strict();
const fenceEventRow = z.object({ id: z.string().min(1), case_id: uuid, source_id: uuid.nullable(), event_slot: z.string(), kind: z.string(), decision_cycle: z.number().int().positive(), claimed_at: z.number().int().nullable(), observed_at: z.number().int(), evidence_json: z.string(), provenance_json: z.string() }).strict();
const fenceTaskRow = z.object({ id: z.string().min(1), case_id: uuid, event_id: z.string().min(1), obligation_key: z.string(), kind: z.enum(["reply", "action", "review"]), object: z.string(), state: z.enum(OBLIGATION_STATES), title: z.string(), requested_items_json: z.string(), deadline_raw: z.string().nullable(), deadline_at: z.number().int().nullable(), version: z.number().int().positive(), provenance_json: z.string() }).strict();
const caseFenceSchema = z.array(z.object({ case: fenceCaseRow, sources: z.array(fenceSourceRow).max(1024), events: z.array(fenceEventRow).max(10_000), tasks: z.array(fenceTaskRow).max(10_000) }).strict()).min(1).max(128);
type CaseFence = z.infer<typeof caseFenceSchema>;
const linkBeforeSchema = z.object({ caseId: uuid, associations: z.array(z.object({ sourceId: uuid, matchBasis: z.string(), manualLocked: z.union([z.literal(0), z.literal(1)]) }).strict()).max(32), fence: caseFenceSchema }).strict();
const linkAfterSchema = z.object({ caseId: uuid, sourceIds: z.array(uuid).min(1).max(32), fence: caseFenceSchema }).strict();
const identityBeforeSchema = z.object({ caseId: uuid, identityState: z.enum(["unconfirmed_case", "confirmed"]), identity: storedIdentity, identityProvenance: ProvenanceSchema, fence: caseFenceSchema }).strict();
const identityAfterSchema = z.object({ caseId: uuid, identityState: z.literal("confirmed"), identity, identityProvenance: ProvenanceSchema, fence: caseFenceSchema }).strict();
const splitBeforeSchema = z.object({ caseId: uuid, eventIds: z.array(uuid).min(1).max(64), fence: caseFenceSchema }).strict();
const operationFactIds = { operationEventIds: z.array(z.string().min(1)).max(10_000), operationTaskIds: z.array(z.string().min(1)).max(10_000) };
const splitAfterSchema = z.object({ caseId: uuid, eventIds: z.array(uuid).min(1).max(64), identity, ...operationFactIds, fence: caseFenceSchema }).strict();
const appealBeforeSchema = z.object({ caseId: uuid, decisionCycle: z.number().int().positive(), fence: caseFenceSchema }).strict();
const appealAfterSchema = z.object({ caseId: uuid, decisionCycle: z.number().int().positive(), eventId: uuid, status: z.literal("appeal_requested"), ...operationFactIds, fence: caseFenceSchema }).strict();
const sourceAuditBase = { sourceId: uuid, sourceVersion: z.number().int().positive() };
const sourceAuditSchemas = {
  tag: z.object({ ...sourceAuditBase, tag: tag.nullable() }).strict(),
  category: z.object({ ...sourceAuditBase, category: z.enum(MAIL_CATEGORIES).nullable() }).strict(),
  sourceTrust: z.object({ ...sourceAuditBase, sourceTrust: z.enum(SOURCE_TRUST) }).strict(),
} as const;

const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const canonicalValue = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalValue) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => [key, canonicalValue(item)])) : value;
const digest = (value: unknown) => createHash("sha256").update(json(canonicalValue(value))).digest("hex");
const unique = (values: string[]) => [...new Set(values)].sort();
const independent = (verifiedAt: number, reason: string): Provenance => ({ supportSourceIds: [], kind: "independent_manual", verifiedAt, reason });
const derived = (sourceIds: string[]): Provenance => ({ supportSourceIds: unique(sourceIds), kind: "source_derived", verifiedAt: null, reason: null });
const atomic = <T>(db: DatabaseSync, run: () => T): T => {
  if (db.isTransaction) return run();
  db.exec("BEGIN IMMEDIATE");
  try { const result = run(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
};
function actorId(actor: ServerActor): string {
  if (!actor || !Number.isSafeInteger(actor.userId) || actor.userId <= 0) throw new Error("人工写操作缺少经过验证的服务端操作者");
  return `user:${actor.userId}`;
}
function activeSource(db: DatabaseSync, sourceId: string): Row | undefined {
  return db.prepare(`SELECT s.* FROM mail_triage_sources s
    JOIN mail_triage_scope scope ON scope.mailbox_id=s.mailbox_id
    JOIN mail_triage_settings settings ON settings.id=1 AND settings.enabled=1 AND settings.state<>'disabled' AND settings.config_epoch=scope.epoch
    JOIN mailboxes box ON box.id=s.mailbox_id AND box.status NOT IN ('deleting','closed','deleted')
    WHERE s.id=? AND s.state='active' AND scope.state='authorized'
      AND EXISTS(SELECT 1 FROM mail_triage_source_aliases a WHERE a.source_id=s.id AND a.mailbox_id=s.mailbox_id AND a.active=1 AND a.uid_validity=scope.uid_validity)
      AND NOT EXISTS(SELECT 1 FROM abandoned_domains d WHERE d.domain=box.domain COLLATE NOCASE)`).get(sourceId);
}
function requireSources(db: DatabaseSync, ids: string[]): Row[] {
  return unique(ids).map(id => { const row = activeSource(db, id); if (!row) throw new Error("source_not_authorized"); return row; });
}
function caseRow(db: DatabaseSync, caseId: string): Row {
  const row = db.prepare("SELECT * FROM mail_application_cases WHERE id=?").get(caseId);
  if (!row) throw new Error("case_not_found");
  const linked = db.prepare("SELECT source_id FROM mail_case_sources WHERE case_id=? ORDER BY source_id").all(caseId) as Row[];
  const authorized = linked.filter(item => activeSource(db, String(item.source_id))).map(item => String(item.source_id));
  const provenance = parse<Provenance>(row.identity_provenance_json);
  if (linked.length !== authorized.length || (!linked.length && !(provenance.kind === "independent_manual" && provenance.supportSourceIds.length === 0 && provenance.verifiedAt && provenance.reason?.trim()))) throw new Error("case_not_authorized");
  return row;
}
function caseSources(db: DatabaseSync, caseId: string): string[] {
  return (db.prepare("SELECT source_id FROM mail_case_sources WHERE case_id=? ORDER BY source_id").all(caseId) as Row[]).map(row => String(row.source_id)).filter(id => Boolean(activeSource(db, id)));
}
function sourceClock(db: DatabaseSync, sourceId: string): number {
  return Number(db.prepare("SELECT COALESCE(MAX(applied_version),0) n FROM mail_case_manual_decisions WHERE case_id IS NULL AND object_id=?").get(sourceId)!.n);
}
export const getSourceManualVersion = sourceClock;
function requireCaseClock(row: Row, expected: number) { if (Number(row.manual_version) !== expected) throw new Error("version_conflict"); }
function requireSourceClock(db: DatabaseSync, sourceId: string, expected: number) { if (sourceClock(db, sourceId) !== expected) throw new Error("version_conflict"); }
function record(db: DatabaseSync, input: { id?: string; caseId: string | null; actor: string; objectId: string; field: string; expected: number; applied: number; reason: string; before: unknown; after: unknown; undoOf?: string | null; provenance: Provenance; now: number }): string {
  const id = input.id ?? randomUUID();
  db.prepare(`INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,undo_of,provenance_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.caseId, input.actor, input.objectId, input.field, input.expected, input.applied, input.reason, json(input.before), json(input.after), input.undoOf ?? null, json(input.provenance), input.now);
  return id;
}
function remember(db: DatabaseSync, requestId: string, operation: string, inputHash: string, result: unknown, now: number) {
  db.prepare("INSERT INTO mail_triage_requests(request_id,operation,canonical_input_hash,result_ref_json,created_at) VALUES(?,?,?,?,?)").run(requestId, operation, inputHash, json(result), now);
}
function replay(db: DatabaseSync, requestId: string, operation: string, inputHash: string): unknown | undefined {
  const row = db.prepare("SELECT canonical_input_hash,result_ref_json FROM mail_triage_requests WHERE request_id=? AND operation=?").get(requestId, operation);
  if (!row) return undefined;
  if (row.canonical_input_hash !== inputHash) throw new Error("request_id_conflict");
  return JSON.parse(String(row.result_ref_json));
}
function affectedTasks(db: DatabaseSync, caseIds: string[]): string[] {
  if (!caseIds.length) return [];
  return unique((db.prepare("SELECT id FROM mail_case_tasks WHERE case_id IN (SELECT value FROM json_each(?)) ORDER BY id").all(json(unique(caseIds))) as Row[]).map(row => String(row.id)));
}
function sourcesToVerify(db: DatabaseSync, ids: string[]): string[] {
  return unique(ids).filter(id => activeSource(db, id)?.trust !== "human_confirmed");
}
function fencePendingModelWork(db: DatabaseSync, sourceIds: string[], caseIds: string[], now: number) {
  const sources = unique([...sourceIds, ...(caseIds.length ? (db.prepare("SELECT DISTINCT source_id FROM mail_case_sources WHERE case_id IN (SELECT value FROM json_each(?))").all(json(unique(caseIds))) as Row[]).map(row => String(row.source_id)) : [])]);
  if (!sources.length) return;
  db.prepare(`UPDATE mail_triage_jobs SET state='needs_review',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=0,last_error='manual_decision_changed',updated_at=?
    WHERE state IN ('queued','running','retry_wait') AND source_id IN (SELECT value FROM json_each(?))`).run(now, json(sources));
}
function safeCase(db: DatabaseSync, caseId: string): Record<string, unknown> {
  const row = db.prepare("SELECT identity_state,provider,site_id,application_identity,version,manual_version,projection_json FROM mail_application_cases WHERE id=?").get(caseId);
  if (!row) return { caseId, deleted: true };
  const projection = PersistedProjectedCaseSchema.parse(JSON.parse(String(row.projection_json)));
  return { caseId, version: Number(row.version), manualVersion: Number(row.manual_version), identityState: row.identity_state, provider: row.provider ?? null, siteId: row.site_id ?? null, applicationId: row.application_identity ?? null, column: projection.column, stage: projection.stage, decision: projection.decision, decisionCycle: projection.decisionCycle };
}
function exactRows(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): unknown[] {
  return (db.prepare(sql).all(...params) as Row[]).map(row => canonicalValue({ ...row }));
}
function caseFence(db: DatabaseSync, caseIds: string[]): unknown {
  return unique(caseIds).map(caseId => ({
    case: canonicalValue(db.prepare(`SELECT id,identity_state,provider,site_id,application_identity,identity_provenance_json,version,manual_version,projection_json
      FROM mail_application_cases WHERE id=?`).get(caseId) ?? null),
    sources: exactRows(db, `SELECT cs.source_id,cs.match_basis,cs.manual_locked,s.source_version FROM mail_case_sources cs
      JOIN mail_triage_sources s ON s.id=cs.source_id WHERE cs.case_id=? ORDER BY cs.source_id`, caseId),
    events: exactRows(db, "SELECT * FROM mail_case_events WHERE case_id=? ORDER BY id", caseId),
    tasks: exactRows(db, "SELECT * FROM mail_case_tasks WHERE case_id=? ORDER BY id", caseId),
  }));
}
function sameFence(actual: unknown, expected: unknown): boolean { return json(canonicalValue(actual)) === json(canonicalValue(expected)); }
function validateFence(fence: CaseFence, expectedCaseIds: string[]): CaseFence {
  const expected = unique(expectedCaseIds), actual = fence.map(item => item.case.id).sort();
  if (json(actual) !== json(expected)) throw new Error("audit_snapshot_invalid");
  for (const item of fence) {
    if (item.events.some(row => row.case_id !== item.case.id) || item.tasks.some(row => row.case_id !== item.case.id)) throw new Error("audit_snapshot_invalid");
    if (new Set(item.sources.map(row => row.source_id)).size !== item.sources.length || new Set(item.events.map(row => row.id)).size !== item.events.length || new Set(item.tasks.map(row => row.id)).size !== item.tasks.length) throw new Error("audit_snapshot_invalid");
    const eventIds = new Set(item.events.map(row => row.id)); if (item.tasks.some(row => !eventIds.has(row.event_id))) throw new Error("audit_snapshot_invalid");
  }
  return fence;
}
function equalStored(left: unknown, right: unknown): boolean { return json(canonicalValue(left)) === json(canonicalValue(right)); }
function invariantCase(before: CaseFence[number], after: CaseFence[number]): boolean {
  const pick = (item: CaseFence[number]) => ({ id: item.case.id, identity_state: item.case.identity_state, provider: item.case.provider, site_id: item.case.site_id, application_identity: item.case.application_identity, identity_provenance_json: item.case.identity_provenance_json });
  return equalStored(pick(before), pick(after));
}
function casePart(fence: CaseFence, id: string): CaseFence[number] { return fence.find(item => item.case.id === id)!; }
function withoutCaseId<T extends { case_id: string }>(row: T): Omit<T, "case_id"> { const { case_id: _caseId, ...rest } = row; return rest; }
function validSafetyExtras(events: CaseFence[number]["events"], tasks: CaseFence[number]["tasks"]): boolean {
  const eventIds = new Set(events.map(row => row.id));
  return events.every(row => row.kind === "review_required" && row.event_slot.includes(":safety_review:"))
    && tasks.every(row => eventIds.has(row.event_id) && row.kind === "review" && row.obligation_key.startsWith("safety_review:") && row.object === row.obligation_key)
    && events.every(row => tasks.some(task => task.event_id === row.id));
}
function fenceFactIds(fence: CaseFence): { eventIds: string[]; taskIds: string[] } {
  return { eventIds: unique(fence.flatMap(item => item.events.map(row => row.id))), taskIds: unique(fence.flatMap(item => item.tasks.map(row => row.id))) };
}
function operationFactDelta(before: CaseFence, after: CaseFence): { operationEventIds: string[]; operationTaskIds: string[] } {
  const prior = fenceFactIds(before), next = fenceFactIds(after), priorEvents = new Set(prior.eventIds), priorTasks = new Set(prior.taskIds);
  return { operationEventIds: next.eventIds.filter(id => !priorEvents.has(id)), operationTaskIds: next.taskIds.filter(id => !priorTasks.has(id)) };
}
function parseStored<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  try { return schema.parse(JSON.parse(String(raw))); } catch { throw new Error("audit_snapshot_invalid"); }
}
function parseSourceAudit(field: string, raw: unknown, sourceId: string): Record<string, unknown> & { sourceId: string; sourceVersion: number } {
  const schema = sourceAuditSchemas[field as keyof typeof sourceAuditSchemas];
  if (!schema) throw new Error("audit_snapshot_invalid");
  const value = parseStored(schema, raw) as Record<string, unknown> & { sourceId: string; sourceVersion: number };
  if (value.sourceId !== sourceId) throw new Error("audit_snapshot_invalid");
  return value;
}
type HighRiskAudit =
  | { field: "link"; before: z.infer<typeof linkBeforeSchema>; after: z.infer<typeof linkAfterSchema> }
  | { field: "identity"; before: z.infer<typeof identityBeforeSchema>; after: z.infer<typeof identityAfterSchema> }
  | { field: "split"; before: z.infer<typeof splitBeforeSchema>; after: z.infer<typeof splitAfterSchema> }
  | { field: "appeal_requested"; before: z.infer<typeof appealBeforeSchema>; after: z.infer<typeof appealAfterSchema> };
function parseHighRiskAudit(field: string, beforeRaw: unknown, afterRaw: unknown, caseId: string, objectId: string): HighRiskAudit | null {
  if (field === "link") {
    const before = parseStored(linkBeforeSchema, beforeRaw), after = parseStored(linkAfterSchema, afterRaw);
    validateFence(before.fence, [caseId]); validateFence(after.fence, [caseId]);
    const bf = casePart(before.fence, caseId), af = casePart(after.fence, caseId), beforeSources = new Map(bf.sources.map(row => [row.source_id, row])), afterSources = new Map(af.sources.map(row => [row.source_id, row]));
    const expectedSourceIds = unique([...beforeSources.keys(), ...after.sourceIds]);
    if (objectId !== caseId || before.caseId !== caseId || after.caseId !== caseId || new Set(after.sourceIds).size !== after.sourceIds.length || before.associations.some(item => !after.sourceIds.includes(item.sourceId)) || !invariantCase(bf, af) || !equalStored(bf.events, af.events) || !equalStored(bf.tasks, af.tasks) || !equalStored([...afterSources.keys()].sort(), expectedSourceIds)) throw new Error("audit_snapshot_invalid");
    for (const sourceId of expectedSourceIds) {
      const prior = beforeSources.get(sourceId), next = afterSources.get(sourceId);
      if (!next || (prior && prior.source_version !== next.source_version)) throw new Error("audit_snapshot_invalid");
      const association = before.associations.find(item => item.sourceId === sourceId);
      if (after.sourceIds.includes(sourceId)) {
        if (next.match_basis !== "manual_link" || next.manual_locked !== 1 || (prior ? !association || association.matchBasis !== prior.match_basis || association.manualLocked !== prior.manual_locked : association)) throw new Error("audit_snapshot_invalid");
      } else if (!prior || !equalStored(prior, next)) throw new Error("audit_snapshot_invalid");
    }
    return { field, before, after };
  }
  if (field === "identity") {
    const before = parseStored(identityBeforeSchema, beforeRaw), after = parseStored(identityAfterSchema, afterRaw);
    validateFence(before.fence, [caseId]); validateFence(after.fence, [caseId]);
    const bf = casePart(before.fence, caseId), af = casePart(after.fence, caseId);
    const priorIdentity = { provider: bf.case.provider, siteId: bf.case.site_id, applicationId: bf.case.application_identity };
    const nextIdentity = { provider: af.case.provider, siteId: af.case.site_id, applicationId: af.case.application_identity };
    if (objectId !== caseId || before.caseId !== caseId || after.caseId !== caseId || !equalStored(bf.sources, af.sources) || !equalStored(bf.events, af.events) || !equalStored(bf.tasks, af.tasks) || bf.case.identity_state !== before.identityState || !equalStored(priorIdentity, before.identity) || !equalStored(parseStored(ProvenanceSchema, bf.case.identity_provenance_json), before.identityProvenance) || af.case.identity_state !== after.identityState || !equalStored(nextIdentity, after.identity) || !equalStored(parseStored(ProvenanceSchema, af.case.identity_provenance_json), after.identityProvenance)) throw new Error("audit_snapshot_invalid");
    return { field, before, after };
  }
  if (field === "split") {
    const before = parseStored(splitBeforeSchema, beforeRaw), after = parseStored(splitAfterSchema, afterRaw);
    validateFence(before.fence, [caseId]); validateFence(after.fence, [caseId, after.caseId]);
    const beforeIds = unique(before.eventIds), afterIds = unique(after.eventIds), bf = casePart(before.fence, caseId), oldAfter = casePart(after.fence, caseId), newCase = casePart(after.fence, after.caseId);
    const afterEvents = [...oldAfter.events, ...newCase.events], afterTasks = [...oldAfter.tasks, ...newCase.tasks];
    const eventMap = new Map(afterEvents.map(row => [row.id, row])), taskMap = new Map(afterTasks.map(row => [row.id, row]));
    const selected = new Set(beforeIds), priorEventIds = new Set(bf.events.map(row => row.id)), priorTaskIds = new Set(bf.tasks.map(row => row.id));
    const extraEvents = afterEvents.filter(row => !priorEventIds.has(row.id)), extraTasks = afterTasks.filter(row => !priorTaskIds.has(row.id));
    const delta = operationFactDelta(before.fence, after.fence);
    if (objectId !== caseId || before.caseId !== caseId || after.caseId === caseId || json(beforeIds) !== json(afterIds) || !invariantCase(bf, oldAfter) || !equalStored(bf.sources, oldAfter.sources) || !equalStored(unique(after.operationEventIds), delta.operationEventIds) || !equalStored(unique(after.operationTaskIds), delta.operationTaskIds) || after.operationEventIds.length !== new Set(after.operationEventIds).size || after.operationTaskIds.length !== new Set(after.operationTaskIds).size || !validSafetyExtras(extraEvents, extraTasks)) throw new Error("audit_snapshot_invalid");
    for (const row of bf.events) { const next = eventMap.get(row.id); if (!next || !equalStored(withoutCaseId(row), withoutCaseId(next)) || next.case_id !== (selected.has(row.id) ? after.caseId : caseId)) throw new Error("audit_snapshot_invalid"); }
    for (const row of bf.tasks) { const next = taskMap.get(row.id); if (!next || !equalStored(withoutCaseId(row), withoutCaseId(next)) || next.case_id !== (selected.has(row.event_id) ? after.caseId : caseId)) throw new Error("audit_snapshot_invalid"); }
    if (beforeIds.some(id => !newCase.events.some(row => row.id === id)) || !equalStored(newCase.sources.map(row => ({ source_id: row.source_id, match_basis: row.match_basis, manual_locked: row.manual_locked })), unique(newCase.events.flatMap(row => row.source_id == null ? [] : [row.source_id])).map(source_id => ({ source_id, match_basis: "manual_split", manual_locked: 1 })))) throw new Error("audit_snapshot_invalid");
    return { field, before, after };
  }
  if (field === "appeal_requested") {
    const before = parseStored(appealBeforeSchema, beforeRaw), after = parseStored(appealAfterSchema, afterRaw);
    validateFence(before.fence, [caseId]); validateFence(after.fence, [caseId]);
    const bf = casePart(before.fence, caseId), af = casePart(after.fence, caseId), event = af.events.find(row => row.id === after.eventId);
    const priorEventIds = new Set(bf.events.map(row => row.id)), priorTaskIds = new Set(bf.tasks.map(row => row.id));
    const extraEvents = af.events.filter(row => row.id !== after.eventId && !priorEventIds.has(row.id)), extraTasks = af.tasks.filter(row => !priorTaskIds.has(row.id));
    const delta = operationFactDelta(before.fence, after.fence);
    if (objectId !== caseId || before.caseId !== caseId || after.caseId !== caseId || after.decisionCycle !== before.decisionCycle + 1 || !event || event.kind !== "reconsideration_requested" || event.decision_cycle !== after.decisionCycle || event.case_id !== caseId || event.source_id !== null || !invariantCase(bf, af) || !equalStored(bf.sources, af.sources) || bf.events.some(row => !af.events.some(next => equalStored(row, next))) || bf.tasks.some(row => !af.tasks.some(next => equalStored(row, next))) || !equalStored(unique(after.operationEventIds), delta.operationEventIds) || !equalStored(unique(after.operationTaskIds), delta.operationTaskIds) || after.operationEventIds.length !== new Set(after.operationEventIds).size || after.operationTaskIds.length !== new Set(after.operationTaskIds).size || !after.operationEventIds.includes(after.eventId) || !validSafetyExtras(extraEvents, extraTasks)) throw new Error("audit_snapshot_invalid");
    return { field, before, after };
  }
  return null;
}
function removeFactsAddedAfterFence(db: DatabaseSync, fence: CaseFence): void {
  for (const item of fence) {
    const caseId = item.case.id;
    const taskIds = new Set(item.tasks.map(row => row.id)), eventIds = new Set(item.events.map(row => row.id));
    for (const row of db.prepare("SELECT id FROM mail_case_tasks WHERE case_id=?").all(caseId) as Row[]) if (!taskIds.has(String(row.id))) db.prepare("DELETE FROM mail_case_tasks WHERE id=?").run(String(row.id));
    for (const row of db.prepare("SELECT id FROM mail_case_events WHERE case_id=?").all(caseId) as Row[]) if (!eventIds.has(String(row.id))) db.prepare("DELETE FROM mail_case_events WHERE id=?").run(String(row.id));
  }
}
function removeOperationFacts(db: DatabaseSync, taskIds: string[], eventIds: string[]): void {
  for (const id of taskIds) db.prepare("DELETE FROM mail_case_tasks WHERE id=?").run(id);
  for (const id of eventIds) db.prepare("DELETE FROM mail_case_events WHERE id=?").run(id);
}
function checkedDeadline(value: { deadlineRaw: string | null; deadlineAt: number | null }) {
  if (value.deadlineRaw === null && value.deadlineAt === null) return;
  if (value.deadlineRaw === null || value.deadlineAt === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.deadlineRaw) || Date.parse(value.deadlineRaw) !== value.deadlineAt) throw new Error("deadline_raw_at_mismatch");
}

export function applyManualDecision(db: DatabaseSync, raw: ManualMutation, actor: ServerActor, now = Date.now()): ManualMutationResult {
  const input = ManualMutationSchema.parse(raw), by = actorId(actor), inputHash = digest(input);
  return atomic(db, () => {
    const old = replay(db, input.requestId, "manual.apply", inputHash); if (old) return ManualMutationResultSchema.parse(old);
    const decisionId = randomUUID();
    let version = input.expectedVersion + 1, before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
    let caseIds: string[] = [], sourceIds: string[] = [], touchedTasks: string[] = [], fenceCaseIds: string[] = [], fenceBefore: unknown = null;
    const priorCaseIds = input.kind === "correct" && input.target.type === "source"
      ? (db.prepare("SELECT case_id FROM mail_case_sources WHERE source_id=? ORDER BY case_id").all(input.target.id) as Row[]).map(row => String(row.case_id))
      : input.kind === "correct" && input.target.type === "task"
        ? (db.prepare("SELECT case_id FROM mail_case_tasks WHERE id=?").all(input.target.id) as Row[]).map(row => String(row.case_id))
        : input.kind === "correct" ? [input.target.id] : [input.caseId];
    const projectionBefore = unique(priorCaseIds).map(id => safeCase(db, id));
    if (input.kind === "correct" && input.target.type === "source") {
      const source = activeSource(db, input.target.id); if (!source) throw new Error("source_not_authorized");
      if (Number(source.source_version) !== input.target.sourceVersion) throw new Error("source_version_conflict");
      requireSourceClock(db, input.target.id, input.expectedVersion); sourceIds = [input.target.id];
      const latest = db.prepare("SELECT after_json FROM mail_case_manual_decisions WHERE case_id IS NULL AND object_id=? AND field=? ORDER BY applied_version DESC,id DESC LIMIT 1").get(input.target.id, input.field);
      const current = input.field === "sourceTrust" ? source.trust : latest ? (parse<Record<string, unknown>>(latest.after_json))[input.field] ?? null : null;
      before = { sourceId: input.target.id, sourceVersion: input.target.sourceVersion, [input.field]: current };
      after = { sourceId: input.target.id, sourceVersion: input.target.sourceVersion, [input.field]: input.value };
      if (input.field === "sourceTrust") db.prepare("UPDATE mail_triage_sources SET trust=? WHERE id=? AND source_version=?").run(input.value, input.target.id, input.target.sourceVersion);
      record(db, { id: decisionId, caseId: null, actor: by, objectId: input.target.id, field: input.field, expected: input.expectedVersion, applied: version, reason: input.reason, before, after, provenance: derived([input.target.id]), now });
      caseIds = (db.prepare("SELECT case_id FROM mail_case_sources WHERE source_id=? ORDER BY case_id").all(input.target.id) as Row[]).map(row => String(row.case_id));
      for (const id of caseIds) { const row = db.prepare("SELECT manual_version FROM mail_application_cases WHERE id=?").get(id); if (row) db.prepare("UPDATE mail_application_cases SET manual_version=manual_version+1,updated_at=? WHERE id=?").run(now, id); }
    } else if (input.kind === "correct" && input.target.type === "task") {
      const task = db.prepare("SELECT * FROM mail_case_tasks WHERE id=?").get(input.target.id); if (!task) throw new Error("task_not_found");
      const c = caseRow(db, String(task.case_id)); requireCaseClock(c, input.expectedVersion); caseIds = [String(task.case_id)]; sourceIds = caseSources(db, caseIds[0]); touchedTasks = [input.target.id];
      let prior: unknown;
      if (input.field === "deadline" || input.field === "deadlineRaw") { checkedDeadline(input.value); prior = { deadlineRaw: task.deadline_raw ?? null, deadlineAt: task.deadline_at ?? null }; db.prepare("UPDATE mail_case_tasks SET deadline_raw=?,deadline_at=?,version=version+1 WHERE id=?").run(input.value.deadlineRaw, input.value.deadlineAt, input.target.id); }
      else if (input.field === "requestedItems") { prior = parse<unknown[]>(task.requested_items_json); db.prepare("UPDATE mail_case_tasks SET requested_items_json=?,version=version+1 WHERE id=?").run(json(unique(input.value)), input.target.id); }
      else if (input.field === "title") { prior = task.title; db.prepare("UPDATE mail_case_tasks SET title=?,version=version+1 WHERE id=?").run(input.value, input.target.id); }
      else if (input.field === "state") { prior = task.state; db.prepare("UPDATE mail_case_tasks SET state=?,version=version+1 WHERE id=?").run(input.value, input.target.id); }
      else { const priorRow = db.prepare("SELECT after_json FROM mail_case_manual_decisions WHERE case_id=? AND object_id=? AND field=? ORDER BY applied_version DESC,id DESC LIMIT 1").get(caseIds[0], input.target.id, input.field); prior = priorRow ? (parse<Record<string, unknown>>(priorRow.after_json))[input.field] ?? null : null; }
      before = { taskId: input.target.id, [input.field]: prior }; after = { taskId: input.target.id, [input.field]: input.value };
      record(db, { id: decisionId, caseId: caseIds[0], actor: by, objectId: input.target.id, field: input.field === "deadlineRaw" ? "deadline" : input.field, expected: input.expectedVersion, applied: version, reason: input.reason, before, after, provenance: parse<Provenance>(task.provenance_json), now });
      db.prepare("UPDATE mail_application_cases SET manual_version=?,updated_at=? WHERE id=?").run(version, now, caseIds[0]);
    } else if (input.kind === "correct" && input.target.type === "case") {
      const c = caseRow(db, input.target.id); requireCaseClock(c, input.expectedVersion); caseIds = [input.target.id]; sourceIds = caseSources(db, input.target.id);
      if (!sourceIds.length) throw new Error("case_source_required");
      const prior = db.prepare("SELECT after_json FROM mail_case_manual_decisions WHERE case_id=? AND object_id=? AND field=? ORDER BY applied_version DESC,id DESC LIMIT 1").get(input.target.id, input.target.id, input.field);
      before = { caseId: input.target.id, [input.field]: prior ? parse<Record<string, unknown>>(prior.after_json)[input.field] ?? null : null }; after = { caseId: input.target.id, [input.field]: input.value };
      record(db, { id: decisionId, caseId: input.target.id, actor: by, objectId: input.target.id, field: input.field, expected: input.expectedVersion, applied: version, reason: input.reason, before, after, provenance: derived(sourceIds), now });
      db.prepare("UPDATE mail_application_cases SET manual_version=?,updated_at=? WHERE id=?").run(version, now, input.target.id);
    } else if (input.kind === "link") {
      const c = caseRow(db, input.caseId); requireCaseClock(c, input.expectedVersion); requireSources(db, input.sourceIds); caseIds = [input.caseId]; sourceIds = unique(input.sourceIds);
      fenceBefore = caseFence(db, [input.caseId]);
      const existing = exactRows(db, "SELECT source_id AS sourceId,match_basis AS matchBasis,manual_locked AS manualLocked FROM mail_case_sources WHERE case_id=? AND source_id IN (SELECT value FROM json_each(?)) ORDER BY source_id", input.caseId, json(sourceIds));
      for (const id of sourceIds) db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis,manual_locked) VALUES(?,?,'manual_link',1) ON CONFLICT(case_id,source_id) DO UPDATE SET manual_locked=1,match_basis='manual_link'").run(input.caseId, id);
      before = { caseId: input.caseId, associations: existing }; after = { caseId: input.caseId, sourceIds }; fenceCaseIds = [input.caseId];
      record(db, { id: decisionId, caseId: input.caseId, actor: by, objectId: input.caseId, field: "link", expected: input.expectedVersion, applied: version, reason: input.reason, before, after, provenance: derived(sourceIds), now });
      db.prepare("UPDATE mail_application_cases SET manual_version=?,updated_at=? WHERE id=?").run(version, now, input.caseId);
    } else if (input.kind === "split") {
      const c = caseRow(db, input.caseId); requireCaseClock(c, input.expectedVersion);
      fenceBefore = caseFence(db, [input.caseId]);
      const events = db.prepare("SELECT id,source_id FROM mail_case_events WHERE case_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id").all(input.caseId, json(unique(input.eventIds))) as Row[];
      if (events.length !== unique(input.eventIds).length) throw new Error("split_event_not_found");
      sourceIds = unique(events.flatMap(row => row.source_id == null ? [] : [String(row.source_id)])); requireSources(db, sourceIds);
      const newCaseId = randomUUID(), provenance = independent(now, input.reason);
      if (input.newIdentity.siteId != null && !db.prepare("SELECT 1 FROM sites WHERE id=?").get(input.newIdentity.siteId)) throw new Error("site_not_found");
      db.prepare(`INSERT INTO mail_application_cases(id,identity_state,provider,site_id,application_identity,identity_provenance_json,projection_json,created_at,updated_at)
        VALUES(?,'confirmed',?,?,?,?, '{}',?,?)`).run(newCaseId, input.newIdentity.provider, input.newIdentity.siteId, input.newIdentity.applicationId, json(provenance), now, now);
      db.exec("PRAGMA defer_foreign_keys=ON");
      db.prepare("UPDATE mail_case_events SET case_id=? WHERE case_id=? AND id IN (SELECT value FROM json_each(?))").run(newCaseId, input.caseId, json(unique(input.eventIds)));
      db.prepare("UPDATE mail_case_tasks SET case_id=? WHERE case_id=? AND event_id IN (SELECT value FROM json_each(?))").run(newCaseId, input.caseId, json(unique(input.eventIds)));
      for (const id of sourceIds) db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis,manual_locked) VALUES(?,?,'manual_split',1)").run(newCaseId, id);
      caseIds = [input.caseId, newCaseId]; touchedTasks = affectedTasks(db, [newCaseId]);
      before = { caseId: input.caseId, eventIds: unique(input.eventIds) }; after = { caseId: newCaseId, eventIds: unique(input.eventIds), identity: input.newIdentity }; fenceCaseIds = [input.caseId, newCaseId];
      record(db, { id: decisionId, caseId: input.caseId, actor: by, objectId: input.caseId, field: "split", expected: input.expectedVersion, applied: version, reason: input.reason, before, after, provenance: independent(now, input.reason), now });
      db.prepare("UPDATE mail_application_cases SET manual_version=?,updated_at=? WHERE id=?").run(version, now, input.caseId);
      db.prepare("UPDATE mail_application_cases SET manual_version=1,updated_at=? WHERE id=?").run(now, newCaseId);
    } else if (input.kind === "confirm_case") {
      const c = caseRow(db, input.caseId); requireCaseClock(c, input.expectedVersion); caseIds = [input.caseId]; sourceIds = caseSources(db, input.caseId);
      fenceBefore = caseFence(db, [input.caseId]);
      if (input.identity.siteId != null && !db.prepare("SELECT 1 FROM sites WHERE id=?").get(input.identity.siteId)) throw new Error("site_not_found");
      if (c.application_identity != null && c.application_identity !== input.identity.applicationId && parse<Record<string, unknown>>(c.projection_json).decision && ["approved", "declined", "withdrawn"].includes(String(parse<Record<string, unknown>>(c.projection_json).decision))) throw new Error("new_application_requires_new_case");
      before = { caseId: input.caseId, identityState: c.identity_state, identity: { provider: c.provider ?? null, siteId: c.site_id ?? null, applicationId: c.application_identity ?? null }, identityProvenance: JSON.parse(String(c.identity_provenance_json)) };
      const nextIdentityProvenance = independent(now, input.reason);
      after = { caseId: input.caseId, identityState: "confirmed", identity: input.identity, identityProvenance: nextIdentityProvenance }; fenceCaseIds = [input.caseId];
      db.prepare("UPDATE mail_application_cases SET identity_state='confirmed',provider=?,site_id=?,application_identity=?,identity_provenance_json=?,manual_version=?,updated_at=? WHERE id=?").run(input.identity.provider, input.identity.siteId, input.identity.applicationId, json(nextIdentityProvenance), version, now, input.caseId);
      record(db, { id: decisionId, caseId: input.caseId, actor: by, objectId: input.caseId, field: "identity", expected: input.expectedVersion, applied: version, reason: input.reason, before, after, provenance: independent(now, input.reason), now });
    } else if (input.kind === "independent_fact") {
      const c = caseRow(db, input.caseId); requireCaseClock(c, input.expectedVersion); caseIds = [input.caseId]; sourceIds = caseSources(db, input.caseId);
      before = { caseId: input.caseId, [input.fact.type]: parse<Record<string, unknown>>(c.projection_json)[input.fact.type] ?? "unknown" };
      after = { caseId: input.caseId, [input.fact.type]: input.fact.value, verifiedAt: input.verifiedAt };
      record(db, { id: decisionId, caseId: input.caseId, actor: by, objectId: input.caseId, field: input.fact.type, expected: input.expectedVersion, applied: version, reason: input.reason, before, after, provenance: independent(input.verifiedAt, input.reason), now });
      db.prepare("UPDATE mail_application_cases SET manual_version=?,updated_at=? WHERE id=?").run(version, now, input.caseId);
    } else if (input.kind === "appeal_requested") {
      const c = caseRow(db, input.caseId); requireCaseClock(c, input.expectedVersion); caseIds = [input.caseId]; sourceIds = caseSources(db, input.caseId);
      fenceBefore = caseFence(db, [input.caseId]);
      const priorCycle = Number(db.prepare("SELECT COALESCE(MAX(decision_cycle),1) n FROM mail_case_events WHERE case_id=?").get(input.caseId)!.n), cycle = priorCycle + 1;
      const eventId = randomUUID(), provenance = independent(now, input.reason);
      db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,NULL,?,'reconsideration_requested',?,?,?,'[]',?)").run(eventId, input.caseId, `manual:appeal:${decisionId}`, cycle, now, now, json(provenance));
      before = { caseId: input.caseId, decisionCycle: priorCycle }; after = { caseId: input.caseId, decisionCycle: cycle, eventId, status: "appeal_requested" }; fenceCaseIds = [input.caseId];
      record(db, { id: decisionId, caseId: input.caseId, actor: by, objectId: input.caseId, field: "appeal_requested", expected: input.expectedVersion, applied: version, reason: input.reason, before, after, provenance, now });
      db.prepare("UPDATE mail_application_cases SET manual_version=?,updated_at=? WHERE id=?").run(version, now, input.caseId);
    } else throw new Error("manual_mutation_unreachable");
    fencePendingModelWork(db, sourceIds, caseIds, now);
    if (caseIds.length) reprojectCases(db, { caseIds, now });
    if (fenceCaseIds.length) {
      const parsedBeforeFence = caseFenceSchema.parse(fenceBefore), parsedAfterFence = caseFenceSchema.parse(caseFence(db, fenceCaseIds));
      const ownedFacts = input.kind === "split" || input.kind === "appeal_requested" ? operationFactDelta(parsedBeforeFence, parsedAfterFence) : {};
      const auditAfter = { ...after, ...ownedFacts, fence: parsedAfterFence };
      const auditBefore = { ...before, fence: parsedBeforeFence };
      db.prepare("UPDATE mail_case_manual_decisions SET before_json=?,after_json=? WHERE id=?").run(json(auditBefore), json(auditAfter), decisionId);
    }
    touchedTasks = unique([...touchedTasks, ...affectedTasks(db, caseIds)]);
    const result = ManualMutationResultSchema.parse({ decisionId, version, before, after, affectedTaskIds: touchedTasks, sourcesToVerify: sourcesToVerify(db, sourceIds), affectedSourceIds: unique(sourceIds), projectionBefore, projectionAfter: unique(caseIds).map(id => safeCase(db, id)) });
    remember(db, input.requestId, "manual.apply", inputHash, result, now); return result;
  });
}

function restoreTaskField(db: DatabaseSync, decision: Row, value: Record<string, unknown>) {
  const taskId = String(decision.object_id), field = String(decision.field);
  if (field === "title") db.prepare("UPDATE mail_case_tasks SET title=?,version=version+1 WHERE id=?").run(String(value.title), taskId);
  else if (field === "requestedItems") db.prepare("UPDATE mail_case_tasks SET requested_items_json=?,version=version+1 WHERE id=?").run(json(value.requestedItems ?? []), taskId);
  else if (field === "state") db.prepare("UPDATE mail_case_tasks SET state=?,version=version+1 WHERE id=?").run(String(value.state), taskId);
  else if (field === "deadline") { const deadline = (value.deadline ?? value.deadlineRaw) as { deadlineRaw: string | null; deadlineAt: number | null }; db.prepare("UPDATE mail_case_tasks SET deadline_raw=?,deadline_at=?,version=version+1 WHERE id=?").run(deadline?.deadlineRaw ?? null, deadline?.deadlineAt ?? null, taskId); }
}

export function undoManualDecision(db: DatabaseSync, raw: z.infer<typeof UndoManualDecisionSchema>, actor: ServerActor, now = Date.now()): { version: number; affectedSourceIds: string[] } {
  const input = UndoManualDecisionSchema.parse(raw), by = actorId(actor), inputHash = digest(input);
  return atomic(db, () => {
    const old = replay(db, input.requestId, "manual.undo", inputHash); if (old) return UndoResultSchema.parse(old);
    const decision = db.prepare("SELECT * FROM mail_case_manual_decisions WHERE id=?").get(input.decisionId); if (!decision) throw new Error("decision_not_found");
    if (db.prepare("SELECT 1 FROM mail_case_manual_decisions WHERE undo_of=?").get(input.decisionId)) throw new Error("decision_already_undone");
    const caseId = decision.case_id == null ? null : String(decision.case_id), objectId = String(decision.object_id), field = String(decision.field);
    const highRisk = caseId === null ? null : parseHighRiskAudit(field, decision.before_json, decision.after_json, caseId, objectId);
    const before = highRisk?.before ?? parseStored(safeDiff, decision.before_json), after = highRisk?.after ?? parseStored(safeDiff, decision.after_json);
    const provenance = parseStored(ProvenanceSchema, decision.provenance_json);
    let version: number, caseIds: string[] = [], sourceIds: string[] = [];
    if (caseId === null) {
      if (highRisk) throw new Error("audit_snapshot_invalid");
      const sourceBefore = parseSourceAudit(field, decision.before_json, objectId), sourceAfter = parseSourceAudit(field, decision.after_json, objectId);
      const source = activeSource(db, objectId); if (!source) throw new Error("source_not_authorized"); requireSourceClock(db, objectId, input.expectedVersion);
      if (sourceBefore.sourceVersion !== sourceAfter.sourceVersion) throw new Error("audit_snapshot_invalid");
      const recordedVersion = sourceAfter.sourceVersion; if (Number(source.source_version) !== recordedVersion) throw new Error("source_version_conflict");
      const later = db.prepare("SELECT 1 FROM mail_case_manual_decisions WHERE case_id IS NULL AND object_id=? AND field=? AND applied_version>? LIMIT 1").get(objectId, field, Number(decision.applied_version));
      if (later) throw new Error("undo_conflict");
      version = input.expectedVersion + 1; sourceIds = [objectId];
      if (field === "sourceTrust") db.prepare("UPDATE mail_triage_sources SET trust=? WHERE id=? AND source_version=?").run(String(sourceBefore.sourceTrust), objectId, recordedVersion);
      record(db, { caseId: null, actor: by, objectId, field, expected: input.expectedVersion, applied: version, reason: input.reason, before: sourceAfter, after: sourceBefore, undoOf: input.decisionId, provenance, now });
      caseIds = (db.prepare("SELECT case_id FROM mail_case_sources WHERE source_id=? ORDER BY case_id").all(objectId) as Row[]).map(row => String(row.case_id));
      for (const id of caseIds) db.prepare("UPDATE mail_application_cases SET manual_version=manual_version+1,updated_at=? WHERE id=?").run(now, id);
    } else {
      const c = caseRow(db, caseId); requireCaseClock(c, input.expectedVersion); version = input.expectedVersion + 1; caseIds = [caseId]; sourceIds = caseSources(db, caseId);
      const later = db.prepare("SELECT 1 FROM mail_case_manual_decisions WHERE case_id=? AND object_id=? AND field=? AND applied_version>? LIMIT 1").get(caseId, objectId, field, Number(decision.applied_version));
      if (later) throw new Error("undo_conflict");
      if (["title", "requestedItems", "state", "deadline"].includes(field)) restoreTaskField(db, decision, before);
      else if (field === "identity") {
        if (highRisk?.field !== "identity") throw new Error("audit_snapshot_invalid");
        if (!sameFence(caseFence(db, [caseId]), highRisk.after.fence)) throw new Error("undo_conflict");
        removeFactsAddedAfterFence(db, highRisk.before.fence);
        const prior = highRisk.before.identity;
        db.prepare("UPDATE mail_application_cases SET identity_state=?,provider=?,site_id=?,application_identity=?,identity_provenance_json=? WHERE id=?").run(highRisk.before.identityState, prior.provider, prior.siteId, prior.applicationId, json(highRisk.before.identityProvenance), caseId);
      } else if (field === "link") {
        if (highRisk?.field !== "link") throw new Error("audit_snapshot_invalid");
        if (!sameFence(caseFence(db, [caseId]), highRisk.after.fence)) throw new Error("undo_conflict");
        removeFactsAddedAfterFence(db, highRisk.before.fence);
        const old = new Map(highRisk.before.associations.map(item => [item.sourceId, item])), newIds = highRisk.after.sourceIds;
        for (const id of newIds) { const prior = old.get(id); if (prior) db.prepare("UPDATE mail_case_sources SET match_basis=?,manual_locked=? WHERE case_id=? AND source_id=?").run(String(prior.matchBasis), Number(prior.manualLocked), caseId, id); else db.prepare("DELETE FROM mail_case_sources WHERE case_id=? AND source_id=?").run(caseId, id); }
      } else if (field === "split") {
        if (highRisk?.field !== "split") throw new Error("audit_snapshot_invalid");
        const newCaseId = highRisk.after.caseId, eventIds = highRisk.after.eventIds;
        if (!sameFence(caseFence(db, [caseId, newCaseId]), highRisk.after.fence)) throw new Error("undo_conflict");
        removeOperationFacts(db, highRisk.after.operationTaskIds, highRisk.after.operationEventIds);
        db.exec("PRAGMA defer_foreign_keys=ON");
        db.prepare("UPDATE mail_case_events SET case_id=? WHERE case_id=? AND id IN (SELECT value FROM json_each(?))").run(caseId, newCaseId, json(eventIds));
        db.prepare("UPDATE mail_case_tasks SET case_id=? WHERE case_id=? AND event_id IN (SELECT value FROM json_each(?))").run(caseId, newCaseId, json(eventIds));
        db.prepare("DELETE FROM mail_application_cases WHERE id=?").run(newCaseId); caseIds = [caseId];
      } else if (field === "appeal_requested") {
        if (highRisk?.field !== "appeal_requested") throw new Error("audit_snapshot_invalid");
        if (!sameFence(caseFence(db, [caseId]), highRisk.after.fence)) throw new Error("undo_conflict");
        removeOperationFacts(db, highRisk.after.operationTaskIds, highRisk.after.operationEventIds);
      }
      record(db, { caseId, actor: by, objectId, field, expected: input.expectedVersion, applied: version, reason: input.reason, before: after, after: before, undoOf: input.decisionId, provenance, now });
      db.prepare("UPDATE mail_application_cases SET manual_version=?,updated_at=? WHERE id=?").run(version, now, caseId);
    }
    fencePendingModelWork(db, sourceIds, caseIds, now);
    if (caseIds.length) reprojectCases(db, { caseIds, now });
    const result = UndoResultSchema.parse({ version, affectedSourceIds: unique(sourceIds) });
    remember(db, input.requestId, "manual.undo", inputHash, result, now); return result;
  });
}
