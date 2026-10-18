import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { ValidatedAssessment } from "./mail-triage-analyzer.ts";
import type { Fence, Provenance } from "../shared/mail-triage-types.ts";
import { setup } from "./testing.ts";
import type { CaseEvent, CaseTask, CaseProjectionInput, SourceFacts, CaseCandidate, ContactMapping } from "./mail-case-projector.ts";
import { applyManualDecision, undoManualDecision } from "./mail-triage-actions.ts";
const mod = () => import("./mail-case-projector.ts");
const sourceId = "11111111-1111-4111-8111-111111111111", caseId = "22222222-2222-4222-8222-222222222222";
const provenance = (ids=[sourceId]):Provenance => ({supportSourceIds:ids,kind:"source_derived",verifiedAt:null,reason:null});
const independent:Provenance = {supportSourceIds:[],kind:"independent_manual",verifiedAt:1,reason:"独立核验"};
const source = (patch:Partial<SourceFacts>={}):SourceFacts => ({id:sourceId,mailboxId:1,version:1,state:"active",trust:"human_confirmed",observedAt:100,date:90,fromAddresses:["support@fixture.test"],text:"APP-001 Please send passport",threadCaseIds:[],...patch});
const candidate = (patch:Partial<CaseCandidate>={}):CaseCandidate => ({id:caseId,identityState:"confirmed",provider:"Fixture",siteId:null,applicationId:"APP-001",eligible:true,...patch});
const mapping:ContactMapping = {id:"mapping",mailboxId:1,address:"support@fixture.test",provider:"Fixture",siteId:null,confirmed:true};
function assessment(patch:Partial<ValidatedAssessment>={}):ValidatedAssessment {
  return {schemaVersion:1,primaryCategory:"progress",tag:"进度通知",summary:"邮件显示进度",caseSuggestion:{providerCandidate:"Fixture",applicationId:"APP-001",candidateCaseId:caseId,matchBasis:[],needsReview:false},events:[],actions:[],completionSuggestions:[],uncertainties:[],requiresHumanReview:false,grade:"evidence_complete",usage:null,evidenceLocations:[],applicationRestrictions:["notification_qualification_required"],...patch};
}
const event = (kind:CaseEvent["kind"],patch:Partial<CaseEvent>={}):CaseEvent => ({id:`event-${kind}`,caseId,sourceId,sourceVersion:1,eventSlot:kind,kind,decisionCycle:1,claimedAt:90,observedAt:100,provenance:provenance(),...patch});
const task = (id="task-passport",patch:Partial<CaseTask>={}):CaseTask => ({id,caseId,eventId:"event-request",obligationKey:id,kind:"action",state:"open",title:"提交材料",requestedItems:["passport"],deadlineRaw:null,deadlineAt:null,version:1,provenance:provenance(),...patch});
const input = (patch:Partial<CaseProjectionInput>={}):CaseProjectionInput => ({caseId,version:1,identityState:"confirmed",events:[],tasks:[],manualDecisions:[],sources:[{id:sourceId,state:"active",trust:"human_confirmed"}],now:100,...patch});

