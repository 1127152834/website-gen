/** 单次模型边界：不重试、不回退、不带工具，所有远端错误都是不可信数据。 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/pi-ai";
import { MAIL_TRIAGE_LIMITS, type VersionTuple } from "../shared/mail-triage-types.ts";
import type { TriageInput } from "./mail-triage-context.ts";
import { listProviders, roleChoice, streamRoleOnce } from "./models.ts";
import { hasReservedTriageFence } from "./mail-triage-queue.ts";

export interface TriageModelRequest { input:TriageInput; context:Context; promptHash:string; maxOutputTokens:number }
export interface ModelUsage { inputTokens:number|null; outputTokens:number|null; estimatedCost:number|null }
/** 仅后端进程内使用；不含 body/Key/Authorization，不可持久化后复用。 */
export interface PreparedTriageRequest {
  readonly promptHash:string; readonly wireHash:string; readonly wireBytes:number;
  readonly maxTokens:number; readonly contextWindow:number; readonly expectedUrl:string;
}
export type TriageModelCaller=(request:TriageModelRequest,signal:AbortSignal,prepared?:PreparedTriageRequest)=>Promise<{text:string;usage:ModelUsage}>;
const preparedRequests=new WeakMap<PreparedTriageRequest,{db:DatabaseSync;requestHash:string;configHash:string}>();
export type TriageModelErrorCode="missing_purpose"|"missing_model_binding"|"missing_api_key"|"unsupported_protocol"|"config_error"|"input_too_large"|"response_too_large"|"http_401"|"http_403"|"http_429"|"http_5xx"|"http_error"|"network_error"|"timeout"|"cancelled"|"invalid_response"|"invalid_evidence"|"stale_source";
export class TriageModelError extends Error {
  code:TriageModelErrorCode; retryAfterMs?:number; dispatched=false;
  constructor(code:TriageModelErrorCode,retryAfterMs?:number){super(code);this.name="TriageModelError";this.code=code;if(retryAfterMs!==undefined)this.retryAfterMs=retryAfterMs;}
}
const error=(code:TriageModelErrorCode)=>new TriageModelError(code);
function canonical(value:unknown):string {
  if(value===null||typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
/** 实际 Context 的全部字段和版本；不是原始邮件 hash。 */
export function fingerprintPrompt(context:Context,tuple:VersionTuple):string { return createHash("sha256").update("mail-triage.prompt.v1\0").update(canonical({context,tuple})).digest("hex"); }
function noTools(context:Context):boolean {
  return !context.tools?.length&&context.messages.every(m=>{
    if(m.role!=="user"&&m.role!=="system")return false;
    if("tools" in m&&m.tools!=null&&(!Array.isArray(m.tools)||m.tools.length))return false;
    return typeof m.content==="string"||m.content.every(c=>c.type==="text");
  });
}
function retryAfter(value:string|null):number|undefined {if(!value)return undefined;const n=Number(value);const ms=Number.isFinite(n)?n*1000:Date.parse(value)-Date.now();return Number.isFinite(ms)&&ms>0?ms:undefined;}
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const requestHash=(request:TriageModelRequest)=>hash(canonical(request));
const abortError=(signal:AbortSignal)=>error(signal.reason?.name==="TimeoutError"?"timeout":"cancelled");
interface RequestConfig {maxTokens:number;contextWindow:number;expectedUrl:string;configHash:string}

function inspectRequest(request:TriageModelRequest,db:DatabaseSync):RequestConfig {
  if(!noTools(request.context)||fingerprintPrompt(request.context,request.input.tuple)!==request.promptHash)throw error("config_error");
  if(!request.input.source.bodyComplete)throw error("invalid_evidence");
  const choice=roleChoice(db,"mail_triage");if(!choice)throw error("missing_purpose");
  const row=db.prepare("SELECT id,protocol,base_url,config_revision,models_json,api_key_ciphertext FROM model_providers WHERE id=?").get(choice.provider_id);
  if(!row)throw error("missing_model_binding");
  if(row.protocol!=="openai"&&row.protocol!=="anthropic")throw error("unsupported_protocol");
  // 配置只从服务器 DB 读取。provider 列表不返回 Key。
  const provider=listProviders(db).find(p=>p.id===choice.provider_id);
  if(!provider)throw error("missing_model_binding");
  if(provider.protocol!=="openai"&&provider.protocol!=="anthropic")throw error("unsupported_protocol");
  if(!provider.hasKey)throw error("missing_api_key");
  const model=provider.models.find(m=>m.id===choice.model_id);if(!model)throw error("missing_model_binding");
  if(request.input.tuple.providerId!==provider.id||request.input.tuple.modelId!==model.id)throw error("config_error");
  const settings=db.prepare("SELECT config_epoch,enabled,state,consent_provider_revision,model_config_revision FROM mail_triage_settings WHERE id=1").get()!;
  if(settings.model_config_revision!==request.input.tuple.modelConfigRevision)throw error("config_error");
  if(settings.state==='paused_budget'){
    const t=request.input.tuple;
    const j=db.prepare(`SELECT * FROM mail_triage_jobs WHERE source_id=? AND source_version=? AND config_epoch=? AND context_version=? AND manual_version=?
      AND provider_id=? AND model_id=? AND model_config_revision=? AND prompt_version=? AND rule_version=? AND schema_version=? AND state='running'`).get(request.input.source.id,request.input.sourceVersion,request.input.configEpoch,request.input.contextVersion,request.input.manualVersion,t.providerId,t.modelId,t.modelConfigRevision,t.promptVersion,t.ruleVersion,t.schemaVersion);
    if(!j||!hasReservedTriageFence(db,{jobId:String(j.id),leaseToken:String(j.lease_token),attemptSeq:Number(j.attempt_seq),configEpoch:Number(j.config_epoch),sourceVersion:Number(j.source_version),contextVersion:String(j.context_version),manualVersion:Number(j.manual_version)},Date.now()))throw error('stale_source');
  }
  const maxTokens=Math.min(4096,model.maxOutputTokens,request.maxOutputTokens);
  if(!Number.isSafeInteger(maxTokens)||maxTokens<1)throw error("config_error");
  const inputBytes=Buffer.byteLength(canonical(request.context));
  // UTF-8每字节最多按1 token计，加协议封装保守预留；无法证明窗口足够则拒绝，不截断。
  if(inputBytes>MAIL_TRIAGE_LIMITS.requestBytes||inputBytes+maxTokens+4096>model.contextWindow)throw error("input_too_large");
  // 1.2.0 Anthropic SDK 的 beta.messages 固定追加 /v1/messages?beta=true（不自动去重 base 的 /v1）。
  const expectedUrl=new URL(provider.baseUrl.replace(/\/$/,"")+(provider.protocol==="openai"?"/chat/completions":"/v1/messages?beta=true")).href;
  // 最后一个预算许可会把enabled变paused_budget；仅上面的精确reserved证明可走兼容分支。
  const hashSettings={...settings,state:settings.state==='paused_budget'?'enabled':settings.state};
  return {maxTokens,contextWindow:model.contextWindow,expectedUrl,configHash:hash(canonical({choice,provider:row,settings:hashSettings}))};
}

/** 校验 SDK 已完成序列化的真实 JSON；不复制、保存或记录 fetch headers。 */
function inspectWire(input:string|URL|Request,init:RequestInit|undefined,config:RequestConfig):{wireHash:string;wireBytes:number} {
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.href!==config.expectedUrl||typeof init?.body!=="string")throw error("config_error");
  const wireBytes=Buffer.byteLength(init.body);
  if(wireBytes>MAIL_TRIAGE_LIMITS.requestBytes||wireBytes+config.maxTokens+4096>config.contextWindow)throw error("input_too_large");
  const payload=JSON.parse(init.body) as {tools?:unknown;functions?:unknown;max_tokens?:number;max_completion_tokens?:number};
  const outputCap=payload.max_completion_tokens??payload.max_tokens;
  if(payload.tools||payload.functions||!Number.isSafeInteger(outputCap)||outputCap!<1||outputCap!>config.maxTokens)throw error("config_error");
  return {wireHash:hash(init.body),wireBytes};
}

/** 预算预留前 await：真实适配器零网络 dry-run，捕获最终 wire 大小/hash 后立即取消并排空。 */
export async function preflightTriageRequest(request:TriageModelRequest,deps:{db:DatabaseSync;key:Buffer},signal?:AbortSignal):Promise<PreparedTriageRequest> {
  const controller=new AbortController();
  const onAbort=()=>controller.abort(signal?abortError(signal):error("cancelled"));
  signal?.addEventListener("abort",onAbort,{once:true});
  const timer=setTimeout(()=>controller.abort(error("timeout")),MAIL_TRIAGE_LIMITS.requestTimeoutMs);timer.unref();
  try{
    if(signal?.aborted)throw abortError(signal);
    const config=inspectRequest(request,deps.db),originalRequestHash=requestHash(request);
    let captured:{wireHash:string;wireBytes:number}|undefined,captureCalls=0,failure:TriageModelError|undefined;
    const stop=new Error("preparation_complete");
    const captureFetch:typeof fetch=async(input,init)=>{
      try{
        if(controller.signal.aborted)throw controller.signal.reason;
        if(++captureCalls!==1)throw error("config_error");
        captured=inspectWire(input,init,config);
      }catch(e){failure=e instanceof TriageModelError?e:error("config_error");controller.abort(failure);throw failure;}
      // 绝不委托 global/base fetch；仅保存无凭据的大小和 digest。
      controller.abort(stop);throw stop;
    };
    const stream=streamRoleOnce(deps.db,deps.key,"mail_triage",request.context,{signal:controller.signal,fetch:captureFetch,maxTokens:config.maxTokens,maxRetries:0,timeoutMs:MAIL_TRIAGE_LIMITS.requestTimeoutMs});
    await stream.result();
    if(failure)throw failure;
    if(controller.signal.aborted&&controller.signal.reason!==stop)throw controller.signal.reason;
    if(captureCalls!==1||!captured)throw error("config_error");
    if(requestHash(request)!==originalRequestHash||inspectRequest(request,deps.db).configHash!==config.configHash)throw error("config_error");
    const prepared:PreparedTriageRequest=Object.freeze({promptHash:request.promptHash,...captured,maxTokens:config.maxTokens,contextWindow:config.contextWindow,expectedUrl:config.expectedUrl});
    preparedRequests.set(prepared,{db:deps.db,requestHash:originalRequestHash,configHash:config.configHash});
    return prepared;
  }catch(e){throw e instanceof TriageModelError?e:error("config_error");}
  finally{clearTimeout(timer);signal?.removeEventListener("abort",onAbort);controller.abort();}
}

function validatePrepared(request:TriageModelRequest,db:DatabaseSync,prepared:PreparedTriageRequest):RequestConfig {
  try{
    const stamp=preparedRequests.get(prepared);
    if(!stamp||stamp.db!==db)throw error("config_error");
    const config=inspectRequest(request,db);
    if(stamp.requestHash!==requestHash(request)||stamp.configHash!==config.configHash||prepared.promptHash!==request.promptHash)throw error("config_error");
    return config;
  }catch(e){throw e instanceof TriageModelError?e:error("config_error");}
}

export async function completeTriageOnce(request:TriageModelRequest,signal:AbortSignal,deps:{db:DatabaseSync;key:Buffer;fetch?:typeof fetch;prepared?:PreparedTriageRequest}):Promise<{text:string;usage:ModelUsage}> {
  const {db,key}=deps;
  if(signal.aborted)throw abortError(signal);
  const prepared=deps.prepared??await preflightTriageRequest(request,{db,key},signal);
  // await 交接时预检已移除旧监听器；取消可能先于本 continuation，不能只等未来事件。
  if(signal.aborted)throw abortError(signal);
  const config=validatePrepared(request,db,prepared),{maxTokens}=config;
  const controller=new AbortController();let failure:TriageModelError|undefined,dispatches=0;
  const abort=(e:TriageModelError)=>{failure??=e;controller.abort(e);};
  const onAbort=()=>abort(abortError(signal));
  signal.addEventListener("abort",onAbort,{once:true});
  if(signal.aborted)onAbort();
  const timer=setTimeout(()=>abort(error("timeout")),MAIL_TRIAGE_LIMITS.requestTimeoutMs);timer.unref();
  const guarded:typeof fetch=async(input,init)=>{
    if(controller.signal.aborted)throw failure??error("cancelled");
    try{
      if(dispatches!==0)throw error("config_error");
      const actualConfig=validatePrepared(request,db,prepared),wire=inspectWire(input,init,actualConfig);
      if(wire.wireHash!==prepared.wireHash||wire.wireBytes!==prepared.wireBytes)throw error("config_error");
    }catch(e){abort(e instanceof TriageModelError?e:error("config_error"));throw failure!;}
    if(signal.aborted)onAbort();
    if(controller.signal.aborted)throw failure??abortError(signal);
    dispatches++;
    let response:Response;
    try{response=await(deps.fetch??globalThis.fetch)(input,{...init,redirect:"error",signal:controller.signal});}
    catch{if(!failure)abort(error("network_error"));throw failure!;}
    if(!response.ok){
      const code:TriageModelErrorCode=response.status===401?"http_401":response.status===403?"http_403":response.status===429?"http_429":response.status>=500?"http_5xx":"http_error";
      const e=new TriageModelError(code,retryAfter(response.headers.get("retry-after")));
      void response.body?.cancel().catch(()=>undefined);abort(e);throw e;
    }
    if(!response.body){abort(error("invalid_response"));throw failure!;}
    const reader=response.body.getReader();let bytes=0,ended=false;
    if(Number(response.headers.get("content-length"))>1024*1024){void reader.cancel().catch(()=>undefined);abort(error("response_too_large"));throw failure!;}
    const body=new ReadableStream<Uint8Array>({
      async pull(target){try{const next=await reader.read();if(ended)return;if(next.done){ended=true;target.close();return;}bytes+=next.value.byteLength;if(bytes>1024*1024){ended=true;abort(error("response_too_large"));void reader.cancel().catch(()=>undefined);target.error(failure);return;}target.enqueue(next.value);}catch{if(ended)return;ended=true;if(!failure)abort(error("network_error"));target.error(failure);}},
      cancel(){ended=true;return reader.cancel().catch(()=>undefined);},
    });
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
  try {
    const stream=streamRoleOnce(db,key,"mail_triage",request.context,{signal:controller.signal,fetch:guarded,maxTokens,maxRetries:0,timeoutMs:MAIL_TRIAGE_LIMITS.requestTimeoutMs});
    let text="",size=0,done=false,usage:ModelUsage={inputTokens:null,outputTokens:null,estimatedCost:null};
    for await(const event of stream){
      if(failure)throw failure;
      if(event.type==="text_delta"){size+=Buffer.byteLength(event.delta);if(size>MAIL_TRIAGE_LIMITS.outputBytes){abort(error("response_too_large"));throw failure!;}text+=event.delta;}
      if(event.type.startsWith("toolcall")){abort(error("invalid_response"));throw failure!;}
      if(event.type==="error")throw failure??error(controller.signal.aborted?"cancelled":"invalid_response");
      if(event.type==="done"){
        if(event.message.stopReason!=="stop")throw error("invalid_response");
        const finalText=event.message.content.filter(c=>c.type==="text").map(c=>c.text).join("");
        if(Buffer.byteLength(finalText)>MAIL_TRIAGE_LIMITS.outputBytes){abort(error("response_too_large"));throw failure!;}
        if(finalText!==text)throw error("invalid_response");
        done=true;usage={inputTokens:Number.isFinite(event.message.usage.input)?event.message.usage.input:null,outputTokens:Number.isFinite(event.message.usage.output)?event.message.usage.output:null,estimatedCost:null};
      }
    }
    if(failure)throw failure;if(!done||dispatches!==1)throw error("invalid_response");
    return {text,usage};
  }catch(e){const out=failure??(e instanceof TriageModelError?e:error("config_error"));out.dispatched=dispatches>0;throw out;}
  finally{clearTimeout(timer);signal.removeEventListener("abort",onAbort);controller.abort();}
}
