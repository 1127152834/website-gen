import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { MailboxMonitor } from "./mailbox-monitor.ts";
import { parseMailText } from "./mailbox-parser.ts";
import { createMailboxService } from "./mailbox-service.ts";
import type { HostingerExec } from "./hostinger.ts";
import { seal, unseal } from "./secrets.ts";
import { FakeMailTransport, fakeRawMail, key, setup } from "./testing.ts";

interface RemoteState {
  orders: { id: string; domain: { name: string }; status: string }[];
  boxes: Map<string, { id: string; address: string; status: string }[]>;
}

const remote = (state: RemoteState, fake: FakeMailTransport): HostingerExec => async (operation, params = {}) => {
  if (operation === "mail_orders_list") return state.orders;
  if (operation === "mail_mailboxes_list") return state.boxes.get(String(params.orderId)) ?? [];
  if (operation === "mail_mailboxes_change-mailbox-password") {
    const mailboxId = String(params.mailboxId);
    const mailbox = [...state.boxes.values()].flat().find((item) => item.id === mailboxId);
    if (!mailbox) throw new Error("missing mailbox");
    fake.passwords.set(mailbox.address.toLowerCase(), String(params.password));
    return { ok: true };
  }
  if (operation === "mail_mailboxes_delete-mailbox") {
    for (const [order, boxes] of state.boxes) state.boxes.set(order, boxes.filter((item) => item.id !== String(params.mailboxId)));
    return { ok: true };
  }
  throw new Error(`unexpected ${operation}`);
};

function oneMailbox() {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const state: RemoteState = {
    orders: [{ id: "order-1", domain: { name: "nordicpaws.com" }, status: "active" }],
    boxes: new Map([["order-1", [{ id: "box-1", address: "support@nordicpaws.com", status: "active" }]]]),
  };
  const events: unknown[] = [];
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: remote(state, fake) }], transport: () => fake, push: (event) => events.push(event), monitor: { pollMs: 5, backoffMs: 1 } });
  return { db, fake, state, events, service };
}

test("邮箱清单跨两个账号，并复用流水线密文", async () => {
  const { db } = setup();
  db.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,status,created_at) VALUES(2,'副账号',?,'zzzz','ok',0)").run(seal(key, "token"));
  const fake = new FakeMailTransport();
  const states: RemoteState[] = [
    { orders: [{ id: "o1", domain: { name: "nordicpaws.com" }, status: "active" }], boxes: new Map([["o1", [{ id: "b1", address: "support@nordicpaws.com", status: "active" }]]]) },
    { orders: [{ id: "o2", domain: { name: "second.test" }, status: "active" }], boxes: new Map([["o2", [{ id: "b2", address: "sales@second.test", status: "active" }]]]) },
  ];
  db.prepare("UPDATE sites SET mailbox_ciphertext=? WHERE domain='nordicpaws.com'").run(seal(key, JSON.stringify({ address: "support@nordicpaws.com", password: "Pipeline1!" })));
  const service = createMailboxService({ db, key, accounts: () => states.map((state, index) => ({ id: index + 1, exec: remote(state, fake) })), transport: () => fake, push: () => {} });
  const boxes = await service.sync();
  assert.deepEqual(boxes.map((item) => item.address), ["support@nordicpaws.com", "sales@second.test"]);
  assert.equal(boxes[0].credentialSaved, true);
  assert.equal(boxes[0].credentialSource, "pipeline");
  await service.close();
});

test("凭据先 IMAP 验证再保存，重置后复用同一密码并更新站点密文", async () => {
  const { db, fake, service } = oneMailbox();
  const [box] = await service.sync();
  fake.passwords.set(box.address, "Typed1!");
  await assert.rejects(service.saveCredential({ mailboxId: box.id, password: "wrong" }), /authentication/);
  await service.saveCredential({ mailboxId: box.id, password: "Typed1!" });
  assert.equal(service.list()[0].credentialSource, "user");
  await service.resetCredential({ mailboxId: box.id, confirmed: true });
  assert.equal(service.list()[0].credentialSource, "reset");
  const site = db.prepare("SELECT mailbox_ciphertext FROM sites WHERE domain='nordicpaws.com'").get() as { mailbox_ciphertext: Uint8Array };
  assert.ok(site.mailbox_ciphertext);
  await service.close();
});

