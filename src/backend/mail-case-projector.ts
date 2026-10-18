/** 归组资格、稳定义务及三列投影。邮件事实不代表平台实时认证；无网络/自动发信。 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ApplicationDecision, ApplicationStage, CaseIdentityState, CaseProjection, EvidenceRef, Fence, ObligationState, Provenance, SourceState, SourceTrust, TaskView, TriageStatus } from "../shared/mail-triage-types.ts";
import type { ValidatedAssessment } from "./mail-triage-analyzer.ts";
import { ASSESSMENT_EVENT_KINDS, type AssessmentEventKind } from "./mail-triage-schema.ts";
import { cachedParsedMessage } from "./mail-triage-source.ts";
import { hasReservedTriageFence } from "./mail-triage-queue.ts";

/** 仅由服务器的授权缓存/映射读取器构造；模型候选字段不能替代这些资格。 */
export interface SourceFacts { id:string; mailboxId:number; version:number; state:SourceState; trust:SourceTrust; observedAt:number; date:number|null; fromAddresses:string[]; text:string; threadCaseIds:string[] }
export interface CaseCandidate { id:string; identityState:CaseIdentityState; provider:string|null; siteId:number|null; applicationId:string|null; eligible:boolean }
export interface ContactMapping { id:string; mailboxId:number; address:string; provider:string; siteId:number|null; confirmed:boolean }
export interface LinkResolution { status:"matched"|"candidate"|"ambiguous"; caseIds:string[]; reason:"exact_identity"|"anchored_thread"|"mapping_required"|"multiple_mappings"|"multiple_cases"|"no_unique_identity" }
export interface CaseEvent { id:string; caseId:string; sourceId:string|null; sourceVersion:number; eventSlot:string; kind:AssessmentEventKind|"request_reply"|"request_action"|"request_review"|"review_new_mail"|"review_required"|"reconsideration_requested"; decisionCycle:number; claimedAt:number|null; observedAt:number; evidence?:EvidenceRef[]; provenance:Provenance }
export type SafetyReviewReason="source_unavailable"|"conflicting_decision"|"account_risk"|"unconfirmed_critical"|"acceptance_unconfirmed"|"insufficient_evidence";
export interface CaseTask extends TaskView { caseId:string; eventId:string; obligationKey:string; version:number; manualLocked?:boolean; safetyReason?:SafetyReviewReason }
export interface CaseManualDecision { objectId:string; field:"state"|"decision"|"stage"|"decisionCycle"|"decisionExplanation"|"snoozedUntil"; value:unknown; appliedVersion:number; createdAt:number; provenance:Provenance }
export interface SupportSource { id:string; state:SourceState; trust:SourceTrust; version?:number }
export interface CaseProjectionInput { caseId:string; version:number; identityState:CaseIdentityState; events:CaseEvent[]; tasks:CaseTask[]; manualDecisions:CaseManualDecision[]; sources:SupportSource[]; now:number; identityProvenance?:Provenance; independentProvenance?:Provenance[] }
export interface ProjectedCase extends CaseProjection { decisionLabel:"邮件显示"|"人工核验"|null; priority:{ rank:number; observedAt:number; id:string }; reminders:{ key:string; taskId:string; deadlineAt:number|null }[]; safetyReviews:{id:string;reason:SafetyReviewReason;cycle:number;provenance:Provenance}[] }
const activeTask=(t:TaskView)=>t.state==="open"||t.state==="blocked";
const finalDecisions=new Set<ApplicationDecision>(["approved","declined","withdrawn"]);
const safetyReasons=new Set<SafetyReviewReason>(["source_unavailable","conflicting_decision","account_risk","unconfirmed_critical","acceptance_unconfirmed","insufficient_evidence"]);
const riskKinds=new Set<string>(["account_restricted","account_suspended","account_disabled","account_closed"]);
const decisionKinds:Partial<Record<CaseEvent["kind"],ApplicationDecision>>={application_approved:"approved",application_declined:"declined",application_withdrawn:"withdrawn",application_conditionally_approved:"conditional"};
const criticalKinds=new Set<string>([...Object.keys(decisionKinds),"reconsideration_accepted","account_activated",...riskKinds]);
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** UUID形状，内容来自服务器稳定键而非模型。 */
const stableId=(domain:string,value:unknown)=>{const h=digest([domain,value]);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const derive=(ids:string[]):Provenance=>({supportSourceIds:[...new Set(ids)].sort(),kind:"source_derived",verifiedAt:null,reason:null});
const exactMention=(text:string,id:string)=>{let at=text.indexOf(id);while(at>=0){const before=text[at-1]??"",after=text[at+id.length]??"";if(!/[\p{L}\p{N}_-]/u.test(before)&&!/[\p{L}\p{N}_-]/u.test(after))return true;at=text.indexOf(id,at+1);}return false;};

export function resolveCaseLinks(input:{assessment:ValidatedAssessment; candidates:CaseCandidate[]; source:SourceFacts; confirmedMappings:ContactMapping[]}):LinkResolution {
  const {source}=input;
  const maps=input.confirmedMappings.filter(m=>m.confirmed&&m.mailboxId===source.mailboxId&&source.fromAddresses.length===1&&m.address.toLowerCase()===source.fromAddresses[0].toLowerCase());
  const mappingKeys=new Set(maps.map(m=>JSON.stringify([m.provider,m.siteId])));
  if(mappingKeys.size>1)return {status:"ambiguous",caseIds:[],reason:"multiple_mappings"};
  if(!maps.length||source.state!=="active")return {status:"candidate",caseIds:[],reason:"mapping_required"};
  const m=maps[0];
  const eligible=input.candidates.filter(c=>c.eligible&&c.identityState==="confirmed"&&c.provider===m.provider&&c.siteId===m.siteId);
  const exact=eligible.filter(c=>c.applicationId&&exactMention(source.text,c.applicationId));
  const mentionedIds=new Set([...source.text.matchAll(/\bAPP-[A-Z0-9_-]+\b/giu)].map(m=>m[0].toUpperCase()));
  // 多申请不广播：即使其中一个来自模型candidateCaseId，也不得选中它。
  if(exact.length>1||mentionedIds.size>1)return {status:"ambiguous",caseIds:exact.map(c=>c.id).sort(),reason:"multiple_cases"};
  if(exact.length===1)return {status:"matched",caseIds:[exact[0].id],reason:"exact_identity"};
  const anchored=eligible.filter(c=>source.threadCaseIds.includes(c.id));
  // 明确的新编号不能被旧线程吞掉。
  const suggested=input.assessment.caseSuggestion.applicationId;
  if(mentionedIds.size||suggested&&exactMention(source.text,suggested))return {status:"candidate",caseIds:[],reason:"no_unique_identity"};
  if(anchored.length===1)return {status:"matched",caseIds:[anchored[0].id],reason:"anchored_thread"};
  return anchored.length>1?{status:"ambiguous",caseIds:anchored.map(c=>c.id).sort(),reason:"multiple_cases"}:{status:"candidate",caseIds:[],reason:"no_unique_identity"};
}

/** 独立人工事实的唯一严格资格；展示、生命周期与投影必须保持同一语义。 */
export function isStrictIndependentProvenance(p:Provenance):boolean {
  return p.kind==="independent_manual"&&p.supportSourceIds.length===0&&p.verifiedAt!==null&&p.verifiedAt>0&&Boolean(p.reason?.trim());
}

/** 无有效支持的衍生项立即退出事实集合。独立人工事实须有明确理由及核验时间。 */
function supported(p:Provenance,sources:Map<string,SupportSource>):boolean {
  return p.kind==="independent_manual"
    ? isStrictIndependentProvenance(p)
    : p.supportSourceIds.length>0&&p.supportSourceIds.every(id=>sources.get(id)?.state==="active");
}
function humanSupported(p:Provenance,sources:Map<string,SupportSource>):boolean {return supported(p,sources)&&(p.kind==="independent_manual"||p.supportSourceIds.every(id=>sources.get(id)?.trust==="human_confirmed"));}
function eventSourceVersion(slot:string):number {
  return /^\d+:/.test(slot)?Number(slot.split(":")[0]):1;
}
/** reducer及周期边界共用同一资格：源仍有效且事件属于当前世代，或明确独立人工事实。 */
function eventSupported(
  event:Pick<CaseEvent,"sourceId"|"sourceVersion"|"provenance">,
  sources:Map<string,SupportSource>,
):boolean {
  if(!supported(event.provenance,sources))return false;
  if(event.provenance.kind==="independent_manual")return true;
  if(event.sourceId===null)return false;
  const currentVersion=sources.get(event.sourceId)?.version;
  return currentVersion===undefined||currentVersion===event.sourceVersion;
}
const effectiveTime=(e:CaseEvent)=>e.claimedAt!==null&&e.claimedAt<=e.observedAt?e.claimedAt:e.observedAt;
const eventOrder=(a:CaseEvent,b:CaseEvent)=>effectiveTime(a)-effectiveTime(b)||a.observedAt-b.observedAt||a.id.localeCompare(b.id);
const obligationStates=new Set<ObligationState>(["open","awaiting_external","resolved_by_evidence","resolved_by_human","dismissed","blocked"]);
export function projectCase(input:CaseProjectionInput):ProjectedCase {
  const sources=new Map(input.sources.map(s=>[s.id,s]));
  const validEvents=input.events.filter(e=>e.caseId===input.caseId&&eventSupported(e,sources)).sort(eventOrder);
  const invalidEventIds=new Set(input.events.filter(e=>!validEvents.includes(e)).map(e=>e.id));
  // 安全核对记录描述“证据不可用”，不是把失效的业务事实保留下来；只允许已知固定reason。
  const isSafety=(t:CaseTask)=>t.kind==="review"&&t.safetyReason!==undefined&&safetyReasons.has(t.safetyReason);
  const safetyEventIds=new Set(input.tasks.filter(isSafety).map(t=>t.eventId));
  const validTasks=input.tasks.filter(t=>t.caseId===input.caseId&&(isSafety(t)||supported(t.provenance,sources)&&!invalidEventIds.has(t.eventId)));
  const sourceUnavailable=input.events.some(e=>!safetyEventIds.has(e.id)&&!validEvents.includes(e))||input.tasks.some(t=>!isSafety(t)&&!validTasks.includes(t))||Boolean(input.identityProvenance&&!supported(input.identityProvenance,sources));
  const manual=input.manualDecisions.filter(d=>supported(d.provenance,sources)).sort((a,b)=>a.appliedVersion-b.appliedVersion||a.createdAt-b.createdAt||a.objectId.localeCompare(b.objectId));
  let cycle=Math.max(1,...validEvents.map(e=>e.decisionCycle));
  for(const d of manual)if(d.objectId===input.caseId&&d.field==="decisionCycle"&&Number.isSafeInteger(d.value)&&Number(d.value)>0)cycle=Number(d.value);
  const current=validEvents.filter(e=>e.decisionCycle===cycle);
  let decision:ApplicationDecision=current.some(e=>!["review_required","review_new_mail"].includes(e.kind))?"pending":"unknown",stage:ApplicationStage="unknown",decisionLabel:ProjectedCase["decisionLabel"]=null;
  let decisionExplanation:string|null=null;
  const milestones:string[]=[...new Set(current.filter(e=>["materials_received","agreement_sent","signature_completed","account_activated"].includes(e.kind)).map(e=>e.kind))].sort();
  const eligibleDecisions=current.filter(e=>decisionKinds[e.kind]&&humanSupported(e.provenance,sources));
  const finals=new Set(eligibleDecisions.map(e=>decisionKinds[e.kind]!).filter(d=>finalDecisions.has(d)));
  const conflict=finals.size>1;
  if(conflict)decision="unknown";
  else if(finals.size===1){decision=[...finals][0];decisionLabel="邮件显示";stage="ended";}
  else if(eligibleDecisions.some(e=>e.kind==="application_conditionally_approved"))decision="conditional";
  if(stage!=="ended")for(const e of current){if(e.kind==="application_submitted")stage="submitted";if(e.kind==="review_started"||e.kind==="reconsideration_accepted"&&humanSupported(e.provenance,sources))stage="reviewing";}
  const awaitingAcceptance=current.some(e=>e.kind==="reconsideration_requested")&&!current.some(e=>e.kind==="reconsideration_accepted"&&humanSupported(e.provenance,sources));
  if(awaitingAcceptance)milestones.push("待确认受理");
  for(const d of manual)if(d.objectId===input.caseId&&humanSupported(d.provenance,sources)){
    if(d.field==="decision"&&["unknown","pending","conditional","approved","declined","withdrawn"].includes(String(d.value))){decision=d.value as ApplicationDecision;decisionLabel="人工核验";if(finalDecisions.has(decision))stage="ended";}
    if(d.field==="stage"&&["unknown","preparing","submitted","reviewing","ended"].includes(String(d.value)))stage=d.value as ApplicationStage;
    if(d.field==="decisionExplanation"&&(d.value===null||typeof d.value==="string"))decisionExplanation=d.value;
  }
  const tasks:TaskView[]=validTasks.map(t=>{let state=t.state,snoozedUntil=t.snoozedUntil??null;for(const d of manual)if(d.objectId===t.id){if(d.field==="state"&&obligationStates.has(d.value as ObligationState))state=d.value as ObligationState;if(d.field==="snoozedUntil"&&(d.value===null||Number.isSafeInteger(d.value)&&Number(d.value)>0))snoozedUntil=d.value as number|null;}return {id:t.id,kind:t.kind,state,title:t.title,requestedItems:[...t.requestedItems],deadlineRaw:t.deadlineRaw,deadlineAt:t.deadlineAt,snoozedUntil,provenance:structuredClone(t.provenance)};});
  const risk=validEvents.some(e=>riskKinds.has(e.kind));
  const unconfirmedCritical=current.some(e=>criticalKinds.has(e.kind)&&!humanSupported(e.provenance,sources));
  const explicitWait=current.some(e=>["application_submitted","review_started"].includes(e.kind)||e.kind==="reconsideration_accepted"&&humanSupported(e.provenance,sources))||tasks.some(t=>t.state==="awaiting_external");
  const fallback=!tasks.some(activeTask)&&!explicitWait&&!finalDecisions.has(decision)&&!sourceUnavailable&&!conflict&&!risk&&!unconfirmedCritical&&!awaitingAcceptance;
  const reviewReasons=[sourceUnavailable?"source_unavailable":null,conflict?"conflicting_decision":null,risk?"account_risk":null,unconfirmedCritical?"unconfirmed_critical":null,awaitingAcceptance?"acceptance_unconfirmed":null,fallback?"insufficient_evidence":null].filter((v):v is SafetyReviewReason=>v!==null);
  const safetyReviews:ProjectedCase["safetyReviews"]=[];
  for(const reason of reviewReasons){
    // 按导致核对的固定事件集合去重；新风险/新冲突不能被旧人工dismiss吞掉。
    const triggers=reason==="account_risk"?validEvents.filter(e=>riskKinds.has(e.kind)).map(e=>e.id):reason==="conflicting_decision"?eligibleDecisions.map(e=>e.id):reason==="unconfirmed_critical"?current.filter(e=>criticalKinds.has(e.kind)&&!humanSupported(e.provenance,sources)).map(e=>e.id):reason==="acceptance_unconfirmed"?current.filter(e=>e.kind==="reconsideration_requested").map(e=>e.id):reason==="source_unavailable"?[...input.events.filter(e=>!safetyEventIds.has(e.id)&&!validEvents.includes(e)).map(e=>e.id),...input.tasks.filter(t=>!isSafety(t)&&!validTasks.includes(t)).map(t=>t.id),...(input.identityProvenance?.supportSourceIds??[])]:[];
    const id=stableId("projection-review",[input.caseId,cycle,reason,[...new Set(triggers)].sort()]);const support=[...input.events.flatMap(e=>e.provenance.supportSourceIds),...input.tasks.flatMap(t=>t.provenance.supportSourceIds),...(input.identityProvenance?.supportSourceIds??[])];const independent=[input.identityProvenance,...(input.independentProvenance??[])].find((p):p is Provenance=>Boolean(p&&p.kind==="independent_manual"&&supported(p,sources)));const provenance=support.length?derive(support):independent?structuredClone(independent):derive([]);safetyReviews.push({id,reason,cycle,provenance});if(!tasks.some(t=>t.id===id)){let state:ObligationState="open";for(const d of manual)if(d.objectId===id&&d.field==="state"&&obligationStates.has(d.value as ObligationState))state=d.value as ObligationState;tasks.push({id,kind:"review",state,title:reason==="source_unavailable"?"来源不可用，请核对":reason==="account_risk"?"账户风险待核对":"申请事实待核对",requestedItems:[],deadlineRaw:null,deadlineAt:null,provenance});}
  }
  tasks.sort((a,b)=>a.id.localeCompare(b.id));
  const requiresReply=tasks.some(t=>activeTask(t)&&t.kind==="reply"),requiresAction=tasks.some(t=>activeTask(t)&&t.kind==="action"),requiresReview=tasks.some(t=>activeTask(t)&&t.kind==="review");
  const column=input.identityState!=="confirmed"?null:requiresReply||requiresAction||requiresReview?"needs_you":explicitWait&&(!finalDecisions.has(decision)||tasks.some(t=>t.state==="awaiting_external"))?"awaiting_platform":finalDecisions.has(decision)?"results":"needs_you";
  const due=tasks.some(t=>activeTask(t)&&t.deadlineAt!==null&&t.deadlineAt<=input.now+24*60*60*1000);
  const observedAt=Math.max(0,...current.map(e=>Math.min(e.observedAt,input.now)));
  const reminders=tasks.filter(t=>activeTask(t)&&(t.snoozedUntil===null||t.snoozedUntil===undefined||t.snoozedUntil<=input.now)).map(t=>({key:`mail-triage:${input.caseId}:${t.id}`,taskId:t.id,deadlineAt:t.deadlineAt}));
  return {caseId:input.caseId,version:input.version,identityState:input.identityState,column,stage,decision,decisionCycle:cycle,decisionExplanation,milestones,tasks,sourceUnavailable,requiresReply,requiresAction,requiresReview,decisionLabel,priority:{rank:risk?0:due?1:requiresAction||requiresReply?2:3,observedAt,id:input.caseId},reminders,safetyReviews};
}
export function compareCasePriority(a:ProjectedCase,b:ProjectedCase):number {return a.priority.rank-b.priority.rank||b.priority.observedAt-a.priority.observedAt||a.caseId.localeCompare(b.caseId);}
export interface MailCountItem {sourceId:string; linked:boolean; state:"reviewed"|"unreviewed"|"failed"; auditPending:boolean}
export function countTriageItems(cases:CaseProjection[],mail:MailCountItem[]):Omit<TriageStatus,"enabled"|"state"|"configEpoch"|"dailyAttemptsUsed"|"dailyAttemptLimit"> {
  const uniqueCases=[...new Map(cases.map(c=>[c.caseId,c])).values()],uniqueMail=[...new Map(mail.map(m=>[m.sourceId,m])).values()];
  return {needsActionCaseCount:uniqueCases.filter(c=>c.column==="needs_you").length,awaitingCaseCount:uniqueCases.filter(c=>c.column==="awaiting_platform").length,resultCaseCount:uniqueCases.filter(c=>c.column==="results").length,unlinkedMailCount:uniqueMail.filter(m=>!m.linked).length,unreviewedMailCount:uniqueMail.filter(m=>m.state==="unreviewed").length,failedMailCount:uniqueMail.filter(m=>m.state==="failed").length,openTaskCount:new Set(uniqueCases.flatMap(c=>c.tasks.filter(activeTask).map(t=>t.id))).size,auditPendingMailCount:uniqueMail.filter(m=>m.auditPending).length};
}

type Row=Record<string,unknown>;
const parse=<T>(value:unknown):T=>JSON.parse(String(value)) as T;
const nullableString=(value:unknown)=>value==null?null:String(value);
function requireTransaction(db:DatabaseSync){if(!db.isTransaction)throw new Error("caller synchronous transaction required");}
function failFence():never {throw new Error("stale_fence");}
/** 在projector边界也使用授权/世代交集；active行本身不代表仍获授权。 */
function readSupportSources(db:DatabaseSync):SupportSource[] {
  return db.prepare(`SELECT s.id,s.source_version,s.trust,CASE WHEN s.state='active' AND EXISTS(
    SELECT 1 FROM mail_triage_scope scope JOIN mail_triage_settings settings ON settings.id=1
    JOIN mail_triage_source_aliases a ON a.source_id=s.id AND a.active=1 AND a.mailbox_id=scope.mailbox_id
    JOIN mailboxes box ON box.id=scope.mailbox_id
    WHERE scope.mailbox_id=s.mailbox_id AND scope.state='authorized' AND scope.epoch=settings.config_epoch
      AND scope.uid_validity=a.uid_validity AND scope.effective_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM abandoned_domains d WHERE d.domain=box.domain COLLATE NOCASE)
    ) THEN 'active' WHEN s.state='active' THEN 'stale' ELSE s.state END AS state
    FROM mail_triage_sources s ORDER BY s.id`).all().map(s=>({id:String(s.id),version:Number(s.source_version),trust:s.trust as SourceTrust,state:s.state as SourceState}));
}
function sourceFacts(db:DatabaseSync,sourceId:string):SourceFacts {
  const row=db.prepare("SELECT * FROM mail_triage_sources WHERE id=?").get(sourceId);if(!row)failFence();
  const cache=db.prepare(`SELECT m.* FROM mail_triage_source_aliases a JOIN mail_messages m ON m.mailbox_id=a.mailbox_id AND m.folder=a.folder AND m.uid=a.uid AND m.uid_validity=a.uid_validity JOIN mail_triage_scope scope ON scope.mailbox_id=a.mailbox_id AND scope.uid_validity=a.uid_validity AND scope.state='authorized' JOIN mail_triage_settings settings ON settings.id=1 AND settings.config_epoch=scope.epoch WHERE a.source_id=? AND a.active=1 ORDER BY a.folder,a.uid LIMIT 1`).get(sourceId);
  if(!cache)failFence();const mail=cachedParsedMessage(cache);
  const refs=[mail.inReplyTo,...mail.references].filter((r):r is string=>Boolean(r));
  const anchors=db.prepare(`SELECT DISTINCT cs.case_id,s.id AS supporting_id FROM mail_case_sources cs JOIN mail_triage_sources s ON s.id=cs.source_id JOIN mail_triage_source_aliases a ON a.source_id=s.id AND a.active=1 JOIN mail_messages m ON m.mailbox_id=a.mailbox_id AND m.folder=a.folder AND m.uid=a.uid AND m.uid_validity=a.uid_validity WHERE s.mailbox_id=? AND s.state='active' AND m.message_id IN (SELECT value FROM json_each(?)) ORDER BY cs.case_id`).all(Number(row.mailbox_id),JSON.stringify(refs));
  const authorized=new Set(readSupportSources(db).filter(s=>s.state==="active").map(s=>s.id));
  return {id:sourceId,mailboxId:Number(row.mailbox_id),version:Number(row.source_version),state:row.state as SourceState,trust:row.trust as SourceTrust,observedAt:Number(row.observed_at),date:mail.date,fromAddresses:mail.fromAddresses,text:`${mail.subject}\n${mail.text}`,threadCaseIds:[...new Set(anchors.filter(a=>authorized.has(String(a.supporting_id))).map(a=>String(a.case_id)))]};
}
function linkInputs(db:DatabaseSync,source:SourceFacts){
  const sources=new Map(readSupportSources(db).map(s=>[s.id,s]));
  const candidates:CaseCandidate[]=db.prepare("SELECT * FROM mail_application_cases ORDER BY id").all().map(c=>({id:String(c.id),identityState:c.identity_state as CaseIdentityState,provider:nullableString(c.provider),siteId:c.site_id==null?null:Number(c.site_id),applicationId:nullableString(c.application_identity),eligible:supported(parse<Provenance>(c.identity_provenance_json),sources)}));
  const confirmedMappings:ContactMapping[]=db.prepare("SELECT * FROM mail_triage_contacts WHERE mailbox_id=? ORDER BY id").all(source.mailboxId).map(m=>({id:String(m.id),mailboxId:Number(m.mailbox_id),address:String(m.address),provider:String(m.provider),siteId:m.site_id==null?null:Number(m.site_id),confirmed:true}));
  return {candidates,confirmedMappings};
}
function checkSource(db:DatabaseSync,input:{sourceId:string;sourceVersion:number;configEpoch:number}){
  const r=db.prepare(`SELECT s.id FROM mail_triage_sources s JOIN mail_triage_scope scope ON scope.mailbox_id=s.mailbox_id JOIN mail_triage_settings settings ON settings.id=1 JOIN mailboxes b ON b.id=s.mailbox_id WHERE s.id=? AND s.source_version=? AND s.state='active' AND scope.state='authorized' AND scope.epoch=? AND settings.config_epoch=? AND (settings.enabled=1 OR settings.state='initializing') AND NOT EXISTS(SELECT 1 FROM abandoned_domains a WHERE a.domain=b.domain COLLATE NOCASE)`).get(input.sourceId,input.sourceVersion,input.configEpoch,input.configEpoch);if(!r)failFence();
}
function caseProjection(db:DatabaseSync,caseId:string,now:number):ProjectedCase {
  const c=db.prepare("SELECT * FROM mail_application_cases WHERE id=?").get(caseId)!;
  const events:CaseEvent[]=db.prepare("SELECT * FROM mail_case_events WHERE case_id=? ORDER BY id").all(caseId).map(e=>({id:String(e.id),caseId,sourceId:e.source_id==null?null:String(e.source_id),sourceVersion:eventSourceVersion(String(e.event_slot)),eventSlot:String(e.event_slot),kind:e.kind as CaseEvent["kind"],decisionCycle:Number(e.decision_cycle),claimedAt:e.claimed_at==null?null:Number(e.claimed_at),observedAt:Number(e.observed_at),evidence:parse<EvidenceRef[]>(e.evidence_json),provenance:parse<Provenance>(e.provenance_json)}));
  const auditRows=db.prepare("SELECT * FROM mail_case_manual_decisions WHERE case_id=? ORDER BY applied_version,created_at,id").all(caseId);
  const undone=new Set(auditRows.flatMap(row=>row.undo_of==null?[]:[String(row.undo_of)]));
  const manualRows=auditRows.filter(row=>row.undo_of==null&&!undone.has(String(row.id)));
  const stateLocked=new Set(manualRows.filter(d=>String(d.field)==="state").map(r=>String(r.object_id)));
  const tasks:CaseTask[]=db.prepare("SELECT * FROM mail_case_tasks WHERE case_id=? ORDER BY id").all(caseId).map(t=>{const reason=String(t.object).startsWith("safety_review:")?String(t.object).slice("safety_review:".length) as SafetyReviewReason:undefined;return {id:String(t.id),caseId,eventId:String(t.event_id),obligationKey:String(t.obligation_key),kind:t.kind as CaseTask["kind"],state:t.state as ObligationState,title:String(t.title),requestedItems:parse<string[]>(t.requested_items_json),deadlineRaw:nullableString(t.deadline_raw),deadlineAt:t.deadline_at==null?null:Number(t.deadline_at),version:Number(t.version),provenance:parse<Provenance>(t.provenance_json),manualLocked:stateLocked.has(String(t.id)),safetyReason:reason&&safetyReasons.has(reason)?reason:undefined};});
  const manualDecisions:CaseManualDecision[]=manualRows.filter(d=>["state","decision","stage","decisionCycle","decisionExplanation","snoozedUntil"].includes(String(d.field))).map(d=>{const raw=parse<unknown>(d.after_json),value=raw!==null&&typeof raw==="object"&&String(d.field) in raw?(raw as Record<string,unknown>)[String(d.field)]:raw;return {objectId:String(d.object_id),field:d.field as CaseManualDecision["field"],value,appliedVersion:Number(d.applied_version),createdAt:Number(d.created_at),provenance:parse<Provenance>(d.provenance_json)};});
  const independentProvenance=manualRows.map(d=>parse<Provenance>(d.provenance_json)).filter(p=>p.kind==="independent_manual"&&supported(p,new Map()));
  const sources=readSupportSources(db);
  return projectCase({caseId,version:Number(c.version),identityState:c.identity_state as CaseIdentityState,events,tasks,manualDecisions,sources,now,identityProvenance:parse<Provenance>(c.identity_provenance_json),independentProvenance});
}
/** 安全review先落地稳定事件/义务，重投影再保存；前端看到的所有任务ID均可审计。 */
function saveProjection(db:DatabaseSync,caseId:string,now:number){
  const initial=caseProjection(db,caseId,now);
  for(const review of initial.safetyReviews){
    if(db.prepare("SELECT 1 FROM mail_case_tasks WHERE id=? AND case_id=?").get(review.id,caseId))continue;
    const source=db.prepare(`SELECT s.* FROM mail_triage_sources s WHERE s.id IN (SELECT value FROM json_each(?)) OR s.id IN (SELECT source_id FROM mail_case_sources WHERE case_id=?) ORDER BY s.id LIMIT 1`).get(JSON.stringify(review.provenance.supportSourceIds),caseId);
    const independent=review.provenance.kind==="independent_manual"&&review.provenance.supportSourceIds.length===0&&review.provenance.verifiedAt!==null&&review.provenance.verifiedAt>0&&Boolean(review.provenance.reason?.trim());
    // source-less 只承载严格独立人工核验；其余review绝不挂到无关邮箱或伪造source。
    if(!source&&!independent)throw new Error("review_source_required");
    const slot=source?`${source.source_version}:safety_review:${review.cycle}:${review.reason}:${review.id}`:`manual:safety_review:${review.cycle}:${review.reason}:${review.id}`,eventId=stableId("safety-event",[caseId,review.id]);
    const provenance=independent?review.provenance:derive(review.provenance.supportSourceIds.length?review.provenance.supportSourceIds:[String(source!.id)]);
    db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,?,?,'review_required',?,NULL,?,'[]',?) ON CONFLICT DO NOTHING")
      .run(eventId,caseId,source?String(source.id):null,slot,review.cycle,source?Number(source.observed_at):review.provenance.verifiedAt!,JSON.stringify(provenance));
    const task=initial.tasks.find(t=>t.id===review.id)!;
    db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,provenance_json) VALUES(?,?,?,?,'review',?,?,?) ON CONFLICT(case_id,event_id,obligation_key) DO NOTHING").run(review.id,caseId,eventId,`safety_review:${review.reason}`,`safety_review:${review.reason}`,task.title,JSON.stringify(provenance));
  }
  const p=caseProjection(db,caseId,now),old=String(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(caseId)!.projection_json);
  // 同输入重放不涨版本；提醒键不依赖重审措辞/时间。
  if(old===JSON.stringify(p))return;
  const oldProjection=parse<Partial<CaseProjection>>(old);const next=oldProjection.caseId?{...p,version:p.version+1}:p;
  db.prepare("UPDATE mail_application_cases SET version=?,projection_json=?,updated_at=? WHERE id=?").run(next.version,JSON.stringify(next),now,caseId);
}
/** Task8/10/11在各自已受保护的同步变更事务内复投影；不调用模型、不复活被取消作业。 */
export function reprojectCases(db:DatabaseSync,input:{caseIds:string[];now:number}):ProjectedCase[] {
  requireTransaction(db);const result:ProjectedCase[]=[];
  for(const id of [...new Set(input.caseIds)].sort()){
    if(!db.prepare("SELECT 1 FROM mail_application_cases WHERE id=?").get(id))continue;
    saveProjection(db,id,input.now);
    result.push(parse<ProjectedCase>(db.prepare("SELECT projection_json FROM mail_application_cases WHERE id=?").get(id)!.projection_json));
  }return result;
}
function insertEvent(db:DatabaseSync,caseId:string,source:SourceFacts,slot:string,kind:CaseEvent["kind"],cycle:number,evidence:EvidenceRef[]=[]):string {
  const id=stableId("event",[caseId,source.id,slot]);
  db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,decision_cycle,claimed_at,observed_at,evidence_json,provenance_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(case_id,source_id,event_slot) DO NOTHING").run(id,caseId,source.id,slot,kind,cycle,source.date,source.observedAt,JSON.stringify(evidence),JSON.stringify(derive([source.id])));return id;
}
function reviewTask(db:DatabaseSync,caseId:string,source:SourceFacts,slot:string,reason:string,cycle:number){
  const eventId=insertEvent(db,caseId,source,slot,reason==="review_new_mail"?"review_new_mail":"review_required",cycle);const id=stableId("task",[eventId,reason]);
  db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,provenance_json) VALUES(?,?,?,?,'review',?,'新邮件待核对',?) ON CONFLICT(case_id,event_id,obligation_key) DO NOTHING").run(id,caseId,eventId,reason,reason,JSON.stringify(derive([source.id])));
}
function provisionalCase(db:DatabaseSync,source:SourceFacts,epoch:number,assessment?:ValidatedAssessment):string {
  const id=stableId("unconfirmed-case",[source.id,source.version,epoch]);const suggested=assessment?.caseSuggestion;
  db.prepare("INSERT INTO mail_application_cases(id,identity_state,provider,application_identity,identity_provenance_json,created_at,updated_at) VALUES(?,'unconfirmed_case',?,?,?,?,?) ON CONFLICT(id) DO NOTHING").run(id,suggested?.providerCandidate??null,suggested?.applicationId??null,JSON.stringify(derive([source.id])),source.observedAt,source.observedAt);
  // 如果先登记后分析，仅填充候选事实，绝不提升身份。
  if(suggested)db.prepare("UPDATE mail_application_cases SET provider=COALESCE(provider,?),application_identity=COALESCE(application_identity,?) WHERE id=? AND identity_state='unconfirmed_case'").run(suggested.providerCandidate,suggested.applicationId,id);
  return id;
}
const emptyAssessment=():ValidatedAssessment=>({schemaVersion:1,primaryCategory:"general_other",tag:"待核对",summary:"新邮件待核对",caseSuggestion:{providerCandidate:null,applicationId:null,candidateCaseId:null,matchBasis:[],needsReview:true},events:[],actions:[],completionSuggestions:[],uncertainties:[],requiresHumanReview:true,grade:"needs_review",usage:null,evidenceLocations:[],applicationRestrictions:["suggest_only"]});
/** Task9 的同步 source hook；不需要 job/model 可用。只可靠关联确认case，否则保持未归组入口。 */
export function registerPendingReview(db:DatabaseSync,input:{sourceId:string;sourceVersion:number;configEpoch:number;now:number}):{affectedCaseIds:string[]} {
  requireTransaction(db);checkSource(db,input);const source=sourceFacts(db,input.sourceId),resolution=resolveCaseLinks({assessment:emptyAssessment(),source,...linkInputs(db,source)});
  const caseId=resolution.status==="matched"?resolution.caseIds[0]:provisionalCase(db,source,input.configEpoch);
  db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,?) ON CONFLICT(case_id,source_id) DO NOTHING").run(caseId,source.id,resolution.status==="matched"?resolution.reason:"candidate");
  reviewTask(db,caseId,source,`${source.version}:${input.configEpoch}:review_new_mail`,"review_new_mail",Number(db.prepare("SELECT COALESCE(MAX(decision_cycle),1) AS n FROM mail_case_events WHERE case_id=?").get(caseId)!.n));saveProjection(db,caseId,input.now);return {affectedCaseIds:[caseId]};
}
/** 用引文本身匹配校验坐标，不使用原始提取数组索引恢复已被analyzer过滤的条目。 */
function freshCoordinates(a:ValidatedAssessment,refs:EvidenceRef[],sourceId:string):string|null {
  if(!refs.length)return null;const ranges:string[]=[];
  for(const ref of refs){if(ref.sourceId!==sourceId)return null;const matches=a.evidenceLocations.filter(e=>e.sourceId===ref.sourceId&&e.quote===ref.quote);if(!matches.length)return null;
    const locations=[...new Map(matches.flatMap(e=>e.locations).map(l=>[JSON.stringify(l),l])).values()];if(locations.length!==1)return null;const l=locations[0];if(l.coordinateUnit!=="utf16"||l.field!=="text"||l.segment!=="current_body"||l.start<0||l.end<=l.start)return null;ranges.push(`${l.start}-${l.end}`);
  }return [...new Set(ranges)].sort().join(",");
}
function assertApplyFence(db:DatabaseSync,input:{sourceId:string;fence:Fence;now:number}){
  const f=input.fence;checkSource(db,{sourceId:input.sourceId,sourceVersion:f.sourceVersion,configEpoch:f.configEpoch});
  const settings=db.prepare("SELECT enabled,state FROM mail_triage_settings WHERE id=1").get();
  if(settings?.enabled!==1||(settings.state!=='enabled'&&!(settings.state==='paused_budget'&&hasReservedTriageFence(db,f,input.now))))failFence();
  const row=db.prepare("SELECT id FROM mail_triage_jobs WHERE id=? AND source_id=? AND source_version=? AND config_epoch=? AND state='running' AND lease_token=? AND lease_expires_at>? AND attempt_seq=? AND context_version=? AND manual_version=?").get(f.jobId,input.sourceId,f.sourceVersion,f.configEpoch,f.leaseToken,input.now,f.attemptSeq,f.contextVersion,f.manualVersion);if(!row)failFence();
}
/** 只能在调用者同步事务中使用。Task7另复核完整context/manual/case快照和tuple后再调用。 */
export function applyAssessment(db:DatabaseSync,input:{sourceId:string;assessment:ValidatedAssessment;fence:Fence;now:number;releaseTemporaryReview?:boolean}):{affectedCaseIds:string[]} {
  requireTransaction(db);assertApplyFence(db,input);
  const source=sourceFacts(db,input.sourceId),a=input.assessment,resolution=resolveCaseLinks({assessment:a,source,...linkInputs(db,source)});
  const locked=db.prepare("SELECT cs.case_id FROM mail_case_sources cs JOIN mail_application_cases c ON c.id=cs.case_id WHERE cs.source_id=? AND cs.manual_locked=1 AND c.identity_state='confirmed' ORDER BY cs.case_id").all(source.id);
  // 多case人工拆分仍须Task10提供逐项绑定；不能把所有提取广播给所有case。
  const target=locked.length===1?String(locked[0].case_id):locked.length>1?null:resolution.status==="matched"?resolution.caseIds[0]:null;
  const caseId=target??provisionalCase(db,source,input.fence.configEpoch,a);
  db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,?) ON CONFLICT(case_id,source_id) DO NOTHING").run(caseId,source.id,target?resolution.reason:"candidate");
  const affected=new Set([caseId]);
  if(target){const provisionalId=stableId("unconfirmed-case",[source.id,source.version,input.fence.configEpoch]);if(provisionalId!==caseId){
    const provisional=db.prepare("SELECT id FROM mail_application_cases WHERE id=? AND identity_state='unconfirmed_case' AND manual_version=0 AND NOT EXISTS(SELECT 1 FROM mail_case_manual_decisions WHERE case_id=?) AND NOT EXISTS(SELECT 1 FROM mail_case_sources WHERE case_id=? AND (source_id<>? OR manual_locked=1))").get(provisionalId,provisionalId,provisionalId,source.id);
    if(provisional){if(db.prepare("SELECT 1 FROM mail_case_tasks WHERE case_id=? AND obligation_key='review_new_mail'").get(provisionalId))reviewTask(db,caseId,source,`${source.version}:${input.fence.configEpoch}:review_new_mail`,"review_new_mail",1);db.prepare("DELETE FROM mail_application_cases WHERE id=?").run(provisionalId);}
  }}
  let cycle=Number(db.prepare("SELECT COALESCE(MAX(decision_cycle),1) AS n FROM mail_case_events WHERE case_id=?").get(caseId)!.n);
  let needsReview=a.grade==="needs_review"||resolution.status!=="matched"&&locked.length!==1||locked.length>1;
  const globalUnsafe=a.applicationRestrictions.some(r=>["multiple_application_ids","historical_evidence","ambiguous_evidence","semantic_conflict","security_not_application","suspicious_content","context_incomplete","content_insufficient"].includes(r));
  // 真正、较晚的复审受理进入新周期；模型不能自创cycle，未认证/迟到的受理不能覆盖旧拒绝。
  if(!globalUnsafe&&a.grade==="evidence_complete"&&source.trust==="human_confirmed"&&a.events.some(e=>e.kind==="reconsideration_accepted"&&freshCoordinates(a,e.evidence,source.id))){
    const prior=db.prepare("SELECT * FROM mail_case_events WHERE case_id=? AND decision_cycle=? AND kind IN ('application_approved','application_declined','application_withdrawn') ORDER BY observed_at,id").all(caseId,cycle);
    const supports=new Map(readSupportSources(db).map(s=>[s.id,s]));
    const valid=prior.filter(row=>{
      const event={
        sourceId:String(row.source_id),
        sourceVersion:eventSourceVersion(String(row.event_slot)),
        provenance:parse<Provenance>(row.provenance_json),
      };
      return eventSupported(event,supports)&&humanSupported(event.provenance,supports);
    });
    const requestedTime=source.date!==null&&source.date<=source.observedAt?source.date:source.observedAt;
    if(valid.length&&valid.every(e=>e.kind==="application_declined")&&valid.every(e=>requestedTime>(e.claimed_at!==null&&Number(e.claimed_at)<=Number(e.observed_at)?Number(e.claimed_at):Number(e.observed_at))))cycle++;
  }
  // 多申请/不可验证证据绝不添加带业务效果的事件/义务；保留核对入口。
  if(!globalUnsafe&&locked.length<=1){
    for(const e of a.events){
      if(!ASSESSMENT_EVENT_KINDS.includes(e.kind as AssessmentEventKind)){needsReview=true;continue;}
      const coords=freshCoordinates(a,e.evidence,source.id);if(!coords){needsReview=true;continue;}
      insertEvent(db,caseId,source,`${source.version}:${e.kind}:${coords}`,e.kind as AssessmentEventKind,cycle,e.evidence);
    }
    for(const action of a.actions){
      const coords=freshCoordinates(a,action.evidence,source.id);if(!coords){needsReview=true;continue;}
      const slot=`${source.version}:request_${action.kind}:${coords}`,eventId=insertEvent(db,caseId,source,slot,`request_${action.kind}`,cycle,action.evidence);
      const object=JSON.stringify(action.requestedItems.map(i=>i.normalize("NFC").trim().toLowerCase()).sort()),key=digest([action.kind,object]);
      const old=db.prepare("SELECT * FROM mail_case_tasks WHERE case_id=? AND event_id=?").all(caseId,eventId);
      if(old.length){if(old.some(t=>String(t.obligation_key)!==key))needsReview=true;continue;}
      const deadlineAt=action.deadlineAt!==null&&action.deadlineRaw!==null&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(action.deadlineRaw)&&Date.parse(action.deadlineRaw)===action.deadlineAt?action.deadlineAt:null;
      db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,requested_items_json,deadline_raw,deadline_at,provenance_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(stableId("task",[eventId,key]),caseId,eventId,key,action.kind,object,action.title,JSON.stringify(action.requestedItems),action.deadlineRaw,deadlineAt,JSON.stringify(derive([source.id])));
    }
    if(a.grade==="evidence_complete"&&source.trust==="human_confirmed"&&target){
      for(const completion of a.completionSuggestions){
        if(!freshCoordinates(a,completion.evidence,source.id))continue;
        const task=db.prepare("SELECT t.*,e.source_id FROM mail_case_tasks t JOIN mail_case_events e ON e.id=t.event_id AND e.case_id=t.case_id WHERE t.id=? AND t.case_id=? AND t.state IN ('open','blocked','awaiting_external') AND NOT EXISTS(SELECT 1 FROM mail_case_manual_decisions d WHERE d.case_id=t.case_id AND d.object_id=t.id AND d.field='state' AND d.undo_of IS NULL AND NOT EXISTS(SELECT 1 FROM mail_case_manual_decisions u WHERE u.undo_of=d.id))").get(completion.taskId,caseId);
        if(!task||String(task.kind)==="review")continue;
        const support=parse<Provenance>(task.provenance_json);const states=new Map(readSupportSources(db).map(s=>[s.id,s]));
        if(!supported(support,states))continue;
        const original=db.prepare("SELECT claimed_at,observed_at,event_slot,source_id FROM mail_case_events WHERE id=?").get(String(task.event_id))!;
        const originalVersion=eventSourceVersion(String(original.event_slot));
        if(states.get(String(original.source_id))?.version!==originalVersion)continue;
        const receiptTime=source.date!==null&&source.date<=source.observedAt?source.date:source.observedAt;
        const requestedTime=original.claimed_at!==null&&Number(original.claimed_at)<=Number(original.observed_at)?Number(original.claimed_at):Number(original.observed_at);
        if(receiptTime<requestedTime)continue;
        // 解析器已经验证每一个精确item明确回执；支持集中加入该封经人工认证的回执。
        db.prepare("UPDATE mail_case_tasks SET state='resolved_by_evidence',version=version+1,provenance_json=? WHERE id=?").run(JSON.stringify(derive([...support.supportSourceIds,source.id])),completion.taskId);
      }
    }
  }else needsReview=true;
  if(needsReview)reviewTask(db,caseId,source,`${source.version}:${input.fence.configEpoch}:assessment_review`,"assessment_review",cycle);
  if(input.releaseTemporaryReview){
    const event=db.prepare("SELECT id FROM mail_case_events WHERE case_id=? AND source_id=? AND event_slot=? AND kind='review_new_mail'").get(caseId,source.id,`${source.version}:${input.fence.configEpoch}:review_new_mail`);
    if(event){db.prepare("DELETE FROM mail_case_tasks WHERE case_id=? AND event_id=? AND obligation_key='review_new_mail' AND kind='review' AND object='review_new_mail'").run(caseId,event.id);db.prepare("DELETE FROM mail_case_events WHERE id=? AND case_id=? AND kind='review_new_mail' AND NOT EXISTS(SELECT 1 FROM mail_case_tasks WHERE event_id=?)").run(event.id,caseId,event.id);}
  }
  // 资格门只可解除本封邮件的临时review_new_mail；既有业务义务和其它安全review永不在此关闭。
  saveProjection(db,caseId,input.now);return {affectedCaseIds:[...affected].sort()};
}
