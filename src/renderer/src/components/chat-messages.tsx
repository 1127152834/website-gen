import { CircleAlert, CircleCheck, LoaderCircle, Wrench } from "lucide-react";
import type { ChatItem } from "../../../shared/protocol.ts";
import { cn } from "@/lib/utils";
import { toolDisplayName } from "./chat-message-utils.ts";
import { MarkdownText } from "./chat-markdown.ts";

function readable(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function ToolLine({ item, compact = false }: { item: Extract<ChatItem, { role: "tool" }>; compact?: boolean }) {
  const pending = item.ok === null;
  const label = toolDisplayName(item.name);
  const detail = readable(item.result) || readable(item.args);
  return (
    <details className={cn("group rounded-md border bg-muted/30 text-xs", compact ? "px-2 py-1" : "px-2.5 py-1.5")}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-muted-foreground marker:hidden">
        {pending ? <LoaderCircle className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden /> : item.ok ? <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <CircleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0">{pending ? "执行中" : item.ok ? "已完成" : "失败"}</span>
      </summary>
      {detail && <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all border-t pt-2 font-sans text-[11px] leading-5 text-muted-foreground">{detail}</pre>}
    </details>
  );
}

export function ChatMessage({ item }: { item: ChatItem }) {
  if (item.role === "user") return <div className="ml-auto max-w-[88%] rounded-xl bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">{item.text}</div>;
  if (item.role === "tool") return <ToolLine item={item} />;
  return (
    <div className="min-w-0 max-w-[94%] text-sm leading-6">
      {item.thinking && <details className="mb-1 text-xs text-muted-foreground"><summary className="cursor-pointer select-none">思考过程</summary><p className="mt-1 whitespace-pre-wrap">{item.thinking}</p></details>}
      {item.text && <MarkdownText text={item.text} />}
      {item.error && <p role="alert" className="text-destructive">模型出错：{item.error}</p>}
    </div>
  );
}

export function LiveChatMessage({ text, thinking, tools }: { text: string; thinking: string; tools: Extract<ChatItem, { role: "tool" }>[] }) {
  return <div className="flex min-w-0 flex-col gap-2" aria-live="polite">
    {thinking && !text && <p className="text-xs text-muted-foreground">正在思考…</p>}
    {tools.map((tool) => <ToolLine key={tool.id} item={tool} />)}
    {text ? <div className="min-w-0 max-w-[94%] text-sm leading-6"><MarkdownText text={text} /></div> : !thinking && tools.length === 0 && <LoaderCircle className="size-4 text-muted-foreground motion-safe:animate-spin" aria-label="pi 正在回复" />}
  </div>;
}
