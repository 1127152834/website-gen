import assert from "node:assert/strict";
import test from "node:test";
import { migrate, openDb } from "./db.ts";
import type { HostingerExec } from "./hostinger.ts";
import { readDomainMailboxes, selectDomainMailbox } from "./site-mailbox.ts";

function database(owners: number[] = [1]) {
  const db = openDb(":memory:");
  migrate(db);
  for (const accountId of owners) {
    db.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,status,created_at) VALUES(?,?,X'00','none','ok',0)")
      .run(accountId, `账号 ${accountId}`);
    db.prepare("INSERT INTO domains(account_id,external_id,domain,status) VALUES(?,?,?,'active')")
      .run(accountId, accountId, "shop.test");
  }
  return db;
}

function remote(input: {
  domainStatus?: string | null;
  orders?: { id: string; domain: { name: string }; status?: string | null }[];
  boxes?: Record<string, { address: string; status?: string | null }[]>;
} = {}): HostingerExec {
  return async (operation, params = {}) => {
    if (operation === "domains_portfolio_list") return [{ id: 1, domain: "shop.test", status: input.domainStatus === undefined ? "active" : input.domainStatus }];
    if (operation === "mail_orders_list") return input.orders ?? [{ id: "mail-1", domain: { name: "shop.test" }, status: "active" }];
    if (operation === "mail_mailboxes_list") return input.boxes?.[String(params.orderId)] ?? [];
    throw new Error(`unexpected operation ${operation}`);
  };
}

test("站点邮箱只返回实际 active 邮箱，多个邮箱不按 support 前缀擅自选择", async () => {
  const db = database();
  const result = await readDomainMailboxes(db, "SHOP.TEST", () => remote({ boxes: {
    "mail-1": [
      { address: "sales@shop.test", status: "active" },
      { address: "support@shop.test", status: "active" },
      { address: "old@shop.test", status: "disabled" },
    ],
  } }));
  assert.deepEqual(result, {
    domain: "shop.test",
    accountId: 1,
    mailboxes: [{ address: "sales@shop.test" }, { address: "support@shop.test" }],
    defaultEmail: null,
  });
  assert.throws(() => selectDomainMailbox(result), /请选择.*邮箱/);
  assert.equal(selectDomainMailbox(result, "sales@shop.test"), "sales@shop.test");
  assert.equal(selectDomainMailbox(result, "support@shop.test"), "support@shop.test");
});

test("唯一实际邮箱不限制前缀；多个邮箱必须由用户明确选择", async () => {
  const db = database();
  for (const prefix of ["hello", "sales", "service", "contact"]) {
    const address = `${prefix}@shop.test`;
    const unique = await readDomainMailboxes(db, "shop.test", () => remote({ boxes: { "mail-1": [{ address, status: "active" }] } }));
    assert.equal(unique.defaultEmail, address);
    assert.equal(selectDomainMailbox(unique), address);
  }

  const multiple = await readDomainMailboxes(db, "shop.test", () => remote({ boxes: { "mail-1": [
    { address: "hello@shop.test", status: "active" }, { address: "sales@shop.test", status: "active" },
  ] } }));
  assert.equal(multiple.defaultEmail, null);
  assert.throws(() => selectDomainMailbox(multiple), /请选择.*邮箱/);
  assert.equal(selectDomainMailbox(multiple, " SALES@SHOP.TEST "), "sales@shop.test");
  assert.throws(() => selectDomainMailbox(multiple, "other@shop.test"), /不是.*已申请/);
});

test("没有邮箱是成功的空结果，但不能通过建站邮箱选择门禁", async () => {
  const db = database();
  const result = await readDomainMailboxes(db, "shop.test", () => remote({ orders: [] }));
  assert.deepEqual(result.mailboxes, []);
  assert.equal(result.defaultEmail, null);
  assert.throws(() => selectDomainMailbox(result), /先.*申请邮箱/);
});

test("域名归属歧义、远端缺状态或查询异常全部 fail closed", async () => {
  const ambiguous = database([1, 2]);
  let calls = 0;
  await assert.rejects(readDomainMailboxes(ambiguous, "shop.test", () => async () => { calls++; return []; }), /多个.*账号/);
  assert.equal(calls, 0, "归属不唯一时不得试探任一账号");

  const db = database();
  const optionalDomainStatus = await readDomainMailboxes(db, "shop.test", () => remote({ domainStatus: null, orders: [] }));
  assert.deepEqual(optionalDomainStatus.mailboxes, [], "MCP 未声明域名响应 status 必填，沿用已同步的 active 证据");
  await assert.rejects(readDomainMailboxes(db, "shop.test", () => remote({ orders: [{ id: "mail-1", domain: { name: "shop.test" } }] })), /状态/);
  await assert.rejects(readDomainMailboxes(db, "shop.test", () => remote({ boxes: { "mail-1": [{ address: "support@shop.test" }] } })), /状态/);
  await assert.rejects(readDomainMailboxes(db, "shop.test", () => async () => { throw new Error("network down"); }), /network down/);
});
