// Hostinger 邮件生产适配器。服务器地址是常量；任何邮件正文、头部或附件内容都不会成为网络目标。
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type ListResponse, type MailboxObject } from "imapflow";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { MailAttachment } from "../shared/mail-types.ts";
import type { MailCredentials, MailTransport, OutgoingMessage, RemoteFolder, RemoteFolderEvent, RemoteMessage, SendResult } from "./mailbox-transport.ts";

const IMAP_HOST = "imap.hostinger.com";
const SMTP_HOST = "smtp.hostinger.com";
const MIME_SOURCE_LIMIT = 25 * 1024 * 1024;
const ATTACHMENT_LIMIT = 20 * 1024 * 1024;
const OUTGOING_ATTACHMENT_LIMIT = 20 * 1024 * 1024;

type ExistsListener = (event: unknown) => void;
type ErrorListener = (error: Error) => void;
export interface ImapClient {
  mailbox: MailboxObject | false;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(): Promise<ListResponse[]>;
  mailboxOpen(path: string | string[], options?: { readOnly?: boolean }): Promise<MailboxObject>;
  fetch(range: string | number, query: { uid?: boolean; flags?: boolean; size?: boolean; source?: boolean | { maxLength?: number } }, options?: { uid?: boolean }): AsyncGenerator<FetchMessageObject, false | void, undefined>;
  fetchAll(range: string | number, query: { uid?: boolean; flags?: boolean; size?: boolean; source?: boolean | { maxLength?: number } }, options?: { uid?: boolean }): Promise<FetchMessageObject[]>;
  search(query: { uid?: string | number; header?: Record<string, string | boolean> }, options?: { uid?: boolean }): Promise<number[] | false | undefined | { all?: number[] }>;
  messageFlagsAdd(range: number, flags: string[], options: { uid: boolean }): Promise<boolean>;
  messageFlagsRemove(range: number, flags: string[], options: { uid: boolean }): Promise<boolean>;
  messageMove(range: number, destination: string, options: { uid: boolean }): Promise<unknown>;
  download(range: number, part: string, options: { uid: boolean; maxBytes: number; binary: boolean }): Promise<{ content?: NodeJS.ReadableStream; meta?: { expectedSize?: number } }>;
  append(path: string, content: Buffer, flags?: string[], idate?: Date): Promise<unknown>;
  idle(): Promise<boolean | undefined>;
  on(event: "exists", listener: ExistsListener): this;
  on(event: "error", listener: ErrorListener): this;
  off(event: "exists", listener: ExistsListener): this;
  off(event: "error", listener: ErrorListener): this;
}

export interface MailAdapterDeps {
  createImap(options: ImapFlowOptions): ImapClient;
  buildRaw(message: OutgoingMessage): Promise<{ raw: Buffer; messageId: string }>;
  sendRaw(credentials: MailCredentials, raw: Buffer, recipients: string[]): Promise<{ messageId: string }>;
}

