import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AccountSummary, DomainSummary } from "../../../shared/protocol.ts";
import { call, onChanged, onConnect } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

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
const daysLeft = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);

export function AccountsPage() {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [syncingIds, setSyncingIds] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AccountSummary | null>(null);

  const load = useCallback(() => {
    call<AccountSummary[]>("accounts.list").then(setAccounts, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    const offConnect = onConnect(load);
    const offChanged = onChanged("accounts", load);
    return () => {
      offConnect();
      offChanged();
    };
  }, [load]);

  // 默认选中第一个账号；被删掉时换一个
  useEffect(() => {
    if (!accounts) return;
    if (!accounts.some((a) => a.id === selected)) setSelected(accounts[0]?.id ?? null);
  }, [accounts, selected]);

  useEffect(() => {
    if (selected == null) {
      setDomains([]);
      return;
    }
    call<DomainSummary[]>("accounts.domains", { id: selected }).then(setDomains, (e: Error) => setError(e.message));
  }, [selected, accounts]);

  const syncNow = async (id: number) => {
    setError(null);
    setSyncingIds((s) => new Set(s).add(id));
    try {
      await call("accounts.sync", { id });
    } catch (e) {
      setError(`同步没有完成：${(e as Error).message}`);
    } finally {
      setSyncingIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      load();
    }
  };

  const remove = async (account: AccountSummary) => {
    try {
      await call("accounts.remove", { id: account.id });
      load();
    } catch (e) {
      setError(`删除没有完成：${(e as Error).message}`);
    }
  };

  const current = accounts?.find((a) => a.id === selected) ?? null;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Hostinger 账号</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            每个账号用一个 API Token 接入。Token 加密保存在这台电脑上，系统会同步账号下的主机订单、网站、域名和邮箱，每 30 分钟自动更新一次。
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus aria-hidden />
          添加账号
        </Button>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

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
                  <TableRow key={a.id} data-state={a.id === selected ? "selected" : undefined}>
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
                        <Button variant="ghost" size="sm" onClick={() => void syncNow(a.id)} disabled={syncing}>
                          {syncing ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                          同步
                        </Button>
                        <Button variant="ghost" size="icon" aria-label={`删除账号 ${a.label}`} onClick={() => setRemoving(a)}>
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {domains.map((d) => {
                    const left = d.expiresAt ? daysLeft(d.expiresAt) : null;
                    return (
                      <TableRow key={d.domain}>
                        <TableCell className="font-medium">{d.domain}</TableCell>
                        <TableCell className="text-muted-foreground">{d.status === "active" ? "正常" : (d.status ?? "—")}</TableCell>
                        <TableCell className={cn("tabular-nums", left !== null && left <= 30 ? "text-amber-600" : "text-muted-foreground")}>
                          {d.expiresAt ? new Date(d.expiresAt).toLocaleDateString("zh-CN") : "—"}
                          {left !== null && left <= 30 && `（${left} 天后到期）`}
                        </TableCell>
                        <TableCell>{d.hasWebsite ? "已建站" : <span className="text-muted-foreground">空闲</span>}</TableCell>
                        <TableCell>{d.hasMail ? "已开通" : <span className="text-muted-foreground">未开通</span>}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      )}

      <AddAccountDialog open={adding} onOpenChange={setAdding} onAdded={load} />

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除账号「{removing?.label}」？</AlertDialogTitle>
            <AlertDialogDescription>
              只会删除这台电脑上保存的 Token 和同步记录，Hostinger 上的网站、域名、邮箱都不受影响。以后可以用 Token 重新添加。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && void remove(removing)}>删除账号</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
            <DialogDescription>在 hPanel 的「账户 → API」里生成 Token。Token 加密保存在这台电脑上，添加后不会再显示。</DialogDescription>
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
