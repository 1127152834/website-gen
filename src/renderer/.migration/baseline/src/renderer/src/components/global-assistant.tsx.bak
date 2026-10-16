import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, MessageSquarePlus, Send, Settings, Square, X } from "lucide-react";
import type { AssistantConfirmation, AssistantEvent, ChatItem } from "../../../shared/protocol.ts";
import { call, onAssistant, onConnect } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button.tsx";
import { ChatMessage, LiveChatMessage } from "@/components/chat-messages.tsx";
import { toolDisplayName } from "@/components/chat-message-utils.ts";
import { confirmationParamEntries } from "@/components/confirmation-params.ts";
import { applyChatEvent, emptyLiveChat, LatestRequest, type LiveChat } from "@/components/assistant-state.ts";
import { cn } from "@/lib/utils.ts";

type AssistantHistory = { items: ChatItem[]; busy: boolean; pending: AssistantConfirmation[] };
const EXAMPLES = ["我有哪些站点还没上线？", "怎么批量建站？", "看一下 Grist 里 WGwork 的表"];

function PiMascot({ state }: { state: "idle" | "busy" | "happy" }) {
  return <svg className={cn("pi-mascot", `pi-mascot-${state}`)} viewBox="0 0 72 72" role="img" aria-label={state === "busy" ? "小助手正在工作" : "pi 小助手"}>
    <path className="pi-shadow" d="M18 61c8-5 28-5 36 0-7 5-29 5-36 0Z" />
    <path className="pi-body" d="M15 38c0-15 9-27 21-27s21 12 21 27c0 17-7 25-21 25S15 55 15 38Z" />
    <path className="pi-highlight" d="M23 23c4-6 10-8 15-7" />
    <g className="pi-face"><ellipse cx="29" cy="37" rx="2.7" ry="4" /><ellipse cx="44" cy="37" rx="2.7" ry="4" /><path d="M32 47c3 3 6 3 9 0" /></g>
    <path className="pi-cheek" d="M22 44h5M46 44h5" />
    <path className="pi-arm" d="M55 40c7-3 8-8 5-11" />
    {state === "busy" && <g className="pi-orbit"><circle cx="59" cy="17" r="2" /><circle cx="64" cy="23" r="1.5" /><circle cx="56" cy="10" r="1.2" /></g>}
  </svg>;
}

function ConfirmCard({ item, resolving, onResolve }: { item: AssistantConfirmation; resolving: boolean; onResolve: (approve: boolean) => void }) {
  const params = confirmationParamEntries(item.args);
  return <article className="min-w-0 rounded-xl border border-amber-300/70 bg-amber-50/80 p-3 text-sm shadow-sm dark:border-amber-700/60 dark:bg-amber-950/30" aria-labelledby={`confirm-${item.id}`}>
    <p id={`confirm-${item.id}`} className="font-medium">需要你的确认</p>
    <p className="mt-1 leading-5 text-muted-foreground"><span className="font-medium text-foreground">{toolDisplayName(item.name)}</span>：{item.description}</p>
    {params.length > 0 && <dl className="mt-2 space-y-1 rounded-md bg-background/70 p-2 text-xs text-muted-foreground">
      {params.map((param, index) => <div key={`${param.label}-${index}`} className="flex min-w-0 items-start gap-1 leading-5">
        <dt className="max-w-[40%] shrink-0 break-all font-medium text-foreground">{param.label}：</dt>
        <dd className="min-w-0 break-all">{param.value}</dd>
      </div>)}
    </dl>}
    <p className="mt-2 text-xs text-muted-foreground">超过 10 分钟未处理会自动取消。</p>
    <div className="mt-3 flex justify-end gap-2"><Button type="button" size="sm" variant="outline" disabled={resolving} onClick={() => onResolve(false)}>取消</Button><Button type="button" size="sm" disabled={resolving} onClick={() => onResolve(true)}>确认执行</Button></div>
  </article>;
}

