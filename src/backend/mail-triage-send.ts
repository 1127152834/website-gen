/** 发信收据与逐项义务结果。所有数据库阶段均为同步短事务；本模块不执行网络请求。 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { CaseProjection, MutationMeta, Provenance } from "../shared/mail-triage-types.ts";
import { MailSendSelectionSchema, MutationMetaSchema, PersistedProjectedCaseSchema } from "./mail-triage-schema.ts";
import { reprojectCases } from "./mail-case-projector.ts";
import { sourceTransaction } from "./mail-triage-source.ts";
import type { ServerActor } from "./mail-triage-service.ts";

type Row = Record<string, unknown>;
export type MailSendReceiptStatus = "prepared" | "smtp_accepted" | "failed" | "unknown";
export type MailSendReviewState = "none" | "pending" | "cleared";
export type MailSendReviewCode = "task_outcome_pending" | "sent_append_unconfirmed" | "task_binding_conflict" | "task_projection_failed";
export interface MailSendReceiptResult { messageId: string; appended: boolean; sendReceiptId: string; reviewState: MailSendReviewState; reviewCode: MailSendReviewCode | null }
export interface PreparedMailSend { receiptId: string; requestId: string; replySourceId: string | null; selectedTaskIds: string[]; replay?: MailSendReceiptResult }

const uuid = z.uuid();
const outcomeSchema = MutationMetaSchema.extend({
  caseId: uuid,
  taskIds: z.array(uuid).min(1).max(100),
  outcome: z.enum(["reply_sent", "action_completed", "dismissed", "blocked"]),
  sendReceiptId: uuid.optional(),
  bounceSourceId: uuid.optional(),
  completedItems: z.array(z.string().trim().min(1).max(500)).min(1).max(100).optional(),
  evidenceNote: z.string().trim().min(1).max(2000).optional(),
}).strict();
const reviewStateSchema = z.enum(["none", "pending", "cleared"]);
const reviewCodeSchema = z.enum(["task_outcome_pending", "sent_append_unconfirmed", "task_binding_conflict", "task_projection_failed"]);
const sendResultSchema = z.object({ messageId: z.string().min(1), appended: z.boolean(), sendReceiptId: uuid, reviewState: reviewStateSchema, reviewCode: reviewCodeSchema.nullable() }).strict();
const bindingSchema = z.object({
  v: z.literal(1), caseId: uuid, caseVersion: z.number().int().positive(), mailboxId: z.number().int().positive(),
  sourceId: uuid, sourceVersion: z.number().int().positive(),
  tasks: z.array(z.object({ id: uuid, version: z.number().int().positive(), kind: z.literal("reply"), requestedItemsHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(100),
}).strict();
const provenanceSchema = z.object({ supportSourceIds: z.array(uuid).min(1), kind: z.literal("source_derived"), verifiedAt: z.null(), reason: z.null() }).strict();
const json = (value: unknown) => JSON.stringify(value);
const hash = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
const unique = (values: string[]) => [...new Set(values)].sort();
const actorId = (actor: ServerActor) => {
  if (!Number.isSafeInteger(actor.userId) || actor.userId <= 0) throw new Error("server_actor_required");
  return `user:${actor.userId}`;
};

type Binding = z.infer<typeof bindingSchema>;

function parseBinding(value: unknown): Binding {
  if (value == null) throw new Error("send_receipt_binding_missing");
  try { return bindingSchema.parse(JSON.parse(String(value))); }
  catch { throw new Error("send_receipt_binding_invalid"); }
}

function receiptResult(row: Row): MailSendReceiptResult {
  return sendResultSchema.parse({
    messageId: row.message_id, appended: Number(row.appended) === 1, sendReceiptId: row.id,
    reviewState: row.review_state, reviewCode: row.review_code,
  });
}

function persistReceiptResult(db: DatabaseSync, receiptId: string): MailSendReceiptResult {
  const row = db.prepare("SELECT * FROM mail_triage_send_receipts WHERE id=? AND smtp_status='smtp_accepted'").get(receiptId) as Row | undefined;
  if (!row) throw new Error("发信收据状态冲突");
  const result = receiptResult(row);
  db.prepare("UPDATE mail_triage_requests SET result_ref_json=? WHERE request_id=? AND operation='mail.send'").run(json(result), String(row.request_id));
  return result;
}

function authorizedSource(db: DatabaseSync, sourceId: string): Row | undefined {
  return db.prepare(`SELECT s.id,s.mailbox_id,s.source_version,s.trust FROM mail_triage_sources s
    JOIN mail_triage_scope scope ON scope.mailbox_id=s.mailbox_id AND scope.state='authorized'
    JOIN mail_triage_settings settings ON settings.id=1 AND settings.config_epoch=scope.epoch
    JOIN mailboxes box ON box.id=s.mailbox_id AND box.status NOT IN ('deleting','closed','deleted')
    WHERE s.id=? AND s.state='active'
      AND NOT EXISTS(SELECT 1 FROM abandoned_domains d WHERE d.domain=box.domain COLLATE NOCASE)`).get(sourceId);
}

function selectedRows(db: DatabaseSync, caseId: string, taskIds: string[]): Row[] {
  const ids = unique(taskIds);
  const rows = db.prepare("SELECT * FROM mail_case_tasks WHERE case_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id").all(caseId, json(ids)) as Row[];
  if (rows.length !== ids.length) throw new Error("所选义务不属于该申请事项");
  return rows;
}

/** 在构造/读取原邮件前校验卡片选择，防止跨邮箱卡片借用其他发件身份。 */
export function validateMailSendSelection(db: DatabaseSync, input: {
  mailboxId: number; caseId?: string; selectedTaskIds?: string[]; replyTo?: { folder: string; uid: number; readerRef?: import("../shared/mail-triage-types.ts").CaseSourceReaderRef };
}): { replySourceId: string | null; selectedTaskIds: string[] } {
  const parsed=MailSendSelectionSchema.parse({mailboxId:input.mailboxId,caseId:input.caseId,selectedTaskIds:input.selectedTaskIds,replyTo:input.replyTo});
  const ids = unique(parsed.selectedTaskIds ?? []);
  if (!ids.length) return { replySourceId: null, selectedTaskIds: [] };
  const caseId = uuid.parse(parsed.caseId);
  if (!parsed.replyTo?.readerRef) throw new Error("所选回复义务必须提供完整来源阅读能力");
  const source = db.prepare(`SELECT s.id,s.mailbox_id,s.source_version,a.uid_validity FROM mail_messages m
    JOIN mail_triage_source_aliases a ON a.mailbox_id=m.mailbox_id AND a.folder=m.folder AND a.uid=m.uid AND a.uid_validity=m.uid_validity AND a.active=1
    JOIN mail_triage_sources s ON s.id=a.source_id
    WHERE m.mailbox_id=? AND m.folder=? AND m.uid=? ORDER BY s.id LIMIT 2`).all(parsed.mailboxId, parsed.replyTo.folder, parsed.replyTo.uid) as Row[];
  if (source.length !== 1) throw new Error("无法唯一确认原收件邮箱来源");
  const replySourceId = String(source[0]!.id);
  const ref=parsed.replyTo.readerRef;
  if(ref.caseId!==caseId||ref.sourceId!==replySourceId||ref.sourceVersion!==Number(source[0]!.source_version)||ref.mailboxId!==parsed.mailboxId||ref.folder!==parsed.replyTo.folder||ref.uid!==parsed.replyTo.uid||ref.uidValidity!==String(source[0]!.uid_validity)) throw new Error("原邮件来源绑定已变化");
  const active = authorizedSource(db, replySourceId);
  if (!active || Number(active.mailbox_id) !== parsed.mailboxId) throw new Error("原收件邮箱来源已失效或未获授权");
  if (!db.prepare("SELECT 1 FROM mail_case_sources WHERE case_id=? AND source_id=?").get(caseId, replySourceId)) throw new Error("原邮件来源不属于该申请事项");
  for (const row of selectedRows(db, caseId, ids)) {
    if (row.kind !== "reply") throw new Error("发信只能勾选具体回复义务，材料上传等义务保持独立");
    if (!["open", "blocked", "awaiting_external"].includes(String(row.state))) throw new Error("所选回复义务当前不可履行");
    const provenance = provenanceSchema.safeParse(JSON.parse(String(row.provenance_json)));
    if (!provenance.success || !provenance.data.supportSourceIds.includes(replySourceId)) throw new Error("回复义务与原邮件来源不匹配");
  }
  return { replySourceId, selectedTaskIds: ids };
}

