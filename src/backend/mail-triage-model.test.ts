import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { openDb,migrate } from "./db.ts";
import { createProviderConfig,setRole } from "./models.ts";
import type { TriageInput } from "./mail-triage-context.ts";
import type { Context } from "@earendil-works/pi-ai";
const key=Buffer.alloc(32,7);
const mod=()=>import("./mail-triage-model.ts");
const sse=(protocol:string,text:string)=> protocol==="openai" ? `data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",model:"fixture",choices:[{index:0,delta:{role:"assistant",content:text},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",model:"fixture",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}})}\n\ndata: [DONE]\n\n` : [
  ["message_start",{type:"message_start",message:{id:"fixture",type:"message",role:"assistant",model:"fixture",content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}}],
  ["content_block_start",{type:"content_block_start",index:0,content_block:{type:"text",text:""}}],
  ["content_block_delta",{type:"content_block_delta",index:0,delta:{type:"text_delta",text}}],
  ["content_block_stop",{type:"content_block_stop",index:0}],
  ["message_delta",{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:4}}],
  ["message_stop",{type:"message_stop"}]
].map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
async function fixture(protocol:"openai"|"anthropic",mode="ok") {
  let calls=0,payload="",captured:RequestInit|undefined;
  const server=createServer(async(req,res)=>{
    calls++; for await(const chunk of req) payload+=String(chunk);
    if(["500","401","403","429"].includes(mode)){res.writeHead(Number(mode),{"retry-after":"130"});res.end("SECRET_REMOTE_BODY");return;}
    if(mode==="redirect"){res.writeHead(307,{location:"http://127.0.0.1:1/forbidden"});res.end();return;}
    res.writeHead(200,{"content-type":"text/event-stream"});
    if(mode==="hang"){res.write(": waiting\n\n");return;}
    if(mode==="wire"){res.end(`: ${"x".repeat(1024*1024+1)}\n\n`);return;}
    res.end(sse(protocol,mode==="output"?"测".repeat(6000):"fixture text"));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const port=(server.address() as {port:number}).port;
  const db=openDb(":memory:");migrate(db);
  const providerId=createProviderConfig(db,key,{name:"fixture",protocol,baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:"fake-fixture-key",models:[{id:"fixture",name:"fixture",contextWindow:128000,maxOutputTokens:8000,thinkingLevels:["off","high"],vision:false}]});
  setRole(db,"mail_triage",{providerId,modelId:"fixture",thinking:"off"});
  const source={id:"00000000-0000-4000-8000-000000000001",mailboxId:1,trust:"unconfirmed" as const,subject:"fixture",text:"test",fromAddresses:["sender@test.invalid"],to:[],cc:[],date:1,bodyComplete:true};
  const tuple={providerId,modelId:"fixture",modelConfigRevision:1,promptVersion:1,ruleVersion:1,schemaVersion:1};
  const input:TriageInput={source,authorizedSources:[source],eligibleCaseIds:[],eligibleTaskIds:[],cases:[],tasks:[],contextIncomplete:false,sourceVersion:1,contextVersion:"fixture",manualVersion:0,configEpoch:1,tuple};
  const context:Context={systemPrompt:"Fixed fixture instruction",messages:[{role:"user",content:JSON.stringify(input),timestamp:0}]};
  const {fingerprintPrompt}=await mod();
  const request={input,context,promptHash:fingerprintPrompt(context,tuple),maxOutputTokens:4096};
  const fetchImpl:typeof fetch=async(url,init)=>{captured=init;return fetch(url,init);};
  return {db,request,fetchImpl,get calls(){return calls;},get payload(){return payload;},get captured(){return captured;},async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();}};
}
for(const protocol of ["openai","anthropic"] as const){
  test(`B40/B58 ${protocol} actual SDK fake SSE is single dispatch, redirect:error, bounded tokens, no tools`,async()=>{
    const {completeTriageOnce}=await mod();const f=await fixture(protocol);
    try{const out=await completeTriageOnce(f.request,new AbortController().signal,{db:f.db,key,fetch:f.fetchImpl});assert.equal(out.text,"fixture text");assert.equal(f.calls,1);assert.equal(f.captured?.redirect,"error");assert.equal(out.usage.estimatedCost,null);const wire=JSON.parse(f.payload);assert.equal(wire.tools,undefined);assert.ok((wire.max_tokens??wire.max_completion_tokens)<=4096);assert.ok(out.usage.inputTokens!>=10);}finally{await f.close();}
  });
  test(`B40 ${protocol} HTTP500 has no SDK/internal retry and error body is not exposed`,async()=>{
    const {completeTriageOnce}=await mod();const f=await fixture(protocol,"500");
    try{await assert.rejects(completeTriageOnce(f.request,new AbortController().signal,{db:f.db,key,fetch:f.fetchImpl}),(err:unknown)=>{assert.equal((err as {code:string}).code,"http_5xx");assert.equal((err as {dispatched:boolean}).dispatched,true);assert.equal(String(err).includes("SECRET_REMOTE_BODY"),false);return true;});assert.equal(f.calls,1);}finally{await f.close();}
  });
  for(const mode of ["output","wire"]){test(`B59 ${protocol} ${mode} overflow aborts real transport`,async()=>{
    const {completeTriageOnce}=await mod();const f=await fixture(protocol,mode);
    try{await assert.rejects(completeTriageOnce(f.request,new AbortController().signal,{db:f.db,key,fetch:f.fetchImpl}),{code:"response_too_large"});assert.equal(f.calls,1);assert.equal(f.captured?.signal?.aborted,true);}finally{await f.close();}
  });}
  test(`B58 ${protocol} caller cancellation reaches actual HTTP signal`,async()=>{
    const {completeTriageOnce}=await mod();const f=await fixture(protocol,"hang");const controller=new AbortController();
    try{const promise=completeTriageOnce(f.request,controller.signal,{db:f.db,key,fetch:f.fetchImpl});while(!f.calls)await new Promise(r=>setTimeout(r,5));controller.abort();await assert.rejects(promise,{code:"cancelled"});assert.equal(f.captured?.signal?.aborted,true);assert.equal(f.calls,1);}finally{await f.close();}
  });
  test(`B58 ${protocol} redirects cannot dispatch to another endpoint`,async()=>{
    const {completeTriageOnce}=await mod();const f=await fixture(protocol,"redirect");
    try{await assert.rejects(completeTriageOnce(f.request,new AbortController().signal,{db:f.db,key,fetch:f.fetchImpl}));assert.equal(f.calls,1);assert.equal(f.captured?.redirect,"error");}finally{await f.close();}
  });
  test(`B59 ${protocol} high thinking cannot expand real output token cap`,async()=>{
    const {completeTriageOnce}=await mod();const f=await fixture(protocol);
    try{setRole(f.db,"mail_triage",{providerId:f.request.input.tuple.providerId,modelId:"fixture",thinking:"high"});await completeTriageOnce(f.request,new AbortController().signal,{db:f.db,key,fetch:f.fetchImpl});const wire=JSON.parse(f.payload);assert.ok((wire.max_tokens??wire.max_completion_tokens)<=4096);}finally{await f.close();}
  });
  test(`B58 ${protocol} caller's earlier deadline is not widened to SDK timeout`,async()=>{
    const {completeTriageOnce}=await mod();const f=await fixture(protocol,"hang");
    try{const started=Date.now();await assert.rejects(completeTriageOnce(f.request,AbortSignal.timeout(100),{db:f.db,key,fetch:f.fetchImpl}),{code:"timeout"});assert.ok(Date.now()-started<3000);assert.equal(f.captured?.signal?.aborted,true);assert.equal(f.calls,1);}finally{await f.close();}
  });
  for(const status of ["401","403","429"]){test(`B40 ${protocol} HTTP ${status} is typed, sanitized, not retried`,async()=>{
    const {completeTriageOnce}=await mod();const f=await fixture(protocol,status);
    try{await assert.rejects(completeTriageOnce(f.request,new AbortController().signal,{db:f.db,key,fetch:f.fetchImpl}),(e:unknown)=>{assert.equal((e as {code:string}).code,`http_${status}`);assert.equal((e as {retryAfterMs:number}).retryAfterMs,130000);assert.equal(String(e).includes("SECRET_REMOTE_BODY"),false);return true;});assert.equal(f.calls,1);}finally{await f.close();}
  });}
}

for(const protocol of ["openai","anthropic"] as const){
  for(const outcome of ["cancelled","timeout"] as const)test(`fix2 ${protocol} ${outcome} in async preparation handoff never reaches base fetch`,async()=>{
    const {completeTriageOnce}=await mod();const f=await fixture(protocol);
    const controller=new AbortController();const signal=controller.signal;
    const remove=signal.removeEventListener.bind(signal);
    let scheduled=false,baseCalls=0,callerAbortedAtDispatch:boolean|null=null;
    // The preparation finally removes its listener before complete's await continuation.
    // Queue abort in that exact gap, not on a timer or after eventual rejection.
    signal.removeEventListener=((type:string,listener:EventListenerOrEventListenerObject,options?:boolean|EventListenerOptions)=>{
      remove(type,listener,options);
      if(type==="abort"&&!scheduled){scheduled=true;queueMicrotask(()=>controller.abort(outcome==="timeout"?new DOMException("worker deadline","TimeoutError"):undefined));}
    }) as typeof signal.removeEventListener;
    const noNetwork:typeof fetch=async()=>{baseCalls++;callerAbortedAtDispatch=signal.aborted;throw new Error("Unexpected base dispatch");};
    try{
      await assert.rejects(completeTriageOnce(f.request,signal,{db:f.db,key,fetch:noNetwork}),(e:unknown)=>{
        const failure=e as {code:string;dispatched:boolean};
        assert.deepEqual({code:failure.code,dispatched:failure.dispatched,baseCalls,callerAbortedAtDispatch},
          {code:outcome,dispatched:false,baseCalls:0,callerAbortedAtDispatch:null});
        return true;
      });
      assert.equal(scheduled,true);assert.equal(signal.aborted,true);assert.equal(f.calls,0);
    }finally{signal.removeEventListener=remove;await f.close();}
  });
  test(`fix2 ${protocol} abort while establishing listener is caught before base fetch`,async()=>{
    const {preflightTriageRequest,completeTriageOnce}=await mod();const f=await fixture(protocol);
    const controller=new AbortController(),signal=controller.signal,add=signal.addEventListener.bind(signal);
    let baseCalls=0,registrationGap=false;
    try{
      const prepared=await preflightTriageRequest(f.request,{db:f.db,key});
      signal.addEventListener=((type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>{
        if(type==="abort"&&!registrationGap){registrationGap=true;controller.abort();}
        add(type,listener,options);
      }) as typeof signal.addEventListener;
      const noNetwork:typeof fetch=async()=>{baseCalls++;throw new Error("Unexpected base dispatch");};
      await assert.rejects(completeTriageOnce(f.request,signal,{db:f.db,key,prepared,fetch:noNetwork}),(e:unknown)=>{
        const failure=e as {code:string;dispatched:boolean};
        assert.deepEqual({code:failure.code,dispatched:failure.dispatched,baseCalls},{code:"cancelled",dispatched:false,baseCalls:0});return true;
      });
      assert.equal(registrationGap,true);assert.equal(f.calls,0);
    }finally{signal.addEventListener=add;await f.close();}
  });
  test(`fix1 ${protocol} prepared metadata is credential-free; dry-run has zero base fetch and complete sends exact captured wire once`,async()=>{
    const {preflightTriageRequest,completeTriageOnce}=await mod();const f=await fixture(protocol);
    let baseFetchCalls=0;const originalFetch=globalThis.fetch;
    try{
      globalThis.fetch=async()=>{baseFetchCalls++;throw new Error("dry-run must not delegate global fetch");};
      const prepared=await preflightTriageRequest(f.request,{db:f.db,key});
      globalThis.fetch=originalFetch;
      assert.equal(baseFetchCalls,0);assert.equal(f.calls,0);assert.equal(Object.isFrozen(prepared),true);
      const serialized=JSON.stringify(prepared);assert.equal(serialized.includes("fake-fixture-key"),false);assert.equal(/authorization|api.key|body/i.test(serialized),false);
      await completeTriageOnce(f.request,new AbortController().signal,{db:f.db,key,prepared,fetch:f.fetchImpl});
      assert.equal(f.calls,1);assert.equal(prepared.wireBytes,Buffer.byteLength(f.payload));assert.equal(prepared.wireHash,createHash("sha256").update(f.payload).digest("hex"));
    }finally{globalThis.fetch=originalFetch;await f.close();}
  });
  test(`fix1 ${protocol} actual serialized body exactly 256KiB is accepted and one byte more is rejected before reserve`,async()=>{
    const {preflightTriageRequest,completeTriageOnce,fingerprintPrompt}=await mod();const f=await fixture(protocol);
    try{
      const models=JSON.parse(String(f.db.prepare("SELECT models_json FROM model_providers").get()!.models_json));models[0].contextWindow=1000000;
      f.db.prepare("UPDATE model_providers SET models_json=?").run(JSON.stringify(models));
      let context:Context={messages:[{role:"user",content:"x",timestamp:0}]};
      let request={...f.request,context,promptHash:fingerprintPrompt(context,f.request.input.tuple)};
      const base=await preflightTriageRequest(request,{db:f.db,key});
      const content="x".repeat(256*1024-base.wireBytes+1);
      context={messages:[{role:"user",content,timestamp:0}]};request={...request,context,promptHash:fingerprintPrompt(context,request.input.tuple)};
      const prepared=await preflightTriageRequest(request,{db:f.db,key});assert.equal(prepared.wireBytes,256*1024);assert.equal(f.calls,0);
      await completeTriageOnce(request,new AbortController().signal,{db:f.db,key,fetch:f.fetchImpl,prepared});assert.equal(f.calls,1);assert.equal(Buffer.byteLength(f.payload),256*1024);
      context={messages:[{role:"user",content:content+"x",timestamp:0}]};request={...request,context,promptHash:fingerprintPrompt(context,request.input.tuple)};
      await assert.rejects(preflightTriageRequest(request,{db:f.db,key}),{code:"input_too_large",dispatched:false});assert.equal(f.calls,1);
    }finally{await f.close();}
  });
  test(`fix1 ${protocol} prepared token is bound to its workspace DB even with copied provider configuration`,async()=>{
    const {preflightTriageRequest,completeTriageOnce}=await mod();const a=await fixture(protocol),b=await fixture(protocol);
    try{
      const row=a.db.prepare("SELECT base_url,api_key_ciphertext,models_json FROM model_providers").get()!;
      b.db.prepare("UPDATE model_providers SET base_url=?,api_key_ciphertext=?,models_json=?").run(String(row.base_url),row.api_key_ciphertext as Uint8Array,String(row.models_json));
      const prepared=await preflightTriageRequest(a.request,{db:a.db,key});
      await assert.rejects(completeTriageOnce(a.request,new AbortController().signal,{db:b.db,key,fetch:b.fetchImpl,prepared}),{code:"config_error",dispatched:false});
      assert.equal(a.calls,0);assert.equal(b.calls,0);
    }finally{await a.close();await b.close();}
  });
  for(const change of ["provider_revision","model_config_revision","role_thinking","model_json","model_json_invalid","endpoint","request","forged_prepared","in_flight_config"] as const){
    test(`fix1 ${protocol} ${change} after preparation fails with dispatched:false and no HTTP`,async()=>{
      const {preflightTriageRequest,completeTriageOnce,fingerprintPrompt}=await mod();const f=await fixture(protocol);
      try{
        let prepared=await preflightTriageRequest(f.request,{db:f.db,key});let request=f.request;
        if(change==="provider_revision")f.db.exec("UPDATE model_providers SET config_revision=config_revision+1");
        if(change==="model_config_revision")f.db.exec("UPDATE mail_triage_settings SET model_config_revision=model_config_revision+1");
        if(change==="role_thinking")f.db.exec("UPDATE model_roles SET thinking='high' WHERE role='mail_triage'");
        if(change==="model_json"){const m=JSON.parse(String(f.db.prepare("SELECT models_json FROM model_providers").get()!.models_json));m[0].maxTokens+=1;f.db.prepare("UPDATE model_providers SET models_json=?").run(JSON.stringify(m));}
        if(change==="model_json_invalid")f.db.exec("UPDATE model_providers SET models_json='{}'");
        if(change==="endpoint")f.db.exec("UPDATE model_providers SET base_url='http://127.0.0.1:1/different'");
        if(change==="request"){const context={messages:[{role:"user" as const,content:"different",timestamp:0}]};request={...request,context,promptHash:fingerprintPrompt(context,request.input.tuple)};}
        if(change==="forged_prepared")prepared={...prepared};
        const promise=completeTriageOnce(request,new AbortController().signal,{db:f.db,key,fetch:f.fetchImpl,prepared});
        if(change==="in_flight_config")f.db.exec("UPDATE model_providers SET config_revision=config_revision+1");
        await assert.rejects(promise,{code:"config_error",dispatched:false});assert.equal(f.calls,0);
      }finally{await f.close();}
    });
  }
}
test("B35 preflight rejects tools, oversized input, hash mismatch, missing binding before HTTP",async()=>{
  const {completeTriageOnce,fingerprintPrompt}=await mod();const f=await fixture("openai");
  try{
    const call=(r:typeof f.request)=>completeTriageOnce(r,new AbortController().signal,{db:f.db,key,fetch:f.fetchImpl});
    const tools={...f.request.context,tools:[{name:"unsafe",description:"unsafe",parameters:{type:"object"}}] as Context["tools"]};
    await assert.rejects(call({...f.request,context:tools,promptHash:fingerprintPrompt(tools,f.request.input.tuple)}),{code:"config_error"});
    const big={messages:[{role:"user" as const,content:"x".repeat(260000),timestamp:0}]};
    await assert.rejects(call({...f.request,context:big,promptHash:fingerprintPrompt(big,f.request.input.tuple)}),{code:"input_too_large"});
    await assert.rejects(call({...f.request,promptHash:"wrong"}),{code:"config_error"});
    f.db.exec("DELETE FROM model_roles WHERE role='mail_triage'");await assert.rejects(call(f.request),{code:"missing_purpose"});assert.equal(f.calls,0);
  }finally{await f.close();}
});
test("preflight is callable before attempt reservation; missing key/model and stale revision fail closed",async()=>{
  const {preflightTriageRequest}=await mod();const f=await fixture("openai");
  try{
    assert.equal((await preflightTriageRequest(f.request,{db:f.db,key})).maxTokens,4096);
    f.db.exec("UPDATE mail_triage_settings SET model_config_revision=2");await assert.rejects(preflightTriageRequest(f.request,{db:f.db,key}),{code:"config_error",dispatched:false});
    f.db.exec("UPDATE mail_triage_settings SET model_config_revision=1; UPDATE model_roles SET model_id='missing' WHERE role='mail_triage'");await assert.rejects(preflightTriageRequest(f.request,{db:f.db,key}),{code:"missing_model_binding",dispatched:false});
    f.db.exec("UPDATE model_roles SET model_id='fixture' WHERE role='mail_triage'; UPDATE model_providers SET api_key_ciphertext=NULL");await assert.rejects(preflightTriageRequest(f.request,{db:f.db,key}),{code:"missing_api_key",dispatched:false});
    assert.equal(f.calls,0);
  }finally{await f.close();}
});

for(const protocol of ["openai","anthropic"] as const) for(const variant of ["envelope","long-model-id","protocol-parameters","unicode"] as const) {
  test(`fix1 ${protocol} ${variant} exact wire-size failure is rejected before attempt reservation`,async()=>{
    const {preflightTriageRequest,completeTriageOnce,fingerprintPrompt}=await mod();
    const db=openDb(":memory:");migrate(db);let baseFetchCalls=0;
    try{
      const modelId=variant==="long-model-id"?"模".repeat(120):"fixture";
      const providerId=createProviderConfig(db,key,{name:"fixture",protocol,baseUrl:"http://127.0.0.1:1/v1",apiKey:"fake-key",models:[{id:modelId,name:"fixture",contextWindow:1000000,maxOutputTokens:8192,thinkingLevels:["off","high"],vision:false}]});
      setRole(db,"mail_triage",{providerId,modelId,thinking:variant==="protocol-parameters"?"high":"off"});
      if(variant==="protocol-parameters"){
        const row=db.prepare("SELECT models_json FROM model_providers WHERE id=?").get(providerId)!;
        const models=JSON.parse(String(row.models_json));
        if(protocol==="openai")models[0].samplingParams={response_format:{type:"json_schema",json_schema:{name:"fixture",schema:{description:"x".repeat(2000),type:"object"}}}};
        else {models[0].reasoning=true;models[0].compat={forceAdaptiveThinking:true};models[0].thinkingLevelMap.high="h".repeat(2000);}
        db.prepare("UPDATE model_providers SET models_json=? WHERE id=?").run(JSON.stringify(models),providerId);
      }
      const source={id:"fixture",mailboxId:1,trust:"unconfirmed" as const,subject:"safe",text:"safe",fromAddresses:[],to:[],cc:[],date:0,bodyComplete:true};
      const tuple={providerId,modelId,modelConfigRevision:1,promptVersion:1,ruleVersion:1,schemaVersion:1};
      const input:TriageInput={source,authorizedSources:[source],cases:[],tasks:[],eligibleCaseIds:[],eligibleTaskIds:[],contextIncomplete:false,sourceVersion:1,contextVersion:"fixture",manualVersion:0,configEpoch:1,tuple};
      const content=variant==="unicode"?"安".repeat(87343):"x".repeat(variant==="protocol-parameters"?261000:protocol==="anthropic"&&variant==="envelope"?262030:262000);
      const context:Context={messages:[{role:"user",content,timestamp:0}]};
      const request={input,context,promptHash:fingerprintPrompt(context,tuple),maxOutputTokens:4096};
      const noNetwork:typeof fetch=async()=>{baseFetchCalls++;throw new Error("No network permitted");};
      await assert.rejects(completeTriageOnce(request,new AbortController().signal,{db,key,fetch:noNetwork}),{code:"input_too_large"});
      assert.equal(baseFetchCalls,0);
      // Production worker will reserve an attempt only after this succeeds. Rejection must occur here too.
      await assert.rejects(preflightTriageRequest(request,{db,key}),{code:"input_too_large",dispatched:false});
    }finally{db.close();}
  });
}
