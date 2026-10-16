import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Bot, Boxes, CircleCheck, Eye, KeyRound, LoaderCircle, Mail, Pencil, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Table2, Trash2, X } from "lucide-react";
import type { AuthUser } from "../../../shared/auth.ts";
import type { ModelRole, RoleSummary } from "../../../shared/protocol.ts";
import { useConfirm, toast } from "@/components/feedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { call, onConnect } from "@/lib/backend.ts";
import { ChangePasswordForm } from "./change-password.tsx";
import { GristSettingsSection } from "./grist-settings.tsx";
import { emptyModel, type ModelInput, type ModelProviderPreset, type ProviderDetail, type ProviderDraft, type ProviderProtocol } from "./settings-types.ts";

const ROLE_TEXT: Record<ModelRole, { label: string; hint: string; icon: typeof Bot }> = {
  agent: { label: "建站与对话", hint: "建站决策和 pi 日常对话", icon: Bot },
  vision: { label: "看截图", hint: "检查 QA 截图和视觉问题", icon: Eye },
  bulk: { label: "批量文案", hint: "商品描述、SEO 和政策文案", icon: Sparkles },
  review: { label: "合规审查", hint: "检查宣传、政策和证据", icon: ShieldCheck },
};
const THINKING_TEXT: Record<string, string> = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", max: "最高" };
const PROTOCOL_TEXT: Record<ProviderProtocol, string> = { openai: "OpenAI 兼容", anthropic: "Anthropic 兼容" };
const THINKING_OPTIONS = ["off", "minimal", "low", "medium", "high", "max"];
const SECTIONS = [
  { id: "providers", label: "模型厂商", icon: Boxes },
  { id: "roles", label: "用途分配", icon: Settings2 },
  { id: "cj", label: "商品资料 CJ", icon: KeyRound },
  { id: "mailbox", label: "邮箱", icon: Mail },
  { id: "grist", label: "Grist 表格", icon: Table2 },
  { id: "security", label: "账户安全", icon: ShieldCheck },
] as const;

type TestResult = { ok: true; text: string } | { ok: false; text: string };

function draftFromProvider(provider: ProviderDetail): ProviderDraft {
  return {
    id: provider.id,
    originalProtocol: provider.protocol,
    originalBaseUrl: provider.baseUrl,
    presetId: "custom",
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: "",
    hasKey: provider.hasKey,
    keyHint: provider.keyHint,
    models: provider.models.map((model) => ({ ...model, thinkingLevels: [...model.thinkingLevels], price: model.price ? { ...model.price } : undefined })),
  };
}

function canonicalOrigin(value: string): string {
  try { return new URL(value).origin.toLowerCase(); }
  catch { return value.trim().replace(/\/+$/, "").toLowerCase(); }
}

function providerDestinationChanged(draft: ProviderDraft): boolean {
  if (!draft.id || !draft.originalProtocol || draft.originalBaseUrl == null) return false;
  return draft.protocol !== draft.originalProtocol || canonicalOrigin(draft.baseUrl) !== canonicalOrigin(draft.originalBaseUrl);
}

function newProviderDraft(preset?: ModelProviderPreset): ProviderDraft {
  return {
    presetId: preset?.id ?? "custom",
    name: preset?.id === "custom" ? "" : (preset?.name ?? ""),
    protocol: preset?.protocol ?? "openai",
    baseUrl: preset?.baseUrl ?? "",
    apiKey: "",
    hasKey: false,
    keyHint: null,
    models: [],
  };
}

