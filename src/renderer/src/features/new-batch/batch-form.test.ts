import assert from "node:assert/strict";
import test from "node:test";
import { batchDraftSchema, emptyBatchDraft, entityToDraft, toBatchForm } from "./batch-form.ts";

test("建站向导把字符串数字转换成原有 batches.create 载荷", () => {
  const draft = emptyBatchDraft();
  draft.entity = {
    kind: "company", name: "Example LLC", address: "1 Main St", supportEmail: "auto", phone: "+1 555 0100",
    processingMin: "1", processingMax: "3", transitMin: "5", transitMax: "10",
  };
  draft.sites = [{ domain: "example.com", categories: "dog beds", count: "20", priceMin: "19.99", priceMax: "49.99", brand: " Example " }];
  assert.deepEqual(toBatchForm(draft), {
    entity: { kind: "company", name: "Example LLC", address: "1 Main St", supportEmail: "auto", phone: "+1 555 0100", processingDays: [1, 3], transitDays: [5, 10] },
    sites: [{ domain: "example.com", categories: "dog beds", count: 20, priceMin: 19.99, priceMax: 49.99, brand: "Example" }],
  });
  assert.equal(batchDraftSchema.safeParse(draft).success, true);
});

test("建站向导沿用共享校验并给出中文错误", () => {
  const result = batchDraftSchema.safeParse(emptyBatchDraft());
  assert.equal(result.success, false);
  assert.match(result.error?.issues.map((issue) => issue.message).join("\n") ?? "", /请填写公司法定名称/);
  assert.match(result.error?.issues.map((issue) => issue.message).join("\n") ?? "", /请选择域名/);
});

test("主体模板可无损回填到向导字段", () => {
  assert.deepEqual(entityToDraft({
    kind: "individual", name: "Jane", address: "2 Main St", supportEmail: "help@example.com", phone: "123",
    processingDays: [0, 2], transitDays: [4, 8],
  }), {
    kind: "individual", name: "Jane", address: "2 Main St", supportEmail: "help@example.com", phone: "123",
    processingMin: "0", processingMax: "2", transitMin: "4", transitMax: "8",
  });
});
