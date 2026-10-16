import { useCallback, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import { KeyRound, LoaderCircle, Plus, Power } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import type { AdminUser, AuthUser } from "../../../../shared/auth.ts";
import { addUser, listUsers, resetUserPassword, setUserDisabled } from "@/lib/auth.ts";
import { useRpcData } from "@/lib/backend.ts";
import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm, toast } from "@/components/feedback";
import { Skeleton } from "@/components/page-state";
import { addUserSchema, resetPasswordSchema } from "./validation.ts";
export { addUserSchema, resetPasswordSchema } from "./validation.ts";

function dateTime(timestamp: number | null): string {
  if (timestamp == null) return "从未";
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(milliseconds);
}

const userStatus = (user: AdminUser) => user.disabled ? "disabled" : user.mustChangePassword ? "password" : "active";
type AddUserValues = z.infer<typeof addUserSchema>;
type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

export function UsersPage({ currentUser }: { currentUser: AuthUser }) {
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadUsers = useCallback(() => listUsers(), []);
  const { data: users, loading, refreshing, error: loadError, refresh, invalidate } = useRpcData<AdminUser[]>("admin.users.list", undefined, { loader: loadUsers });

  const reload = () => { invalidate(); void refresh().catch((reason: Error) => setError(reason.message)); };
  const toggle = async (user: AdminUser) => {
    if (!await confirm({ title: `${user.disabled ? "启用" : "停用"}用户「${user.username}」？`, description: user.disabled ? "启用后该用户可以重新登录并继续使用自己的工作区。" : "该用户会立即退出登录，后台工作区将关闭；数据会保留。", destructive: !user.disabled })) return;
    setBusyId(user.id); setError(null);
    try { await setUserDisabled(user.id, !user.disabled); toast(user.disabled ? "用户已启用" : "用户已停用"); reload(); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusyId(null); }
  };
  const columns = useMemo<ColumnDef<AdminUser, any>[]>(() => [
    { accessorKey: "username", header: "用户名", cell: ({ row }) => <span className="font-medium">{row.original.username}{row.original.id === currentUser.id && <span className="ml-2 text-xs font-normal text-muted-foreground">当前账号</span>}</span> },
    { accessorKey: "role", header: "角色", cell: ({ row }) => row.original.role === "admin" ? "管理员" : "普通用户" },
    { id: "status", accessorFn: userStatus, header: "状态", cell: ({ row }) => row.original.disabled ? <Badge variant="destructive">已停用</Badge> : row.original.mustChangePassword ? <Badge variant="outline">等待修改初始密码</Badge> : <Badge variant="secondary">正常</Badge> },
    { accessorKey: "lastLoginAt", header: "上次登录", cell: ({ row }) => <span className="text-muted-foreground">{dateTime(row.original.lastLoginAt)}</span> },
    { accessorKey: "createdAt", header: "创建时间", cell: ({ row }) => <span className="text-muted-foreground">{dateTime(row.original.createdAt)}</span> },
  ], [currentUser.id]);

  return <div className="flex min-w-0 max-w-6xl flex-col gap-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="text-2xl font-semibold tracking-tight">用户管理</h1><p className="mt-1 text-sm text-muted-foreground">创建登录账号、重置初始密码和停用账号。管理员不能查看其他用户的业务数据。</p></div><Button onClick={() => setAdding(true)}><Plus aria-hidden />添加用户</Button></div>
    {refreshing && users && <p role="status" className="fixed right-4 bottom-4 text-xs text-muted-foreground">刷新中…</p>}
    {(error || loadError) && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error ?? loadError?.message}</p>}
    {loading && !error ? <Skeleton label="正在读取用户" /> : users && <DataTable data={users} columns={columns} searchKey="username" searchPlaceholder="搜索用户名…" filters={[{ columnId: "role", title: "角色", options: [{ label: "管理员", value: "admin" }, { label: "普通用户", value: "user" }] }, { columnId: "status", title: "状态", options: [{ label: "正常", value: "active" }, { label: "等待修改密码", value: "password" }, { label: "已停用", value: "disabled" }] }]} getRowId={(user) => String(user.id)} emptyMessage="还没有用户。" rowActions={(user) => <div className="flex justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => setResetting(user)}><KeyRound aria-hidden />重置密码</Button><Button variant="ghost" size="sm" disabled={busyId !== null || user.id === currentUser.id} title={user.id === currentUser.id ? "不能停用自己" : undefined} onClick={() => void toggle(user)}>{busyId === user.id ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Power aria-hidden />}{user.disabled ? "启用" : "停用"}</Button></div>} />}
    <AddUserDialog open={adding} onClose={() => setAdding(false)} onSaved={reload} />
    <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} onSaved={reload} />
  </div>;
}

function AddUserDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<AddUserValues>({ resolver: zodResolver(addUserSchema), defaultValues: { username: "", password: "", role: "user" } });
  const close = () => { form.reset(); setServerError(null); onClose(); };
  const submit = form.handleSubmit(async ({ username, password, role }) => { setServerError(null); try { await addUser(username.trim(), password, role); toast("用户信息已保存"); close(); onSaved(); } catch (reason) { setServerError((reason as Error).message); } });
  return <Dialog open={open} onOpenChange={(value) => !value && close()}><DialogContent><form onSubmit={(event) => void submit(event)} noValidate><DialogHeader><DialogTitle>添加用户</DialogTitle><DialogDescription>初始密码只交给该用户；首次登录后必须修改。</DialogDescription></DialogHeader><div className="my-5 grid gap-4">
    <div className="grid gap-2"><Label htmlFor="new-user-name">用户名</Label><Input id="new-user-name" autoFocus aria-invalid={Boolean(form.formState.errors.username)} aria-describedby={form.formState.errors.username ? "new-user-name-error" : undefined} {...form.register("username")} />{form.formState.errors.username && <p id="new-user-name-error" role="alert" className="text-xs text-destructive">{form.formState.errors.username.message}</p>}</div>
    <div className="grid gap-2"><Label htmlFor="new-user-password">初始密码</Label><Input id="new-user-password" type="password" autoComplete="new-password" aria-invalid={Boolean(form.formState.errors.password)} aria-describedby={form.formState.errors.password ? "new-user-password-error" : undefined} {...form.register("password")} />{form.formState.errors.password && <p id="new-user-password-error" role="alert" className="text-xs text-destructive">{form.formState.errors.password.message}</p>}</div>
    <div className="grid gap-2"><Label htmlFor="new-user-role">角色</Label><Controller name="role" control={form.control} render={({ field }) => <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="new-user-role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="user">普通用户</SelectItem><SelectItem value="admin">管理员</SelectItem></SelectContent></Select>} /></div>
    {serverError && <p role="alert" className="text-sm text-destructive">{serverError}</p>}
  </div><DialogFooter><Button type="button" variant="outline" onClick={close}>取消</Button><Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}创建用户</Button></DialogFooter></form></DialogContent></Dialog>;
}

function ResetPasswordDialog({ user, onClose, onSaved }: { user: AdminUser | null; onClose: () => void; onSaved: () => void }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<ResetPasswordValues>({ resolver: zodResolver(resetPasswordSchema), defaultValues: { password: "" } });
  const close = () => { form.reset(); setServerError(null); onClose(); };
  const submit = form.handleSubmit(async ({ password }) => { if (!user) return; setServerError(null); try { await resetUserPassword(user.id, password); toast("用户信息已保存"); close(); onSaved(); } catch (reason) { setServerError((reason as Error).message); } });
  return <Dialog open={user !== null} onOpenChange={(value) => !value && close()}><DialogContent><form onSubmit={(event) => void submit(event)} noValidate><DialogHeader><DialogTitle>重置密码</DialogTitle><DialogDescription>为「{user?.username}」设置新的初始密码。该账号的其他会话会退出，下次登录必须修改密码。</DialogDescription></DialogHeader><div className="my-5 grid gap-2"><Label htmlFor="reset-user-password">初始密码</Label><Input id="reset-user-password" type="password" autoComplete="new-password" autoFocus aria-invalid={Boolean(form.formState.errors.password)} aria-describedby={form.formState.errors.password ? "reset-user-password-error" : undefined} {...form.register("password")} />{form.formState.errors.password && <p id="reset-user-password-error" role="alert" className="text-xs text-destructive">{form.formState.errors.password.message}</p>}{serverError && <p role="alert" className="text-sm text-destructive">{serverError}</p>}</div><DialogFooter><Button type="button" variant="outline" onClick={close}>取消</Button><Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}保存初始密码</Button></DialogFooter></form></DialogContent></Dialog>;
}