test("非客服邮箱凭据不会覆盖站点 support 邮箱密文", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const support = { address: "support@nordicpaws.com", password: "Support1!" };
  db.prepare("UPDATE sites SET mailbox_ciphertext=? WHERE domain='nordicpaws.com'").run(seal(key, JSON.stringify(support)));
  const state: RemoteState = {
    orders: [{ id: "o1", domain: { name: "nordicpaws.com" }, status: "active" }],
    boxes: new Map([["o1", [
      { id: "support", address: support.address, status: "active" },
      { id: "sales", address: "sales@nordicpaws.com", status: "active" },
    ]]]),
  };
  fake.passwords.set("sales@nordicpaws.com", "Sales1!");
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: remote(state, fake) }], transport: () => fake, push: () => {} });
  const sales = (await service.sync()).find((item) => item.address === "sales@nordicpaws.com")!;
  await service.saveCredential({ mailboxId: sales.id, password: "Sales1!" });
  const stored = db.prepare("SELECT mailbox_ciphertext FROM sites WHERE domain='nordicpaws.com'").get() as { mailbox_ciphertext: Uint8Array };
  assert.deepEqual(JSON.parse(unseal(key, stored.mailbox_ciphertext)), support);
  await service.close();
});

test("HTML 邮件只产出文本，链接和像素不会触发 fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => { fetches++; throw new Error("network forbidden"); }) as typeof fetch;
  try {
    const parsed = await parseMailText(fakeRawMail({
      from: "sender@example.test", to: ["support@nordicpaws.com"], subject: "Safety",
      html: '<style>@import "https://evil.test/x.css"</style><p>Hello <a href="https://evil.test/click">there</a></p><img src="https://evil.test/pixel.gif" width="1">',
    }));
    assert.equal(fetches, 0);
    assert.equal(parsed.text.includes("<img"), false);
    assert.equal(parsed.text.includes("<a "), false);
    assert.match(parsed.text, /Hello/);
  } finally { globalThis.fetch = originalFetch; }
});

test("超出 HTML 转文本上限的恶意邮件变成安全占位且不阻断相邻邮件", async () => {
  const { fake, service } = oneMailbox();
  const [box] = await service.sync();
  fake.passwords.set(box.address, "Mail1!");
  await service.saveCredential({ mailboxId: box.id, password: "Mail1!" });
  const malicious = fakeRawMail({ from: "bad@example.test", to: [box.address], subject: "large html", html: `<p>${"x".repeat(2 * 1024 * 1024 + 100)}</p>` });
  const normal = fakeRawMail({ from: "good@example.test", to: [box.address], subject: "normal", text: "safe neighbor" });
  fake.seed(box.address, "INBOX", [
    { uid: 1, uidValidity: "html-1", folder: "INBOX", flags: [], size: malicious.length, source: malicious },
    { uid: 2, uidValidity: "html-1", folder: "INBOX", flags: [], size: normal.length, source: normal },
  ]);
  const page = await service.messages({ mailboxId: box.id, folder: "INBOX", pageSize: 10 });
  assert.equal(page.total, 2);
  assert.match((await service.message({ mailboxId: box.id, folder: "INBOX", uid: 1 })).text, /无法安全解析/);
  assert.equal((await service.message({ mailboxId: box.id, folder: "INBOX", uid: 2 })).text, "safe neighbor");
  await service.close();
});

