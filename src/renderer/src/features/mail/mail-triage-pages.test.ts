import assert from "node:assert/strict";
import test, { before } from "node:test";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "vite";

type Node = { type: string | ((props: any) => unknown); props: Record<string, any> };
const entries = {
  panes: fileURLToPath(new URL("./mailbox-pane.tsx", import.meta.url)),
  review: fileURLToPath(new URL("./mail-review-page.tsx", import.meta.url)),
  settings: fileURLToPath(new URL("./mail-triage-settings-page.tsx", import.meta.url)),
};
const compiled = new Map<string, string>();

before(async () => {
  for (const [name, entry] of Object.entries(entries)) {
    const bundle = await build({
      configFile: false, envDir: false, logLevel: "silent", oxc: { jsx: { runtime: "automatic" } },
      build: { write: false, minify: false, lib: { entry, formats: ["cjs"] }, rolldownOptions: { external: id => !id.startsWith(".") && !id.replaceAll("\\", "/").includes("/features/mail/") } },
    });
    const result = Array.isArray(bundle) ? bundle[0] : bundle;
    if (!("output" in result)) throw new Error(`missing ${name} bundle`);
    compiled.set(name, result.output.find(output => output.type === "chunk")!.code);
  }
});

const walk = (value: any): Node[] => {
  if (Array.isArray(value)) return value.flatMap(walk);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const children = typeof value.type === "function" ? value.type(value.props) : value.props.children;
  return [value, ...walk(children)];
};
const text = (value: any): string => Array.isArray(value) ? value.map(text).join(" ") : value && typeof value === "object" && "props" in value ? text(value.props.children) : String(value ?? "");
type RpcState = { data?: unknown; loading?: boolean; refreshing?: boolean; error?: unknown; refresh?: () => Promise<void> };
const runtime = (name: string, rpc: (method: string, params: unknown) => unknown = () => undefined, rpcState?: (method: string, params: unknown) => RpcState) => {
  const exports: any = {}, components = new Proxy({}, { get: (_target, key) => String(key) });
  const hooks = { createElement: (type: Node["type"], props: Node["props"], ...children: unknown[]) => ({ type, props: { ...props, children: children.length <= 1 ? children[0] : children } }), useState: (value: any) => [typeof value === "function" ? value() : value, () => {}], useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn, useRef: (value: unknown) => ({ current: value }), useEffect: () => {} };
  new Script(compiled.get(name)!, { filename: `${name}.tsx` }).runInNewContext({ exports, crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000099" }, console, require(id: string) {
    if (id === "react") return hooks;
    if (id === "react/jsx-runtime") return { jsx: (type: Node["type"], props: Node["props"]) => ({ type, props }), jsxs: (type: Node["type"], props: Node["props"]) => ({ type, props }), Fragment: "Fragment" };
    if (id.includes("/lib/backend")) return { call: rpc, invalidateRpcData() {}, useRpcData(method: string, params: unknown) { return { data: rpc(method, params), loading: false, refreshing: false, error: null, refresh: async () => undefined, ...rpcState?.(method, params) }; } };
    if (id.includes("/components/feedback")) return { toast() {}, useConfirm: () => async () => true };
    if (id.includes("/lib/utils")) return { cn: (...items: unknown[]) => items.filter(Boolean).join(" ") };
    return components;
  } });
  return exports;
};

