// 商业邮箱与邮件 DNS：用域名的 Hostinger 邮箱订单建 support@（已有就复用）并加 orders@ 别名；
// 按 Hostinger Email 的标准记录检查 MX、SPF、DKIM、DMARC，只补缺的，不动别人的（POC 在两个域名上核对过这套记录）。
// 公共 DNS 用 DoH 查（本机代理的虚拟 DNS 查不了 TXT/NS）；写入只改 Hostinger 管理的区域，改前记下 Hostinger 自动拍的快照编号。
import { randomBytes } from "node:crypto";
import { listAll } from "./hostinger.ts";
import { PermanentError } from "./jobs.ts";
import type { StepCtx } from "./pipeline.ts";
import type { DatabaseSync } from "node:sqlite";
import { getSecret, seal, setSecret } from "./secrets.ts";
import { facts } from "./store.ts";
import type { MailDnsCheck, MailDnsResult, MailStatus } from "../shared/protocol.ts";

export const HOSTINGER_MAIL = {
  mx: ["5 mx1.hostinger.com.", "10 mx2.hostinger.com."],
  spfInclude: "include:_spf.mail.hostinger.com",
  dkim: ["a", "b", "c"].map((s) => ({ name: `hostingermail-${s}._domainkey`, content: `hostingermail-${s}.dkim.mail.hostinger.com.` })),
  dmarc: "v=DMARC1; p=none",
  /** Hostinger DNS 的名称服务器 */
  nameservers: /\.dns-parking\.com\.?$/i,
};

export interface ZoneGroup {
  name: string;
  type: string;
  ttl?: number;
  records: { content: string; is_disabled?: boolean }[];
}
export interface MailDnsPlan {
  checks: MailDnsCheck[];
  /** 要写入的记录组（按名称 + 类型整组覆盖） */
  updates: ZoneGroup[];
}

/** TXT 内容可能带引号、也可能拆成多段 "a" "b" */
export const txtValue = (s: string) => {
  const parts = s.match(/"((?:[^"\\]|\\.)*)"/g);
  return parts ? parts.map((p) => p.slice(1, -1)).join("") : s.trim();
};
const quoted = (s: string) => `"${s}"`;

