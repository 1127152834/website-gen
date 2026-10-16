import type { MailAttachment } from "../shared/mail-types.ts";

export interface MailCredentials {
  address: string;
  password: string;
}

export interface RemoteFolder {
  path: string;
  name: string;
  specialUse: string | null;
}

export interface RemoteMessage {
  uid: number;
  folder: string;
  /** 字符串化后保存，变化时必须丢弃这个文件夹的旧 UID 索引。 */
  uidValidity?: string;
  flags: string[];
  size: number;
  /** 已缓存且 UIDVALIDITY 未变时不再下载 MIME，只返回 flags/size。 */
  source?: Buffer;
}

export type RemoteFolderEvent =
  | { kind: "mailbox"; uidValidity: string }
  | { kind: "message"; message: RemoteMessage };

export interface OutgoingMessage {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

export interface SendResult {
  messageId: string;
  appended: boolean;
}

/** 所有网络操作都固定连接 Hostinger 邮件服务器；任何参数都不得来自邮件正文里的 URL。 */
export interface MailTransport {
  verify(credentials: MailCredentials): Promise<void>;
  listFolders(credentials: MailCredentials): Promise<RemoteFolder[]>;
  fetchMessages(credentials: MailCredentials, folder: string, afterUid?: number): Promise<RemoteMessage[]>;
  /** 全量扫描轻量元数据；只有未缓存 UID 才携带单封、受限大小的 MIME source。 */
  streamMessages?(
    credentials: MailCredentials,
    folder: string,
    known?: { uidValidity?: string; uids: ReadonlySet<number> },
  ): AsyncIterable<RemoteFolderEvent>;
  fetchMessage(credentials: MailCredentials, folder: string, uid: number): Promise<RemoteMessage | null>;
  setSeen(credentials: MailCredentials, folder: string, uid: number, seen: boolean): Promise<void>;
  moveToTrash(credentials: MailCredentials, folder: string, uid: number): Promise<void>;
  downloadAttachment(credentials: MailCredentials, folder: string, uid: number, attachment: MailAttachment): Promise<Buffer>;
  send(credentials: MailCredentials, message: OutgoingMessage): Promise<SendResult>;
  idle(credentials: MailCredentials, onExists: () => void | Promise<void>, signal: AbortSignal): Promise<void>;
}

export type MailTransportFactory = () => MailTransport;
