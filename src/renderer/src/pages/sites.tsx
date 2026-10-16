import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CircleAlert, CircleCheck, Clock, ExternalLink, LoaderCircle, MessageSquarePlus, RefreshCw, Rocket, RotateCcw, Send, Square, Wrench } from "lucide-react";
import { PROVISION_STEPS, type ChangeSummary, type ChatEvent, type ChatItem, type MailStatus, type QaView, type RunEvent, type SiteProgress, type SiteStatus, type SmtpStatus, type StepState } from "../../../shared/protocol.ts";
import { toast, useConfirm } from "@/components/feedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { call, onChanged, onChat, onConnect, onEvent } from "@/lib/backend.ts";
import { cn } from "@/lib/utils";
import { LogViewer, StepTimeline } from "./site-operations.tsx";
import { QaReport } from "./qa-report.tsx";
import { AbandonSiteButton } from "@/components/abandon-site.tsx";

const TOOL_TEXT: Record<string, string> = {
  get_site: "查看站点概况", get_copy: "读取文案", get_policy: "读取政策页", list_products: "查看商品列表", get_product: "读取商品", list_changes: "查看变更记录",
  update_copy: "修改文案", update_policy: "修改政策页", update_announcement: "修改公告栏", update_style: "切换风格", update_product: "修改商品", revert_change: "回滚变更", schedule_revert: "设置定时恢复",
};
const INITIATOR = { pi: "pi", you: "你", schedule: "定时恢复" } as const;
const SUGGESTIONS = ["把顶部公告改成冬季上新的提示，12 月 1 日恢复", "首页大标题写得更有温度一点", "把 FAQ 里关于退货的回答写得更清楚"];
const TABS = [{ key: "overview", label: "概况" }, { key: "chat", label: "对话" }, { key: "mail", label: "邮箱" }, { key: "changes", label: "变更记录" }, { key: "qa", label: "复核报告" }] as const;
type SiteTab = (typeof TABS)[number]["key"];
const dateTime = (timestamp: number) => new Date(timestamp).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const TOTAL = PROVISION_STEPS.length;
const STATUS: Record<SiteStatus, { text: string; variant: "default" | "secondary" | "outline" | "destructive"; className?: string }> = {
  queued: { text: "排队中", variant: "outline" }, running: { text: "进行中", variant: "default", className: "status-running" },
  waiting: { text: "待外部服务", variant: "outline", className: "status-waiting" }, done: { text: "已完成", variant: "secondary", className: "status-done" }, failed: { text: "失败", variant: "destructive", className: "status-failed" },
  abandoned: { text: "已放弃", variant: "outline" },
};

function unresolvedQa(qa: QaView | null): string[] {
  if (!qa) return ["未找到 QA 报告"];
  return [
    ...qa.checks.filter((check) => !check.ok).map((check) => `${check.name}：${check.detail}`),
    ...(qa.review?.issues.filter((issue) => issue.status !== "fixed").map((issue) => `${issue.level} ${issue.page}：${issue.status === "needs_you" ? "待你补充" : "待处理"}`) ?? []),
  ];
}

function siteBadge(site: SiteProgress) {
  if (site.status === "abandoned") return <Badge variant="outline">已放弃</Badge>;
  if (site.launchedAt) return <Badge variant="secondary" className="status-launched">已上线</Badge>;
  const value = STATUS[site.status];
  return <Badge variant={value.variant} className={value.className}>{value.text}</Badge>;
}

function toolOutcome(result: string): string {
  try { const value = JSON.parse(result) as { ok?: boolean; note?: string; problems?: string[]; error?: string }; return value.ok === false ? value.error ?? (value.problems ?? []).join("; ") : value.note ?? ""; }
  catch { return ""; }
}
const rich = (text: string) => text.split(/(\*\*[^*\n]+\*\*)/g).map((part, index) => part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={index}>{part.slice(2, -2)}</strong> : part);
type Live = { text: string; thinking: string; tools: Extract<ChatItem, { role: "tool" }>[] };
const emptyLive = (): Live => ({ text: "", thinking: "", tools: [] });

