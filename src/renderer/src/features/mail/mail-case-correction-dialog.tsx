import { useState } from "react";
import type { CaseSourceView } from "../../../../shared/mail-triage-types.ts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { call, invalidateCurrentTriageViews } from "@/lib/backend.ts";

export function MailCaseCorrectionDialog({ source, open = true, onOpenChange = () => {}, onConflict }: { source: CaseSourceView; open?: boolean; onOpenChange?: (open: boolean) => void; onConflict?: () => void }) {
  const [tag, setTag] = useState(source.tag ?? ""), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!/^\p{Script=Han}{2,6}$/u.test(tag) || !reason.trim()) { setError("短标签须为 2–6 个汉字，并填写更正依据。"); return; }
    setBusy(true); setError(null);
    try { await call("mail.triage.correct", { target: { type: "source", id: source.sourceId, sourceVersion: source.sourceVersion }, field: "tag", value: tag, requestId: crypto.randomUUID(), expectedVersion: source.manualVersion, reason: reason.trim() }); invalidateCurrentTriageViews(); onOpenChange(false); }
    catch (cause) { const message=(cause as Error).message; if(/version_conflict|版本冲突|source_version_conflict/.test(message)){setError("来源已变化。已重新读取，请核对新原文与差异后再更正。");onConflict?.();} else setError(message); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>更正来源分类</DialogTitle><DialogDescription>更正只绑定这封来源邮件与当前版本。证据链接用于核对，不会获得业务决定权限。</DialogDescription></DialogHeader>
    <div className="rounded-lg bg-muted p-3 text-sm"><strong>{source.mailboxAddress}</strong><span className="mt-1 block text-muted-foreground">来源版本 {source.sourceVersion} · {source.sourceTrust === "unconfirmed" ? "未知来源候选，须在待确认入口复核" : "已确认联系映射"}</span></div>
    <div className="grid gap-2"><Label htmlFor="correction-tag">短标签</Label><Input id="correction-tag" value={tag} onChange={event=>setTag(event.target.value)} maxLength={6} /></div>
    <div className="grid gap-2"><Label htmlFor="correction-reason">更正依据</Label><Input id="correction-reason" value={reason} onChange={event=>setReason(event.target.value)} placeholder="例如：按原文确认这是补件请求" /></div>
    {error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}<DialogFooter><Button variant="outline" onClick={()=>onOpenChange(false)}>取消</Button><Button disabled={busy} onClick={()=>void submit()}>{busy?"正在保存…":"保存更正"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
