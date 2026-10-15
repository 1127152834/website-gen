import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Circle, CircleDashed, Clock, LoaderCircle, RotateCcw } from "lucide-react";
import { PROVISION_STEPS, type BatchSummary, type RunEvent, type SiteProgress, type SiteStatus, type StepState } from "../../../shared/protocol.ts";
import { call, onChanged, onConnect, onEvent } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const SITE_STATUS: Record<SiteStatus, { label: string; variant: "secondary" | "outline" | "destructive" | "default" }> = {
  queued: { label: "排队中", variant: "outline" },
  running: { label: "进行中", variant: "default" },
  waiting: { label: "等待 Hostinger", variant: "outline" },
  done: { label: "已完成", variant: "secondary" },
  failed: { label: "失败", variant: "destructive" },
};
const STEP_TEXT: Record<StepState["status"], string> = {
  pending: "未开始", running: "进行中", waiting: "等待中", done: "完成", skipped: "已存在，跳过", failed: "失败",
};
const TOTAL = PROVISION_STEPS.length;

interface QaView {
  at: number;
  checks: { id: string; name: string; level: "block" | "warn"; ok: boolean; detail: string }[];
  shots: { name: string; src: string }[];
}
const SHOT_TEXT: Record<string, string> = {
  home: "首页", shop: "商品列表", product: "商品页", contact: "联系页", cart: "购物车", checkout: "结账页", "home-mobile": "首页（手机）",
};
const time = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
const dateTime = (ts: number) => new Date(ts).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const seconds = (from: number | null, to: number | null) => (from != null && to != null ? `${Math.max(1, Math.round((to - from) / 1000))} 秒` : null);

function StepIcon({ status }: { status: StepState["status"] }) {
  const cls = "size-4 shrink-0";
  if (status === "done" || status === "skipped") return <CircleCheck className={cn(cls, "text-green-600")} aria-hidden />;
  if (status === "running") return <LoaderCircle className={cn(cls, "text-primary motion-safe:animate-spin")} aria-hidden />;
  if (status === "waiting") return <Clock className={cn(cls, "text-amber-600")} aria-hidden />;
  if (status === "failed") return <CircleAlert className={cn(cls, "text-destructive")} aria-hidden />;
  return <Circle className={cn(cls, "text-muted-foreground")} aria-hidden />;
}

/** 一条日志的文字：步骤变化、Hostinger 调用、警告和错误。 */
function describe(e: RunEvent): { text: string; tone: "muted" | "normal" | "warn" | "error" } {
  const p = e.payload as Record<string, unknown>;
  if (e.kind === "step") {
    const status = p.status as StepState["status"];
    return { text: `${p.name}：${STEP_TEXT[status]}${p.detail ? `，${p.detail}` : ""}`, tone: status === "failed" ? "error" : "normal" };
  }
  if (e.kind === "mcp") return { text: `Hostinger ${p.op}，${p.ms} 毫秒${p.ok ? "" : `，出错：${p.error}`}`, tone: p.ok ? "muted" : "warn" };
  if (e.kind === "warn") return { text: String(p.message), tone: "warn" };
  if (e.kind === "ai_text") {
    const cost = typeof p.cost === "number" ? `，$${p.cost.toFixed(4)}` : "";
    return { text: `AI ${p.task}${p.ok === false ? "（没通过检查）" : ""}${cost}：${String(p.preview ?? "").replace(/\s+/g, " ").slice(0, 160)}`, tone: p.ok === false ? "warn" : "muted" };
  }
  if (e.kind === "error") return { text: `${p.name}出错：${p.message}`, tone: "error" };
  return { text: JSON.stringify(p), tone: "muted" };
}

