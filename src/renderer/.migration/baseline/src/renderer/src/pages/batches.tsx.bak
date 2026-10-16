import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { ExternalLink, LoaderCircle, Plus, Rocket, RotateCcw } from "lucide-react";
import { PROVISION_STEPS, type BatchSummary, type QaView, type RunEvent, type SiteProgress, type SiteStatus, type StepState } from "../../../shared/protocol.ts";
import { toast, useConfirm } from "@/components/feedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { call, onEvent, useRpcData } from "@/lib/backend.ts";
import { cn } from "@/lib/utils";
import { LogViewer, StepTimeline } from "./site-operations.tsx";
import { QaReport } from "./qa-report.tsx";

const SITE_STATUS: Record<SiteStatus, { label: string; variant: "secondary" | "outline" | "destructive" | "default"; className?: string }> = {
  queued: { label: "排队中", variant: "outline" },
  running: { label: "进行中", variant: "default" },
  waiting: { label: "等待 Hostinger", variant: "outline", className: "border-amber-500/60 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300" },
  done: { label: "已完成", variant: "secondary" },
  failed: { label: "失败", variant: "destructive" },
  abandoned: { label: "已放弃", variant: "outline" },
};

const TOTAL = PROVISION_STEPS.length;
const dateTime = (timestamp: number) => new Date(timestamp).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
type BatchesPageProps = { initialBatch: number | null; onNew: () => void; onNavigate?: (path: string) => void };

function unresolvedQa(qa: QaView | null): string[] {
  if (!qa) return ["未找到 QA 报告"];
  return [
    ...qa.checks.filter((check) => !check.ok).map((check) => `${check.name}：${check.detail}`),
    ...(qa.review?.issues.filter((issue) => issue.status !== "fixed").map((issue) => `${issue.level} ${issue.page}：${issue.status === "needs_you" ? "待你补充" : "待处理"}`) ?? []),
  ];
}

function BatchSkeleton() {
  return <div aria-label="正在加载批次" className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]"><div className="h-44 animate-pulse rounded-lg bg-muted" /><div className="h-72 animate-pulse rounded-lg bg-muted" /></div>;
}

