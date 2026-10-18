import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { MailboxSummary } from "../../../../shared/mail-types.ts";
import { toast, useConfirm } from "@/components/feedback";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { call, invalidateRpcData } from "@/lib/backend.ts";

const schema = z.object({ password: z.string().min(1, "请输入邮箱密码") });
type Form = z.infer<typeof schema>;
function PasswordReveal({ mailbox }: { mailbox: MailboxSummary | null }) { const confirm = useConfirm(); const [secret, setSecret] = useState<string | null>(null); if (!mailbox?.credentialSaved) return null; return <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm"><p>密码：{secret ? <code className="select-all break-all">{secret}</code> : "已加密保存"}</p><Button type="button" size="sm" variant="outline" onClick={async () => { if (secret) return setSecret(null); if (!await confirm({ title: "显示已保存的邮箱密码？", description: "请避开共享屏幕，复制后及时隐藏。", confirmText: "显示密码" })) return; const result = await call<{ password: string } | null>("mail.password", { mailboxId: mailbox.id }); setSecret(result?.password ?? null); }}>{secret ? "隐藏密码" : "显示已保存密码"}</Button></div>; }
export function CredentialDialog({ mailbox, onClose, onSaved }: { mailbox: MailboxSummary | null; onClose(): void; onSaved(): void }) { const confirm = useConfirm(); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { password: "" } }); useEffect(() => { form.reset(); setError(null); }, [form, mailbox?.id]); const save = async ({ password }: Form) => { if (!mailbox) return; setBusy(true); try { await call("mail.credential.save", { mailboxId: mailbox.id, password }); invalidateRpcData("mail.list"); toast("密码已通过 IMAP 验证并加密保存"); onSaved(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }; const reset = async () => { if (!mailbox || !await confirm({ title: `重置 ${mailbox.address} 的密码？`, description: "旧密码会立即失效，此操作无法撤回。", confirmText: "确认重置密码", destructive: true })) return; setBusy(true); try { await call("mail.credential.reset", { mailboxId: mailbox.id, confirmed: true }); invalidateRpcData("mail.list"); toast("新密码已加密保存"); onSaved(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } };
  return <Dialog open={mailbox !== null} onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogHeader><DialogTitle>邮箱凭据</DialogTitle><DialogDescription>{mailbox?.address} 只有在密码验证成功后才能读取或发信。</DialogDescription></DialogHeader><PasswordReveal mailbox={mailbox} /><form onSubmit={form.handleSubmit(save)} className="space-y-3"><label className="space-y-2"><Label htmlFor="mailbox-password">邮箱密码</Label><PasswordInput id="mailbox-password" autoComplete="off" {...form.register("password")} /></label>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<DialogFooter><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => void reset()}>不知道密码？重置</Button><Button type="submit" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : null}验证并保存</Button></DialogFooter></form></DialogContent></Dialog>;
}
