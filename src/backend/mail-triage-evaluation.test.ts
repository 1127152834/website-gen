import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { migrate, openDb } from "./db.ts";
import {
  approveNotificationRouting,
  canAutoRouteNotification,
  evaluateNotificationGate,
  getEvaluationStatus,
  recordNotificationAudit,
  registerNotificationAudit,
  saveEvaluationReport,
  type EvaluationReport, type EvaluationStatus, type Qualification,
} from "./mail-triage-evaluation.ts";
import type { ValidatedAssessment } from "./mail-triage-analyzer.ts";
import type { VersionTuple } from "../shared/mail-triage-types.ts";
import { workspaceRpcRisk } from "./workspace-rpc-policy.ts";
import { ASSISTANT_EXCLUDED_METHODS } from "./assistant-tools.ts";
import { createWorkspace } from "./index.ts";

const tuple: VersionTuple = { providerId: 7, modelId: "fixture-model", modelConfigRevision: 3, promptVersion: 1, ruleVersion: 1, schemaVersion: 1 };
const hash = "a".repeat(64);
const report = (overrides: Partial<EvaluationReport> = {}): EvaluationReport => ({
  tuple,
  datasetSource: "user_authorized_redacted_mail",
  humanLabelsConfirmed: true,
  redactedRealMail: true,
  total: 100,
  strata: { actionRequired: 20, finalOrConditionalDecision: 20, associationConflict: 20, quotedOldRequest: 20, incompleteContent: 20 },
  missedActionCount: 0,
  incorrectCriticalTransitionCount: 0,
  incorrectCriticalAssociationCount: 0,
  injectionRegression: { independentSet: true, total: 8, failures: 0 },
  artifactHash: hash,
  ...overrides,
});
const authorizeTuple=(db:ReturnType<typeof openDb>,t=tuple)=>{
  db.prepare("INSERT INTO model_providers(id,name,protocol,base_url,api_key_ciphertext,models_json,created_at,config_revision) VALUES(?,?,'openai','https://models.example.test',? ,?,1,5)").run(t.providerId,`provider-${t.providerId}`,Buffer.from("sealed"),JSON.stringify([{id:t.modelId}]));
  db.prepare("INSERT INTO model_roles(role,provider_id,model_id,thinking) VALUES('mail_triage',?,?,'off')").run(t.providerId,t.modelId);
  db.prepare("UPDATE mail_triage_settings SET enabled=1,state='enabled',model_config_revision=?,consent_provider_revision=5").run(t.modelConfigRevision);
};

const notification = (): ValidatedAssessment => ({
  schemaVersion: 1, primaryCategory: "general_other", tag: "普通通知", summary: "明确说明无需回复。",
  caseSuggestion: { providerCandidate: null, applicationId: null, candidateCaseId: null, matchBasis: [], needsReview: false },
  events: [], actions: [], completionSuggestions: [], uncertainties: [], requiresHumanReview: false,
  grade: "evidence_complete", usage: null, evidenceLocations: [], applicationRestrictions: [],
});

test("evaluation gate rejects 99 real labels and any high-risk stratum below 20", () => {
  assert.equal(evaluateNotificationGate({ tuple, report: report({ total: 99 }) }).eligible, false);
  const low = report({ strata: { ...report().strata, incompleteContent: 19 } });
  assert.equal(evaluateNotificationGate({ tuple, report: low }).eligible, false);
});

test("Task12 RPCs have explicit risk and are excluded from the general assistant", () => {
  assert.equal(workspaceRpcRisk("mail.triage.evaluationStatus"),"read");
  for(const method of ["mail.triage.saveEvaluationReport","mail.triage.approveNotificationRouting","mail.triage.auditOutcome"]){assert.equal(workspaceRpcRisk(method),"confirm");assert.ok(ASSISTANT_EXCLUDED_METHODS[method]);}
});

test("evaluation gate is tuple-bound and does not claim quality without real human labels", () => {
  assert.equal(evaluateNotificationGate({ tuple: { ...tuple, ruleVersion: 2 }, report: report() }).eligible, false);
  const result = evaluateNotificationGate({ tuple, report: report({ humanLabelsConfirmed: false, redactedRealMail: false, total: 0 }) });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("missing_real_human_labels"));
});

