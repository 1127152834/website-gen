import { useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import type { AuthUser } from "../../../shared/auth.ts";
import { changePassword } from "@/lib/auth.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  forced?: boolean;
  onChanged: (user: AuthUser) => void;
  onCancel?: () => void;
}

export function ChangePasswordForm({ forced = false, onChanged, onCancel }: Props) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    if (newPassword === oldPassword) {
      setError("新密码不能和当前密码相同");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onChanged(await changePassword(oldPassword, newPassword));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-2">
        <Label htmlFor={forced ? "forced-old-password" : "old-password"}>当前密码</Label>
        <Input id={forced ? "forced-old-password" : "old-password"} type="password" autoComplete="current-password" autoFocus={forced} required value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={forced ? "forced-new-password" : "new-password"}>新密码</Label>
        <Input id={forced ? "forced-new-password" : "new-password"} type="password" autoComplete="new-password" minLength={8} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={forced ? "forced-confirm-password" : "confirm-password"}>再输入一次新密码</Label>
        <Input id={forced ? "forced-confirm-password" : "confirm-password"} type="password" autoComplete="new-password" minLength={8} required value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>取消</Button>}
        <Button type="submit" disabled={busy || !oldPassword || !newPassword || !confirm}>
          {busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
          保存新密码
        </Button>
      </div>
    </form>
  );
}

export function ForcedChangePasswordPage({ username, onChanged }: { username: string; onChanged: (user: AuthUser) => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle><h1>首次登录，请修改密码</h1></CardTitle>
          <CardDescription>账号「{username}」当前使用的是初始密码。修改后才能进入工作区。</CardDescription>
        </CardHeader>
        <CardContent><ChangePasswordForm forced onChanged={onChanged} /></CardContent>
      </Card>
    </main>
  );
}