test("B15/B56 exact ID + confirmed mapping + unique eligible case only; new ID candidate not authorization",async()=>{
  const {resolveCaseLinks}=await mod();
  const run=(s=source(),cs=[candidate()],maps=[mapping])=>resolveCaseLinks({assessment:assessment(),source:s,candidates:cs,confirmedMappings:maps});
  assert.equal(run().status,"matched"); assert.deepEqual(run().caseIds,[caseId]);
  assert.equal(run(source({fromAddresses:["spoof@fixture.test"]})).status,"candidate");
  assert.equal(run(source({text:"APP-001"}),[candidate({eligible:false})]).status,"candidate");
  assert.equal(run(source({text:"APP-001"}),[candidate({identityState:"unconfirmed_case"})]).status,"candidate");
  assert.equal(run(source({text:"APP-001X"})).status,"candidate");
  assert.equal(run(source({text:"new APP-002"})).status,"candidate");
  assert.equal(run(source(),[candidate(),candidate({id:randomUUID()})]).status,"ambiguous");
  assert.equal(run(source(),[candidate()],[mapping,{...mapping,id:"other",provider:"Other"}]).status,"ambiguous");
});
test("RF3/B16 forwarded multi-case request remains reviewable; anchored thread requires mapping",async()=>{
  const {resolveCaseLinks}=await mod();
  const cs=[candidate(),candidate({id:randomUUID(),applicationId:"APP-002"})];
  assert.equal(resolveCaseLinks({assessment:assessment(),source:source({text:"APP-001 APP-002"}),candidates:cs,confirmedMappings:[mapping]}).status,"ambiguous");
  assert.equal(resolveCaseLinks({assessment:assessment(),source:source({text:"Please reply",threadCaseIds:[caseId]}),candidates:cs,confirmedMappings:[mapping]}).status,"matched");
  assert.equal(resolveCaseLinks({assessment:assessment(),source:source({text:"Please reply",threadCaseIds:[caseId]}),candidates:cs,confirmedMappings:[]}).status,"candidate");
});
test("B01/B20 signature is milestone only, open docs keep pending needs_you",async()=>{
  const {projectCase}=await mod();const p=projectCase(input({events:[event("signature_completed")],tasks:[task()]}));
  assert.equal(p.column,"needs_you");assert.equal(p.decision,"pending");assert.deepEqual(p.milestones,["signature_completed"]);
});
test("B02/B03/B04/B05 decisions, conditional and independent action are orthogonal",async()=>{
  const {projectCase}=await mod();
  assert.equal(projectCase(input({events:[event("application_approved")]})).column,"results");
  assert.equal(projectCase(input({events:[event("application_approved")]})).decisionLabel,"邮件显示");
  assert.equal(projectCase(input({events:[event("application_conditionally_approved")]})).decision,"conditional");
  assert.notEqual(projectCase(input({events:[event("application_conditionally_approved")]})).column,"results");
  for(const kind of ["application_approved","application_declined"] as const){const p=projectCase(input({events:[event(kind)],tasks:[task("activation",{kind:"reply"})]}));assert.equal(p.column,"needs_you");assert.equal(p.requiresReply,true);}
});
test("B12/B50 account suspended has mandatory review but preserves approval history",async()=>{
  const {projectCase}=await mod();const p=projectCase(input({events:[event("application_approved"),event("account_disabled",{id:"risk"})]}));
  assert.equal(p.decision,"approved");assert.equal(p.column,"needs_you");assert.equal(p.requiresReview,true);
});
test("B17/B18 late progress cannot cover newer decision; conflicting decisions need review",async()=>{
  const {projectCase}=await mod();
  const p=projectCase(input({events:[event("application_approved",{claimedAt:80}),event("review_started",{claimedAt:10,observedAt:110})]}));assert.equal(p.decision,"approved");assert.equal(p.stage,"ended");
  const conflict=projectCase(input({events:[event("application_approved"),event("application_declined",{id:"declined",claimedAt:50})]}));assert.equal(conflict.column,"needs_you");assert.equal(conflict.requiresReview,true);assert.equal(conflict.decision,"unknown");
});
test("B19/B07/B08/B09 new reply/upload after result reopen as two obligations",async()=>{
  const {projectCase}=await mod();const p=projectCase(input({events:[event("application_approved")],tasks:[task(),task("reply",{kind:"reply"})]}));assert.equal(p.column,"needs_you");assert.equal(p.tasks.length,2);assert.equal(p.requiresReply,true);assert.equal(p.requiresAction,true);
});
test("B26/B27 manual lock is durable for old task but new request still adds",async()=>{
  const {projectCase}=await mod();const p=projectCase(input({tasks:[task("old"),task("new")],manualDecisions:[{objectId:"old",field:"state",value:"dismissed",appliedVersion:2,createdAt:100,provenance:independent}]}));
  assert.equal(p.tasks.find(t=>t.id==="old")?.state,"dismissed");assert.equal(p.tasks.find(t=>t.id==="new")?.state,"open");assert.equal(p.column,"needs_you");
});
test("B51 appeal request starts pending-acceptance cycle; old decline stays history",async()=>{
  const {projectCase}=await mod();const p=projectCase(input({events:[event("application_declined"),event("reconsideration_requested",{id:"appeal",decisionCycle:2,claimedAt:100})]}));
  assert.equal(p.decisionCycle,2);assert.equal(p.decision,"pending");assert.equal(p.column,"needs_you");assert.ok(p.milestones.includes("待确认受理"));
  const accepted=projectCase(input({events:[event("application_declined"),event("reconsideration_accepted",{id:"appeal",decisionCycle:2})]}));assert.equal(accepted.decision,"pending");assert.equal(accepted.column,"awaiting_platform");
});
test("B62 stale only support becomes unavailable/review, not successful task completion",async()=>{
  const {projectCase}=await mod();const p=projectCase(input({events:[event("application_approved")],tasks:[task()],sources:[{id:sourceId,state:"stale",trust:"human_confirmed"}]}));
  assert.equal(p.sourceUnavailable,true);assert.equal(p.column,"needs_you");assert.equal(p.requiresReview,true);assert.equal(p.decision,"unknown");assert.ok(!p.tasks.some(t=>t.state==="resolved_by_evidence"));
});
test("B49 unconfirmed per-message critical event needs review despite contact mapping",async()=>{
  const {projectCase}=await mod();const p=projectCase(input({events:[event("application_approved")],sources:[{id:sourceId,state:"active",trust:"contact_mapped"}]}));assert.equal(p.column,"needs_you");assert.equal(p.decision,"pending");
});
test("B56 unconfirmed case has no normal board column; insufficient confirmed case review visible",async()=>{
  const {projectCase}=await mod();assert.equal(projectCase(input({identityState:"unconfirmed_case"})).column,null);assert.equal(projectCase(input()).column,"needs_you");
});
test("RF2/B21 future Date never wins priority; unknown deadline stays raw; stable risk/deadline/action/review order",async()=>{
  const {projectCase,compareCasePriority}=await mod();
  const p=projectCase(input({events:[event("review_started",{claimedAt:999999999})],tasks:[task("time",{deadlineRaw:"November 1 01:30",deadlineAt:null})]}));assert.equal(p.tasks[0].deadlineAt,null);assert.equal(p.tasks[0].deadlineRaw,"November 1 01:30");
  const risk=projectCase(input({caseId:"risk",events:[event("account_suspended",{caseId:"risk"})]}));const due=projectCase(input({caseId:"due",tasks:[task("due",{caseId:"due",deadlineAt:99})]}));const action=projectCase(input({caseId:"action",tasks:[task("action",{caseId:"action"})]}));const review=projectCase(input({caseId:"review"}));
  assert.deepEqual([review,action,due,risk].sort(compareCasePriority).map(p=>p.caseId),["risk","due","action","review"]);assert.equal(p.priority.observedAt,100);
});
test("B45 count units and reducer/reminder replay deterministic",async()=>{
  const {projectCase,countTriageItems}=await mod();const i=input({tasks:[task(),task("reply",{kind:"reply"})]});const p=projectCase(i);assert.deepEqual(projectCase(i),p);assert.equal(new Set(p.reminders.map(r=>r.key)).size,p.reminders.length);
  const counts=countTriageItems([p],[{sourceId:"a",linked:true,state:"unreviewed",auditPending:true},{sourceId:"b",linked:false,state:"failed",auditPending:false}]);
  assert.deepEqual(counts,{needsActionCaseCount:1,awaitingCaseCount:0,resultCaseCount:0,unlinkedMailCount:1,unreviewedMailCount:1,failedMailCount:1,openTaskCount:2,auditPendingMailCount:1});
});

