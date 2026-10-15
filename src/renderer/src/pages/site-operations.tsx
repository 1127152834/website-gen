import { useMemo, useState } from "react";
import { Circle, CircleAlert, CircleCheck, CircleDashed, Clock, LoaderCircle } from "lucide-react";
import type { RunEvent, RunEventKind, StepState } from "../../../shared/protocol.ts";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const STEP_TEXT: Record<StepState["status"], string> = {
  pending: "未开始",
  running: "进行中",
  waiting: "等待中",
  done: "完成",
  skipped: "已跳过",
  failed: "失败",
};

const KIND_TEXT: Record<RunEventKind, string> = {
  step: "步骤",
  mcp: "Hostinger",
  ai_text: "AI 文本",
  ai_thinking: "AI 思考",
  ai_tool: "AI 工具",
  warn: "提醒",
  error: "错误",
};

type LogTone = "normal" | "muted" | "warn" | "error";

function StepIcon({ status }: { status: StepState["status"] }) {
  const className = "size-4 shrink-0";
  if (status === "done" || status === "skipped") return <CircleCheck className={cn(className, "text-emerald-600 dark:text-emerald-400")} aria-hidden />;
  if (status === "running") return <LoaderCircle className={cn(className, "text-primary motion-safe:animate-spin")} aria-hidden />;
  if (status === "waiting") return <Clock className={cn(className, "text-amber-600 dark:text-amber-400")} aria-hidden />;
  if (status === "failed") return <CircleAlert className={cn(className, "text-destructive")} aria-hidden />;
  return <Circle className={cn(className, "text-muted-foreground")} aria-hidden />;
}

const seconds = (from: number | null, to: number | null) =>
  from != null && to != null ? `${Math.max(1, Math.round((to - from) / 1_000))} 秒` : null;

export function StepTimeline({ steps, emptyText = "任务开始后会在这里显示每一步。" }: { steps: StepState[]; emptyText?: string }) {
  if (steps.length === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <ol aria-label="建站步骤" className="flex flex-col">
      {steps.map((step, index) => (
        <li key={step.key} className="relative flex gap-3 pb-4 last:pb-0">
          {index < steps.length - 1 && <span className="absolute top-5 bottom-0 left-[7.5px] w-px bg-border" aria-hidden />}
          <StepIcon status={step.status} />
          <div className="-mt-0.5 min-w-0 text-sm">
            <p className={cn("font-medium", step.status === "pending" && "font-normal text-muted-foreground")}>
              {step.name}
              <span className="sr-only">：{STEP_TEXT[step.status]}</span>
              {(step.status === "done" || step.status === "skipped") && seconds(step.startedAt, step.finishedAt) && (
                <span className="ml-2 font-normal text-xs text-muted-foreground tabular-nums">{seconds(step.startedAt, step.finishedAt)}</span>
              )}
            </p>
            {step.detail && <p className={cn("mt-0.5 break-words text-xs", step.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{step.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function describeEvent(event: RunEvent): { text: string; tone: LogTone } {
  const payload = event.payload as Record<string, unknown>;
  if (event.kind === "step") {
    const status = payload.status as StepState["status"];
    return { text: `${String(payload.name ?? payload.step ?? "步骤")}：${STEP_TEXT[status] ?? status}${payload.detail ? `，${String(payload.detail)}` : ""}`, tone: status === "failed" ? "error" : status === "waiting" ? "warn" : "normal" };
  }
  if (event.kind === "mcp") return { text: `Hostinger ${String(payload.op ?? "调用")}，${String(payload.ms ?? "—")} 毫秒${payload.ok ? "" : `，出错：${String(payload.error ?? "未知错误")}`}`, tone: payload.ok ? "muted" : "warn" };
  if (event.kind === "warn") return { text: String(payload.message ?? "需要注意"), tone: "warn" };
  if (event.kind === "ai_tool" && payload.change) return { text: `变更 #${String(payload.change)}：${String(payload.summary ?? "已应用")}`, tone: "normal" };
  if (event.kind === "ai_text") {
    const cost = typeof payload.cost === "number" ? `，$${payload.cost.toFixed(4)}` : "";
    return { text: `AI ${String(payload.task ?? "任务")}${payload.ok === false ? "（没通过检查）" : ""}${cost}：${String(payload.preview ?? "").replace(/\s+/g, " ").slice(0, 180)}`, tone: payload.ok === false ? "warn" : "muted" };
  }
  if (event.kind === "error") return { text: `${String(payload.name ?? "任务")}出错：${String(payload.message ?? "未知错误")}`, tone: "error" };
  if (event.kind === "ai_thinking") return { text: `AI 思考：${String(payload.preview ?? payload.text ?? "").replace(/\s+/g, " ").slice(0, 180)}`, tone: "muted" };
  return { text: JSON.stringify(payload), tone: "muted" };
}

const time = (timestamp: number) => new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });

export function LogViewer({ events, className }: { events: RunEvent[]; className?: string }) {
  const [level, setLevel] = useState<"all" | "normal" | "warn" | "error">("all");
  const [kind, setKind] = useState<"all" | RunEventKind>("all");
  const rows = useMemo(() => events.map((event) => ({ event, description: describeEvent(event) })), [events]);
  const filtered = useMemo(() => rows.filter(({ event, description }) => {
    const levelMatch = level === "all" || (level === "normal" ? description.tone === "normal" || description.tone === "muted" : description.tone === level);
    return levelMatch && (kind === "all" || event.kind === kind);
  }), [kind, level, rows]);

  return (
    <section aria-label="运行日志" className={cn("min-w-0 overflow-hidden rounded-lg border bg-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <h3 className="flex items-center gap-2 text-sm font-medium"><CircleDashed className="size-4 text-muted-foreground" aria-hidden />运行日志</h3>
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5">级别
            <select value={level} onChange={(event) => setLevel(event.target.value as typeof level)} className="h-8 rounded-md border border-input bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="all">全部</option><option value="normal">常规</option><option value="warn">提醒</option><option value="error">错误</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">类型
            <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className="h-8 rounded-md border border-input bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="all">全部</option>
              {(Object.keys(KIND_TEXT) as RunEventKind[]).map((value) => <option key={value} value={value}>{KIND_TEXT[value]}</option>)}
            </select>
          </label>
        </div>
      </div>
      <ScrollArea className="h-80">
        {events.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">任务开始后，步骤、AI 和 Hostinger 调用会记录在这里。</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">当前筛选条件下没有日志。</p>
        ) : (
          <ul className="p-2 text-sm">
            {filtered.map(({ event, description }) => (
              <li key={event.seq} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
                <span className="text-xs text-muted-foreground tabular-nums">{time(event.ts)}</span>
                <span className={cn("break-words text-xs leading-5", description.tone === "muted" && "text-muted-foreground", description.tone === "warn" && "text-amber-700 dark:text-amber-400", description.tone === "error" && "text-destructive")}>{description.text}</span>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </section>
  );
}
