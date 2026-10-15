import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound, LoaderCircle, PlugZap } from "lucide-react";
import type { ModelRole, ProviderSummary, RoleSummary } from "../../../shared/protocol.ts";
import { call, onConnect } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const ROLE_TEXT: Record<ModelRole, { label: string; hint: string }> = {
  agent: { label: "建站与对话", hint: "pi 主对话：建站、选品、运维" },
  vision: { label: "看截图", hint: "审 QA 截图、给图片写说明" },
  bulk: { label: "批量文案", hint: "商品描述、SEO 文案" },
  review: { label: "合规审查", hint: "检查宣传是否真实合规" },
};
const THINKING_TEXT: Record<string, string> = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", max: "最高" };
const PROTOCOL_TEXT = { openai: "OpenAI 格式", anthropic: "Anthropic 格式" } as const;

type TestResult = { ok: true; text: string } | { ok: false; text: string };

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<ProviderSummary | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [tests, setTests] = useState<Record<number, TestResult>>({});

  const load = useCallback(() => {
    call<ProviderSummary[]>("models.providers").then(setProviders, (e: Error) => setError(e.message));
    call<RoleSummary[]>("models.roles").then(setRoles, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => onConnect(load), [load]);

  const test = async (p: ProviderSummary) => {
    setTesting(p.id);
    try {
      const r = await call<{ ms: number; reply: string; cost: number }>("models.test", { providerId: p.id, modelId: p.models[0].id });
      setTests((t) => ({ ...t, [p.id]: { ok: true, text: `连接正常：${(r.ms / 1000).toFixed(1)} 秒，回复「${r.reply}」` } }));
    } catch (e) {
      setTests((t) => ({ ...t, [p.id]: { ok: false, text: (e as Error).message } }));
    } finally {
      setTesting(null);
    }
  };

  // 换提供方时尽量保留同名模型和思考强度；不支持就退到第一个可用的
  const change = async (role: RoleSummary, patch: Partial<Pick<RoleSummary, "providerId" | "modelId" | "thinking">>) => {
    const provider = providers.find((p) => p.id === (patch.providerId ?? role.providerId));
    if (!provider) return;
    const usable = provider.models.filter((m) => role.role !== "vision" || m.vision);
    const model = usable.find((m) => m.id === (patch.modelId ?? role.modelId)) ?? usable[0];
    if (!model) {
      setError(`「${provider.name}」没有适合「${ROLE_TEXT[role.role].label}」的模型`);
      return;
    }
    const wanted = patch.thinking ?? role.thinking;
    const thinking = model.thinkingLevels.includes(wanted) ? wanted : (model.thinkingLevels.find((l) => l !== "off") ?? "off");
    setError(null);
    try {
      setRoles(await call<RoleSummary[]>("models.setRole", { role: role.role, providerId: provider.id, modelId: model.id, thinking }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <div>
        <h1 className="text-lg font-semibold">设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">模型服务的 Key，建站、写文案、看截图、合规审查分别用哪个模型，以及商品资料来源。</p>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <section aria-label="模型提供方" className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">模型提供方</h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>提供方</TableHead>
                <TableHead>格式</TableHead>
                <TableHead>地址</TableHead>
                <TableHead>Key</TableHead>
                <TableHead className="w-0"><span className="sr-only">操作</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <span className="font-medium">{p.name}</span>
                    {tests[p.id] && (
                      <span role="status" className={`mt-1 block whitespace-normal text-xs ${tests[p.id].ok ? "text-green-700" : "text-destructive"}`}>
                        {tests[p.id].text}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{PROTOCOL_TEXT[p.protocol]}</TableCell>
                  <TableCell className="text-muted-foreground">{p.baseUrl}</TableCell>
                  <TableCell>
                    {p.hasKey ? <span className="tabular-nums">已设置，尾号 {p.keyHint}</span> : <Badge variant="outline">未设置</Badge>}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setKeyFor(p)}>
                        <KeyRound aria-hidden />
                        {p.hasKey ? "更换 Key" : "设置 Key"}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={!p.hasKey || testing !== null} onClick={() => void test(p)} aria-label={`测试 ${p.name}`}>
                        {testing === p.id ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <PlugZap aria-hidden />}
                        测试
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section aria-label="用途" className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">各用途使用的模型</h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用途</TableHead>
                <TableHead>提供方</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>思考强度</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((r) => {
                const provider = providers.find((p) => p.id === r.providerId);
                const models = provider?.models.filter((m) => r.role !== "vision" || m.vision) ?? [];
                const levels = provider?.models.find((m) => m.id === r.modelId)?.thinkingLevels ?? [];
                const text = ROLE_TEXT[r.role];
                return (
                  <TableRow key={r.role}>
                    <TableCell>
                      <span className="font-medium">{text.label}</span>
                      <span className="block text-xs text-muted-foreground">{text.hint}</span>
                    </TableCell>
                    <TableCell>
                      <Select value={String(r.providerId)} onValueChange={(v) => void change(r, { providerId: Number(v) })}>
                        <SelectTrigger className="w-52" aria-label={`${text.label}的提供方`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {providers.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select value={r.modelId} onValueChange={(v) => void change(r, { modelId: v })}>
                        <SelectTrigger className="w-40" aria-label={`${text.label}的模型`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {models.map((m) => <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select value={r.thinking} onValueChange={(v) => void change(r, { thinking: v })}>
                        <SelectTrigger className="w-24" aria-label={`${text.label}的思考强度`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {levels.map((l) => <SelectItem key={l} value={l}>{THINKING_TEXT[l] ?? l}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {r.ready ? <Badge variant="secondary">可用</Badge> : <span className="text-xs text-amber-700">{r.problem}</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      <CjSection />

      <KeyDialog provider={keyFor} onClose={() => setKeyFor(null)} onSaved={(list) => { setProviders(list); load(); }} />
    </div>
  );
}

/** CJdropshipping 只当商品资料库：选品和上架时读商品资料，不授权店铺、不下单。 */
function CjSection() {
  const [hint, setHint] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onConnect(() => void call<{ keyHint: string | null }>("cj.status").then((r) => setHint(r.keyHint), () => setHint(null))), []);

  const close = () => {
    setApiKey("");
    setError(null);
    setOpen(false);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setHint((await call<{ keyHint: string | null }>("cj.setKey", { apiKey })).keyHint);
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="商品资料" className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">商品资料</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">建站时从 CJdropshipping 读取商品的标题、图片、规格和成本价，只读，不授权店铺、不下单。</p>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3 text-sm">
        <div>
          <p className="font-medium">CJdropshipping API Key</p>
          <p className="text-muted-foreground">{hint === undefined ? "读取中…" : hint ? `已设置，尾号 ${hint}` : "未设置，建站会停在「从 CJ 选品」这一步"}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <KeyRound aria-hidden />
          {hint ? "更换 Key" : "设置 Key"}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>设置 CJdropshipping 的 Key</DialogTitle>
              <DialogDescription>在 CJ 后台的「Authorization → API」里生成。保存前会先向 CJ 验证，Key 加密保存在这台电脑上。</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cj-key">API Key</Label>
              <Input id="cj-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoFocus />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={busy || !apiKey.trim()}>
                {busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
                验证并保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function KeyDialog({ provider, onClose, onSaved }: { provider: ProviderSummary | null; onClose: () => void; onSaved: (list: ProviderSummary[]) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 关闭时清空，Key 不在界面里多停留
  const close = () => {
    setApiKey("");
    setError(null);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await call<ProviderSummary[]>("models.setKey", { providerId: provider.id, apiKey }));
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={provider !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>设置 {provider?.name} 的 Key</DialogTitle>
            <DialogDescription>
              同一服务的其他格式会一起更新（例如 DeepSeek 的两种格式共用一个 Key）。Key 加密保存在这台电脑上，保存后不会再显示。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="provider-key">API Key</Label>
            <Input id="provider-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoFocus />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !apiKey.trim()}>
              {busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