function dbFixture(){
  const {db}=setup({cachedMailbox:{password:"fixture"}});const id=sourceId;
  db.exec("UPDATE mail_triage_settings SET enabled=1,state='enabled'; INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,effective_at) VALUES(1,1,'authorized','100',0)");
  db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,trust,observed_at) VALUES(?,1,'h','h','human_confirmed',100)").run(id);
  db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,subject,date,body_text,body_complete,message_id) VALUES(1,'INBOX',1,'100','\"Sender\"','[\"support@fixture.test\"]','[]','APP-001',90,'APP-001 Please send passport',1,'<fixture>')").run();
  db.prepare("INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id) VALUES(1,'INBOX','100',1,?)").run(id);
  db.prepare("INSERT INTO mail_triage_contacts(id,provider,mailbox_id,address,reason,confirmed_by,confirmed_at) VALUES('mapping','Fixture',1,'support@fixture.test','fixture','actor',1)").run();
  db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json) VALUES(?,'confirmed','Fixture','APP-001',?)").run(caseId,JSON.stringify(independent));
  const fence:Fence={jobId:randomUUID(),leaseToken:"lease",attemptSeq:1,configEpoch:1,sourceVersion:1,contextVersion:"context",manualVersion:0};
  db.prepare("INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,config_epoch,state,lease_token,lease_expires_at,attempt_seq) VALUES(?,?,1,1,'fixture',1,1,1,1,'context',1,'running','lease',1000,1)").run(fence.jobId,id);
  const quote="Please send passport";
  const a=assessment({actions:[{kind:"action",title:"提交护照",requestedItems:["passport"],deadlineRaw:null,deadlineAt:null,satisfiesTaskIds:[],evidence:[{sourceId:id,quote}]}],evidenceLocations:[{path:"/actions/0/evidence/0",sourceId:id,quote,locations:[{field:"text",segment:"current_body",start:8,end:28,coordinateUnit:"utf16"}]}]});
  return {db,fence,a};
}
function transact<T>(db:ReturnType<typeof setup>["db"],run:()=>T):T {db.exec("BEGIN IMMEDIATE");try{const result=run();db.exec("COMMIT");return result;}catch(e){db.exec("ROLLBACK");throw e;}}
test("B47 paused/job-null pending registration immediately reviews reliably linked result; seam idempotent",async()=>{
  const {registerPendingReview}=await mod();const {db}=dbFixture();try{
    db.exec("UPDATE mail_triage_settings SET state='blocked_config'");
    transact(db,()=>registerPendingReview(db,{sourceId,sourceVersion:1,configEpoch:1,now:100}));transact(db,()=>registerPendingReview(db,{sourceId,sourceVersion:1,configEpoch:1,now:101}));
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks WHERE obligation_key='review_new_mail'").get()!.n,1);
    const p=JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json));assert.equal(p.column,"needs_you");
  }finally{db.close();}
});
test("B56 provisional source registration cannot guess confirmed case without exact mapping",async()=>{
  const {registerPendingReview}=await mod();const {db}=dbFixture();try{db.exec("DELETE FROM mail_triage_contacts");transact(db,()=>registerPendingReview(db,{sourceId,sourceVersion:1,configEpoch:1,now:100}));
    const row=db.prepare("SELECT * FROM mail_application_cases WHERE identity_state='unconfirmed_case'").get()!;assert.equal(JSON.parse(String(row.projection_json)).column,null);assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_sources WHERE case_id=?").get(caseId)!.n,0);
  }finally{db.close();}
});
test("stable evidence-slot replay and synonymous action title do not duplicate tasks or reminders",async()=>{
  const {applyAssessment}=await mod();const {db,fence,a}=dbFixture();try{
    assert.throws(()=>applyAssessment(db,{sourceId,assessment:a,fence,now:100}),/transaction/);
    const run=(a:ValidatedAssessment)=>transact(db,()=>applyAssessment(db,{sourceId,assessment:a,fence,now:100}));run(a);const first=db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json;
    run({...a,actions:[{...a.actions[0],title:"请提供护照"}]});assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks WHERE kind='action'").get()!.n,1);assert.equal(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json,first);
  }finally{db.close();}
});
test("B06/B49 exact same-case item receipt only resolves its task when source human confirmed",async()=>{
  const {applyAssessment}=await mod();const {db,fence,a}=dbFixture();try{
    transact(db,()=>applyAssessment(db,{sourceId,assessment:a,fence,now:100}));const t=db.prepare("SELECT id FROM mail_case_tasks WHERE kind='action'").get()!;
    const receipt=assessment({completionSuggestions:[{taskId:String(t.id),evidence:[{sourceId,quote:"Please send passport"}]}],evidenceLocations:a.evidenceLocations});
    db.exec("UPDATE mail_triage_sources SET trust='contact_mapped'");transact(db,()=>applyAssessment(db,{sourceId,assessment:receipt,fence,now:100}));assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(String(t.id))!.state,"open");
    // A validator-restricted receipt can never clear it, even after per-message confirmation.
    db.exec("UPDATE mail_triage_sources SET trust='human_confirmed'");transact(db,()=>applyAssessment(db,{sourceId,assessment:{...receipt,applicationRestrictions:["completion_not_explicit","suggest_only"],grade:"needs_review"},fence,now:100}));assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(String(t.id))!.state,"open");
  }finally{db.close();}
});
test("B10/B48 no_action and filtered raw audit events cannot clear old obligations or provisional review",async()=>{
  const {applyAssessment,registerPendingReview}=await mod();const {db,fence,a}=dbFixture();try{
    transact(db,()=>registerPendingReview(db,{sourceId,sourceVersion:1,configEpoch:1,now:100}));transact(db,()=>applyAssessment(db,{sourceId,assessment:a,fence,now:100}));
    const noAction=assessment({events:[],evidenceLocations:[{path:"/events/0/evidence/0",sourceId,quote:"APP-001",locations:[{field:"text",segment:"current_body",start:0,end:7,coordinateUnit:"utf16"}]}]});
    transact(db,()=>applyAssessment(db,{sourceId,assessment:noAction,fence,now:100}));assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks WHERE state='open'").get()!.n,2);assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_events WHERE kind='application_approved'").get()!.n,0);
    transact(db,()=>applyAssessment(db,{sourceId,assessment:noAction,fence,now:100,releaseTemporaryReview:true}));assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks WHERE kind='action' AND state='open'").get()!.n,1);assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks WHERE obligation_key='review_new_mail'").get()!.n,0);
  }finally{db.close();}
});
test("B13/RF3 absent fresh action stays absent; source/epoch/lease/manual fence rejected without writes",async()=>{
  const {applyAssessment}=await mod();const {db,fence}=dbFixture();try{
    for(const bad of [{...fence,sourceVersion:2},{...fence,configEpoch:2},{...fence,leaseToken:"old"},{...fence,manualVersion:2}])assert.throws(()=>transact(db,()=>applyAssessment(db,{sourceId,assessment:assessment(),fence:bad,now:100})),/stale_fence/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks").get()!.n,0);
  }finally{db.close();}
});

test("B06 positive validated per-item receipt resolves only passport, not license; manual locks prevent clear",async()=>{
  const {applyAssessment}=await mod();const {validateAssessment}=await import("./mail-triage-analyzer.ts");const {db,fence,a}=dbFixture();try{
    const licenseQuote="APP-001",b=assessment({actions:[...a.actions,{...a.actions[0],title:"提供执照",requestedItems:["license"],evidence:[{sourceId,quote:licenseQuote}]}],evidenceLocations:[...a.evidenceLocations,{path:"/actions/1/evidence/0",sourceId,quote:licenseQuote,locations:[{field:"text",segment:"current_body",start:0,end:7,coordinateUnit:"utf16"}]}]});
    transact(db,()=>applyAssessment(db,{sourceId,assessment:b,fence,now:100}));const rows=db.prepare("SELECT id,requested_items_json FROM mail_case_tasks WHERE kind='action'").all();const passport=rows.find(r=>String(r.requested_items_json).includes("passport"))!,license=rows.find(r=>String(r.requested_items_json).includes("license"))!;
    const id=randomUUID(),job=randomUUID(),text="We received your passport. No action required.";
    db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,trust,observed_at) VALUES(?,1,'receipt','receipt','human_confirmed',200)").run(id);
    db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,subject,date,body_text,body_complete,message_id) VALUES(1,'INBOX',2,'100','\"Sender\"','[\"support@fixture.test\"]','[]','APP-001',190,?,1,'<receipt>')").run(text);
    db.prepare("INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id) VALUES(1,'INBOX','100',2,?)").run(id);
    db.prepare("INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,config_epoch,state,lease_token,lease_expires_at,attempt_seq) VALUES(?,?,1,1,'fixture',1,1,1,1,'context',1,'running','lease',1000,1)").run(job,id);
    const s={id,mailboxId:1,trust:"human_confirmed" as const,subject:"APP-001",text,fromAddresses:["support@fixture.test"],to:[],cc:[],date:190,bodyComplete:true};
    const raw={...assessment(),events:[{kind:"notification",evidence:[{sourceId:id,quote:"No action required."}]}],completionSuggestions:[{taskId:String(passport.id),evidence:[{sourceId:id,quote:"We received your passport."}]}]};
    const {grade,usage,evidenceLocations,applicationRestrictions,...output}=raw;void grade;void usage;void evidenceLocations;void applicationRestrictions;
    const validated=validateAssessment(output,{source:s,authorizedSources:[s],cases:[{id:caseId,provider:"Fixture",applicationId:"APP-001"}],tasks:[{id:String(passport.id),caseId,kind:"action",state:"open",title:"提交护照",requestedItems:["passport"],deadlineRaw:null,deadlineAt:null,supportSourceIds:[sourceId]}],eligibleCaseIds:[caseId],eligibleTaskIds:[String(passport.id)],contextIncomplete:false,sourceVersion:1,contextVersion:"context",manualVersion:0,configEpoch:1,tuple:{providerId:1,modelId:"fixture",modelConfigRevision:1,promptVersion:1,ruleVersion:1,schemaVersion:1}});
    assert.equal(validated.grade,"evidence_complete");const receiptFence={...fence,jobId:job};transact(db,()=>applyAssessment(db,{sourceId:id,assessment:validated,fence:receiptFence,now:200}));
    assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(String(passport.id))!.state,"resolved_by_evidence");assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(String(license.id))!.state,"open");
    const stored=JSON.parse(String(db.prepare("SELECT provenance_json FROM mail_case_tasks WHERE id=?").get(String(passport.id))!.provenance_json));assert.deepEqual(stored.supportSourceIds.sort(),[sourceId,id].sort());
    db.prepare("UPDATE mail_triage_sources SET source_version=2 WHERE id=?").run(sourceId);db.prepare("UPDATE mail_case_tasks SET state='open' WHERE id=?").run(String(passport.id));transact(db,()=>applyAssessment(db,{sourceId:id,assessment:validated,fence:receiptFence,now:200}));assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(String(passport.id))!.state,"open");
    db.prepare("UPDATE mail_triage_sources SET source_version=1 WHERE id=?").run(sourceId);
    const manual=applyManualDecision(db,{kind:"correct",target:{type:"task",id:String(passport.id)},field:"state",value:"dismissed",requestId:randomUUID(),expectedVersion:0,reason:"人工暂时关闭该义务"},{userId:7},210);
    assert.equal(JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json)).tasks.find((t:{id:string})=>t.id===passport.id).state,"dismissed");
    const undone=undoManualDecision(db,{decisionId:manual.decisionId,requestId:randomUUID(),expectedVersion:1,reason:"确认录入错误，恢复原状态"},{userId:7},220);
    assert.equal(undone.version,2);
    db.prepare("UPDATE mail_triage_jobs SET state='running',lease_token='lease',lease_expires_at=1000,manual_version=2 WHERE id=?").run(job);
    transact(db,()=>applyAssessment(db,{sourceId:id,assessment:validated,fence:{...receiptFence,manualVersion:2},now:230}));
    assert.equal(db.prepare("SELECT state FROM mail_case_tasks WHERE id=?").get(String(passport.id))!.state,"resolved_by_evidence");
    assert.equal(db.prepare("SELECT count(*) n FROM mail_case_manual_decisions WHERE undo_of=?").get(manual.decisionId)!.n,1);
  }finally{db.close();}
});
test("stable re-extraction disagreement is review, never a second task; different new evidence adds despite old manual close",async()=>{
  const {applyAssessment}=await mod();const {db,fence,a}=dbFixture();try{
    transact(db,()=>applyAssessment(db,{sourceId,assessment:a,fence,now:100}));const old=db.prepare("SELECT id FROM mail_case_tasks WHERE kind='action'").get()!;
    db.prepare("INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at) VALUES(?,?,'fixture',?,'state',1,2,'ignore','\"open\"','\"dismissed\"',?,100)").run(randomUUID(),caseId,String(old.id),JSON.stringify(independent));
    transact(db,()=>applyAssessment(db,{sourceId,assessment:{...a,actions:[{...a.actions[0],requestedItems:["changed item"]}]},fence,now:100}));assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks WHERE kind='action'").get()!.n,1);assert.ok(db.prepare("SELECT 1 FROM mail_case_tasks WHERE obligation_key='assessment_review'").get());
    const quote="APP-001",next={...a,actions:[{...a.actions[0],requestedItems:["license"],evidence:[{sourceId,quote}]}],evidenceLocations:[{path:"/actions/0/evidence/0",sourceId,quote,locations:[{field:"text" as const,segment:"current_body" as const,start:0,end:7,coordinateUnit:"utf16" as const}]}]};transact(db,()=>applyAssessment(db,{sourceId,assessment:next,fence,now:100}));
    const p=JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json));assert.equal(p.tasks.find((t:{id:string})=>t.id===old.id).state,"dismissed");assert.equal(p.tasks.filter((t:{kind:string,state:string})=>t.kind==="action"&&t.state==="open").length,1);
  }finally{db.close();}
});


