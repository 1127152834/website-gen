import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CircleAlert, Clock, ExternalLink, LoaderCircle, MessageSquarePlus, RotateCcw, Send, Square, Wrench } from "lucide-react";
import type { ChangeSummary, ChatEvent, ChatItem, SiteListItem } from "../../../shared/protocol.ts";
import { call, onChanged, onChat, onConnect } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

const TOOL_TEXT: Record<string, string> = {
  get_site: "查看站点概况", get_copy: "读取文案", get_policy: "读取政策页", list_products: "查看商品列表", get_product: "读取商品",
  list_changes: "查看变更记录", update_copy: "修改文案", update_policy: "修改政策页", update_announcement: "修改公告栏",
  update_style: "切换风格", update_product: "修改商品", revert_change: "回滚变更", schedule_revert: "设置定时恢复",
};
const INITIATOR = { pi: "pi", you: "你", schedule: "定时恢复" } as const;
const SUGGESTIONS = ["把顶部公告改成冬季上新的提示，12 月 1 日恢复", "首页大标题写得更有温度一点", "把 FAQ 里关于退货的回答写得更清楚"];
const dateTime = (ts: number) => new Date(ts).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 工具结果里给人看的那句话：成功的说明，或没通过的原因 */
function toolOutcome(result: string): string {
  try {
    const r = JSON.parse(result) as { ok?: boolean; note?: string; problems?: string[]; error?: string };
    if (r.ok === false) return r.error ?? (r.problems ?? []).join("; ");
    return r.note ?? "";
  } catch {
    return "";
  }
}

/** 模型偶尔还是会用 **加粗**：渲染成加粗，其余 Markdown 原样显示 */
const rich = (text: string) =>
  text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part));

type Live = { text: string; thinking: string; tools: Extract<ChatItem, { role: "tool" }>[] };
const emptyLive = (): Live => ({ text: "", thinking: "", tools: [] });

function ToolLine({ item }: { item: Extract<ChatItem, { role: "tool" }> }) {
  const outcome = item.ok === null ? "" : toolOutcome(item.result);
  return (
    <div className="flex items-start gap-2 text-xs text-muted-foreground">
      {item.ok === null ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
        : item.ok ? <Wrench className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        : <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />}
      <span>
        {TOOL_TEXT[item.name] ?? item.name}
        {outcome && <span className={cn("ml-1", item.ok === false && "text-amber-700")}>：{outcome}</span>}
      </span>
    </div>
  );
}

function Message({ item }: { item: ChatItem }) {
  if (item.role === "user") {
    return <div className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">{item.text}</div>;
  }
  if (item.role === "tool") return <ToolLine item={item} />;
  return (
    <div className="max-w-[92%] text-sm">
      {item.thinking && (
        <details className="mb-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">思考过程</summary>
          <p className="mt-1 whitespace-pre-wrap">{item.thinking}</p>
        </details>
      )}
      {item.text && <p className="whitespace-pre-wrap">{rich(item.text)}</p>}
      {item.error && <p role="alert" className="text-destructive">模型出错：{item.error}</p>}
    </div>
  );
}