/** SMTP 已经接受邮件，但保存 Sent 副本失败。调用方必须显示“已发送”，不能建议直接重发。 */
export class MailSentAppendError extends Error {
  readonly sent = true;
  readonly messageId: string;
  constructor(messageId: string, cause: unknown) {
    super(`邮件已发送（${messageId}），但无法确认 Sent 副本：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MailSentAppendError";
    this.messageId = messageId;
  }
}

const defaultDeps: MailAdapterDeps = {
  createImap: (options) => new ImapFlow(options),
  buildRaw: (message) => buildRawMessage(message),
  sendRaw: async (credentials, raw, recipients) => {
    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: 465,
      secure: true,
      auth: { user: credentials.address, pass: credentials.password },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      const info: SMTPTransport.SentMessageInfo = await transport.sendMail({
        raw,
        envelope: { from: credentials.address, to: recipients },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return { messageId: info.messageId };
    } finally {
      transport.close();
    }
  },
};

/** 只编译正文原文；Bcc 仅进入 SMTP envelope，绝不写入 MIME 头。 */
export async function buildRawMessage(message: OutgoingMessage): Promise<{ raw: Buffer; messageId: string }> {
    const compiler = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "windows",
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const info = await compiler.sendMail({
      from: message.from,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      text: message.text,
      messageId: message.messageId,
      inReplyTo: message.inReplyTo,
      references: message.references,
      attachments: message.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: attachment.content,
        contentDisposition: "attachment" as const,
      })),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!Buffer.isBuffer(info.message)) throw new Error("生成邮件原文失败");
    return { raw: info.message, messageId: info.messageId };
}

const imapOptions = (credentials: MailCredentials, verifyOnly = false): ImapFlowOptions => ({
  host: IMAP_HOST,
  port: 993,
  secure: true,
  auth: { user: credentials.address, pass: credentials.password },
  logger: false,
  verifyOnly,
  disableAutoIdle: true,
  maxLineLength: 1024 * 1024,
  maxLiteralSize: MIME_SOURCE_LIMIT + 1024 * 1024,
  maxResponseSize: MIME_SOURCE_LIMIT + 2 * 1024 * 1024,
});

async function usingImap<T>(deps: MailAdapterDeps, credentials: MailCredentials, action: (client: ImapClient) => Promise<T>): Promise<T> {
  const client = deps.createImap(imapOptions(credentials));
  let connected = false;
  let emittedError: Error | undefined;
  const onError: ErrorListener = (error) => { emittedError ??= error; };
  client.on("error", onError);
  try {
    await client.connect();
    connected = true;
    const result = await action(client);
    if (emittedError) throw emittedError;
    return result;
  } finally {
    if (connected) await client.logout().catch(() => client.close());
    else client.close();
    // 客户端已不可复用；保留 error 监听直到对象被回收，覆盖 close 后到达的迟发 socket error。
  }
}

const specialFolder = (folders: ListResponse[], use: "\\Trash" | "\\Sent"): ListResponse => {
  const folder = folders.find((item) => item.specialUse === use);
  if (!folder) throw new Error(`邮件服务器没有报告 ${use} 特殊文件夹，未猜测普通文件夹名称`);
  return folder;
};

const sourceMessage = (message: FetchMessageObject, folder: string, uidValidity: string): RemoteMessage => {
  const size = message.size ?? message.source?.length ?? 0;
  if (size > MIME_SOURCE_LIMIT || (message.source?.length ?? 0) > MIME_SOURCE_LIMIT) return {
    uid: message.uid,
    folder,
    uidValidity,
    flags: [...(message.flags ?? [])],
    size,
    // 上层 safeParse 会把空原文转成可见占位记录；绝不因一封超大邮件卡死整个文件夹监听。
    source: Buffer.alloc(0),
  };
  if (!message.source) throw new Error(`邮件 ${folder}/${message.uid} 没有返回 MIME 原文`);
  return {
    uid: message.uid,
    folder,
    uidValidity,
    flags: [...(message.flags ?? [])],
    size,
    source: message.source,
  };
};

async function fetchOne(client: ImapClient, folder: string, uid: number, uidValidity: string): Promise<RemoteMessage | null> {
  const rows = await client.fetchAll(uid, { uid: true, flags: true, size: true, source: { maxLength: MIME_SOURCE_LIMIT + 1 } }, { uid: true });
  return rows[0] ? sourceMessage(rows[0], folder, uidValidity) : null;
}

const searchUids = (result: Awaited<ReturnType<ImapClient["search"]>>): number[] => {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  return result.all ?? [];
};

async function collectBounded(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > limit) throw new Error("附件超过 20 MB 下载上限");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export function createMailTransport(overrides: Partial<MailAdapterDeps> = {}): MailTransport {
  const deps = { ...defaultDeps, ...overrides };
  const streamMessages: MailTransport["streamMessages"] = (credentials, folder, known) => (async function* (): AsyncGenerator<RemoteFolderEvent> {
    const client = deps.createImap(imapOptions(credentials));
    let connected = false;
    let emittedError: Error | undefined;
    const onError: ErrorListener = (error) => { emittedError ??= error; client.close(); };
    client.on("error", onError);
    try {
      await client.connect();
      connected = true;
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      const uidValidity = mailbox.uidValidity.toString();
      yield { kind: "mailbox", uidValidity };
      if (emittedError) throw emittedError;

      // 全量只拉 UID/flags/size，用于 flags 与 EXPUNGE 对账；绝不在这一阶段拉 MIME literal。
      const metadataRows: FetchMessageObject[] = [];
      for await (const metadata of client.fetch("1:*", { uid: true, flags: true, size: true }, { uid: true })) metadataRows.push(metadata);
      const canReuse = known?.uidValidity === uidValidity;
      for (const metadata of metadataRows.sort((a, b) => b.uid - a.uid)) {
        if (emittedError) throw emittedError;
        if (canReuse && known.uids.has(metadata.uid)) {
          yield {
            kind: "message",
            message: {
              uid: metadata.uid,
              folder,
              uidValidity,
              flags: [...(metadata.flags ?? [])],
              size: metadata.size ?? 0,
            },
          };
          continue;
        }
        // 只在消费者索取下一项时读取这一封；上层处理完成前不会预取下一封 MIME。
        const message = (metadata.size ?? 0) > MIME_SOURCE_LIMIT
          ? sourceMessage(metadata, folder, uidValidity)
          : await fetchOne(client, folder, metadata.uid, uidValidity);
        if (message) yield { kind: "message", message };
      }
      if (emittedError) throw emittedError;
    } finally {
      if (connected) await client.logout().catch(() => client.close());
      else client.close();
      // 保留 error listener，覆盖 close/logout 之后到达的迟发 socket error。
    }
  })();
  return {
    async verify(credentials) {
      const client = deps.createImap(imapOptions(credentials, true));
      let emittedError: Error | undefined;
      const onError: ErrorListener = (error) => { emittedError ??= error; };
      client.on("error", onError);
      try {
        await client.connect();
        if (emittedError) throw emittedError;
      } finally {
        client.close();
      }
    },

    listFolders: (credentials) => usingImap(deps, credentials, async (client) => (await client.list()).map((folder): RemoteFolder => ({
      path: folder.path,
      name: folder.name,
      specialUse: folder.specialUse ?? null,
    }))),

    fetchMessages: async (credentials, folder, _afterUid) => {
      const messages: RemoteMessage[] = [];
      for await (const event of streamMessages(credentials, folder)) if (event.kind === "message") messages.push(event.message);
      return messages;
    },

    streamMessages,

    fetchMessage: (credentials, folder, uid) => usingImap(deps, credentials, async (client) => {
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      return fetchOne(client, folder, uid, mailbox.uidValidity.toString());
    }),

    setSeen: (credentials, folder, uid, seen) => usingImap(deps, credentials, async (client) => {
      await client.mailboxOpen(folder);
      const changed = seen
        ? await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true })
        : await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
      if (!changed) throw new Error("邮件已读状态写入失败");
      const row = (await client.fetchAll(uid, { uid: true, flags: true }, { uid: true }))[0];
      if (!row || row.flags?.has("\\Seen") !== seen) throw new Error("邮件已读状态写入后未得到确认");
    }),

    moveToTrash: (credentials, folder, uid) => usingImap(deps, credentials, async (client) => {
      const trash = specialFolder(await client.list(), "\\Trash");
      if (trash.path === folder) throw new Error("邮件已经在废纸篓中");
      await client.mailboxOpen(folder);
      await client.messageMove(uid, trash.path, { uid: true });
      const remains = searchUids(await client.search({ uid }, { uid: true }));
      if (remains.includes(uid)) throw new Error("邮件移动到废纸篓后仍在原文件夹中");
    }),

    downloadAttachment: (credentials, folder, uid, attachment: MailAttachment) => usingImap(deps, credentials, async (client) => {
      if (!/^\d+(?:\.\d+)*$/.test(attachment.partId)) throw new Error("附件 partId 无效");
      if (attachment.size > ATTACHMENT_LIMIT) throw new Error("附件超过 20 MB 下载上限");
      await client.mailboxOpen(folder, { readOnly: true });
      const download = await client.download(uid, attachment.partId, { uid: true, maxBytes: ATTACHMENT_LIMIT + 1, binary: true });
      if (!download.content) throw new Error("附件不存在");
      if ((download.meta?.expectedSize ?? 0) > ATTACHMENT_LIMIT) throw new Error("附件超过 20 MB 下载上限");
      return collectBounded(download.content, ATTACHMENT_LIMIT);
    }),

    async send(credentials, message): Promise<SendResult> {
      if (message.from.trim().toLowerCase() !== credentials.address.trim().toLowerCase()) throw new Error("发件地址必须是当前邮箱");
      const attachmentBytes = message.attachments.reduce((sum, attachment) => sum + attachment.content.length, 0);
      if (attachmentBytes > OUTGOING_ATTACHMENT_LIMIT) throw new Error("附件总大小不能超过 20 MB");
      const built = await deps.buildRaw(message);
      const recipients = [...message.to, ...message.cc, ...message.bcc];
      if (recipients.length === 0) throw new Error("至少填写一个收件人");
      await deps.sendRaw(credentials, built.raw, recipients);
      // 搜索和追加必须使用实际原文中的 Message-ID，不能使用 SMTP 响应派生的新值。
      const messageId = built.messageId;
      try {
        const appended = await usingImap(deps, credentials, async (client) => {
          const sentFolder = specialFolder(await client.list(), "\\Sent");
          await client.mailboxOpen(sentFolder.path);
          const existing = searchUids(await client.search({ header: { "Message-ID": messageId } }, { uid: true }));
          if (existing.length > 0) return false;
          await client.append(sentFolder.path, built.raw, ["\\Seen"], new Date());
          const verified = searchUids(await client.search({ header: { "Message-ID": messageId } }, { uid: true }));
          if (verified.length === 0) throw new Error("追加后未搜索到相同 Message-ID");
          return true;
        });
        return { messageId, appended };
      } catch (error) {
        throw new MailSentAppendError(messageId, error);
      }
    },

    async idle(credentials, onExists, signal) {
      if (signal.aborted) return;
      const client = deps.createImap(imapOptions(credentials));
      let callbackTask = Promise.resolve();
      let callbackError: unknown;
      let connectionError: Error | undefined;
      const exists: ExistsListener = () => {
        if (signal.aborted) return;
        callbackTask = callbackTask.then(() => onExists()).catch((error) => {
          callbackError = error;
          client.close();
        });
      };
      const onError: ErrorListener = (error) => {
        connectionError ??= error;
        client.close();
      };
      const abort = () => client.close();
      signal.addEventListener("abort", abort, { once: true });
      client.on("exists", exists);
      client.on("error", onError);
      let idleError: unknown;
      try {
        await client.connect();
        if (signal.aborted) return;
        await client.mailboxOpen("INBOX");
        const idled = await client.idle();
        if (idled === false) throw new Error("IMAP IDLE 启动失败，将按退避策略重连");
      } catch (error) {
        if (!signal.aborted) idleError = error;
      } finally {
        signal.removeEventListener("abort", abort);
        client.off("exists", exists);
        // 先阻止新回调并关闭连接，再等待已开始的索引回调；stopDomain/close 返回时不留后台写入。
        client.close();
        await callbackTask;
      }
      if (callbackError) throw callbackError;
      if (!signal.aborted && connectionError) throw connectionError;
      if (!signal.aborted && idleError) throw idleError;
    },
  };
}