const interactiveRuntime = (name: string, rpc: (method: string, params: unknown) => unknown, rpcState?: (method: string, params: unknown) => RpcState) => {
  const exports: any = {}, components = new Proxy({}, { get: (_target, key) => String(key) });
  const state: any[] = [], toasts: unknown[][] = [];
  let cursor = 0;
  const hooks = {
    createElement: (type: Node["type"], props: Node["props"], ...children: unknown[]) => ({ type, props: { ...props, children: children.length <= 1 ? children[0] : children } }),
    useState(initial: any) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (next: any) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    },
    useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn, useRef: (value: unknown) => ({ current: value }), useEffect: () => {},
  };
  new Script(compiled.get(name)!, { filename: `${name}.tsx` }).runInNewContext({ exports, crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000099" }, console, require(id: string) {
    if (id === "react") return hooks;
    if (id === "react/jsx-runtime") return { jsx: (type: Node["type"], props: Node["props"]) => ({ type, props }), jsxs: (type: Node["type"], props: Node["props"]) => ({ type, props }), Fragment: "Fragment" };
    if (id.includes("/lib/backend")) return { call: rpc, invalidateRpcData() {}, useRpcData(method: string, params: unknown) { return { data: rpc(method, params), loading: false, refreshing: false, error: null, refresh: async () => undefined, ...rpcState?.(method, params) }; } };
    if (id.includes("/components/feedback")) return { toast(...args: unknown[]) { toasts.push(args); }, useConfirm: () => async () => true };
    if (id.includes("/lib/utils")) return { cn: (...items: unknown[]) => items.filter(Boolean).join(" ") };
    return components;
  } });
  return { exports, toasts, render(exportName: string, props: unknown = {}) { cursor = 0; return exports[exportName](props); } };
};

test("B11 layered mailbox pane groups domain then mailbox then folder and keeps management actions out", () => {
  const e = runtime("panes");
  const tree = e.MailboxPane({ mailboxes: [{ id: 1, domain: "example.test", address: "hello@example.test", unreadCount: 2, credentialSaved: true }], activeMailboxId: 1, folders: [{ name: "收件箱", path: "INBOX", total: 2, unread: 1 }], activeFolder: "INBOX", onSelectMailbox() {}, onSelectFolder() {} });
  assert.match(text(tree), /example\.test.*hello@example\.test.*收件箱/s);
  assert.equal(walk(tree).some(node => /删除|监听|密码/.test(text(node))), false);
});

test("B35/B40 settings distinguish unconfigured, paused budget and explicit future-mailbox exclusion", () => {
  const e = runtime("settings", method => method === "mail.triage.settings" ? { enabled: false, state: "blocked_config", configEpoch: 1, modelConfigRevision: 1, version: 0, mailboxIds: [], mode: "auto_suggest", modelBinding: null, dailyAttemptLimit: 500, consentProviderRevision: null, reminderEnabled: false, reminderSettings: { followUpDays: 7, leadDays: 1 }, autoNotifications: false } : method === "mail.list" ? [] : method === "models.providers" ? [] : null);
  const rendered = text(e.MailTriageSettingsPage());
  assert.match(rendered, /不会回退.*未配置/s);
  assert.match(rendered, /未来新增邮箱默认不授权/);
  assert.match(rendered, /200 封.*7 天.*30 天/s);
  const acknowledged=e.consentFingerprint(7,"dedicated",3,[9,2]);
  assert.equal(acknowledged,e.consentFingerprint(7,"dedicated",3,[2,9]));
  assert.notEqual(acknowledged,e.consentFingerprint(7,"dedicated",4,[2,9]),"provider revision change requires new acknowledgement");
  assert.notEqual(acknowledged,e.consentFingerprint(7,"dedicated",3,[2,9,11]),"scope expansion requires new acknowledgement");
});

test("B38/RF4 review evidence and raw text remain plain text with zero anchors or images", () => {
  const e = runtime("review", method => method === "mail.triage.reviewQueue" ? { items: [{ sourceId: "00000000-0000-4000-8000-000000000001", jobId: null, caseId: null, state: "needs_review", reason: "<img src=x> https://evil.test", updatedAt: 1, mailboxId: 1, mailboxAddress: "hello@example.test", mailDate: 1, sourceVersion: 1, manualVersion: 0, sourceState: "active", sourceTrust: "unconfirmed", tag: "待核对", summary: "https://evil.test", displayError: null, readerRef: null }], total: 1, page: 1, pageSize: 30 } : undefined);
  const tree = e.MailReviewPage({ filter: "review" });
  assert.equal(walk(tree).filter(node => node.type === "a").length, 0);
  assert.equal(walk(tree).filter(node => node.type === "img").length, 0);
  assert.match(text(tree), /https:\/\/evil\.test/);
});