test("B62 active source with newer generation invalidates old facts and tasks immediately",async()=>{
  const {projectCase}=await mod();const p=projectCase(input({events:[event("application_approved"),event("request_action",{id:"event-request"})],tasks:[task()],sources:[{id:sourceId,state:"active",trust:"human_confirmed",version:2}]}));
  assert.equal(p.sourceUnavailable,true);assert.equal(p.decision,"unknown");assert.equal(p.column,"needs_you");assert.ok(!p.tasks.some(t=>t.id==="task-passport"));
});
test("explicit awaiting_external wins results when no open action remains",async()=>{
  const {projectCase}=await mod();const p=projectCase(input({events:[event("application_approved")],tasks:[task("waiting",{state:"awaiting_external"})]}));assert.equal(p.column,"awaiting_platform");assert.equal(p.decision,"approved");
});
test("account risks survive application appeal cycle separation",async()=>{
  const {projectCase}=await mod();const p=projectCase(input({events:[event("account_disabled"),event("reconsideration_accepted",{id:"accepted",decisionCycle:2})]}));assert.equal(p.column,"needs_you");assert.equal(p.requiresReview,true);assert.equal(p.priority.rank,0);
});
test("B62 source support outside current authorization is not eligible for automatic association",async()=>{
  const {applyAssessment}=await mod();const {db,fence,a}=dbFixture();try{
    const stale=randomUUID();db.exec("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,status) VALUES(2,1,'x','b','private@private.test','private.test','active')");db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,observed_at) VALUES(?,2,'x','x',1)").run(stale);
    db.prepare("UPDATE mail_application_cases SET identity_provenance_json=? WHERE id=?").run(JSON.stringify(provenance([stale])),caseId);
    transact(db,()=>applyAssessment(db,{sourceId,assessment:a,fence,now:100}));assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_sources WHERE case_id=?").get(caseId)!.n,0);
  }finally{db.close();}
});
test("apply stops while paused although pending source registration stays available",async()=>{
  const {applyAssessment}=await mod();const {db,fence,a}=dbFixture();try{db.exec("UPDATE mail_triage_settings SET state='blocked_config'");assert.throws(()=>transact(db,()=>applyAssessment(db,{sourceId,assessment:a,fence,now:100})),/stale_fence/);}finally{db.close();}
});
test("B62 task with mixed active/stale support cannot become a result; independent manual decision remains",async()=>{
  const {projectCase}=await mod();const p=projectCase(input({events:[event("application_approved")],tasks:[task("stale",{state:"resolved_by_evidence",provenance:provenance([sourceId,"missing"])})],manualDecisions:[{objectId:caseId,field:"decision",value:"approved",appliedVersion:2,createdAt:100,provenance:independent}]}));assert.equal(p.sourceUnavailable,true);assert.equal(p.decision,"approved");assert.equal(p.decisionLabel,"人工核验");assert.equal(p.column,"needs_you");
});

