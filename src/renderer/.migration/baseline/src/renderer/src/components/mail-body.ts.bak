import { createElement } from "react";

/**
 * 邮件正文只有服务端生成的纯文本。这里故意不解析 URL、不创建链接，也不接受 HTML。
 * 保持为独立的 createElement 组件，node:test 可以在不转换 TSX 的情况下验证安全边界。
 */
export function MailBody({ text }: { text: string }) {
  return createElement("pre", {
    className: "min-h-40 whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground",
    "data-mail-body": "plain-text",
  }, text);
}