test("R23 review page uses the registered production case-detail RPC", () => {
  const methods: string[] = [];
  const e = runtime("review", (method) => { methods.push(method); return method === "mail.triage.reviewQueue" ? { items: [], total: 0, page: 1, pageSize: 30 } : undefined; });
  e.MailReviewPage({ filter: "review" });
  assert.ok(methods.includes("mail.cases.detail"));
  assert.equal(methods.includes("mail.cases.get"), false);
});

test("Task15 Fix1 review handlers send real source and case CAS clocks with explicit reasons",async()=>{
  const calls:{method:string;input:any}[]=[],e=runtime("review");
  const invoke=async(method:string,input:unknown)=>{calls.push({method,input});return{};};
  await e.executeReviewMutation(invoke,"mail.triage.correct","逐封人工核对",{target:{type:"source",id:"00000000-0000-4000-8000-000000000001",sourceVersion:4},expectedVersion:7,field:"sourceTrust",value:"human_confirmed"});
  await e.executeReviewMutation(invoke,"mail.cases.link","人工选择关联",{caseId:"00000000-0000-4000-8000-000000000002",sourceIds:["00000000-0000-4000-8000-000000000001"],expectedVersion:9});
  await e.executeReviewMutation(invoke,"mail.cases.confirm","核对官方申请编号",{caseId:"00000000-0000-4000-8000-000000000002",expectedVersion:10,identity:{provider:"Provider",siteId:null,applicationId:"APP-1"}});
  assert.deepEqual(calls.map(item=>[item.method,item.input.expectedVersion]),[["mail.triage.correct",7],["mail.cases.link",9],["mail.cases.confirm",10]]);
  assert.equal(calls[0]!.input.reason,"逐封人工核对");
  await assert.rejects(()=>e.executeReviewMutation(invoke,"mail.triage.correct","   ",{}),/人工判断原因/);
});

test("Task15 Fix2 consecutive real source buttons use the mutation result clock",async()=>{
  const sourceId="00000000-0000-4000-8000-000000000001",calls:{method:string;input:any}[]=[];
  const row={sourceId,jobId:null,caseId:null,state:"needs_review",reason:"请核对",updatedAt:1,mailboxId:1,mailboxAddress:"hello@example.test",mailDate:1,sourceVersion:4,manualVersion:7,sourceState:"active",sourceTrust:"unconfirmed",tag:"旧标签",summary:"摘要",displayError:null,readerRef:null};
  const preview={sourceRef:{sourceId,sourceVersion:4,mailboxId:1,folder:"INBOX",uidValidity:"1",uid:1},readerRef:null,message:{mailboxId:1,folder:"INBOX",uid:1,messageId:"m1",from:"from@example.test",to:["hello@example.test"],cc:[],subject:"主题",date:1,text:"正文",html:null,attachments:[],seen:false},assessment:null,grade:"needs_review",displayError:null};
  const rpc=(method:string,input:any)=>{
    if(method==="mail.triage.reviewQueue")return{items:[row],total:1,page:1,pageSize:30};
    if(method==="mail.triage.sourcePreview")return preview;
    if(method==="mail.cases.list")return{items:[],total:0,page:1,pageSize:100,facets:{}};
    if(method==="mail.triage.correct"){calls.push({method,input});return{decisionId:"00000000-0000-4000-8000-000000000010",version:input.expectedVersion+1,before:{},after:{},affectedTaskIds:[],sourcesToVerify:[],affectedSourceIds:[sourceId],projectionBefore:[],projectionAfter:[]};}
    return null;
  };
  const app=interactiveRuntime("review",rpc);
  let tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="button"&&text(node).includes("hello@example.test"))!.props.onClick();
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.props?.["aria-label"]==="人工判断原因")!.props.onChange({target:{value:"逐封确认来源"}});
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="Button"&&text(node)==="确认本封来源")!.props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.props?.["aria-label"]==="人工判断原因")!.props.onChange({target:{value:"修正标签"}});
  walk(tree).find(node=>node.props?.["aria-label"]==="人工短标签")!.props.onChange({target:{value:"新标签"}});
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="Button"&&text(node)==="更正短标签")!.props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(item=>item.input.expectedVersion),[7,8]);
});

