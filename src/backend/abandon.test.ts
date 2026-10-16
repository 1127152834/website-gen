import assert from "node:assert/strict";
import test from "node:test";
import { abandonStatus, ABANDON_JOB, queueAbandon, retryAbandon, runAbandon, type AbandonDeps } from "./abandon.ts";
import { listFreeDomains } from "./batches.ts";
import { HostingerError, type HostingerExec } from "./hostinger.ts";
import { createRunner } from "./jobs.ts";
import { DOMAIN, setup } from "./testing.ts";

type Remote = {
  orders: Record<string, unknown>[];
  mailboxes: Record<string, unknown>[];
  aliases: Record<string, unknown>[];
  websites: Record<string, unknown>[];
  subscriptions: Record<string, unknown>[];
  calls: { op: string; params: Record<string, unknown> }[];
  keepWebsite?: boolean;
};

const remote = (): Remote => ({ orders: [], mailboxes: [], aliases: [], websites: [], subscriptions: [], calls: [] });

function fake(remote: Remote): HostingerExec {
  const page = (data: unknown[]) => ({ data: structuredClone(data), meta: { total: data.length } });
  return async (op, params = {}) => {
    remote.calls.push({ op, params });
    if (op === "mail_orders_list") return page(remote.orders.filter((item) => (item.domain as { name?: string })?.name === params.domain));
    if (op === "mail_aliases_list") return page(remote.aliases.filter((item) => item.order_id === params.orderId));
    if (op === "mail_mailboxes_list") return page(remote.mailboxes.filter((item) => item.order_id === params.orderId));
    if (op === "mail_aliases_delete-alias") {
      remote.aliases = remote.aliases.filter((item) => item.id !== params.aliasId);
      throw new HostingerError("HTTP 500: deletion response was lost", 500);
    }
    if (op === "mail_mailboxes_delete-mailbox") {
      remote.mailboxes = remote.mailboxes.filter((item) => item.id !== params.mailboxId);
      throw new HostingerError("HTTP 500: deletion response was lost", 500);
    }
    if (op === "hosting_websites_list") return page(remote.websites.filter((item) => item.domain === params.domain));
    if (op === "hosting_websites_delete") {
      if (!remote.keepWebsite) remote.websites = remote.websites.filter((item) => item.domain !== params.domain);
      throw new HostingerError("HTTP 500: async deletion response was lost", 500);
    }
    if (op === "billing_subscriptions_list") return structuredClone(remote.subscriptions);
    if (op === "billing_subscriptions_disable-auto-renewal") {
      const subscription = remote.subscriptions.find((item) => item.id === params.subscriptionId);
      if (subscription) subscription.is_auto_renewed = false;
      throw new HostingerError("HTTP 500: renewal response was lost", 500);
    }
    throw new Error(`unexpected operation ${op}`);
  };
}

function fixture(states: Map<number, Remote>) {
  const { db, siteId } = setup();
  db.prepare("UPDATE jobs SET status = 'done'").run();
  if (states.has(2)) db.prepare("INSERT INTO hostinger_accounts (id,label,token_ciphertext,token_hint,status,created_at) VALUES (2,'mail-account',X'01','0002','ok',0)").run();
  db.prepare(`INSERT INTO mailboxes
    (account_id,order_id,remote_id,address,domain,status,credential_ciphertext,monitoring)
    VALUES (1,'M1','B1',?,?,'active',X'0102',1)`).run(`support@${DOMAIN}`, DOMAIN);
  const mailboxId = Number((db.prepare("SELECT id FROM mailboxes WHERE remote_id = 'B1'").get() as { id: number }).id);
  db.prepare("INSERT INTO mail_messages (mailbox_id,folder,uid,subject,body_text) VALUES (?,'INBOX',1,'hello','cached')").run(mailboxId);
  db.prepare("UPDATE sites SET mailbox_ciphertext = X'0102' WHERE id = ?").run(siteId);
  const stopped: string[] = [];
  const events: unknown[] = [];
  let clock = 100;
  const deps: AbandonDeps = {
    db,
    hostinger: (accountId) => fake(states.get(accountId) ?? remote()),
    stopDomain: async (domain) => { stopped.push(domain); },
    emit: (event) => { events.push(event); },
    now: () => ++clock,
  };
  return { db, siteId, deps, stopped, events, clock: () => clock };
}

async function runQueued(deps: AbandonDeps, now: () => number) {
  const runner = createRunner({ db: deps.db, now, handlers: { [ABANDON_JOB]: (job) => runAbandon(deps, job) } });
  await runner.tick();
  await runner.stop();
}