export function GlobalAssistant({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [items, setItems] = useState<ChatItem[]>([]);
  const [live, setLive] = useState<LiveChat | null>(null);
  const [pending, setPending] = useState<AssistantConfirmation[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [happy, setHappy] = useState(false);
  const [resolving, setResolving] = useState<Set<string>>(() => new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const happyTimer = useRef<number | null>(null);
  const historyRequest = useRef(new LatestRequest());

  const load = useCallback(() => {
    const request = historyRequest.current.begin();
    void call<AssistantHistory>("assistant.history").then((history) => {
      if (!historyRequest.current.isCurrent(request)) return;
      setItems(history.items);
      setPending(history.pending ?? []);
      setLive((current) => history.busy ? current ?? emptyLiveChat() : null);
      setError(null);
    }, (reason: Error) => { if (historyRequest.current.isCurrent(request)) setError(reason.message); });
  }, []);

  useEffect(() => {
    const off = [onConnect(load), onAssistant((event: AssistantEvent) => {
      historyRequest.current.invalidate();
      if (event.type === "confirm") {
        setPending((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
        if (!openRef.current) setUnread(true);
        return;
      }
      if (event.type === "confirm_resolved") {
        setPending((current) => current.filter((item) => item.id !== event.id));
        setResolving((current) => { const next = new Set(current); next.delete(event.id); return next; });
        return;
      }
      if (event.type === "settled") {
        setLive(null);
        load();
        setHappy(true);
        if (!openRef.current) setUnread(true);
        if (happyTimer.current != null) window.clearTimeout(happyTimer.current);
        happyTimer.current = window.setTimeout(() => setHappy(false), 1400);
        return;
      }
      if (event.type === "error") {
        setError(event.message);
        setLive(null);
        if (!openRef.current) setUnread(true);
        return;
      }
      if (event.type === "text" && !openRef.current) setUnread(true);
      setLive((current) => applyChatEvent(current ?? emptyLiveChat(), event));
    })];
    return () => { off.forEach((dispose) => dispose()); if (happyTimer.current != null) window.clearTimeout(happyTimer.current); };
  }, [load]);

  const closePanel = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => launcherRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!open) return;
    setUnread(false);
    window.requestAnimationFrame(() => closeRef.current?.focus());
  }, [open]);
  useEffect(() => { if (open) void endRef.current?.scrollIntoView({ block: "end" }); }, [open, items.length, live?.text.length, live?.tools.length, pending.length]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") closePanel(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [closePanel, open]);

  const busy = live !== null;
  const modelMissing = Boolean(error && /(模型|建站与对话).*(设置|配置|可用)|设置.*模型/.test(error));
  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    historyRequest.current.invalidate();
    setError(null); setItems((current) => [...current, { role: "user", text: message }]); setLive(emptyLiveChat()); setDraft("");
    try { await call("assistant.send", { text: message, page: window.location.pathname }); }
    catch (reason) { setLive(null); setError((reason as Error).message); load(); }
  };
  const reset = async () => {
    historyRequest.current.invalidate();
    setError(null);
    try { await call("assistant.reset"); setItems([]); setLive(null); setPending([]); }
    catch (reason) { setError((reason as Error).message); }
  };
  const abort = async () => {
    historyRequest.current.invalidate();
    try { await call("assistant.abort"); setPending([]); setLive(null); load(); }
    catch (reason) { setError((reason as Error).message); }
  };
  const resolve = async (id: string, approve: boolean) => {
    historyRequest.current.invalidate();
    setResolving((current) => new Set(current).add(id));
    try {
      const result = await call<{ ok?: boolean }>("assistant.confirm", { id, approve });
      setPending((current) => current.filter((item) => item.id !== id));
      setResolving((current) => { const next = new Set(current); next.delete(id); return next; });
      if (result?.ok === false) { setError("这次确认已经取消或过期，没有执行。"); load(); }
    }
    catch (reason) { setError((reason as Error).message); setResolving((current) => { const next = new Set(current); next.delete(id); return next; }); }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(draft); }
  };

  return <>
    {open && <section className="assistant-panel" role="dialog" aria-modal="false" aria-labelledby="assistant-title">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <div className="size-10 shrink-0"><PiMascot state={busy ? "busy" : happy ? "happy" : "idle"} /></div>
        <div className="min-w-0 flex-1"><h2 id="assistant-title" className="font-semibold">pi 小助手</h2><p className="truncate text-xs text-muted-foreground">能查业务、执行业务操作，也能回答怎么用</p></div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="开始新对话" title="开始新对话" onClick={() => void reset()}><MessageSquarePlus aria-hidden /></Button>
        <Button ref={closeRef} type="button" variant="ghost" size="icon-sm" aria-label="收起小助手" onClick={closePanel}><X aria-hidden /></Button>
      </header>
      {error && <div role="alert" className="border-b bg-destructive/5 px-4 py-2 text-sm text-destructive"><p>{error}</p>{modelMissing && <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { onNavigate("/settings"); setOpen(false); }}><Settings aria-hidden />去设置模型</Button>}</div>}
      <div className="assistant-messages" aria-label="对话内容">
        {items.length === 0 && !live && <div className="my-auto py-8 text-center text-sm text-muted-foreground"><p className="font-medium text-foreground">嗨，我是你的全局小助手</p><p className="mt-1">可以先帮你查清楚，再执行业务操作。</p><div className="mt-5 grid gap-2">{EXAMPLES.map((example) => <button type="button" key={example} className="rounded-lg border bg-background px-3 py-2 text-left text-xs leading-5 transition-colors hover:bg-accent hover:text-accent-foreground" onClick={() => void send(example)}>{example}</button>)}</div></div>}
        {items.map((item, index) => <ChatMessage key={`${item.role}-${index}`} item={item} />)}
        {live && <LiveChatMessage {...live} />}
        {pending.map((item) => <ConfirmCard key={item.id} item={item} resolving={resolving.has(item.id)} onResolve={(approve) => void resolve(item.id, approve)} />)}
        <div ref={endRef} />
      </div>
      <form className="shrink-0 border-t bg-card p-3" onSubmit={(event) => { event.preventDefault(); void send(draft); }}>
        <label htmlFor="global-assistant-input" className="sr-only">给 pi 小助手的消息</label>
        <textarea id="global-assistant-input" rows={2} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey} placeholder={busy ? "小助手正在处理…" : "问业务问题或告诉我你想做什么"} className="min-h-14 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
        <div className="mt-2 flex items-center justify-between"><p className="text-[11px] text-muted-foreground">Enter 发送 · Shift+Enter 换行</p>{busy ? <Button type="button" size="sm" variant="outline" onClick={() => void abort()}><Square aria-hidden />停止</Button> : <Button type="submit" size="sm" disabled={!draft.trim()}><Send aria-hidden />发送</Button>}</div>
      </form>
    </section>}
    <button ref={launcherRef} type="button" className={cn("assistant-launcher", busy && "is-busy", happy && "is-happy")} aria-label={open ? "收起 pi 小助手" : "打开 pi 小助手"} aria-expanded={open} onClick={() => open ? closePanel() : setOpen(true)}>
      <PiMascot state={busy ? "busy" : happy ? "happy" : "idle"} />
      <span className="assistant-launcher-label">问问 pi</span>
      {unread && !open && <span className="assistant-unread" aria-label="有新回复" />}
      {open && <ChevronDown className="assistant-launcher-close" aria-hidden />}
    </button>
  </>;
}