export function SitesPage() {
  const [sites, setSites] = useState<SiteListItem[] | null>(null);
  const [siteId, setSiteId] = useState<number | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [changes, setChanges] = useState<ChangeSummary[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reverting, setReverting] = useState<ChangeSummary | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const current = useRef<number | null>(null);
  current.current = siteId;

  const fail = (e: Error) => setError(e.message);
  const loadSites = useCallback(() => void call<SiteListItem[]>("sites.list").then(setSites, fail), []);
  const loadChat = useCallback(() => {
    const id = current.current;
    if (id == null) return;
    call<{ items: ChatItem[]; busy: boolean }>("chat.history", { siteId: id }).then((h) => {
      setItems(h.items);
      setLive((l) => (h.busy ? (l ?? emptyLive()) : null));
    }, fail);
  }, []);
  const loadChanges = useCallback(() => {
    const id = current.current;
    if (id != null) call<ChangeSummary[]>("changes.list", { siteId: id }).then(setChanges, fail);
  }, []);

  useEffect(() => {
    const offs = [
      onConnect(() => {
        loadSites();
        loadChat();
        loadChanges();
      }),
      onChanged("batches", loadSites),
      onChanged("changes", loadChanges),
      onChat((id, e: ChatEvent) => {
        if (id !== current.current) return;
        if (e.type === "settled") {
          loadChat();
          return;
        }
        if (e.type === "error") {
          setError(`pi 出错：${e.message}`);
          return;
        }
        setLive((l) => {
          const next = { ...(l ?? emptyLive()) };
          if (e.type === "text") next.text += e.delta;
          else if (e.type === "thinking") next.thinking += e.delta;
          else if (e.type === "tool_start") next.tools = [...next.tools, { role: "tool", id: e.id, name: e.name, args: e.args, ok: null, result: "" }];
          else if (e.type === "tool_end") next.tools = next.tools.map((t) => (t.id === e.id ? { ...t, ok: e.ok, result: e.result } : t));
          return next;
        });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [loadSites, loadChat, loadChanges]);

  useEffect(() => {
    if (sites && !sites.some((s) => s.id === siteId)) setSiteId(sites[0]?.id ?? null);
  }, [sites, siteId]);
  useEffect(() => {
    setItems([]);
    setLive(null);
    setChanges([]);
    setError(null);
    loadChat();
    loadChanges();
  }, [siteId, loadChat, loadChanges]);
  // 花括号不能省：新版 Chromium 的 scrollIntoView 返回 Promise
  useEffect(() => {
    void endRef.current?.scrollIntoView({ block: "end" });
  }, [items.length, live?.text.length, live?.tools.length]);

  const busy = live !== null;
  const send = async (text: string) => {
    if (siteId == null || !text.trim() || busy) return;
    setError(null);
    setItems((list) => [...list, { role: "user", text: text.trim() }]);
    setLive(emptyLive());
    setDraft("");
    try {
      await call("chat.send", { siteId, text });
    } catch (e) {
      setLive(null);
      fail(e as Error);
      loadChat();
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };
  const revert = async (c: ChangeSummary) => {
    setError(null);
    try {
      await call("changes.revert", { siteId, changeId: c.id });
    } catch (e) {
      fail(e as Error);
    } finally {
      setReverting(null);
      loadChanges();
    }
  };
  const site = sites?.find((s) => s.id === siteId) ?? null;

  if (sites && sites.length === 0) {
    return (
      <div className="flex max-w-5xl flex-col gap-6">
        <h1 className="text-lg font-semibold">站点</h1>
        <div className="rounded-lg border border-dashed p-8 text-sm">
          <p className="font-medium">还没有建好的站</p>
          <p className="mt-1 text-muted-foreground">建站流程（含 QA）全部完成的站会出现在这里，可以和 pi 对话修改文案、政策、公告、风格和商品描述，每次修改都能回滚。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <h1 className="text-lg font-semibold">站点</h1>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="grid min-h-0 flex-1 grid-cols-[12rem_minmax(0,1fr)] gap-6 xl:grid-cols-[12rem_minmax(0,1fr)_20rem]">
        <nav aria-label="站点列表" className="flex flex-col gap-1">
          {sites?.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={s.id === siteId ? "true" : undefined}
              onClick={() => setSiteId(s.id)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                s.id === siteId ? "border-primary/40 bg-accent" : "border-transparent hover:bg-accent/60",
              )}
            >
              <span className="block truncate font-medium">{s.domain}</span>
              <span className="text-xs text-muted-foreground">{s.launchedAt ? "已上线" : "维护模式中"}</span>
            </button>
          ))}
        </nav>

        <section aria-label="和 pi 对话" className="flex min-h-[28rem] min-w-0 flex-col rounded-lg border">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">和 pi 对话</span>
              {site && (
                <a href={`https://${site.domain}/`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
                  {site.domain}<ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </div>
            <Button variant="ghost" size="sm" disabled={busy || siteId == null} onClick={() => void call("chat.reset", { siteId }).then(loadChat, fail)}>
              <MessageSquarePlus aria-hidden />
              新对话
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 p-4">
              {items.length === 0 && !live && (
                <div className="text-sm text-muted-foreground">
                  <p>告诉 pi 你想怎么改这个站。修改会马上生效（站点在维护模式下访客看不到），每次修改都记在右边，可以回滚。</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {SUGGESTIONS.map((s) => (
                      <Button key={s} variant="outline" size="sm" className="h-auto py-1 whitespace-normal text-left" onClick={() => setDraft(s)}>{s}</Button>
                    ))}
                  </div>
                </div>
              )}
              {items.map((item, i) => <Message key={i} item={item} />)}
              {live && (
                <div className="flex flex-col gap-2" aria-live="polite">
                  {live.thinking && !live.text && <p className="text-xs text-muted-foreground">正在思考…</p>}
                  {live.tools.map((t) => <ToolLine key={t.id} item={t} />)}
                  {live.text ? <p className="max-w-[92%] text-sm whitespace-pre-wrap">{rich(live.text)}</p>
                    : !live.thinking && live.tools.length === 0 && <LoaderCircle className="size-4 text-muted-foreground motion-safe:animate-spin" aria-label="pi 正在回复" />}
                </div>
              )}
              <div ref={endRef} />
            </div>
          </ScrollArea>
          <form onSubmit={submit} className="flex items-end gap-2 border-t p-3">
            <label htmlFor="chat-input" className="sr-only">给 pi 的消息</label>
            <textarea
              id="chat-input"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder="例如：把公告栏改成冬季上新的提示（Enter 发送，Shift+Enter 换行）"
              disabled={siteId == null}
              className="min-h-14 flex-1 resize-none rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            />
            {busy ? (
              <Button type="button" variant="outline" onClick={() => void call("chat.abort", { siteId }).catch(fail)}>
                <Square aria-hidden />
                停止
              </Button>
            ) : (
              <Button type="submit" disabled={!draft.trim() || siteId == null}>
                <Send aria-hidden />
                发送
              </Button>
            )}
          </form>
        </section>

        <section aria-label="变更记录" className="col-span-2 flex min-w-0 flex-col gap-2 xl:col-span-1">
          <h2 className="text-sm font-medium">变更记录</h2>
          {changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有修改过。pi 每次修改前都会给改动的内容拍快照，可以随时整体回滚。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {changes.map((c) => (
                <li key={c.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium">#{c.id} {c.summary}</p>
                    {c.status === "applied" ? <Badge variant="secondary">已生效</Badge> : <Badge variant="outline">已回滚</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {dateTime(c.createdAt)}，由{INITIATOR[c.initiator]}修改：{c.targets.join("、")}
                  </p>
                  {c.revertedAt && <p className="text-xs text-muted-foreground">{dateTime(c.revertedAt)} 已回滚</p>}
                  {c.status === "applied" && c.revertAt && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-amber-700">
                      <Clock className="size-3" aria-hidden />
                      将于 {dateTime(c.revertAt)} 自动回滚
                      <button type="button" className="ml-1 underline underline-offset-2" onClick={() => void call("changes.cancelSchedule", { siteId, changeId: c.id }).then(loadChanges, fail)}>取消</button>
                    </p>
                  )}
                  {c.revertError && <p className="mt-1 text-xs text-destructive">定时恢复失败：{c.revertError}</p>}
                  {c.status === "applied" && (
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => setReverting(c)}>
                      <RotateCcw aria-hidden />
                      回滚
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <AlertDialog open={reverting !== null} onOpenChange={(open) => !open && setReverting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>回滚变更 #{reverting?.id}？</AlertDialogTitle>
            <AlertDialogDescription>
              「{reverting?.summary}」改动的内容会恢复成修改前的快照：{reverting?.targets.join("、")}。如果这些内容之后又被改过，会拒绝回滚，需要先回滚更晚的变更。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => reverting && void revert(reverting)}>回滚</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