/** canonicalContent 必须是最终传给 transport 的规范化消息（附件仅需内容哈希）。 */
export function prepareMailSend(db: DatabaseSync, input: {
  requestId?: string; mailboxId: number; caseId?: string; selectedTaskIds?: string[]; replySourceId: string | null; canonicalContent: unknown;
}, now = Date.now()): PreparedMailSend {
  const requestId = input.requestId === undefined ? randomUUID() : uuid.parse(input.requestId);
  const receiptId = randomUUID(), selectedTaskIds = unique(input.selectedTaskIds ?? []);
  const inputHash = hash({ mailboxId: input.mailboxId, caseId: input.caseId ?? null, selectedTaskIds, replySourceId: input.replySourceId, content: input.canonicalContent });
  const outcome = sourceTransaction(db, (): PreparedMailSend | { blocked: "failed" | "unknown" } => {
    const priorRequest = db.prepare("SELECT canonical_input_hash,result_ref_json FROM mail_triage_requests WHERE request_id=? AND operation='mail.send'").get(requestId) as Row | undefined;
    if (priorRequest) {
      if (priorRequest.canonical_input_hash !== inputHash) throw new Error("request_id_conflict：requestId 已用于不同内容");
      const receipt = db.prepare("SELECT * FROM mail_triage_send_receipts WHERE request_id=?").get(requestId) as Row | undefined;
      if (!receipt) throw new Error("发信收据完整性校验失败");
      const status = String(receipt.smtp_status) as MailSendReceiptStatus;
      if (status === "smtp_accepted") return { receiptId: String(receipt.id), requestId, replySourceId: receipt.reply_source_id == null ? null : String(receipt.reply_source_id), selectedTaskIds, replay: receiptResult(receipt) };
      if (status === "prepared") db.prepare("UPDATE mail_triage_send_receipts SET smtp_status='unknown' WHERE id=?").run(String(receipt.id));
      return { blocked: status === "failed" ? "failed" : "unknown" };
    }
    db.prepare("INSERT INTO mail_triage_requests(request_id,operation,canonical_input_hash,result_ref_json,created_at) VALUES(?,'mail.send',?,NULL,?)").run(requestId, inputHash, now);
    let binding: Binding | null = null;
    if (selectedTaskIds.length) {
      const caseId = uuid.parse(input.caseId), currentCase = db.prepare("SELECT version FROM mail_application_cases WHERE id=?").get(caseId) as Row | undefined;
      if (!currentCase) throw new Error("申请事项不存在");
      const sourceId = uuid.parse(input.replySourceId), source = authorizedSource(db, sourceId);
      if (!source || Number(source.mailbox_id) !== input.mailboxId) throw new Error("原收件邮箱来源已失效或未获授权");
      const tasks = selectedRows(db, caseId, selectedTaskIds).map((row) => {
        if (row.kind !== "reply") throw new Error("send_receipt_task_mismatch");
        return { id: String(row.id), version: Number(row.version), kind: "reply" as const, requestedItemsHash: hash(JSON.parse(String(row.requested_items_json))) };
      });
      binding = bindingSchema.parse({ v: 1, caseId, caseVersion: Number(currentCase.version), mailboxId: input.mailboxId, sourceId, sourceVersion: Number(source.source_version), tasks });
    }
    db.prepare(`INSERT INTO mail_triage_send_receipts(id,request_id,mailbox_id,reply_source_id,smtp_status,selected_task_ids_json,binding_json,created_at)
      VALUES(?,?,?,?,'prepared',?,?,?)`).run(receiptId, requestId, input.mailboxId, input.replySourceId, json(selectedTaskIds), binding == null ? null : json(binding), now);
    return { receiptId, requestId, replySourceId: input.replySourceId, selectedTaskIds };
  });
  if ("blocked" in outcome) throw new Error(outcome.blocked === "failed" ? "邮件未出站；请使用新的发送操作重试" : "发送状态未知，请核对后再决定，系统不会自动重发");
  return outcome;
}

