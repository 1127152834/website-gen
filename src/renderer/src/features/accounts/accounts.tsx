import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import { LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { AccountSummary, DomainSummary } from "../../../../shared/protocol.ts";
import { call, useRpcData } from "@/lib/backend.ts";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm, toast } from "@/components/feedback";
import { Skeleton } from "@/components/page-state";
import { cn } from "@/lib/utils";
import { AbandonSiteButton } from "@/components/abandon-site.tsx";
import { accountSchema } from "./validation.ts";
export { accountSchema } from "./validation.ts";

const STATUS: Record<AccountSummary["status"], { label: string; variant: "secondary" | "outline" | "destructive" }> = {
  new: { label: "首次同步中", variant: "outline" }, ok: { label: "正常", variant: "secondary" }, auth_failed: { label: "Token 无效", variant: "destructive" }, error: { label: "同步出错", variant: "destructive" },
};
const DOMAIN_STATUS: Record<string, string> = { active: "正常", pending_setup: "待设置（还没选定域名）", expired: "已过期", pending_verification: "待验证" };
const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
function ago(ts: number | null): string { if (ts == null) return "从未"; const s = Math.round((ts - Date.now()) / 1000); if (Math.abs(s) < 60) return "刚刚"; if (Math.abs(s) < 3600) return rtf.format(Math.round(s / 60), "minute"); if (Math.abs(s) < 86400) return rtf.format(Math.round(s / 3600), "hour"); return rtf.format(Math.round(s / 86400), "day"); }
const daysLeft = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
type AccountValues = z.infer<typeof accountSchema>;