/** 对照 Hostinger Email 的标准记录，算出哪些缺、要写什么。不碰指向其他邮件服务的 MX。 */
export function planMailDns(zone: ZoneGroup[]): MailDnsPlan {
  const group = (name: string, type: string) => zone.find((z) => z.name.toLowerCase() === name && z.type === type);
  const active = (g?: ZoneGroup) => (g?.records ?? []).filter((r) => !r.is_disabled).map((r) => r.content);
  const checks: MailDnsCheck[] = [];
  const updates: ZoneGroup[] = [];

  const mx = active(group("@", "MX"));
  if (mx.length === 0) {
    checks.push({ key: "MX", ok: false, detail: "没有 MX 记录，收不到邮件" });
    updates.push({ name: "@", type: "MX", ttl: 14400, records: HOSTINGER_MAIL.mx.map((content) => ({ content })) });
  } else if (mx.every((c) => /\bmx\d\.hostinger\.com\.?$/i.test(c))) {
    checks.push({ key: "MX", ok: true, detail: mx.join("，") });
  } else {
    checks.push({ key: "MX", ok: false, detail: `MX 指向其他邮件服务（${mx.join("，")}），没有改动；要用 Hostinger 邮箱需要在 hPanel 里改` });
  }

  const txt = group("@", "TXT");
  const txtRecords = active(txt);
  const spf = txtRecords.filter((c) => /^v=spf1\b/i.test(txtValue(c)));
  const others = (txt?.records ?? []).filter((r) => !spf.includes(r.content));
  let newSpf: string | null = null;
  if (spf.length === 0) {
    newSpf = `v=spf1 ${HOSTINGER_MAIL.spfInclude} ~all`;
    checks.push({ key: "SPF", ok: false, detail: "没有 SPF 记录" });
  } else {
    const value = txtValue(spf[0]);
    const hasInclude = value.toLowerCase().includes(HOSTINGER_MAIL.spfInclude);
    if (spf.length > 1 || !hasInclude) {
      // 多条 SPF 是错误配置；缺 Hostinger 的 include 就插在 all 前面，保留原来的其他发信来源
      const extra = spf.slice(1).flatMap((c) => txtValue(c).split(/\s+/).slice(1).filter((m) => !/^[~?+-]?all$/i.test(m)));
      const mechanisms = value.split(/\s+/).slice(1);
      const all = mechanisms.find((m) => /^[~?+-]?all$/i.test(m)) ?? "~all";
      const kept = [...new Set([...mechanisms.filter((m) => m !== all), ...extra])];
      if (!hasInclude) kept.push(HOSTINGER_MAIL.spfInclude);
      newSpf = ["v=spf1", ...kept, all].join(" ");
      checks.push({ key: "SPF", ok: false, detail: spf.length > 1 ? `有 ${spf.length} 条 SPF 记录（只能有一条）` : "SPF 没有包含 Hostinger 邮件服务器" });
    } else {
      checks.push({ key: "SPF", ok: true, detail: value });
    }
  }
  if (newSpf) updates.push({ name: "@", type: "TXT", ttl: txt?.ttl ?? 3600, records: [...others.map((r) => ({ content: r.content })), { content: quoted(newSpf) }] });

  const missingDkim = HOSTINGER_MAIL.dkim.filter((k) => !active(group(k.name, "CNAME")).some((c) => c.toLowerCase().replace(/\.?$/, ".") === k.content));
  checks.push({ key: "DKIM", ok: missingDkim.length === 0, detail: missingDkim.length ? `缺少 ${missingDkim.map((k) => k.name).join("、")}` : "3 条 DKIM 记录都在" });
  for (const k of missingDkim) updates.push({ name: k.name, type: "CNAME", ttl: 300, records: [{ content: k.content }] });

  const dmarc = active(group("_dmarc", "TXT")).map(txtValue).find((v) => /^v=DMARC1\b/i.test(v));
  if (dmarc) checks.push({ key: "DMARC", ok: true, detail: dmarc });
  else {
    checks.push({ key: "DMARC", ok: false, detail: "没有 DMARC 记录" });
    updates.push({ name: "_dmarc", type: "TXT", ttl: 3600, records: [{ content: quoted(HOSTINGER_MAIL.dmarc) }] });
  }
  return { checks, updates };
}

/** 公共 DNS 上实际看到的记录（Cloudflare DoH），整理成和 Hostinger 区域一样的结构，好用同一套检查。 */
export async function publicMailZone(domain: string, fetchImpl: typeof fetch): Promise<{ zone: ZoneGroup[]; nameservers: string[] }> {
  const q = async (name: string, type: string) => {
    const res = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`公共 DNS 查询失败：HTTP ${res.status}`);
    const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
    const code = { NS: 2, CNAME: 5, MX: 15, TXT: 16 }[type];
    return (body.Answer ?? []).filter((a) => a.type === code).map((a) => ({ content: a.data }));
  };
  const [ns, mx, txt, dmarc, ...dkim] = await Promise.all([
    q(domain, "NS"), q(domain, "MX"), q(domain, "TXT"), q(`_dmarc.${domain}`, "TXT"),
    ...HOSTINGER_MAIL.dkim.map((k) => q(`${k.name}.${domain}`, "CNAME")),
  ]);
  return {
    nameservers: ns.map((r) => r.content),
    zone: [
      { name: "@", type: "MX", records: mx },
      { name: "@", type: "TXT", records: txt },
      { name: "_dmarc", type: "TXT", records: dmarc },
      ...HOSTINGER_MAIL.dkim.map((k, i) => ({ name: k.name, type: "CNAME", records: dkim[i] })),
    ],
  };
}

interface MailOrder { id: string; status: string; domain?: { name?: string } }

