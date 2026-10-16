import { useCallback, useLayoutEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy, LoaderCircle, RefreshCw, Table2, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { call, invalidateRpcData, useRpcData } from "@/lib/backend.ts";
import { toast, useConfirm } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/password-input";
import { Skeleton } from "@/components/page-state";
import { gristMcpCommand, type GristSettings } from "./grist-table-helpers.ts";

type TokenStatus = { createdAt: number | null; lastUsedAt: number | null };
type ConnectionResult = { ok: boolean; text: string };

const gristSettingsSchema = z.object({
  baseUrl: z.string().trim().min(1, "请输入 Grist 地址").url("请输入有效的 HTTP / HTTPS 地址").refine((value) => /^https?:\/\//i.test(value), "仅支持 HTTP / HTTPS 地址"),
  apiKey: z.string(),
});
type GristSettingsForm = z.infer<typeof gristSettingsSchema>;

export function GristSettingsSection() {
  const confirm = useConfirm();
  const [settings, setSettings] = useState<GristSettings | null>(null);
  const [status, setStatus] = useState<TokenStatus>({ createdAt: null, lastUsedAt: null });
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectionResult | null>(null);
  const form = useForm<GristSettingsForm>({
    resolver: zodResolver(gristSettingsSchema),
    defaultValues: { baseUrl: "", apiKey: "" },
  });
  const baseUrl = form.watch("baseUrl");
  const apiKey = form.watch("apiKey");

  const loadSettings = useCallback(async () => {
      const [next, tokenStatus] = await Promise.all([call<GristSettings>("grist.settings.get"), call<TokenStatus>("grist.mcpToken.status")]);
      return { settings: next, status: tokenStatus };
  }, []);
  const { data, loading, refreshing, error: loadError, refresh, invalidate } = useRpcData<{ settings: GristSettings; status: TokenStatus }>("grist.settings.firstScreen", undefined, { loader: loadSettings });
  useLayoutEffect(() => { if (data) { setSettings(data.settings); form.reset({ baseUrl: data.settings.baseUrl, apiKey: "" }); setStatus(data.status); } }, [data, form]);

  const save = async (values: GristSettingsForm) => {
    setBusy("save"); setError(null); setTest(null);
    try {
      const next = await call<GristSettings>("grist.settings.save", { baseUrl: values.baseUrl.trim(), ...(values.apiKey.trim() ? { apiKey: values.apiKey.trim() } : {}) });
      setSettings(next); form.reset({ baseUrl: next.baseUrl, apiKey: "" });
      invalidate();
      for (const method of ["grist.settings.get", "grist.listOrgs", "grist.listWorkspaces", "grist.listDocs", "grist.getDocStructure", "grist.getPageRecords", "grist.getAttachments"]) invalidateRpcData(method);
      void refresh().catch((reason: Error) => setError(reason.message)); toast("Grist 设置已保存", "success");
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(null); }
  };
  const testConnection = async () => {
    setBusy("test"); setTest(null);
    try {
      const profile = await call<{ user?: { name?: string; email?: string } }>("grist.testConnection", { baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      setTest({ ok: true, text: `连接成功 · ${profile.user?.name || "未提供用户名"} · ${profile.user?.email || "未提供邮箱"}` });
    } catch (reason) { setTest({ ok: false, text: (reason as Error).message }); }
    finally { setBusy(null); }
  };
  const generate = async () => {
    if (status.createdAt && !await confirm({ title: "重新生成 MCP 令牌？", description: "旧令牌会立即失效。请使用新令牌更新所有已接入的 AI 客户端。", confirmText: "重新生成", destructive: true })) return;
    setBusy("generate"); setError(null);
    try {
      const next = await call<{ token: string; createdAt: number }>("grist.mcpToken.generate");
      setToken(next.token); setStatus({ createdAt: next.createdAt, lastUsedAt: null }); invalidate(); void refresh().catch((reason: Error) => setError(reason.message));
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(null); }
  };
  const revoke = async () => {
    if (!await confirm({ title: "撤销 MCP 令牌？", description: "使用此令牌的 AI 客户端将立即无法访问 Grist。之后可以生成新令牌。", confirmText: "撤销令牌", destructive: true })) return;
    setBusy("revoke"); setError(null);
    try { await call("grist.mcpToken.revoke"); setToken(null); setStatus({ createdAt: null, lastUsedAt: null }); invalidate(); void refresh().catch((reason: Error) => setError(reason.message)); toast("MCP 令牌已撤销"); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(null); }
  };
  const command = gristMcpCommand(window.location.origin, token ?? undefined);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast("已复制"); }
    catch { toast("复制失败，请选中文字手动复制", "error"); }
  };
  return <section id="grist" className="scroll-mt-6 space-y-5" aria-labelledby="grist-title">
    <div><h2 id="grist-title" className="flex items-center gap-2 text-base font-semibold tracking-tight"><Table2 className="size-4" aria-hidden />Grist 表格</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">连接自己的 Grist，浏览和编辑表格。地址与加密密钥仅保存在当前用户的工作区。</p></div>
    {refreshing && settings && <p role="status" className="fixed right-4 bottom-4 text-xs text-muted-foreground">刷新中…</p>}
    {(error || loadError) && <p role="alert" className="text-sm text-destructive">{error ?? loadError?.message}{!settings && <Button variant="link" size="sm" onClick={() => void refresh().catch((reason: Error) => setError(reason.message))}>重新读取</Button>}</p>}
    {loading ? <Skeleton label="正在读取 Grist 设置" /> : settings && <div className="divide-y rounded-xl border bg-card">
      <form onSubmit={form.handleSubmit(save)} className="space-y-4 p-4 sm:p-5" noValidate>
        <div className="space-y-2"><Label htmlFor="grist-url">Grist 地址</Label><Input id="grist-url" type="url" autoComplete="url" placeholder="https://grist.example.com" {...form.register("baseUrl", { onChange: () => setTest(null) })} disabled={busy !== null} aria-invalid={Boolean(form.formState.errors.baseUrl)} aria-describedby={form.formState.errors.baseUrl ? "grist-url-error" : "grist-url-hint"} />{form.formState.errors.baseUrl ? <p id="grist-url-error" role="alert" className="text-xs text-destructive">{form.formState.errors.baseUrl.message}</p> : <p id="grist-url-hint" className="text-xs text-muted-foreground">仅支持公网 HTTP / HTTPS 地址，不接受回环或内网地址。</p>}</div>
        <div className="space-y-2"><Label htmlFor="grist-api-key">API Key</Label><PasswordInput id="grist-api-key" autoComplete="new-password" {...form.register("apiKey", { onChange: () => setTest(null) })} placeholder={settings.apiKeyHint ? `已保存 ····${settings.apiKeyHint}；留空不修改` : "在 Grist 个人资料中生成 API Key"} disabled={busy !== null} aria-describedby="grist-api-key-hint" /><p id="grist-api-key-hint" className="text-xs text-muted-foreground">{settings.apiKeyHint ? `已保存密钥末 4 位：${settings.apiKeyHint}。留空表示不修改。` : "密钥保存后只显示末 4 位，不会再次返回明文。"}</p></div>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy !== null}>{busy === "save" && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}保存设置</Button><Button type="button" variant="outline" disabled={busy !== null || !baseUrl.trim() || (!apiKey.trim() && !settings.apiKeyHint)} onClick={() => void testConnection()}>{busy === "test" ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}测试连接</Button></div>
        {test && <p role={test.ok ? "status" : "alert"} className={test.ok ? "flex items-center gap-2 text-sm" : "text-sm text-destructive"}>{test.ok && <Check className="size-4 shrink-0" aria-hidden />}{test.text}</p>}
      </form>
      <div className="space-y-4 p-4 sm:p-5"><div><h3 className="font-medium">MCP 接入令牌</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">令牌允许 AI 以你的身份读写已连接的 Grist，包括删除数据和表结构。只交给可信客户端；撤销或停用用户后立即失效。</p></div>
        {status.createdAt ? <p className="text-xs text-muted-foreground">已生成 · {new Date(status.createdAt).toLocaleString()} · {status.lastUsedAt ? `最近使用 ${new Date(status.lastUsedAt).toLocaleString()}` : "尚未使用"}</p> : <p className="text-xs text-muted-foreground">尚未生成令牌</p>}
        <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy !== null || !settings.configured} onClick={() => void generate()}>{busy === "generate" && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}{status.createdAt ? "重新生成令牌" : "生成 MCP 令牌"}</Button>{status.createdAt !== null && <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void revoke()}><Trash2 aria-hidden />撤销令牌</Button>}</div>
        {!settings.configured && <p className="text-xs text-muted-foreground">先保存 Grist 地址与 API Key，再生成令牌。</p>}
        {token && <div className="space-y-2 rounded-lg bg-muted p-3"><p className="text-sm font-medium">请现在复制：明文令牌只显示这一次</p><div className="flex items-start gap-2"><code className="min-w-0 flex-1 break-all text-xs">{token}</code><Button variant="ghost" size="icon-sm" aria-label="复制 MCP 令牌" onClick={() => void copy(token)}><Copy aria-hidden /></Button></div><Button variant="outline" size="sm" onClick={() => setToken(null)}>我已保存，隐藏明文</Button></div>}
        <div className="space-y-2"><p className="text-xs font-medium">Claude 接入命令</p><div className="flex items-start gap-2 rounded-lg bg-muted p-3"><code className="min-w-0 flex-1 break-all text-xs leading-5">{command}</code><Button variant="ghost" size="icon-sm" aria-label="复制 Claude MCP 接入命令" onClick={() => void copy(command)}><Copy aria-hidden /></Button></div>{!token && <p className="text-xs text-muted-foreground">将占位符替换为生成时保存的 MCP 令牌；现有令牌无法重新查看。</p>}</div>
      </div>
    </div>}
  </section>;
}
