import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronDown, CircleAlert, CircleCheck, ExternalLink,
  FileSearch, Image as ImageIcon, LoaderCircle, RefreshCw, Sparkles, Wrench, XCircle,
} from "lucide-react";
import type { QaRun, QaRunEvent, QaView, ReviewIssue, RunEvent } from "../../../shared/protocol.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { call, onEvent, useRpcData } from "@/lib/backend.ts";
import { cn } from "@/lib/utils";
import { activeQaRun, groupQaIssues, issueTitle, latestQaRun, needsYouGuidance, qaCounts, qaPassed } from "@/features/sites/components/qa-report-model.ts";

const SHOT_TEXT: Record<string, string> = {
  home: "首页", shop: "商店", product: "商品页", contact: "联系我们", cart: "购物车", checkout: "结账页", "home-mobile": "首页（手机）",
};
const LEVEL_TEXT: Record<ReviewIssue["level"], string> = { P1: "必须解决", P2: "建议修改", P3: "建议修改" };
const RUN_KIND: Record<QaRun["kind"], string> = { fixIssue: "修复单个问题", fixAll: "一键修复", recheck: "重新复核" };
const NOOP = () => undefined;

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}
const safeImage = (value: string | undefined): string | null => value && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value) ? value : null;
const dateTime = (value: number) => new Date(value).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function runEventFromPush(event: RunEvent): { runId: string; item: QaRunEvent } | null {
  const payload = event.payload;
  const runId = typeof payload.qaRunId === "string" ? payload.qaRunId : null;
  const message = typeof payload.message === "string" ? payload.message : null;
  if (!runId || !message) return null;
  const level = payload.level === "success" || payload.level === "warning" || payload.level === "error" ? payload.level : "info";
  return {
    runId,
    item: {
      at: typeof payload.at === "number" ? payload.at : event.ts,
      stage: typeof payload.stage === "string" ? payload.stage : "progress",
      level,
      message,
      ...(typeof payload.issueId === "string" ? { issueId: payload.issueId } : {}),
      ...(typeof payload.changesetId === "number" ? { changesetId: payload.changesetId } : {}),
    },
  };
}

function sameRunEvent(left: QaRunEvent, right: QaRunEvent): boolean {
  return left.at === right.at && left.stage === right.stage && left.message === right.message;
}

/** Server state is authoritative, while local push/optimistic items bridge invalidation latency. */
function mergeQaRuns(server: QaRun[], current: QaRun[]): QaRun[] {
  const local = new Map(current.map((run) => [run.id, run]));
  const merged = server.map((run) => {
    const pending = local.get(run.id)?.events.filter((event) => !run.events.some((saved) => sameRunEvent(saved, event))) ?? [];
    return pending.length ? { ...run, events: [...run.events, ...pending].sort((left, right) => left.at - right.at) } : run;
  });
  const savedIds = new Set(server.map((run) => run.id));
  return [...merged, ...current.filter((run) => !savedIds.has(run.id))];
}

