import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createMailboxService } from "./mailbox-service.ts";
import { createMailTriageService } from "./mail-triage-service.ts";
import { registerCachedSource } from "./mail-triage-source.ts";
import { reprojectCases } from "./mail-case-projector.ts";
import { key, setup } from "./testing.ts";
import type { TriageWorker } from "./mail-triage-worker.ts";
import { workspaceRpcRisk } from "./workspace-rpc-policy.ts";
import { ASSISTANT_EXCLUDED_METHODS } from "./assistant-tools.ts";
import { registerNotificationAudit } from "./mail-triage-evaluation.ts";

const derived = (ids: string[]) => ({ supportSourceIds: ids, kind: "source_derived" as const, verifiedAt: null, reason: null });
const parsed = (text = "Please upload the bank statement") => ({
  messageId: "<task14@example.test>", from: "Zen Payments <review@example.test>", fromAddresses: ["review@example.test"],
  to: ["support@nordicpaws.com"], cc: [], subject: "Application update", date: 200, text, snippet: text,
  inReplyTo: null, references: [], attachments: [], bodyComplete: true, bodyIssue: null,
});

function fixture() {
  const { db } = setup({ cachedMailbox: { password: "fixture" } });
  db.exec("UPDATE mail_triage_settings SET enabled=1,state='enabled',config_epoch=1; INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(1,1,'authorized','uv-14',0,1)");
  const mail = parsed();
  db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,snippet,body_text,body_complete,message_id,references_json,attachments_json)
    VALUES(1,'INBOX',14,'uv-14',?,? ,?,'[]','Application update',200,?,?,1,'<task14@example.test>','[]','[]')`).run(JSON.stringify(mail.from),JSON.stringify(mail.fromAddresses),JSON.stringify(mail.to),mail.snippet, mail.text);
  const source = registerCachedSource(db, { locator: { mailboxId: 1, folder: "INBOX", uidValidity: "uv-14", uid: 14 }, mail, observedAt: 210 }, key);
  const caseId = randomUUID(), eventId = randomUUID(), taskId = randomUUID();
  db.prepare("INSERT INTO mail_application_cases(id,identity_state,site_id,provider,application_identity,identity_provenance_json,created_at,updated_at) VALUES(?,'confirmed',NULL,'Zen Payments','APP-14',?,1,210)").run(caseId, JSON.stringify(derived([source.sourceId])));
  db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'fixture')").run(caseId, source.sourceId);
  db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:request','request_action',1,200,210,?,?)")
    .run(eventId, caseId, source.sourceId, JSON.stringify([{ sourceId: source.sourceId, quote: "upload the bank statement" }]), JSON.stringify(derived([source.sourceId])));
  db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,requested_items_json,provenance_json) VALUES(?,?,?,'upload','action','bank statement','上传银行账单','[" + '"银行账单"' + "]',?)")
    .run(taskId, caseId, eventId, JSON.stringify(derived([source.sourceId])));
  db.exec("BEGIN IMMEDIATE"); try { reprojectCases(db, { caseIds: [caseId], now: 220 }); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
  const mailboxes = createMailboxService({ db, key, accounts: () => [], readOnly: true, push() {} });
  const worker: TriageWorker = { start() {}, wake() {}, abortSources() {}, stopAccepting() {}, async close() {} };
  const service = createMailTriageService({ db, key, mailboxes, worker, clock: () => 300, push() {}, readOnly: false, actor: { userId: 7 } });
  return { db, mailboxes, service, caseId, sourceId: source.sourceId, taskId };
}

test("R20 case DTO exposes only server-projected board/detail display fields", () => {
  const f = fixture();
  try {
    const card = f.service.casesList({}).items[0]!;
    assert.equal(card.provider, "Zen Payments");
    assert.equal(card.applicationId, "APP-14");
    assert.equal(card.mailboxAddress, "support@nordicpaws.com");
    assert.equal(card.mailboxCount, 1);
    assert.equal(card.openTaskCount, 1);
    assert.match(card.tag, /^\p{Script=Han}{2,6}$/u);
    assert.equal(card.latestValidAt, 210);
    const detail = f.service.caseDetail({ caseId: f.caseId })!;
    assert.equal(detail.timeline[0]?.sourceId, f.sourceId);
    assert.equal(detail.evidence[0]?.sourceId, f.sourceId);
    assert.equal(detail.currentCycle.cycle, 1);
    assert.ok(detail.sources[0]?.readerRef);
    assert.equal(JSON.stringify(detail).includes("source_hash"), false);
  } finally { f.db.close(); }
});

test("R20 source reader is cache-only and rejects wrong case/version/generation/fingerprint/lifecycle", () => {
  const f = fixture();
  try {
    const detail = f.service.caseDetail({ caseId: f.caseId })!;
    const ref = detail.sources[0]!.readerRef!;
    const read = f.mailboxes.sourceMessage(ref);
    assert.equal(read.message.text, "Please upload the bank statement");
    assert.deepEqual(read.ref, ref);
    assert.throws(() => f.mailboxes.sourceMessage({ ...ref, caseId: randomUUID() }), /source_unavailable/);
    assert.throws(() => f.mailboxes.sourceMessage({ ...ref, sourceVersion: ref.sourceVersion + 1 }), /source_unavailable/);
    f.db.prepare("UPDATE mail_messages SET body_text='replacement body' WHERE mailbox_id=1 AND folder='INBOX' AND uid=14").run();
    assert.throws(() => f.mailboxes.sourceMessage(ref), /source_unavailable/);
    assert.equal(f.service.caseDetail({ caseId: f.caseId })!.sources[0]!.readerRef, null);
    f.db.prepare("UPDATE mail_messages SET body_text='Please upload the bank statement',uid_validity='uv-reused' WHERE mailbox_id=1 AND folder='INBOX' AND uid=14").run();
    assert.throws(() => f.mailboxes.sourceMessage(ref), /source_unavailable/);
    f.db.prepare("UPDATE mail_messages SET uid_validity='uv-14' WHERE mailbox_id=1 AND folder='INBOX' AND uid=14").run();
    f.db.prepare("UPDATE mail_messages SET subject='replacement header' WHERE mailbox_id=1 AND folder='INBOX' AND uid=14").run();
    assert.throws(() => f.mailboxes.sourceMessage(ref), /source_unavailable/);
    f.db.prepare("UPDATE mail_messages SET subject='Application update' WHERE mailbox_id=1 AND folder='INBOX' AND uid=14").run();
    f.db.prepare("UPDATE mail_triage_scope SET state='revoked' WHERE mailbox_id=1").run();
    assert.throws(() => f.mailboxes.sourceMessage(ref), /source_unavailable/);
    f.db.prepare("UPDATE mail_triage_scope SET state='authorized' WHERE mailbox_id=1").run();
    f.db.prepare("UPDATE mailboxes SET status='closed' WHERE id=1").run();
    assert.throws(() => f.mailboxes.sourceMessage(ref), /source_unavailable/);
    f.db.prepare("UPDATE mailboxes SET status='active' WHERE id=1").run();
    f.db.prepare("UPDATE mail_triage_source_aliases SET active=0 WHERE source_id=?").run(f.sourceId);
    assert.throws(() => f.mailboxes.sourceMessage(ref), /source_unavailable/);
  } finally { f.db.close(); }
});

test("R20 source reader RPC is read-only policy and excluded from the general assistant",()=>{
  assert.equal(workspaceRpcRisk("mail.cases.sourceMessage"),"read");
  assert.match(ASSISTANT_EXCLUDED_METHODS["mail.cases.sourceMessage"]??"",/专用|不暴露/);
});

test("R22 review rows stay lightweight and source preview reuses the strict cached binding",()=>{
  const f=fixture();
  try{
    const page=f.service.reviewQueue({filter:"unreviewed",page:1,pageSize:30});
    const row=page.items[0]!;
    assert.equal(row.mailboxAddress,"support@nordicpaws.com");
    assert.equal(row.sourceVersion,1);
    assert.equal(row.readerRef?.caseId,f.caseId);
    assert.equal("message" in row,false,"30-row queue must not embed full bodies");
    assert.equal("evidence" in row,false,"30-row queue must not embed evidence quotes");
    const preview=f.mailboxes.sourcePreview({sourceId:f.sourceId,sourceVersion:1});
    assert.equal(preview.message.text,"Please upload the bank statement");
    assert.deepEqual(preview.readerRef,row.readerRef);
    assert.throws(()=>f.mailboxes.sourcePreview({sourceId:f.sourceId,sourceVersion:2}),/source_unavailable/);
    f.db.prepare("UPDATE mail_triage_scope SET state='revoked' WHERE mailbox_id=1").run();
    assert.throws(()=>f.mailboxes.sourcePreview({sourceId:f.sourceId,sourceVersion:1}),/source_unavailable/);
  }finally{f.db.close();}
});

test("Task15 Fix1 malformed assessment is explicit and retains its real manual clock",()=>{
  const f=fixture();
  try{
    f.db.prepare("UPDATE mail_triage_sources SET trust='human_confirmed' WHERE id=?").run(f.sourceId);
    f.service.correct({requestId:randomUUID(),expectedVersion:0,reason:"fixture source correction",target:{type:"source",id:f.sourceId,sourceVersion:1},field:"sourceTrust",value:"unconfirmed"});
    const jobId=randomUUID();
    f.db.prepare("INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,config_epoch,state,created_at,updated_at) VALUES(?,?,1,1,'fixture',1,1,1,1,'fix1',1,'needs_review',1,250)").run(jobId,f.sourceId);
    f.db.prepare("INSERT INTO mail_triage_assessments(id,job_id,source_id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,prompt_hash,validated_json,support_source_ids_json,grade,created_at) VALUES(?,?,?,1,'fixture',1,1,1,1,'hash','{}',?,'needs_review',250)").run(randomUUID(),jobId,f.sourceId,JSON.stringify([f.sourceId]));
    const row=f.service.reviewQueue({filter:"review",page:1,pageSize:30}).items[0]!;
    assert.match(row.displayError??"",/数据完整性错误：预审评估/);
    assert.equal(row.manualVersion,1);
    assert.equal(row.tag,null);
    assert.equal("evidence" in row,false);
    const preview=f.service.sourcePreview({sourceId:f.sourceId,sourceVersion:1});
    assert.match(preview.displayError??"",/数据完整性错误：预审评估/);
    assert.equal(preview.message.text,"Please upload the bank statement");
  }finally{f.db.close();}
});

test("Fix1 status and review queue expose only the current authorized source set",()=>{
  const f=fixture();
  const visible=()=>({count:f.service.status().unreviewedMailCount,rows:f.service.reviewQueue({filter:"unreviewed",page:1,pageSize:30}).total});
  try{
    assert.deepEqual(visible(),{count:1,rows:1});
    f.db.prepare("UPDATE mail_triage_scope SET state='revoked' WHERE mailbox_id=1").run();assert.deepEqual(visible(),{count:0,rows:0});
    f.db.prepare("UPDATE mail_triage_scope SET state='authorized' WHERE mailbox_id=1").run();
    f.db.prepare("UPDATE mail_triage_settings SET enabled=0,state='disabled' WHERE id=1").run();assert.deepEqual(visible(),{count:0,rows:0});
    f.db.prepare("UPDATE mail_triage_settings SET enabled=1,state='enabled' WHERE id=1").run();
    f.db.prepare("UPDATE mailboxes SET status='closed' WHERE id=1").run();assert.deepEqual(visible(),{count:0,rows:0});
    f.db.prepare("UPDATE mailboxes SET status='active' WHERE id=1").run();
    f.db.prepare("INSERT INTO abandoned_domains(domain,abandoned_at) VALUES('nordicpaws.com',1)").run();assert.deepEqual(visible(),{count:0,rows:0});
    f.db.prepare("DELETE FROM abandoned_domains WHERE domain='nordicpaws.com'").run();
    f.db.prepare("UPDATE mail_triage_scope SET uid_validity='different-generation' WHERE mailbox_id=1").run();assert.deepEqual(visible(),{count:0,rows:0});
    f.db.prepare("UPDATE mail_triage_scope SET uid_validity='uv-14' WHERE mailbox_id=1").run();
    f.db.prepare("UPDATE mail_triage_source_aliases SET active=0 WHERE source_id=?").run(f.sourceId);assert.deepEqual(visible(),{count:0,rows:0});
  }finally{f.db.close();}
});

test("Fix1 detail fails closed for unauthorized events or malformed manual provenance and retains strict independent events",()=>{
  const f=fixture();
  try{
    const mail=parsed("second body");
    f.db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,snippet,body_text,body_complete,message_id,references_json,attachments_json) VALUES(1,'INBOX',15,'uv-14',?,?,?,'[]','Second',201,?,?,1,'<second@example.test>','[]','[]')`).run(JSON.stringify(mail.from),JSON.stringify(mail.fromAddresses),JSON.stringify(mail.to),mail.snippet,mail.text);
    const second=registerCachedSource(f.db,{locator:{mailboxId:1,folder:"INBOX",uidValidity:"uv-14",uid:15},mail:{...mail,messageId:"<second@example.test>",subject:"Second",date:201},observedAt:211},key);
    const eventId=randomUUID();
    f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:foreign','notification',1,201,211,?,?)").run(eventId,f.caseId,second.sourceId,JSON.stringify([{sourceId:f.sourceId,quote:"safe"}]),JSON.stringify(derived([f.sourceId])));
    f.db.prepare("UPDATE mail_triage_source_aliases SET active=0 WHERE source_id=?").run(second.sourceId);
    assert.equal(f.service.caseDetail({caseId:f.caseId}),null);
    f.db.prepare("DELETE FROM mail_case_events WHERE id=?").run(eventId);
    const independentId=randomUUID(),independent={supportSourceIds:[],kind:"independent_manual",verifiedAt:212,reason:"人工登录官方平台核验"};
    f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,NULL,'manual:verified','notification',1,NULL,212,'[]',?)").run(independentId,f.caseId,JSON.stringify(independent));
    const timeline=f.service.caseDetail({caseId:f.caseId})!.timeline;
    assert.equal(timeline.some(entry=>entry.id===independentId),true);
    f.db.prepare("INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at) VALUES(?,?, 'user:7',?,'note',0,1,'bad provenance','{}','{}','{}',220)").run(randomUUID(),f.caseId,f.caseId);
    assert.equal(f.service.caseDetail({caseId:f.caseId}),null);
  }finally{f.db.close();}
});

