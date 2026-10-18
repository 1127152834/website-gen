import assert from "node:assert/strict";
import { before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { APPLICATION_DECISION_LABELS, type CaseProjection, type CaseSummary, type TaskView } from "../../../../shared/mail-triage-types.ts";
import { parseMailSourceSearch } from "./mail-source-search.ts";

const provenance = { supportSourceIds: ["00000000-0000-4000-8000-000000000001"], kind: "source_derived" as const, verifiedAt: null, reason: null };
const task = (id: string, kind: TaskView["kind"], state: TaskView["state"], title: string): TaskView => ({ id, kind, state, title, requestedItems: [], deadlineRaw: null, deadlineAt: null, provenance });
const projection: CaseProjection = { caseId: "00000000-0000-4000-8000-000000000010", version: 2, identityState: "confirmed", column: "needs_you", stage: "reviewing", decision: "pending", decisionCycle: 1, milestones: ["signature_completed"], tasks: [task("00000000-0000-4000-8000-000000000011", "reply", "open", "回复经营模式"), task("00000000-0000-4000-8000-000000000012", "action", "open", "上传银行账单")], sourceUnavailable: false, requiresReply: true, requiresAction: true, requiresReview: false };
const item: CaseSummary = { caseId: projection.caseId, version: 2, manualVersion: 0, identityState: "confirmed", column: "needs_you", provider: "Zen Payments", siteId: null, siteLabel: "carrbags.com", applicationId: "APP-14", mailboxAddress: "hello@carrbags.com", mailboxCount: 1, mailboxAddresses: ["hello@carrbags.com"], tag: "补件请求", openTaskCount: 2, nextStep: "回复经营模式", latestValidSummary: "平台拒绝申请，但允许补充说明后复审。", latestValidAt: 200, requiresReply: true, requiresAction: true, requiresReview: false };

const text = (value: unknown): string => {
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (typeof value === "object" && "props" in value) return text((value as { props: { children?: unknown } }).props.children);
  return "";
};

type Node = { type: string | ((props: any) => unknown); props: Record<string, any> };
const entry=fileURLToPath(new URL("./mail-board-page.tsx",import.meta.url));
let exportsUnderTest:any;
before(async()=>{
  const bundle=await build({configFile:false,envDir:false,logLevel:"silent",oxc:{jsx:{runtime:"automatic"}},build:{write:false,minify:false,lib:{entry,formats:["cjs"]},rolldownOptions:{external:(id)=>{
    const path=id.replaceAll("\\","/");
    return !(path.endsWith("/features/mail/mail-board-page.tsx")||path.endsWith("/features/mail/mail-case-card.tsx")||path.endsWith("/mail-case-card.tsx")||path.endsWith("/shared/mail-triage-types.ts"));
  }}}});
  const result=Array.isArray(bundle)?bundle[0]:bundle;if(!("output" in result))throw new Error("bundle missing");
  const compiled=result.output.find(output=>output.type==="chunk")!.code,exports:any={};
  const hooks={useState:(initial:any)=>[typeof initial==="function"?initial():initial,()=>{}],useMemo:(make:()=>unknown)=>make(),useEffect:()=>{}};
  const components=new Proxy({}, {get:(_target,name)=>String(name)});
  new Script(compiled,{filename:"mail-board-page.tsx"}).runInNewContext({exports,console,require(name:string){
    if(name==="react")return hooks;
    if(name==="react/jsx-runtime")return{jsx:(type:Node["type"],props:Node["props"])=>({type,props}),jsxs:(type:Node["type"],props:Node["props"])=>({type,props}),Fragment:"Fragment"};
    if(name.includes("@tanstack/react-router"))return{useNavigate:()=>()=>{}};
    if(name.includes("mail-triage-types"))return{APPLICATION_DECISION_LABELS};
    if(name.includes("/lib/backend"))return{useRpcData:(method:string)=>method==="mail.cases.list"?{data:{items:[item],total:1,page:1,pageSize:100,columnTotals:{needs_you:1,awaiting_platform:0,results:0},facets:{sites:["carrbags.com"],mailboxes:["hello@carrbags.com"],providers:["Zen Payments"]}},error:null,loading:false,refresh:async()=>undefined}:method==="mail.triage.status"?{data:{unlinkedMailCount:2,unreviewedMailCount:3,failedMailCount:1},error:null,loading:false,refresh:async()=>undefined}:{data:undefined,error:null,loading:false,refresh:async()=>undefined}};
    if(name.includes("/lib/utils"))return{cn:(...values:unknown[])=>values.filter(Boolean).join(" ")};
    if(name.includes("mail-case-drawer"))return{MailCaseDrawer:"MailCaseDrawer"};
    return components;
  }});
  exportsUnderTest=exports;
});

async function componentHarness(file: string, exportName: string, rpc: (method: string, params: unknown) => unknown) {
  const componentEntry=fileURLToPath(new URL(file,import.meta.url));
  const bundle=await build({configFile:false,envDir:false,logLevel:"silent",oxc:{jsx:{runtime:"automatic"}},build:{write:false,minify:false,lib:{entry:componentEntry,formats:["cjs"]},rolldownOptions:{external:()=>true}}});
  const result=Array.isArray(bundle)?bundle[0]:bundle;if(!("output" in result))throw new Error("component bundle missing");
  const compiled=result.output.find(output=>output.type==="chunk")!.code,exports:any={},slots:any[]=[];
  let cursor=0;
  const hooks={useState:(initial:any)=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initial==="function"?initial():initial;return[slots[index],(next:any)=>{slots[index]=typeof next==="function"?next(slots[index]):next;}];},useMemo:(make:()=>unknown)=>make()};
  const components=new Proxy({}, {get:(_target,name)=>String(name)});
  new Script(compiled,{filename:file}).runInNewContext({exports,console,crypto:{randomUUID},require(name:string){
    if(name==="react")return hooks;
    if(name==="react/jsx-runtime")return{jsx:(type:Node["type"],props:Node["props"])=>({type,props}),jsxs:(type:Node["type"],props:Node["props"])=>({type,props}),Fragment:"Fragment"};
    if(name.includes("@tanstack/react-router"))return{useNavigate:()=>()=>{}};
    if(name.includes("/lib/backend"))return{call:rpc,invalidateCurrentTriageViews:()=>undefined,useRpcData:(method:string,params:unknown)=>({data:rpc(method,params),error:null,loading:false,refresh:async()=>undefined})};
    return components;
  }});
  return {exports,render:(props:any)=>{cursor=0;return exports[exportName](props);}};
}