function ToolLine({ item }: { item: Extract<ChatItem, { role: "tool" }> }) {
  const outcome = item.ok === null ? "" : toolOutcome(item.result);
  return <div className="flex items-start gap-2 text-xs text-muted-foreground">{item.ok === null ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden /> : item.ok ? <Wrench className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />}<span>{TOOL_TEXT[item.name] ?? item.name}{outcome && <span className={cn("ml-1", item.ok === false && "text-amber-700 dark:text-amber-400")}>：{outcome}</span>}</span></div>;
}
function Message({ item }: { item: ChatItem }) {
  if (item.role === "user") return <div className="ml-auto max-w-[88%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">{item.text}</div>;
  if (item.role === "tool") return <ToolLine item={item} />;
  return <div className="max-w-[94%] text-sm">{item.thinking && <details className="mb-1 text-xs text-muted-foreground"><summary className="cursor-pointer select-none">思考过程</summary><p className="mt-1 whitespace-pre-wrap">{item.thinking}</p></details>}{item.text && <p className="whitespace-pre-wrap">{rich(item.text)}</p>}{item.error && <p role="alert" className="text-destructive">模型出错：{item.error}</p>}</div>;
}

type SitesPageProps = { siteId?: number; tab?: string; onNavigate?: (path: string) => void };