test("B62 stored reprojection removes revoked-generation support without model call and preserves replay",async()=>{
  const {applyAssessment,reprojectCases}=await mod();const {db,fence,a}=dbFixture();try{
    transact(db,()=>applyAssessment(db,{sourceId,assessment:a,fence,now:100}));db.prepare("UPDATE mail_triage_sources SET source_version=2 WHERE id=?").run(sourceId);
    const p=transact(db,()=>reprojectCases(db,{caseIds:[caseId,caseId],now:200}));assert.equal(p.length,1);assert.equal(p[0].sourceUnavailable,true);assert.ok(!p[0].tasks.some(t=>t.kind==="action"));
    const before=db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json;transact(db,()=>reprojectCases(db,{caseIds:[caseId],now:200}));assert.equal(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json,before);
  }finally{db.close();}
});

test("safety reviews persist exactly once, counts equal stored tasks and manual override is durable",async()=>{
  const {applyAssessment,reprojectCases}=await mod();const {db,fence,a}=dbFixture();try{
    const quote="APP-001";const risk={...a,actions:[],events:[{kind:"account_disabled",evidence:[{sourceId,quote}]}],evidenceLocations:[{path:"/events/0/evidence/0",sourceId,quote,locations:[{field:"text" as const,segment:"current_body" as const,start:0,end:7,coordinateUnit:"utf16" as const}]}]};
    transact(db,()=>applyAssessment(db,{sourceId,assessment:risk,fence,now:100}));let p=JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json));
    const review=p.tasks.find((t:{kind:string})=>t.kind==="review");assert.ok(review);assert.ok(db.prepare("SELECT 1 FROM mail_case_tasks WHERE id=?").get(review.id));assert.equal(new Set(p.tasks.map((t:{id:string})=>t.id)).size,p.tasks.length);assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks WHERE case_id=?").get(caseId)!.n,p.tasks.length);
    db.prepare("INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at) VALUES(?,?,'fixture',?,'state',1,2,'checked','\"open\"','\"dismissed\"',?,100)").run(randomUUID(),caseId,review.id,JSON.stringify(independent));
    transact(db,()=>reprojectCases(db,{caseIds:[caseId],now:100}));transact(db,()=>applyAssessment(db,{sourceId,assessment:risk,fence,now:100}));p=JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json));assert.equal(p.tasks.find((t:{id:string})=>t.id===review.id).state,"dismissed");assert.equal(p.tasks.filter((t:{id:string})=>t.id===review.id).length,1);
    transact(db,()=>applyAssessment(db,{sourceId,assessment:{...risk,events:[{...risk.events[0],kind:"account_suspended"}]},fence,now:100}));p=JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json));assert.ok(p.tasks.some((t:{id:string,kind:string,state:string})=>t.id!==review.id&&t.kind==="review"&&t.state==="open"));
  }finally{db.close();}
});