export function BatchesPage({ initialBatch, onNew }: { initialBatch: number | null; onNew: () => void }) {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [batchId, setBatchId] = useState<number | null>(initialBatch);
  const [sites, setSites] = useState<SiteProgress[]>([]);
  const [siteId, setSiteId] = useState<number | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [qa, setQa] = useState<QaView | null>(null);
  const [zoom, setZoom] = useState<QaView["shots"][number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  // 事件回调里要读到最新的选择，用 ref 避免反复重新订阅
  const sel = useRef({ batchId, siteId, siteIds: new Set<string>() });
  sel.current = { batchId, siteId, siteIds: new Set(sites.map((s) => String(s.id))) };

  const fail = (e: Error) => setError(e.message);
  const loadBatches = useCallback(() => call<BatchSummary[]>("batches.list").then(setBatches, fail), []);
  const loadSites = useCallback(() => {
    const id = sel.current.batchId;
    if (id != null) call<SiteProgress[]>("batches.sites", { batchId: id }).then(setSites, fail);
  }, []);
  const loadSite = useCallback(() => {
    const id = sel.current.siteId;
    if (id == null) return;
    call<StepState[]>("sites.steps", { siteId: id }).then(setSteps, fail);
    call<RunEvent[]>("sites.events", { siteId: id }).then(setEvents, fail);
    call<QaView | null>("sites.qa", { siteId: id }).then(setQa, fail);
  }, []);

  useEffect(() => {
    // 进度事件很密（每次 Hostinger 调用一条），刷新表格合并到 0.5 秒一次
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void loadBatches();
        loadSites();
      }, 500);
    };
    const offs = [
      onConnect(() => {
        void loadBatches();
        loadSites();
        loadSite();
      }),
      onChanged("batches", refreshSoon),
      onEvent((e) => {
        if (!e.siteId || !sel.current.siteIds.has(e.siteId)) return;
        if (e.kind === "step") refreshSoon();
        if (e.siteId !== String(sel.current.siteId)) return;
        setEvents((prev) => (prev.some((x) => x.seq === e.seq) ? prev : [...prev, e]));
        if (e.kind === "step") call<StepState[]>("sites.steps", { siteId: Number(e.siteId) }).then(setSteps, fail);
        if (e.kind === "step" && e.payload.step === "qa") call<QaView | null>("sites.qa", { siteId: Number(e.siteId) }).then(setQa, fail);
      }),
    ];
    return () => {
      clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [loadBatches, loadSites, loadSite]);

  // 默认选中最新的批次和其中第一个站
  useEffect(() => {
    if (batches && !batches.some((b) => b.id === batchId)) setBatchId(batches[0]?.id ?? null);
  }, [batches, batchId]);
  useEffect(() => {
    setSites([]);
    setSiteId(null);
    loadSites();
  }, [batchId, loadSites]);
  useEffect(() => {
    if (!sites.some((s) => s.id === siteId)) setSiteId(sites[0]?.id ?? null);
  }, [sites, siteId]);
  useEffect(() => {
    setSteps([]);
    setEvents([]);
    setQa(null);
    loadSite();
  }, [siteId, loadSite]);

  // 花括号不能省：新版 Chromium 的 scrollIntoView 返回 Promise，直接 return 会被 React 当成清理函数而崩溃
  useEffect(() => {
    void logEnd.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  const retry = async (id: number) => {
    setError(null);
    try {
      await call("sites.retry", { siteId: id });
      loadSites();
      loadSite();
    } catch (e) {
      fail(e as Error);
    }
  };

  const site = sites.find((s) => s.id === siteId) ?? null;

  if (batches && batches.length === 0) {
    return (
      <div className="flex max-w-5xl flex-col gap-6">
        <h1 className="text-lg font-semibold">批次</h1>
        <div className="rounded-lg border border-dashed p-8 text-sm">
          <p className="font-medium">还没有建站批次</p>
          <p className="mt-1 text-muted-foreground">在「建站」页填好经营主体和域名并提交，每个站的进度和日志会实时显示在这里。</p>
          <Button className="mt-4" onClick={onNew}>去建站</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold">批次</h1>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <div className="grid grid-cols-[13rem_minmax(0,1fr)] gap-6">
        <nav aria-label="批次列表" className="flex flex-col gap-1">
          {batches?.map((b) => (
            <button
              key={b.id}
              type="button"
              aria-current={b.id === batchId ? "true" : undefined}
              onClick={() => setBatchId(b.id)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                b.id === batchId ? "border-primary/40 bg-accent" : "border-transparent hover:bg-accent/60",
              )}
            >
              <span className="flex items-center justify-between font-medium">
                批次 {b.id}
                {b.active > 0 && <LoaderCircle className="size-3.5 text-primary motion-safe:animate-spin" aria-label="进行中" />}
              </span>
              <span className="block text-xs text-muted-foreground tabular-nums">{dateTime(b.createdAt)}，{b.total} 个站</span>
              <span className="block text-xs tabular-nums">
                完成 {b.done}
                {b.failed > 0 && <span className="text-destructive">，失败 {b.failed}</span>}
              </span>
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-col gap-6">
          <div className="rounded-lg border">
            <Table aria-label="站点进度">
              <TableHeader>
                <TableRow>
                  <TableHead>域名</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="w-48">进度</TableHead>
                  <TableHead>当前步骤</TableHead>
                  <TableHead className="w-0"><span className="sr-only">操作</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map((s) => (
                  <TableRow key={s.id} data-state={s.id === siteId ? "selected" : undefined} className="cursor-pointer" onClick={() => setSiteId(s.id)}>
                    <TableCell>
                      <button type="button" className="font-medium outline-none focus-visible:underline" aria-pressed={s.id === siteId} onClick={() => setSiteId(s.id)}>{s.domain}</button>
                    </TableCell>
                    <TableCell><Badge variant={SITE_STATUS[s.status].variant}>{SITE_STATUS[s.status].label}</Badge></TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={TOTAL} aria-valuenow={s.completed} aria-label={`${s.domain} 的进度`}>
                          <div className={cn("h-full rounded-full", s.status === "failed" ? "bg-destructive" : "bg-green-500")} style={{ width: `${(s.completed / TOTAL) * 100}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums">{s.completed}/{TOTAL}</span>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {s.status === "done" ? <span className="text-muted-foreground">已完成，维护模式中，等你检查后上线</span> : (s.currentStep ?? "—")}
                      {s.lastError && s.status !== "done" && <span className="mt-1 block max-w-96 text-xs text-destructive">{s.lastError}</span>}
                    </TableCell>
                    <TableCell>
                      {s.status === "failed" && (
                        <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); void retry(s.id); }}>
                          <RotateCcw aria-hidden />
                          重试
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {site && (
            <section aria-label={`${site.domain} 的详情`} className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
              <div>
                <h2 className="mb-3 text-sm font-medium">{site.domain}</h2>
                <ol aria-label="建站步骤" className="flex flex-col">
                  {steps.map((st, i) => (
                    <li key={st.key} className="relative flex gap-3 pb-4 last:pb-0">
                      {i < steps.length - 1 && <span className="absolute top-5 bottom-0 left-[7.5px] w-px bg-border" aria-hidden />}
                      <StepIcon status={st.status} />
                      <div className="min-w-0 -mt-0.5 text-sm">
                        <p className={cn(st.status === "pending" && "text-muted-foreground")}>
                          {st.name}
                          <span className="sr-only">：{STEP_TEXT[st.status]}</span>
                          {(st.status === "done" || st.status === "skipped") && seconds(st.startedAt, st.finishedAt) && (
                            <span className="ml-2 text-xs text-muted-foreground tabular-nums">{seconds(st.startedAt, st.finishedAt)}</span>
                          )}
                        </p>
                        {st.detail && <p className={cn("text-xs break-words", st.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{st.detail}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              <section aria-label="日志" className="min-w-0 rounded-lg border">
                <div className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
                  <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden />
                  日志
                </div>
                <ScrollArea className="h-80">
                  {events.length === 0 ? (
                    <p className="p-3 text-sm text-muted-foreground">任务开始后，每一步和每次 Hostinger 调用都会记在这里。</p>
                  ) : (
                    <ul className="p-1 text-sm">
                      {events.map((e) => {
                        const d = describe(e);
                        return (
                          <li key={e.seq} className="grid grid-cols-[4.5rem_1fr] gap-2 rounded px-2 py-0.5">
                            <span className="text-muted-foreground tabular-nums">{time(e.ts)}</span>
                            <span className={cn("break-words", d.tone === "muted" && "text-muted-foreground", d.tone === "warn" && "text-amber-700", d.tone === "error" && "text-destructive")}>{d.text}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div ref={logEnd} />
                </ScrollArea>
              </section>

              {qa && (
                <section aria-label="QA 报告" className="flex flex-col gap-3 lg:col-span-2">
                  <h3 className="text-sm font-medium">
                    QA 报告<span className="ml-2 font-normal text-muted-foreground tabular-nums">{new Date(qa.at).toLocaleString("zh-CN", { hour12: false })}</span>
                  </h3>
                  <ul className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2">
                    {qa.checks.map((c) => (
                      <li key={c.id} className="flex gap-2">
                        {c.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-green-600" aria-label="通过" />
                          : c.level === "block" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="没通过" />
                          : <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-label="提醒" />}
                        <div className="min-w-0">
                          <p>{c.name}</p>
                          <p className={cn("text-xs break-words", c.ok ? "text-muted-foreground" : c.level === "block" ? "text-destructive" : "text-amber-700")}>{c.detail}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {qa.shots.length > 0 && (
                    <ul aria-label="页面截图" className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      {qa.shots.map((shot) => (
                        <li key={shot.name}>
                          <button type="button" className="w-full overflow-hidden rounded-md border text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setZoom(shot)}>
                            <img src={shot.src} alt={`${SHOT_TEXT[shot.name] ?? shot.name}截图`} className="aspect-[4/3] w-full object-cover object-top" />
                            <span className="block px-2 py-1 text-xs">{SHOT_TEXT[shot.name] ?? shot.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </section>
          )}
        </div>
      </div>

      <Dialog open={zoom !== null} onOpenChange={(open) => !open && setZoom(null)}>
        <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{zoom && (SHOT_TEXT[zoom.name] ?? zoom.name)}</DialogTitle>
          </DialogHeader>
          {zoom && <img src={zoom.src} alt="" className="w-full rounded-md border" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
