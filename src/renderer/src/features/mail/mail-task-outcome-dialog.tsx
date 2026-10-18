import { useMemo, useState } from "react";
import type { TaskView } from "../../../../shared/mail-triage-types.ts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { call, invalidateCurrentTriageViews } from "@/lib/backend.ts";

export function MailTaskOutcomeDialog({ caseId, tasks, expectedVersion, open = true, onOpenChange = () => {}, onConflict }: { caseId: string; tasks: TaskView[]; expectedVersion: number; open?: boolean; onOpenChange?: (open: boolean) => void; onConflict?: () => void }) {
  const eligible = useMemo(() => tasks.filter(task => task.state === "open" || task.state === "blocked"), [tasks]);
  const [selected, setSelected] = useState<string[]>([]), [outcome, setOutcome] = useState<"action_completed" | "dismissed">("action_completed"), [reason, setReason] = useState(""), [completedItems, setCompletedItems] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const selectedTasks = eligible.filter(task => selected.includes(task.id));
  const submit = async () => {
    if (!selected.length || !reason.trim()) { setError("请选择具体义务并填写处理依据。"); return; }
    if (outcome === "action_completed" && (selectedTasks.length !== 1 || selectedTasks[0]!.kind !== "action")) { setError("完成操作每次只能选择一项操作义务；回复必须从原邮件发送并取得收据。"); return; }
    if (outcome === "action_completed" && selectedTasks[0]!.requestedItems.length>0 && completedItems.length===0) { setError("请选择本次实际完成的至少一项材料；未选择的材料会继续保持开放。"); return; }
    setBusy(true); setError(null);
    try {
      await call("mail.tasks.recordOutcome", { caseId, taskIds: selected, outcome, ...(outcome === "action_completed" && selectedTasks[0]!.requestedItems.length>0 ? { completedItems } : {}), requestId: crypto.randomUUID(), expectedVersion, reason: reason.trim() });
      invalidateCurrentTriageViews(); onOpenChange(false);
    } catch (cause) {
      const message = (cause as Error).message;
      if (/version_conflict|版本冲突|task_version_conflict/.test(message)) { setError("申请已被其他操作更新。已重新读取，请核对差异后再提交。"); onConflict?.(); }
      else setError(message);
    } finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>记录处理结果</DialogTitle><DialogDescription>只更新所选义务。签名、发信或材料提交都不会自动把整项申请标为获批。</DialogDescription></DialogHeader>
    <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">选择具体义务</legend>{eligible.map(task => <label key={task.id} className="flex items-start gap-3 rounded-lg border p-3 text-sm"><input type="checkbox" checked={selected.includes(task.id)} onChange={event => setSelected(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id))} className="mt-1" /><span><strong className="block">{task.title}</strong><span className="text-muted-foreground">{task.kind === "reply" ? "回复义务需通过原邮件发送，不能在这里假称已回复。" : task.requestedItems.join("、") || "没有拆分材料项"}</span></span></label>)}</fieldset>
    <div className="grid gap-2"><Label htmlFor="task-outcome">处理结果</Label><select id="task-outcome" value={outcome} onChange={event => setOutcome(event.target.value as typeof outcome)} className="h-9 rounded-md border bg-background px-3 text-sm"><option value="action_completed">已完成所选操作</option><option value="dismissed">经核对无需处理</option></select></div>
    {outcome === "action_completed" && selectedTasks[0]?.requestedItems.length ? <fieldset className="space-y-2"><legend className="text-sm font-medium">本次实际完成的材料</legend>{selectedTasks[0].requestedItems.map(item => <label key={item} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={completedItems.includes(item)} onChange={event => setCompletedItems(current => event.target.checked ? [...current, item] : current.filter(value => value !== item))} />{item}</label>)}</fieldset> : null}
    <div className="grid gap-2"><Label htmlFor="task-reason">处理依据</Label><Input id="task-reason" value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：已在平台官网逐项上传" /></div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={busy || !selected.length} onClick={() => void submit()}>{busy ? "正在保存…" : "保存具体结果"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