async function pagedBoardHarness(){
  const bundle=await build({configFile:false,envDir:false,logLevel:"silent",oxc:{jsx:{runtime:"automatic"}},build:{write:false,minify:false,lib:{entry,formats:["cjs"]},rolldownOptions:{external:(id)=>{const path=id.replaceAll("\\","/");return !(path.endsWith("/features/mail/mail-board-page.tsx")||path.endsWith("/features/mail/mail-case-card.tsx")||path.endsWith("/mail-case-card.tsx")||path.endsWith("/shared/mail-triage-types.ts"));}}}});
  const result=Array.isArray(bundle)?bundle[0]:bundle;if(!("output" in result))throw new Error("paged board bundle missing");const compiled=result.output.find(output=>output.type==="chunk")!.code,exports:any={},slots:any[]=[],calls:{method:string;params:any}[]=[];let cursor=0;
  const hooks={useState:(initial:any)=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==="function"?initial():initial;return[slots[i],(next:any)=>{slots[i]=typeof next==="function"?next(slots[i]):next;}];},useMemo:(make:()=>unknown)=>make(),useEffect:(effect:()=>void)=>effect()};
  const components=new Proxy({}, {get:(_target,name)=>String(name)});
  new Script(compiled).runInNewContext({exports,console,require(name:string){
    if(name==="react")return hooks;
    if(name==="react/jsx-runtime")return{jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props}),Fragment:"Fragment"};
    if(name.includes("@tanstack/react-router"))return{useNavigate:()=>()=>{}};
    if(name.includes("/lib/utils"))return{cn:(...values:any[])=>values.filter(Boolean).join(" ")};
    if(name.includes("mail-case-drawer"))return{MailCaseDrawer:"MailCaseDrawer"};
    if(name.includes("/lib/backend"))return{useRpcData:(method:string,params:any)=>{
      calls.push({method,params});
      if(method==="mail.cases.list")return{data:{items:params.page===1?[item]:[],total:101,page:params.page,pageSize:100,columnTotals:{needs_you:101,awaiting_platform:0,results:0},facets:{sites:["carrbags.com","later.example"],mailboxes:["hello@carrbags.com","later@example.test"],providers:["Zen Payments","Later Pay"]}},loading:false,error:null,refresh:async()=>undefined};
      if(method==="mail.triage.status")return{data:{unlinkedMailCount:31,unreviewedMailCount:0,failedMailCount:0},loading:false,error:null,refresh:async()=>undefined};
      if(method==="mail.triage.reviewQueue")return params?{data:{items:params.page===1?[{sourceId:provenance.supportSourceIds[0],jobId:null,caseId:null,state:"unreviewed",reason:null,updatedAt:1}]:[],total:31,page:params.page,pageSize:30},loading:false,error:null,refresh:async()=>undefined}:{data:undefined,loading:false,error:null,refresh:async()=>undefined};
      return{data:undefined,loading:false,error:null,refresh:async()=>undefined};
    }};
    return components;
  }});
  return{calls,render:()=>{cursor=0;return exports.MailBoardPage({});}};
}