test("新邮件索引、未读计数、回复/回复全部/转发和 Sent 副本", async () => {
  const { db, fake, events, service } = oneMailbox();
  const [box] = await service.sync();
  fake.passwords.set(box.address, "Mail1!");
  await service.saveCredential({ mailboxId: box.id, password: "Mail1!" });
  fake.seed(box.address, "INBOX", []);
  fake.seed(box.address, "Sent", []);
  await service.messages({ mailboxId: box.id, folder: "INBOX", page: 1, pageSize: 20 });
  fake.seed(box.address, "INBOX", [{
    uid: 9, uidValidity: "1", folder: "INBOX", flags: [], size: 300,
    source: fakeRawMail({ from: '"Doe, Alice" <alice@example.test>', to: [box.address], cc: ['"Smith, Team" <team@example.test>'], subject: "Question", text: "Original body", messageId: "<original@example.test>" }),
  }]);
  const sync = db.prepare("SELECT sync_state_json FROM mailboxes WHERE id=?").get(box.id) as { sync_state_json: string };
  const syncState = JSON.parse(sync.sync_state_json) as { folders: Record<string, { syncedAt: number }> };
  syncState.folders.INBOX.syncedAt = 0;
  db.prepare("UPDATE mailboxes SET sync_state_json=? WHERE id=?").run(JSON.stringify(syncState), box.id);
  const page = await service.messages({ mailboxId: box.id, folder: "INBOX", page: 1, pageSize: 20 });
  assert.equal(page.total, 1);
  assert.equal(service.list()[0].unreadCount, 1);
  assert.ok(events.some((event) => (event as { type?: string }).type === "new"));
  for (const mode of ["reply", "replyAll", "forward"] as const) await service.send({
    mailboxId: box.id, to: mode === "forward" ? ["forward@example.test"] : [], cc: [], bcc: [], subject: "", text: `${mode} text`, mode,
    replyTo: { folder: "INBOX", uid: 9 }, attachments: [],
  });
  assert.equal(fake.sent.length, 3);
  assert.deepEqual(fake.sent[0].message.to, ["alice@example.test"]);
  assert.ok(fake.sent[1].message.to.includes("alice@example.test"));
  assert.deepEqual(fake.sent[1].message.cc, ["team@example.test"]);
  assert.equal(fake.sent[2].message.inReplyTo, "<original@example.test>");
  assert.equal((await fake.fetchMessages({ address: box.address, password: "Mail1!" }, "Sent")).length, 3);
  await service.close();
});

test("发信拒绝换行注入和非邮箱收件人", async () => {
  const { fake, service } = oneMailbox();
  const [box] = await service.sync();
  fake.passwords.set(box.address, "Mail1!");
  await service.saveCredential({ mailboxId: box.id, password: "Mail1!" });
  await assert.rejects(service.send({ mailboxId: box.id, to: ["victim@example.test\r\nBcc: attacker@example.test"], subject: "x", text: "x" }), /邮件地址无效/);
  await assert.rejects(service.send({ mailboxId: box.id, to: ["not-an-email"], subject: "x", text: "x" }), /邮件地址无效/);
  await service.close();
});

test("IDLE 上限、轮询回退、密码变化重启连接并干净停止", async () => {
  const fake = new FakeMailTransport();
  const candidates = Array.from({ length: 17 }, (_, index) => ({ id: index + 1, domain: "example.test", credentials: { address: `box${index}@example.test`, password: "Old1!" } }));
  for (const item of candidates) fake.passwords.set(item.credentials.address, item.credentials.password);
  const modes = new Map<number, string>();
  let polls = 0;
  const monitor = new MailboxMonitor({ candidates: () => candidates, transport: () => fake, syncInbox: async () => { polls++; }, setMode: (id, mode) => modes.set(id, mode), idleLimit: 15, pollMs: 5, backoffMs: 1 });
  await monitor.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal([...modes.values()].filter((mode) => mode === "idle").length, 15);
  assert.equal([...modes.values()].filter((mode) => mode === "poll").length, 2);
  assert.ok(polls >= 17);
  candidates[0].credentials = { ...candidates[0].credentials, password: "New1!" };
  fake.passwords.set(candidates[0].credentials.address, "New1!");
  await monitor.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(fake.idleStarts.some((item) => item.address === "box0@example.test" && item.password === "New1!"));
  await monitor.close();
  assert.equal(fake.idleStops.length, fake.idleStarts.length);
});

test("放弃域名停止监听且墓碑阻止同步复活", async () => {
  const { db, fake, service } = oneMailbox();
  const [box] = await service.sync();
  fake.passwords.set(box.address, "Mail1!");
  await service.saveCredential({ mailboxId: box.id, password: "Mail1!" });
  await service.setMonitoring({ mailboxId: box.id, enabled: true });
  db.prepare("INSERT INTO abandoned_domains(domain,abandoned_at) VALUES('nordicpaws.com',?)").run(Date.now());
  await service.stopDomain("nordicpaws.com");
  assert.equal((await service.sync()).length, 0);
  await assert.rejects(service.send({ mailboxId: box.id, to: ["x@example.test"], subject: "x", text: "x" }), /不存在|放弃/);
  await service.close();
});

