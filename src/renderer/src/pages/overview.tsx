import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, CircleCheck, LoaderCircle, Play } from "lucide-react";
import type { RunEvent } from "../../../shared/protocol.ts";
import { call, onConnect, onEvent } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type StepPayload = { step: number; total: number; name: string; status: "running" | "done" };
const time = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });

export function OverviewPage({ connected }: { connected: boolean }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const logEnd = useRef<HTMLDivElement>(null);

  // 按 seq 去重合并：连上（或重连）时补发漏掉的事件，之后靠推送
  const merge = (incoming: RunEvent[]) => {
    const fresh = incoming.filter((e) => e.seq > lastSeq.current);
    if (fresh.length === 0) return;
    lastSeq.current = fresh[fresh.length - 1].seq;
    setEvents((prev) => [...prev, ...fresh]);
  };

  useEffect(() => {
    const offEvent = onEvent((e) => merge([e]));
    const offConnect = onConnect(() => {
      call<RunEvent[]>("events.since", { afterSeq: lastSeq.current }).then(merge, (e: Error) => setError(e.message));
    });
    return () => {
      offEvent();
      offConnect();
    };
  }, []);

  // 花括号不能省：新版 Chromium 的 scrollIntoView 返回 Promise，直接 return 会被 React 当成清理函数而崩溃
  useEffect(() => {
    void logEnd.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  // 进度轨道只显示最近一次示例任务
  const run = useMemo(() => {
    const steps = events.filter((e) => e.kind === "step");
    const siteId = steps.at(-1)?.siteId;
    if (!siteId) return null;
    const mine = steps.filter((e) => e.siteId === siteId).map((e) => e.payload as unknown as StepPayload);
    const last = mine.at(-1)!;
    return { total: last.total, reached: last.step, done: last.status === "done", names: mine.map((s) => s.name) };
  }, [events]);
  const running = run !== null && !run.done;

  const start = () => {
    setError(null);
    call("demo.start").catch((e: Error) => setError(e.message));
  };

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <CardTitle>示例任务</CardTitle>
        <CardDescription>模拟一次建站的 7 个步骤，用来检查进度推送和日志补发。关掉窗口再打开，日志会从数据库补回来。</CardDescription>
        <CardAction>
          <Button onClick={start} disabled={!connected || running}>
            {running ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Play aria-hidden />}
            {running ? "运行中" : "运行示例任务"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error && <p role="alert" className="text-sm text-destructive">操作没有完成：{error}</p>}

        <ol className="grid grid-cols-7 gap-2" aria-label="建站步骤">
          {Array.from({ length: run?.total ?? 7 }, (_, i) => {
            const n = i + 1;
            const state = !run || n > run.reached ? "pending" : n < run.reached || run.done ? "done" : "current";
            return (
              <li key={n} className="flex flex-col gap-2">
                <div className={cn("h-1.5 rounded-full", state === "pending" ? "bg-muted" : "bg-green-500")} />
                <div className="flex items-center gap-1.5 text-xs">
                  {state === "done" && <CircleCheck className="size-3.5 text-green-600" aria-hidden />}
                  {state === "current" && <LoaderCircle className="size-3.5 text-green-600 motion-safe:animate-spin" aria-hidden />}
                  {state === "pending" && <Circle className="size-3.5 text-muted-foreground" aria-hidden />}
                  <span className={cn("tabular-nums", state === "pending" && "text-muted-foreground")}>第 {n} 步</span>
                </div>
                <span className={cn("text-sm", state === "pending" ? "text-muted-foreground" : "font-medium")}>{run?.names[i] ?? "—"}</span>
              </li>
            );
          })}
        </ol>

        <section aria-label="事件日志" className="rounded-lg border">
          <div className="flex items-center justify-between border-b px-3 py-2 text-sm">
            <span className="font-medium">事件日志</span>
            {run?.done && <Badge variant="secondary">已完成</Badge>}
          </div>
          <ScrollArea className="h-64">
            {events.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">还没有事件。点「运行示例任务」，进度会实时出现在这里。</p>
            ) : (
              <ul className="p-1 text-sm">
                {events.map((e) => {
                  const p = e.payload as unknown as StepPayload;
                  return (
                    <li key={e.seq} className="grid grid-cols-[3.5rem_5rem_1fr] gap-2 rounded px-2 py-1 tabular-nums">
                      <span className="text-muted-foreground">#{e.seq}</span>
                      <span className="text-muted-foreground">{time(e.ts)}</span>
                      <span>
                        第 {p.step}/{p.total} 步：{p.name}
                        {p.status === "done" && "，全部完成"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <div ref={logEnd} />
          </ScrollArea>
        </section>
      </CardContent>
    </Card>
  );
}
