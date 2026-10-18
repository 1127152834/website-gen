import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MailTransport, OutgoingMessage, SendResult } from "./mailbox-transport.ts";
import { MailSentAppendError } from "./mailbox-adapter.ts";
import { createMailboxService } from "./mailbox-service.ts";
import { createWorkspace } from "./index.ts";
import { reprojectCases } from "./mail-case-projector.ts";
import { prepareMailSend, recordTaskOutcome, settleMailSendAccepted } from "./mail-triage-send.ts";
import { ASSISTANT_EXCLUDED_METHODS } from "./assistant-tools.ts";
import { workspaceRpcRisk } from "./workspace-rpc-policy.ts";
import { key, setup } from "./testing.ts";
import { cachedParsedMessage, fingerprintSource } from "./mail-triage-source.ts";

const caseId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const replyTaskId = "33333333-3333-4333-8333-333333333333";
const uploadTaskId = "44444444-4444-4444-8444-444444444444";
const replyEventId = "55555555-5555-4555-8555-555555555555";
const uploadEventId = "66666666-6666-4666-8666-666666666666";
const readerRef={caseId,sourceId,sourceVersion:1,mailboxId:1,folder:"INBOX",uidValidity:"100",uid:7};
const actor = { userId: 17 };
const derived = JSON.stringify({ supportSourceIds: [sourceId], kind: "source_derived", verifiedAt: null, reason: null });

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function fixture() {
  const { db } = setup({ cachedMailbox: { password: "fixture" } });
  db.exec(`UPDATE mail_triage_settings SET enabled=1,state='enabled';
    INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(1,1,'authorized','100',0,0);`);
  db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,trust,observed_at) VALUES(?,1,'body','headers','human_confirmed',100)").run(sourceId);
  db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,attachments_json)
    VALUES(1,'INBOX',7,'100',?,?,'["support@nordicpaws.com"]','[]','APP-11 materials',90,'Please reply and upload passport',1,'<original@fixture>','[]','[]')`)
    .run(JSON.stringify("Applicant <applicant@example.test>"), JSON.stringify(["applicant@example.test"]));
  db.prepare("INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id) VALUES(1,'INBOX','100',7,?)").run(sourceId);
  const cached=db.prepare("SELECT * FROM mail_messages WHERE mailbox_id=1 AND folder='INBOX' AND uid=7").get() as Record<string,unknown>,fingerprints=fingerprintSource(key,cachedParsedMessage(cached));
  db.prepare("UPDATE mail_triage_sources SET source_hash=?,critical_headers_hash=? WHERE id=?").run(fingerprints.sourceHash,fingerprints.criticalHeadersHash,sourceId);
  db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,version,manual_version) VALUES(?,'confirmed','Fixture','APP-11',?,'{}',1,0)")
    .run(caseId, JSON.stringify({ supportSourceIds: [], kind: "independent_manual", verifiedAt: 1, reason: "fixture identity" }));
  db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'fixture')").run(caseId, sourceId);
  db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:reply','request_reply',1,100,'[]',?)")
    .run(replyEventId, caseId, sourceId, derived);
  db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:upload','request_action',1,100,'[]',?)")
    .run(uploadEventId, caseId, sourceId, derived);
  db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,requested_items_json,provenance_json) VALUES(?,?,?,'reply','reply','reply','回复申请问题','[]',?)")
    .run(replyTaskId, caseId, replyEventId, derived);
  db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,requested_items_json,provenance_json) VALUES(?,?,?,'passport','action','passport','上传护照','[\"passport\"]',?)")
    .run(uploadTaskId, caseId, uploadEventId, derived);
  transaction(db, () => reprojectCases(db, { caseIds: [caseId], now: 100 }));
  return db;
}

class SendTransport implements MailTransport {
  dispatches = 0;
  sent: OutgoingMessage[] = [];
  beforeDispatch?: () => void;
  failure?: unknown;
  async verify() {}
  async listFolders() { return []; }
  async fetchMessages() { return []; }
  async fetchMessage() { return null; }
  async setSeen() {}
  async moveToTrash() {}
  async downloadAttachment() { return Buffer.alloc(0); }
  async idle() {}
  async send(_credentials: { address: string; password: string }, message: OutgoingMessage): Promise<SendResult> {
    this.dispatches += 1;
    this.beforeDispatch?.();
    this.sent.push(message);
    if (this.failure) throw this.failure;
    return { messageId: message.messageId, appended: true };
  }
}

function serviceFixture(transport = new SendTransport()) {
  const db = fixture();
  const service = createMailboxService({ db, key, accounts: () => [], transport: () => transport, push: () => {} });
  return { db, service, transport };
}

test("B06/B07/B22/B23 prepares before SMTP, replays one exact request, and only advances selected reply", async () => {
  const { db, service, transport } = serviceFixture();
  try {
    assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(replyTaskId)!.state, "open");
    transport.beforeDispatch = () => assert.equal(db.prepare("SELECT smtp_status FROM mail_triage_send_receipts WHERE request_id=?").get(requestId)!.smtp_status, "prepared");
    const requestId = randomUUID();
    const input = { mailboxId: 1, to: ["ignored@example.test"], subject: "", text: "Verbatim reply", mode: "reply" as const,
      replyTo: { folder: "INBOX", uid: 7, readerRef }, requestId, caseId, selectedTaskIds: [replyTaskId] };
    const first = await service.send(input), replay = await service.send(input);
    assert.deepEqual(replay, first);
    assert.equal(transport.dispatches, 1);
    assert.equal(first.sendReceiptId, db.prepare("SELECT id FROM mail_triage_send_receipts WHERE request_id=?").get(requestId)!.id);
    assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(replyTaskId)!.state, "awaiting_external");
    assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(uploadTaskId)!.state, "open");
    assert.match(transport.sent[0]!.text, /--- 原始邮件 ---[\s\S]*Please reply and upload passport/);
    await assert.rejects(service.send({ ...input, text: "different content" }), /request.*conflict|不同内容/i);
  } finally { await service.close(); db.close(); }
});

test("B24 unknown SMTP result is durable and the same request is never automatically re-sent", async () => {
  const { db, service, transport } = serviceFixture();
  const requestId = randomUUID();
  transport.failure = new Error("socket closed after DATA");
  try {
    const input = { mailboxId: 1, to: ["applicant@example.test"], subject: "Re: APP-11", text: "reply", mode: "reply" as const, replyTo: { folder: "INBOX", uid: 7, readerRef }, requestId, caseId, selectedTaskIds: [replyTaskId] };
    await assert.rejects(service.send(input), /发送状态未知/);
    assert.equal(db.prepare("SELECT smtp_status FROM mail_triage_send_receipts WHERE request_id=?").get(requestId)!.smtp_status, "unknown");
    await assert.rejects(service.send(input), /发送状态未知/);
    assert.equal(transport.dispatches, 1);
    assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(replyTaskId)!.state, "open");
  } finally { await service.close(); db.close(); }
});

test("B24 a prepared receipt left by a crash becomes unknown and cannot dispatch on replay", () => {
  const db = fixture(), requestId = randomUUID();
  try {
    prepareMailSend(db, { requestId, mailboxId: 1, replySourceId: null, canonicalContent: { to: ["one@example.test"], text: "same" } }, 100);
    assert.throws(() => prepareMailSend(db, { requestId, mailboxId: 1, replySourceId: null, canonicalContent: { to: ["one@example.test"], text: "same" } }, 101), /发送状态未知/);
    assert.equal(db.prepare("SELECT smtp_status FROM mail_triage_send_receipts WHERE request_id=?").get(requestId)!.smtp_status, "unknown");
  } finally { db.close(); }
});

test("B24 a proven zero-dispatch failure is recorded separately and requires a new operation", async () => {
  const { db, service, transport } = serviceFixture();
  const requestId = randomUUID(), failure = new Error("DNS lookup rejected before connect") as Error & { dispatched: false };
  failure.dispatched = false; transport.failure = failure;
  const input = { mailboxId: 1, to: ["applicant@example.test"], subject: "reply", text: "reply", mode: "reply" as const, replyTo: { folder: "INBOX", uid: 7, readerRef }, requestId, caseId, selectedTaskIds: [replyTaskId] };
  try {
    await assert.rejects(service.send(input), /未出站/);
    assert.equal(db.prepare("SELECT smtp_status FROM mail_triage_send_receipts WHERE request_id=?").get(requestId)!.smtp_status, "failed");
    await assert.rejects(service.send(input), /新的发送操作/);
    assert.equal(transport.dispatches, 1);
  } finally { await service.close(); db.close(); }
});

test("same in-flight requestId with different content conflicts instead of joining the first SMTP", async () => {
  const { db, service, transport } = serviceFixture();
  const requestId = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const originalSend = transport.send.bind(transport);
  transport.send = async (...args) => { await gate; return originalSend(...args); };
  const base = { mailboxId: 1, to: ["applicant@example.test"], subject: "reply", text: "first", mode: "reply" as const, replyTo: { folder: "INBOX", uid: 7, readerRef }, requestId, caseId, selectedTaskIds: [replyTaskId] };
  try {
    const first = service.send(base);
    await assert.rejects(service.send({ ...base, text: "different" }), /request_id_conflict/);
    release(); await first;
    assert.equal(transport.dispatches, 1);
  } finally { release(); await service.close(); db.close(); }
});

test("B24 SMTP accepted with Sent append failure advances selected reply and adds a separate review", async () => {
  const { db, service, transport } = serviceFixture();
  const requestId = randomUUID();
  transport.failure = new MailSentAppendError("<accepted@fixture>", new Error("append unavailable"));
  try {
    await assert.rejects(service.send({ mailboxId: 1, to: ["applicant@example.test"], subject: "reply", text: "reply", requestId, caseId, selectedTaskIds: [replyTaskId], replyTo: { folder: "INBOX", uid: 7, readerRef }, mode: "reply" }), /发送成功，但未保存到已发送/);
    const receipt = db.prepare("SELECT smtp_status,message_id,appended,review_state,review_code FROM mail_triage_send_receipts WHERE request_id=?").get(requestId)!;
    assert.deepEqual({ ...receipt }, { smtp_status: "smtp_accepted", message_id: "<accepted@fixture>", appended: 0, review_state: "pending", review_code: "sent_append_unconfirmed" });
    assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(replyTaskId)!.state, "awaiting_external");
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_tasks WHERE case_id=? AND kind='review' AND state='open'").get(caseId)!.n, 1);
    await assert.rejects(service.send({ mailboxId: 1, to: ["applicant@example.test"], subject: "reply", text: "reply", requestId, caseId, selectedTaskIds: [replyTaskId], replyTo: { folder: "INBOX", uid: 7, readerRef }, mode: "reply" }), /发送成功，但未保存到已发送/);
    assert.equal(transport.dispatches, 1);
  } finally { await service.close(); db.close(); }
});

test("B43 a selected case reply must use its original active receiving mailbox/source identity", async () => {
  const { db, service } = serviceFixture();
  try {
    db.prepare("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,status,credential_ciphertext,monitoring) SELECT 2,account_id,'other','other','other@example.test','example.test',status,credential_ciphertext,0 FROM mailboxes WHERE id=1").run();
    await assert.rejects(service.send({ mailboxId: 2, to: ["applicant@example.test"], subject: "reply", text: "reply", requestId: randomUUID(), caseId, selectedTaskIds: [replyTaskId], replyTo: { folder: "INBOX", uid: 7, readerRef }, mode: "reply" }), /原收件邮箱|来源/i);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_send_receipts").get()!.n, 0);
  } finally { await service.close(); db.close(); }
});

test("R20/B43 full reader binding is rechecked before quoting and stale reused UID causes zero SMTP",async()=>{
  const bind=(db:DatabaseSync)=>{const row=db.prepare("SELECT * FROM mail_messages WHERE mailbox_id=1 AND folder='INBOX' AND uid=7").get() as Record<string,unknown>,fingerprint=fingerprintSource(key,cachedParsedMessage(row));db.prepare("UPDATE mail_triage_sources SET source_hash=?,critical_headers_hash=? WHERE id=?").run(fingerprint.sourceHash,fingerprint.criticalHeadersHash,sourceId);};
  const good=serviceFixture();
  try{
    bind(good.db);
    await good.service.send({mailboxId:1,to:["ignored@example.test"],subject:"",text:"Bound reply",mode:"reply",replyTo:{folder:"INBOX",uid:7,readerRef},requestId:randomUUID(),caseId,selectedTaskIds:[replyTaskId]});
    assert.equal(good.transport.dispatches,1);
    assert.equal(good.db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(replyTaskId)!.state,"awaiting_external");
    assert.equal(good.db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(uploadTaskId)!.state,"open");
  }finally{await good.service.close();good.db.close();}
  const stale=serviceFixture();
  try{
    bind(stale.db);stale.db.prepare("UPDATE mail_messages SET body_text='replacement reused UID' WHERE mailbox_id=1 AND folder='INBOX' AND uid=7").run();
    await assert.rejects(stale.service.send({mailboxId:1,to:["ignored@example.test"],subject:"",text:"Must not dispatch",mode:"reply",replyTo:{folder:"INBOX",uid:7,readerRef},requestId:randomUUID(),caseId,selectedTaskIds:[replyTaskId]}),/source_unavailable|来源/);
    assert.equal(stale.transport.dispatches,0);assert.equal(stale.db.prepare("SELECT count(*) n FROM mail_triage_send_receipts").get()!.n,0);
  }finally{await stale.service.close();stale.db.close();}
});

test("R26 selected reply requires a complete reader capability before receipt or SMTP while legacy reply remains compatible",async()=>{
  const selected=serviceFixture();
  try{
    await assert.rejects(selected.service.send({mailboxId:1,to:["ignored@example.test"],subject:"",text:"Must not dispatch",mode:"reply",replyTo:{folder:"INBOX",uid:7},requestId:randomUUID(),caseId,selectedTaskIds:[replyTaskId]}),/完整来源|reader|来源绑定/i);
    assert.equal(selected.transport.dispatches,0);
    assert.equal(selected.db.prepare("SELECT count(*) n FROM mail_triage_send_receipts").get()!.n,0);
  }finally{await selected.service.close();selected.db.close();}
  const legacy=serviceFixture();
  try{
    await legacy.service.send({mailboxId:1,to:["ignored@example.test"],subject:"",text:"Legacy reply",mode:"reply",replyTo:{folder:"INBOX",uid:7},requestId:randomUUID()});
    assert.equal(legacy.transport.dispatches,1);
  }finally{await legacy.service.close();legacy.db.close();}
});

test("recordTaskOutcome is CAS/idempotent, task-specific, server-actor audited, and does not claim platform acceptance", () => {
  const db = fixture();
  try {
    const requestId = randomUUID();
    const input = { caseId, taskIds: [uploadTaskId], outcome: "action_completed" as const, requestId, expectedVersion: 1, reason: "我已在外部页面上传护照", evidenceNote: "仅确认我方上传动作" };
    const first = recordTaskOutcome(db, input, actor, 200), replay = recordTaskOutcome(db, input, actor, 201);
    assert.deepEqual(replay, first);
    assert.equal(first.tasks.find((task) => task.id === uploadTaskId)!.state, "resolved_by_human");
    assert.equal(first.tasks.find((task) => task.id === replyTaskId)!.state, "open");
    const audit = db.prepare("SELECT actor,provenance_json,after_json FROM mail_case_manual_decisions WHERE object_id=? AND field='task_outcome'").get(uploadTaskId)!;
    assert.equal(audit.actor, "user:17");
    assert.equal(JSON.parse(String(audit.provenance_json)).kind, "source_derived");
    assert.equal(JSON.parse(String(audit.after_json)).platformAccepted, false);
    assert.throws(() => recordTaskOutcome(db, { ...input, requestId: randomUUID() }, actor, 202), /version_conflict/);
  } finally { db.close(); }
});

test("R18 action completion applies only an exact action subset and keeps remaining items open", () => {
  const db = fixture();
  try {
    db.prepare("UPDATE mail_case_tasks SET requested_items_json='[\"passport\",\"portrait\"]' WHERE id=?").run(uploadTaskId);
    const result = recordTaskOutcome(db, { caseId, taskIds: [uploadTaskId], outcome: "action_completed", completedItems: ["passport"], requestId: randomUUID(), expectedVersion: 1, reason: "已上传护照" }, actor, 200);
    const row = db.prepare("SELECT state,requested_items_json FROM mail_case_tasks WHERE id=?").get(uploadTaskId)!;
    assert.deepEqual({ ...row }, { state: "open", requested_items_json: '["portrait"]' });
    assert.equal(result.tasks.find((task) => task.id === uploadTaskId)!.state, "open");
    assert.throws(() => recordTaskOutcome(db, { caseId, taskIds: [replyTaskId], outcome: "action_completed", completedItems: ["passport"], requestId: randomUUID(), expectedVersion: result.version, reason: "wrong" }, actor, 201), /action|材料|义务/i);
    assert.throws(() => recordTaskOutcome(db, { caseId, taskIds: [uploadTaskId], outcome: "action_completed", completedItems: ["not-requested"], requestId: randomUUID(), expectedVersion: result.version, reason: "wrong" }, actor, 201), /subset|清单|requested|未请求/i);
  } finally { db.close(); }
});

test("R18 accepted receipt keeps immutable binding, durable review state, and replay never resends", async () => {
  const { db, service, transport } = serviceFixture();
  const requestId = randomUUID();
  try {
    transport.beforeDispatch = () => db.prepare("UPDATE mail_case_tasks SET version=version+1 WHERE id=?").run(replyTaskId);
    const input = { mailboxId: 1, to: ["applicant@example.test"], subject: "reply", text: "BODY-TOKEN-DO-NOT-BIND", mode: "reply" as const, replyTo: { folder: "INBOX", uid: 7, readerRef }, requestId, caseId, selectedTaskIds: [replyTaskId] };
    const first = await service.send(input);
    assert.equal(first.reviewState, "pending");
    assert.equal(first.reviewCode, "task_binding_conflict");
    const receipt = db.prepare("SELECT binding_json,review_state,review_code FROM mail_triage_send_receipts WHERE request_id=?").get(requestId)!;
    assert.equal(receipt.review_state, "pending");
    assert.equal(receipt.review_code, "task_binding_conflict");
    assert.doesNotMatch(String(receipt.binding_json), /BODY-TOKEN|Please reply|passport/i);
    assert.equal((JSON.parse(String(receipt.binding_json)).tasks as unknown[]).length, 1);
    assert.deepEqual(await service.send(input), first);
    assert.equal(transport.dispatches, 1);
  } finally { await service.close(); db.close(); }
});

test("reply_sent requires the real writer's exact immutable source/task binding", () => {
  const db = fixture();
  try {
    const requestId = randomUUID();
    const prepared = prepareMailSend(db, { requestId: randomUUID(), mailboxId: 1, caseId, selectedTaskIds: [replyTaskId], replySourceId: sourceId, canonicalContent: { digest: "fixture" } }, 100);
    const accepted = settleMailSendAccepted(db, { receiptId: prepared.receiptId, caseId, selectedTaskIds: [replyTaskId], messageId: "<sent@fixture>", appended: true, replySourceId: sourceId }, 101);
    const receiptId = accepted.sendReceiptId;
    const expectedVersion = Number(db.prepare("SELECT version FROM mail_application_cases WHERE id=?").get(caseId)!.version);
    const result = recordTaskOutcome(db, { caseId, taskIds: [replyTaskId], outcome: "reply_sent", sendReceiptId: receiptId, requestId, expectedVersion, reason: "确认本次回复履行该回复义务" }, actor, 200);
    assert.equal(result.tasks.find((task) => task.id === replyTaskId)!.state, "awaiting_external");
    assert.equal(result.tasks.find((task) => task.id === uploadTaskId)!.state, "open");
    assert.throws(() => recordTaskOutcome(db, { caseId, taskIds: [uploadTaskId], outcome: "reply_sent", sendReceiptId: receiptId, requestId: randomUUID(), expectedVersion: result.version, reason: "wrong" }, actor, 201), /reply|收据|义务/i);
  } finally { db.close(); }
});

test("B25 blocked outcome requires one specifically matched obligation", () => {
  const db = fixture();
  try {
    assert.throws(() => recordTaskOutcome(db, { caseId, taskIds: [replyTaskId, uploadTaskId], outcome: "blocked", requestId: randomUUID(), expectedVersion: 1, reason: "退信", evidenceNote: "明确退信" }, actor, 200), /唯一|一项/);
    assert.throws(() => recordTaskOutcome(db, { caseId, taskIds: [replyTaskId], outcome: "blocked", requestId: randomUUID(), expectedVersion: 1, reason: "退信", evidenceNote: "正文声称退信" }, actor, 200), /退信来源|收据|bounce/i);
    const prepared = prepareMailSend(db, { requestId: randomUUID(), mailboxId: 1, caseId, selectedTaskIds: [replyTaskId], replySourceId: sourceId, canonicalContent: { digest: "fixture" } }, 100);
    settleMailSendAccepted(db, { receiptId: prepared.receiptId, caseId, selectedTaskIds: [replyTaskId], messageId: "<sent-for-bounce@fixture>", appended: true, replySourceId: sourceId }, 101);
    const bounceSourceId = "77777777-7777-4777-8777-777777777777";
    db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,trust,observed_at) VALUES(?,1,'bounce','bounce-headers','human_confirmed',150)").run(bounceSourceId);
    db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,in_reply_to,attachments_json)
      VALUES(1,'INBOX',8,'100','\"Mailer Daemon\"','[\"mailer-daemon@example.test\"]','[]','[]','Delivery failure',140,'claimed bounce',1,'<bounce@fixture>','[\"<sent-for-bounce@fixture>\"]','<sent-for-bounce@fixture>','[]')`).run();
    db.prepare("INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id) VALUES(1,'INBOX','100',8,?)").run(bounceSourceId);
    db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'human-confirmed-bounce')").run(caseId, bounceSourceId);
    const currentVersion = Number(db.prepare("SELECT version FROM mail_application_cases WHERE id=?").get(caseId)!.version);
    const result = recordTaskOutcome(db, { caseId, taskIds: [replyTaskId], outcome: "blocked", sendReceiptId: prepared.receiptId, bounceSourceId, requestId: randomUUID(), expectedVersion: currentVersion, reason: "人工确认该退信来源并与本次收据唯一匹配" }, actor, 200);
    assert.equal(result.tasks.find((task) => task.id === replyTaskId)!.state, "blocked");
    assert.equal(result.tasks.find((task) => task.id === uploadTaskId)!.state, "open");
  } finally { db.close(); }
});