function SectionHeading({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

function SettingsSkeleton() {
  return <div className="space-y-3" aria-label="正在读取设置">{[1, 2].map((item) => <div key={item} className="motion-safe:animate-pulse rounded-xl border p-4"><div className="h-4 w-36 rounded bg-muted" /><div className="mt-3 h-3 w-3/4 rounded bg-muted" /><div className="mt-5 h-8 w-24 rounded bg-muted" /></div>)}</div>;
}

export function SettingsPage({ onPasswordChanged }: { onPasswordChanged?: (user: AuthUser) => void }) {
  const confirm = useConfirm();
  const [providers, setProviders] = useState<ProviderDetail[]>([]);
  const [presets, setPresets] = useState<ModelProviderPreset[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});

  const load = useCallback(async () => {
    try {
      const [nextProviders, nextRoles, nextPresets] = await Promise.all([
        call<ProviderDetail[]>("models.providers"),
        call<RoleSummary[]>("models.roles"),
        call<ModelProviderPreset[]>("models.presets"),
      ]);
      setProviders(nextProviders); setRoles(nextRoles); setPresets(nextPresets); setError(null);
    } catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => onConnect(() => void load()), [load]);

  const openNew = () => setDraft(newProviderDraft(presets.find((preset) => preset.id !== "custom") ?? presets[0]));

  const testModel = async (provider: ProviderDetail, modelId: string) => {
    const key = `${provider.id}:${modelId}`;
    setTesting(key);
    setTests((current) => { const next = { ...current }; delete next[key]; return next; });
    try {
      const result = await call<{ ms: number; reply: string; cost: number }>("models.test", { providerId: provider.id, modelId });
      setTests((current) => ({ ...current, [key]: { ok: true, text: `连接正常 · ${(result.ms / 1000).toFixed(1)} 秒 · ${result.reply || "已响应"}` } }));
      toast(`${provider.name} / ${modelId} 连接正常`, "success");
    } catch (reason) {
      const message = (reason as Error).message;
      setTests((current) => ({ ...current, [key]: { ok: false, text: message } }));
      toast(message, "error");
    } finally { setTesting(null); }
  };

  const deleteProvider = async (provider: ProviderDetail) => {
    if (!await confirm({ title: `删除「${provider.name}」？`, description: "厂商的密钥、模型列表和相关用途分配都会删除。此操作不能撤销。", confirmText: "删除厂商", destructive: true })) return;
    try {
      setProviders(await call<ProviderDetail[]>("models.delete", { providerId: provider.id }));
      setRoles(await call<RoleSummary[]>("models.roles"));
      toast("模型厂商已删除", "success");
    } catch (reason) { toast((reason as Error).message, "error"); }
  };

  const changeRole = async (role: RoleSummary, patch: Partial<Pick<RoleSummary, "providerId" | "modelId" | "thinking">>) => {
    const provider = providers.find((item) => item.id === (patch.providerId ?? role.providerId));
    if (!provider) return;
    const usableModels = provider.models.filter((model) => role.role !== "vision" || model.vision);
    const model = usableModels.find((item) => item.id === (patch.modelId ?? role.modelId)) ?? usableModels[0];
    if (!model) { toast(`「${provider.name}」没有支持图片的模型，不能用于看截图`, "error"); return; }
    const requestedThinking = patch.thinking ?? role.thinking;
    const thinking = model.thinkingLevels.includes(requestedThinking) ? requestedThinking : (model.thinkingLevels.find((level) => level !== "off") ?? model.thinkingLevels[0] ?? "off");
    try {
      setRoles(await call<RoleSummary[]>("models.setRole", { role: role.role, providerId: provider.id, modelId: model.id, thinking }));
      toast(`「${ROLE_TEXT[role.role].label}」已更新`, "success");
    } catch (reason) { toast((reason as Error).message, "error"); }
  };

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="mb-7"><h1 className="text-xl font-semibold tracking-tight">设置</h1><p className="mt-1 text-sm text-muted-foreground">集中管理模型、商品资料和账户安全。密钥只在服务端解密，界面仅显示末四位。</p></header>
      <div className="grid items-start gap-7 md:grid-cols-[11rem_minmax(0,1fr)]">
        <nav aria-label="设置分区" className="sticky top-3 z-10 -mx-1 flex gap-1 overflow-x-auto bg-background/95 px-1 py-1 md:mx-0 md:flex-col md:bg-transparent md:p-0">
          {SECTIONS.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} className="flex min-h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:w-full"><Icon className="size-4" aria-hidden />{label}</a>)}
        </nav>
        <div className="min-w-0 space-y-12">
          {error && <div role="alert" className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
          <section id="providers" className="scroll-mt-6 space-y-5" aria-labelledby="providers-title">
            <div id="providers-title"><SectionHeading title="模型厂商" description="每个厂商独立保存自己的 API Key。选择预设可快速填好协议和地址，仍可按服务商文档修改。" action={<Button onClick={openNew}><Plus aria-hidden />添加厂商</Button>} /></div>
            {loading ? <SettingsSkeleton /> : providers.length === 0 ? (
              <div className="rounded-xl border border-dashed px-5 py-10 text-center"><Boxes className="mx-auto size-8 text-muted-foreground" aria-hidden /><p className="mt-3 font-medium">还没有模型厂商</p><p className="mt-1 text-sm text-muted-foreground">先添加一个厂商并配置模型，才能分配建站、看图和审查用途。</p><Button className="mt-4" onClick={openNew}><Plus aria-hidden />添加第一个厂商</Button></div>
            ) : <ProviderList providers={providers} tests={tests} testing={testing} onEdit={(provider) => setDraft(draftFromProvider(provider))} onDelete={deleteProvider} onTest={testModel} />}
          </section>
          <RoleSection providers={providers} roles={roles} loading={loading} onChange={changeRole} />
          <CjSection />
          <MailboxPasswordSection />
          <GristSettingsSection />
          <section id="security" className="scroll-mt-6 space-y-5" aria-labelledby="security-title">
            <div id="security-title"><SectionHeading title="账户安全" description="修改当前账户的登录密码。保存后，当前设备以外的登录会话都会退出。" /></div>
            <div className="max-w-xl rounded-xl border bg-card p-4 sm:p-5"><ChangePasswordForm onChanged={(user) => { toast("密码已修改", "success"); onPasswordChanged?.(user); }} /></div>
          </section>
        </div>
      </div>
      <ProviderEditor draft={draft} presets={presets} onClose={() => setDraft(null)} onSaved={(nextProviders) => { setProviders(nextProviders); setDraft(null); void call<RoleSummary[]>("models.roles").then(setRoles, (reason: Error) => toast(reason.message, "error")); }} />
    </div>
  );
}