test("Fix1 historical cycles retain their authorized projected decision and explanation",()=>{
  const f=fixture();
  try{
    f.db.prepare("UPDATE mail_triage_sources SET trust='human_confirmed' WHERE id=?").run(f.sourceId);
    f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:declined','application_declined',1,220,220,'[]',?)").run(randomUUID(),f.caseId,f.sourceId,JSON.stringify(derived([f.sourceId])));
    f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:review2','review_started',2,230,230,'[]',?)").run(randomUUID(),f.caseId,f.sourceId,JSON.stringify(derived([f.sourceId])));
    f.db.exec("BEGIN IMMEDIATE");try{reprojectCases(f.db,{caseIds:[f.caseId],now:240});f.db.exec("COMMIT");}catch(error){f.db.exec("ROLLBACK");throw error;}
    const detail=f.service.caseDetail({caseId:f.caseId})!;
    assert.equal(detail.currentCycle.cycle,2);
    assert.deepEqual(detail.historicalCycles,[{cycle:1,decision:"declined",explanation:"申请被拒",current:false}]);
  }finally{f.db.close();}
});

test("Fix1 historical cycle projection preserves conflicts instead of inventing a final result",()=>{
  const f=fixture();
  try{
    f.db.prepare("UPDATE mail_triage_sources SET trust='human_confirmed' WHERE id=?").run(f.sourceId);
    for(const [slot,kind] of [["1:approved","application_approved"],["1:declined","application_declined"]] as const)f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,?,?,?,1,220,220,'[]',?)").run(randomUUID(),f.caseId,f.sourceId,slot,kind,JSON.stringify(derived([f.sourceId])));
    f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:review2','review_started',2,230,230,'[]',?)").run(randomUUID(),f.caseId,f.sourceId,JSON.stringify(derived([f.sourceId])));
    f.db.exec("BEGIN IMMEDIATE");try{reprojectCases(f.db,{caseIds:[f.caseId],now:240});f.db.exec("COMMIT");}catch(error){f.db.exec("ROLLBACK");throw error;}
    assert.deepEqual(f.service.caseDetail({caseId:f.caseId})!.historicalCycles,[{cycle:1,decision:"unknown",explanation:null,current:false}]);
  }finally{f.db.close();}
});

