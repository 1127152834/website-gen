// 交易邮件发信：让站点（含 WooCommerce）经客服邮箱的 SMTP 发信，伴侣插件负责在站点上接管 wp_mail。
// 发测试邮件后，用 IMAP 登录客服邮箱确认真的收到了（只读：登录、搜索主题、退出）。
// 服务器地址取自 Hostinger 的邮件客户端自动配置（autoconfig.mail.hostinger.com）：SMTP 465/SSL，IMAP 993/SSL，用户名是完整邮箱。
import { randomBytes } from "node:crypto";
import { connect } from "node:tls";
import type { SmtpStatus } from "../shared/protocol.ts";
import { PermanentError } from "./jobs.ts";
import type { StepCtx } from "./pipeline.ts";
import { seal, unseal } from "./secrets.ts";
import { facts } from "./store.ts";
import { listAll } from "./hostinger.ts";
import { mailSetup } from "./mail.ts";

export const HOSTINGER_SMTP = { host: "smtp.hostinger.com", port: 465, secure: "ssl" } as const;
export const HOSTINGER_IMAP = { host: "imap.hostinger.com", port: 993 } as const;

export interface MailboxCreds { address: string; password: string }
/** 查收件箱里有没有主题含某个标记的邮件 */
export type InboxCheck = (creds: MailboxCreds, token: string) => Promise<boolean>;

export const savedMailbox = (ctx: StepCtx): MailboxCreds | null =>
  ctx.site.mailbox_ciphertext ? (JSON.parse(unseal(ctx.d.key, ctx.site.mailbox_ciphertext)) as MailboxCreds) : null;

/** 你在站点页填的已有邮箱密码：先用 IMAP 登录验证，对了才保存（加密）。 */
export async function saveMailboxPassword(ctx: StepCtx, password: string, login: (c: MailboxCreds) => Promise<void> = imapLogin): Promise<void> {
  const creds = { address: facts(ctx).email, password };
  await login(creds).catch((e: Error) => {
    throw new Error(`用这个密码登录 ${creds.address} 失败：${e.message}`);
  });
  ctx.save("mailbox_ciphertext", seal(ctx.d.key, JSON.stringify(creds)));
}

/**
 * 不知道已有邮箱的密码时：由应用生成新密码改掉（其他地方用旧密码的登录会失效）。
 * 先加密保存再提交，Hostinger 返回 500 但实际改成功时也不会丢；之后用 IMAP 登录确认生效。
 */
