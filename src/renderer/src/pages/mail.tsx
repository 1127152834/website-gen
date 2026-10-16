import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Forward, Inbox, KeyRound, LoaderCircle, Mail, MailOpen, MoreVertical, Paperclip, PenLine, RefreshCw, Reply, ReplyAll, Search, Send, Trash2 } from "lucide-react";
import type { MailAttachment, MailFolder, MailListResult, MailMessageDetail, MailMessageSummary, MailboxSummary } from "../../../shared/mail-types.ts";
import { MailBody } from "@/components/mail-body.ts";
import { toast, useConfirm } from "@/components/feedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { call, onChanged, onConnect, onMail } from "@/lib/backend.ts";
import { cn } from "@/lib/utils";
import { folderUnread, MailOpenState, mailSelectionRedirect } from "@/lib/mail-open-state.ts";

const PAGE_SIZE = 30;
const MAX_ATTACHMENTS = 20 * 1024 * 1024;

type ComposeMode = "new" | "reply" | "reply-all" | "forward";
type Upload = { name: string; type: string; size: number; dataBase64: string };

const date = (value: number) => new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const emailOnly = (value: string) => value.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? value.trim();
const splitAddresses = (value: string) => value.split(/[;,]/).map(emailOnly).filter(Boolean);
const quote = (message: MailMessageDetail) => `\n\n--- 原邮件 ---\n发件人：${message.from}\n日期：${new Date(message.date).toLocaleString("zh-CN")}\n主题：${message.subject}\n\n${message.text.split("\n").map((line) => `> ${line}`).join("\n")}`;
const routeFor = (mailboxId: number, folder: string, uid?: number) => `/mail/${mailboxId}/${encodeURIComponent(folder)}${uid == null ? "" : `/${uid}`}`;