test("Task15 Fix3 A to B to A selection retains the authoritative source generation clock",async()=>{
  const sourceA="00000000-0000-4000-8000-000000000001",sourceB="00000000-0000-4000-8000-000000000002",calls:{method:string;input:any}[]=[];
  const row=(sourceId:string,address:string,manualVersion:number)=>({sourceId,jobId:null,caseId:null,state:"needs_review",reason:"请核对",updatedAt:1,mailboxId:1,mailboxAddress:address,mailDate:1,sourceVersion:4,manualVersion,sourceState:"active",sourceTrust:"unconfirmed",tag:"旧标签",summary:"摘要",displayError:null,readerRef:null});
  const rows=[row(sourceA,"a@example.test",7),row(sourceB,"b@example.test",3)];
  const preview=(sourceId:string)=>({sourceRef:{sourceId,sourceVersion:4,mailboxId:1,folder:"INBOX",uidValidity:"1",uid:1},readerRef:null,message:{mailboxId:1,folder:"INBOX",uid:1,messageId:sourceId,from:"from@example.test",to:["hello@example.test"],cc:[],subject:"主题",date:1,text:"正文",html:null,attachments:[],seen:false},assessment:null,grade:"needs_review",displayError:null});
  const rpc=(method:string,input:any)=>{
    if(method==="mail.triage.reviewQueue")return{items:rows,total:2,page:1,pageSize:30};
    if(method==="mail.triage.sourcePreview")return input?preview(input.sourceId):null;
    if(method==="mail.cases.list")return{items:[],total:0,page:1,pageSize:100,facets:{}};
    if(method==="mail.triage.correct"){calls.push({method,input});return{decisionId:"00000000-0000-4000-8000-000000000010",version:input.expectedVersion+1,before:{},after:{},affectedTaskIds:[],sourcesToVerify:[],affectedSourceIds:[input.target.id],projectionBefore:[],projectionAfter:[]};}
    return null;
  };
  const app=interactiveRuntime("review",rpc);
  let tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="button"&&text(node).includes("a@example.test"))!.props.onClick();
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.props?.["aria-label"]==="人工判断原因")!.props.onChange({target:{value:"确认 A 来源"}});
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="Button"&&text(node)==="确认本封来源")!.props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="button"&&text(node).includes("b@example.test"))!.props.onClick();
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="button"&&text(node).includes("a@example.test"))!.props.onClick();
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.props?.["aria-label"]==="人工判断原因")!.props.onChange({target:{value:"更正 A 标签"}});
  walk(tree).find(node=>node.props?.["aria-label"]==="人工短标签")!.props.onChange({target:{value:"新标签"}});
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="Button"&&text(node)==="更正短标签")!.props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(item=>[item.input.target.id,item.input.target.sourceVersion,item.input.expectedVersion]),[[sourceA,4,7],[sourceA,4,8]]);
});

