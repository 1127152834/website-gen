import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import type { FetchMessageObject, ImapFlowOptions, ListResponse, MailboxObject } from "imapflow";
import { buildRawMessage, createMailTransport, MailSentAppendError, smtpTransportOptions, type ImapClient, type MailAdapterDeps } from "./mailbox-adapter.ts";
import type { OutgoingMessage } from "./mailbox-transport.ts";

const credentials = { address: "support@example.com", password: "Secret1!" };
const message: OutgoingMessage = {
  from: credentials.address,
  to: ["to@example.net"],
  cc: ["cc@example.net"],
  bcc: ["bcc@example.net"],
  subject: "plain",
  text: "https://example.invalid stays plain text",
  messageId: "<one@example.com>",
  attachments: [],
};

type State = {
  options: ImapFlowOptions[];
  folders: ListResponse[];
  messages: FetchMessageObject[];
  seen: boolean;
  moved: boolean;
  sentHas: boolean;
  appended: number;
  closed: boolean;
  sourceFetches: number;
  activeSourceFetches: number;
  maxActiveSourceFetches: number;
};

const mailbox = (path: string): MailboxObject => ({
  path, delimiter: "/", flags: new Set(), uidValidity: 77n, uidNext: 4, exists: 2,
});

class FakeImap extends EventEmitter implements ImapClient {
  mailbox: MailboxObject | false = false;
  readonly state: State;
  constructor(state: State) { super(); this.state = state; }
  async connect() {}
  async logout() {}
  close() { this.state.closed = true; }
  async list() { return this.state.folders; }
  async mailboxOpen(path: string | string[]) { return this.mailbox = mailbox(Array.isArray(path) ? path.join("/") : path); }
  async *fetch(_range: string | number, query: Parameters<ImapClient["fetch"]>[1]) {
    for (const item of this.state.messages) yield query.source ? item : { ...item, source: undefined };
  }
  async fetchAll(range: string | number) {
    if (typeof range === "number") {
      this.state.sourceFetches++;
      this.state.activeSourceFetches++;
      this.state.maxActiveSourceFetches = Math.max(this.state.maxActiveSourceFetches, this.state.activeSourceFetches);
      await Promise.resolve();
      this.state.activeSourceFetches--;
    }
    return this.state.messages.filter((item) => typeof range === "number" ? item.uid === range : true);
  }
  async search(query: { uid?: string | number; header?: Record<string, string | boolean> }) {
    if (query.header) return this.state.sentHas ? [99] : [];
    return this.state.moved ? [] : [Number(query.uid)];
  }
  async messageFlagsAdd() { this.state.seen = true; this.state.messages[0]!.flags = new Set(["\\Seen"]); return true; }
  async messageFlagsRemove() { this.state.seen = false; this.state.messages[0]!.flags = new Set(); return true; }
  async messageMove() { this.state.moved = true; return {}; }
  async download() { return { meta: { expectedSize: 3 }, content: Readable.from([Buffer.from("abc")]) }; }
  async append() { this.state.appended++; this.state.sentHas = true; return {}; }
  async idle(): Promise<boolean | undefined> { return undefined; }
}

const folder = (path: string, name: string, specialUse?: string): ListResponse => ({
  path, pathAsListed: path, name, delimiter: "/", parent: [], parentPath: "", flags: new Set(), specialUse, listed: true, subscribed: true,
});

function setup(overrides: Partial<MailAdapterDeps> = {}) {
  const state: State = {
    options: [],
    folders: [folder("INBOX", "INBOX", "\\Inbox"), folder("Sent", "Sent", "\\Sent"), folder("Trash", "Trash", "\\Trash")],
    messages: [
      { seq: 1, uid: 2, size: 3, flags: new Set(), source: Buffer.from("two") },
      { seq: 2, uid: 3, size: 5, flags: new Set(["\\Seen"]), source: Buffer.from("three") },
    ],
    seen: false, moved: false, sentHas: false, appended: 0, closed: false,
    sourceFetches: 0, activeSourceFetches: 0, maxActiveSourceFetches: 0,
  };
  const sent: { raw: Buffer; recipients: string[] }[] = [];
  const deps: MailAdapterDeps = {
    createImap: (options) => { state.options.push(options); return new FakeImap(state); },
    buildRaw: async (outgoing) => ({ raw: Buffer.from(`Message-ID: ${outgoing.messageId}\r\n\r\n${outgoing.text}`), messageId: outgoing.messageId }),
    sendRaw: async (_credentials, raw, recipients) => { sent.push({ raw, recipients }); return { messageId: message.messageId }; },
    ...overrides,
  };
  return { state, sent, transport: createMailTransport(deps) };
}

test("生产适配器固定 Hostinger IMAP TLS，并全量返回 UIDVALIDITY 与倒序邮件", async () => {
  const { state, transport } = setup();
  const rows = await transport.fetchMessages(credentials, "INBOX", 999);
  assert.deepEqual(rows.map((row) => [row.uid, row.uidValidity, row.source?.toString()]), [[3, "77", "three"], [2, "77", "two"]]);
  assert.equal(state.options[0]?.host, "imap.hostinger.com");
  assert.equal(state.options[0]?.port, 993);
  assert.equal(state.options[0]?.secure, true);
  assert.equal(state.options[0]?.disableAutoIdle, true);
});

