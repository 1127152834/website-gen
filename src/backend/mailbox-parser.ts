import { simpleParser, type AddressObject, type EmailAddress } from "mailparser";
import type { MailAttachment } from "../shared/mail-types.ts";

export interface ParsedSafeMessage {
  messageId: string | null;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: number;
  text: string;
  snippet: string;
  inReplyTo: string | null;
  references: string[];
  attachments: MailAttachment[];
}

const addressValues = (values: EmailAddress[]): string[] => values.flatMap((item) => [
  ...(item.address ? [item.address] : []),
  ...(item.group ? addressValues(item.group) : []),
]);

/** 永远使用 mailparser 的结构化地址，不按逗号拆显示名。 */
const addresses = (value: AddressObject | AddressObject[] | undefined): string[] =>
  value ? (Array.isArray(value) ? value : [value]).flatMap((item) => addressValues(item.value)) : [];

const plainSnippet = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 240);

/**
 * MIME 只在本机解析。mailparser 不请求外部资源；同时关闭 CID 展开、HTML/文本链接化。
 * 返回值里完全没有 HTML，调用方只能把 text 当普通文本显示。
 */
export async function parseMailText(source: Buffer): Promise<ParsedSafeMessage> {
  const mail = await simpleParser(source, {
    skipImageLinks: true,
    keepCidLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    maxHtmlLengthToParse: 2 * 1024 * 1024,
  });
  const text = (mail.text ?? "").replace(/\r\n/g, "\n").trim();
  return {
    messageId: mail.messageId ?? null,
    from: mail.from?.text ?? "",
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    subject: mail.subject ?? "",
    date: mail.date?.getTime() ?? 0,
    text,
    snippet: plainSnippet(text),
    inReplyTo: mail.inReplyTo ?? null,
    references: mail.references == null ? [] : Array.isArray(mail.references) ? mail.references : [mail.references],
    attachments: mail.attachments.map((attachment, index) => ({
      partId: attachment.partId ?? String(index + 1),
      name: attachment.filename ?? `attachment-${index + 1}`,
      type: attachment.contentType || "application/octet-stream",
      size: attachment.size,
    })),
  };
}