function SummaryMetric({ value, label, tone }: { value: number; label: string; tone?: "danger" | "warning" | "success" }) {
  return (
    <div className="min-w-0 border-l pl-3 first:border-l-0 first:pl-0 sm:pl-4">
      <p className={cn("text-xl font-semibold tabular-nums", tone === "danger" && "text-destructive", tone === "warning" && "text-amber-700 dark:text-amber-300", tone === "success" && "text-emerald-700 dark:text-emerald-300")}>{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function RuleDetail({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 140;
  return (
    <div className="mt-0.5 text-xs text-muted-foreground">
      <p className={cn(!expanded && long && "line-clamp-2")}>{text}</p>
      {long && <button type="button" className="mt-1 font-medium text-primary underline-offset-2 hover:underline" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : "展开"}</button>}
    </div>
  );
}

function IssueCard({ issue, running, onFix, onZoom }: { issue: ReviewIssue; running: boolean; onFix: (issue: ReviewIssue) => void; onZoom: (shot: string, title: string) => void }) {
  const url = safeHttpUrl(issue.url);
  const shot = safeImage(issue.shot);
  return (
    <article className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={issue.level === "P1" ? "destructive" : "outline"} className={cn(issue.level !== "P1" && "text-amber-700 dark:text-amber-300")}>{LEVEL_TEXT[issue.level]} · {issue.level}</Badge>
            {issue.status === "fixed" && <Badge variant="secondary" className="status-done">已修复</Badge>}
          </div>
          <h4 className="mt-2 text-base font-semibold leading-snug">{issueTitle(issue.why)}</h4>
        </div>
        {issue.status === "open" && issue.fixable && (
          <Button size="sm" disabled={running} onClick={() => onFix(issue)}>{running ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Wrench aria-hidden />}修复</Button>
        )}
      </div>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>位置：{issue.page}</span>
        {url && <a href={url} target="_blank" rel="noreferrer" aria-label={`打开${issue.page}`} className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">查看页面<ExternalLink className="size-3" aria-hidden /></a>}
      </div>
      <dl className="mt-4 grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[4.5rem_minmax(0,1fr)]">
        <dt className="font-medium text-muted-foreground">为什么</dt><dd className="whitespace-pre-wrap">{issue.why}</dd>
        <dt className="font-medium text-muted-foreground">怎么改</dt><dd className="whitespace-pre-wrap">{issue.fix}</dd>
      </dl>
      {issue.status === "needs_you" && <div className="mt-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"><p className="font-medium">你需要提供</p><p className="mt-1">{needsYouGuidance(issue)}</p></div>}
      <details className="mt-4 border-t pt-3 text-sm">
        <summary className="cursor-pointer select-none font-medium text-muted-foreground marker:text-muted-foreground">页面原文</summary>
        <p className="mt-2 whitespace-pre-wrap rounded-lg bg-muted/60 p-3 text-xs leading-relaxed">{issue.evidence || "没有文字证据，请查看页面或截图。"}</p>
      </details>
      {shot && <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => onZoom(shot, `${issue.page}的问题截图`)}><ImageIcon aria-hidden />查看问题截图</Button>}
    </article>
  );
}

function RunPanel({ run, open, onOpenChange }: { run: QaRun | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  if (!open || !run) return null;
  const active = run.status === "queued" || run.status === "running";
  return (
    <aside aria-label="修复进度" className="order-first rounded-xl border bg-card shadow-sm xl:order-last xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-auto">
      <header className="flex items-start justify-between gap-3 border-b p-4">
        <div><h3 className="font-semibold">{active ? "正在处理" : "修复记录"}</h3><p className="mt-1 text-xs text-muted-foreground">{RUN_KIND[run.kind]} · {dateTime(run.createdAt)}</p></div>
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>关闭</Button>
      </header>
      <div className="p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          {run.status === "error" ? <XCircle className="size-4 text-destructive" aria-hidden /> : active ? <LoaderCircle className="size-4 motion-safe:animate-spin text-primary" aria-hidden /> : <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />}
          {run.status === "queued" ? "等待开始" : run.status === "running" ? "任务进行中" : run.status === "done" ? "任务已完成" : "任务失败"}
        </div>
        <ol className="mt-4 space-y-3" aria-live="polite">
          {run.events.length === 0 && <li className="text-sm text-muted-foreground">任务已经提交，正在等待第一条进度。</li>}
          {run.events.map((event, index) => (
            <li key={`${event.at}-${event.stage}-${index}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 text-sm">
              <span className={cn("mt-1.5 size-2 rounded-full", event.level === "success" ? "bg-emerald-500" : event.level === "warning" ? "bg-amber-500" : event.level === "error" ? "bg-destructive" : "bg-primary")} aria-hidden />
              <div><p className={cn(event.level === "error" && "text-destructive", event.level === "warning" && "text-amber-800 dark:text-amber-300")}>{event.message}</p><p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{dateTime(event.at)}{event.changesetId != null ? ` · 变更 #${event.changesetId}` : ""}</p></div>
            </li>
          ))}
        </ol>
        {run.result && <div className="mt-4 rounded-lg bg-muted/60 p-3 text-sm"><p className="font-medium">{run.result.passed ? "复核已通过" : "复核仍有待处理项"}</p><p className="mt-1 text-muted-foreground">已修复 {run.result.fixed} 项，剩余 P1 {run.result.remainingP1} 项。</p></div>}
        {run.error && <p role="alert" className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{run.error}</p>}
      </div>
    </aside>
  );
}

export function QaReport({ siteId, qa, onRefresh = NOOP }: { siteId?: number; qa: QaView | null; onRefresh?: () => void }) {
  const [runs, setRuns] = useState<QaRun[]>([]);
  const runsRef = useRef<QaRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryRequest, setRetryRequest] = useState<{ method: "qa.fixIssue" | "qa.fixAll" | "qa.recheck"; issueId?: string } | null>(null);
  const [submitting, setSubmitting] = useState<QaRun["kind"] | null>(null);
  const submittingRef = useRef(false);
  const [zoom, setZoom] = useState<{ src: string; title: string } | null>(null);
  const { data: serverRuns, error: runsError, refresh: refreshRuns, invalidate: invalidateRuns } = useRpcData<QaRun[]>("qa.runs", siteId == null ? null : { siteId });
  const issues = qa?.review?.issues ?? [];
  const groups = useMemo(() => groupQaIssues(issues), [issues]);
  const counts = useMemo(() => qaCounts(issues), [issues]);
  const activeRun = activeQaRun(runs);
  const latestRun = latestQaRun(runs);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? activeRun ?? latestRun;
  const passed = qaPassed(qa);
  const runBusy = Boolean(activeRun) || submitting !== null;

  const reloadRuns = useCallback(async () => {
    if (siteId == null) return [];
    try { return await refreshRuns() ?? []; }
    catch (reason) { setError((reason as Error).message); return []; }
  }, [refreshRuns, siteId]);

  useEffect(() => {
    runsRef.current = [];
    setRuns([]);
    setSelectedRunId(null);
    setPanelOpen(false);
    setError(null);
  }, [siteId]);

  useEffect(() => {
    if (!serverRuns) return;
    const previous = runsRef.current;
    const completed = serverRuns.some((run) => {
      const old = previous.find((item) => item.id === run.id);
      return Boolean(old && (old.status === "queued" || old.status === "running") && (run.status === "done" || run.status === "error"));
    });
    const next = mergeQaRuns(serverRuns, previous);
    runsRef.current = next;
    setRuns(next);
    const active = activeQaRun(next);
    if (active) { setSelectedRunId(active.id); setPanelOpen(true); }
    if (completed) onRefresh();
  }, [onRefresh, serverRuns]);
  useEffect(() => onEvent((event) => {
    if (siteId == null) return;
    if (event.siteId !== String(siteId)) return;
    const pushed = runEventFromPush(event);
    if (!pushed) return;
    setSelectedRunId(pushed.runId);
    setPanelOpen(true);
    setRuns((current) => {
      const next = current.map((run) => run.id !== pushed.runId || run.events.some((item) => sameRunEvent(item, pushed.item)) ? run : { ...run, status: run.status === "queued" ? "running" as const : run.status, events: [...run.events, pushed.item] });
      runsRef.current = next;
      return next;
    });
  }), [siteId]);
  useEffect(() => {
    if (!activeRun) return;
    const timer = window.setInterval(() => { void reloadRuns(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [activeRun, reloadRuns]);

  const startRun = async (method: "qa.fixIssue" | "qa.fixAll" | "qa.recheck", issueId?: string) => {
    if (siteId == null || submittingRef.current || activeRun) return;
    const kind: QaRun["kind"] = method === "qa.fixIssue" ? "fixIssue" : method === "qa.fixAll" ? "fixAll" : "recheck";
    submittingRef.current = true;
    setSubmitting(kind);
    setError(null);
    setRetryRequest(null);
    try {
      const result = await call<{ runId: string }>(method, { siteId, ...(issueId ? { issueId } : {}) });
      const placeholder: QaRun = { id: result.runId, siteId, kind, status: "queued", createdAt: Date.now(), events: [] };
      setRuns((current) => { const next = current.some((run) => run.id === result.runId) ? current : [placeholder, ...current]; runsRef.current = next; return next; });
      setSelectedRunId(result.runId);
      setPanelOpen(true);
      invalidateRuns();
      void reloadRuns();
    } catch (reason) {
      setError((reason as Error).message);
      setRetryRequest({ method, ...(issueId ? { issueId } : {}) });
    } finally {
      submittingRef.current = false;
      setSubmitting(null);
    }
  };

  const aiCheckCounts = `${counts.p1} 个必须解决，${counts.suggestions} 个建议修改，${counts.needsYou} 个需要你补充；见下方复核问题`;
  return (
    <div className={cn("grid gap-6", panelOpen && selectedRun && "xl:grid-cols-[minmax(0,1fr)_22rem]")}>
      <div className="min-w-0 space-y-6">
        <section className="overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
          <div className="flex flex-col gap-5 p-4 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className={cn("mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl", runBusy ? "bg-primary/10 text-primary" : !qa?.review ? "bg-muted text-muted-foreground" : passed ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-destructive/10 text-destructive")}>
                  {runBusy ? <LoaderCircle className="size-5 motion-safe:animate-spin" aria-hidden /> : !qa?.review ? <FileSearch className="size-5" aria-hidden /> : passed ? <CircleCheck className="size-5" aria-hidden /> : <CircleAlert className="size-5" aria-hidden />}
                </span>
                <div><h2 className="text-lg font-semibold">{runBusy ? (activeRun?.kind ?? submitting) === "recheck" ? "复核中…" : "修复中…" : !qa?.review ? "待复核" : passed ? "已通过" : "未通过"}</h2><p className="mt-1 text-sm text-muted-foreground">{qa ? `上次复核：${dateTime(qa.at)}` : "还没有复核记录"}</p></div>
              </div>
              <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                {latestRun && !panelOpen && <Button variant="outline" className="max-sm:flex-1" onClick={() => { setSelectedRunId(latestRun.id); setPanelOpen(true); }}>查看修复记录</Button>}
                <Button variant="outline" className="max-sm:flex-1" disabled={siteId == null || runBusy} onClick={() => void startRun("qa.recheck")}>
                  {(activeRun?.kind ?? submitting) === "recheck" ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}重新复核
                </Button>
                <Button className="max-sm:w-full" disabled={siteId == null || runBusy || counts.fixable === 0} onClick={() => void startRun("qa.fixAll")}>
                  {(activeRun?.kind ?? submitting) === "fixAll" ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Sparkles aria-hidden />}一键修复全部（{counts.fixable} 项可自动修复）
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-y-4 border-t pt-4 sm:grid-cols-4">
              <SummaryMetric value={counts.p1} label="必须解决 P1" tone={counts.p1 ? "danger" : undefined} />
              <SummaryMetric value={counts.suggestions} label="建议修改 P2/P3" />
              <SummaryMetric value={counts.needsYou} label="需要你补充" tone={counts.needsYou ? "warning" : undefined} />
              <SummaryMetric value={counts.fixed} label="已修复" tone={counts.fixed ? "success" : undefined} />
            </div>
          </div>
        </section>

        {(error || runsError) && <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /><div className="min-w-0"><p>{error ?? runsError?.message}</p><div className="mt-2 flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={runBusy} onClick={() => retryRequest ? void startRun(retryRequest.method, retryRequest.issueId) : void reloadRuns()}>{retryRequest ? "重试操作" : "重新加载"}</Button>{error && <Button variant="ghost" size="sm" onClick={() => setError(null)}>关闭</Button>}</div></div></div>}

        {qa ? (
          <section aria-labelledby="rules-title">
            <h3 id="rules-title" className="text-base font-semibold">规则检查</h3>
            <ul className="mt-3 divide-y rounded-xl border bg-card px-4 sm:px-5">
              {qa.checks.map((check) => (
                <li key={check.id} className="flex gap-3 py-3.5 text-sm">
                  {check.ok ? (
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="通过" />
                  ) : (
                    <CircleAlert className={cn("mt-0.5 size-4 shrink-0", check.level === "block" ? "text-destructive" : "text-amber-600 dark:text-amber-400")} aria-label={check.level === "block" ? "未通过" : "提醒"} />
                  )}
                  <div className="min-w-0"><p className="font-medium">{check.name}</p>{check.id === "ai-review" ? <p className="mt-0.5 text-xs text-muted-foreground">{aiCheckCounts}</p> : <RuleDetail text={check.detail} />}</div>
                </li>
              ))}
            </ul>
          </section>
        ) : <section className="rounded-xl border border-dashed p-8 text-center"><FileSearch className="mx-auto size-7 text-muted-foreground" aria-hidden /><h3 className="mt-3 font-semibold">还没有复核报告</h3><p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">点击「重新复核」检查整站文字、视觉和关键设置。报告生成后会在这里列出需要处理的项目。</p></section>}

        {qa?.review && (
          <section aria-labelledby="issues-title">
            <h3 id="issues-title" className="text-base font-semibold">复核问题</h3>
            <div className="mt-3 space-y-6">
              <section aria-labelledby="open-title"><div className="flex items-center gap-2"><h4 id="open-title" className="font-semibold">待处理</h4><Badge variant="destructive">{groups.open.length}</Badge></div>{groups.open.length ? <div className="mt-3 grid gap-3">{groups.open.map((issue) => <IssueCard key={issue.id} issue={issue} running={siteId == null || runBusy} onFix={(item) => void startRun("qa.fixIssue", item.id)} onZoom={(src, title) => setZoom({ src, title })} />)}</div> : <p className="mt-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">没有待系统处理的问题。</p>}</section>
              <section aria-labelledby="needs-title"><div className="flex items-center gap-2"><h4 id="needs-title" className="font-semibold">需要你补充</h4><Badge variant="outline" className="border-amber-500/60 text-amber-800 dark:text-amber-300">{groups.needsYou.length}</Badge></div>{groups.needsYou.length ? <><p className="mt-2 text-sm text-muted-foreground">这些问题需要真实资料，系统不会猜测。请按「怎么改」补充公司、商品或套装的实际信息，再重新复核。</p><div className="mt-3 grid gap-3">{groups.needsYou.map((issue) => <IssueCard key={issue.id} issue={issue} running={Boolean(activeRun)} onFix={() => undefined} onZoom={(src, title) => setZoom({ src, title })} />)}</div></> : <p className="mt-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">没有需要你补充的资料。</p>}</section>
              <details className="group rounded-xl border bg-card"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 font-semibold sm:px-5"><span className="flex items-center gap-2">已修复 <Badge variant="secondary">{groups.fixed.length}</Badge></span><ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden /></summary>{groups.fixed.length ? <div className="grid gap-3 border-t p-4 sm:p-5">{groups.fixed.map((issue) => <IssueCard key={issue.id} issue={issue} running={Boolean(activeRun)} onFix={() => undefined} onZoom={(src, title) => setZoom({ src, title })} />)}</div> : <p className="border-t p-4 text-sm text-muted-foreground">还没有修复记录。</p>}</details>
            </div>
          </section>
        )}

        {qa && qa.shots.length > 0 && <details className="rounded-xl border bg-card"><summary className="cursor-pointer p-4 font-semibold sm:px-5">页面截图（{qa.shots.length}）</summary><ul className="grid grid-cols-2 gap-3 border-t p-4 sm:grid-cols-3 sm:p-5">{qa.shots.filter((shot) => safeImage(shot.src)).map((shot) => <li key={shot.name}><button type="button" className="w-full overflow-hidden rounded-lg border bg-card text-left outline-none hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setZoom({ src: shot.src, title: SHOT_TEXT[shot.name] ?? shot.name })}><img src={shot.src} alt={`${SHOT_TEXT[shot.name] ?? shot.name}截图`} className="aspect-[4/3] w-full object-cover object-top" /><span className="block border-t px-3 py-2 text-xs font-medium">{SHOT_TEXT[shot.name] ?? shot.name}</span></button></li>)}</ul></details>}
      </div>

      <RunPanel run={selectedRun} open={panelOpen} onOpenChange={setPanelOpen} />
      <Dialog open={zoom !== null} onOpenChange={(open) => !open && setZoom(null)}><DialogContent className="max-h-[92vh] overflow-auto sm:max-w-5xl"><DialogHeader><DialogTitle>{zoom?.title}</DialogTitle></DialogHeader>{zoom && <img src={zoom.src} alt="" className="w-full rounded-md border" />}</DialogContent></Dialog>
    </div>
  );
}