test("B51 persisted affirmative reconsideration acceptance starts a later cycle, never supersedes by late mail",async()=>{
  const {applyAssessment}=await mod();const {db,fence,a}=dbFixture();try{
    const prov=JSON.stringify(provenance());db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES('old-decline',?,?,'1:application_declined:legacy','application_declined',1,50,60,'[]',?)").run(caseId,sourceId,prov);
    const quote="APP-001",accepted=assessment({events:[{kind:"reconsideration_accepted",evidence:[{sourceId,quote}]}],evidenceLocations:[{path:"/events/0/evidence/0",sourceId,quote,locations:[{field:"text",segment:"current_body",start:0,end:7,coordinateUnit:"utf16"}]}]});
    transact(db,()=>applyAssessment(db,{sourceId,assessment:accepted,fence,now:100}));const p=JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json));assert.equal(p.decisionCycle,2);assert.equal(p.decision,"pending");assert.equal(p.column,"awaiting_platform");
    transact(db,()=>applyAssessment(db,{sourceId,assessment:accepted,fence,now:100}));assert.equal(db.prepare("SELECT max(decision_cycle) AS n FROM mail_case_events WHERE case_id=?").get(caseId)!.n,2);
  }finally{db.close();}
});


test("B17/B51 late or unconfirmed reconsideration cannot create a new cycle over independent decline",async()=>{
  const {applyAssessment}=await mod();for(const [date,trust] of [[40,"human_confirmed"],[90,"contact_mapped"]] as const){const {db,fence}=dbFixture();try{
    db.prepare("UPDATE mail_messages SET date=?").run(date);db.prepare("UPDATE mail_triage_sources SET trust=?").run(trust);
    db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES('decline',?,?,'1:decline','application_declined',1,50,60,'[]',?)").run(caseId,sourceId,JSON.stringify(independent));
    const quote="APP-001",a=assessment({events:[{kind:"reconsideration_accepted",evidence:[{sourceId,quote}]}],evidenceLocations:[{path:"/events/0/evidence/0",sourceId,quote,locations:[{field:"text",segment:"current_body",start:0,end:7,coordinateUnit:"utf16"}]}]});transact(db,()=>applyAssessment(db,{sourceId,assessment:a,fence,now:100}));const p=JSON.parse(String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json));assert.equal(p.decisionCycle,1);assert.equal(p.decision,"declined");
  }finally{db.close();}}
});