test("Task15 Fix3 a delayed old generation mutation cannot alter the selected new generation",async()=>{
  const sourceId="00000000-0000-4000-8000-000000000001",calls:{method:string;input:any}[]=[],resolvers:((value:unknown)=>void)[]=[];
  let generation=4;
  const currentRow=()=>({sourceId,jobId:null,caseId:null,state:"needs_review",reason:"请核对",updatedAt:generation,mailboxId:1,mailboxAddress:"same@example.test",mailDate:1,sourceVersion:generation,manualVersion:generation===4?7:20,sourceState:"active",sourceTrust:"unconfirmed",tag:"旧标签",summary:"摘要",displayError:null,readerRef:null});
  const rpc=(method:string,input:any)=>{
    if(method==="mail.triage.reviewQueue")return{items:[currentRow()],total:1,page:1,pageSize:30};
    if(method==="mail.triage.sourcePreview")return{sourceRef:{sourceId,sourceVersion:generation,mailboxId:1,folder:"INBOX",uidValidity:String(generation),uid:1},readerRef:null,message:{mailboxId:1,folder:"INBOX",uid:1,messageId:`m${generation}`,from:"from@example.test",to:["same@example.test"],cc:[],subject:"主题",date:1,text:"正文",html:null,attachments:[],seen:false},assessment:null,grade:"needs_review",displayError:null};
    if(method==="mail.cases.list")return{items:[],total:0,page:1,pageSize:100,facets:{}};
    if(method==="mail.triage.correct"){calls.push({method,input});if(calls.length===1)return new Promise(resolve=>resolvers.push(resolve));return{decisionId:"00000000-0000-4000-8000-000000000011",version:input.expectedVersion+1,before:{},after:{},affectedTaskIds:[],sourcesToVerify:[],affectedSourceIds:[sourceId],projectionBefore:[],projectionAfter:[]};}
    return null;
  };
  const app=interactiveRuntime("review",rpc);
  let tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="button"&&text(node).includes("same@example.test"))!.props.onClick();
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.props?.["aria-label"]==="人工判断原因")!.props.onChange({target:{value:"旧代确认"}});
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="Button"&&text(node)==="确认本封来源")!.props.onClick();
  generation=5;
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="button"&&text(node).includes("same@example.test"))!.props.onClick();
  resolvers[0]!({decisionId:"00000000-0000-4000-8000-000000000010",version:8,before:{},after:{},affectedTaskIds:[],sourcesToVerify:[],affectedSourceIds:[sourceId],projectionBefore:[],projectionAfter:[]});
  await new Promise(resolve=>setImmediate(resolve));
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.props?.["aria-label"]==="人工判断原因")!.props.onChange({target:{value:"新代标签"}});
  walk(tree).find(node=>node.props?.["aria-label"]==="人工短标签")!.props.onChange({target:{value:"新代"}});
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="Button"&&text(node)==="更正短标签")!.props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(item=>[item.input.target.sourceVersion,item.input.expectedVersion]),[[4,7],[5,20]]);
});