const walk=(value:any):Node[]=>{if(Array.isArray(value))return value.flatMap(walk);if(!value||typeof value!=="object"||!("props" in value))return[];const children=typeof value.type==="function"&&value.props.item&&value.props.onOpen?value.type(value.props):value.props.children;return[value,...walk(children)];};

test("B01/B04/B05 fixed three-column contract and truthful milestone semantics", () => {
  assert.deepEqual(Array.from(exportsUnderTest.boardColumns,(column:any)=>column.title), ["需要你处理", "等待平台", "结果回执"]);
  assert.equal(exportsUnderTest.signedMailClaimsApproval(projection), false);
  const rendered=text(exportsUnderTest.MailBoardPage({}));
  for(const expected of ["需要你处理","等待平台","结果回执","待确认\\s+2","未预审\\s+3","失败\\s+1"])assert.match(rendered,new RegExp(expected));
});

test("B18-B20/B45-B49 card renders authorized context without drag or whole-case approval", () => {
  const node = walk(exportsUnderTest.MailBoardPage({})).find(node=>node.props["aria-label"]===`打开申请 ${item.siteLabel}`)!;
  assert.ok(node,JSON.stringify(walk(exportsUnderTest.MailBoardPage({})).map(entry=>({type:typeof entry.type==="function"?entry.type.name:entry.type,keys:Object.keys(entry.props)}))));
  const rendered = text(node);
  for (const expected of ["carrbags.com", "Zen Payments", "APP-14", "补件请求", "2\\s+项待办", "回复经营模式", "hello@carrbags.com"]) assert.match(rendered, new RegExp(expected));
  assert.equal((node.props as { draggable?: boolean }).draggable, undefined);
  assert.equal(rendered.includes("标记整项获批"), false);
});

test("B12/B26/B42/B50/B51 partial outcomes and unavailable source stay explicit", () => {
  assert.deepEqual(Array.from(exportsUnderTest.outcomeRemainingTasks(projection.tasks, [projection.tasks[0]!.id]),(entry:any)=>entry.title), ["上传银行账单"]);
  const boardNodes=walk(exportsUnderTest.MailBoardPage({}));
  assert.equal(boardNodes.some(node=>node.props.draggable===true),false);
  assert.equal(text(boardNodes).includes("标记整项获批"),false);
  assert.deepEqual(parseMailSourceSearch({}),{});
  assert.throws(()=>parseMailSourceSearch({caseId:projection.caseId}),/不完整/);
  assert.equal(parseMailSourceSearch({caseId:projection.caseId,sourceId:provenance.supportSourceIds[0],sourceVersion:1,uidValidity:"14"}).sourceVersion,1);
});

test("B12/B26 outcome component submits one concrete task with case CAS and surfaces refresh on conflict",async()=>{
  const calls:{method:string;params:any}[]=[],h=await componentHarness("./mail-task-outcome-dialog.tsx","MailTaskOutcomeDialog",(method,params)=>{calls.push({method,params});return Promise.reject(new Error("version_conflict"));});
  let conflicts=0,tree=h.render({caseId:projection.caseId,tasks:projection.tasks,expectedVersion:projection.version,onConflict:()=>{conflicts++;}}),nodes=walk(tree);
  const checks=nodes.filter(node=>node.props.type==="checkbox");checks[1]!.props.onChange({target:{checked:true}});
  tree=h.render({caseId:projection.caseId,tasks:projection.tasks,expectedVersion:projection.version,onConflict:()=>{conflicts++;}});nodes=walk(tree);
  nodes.find(node=>node.props.id==="task-reason")!.props.onChange({target:{value:"已按原文完成材料上传"}});
  tree=h.render({caseId:projection.caseId,tasks:projection.tasks,expectedVersion:projection.version,onConflict:()=>{conflicts++;}});nodes=walk(tree);
  nodes.find(node=>text(node)==="保存具体结果")!.props.onClick();for(let turn=0;turn<10;turn++)await Promise.resolve();
  tree=h.render({caseId:projection.caseId,tasks:projection.tasks,expectedVersion:projection.version,onConflict:()=>{conflicts++;}});
  assert.equal(calls[0]!.method,"mail.tasks.recordOutcome");assert.equal(calls[0]!.params.expectedVersion,projection.version);assert.deepEqual(Array.from(calls[0]!.params.taskIds),[projection.tasks[1]!.id]);
  assert.equal(conflicts,1);assert.match(text(tree),/申请已被其他操作更新/);
});