test("automatic routing requires an explicitly approved current qualification and a safe no-action assessment", () => {
  const qualification = { tuple, reportHash: hash, state: "approved" as const, approvalRevision: 2, unresolvedRecheck: false };
  assert.equal(canAutoRouteNotification({ assessment: notification(), qualification, enabled: true }), true);
  assert.equal(canAutoRouteNotification({ assessment: notification(), qualification: null, enabled: true }), false);
  assert.equal(canAutoRouteNotification({ assessment: { ...notification(), actions: [{ kind: "reply", title: "reply", requestedItems: [], deadlineRaw: null, deadlineAt: null, satisfiesTaskIds: [], evidence: [] }] }, qualification, enabled: true }), false);
  assert.equal(canAutoRouteNotification({ assessment: notification(), qualification: { ...qualification, state: "paused_audit" }, enabled: true }), false);
});

test("saved reports are immutable history; selecting a new report invalidates old approval and approval is CAS-bound", () => {
  const db = openDb(":memory:"); migrate(db);
  try {
    authorizeTuple(db);
    const actor = { userId: 9 };
    assert.throws(() => saveEvaluationReport(db, { report: report(), expectedVersion: 0, requestId: randomUUID(), reason: "伪造actor" }, null as never, 9), /服务端操作者/);
    const first = saveEvaluationReport(db, { report: report(), expectedVersion: 0, requestId: randomUUID(), reason: "保存人工评估" }, actor, 10);
    assert.equal(first.state, "not_qualified");
    const approved = approveNotificationRouting(db, { tuple, reportHash: first.reportHash, expectedVersion: first.approvalRevision, requestId: randomUUID(), reason: "人工批准" }, actor, 11);
    assert.equal(approved.state, "approved");
    const replayId=randomUUID(),replayInput={tuple,reportHash:first.reportHash,expectedVersion:approved.approvalRevision,requestId:replayId,reason:"显式重复批准"};
    const replayed=approveNotificationRouting(db,replayInput,actor,12);
    db.exec("UPDATE mail_triage_settings SET model_config_revision=4");
    const beforeReplay=Buffer.from(db.serialize());
    assert.deepEqual(approveNotificationRouting(db,replayInput,actor,13),replayed);
    assert.deepEqual(Buffer.from(db.serialize()),beforeReplay);
    assert.throws(()=>approveNotificationRouting(db,{...replayInput,reason:"相同requestId不同内容"},actor,14),/requestId 已用于不同内容/);
    assert.deepEqual(Buffer.from(db.serialize()),beforeReplay);
    db.exec("UPDATE mail_triage_settings SET model_config_revision=3");
    assert.throws(() => approveNotificationRouting(db, { tuple, reportHash: first.reportHash, expectedVersion: first.approvalRevision, requestId: randomUUID(), reason: "陈旧批准" }, actor, 12), /版本冲突/);
    const secondReport = report({ artifactHash: "b".repeat(64), datasetSource: "user_authorized_redacted_mail" });
    const second = saveEvaluationReport(db, { report: secondReport, expectedVersion: replayed.approvalRevision, requestId: randomUUID(), reason: "选择新报告" }, actor, 14);
    assert.equal(second.state, "not_qualified");
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_evaluation_reports").get()!.n, 2);
    assert.throws(() => saveEvaluationReport(db, { report: { ...report(), total: 101 }, expectedVersion: second.approvalRevision, requestId: randomUUID(), reason: "改写旧hash" }, actor, 14), /报告哈希冲突/);
  } finally { db.close(); }
});

