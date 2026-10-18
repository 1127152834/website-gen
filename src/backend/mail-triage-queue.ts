import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAIL_TRIAGE_LIMITS as LIMITS, type Fence, type VersionTuple } from "../shared/mail-triage-types.ts";
import { verifiedUidValidity } from "./mail-triage-source.ts";

export type TriagePriority = "new" | "history";
export interface JobRegistration { sourceId: string; sourceVersion: number; tuple: VersionTuple; contextVersion: string; generation: number; configEpoch: number; priority: TriagePriority }
export interface JobLease { jobId: string; leaseToken: string; sourceId: string; configEpoch: number; sourceVersion: number; epoch: number; version: number; contextVersion: string; manualVersion: number; manualVersionsJson?:string|null; tuple: VersionTuple; generation: number; attemptSeq: number }
export interface AttemptPermit { fence: Fence; deadlineAt: number }
export interface TriageFailure { code: string; retryable: boolean; retryAfterMs?: number }
export interface PreparedContext { contextVersion: string; manualVersion: number; manualVersionsJson?:string|null; tuple: VersionTuple }
export interface TriageQueue {
  enqueue(input: JobRegistration): string; peekPriority(): TriagePriority | null; claim(): JobLease | null;
  /** null = 占位作业被去重取消，调用方必须停止该lease并释放服务许可，不得继续出站。 */
  prepareContext(lease: JobLease, context: PreparedContext): JobLease | null;
  reserveAttempt(lease: JobLease): AttemptPermit; renew(fence: Fence): boolean; retry(fence: Fence, failure: TriageFailure): void;
  release(lease: JobLease): void;
  /** capturedAttemptId仅供持有原始caller零派发证明的worker结清已取消/匿名账，不更新job。 */
  settleNotDispatched(fence: Fence, failure: TriageFailure, capturedAttemptId?:string): void;
  cancel(sourceIds: string[], reason: string): void; recover(): number;
}
export interface TriageQueueOptions {
  /** 返回毫秒数，强制约束在[0,1000]；测试可注入确定值。 */
  jitter?: () => number;
  /** Task7/9必须传与mailbox-service一致的同步deleting/closed运行时guard。 */
  isMailboxAvailable?: (mailboxId: number) => boolean;
}
interface JobRow {
  id: string; source_id: string; source_version: number; provider_id: number; model_id: string; model_config_revision: number;
  prompt_version: number; rule_version: number; schema_version: number; context_version: string; generation: number; config_epoch: number;
  state: string; priority: number; next_attempt_at: number; lease_token: string | null; lease_expires_at: number | null;
  attempt_seq: number; manual_version: number; manual_versions_json:string|null; mailbox_id?: number;
}
const tupleOf = (j: JobRow): VersionTuple => ({ providerId:j.provider_id,modelId:j.model_id,modelConfigRevision:j.model_config_revision,promptVersion:j.prompt_version,ruleVersion:j.rule_version,schemaVersion:j.schema_version });
const tupleValues = (t: VersionTuple) => [t.providerId,t.modelId,t.modelConfigRevision,t.promptVersion,t.ruleVersion,t.schemaVersion] as const;
const sameTuple = (a: VersionTuple,b: VersionTuple) => tupleValues(a).every((v,i) => v===tupleValues(b)[i]);
function leaseOf(j: JobRow): JobLease {
  return {jobId:j.id,leaseToken:j.lease_token!,sourceId:j.source_id,configEpoch:j.config_epoch,sourceVersion:j.source_version,epoch:j.config_epoch,version:j.source_version,
    contextVersion:j.context_version,manualVersion:j.manual_version,manualVersionsJson:j.manual_versions_json,tuple:tupleOf(j),generation:j.generation,attemptSeq:j.attempt_seq};
}
const dayOf = (now:number) => new Date(now).toISOString().slice(0,10);
const pending = (context:string) => !context.trim() || context.startsWith("pending-source:");
const retryCodes = new Set(["network","network_error","http_429","rate_limit","http_5xx","timeout"]);
const configCodes = new Set(["http_401","http_403","missing_purpose","missing_model_binding","missing_api_key","unsupported_protocol","config_error"]);
/** last_error只保留白名单代码，绝不保存可能含正文/响应的异常文本。 */
const safeCode = (code:string) => /^http_5\d{2}$/.test(code) ? "http_5xx" : retryCodes.has(code) || configCodes.has(code) || code === "invalid_json" || code === "invalid_evidence" ? code : "request_failed";