test("删除与旧清单并发时不会把邮箱复活", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  fake.passwords.set("support@nordicpaws.com", "Mail1!");
  const state: RemoteState = {
    orders: [{ id: "o1", domain: { name: "nordicpaws.com" }, status: "active" }],
    boxes: new Map([["o1", [{ id: "b1", address: "support@nordicpaws.com", status: "active" }]]]),
  };
  let listCalls = 0;
  let releaseSnapshot!: () => void;
  let snapshotWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => { snapshotWaiting = resolve; });
  const exec: HostingerExec = async (operation, params = {}) => {
    if (operation === "mail_orders_list") return state.orders;
    if (operation === "mail_mailboxes_list") {
      listCalls++;
      if (listCalls === 2) {
        const snapshot = [...(state.boxes.get(String(params.orderId)) ?? [])];
        snapshotWaiting();
        await new Promise<void>((resolve) => { releaseSnapshot = resolve; });
        return snapshot;
      }
      return state.boxes.get(String(params.orderId)) ?? [];
    }
    if (operation === "mail_mailboxes_delete-mailbox") {
      state.boxes.set("o1", []);
      return { ok: true };
    }
    throw new Error(`unexpected ${operation}`);
  };
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec }], transport: () => fake, push: () => {} });
  const [box] = await service.sync();
  const staleSync = service.sync();
  await waiting;
  await service.deleteMailbox({ mailboxId: box.id, confirmed: true });
  releaseSnapshot();
  await staleSync;
  assert.equal(service.list().length, 0);
  await service.close();
});

test("大文件夹逐封解析落库，不调用全量 MIME 数组接口", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  fake.passwords.set("support@nordicpaws.com", "Mail1!");
  const total = 600;
  fake.fetchMessages = async () => { throw new Error("不得物化全文件夹 MIME"); };
  fake.streamMessages = async function* (credentials, folder) {
    await this.verify(credentials);
    yield { kind: "mailbox" as const, uidValidity: "large-1" };
    for (let uid = 1; uid <= total; uid++) {
      if (uid > 1) {
        const count = (db.prepare("SELECT count(*) AS n FROM mail_messages").get() as { n: number }).n;
        assert.equal(count, uid - 1, "上一封应在请求下一封 MIME 前落库");
      }
      const source = fakeRawMail({ from: `sender${uid}@example.test`, to: [credentials.address], subject: `message ${uid}`, text: "bounded body" });
      yield { kind: "message" as const, message: { uid, uidValidity: "large-1", folder, flags: [], size: source.length, source } };
    }
  };
  const state: RemoteState = { orders: [{ id: "o1", domain: { name: "nordicpaws.com" }, status: "active" }], boxes: new Map([["o1", [{ id: "b1", address: "support@nordicpaws.com", status: "active" }]]]) };
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: remote(state, fake) }], transport: () => fake, push: () => {} });
  const [box] = await service.sync();
  await service.saveCredential({ mailboxId: box.id, password: "Mail1!" });
  const page = await service.messages({ mailboxId: box.id, folder: "INBOX", page: 1, pageSize: 10 });
  assert.equal(page.total, total);
  assert.equal(page.items.length, 10);
  await service.close();
});

test("已缓存 UID 只同步 flags，不重新下载正文且保留正文索引", async () => {
  const { db, fake, service } = oneMailbox();
  const [box] = await service.sync();
  fake.passwords.set(box.address, "Mail1!");
  await service.saveCredential({ mailboxId: box.id, password: "Mail1!" });
  const source = fakeRawMail({ from: "sender@example.test", to: [box.address], subject: "Keep body", text: "do not refetch me" });
  fake.seed(box.address, "INBOX", [{ uid: 1, uidValidity: "flags-1", folder: "INBOX", flags: [], size: source.length, source }]);
  await service.messages({ mailboxId: box.id, folder: "INBOX" });
  const message = fake.folders.get(box.address)?.get("INBOX")?.[0];
  assert.ok(message);
  message.flags = ["\\Seen"];
  const current = db.prepare("SELECT sync_state_json FROM mailboxes WHERE id=?").get(box.id) as { sync_state_json: string };
  const state = JSON.parse(current.sync_state_json) as { folders: Record<string, { uidValidity: string; syncedAt: number }> };
  state.folders.INBOX.syncedAt = 0;
  db.prepare("UPDATE mailboxes SET sync_state_json=? WHERE id=?").run(JSON.stringify(state), box.id);
  const page = await service.messages({ mailboxId: box.id, folder: "INBOX" });
  assert.equal(page.items[0].seen, true);
  assert.equal((await service.message({ mailboxId: box.id, folder: "INBOX", uid: 1 })).text, "do not refetch me");
  await service.close();
});