test("Fix1 detail is unavailable for an obsolete source generation",()=>{
  const f=fixture();
  try{f.db.prepare("UPDATE mail_triage_sources SET source_version=2 WHERE id=?").run(f.sourceId);assert.equal(f.service.caseDetail({caseId:f.caseId}),null);}finally{f.db.close();}
});

test("Fix1 server pagination reaches case 101 and review row 31 with unsliced totals and facets",()=>{
  const f=fixture();
  try{
    const base=JSON.parse(String(f.db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(f.caseId)!.projection_json));
    for(let index=0;index<100;index++){const id=randomUUID();f.db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,created_at,updated_at) VALUES(?,'confirmed','Zen Payments',?,?,?,1,?)").run(id,`APP-${index}`,JSON.stringify(derived([f.sourceId])),JSON.stringify({...base,caseId:id}),100+index);f.db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'page-test')").run(id,f.sourceId);}
    const first=f.service.casesList({page:1,pageSize:100}),second=f.service.casesList({page:2,pageSize:100});
    assert.equal(first.total,101);assert.equal(first.items.length,100);assert.equal(second.items.length,1);assert.equal(first.columnTotals.needs_you,101);assert.ok(first.facets.providers.includes("Zen Payments"));
    for(let uid=20;uid<50;uid++){const message={...parsed(`page ${uid}`),messageId:`<page-${uid}@example.test>`};f.db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,snippet,body_text,body_complete,message_id,references_json,attachments_json) VALUES(1,'INBOX',?,'uv-14',?,?,?,'[]','Page',200,?,?,1,?,'[]','[]')`).run(uid,JSON.stringify(message.from),JSON.stringify(message.fromAddresses),JSON.stringify(message.to),message.snippet,message.text,message.messageId);registerCachedSource(f.db,{locator:{mailboxId:1,folder:"INBOX",uidValidity:"uv-14",uid},mail:message,observedAt:uid},key);}
    const reviews1=f.service.reviewQueue({filter:"unreviewed",page:1,pageSize:30}),reviews2=f.service.reviewQueue({filter:"unreviewed",page:2,pageSize:30});assert.equal(reviews1.total,31);assert.equal(reviews1.items.length,30);assert.equal(reviews2.items.length,1);
  }finally{f.db.close();}
});

test("Fix2 every status count and review filter excludes a non-current authorization generation",()=>{
  const f=fixture();
  const addSource=(uid:number)=>{
    const mail={...parsed(`source ${uid}`),messageId:`<fix2-${uid}@example.test>`,subject:`Fix2 ${uid}`};
    f.db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,snippet,body_text,body_complete,message_id,references_json,attachments_json) VALUES(1,'INBOX',?,'uv-14',?,?,?,'[]',?,200,?,?,1,?,'[]','[]')`).run(uid,JSON.stringify(mail.from),JSON.stringify(mail.fromAddresses),JSON.stringify(mail.to),mail.subject,mail.snippet,mail.text,mail.messageId);
    return registerCachedSource(f.db,{locator:{mailboxId:1,folder:"INBOX",uidValidity:"uv-14",uid},mail,observedAt:uid},key).sourceId;
  };
  const addJob=(sourceId:string,state:"failed"|"needs_review"|"succeeded")=>{const id=randomUUID();f.db.prepare("INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,config_epoch,state,created_at,updated_at) VALUES(?,?,1,1,'fixture',1,1,1,1,'fix2',1,?,1,250)").run(id,sourceId,state);return id;};
  try{
    const base=JSON.parse(String(f.db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(f.caseId)!.projection_json));
    f.db.prepare("UPDATE mail_triage_sources SET trust='human_confirmed' WHERE id=?").run(f.sourceId);
    for(const [suffix,column] of [["await","awaiting_platform"],["result","results"]] as const){const id=randomUUID();f.db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,created_at,updated_at) VALUES(?,'confirmed','Zen Payments',?,?,?,1,200)").run(id,`APP-${suffix}`,JSON.stringify(derived([f.sourceId])),JSON.stringify({...base,caseId:id,column,decision:column==="results"?"approved":base.decision,stage:column==="results"?"ended":base.stage,tasks:[]}));f.db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'fix2-count')").run(id,f.sourceId);f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:fix2-count',?,1,200,200,'[]',?)").run(randomUUID(),id,f.sourceId,column==="results"?"application_approved":"review_started",JSON.stringify(derived([f.sourceId])));}
    const unlinked=addSource(40),failed=addSource(41),review=addSource(42),audit=addSource(43);
    addJob(failed,"failed");addJob(review,"needs_review");const auditJob=addJob(audit,"succeeded"),assessmentId=randomUUID();
    f.db.prepare("INSERT INTO mail_triage_assessments(id,job_id,source_id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,prompt_hash,validated_json,support_source_ids_json,grade,created_at) VALUES(?,?,?,1,'fixture',1,1,1,1,'hash','{}',?,'needs_review',250)").run(assessmentId,auditJob,audit,JSON.stringify([audit]));
    const auditTuple={providerId:1,modelId:"fixture",modelConfigRevision:1,promptVersion:1,ruleVersion:1,schemaVersion:1};
    f.db.prepare("INSERT INTO mail_triage_qualifications(id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,evidence_hash,strata_counts_json,missed_action_count) VALUES(?,?,?,?,?,?,?,'fixture','{}',0)").run(randomUUID(),auditTuple.providerId,auditTuple.modelId,auditTuple.modelConfigRevision,auditTuple.promptVersion,auditTuple.ruleVersion,auditTuple.schemaVersion);
    const auditRegistration=registerNotificationAudit(f.db,{assessmentId,tuple:auditTuple},250);
    f.db.prepare("INSERT INTO mail_triage_audits(id,assessment_id,sequence,sampled) VALUES(?,?,?,?)").run(randomUUID(),assessmentId,auditRegistration.sequence,auditRegistration.sampled?1:0);
    f.db.prepare("UPDATE mail_triage_settings SET reminder_enabled=1,reminder_settings_json=? WHERE id=1").run(JSON.stringify({followUpDays:7,leadDays:1}));
    f.db.prepare("UPDATE mail_case_tasks SET deadline_at=300 WHERE id=?").run(f.taskId);
    const visible=()=>({
      status:f.service.status(),
      filters:Object.fromEntries(["unreviewed","unlinked","failed","review","audit","notifications"].map(filter=>[filter,f.service.reviewQueue({filter,page:1,pageSize:30}).total])),
    });
    const assertVisible=()=>{const value=visible();assert.deepEqual([value.status.needsActionCaseCount,value.status.awaitingCaseCount,value.status.resultCaseCount,value.status.openTaskCount,value.status.auditPendingMailCount],[1,1,1,1,1]);for(const count of Object.values(value.filters))assert.ok(count>0);};
    const assertHidden=()=>{const value=visible();assert.deepEqual([value.status.needsActionCaseCount,value.status.awaitingCaseCount,value.status.resultCaseCount,value.status.openTaskCount,value.status.auditPendingMailCount],[0,0,0,0,0]);assert.deepEqual(Object.values(value.filters),[0,0,0,0,0,0]);};
    assertVisible();
    f.db.prepare("UPDATE mail_triage_scope SET state='revoked' WHERE mailbox_id=1").run();assertHidden();f.db.prepare("UPDATE mail_triage_scope SET state='authorized' WHERE mailbox_id=1").run();assertVisible();
    f.db.prepare("UPDATE mail_triage_settings SET enabled=0,state='disabled' WHERE id=1").run();assertHidden();f.db.prepare("UPDATE mail_triage_settings SET enabled=1,state='enabled' WHERE id=1").run();assertVisible();
    f.db.prepare("INSERT INTO abandoned_domains(domain,abandoned_at) VALUES('nordicpaws.com',1)").run();assertHidden();f.db.prepare("DELETE FROM abandoned_domains WHERE domain='nordicpaws.com'").run();assertVisible();
    f.db.prepare("UPDATE mail_triage_scope SET uid_validity='reused-generation' WHERE mailbox_id=1").run();assertHidden();
    const independent={supportSourceIds:[],kind:"independent_manual",verifiedAt:299,reason:"人工登录官方平台核验"};
    const projection=JSON.parse(String(f.db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(f.caseId)!.projection_json));
    projection.tasks=projection.tasks.map((task:Record<string,unknown>)=>({...task,provenance:independent}));
    f.db.prepare("UPDATE mail_application_cases SET identity_provenance_json=?,projection_json=? WHERE id=?").run(JSON.stringify(independent),JSON.stringify(projection),f.caseId);
    f.db.prepare("UPDATE mail_case_tasks SET provenance_json=? WHERE id=?").run(JSON.stringify(independent),f.taskId);
    f.db.prepare("UPDATE mail_case_events SET source_id=NULL,evidence_json='[]',provenance_json=? WHERE case_id=?").run(JSON.stringify(independent),f.caseId);
    const independentlyVisible=visible();
    assert.deepEqual([independentlyVisible.status.needsActionCaseCount,independentlyVisible.status.openTaskCount,independentlyVisible.filters.notifications],[1,1,1]);
    assert.ok(unlinked&&auditJob);
  }finally{f.db.close();}
});

