import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setup, key } from "./testing.ts";
import { createProviderConfig, setRole } from "./models.ts";
import { registerCachedSource, fingerprintSource } from "./mail-triage-source.ts";
import type { ParsedSafeMessage } from "./mailbox-parser.ts";

const mod = () => import("./mail-triage-context.ts");
function fixture() {
  const { db } = setup({ cachedMailbox: { password: "fixture" } });
  const providerId = createProviderConfig(db,key,{name:"fixture",protocol:"openai",baseUrl:"http://127.0.0.1:1/v1",apiKey:"fake",models:[{id:"fixture",name:"fixture",contextWindow:128000,maxOutputTokens:8192,vision:false,thinkingLevels:["off"]}]});
  setRole(db,"mail_triage",{providerId,modelId:"fixture",thinking:"off"});
  db.exec("UPDATE mail_triage_settings SET enabled=1,state='enabled',consent_provider_revision=1; INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,effective_at) VALUES(1,1,'authorized','100',0)");
  const add = (uid:number,text:string,mailboxId=1) => {
    const mail:ParsedSafeMessage={messageId:`<${uid}@fixture>`,from:"Sender",fromAddresses:["sender@fixture.test"],to:["recipient@fixture.test"],cc:[],subject:"Documents",date:1,text,snippet:text,inReplyTo:null,references:[],attachments:[],bodyComplete:true,bodyIssue:null};
    db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,uid_validity,from_json,from_addresses_json,to_json,cc_json,subject,date,body_text,body_complete,message_id,references_json,attachments_json) VALUES(?,'INBOX',?,'100',?,?,?,?,?,?,?,?,?,'[]','[]')`).run(mailboxId,uid,JSON.stringify(mail.from),JSON.stringify(mail.fromAddresses),JSON.stringify(mail.to),"[]",mail.subject,1,text,1,mail.messageId);
    return registerCachedSource(db,{locator:{mailboxId,folder:"INBOX",uidValidity:"100",uid},mail,observedAt:1},key).sourceId;
  };
  return {db,add};
}

test("B14/B35 related unauthorized mail and derived case/task fields never enter authorized context",async()=>{
  const {buildTriageContext}=await mod(); const {db,add}=fixture();
  try {
    const a=add(1,"Authorized document request");
    db.exec("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,status) VALUES(2,1,'x','b','PRIVATE_B_SENTINEL@private.test','private.test','active')");
    const b=add(2,"PRIVATE_B_SENTINEL",2), caseId=randomUUID(), eventId=randomUUID(), taskId=randomUUID();
    const provenance=JSON.stringify({supportSourceIds:[b],kind:"source_derived",verifiedAt:null,reason:null});
    db.prepare("INSERT INTO mail_application_cases(id,provider,application_identity,identity_provenance_json,projection_json) VALUES(?,'PRIVATE_B_SENTINEL','PRIVATE_B_SENTINEL',?,?)").run(caseId,provenance,JSON.stringify({summary:"PRIVATE_B_SENTINEL"}));
    for(const id of [a,b]) db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'explicit')").run(caseId,id);
    db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'x','request',1,'[]',?)").run(eventId,caseId,b,provenance);
    db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,provenance_json) VALUES(?,?,?,'x','reply','x','PRIVATE_B_SENTINEL',?)").run(taskId,caseId,eventId,provenance);
    const input=buildTriageContext(db,key,a,1),payload=JSON.stringify(input);
    assert.equal(payload.includes("PRIVATE_B_SENTINEL"),false); assert.equal(input.contextIncomplete,true);
    assert.deepEqual(input.authorizedSources.map(s=>s.id),[a]); assert.deepEqual(input.eligibleTaskIds,[]);
    assert.equal(payload.includes("sourceHash"),false); assert.equal(payload.includes("source_hash"),false);
    let wire="";
    const server=createServer(async(req,res)=>{for await(const chunk of req)wire+=String(chunk);res.writeHead(200,{"content-type":"text/event-stream"});res.end(`data: ${JSON.stringify({id:"fixture",choices:[{index:0,delta:{role:"assistant",content:"{}"},finish_reason:"stop"}]})}\n\ndata: [DONE]\n\n`);});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    try{
      const port=(server.address() as {port:number}).port;db.prepare("UPDATE model_providers SET base_url=?").run(`http://127.0.0.1:${port}/v1`);
      const {fingerprintPrompt,completeTriageOnce}=await import("./mail-triage-model.ts");
      const context={messages:[{role:"user" as const,content:payload,timestamp:0}]};
      await completeTriageOnce({input,context,promptHash:fingerprintPrompt(context,input.tuple),maxOutputTokens:4096},new AbortController().signal,{db,key});
      assert.equal(wire.includes("PRIVATE_B_SENTINEL"),false);assert.ok(wire.includes("Authorized document request"));
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  } finally {db.close();}
});
test("B38 raw OTP fingerprints differ while redacted actual prompt fingerprints match",async()=>{
  const {redactTriageText}=await mod(); const {fingerprintPrompt}=await import("./mail-triage-model.ts");
  const tuple={providerId:1,modelId:"m",modelConfigRevision:1,promptVersion:1,ruleVersion:1,schemaVersion:1};
  const a=redactTriageText("Your code is 123456. password: secret1 token=abc https://mail.test/x?key=one#secret");
  const b=redactTriageText("Your code is 654321. password: secret2 token=def https://mail.test/x?key=two#other");
  assert.equal(a,b); assert.equal(a.includes("123456"),false); assert.equal(a.includes("secret1"),false);
  const mail:ParsedSafeMessage={messageId:"same",from:"Sender",fromAddresses:[],to:[],cc:[],subject:"Code",date:0,text:"Your code is 123456",snippet:"",inReplyTo:null,references:[],attachments:[],bodyComplete:true,bodyIssue:null};
  assert.notEqual(fingerprintSource(key,mail).sourceHash,fingerprintSource(key,{...mail,text:"Your code is 654321"}).sourceHash);
  assert.equal(fingerprintPrompt({messages:[{role:"user",content:a,timestamp:1}]},tuple),fingerprintPrompt({messages:[{role:"user",content:b,timestamp:1}]},tuple));
});
test("B55 current scope/generation, complete cache and source trust are authoritative; never truncate current body",async()=>{
  const {buildTriageContext}=await mod(); const {db,add}=fixture();
  try {
    const a=add(1,"Complete body"); db.prepare("UPDATE mail_triage_sources SET trust='human_confirmed' WHERE id=?").run(a);
    assert.equal(buildTriageContext(db,key,a,1).source.trust,"human_confirmed");
    const v=buildTriageContext(db,key,a,1).contextVersion;
    db.exec("UPDATE mail_triage_scope SET scope_version=scope_version+1"); assert.notEqual(buildTriageContext(db,key,a,1).contextVersion,v);
    db.exec("UPDATE mail_messages SET body_complete=0,body_issue='missing_body'");
    assert.equal(buildTriageContext(db,key,a,1).contextIncomplete,true);
    db.exec("UPDATE mail_messages SET body_complete=1,body_issue=NULL,body_text=replace(hex(zeroblob(16000)),'0','x')");
    assert.throws(()=>buildTriageContext(db,key,a,1),{code:"input_too_large"});
    db.exec("UPDATE mail_triage_scope SET epoch=2"); assert.throws(()=>buildTriageContext(db,key,a,1),{code:"stale_source"});
  }finally{db.close();}
});
test("R26 malformed persisted requested items fail with a typed integrity error",async()=>{
  const {buildTriageContext}=await mod();const {db,add}=fixture();
  try{
    const sourceId=add(1,"Authorized request"),caseId=randomUUID(),eventId=randomUUID(),taskId=randomUUID();
    const provenance=JSON.stringify({supportSourceIds:[sourceId],kind:"source_derived",verifiedAt:null,reason:null});
    db.prepare("INSERT INTO mail_application_cases(id,identity_provenance_json,projection_json) VALUES(?,?,'{}')").run(caseId,provenance);
    db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'fixture')").run(caseId,sourceId);
    db.prepare("INSERT INTO mail_case_events(id,case_id,source_id,event_slot,kind,observed_at,evidence_json,provenance_json) VALUES(?,?,?,'1:request','request_action',1,'[]',?)").run(eventId,caseId,sourceId,provenance);
    db.prepare("INSERT INTO mail_case_tasks(id,case_id,event_id,obligation_key,kind,object,title,requested_items_json,provenance_json) VALUES(?,?,?,'item','action','item','提交材料','{}',?)").run(taskId,caseId,eventId,provenance);
    assert.throws(()=>buildTriageContext(db,key,sourceId,1),{code:"context_integrity"});
  }finally{db.close();}
});
test("B35 unrelated cached bodies are not parsed; authorized related sources are capped and omission is explicit",async()=>{
  const {buildTriageContext}=await mod();const {db,add}=fixture();
  try{
    const a=add(1,"Authorized current body");add(99,"Unrelated body");
    // JSON valid but wrong metadata shape on an unrelated cache row must not contaminate this request.
    db.exec("UPDATE mail_messages SET references_json='{}' WHERE uid=99");
    assert.equal(buildTriageContext(db,key,a,1).contextIncomplete,false);
    const c=randomUUID();db.prepare("INSERT INTO mail_application_cases(id) VALUES(?)").run(c);
    for(const id of [a,...Array.from({length:9},(_,i)=>add(i+2,`Related document ${i}`))])db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'explicit')").run(c,id);
    const input=buildTriageContext(db,key,a,1);assert.equal(input.authorizedSources.length,8);assert.equal(input.contextIncomplete,true);
    assert.equal(JSON.stringify(input).includes("Unrelated body"),false);
  }finally{db.close();}
});
test("B35 context source support is all-of, manual notes stay local, and context budget never slices a body",async()=>{
  const {buildTriageContext}=await mod();const {db,add}=fixture();
  try{
    const a=add(1,"Current");const b=add(2,"y".repeat(20000));const c=add(3,"z".repeat(20000));const id=randomUUID();
    db.prepare("INSERT INTO mail_application_cases(id,provider,identity_provenance_json) VALUES(?,'Visible source identity',?)").run(id,JSON.stringify({supportSourceIds:[a],kind:"source_derived"}));
    for(const source of [a,b,c])db.prepare("INSERT INTO mail_case_sources(case_id,source_id,match_basis) VALUES(?,?,'explicit')").run(id,source);
    db.exec("UPDATE mail_triage_scope SET baseline_uid=100"); // Context consent is mailbox/epoch, not new-mail eligibility.
    const input=buildTriageContext(db,key,a,1);assert.equal(input.contextIncomplete,true);assert.equal(input.authorizedSources.length,2);assert.equal(input.authorizedSources[1]!.text.length,20000);assert.deepEqual(input.eligibleCaseIds,[id]);
    db.prepare("INSERT INTO mail_case_manual_decisions(id,case_id,actor,object_id,field,expected_version,applied_version,reason,before_json,after_json,provenance_json,created_at) VALUES(?,?,'human',?,'provider',0,1,'PRIVATE_NOTE','{}','{}','{}',1)").run(randomUUID(),id,id);
    const after=buildTriageContext(db,key,a,1);assert.equal(JSON.stringify(after).includes("PRIVATE_NOTE"),false);assert.equal(JSON.stringify(after).includes("Visible source identity"),false);assert.notEqual(after.contextVersion,input.contextVersion);
  }finally{db.close();}
});
