import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TRIAGE_PROMPT_VERSION, TRIAGE_RULE_VERSION, type ValidatedAssessment } from "./mail-triage-analyzer.ts";
import type { ServerActor } from "./mail-triage-service.ts";
import type { MutationMeta, VersionTuple } from "../shared/mail-triage-types.ts";
import { MAIL_TRIAGE_LIMITS, MAIL_TRIAGE_SCHEMA_VERSION } from "../shared/mail-triage-types.ts";

export interface EvaluationReport {
  tuple: VersionTuple;
  datasetSource: "user_authorized_redacted_mail"|"synthetic_fixture";
  humanLabelsConfirmed: boolean;
  redactedRealMail: boolean;
  total: number;
  strata: { actionRequired: number; finalOrConditionalDecision: number; associationConflict: number; quotedOldRequest: number; incompleteContent: number };
  missedActionCount: number;
  incorrectCriticalTransitionCount: number;
  incorrectCriticalAssociationCount: number;
  injectionRegression: { independentSet: boolean; total: number; failures: number };
  artifactHash: string;
}
export interface Qualification {
  tuple: VersionTuple; reportHash: string; state: "not_qualified"|"approved"|"paused_audit"; approvalRevision: number; unresolvedRecheck: boolean;
}
export interface EvaluationStatus extends Qualification { eligible: boolean; reasons: string[]; report: EvaluationReport; lastPassedBoundary: number }

