import assert from "node:assert/strict";
import test from "node:test";
import { batchDraftSchema, emptyBatchDraft, resolveSiteMailboxEmail, toBatchForm } from "./batch-form.ts";

test("建站向导把字符串数字转换成原有 batches.create 载荷", () => {
  const draft = emptyBatchDraft();
  draft.entity = {
    kind: "company", name: "Example LLC", address: "1 Main St", phone: "+1 555 0100",
    processingMin: "1", processingMax: "3", transitMin: "5", transitMax: "10",
  };
  draft.sites = [{ domain: "example.com", supportEmail: "support@example.com", categories: "dog beds", count: "20", priceMin: "19.99", priceMax: "49.99", brand: " Example " }];
  assert.deepEqual(toBatchForm(draft), {
    entity: { kind: "company", name: "Example LLC", address: "1 Main St", supportEmail: "auto", phone: "+1 555 0100", processingDays: [1, 3], transitDays: [5, 10] },
    sites: [{ domain: "example.com", supportEmail: "support@example.com", categories: "dog beds", count: 20, priceMin: 19.99, priceMax: 49.99, brand: "Example" }],
  });
  assert.equal(batchDraftSchema.safeParse(draft).success, true);
});

test("站点没有已解析客服邮箱时不能通过建站校验", () => {
  const draft = emptyBatchDraft();
  draft.entity = {
    kind: "company", name: "Example LLC", address: "1 Main St", phone: "+1 555 0100",
    processingMin: "1", processingMax: "3", transitMin: "5", transitMax: "10",
  };
  draft.sites[0] = { ...draft.sites[0], domain: "example.com", categories: "dog beds" };

  const result = batchDraftSchema.safeParse(draft);
  assert.equal(result.success, false);
  assert.match(result.error?.issues.map((issue) => issue.message).join("\n") ?? "", /请先为该站点申请邮箱/);
});

test("邮箱解析优先服务端默认值，并拒绝过期域名响应", () => {
  assert.equal(resolveSiteMailboxEmail("new.example", {
    domain: "new.example", accountId: 1,
    mailboxes: [{ address: "sales@new.example" }, { address: "support@new.example" }],
    defaultEmail: "support@new.example",
  }, "sales@new.example"), "support@new.example");
  assert.equal(resolveSiteMailboxEmail("new.example", {
    domain: "old.example", accountId: 1,
    mailboxes: [{ address: "support@old.example" }], defaultEmail: "support@old.example",
  }, ""), null);
});

test("没有默认邮箱时只保留服务端仍存在的用户选择", () => {
  const result = { domain: "example.com", accountId: 1, mailboxes: [{ address: "sales@example.com" }, { address: "hello@example.com" }], defaultEmail: null };
  assert.equal(resolveSiteMailboxEmail("example.com", result, "hello@example.com"), "hello@example.com");
  assert.equal(resolveSiteMailboxEmail("example.com", result, "removed@example.com"), "");
});

test("邮箱响应按规范化域名归属匹配，但不同域名仍被拒绝", () => {
  const result = { domain: "example.com", accountId: 1, mailboxes: [{ address: "support@example.com" }], defaultEmail: "support@example.com" };
  for (const domain of ["EXAMPLE.COM", " Example.com. "]) {
    assert.equal(resolveSiteMailboxEmail(domain, result, ""), "support@example.com");
  }
  assert.equal(resolveSiteMailboxEmail("other.example", result, ""), null);
});

test("建站向导沿用共享校验并给出中文错误", () => {
  const result = batchDraftSchema.safeParse(emptyBatchDraft());
  assert.equal(result.success, false);
  assert.match(result.error?.issues.map((issue) => issue.message).join("\n") ?? "", /请填写公司法定名称/);
  assert.match(result.error?.issues.map((issue) => issue.message).join("\n") ?? "", /请选择域名/);
});