/** 只授权已有的精确reserved许可；绝不赋予新出站权。用于第500次请求的预算暂停例外。 */
export function hasReservedTriageFence(db:DatabaseSync,f:Fence,now:number):boolean {
  return Boolean(db.prepare(`SELECT 1 FROM mail_triage_jobs j
    JOIN mail_triage_attempts a ON a.job_id=j.id AND a.attempt_seq=j.attempt_seq AND a.outcome='reserved'
    JOIN mail_triage_sources src ON src.id=j.source_id AND src.state='active' AND src.source_version=j.source_version
    JOIN mail_triage_settings cfg ON cfg.id=1 AND cfg.enabled=1 AND cfg.state IN ('enabled','paused_budget') AND cfg.config_epoch=j.config_epoch AND cfg.model_config_revision=j.model_config_revision
    JOIN model_roles role ON role.role='mail_triage' AND role.provider_id=j.provider_id AND role.model_id=j.model_id
    JOIN model_providers p ON p.id=role.provider_id AND p.config_revision=cfg.consent_provider_revision
    JOIN mail_triage_scope scope ON scope.mailbox_id=src.mailbox_id AND scope.state='authorized' AND scope.epoch=j.config_epoch AND scope.effective_at IS NOT NULL AND scope.effective_at<=?
    JOIN mailboxes b ON b.id=src.mailbox_id AND b.status NOT IN ('deleting','closed','deleted')
    WHERE j.id=? AND j.state='running' AND j.lease_token=? AND j.lease_expires_at>? AND j.attempt_seq=? AND j.config_epoch=? AND j.source_version=? AND j.context_version=? AND j.manual_version=?
      AND NOT EXISTS(SELECT 1 FROM abandoned_domains d WHERE d.domain=b.domain COLLATE NOCASE)
      AND EXISTS(SELECT 1 FROM mail_triage_source_aliases alias JOIN mail_messages m ON m.mailbox_id=alias.mailbox_id AND m.folder=alias.folder AND m.uid=alias.uid AND m.uid_validity=alias.uid_validity
        WHERE alias.source_id=src.id AND alias.mailbox_id=src.mailbox_id AND alias.active=1 AND alias.folder='INBOX' AND alias.uid_validity=scope.uid_validity
          AND (j.priority=1 OR (alias.uid>scope.baseline_uid AND src.observed_at>=scope.effective_at)))`)
    .get(now,f.jobId,f.leaseToken,now,f.attemptSeq,f.configEpoch,f.sourceVersion,f.contextVersion,f.manualVersion));
}