export function MailPage({ mailboxId, folder, uid, onNavigate }: { mailboxId?: number; folder?: string; uid?: number; onNavigate: (path: string) => void }) {
  const confirm = useConfirm();
  const [mailboxes, setMailboxes] = useState<MailboxSummary[] | null>(null);
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [messages, setMessages] = useState<MailListResult | null>(null);
  const [message, setMessage] = useState<MailMessageDetail | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [credentialFor, setCredentialFor] = useState<MailboxSummary | null>(null);
  const [compose, setCompose] = useState<{ mailbox: MailboxSummary; mode: ComposeMode; original?: MailMessageDetail } | null>(null);
  const folderRequest = useRef(0);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const openState = useRef(new MailOpenState());
  const activeMailbox = mailboxes?.find((item) => item.id === mailboxId) ?? null;
  const credentialSaved = activeMailbox?.credentialSaved ?? false;
  const activeFolder = folder ?? "INBOX";

  const loadMailboxes = useCallback(() => {
    void call<MailboxSummary[]>("mail.list").then((items) => {
      setMailboxes(items);
      setError(null);
      const redirect = mailSelectionRedirect(mailboxId, items.map((item) => item.id));
      if (redirect) onNavigate(redirect);
    }, (reason: Error) => setError(reason.message));
  }, [mailboxId, onNavigate]);

  const loadFolders = useCallback(() => {
    if (!mailboxId || !credentialSaved) return;
    const request = ++folderRequest.current;
    void call<MailFolder[]>("mail.folders", { mailboxId }).then((items) => { if (request === folderRequest.current) setFolders(items); }, (reason: Error) => { if (request === folderRequest.current) setError(reason.message); });
  }, [credentialSaved, mailboxId]);

  const loadMessages = useCallback(() => {
    if (!mailboxId || !credentialSaved) return;
    const request = ++listRequest.current;
    void call<MailListResult>("mail.messages", { mailboxId, folder: activeFolder, query: query.trim() || undefined, page, pageSize: PAGE_SIZE }).then((result) => { if (request === listRequest.current) setMessages(result); }, (reason: Error) => { if (request === listRequest.current) setError(reason.message); });
  }, [activeFolder, credentialSaved, mailboxId, page, query]);

  useEffect(() => onConnect(loadMailboxes), [loadMailboxes]);
  useEffect(() => { folderRequest.current++; listRequest.current++; detailRequest.current++; setPage(1); setFolders([]); setMessages(null); setMessage(null); setError(null); }, [activeFolder, mailboxId]);
  useEffect(() => { loadFolders(); }, [loadFolders]);
  useEffect(() => { setMessages(null); loadMessages(); }, [loadMessages]);
  useEffect(() => {
    if (!mailboxId || uid == null || !credentialSaved) { setMessage(null); if (uid == null) openState.current.leaveMessage(); return; }
    const request = ++detailRequest.current;
    void call<MailMessageDetail>("mail.message", { mailboxId, folder: activeFolder, uid }).then((item) => {
      if (request !== detailRequest.current) return;
      setMessage(item);
      if (openState.current.shouldAutoMark(mailboxId, activeFolder, uid, item.seen)) {
        void call("mail.seen", { mailboxId, folder: activeFolder, uid, seen: true }).then(() => {
          setMessage((current) => current?.uid === uid && current.folder === activeFolder ? { ...current, seen: true } : current);
          setMessages((current) => current ? { ...current, items: current.items.map((entry) => entry.uid === uid ? { ...entry, seen: true } : entry) } : current);
          loadMailboxes();
          loadFolders();
        });
      }
    }, (reason: Error) => { if (request === detailRequest.current) setError(reason.message); });
  }, [activeFolder, credentialSaved, loadFolders, loadMailboxes, mailboxId, uid]);
  useEffect(() => onMail((event) => {
    loadMailboxes();
    if (event.mailboxId === mailboxId) { loadFolders(); loadMessages(); }
  }), [loadFolders, loadMailboxes, loadMessages, mailboxId]);
  useEffect(() => onChanged("mail", () => { loadMailboxes(); loadFolders(); loadMessages(); }), [loadFolders, loadMailboxes, loadMessages]);

  const sync = async () => {
    setSyncing(true); setError(null);
    try { await call("mail.sync"); toast("邮箱清单已同步"); loadMailboxes(); }
    catch (reason) { setError((reason as Error).message); }
    finally { setSyncing(false); }
  };
  const setMonitoring = async (mailbox: MailboxSummary, enabled: boolean) => {
    try { await call("mail.monitor", { mailboxId: mailbox.id, enabled }); toast(enabled ? "已开始监听" : "已停止监听"); loadMailboxes(); }
    catch (reason) { toast((reason as Error).message, "error"); }
  };
  const deleteMailbox = async (mailbox: MailboxSummary) => {
    if (!await confirm({ title: `永久删除 ${mailbox.address}？`, description: "将删除 Hostinger 邮箱，并清除本工作区中的凭据、邮件索引和正文缓存。此操作无法撤销。", confirmText: "删除邮箱", destructive: true })) return;
    try { await call("mail.delete", { mailboxId: mailbox.id, confirmed: true }); toast("邮箱已删除"); onNavigate("/mail"); loadMailboxes(); }
    catch (reason) { toast((reason as Error).message, "error"); }
  };
  const setSeen = async (seen: boolean) => {
    if (!message || !mailboxId) return;
    try { await call("mail.seen", { mailboxId, folder: activeFolder, uid: message.uid, seen }); setMessage({ ...message, seen }); setMessages((current) => current ? { ...current, items: current.items.map((entry) => entry.uid === message.uid ? { ...entry, seen } : entry) } : current); loadMailboxes(); loadFolders(); }
    catch (reason) { toast((reason as Error).message, "error"); }
  };
  const trash = async () => {
    if (!message || !mailboxId || !await confirm({ title: "把这封邮件移到废纸篓？", description: `“${message.subject || "（无主题）"}”将移到服务器的废纸篓。`, confirmText: "移到废纸篓", destructive: true })) return;
    try { await call("mail.trash", { mailboxId, folder: activeFolder, uid: message.uid, confirmed: true }); toast("已移到废纸篓"); onNavigate(routeFor(mailboxId, activeFolder)); loadMessages(); loadMailboxes(); loadFolders(); }
    catch (reason) { toast((reason as Error).message, "error"); }
  };

  const byDomain = useMemo(() => {
    const groups = new Map<string, MailboxSummary[]>();
    for (const item of mailboxes ?? []) groups.set(item.domain, [...(groups.get(item.domain) ?? []), item]);
    return [...groups];
  }, [mailboxes]);

  if (mailboxes === null) return <div className="space-y-4"><header><h1 className="text-2xl font-semibold">邮箱</h1><p className="text-sm text-muted-foreground">正在读取邮箱…</p></header><div className="h-[34rem] animate-pulse rounded-lg bg-muted" /></div>;
  if (mailboxes.length === 0) return <div className="space-y-6"><header className="flex items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">邮箱</h1><p className="mt-1 text-sm text-muted-foreground">集中收发所有已接入 Hostinger 账号下的邮件。</p></div><Button variant="outline" onClick={() => void sync()} disabled={syncing}>{syncing ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}同步</Button></header>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<div className="rounded-lg border border-dashed p-10 text-center text-sm"><Mail className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden /><p className="font-medium">还没有邮箱</p><p className="mt-1 text-muted-foreground">先在「账号」接入 Hostinger 账号并同步；账号下的邮箱会自动出现在这里。</p></div></div>;

  const showMailboxPane = !mailboxId;
  const showListPane = Boolean(mailboxId) && uid == null;
  const showReaderPane = Boolean(mailboxId) && uid != null;
  return <div className="space-y-4">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">邮箱</h1><p className="mt-1 text-sm text-muted-foreground">邮件正文只显示纯文本；应用不会访问邮件中的链接、图片或其他远程资源。</p></div><div className="flex gap-2"><Button variant="outline" onClick={() => void sync()} disabled={syncing}>{syncing ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}同步</Button>{activeMailbox?.credentialSaved && <Button onClick={() => setCompose({ mailbox: activeMailbox, mode: "new" })}><PenLine aria-hidden />写邮件</Button>}</div></header>
    {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">{error}</p>}
    <div className="grid min-h-[calc(100dvh-12rem)] overflow-hidden rounded-xl border bg-card xl:grid-cols-[17rem_minmax(18rem,24rem)_minmax(22rem,1fr)]">
      <aside aria-label="邮箱列表" className={cn("border-r", !showMailboxPane && "hidden xl:block")}>
        <div className="border-b px-4 py-3 text-sm font-medium">全部邮箱 <span className="font-normal text-muted-foreground">{mailboxes.length}</span></div>
        <div className="max-h-[calc(100dvh-16rem)] overflow-auto p-2">{byDomain.map(([domain, items]) => <section key={domain} className="mb-4"><h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{domain}</h2>{items.map((item) => <div key={item.id} className={cn("mb-1 rounded-md p-2", item.id === mailboxId ? "bg-accent" : "hover:bg-muted/60")}><button type="button" className="w-full text-left" onClick={() => onNavigate(routeFor(item.id, "INBOX"))}><span className="flex items-center justify-between gap-2 text-sm font-medium"><span className="truncate">{item.address}</span>{item.unreadCount > 0 && <Badge>{item.unreadCount}</Badge>}</span><span className="mt-1 block text-xs text-muted-foreground">{item.credentialSaved ? item.monitoring ? item.monitorMode === "poll" ? "轮询监听" : "实时监听" : "监听已关闭" : "需要密码"}</span></button><div className="mt-2 flex gap-1"><Button size="sm" variant="ghost" onClick={() => item.credentialSaved ? void setMonitoring(item, !item.monitoring) : setCredentialFor(item)}>{item.credentialSaved ? item.monitoring ? "停止监听" : "开始监听" : "输入密码"}</Button><Button size="icon-sm" variant="ghost" aria-label={`删除邮箱 ${item.address}`} onClick={() => void deleteMailbox(item)}><Trash2 aria-hidden /></Button></div></div>)}</section>)}</div>
      </aside>
      <section aria-label="邮件列表" className={cn("min-w-0 border-r", !showListPane && "hidden xl:block")}>
        {activeMailbox ? <><div className="border-b p-3"><Button className="mb-2 xl:hidden" size="sm" variant="ghost" onClick={() => onNavigate("/mail")}><ArrowLeft aria-hidden />邮箱</Button><div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium">{activeMailbox.address}</p><p className="text-xs text-muted-foreground">{activeFolder}</p></div><Button variant="ghost" size="icon-sm" aria-label="邮箱凭据" onClick={() => setCredentialFor(activeMailbox)}><MoreVertical aria-hidden /></Button></div>{activeMailbox.credentialSaved && <><div className="mt-3 flex gap-2 overflow-x-auto">{folders.map((item) => <Button key={item.path} size="sm" variant={item.path === activeFolder ? "secondary" : "ghost"} onClick={() => onNavigate(routeFor(activeMailbox.id, item.path))}>{item.name}{folderUnread(item, activeMailbox) > 0 && <span className="tabular-nums">{folderUnread(item, activeMailbox)}</span>}</Button>)}</div><label className="relative mt-3 block"><Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden /><Input className="pl-8" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索发件人或主题" /></label></>}</div>{!activeMailbox.credentialSaved ? <div className="p-8 text-center text-sm"><KeyRound className="mx-auto mb-2 size-7 text-muted-foreground" aria-hidden /><p className="font-medium">输入邮箱密码后才能读取</p><p className="mt-1 text-muted-foreground">密码会先通过 IMAP 登录验证，再加密保存。</p><Button className="mt-4" size="sm" onClick={() => setCredentialFor(activeMailbox)}>输入密码</Button></div> : <><div className="max-h-[calc(100dvh-22rem)] overflow-auto">{messages === null ? <p className="p-6 text-center text-sm text-muted-foreground">正在读取邮件…</p> : messages.items.length === 0 ? <div className="p-8 text-center text-sm"><Inbox className="mx-auto mb-2 size-7 text-muted-foreground" aria-hidden /><p className="font-medium">{query ? "没有匹配的邮件" : "这个文件夹是空的"}</p></div> : messages.items.map((item) => <MessageRow key={item.uid} item={item} active={item.uid === uid} onOpen={() => onNavigate(routeFor(activeMailbox.id, activeFolder, item.uid))} />)}</div>{messages && messages.total > PAGE_SIZE && <div className="flex items-center justify-between border-t p-2 text-xs text-muted-foreground"><span>第 {messages.page} 页，共 {Math.ceil(messages.total / messages.pageSize)} 页</span><div><Button variant="ghost" size="icon-sm" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft aria-hidden /></Button><Button variant="ghost" size="icon-sm" aria-label="下一页" disabled={page * PAGE_SIZE >= messages.total} onClick={() => setPage((value) => value + 1)}><ChevronRight aria-hidden /></Button></div></div>}</>}</> : <p className="p-8 text-sm text-muted-foreground">请先选择邮箱。</p>}
      </section>
      <article aria-label="邮件正文" className={cn("min-w-0", !showReaderPane && "hidden xl:block")}>
        {message && activeMailbox ? <><header className="border-b p-4"><Button className="mb-3 xl:hidden" size="sm" variant="ghost" onClick={() => onNavigate(routeFor(activeMailbox.id, activeFolder))}><ArrowLeft aria-hidden />邮件列表</Button><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words text-lg font-semibold">{message.subject || "（无主题）"}</h2><p className="mt-2 break-all text-sm">发件人：{message.from}</p><p className="mt-1 break-all text-xs text-muted-foreground">收件人：{message.to.join("、")}{message.cc.length ? ` · 抄送：${message.cc.join("、")}` : ""}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(message.date).toLocaleString("zh-CN")}</p></div><div className="flex flex-wrap gap-1"><Button variant="ghost" size="sm" onClick={() => setCompose({ mailbox: activeMailbox, mode: "reply", original: message })}><Reply aria-hidden />回复</Button><Button variant="ghost" size="sm" onClick={() => setCompose({ mailbox: activeMailbox, mode: "reply-all", original: message })}><ReplyAll aria-hidden />全部回复</Button><Button variant="ghost" size="sm" onClick={() => setCompose({ mailbox: activeMailbox, mode: "forward", original: message })}><Forward aria-hidden />转发</Button><Button variant="ghost" size="icon-sm" aria-label={message.seen ? "标为未读" : "标为已读"} onClick={() => void setSeen(!message.seen)}>{message.seen ? <Mail aria-hidden /> : <MailOpen aria-hidden />}</Button><Button variant="ghost" size="icon-sm" aria-label="移到废纸篓" onClick={() => void trash()}><Trash2 aria-hidden /></Button></div></div></header><div className="p-5"><MailBody text={message.text} />{message.attachments.length > 0 && <Attachments mailboxId={activeMailbox.id} folder={activeFolder} uid={message.uid} items={message.attachments} />}</div></> : <div className="grid h-full min-h-80 place-content-center p-8 text-center text-sm text-muted-foreground">{activeMailbox && <Button className="mb-6 xl:hidden" size="sm" variant="ghost" onClick={() => onNavigate(routeFor(activeMailbox.id, activeFolder))}><ArrowLeft aria-hidden />邮件列表</Button>}<MailOpen className="mx-auto mb-2 size-8" aria-hidden /><p>选择一封邮件阅读。</p><p className="mt-1 max-w-sm">正文始终按纯文本显示，URL 不可点击，也不会加载远程图片或跟踪像素。</p></div>}
      </article>
    </div>
    <CredentialDialog mailbox={credentialFor} onClose={() => setCredentialFor(null)} onSaved={() => { setCredentialFor(null); loadMailboxes(); loadFolders(); loadMessages(); }} />
    <ComposeDialog state={compose} onClose={() => setCompose(null)} onSent={() => { setCompose(null); loadFolders(); loadMessages(); }} />
  </div>;
}

function MessageRow({ item, active, onOpen }: { item: MailMessageSummary; active: boolean; onOpen: () => void }) {
  return <button type="button" className={cn("block w-full border-b p-3 text-left hover:bg-muted/60", active && "bg-accent", !item.seen && "border-l-2 border-l-primary bg-primary/5")} onClick={onOpen}><span className="flex items-center justify-between gap-2"><span className={cn("truncate text-sm", !item.seen && "font-semibold")}>{item.from || "未知发件人"}</span><span className="shrink-0 text-xs text-muted-foreground">{date(item.date)}</span></span><span className={cn("mt-1 block truncate text-sm", !item.seen && "font-medium")}>{item.subject || "（无主题）"}</span><span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">{item.hasAttachments && <Paperclip className="size-3" aria-label="有附件" />}<span className="truncate">{item.snippet}</span></span></button>;
}

function Attachments({ mailboxId, folder, uid, items }: { mailboxId: number; folder: string; uid: number; items: MailAttachment[] }) {
  return <section className="mt-8 border-t pt-4"><h3 className="text-sm font-medium">附件</h3><ul className="mt-2 space-y-2">{items.map((item) => <li key={item.partId} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"><span className="min-w-0 truncate">{item.name} <span className="text-xs text-muted-foreground">{Math.ceil(item.size / 1024)} KB · {item.type}</span></span><Button variant="outline" size="sm" asChild><a download={item.name} href={`/api/mail/attachments?mailboxId=${mailboxId}&folder=${encodeURIComponent(folder)}&uid=${uid}&partId=${encodeURIComponent(item.partId)}`}><Download aria-hidden />下载</a></Button></li>)}</ul><p className="mt-2 text-xs text-muted-foreground">仅在你点击“下载”后请求附件；附件强制下载，不在页面内预览。</p></section>;
}

function MailboxPasswordReveal({ mailbox }: { mailbox: MailboxSummary | null }) {
  const confirm = useConfirm();
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSecret(null); }, [mailbox?.id]);
  if (!mailbox?.credentialSaved) return null;
  const reveal = async () => {
    if (secret) { setSecret(null); return; }
    if (!await confirm({ title: "显示已保存的邮箱密码？", description: "密码会显示在屏幕上。请避开共享屏幕，复制后及时隐藏；其他客户端可使用这个密码。", confirmText: "显示密码" })) return;
    setBusy(true);
    try {
      const result = await call<{ address: string; password: string } | null>("mail.password", { mailboxId: mailbox.id });
      setSecret(result?.password ?? null);
      if (!result) toast("没有可显示的已保存密码", "error");
    } catch (reason) { toast((reason as Error).message, "error"); }
    finally { setBusy(false); }
  };
  return <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm"><p>密码：{secret ? <code className="select-all break-all rounded bg-muted px-1.5 py-0.5">{secret}</code> : "已加密保存"}</p><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void reveal()}>{secret ? "隐藏密码" : "显示已保存密码"}</Button></div>;
}

function CredentialDialog({ mailbox, onClose, onSaved }: { mailbox: MailboxSummary | null; onClose: () => void; onSaved: () => void }) {
  const confirm = useConfirm();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => { event.preventDefault(); if (!mailbox) return; setBusy(true); setError(null); try { await call("mail.credential.save", { mailboxId: mailbox.id, password }); toast("密码已通过 IMAP 验证并加密保存"); setPassword(""); onSaved(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } };
  const reset = async () => { if (!mailbox || !await confirm({ title: `重置 ${mailbox.address} 的密码？`, description: "旧密码会立即失效。其他邮件客户端、手机和网页邮箱都必须改用新密码，否则会停止收发邮件。", confirmText: "确认重置密码", destructive: true })) return; setBusy(true); setError(null); try { await call("mail.credential.reset", { mailboxId: mailbox.id, confirmed: true }); toast("新密码已加密保存"); onSaved(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } };
  return <Dialog open={mailbox !== null} onOpenChange={(open) => { if (!open) { setPassword(""); setError(null); onClose(); } }}><DialogContent><DialogHeader><DialogTitle>邮箱凭据</DialogTitle><DialogDescription>{mailbox?.address} 只有在密码验证成功后才能读取或发信。密码默认隐藏；只有明确点击“显示已保存密码”并确认后才会显示。</DialogDescription></DialogHeader><MailboxPasswordReveal key={mailbox?.id} mailbox={mailbox} /><form onSubmit={save} className="space-y-3"><div className="space-y-2"><Label htmlFor="mailbox-password">邮箱密码</Label><Input id="mailbox-password" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => void reset()}>不知道密码？重置</Button><Button type="submit" disabled={busy || !password}>{busy && <LoaderCircle className="animate-spin" aria-hidden />}验证并保存</Button></DialogFooter></form></DialogContent></Dialog>;
}

function ComposeDialog({ state, onClose, onSent }: { state: { mailbox: MailboxSummary; mode: ComposeMode; original?: MailMessageDetail } | null; onClose: () => void; onSent: () => void }) {
  const [to, setTo] = useState(""); const [cc, setCc] = useState(""); const [bcc, setBcc] = useState(""); const [subject, setSubject] = useState(""); const [text, setText] = useState(""); const [files, setFiles] = useState<Upload[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!state) return; const original = state.original; setFiles([]); setError(null); setText(""); if (!original || state.mode === "new") { setTo(""); setCc(""); setSubject(""); } else if (state.mode === "forward") { setTo(""); setCc(""); setSubject(/^Fwd:/i.test(original.subject) ? original.subject : `Fwd: ${original.subject}`); } else { setTo(emailOnly(original.from)); setCc(state.mode === "reply-all" ? [...original.to, ...original.cc].map(emailOnly).filter((address) => address.toLowerCase() !== state.mailbox.address.toLowerCase()).join(", ") : ""); setSubject(/^Re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`); } setBcc(""); }, [state]);
  const choose = async (event: ChangeEvent<HTMLInputElement>) => { const selected = [...(event.target.files ?? [])]; const total = selected.reduce((sum, file) => sum + file.size, files.reduce((sum, file) => sum + file.size, 0)); if (total > MAX_ATTACHMENTS) { setError("附件总大小不能超过 20 MB。"); event.target.value = ""; return; } const loaded = await Promise.all(selected.map((file) => new Promise<Upload>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolve({ name: file.name, type: file.type || "application/octet-stream", size: file.size, dataBase64: String(reader.result).split(",")[1] ?? "" }); reader.readAsDataURL(file); }))); setFiles((current) => [...current, ...loaded]); event.target.value = ""; };
  const send = async (event: FormEvent) => { event.preventDefault(); if (!state) return; setBusy(true); setError(null); try { await call("mail.send", { mailboxId: state.mailbox.id, to: splitAddresses(to), cc: splitAddresses(cc), bcc: splitAddresses(bcc), subject, text, mode: state.mode === "reply-all" ? "replyAll" : state.mode, replyTo: state.original ? { folder: state.original.folder, uid: state.original.uid } : undefined, attachments: files }); toast("邮件已发送，并已核对已发送文件夹"); onSent(); } catch (reason) { const message = (reason as Error).message; if (/^邮件已发送（.+），但无法确认 Sent 副本/.test(message)) { toast(message, "error"); onSent(); } else setError(message); } finally { setBusy(false); } };
  return <Dialog open={state !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{state?.mode === "reply" ? "回复" : state?.mode === "reply-all" ? "全部回复" : state?.mode === "forward" ? "转发" : "写邮件"}</DialogTitle><DialogDescription>从 {state?.mailbox.address} 发送纯文本邮件。附件总大小上限 20 MB。</DialogDescription></DialogHeader><form onSubmit={send} className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm"><span>收件人</span><Input type="text" value={to} onChange={(event) => setTo(event.target.value)} placeholder="多个地址用逗号分隔" /></label><label className="space-y-1 text-sm"><span>抄送</span><Input type="text" value={cc} onChange={(event) => setCc(event.target.value)} /></label></div><label className="space-y-1 text-sm"><span>密送</span><Input type="text" value={bcc} onChange={(event) => setBcc(event.target.value)} /></label><label className="space-y-1 text-sm"><span>主题</span><Input value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label className="space-y-1 text-sm"><span>正文（纯文本）</span><textarea rows={12} value={text} onChange={(event) => setText(event.target.value)} className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>{state?.original && <details className="rounded-md border bg-muted/30 p-3 text-sm"><summary className="cursor-pointer text-muted-foreground">查看将由服务端安全引用的原邮件</summary><div className="mt-3 max-h-40 overflow-auto"><MailBody text={quote(state.original)} /></div></details>}<input ref={input} className="sr-only" type="file" multiple onChange={(event) => void choose(event)} /><div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}><Paperclip aria-hidden />添加附件</Button>{files.map((file, index) => <button type="button" key={`${file.name}-${index}`} className="rounded bg-muted px-2 py-1 text-xs" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>{file.name} ×</button>)}</div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || splitAddresses(to).length === 0 || !text.trim()}>{busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Send aria-hidden />}发送</Button></DialogFooter></form></DialogContent></Dialog>;
}