function addAppendReview(db: DatabaseSync, receiptId: string, caseId: string, sourceId: string, now: number) {
  const source = authorizedSource(db, sourceId);
  if (!source) throw new Error("发信来源已失效");
  const provenance: Provenance = { supportSourceIds: [sourceId], kind: "source_derived", verifiedAt: null, reason: null };
  const eventId = randomUUID(), taskId = randomUUID(), slot = `${Number(source.source_version)}:send_append_review:${receiptId}`;
  db.prepare(`INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json)
    VALUES(?,?,?,?,'review_required',1,NULL,?,'[]',?) ON CONFLICT(case_id,source_id,event_slot) DO NOTHING`)
    .run(eventId, caseId, sourceId, slot, now, json(provenance));
  const persistedEvent = db.prepare("SELECT id FROM mail_case_events WHERE case_id=? AND source_id=? AND event_slot=?").get(caseId, sourceId, slot) as Row;
  db.prepare(`INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,state,title,requested_items_json,provenance_json)
    VALUES(?,?,?,?,'review',?,'open','发送成功，但未保存到已发送','[]',?) ON CONFLICT(case_id,event_id,obligation_key) DO NOTHING`)
    .run(taskId, caseId, String(persistedEvent.id), `sent_append_review:${receiptId}`, `sent_append_review:${receiptId}`, json(provenance));
}

