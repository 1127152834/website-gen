import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, LoaderCircle, Mail, PenLine, RefreshCw } from "lucide-react";
import type { MailAttachment, MailFolder, MailListResult, MailMessageDetail, MailMessageSummary, MailboxSummary, MailTranslation } from "../../../../shared/mail-types.ts";
import type { CaseSourceReaderRef, MailMessageAnnotation, MailMessageAnnotationsResult, ReviewSourcePreview } from "../../../../shared/mail-triage-types.ts";
import { toast, useConfirm } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { call, invalidateRpcData, useRpcData } from "@/lib/backend.ts";
import { cn } from "@/lib/utils";
import { MailOpenState, mailSelectionRedirect } from "./mail-open-state.ts";
import { ComposeDialog, type ComposeHandoff, type ComposeMode, type ComposeState } from "./compose-dialog.tsx";
import { MailboxPane } from "./mailbox-pane.tsx";
import { MessageListPane } from "./message-list-pane.tsx";
import { MessageReaderPane } from "./message-reader-pane.tsx";

const PAGE_SIZE = 30;
type SeenQueue = { confirmed: boolean; pending: { id: number; seen: boolean }[]; chain: Promise<void> };
type TranslationSource = { key: string; subject: string; text: string };
type TranslationState = { source: TranslationSource; busy: boolean; showOriginal: boolean; value?: MailTranslation; error?: string };

const routeFor = (mailboxId: number, folder: string, uid?: number) => `/mail/${mailboxId}/${encodeURIComponent(folder)}${uid == null ? "" : `/${uid}`}`;
const canEnterPassword = (mailbox: MailboxSummary) => !mailbox.credentialSaved && (mailbox.defaultPasswordStatus === "unconfigured" || mailbox.defaultPasswordStatus === "rejected");
const isTryingDefaultPassword = (mailbox: MailboxSummary) => !mailbox.credentialSaved && (mailbox.defaultPasswordStatus === "pending" || mailbox.defaultPasswordStatus === "trying");

function mailboxStatusText(mailbox: MailboxSummary): string {
  if (mailbox.credentialSaved) return mailbox.monitoring ? mailbox.monitorMode === "poll" ? "轮询监听" : "实时监听" : "监听已关闭";
  if (isTryingDefaultPassword(mailbox)) return "正在用默认密码登录…";
  if (mailbox.defaultPasswordStatus === "unavailable") return "验证未完成，下次同步时重试";
  return "需要密码";
}