function ProviderList({ providers, tests, testing, onEdit, onDelete, onTest }: { providers: ProviderDetail[]; tests: Record<string, TestResult>; testing: string | null; onEdit: (provider: ProviderDetail) => void; onDelete: (provider: ProviderDetail) => Promise<void>; onTest: (provider: ProviderDetail, modelId: string) => Promise<void> }) {
  return <div className="divide-y rounded-xl border bg-card">{providers.map((provider) => (
    <article key={provider.id} className="p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{provider.name}</h3><Badge variant="outline">{PROTOCOL_TEXT[provider.protocol]}</Badge>{provider.hasKey ? <Badge variant="secondary"><CircleCheck aria-hidden />Key ····{provider.keyHint}</Badge> : <Badge variant="destructive">未设置 Key</Badge>}</div><p className="mt-1 truncate text-sm text-muted-foreground" title={provider.baseUrl}>{provider.baseUrl}</p><p className="mt-2 text-xs tabular-nums text-muted-foreground">{provider.models.length} 个模型 · 密钥不会在保存后再次显示</p></div>
        <div className="flex shrink-0 gap-1"><Button variant="ghost" size="sm" onClick={() => onEdit(provider)}><Pencil aria-hidden />编辑</Button><Button variant="ghost" size="icon-sm" aria-label={`删除 ${provider.name}`} onClick={() => void onDelete(provider)}><Trash2 aria-hidden /></Button></div>
      </div>
      {provider.models.length > 0 && <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[36rem] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="pb-2 font-medium">模型</th><th className="pb-2 font-medium">能力</th><th className="pb-2 font-medium">上下文 / 输出</th><th className="pb-2 text-right font-medium">连接</th></tr></thead><tbody className="divide-y">{provider.models.map((model) => { const key = `${provider.id}:${model.id}`; return <tr key={model.id}><td className="py-2.5"><span className="font-medium">{model.name || model.id}</span><span className="ml-2 text-xs text-muted-foreground">{model.id}</span></td><td className="py-2.5 text-xs text-muted-foreground">{model.vision ? "图片 + 文字" : "文字"} · {model.thinkingLevels.map((level) => THINKING_TEXT[level] ?? level).join(" / ")}</td><td className="py-2.5 tabular-nums text-muted-foreground">{model.contextWindow.toLocaleString()} / {model.maxOutputTokens.toLocaleString()}</td><td className="py-2.5 text-right"><Button variant="outline" size="xs" disabled={!provider.hasKey || testing !== null} onClick={() => void onTest(provider, model.id)}>{testing === key ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}测试</Button>{tests[key] && <p role="status" className={`mt-1 text-xs ${tests[key].ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>{tests[key].text}</p>}</td></tr>; })}</tbody></table></div>}
    </article>
  ))}</div>;
}

function RoleSection({ providers, roles, loading, onChange }: { providers: ProviderDetail[]; roles: RoleSummary[]; loading: boolean; onChange: (role: RoleSummary, patch: Partial<Pick<RoleSummary, "providerId" | "modelId" | "thinking">>) => Promise<void> }) {
  return <section id="roles" className="scroll-mt-6 space-y-5" aria-labelledby="roles-title"><div id="roles-title"><SectionHeading title="用途分配" description="不同任务可以使用不同厂商和模型。看截图只会列出明确标记为支持图片的模型。" /></div><div className="divide-y rounded-xl border bg-card">{roles.map((role) => {
    const copy = ROLE_TEXT[role.role]; const Icon = copy.icon; const provider = providers.find((item) => item.id === role.providerId); const models = provider?.models.filter((model) => role.role !== "vision" || model.vision) ?? []; const levels = models.find((model) => model.id === role.modelId)?.thinkingLevels ?? ["off"];
    return <div key={role.role} className="grid gap-4 p-4 lg:grid-cols-[minmax(10rem,1fr)_minmax(9rem,13rem)_minmax(9rem,13rem)_7rem] lg:items-center"><div className="flex gap-3"><span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted"><Icon className="size-4" aria-hidden /></span><div><p className="font-medium">{copy.label}</p><p className="text-xs leading-5 text-muted-foreground">{copy.hint}</p>{!role.ready && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{role.problem}</p>}</div></div><Select value={role.providerId > 0 ? String(role.providerId) : undefined} onValueChange={(value) => void onChange(role, { providerId: Number(value) })}><SelectTrigger aria-label={`${copy.label}的模型厂商`}><SelectValue placeholder="选择厂商" /></SelectTrigger><SelectContent>{providers.filter((item) => role.role !== "vision" || item.models.some((model) => model.vision)).map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}</SelectContent></Select><Select value={role.modelId || undefined} disabled={!provider} onValueChange={(value) => void onChange(role, { modelId: value })}><SelectTrigger aria-label={`${copy.label}的模型`}><SelectValue placeholder="选择模型" /></SelectTrigger><SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name || model.id}</SelectItem>)}</SelectContent></Select><Select value={role.thinking || "off"} disabled={!provider || !role.modelId} onValueChange={(value) => void onChange(role, { thinking: value })}><SelectTrigger aria-label={`${copy.label}的思考强度`}><SelectValue /></SelectTrigger><SelectContent>{levels.map((level) => <SelectItem key={level} value={level}>{THINKING_TEXT[level] ?? level}</SelectItem>)}</SelectContent></Select></div>;
  })}{!loading && roles.length === 0 && <p className="p-5 text-sm text-muted-foreground">暂无用途配置。请先添加模型厂商。</p>}</div></section>;
}

function ProviderEditor({ draft, presets, onClose, onSaved }: { draft: ProviderDraft | null; presets: ModelProviderPreset[]; onClose: () => void; onSaved: (providers: ProviderDetail[]) => void }) {
  const [value, setValue] = useState<ProviderDraft | null>(draft);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destinationChanged = value ? providerDestinationChanged(value) : false;
  const effectiveHasKey = Boolean(value?.hasKey && !destinationChanged);
  const effectiveKeyHint = effectiveHasKey ? value?.keyHint : null;
  useEffect(() => { setValue(draft); setError(null); }, [draft]);
  const patch = (next: Partial<ProviderDraft>) => setValue((current) => current ? { ...current, ...next } : current);
  const patchModel = (index: number, next: Partial<ModelInput>) => setValue((current) => current ? { ...current, models: current.models.map((model, position) => position === index ? { ...model, ...next } : model) } : current);
  const selectPreset = (presetId: string) => { const preset = presets.find((item) => item.id === presetId); if (preset) patch({ presetId, name: preset.id === "custom" ? (value?.name ?? "") : preset.name, protocol: preset.protocol, baseUrl: preset.baseUrl }); };
  const fetchModels = async () => {
    if (!value?.id) return; setFetching(true); setError(null);
    try { const models = await call<ModelInput[]>("models.fetch", { providerId: value.id }); patch({ models }); toast(`已获取 ${models.length} 个模型，请检查后保存`, "success"); }
    catch (reason) { setError((reason as Error).message); }
    finally { setFetching(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!value) return;
    if (value.models.some((model) => !model.id.trim())) { setError("每个模型都要填写模型 ID"); return; }
    setBusy(true); setError(null);
    try {
      const params = { ...(value.id ? { providerId: value.id } : {}), name: value.name.trim(), protocol: value.protocol, baseUrl: value.baseUrl.trim(), ...(value.apiKey.trim() ? { apiKey: value.apiKey.trim() } : {}), models: value.models.map((model) => ({ ...model, id: model.id.trim(), name: model.name.trim() || model.id.trim() })) };
      const providers = await call<ProviderDetail[]>(value.id ? "models.update" : "models.create", params);
      onSaved(providers); toast(value.id ? "模型厂商已更新" : "模型厂商已添加", "success");
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  return <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}><DialogContent showCloseButton={false} className="inset-y-0! right-0! left-auto! top-0! h-dvh! max-w-full! translate-x-0! translate-y-0! grid-rows-[auto_minmax(0,1fr)_auto] gap-0 rounded-none p-0 sm:max-w-2xl! data-open:zoom-in-100 data-closed:zoom-out-100 data-open:slide-in-from-right data-closed:slide-out-to-right">{value && <form onSubmit={(event) => void submit(event)} className="contents">
    <DialogHeader className="border-b px-5 py-4 pr-14"><DialogTitle>{value.id ? `编辑 ${value.name}` : "添加模型厂商"}</DialogTitle><DialogDescription>密钥按厂商独立加密保存；协议和服务地址不变时，留空保留现有密钥。</DialogDescription><Button type="button" variant="ghost" size="icon-sm" className="absolute right-4 top-4" aria-label="关闭编辑抽屉" onClick={onClose}><X aria-hidden /></Button></DialogHeader>
    <div className="overflow-y-auto px-5 py-5"><div className="space-y-6"><fieldset className="space-y-4"><legend className="text-sm font-semibold">厂商连接</legend><div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2 sm:col-span-2"><Label htmlFor="provider-preset">预设</Label><Select value={value.presetId} onValueChange={selectPreset}><SelectTrigger id="provider-preset"><SelectValue placeholder="选择预设" /></SelectTrigger><SelectContent>{presets.map((preset) => <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-2"><Label htmlFor="provider-name">厂商名称</Label><Input id="provider-name" required value={value.name} onChange={(event) => patch({ name: event.target.value })} placeholder="例如：生产用 OpenRouter" /></div>
      <div className="space-y-2"><Label htmlFor="provider-protocol">协议</Label><Select value={value.protocol} onValueChange={(protocol) => patch({ protocol: protocol as ProviderProtocol })}><SelectTrigger id="provider-protocol"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai">OpenAI 兼容</SelectItem><SelectItem value="anthropic">Anthropic 兼容</SelectItem></SelectContent></Select></div>
      <div className="space-y-2 sm:col-span-2"><Label htmlFor="provider-url">Base URL</Label><Input id="provider-url" type="url" required spellCheck={false} value={value.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></div>
      <div className="space-y-2 sm:col-span-2"><div className="flex items-center justify-between gap-3"><Label htmlFor="provider-api-key">API Key</Label>{effectiveHasKey && <span className="text-xs tabular-nums text-muted-foreground">当前 ····{effectiveKeyHint}</span>}</div><Input id="provider-api-key" type="password" autoComplete="off" spellCheck={false} required={!effectiveHasKey && !destinationChanged} value={value.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder={effectiveHasKey ? "留空则不更换" : "粘贴该厂商的 API Key"} />{destinationChanged && <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400">协议或服务地址已变更，请重新填写 API Key；留空将清除原密钥</p>}</div>
    </div></fieldset>
    <fieldset className="space-y-4"><legend className="sr-only">模型列表</legend><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold">模型列表</p><p className="mt-1 text-xs text-muted-foreground">自动获取只填入草稿，保存后才会生效。</p></div><div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={!value.id || !effectiveHasKey || fetching} onClick={() => void fetchModels()}>{fetching ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}获取模型</Button><Button type="button" variant="outline" size="sm" onClick={() => patch({ models: [...value.models, emptyModel()] })}><Plus aria-hidden />手动添加</Button></div></div>
      {!value.id && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">首次添加请先保存厂商，再回来使用「获取模型」。也可以现在手动添加。</p>}
      {value.models.length === 0 ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">还没有模型。保存厂商后自动获取，或手动添加一个。</div> : value.models.map((model, index) => <ModelEditor key={index} model={model} index={index} onChange={(next) => patchModel(index, next)} onRemove={() => patch({ models: value.models.filter((_, position) => position !== index) })} />)}
    </fieldset>{error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}</div></div>
    <DialogFooter className="m-0 rounded-none px-5 py-4"><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}{value.id ? "保存更改" : "添加厂商"}</Button></DialogFooter>
  </form>}</DialogContent></Dialog>;
}

function ModelEditor({ model, index, onChange, onRemove }: { model: ModelInput; index: number; onChange: (next: Partial<ModelInput>) => void; onRemove: () => void }) {
  const price = model.price;
  const setPrice = (field: "input" | "output", raw: string) => onChange({ price: { input: field === "input" ? Number(raw) : (price?.input ?? 0), output: field === "output" ? Number(raw) : (price?.output ?? 0), ...(price?.cacheRead == null ? {} : { cacheRead: price.cacheRead }), ...(price?.cacheWrite == null ? {} : { cacheWrite: price.cacheWrite }) } });
  return <div className="rounded-xl border bg-muted/20 p-4"><div className="mb-4 flex items-center justify-between gap-3"><p className="text-sm font-medium">模型 {index + 1}</p><Button type="button" variant="ghost" size="icon-sm" aria-label={`删除模型 ${model.name || model.id || index + 1}`} onClick={onRemove}><Trash2 aria-hidden /></Button></div><div className="grid gap-4 sm:grid-cols-2">
    <div className="space-y-2"><Label htmlFor={`model-${index}-id`}>模型 ID</Label><Input id={`model-${index}-id`} required spellCheck={false} value={model.id} onChange={(event) => onChange({ id: event.target.value })} placeholder="gpt-5" /></div><div className="space-y-2"><Label htmlFor={`model-${index}-name`}>显示名称</Label><Input id={`model-${index}-name`} value={model.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="留空则使用模型 ID" /></div>
    <div className="space-y-2"><Label htmlFor={`model-${index}-context`}>上下文窗口</Label><Input id={`model-${index}-context`} type="number" min="1" required className="tabular-nums" value={model.contextWindow} onChange={(event) => onChange({ contextWindow: Number(event.target.value) })} /></div><div className="space-y-2"><Label htmlFor={`model-${index}-output`}>最大输出 tokens</Label><Input id={`model-${index}-output`} type="number" min="1" required className="tabular-nums" value={model.maxOutputTokens} onChange={(event) => onChange({ maxOutputTokens: Number(event.target.value) })} /></div>
    <label className="flex min-h-8 items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={model.vision} onChange={(event) => onChange({ vision: event.target.checked })} />支持图片输入</label>
    <div className="space-y-2 sm:col-span-2"><Label>支持的思考强度</Label><div className="flex flex-wrap gap-2">{THINKING_OPTIONS.map((level) => <label key={level} className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-xs"><input type="checkbox" className="size-3.5 accent-primary" checked={model.thinkingLevels.includes(level)} onChange={(event) => onChange({ thinkingLevels: event.target.checked ? [...model.thinkingLevels, level] : model.thinkingLevels.filter((item) => item !== level) })} />{THINKING_TEXT[level]}</label>)}</div></div>
    <div className="space-y-2"><Label htmlFor={`model-${index}-input-price`}>输入单价（可选）</Label><Input id={`model-${index}-input-price`} type="number" min="0" step="any" className="tabular-nums" value={price?.input ?? ""} onChange={(event) => event.target.value ? setPrice("input", event.target.value) : onChange({ price: undefined })} placeholder="每百万 tokens" /></div><div className="space-y-2"><Label htmlFor={`model-${index}-output-price`}>输出单价（可选）</Label><Input id={`model-${index}-output-price`} type="number" min="0" step="any" className="tabular-nums" value={price?.output ?? ""} onChange={(event) => event.target.value ? setPrice("output", event.target.value) : onChange({ price: undefined })} placeholder="每百万 tokens" /></div>
  </div></div>;
}

function CjSection() {
  const [hint, setHint] = useState<string | null | undefined>(undefined); const [open, setOpen] = useState(false); const [apiKey, setApiKey] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => onConnect(() => void call<{ keyHint: string | null }>("cj.status").then((result) => setHint(result.keyHint), () => setHint(null))), []);
  const close = () => { setOpen(false); setApiKey(""); setError(null); };
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { setHint((await call<{ keyHint: string | null }>("cj.setKey", { apiKey })).keyHint); close(); toast("CJ API Key 已验证并保存", "success"); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } };
  return <section id="cj" className="scroll-mt-6 space-y-5" aria-labelledby="cj-title"><div id="cj-title"><SectionHeading title="商品资料 CJ" description="CJdropshipping 只作为只读商品资料库，用于标题、图片、规格和成本价；不会授权店铺或自动下单。" /></div><div className="flex flex-col gap-4 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"><div><p className="font-medium">CJdropshipping API Key</p><p className="mt-1 text-sm text-muted-foreground">{hint === undefined ? "正在读取…" : hint ? `已设置 ····${hint}` : "未设置，建站会停在「从 CJ 选品」步骤"}</p></div><Button variant="outline" onClick={() => setOpen(true)}><KeyRound aria-hidden />{hint ? "更换 Key" : "设置 Key"}</Button></div><Dialog open={open} onOpenChange={(next) => !next && close()}><DialogContent><form onSubmit={(event) => void submit(event)} className="space-y-4"><DialogHeader><DialogTitle>设置 CJdropshipping API Key</DialogTitle><DialogDescription>在 CJ 后台「Authorization → API」生成。保存前会先验证，失败时不会写入。</DialogDescription></DialogHeader><div className="space-y-2"><Label htmlFor="cj-key">API Key</Label><Input id="cj-key" type="password" autoComplete="off" required value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoFocus /></div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="outline" onClick={close}>取消</Button><Button type="submit" disabled={busy || !apiKey.trim()}>{busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}验证并保存</Button></DialogFooter></form></DialogContent></Dialog></section>;
}

function MailboxPasswordSection() {
  const confirm = useConfirm(); const [isSet, setIsSet] = useState<boolean | null>(null); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => onConnect(() => void call<{ set: boolean }>("mail.defaultPassword.status").then((result) => setIsSet(result.set), () => setIsSet(null))), []);
  const save = async (value: string | null) => { setBusy(true); setError(null); try { setIsSet((await call<{ set: boolean }>("mail.defaultPassword.set", { password: value })).set); setPassword(""); toast(value ? "默认邮箱密码已保存" : "已改为每个邮箱生成随机密码", "success"); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } };
  const clear = async () => { if (await confirm({ title: "清除默认邮箱密码？", description: "以后新建的邮箱将各自使用随机强密码，已有邮箱不受影响。", confirmText: "清除" })) await save(null); };
  return <section id="mailbox" className="scroll-mt-6 space-y-5" aria-labelledby="mailbox-title"><div id="mailbox-title"><SectionHeading title="邮箱" description="可为新建的 support@ 邮箱设置统一默认密码；不设置时，系统会为每个邮箱生成独立随机强密码，更安全。" /></div><form onSubmit={(event) => { event.preventDefault(); void save(password); }} className="rounded-xl border bg-card p-4 sm:p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-end"><div className="min-w-0 flex-1 space-y-2"><div className="flex items-center justify-between gap-3"><Label htmlFor="mailbox-default-password">默认邮箱密码</Label><span className="text-xs text-muted-foreground">{isSet === null ? "正在读取…" : isSet ? "已设置" : "使用随机密码"}</span></div><Input id="mailbox-default-password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={isSet ? "输入新密码可替换" : "至少 8 位，含大小写、数字和符号"} /></div><div className="flex gap-2"><Button type="submit" disabled={busy || !password}>{busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}保存</Button>{isSet && <Button type="button" variant="outline" disabled={busy} onClick={() => void clear()}>清除</Button>}</div></div>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}<p className="mt-3 text-xs leading-5 text-muted-foreground">统一密码一旦泄露会影响所有使用它的邮箱。密码会加密保存，保存后不会显示。</p></form></section>;
}
