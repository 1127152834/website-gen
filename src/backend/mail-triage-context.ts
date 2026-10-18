/** 只读缓存的最小授权交集。绝不读取 projection/assessment 摘要或人工备注。 */
import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAIL_TRIAGE_LIMITS, MAIL_TRIAGE_SCHEMA_VERSION, type Fence, type SourceTrust, type VersionTuple } from "../shared/mail-triage-types.ts";
import { hasReservedTriageFence } from "./mail-triage-queue.ts";
import { cachedParsedMessage, fingerprintSource, verifiedUidValidity } from "./mail-triage-source.ts";
import { roleChoice } from "./models.ts";

export interface TriageSource {
  id:string; mailboxId:number; trust:SourceTrust; subject:string; text:string; fromAddresses:string[]; to:string[]; cc:string[]; date:number; bodyComplete:boolean;
}
export interface TriageCase { id:string; provider:string|null; applicationId:string|null }
export interface TriageTask { id:string; caseId:string; kind:string; state:string; title:string; requestedItems:string[]; deadlineRaw:string|null; deadlineAt:number|null; supportSourceIds:string[] }
export interface TriageInput {
  source:TriageSource; authorizedSources:TriageSource[]; cases:TriageCase[]; tasks:TriageTask[];
  eligibleCaseIds:string[]; eligibleTaskIds:string[]; contextIncomplete:boolean;
  sourceVersion:number; contextVersion:string; manualVersion:number; configEpoch:number; tuple:VersionTuple;
}
export type TriageContextErrorCode="stale_source"|"missing_purpose"|"input_too_large"|"context_integrity";
export class TriageContextError extends Error { readonly code:TriageContextErrorCode;constructor(code:TriageContextErrorCode){super(code);this.name="TriageContextError";this.code=code;} }
function fail(code:TriageContextErrorCode):never { throw new TriageContextError(code); }
function requestedItems(raw:unknown):string[]{let value:unknown;try{value=JSON.parse(String(raw));}catch{fail("context_integrity");}if(!Array.isArray(value)||!value.every(item=>typeof item==="string"))fail("context_integrity");return value as string[];}
/** 链接仍是普通不可信文字；删除所有查询/fragment，避免秘密随 URL 外发。 */
export function redactTriageText(text:string):string {
  return text.replace(/\r\n?/g,"\n")
    .replace(/https?:\/\/[^\s<>"']+/gi,raw=>{try{const url=new URL(raw);url.username="";url.password="";url.search="";url.hash="";return url.toString();}catch{return "[URL]";}})
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,"Bearer [SECRET]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g,"[SECRET]")
    .replace(/((?:password|passwd|pwd|token|api[_ -]?key|secret|密码|口令|验证码|校验码|动态码|verification\s*code|one[- ]time\s*(?:code|password)|otp|(?:your\s+)?code)\s*(?:is|是|为|[:=：])?\s*)[A-Za-z0-9_+./=-]+/gi,"$1[SECRET]")
    .replace(/\b\d{4,8}\b/g,"[CODE]");
}
const chars=(value:unknown)=>Array.from(JSON.stringify(value)).length;
type Row=Record<string,unknown>;
function supported(raw:unknown,allowed:Set<string>):string[]|null {
  try {const p=JSON.parse(String(raw)) as {kind?:unknown;supportSourceIds?:unknown};
    if(p.kind!=="source_derived"||!Array.isArray(p.supportSourceIds)||!p.supportSourceIds.length||!p.supportSourceIds.every(id=>typeof id==="string"&&allowed.has(id)))return null;
    return [...new Set(p.supportSourceIds as string[])];
  }catch{return null;}
}

export function buildTriageContext(db:DatabaseSync,key:Buffer,sourceId:string,epoch:number,reserved?:{fence:Fence;now:number}):TriageInput {
  const settings=db.prepare("SELECT * FROM mail_triage_settings WHERE id=1").get()!;
  const reservedBudget=settings.state==='paused_budget'&&reserved&&reserved.fence.configEpoch===epoch
    &&hasReservedTriageFence(db,reserved.fence,reserved.now)
    &&db.prepare('SELECT 1 FROM mail_triage_jobs WHERE id=? AND source_id=?').get(reserved.fence.jobId,sourceId);
  if(settings.config_epoch!==epoch||settings.enabled!==1||(settings.state!=="enabled"&&!reservedBudget))fail("stale_source");
  const choice=roleChoice(db,"mail_triage");if(!choice)fail("missing_purpose");
  const tuple:VersionTuple={providerId:choice.provider_id,modelId:choice.model_id,modelConfigRevision:Number(settings.model_config_revision),promptVersion:1,ruleVersion:1,schemaVersion:MAIL_TRIAGE_SCHEMA_VERSION};
  const primary=db.prepare("SELECT * FROM mail_triage_sources WHERE id=? AND state='active'").get(sourceId);
  if(!primary)fail("stale_source");
  const linked=db.prepare("SELECT c.* FROM mail_application_cases c JOIN mail_case_sources cs ON cs.case_id=c.id WHERE cs.source_id=? ORDER BY c.id").all(sourceId);
  const related=new Set([sourceId]);
  for(const c of linked)for(const row of db.prepare("SELECT source_id FROM mail_case_sources WHERE case_id=? ORDER BY source_id").all(String(c.id)))related.add(String(row.source_id));
  // 当前 mailbox 的引用头只是候选关系，不能让跨邮箱相同 Message-ID 扩权。
  const cacheSql=`SELECT m.*,s.id AS source_id,s.source_version,s.source_hash,s.trust,scope.scope_version
    FROM mail_triage_sources s JOIN mail_triage_source_aliases a ON a.source_id=s.id AND a.active=1
    JOIN mail_triage_scope scope ON scope.mailbox_id=s.mailbox_id AND scope.state='authorized' AND scope.epoch=?
    JOIN mailboxes box ON box.id=s.mailbox_id
    JOIN mail_messages m ON m.mailbox_id=a.mailbox_id AND m.folder=a.folder AND m.uid=a.uid AND m.uid_validity=a.uid_validity
    WHERE s.state='active' AND scope.uid_validity=a.uid_validity AND scope.effective_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM abandoned_domains d WHERE d.domain=box.domain COLLATE NOCASE)`;
  const currentRow=db.prepare(`${cacheSql} AND s.id=? ORDER BY a.folder,a.uid LIMIT 1`).get(epoch,sourceId) as Row|undefined;
  if(!currentRow||!verifiedUidValidity(String(currentRow.uid_validity)))fail("stale_source");
  const currentMail=cachedParsedMessage(currentRow);
  if(Array.from(currentMail.text).length>MAIL_TRIAGE_LIMITS.bodyCharacters)fail("input_too_large");
  const refs=JSON.stringify([...new Set([currentMail.messageId,currentMail.inReplyTo,...currentMail.references].filter(Boolean))]);
  // SQL 先做相关性与授权交集；不加载/解析无关来源的正文。
  const cacheRows=db.prepare(`${cacheSql} AND (s.id IN (SELECT value FROM json_each(?)) OR (s.mailbox_id=? AND (
    m.message_id IN (SELECT value FROM json_each(?)) OR m.in_reply_to IN (SELECT value FROM json_each(?))
    OR EXISTS(SELECT 1 FROM json_each(m.references_json) r WHERE r.value IN (SELECT value FROM json_each(?))))))
    ORDER BY s.id,a.folder,a.uid`).all(epoch,JSON.stringify([...related]),primary.mailbox_id,refs,refs,refs) as Row[];
  for(const row of cacheRows)related.add(String(row.source_id));
  let incomplete=!currentMail.bodyComplete||Boolean(currentMail.bodyIssue);
  const selected:TriageSource[]=[],versions:unknown[]=[],seen=new Set<string>();let total=0;
  const ordered=[currentRow,...cacheRows.filter(r=>r!==currentRow)];
  for(const row of ordered){
    const id=String(row.source_id);if(!related.has(id)||seen.has(id))continue;seen.add(id);
    const mail=cachedParsedMessage(row);
    if(Array.from(mail.text).length>MAIL_TRIAGE_LIMITS.bodyCharacters){incomplete=true;continue;}
    // 完整缓存必须仍然与登记来源一致；未完整当前信保留显式标志供 worker 停止。
    if(mail.bodyComplete&&fingerprintSource(key,mail).sourceHash!==row.source_hash) {if(id===sourceId)fail("stale_source");incomplete=true;continue;}
    if(!mail.bodyComplete||mail.bodyIssue){incomplete=true;if(id!==sourceId)continue;}
    const source:TriageSource={id,mailboxId:Number(row.mailbox_id),trust:row.trust as SourceTrust,subject:redactTriageText(mail.subject),text:redactTriageText(mail.text),fromAddresses:mail.fromAddresses.map(redactTriageText),to:mail.to.map(redactTriageText),cc:mail.cc.map(redactTriageText),date:mail.date,bodyComplete:mail.bodyComplete&&!mail.bodyIssue};
    const size=chars(source);
    // 当前信有独立30k预算；其余上下文整体30k，任何来源不做静默截断。
    if(id!==sourceId&&(selected.length>=MAIL_TRIAGE_LIMITS.contextSources||total+size>MAIL_TRIAGE_LIMITS.contextCharacters)){incomplete=true;continue;}
    if(id!==sourceId)total+=size;
    selected.push(source);versions.push([id,row.source_version,row.scope_version,row.trust,mail.bodyComplete,mail.bodyIssue]);
  }
  if(!selected.length||selected[0]!.id!==sourceId)fail("stale_source");
  const allowed=new Set(selected.map(s=>s.id));if([...related].some(id=>!allowed.has(id)))incomplete=true;
  const cases:TriageCase[]=[],tasks:TriageTask[]=[];
  for(const c of linked){
    versions.push([c.id,c.version,c.manual_version]);
    const hasManual=Boolean(db.prepare("SELECT 1 FROM mail_case_manual_decisions WHERE case_id=? LIMIT 1").get(String(c.id)));
    if(!hasManual&&supported(c.identity_provenance_json,allowed)){
      const item:TriageCase={id:String(c.id),provider:c.provider==null?null:redactTriageText(String(c.provider)),applicationId:c.application_identity==null?null:redactTriageText(String(c.application_identity))};
      if(total+chars(item)<=MAIL_TRIAGE_LIMITS.contextCharacters){cases.push(item);total+=chars(item);}else incomplete=true;
    }else incomplete=true;
    for(const t of db.prepare("SELECT * FROM mail_case_tasks WHERE case_id=? ORDER BY id").all(String(c.id))){
      const support=supported(t.provenance_json,allowed);
      const event=db.prepare("SELECT source_id,provenance_json FROM mail_case_events WHERE id=? AND case_id=?").get(String(t.event_id),String(c.id));
      if(hasManual||!support||!event||!allowed.has(String(event.source_id))||!supported(event.provenance_json,allowed)){incomplete=true;continue;}
      const item:TriageTask={id:String(t.id),caseId:String(c.id),kind:String(t.kind),state:String(t.state),title:redactTriageText(String(t.title)),requestedItems:requestedItems(t.requested_items_json).map(redactTriageText),deadlineRaw:t.deadline_raw==null?null:redactTriageText(String(t.deadline_raw)),deadlineAt:t.deadline_at==null?null:Number(t.deadline_at),supportSourceIds:support};
      if(total+chars(item)>MAIL_TRIAGE_LIMITS.contextCharacters){incomplete=true;continue;}
      tasks.push(item);total+=chars(item);versions.push([t.id,t.version]);
    }
  }
  const contextVersion=createHmac("sha256",key).update("mail-triage.context.v1\0").update(JSON.stringify([epoch,tuple,versions,incomplete,selected,cases,tasks])).digest("hex");
  return {source:selected[0]!,authorizedSources:selected,cases,tasks,eligibleCaseIds:cases.map(c=>c.id),eligibleTaskIds:tasks.map(t=>t.id),contextIncomplete:incomplete,sourceVersion:Number(primary.source_version),contextVersion,manualVersion:Math.max(0,...linked.map(c=>Number(c.manual_version))),configEpoch:epoch,tuple};
}