/** 每个实例绑定当前工作区DB；所有许可/恢复写入用BEGIN IMMEDIATE，不跨await。 */
export function createTriageQueue(db: DatabaseSync, clock: () => number, options: TriageQueueOptions = {}): TriageQueue {
  if (options.isMailboxAvailable?.constructor.name === "AsyncFunction") throw new TypeError("邮箱guard必须同步");
  const jitter = options.jitter ?? (()=>Math.random()*1000);
  const atomic = <T>(work:()=>T):T => {
    db.exec("BEGIN IMMEDIATE");
    try {const result=work();db.exec("COMMIT");return result;} catch(error) {db.exec("ROLLBACK");throw error;}
  };
  const row = (id:string) => db.prepare("SELECT * FROM mail_triage_jobs WHERE id=?").get(id) as unknown as JobRow | undefined;
  const countDay = (now:number) => Number(db.prepare("SELECT count(*) AS n FROM mail_triage_attempts WHERE budget_day=? AND outcome<>'not_dispatched'").get(dayOf(now))!.n);
  const consumed = (id:string) => Number(db.prepare("SELECT count(*) n FROM mail_triage_attempts WHERE job_id=? AND outcome<>'not_dispatched'").get(id)!.n);
  function eligible(j:JobRow, allowBudget=false):boolean {
    const allowed = db.prepare(`SELECT src.mailbox_id,scope.uid_validity FROM mail_triage_sources src
      JOIN mailboxes box ON box.id=src.mailbox_id JOIN mail_triage_scope scope ON scope.mailbox_id=src.mailbox_id
      JOIN mail_triage_settings cfg ON cfg.id=1 JOIN model_roles role ON role.role='mail_triage'
      JOIN model_providers provider ON provider.id=role.provider_id
      WHERE src.id=? AND src.state='active' AND src.source_version=? AND cfg.enabled=1
        AND (cfg.state='enabled' OR (?=1 AND cfg.state='paused_budget')) AND cfg.config_epoch=?
        AND cfg.model_config_revision=? AND role.provider_id=? AND role.model_id=?
        AND cfg.consent_provider_revision=provider.config_revision
        AND scope.state='authorized' AND scope.epoch=cfg.config_epoch AND scope.effective_at IS NOT NULL AND scope.effective_at<=?
        AND box.status NOT IN ('deleting','closed','deleted')
        AND EXISTS(SELECT 1 FROM mail_triage_source_aliases alias WHERE alias.source_id=src.id AND alias.mailbox_id=src.mailbox_id
          AND alias.active=1 AND alias.folder='INBOX' AND alias.uid_validity=scope.uid_validity
          AND (?=1 OR (alias.uid>scope.baseline_uid AND src.observed_at>=scope.effective_at)))
        AND NOT EXISTS(SELECT 1 FROM abandoned_domains abandoned WHERE abandoned.domain=box.domain COLLATE NOCASE)`)
      .get(j.source_id,j.source_version,allowBudget?1:0,j.config_epoch,j.model_config_revision,j.provider_id,j.model_id,clock(),j.priority===1?1:0) as {mailbox_id:number;uid_validity:string} | undefined;
    return Boolean(allowed && verifiedUidValidity(allowed.uid_validity) && (!options.isMailboxAvailable || options.isMailboxAvailable(allowed.mailbox_id)===true));
  }
  function liveLease(lease:JobLease, allowBudget=false):JobRow {
    const j=row(lease.jobId);
    if(!j || j.state!=="running" || j.lease_token!==lease.leaseToken || (j.lease_expires_at??0)<=clock()
      || j.source_id!==lease.sourceId || j.source_version!==lease.sourceVersion || j.config_epoch!==lease.configEpoch
      || j.context_version!==lease.contextVersion || j.manual_version!==lease.manualVersion || j.generation!==lease.generation
      || j.manual_versions_json!==(lease.manualVersionsJson??null)
      || j.attempt_seq!==lease.attemptSeq || !sameTuple(tupleOf(j),lease.tuple) || !eligible(j,allowBudget)) throw new Error("lease/fence租约已失效");
    return j;
  }
  function liveFence(f:Fence):JobRow | undefined {
    const j=row(f.jobId);
    if(!j || j.state!=="running" || j.lease_token!==f.leaseToken || (j.lease_expires_at??0)<=clock()
      || j.attempt_seq!==f.attemptSeq || j.config_epoch!==f.configEpoch || j.source_version!==f.sourceVersion
      || j.context_version!==f.contextVersion || j.manual_version!==f.manualVersion || !eligible(j,true)) return;
    const attempt=db.prepare("SELECT 1 FROM mail_triage_attempts WHERE job_id=? AND attempt_seq=? AND outcome='reserved'").get(f.jobId,f.attemptSeq);
    return attempt ? j : undefined;
  }
  function clearJob(id:string,state:string,next:number,code:string|null,now:number) {
    db.prepare("UPDATE mail_triage_jobs SET state=?,next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=?").run(state,next,code,now,id);
  }
  function resumeBudget(now:number) {
    const cfg=db.prepare("SELECT enabled,state,daily_attempt_limit FROM mail_triage_settings WHERE id=1").get()!;
    if(cfg.enabled!==1 || cfg.state!=="paused_budget" || countDay(now)>=Number(cfg.daily_attempt_limit)) return;
    const candidates=db.prepare("SELECT * FROM mail_triage_jobs WHERE state IN ('paused_budget','retry_wait','queued','running')").all() as unknown as JobRow[];
    if(!candidates.some(j=>eligible(j,true))) return;
    db.prepare("UPDATE mail_triage_settings SET state='enabled' WHERE id=1 AND enabled=1 AND state='paused_budget'").run();
  }
  function due():JobRow[] {
    if(db.prepare("SELECT 1 FROM mail_triage_jobs WHERE state='running'").get()) return [];
    return (db.prepare("SELECT * FROM mail_triage_jobs WHERE state IN ('queued','retry_wait') AND next_attempt_at<=? ORDER BY priority,created_at,id").all(clock()) as unknown as JobRow[]).filter(j=>eligible(j));
  }
  const queue:TriageQueue = {
    enqueue(input) {
      if(input.priority!=="new" && input.priority!=="history") throw new TypeError("优先级无效");
      if(!input.contextVersion.trim()) throw new TypeError("上下文版本不能为空");
      return atomic(()=>{
        const values=[input.sourceId,input.sourceVersion,...tupleValues(input.tuple),input.contextVersion,input.generation,input.configEpoch] as const;
        const key="source_id=? AND source_version=? AND provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=? AND context_version=? AND generation=? AND config_epoch=?";
        const old=db.prepare(`SELECT id FROM mail_triage_jobs WHERE ${key}`).get(...values); if(old)return String(old.id);
        const id=randomUUID();const now=clock();
        db.prepare(`INSERT INTO mail_triage_jobs(id,source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,generation,config_epoch,priority,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,...values,input.priority==="new"?0:1,now,now);return id;
      });
    },
    peekPriority() {const j=due()[0];return j?(j.priority===0?"new":"history"):null;},
    claim() {return atomic(()=>{
      const j=due()[0];if(!j)return null;const now=clock();j.state="running";j.lease_token=randomUUID();j.lease_expires_at=now+LIMITS.leaseTtlMs;
      db.prepare("UPDATE mail_triage_jobs SET state='running',lease_token=?,lease_expires_at=?,updated_at=? WHERE id=?").run(j.lease_token,j.lease_expires_at,now,j.id);return leaseOf(j);
    });},
    prepareContext(lease,context) {return atomic(()=>{
      const j=liveLease(lease);
      if(pending(context.contextVersion) || !Number.isSafeInteger(context.manualVersion) || context.manualVersion<0)throw new TypeError("真实上下文与人工版本无效");
      // 已尝试的旧NULL快照不能事后猜填；context hash未变时继续保留未知标记。
      const vector=j.attempt_seq>0?j.manual_versions_json:(context.manualVersionsJson??j.manual_versions_json);
      if(vector!==null){const parsed:unknown=JSON.parse(vector);const pairs=(value:unknown)=>Array.isArray(value)&&value.every(v=>Array.isArray(v)&&v.length===2&&typeof v[0]==='string'&&Number.isSafeInteger(v[1])&&v[1]>=0);const valid=pairs(parsed)||(parsed!==null&&typeof parsed==='object'&&(parsed as {v?:unknown}).v===2&&pairs((parsed as {cases?:unknown}).cases)&&pairs((parsed as {sources?:unknown}).sources));if(!valid)throw new TypeError('人工版本向量无效');}
      if(j.attempt_seq>0&&j.manual_versions_json!==null&&context.manualVersionsJson!==undefined&&context.manualVersionsJson!==j.manual_versions_json)throw new Error('已有attempt不能改变人工版本向量');
      const unchanged=j.context_version===context.contextVersion && j.manual_version===context.manualVersion && j.manual_versions_json===vector && sameTuple(tupleOf(j),context.tuple);
      if(j.attempt_seq>0 && !unchanged)throw new Error("已有attempt尝试不能改变上下文");
      if(unchanged)return leaseOf(j);
      const candidate={...j,context_version:context.contextVersion,manual_version:context.manualVersion,manual_versions_json:vector,provider_id:context.tuple.providerId,model_id:context.tuple.modelId,
        model_config_revision:context.tuple.modelConfigRevision,prompt_version:context.tuple.promptVersion,rule_version:context.tuple.ruleVersion,schema_version:context.tuple.schemaVersion};
      if(!eligible(candidate))throw new Error("上下文配置已失效");
      const existing=db.prepare(`SELECT id FROM mail_triage_jobs WHERE id<>? AND source_id=? AND source_version=? AND provider_id=? AND model_id=? AND model_config_revision=?
        AND prompt_version=? AND rule_version=? AND schema_version=? AND context_version=? AND generation=? AND config_epoch=?`)
        .get(j.id,j.source_id,j.source_version,...tupleValues(context.tuple),context.contextVersion,j.generation,j.config_epoch);
      if(existing){clearJob(j.id,"cancelled",0,"deduplicated",clock());return null;}
      db.prepare("UPDATE mail_triage_jobs SET provider_id=?,model_id=?,model_config_revision=?,prompt_version=?,rule_version=?,schema_version=?,context_version=?,manual_version=?,manual_versions_json=?,updated_at=? WHERE id=?")
        .run(...tupleValues(context.tuple),context.contextVersion,context.manualVersion,vector,clock(),j.id);return leaseOf(candidate);
    });},
    reserveAttempt(lease) {
      const result=atomic(()=>{
        const j=liveLease(lease);const now=clock();if(pending(j.context_version))throw new Error("context上下文尚未准备");
        if(consumed(j.id)>=LIMITS.maxAttempts)throw new Error("attempt许可已用尽");
        if(db.prepare("SELECT 1 FROM mail_triage_attempts WHERE job_id=? AND outcome='reserved'").get(j.id))throw new Error("attempt已有未结束许可");
        const limit=Number(db.prepare("SELECT daily_attempt_limit FROM mail_triage_settings WHERE id=1").get()!.daily_attempt_limit);
        const used=countDay(now);
        if(used>=limit){db.prepare("UPDATE mail_triage_settings SET state='paused_budget' WHERE id=1").run();clearJob(j.id,"paused_budget",0,"daily_budget",now);return null;}
        const seq=j.attempt_seq+1;const deadline=now+LIMITS.requestTimeoutMs;
        db.prepare("INSERT INTO mail_triage_attempts(id,job_id,attempt_seq,budget_day,reserved_at,deadline_at) VALUES(?,?,?,?,?,?)").run(randomUUID(),j.id,seq,dayOf(now),now,deadline);
        db.prepare("UPDATE mail_triage_jobs SET attempt_seq=?,updated_at=? WHERE id=?").run(seq,now,j.id);
        if(used+1>=limit)db.prepare("UPDATE mail_triage_settings SET state='paused_budget' WHERE id=1 AND enabled=1 AND state='enabled'").run();
        return {fence:{jobId:j.id,leaseToken:j.lease_token!,attemptSeq:seq,configEpoch:j.config_epoch,sourceVersion:j.source_version,contextVersion:j.context_version,manualVersion:j.manual_version},deadlineAt:deadline};
      });
      if(!result)throw new Error("每日attempt预算已暂停");return result;
    },
    renew(fence) {return atomic(()=>{const j=liveFence(fence);if(!j)return false;
      db.prepare("UPDATE mail_triage_jobs SET lease_expires_at=?,updated_at=? WHERE id=?").run(clock()+LIMITS.leaseTtlMs,clock(),j.id);return true;
    });},
    release(lease) {atomic(()=>{
      const j=row(lease.jobId);
      if(!j||j.state!=="running"||j.lease_token!==lease.leaseToken||j.attempt_seq!==lease.attemptSeq
        ||j.source_id!==lease.sourceId||j.source_version!==lease.sourceVersion||j.config_epoch!==lease.configEpoch
        ||j.context_version!==lease.contextVersion||j.manual_version!==lease.manualVersion||j.manual_versions_json!==(lease.manualVersionsJson??null)||j.generation!==lease.generation||!sameTuple(tupleOf(j),lease.tuple))return;
      if(db.prepare("SELECT 1 FROM mail_triage_attempts WHERE job_id=? AND outcome='reserved'").get(j.id))return;
      clearJob(j.id,"queued",clock(),null,clock());
    });},
    settleNotDispatched(fence,error,capturedAttemptId) {atomic(()=>{
      const j=row(fence.jobId);
      if(!j||j.state!=="running"||j.lease_token!==fence.leaseToken||j.attempt_seq!==fence.attemptSeq
        ||j.config_epoch!==fence.configEpoch||j.source_version!==fence.sourceVersion||j.context_version!==fence.contextVersion||j.manual_version!==fence.manualVersion){
        // 取消已清token或删除已匿名化；仅原预约的进程内UUID可结清账，绝不复活job/覆盖unknown。
        if(capturedAttemptId){
          const changed=db.prepare("UPDATE mail_triage_attempts SET outcome='not_dispatched',settled_at=? WHERE id=? AND attempt_seq=? AND (job_id=? OR job_id IS NULL) AND outcome IN ('reserved','cancelled')")
            .run(clock(),capturedAttemptId,fence.attemptSeq,fence.jobId);
          if(changed.changes)resumeBudget(clock());
        }
        return;
      }
      const changed=db.prepare("UPDATE mail_triage_attempts SET outcome='not_dispatched',settled_at=? WHERE job_id=? AND attempt_seq=? AND outcome='reserved'").run(clock(),j.id,fence.attemptSeq);
      if(!changed.changes)return;
      // 零请求账仍须结清，但旧配置的错误不能暂停新的epoch或已撤销的授权。
      if(!eligible(j,true)){clearJob(j.id,'stale_source',0,'authorization_changed',clock());return;}
      const code=safeCode(error.code);
      let state=code==='invalid_evidence'?'needs_review':'failed';
      let next=0;
      if(configCodes.has(code)){state='blocked_config';db.prepare("UPDATE mail_triage_settings SET state='blocked_config' WHERE id=1 AND enabled=1").run();}
      else if(error.retryable&&retryCodes.has(code)&&consumed(j.id)<LIMITS.maxAttempts){
        state='retry_wait';const raw=jitter();const noise=Number.isFinite(raw)?Math.max(0,Math.min(1000,raw)):0;
        const after=Number.isFinite(error.retryAfterMs)?Math.max(0,error.retryAfterMs!):0;
        next=clock()+Math.max(LIMITS.retryDelaysMs[Math.max(0,consumed(j.id)-1)]!,after)+noise;
      }
      clearJob(j.id,state,next,code,clock());resumeBudget(clock());
    });},
    retry(fence,error) {atomic(()=>{
      const j=liveFence(fence);if(!j)return;const now=clock();const code=safeCode(error.code);
      db.prepare("UPDATE mail_triage_attempts SET outcome='failed',settled_at=? WHERE job_id=? AND attempt_seq=? AND outcome='reserved'").run(now,j.id,fence.attemptSeq);
      let state="failed";let next=0;
      if(configCodes.has(code)){state="blocked_config";db.prepare("UPDATE mail_triage_settings SET state='blocked_config' WHERE id=1 AND enabled=1").run();}
      else if(code==="invalid_evidence")state="needs_review";
      else if(error.retryable && retryCodes.has(code) && consumed(j.id)<LIMITS.maxAttempts){
        state="retry_wait";const raw=jitter();const noise=Number.isFinite(raw)?Math.max(0,Math.min(1000,raw)):0;
        const after=Number.isFinite(error.retryAfterMs)?Math.max(0,error.retryAfterMs!):0;
        next=now+Math.max(LIMITS.retryDelaysMs[Math.max(0,consumed(j.id)-1)]!,after)+noise;
      }
      clearJob(j.id,state,next,code,now);
    });},
    cancel(sourceIds,_reason) {atomic(()=>{
      for(const id of new Set(sourceIds)){
        db.prepare("UPDATE mail_triage_attempts SET outcome='cancelled',settled_at=? WHERE outcome='reserved' AND job_id IN (SELECT id FROM mail_triage_jobs WHERE source_id=?)").run(clock(),id);
        db.prepare("UPDATE mail_triage_jobs SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,last_error='cancelled',updated_at=? WHERE source_id=? AND state<>'cancelled'").run(clock(),id);
      }
    });},
    recover() {return atomic(()=>{
      const now=clock();resumeBudget(now);let recovered=0;
      const jobs=db.prepare("SELECT * FROM mail_triage_jobs WHERE state IN ('running','paused_budget')").all() as unknown as JobRow[];
      for(const j of jobs){
        if(j.state==="paused_budget") {if(eligible(j)){clearJob(j.id,"queued",j.next_attempt_at,null,now);recovered++;}continue;}
        if((j.lease_expires_at??0)>now)continue;
        const last=db.prepare("SELECT deadline_at,outcome FROM mail_triage_attempts WHERE job_id=? AND attempt_seq=?").get(j.id,j.attempt_seq) as {deadline_at:number;outcome:string}|undefined;
        if(last?.outcome==="reserved" && now<last.deadline_at+LIMITS.unknownResultGraceMs)continue;
        if(last?.outcome==="reserved")db.prepare("UPDATE mail_triage_attempts SET outcome='unknown',settled_at=? WHERE job_id=? AND attempt_seq=? AND outcome='reserved'").run(now,j.id,j.attempt_seq);
        if(!eligible(j,true)){clearJob(j.id,"stale_source",0,"authorization_changed",now);continue;}
        clearJob(j.id,consumed(j.id)>=LIMITS.maxAttempts?"failed":"queued",now,j.attempt_seq?"unknown_result":null,now);recovered++;
      }
      return recovered;
    });},
  };return queue;
}