type Row = Record<string, unknown>;
const tupleValues = (t: VersionTuple) => [t.providerId,t.modelId,t.modelConfigRevision,t.promptVersion,t.ruleVersion,t.schemaVersion] as const;
const sameTuple = (a: VersionTuple,b: VersionTuple) => tupleValues(a).every((value,index)=>value===tupleValues(b)[index]);
const canonicalValue=(value:unknown):unknown=>Array.isArray(value)?value.map(canonicalValue):value!==null&&typeof value==="object"?Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b,"en")).map(([key,item])=>[key,canonicalValue(item)])):value;
const canonical=(value:unknown)=>JSON.stringify(canonicalValue(value));
const digest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
const actorId=(actor:ServerActor)=>{if(!actor||!Number.isSafeInteger(actor.userId)||actor.userId<=0)throw new Error("人工写操作缺少经过验证的服务端操作者");return `user:${actor.userId}`;};
const atomic=<T>(db:DatabaseSync,work:()=>T):T=>{const own=!db.isTransaction;if(own)db.exec("BEGIN IMMEDIATE");try{const value=work();if(own)db.exec("COMMIT");return value;}catch(error){if(own)db.exec("ROLLBACK");throw error;}};
const isInt=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
const exact=(value:unknown,keys:string[])=>Boolean(value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join("\0")===[...keys].sort().join("\0"));
const assertTuple=(t:VersionTuple)=>{if(!exact(t,["providerId","modelId","modelConfigRevision","promptVersion","ruleVersion","schemaVersion"])||!Number.isSafeInteger(t.providerId)||t.providerId<=0||typeof t.modelId!=="string"||!t.modelId.trim()||![t.modelConfigRevision,t.promptVersion,t.ruleVersion,t.schemaVersion].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error("版本tuple无效");};
const assertMeta=(input:MutationMeta)=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)||!isInt(input.expectedVersion)||typeof input.reason!=="string"||!input.reason.trim()||input.reason.length>2000)throw new Error("写操作参数无效");};
function parseReport(value:unknown):EvaluationReport {
  let raw:unknown;try{raw=JSON.parse(String(value));}catch{throw new Error("数据完整性错误：评估报告不是有效JSON");}
  if(!exact(raw,["tuple","datasetSource","humanLabelsConfirmed","redactedRealMail","total","strata","missedActionCount","incorrectCriticalTransitionCount","incorrectCriticalAssociationCount","injectionRegression","artifactHash"]))throw new Error("数据完整性错误：评估报告结构无效");
  const r=raw as Record<string,unknown>,t=r.tuple as Record<string,unknown>|undefined,s=r.strata as Record<string,unknown>|undefined,i=r.injectionRegression as Record<string,unknown>|undefined;
  if(!t||!s||!i||!exact(t,["providerId","modelId","modelConfigRevision","promptVersion","ruleVersion","schemaVersion"])||!exact(s,["actionRequired","finalOrConditionalDecision","associationConflict","quotedOldRequest","incompleteContent"])||!exact(i,["independentSet","total","failures"])||!["user_authorized_redacted_mail","synthetic_fixture"].includes(String(r.datasetSource))||typeof r.humanLabelsConfirmed!=="boolean"||typeof r.redactedRealMail!=="boolean"||!isInt(r.total)||typeof r.artifactHash!=="string"||!/^[a-f0-9]{64}$/i.test(r.artifactHash)
    || ![t.providerId,t.modelConfigRevision,t.promptVersion,t.ruleVersion,t.schemaVersion].every(n=>Number.isSafeInteger(n)&&Number(n)>0)||typeof t.modelId!=="string"||!t.modelId
    || ![s.actionRequired,s.finalOrConditionalDecision,s.associationConflict,s.quotedOldRequest,s.incompleteContent,r.missedActionCount,r.incorrectCriticalTransitionCount,r.incorrectCriticalAssociationCount,i.total,i.failures].every(isInt)
    ||typeof i.independentSet!=="boolean")throw new Error("数据完整性错误：评估报告结构无效");
  return raw as EvaluationReport;
}
export function evaluateNotificationGate(input:{tuple:VersionTuple;report:EvaluationReport}):{eligible:boolean;reasons:string[]} {
  const r=input.report,reasons:string[]=[];
  if(!sameTuple(input.tuple,r.tuple))reasons.push("version_tuple_mismatch");
  if(r.datasetSource!=="user_authorized_redacted_mail"||!r.humanLabelsConfirmed||!r.redactedRealMail||r.total<1)reasons.push("missing_real_human_labels");
  if(r.total<100)reasons.push("insufficient_total");
  for(const [name,count] of Object.entries(r.strata))if(count<20)reasons.push(`insufficient_stratum:${name}`);
  if(r.missedActionCount!==0)reasons.push("missed_action");
  if(r.incorrectCriticalTransitionCount!==0)reasons.push("incorrect_critical_transition");
  if(r.incorrectCriticalAssociationCount!==0)reasons.push("incorrect_critical_association");
  if(!r.injectionRegression.independentSet||r.injectionRegression.total<1||r.injectionRegression.failures!==0)reasons.push("injection_regression_failed");
  if(!/^[a-f0-9]{64}$/i.test(r.artifactHash))reasons.push("invalid_artifact_hash");
  return {eligible:reasons.length===0,reasons};
}
export function canAutoRouteNotification(input:{assessment:ValidatedAssessment;qualification:Qualification|null;enabled:boolean}):boolean {
  const a=input.assessment,q=input.qualification;
  return input.enabled&&q?.state==="approved"&&!q.unresolvedRecheck&&a.grade==="evidence_complete"&&!a.requiresHumanReview&&a.uncertainties.length===0&&a.applicationRestrictions.every(reason=>reason==="notification_qualification_required")&&a.actions.length===0&&a.completionSuggestions.length===0&&a.events.every(e=>e.kind==="notification")&&["general_other","progress"].includes(a.primaryCategory);
}
function qualificationRow(db:DatabaseSync,t:VersionTuple):Row|undefined{return db.prepare("SELECT * FROM mail_triage_qualifications WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=?").get(...tupleValues(t));}
export function resolveCurrentNotificationTuple(db:DatabaseSync):VersionTuple {
  const settings=db.prepare("SELECT enabled,state,model_config_revision,consent_provider_revision FROM mail_triage_settings WHERE id=1").get(),binding=db.prepare("SELECT r.provider_id,r.model_id,p.config_revision,p.models_json,p.api_key_ciphertext FROM model_roles r JOIN model_providers p ON p.id=r.provider_id WHERE r.role='mail_triage'").get();
  if(!settings||settings.enabled!==1||!["enabled","paused_budget","paused_audit"].includes(String(settings.state))||!binding||!binding.api_key_ciphertext||Number(settings.consent_provider_revision)!==Number(binding.config_revision))throw new Error("自动通知分流只能批准当前已启用且已授权的模型配置");
  let models:unknown;try{models=JSON.parse(String(binding.models_json));}catch{throw new Error("当前模型目录数据完整性错误");}if(!Array.isArray(models)||!models.some(item=>item&&typeof item==="object"&&(item as {id?:unknown}).id===binding.model_id))throw new Error("自动通知分流只能批准当前实际模型");
  return {providerId:Number(binding.provider_id),modelId:String(binding.model_id),modelConfigRevision:Number(settings.model_config_revision),promptVersion:TRIAGE_PROMPT_VERSION,ruleVersion:TRIAGE_RULE_VERSION,schemaVersion:MAIL_TRIAGE_SCHEMA_VERSION};
}
function toQualification(row:Row,t:VersionTuple):Qualification{return {tuple:t,reportHash:String(row.current_report_hash),state:String(row.notification_state) as Qualification["state"],approvalRevision:Number(row.approval_revision),unresolvedRecheck:row.unresolved_recheck===1};}
export function saveEvaluationReport(db:DatabaseSync,input:{report:EvaluationReport}&MutationMeta,actor:ServerActor,now=Date.now()):Qualification {
  if(!exact(input,["report","requestId","expectedVersion","reason"]))throw new Error("写操作参数无效");assertMeta(input);const by=actorId(actor),report=parseReport(JSON.stringify(input.report));assertTuple(report.tuple);const gate=evaluateNotificationGate({tuple:report.tuple,report}),reportHash=report.artifactHash.toLowerCase(),serialized=canonical(report);
  return atomic(db,()=>{
    const prior=db.prepare("SELECT result_ref_json,canonical_input_hash FROM mail_triage_requests WHERE request_id=? AND operation='evaluation.save'").get(input.requestId);
    const inputHash=digest(input);if(prior){if(prior.canonical_input_hash!==inputHash)throw new Error("requestId 已用于不同内容");const decoded=JSON.parse(String(prior.result_ref_json));return decoded as Qualification;}
    const oldReport=db.prepare("SELECT report_json FROM mail_triage_evaluation_reports WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=? AND report_hash=?").get(...tupleValues(report.tuple),reportHash);
    if(oldReport&&String(oldReport.report_json)!==serialized)throw new Error("评估报告哈希冲突");
    const current=qualificationRow(db,report.tuple);if(Number(current?.approval_revision??0)!==input.expectedVersion)throw new Error("评估资格版本冲突");
    if(!oldReport)db.prepare("INSERT INTO mail_triage_evaluation_reports VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(...tupleValues(report.tuple),reportHash,serialized,gate.eligible?1:0,by,now);
    if(current)db.prepare("UPDATE mail_triage_qualifications SET evidence_hash=?,strata_counts_json=?,missed_action_count=?,current_report_hash=?,approval_revision=approval_revision+1,notification_state='not_qualified',approved_by=NULL,approved_at=NULL,revoked_at=?,paused_at=NULL WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=?").run(report.artifactHash,JSON.stringify(report.strata),report.missedActionCount,reportHash,now,...tupleValues(report.tuple));
    else db.prepare("INSERT INTO mail_triage_qualifications(id,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,evidence_hash,strata_counts_json,missed_action_count,current_report_hash,approval_revision,notification_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,'not_qualified')").run(randomUUID(),...tupleValues(report.tuple),report.artifactHash,JSON.stringify(report.strata),report.missedActionCount,reportHash);
    const result=toQualification(qualificationRow(db,report.tuple)!,report.tuple);
    db.prepare("INSERT INTO mail_triage_requests(request_id,operation,canonical_input_hash,result_ref_json,created_at) VALUES(?,'evaluation.save',?,?,?)").run(input.requestId,inputHash,JSON.stringify(result),now);return result;
  });
}
export function approveNotificationRouting(db:DatabaseSync,input:{tuple:VersionTuple;reportHash:string}&MutationMeta,actor:ServerActor,now=Date.now()):Qualification {
  if(!exact(input,["tuple","reportHash","requestId","expectedVersion","reason"]))throw new Error("写操作参数无效");assertMeta(input);assertTuple(input.tuple);if(!/^[a-f0-9]{64}$/i.test(input.reportHash))throw new Error("报告hash无效");const by=actorId(actor),inputHash=digest(input),readReplay=()=>{const prior=db.prepare("SELECT canonical_input_hash,result_ref_json FROM mail_triage_requests WHERE request_id=? AND operation='evaluation.approve'").get(input.requestId);if(!prior)return null;if(prior.canonical_input_hash!==inputHash)throw new Error("requestId 已用于不同内容");return JSON.parse(String(prior.result_ref_json)) as Qualification;},replayed=readReplay();if(replayed)return replayed;return atomic(db,()=>{
    const concurrentReplay=readReplay();if(concurrentReplay)return concurrentReplay;
    const authoritative=resolveCurrentNotificationTuple(db);if(!sameTuple(authoritative,input.tuple))throw new Error("只能批准当前模型版本tuple");
    const row=qualificationRow(db,authoritative);if(!row||Number(row.approval_revision)!==input.expectedVersion)throw new Error("评估资格版本冲突");
    if(String(row.current_report_hash)!==input.reportHash)throw new Error("批准必须绑定当前已保存报告hash");
    const reportRow=db.prepare("SELECT report_json,eligible,created_at FROM mail_triage_evaluation_reports WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=? AND report_hash=?").get(...tupleValues(input.tuple),input.reportHash);
    if(!reportRow)throw new Error("当前报告未达到本地资格门槛");const storedReport=parseReport(reportRow.report_json),gate=evaluateNotificationGate({tuple:authoritative,report:storedReport});if(storedReport.artifactHash.toLowerCase()!==input.reportHash.toLowerCase()||!sameTuple(storedReport.tuple,authoritative)||!gate.eligible||reportRow.eligible!==1)throw new Error("当前报告未达到本地资格门槛或缓存资格不一致");
    if(row.paused_report_hash!=null&&(row.paused_report_hash===input.reportHash||row.unresolved_recheck===1))throw new Error("漏判暂停后必须完成追查并选择新的合格人工评估报告");
    const changed=db.prepare("UPDATE mail_triage_qualifications SET notification_state='approved',approved_by=?,approved_at=?,revoked_at=NULL,approval_revision=approval_revision+1 WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=? AND approval_revision=?").run(by,now,...tupleValues(input.tuple),input.expectedVersion);
    if(changed.changes!==1)throw new Error("评估资格版本冲突");
    db.prepare("UPDATE mail_triage_settings SET auto_notifications=1,state=CASE WHEN state='paused_audit' THEN 'enabled' ELSE state END WHERE id=1").run();
    const result=toQualification(qualificationRow(db,input.tuple)!,input.tuple);db.prepare("INSERT INTO mail_triage_requests(request_id,operation,canonical_input_hash,result_ref_json,created_at) VALUES(?,'evaluation.approve',?,?,?)").run(input.requestId,inputHash,JSON.stringify(result),now);return result;
  });
}
export function getEvaluationStatus(db:DatabaseSync,tuple:VersionTuple):EvaluationStatus|null {
  assertTuple(tuple);const row=qualificationRow(db,tuple);if(!row||row.current_report_hash==null)return null;
  const stored=db.prepare("SELECT report_json,eligible FROM mail_triage_evaluation_reports WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=? AND report_hash=?").get(...tupleValues(tuple),String(row.current_report_hash));
  if(!stored)throw new Error("数据完整性错误：当前评估报告不存在");const report=parseReport(stored.report_json),gate=evaluateNotificationGate({tuple,report});if(report.artifactHash.toLowerCase()!==String(row.current_report_hash).toLowerCase()||(stored.eligible===1)!==gate.eligible)throw new Error("数据完整性错误：评估资格与报告不一致");
  const counter=db.prepare("SELECT last_passed_boundary FROM mail_triage_audit_counters WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=?").get(...tupleValues(tuple));
  return {...toQualification(row,tuple),eligible:gate.eligible,reasons:gate.reasons,report,lastPassedBoundary:Number(counter?.last_passed_boundary??0)};
}
export function registerNotificationAudit(db:DatabaseSync,input:{assessmentId:string;tuple:VersionTuple},now=Date.now()):{sequence:number;sampled:boolean} {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.assessmentId))throw new Error("assessmentId 必须是匿名UUID");
  return atomic(db,()=>{const old=db.prepare("SELECT sequence,sampled FROM mail_triage_audit_positions WHERE assessment_id=?").get(input.assessmentId);if(old)return {sequence:Number(old.sequence),sampled:old.sampled===1};
    db.prepare("INSERT INTO mail_triage_audit_counters(provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(...tupleValues(input.tuple));
    const c=db.prepare("SELECT next_sequence FROM mail_triage_audit_counters WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=?").get(...tupleValues(input.tuple))!,sequence=Number(c.next_sequence),sampled=sequence<=MAIL_TRIAGE_LIMITS.initialAuditCount||sequence%MAIL_TRIAGE_LIMITS.auditEvery===0;
    db.prepare("INSERT INTO mail_triage_audit_positions(provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,sequence,assessment_id,sampled) VALUES(?,?,?,?,?,?,?,?,?)").run(...tupleValues(input.tuple),sequence,input.assessmentId,sampled?1:0);
    db.prepare("UPDATE mail_triage_audit_counters SET next_sequence=next_sequence+1 WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=?").run(...tupleValues(input.tuple));return {sequence,sampled};
  });
}
export interface NotificationAuditResult { paused:boolean; recheckAssessmentIds:string[] }
function decodeAuditResult(value:unknown):NotificationAuditResult {
  let raw:unknown;try{raw=JSON.parse(String(value));}catch{throw new Error("数据完整性错误：抽查结果不是有效JSON");}
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("数据完整性错误：抽查结果结构无效");
  const row=raw as Record<string,unknown>,legacy=row.recheckAssessmentIds??row.recheckSourceIds;
  if(typeof row.paused!=="boolean"||!Array.isArray(legacy)||!legacy.every(id=>typeof id==="string"&&/^[0-9a-f-]{36}$/i.test(id)))throw new Error("数据完整性错误：抽查结果结构无效");
  return{paused:row.paused,recheckAssessmentIds:[...new Set(legacy as string[])]};
}
export function recordNotificationAudit(db:DatabaseSync,input:{assessmentId:string;verdict:"correct"|"missed_action"}&MutationMeta,actor:ServerActor,now=Date.now()):NotificationAuditResult {
  if(!exact(input,["assessmentId","verdict","requestId","expectedVersion","reason"]))throw new Error("抽查参数无效");assertMeta(input);
  if(!/^[0-9a-f-]{36}$/i.test(input.assessmentId)||!["correct","missed_action"].includes(input.verdict))throw new Error("抽查参数无效");
  const by=actorId(actor),persisted=input.verdict==="correct"?"passed":"missed_action",inputHash=digest(input);
  return atomic(db,()=>{
    const prior=db.prepare("SELECT canonical_input_hash,result_ref_json FROM mail_triage_requests WHERE request_id=? AND operation='evaluation.audit'").get(input.requestId);
    if(prior){if(prior.canonical_input_hash!==inputHash)throw new Error("requestId 已用于不同内容");return decodeAuditResult(prior.result_ref_json);}
    const pos=db.prepare("SELECT * FROM mail_triage_audit_positions WHERE assessment_id=?").get(input.assessmentId);
    if(!pos)throw new Error("抽查记录不存在");
    const tuple:VersionTuple={providerId:Number(pos.provider_id),modelId:String(pos.model_id),modelConfigRevision:Number(pos.model_config_revision),promptVersion:Number(pos.prompt_version),ruleVersion:Number(pos.rule_version),schemaVersion:Number(pos.schema_version)};
    const qualification=qualificationRow(db,tuple),counter=db.prepare("SELECT * FROM mail_triage_audit_counters WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=?").get(...tupleValues(tuple));
    const oldBoundary=Number(counter?.last_passed_boundary??0),unresolved=qualification?.unresolved_recheck===1;
    if(pos.sampled!==1&&!(unresolved&&Number(pos.sequence)>oldBoundary))throw new Error("抽查记录不存在");
    if(Number(pos.version)!==input.expectedVersion)throw new Error("抽查版本冲突");
    db.prepare("UPDATE mail_triage_audit_positions SET verdict=?,reviewed_at=?,version=version+1 WHERE assessment_id=? AND version=?").run(persisted,now,input.assessmentId,input.expectedVersion);
    db.prepare("INSERT INTO mail_triage_audit_verdict_history VALUES(?,?,?,?,?,?,?,?)").run(input.requestId,input.assessmentId,input.expectedVersion,pos.verdict,persisted,input.reason,by,now);
    if(db.prepare("SELECT 1 FROM mail_triage_audits WHERE assessment_id=?").get(input.assessmentId))db.prepare("UPDATE mail_triage_audits SET verdict=?,reviewed_at=? WHERE assessment_id=?").run(persisted,now,input.assessmentId);
    let paused=false;
    if(persisted==="missed_action"){
      paused=true;
      db.prepare("UPDATE mail_triage_qualifications SET notification_state='paused_audit',paused_at=?,paused_report_hash=current_report_hash,unresolved_recheck=1,revoked_at=?,approval_revision=approval_revision+1 WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=?").run(now,now,...tupleValues(tuple));
      db.prepare("UPDATE mail_triage_settings SET state='paused_audit',auto_notifications=0 WHERE id=1 AND enabled=1").run();
    }
    const positions=db.prepare("SELECT sequence,assessment_id,sampled,verdict FROM mail_triage_audit_positions WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=? ORDER BY sequence").all(...tupleValues(tuple)) as Row[];
    const bySequence=new Map(positions.map(row=>[Number(row.sequence),row])),nextSequence=Number(counter?.next_sequence??1);
    let boundary=oldBoundary;
    const nowUnresolved=persisted==="missed_action"||unresolved;
    if(persisted==="missed_action"&&Number(pos.sequence)<=boundary){boundary=0;for(let sequence=1;sequence<Number(pos.sequence);sequence++){if(sequence>MAIL_TRIAGE_LIMITS.initialAuditCount&&sequence%MAIL_TRIAGE_LIMITS.auditEvery!==0)continue;const row=bySequence.get(sequence);if(!row||row.verdict!=="passed")break;boundary=sequence;}}
    if(!nowUnresolved){boundary=0;for(let sequence=1;sequence<nextSequence;sequence++){if(sequence>MAIL_TRIAGE_LIMITS.initialAuditCount&&sequence%MAIL_TRIAGE_LIMITS.auditEvery!==0)continue;const row=bySequence.get(sequence);if(!row||row.verdict!=="passed")break;boundary=sequence;}}
    let recheck=positions.filter(row=>Number(row.sequence)>boundary&&row.verdict!=="passed").map(row=>String(row.assessment_id));
    if(nowUnresolved&&!recheck.length){boundary=nextSequence-1;db.prepare("UPDATE mail_triage_qualifications SET unresolved_recheck=0 WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=? AND paused_report_hash IS NOT NULL").run(...tupleValues(tuple));}
    db.prepare("UPDATE mail_triage_audit_counters SET last_passed_boundary=? WHERE provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=?").run(boundary,...tupleValues(tuple));
    recheck=positions.filter(row=>Number(row.sequence)>boundary&&row.verdict!=="passed").map(row=>String(row.assessment_id));
    const result={paused,recheckAssessmentIds:recheck};
    db.prepare("INSERT INTO mail_triage_requests(request_id,operation,canonical_input_hash,result_ref_json,created_at) VALUES(?,'evaluation.audit',?,?,?)").run(input.requestId,inputHash,JSON.stringify(result),now);
    return result;
  });
}