test("一封超过 25 MB 的邮件只生成空原文占位，不阻断前后正常邮件", async () => {
  const { state, transport } = setup();
  state.messages = [
    { seq: 1, uid: 1, size: 3, flags: new Set(), source: Buffer.from("one") },
    { seq: 2, uid: 2, size: 25 * 1024 * 1024 + 1, flags: new Set() },
    { seq: 3, uid: 3, size: 5, flags: new Set(), source: Buffer.from("three") },
  ];
  const rows = await transport.fetchMessages(credentials, "INBOX");
  assert.deepEqual(rows.map((row) => [row.uid, row.source?.length]), [[3, 5], [2, 0], [1, 3]]);
});

test("流式扫描只为新 UID 逐封读取 MIME，已有 UID 仍更新 flags 且不重下载", async () => {
  const { state, transport } = setup();
  state.messages = Array.from({ length: 1_002 }, (_, index): FetchMessageObject => ({
    seq: index + 1,
    uid: index + 1,
    size: 4,
    flags: new Set(index === 500 ? ["\\Seen"] : []),
    source: Buffer.from("mail"),
  }));
  const knownUids = new Set(Array.from({ length: 1_000 }, (_, index) => index + 1));
  const stream = transport.streamMessages!(credentials, "INBOX", { uidValidity: "77", uids: knownUids })[Symbol.asyncIterator]();
  assert.deepEqual(await stream.next(), { done: false, value: { kind: "mailbox", uidValidity: "77" } });
  assert.equal(state.sourceFetches, 0, "mailbox marker and metadata scan do not fetch MIME");

  const messages: Array<{ uid: number; source?: Buffer; flags: string[] }> = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) break;
    if (next.value.kind === "message") messages.push(next.value.message);
  }
  assert.equal(messages.length, 1_002);
  assert.equal(state.sourceFetches, 2, "only the two unknown UIDs download MIME");
  assert.equal(state.maxActiveSourceFetches, 1, "MIME downloads are never prefetched concurrently");
  assert.equal(messages.find((item) => item.uid === 501)?.source, undefined);
  assert.deepEqual(messages.find((item) => item.uid === 501)?.flags, ["\\Seen"]);
  assert.equal(messages.find((item) => item.uid === 1_002)?.source?.toString(), "mail");
});

test("UIDVALIDITY 改变时忽略旧 UID 提示并重新逐封读取", async () => {
  const { state, transport } = setup();
  const events = [];
  for await (const event of transport.streamMessages!(credentials, "INBOX", { uidValidity: "old", uids: new Set([2, 3]) })) events.push(event);
  assert.equal(state.sourceFetches, 2);
  assert.equal(events[0]?.kind, "mailbox");
  assert.ok(events.slice(1).every((event) => event.kind === "message" && event.message.source != null));
});

test("已读、移入特殊用途 Trash 和显式附件下载都会核验且不解析 URL", async () => {
  const { state, transport } = setup();
  await transport.setSeen(credentials, "INBOX", 2, true);
  assert.equal(state.seen, true);
  await transport.moveToTrash(credentials, "INBOX", 2);
  assert.equal(state.moved, true);
  const content = await transport.downloadAttachment(credentials, "INBOX", 2, { partId: "2.1", name: "a.bin", type: "application/octet-stream", size: 3 });
  assert.equal(content.toString(), "abc");
  await assert.rejects(() => transport.downloadAttachment(credentials, "INBOX", 2, { partId: "https://tracker.invalid", name: "x", type: "x", size: 1 }), /partId/);
});

test("SMTP 只发送同一份原文，Sent 以 Message-ID 去重并验证追加", async () => {
  const { state, sent, transport } = setup();
  const first = await transport.send(credentials, message);
  assert.deepEqual(first, { messageId: message.messageId, appended: true });
  assert.equal(state.appended, 1);
  assert.deepEqual(sent[0]?.recipients, [...message.to, ...message.cc, ...message.bcc]);
  assert.match(sent[0]!.raw.toString(), /https:\/\/example\.invalid stays plain text/);

  const second = await transport.send(credentials, message);
  assert.deepEqual(second, { messageId: message.messageId, appended: false });
  assert.equal(state.appended, 1);
});

test("SMTP 成功但没有特殊用途 Sent 时抛出明确的已发送异常", async () => {
  const { state, transport } = setup();
  state.folders = [folder("INBOX", "INBOX", "\\Inbox")];
  await assert.rejects(
    () => transport.send(credentials, message),
    (error) => error instanceof MailSentAppendError && error.sent && error.messageId === message.messageId && /邮件已发送/.test(error.message),
  );
});