test("audit sampling is durable: all first 100, then every tenth; a miss pauses and preserves the recheck boundary", () => {
  const db = openDb(":memory:"); migrate(db);
  try {
    authorizeTuple(db);
    const actor = { userId: 9 };
    const saved = saveEvaluationReport(db, { report: report(), expectedVersion: 0, requestId: randomUUID(), reason: "保存人工评估" }, actor, 10);
    const approved = approveNotificationRouting(db, { tuple, reportHash: saved.reportHash, expectedVersion: saved.approvalRevision, requestId: randomUUID(), reason: "人工批准" }, actor, 11);
    let sampled = 0;
    const assessmentIds = Array.from({ length: 110 }, () => randomUUID());
    for (let i = 1; i <= 110; i++) {
      const row = registerNotificationAudit(db, { assessmentId: assessmentIds[i - 1]!, tuple }, 20 + i);
      if (row.sampled) sampled++;
    }
    assert.equal(sampled, 101);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_audit_positions WHERE sampled=1").get()!.n, 101);
    for (let i = 1; i <= 3; i++) recordNotificationAudit(db, { assessmentId: assessmentIds[i - 1]!, verdict: "correct", expectedVersion: 1, requestId: randomUUID(), reason: "人工抽查" }, actor, 200 + i);
    const missed = recordNotificationAudit(db, { assessmentId: assessmentIds[3]!, verdict: "missed_action", expectedVersion: 1, requestId: randomUUID(), reason: "漏待办" }, actor, 204);
    assert.equal(missed.paused, true);
    assert.equal(missed.recheckAssessmentIds.length, 107);
    assert.deepEqual(missed.recheckAssessmentIds, assessmentIds.slice(3));
    const status = getEvaluationStatus(db, tuple);
    assert.equal(status?.state, "paused_audit");
    assert.equal(status?.lastPassedBoundary, 3);
    assert.equal(status?.unresolvedRecheck, true);
    assert.throws(() => approveNotificationRouting(db, { tuple, reportHash: saved.reportHash, expectedVersion: approved.approvalRevision + 1, requestId: randomUUID(), reason: "不能静默恢复" }, actor, 205), /新的合格人工评估报告/);
    const sampledBefore=db.prepare("SELECT assessment_id,sampled FROM mail_triage_audit_positions ORDER BY sequence").all();
    for(let index=3;index<assessmentIds.length;index++){
      recordNotificationAudit(db,{assessmentId:assessmentIds[index]!,verdict:"correct",expectedVersion:index===3?2:1,requestId:randomUUID(),reason:"逐项复核遗漏边界后的全部邮件"},actor,300+index);
    }
    const resolved=getEvaluationStatus(db,tuple);
    assert.equal(resolved?.unresolvedRecheck,false);
    assert.equal(resolved?.lastPassedBoundary,110);
    assert.deepEqual(db.prepare("SELECT assessment_id,sampled FROM mail_triage_audit_positions ORDER BY sequence").all(),sampledBefore);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_audit_verdict_history").get()!.n,111);
    assert.equal(db.prepare("SELECT count(*) n FROM mail_triage_audit_positions WHERE verdict<>'passed' OR verdict IS NULL").get()!.n,0);
  } finally { db.close(); }
});

test("strict persisted report JSON fails closed instead of falling back", () => {
  const db = openDb(":memory:"); migrate(db);
  try {
    authorizeTuple(db);
    const actor = { userId: 9 };
    saveEvaluationReport(db, { report: report(), expectedVersion: 0, requestId: randomUUID(), reason: "保存人工评估" }, actor, 10);
    db.exec("PRAGMA ignore_check_constraints=ON");
    db.prepare("UPDATE mail_triage_evaluation_reports SET report_json='{}'").run();
    assert.throws(() => getEvaluationStatus(db, tuple), /数据完整性错误/);
  } finally { db.close(); }
});