test("B26 correction component sends source generation plus manual CAS and surfaces conflict",async()=>{
  const source={sourceId:provenance.supportSourceIds[0],sourceVersion:4,manualVersion:7,sourceState:"active",sourceTrust:"confirmed",mailboxId:1,mailboxAddress:"hello@carrbags.com",observedAt:200,mailDate:190,tag:"补件请求",summary:null,readerRef:null},calls:{method:string;params:any}[]=[],h=await componentHarness("./mail-case-correction-dialog.tsx","MailCaseCorrectionDialog",(method,params)=>{calls.push({method,params});return Promise.reject(new Error("source_version_conflict"));});
  let conflicts=0,tree=h.render({source,onConflict:()=>{conflicts++;}}),nodes=walk(tree);
  nodes.find(node=>node.props.id==="correction-reason")!.props.onChange({target:{value:"按来源原文重新核对"}});
  tree=h.render({source,onConflict:()=>{conflicts++;}});nodes=walk(tree);nodes.find(node=>text(node)==="保存更正")!.props.onClick();for(let turn=0;turn<10;turn++)await Promise.resolve();
  tree=h.render({source,onConflict:()=>{conflicts++;}});
  assert.equal(calls[0]!.method,"mail.triage.correct");assert.equal(calls[0]!.params.expectedVersion,source.manualVersion);assert.equal(calls[0]!.params.target.sourceVersion,source.sourceVersion);
  assert.equal(conflicts,1);assert.match(text(tree),/来源已变化/);
});

test("Fix1 zero-item actions omit completedItems while itemized actions require a concrete subset",async()=>{
  const zeroCalls:any[]=[],zero=await componentHarness("./mail-task-outcome-dialog.tsx","MailTaskOutcomeDialog",(_method,params)=>{zeroCalls.push(params);return Promise.resolve({});});
  let tree=zero.render({caseId:projection.caseId,tasks:[projection.tasks[1]],expectedVersion:2}),nodes=walk(tree);nodes.find(node=>node.props.type==="checkbox")!.props.onChange({target:{checked:true}});tree=zero.render({caseId:projection.caseId,tasks:[projection.tasks[1]],expectedVersion:2});nodes=walk(tree);nodes.find(node=>node.props.id==="task-reason")!.props.onChange({target:{value:"操作已完成"}});tree=zero.render({caseId:projection.caseId,tasks:[projection.tasks[1]],expectedVersion:2});walk(tree).find(node=>text(node)==="保存具体结果")!.props.onClick();for(let i=0;i<8;i++)await Promise.resolve();assert.equal("completedItems" in zeroCalls[0],false);
  const itemized={...projection.tasks[1],requestedItems:["银行账单","公司证明"]},subsetCalls:any[]=[],subset=await componentHarness("./mail-task-outcome-dialog.tsx","MailTaskOutcomeDialog",(_method,params)=>{subsetCalls.push(params);return Promise.resolve({});});
  tree=subset.render({caseId:projection.caseId,tasks:[itemized],expectedVersion:2});nodes=walk(tree);nodes.find(node=>node.props.type==="checkbox")!.props.onChange({target:{checked:true}});tree=subset.render({caseId:projection.caseId,tasks:[itemized],expectedVersion:2});nodes=walk(tree);nodes.find(node=>node.props.id==="task-reason")!.props.onChange({target:{value:"完成一项"}});tree=subset.render({caseId:projection.caseId,tasks:[itemized],expectedVersion:2});walk(tree).find(node=>text(node)==="保存具体结果")!.props.onClick();for(let i=0;i<8;i++)await Promise.resolve();tree=subset.render({caseId:projection.caseId,tasks:[itemized],expectedVersion:2});assert.equal(subsetCalls.length,0);assert.match(text(tree),/至少一项材料/);
  nodes=walk(tree);nodes.filter(node=>node.props.type==="checkbox")[1]!.props.onChange({target:{checked:true}});tree=subset.render({caseId:projection.caseId,tasks:[itemized],expectedVersion:2});walk(tree).find(node=>text(node)==="保存具体结果")!.props.onClick();for(let i=0;i<8;i++)await Promise.resolve();assert.deepEqual(Array.from(subsetCalls[0].completedItems),["银行账单"]);
});