export function SitesPage({ siteId, tab, onNavigate }: SitesPageProps) {
  const [sites, setSites] = useState<SiteProgress[] | null>(null);
  const [history, setHistory] = useState<SiteProgress[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => void call<SiteProgress[]>("sites.all").then(setSites, (reason: Error) => setError(reason.message)), []);
  const loadHistory = useCallback(() => void call<SiteProgress[]>("sites.history").then(setHistory, (reason: Error) => setError(reason.message)), []);
  useEffect(() => { const off = [onConnect(load), onChanged("batches", load)]; return () => off.forEach((dispose) => dispose()); }, [load]);

  const navigate = (path: string) => {
    if (onNavigate) onNavigate(path);
    else { window.history.pushState(null, "", path); window.dispatchEvent(new PopStateEvent("popstate")); }
  };
  if (siteId != null) return <SiteDetail key={siteId} siteId={siteId} tab={(TABS.some((item) => item.key === tab) ? tab : "overview") as SiteTab} onNavigate={navigate} />;
  if (sites === null) return <div className="space-y-6"><header><h1 className="text-2xl font-semibold tracking-tight">站点</h1><p className="mt-1 text-sm text-muted-foreground">管理全部站点，包括进行中、失败和已上线的站点。</p></header>{error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"><p>{error}</p><Button variant="outline" size="sm" className="mt-3" onClick={load}>重新加载</Button></div>}<div className="h-64 animate-pulse rounded-lg bg-muted" /></div>;
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">站点</h1><p className="mt-1 text-sm text-muted-foreground">管理全部站点，包括进行中、失败和已上线的站点。</p></div><Button variant="outline" size="sm" onClick={() => { const next = !showHistory; setShowHistory(next); if (next && history === null) loadHistory(); }}>{showHistory ? "隐藏已放弃历史" : "查看已放弃历史"}</Button></header>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {sites.length === 0 ? <div className="rounded-lg border border-dashed p-8 text-center text-sm"><p className="font-medium">还没有站点</p><p className="mt-1 text-muted-foreground">先从「建站」创建一个批次。站点进入队列后就会出现在这里。</p></div> : <div className="overflow-x-auto rounded-lg border bg-card"><Table aria-label="全部站点"><TableHeader><TableRow><TableHead>域名</TableHead><TableHead>状态</TableHead><TableHead className="min-w-48">进度</TableHead><TableHead className="min-w-56">当前步骤</TableHead><TableHead>最近更新</TableHead></TableRow></TableHeader><TableBody>{sites.map((site) => <TableRow key={site.id} className="cursor-pointer" tabIndex={0} onClick={() => navigate(`/sites/${site.id}/overview`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`/sites/${site.id}/overview`); } }}><TableCell className="font-medium">{site.domain}</TableCell><TableCell>{siteBadge(site)}</TableCell><TableCell><div className="flex items-center gap-2"><div className="h-1.5 flex-1 rounded-full bg-muted"><div className={cn("h-full rounded-full", site.status === "failed" ? "bg-destructive" : site.status === "waiting" ? "bg-amber-500" : "bg-primary")} style={{ width: `${Math.min(100, (site.completed / TOTAL) * 100)}%` }} /></div><span className="text-xs text-muted-foreground tabular-nums">{site.completed}/{TOTAL}</span></div></TableCell><TableCell className="whitespace-normal">{site.launchedAt ? "站点已上线" : site.status === "done" ? "等待检查并上线" : site.currentStep ?? "—"}{site.lastError && <span className="mt-1 block max-w-md text-xs text-destructive">{site.lastError}</span>}</TableCell><TableCell className="text-muted-foreground tabular-nums">{dateTime(site.updatedAt)}</TableCell></TableRow>)}</TableBody></Table></div>}
      {showHistory && <section aria-label="已放弃站点历史"><h2 className="mb-3 text-sm font-medium">已放弃历史</h2>{history === null ? <p className="text-sm text-muted-foreground">正在读取…</p> : history.length === 0 ? <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">还没有已放弃的站点。</p> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>域名</TableHead><TableHead>状态</TableHead><TableHead>最近更新</TableHead></TableRow></TableHeader><TableBody>{history.map((site) => <TableRow key={site.id} className="cursor-pointer" tabIndex={0} onClick={() => navigate(`/sites/${site.id}/overview`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`/sites/${site.id}/overview`); } }}><TableCell className="font-medium">{site.domain}</TableCell><TableCell>{siteBadge(site)}</TableCell><TableCell className="text-muted-foreground">{dateTime(site.updatedAt)}</TableCell></TableRow>)}</TableBody></Table></div>}</section>}
    </div>
  );
}

function SiteDetail({ siteId, tab, onNavigate }: { siteId: number; tab: SiteTab; onNavigate: (path: string) => void }) {
  const confirm = useConfirm();
  const [site, setSite] = useState<SiteProgress | null | undefined>(undefined);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [qa, setQa] = useState<QaView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((reason: Error) => setError(reason.message), []);
  const load = useCallback(() => {
    void call<SiteProgress | null>("sites.get", { siteId }).then(setSite, fail);
    void call<StepState[]>("sites.steps", { siteId }).then(setSteps, fail);
    void call<RunEvent[]>("sites.events", { siteId }).then(setEvents, fail);
    void call<QaView | null>("sites.qa", { siteId }).then(setQa, fail);
  }, [fail, siteId]);
  useEffect(() => {
    const off = [onConnect(load), onChanged("batches", load), onEvent((event) => {
      if (event.siteId !== String(siteId)) return;
      setEvents((current) => current.some((item) => item.seq === event.seq) ? current : [...current, event]);
      if (event.kind === "step") load();
    })];
    return () => off.forEach((dispose) => dispose());
  }, [load, siteId]);

  const retry = async () => {
    if (!site || !await confirm({ title: `重试 ${site.domain}？`, description: "将从失败步骤继续执行并再次调用外部服务。", confirmText: "重试" })) return;
    setBusy(true); setError(null);
    try { await call("sites.retry", { siteId }); toast("已重新加入执行队列", "success"); load(); }
    catch (reason) { fail(reason as Error); toast((reason as Error).message, "error"); }
    finally { setBusy(false); }
  };
  const launch = async () => {
    if (!site) return;
    let warnings: string[] = [];
    try { warnings = unresolvedQa(await call<QaView | null>("sites.qa", { siteId })); }
    catch (reason) { fail(reason as Error); toast("无法读取最新 QA 报告，已取消上线", "error"); return; }
    const warningText = warnings.length > 0 ? ` 尚有 ${warnings.length} 项未解决：${warnings.slice(0, 3).join("；")}${warnings.length > 3 ? "；…" : ""}。` : " 当前 QA 没有未解决项。";
    if (!await confirm({ title: `上线 ${site.domain}？`, description: `将关闭维护模式和“即将上线”页面，并允许搜索引擎收录。访客之后可以浏览和下单。${warningText}`, confirmText: warnings.length > 0 ? "仍然上线" : "确认上线" })) return;
    setBusy(true); setError(null);
    try { const result = await call<{ detail: string }>("sites.launch", { siteId }); toast(result.detail, "success"); load(); }
    catch (reason) { fail(reason as Error); toast((reason as Error).message, "error"); }
    finally { setBusy(false); }
  };

  if (site === undefined) return <div className="space-y-5">{error ? <div role="alert" className="space-y-3 text-sm text-destructive"><p>{error}</p><Button variant="outline" onClick={load}>重新加载</Button></div> : <><div className="h-16 motion-safe:animate-pulse rounded-lg bg-muted" /><div className="h-80 motion-safe:animate-pulse rounded-lg bg-muted" /></>}</div>;
  if (site === null) return <div className="rounded-lg border border-dashed p-8 text-center text-sm"><p className="font-medium">找不到这个站点</p><p className="mt-1 text-muted-foreground">它可能已被移除，或当前账户没有权限查看。</p><Button variant="outline" className="mt-4" onClick={() => onNavigate("/sites")}>返回站点列表</Button></div>;
  return (
    <div className="space-y-6">
      <nav aria-label="面包屑" className="text-sm text-muted-foreground"><button type="button" className="outline-none hover:text-foreground focus-visible:underline" onClick={() => onNavigate("/sites")}>站点</button><span className="mx-2">/</span><span className="text-foreground">{site.domain}</span></nav>
      <header className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight">{site.domain}</h1>{siteBadge(site)}</div><p className="mt-1 text-sm text-muted-foreground tabular-nums">批次 {site.batchId} · 最近更新 {dateTime(site.updatedAt)}</p></div>{site.status !== "abandoned" ? <div className="flex flex-wrap gap-2">{site.status === "failed" && <Button variant="outline" disabled={busy} onClick={() => void retry()}>{busy ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}重试</Button>}{site.status === "done" && !site.launchedAt && <Button disabled={busy} onClick={() => void launch()}><Rocket aria-hidden />上线</Button>}<Button variant="outline" asChild><a href={`https://${site.domain}/`} target="_blank" rel="noreferrer">打开网站<ExternalLink aria-hidden /></a></Button><AbandonSiteButton domain={site.domain} siteId={siteId} onDone={() => onNavigate("/sites")} /></div> : <AbandonSiteButton domain={site.domain} siteId={siteId} statusOnly />}</header>
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}
      {site.status === "abandoned" && <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">此站点已放弃。这里只保留执行时间线、日志、变更和 QA 历史，不再提供上线、重试、邮箱或对话修改。</p>}
      <nav aria-label="站点详情" className="-mx-1 flex overflow-x-auto border-b px-1">{TABS.filter((item) => site.status !== "abandoned" || (item.key !== "chat" && item.key !== "mail")).map((item) => <button key={item.key} type="button" aria-current={tab === item.key ? "page" : undefined} onClick={() => onNavigate(`/sites/${siteId}/${item.key}`)} className={cn("shrink-0 border-b-2 px-4 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", tab === item.key ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{item.label}</button>)}</nav>
      {(tab === "overview" || (site.status === "abandoned" && (tab === "chat" || tab === "mail"))) && <div className="grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]"><section><h2 className="mb-3 text-sm font-medium">步骤时间线</h2><StepTimeline steps={steps} /></section><LogViewer events={events} /></div>}
      {tab === "chat" && site.status !== "abandoned" && <ChatPanel siteId={siteId} domain={site.domain} />}
      {tab === "mail" && site.status !== "abandoned" && <MailPanel siteId={siteId} />}
      {tab === "changes" && <ChangesPanel siteId={siteId} />}
      {tab === "qa" && <QaReport siteId={siteId} qa={qa} onRefresh={load} />}
    </div>
  );
}

function ChatPanel({ siteId, domain }: { siteId: number; domain: string }) {
  const confirm = useConfirm();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const load = useCallback(() => void call<{ items: ChatItem[]; busy: boolean }>("chat.history", { siteId }).then((history) => { setItems(history.items); setLive((current) => history.busy ? current ?? emptyLive() : null); }, (reason: Error) => setError(reason.message)), [siteId]);
  useEffect(() => {
    const off = [onConnect(load), onChat((id, event: ChatEvent) => {
      if (id !== siteId) return;
      if (event.type === "settled") { load(); return; }
      if (event.type === "error") { setError(`pi 出错：${event.message}`); return; }
      setLive((current) => {
        const next = { ...(current ?? emptyLive()) };
        if (event.type === "text") next.text += event.delta;
        else if (event.type === "thinking") next.thinking += event.delta;
        else if (event.type === "tool_start") next.tools = [...next.tools, { role: "tool", id: event.id, name: event.name, args: event.args, ok: null, result: "" }];
        else if (event.type === "tool_end") next.tools = next.tools.map((tool) => tool.id === event.id ? { ...tool, ok: event.ok, result: event.result } : tool);
        return next;
      });
    })];
    return () => off.forEach((dispose) => dispose());
  }, [load, siteId]);
  useEffect(() => { void endRef.current?.scrollIntoView({ block: "end" }); }, [items.length, live?.text.length, live?.tools.length]);
  const send = async (text: string) => {
    if (!text.trim() || live) return;
    setError(null); setItems((current) => [...current, { role: "user", text: text.trim() }]); setLive(emptyLive()); setDraft("");
    try { await call("chat.send", { siteId, text }); }
    catch (reason) { setLive(null); setError((reason as Error).message); toast((reason as Error).message, "error"); load(); }
  };
  const reset = async () => {
    if (!await confirm({ title: "开始新对话？", description: "当前对话上下文会被清空，但已经应用到站点的变更不会撤销。", confirmText: "开始新对话", destructive: true })) return;
    try { await call("chat.reset", { siteId }); toast("已开始新对话", "success"); load(); }
    catch (reason) { setError((reason as Error).message); toast((reason as Error).message, "error"); }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(draft); } };
  return <section aria-label={`和 pi 对话：${domain}`} className="flex min-h-[34rem] min-w-0 flex-col overflow-hidden rounded-lg border bg-card"><header className="flex items-center justify-between gap-2 border-b px-4 py-3"><div><h2 className="text-sm font-medium">和 pi 对话</h2><p className="mt-0.5 text-xs text-muted-foreground">修改会直接应用到 {domain}，并记录为可回滚的变更集。</p></div><Button variant="ghost" size="sm" disabled={live !== null} onClick={() => void reset()}><MessageSquarePlus aria-hidden />新对话</Button></header>{error && <p role="alert" className="border-b bg-destructive/5 px-4 py-2 text-sm text-destructive">{error}</p>}<ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-4 p-4">{items.length === 0 && !live && <div className="py-8 text-center text-sm text-muted-foreground"><p className="font-medium text-foreground">告诉 pi 你想怎么改这个站</p><p className="mt-1">每次修改都会保存快照，可以在「变更记录」里回滚。</p><div className="mt-4 flex flex-wrap justify-center gap-2">{SUGGESTIONS.map((suggestion) => <Button key={suggestion} variant="outline" size="sm" className="h-auto max-w-sm py-1.5 whitespace-normal text-left" onClick={() => setDraft(suggestion)}>{suggestion}</Button>)}</div></div>}{items.map((item, index) => <Message key={index} item={item} />)}{live && <div className="flex flex-col gap-2" aria-live="polite">{live.thinking && !live.text && <p className="text-xs text-muted-foreground">正在思考…</p>}{live.tools.map((tool) => <ToolLine key={tool.id} item={tool} />)}{live.text ? <p className="max-w-[94%] text-sm whitespace-pre-wrap">{rich(live.text)}</p> : !live.thinking && live.tools.length === 0 && <LoaderCircle className="size-4 text-muted-foreground motion-safe:animate-spin" aria-label="pi 正在回复" />}</div>}<div ref={endRef} /></div></ScrollArea><form onSubmit={(event) => { event.preventDefault(); void send(draft); }} className="flex items-end gap-2 border-t p-3"><label htmlFor={`chat-${siteId}`} className="sr-only">给 pi 的消息</label><textarea id={`chat-${siteId}`} rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey} placeholder="描述你想修改的内容（Enter 发送，Shift+Enter 换行）" className="min-h-14 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />{live ? <Button type="button" variant="outline" onClick={() => void call("chat.abort", { siteId }).catch((reason: Error) => setError(reason.message))}><Square aria-hidden />停止</Button> : <Button type="submit" disabled={!draft.trim()}><Send aria-hidden />发送</Button>}</form></section>;
}

function ChangesPanel({ siteId }: { siteId: number }) {
  const confirm = useConfirm();
  const [changes, setChanges] = useState<ChangeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => void call<ChangeSummary[]>("changes.list", { siteId }).then(setChanges, (reason: Error) => setError(reason.message)), [siteId]);
  useEffect(() => { const off = [onConnect(load), onChanged("changes", load)]; return () => off.forEach((dispose) => dispose()); }, [load]);
  const revert = async (change: ChangeSummary) => {
    if (!await confirm({ title: `回滚变更 #${change.id}？`, description: `“${change.summary}”涉及 ${change.targets.join("、")}。如果这些内容之后又被修改过，后台会拒绝回滚。`, confirmText: "确认回滚", destructive: true })) return;
    try { await call("changes.revert", { siteId, changeId: change.id }); toast("变更已回滚", "success"); load(); }
    catch (reason) { setError((reason as Error).message); toast((reason as Error).message, "error"); }
  };
  const cancelSchedule = async (change: ChangeSummary) => {
    if (!await confirm({ title: "取消定时恢复？", description: `变更 #${change.id} 将继续保持生效，不会在原定时间自动回滚。`, confirmText: "取消定时恢复" })) return;
    try { await call("changes.cancelSchedule", { siteId, changeId: change.id }); toast("已取消定时恢复", "success"); load(); }
    catch (reason) { setError((reason as Error).message); toast((reason as Error).message, "error"); }
  };
  if (changes === null) return error ? <div role="alert" className="space-y-3 text-sm text-destructive"><p>{error}</p><Button variant="outline" onClick={load}>重新加载变更记录</Button></div> : <div className="h-52 motion-safe:animate-pulse rounded-lg bg-muted" />;
  return <section aria-labelledby="changes-title"><header><h2 id="changes-title" className="font-semibold">变更记录</h2><p className="mt-1 text-sm text-muted-foreground">pi 每次修改前都会保存快照，可以整体回滚；定时恢复由对话中的指令创建。</p></header>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}{changes.length === 0 ? <div className="mt-5 rounded-lg border border-dashed p-8 text-center text-sm"><p className="font-medium">还没有变更记录</p><p className="mt-1 text-muted-foreground">去「对话」告诉 pi 你想修改的内容。</p></div> : <ol className="mt-5 divide-y border-y">{changes.map((change) => <li key={change.id} className="py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium">#{change.id} {change.summary}</p><p className="mt-1 text-xs text-muted-foreground tabular-nums">{dateTime(change.createdAt)} · 由{INITIATOR[change.initiator]}修改 · {change.targets.join("、")}</p></div>{change.status === "applied" ? <Badge variant="secondary">已生效</Badge> : <Badge variant="outline">已回滚</Badge>}</div>{change.revertedAt && <p className="mt-2 text-xs text-muted-foreground">{dateTime(change.revertedAt)} 已回滚</p>}{change.status === "applied" && change.revertAt && <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-amber-700 dark:text-amber-400"><Clock className="size-3" aria-hidden />将于 {dateTime(change.revertAt)} 自动回滚<button type="button" className="ml-1 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void cancelSchedule(change)}>取消</button></p>}{change.revertError && <p className="mt-2 text-xs text-destructive">定时恢复失败：{change.revertError}</p>}{change.status === "applied" && <Button variant="outline" size="sm" className="mt-3" onClick={() => void revert(change)}><RotateCcw aria-hidden />回滚</Button>}</li>)}</ol>}</section>;
}

function MailPanel({ siteId }: { siteId: number }) {
  const confirm = useConfirm();
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const load = useCallback(() => { setLoading(true); setError(null); void call<MailStatus>("mail.status", { siteId }).then(setStatus, (reason: Error) => setError(reason.message)).finally(() => setLoading(false)); }, [siteId]);
  useEffect(() => onConnect(load), [load]);
  const needMailbox = Boolean(status?.onDomain && status.hasOrder && !status.mailbox);
  const planned = status?.dns?.atHostinger ? status.dns.planned : [];
  const fix = async () => {
    const actions = [needMailbox ? `创建 ${status?.email}` : "", ...planned].filter(Boolean).join("；");
    if (!await confirm({ title: "修复客服邮箱和邮件 DNS？", description: `只补缺少的项目，不删除已有记录。${actions ? `计划：${actions}` : ""}`, confirmText: "确认修复" })) return;
    setFixing(true); setError(null);
    try { const result = await call<{ mailbox: string; dns: { fixed: string[] } | null }>("mail.fix", { siteId }); toast(`${result.mailbox}${result.dns?.fixed.length ? `；补上 ${result.dns.fixed.length} 组 DNS 记录` : ""}`, "success"); load(); }
    catch (reason) { setError((reason as Error).message); toast((reason as Error).message, "error"); }
    finally { setFixing(false); }
  };
  const showPassword = async () => { try { setPassword((await call<{ password: string } | null>("mail.password", { siteId }))?.password ?? null); } catch (reason) { setError((reason as Error).message); } };
  return <section aria-labelledby="mail-title" className="max-w-4xl"><header className="flex items-start justify-between gap-3"><div><h2 id="mail-title" className="font-semibold">客服邮箱</h2><p className="mt-1 text-sm text-muted-foreground">检查邮箱、公共 DNS 和 WooCommerce 交易邮件。</p></div><Button variant="outline" size="sm" onClick={load} disabled={loading || fixing}>{loading ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}重新检查</Button></header>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}{!status ? <div className="mt-5 h-48 animate-pulse rounded-lg bg-muted" /> : <div className="mt-5 space-y-5"><section className="rounded-lg border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium break-all">{status.email}</p>{!status.onDomain ? <Badge variant="outline">外部管理</Badge> : status.mailbox === "active" ? <Badge variant="secondary">邮箱已开通</Badge> : <Badge variant="outline" className="status-waiting">待开通</Badge>}</div>{!status.onDomain ? <p className="mt-2 text-sm text-muted-foreground">不在本站域名上，由你自己管理。</p> : !status.hasOrder ? <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">这个域名没有 Hostinger 邮箱订单。先在 hPanel 开通邮箱，再重新检查。</p> : status.mailbox !== "active" && <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">邮箱状态：{status.mailbox ?? "尚未创建"}</p>}{status.passwordSaved && <p className="mt-3 text-sm">密码：{password ? <code className="rounded bg-muted px-1.5 py-0.5 select-all">{password}</code> : "已加密保存"}<button type="button" className="ml-2 text-xs underline underline-offset-2" onClick={() => password ? setPassword(null) : void showPassword()}>{password ? "隐藏" : "显示"}</button></p>}{status.dns && <div className="mt-4 border-t pt-4"><h3 className="text-sm font-medium">邮件 DNS</h3><ul className="mt-3 grid gap-2 sm:grid-cols-2">{status.dns.checks.map((check) => <li key={check.key} className="flex gap-2 text-xs">{check.ok ? <CircleCheck className="size-4 shrink-0 text-emerald-600" aria-label="正确" /> : <CircleAlert className="size-4 shrink-0 text-amber-600" aria-label="有问题" />}<span className="w-12 shrink-0 font-medium">{check.key}</span><span className="min-w-0 break-all text-muted-foreground">{check.detail}</span></li>)}</ul>{!status.dns.atHostinger && status.dns.manual.length > 0 && <div className="mt-4 text-xs"><p className="text-amber-700 dark:text-amber-400">DNS 不在 Hostinger，请在当前 DNS 服务商添加：</p><ul className="mt-2 list-disc space-y-1 pl-5 font-mono break-all">{status.dns.manual.map((item) => <li key={item}>{item}</li>)}</ul></div>}</div>}{(needMailbox || planned.length > 0) && <Button className="mt-4" size="sm" disabled={fixing} onClick={() => void fix()}>{fixing ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Wrench aria-hidden />}修复缺少项目</Button>}</section>{status.onDomain && status.mailbox === "active" && <SmtpSection siteId={siteId} email={status.email} />}</div>}</section>;
}

function SmtpSection({ siteId, email }: { siteId: number; email: string }) {
  const confirm = useConfirm();
  const [smtp, setSmtp] = useState<SmtpStatus | null>(null);
  const [password, setPassword] = useState("");
  const [to, setTo] = useState(email);
  const [busy, setBusy] = useState<"enable" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => void call<SmtpStatus>("smtp.status", { siteId }).then(setSmtp, (reason: Error) => setError(/HTTP 404/.test(reason.message) ? "站点上的伴侣插件版本太旧，重新部署后才能设置发信" : reason.message)), [siteId]);
  useEffect(() => onConnect(load), [load]);
  const enable = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!await confirm({ title: "启用交易邮件？", description: `将验证 ${email} 的凭据，更新站点 SMTP 配置，并发送一封测试邮件。`, confirmText: "验证并启用" })) return;
    setBusy("enable"); setError(null);
    try { const result = await call<{ ok: boolean; detail: string }>("smtp.enable", { siteId, password: password || undefined }); result.ok ? toast(result.detail, "success") : toast(result.detail, "error"); setPassword(""); load(); }
    catch (reason) { setError((reason as Error).message); toast((reason as Error).message, "error"); }
    finally { setBusy(null); }
  };
  const resetPassword = async () => {
    if (!await confirm({ title: `给 ${email} 生成新密码？`, description: "旧密码会立即失效，其他邮件客户端和网页邮箱也必须改用新密码。", confirmText: "生成新密码并启用", destructive: true })) return;
    setBusy("enable"); setError(null);
    try { const result = await call<{ ok: boolean; detail: string }>("smtp.resetPassword", { siteId }); result.ok ? toast(result.detail, "success") : toast(result.detail, "error"); load(); }
    catch (reason) { setError((reason as Error).message); toast((reason as Error).message, "error"); }
    finally { setBusy(null); }
  };
  const sendTest = async (event: FormEvent) => {
    event.preventDefault();
    if (!await confirm({ title: "发送测试邮件？", description: `将向 ${to} 发送一封真实测试邮件。`, confirmText: "发送" })) return;
    setBusy("test"); setError(null);
    try { const result = await call<{ sent: boolean; delivered: boolean | null; detail: string }>("smtp.test", { siteId, to }); result.sent && result.delivered !== false ? toast(result.detail, "success") : toast(result.detail, "error"); }
    catch (reason) { setError((reason as Error).message); toast((reason as Error).message, "error"); }
    finally { setBusy(null); }
  };
  return <section aria-labelledby="smtp-title" className="rounded-lg border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 id="smtp-title" className="font-medium">交易邮件</h3>{smtp?.enabled ? <Badge variant="secondary">已启用</Badge> : <Badge variant="outline" className="status-waiting">待启用</Badge>}</div>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}{smtp && (smtp.enabled ? <><p className="mt-3 flex gap-2 text-sm"><CircleCheck className="size-4 shrink-0 text-emerald-600" aria-hidden />订单邮件经 {smtp.host} 用 {smtp.username} 发出</p><form onSubmit={sendTest} className="mt-4 flex flex-col gap-2 sm:flex-row"><label htmlFor={`smtp-to-${siteId}`} className="sr-only">测试邮件收件人</label><input id={`smtp-to-${siteId}`} type="email" value={to} onChange={(event) => setTo(event.target.value)} className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /><Button type="submit" variant="outline" disabled={busy !== null || !to.trim()}>{busy === "test" && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}发测试邮件</Button></form></> : smtp.passwordSaved ? <><p className="mt-3 text-sm text-amber-700 dark:text-amber-400">订单邮件仍使用主机默认发信，容易进入垃圾箱。</p><Button className="mt-3" size="sm" disabled={busy !== null} onClick={() => void enable()}>{busy === "enable" && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}启用并发测试邮件</Button></> : <form onSubmit={enable} className="mt-3 space-y-3"><p className="text-sm text-amber-700 dark:text-amber-400">这是已有邮箱，本应用没有它的密码。填入后会先验证，再启用发信。</p><label htmlFor={`smtp-pass-${siteId}`} className="sr-only">{email} 的密码</label><input id={`smtp-pass-${siteId}`} type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={`${email} 的密码`} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /><div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={busy !== null || !password}>{busy === "enable" && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}验证并启用</Button><Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void resetPassword()}>不知道密码？生成新密码</Button></div></form>)}</section>;
}