test("Fix2 invalid source-null events and manual rows make direct detail unavailable",()=>{
  const f=fixture();
  try{
    const badSupport=randomUUID(),badEvidence=randomUUID(),badZero=randomUUID();
    f.db.exec("PRAGMA ignore_check_constraints=ON");
    f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,NULL,'manual:bad-support','notification',1,NULL,230,'[]',?)").run(badSupport,f.caseId,JSON.stringify({supportSourceIds:[f.sourceId],kind:"independent_manual",verifiedAt:230,reason:"人工核验"}));
    f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,NULL,'manual:bad-evidence','notification',1,NULL,231,?,?)").run(badEvidence,f.caseId,JSON.stringify([{sourceId:f.sourceId,quote:"not independent"}]),JSON.stringify({supportSourceIds:[],kind:"independent_manual",verifiedAt:231,reason:"人工核验"}));
    f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,NULL,'manual:bad-time','notification',1,NULL,232,'[]',?)").run(badZero,f.caseId,JSON.stringify({supportSourceIds:[],kind:"independent_manual",verifiedAt:0,reason:"人工核验"}));
    f.db.exec("PRAGMA ignore_check_constraints=OFF");
    f.db.prepare("INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at) VALUES(?,?,'user:7',?,'note',0,1,'bad support','{}','{}',?,233)").run(randomUUID(),f.caseId,f.caseId,JSON.stringify({supportSourceIds:[f.sourceId],kind:"independent_manual",verifiedAt:233,reason:"人工核验"}));
    assert.equal(f.service.caseDetail({caseId:f.caseId}),null);
  }finally{f.db.close();}
});

