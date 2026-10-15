import { useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import type { AuthUser } from "../../../shared/auth.ts";
import { login } from "@/lib/auth.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import iconUrl from "../../../../resources/icon.png";

export function LoginPage({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(username.trim(), password));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <img src={iconUrl} alt="" className="size-8 rounded-lg" />
            <span className="font-semibold">独立站 AI 工厂</span>
          </div>
          <CardTitle><h1>登录</h1></CardTitle>
          <CardDescription>使用管理员分配给你的用户名和密码。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
            <div className="grid gap-2">
              <Label htmlFor="login-username">用户名</Label>
              <Input id="login-username" name="username" autoComplete="username" autoFocus required value={username} onChange={(event) => setUsername(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="login-password">密码</Label>
              <Input id="login-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy || !username.trim() || !password}>
              {busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
              登录
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
