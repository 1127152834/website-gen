import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AccountSummary, DomainSummary } from "../../../shared/protocol.ts";
import { call, useRpcData } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm, toast } from "@/components/feedback";
import { Skeleton } from "@/components/page-state";
import { cn } from "@/lib/utils";
import { AbandonSiteButton } from "@/components/abandon-site.tsx";

const STATUS: Record<AccountSummary["status"], { label: string; variant: "secondary" | "outline" | "destructive" }> = {
  new: { label: "首次同步中", variant: "outline" },
  ok: { label: "正常", variant: "secondary" },
  auth_failed: { label: "Token 无效", variant: "destructive" },
  error: { label: "同步出错", variant: "destructive" },
};

const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
function ago(ts: number | null): string {
  if (ts == null) return "从未";
  const s = Math.round((ts - Date.now()) / 1000);
  if (Math.abs(s) < 60) return "刚刚";
  if (Math.abs(s) < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (Math.abs(s) < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}
const DOMAIN_STATUS: Record<string, string> = { active: "正常", pending_setup: "待设置（还没选定域名）", expired: "已过期", pending_verification: "待验证" };
const daysLeft = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);

export function AccountsPage() {
  const [selected, setSelected] = useState<number | null>(null);
  const [syncingIds, setSyncingIds] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const confirm = useConfirm();

  const { data: accounts, loading, refreshing, error: loadError, refresh, invalidate } = useRpcData<AccountSummary[]>("accounts.list", undefined, { topics: ["accounts"] });
  const { data: domains = [], error: domainsError, refresh: refreshDomains, invalidate: invalidateDomains } = useRpcData<DomainSummary[]>("accounts.domains", selected == null ? null : { id: selected }, { topics: ["accounts"] });
  useEffect(() => { if (domainsError) setError(domainsError.message); }, [domainsError]);

  // 默认选中第一个账号；被删掉时换一个
  useEffect(() => {
    if (!accounts) return;
    if (!accounts.some((a) => a.id === selected)) setSelected(accounts[0]?.id ?? null);
  }, [accounts, selected]);

  const syncNow = async (id: number) => {
    setError(null);
    setSyncingIds((s) => new Set(s).add(id));
    try {
      await call("accounts.sync", { id });
      toast("账号资源已同步");
    } catch (e) {
      setError(`同步没有完成：${(e as Error).message}`);
    } finally {
      setSyncingIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      invalidate(); invalidateDomains(); await Promise.all([refresh(), refreshDomains()]);
    }
  };

  const remove = async (account: AccountSummary) => {
    if (!await confirm({ title: `删除账号「${account.label}」？`, description: "只删除当前工作区的 Token 和同步快照，不影响 Hostinger 上的网站、域名和邮箱。", confirmText: "删除账号", destructive: true })) return;
    try {
      await call("accounts.remove", { id: account.id });
      toast("账号已移除");
      invalidate(); await refresh();
    } catch (e) {
      setError(`删除没有完成：${(e as Error).message}`);
    }
  };

  const current = accounts?.find((a) => a.id === selected) ?? null;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Hostinger 账号</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            每个账号用一个 API Token 接入。Token 加密保存在你的工作区，系统会同步账号下的主机订单、网站、域名和邮箱，每 30 分钟自动更新一次。
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus aria-hidden />
          添加账号
        </Button>
      </div>

      {refreshing && accounts && <p role="status" className="fixed right-4 bottom-4 text-xs text-muted-foreground">刷新中…</p>}
      {(error || loadError) && <p role="alert" className="text-sm text-destructive">{error ?? loadError?.message}</p>}

      {loading && !error && <Skeleton label="正在读取账号" />}
      {accounts && accounts.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-sm">
          <p className="font-medium">还没有接入账号</p>
          <p className="mt-1 text-muted-foreground">添加一个 Hostinger 账号后，这里会列出它的订单、网站、域名和邮箱，建站时也会用到这些数据。</p>
        </div>
      )}

      {accounts && accounts.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>账号</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">订单</TableHead>
                <TableHead className="text-right">网站</TableHead>
                <TableHead className="text-right">域名</TableHead>
                <TableHead className="text-right">邮箱订单</TableHead>
                <TableHead>上次同步</TableHead>
                <TableHead className="w-0"><span className="sr-only">操作</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => {
                const syncing = syncingIds.has(a.id);
                const status = syncing ? { label: "同步中", variant: "outline" as const } : STATUS[a.status];
                return (
                  // 整行都能点：之前只有账号名那几个字能点，点空白处没反应
                  <TableRow key={a.id} data-state={a.id === selected ? "selected" : undefined} className="cursor-pointer" onClick={() => setSelected(a.id)}>
                    <TableCell>
                      <button type="button" className="text-left outline-none focus-visible:underline" onClick={() => setSelected(a.id)} aria-pressed={a.id === selected}>
                        <span className="font-medium">{a.label}</span>
                        <span className="block text-xs text-muted-foreground tabular-nums">Token 尾号 {a.tokenHint}</span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                      {/* 表格单元格默认不换行，错误提示要允许换行，否则会把右边几列挤歪 */}
                      {a.lastError && !syncing && <span className="mt-1 block max-w-60 whitespace-normal text-xs text-destructive">{a.lastError}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{a.counts.orders}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.counts.websites}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.counts.domains}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.counts.mailOrders}</TableCell>
                    <TableCell className="text-muted-foreground">{ago(a.lastSyncedAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); void syncNow(a.id); }} disabled={syncing}>
                          {syncing ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                          同步
                        </Button>
                        <Button variant="ghost" size="icon" aria-label={`删除账号 ${a.label}`} onClick={(event) => { event.stopPropagation(); void remove(a); }}>
                          <Trash2 aria-hidden />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {current && (
        <section aria-label="域名" className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">
            {current.label} 的域名<span className="ml-2 font-normal text-muted-foreground tabular-nums">{domains.length} 个</span>
          </h2>
          {domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">{current.lastSyncedAt ? "这个账号下没有域名。" : "同步完成后会在这里列出域名。"}</p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>域名</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>到期</TableHead>
                    <TableHead>网站</TableHead>
                    <TableHead>邮箱</TableHead>
                    <TableHead className="w-0"><span className="sr-only">操作</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {domains.map((d) => {
                    const left = d.expiresAt ? daysLeft(d.expiresAt) : null;
                    return (
                      // 按 Hostinger 的域名 ID 做 key：待设置的域名没有名字，用名字做 key 会重复，切换账号时残留旧行
                      <TableRow key={d.id}>
                        <TableCell className="font-medium">{d.domain || <span className="font-normal text-muted-foreground">（待设置的域名）</span>}</TableCell>
                        <TableCell className="text-muted-foreground">{DOMAIN_STATUS[d.status ?? ""] ?? d.status ?? "—"}</TableCell>
                        <TableCell className={cn("tabular-nums", left !== null && left <= 30 ? "text-amber-600" : "text-muted-foreground")}>
                          {d.expiresAt ? new Date(d.expiresAt).toLocaleDateString("zh-CN") : "—"}
                          {left !== null && left <= 30 && `（${left} 天后到期）`}
                        </TableCell>
                        <TableCell>{d.hasWebsite ? "已建站" : <span className="text-muted-foreground">空闲</span>}</TableCell>
                        <TableCell>{d.hasMail ? "已开通" : <span className="text-muted-foreground">未开通</span>}</TableCell>
                        <TableCell>{d.domain && <AbandonSiteButton domain={d.domain} accountId={current.id} onDone={() => { invalidateDomains(); void refreshDomains().catch((reason: Error) => setError(reason.message)); }} />}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      )}

      <AddAccountDialog open={adding} onOpenChange={setAdding} onAdded={() => { invalidate(); void refresh().catch((reason: Error) => setError(reason.message)); }} />


    </div>
  );
}

function AddAccountDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 关闭时清空，Token 不在界面里多停留
  const close = (next: boolean) => {
    if (!next) {
      setLabel("");
      setToken("");
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("accounts.add", { label, token });
      close(false);
      toast("Hostinger 账号已接入，正在同步资源");
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>添加 Hostinger 账号</DialogTitle>
            <DialogDescription>在 hPanel 的「账户 → API」里生成 Token。Token 加密保存在你的工作区，添加后不会再显示。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-label">名称</Label>
            <Input id="account-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：主账号" autoFocus />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-token">API Token</Label>
            <Input id="account-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !label.trim() || !token.trim()}>
              {busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
              {busy ? "正在验证" : "验证并添加"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