export function BatchesPage({ initialBatch, onNew, onNavigate }: BatchesPageProps) {
  const confirm = useConfirm();
  const [batchId, setBatchId] = useState<number | null>(initialBatch);
  const [siteId, setSiteId] = useState<number | null>(null);
  const [busySite, setBusySite] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((reason: Error) => setError(reason.message), []);
  const { data: batches, loading: batchesLoading, refreshing: batchesRefreshing, error: batchesError, refresh: refreshBatches, invalidate: invalidateBatches } = useRpcData<BatchSummary[]>("batches.list");
  const effectiveBatchId = batchId ?? batches?.[0]?.id ?? null;
  const { data: sites = [], error: sitesError, refresh: refreshSites, invalidate: invalidateSites } = useRpcData<SiteProgress[]>("batches.sites", effectiveBatchId == null ? null : { batchId: effectiveBatchId }, { topics: ["batches"] });
  const effectiveSiteId = siteId ?? sites[0]?.id ?? null;
  const { data: steps = [], error: stepsError, refresh: refreshSteps, invalidate: invalidateSteps } = useRpcData<StepState[]>("sites.steps", effectiveSiteId == null ? null : { siteId: effectiveSiteId }, { topics: ["batches"] });
  const { data: events = [], error: eventsError, refresh: refreshEvents, invalidate: invalidateEvents } = useRpcData<RunEvent[]>("sites.events", effectiveSiteId == null ? null : { siteId: effectiveSiteId }, { topics: ["batches"] });
  const { data: qa = null, error: qaError, refresh: refreshQa, invalidate: invalidateQa } = useRpcData<QaView | null>("sites.qa", effectiveSiteId == null ? null : { siteId: effectiveSiteId }, { topics: ["batches"] });
  const loadBatches = useCallback(() => refreshBatches().catch(fail), [fail, refreshBatches]);
  const loadSites = useCallback(() => { void refreshSites().catch(fail); }, [fail, refreshSites]);
  const loadSite = useCallback(() => { void Promise.all([refreshSteps(), refreshEvents(), refreshQa()]).catch(fail); }, [fail, refreshEvents, refreshQa, refreshSteps]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void loadBatches(); loadSites(); }, 200);
    };
    const off = [onEvent((event) => {
        if (!event.siteId || !sites.some((item) => String(item.id) === event.siteId)) return;
        if (event.kind === "step") refreshSoon();
        if (event.siteId !== String(effectiveSiteId)) return;
        invalidateEvents(); void refreshEvents().catch(fail);
        if (event.kind === "step") { invalidateSteps(); void refreshSteps().catch(fail); }
        if (event.kind === "step" && event.payload.step === "qa") { invalidateQa(); void refreshQa().catch(fail); }
      })];
    return () => { clearTimeout(timer); off.forEach((dispose) => dispose()); };
  }, [effectiveSiteId, fail, invalidateEvents, invalidateQa, invalidateSteps, loadBatches, loadSites, refreshEvents, refreshQa, refreshSteps, sites]);

  useLayoutEffect(() => { if (initialBatch != null) setBatchId(initialBatch); }, [initialBatch]);
  useEffect(() => { const reason = sitesError ?? stepsError ?? eventsError ?? qaError; if (reason) fail(reason); }, [eventsError, fail, qaError, sitesError, stepsError]);
  useLayoutEffect(() => { if (batches && !batches.some((batch) => batch.id === batchId)) setBatchId(batches[0]?.id ?? null); }, [batchId, batches]);
  useLayoutEffect(() => { if (!sites.some((item) => item.id === siteId)) setSiteId(sites[0]?.id ?? null); }, [siteId, sites]);

  const chooseBatch = (id: number) => { setBatchId(id); onNavigate?.(`/batches/${id}`); };
  const retry = async (site: SiteProgress) => {
    if (!await confirm({ title: `重试 ${site.domain}？`, description: "将从失败的步骤继续执行，并再次调用外部服务。", confirmText: "重试" })) return;
    setBusySite(site.id); setError(null);
    try { await call("sites.retry", { siteId: site.id }); toast("已重新加入执行队列", "success"); invalidateBatches(); invalidateSites(); invalidateSteps(); invalidateEvents(); invalidateQa(); void loadBatches(); loadSites(); loadSite(); }
    catch (reason) { fail(reason as Error); toast((reason as Error).message, "error"); }
    finally { setBusySite(null); }
  };
  const launch = async (site: SiteProgress) => {
    let warnings: string[] = [];
    try { warnings = unresolvedQa(await call<QaView | null>("sites.qa", { siteId: site.id })); }
    catch (reason) { fail(reason as Error); toast("无法读取最新 QA 报告，已取消上线", "error"); return; }
    const warningText = warnings.length > 0 ? ` 尚有 ${warnings.length} 项未解决：${warnings.slice(0, 3).join("；")}${warnings.length > 3 ? "；…" : ""}。` : " 当前 QA 没有未解决项。";
    if (!await confirm({ title: `上线 ${site.domain}？`, description: `将关闭维护模式和“即将上线”页面，并允许搜索引擎收录。访客之后可以浏览和下单。${warningText}`, confirmText: warnings.length > 0 ? "仍然上线" : "确认上线" })) return;
    setBusySite(site.id); setError(null);
    try { const result = await call<{ detail: string }>("sites.launch", { siteId: site.id }); toast(result.detail, "success"); invalidateBatches(); invalidateSites(); void loadBatches(); loadSites(); }
    catch (reason) { fail(reason as Error); toast((reason as Error).message, "error"); }
    finally { setBusySite(null); }
  };
  const site = sites.find((item) => item.id === effectiveSiteId) ?? null;

  if (batchesLoading) return <div className="flex flex-col gap-6"><header><h1 className="text-2xl font-semibold tracking-tight">批次</h1><p className="mt-1 text-sm text-muted-foreground">查看建站任务、步骤和复核结果。</p></header>{(error || batchesError) && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"><p>{error ?? batchesError?.message}</p><Button variant="outline" size="sm" className="mt-3" onClick={() => void loadBatches()}>重新加载</Button></div>}<BatchSkeleton /></div>;
  if (!batches) return <p role="alert" className="text-sm text-destructive">{batchesError?.message ?? error ?? "无法读取批次"}</p>;
  if (batches.length === 0) return <div className="flex max-w-3xl flex-col gap-6"><header><h1 className="text-2xl font-semibold tracking-tight">批次</h1><p className="mt-1 text-sm text-muted-foreground">查看建站任务、步骤和复核结果。</p></header><div className="rounded-lg border border-dashed p-8 text-center text-sm"><p className="font-medium">还没有建站批次</p><p className="mt-1 text-muted-foreground">先在「建站」页填写经营主体和域名。提交后，实时进度会出现在这里。</p><Button className="mt-4" onClick={onNew}><Plus aria-hidden />新建批次</Button></div></div>;

  return (
    <div className="flex flex-col gap-6">
      {batchesRefreshing && <p role="status" className="fixed right-4 bottom-4 text-xs text-muted-foreground">刷新中…</p>}
      <header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">批次</h1><p className="mt-1 text-sm text-muted-foreground">查看建站任务、步骤和复核结果。</p></div><Button onClick={onNew}><Plus aria-hidden />新建批次</Button></header>
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label="批次列表" className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
          {batches.map((batch) => <button key={batch.id} type="button" aria-current={batch.id === batchId ? "page" : undefined} onClick={() => chooseBatch(batch.id)} className={cn("min-w-52 rounded-lg border px-3 py-3 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring lg:min-w-0", batch.id === batchId ? "border-primary/40 bg-primary/5" : "border-border/70 hover:bg-muted/60")}><span className="flex items-center justify-between font-medium">批次 {batch.id}{batch.active > 0 && <LoaderCircle className="size-3.5 text-primary motion-safe:animate-spin" aria-label="进行中" />}</span><span className="mt-1 block text-xs text-muted-foreground tabular-nums">{dateTime(batch.createdAt)} · {batch.total} 个站</span><span className="mt-1 block text-xs tabular-nums">完成 {batch.done}{batch.failed > 0 && <span className="text-destructive"> · 失败 {batch.failed}</span>}</span></button>)}
        </nav>
        <main className="min-w-0 space-y-6">
          <section aria-labelledby="batch-sites-title"><h2 id="batch-sites-title" className="mb-3 text-sm font-medium">站点进度</h2><div className="overflow-x-auto rounded-lg border bg-card"><Table aria-label="站点进度"><TableHeader><TableRow><TableHead>域名</TableHead><TableHead>状态</TableHead><TableHead className="min-w-44">进度</TableHead><TableHead className="min-w-52">当前步骤</TableHead><TableHead><span className="sr-only">操作</span></TableHead></TableRow></TableHeader><TableBody>{sites.map((item) => <TableRow key={item.id} data-state={item.id === siteId ? "selected" : undefined} className="cursor-pointer" onClick={() => setSiteId(item.id)}><TableCell><button type="button" className="font-medium outline-none focus-visible:underline" aria-pressed={item.id === siteId} onClick={() => setSiteId(item.id)}>{item.domain}</button></TableCell><TableCell>{item.launchedAt ? <Badge variant="secondary">已上线</Badge> : <Badge variant={SITE_STATUS[item.status].variant} className={SITE_STATUS[item.status].className}>{SITE_STATUS[item.status].label}</Badge>}</TableCell><TableCell><div className="flex items-center gap-2"><div className="h-1.5 flex-1 rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={TOTAL} aria-valuenow={item.completed} aria-label={`${item.domain} 的进度`}><div className={cn("h-full rounded-full", item.status === "failed" ? "bg-destructive" : item.status === "waiting" ? "bg-amber-500" : "bg-primary")} style={{ width: `${Math.min(100, (item.completed / TOTAL) * 100)}%` }} /></div><span className="text-xs text-muted-foreground tabular-nums">{item.completed}/{TOTAL}</span></div></TableCell><TableCell className="whitespace-normal text-sm">{item.launchedAt ? <span className="text-muted-foreground">{dateTime(item.launchedAt)} 上线</span> : item.status === "done" ? <span className="text-muted-foreground">已完成，等你检查后上线</span> : item.currentStep ?? "—"}{item.lastError && <span className="mt-1 block max-w-md text-xs text-destructive">{item.lastError}</span>}</TableCell><TableCell><div className="flex gap-2">{item.status === "failed" && <Button variant="outline" size="sm" disabled={busySite === item.id} onClick={(event) => { event.stopPropagation(); void retry(item); }}>{busySite === item.id ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}重试</Button>}{item.status === "done" && !item.launchedAt && <Button size="sm" disabled={busySite === item.id} onClick={(event) => { event.stopPropagation(); void launch(item); }}><Rocket aria-hidden />上线</Button>}</div></TableCell></TableRow>)}</TableBody></Table></div></section>
          {site && <section aria-label={`${site.domain} 的详情`} className="space-y-6"><header className="flex flex-wrap items-center justify-between gap-3 border-b pb-3"><div><h2 className="font-semibold">{site.domain}</h2><p className="mt-0.5 text-xs text-muted-foreground tabular-nums">最近更新 {dateTime(site.updatedAt)}</p></div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => onNavigate?.(`/sites/${site.id}/overview`)}>站点详情</Button><Button variant="ghost" size="sm" asChild><a href={`https://${site.domain}/`} target="_blank" rel="noreferrer">打开网站<ExternalLink aria-hidden /></a></Button></div></header><div className="grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]"><section aria-labelledby="timeline-title"><h3 id="timeline-title" className="mb-3 text-sm font-medium">步骤时间线</h3><StepTimeline steps={steps} /></section><LogViewer events={events} /></div><QaReport qa={qa} /></section>}
        </main>
      </div>
    </div>
  );
}