test("current scope UIDVALIDITY mismatch fences apply and pending registration before writes",async()=>{
  const {applyAssessment,registerPendingReview}=await mod();const {db,fence,a}=dbFixture();try{db.exec("UPDATE mail_triage_scope SET uid_validity='200'");assert.throws(()=>transact(db,()=>applyAssessment(db,{sourceId,assessment:a,fence,now:100})),/stale_fence/);assert.throws(()=>transact(db,()=>registerPendingReview(db,{sourceId,sourceVersion:1,configEpoch:1,now:100})),/stale_fence/);assert.equal(db.prepare("SELECT count(*) AS n FROM mail_case_tasks").get()!.n,0);}finally{db.close();}
});

for (const example of [
  { name:"obsolete decline v1 cannot roll over active source v2", eventVersion:1, kind:"source_derived", extraStaleSupport:false, staleApproval:false, expectedCycle:1 },
  { name:"current decline v2 still rolls over active source v2", eventVersion:2, kind:"source_derived", extraStaleSupport:false, staleApproval:false, expectedCycle:2 },
  { name:"current decline with mixed stale support cannot roll over", eventVersion:2, kind:"source_derived", extraStaleSupport:true, staleApproval:false, expectedCycle:1 },
  { name:"obsolete approval cannot block current valid decline rollover", eventVersion:2, kind:"source_derived", extraStaleSupport:false, staleApproval:true, expectedCycle:2 },
  { name:"independent verified decline does not depend on origin source version", eventVersion:1, kind:"independent_manual", extraStaleSupport:false, staleApproval:false, expectedCycle:2 },
] as const) {
  test(`fix1 B51/B62 ${example.name}`,async()=>{
    const {applyAssessment}=await mod();
    const {db,fence}=dbFixture();
    try {
      // The acceptance and its job/fence are current v2; only the prior event may be obsolete.
      db.prepare("UPDATE mail_triage_sources SET source_version=2 WHERE id=?").run(sourceId);
      db.prepare("UPDATE mail_triage_jobs SET source_version=2 WHERE id=?").run(fence.jobId);
      const supportIds=[sourceId];
      if(example.extraStaleSupport){
        const stale=randomUUID();
        db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,state,trust,observed_at) VALUES(?,1,'stale','stale','stale','human_confirmed',10)").run(stale);
        supportIds.push(stale);
      }
      const declineProvenance=example.kind==="independent_manual"?independent:provenance(supportIds);
      db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES('prior-decline',?,?,?,'application_declined',1,50,60,'[]',?)")
        .run(caseId,sourceId,`${example.eventVersion}:application_declined:old`,JSON.stringify(declineProvenance));
      if(example.staleApproval){
        db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES('obsolete-approval',?,?,'1:application_approved:old','application_approved',1,40,45,'[]',?)")
          .run(caseId,sourceId,JSON.stringify(provenance()));
      }
      const quote="APP-001";
      const accepted=assessment({
        events:[{kind:"reconsideration_accepted",evidence:[{sourceId,quote}]}],
        evidenceLocations:[{path:"/events/0/evidence/0",sourceId,quote,locations:[{field:"text",segment:"current_body",start:0,end:7,coordinateUnit:"utf16"}]}],
      });
      const currentFence={...fence,sourceVersion:2};
      transact(db,()=>applyAssessment(db,{sourceId,assessment:accepted,fence:currentFence,now:100}));
      const stored=db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!;
      const projection=JSON.parse(String(stored.projection_json));
      assert.equal(projection.decisionCycle,example.expectedCycle);
      assert.equal(projection.decision,"pending");
      assert.equal(db.prepare("SELECT decision_cycle FROM mail_case_events WHERE case_id=? AND kind='reconsideration_accepted'").get(caseId)!.decision_cycle,example.expectedCycle);
      assert.equal(projection.sourceUnavailable,example.eventVersion!==2&&example.kind!=="independent_manual"||example.extraStaleSupport||example.staleApproval);
      // A stable replay uses the same eligible facts, not the excluded historical decline/approval.
      transact(db,()=>applyAssessment(db,{sourceId,assessment:accepted,fence:currentFence,now:100}));
      assert.equal(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json,stored.projection_json);
    }finally{db.close();}
  });
}