test("真实 Nodemailer MIME 编译不会把 Bcc 地址写进原文", async () => {
  const built = await buildRawMessage(message);
  const raw = built.raw.toString("utf8");
  assert.doesNotMatch(raw, /^Bcc:/mi);
  assert.doesNotMatch(raw, /bcc@example\.net/i);
  assert.match(raw, /Message-ID: <one@example\.com>/i);
});

test("每条 IMAP 连接消费 error 事件并把错误交给调用方", async () => {
  const { state } = setup();
  class ErrorImap extends FakeImap {
    override async connect() { this.emit("error", new Error("socket lost")); }
  }
  const transport = createMailTransport({
    createImap: () => new ErrorImap(state),
    buildRaw: async () => ({ raw: Buffer.alloc(0), messageId: message.messageId }),
    sendRaw: async () => ({ messageId: message.messageId }),
  });
  await assert.rejects(() => transport.listFolders(credentials), /socket lost/);
});

test("IDLE abort 会等待已开始的新邮件索引回调结束", async () => {
  const { state } = setup();
  let idleStartedResolve!: () => void;
  const idleStarted = new Promise<void>((resolve) => { idleStartedResolve = resolve; });
  let idleResolve!: () => void;
  class IdleImap extends FakeImap {
    override async idle() {
      idleStartedResolve();
      await new Promise<void>((resolve) => { idleResolve = resolve; });
      return undefined;
    }
    override close() { super.close(); idleResolve?.(); }
  }
  let client!: IdleImap;
  const transport = createMailTransport({
    createImap: () => (client = new IdleImap(state)),
    buildRaw: async () => ({ raw: Buffer.alloc(0), messageId: message.messageId }),
    sendRaw: async () => ({ messageId: message.messageId }),
  });
  const controller = new AbortController();
  let releaseCallback!: () => void;
  let callbackStartedResolve!: () => void;
  const callbackStarted = new Promise<void>((resolve) => { callbackStartedResolve = resolve; });
  const running = transport.idle(credentials, async () => {
    callbackStartedResolve();
    await new Promise<void>((resolve) => { releaseCallback = resolve; });
  }, controller.signal);
  await idleStarted;
  client.emit("exists", { count: 1 });
  await callbackStarted;
  controller.abort();
  let settled = false;
  void running.finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "stop must wait for the in-flight indexing callback");
  releaseCallback();
  await running;
  assert.equal(settled, true);
});

test("IDLE error 事件关闭连接并作为可重连错误返回", async () => {
  const { state } = setup();
  let idleStartedResolve!: () => void;
  const idleStarted = new Promise<void>((resolve) => { idleStartedResolve = resolve; });
  let idleResolve!: () => void;
  class IdleImap extends FakeImap {
    override async idle() { idleStartedResolve(); await new Promise<void>((resolve) => { idleResolve = resolve; }); return undefined; }
    override close() { super.close(); idleResolve?.(); }
  }
  let client!: IdleImap;
  const transport = createMailTransport({
    createImap: () => (client = new IdleImap(state)),
    buildRaw: async () => ({ raw: Buffer.alloc(0), messageId: message.messageId }),
    sendRaw: async () => ({ messageId: message.messageId }),
  });
  const running = transport.idle(credentials, async () => {}, new AbortController().signal);
  await idleStarted;
  client.emit("error", new Error("idle socket lost"));
  await assert.rejects(() => running, /idle socket lost/);
});

test("IDLE 返回 false 时作为错误交给监控退避，避免紧循环重连", async () => {
  const { state } = setup();
  class FalseIdleImap extends FakeImap { override async idle() { return false; } }
  const transport = createMailTransport({
    createImap: () => new FalseIdleImap(state),
    buildRaw: async () => ({ raw: Buffer.alloc(0), messageId: message.messageId }),
    sendRaw: async () => ({ messageId: message.messageId }),
  });
  await assert.rejects(() => transport.idle(credentials, async () => {}, new AbortController().signal), /退避策略重连/);
});

test("发件人与认证邮箱必须一致，附件总量硬限制为 20 MB", async () => {
  const { transport } = setup();
  await assert.rejects(() => transport.send(credentials, { ...message, from: "other@example.com" }), /发件地址/);
  await assert.rejects(() => transport.send(credentials, {
    ...message,
    attachments: [{ filename: "big.bin", contentType: "application/octet-stream", content: Buffer.alloc(20 * 1024 * 1024 + 1) }],
  }), /20 MB/);
});


// 实测 2026-10-15：nodemailer 自己做 DNS 解析，在本机代理的假 IP DNS 下卡 15 秒超时；且没有超时设置时界面无限转圈
test("SMTP connects to a pre-resolved IP, keeps certificate checks on the real host, and has timeouts", () => {
  const options = smtpTransportOptions({ address: "support@shop.test", password: "x" }, "203.0.113.5");
  assert.equal(options.host, "203.0.113.5");
  assert.equal(options.tls?.servername, "smtp.hostinger.com");
  assert.notEqual(options.tls?.rejectUnauthorized, false);
  assert.ok(options.connectionTimeout && options.greetingTimeout && options.socketTimeout);
  assert.equal(options.secure, true);
  assert.equal(options.port, 465);
});
