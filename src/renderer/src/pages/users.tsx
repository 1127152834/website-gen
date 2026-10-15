import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound, LoaderCircle, Plus, Power } from "lucide-react";
import type { AdminUser, AuthUser } from "../../../shared/auth.ts";
import { addUser, listUsers, resetUserPassword, setUserDisabled } from "@/lib/auth.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function dateTime(timestamp: number | null): string {
  if (timestamp == null) return "从未";
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(milliseconds);
}

export function UsersPage({ currentUser }: { currentUser: AuthUser }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await listUsers());
      setError(null);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (user: AdminUser) => {
    setBusyId(user.id);
    setError(null);
    try {
      await setUserDisabled(user.id, !user.disabled);
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">用户管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">创建登录账号、重置初始密码和停用账号。管理员不能查看其他用户的业务数据。</p>
        </div>
        <Button onClick={() => setAdding(true)}><Plus aria-hidden />添加用户</Button>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {users === null && <p className="text-sm text-muted-foreground">读取中…</p>}
      {users && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>用户名</TableHead><TableHead>角色</TableHead><TableHead>状态</TableHead><TableHead>上次登录</TableHead><TableHead>创建时间</TableHead><TableHead className="w-0"><span className="sr-only">操作</span></TableHead></TableRow></TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.username}{user.id === currentUser.id && <span className="ml-2 text-xs font-normal text-muted-foreground">当前账号</span>}</TableCell>
                  <TableCell>{user.role === "admin" ? "管理员" : "普通用户"}</TableCell>
                  <TableCell>
                    {user.disabled ? <Badge variant="destructive">已停用</Badge> : user.mustChangePassword ? <Badge variant="outline">等待修改初始密码</Badge> : <Badge variant="secondary">正常</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{dateTime(user.lastLoginAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{dateTime(user.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setResetting(user)}><KeyRound aria-hidden />重置密码</Button>
                      <Button variant="ghost" size="sm" disabled={busyId !== null || user.id === currentUser.id} title={user.id === currentUser.id ? "不能停用自己" : undefined} onClick={() => void toggle(user)}>
                        {busyId === user.id ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Power aria-hidden />}
                        {user.disabled ? "启用" : "停用"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AddUserDialog open={adding} onClose={() => setAdding(false)} onSaved={() => void load()} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} onSaved={() => void load()} />
    </div>
  );
}

function AddUserDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AdminUser["role"]>("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setUsername(""); setPassword(""); setRole("user"); setError(null); onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await addUser(username.trim(), password, role);
      close(); onSaved();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader><DialogTitle>添加用户</DialogTitle><DialogDescription>初始密码只交给该用户；首次登录后必须修改。</DialogDescription></DialogHeader>
          <div className="my-5 grid gap-4">
            <div className="grid gap-2"><Label htmlFor="new-user-name">用户名</Label><Input id="new-user-name" autoFocus required value={username} onChange={(event) => setUsername(event.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="new-user-password">初始密码</Label><Input id="new-user-password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="new-user-role">角色</Label><Select value={role} onValueChange={(value) => setRole(value as AdminUser["role"])}><SelectTrigger id="new-user-role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="user">普通用户</SelectItem><SelectItem value="admin">管理员</SelectItem></SelectContent></Select></div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter><Button type="button" variant="outline" onClick={close}>取消</Button><Button type="submit" disabled={busy || !username.trim() || !password}>{busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}创建用户</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose, onSaved }: { user: AdminUser | null; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { setPassword(""); setError(null); onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!user) return; setBusy(true); setError(null);
    try {
      await resetUserPassword(user.id, password);
      close(); onSaved();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={user !== null} onOpenChange={(value) => !value && close()}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader><DialogTitle>重置密码</DialogTitle><DialogDescription>为「{user?.username}」设置新的初始密码。该账号的其他会话会退出，下次登录必须修改密码。</DialogDescription></DialogHeader>
          <div className="my-5 grid gap-2"><Label htmlFor="reset-user-password">初始密码</Label><Input id="reset-user-password" type="password" autoComplete="new-password" minLength={8} autoFocus required value={password} onChange={(event) => setPassword(event.target.value)} />{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>
          <DialogFooter><Button type="button" variant="outline" onClick={close}>取消</Button><Button type="submit" disabled={busy || !password}>{busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}保存初始密码</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