export function AccountsPage() {
  const [selected, setSelected] = useState<number | null>(null);
  const [syncingIds, setSyncingIds] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const confirm = useConfirm();
  const { data: accounts, loading, refreshing, error: loadError, refresh, invalidate } = useRpcData<AccountSummary[]>("accounts.list", undefined, { topics: ["accounts"] });
  const { data: domains = [], error: domainsError, refresh: refreshDomains, invalidate: invalidateDomains } = useRpcData<DomainSummary[]>("accounts.domains", selected == null ? null : { id: selected }, { topics: ["accounts"] });
  useEffect(() => { if (domainsError) setError(domainsError.message); }, [domainsError]);
  useEffect(() => { if (accounts && !accounts.some((account) => account.id === selected)) setSelected(accounts[0]?.id ?? null); }, [accounts, selected]);

  const reload = () => { invalidate(); invalidateDomains(); void Promise.all([refresh(), refreshDomains()]).catch((reason: Error) => setError(reason.message)); };
  const syncNow = async (id: number) => { setError(null); setSyncingIds((current) => new Set(current).add(id)); try { await call("accounts.sync", { id }); toast("账号资源已同步"); } catch (reason) { setError(`同步没有完成：${(reason as Error).message}`); } finally { setSyncingIds((current) => { const next = new Set(current); next.delete(id); return next; }); reload(); } };
  const remove = async (account: AccountSummary) => { if (!await confirm({ title: `删除账号「${account.label}」？`, description: "只删除当前工作区的 Token 和同步快照，不影响 Hostinger 上的网站、域名和邮箱。", confirmText: "删除账号", destructive: true })) return; try { await call("accounts.remove", { id: account.id }); toast("账号已移除"); reload(); } catch (reason) { setError(`删除没有完成：${(reason as Error).message}`); } };
  const accountColumns = useMemo<ColumnDef<AccountSummary, any>[]>(() => [
    { accessorKey: "label", header: "账号", cell: ({ row }) => <button type="button" className="text-left outline-none focus-visible:underline" onClick={() => setSelected(row.original.id)} aria-pressed={row.original.id === selected}><span className="font-medium">{row.original.label}</span><span className="block text-xs text-muted-foreground tabular-nums">Token 尾号 {row.original.tokenHint}</span></button> },
    { accessorKey: "status", header: "状态", cell: ({ row }) => { const syncing = syncingIds.has(row.original.id); const status = syncing ? { label: "同步中", variant: "outline" as const } : STATUS[row.original.status]; return <div><Badge variant={status.variant}>{status.label}</Badge>{row.original.lastError && !syncing && <span className="mt-1 block max-w-60 whitespace-normal text-xs text-destructive">{row.original.lastError}</span>}</div>; } },
    { id: "orders", accessorFn: (row) => row.counts.orders, header: "订单", cell: ({ row }) => <span className="tabular-nums">{row.original.counts.orders}</span> },
    { id: "websites", accessorFn: (row) => row.counts.websites, header: "网站", cell: ({ row }) => <span className="tabular-nums">{row.original.counts.websites}</span> },
    { id: "domains", accessorFn: (row) => row.counts.domains, header: "域名", cell: ({ row }) => <span className="tabular-nums">{row.original.counts.domains}</span> },
    { id: "mailOrders", accessorFn: (row) => row.counts.mailOrders, header: "邮箱订单", cell: ({ row }) => <span className="tabular-nums">{row.original.counts.mailOrders}</span> },
    { accessorKey: "lastSyncedAt", header: "上次同步", cell: ({ row }) => <span className="text-muted-foreground">{ago(row.original.lastSyncedAt)}</span> },
  ], [selected, syncingIds]);
  const current = accounts?.find((account) => account.id === selected) ?? null;
  const domainColumns = useMemo<ColumnDef<DomainSummary, any>[]>(() => [
    { accessorKey: "domain", header: "域名", cell: ({ row }) => <span className="font-medium">{row.original.domain || <span className="font-normal text-muted-foreground">（待设置的域名）</span>}</span> },
    { accessorKey: "status", header: "状态", cell: ({ row }) => <span className="text-muted-foreground">{DOMAIN_STATUS[row.original.status ?? ""] ?? row.original.status ?? "—"}</span> },
    { accessorKey: "expiresAt", header: "到期", cell: ({ row }) => { const left = row.original.expiresAt ? daysLeft(row.original.expiresAt) : null; return <span className={cn("tabular-nums", left !== null && left <= 30 ? "text-amber-600" : "text-muted-foreground")}>{row.original.expiresAt ? new Date(row.original.expiresAt).toLocaleDateString("zh-CN") : "—"}{left !== null && left <= 30 && `（${left} 天后到期）`}</span>; } },
    { id: "website", accessorFn: (row) => row.hasWebsite ? "yes" : "no", header: "网站", cell: ({ row }) => row.original.hasWebsite ? "已建站" : <span className="text-muted-foreground">空闲</span> },
    { id: "mail", accessorFn: (row) => row.hasMail ? "yes" : "no", header: "邮箱", cell: ({ row }) => row.original.hasMail ? "已开通" : <span className="text-muted-foreground">未开通</span> },
  ], []);

  return <div className="flex min-w-0 max-w-6xl flex-col gap-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="text-2xl font-semibold tracking-tight">Hostinger 账号</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">每个账号使用独立 API Token 接入并加密保存，系统每 30 分钟同步订单、网站、域名和邮箱。</p></div><Button onClick={() => setAdding(true)}><Plus aria-hidden />添加账号</Button></div>
    {refreshing && accounts && <p role="status" className="fixed right-4 bottom-4 text-xs text-muted-foreground">刷新中…</p>}{(error || loadError) && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error ?? loadError?.message}</p>}
    {loading && !error ? <Skeleton label="正在读取账号" /> : accounts && <DataTable data={accounts} columns={accountColumns} searchKey="label" searchPlaceholder="搜索账号…" filterKey="status" filterOptions={Object.entries(STATUS).map(([value, item]) => ({ value, label: item.label }))} getRowId={(account) => String(account.id)} emptyMessage="还没有接入账号。添加 Hostinger 账号后，这里会显示同步资源。" rowActions={(account) => <div className="flex justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => void syncNow(account.id)} disabled={syncingIds.has(account.id)}>{syncingIds.has(account.id) ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}同步</Button><Button variant="ghost" size="icon" aria-label={`删除账号 ${account.label}`} onClick={() => void remove(account)}><Trash2 aria-hidden /></Button></div>} />}
    {current && <section aria-label="域名" className="space-y-3"><div><h2 className="font-semibold">{current.label} 的域名 <span className="ml-2 font-normal text-muted-foreground tabular-nums">{domains.length} 个</span></h2><p className="mt-1 text-sm text-muted-foreground">选择上方账号查看其域名、网站和邮箱状态。</p></div><DataTable data={domains} columns={domainColumns} searchKey="domain" searchPlaceholder="搜索域名…" filterKey="status" filterOptions={Object.entries(DOMAIN_STATUS).map(([value, label]) => ({ value, label }))} getRowId={(domain) => String(domain.id)} emptyMessage={current.lastSyncedAt ? "这个账号下没有域名。" : "同步完成后会在这里列出域名。"} rowActions={(domain) => domain.domain ? <AbandonSiteButton domain={domain.domain} accountId={current.id} onDone={reload} /> : null} /></section>}
    <AddAccountDialog open={adding} onOpenChange={setAdding} onAdded={reload} />
  </div>;
}

function AddAccountDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<AccountValues>({ resolver: zodResolver(accountSchema), defaultValues: { label: "", token: "" } });
  const close = (next: boolean) => { if (!next) { form.reset(); setServerError(null); } onOpenChange(next); };
  const submit = form.handleSubmit(async ({ label, token }) => { setServerError(null); try { await call("accounts.add", { label: label.trim(), token: token.trim() }); close(false); toast("Hostinger 账号已接入，正在同步资源"); onAdded(); } catch (reason) { setServerError((reason as Error).message); } });
  return <Dialog open={open} onOpenChange={close}><DialogContent><form onSubmit={(event) => void submit(event)} className="grid gap-4" noValidate><DialogHeader><DialogTitle>添加 Hostinger 账号</DialogTitle><DialogDescription>在 hPanel 的「账户 → API」生成 Token。Token 加密保存，添加后不会再次显示。</DialogDescription></DialogHeader><div className="grid gap-2"><Label htmlFor="account-label">名称</Label><Input id="account-label" placeholder="例如：主账号" autoFocus aria-invalid={Boolean(form.formState.errors.label)} aria-describedby={form.formState.errors.label ? "account-label-error" : undefined} {...form.register("label")} />{form.formState.errors.label && <p id="account-label-error" role="alert" className="text-xs text-destructive">{form.formState.errors.label.message}</p>}</div><div className="grid gap-2"><Label htmlFor="account-token">API Token</Label><Input id="account-token" type="password" autoComplete="off" spellCheck={false} aria-invalid={Boolean(form.formState.errors.token)} aria-describedby={form.formState.errors.token ? "account-token-error" : undefined} {...form.register("token")} />{form.formState.errors.token && <p id="account-token-error" role="alert" className="text-xs text-destructive">{form.formState.errors.token.message}</p>}</div>{serverError && <p role="alert" className="text-sm text-destructive">{serverError}</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => close(false)}>取消</Button><Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}{form.formState.isSubmitting ? "正在验证" : "验证并添加"}</Button></DialogFooter></form></DialogContent></Dialog>;
}