test("actual workspace RPC is confirm-risk, assistant-excluded, strict, and rejects client-forged authority", async () => {
  assert.equal(workspaceRpcRisk("mail.tasks.recordOutcome"), "confirm");
  assert.match(ASSISTANT_EXCLUDED_METHODS["mail.tasks.recordOutcome"] ?? "", /用户|专用界面/);
  const directory = mkdtempSync(join(tmpdir(), "mail-triage-outcome-rpc-"));
  const workspace = createWorkspace({
    userDir: directory, key: Buffer.alloc(32, 7), ownerUserId: 17,
    dependencies: { mailTransport: () => new SendTransport(), hostingerPool: { forAccount: () => async () => [], close: async () => {}, closeAll: async () => [] } },
  });
  try {
    assert.throws(() => workspace.handlers["mail.tasks.recordOutcome"]({
      caseId, taskIds: [replyTaskId], outcome: "dismissed", requestId: randomUUID(), expectedVersion: 1, reason: "fixture", actor: { userId: 999 },
    }), /身份只能来自服务端会话/);
    await assert.rejects(Promise.resolve(workspace.handlers["mail.tasks.recordOutcome"]({
      caseId, taskIds: [replyTaskId], outcome: "dismissed", requestId: randomUUID(), expectedVersion: 1, reason: "fixture", extra: true,
    })), /unrecognized|不存在|Invalid input|参数/i);
  } finally {
    await workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