// ---- 新建邮箱的默认密码（设置页填写，加密保存）：不设就为每个邮箱生成随机强密码 ----
const DEFAULT_PASSWORD = "mail.defaultPassword";

/** Hostinger 邮箱密码规则：至少 8 位，含大写、小写、数字和特殊字符 */
export const mailboxPasswordProblem = (p: string): string | null =>
  p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p) ? null : "邮箱密码至少 8 位，要同时有大写字母、小写字母、数字和特殊字符";

export function setDefaultMailboxPassword(db: DatabaseSync, key: Buffer, password: string | null): void {
  if (password === null) {
    db.prepare("DELETE FROM secrets WHERE name = ?").run(DEFAULT_PASSWORD);
    return;
  }
  const problem = mailboxPasswordProblem(password);
  if (problem) throw new Error(problem);
  setSecret(db, key, DEFAULT_PASSWORD, password); // 不留末几位提示
}

export const hasDefaultMailboxPassword = (db: DatabaseSync) => Boolean(db.prepare("SELECT 1 FROM secrets WHERE name = ?").get(DEFAULT_PASSWORD));

/** 客服邮箱地址、它是否在本站域名上、这个域名有没有有效的 Hostinger 邮箱订单 */
export async function mailSetup(ctx: StepCtx): Promise<{ email: string; onDomain: boolean; order: MailOrder | null }> {
  const email = facts(ctx).email;
  const onDomain = email.split("@")[1]?.toLowerCase() === ctx.domain.toLowerCase();
  if (!onDomain) return { email, onDomain, order: null };
  const orders = (await listAll(ctx.hx, "mail_orders_list")) as MailOrder[];
  return { email, onDomain, order: orders.find((o) => o.domain?.name === ctx.domain && o.status === "active") ?? null };
}

/** 建 support@（已有就复用）并加 orders@ 别名。返回给人看的说明；有问题时 ok=false，但不让建站失败。 */
export async function ensureMailbox(ctx: StepCtx): Promise<{ ok: boolean; detail: string }> {
  const { email, onDomain, order } = await mailSetup(ctx);
  if (!onDomain) return { ok: true, detail: `客服邮箱用的是 ${email}，不在这个域名上，不创建` };
  // Hostinger 的 API 不能申请免费试用（目录里只有付费套餐），只能你在 hPanel 里开通
  if (!order) return { ok: false, detail: `${ctx.domain} 没有 Hostinger 邮箱订单，${email} 收不到邮件：在 hPanel 的「邮箱」里给这个域名开通免费试用（1 个月），然后到站点页点「修复」` };
  const defaultPassword = getSecret(ctx.d.db, ctx.d.key, DEFAULT_PASSWORD);
  const local = email.split("@")[0];
  const find = async () => ((await listAll(ctx.hx, "mail_mailboxes_list", { orderId: order.id, search: local })) as { id: string; address: string }[])
    .find((m) => m.address.toLowerCase() === email.toLowerCase());
  let box = await find();
  let created = false;
  let passwordNote = "";
  if (!box) {
    // 设置页有默认密码就用它，否则生成随机强密码（满足 Hostinger 的规则：大小写、数字、特殊字符）
    const password = defaultPassword ?? `Aa1!${randomBytes(15).toString("base64url")}`;
    passwordNote = defaultPassword ? "，用设置页的默认密码" : "，随机密码已加密保存";
    try {
      await ctx.act("mail_mailboxes_create-mailbox", { orderId: order.id, local_part: local, password });
    } catch (e) {
      if (e instanceof PermanentError) return { ok: false, detail: `没能创建 ${email}：${e.message.slice(0, 200)}（可能是邮箱套餐的席位用完了）` };
      throw e;
    }
    box = await find();
    if (!box) throw new Error(`创建 ${email} 的请求没有得到确认，稍后重试`);
    ctx.save("mailbox_ciphertext", seal(ctx.d.key, JSON.stringify({ address: email, password })));
    created = true;
  } else if (!ctx.site.mailbox_ciphertext && defaultPassword && ctx.d.login) {
    // 已有的邮箱：用默认密码登录一次试试（很多邮箱是在 hPanel 里用同一个密码建的），能登录才保存
    const creds = { address: email, password: defaultPassword };
    const ok = await ctx.d.login(creds).then(() => true, () => false);
    if (ok) ctx.save("mailbox_ciphertext", seal(ctx.d.key, JSON.stringify(creds)));
    passwordNote = ok ? "，默认密码能登录，已保存" : "，默认密码登录不了，密码在站点页填写";
  }
  const alias = `orders@${ctx.domain}`;
  const aliases = (await listAll(ctx.hx, "mail_aliases_list", { orderId: order.id })) as { address: string }[];
  let aliasNote = `别名 ${alias}`;
  if (!aliases.some((a) => a.address.toLowerCase() === alias)) {
    try {
      await ctx.act("mail_aliases_create-alias", { mailboxId: box.id, local_part: "orders" });
    } catch (e) {
      if (!(e instanceof PermanentError)) throw e;
      aliasNote = `别名 ${alias} 没建成（${e.message.slice(0, 100)}）`;
    }
  }
  return { ok: true, detail: `${created ? "已创建" : "已有，复用"} ${email}${passwordNote}，${aliasNote}` };
}

