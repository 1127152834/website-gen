export type MailCredentialSource = "pipeline" | "user" | "reset" | "default" | null;
export type MailMonitorMode = "idle" | "poll" | "off";
export type MailDefaultPasswordStatus = "unconfigured" | "pending" | "trying" | "rejected" | "unavailable";

export interface MailDefaultPasswordResult {
  succeeded: number;
  failed: number;
  /** 网络故障或工作区状态变化时暂缓；不等于密码错误。 */
  deferred: number;
}

export interface MailboxSummary {
  id: number;
  accountId: number;
  accountLabel: string;
  orderId: string;
  domain: string;
  address: string;
  credentialSaved: boolean;
  credentialSource?: MailCredentialSource;
  defaultPasswordStatus: MailDefaultPasswordStatus;
  monitoring: boolean;
  monitorMode?: MailMonitorMode;
  unreadCount: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface MailFolder {
  name: string;
  path: string;
  total: number;
  unread: number;
  specialUse?: string | null;
}

export interface MailMessageSummary {
  uid: number;
  folder: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: number;
  snippet: string;
  seen: boolean;
  hasAttachments: boolean;
  size: number;
  /** Server-produced opaque identity for binding additive annotations to this exact cached generation. */
  readIdentity?: string;
}

export interface MailAttachment {
  partId: string;
  name: string;
  type: string;
  size: number;
}

export interface MailMessageDetail extends MailMessageSummary {
  text: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  attachments: MailAttachment[];
}

export interface MailListResult {
  items: MailMessageSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MailEvent {
  type: "new" | "changed";
  mailboxId: number;
  folder?: string;
  uid?: number;
  unreadCount?: number;
}

export interface MailSendAttachment {
  name: string;
  type: string;
  size: number;
  dataBase64: string;
}

export interface MailSendInput {
  mailboxId: number;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  mode?: "new" | "reply" | "replyAll" | "forward";
  replyTo?: { folder: string; uid: number; readerRef?: CaseSourceReaderRef };
  attachments?: MailSendAttachment[];
  /** 显式发送幂等键；同键不同最终内容拒绝，同键 prepared/unknown 不自动重发。 */
  requestId?: string;
  /** 卡片回复时由专用 UI 传入；服务器仍会重新校验 case/task/source/mailbox 关系。 */
  caseId?: string;
  selectedTaskIds?: string[];
}

export interface MailSendResult {
  messageId: string;
  appended: boolean;
  sendReceiptId: string;
  /** SMTP 接受后的本地任务投影/已发送副本核对状态；不表示收件方送达。 */
  reviewState: "none" | "pending" | "cleared";
  reviewCode: "task_outcome_pending" | "sent_append_unconfirmed" | "task_binding_conflict" | "task_projection_failed" | null;
}

export interface MailTranslateInput { mailboxId: number; folder: string; uid: number }
export interface MailTranslation { subject: string; text: string }
import type { CaseSourceReaderRef } from "./mail-triage-types.ts";
