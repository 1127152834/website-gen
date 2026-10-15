import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { migrate, openDb } from "./db.ts";
import { accountToken, addAccount, listAccounts, listDomains, removeAccount, syncAccount, syncWithStoredToken } from "./accounts.ts";
import { HostingerError, type HostingerExec } from "./hostinger.ts";

const key = randomBytes(32);
const fresh = () => {
  const db = openDb(":memory:");
  migrate(db);
  return db;
};
const fake = (responses: Record<string, unknown>): HostingerExec => async (op) => {
  if (!(op in responses)) throw new Error(`unexpected operation ${op}`);
  const r = responses[op];
  if (r instanceof Error) throw r;
  return r;
};
const page = (data: unknown[]) => ({ data, meta: { current_page: 1, per_page: 25, total: data.length } });

const snapshot = (domains: string[]) => ({
  hosting_orders_list: page([{ id: 101, plan: { name: "hostinger_unlimited_v6" }, status: "active", created_at: "2026-10-03T11:57:58Z" }]),
  hosting_websites_list: page([{ domain: "a.com", username: "u1", order_id: 101, website_type: "wordpress", is_enabled: true, created_at: "2026-10-10T00:00:00Z" }]),
  domains_portfolio_list: domains.map((d, i) => ({ id: i + 1, domain: d, type: "domain", status: "active", expires_at: "2027-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z" })),
  mail_orders_list: page([{ id: "OR1", status: "active", is_trial: true, seats: 1, domain: { name: "b.com" }, plan: { title: "Starter Business Email" }, expires_at: "2026-11-01T00:00:00Z" }]),
});

test("addAccount verifies the token with Hostinger and stores only ciphertext", async () => {
  const db = fresh();
  const id = await addAccount(db, key, { label: "主账号", token: "tok-abcd1234" }, fake({ hosting_orders_list: page([]) }));
  const row = db.prepare("SELECT token_ciphertext, token_hint FROM hostinger_accounts WHERE id = ?").get(id) as { token_ciphertext: Uint8Array; token_hint: string };
  assert.ok(!Buffer.from(row.token_ciphertext).toString("latin1").includes("tok-abcd1234"));
  assert.equal(row.token_hint, "1234");
  assert.equal(accountToken(db, key, id), "tok-abcd1234");
});

test("addAccount rejects a token Hostinger refuses and stores nothing", async () => {
  const db = fresh();
  const exec = fake({ hosting_orders_list: new HostingerError("HTTP 401: Unauthenticated.", 401) });
  await assert.rejects(addAccount(db, key, { label: "坏的", token: "nope" }, exec), /Token 无效/);
  assert.equal(listAccounts(db).length, 0);
});

test("syncAccount stores a snapshot and the next sync drops resources that disappeared", async () => {
  const db = fresh();
  const id = await addAccount(db, key, { label: "主账号", token: "tok-1" }, fake({ hosting_orders_list: page([]) }));

  assert.deepEqual(await syncAccount(db, id, fake(snapshot(["a.com", "b.com", "c.com"]))), { orders: 1, websites: 1, domains: 3, mailOrders: 1 });
  const domains = listDomains(db, id);
  assert.deepEqual(domains.map((d) => [d.domain, d.hasWebsite, d.hasMail]), [["a.com", true, false], ["b.com", false, true], ["c.com", false, false]]);

  await syncAccount(db, id, fake(snapshot(["a.com"])));
  const [account] = listAccounts(db);
  assert.equal(account.counts.domains, 1);
  assert.equal(account.status, "ok");
  assert.ok(account.lastSyncedAt);
});

test("a failed sync keeps the previous snapshot and records the error", async () => {
  const db = fresh();
  const id = await addAccount(db, key, { label: "主账号", token: "tok-1" }, fake({ hosting_orders_list: page([]) }));
  await syncAccount(db, id, fake(snapshot(["a.com"])));
  const broken = { ...snapshot([]), domains_portfolio_list: new HostingerError("HTTP 500: boom", 500) };
  await assert.rejects(syncAccount(db, id, fake(broken)));
  const [account] = listAccounts(db);
  assert.equal(account.counts.domains, 1);
  assert.equal(account.status, "error");
  assert.match(account.lastError ?? "", /500/);
});

test("a token that can no longer be decrypted marks the account instead of throwing synchronously", async () => {
  const db = fresh();
  const id = await addAccount(db, key, { label: "主账号", token: "tok-1" }, fake({ hosting_orders_list: page([]) }));
  const otherKey = randomBytes(32); // 例如数据被拷到另一台电脑，主密钥对不上
  const pending = syncWithStoredToken(db, otherKey, id, () => fake(snapshot(["a.com"])));
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending);
  const [account] = listAccounts(db);
  assert.equal(account.status, "error");
  assert.match(account.lastError ?? "", /无法解开/);
});

test("removeAccount deletes the account and its synced resources", async () => {
  const db = fresh();
  const id = await addAccount(db, key, { label: "主账号", token: "tok-1" }, fake({ hosting_orders_list: page([]) }));
  await syncAccount(db, id, fake(snapshot(["a.com"])));
  removeAccount(db, id);
  assert.equal(listAccounts(db).length, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM domains").get() as { n: number }).n, 0);
});