test("Task15 Fix2 review failures are explicit retryable states and regions are labelled",async()=>{
  const sourceId="00000000-0000-4000-8000-000000000001",caseId="00000000-0000-4000-8000-000000000002";
  const row={sourceId,jobId:null,caseId:null,state:"needs_review",reason:"请核对",updatedAt:1,mailboxId:1,mailboxAddress:"hello@example.test",mailDate:1,sourceVersion:4,manualVersion:7,sourceState:"active",sourceTrust:"unconfirmed",tag:null,summary:null,displayError:null,readerRef:null};
  const preview={sourceRef:{sourceId,sourceVersion:4,mailboxId:1,folder:"INBOX",uidValidity:"1",uid:1},readerRef:null,message:{mailboxId:1,folder:"INBOX",uid:1,messageId:"m1",from:"from@example.test",to:["hello@example.test"],cc:[],subject:"主题",date:1,text:"正文",html:null,attachments:[],seen:false},assessment:{summary:"建议",tag:"核对",primaryCategory:"other",events:[],actions:[],completionSuggestions:[],uncertainties:[],sourceIds:[sourceId]},grade:"needs_review",displayError:null};
  const queueFailed=interactiveRuntime("review",()=>undefined,method=>method==="mail.triage.reviewQueue"?{error:new Error("queue failed"),refresh:async()=>{throw new Error("queue retry failed");}}:{data:undefined});
  let tree=queueFailed.render("MailReviewPage",{filter:"review"});
  assert.match(text(tree),/核对队列加载失败.*重试/s);
  assert.equal(walk(tree).some(node=>node.type==="Button"&&text(node)==="重试核对队列"),true);
  assert.doesNotMatch(text(tree),/这个队列当前为空/);
  assert.doesNotMatch(text(tree),/0\s*封邮件/);
  walk(tree).find(node=>node.type==="Button"&&text(node)==="重试核对队列")!.props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(String(queueFailed.toasts.at(-1)?.[0]),/核对队列.*失败/);
  assert.match(text(queueFailed.render("MailReviewPage",{filter:"review"})),/核对队列加载失败/);
  const app=interactiveRuntime("review",method=>method==="mail.triage.reviewQueue"?{items:[row],total:1,page:1,pageSize:30}:method==="mail.triage.sourcePreview"?preview:null,method=>method==="mail.cases.list"?{data:undefined,error:new Error("cases failed"),refresh:async()=>{throw new Error("cases retry failed");}} : {});
  tree=app.render("MailReviewPage",{filter:"review"});
  walk(tree).find(node=>node.type==="button"&&text(node).includes("hello@example.test"))!.props.onClick();
  tree=app.render("MailReviewPage",{filter:"review"});
  assert.match(text(tree),/申请列表加载失败.*重试/s);
  assert.equal(walk(tree).some(node=>node.type==="Button"&&text(node)==="重试申请列表"),true);
  walk(tree).find(node=>node.type==="Button"&&text(node)==="重试申请列表")!.props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(String(app.toasts.at(-1)?.[0]),/申请列表.*失败/);
  const previewApp=interactiveRuntime("review",method=>method==="mail.triage.reviewQueue"?{items:[row],total:1,page:1,pageSize:30}:null,method=>method==="mail.triage.sourcePreview"?{data:undefined,error:new Error("preview failed"),refresh:async()=>{throw new Error("preview retry failed");}} : {});
  let previewTree=previewApp.render("MailReviewPage",{filter:"review"});
  walk(previewTree).find(node=>node.type==="button"&&text(node).includes("hello@example.test"))!.props.onClick();
  previewTree=previewApp.render("MailReviewPage",{filter:"review"});
  assert.match(text(previewTree),/来源预览加载失败.*重试/s);
  assert.equal(walk(previewTree).some(node=>node.type==="Button"&&text(node)==="重试来源预览"),true);
  walk(previewTree).find(node=>node.type==="Button"&&text(node)==="重试来源预览")!.props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(String(previewApp.toasts.at(-1)?.[0]),/来源预览.*失败/);
  const linked={...row,caseId};
  const detailApp=interactiveRuntime("review",method=>method==="mail.triage.reviewQueue"?{items:[linked],total:1,page:1,pageSize:30}:method==="mail.triage.sourcePreview"?preview:null,method=>method==="mail.cases.detail"?{data:undefined,error:new Error("detail failed"),refresh:async()=>{throw new Error("detail retry failed");}} : {});
  let linkedTree=detailApp.render("MailReviewPage",{filter:"review"});
  walk(linkedTree).find(node=>node.type==="button"&&text(node).includes("hello@example.test"))!.props.onClick();
  linkedTree=detailApp.render("MailReviewPage",{filter:"review"});
  assert.match(text(linkedTree),/申请详情加载失败.*重试/s);
  assert.equal(walk(linkedTree).some(node=>node.type==="Button"&&text(node)==="重试申请详情"),true);
  walk(linkedTree).find(node=>node.type==="Button"&&text(node)==="重试申请详情")!.props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(String(detailApp.toasts.at(-1)?.[0]),/申请详情.*失败/);
  assert.equal(walk(tree).some(node=>node.props?.["aria-label"]==="核对证据"),true);
  assert.equal(walk(tree).some(node=>node.props?.["aria-label"]==="当前队列"),true);
  assert.equal(walk(tree).some(node=>node.props?.["aria-label"]==="核对队列"),true);
});