export async function resetMailboxPassword(ctx: StepCtx, login: (c: MailboxCreds) => Promise<void> = imapLogin, pauseMs = 5000): Promise<void> {
  const { email, order } = await mailSetup(ctx);
  if (!order) throw new Error(`${ctx.domain} 没有 Hostinger 邮箱订单`);
  const box = ((await listAll(ctx.hx, "mail_mailboxes_list", { orderId: order.id, search: email.split("@")[0] })) as { id: string; address: string }[])
    .find((m) => m.address.toLowerCase() === email.toLowerCase());
  if (!box) throw new Error(`${email} 还没有创建`);
  const creds = { address: email, password: `Aa1!${randomBytes(15).toString("base64url")}` };
  ctx.save("mailbox_ciphertext", seal(ctx.d.key, JSON.stringify(creds)));
  await ctx.act("mail_mailboxes_change-mailbox-password", { mailboxId: box.id, password: creds.password });
  for (let i = 0; ; i++) {
    try {
      return await login(creds);
    } catch (e) {
      if (i >= 5) throw new Error(`新密码已提交，但登录验证没通过：${(e as Error).message}（新密码已保存，可稍后在站点页重试启用）`);
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
}

export async function smtpStatus(ctx: StepCtx): Promise<SmtpStatus> {
  const s = (await ctx.wp("GET", "site-agent/v1/smtp")) as { enabled: boolean; host: string | null; username: string | null };
  return { enabled: s.enabled, host: s.host, username: s.username, passwordSaved: Boolean(ctx.site.mailbox_ciphertext) };
}

/**
 * 启用 SMTP 并发一封测试邮件到客服邮箱自己，再用 IMAP 确认收到。发不出去就关掉 SMTP，
 * 退回主机默认发信（总比交易邮件一封都发不出去好）。
 */
export async function enableSmtp(ctx: StepCtx, inbox: InboxCheck): Promise<{ ok: boolean; detail: string }> {
  const creds = savedMailbox(ctx);
  if (!creds) return { ok: false, detail: `没有 ${facts(ctx).email} 的密码（邮箱是之前就有的），到站点页填写后启用` };
  const brand = facts(ctx).brand;
  await ctx.wp("POST", "site-agent/v1/smtp", {
    ...HOSTINGER_SMTP, username: creds.address, password: creds.password, from_email: creds.address, from_name: brand,
  });
  // WooCommerce 邮件里显示的发件人
  await ctx.wp("POST", "wc/v3/settings/email/batch", {
    update: [{ id: "woocommerce_email_from_name", value: brand }, { id: "woocommerce_email_from_address", value: creds.address }],
  });
  const test = await sendTestEmail(ctx, creds.address, inbox);
  if (!test.sent) {
    await ctx.wp("POST", "site-agent/v1/smtp", { enabled: false });
    return { ok: false, detail: `测试邮件发不出去，已退回主机默认发信：${test.detail}` };
  }
  return { ok: true, detail: `交易邮件经 ${HOSTINGER_SMTP.host} 用 ${creds.address} 发出；${test.detail}` };
}

/** 经站点发一封测试邮件；收件人是客服邮箱自己时，再登录收件箱确认送达（最多等 90 秒）。 */
export async function sendTestEmail(
  ctx: StepCtx, to: string, inbox: InboxCheck, wait = { tries: 18, pauseMs: 5000 },
): Promise<{ sent: boolean; delivered: boolean | null; detail: string }> {
  const token = `wg-${randomBytes(4).toString("hex")}`;
  const r = (await ctx.wp("POST", "site-agent/v1/smtp/test", { to, subject: `Test email from ${facts(ctx).brand} (${token})` })) as { ok: boolean; smtp: boolean; error: string | null };
  if (!r.ok) return { sent: false, delivered: null, detail: r.error ?? "wp_mail 返回失败" };
  const creds = savedMailbox(ctx);
  if (!creds || creds.address.toLowerCase() !== to.toLowerCase()) {
    return { sent: true, delivered: null, detail: `测试邮件已发往 ${to}${r.smtp ? "" : "（用的是主机默认发信）"}，请到收件箱查看` };
  }
  for (let i = 0; i < wait.tries; i++) {
    if (await inbox(creds, token).catch(() => false)) return { sent: true, delivered: true, detail: `测试邮件已送达 ${to} 的收件箱` };
    await new Promise((r) => setTimeout(r, wait.pauseMs));
  }
  return { sent: true, delivered: false, detail: `测试邮件已发出，但 ${Math.round((wait.tries * wait.pauseMs) / 1000)} 秒内 ${to} 的收件箱里还没看到（可能延迟或进了垃圾箱）` };
}

// ---- 最小 IMAP 客户端：只做 LOGIN / SELECT / SEARCH / LOGOUT ----

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function imapSession<T>(creds: MailboxCreds, work: (cmd: (line: string) => Promise<string[]>) => Promise<T>): Promise<T> {
  const socket = connect({ host: HOSTINGER_IMAP.host, port: HOSTINGER_IMAP.port, servername: HOSTINGER_IMAP.host });
  socket.setTimeout(20_000, () => socket.destroy(new Error("IMAP 连接超时")));
  let buffer = "";
  let waiting: { tag: string | null; lines: string[]; resolve: (l: string[]) => void; reject: (e: Error) => void } | null = null;
  const fail = (e: Error) => waiting?.reject(e);
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("IMAP 连接被关闭")));
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let i: number;
    while ((i = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (!waiting) continue;
      waiting.lines.push(line);
      // 问候语（tag 为空）以 * OK 结束；命令以带 tag 的状态行结束
      if (waiting.tag === null ? line.startsWith("* ") : line.startsWith(`${waiting.tag} `)) {
        const w = waiting;
        waiting = null;
        const status = w.tag === null ? line.slice(2) : line.slice(w.tag.length + 1);
        if (/^OK\b/i.test(status)) w.resolve(w.lines);
        else w.reject(new PermanentError(status.replace(/^(NO|BAD)\s*/i, "")));
      }
    }
  });
  const expect = (tag: string | null) => new Promise<string[]>((resolve, reject) => (waiting = { tag, lines: [], resolve, reject }));
  let n = 0;
  const cmd = (line: string) => {
    const tag = `a${++n}`;
    const p = expect(tag);
    socket.write(`${tag} ${line}\r\n`);
    return p;
  };
  try {
    await expect(null);
    await cmd(`LOGIN ${quote(creds.address)} ${quote(creds.password)}`);
    return await work(cmd);
  } finally {
    socket.write(`a${++n} LOGOUT\r\n`);
    socket.end();
  }
}

export const imapLogin = (creds: MailboxCreds) => imapSession(creds, async () => {});

export const imapHasSubject: InboxCheck = (creds, token) =>
  imapSession(creds, async (cmd) => {
    await cmd("SELECT INBOX");
    const lines = await cmd(`SEARCH SUBJECT ${quote(token)}`);
    return lines.some((l) => /^\* SEARCH \d/.test(l));
  });