test("放弃任务跨账号删除邮件和网站，核验 5xx 的实际状态并可幂等重入", async () => {
  const a = remote();
  a.orders = [{ id: "M1", domain: { name: DOMAIN }, subscription_id: "MAIL-1" }];
  a.mailboxes = [{ id: "B1", order_id: "M1", address: `support@${DOMAIN}` }];
  a.aliases = [{ id: "A1", order_id: "M1", address: `orders@${DOMAIN}` }];
  a.websites = [{ domain: DOMAIN }];
  a.subscriptions = [
    { id: "MAIL-1", type: "email", order_id: "M1", is_auto_renewed: true },
    { id: "DOMAIN-1", type: "domain", domain: DOMAIN, is_auto_renewed: true },
  ];
  const b = remote();
  b.orders = [{ id: "M2", domain: { name: DOMAIN }, subscription_id: "MAIL-2" }];
  b.mailboxes = [{ id: "B2", order_id: "M2", address: `sales@${DOMAIN}` }];
  b.aliases = [{ id: "A2", order_id: "M2", address: `shop@${DOMAIN}` }];
  b.subscriptions = [{ id: "MAIL-2", type: "mail", order_id: "M2", is_auto_renewed: true }];
  const f = fixture(new Map([[1, a], [2, b]]));

  assert.throws(() => queueAbandon(f.db, { domain: DOMAIN, confirmation: "wrong", siteId: f.siteId }), /完整域名/);
  const queued = queueAbandon(f.db, { domain: DOMAIN, confirmation: DOMAIN, siteId: f.siteId }, f.clock());
  assert.deepEqual(listFreeDomains(f.db), [], "墓碑在远端删除开始前就排除 domains.free");
  await runQueued(f.deps, f.clock);

  const status = abandonStatus(f.db, { jobId: queued.jobId });
  assert.equal(status?.status, "done");
  assert.ok(status?.steps.every((step) => step.status === "done"));
  assert.deepEqual(f.stopped, [DOMAIN]);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM mailboxes").get() as { n: number }).n, 0);
  assert.equal((f.db.prepare("SELECT mailbox_ciphertext FROM sites WHERE id = ?").get(f.siteId) as { mailbox_ciphertext: Uint8Array | null }).mailbox_ciphertext, null);
  assert.ok((f.db.prepare("SELECT abandoned_at FROM sites WHERE id = ?").get(f.siteId) as { abandoned_at: number | null }).abandoned_at != null);
  assert.equal(a.mailboxes.length + b.mailboxes.length + a.aliases.length + b.aliases.length + a.websites.length, 0);
  assert.ok([...a.subscriptions, ...b.subscriptions].every((item) => item.is_auto_renewed === false));
  assert.ok(f.events.length >= 10);

  const callCount = a.calls.length + b.calls.length;
  assert.equal(queueAbandon(f.db, { domain: DOMAIN, confirmation: DOMAIN, siteId: f.siteId }, f.clock()).jobId, queued.jobId);
  await runAbandon(f.deps, { id: queued.jobId, type: ABANDON_JOB, siteId: f.siteId, attempts: 0, maxAttempts: 3 });
  assert.equal(a.calls.length + b.calls.length, callCount, "已完成步骤不会重复执行远端写操作");
});

test("域名订阅不唯一时失败关闭且不猜测", async () => {
  const a = remote();
  a.subscriptions = [
    { id: "D1", type: "domain", domain: DOMAIN, is_auto_renewed: true },
    { id: "D2", type: "domain", domain: DOMAIN, is_auto_renewed: true },
  ];
  const f = fixture(new Map([[1, a]]));
  const { jobId } = queueAbandon(f.db, { domain: DOMAIN, confirmation: DOMAIN, accountId: 1 }, f.clock());
  await runQueued(f.deps, f.clock);
  const status = abandonStatus(f.db, { jobId });
  assert.equal(status?.status, "failed");
  assert.match(status?.error ?? "", /匹配到 2 项/);
  assert.equal(a.calls.filter((call) => call.op === "billing_subscriptions_disable-auto-renewal").length, 0);
  assert.deepEqual(listFreeDomains(f.db), []);
});

test("同域只有邮件订阅时也不会被当作域名订阅", async () => {
  const a = remote();
  a.subscriptions = [{ id: "EMAIL", type: "email", domain: DOMAIN, is_auto_renewed: true }];
  const f = fixture(new Map([[1, a]]));
  const { jobId } = queueAbandon(f.db, { domain: DOMAIN, confirmation: DOMAIN }, f.clock());
  await runQueued(f.deps, f.clock);
  assert.match(abandonStatus(f.db, { jobId })?.error ?? "", /匹配到 0 项/);
  assert.equal(a.calls.filter((call) => call.op === "billing_subscriptions_disable-auto-renewal").length, 0);
});

test("失败步骤可从原任务恢复，已完成步骤不重做", async () => {
  const a = remote();
  a.websites = [{ domain: DOMAIN }];
  a.keepWebsite = true;
  a.subscriptions = [{ id: "D1", type: "domain", domain: DOMAIN, is_auto_renewed: true }];
  const f = fixture(new Map([[1, a]]));
  const { jobId } = queueAbandon(f.db, { domain: DOMAIN, confirmation: DOMAIN, siteId: f.siteId }, f.clock());
  f.db.prepare("UPDATE jobs SET max_attempts = 1 WHERE id = ?").run(jobId);
  await runQueued(f.deps, f.clock);
  assert.equal(abandonStatus(f.db, { jobId })?.status, "failed");
  assert.equal(f.stopped.length, 1);

  a.keepWebsite = false;
  retryAbandon(f.db, jobId, f.clock());
  await runQueued(f.deps, f.clock);
  assert.equal(abandonStatus(f.db, { jobId })?.status, "done");
  assert.equal(f.stopped.length, 1, "重试从失败的网站步骤继续，不重复本地清理");
});

test("不属于目标域名的邮箱会使任务停止，绝不误删", async () => {
  const a = remote();
  a.orders = [{ id: "M1", domain: { name: DOMAIN }, subscription_id: "MAIL-1" }];
  a.mailboxes = [{ id: "FOREIGN", order_id: "M1", address: "owner@other.example" }];
  a.subscriptions = [{ id: "MAIL-1", type: "mail", is_auto_renewed: true }];
  const f = fixture(new Map([[1, a]]));
  const { jobId } = queueAbandon(f.db, { domain: DOMAIN, confirmation: DOMAIN }, f.clock());
  await runQueued(f.deps, f.clock);
  assert.match(abandonStatus(f.db, { jobId })?.error ?? "", /不属于/);
  assert.equal(a.mailboxes.length, 1);
  assert.equal(a.calls.filter((call) => call.op === "mail_mailboxes_delete-mailbox").length, 0);
});