export function MailPage({ mailboxId, folder, uid, sourceRef, composeHandoff, onNavigate }: { mailboxId?: number; folder?: string; uid?: number; sourceRef?: CaseSourceReaderRef; composeHandoff?: ComposeHandoff; onNavigate: (path: string) => void }) {
  const confirm = useConfirm();
  const activeFolder = folder ?? "INBOX";
  const listScope = `${mailboxId ?? ""}\u0000${activeFolder}`;
  const mailboxesState = useRpcData<MailboxSummary[]>("mail.list", undefined, { topics: ["mail"] });
  const mailboxes = mailboxesState.data ?? null;
  const activeMailbox = mailboxes?.find((item) => item.id === mailboxId) ?? null;
  const credentialSaved = activeMailbox?.credentialSaved ?? false;
  const foldersState = useRpcData<MailFolder[]>("mail.folders", mailboxId && credentialSaved && !sourceRef ? { mailboxId } : null, { topics: ["mail"] });
  const folders = foldersState.data ?? [];
  const [messages, setMessages] = useState<MailListResult | null>(null);
  const [message, setMessage] = useState<MailMessageDetail | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [listIdentity, setListIdentity] = useState(listScope);
  const [listBusy, setListBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [retryingDefaultFor, setRetryingDefaultFor] = useState<number | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [correctionReason,setCorrectionReason]=useState(""),[correctionTag,setCorrectionTag]=useState(""),[correctionBusy,setCorrectionBusy]=useState(false),[correctionError,setCorrectionError]=useState<string|null>(null);
  const openedHandoff = useRef("");
  const [translationState, setTranslationState] = useState<TranslationState | null>(null);
  const translationSource = useRef<TranslationSource | null>(null);
  const translationPending = useRef<TranslationSource | null>(null);
  useEffect(() => () => { translationSource.current = null; translationPending.current = null; }, []);
  const seenQueues = useRef(new Map<string, SeenQueue>());
  const seenSequence = useRef(0);
  const messagesScope = useRef(listScope);
  const messageIdentity = useRef<string | null>(null);
  const sourceIdentity=sourceRef?`${sourceRef.caseId}\u0000${sourceRef.sourceId}\u0000${sourceRef.sourceVersion}\u0000${sourceRef.uidValidity}`:"";
  const routeRef = useRef({ mailboxId, folder: activeFolder, uid, sourceIdentity });
  routeRef.current = { mailboxId, folder: activeFolder, uid, sourceIdentity };
  const openState = useRef(new MailOpenState());
  const messagesParams = mailboxId && credentialSaved && !sourceRef ? { mailboxId, folder: activeFolder, query: debouncedQuery.trim() || undefined, page, pageSize: PAGE_SIZE } : null;
  const messagesState = useRpcData<MailListResult>("mail.messages", messagesParams, { topics: ["mail"] });
  const annotationParams=messagesParams&&messagesState.data?{mailboxId:messagesParams.mailboxId,folder:messagesParams.folder,messages:messagesState.data.items.flatMap(item=>item.readIdentity?[{uid:item.uid,readIdentity:item.readIdentity}]:[])}:null;
  const annotationsState=useRpcData<MailMessageAnnotationsResult>("mail.triage.messageAnnotations",annotationParams,{topics:["mail_triage"]});
  const annotations=useMemo(()=>Object.fromEntries((annotationsState.data?.items??[]).map(item=>[item.uid,item])) as Record<number,MailMessageAnnotation>,[annotationsState.data]);
  const selectedAnnotation=uid==null?null:annotations[uid]??null;
  const annotationPreview=useRpcData<ReviewSourcePreview>("mail.triage.sourcePreview",selectedAnnotation?{sourceId:selectedAnnotation.sourceId,sourceVersion:selectedAnnotation.sourceVersion}:null,{topics:["mail_triage"]});
  const detailParams = mailboxId && uid != null && (credentialSaved||Boolean(sourceRef)) ? sourceRef??{ mailboxId, folder: activeFolder, uid } : null;
  const detailState = useRpcData<MailMessageDetail|{ref:CaseSourceReaderRef;message:MailMessageDetail}>(sourceRef?"mail.cases.sourceMessage":"mail.message", detailParams, { topics: sourceRef?["mail_triage"]:["mail"] });

  const updateSeen = useCallback((targetMailboxId: number, targetFolder: string, targetUid: number, seen: boolean, previousSeen: boolean) => {
    const key = `${targetMailboxId}\u0000${targetFolder}\u0000${targetUid}`;
    const id = ++seenSequence.current;
    const queue = seenQueues.current.get(key) ?? { confirmed: previousSeen, pending: [], chain: Promise.resolve() };
    seenQueues.current.set(key, queue);
    queue.pending.push({ id, seen });
    const apply = (value: boolean) => {
      setMessage((current) => routeRef.current.mailboxId === targetMailboxId && routeRef.current.folder === targetFolder && routeRef.current.uid === targetUid && current?.uid === targetUid && current.folder === targetFolder ? { ...current, seen: value } : current);
      setMessages((current) => messagesScope.current === `${targetMailboxId}\u0000${targetFolder}` && current ? { ...current, items: current.items.map((entry) => entry.uid === targetUid ? { ...entry, seen: value } : entry) } : current);
    };
    apply(seen);
    queue.chain = queue.chain.then(() => call("mail.seen", { mailboxId: targetMailboxId, folder: targetFolder, uid: targetUid, seen })).then(() => {
      queue.confirmed = seen;
    }, (reason: Error) => {
      toast(reason.message, "error");
    }).then(() => {
      queue.pending = queue.pending.filter((entry) => entry.id !== id);
      apply(queue.pending.at(-1)?.seen ?? queue.confirmed);
      if (queue.pending.length === 0) seenQueues.current.delete(key);
    });
  }, []);

  useEffect(() => {
    messagesScope.current = listScope;
    setListIdentity(listScope);
    setPage(1);
    setQuery("");
    setDebouncedQuery("");
    setMessages(null);
    setMessage(null);
    messageIdentity.current = null;
    setListBusy(true);
    setError(null);
  }, [listScope]);
  useEffect(() => {
    if (!mailboxes) return;
    const redirect = mailSelectionRedirect(mailboxId, mailboxes.map((item) => item.id));
    if (redirect) onNavigate(redirect);
  }, [mailboxId, mailboxes, onNavigate]);
  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedQuery(query); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (listIdentity !== listScope) return;
    setListBusy(messagesState.loading || messagesState.refreshing);
    if (!messagesState.data) return;
    const result = messagesState.data;
    setMessages({ ...result, items: result.items.map((entry) => {
      const pending = mailboxId == null ? undefined : seenQueues.current.get(`${mailboxId}\u0000${activeFolder}\u0000${entry.uid}`)?.pending.at(-1);
      return pending ? { ...entry, seen: pending.seen } : entry;
    }) });
  }, [activeFolder, listIdentity, listScope, mailboxId, messagesState.data, messagesState.loading, messagesState.refreshing]);
  useEffect(() => {
    setMessage(null);
    messageIdentity.current = null;
    if (!mailboxId || uid == null || (!credentialSaved&&!sourceRef)) { if (uid == null) openState.current.leaveMessage(); return; }
    const response = detailState.data;
    if (!response) return;
    if(sourceRef&&!("message" in response))return;
    if(sourceRef&&"message" in response){const ref=response.ref;if(ref.caseId!==sourceRef.caseId||ref.sourceId!==sourceRef.sourceId||ref.sourceVersion!==sourceRef.sourceVersion||ref.mailboxId!==sourceRef.mailboxId||ref.folder!==sourceRef.folder||ref.uidValidity!==sourceRef.uidValidity||ref.uid!==sourceRef.uid)return;}
    const item = sourceRef&&"message" in response?response.message:response as MailMessageDetail;
    const route = routeRef.current;
    if (route.mailboxId !== mailboxId || route.folder !== activeFolder || route.uid !== uid || route.sourceIdentity!==sourceIdentity) return;
    messageIdentity.current = `${listScope}\u0000${uid}\u0000${sourceIdentity}`;
    setMessage(item);
    if (!sourceRef&&openState.current.shouldAutoMark(mailboxId, activeFolder, uid, item.seen)) updateSeen(mailboxId, activeFolder, uid, true, item.seen);
  }, [activeFolder, credentialSaved, detailState.data, listScope, mailboxId, sourceIdentity, sourceRef, uid, updateSeen]);
  useEffect(() => {
    const reason = mailboxesState.error ?? foldersState.error ?? messagesState.error ?? detailState.error;
    if (reason) setError(reason.message);
  }, [detailState.error, foldersState.error, mailboxesState.error, messagesState.error]);

  const sync = async () => {
    setSyncing(true); setError(null);
    try { await call("mail.sync"); invalidateRpcData("mail.list"); toast("邮箱清单已同步"); }
    catch (reason) { setError((reason as Error).message); }
    finally { setSyncing(false); }
  };
  const setMonitoring = async (mailbox: MailboxSummary, enabled: boolean) => {
    try { await call("mail.monitor", { mailboxId: mailbox.id, enabled }); invalidateRpcData("mail.list"); toast(enabled ? "已开始监听" : "已停止监听"); }
    catch (reason) { toast((reason as Error).message, "error"); }
  };
  const retryDefaultPassword = async (mailbox: MailboxSummary) => {
    setRetryingDefaultFor(mailbox.id);
    try {
      const result = await call<{ succeeded: number; failed: number; deferred: number }>("mail.credential.retryDefault", { mailboxId: mailbox.id });
      if (result.succeeded) toast("默认密码验证成功，已开始监听");
      else if (result.failed) toast("默认密码仍然不对，请输入这个邮箱的密码", "error");
      else toast("默认密码验证未完成，将在下次同步时重试", "error");
      invalidateRpcData("mail.list");
    } catch (reason) { toast((reason as Error).message, "error"); }
    finally { setRetryingDefaultFor(null); }
  };
  const deleteMailbox = async (mailbox: MailboxSummary) => {
    if (!await confirm({ title: `永久删除 ${mailbox.address}？`, description: "将删除 Hostinger 邮箱，并清除本工作区中的凭据、邮件索引和正文缓存。此操作无法撤销。", confirmText: "删除邮箱", destructive: true })) return;
    try { await call("mail.delete", { mailboxId: mailbox.id, confirmed: true }); invalidateRpcData("mail.list"); invalidateRpcData("mail.folders"); invalidateRpcData("mail.messages"); invalidateRpcData("mail.message"); toast("邮箱已删除"); onNavigate("/mail"); }
    catch (reason) { toast((reason as Error).message, "error"); }
  };
  const setSeen = async (seen: boolean) => {
    if (!message || !mailboxId) return;
    updateSeen(mailboxId, activeFolder, message.uid, seen, message.seen);
  };
  const trash = async () => {
    if (!message || !mailboxId || !await confirm({ title: "把这封邮件移到废纸篓？", description: `“${message.subject || "（无主题）"}”将移到服务器的废纸篓。`, confirmText: "移到废纸篓", destructive: true })) return;
    try { await call("mail.trash", { mailboxId, folder: activeFolder, uid: message.uid, confirmed: true }); invalidateRpcData("mail.list"); invalidateRpcData("mail.folders"); invalidateRpcData("mail.messages"); invalidateRpcData("mail.message"); toast("已移到废纸篓"); onNavigate(routeFor(mailboxId, activeFolder)); }
    catch (reason) { toast((reason as Error).message, "error"); }
  };
  const translateMessage = async () => {
    const source = translationSource.current;
    if (!currentMessage || !mailboxId || !source || translationPending.current === source) return;
    translationPending.current = source;
    setTranslationState({ source, busy: true, showOriginal: false });
    try {
      const value = await call<MailTranslation>("mail.translate", { mailboxId, folder: activeFolder, uid: currentMessage.uid });
      if (translationSource.current !== source) return;
      setTranslationState({ source, value, busy: false, showOriginal: false });
    } catch (reason) {
      if (translationSource.current === source) setTranslationState({ source, busy: false, showOriginal: false, error: (reason as Error).message });
    } finally { if (translationPending.current === source) translationPending.current = null; }
  };

  const byDomain = useMemo(() => {
    const groups = new Map<string, MailboxSummary[]>();
    for (const item of mailboxes ?? []) groups.set(item.domain, [...(groups.get(item.domain) ?? []), item]);
    return [...groups];
  }, [mailboxes]);
  const visibleMessages = listIdentity === listScope && messagesScope.current === listScope ? messages : null;
  const visibleFolders = folders;
  const currentMessage = message && messageIdentity.current === `${listScope}\u0000${uid}\u0000${sourceIdentity}` && message.uid === uid && message.folder === activeFolder ? message : null;
  const currentAnnotation=currentMessage?.readIdentity&&selectedAnnotation?.readIdentity===currentMessage.readIdentity?selectedAnnotation:null;
  const strictAnnotationPreview=currentAnnotation&&annotationPreview.data?.sourceRef.sourceId===currentAnnotation.sourceId&&annotationPreview.data.sourceRef.sourceVersion===currentAnnotation.sourceVersion&&annotationPreview.data.message.readIdentity===currentMessage?.readIdentity?annotationPreview.data:null;
  const selectedSummary = uid == null ? null : visibleMessages?.items.find((item) => item.uid === uid) ?? null;
  const readerHeader = currentMessage ?? selectedSummary;
  const translationKey = `${listScope}\u0000${uid}`;
  // 路由或正文版本改变时立即隔离旧请求，包括 A → B → A 和同 UID 的缓存更新。
  if (!currentMessage) translationSource.current = null;
  else if (translationSource.current?.key !== translationKey || translationSource.current.subject !== currentMessage.subject || translationSource.current.text !== currentMessage.text) {
    translationSource.current = { key: translationKey, subject: currentMessage.subject, text: currentMessage.text };
  }
  const translation = translationState?.source === translationSource.current ? translationState : null;
  const translatedMessage = translation?.value && !translation.showOriginal ? translation.value : null;
  useEffect(()=>{setCorrectionReason("");setCorrectionTag(currentAnnotation?.tag??"");setCorrectionError(null);},[currentAnnotation?.readIdentity,currentAnnotation?.manualVersion,currentAnnotation?.tag]);
  const correctAnnotationTag=async()=>{if(!currentAnnotation||!strictAnnotationPreview||!currentMessage?.readIdentity)return;setCorrectionBusy(true);setCorrectionError(null);try{await call("mail.triage.correct",{requestId:crypto.randomUUID(),reason:correctionReason.trim(),target:{type:"source",id:currentAnnotation.sourceId,sourceVersion:currentAnnotation.sourceVersion},expectedVersion:currentAnnotation.manualVersion,field:"tag",value:correctionTag,sourceRef:strictAnnotationPreview.sourceRef,readIdentity:currentMessage.readIdentity});invalidateRpcData("mail.triage.messageAnnotations");invalidateRpcData("mail.triage.sourcePreview");await annotationsState.refresh();toast("短标签已更正");}catch(reason){setCorrectionError((reason as Error).message);}finally{setCorrectionBusy(false);}};
  useEffect(()=>{if(!composeHandoff||!currentMessage||!activeMailbox)return;const key=`${composeHandoff.caseId}\0${composeHandoff.selectedTaskIds.join("\0")}\0${composeHandoff.readerRef.sourceId}\0${composeHandoff.readerRef.sourceVersion}`;if(openedHandoff.current===key)return;openedHandoff.current=key;setCompose({mailbox:activeMailbox,mode:"reply",original:currentMessage,handoff:composeHandoff});},[activeMailbox,composeHandoff,currentMessage]);

  if (mailboxes === null) return <div className="space-y-4"><header><h1 className="text-2xl font-semibold">邮箱</h1><p className="text-sm text-muted-foreground">{mailboxesState.error ? "暂时无法读取邮箱。" : "正在读取邮箱…"}</p></header>{mailboxesState.error ? <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-5"><p role="alert" className="text-sm text-destructive">{mailboxesState.error.message}</p><Button className="mt-3" variant="outline" onClick={() => void mailboxesState.refresh().catch(() => undefined)}>重新读取</Button></div> : <div className="h-[34rem] animate-pulse rounded-lg bg-muted" />}</div>;
  if (mailboxes.length === 0) return <div className="space-y-6"><header className="flex items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">邮箱</h1><p className="mt-1 text-sm text-muted-foreground">集中收发所有已接入 Hostinger 账号下的邮件。</p></div><Button variant="outline" onClick={() => void sync()} disabled={syncing}>{syncing ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}同步</Button></header>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<div className="rounded-lg border border-dashed p-10 text-center text-sm"><Mail className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden /><p className="font-medium">还没有邮箱</p><p className="mt-1 text-muted-foreground">先在「账号」接入 Hostinger 账号并同步；账号下的邮箱会自动出现在这里。</p></div></div>;

  const showMailboxPane = !mailboxId;
  const showListPane = Boolean(mailboxId) && uid == null;
  const showReaderPane = Boolean(mailboxId) && uid != null;
  const attachmentSlot=currentMessage?.attachments.length?(sourceRef?<p className="mt-8 border-t pt-4 text-sm text-muted-foreground">含 {currentMessage.attachments.length} 个附件。只读来源不会下载或预览附件。</p>:<Attachments mailboxId={activeMailbox?.id??0} folder={activeFolder} uid={currentMessage.uid} items={currentMessage.attachments}/>):null;
  return <div className="space-y-4">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{sourceRef?"来源邮件":"邮箱"}</h1><p className="mt-1 text-sm text-muted-foreground">{sourceRef?(composeHandoff?"这是已选择回复义务绑定的原邮件；发送前服务端会再次核验来源。":"来源绑定的只读纯文本预览；不会标已读、翻译、删除或下载附件。尚未选择回复义务时不能写信。") : "邮件正文只显示纯文本；应用不会访问邮件中的链接、图片或其他远程资源。"}</p></div>{sourceRef?<Button variant="outline" onClick={()=>onNavigate(`/mail/cases/${sourceRef.caseId}`)}><ArrowLeft/>返回申请详情</Button>:<div className="flex gap-2"><Button variant="outline" onClick={()=>void sync()} disabled={syncing}>{syncing?<LoaderCircle className="animate-spin"/>:<RefreshCw/>}同步</Button><Button variant="outline" onClick={()=>onNavigate("/mail/manage")}>邮箱管理</Button>{activeMailbox?.credentialSaved?<Button onClick={()=>setCompose({mailbox:activeMailbox,mode:"new"})}><PenLine/>写邮件</Button>:null}</div>}</header>
    {error?<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>:null}
    <div className={cn("grid min-h-[calc(100dvh-12rem)] overflow-hidden rounded-xl border bg-card",sourceRef?"grid-cols-1":"xl:grid-cols-[17rem_minmax(18rem,24rem)_minmax(22rem,1fr)]")}>
      {!sourceRef?<div className={cn(!showMailboxPane&&"hidden xl:block")}><MailboxPane mailboxes={mailboxes} activeMailboxId={mailboxId} folders={visibleFolders} activeFolder={activeFolder} onSelectMailbox={id=>onNavigate(routeFor(id,"INBOX"))} onSelectFolder={(id,path)=>onNavigate(routeFor(id,path))}/></div>:null}
      {!sourceRef?<div className={cn(!showListPane&&"hidden xl:block")}><MessageListPane mailbox={activeMailbox} folder={activeFolder} query={query} busy={listBusy} messages={visibleMessages} annotations={annotations} selectedUid={uid} pageSize={PAGE_SIZE} onQuery={setQuery} onOpen={selected=>activeMailbox&&onNavigate(routeFor(activeMailbox.id,activeFolder,selected))} onPrevious={()=>setPage(value=>value-1)} onNext={()=>setPage(value=>value+1)}/></div>:null}
      <div className={cn(!sourceRef&&!showReaderPane&&"hidden xl:block")}><MessageReaderPane header={readerHeader??null} message={currentMessage} annotation={currentAnnotation} annotationAssessment={strictAnnotationPreview?.assessment??null} annotationError={currentAnnotation&&!strictAnnotationPreview?(annotationPreview.error?.message??"来源世代已变化，证据与更正已停用；请重新读取邮件。"):correctionError} correctionReason={correctionReason} correctionTag={correctionTag} correctionBusy={correctionBusy} onCorrectionReason={setCorrectionReason} onCorrectionTag={setCorrectionTag} onCorrectTag={currentAnnotation&&strictAnnotationPreview?()=>void correctAnnotationTag():undefined} translated={translatedMessage} translationAvailable={Boolean(translation?.value)} translating={translation?.busy} translationError={translation?.error} sourcePreview={Boolean(sourceRef)} onTranslate={!sourceRef?()=>translation?.value?setTranslationState({...translation,showOriginal:!translation.showOriginal}):void translateMessage():undefined} onCompose={!sourceRef&&activeMailbox&&currentMessage?(mode:ComposeMode)=>setCompose({mailbox:activeMailbox,mode,original:currentMessage}):undefined} onSeen={!sourceRef?(seen:boolean)=>void setSeen(seen):undefined} onTrash={!sourceRef?()=>void trash():undefined} attachmentSlot={attachmentSlot}/></div>
    </div>
    <ComposeDialog state={compose} onClose={()=>setCompose(null)} onSent={()=>setCompose(null)}/>
  </div>;
}

function Attachments({ mailboxId, folder, uid, items }: { mailboxId: number; folder: string; uid: number; items: MailAttachment[] }) {
  return <section className="mt-8 border-t pt-4"><h3 className="text-sm font-medium">附件</h3><ul className="mt-2 space-y-2">{items.map(item=><li key={item.partId} className="flex items-center justify-between gap-3 rounded-lg border p-2 text-sm"><span className="min-w-0 truncate">{item.name} <span className="text-xs text-muted-foreground">{Math.ceil(item.size/1024)} KB · {item.type}</span></span><Button variant="outline" size="sm" asChild><a download={item.name} href={`/api/mail/attachments?mailboxId=${mailboxId}&folder=${encodeURIComponent(folder)}&uid=${uid}&partId=${encodeURIComponent(item.partId)}`}><Download/>下载</a></Button></li>)}</ul><p className="mt-2 text-xs text-muted-foreground">仅在你点击“下载”后请求附件；不会自动解析或预览。</p></section>;
}
