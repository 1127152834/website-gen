import type { MailMessageDetail, MailSendInput, MailSendResult, MailboxSummary } from "../../../../shared/mail-types.ts";
import type { CaseSourceReaderRef } from "../../../../shared/mail-triage-types.ts";
import { splitMailAddresses } from "./mail-form.ts";

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";
export type ComposeHandoff = { caseId: string; selectedTaskIds: readonly string[]; readerRef: CaseSourceReaderRef };
export type ComposeState = { mailbox: MailboxSummary; mode: ComposeMode; original?: MailMessageDetail; handoff?: ComposeHandoff };
export type ComposeValues = { to: string; cc: string; bcc: string; subject: string; text: string };
export type ComposeUpload = { name: string; type: string; size: number; dataBase64: string };
export type ComposeSettlement = { terminal: boolean; close: boolean; message: string | null };

export function createComposeOperation(requestId: string) {
  let locked=false;
  return { requestId,
    tryStart(){if(locked)return false;locked=true;return true;},
    settle(result:MailSendResult):ComposeSettlement { if(result.reviewState==="pending"||!result.appended)return{terminal:true,close:false,message:`SMTP 已接受，但本地核对仍待处理（${result.reviewCode??"sent_append_unconfirmed"}，收据 ${result.sendReceiptId}）。请关闭后从申请详情核对；不要重复发送。`};return{terminal:true,close:true,message:null}; },
    fail(message:string):ComposeSettlement{return{terminal:true,close:false,message:`发送结果未知或需要人工核对：${message}。已锁定本次操作以防重复 SMTP；请关闭后核对收据状态。`};},
  };
}

export const quoteOriginal = (message: MailMessageDetail) => `\n\n--- 原邮件 ---\n发件人：${message.from}\n日期：${new Date(message.date).toLocaleString("zh-CN")}\n主题：${message.subject}\n\n${message.text.split("\n").map(line => `> ${line}`).join("\n")}`;

export function composeSendInput(state: ComposeState, values: ComposeValues, files: ComposeUpload[], requestId: string): MailSendInput {
  return { mailboxId: state.mailbox.id, to: splitMailAddresses(values.to), cc: splitMailAddresses(values.cc), bcc: splitMailAddresses(values.bcc), subject: values.subject, text: values.text, mode: state.mode === "reply-all" ? "replyAll" : state.mode,
    replyTo: state.original ? { folder: state.original.folder, uid: state.original.uid, readerRef: state.handoff?.readerRef } : undefined, attachments: files,
    ...(state.handoff ? { requestId, caseId: state.handoff.caseId, selectedTaskIds: [...state.handoff.selectedTaskIds] } : {}) };
}