test("Fix1 reply handoff chooses only a currently readable supporting source",async()=>{
  const h=await componentHarness("./mail-case-drawer.tsx","MailCaseDrawer",()=>undefined),taskWithSecond={...projection.tasks[0],provenance:{...provenance,supportSourceIds:["00000000-0000-4000-8000-000000000002"]}},firstRef={caseId:projection.caseId,sourceId:provenance.supportSourceIds[0],sourceVersion:1,mailboxId:1,folder:"INBOX",uidValidity:"1",uid:1},secondRef={...firstRef,sourceId:"00000000-0000-4000-8000-000000000002",uid:2};
  const sources=[{sourceId:firstRef.sourceId,readerRef:firstRef},{sourceId:secondRef.sourceId,readerRef:secondRef}];
  assert.deepEqual(h.exports.readerRefForTask(taskWithSecond,sources),secondRef);
  assert.equal(h.exports.readerRefForTask(taskWithSecond,[sources[0],{sourceId:secondRef.sourceId,readerRef:null}]),null);
});

test("Fix1 drawer renders distinct current/history cycles and task-bound handoff capability",async()=>{
  const firstRef={caseId:projection.caseId,sourceId:provenance.supportSourceIds[0],sourceVersion:1,mailboxId:1,folder:"INBOX",uidValidity:"1",uid:1},secondRef={...firstRef,sourceId:"00000000-0000-4000-8000-000000000002",uid:2},reply={...projection.tasks[0],provenance:{...provenance,supportSourceIds:[secondRef.sourceId]}},source=(ref:any)=>({sourceId:ref.sourceId,sourceVersion:1,manualVersion:0,sourceState:"active",sourceTrust:"human_confirmed",mailboxId:1,mailboxAddress:"hello@carrbags.com",observedAt:2,mailDate:1,tag:null,summary:null,readerRef:ref});
  const detail={...item,projection:{...projection,tasks:[reply]},sourceIds:[firstRef.sourceId,secondRef.sourceId],sources:[source(firstRef),source(secondRef)],timeline:[],evidence:[],manualRecords:[],currentCycle:{cycle:2,decision:"pending",explanation:"复审中",current:true},historicalCycles:[{cycle:1,decision:"declined",explanation:"申请被拒",current:false}]};
  const h=await componentHarness("./mail-case-drawer.tsx","MailCaseDrawer",(method)=>method==="mail.cases.detail"?detail:undefined),tree=h.render({caseId:projection.caseId,onClose:()=>{}}),rendered=text(tree),handoff=walk(tree).find(node=>node.props["data-compose-handoff"]);
  assert.match(rendered,/当前第\s+2\s+周期.*复审中/);assert.match(rendered,/历史第\s+1\s+周期.*申请被拒/);assert.doesNotMatch(rendered,/\b(?:pending|unknown|declined)\b/);assert.equal(JSON.parse(handoff!.props["data-compose-handoff"]).readerRef.sourceId,secondRef.sourceId);
});

test("Fix1 board and review entry issue real page-2 RPCs beyond 100 and 30 rows",async()=>{
  const h=await pagedBoardHarness();let tree=h.render(),nodes=walk(tree);nodes.find(node=>text(node).startsWith("加载更多申请"))!.props.onClick();tree=h.render();assert.equal(h.calls.filter(call=>call.method==="mail.cases.list").at(-1)!.params.page,2);
  nodes=walk(tree);nodes.find(node=>node.props["aria-pressed"]===false)!.props.onClick();tree=h.render();nodes=walk(tree);nodes.find(node=>typeof node.props.onClick==="function"&&text(node).includes("加载更多待核对邮件"))!.props.onClick();h.render();assert.equal(h.calls.filter(call=>call.method==="mail.triage.reviewQueue"&&call.params).at(-1)!.params.page,2);
});

