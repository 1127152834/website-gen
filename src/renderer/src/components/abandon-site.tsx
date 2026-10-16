import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { call } from "@/lib/backend.ts";
import { toast } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";

type AbandonStep = {
  key: "local_mail" | "remote_mail" | "website" | "domain_renewal" | "finalize";
  name: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string | null;
};

export type AbandonJob = {
  id: number | string;
  status: "queued" | "running" | "failed" | "done";
  domain: string;
  retryable: boolean;
  error?: string | null;
  steps: AbandonStep[];
  updatedAt: number;
};

const CONSEQUENCES = [
  "停止该域名所有邮箱监听，并清除本工作区保存的邮箱凭据和邮件缓存。",
  "永久删除该域名的所有邮箱和别名；没有邮箱后，关闭邮箱订阅自动续费。",
  "永久删除 Hostinger 上的网站（如果存在）。",
  "关闭域名自动续费；域名不会立即删除，而是在到期后自然失效。",
  "把站点标记为已放弃、从活跃列表隐藏，并永远不再用于新批次或邮件监听。",
] as const;

function StepIcon({ status }: { status: AbandonStep["status"] }) {
  if (status === "running") return <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" aria-hidden />;
  if (status === "done" || status === "skipped") return <CircleCheck className="size-4 shrink-0 text-emerald-600" aria-hidden />;
  if (status === "failed") return <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />;
  return <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

export function AbandonSiteButton({ domain, siteId, accountId, onDone, statusOnly = false }: { domain: string; siteId?: number; accountId?: number; onDone?: () => void; statusOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [job, setJob] = useState<AbandonJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !job || (job.status !== "queued" && job.status !== "running")) return;
    const refresh = async () => {
      try {
        const next = await call<AbandonJob | null>("abandon.status", { jobId: job.id });
        if (!next) return;
        setJob(next);
        if (next.status === "done") { toast(`${domain} 已放弃`); onDone?.(); }
      } catch (reason) { setError((reason as Error).message); }
    };
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(timer);
  }, [domain, job, onDone, open]);

  const start = async () => {
    if (typed.trim().toLowerCase() !== domain.toLowerCase()) return;
    setBusy(true); setError(null);
    try {
      const next = await call<AbandonJob>("abandon.start", { domain, siteId, accountId, confirmation: typed.trim() });
      setJob(next);
      if (next.status === "done") { toast(`${domain} 已放弃`); onDone?.(); }
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  const retry = async () => {
    if (!job) return;
    setBusy(true); setError(null);
    try { setJob(await call<AbandonJob>("abandon.retry", { jobId: job.id })); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next && job?.status !== "running" && job?.status !== "queued") { setTyped(""); setJob(null); setError(null); }
  };

  const show = async () => {
    setOpen(true); setError(null);
    if (!statusOnly) return;
    setBusy(true);
    try {
      // 任务可能从站点页或账号页的另一入口创建；域名才是跨入口稳定标识。
      const existing = await call<AbandonJob | null>("abandon.status", { domain });
      if (existing) setJob(existing);
      else setError("没有找到这个域名的放弃任务记录。");
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  return <>
    <Button variant={statusOnly ? "outline" : "destructive"} size="sm" onClick={() => void show()}>{statusOnly ? <CircleDashed aria-hidden /> : <Trash2 aria-hidden />}{statusOnly ? "查看放弃进度" : "放弃这个站点"}</Button>
    <ConfirmDialog open={open && !job && !statusOnly} onOpenChange={changeOpen} title={`放弃 ${domain}？`} desc="这是破坏性后台任务。每一步都会核验，失败后可以从未完成步骤重试。" destructive confirmText={busy ? "正在提交…" : "永久放弃"} disabled={busy || typed.trim().toLowerCase() !== domain.toLowerCase()} handleConfirm={() => void start()}>
      <ol className="list-decimal space-y-2 pl-5 text-sm">{CONSEQUENCES.map((item) => <li key={item}>{item}</li>)}</ol>
      <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">邮箱、别名和网站删除后无法由本应用恢复。域名本身不会被删除，只会关闭自动续费。</p>
      <div className="space-y-2"><Label htmlFor={`abandon-${domain}`}>输入域名 <strong>{domain}</strong> 以确认</Label><Input id={`abandon-${domain}`} autoComplete="off" value={typed} onChange={event => setTyped(event.target.value)} /></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </ConfirmDialog>
    <Dialog open={open && (job !== null || statusOnly)} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>放弃 {domain}？</DialogTitle>
          <DialogDescription>这是破坏性后台任务。每一步都会核验，失败后可以从未完成步骤重试。</DialogDescription>
        </DialogHeader>
        {job ? <div className="space-y-4" aria-live="polite">
          <p className={cn("text-sm font-medium", job.status === "failed" && "text-destructive")}>{job.status === "done" ? "已完成" : job.status === "failed" ? "任务停在失败步骤" : "后台正在处理，可关闭此窗口"}</p>
          <ol className="space-y-3">{job.steps.map((step) => <li key={step.key} className="flex gap-2 text-sm"><StepIcon status={step.status} /><span><span className="font-medium">{step.name}</span>{step.detail && <span className={cn("mt-0.5 block text-xs text-muted-foreground", step.status === "failed" && "text-destructive")}>{step.detail}</span>}</span></li>)}</ol>
          {(error || job.error) && <p role="alert" className="text-sm text-destructive">{error ?? job.error}</p>}
        </div> : <p className="py-6 text-center text-sm text-muted-foreground">{busy ? "正在读取任务进度…" : "暂无任务进度。"}</p>}
        {error && !job && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => changeOpen(false)}>{job?.status === "done" ? "关闭" : "稍后查看"}</Button>
          {job?.status === "failed" && job.retryable && <Button disabled={busy} onClick={() => void retry()}>{busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}从失败步骤重试</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
