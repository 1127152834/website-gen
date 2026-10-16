import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound, LoaderCircle } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { AuthUser } from "../../../../shared/auth.ts";
import { changePassword } from "@/lib/auth.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePasswordSchema } from "./validation.ts";
export { changePasswordSchema } from "./validation.ts";

type ChangePasswordValues = z.infer<typeof changePasswordSchema>;
interface Props { forced?: boolean; onChanged: (user: AuthUser) => void; onCancel?: () => void; }

export function ChangePasswordForm({ forced = false, onChanged, onCancel }: Props) {
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<ChangePasswordValues>({ resolver: zodResolver(changePasswordSchema), defaultValues: { oldPassword: "", newPassword: "", confirm: "" } });
  const fieldId = (name: string) => forced ? `forced-${name}` : name;
  const errorId = (name: string) => `${fieldId(name)}-error`;
  const submit = form.handleSubmit(async ({ oldPassword, newPassword }) => {
    setServerError(null);
    try { onChanged(await changePassword(oldPassword, newPassword)); form.reset(); }
    catch (reason) { setServerError((reason as Error).message); }
  });
  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <div className="grid gap-2"><Label htmlFor={fieldId("old-password")}>当前密码</Label><Input id={fieldId("old-password")} type="password" autoComplete="current-password" autoFocus={forced} aria-invalid={Boolean(form.formState.errors.oldPassword)} aria-describedby={form.formState.errors.oldPassword ? errorId("old-password") : undefined} {...form.register("oldPassword")} />{form.formState.errors.oldPassword && <p id={errorId("old-password")} role="alert" className="text-xs text-destructive">{form.formState.errors.oldPassword.message}</p>}</div>
      <div className="grid gap-2"><Label htmlFor={fieldId("new-password")}>新密码</Label><Input id={fieldId("new-password")} type="password" autoComplete="new-password" aria-invalid={Boolean(form.formState.errors.newPassword)} aria-describedby={form.formState.errors.newPassword ? errorId("new-password") : undefined} {...form.register("newPassword")} />{form.formState.errors.newPassword && <p id={errorId("new-password")} role="alert" className="text-xs text-destructive">{form.formState.errors.newPassword.message}</p>}</div>
      <div className="grid gap-2"><Label htmlFor={fieldId("confirm-password")}>再输入一次新密码</Label><Input id={fieldId("confirm-password")} type="password" autoComplete="new-password" aria-invalid={Boolean(form.formState.errors.confirm)} aria-describedby={form.formState.errors.confirm ? errorId("confirm-password") : undefined} {...form.register("confirm")} />{form.formState.errors.confirm && <p id={errorId("confirm-password")} role="alert" className="text-xs text-destructive">{form.formState.errors.confirm.message}</p>}</div>
      {serverError && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{serverError}</p>}
      <div className="flex justify-end gap-2">{onCancel && <Button type="button" variant="outline" onClick={onCancel} disabled={form.formState.isSubmitting}>取消</Button>}<Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}保存新密码</Button></div>
    </form>
  );
}

export function ForcedChangePasswordPage({ username, onChanged }: { username: string; onChanged: (user: AuthUser) => void }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-muted/30 p-6">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-linear-to-b from-primary/8 to-transparent" />
      <Card className="relative w-full max-w-md shadow-xl shadow-black/5"><CardHeader><div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><KeyRound aria-hidden /></div><CardTitle><h1 className="text-2xl">首次登录，请修改密码</h1></CardTitle><CardDescription>账号「{username}」当前使用的是初始密码。修改后才能进入工作区。</CardDescription></CardHeader><CardContent><ChangePasswordForm forced onChanged={onChanged} /></CardContent></Card>
    </main>
  );
}