function markSelectedRepliesAwaiting(db: DatabaseSync, receiptId: string, binding: Binding, now: number): boolean {
  const currentCase = db.prepare("SELECT version FROM mail_application_cases WHERE id=?").get(binding.caseId) as Row | undefined;
  const source = authorizedSource(db, binding.sourceId);
  if (!currentCase || Number(currentCase.version) !== binding.caseVersion || !source
    || Number(source.mailbox_id) !== binding.mailboxId || Number(source.source_version) !== binding.sourceVersion) return false;
  const rows = selectedRows(db, binding.caseId, binding.tasks.map((task) => task.id));
  for (const row of rows) {
    const frozen = binding.tasks.find((task) => task.id === row.id);
    if (!frozen || row.kind !== "reply" || Number(row.version) !== frozen.version
      || hash(JSON.parse(String(row.requested_items_json))) !== frozen.requestedItemsHash) return false;
  }
  for (const row of rows) db.prepare("UPDATE mail_case_tasks SET state='awaiting_external',version=version+1 WHERE id=? AND version=?").run(String(row.id), Number(row.version));
  db.prepare("UPDATE mail_application_cases SET manual_version=manual_version+1,updated_at=? WHERE id=?").run(now, binding.caseId);
  reprojectCases(db, { caseIds: [binding.caseId], now });
  // receiptId is intentionally the durable proof; no manual independent fact is synthesized.
  if (!db.prepare("SELECT 1 FROM mail_triage_send_receipts WHERE id=? AND smtp_status='smtp_accepted'").get(receiptId)) throw new Error("send_receipt_not_accepted");
  return true;
}

