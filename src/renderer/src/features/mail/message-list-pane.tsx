import { ChevronLeft, ChevronRight, Inbox, Search } from "lucide-react";
import type { MailListResult, MailMessageSummary, MailboxSummary } from "../../../../shared/mail-types.ts";
import type { MailMessageAnnotation } from "../../../../shared/mail-triage-types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const date = (value: number) => new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export function MessageRow({ item, annotation, active, onOpen }: { item: MailMessageSummary; annotation?: MailMessageAnnotation; active: boolean; onOpen(): void }) {
  return <button type="button" className={cn("block min-h-[5.75rem] w-full border-b p-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", active && "bg-accent", !item.seen && "bg-primary/5 font-medium")} onClick={onOpen}>
    <span className="flex items-center justify-between gap-2"><span className="truncate text-sm">{item.from || "未知发件人"}</span><span className="shrink-0 text-xs text-muted-foreground">{date(item.date)}</span></span>
    <span className="mt-1 flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm">{item.subject || "（无主题）"}</span>{annotation?<Badge variant="outline" className="shrink-0">{annotation.tag}</Badge>:null}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{annotation?.summary??item.snippet}</span>
  </button>;
}
export function MessageRowSkeleton() { return <div data-testid="mail-row-skeleton" aria-hidden="true" className="min-h-[5.75rem] animate-pulse border-b p-3"><div className="h-4 w-2/5 rounded bg-muted" /><div className="mt-2 h-4 w-3/4 rounded bg-muted" /><div className="mt-2 h-3 w-full rounded bg-muted" /></div>; }

export function MessageListPane({ mailbox, folder, query, busy, messages, annotations={}, selectedUid, pageSize, onQuery, onOpen, onPrevious, onNext }: {
  mailbox: MailboxSummary | null; folder: string; query: string; busy: boolean; messages: MailListResult | null; selectedUid?: number; pageSize: number;
  annotations?: Readonly<Record<number,MailMessageAnnotation>>;
  onQuery(value: string): void; onOpen(uid: number): void; onPrevious(): void; onNext(): void;
}) {
  if (!mailbox) return <section aria-label="邮件列表" className="min-w-0 border-r p-8 text-sm text-muted-foreground">请先选择邮箱。</section>;
  if (!mailbox.credentialSaved) return <section aria-label="邮件列表" className="min-w-0 border-r p-8 text-center text-sm"><p className="font-medium">这个邮箱还没有可用凭据</p><p className="mt-1 text-muted-foreground">请前往邮箱管理验证密码后再读取邮件。</p></section>;
  return <section aria-label="邮件列表" className="min-w-0 border-r"><div className="border-b p-3"><p className="truncate text-sm font-medium">{mailbox.address}</p><p className="text-xs text-muted-foreground">{folder}</p><label className="relative mt-3 block"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden /><Input className="pl-8" value={query} onChange={event => onQuery(event.target.value)} placeholder="搜索发件人或主题" /></label></div>
    <div aria-busy={busy} className={cn("max-h-[calc(100dvh-22rem)] overflow-auto transition-opacity", busy && messages && "opacity-60")}>{messages === null ? <div role="status" aria-label="正在读取邮件">{Array.from({ length: 6 }, (_, index) => <MessageRowSkeleton key={index} />)}</div> : messages.items.length === 0 ? <div className="p-8 text-center text-sm"><Inbox className="mx-auto mb-2 size-7 text-muted-foreground" aria-hidden /><p className="font-medium">{query ? "没有匹配的邮件" : "这个文件夹是空的"}</p></div> : messages.items.map(item => <MessageRow key={item.uid} item={item} annotation={annotations[item.uid]?.readIdentity===item.readIdentity?annotations[item.uid]:undefined} active={item.uid === selectedUid} onOpen={() => onOpen(item.uid)} />)}</div>
    {messages && messages.total > pageSize ? <div className="flex items-center justify-between border-t p-2 text-xs text-muted-foreground"><span>第 {messages.page} 页，共 {Math.ceil(messages.total / messages.pageSize)} 页</span><div><Button variant="ghost" size="icon-sm" aria-label="上一页" disabled={messages.page <= 1} onClick={onPrevious}><ChevronLeft /></Button><Button variant="ghost" size="icon-sm" aria-label="下一页" disabled={messages.page * pageSize >= messages.total} onClick={onNext}><ChevronRight /></Button></div></div> : null}
  </section>;
}