const describe = (g: ZoneGroup) => `${g.type} ${g.name} → ${g.records.map((r) => r.content).join("，")}`;

/** 检查邮件 DNS；fix=true 时把缺的记录写进 Hostinger 区域（先校验，写完再读一遍确认）。 */
export async function mailDns(ctx: StepCtx, fix: boolean): Promise<MailDnsResult> {
  const pub = await publicMailZone(ctx.domain, ctx.d.fetch);
  const atHostinger = pub.nameservers.length > 0 && pub.nameservers.every((n) => HOSTINGER_MAIL.nameservers.test(n));
  if (!atHostinger) {
    const plan = planMailDns(pub.zone);
    return { atHostinger, checks: plan.checks, fixed: [], manual: plan.updates.map(describe), planned: [], snapshotId: null };
  }
  const zone = () => ctx.hx("dns_records_list", { domain: ctx.domain }) as Promise<ZoneGroup[]>;
  let plan = planMailDns(await zone());
  if (!fix || plan.updates.length === 0) return { atHostinger, checks: plan.checks, fixed: [], manual: [], planned: plan.updates.map(describe), snapshotId: null };

  // Hostinger 每次改区域都会自动拍快照；记下改动前最新的一张，需要时在 hPanel 里恢复
  const snapshots = (await ctx.hx("dns_snapshots_list", { domain: ctx.domain })) as { id: number }[];
  const update = { domain: ctx.domain, overwrite: true, zone: plan.updates };
  try {
    await ctx.hx("dns_records_validate", update);
  } catch (e) {
    throw new PermanentError(`Hostinger 认为这些 DNS 记录不合法：${(e as Error).message.slice(0, 200)}`);
  }
  await ctx.act("dns_records_update", update);
  const fixed = plan.updates.map(describe);
  plan = planMailDns(await zone());
  if (plan.updates.length) throw new Error("DNS 记录写入后没有生效，稍后重试");
  return { atHostinger, checks: plan.checks, fixed, manual: [], planned: [], snapshotId: snapshots[0]?.id ?? null };
}

/** 站点页和 QA 用：客服邮箱和邮件 DNS 的现状（只读） */
export async function mailStatus(ctx: StepCtx): Promise<MailStatus> {
  const { email, onDomain, order } = await mailSetup(ctx);
  const box = order
    ? ((await listAll(ctx.hx, "mail_mailboxes_list", { orderId: order.id, search: email.split("@")[0] })) as { address: string; status: string }[])
      .find((m) => m.address.toLowerCase() === email.toLowerCase())
    : undefined;
  return {
    email, onDomain, hasOrder: Boolean(order), mailbox: box?.status ?? null,
    passwordSaved: Boolean(ctx.site.mailbox_ciphertext), dns: order ? await mailDns(ctx, false) : null,
  };
}