export function settleMailSendAccepted(db: DatabaseSync, input: {
  receiptId: string; caseId?: string; selectedTaskIds: string[]; messageId: string; appended: boolean; replySourceId: string | null;
}, now = Date.now()): MailSendReceiptResult {
  const settled = sourceTransaction(db, () => {
    const receipt = db.prepare("SELECT * FROM mail_triage_send_receipts WHERE id=?").get(input.receiptId) as Row | undefined;
    if (!receipt || !["prepared", "smtp_accepted"].includes(String(receipt.smtp_status))) throw new Error("发信收据状态冲突");
    if (receipt.smtp_status === "smtp_accepted") return { result: receiptResult(receipt), binding: receipt.binding_json };
    const selected = z.array(uuid).parse(JSON.parse(String(receipt.selected_task_ids_json)));
    if (json(selected) !== json(unique(input.selectedTaskIds)) || (receipt.reply_source_id ?? null) !== input.replySourceId) throw new Error("发信收据绑定冲突");
    const pending = selected.length > 0 || !input.appended;
    const code: MailSendReviewCode | null = !input.appended ? "sent_append_unconfirmed" : selected.length ? "task_outcome_pending" : null;
    db.prepare("UPDATE mail_triage_send_receipts SET smtp_status='smtp_accepted',message_id=?,appended=?,review_state=?,review_code=? WHERE id=?")
      .run(input.messageId, input.appended ? 1 : 0, pending ? "pending" : "none", code, input.receiptId);
    return { result: persistReceiptResult(db, input.receiptId), binding: receipt.binding_json };
  });
  if (settled.result.reviewState !== "pending" || !input.selectedTaskIds.length) return settled.result;
  // SMTP accepted 已经先持久化；义务 CAS/来源若在网络等待期间变化，只能留下待核对，绝不能把已接受降回可重发。
  let code: MailSendReviewCode = "task_binding_conflict";
  try {
    const applied = sourceTransaction(db, () => {
      const binding = parseBinding(settled.binding);
      if (binding.caseId !== input.caseId || binding.sourceId !== input.replySourceId || json(binding.tasks.map((task) => task.id).sort()) !== json(unique(input.selectedTaskIds))) return false;
      const ok = markSelectedRepliesAwaiting(db, input.receiptId, binding, now);
      if (ok && !input.appended) { addAppendReview(db, input.receiptId, binding.caseId, binding.sourceId, now); reprojectCases(db, { caseIds: [binding.caseId], now }); }
      return ok;
    });
    code = applied ? (input.appended ? "task_outcome_pending" : "sent_append_unconfirmed") : "task_binding_conflict";
    sourceTransaction(db, () => {
      db.prepare("UPDATE mail_triage_send_receipts SET review_state=?,review_code=? WHERE id=? AND smtp_status='smtp_accepted'")
        .run(applied && input.appended ? "cleared" : "pending", code, input.receiptId);
      persistReceiptResult(db, input.receiptId);
    });
  } catch {
    code = "task_projection_failed";
    sourceTransaction(db, () => {
      db.prepare("UPDATE mail_triage_send_receipts SET review_state='pending',review_code=? WHERE id=? AND smtp_status='smtp_accepted'").run(code, input.receiptId);
      persistReceiptResult(db, input.receiptId);
    });
  }
  return sourceTransaction(db, () => persistReceiptResult(db, input.receiptId));
}

export function settleMailSendFailure(db: DatabaseSync, receiptId: string, status: "failed" | "unknown") {
  sourceTransaction(db, () => {
    const changed = db.prepare("UPDATE mail_triage_send_receipts SET smtp_status=? WHERE id=? AND smtp_status='prepared'").run(status, receiptId);
    if (Number(changed.changes) !== 1) throw new Error("发信收据状态冲突");
  });
}