test("Fix2 case page hydrates only its SQL-selected rows even with ten thousand off-page cases",()=>{
  const f=fixture();
  try{
    const base=String(f.db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(f.caseId)!.projection_json);
    f.db.prepare(`WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<10000)
      INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,created_at,updated_at)
      SELECT printf('00000000-0000-4000-8000-%012d',x),'confirmed','Bulk Provider',printf('BULK-%05d',x),?,json_set(?,'$.caseId',printf('00000000-0000-4000-8000-%012d',x),'$.tasks',json('[]')),1,100000-x FROM seq`).run(JSON.stringify(derived([f.sourceId])),base);
    f.db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) SELECT id,?,'bulk' FROM mail_application_cases WHERE provider='Bulk Provider'").run(f.sourceId);
    const poisonMail={...parsed("poison"),messageId:"<poison@example.test>",subject:"Poison"};
    f.db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,snippet,body_text,body_complete,message_id,references_json,attachments_json) VALUES(1,'INBOX',99,'uv-14',?,?,?,'[]','Poison',200,?,?,1,?,'[]','[]')`).run(JSON.stringify(poisonMail.from),JSON.stringify(poisonMail.fromAddresses),JSON.stringify(poisonMail.to),poisonMail.snippet,poisonMail.text,poisonMail.messageId);
    const poisonSource=registerCachedSource(f.db,{locator:{mailboxId:1,folder:"INBOX",uidValidity:"uv-14",uid:99},mail:poisonMail,observedAt:299},key).sourceId,poisonCase=randomUUID(),job=randomUUID();
    f.db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,created_at,updated_at) VALUES(?,'confirmed','Poison Provider','POISON',?,?,1,99900)").run(poisonCase,JSON.stringify(derived([poisonSource])),JSON.stringify({...JSON.parse(base),caseId:poisonCase,tasks:[]}));
    f.db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'poison')").run(poisonCase,poisonSource);
    f.db.prepare("INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,config_epoch,state,created_at,updated_at) VALUES(?,?,1,1,'fixture',1,1,1,1,'poison',1,'succeeded',1,250)").run(job,poisonSource);
    f.db.prepare("INSERT INTO mail_triage_assessments(id,job_id,source_id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,prompt_hash,validated_json,support_source_ids_json,grade,created_at) VALUES(?,?,?,1,'fixture',1,1,1,1,'hash','{}',?,'needs_review',250)").run(randomUUID(),job,poisonSource,JSON.stringify([poisonSource]));
    const first=f.service.casesList({page:1,pageSize:100});
    assert.equal(first.total,10002);assert.equal(first.items.length,100);assert.equal(first.items.some(item=>item.caseId===poisonCase),false);
    assert.throws(()=>f.service.casesList({page:2,pageSize:100}),/预审评估|数据完整性/);
  }finally{f.db.close();}
});

test("Fix3 a stale current-cycle decision cannot survive behind an independent case identity",()=>{
  const f=fixture();
  try{
    const independent={supportSourceIds:[],kind:"independent_manual",verifiedAt:250,reason:"人工登录官方平台核验申请身份"};
    f.db.prepare("DELETE FROM mail_case_tasks WHERE case_id=?").run(f.caseId);
    f.db.prepare("UPDATE mail_triage_sources SET trust='human_confirmed' WHERE id=?").run(f.sourceId);
    f.db.prepare("UPDATE mail_case_events SET kind='application_approved' WHERE case_id=?").run(f.caseId);
    f.db.prepare("UPDATE mail_application_cases SET identity_provenance_json=? WHERE id=?").run(JSON.stringify(independent),f.caseId);
    f.db.exec("BEGIN IMMEDIATE");try{reprojectCases(f.db,{caseIds:[f.caseId],now:260});f.db.exec("COMMIT");}catch(error){f.db.exec("ROLLBACK");throw error;}
    assert.equal(f.service.status().resultCaseCount,1);assert.equal(f.service.casesList({}).total,1);
    f.db.prepare("UPDATE mail_triage_scope SET state='revoked' WHERE mailbox_id=1").run();
    assert.equal(f.service.status().resultCaseCount,0);assert.equal(f.service.casesList({}).total,0);
    f.db.prepare("UPDATE mail_triage_scope SET state='authorized',uid_validity='reused-generation' WHERE mailbox_id=1").run();
    assert.equal(f.service.status().resultCaseCount,0);assert.equal(f.service.casesList({}).total,0);
  }finally{f.db.close();}
});

test("Fix3 one runtime provenance rule rejects malformed identity tasks and non-null independent events",()=>{
  const f=fixture();
  const validIdentity=JSON.stringify(derived([f.sourceId]));
  try{
    const malformed={supportSourceIds:[f.sourceId],kind:"independent_manual",verifiedAt:0,reason:"   "};
    f.db.prepare("UPDATE mail_application_cases SET identity_provenance_json=? WHERE id=?").run(JSON.stringify(malformed),f.caseId);
    assert.throws(()=>f.service.caseDetail({caseId:f.caseId}),/申请身份|数据完整性/);
    f.db.prepare("UPDATE mail_application_cases SET identity_provenance_json=? WHERE id=?").run(validIdentity,f.caseId);
    const projection=JSON.parse(String(f.db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(f.caseId)!.projection_json));
    projection.tasks[0].provenance=malformed;f.db.prepare("UPDATE mail_application_cases SET projection_json=? WHERE id=?").run(JSON.stringify(projection),f.caseId);
    assert.throws(()=>f.service.caseDetail({caseId:f.caseId}),/事项投影|数据完整性/);
    projection.tasks[0].provenance=derived([f.sourceId]);f.db.prepare("UPDATE mail_application_cases SET projection_json=? WHERE id=?").run(JSON.stringify(projection),f.caseId);
    const malformedEvent=randomUUID(),evidenceEvent=randomUUID();
    f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:fix3-malformed','notification',1,NULL,260,'[]',?)").run(malformedEvent,f.caseId,f.sourceId,JSON.stringify(malformed));
    const strict={supportSourceIds:[],kind:"independent_manual",verifiedAt:261,reason:"人工登录官方平台核验"};
    f.db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:fix3-evidence','notification',1,NULL,261,?,?)").run(evidenceEvent,f.caseId,f.sourceId,JSON.stringify([{sourceId:f.sourceId,quote:"not independent"}]),JSON.stringify(strict));
    assert.equal(f.service.caseDetail({caseId:f.caseId}),null);
  }finally{f.db.close();}
});

test("Fix3 off-page malformed projection fails closed before totals or facets are returned",()=>{
  const f=fixture();
  try{
    const id=randomUUID();
    f.db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,created_at,updated_at) VALUES(?,'confirmed','Malformed Provider','BAD',?,'{\"column\":\"results\",\"tasks\":[]}',1,1)").run(id,JSON.stringify(derived([f.sourceId])));
    f.db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'malformed')").run(id,f.sourceId);
    assert.throws(()=>f.service.casesList({page:1,pageSize:1}),/事项投影|数据完整性/);
  }finally{f.db.close();}
});

test("Fix3 provider filtering keeps the authorized provider facet universe",()=>{
  const f=fixture();
  try{
    const id=randomUUID(),base=JSON.parse(String(f.db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(f.caseId)!.projection_json));
    f.db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,projection_json,created_at,updated_at) VALUES(?,'confirmed','Other Provider','OTHER',?,?,1,100)").run(id,JSON.stringify(derived([f.sourceId])),JSON.stringify({...base,caseId:id,tasks:[]}));
    f.db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'facet')").run(id,f.sourceId);
    const page=f.service.casesList({provider:"Zen Payments"});
    assert.equal(page.total,1);assert.deepEqual(page.facets.providers,["Other Provider","Zen Payments"]);
  }finally{f.db.close();}
});

test("Fix4 direct detail hides a source-derived final decision after revocation or UIDVALIDITY reuse",()=>{
  const f=fixture();
  try{
    const independent={supportSourceIds:[],kind:"independent_manual",verifiedAt:310,reason:"人工登录官方平台核验申请身份"};
    f.db.prepare("DELETE FROM mail_case_tasks WHERE case_id=?").run(f.caseId);
    f.db.prepare("UPDATE mail_triage_sources SET trust='human_confirmed' WHERE id=?").run(f.sourceId);
    f.db.prepare("UPDATE mail_case_events SET kind='application_approved' WHERE case_id=?").run(f.caseId);
    f.db.prepare("UPDATE mail_application_cases SET identity_provenance_json=? WHERE id=?").run(JSON.stringify(independent),f.caseId);
    f.db.exec("BEGIN IMMEDIATE");try{reprojectCases(f.db,{caseIds:[f.caseId],now:320});f.db.exec("COMMIT");}catch(error){f.db.exec("ROLLBACK");throw error;}
    assert.equal(f.service.caseDetail({caseId:f.caseId})?.currentCycle.decision,"approved");

    f.db.prepare("UPDATE mail_triage_scope SET state='revoked' WHERE mailbox_id=1").run();
    assert.equal(f.service.status().resultCaseCount,0);
    assert.equal(f.service.casesList({}).total,0);
    assert.equal(f.service.caseDetail({caseId:f.caseId}),null);

    f.db.prepare("UPDATE mail_triage_scope SET state='authorized',uid_validity='reused-generation' WHERE mailbox_id=1").run();
    assert.equal(f.service.status().resultCaseCount,0);
    assert.equal(f.service.casesList({}).total,0);
    assert.equal(f.service.caseDetail({caseId:f.caseId}),null);
  }finally{f.db.close();}
});

test("Fix4 final manual authority requires the case object and an active non-undone audit row",()=>{
  const f=fixture();
  const independent={supportSourceIds:[],kind:"independent_manual",verifiedAt:330,reason:"人工登录官方平台核验最终结果"};
  const writeStaleApprovedProjection=()=>{
    const projection=JSON.parse(String(f.db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(f.caseId)!.projection_json));
    f.db.prepare("UPDATE mail_application_cases SET identity_provenance_json=?,projection_json=? WHERE id=?").run(JSON.stringify(independent),JSON.stringify({...projection,column:"results",stage:"ended",decision:"approved",decisionLabel:"人工核验",tasks:[]}),f.caseId);
  };
  const insertDecision=(id:string,objectId:string,undoOf:string|null,field="decision")=>f.db.prepare("INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,undo_of,provenance_json,created_at) VALUES(?,?,'user:7',?,?,0,1,'人工核验最终结果','{\"decision\":\"unknown\"}','{\"decision\":\"approved\"}',?,?,330)").run(id,f.caseId,objectId,field,undoOf,JSON.stringify(independent));
  try{
    f.db.prepare("DELETE FROM mail_case_tasks WHERE case_id=?").run(f.caseId);
    writeStaleApprovedProjection();

    const wrongObjectId=randomUUID();
    insertDecision(randomUUID(),wrongObjectId,null);
    assert.equal(f.service.status().resultCaseCount,0);
    assert.equal(f.service.casesList({}).total,0);
    assert.equal(f.service.caseDetail({caseId:f.caseId}),null);

    f.db.prepare("DELETE FROM mail_case_manual_decisions WHERE case_id=?").run(f.caseId);
    const decisionId=randomUUID();
    insertDecision(decisionId,f.caseId,null);
    insertDecision(randomUUID(),f.caseId,decisionId,"undo");
    assert.equal(f.service.status().resultCaseCount,0);
    assert.equal(f.service.casesList({}).total,0);
    assert.equal(f.service.caseDetail({caseId:f.caseId}),null);
  }finally{f.db.close();}
});