test("local evaluation CLI never invents real-label counts and emits NOT_QUALIFIED", () => {
  const dir=mkdtempSync(join(tmpdir(),"mail-triage-eval-")),labels=join(dir,"labels.json"),predictions=join(dir,"predictions.json"),output=join(dir,"report.json");
  try {
    writeFileSync(labels,JSON.stringify({tuple,datasetSource:"synthetic_fixture",humanLabelsConfirmed:false,redactedRealMail:false,items:[],injectionIndependentSet:false,injectionItems:[]}));
    writeFileSync(predictions,JSON.stringify({tuple,items:[],injectionItems:[]}));
    const run=spawnSync(process.execPath,["scripts/evaluate-mail-triage.ts","--labels",labels,"--predictions",predictions,"--output",output],{cwd:process.cwd(),encoding:"utf8"});
    assert.equal(run.status,0,run.stderr);
    const saved=JSON.parse(readFileSync(output,"utf8"));
    assert.equal(saved.status,"NOT_QUALIFIED");
    assert.equal(saved.report.total,0);
    assert.ok(saved.gate.reasons.includes("missing_real_human_labels"));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("CLI requires strict tuple-bound one-to-one unique production and independent injection datasets",()=>{
  const make=()=>{const items=Array.from({length:100},(_,i)=>({id:`mail-${i}`,strata:["actionRequired","finalOrConditionalDecision","associationConflict","quotedOldRequest","incompleteContent"],requiresAction:i%2===0,criticalTransition:null,association:null}));const injectionItems=Array.from({length:5},(_,i)=>({id:`injection-${i}`,expectedSafe:true}));return {labels:{tuple,datasetSource:"user_authorized_redacted_mail",humanLabelsConfirmed:true,redactedRealMail:true,items,injectionIndependentSet:true,injectionItems},predictions:{tuple,items:items.map(({id,requiresAction,criticalTransition,association})=>({id,requiresAction,criticalTransition,association})),injectionItems:injectionItems.map(({id,expectedSafe})=>({id,safe:expectedSafe}))}};};
  const run=(mutate:(data:ReturnType<typeof make>)=>void)=>{const dir=mkdtempSync(join(tmpdir(),"mail-triage-cli-strict-")),data=make(),labels=join(dir,"labels.json"),predictions=join(dir,"predictions.json"),output=join(dir,"output.json");try{mutate(data);writeFileSync(labels,JSON.stringify(data.labels));writeFileSync(predictions,JSON.stringify(data.predictions));const result=spawnSync(process.execPath,["scripts/evaluate-mail-triage.ts","--labels",labels,"--predictions",predictions,"--output",output],{cwd:process.cwd(),encoding:"utf8"});return {status:result.status,stderr:result.stderr,output:result.status===0?JSON.parse(readFileSync(output,"utf8")):null};}finally{rmSync(dir,{recursive:true,force:true});}};
  const good=run(()=>{});assert.equal(good.status,0,good.stderr);assert.equal(good.output.status,"QUALIFIED");
  const omittedOptional=run(d=>{for(const item of d.labels.items){Reflect.deleteProperty(item,"criticalTransition");Reflect.deleteProperty(item,"association");}for(const item of d.predictions.items){Reflect.deleteProperty(item,"criticalTransition");Reflect.deleteProperty(item,"association");}});assert.equal(omittedOptional.status,0,omittedOptional.stderr);assert.equal(omittedOptional.output.status,"QUALIFIED");
  for(const mutate of [
    (d:ReturnType<typeof make>)=>{d.predictions.tuple={...tuple,ruleVersion:2};},
    (d:ReturnType<typeof make>)=>{d.labels.items[1]!.id=d.labels.items[0]!.id;},
    (d:ReturnType<typeof make>)=>{d.predictions.items.pop();},
    (d:ReturnType<typeof make>)=>{d.predictions.items.push({id:"extra",requiresAction:false,criticalTransition:null,association:null});},
    (d:ReturnType<typeof make>)=>{d.labels.items[0]!.strata.push("unknown");},
    (d:ReturnType<typeof make>)=>{d.labels.injectionItems[1]!.id=d.labels.injectionItems[0]!.id;},
    (d:ReturnType<typeof make>)=>{d.labels.injectionItems[0]!.id=d.labels.items[0]!.id;},
    (d:ReturnType<typeof make>)=>{d.labels.items[0]!.criticalTransition={} as never;},
    (d:ReturnType<typeof make>)=>{d.predictions.items[0]!.association=[] as never;},
  ]){const bad=run(mutate);assert.notEqual(bad.status,0);assert.equal(bad.output,null);}
  const notIndependent=run(d=>{d.labels.injectionIndependentSet=false;});assert.equal(notIndependent.status,0,notIndependent.stderr);assert.equal(notIndependent.output.status,"NOT_QUALIFIED");
});

test("approval resolves the authoritative current tuple and recomputes the stored gate",()=>{
  const db=openDb(":memory:");migrate(db);authorizeTuple(db);const actor={userId:9};try{
    const historical={...tuple,modelConfigRevision:2},savedHistorical=saveEvaluationReport(db,{report:report({tuple:historical}),requestId:randomUUID(),expectedVersion:0,reason:"历史报告"},actor,1);
    assert.throws(()=>approveNotificationRouting(db,{tuple:historical,reportHash:savedHistorical.reportHash,requestId:randomUUID(),expectedVersion:savedHistorical.approvalRevision,reason:"不得批准历史tuple"},actor,2),/当前模型版本|当前配置/);
    const saved=saveEvaluationReport(db,{report:report(),requestId:randomUUID(),expectedVersion:0,reason:"当前报告"},actor,3);
    db.exec("UPDATE mail_triage_settings SET model_config_revision=4");assert.throws(()=>approveNotificationRouting(db,{tuple,reportHash:saved.reportHash,requestId:randomUUID(),expectedVersion:saved.approvalRevision,reason:"配置已变化"},actor,4),/当前模型版本|当前配置/);
    db.exec("UPDATE mail_triage_settings SET model_config_revision=3; UPDATE mail_triage_evaluation_reports SET report_json=json_set(report_json,'$.total',99),eligible=1 WHERE report_hash='"+saved.reportHash+"'");
    assert.throws(()=>approveNotificationRouting(db,{tuple,reportHash:saved.reportHash,requestId:randomUUID(),expectedVersion:saved.approvalRevision,reason:"缓存资格不能替代重算"},actor,5),/未达到|不一致/);
  }finally{db.close();}
});

test("actual workspace Task12 RPCs enforce strict input, idempotence and stale CAS", async () => {
  const dir=mkdtempSync(join(tmpdir(),"mail-triage-eval-rpc-")),assessmentId=randomUUID(),db=openDb(join(dir,"website-gen.sqlite"));migrate(db);authorizeTuple(db);registerNotificationAudit(db,{assessmentId,tuple},1);db.close();
  const workspace=createWorkspace({userDir:dir,key:randomBytes(32),ownerUserId:9});
  try {
    const saveInput={report:report(),expectedVersion:0,requestId:randomUUID(),reason:"保存真实人工评估"};
    await assert.rejects(async()=>workspace.handlers["mail.triage.saveEvaluationReport"]({...saveInput,extra:true}),/参数|结构/);
    const saved=await workspace.handlers["mail.triage.saveEvaluationReport"](saveInput) as Qualification;assert.deepEqual(await workspace.handlers["mail.triage.saveEvaluationReport"](saveInput),saved);
    await assert.rejects(async()=>workspace.handlers["mail.triage.saveEvaluationReport"]({...saveInput,reason:"变更内容"}),/requestId/);
    const approveInput={tuple,reportHash:saved.reportHash,expectedVersion:saved.approvalRevision,requestId:randomUUID(),reason:"明确批准自动通知分流"};
    const changed=openDb(join(dir,"website-gen.sqlite"));changed.exec("UPDATE mail_triage_settings SET model_config_revision=4");changed.close();await assert.rejects(async()=>workspace.handlers["mail.triage.approveNotificationRouting"](approveInput),/当前模型版本/);const restored=openDb(join(dir,"website-gen.sqlite"));restored.exec("UPDATE mail_triage_settings SET model_config_revision=3");restored.close();
    const approved=await workspace.handlers["mail.triage.approveNotificationRouting"](approveInput) as Qualification;assert.deepEqual(await workspace.handlers["mail.triage.approveNotificationRouting"](approveInput),approved);
    await assert.rejects(async()=>workspace.handlers["mail.triage.approveNotificationRouting"]({...approveInput,requestId:randomUUID()}),/版本冲突/);
    const snapshot=openDb(join(dir,"website-gen.sqlite")),before=snapshot.serialize();snapshot.close();const status=await workspace.handlers["mail.triage.evaluationStatus"](tuple) as EvaluationStatus;assert.equal(status.state,"approved");const check=openDb(join(dir,"website-gen.sqlite"));assert.deepEqual(check.serialize(),before);check.close();
    const auditInput={assessmentId,verdict:"missed_action",expectedVersion:1,requestId:randomUUID(),reason:"人工发现漏待办"};
    const missed=await workspace.handlers["mail.triage.auditOutcome"](auditInput);assert.deepEqual(await workspace.handlers["mail.triage.auditOutcome"](auditInput),missed);
    await assert.rejects(async()=>workspace.handlers["mail.triage.auditOutcome"]({...auditInput,requestId:randomUUID()}),/版本冲突/);
  } finally {await workspace.close();rmSync(dir,{recursive:true,force:true});}
});
