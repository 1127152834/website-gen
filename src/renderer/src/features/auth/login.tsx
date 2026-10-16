import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle, LogIn } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { AuthUser } from "../../../../shared/auth.ts";
import { login } from "@/lib/auth.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import iconUrl from "../../../../../resources/icon.png";
import { loginSchema } from "./validation.ts";
export { loginSchema } from "./validation.ts";

type LoginValues = z.infer<typeof loginSchema>;

export function LoginPage({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { username: "", password: "" } });
  const submit = form.handleSubmit(async ({ username, password }) => {
    setServerError(null);
    try { onLogin(await login(username.trim(), password)); }
    catch (reason) { setServerError((reason as Error).message); }
  });

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-muted/30 p-6">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-linear-to-b from-primary/8 to-transparent" />
      <Card className="relative w-full max-w-sm shadow-xl shadow-black/5">
        <CardHeader className="space-y-3">
          <div className="flex items-center gap-2.5"><img src={iconUrl} alt="" className="size-9 rounded-lg ring-1 ring-border" /><span className="font-semibold tracking-tight">独立站 AI 工厂</span></div>
          <div><CardTitle><h1 className="text-2xl">登录</h1></CardTitle><CardDescription className="mt-1.5">使用管理员分配给你的用户名和密码。</CardDescription></div>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
            <div className="grid gap-2"><Label htmlFor="login-username">用户名</Label><Input id="login-username" autoComplete="username" autoFocus aria-invalid={Boolean(form.formState.errors.username)} aria-describedby={form.formState.errors.username ? "login-username-error" : undefined} {...form.register("username")} />{form.formState.errors.username && <p id="login-username-error" role="alert" className="text-xs text-destructive">{form.formState.errors.username.message}</p>}</div>
            <div className="grid gap-2"><Label htmlFor="login-password">密码</Label><Input id="login-password" type="password" autoComplete="current-password" aria-invalid={Boolean(form.formState.errors.password)} aria-describedby={form.formState.errors.password ? "login-password-error" : undefined} {...form.register("password")} />{form.formState.errors.password && <p id="login-password-error" role="alert" className="text-xs text-destructive">{form.formState.errors.password.message}</p>}</div>
            {serverError && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{serverError}</p>}
            <Button type="submit" className="mt-1 w-full" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <LogIn aria-hidden />}登录</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