export function recordTaskOutcome(db: DatabaseSync, raw: {
  caseId: string; taskIds: string[]; outcome: "reply_sent" | "action_completed" | "dismissed" | "blocked"; sendReceiptId?: string; bounceSourceId?: string; completedItems?: string[]; evidenceNote?: string;
} & MutationMeta, actor: ServerActor, now = Date.now()): CaseProjection {
  const input = outcomeSchema.parse(raw), by = actorId(actor), taskIds = unique(input.taskIds);
  if (input.outcome === "blocked" && (taskIds.length !== 1 || !input.sendReceiptId || !input.bounceSourceId)) throw new Error("退信来源必须由人工确认并唯一匹配一项义务与发信收据");
  if (input.outcome === "action_completed" && taskIds.length !== 1) throw new Error("action_completed 每次只能履行一项动作义务");
  const inputHash = hash({ ...input, taskIds });
  return sourceTransaction(db, () => {
    const replay = db.prepare("SELECT canonical_input_hash,result_ref_json FROM mail_triage_requests WHERE request_id=? AND operation='mail.tasks.recordOutcome'").get(input.requestId) as Row | undefined;
    if (replay) {
      if (replay.canonical_input_hash !== inputHash) throw new Error("request_id_conflict");
      if (replay.result_ref_json == null) throw new Error("义务结果完整性校验失败");
      return PersistedProjectedCaseSchema.parse(JSON.parse(String(replay.result_ref_json)));
    }
    const caseRow = db.prepare("SELECT version,manual_version FROM mail_application_cases WHERE id=?").get(input.caseId) as Row | undefined;
    if (!caseRow || Number(caseRow.version) !== input.expectedVersion) throw new Error("version_conflict");
    const tasks = selectedRows(db, input.caseId, taskIds);
    let receipt: Row | undefined, binding: Binding | undefined;
    if (input.outcome === "reply_sent" || input.outcome === "blocked") {
      if (!input.sendReceiptId) throw new Error("reply_sent/blocked 必须提供可信本地发信收据");
      receipt = db.prepare("SELECT * FROM mail_triage_send_receipts WHERE id=? AND smtp_status='smtp_accepted'").get(input.sendReceiptId) as Row | undefined;
      const receiptSource = receipt?.reply_source_id == null ? undefined : authorizedSource(db, String(receipt.reply_source_id));
      if (!receipt || !receiptSource || Number(receipt.mailbox_id) !== Number(receiptSource.mailbox_id)) throw new Error("发信收据无效或来源已失效");
      binding = parseBinding(receipt.binding_json);
      if (binding.caseId !== input.caseId || binding.mailboxId !== Number(receipt.mailbox_id) || binding.sourceId !== String(receipt.reply_source_id)
        || binding.sourceVersion !== Number(receiptSource.source_version) || json(binding.tasks.map((task) => task.id).sort()) !== json(taskIds)) throw new Error("发信收据未精确绑定该来源/版本/回复义务");
      for (const task of tasks) {
        const frozen = binding.tasks.find((item) => item.id === task.id);
        const alreadyProjected = task.state === "awaiting_external" && Number(task.version) === Number(frozen?.version) + 1;
        if (task.kind !== "reply" || !frozen || (!alreadyProjected && Number(task.version) !== frozen.version)) throw new Error("发信收据任务版本不匹配");
      }
      if (!db.prepare("SELECT 1 FROM mail_case_sources WHERE case_id=? AND source_id=?").get(input.caseId, binding.sourceId)) throw new Error("发信收据来源不属于该申请事项");
      if (input.outcome === "blocked") {
        const bounceSourceId = input.bounceSourceId!;
        const bounce = authorizedSource(db, bounceSourceId);
        if (!bounce || bounce.trust !== "human_confirmed" || Number(bounce.mailbox_id) !== binding.mailboxId
          || !db.prepare("SELECT 1 FROM mail_case_sources WHERE case_id=? AND source_id=?").get(input.caseId, bounceSourceId)) throw new Error("退信来源不是当前有效的人工确认来源");
        const messages = db.prepare(`SELECT m.in_reply_to,m.references_json FROM mail_triage_source_aliases a
          JOIN mail_messages m ON m.mailbox_id=a.mailbox_id AND m.folder=a.folder AND m.uid_validity=a.uid_validity AND m.uid=a.uid
          WHERE a.source_id=? AND a.active=1 AND m.mailbox_id=?`).all(bounceSourceId, binding.mailboxId) as Row[];
        const matches = messages.some((message) => message.in_reply_to === receipt!.message_id
          || z.array(z.string()).catch([]).parse(JSON.parse(String(message.references_json))).includes(String(receipt!.message_id)));
        if (!matches) throw new Error("退信来源未与该发信收据唯一关联");
        const correlated = db.prepare(`SELECT count(DISTINCT r.id) AS n,min(r.id) AS id FROM mail_triage_send_receipts r
          WHERE r.mailbox_id=? AND r.smtp_status='smtp_accepted' AND r.message_id IS NOT NULL AND EXISTS(
            SELECT 1 FROM mail_triage_source_aliases a JOIN mail_messages m ON m.mailbox_id=a.mailbox_id AND m.folder=a.folder AND m.uid_validity=a.uid_validity AND m.uid=a.uid
            WHERE a.source_id=? AND a.active=1 AND (m.in_reply_to=r.message_id OR EXISTS(SELECT 1 FROM json_each(m.references_json) WHERE value=r.message_id)))`).get(binding.mailboxId, bounceSourceId) as Row;
        if (Number(correlated.n) !== 1 || correlated.id !== input.sendReceiptId) throw new Error("退信来源未唯一匹配该发信收据");
      }
    } else if (input.sendReceiptId || input.bounceSourceId) throw new Error("该结果不能附带发信/退信收据");
    if (input.outcome === "action_completed" && tasks[0]!.kind !== "action") throw new Error("action_completed 只能履行动作/材料义务");
    const nextState = input.outcome === "reply_sent" ? "awaiting_external" : input.outcome === "action_completed" ? "resolved_by_human" : input.outcome;
    const appliedVersion = Number(caseRow.manual_version) + 1;
    for (const task of tasks) {
      const provenance = provenanceSchema.parse(JSON.parse(String(task.provenance_json)));
      for (const sourceId of provenance.supportSourceIds) if (!authorizedSource(db, sourceId)) throw new Error("义务来源已失效");
      const requested = z.array(z.string()).parse(JSON.parse(String(task.requested_items_json)));
      const completed = input.outcome === "action_completed" ? unique(input.completedItems ?? requested) : [];
      if (input.outcome === "action_completed" && completed.some((item) => !requested.includes(item))) throw new Error("completedItems 必须是当前 requested 清单的精确子集");
      const remaining = input.outcome === "action_completed" ? requested.filter((item) => !completed.includes(item)) : requested;
      const state = input.outcome === "action_completed" && remaining.length ? "open" : nextState;
      const before = { state: task.state, version: Number(task.version), requestedItems: requested };
      const after = { state, version: Number(task.version) + 1, outcome: input.outcome, platformAccepted: false, sendReceiptId: input.sendReceiptId ?? null, bounceSourceId: input.bounceSourceId ?? null, completedItems: completed, remainingItems: remaining, evidenceNote: input.evidenceNote ?? null };
      const changed = db.prepare("UPDATE mail_case_tasks SET state=?,requested_items_json=?,version=version+1 WHERE id=? AND version=?").run(state, json(remaining), String(task.id), Number(task.version));
      if (Number(changed.changes) !== 1) throw new Error("task_version_conflict");
      db.prepare(`INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at)
        VALUES(?,?,?,?, 'task_outcome',?,?,?,?,?,?,?)`).run(randomUUID(), input.caseId, by, String(task.id), Number(task.version), appliedVersion, input.reason, json(before), json(after), json(provenance), now);
    }
    db.prepare("UPDATE mail_application_cases SET manual_version=?,updated_at=? WHERE id=?").run(appliedVersion, now, input.caseId);
    const projection = reprojectCases(db, { caseIds: [input.caseId], now })[0];
    if (!projection) throw new Error("申请事项不存在");
    const safe = PersistedProjectedCaseSchema.parse(projection);
    db.prepare("INSERT INTO mail_triage_requests(request_id,operation,canonical_input_hash,result_ref_json,created_at) VALUES(?,'mail.tasks.recordOutcome',?,?,?)").run(input.requestId, inputHash, json(safe), now);
    return safe;
  });
}
