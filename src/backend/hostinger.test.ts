import { test } from "node:test";
import assert from "node:assert/strict";
import { listAll, parseError } from "./hostinger.ts";

test("listAll follows pagination until `total` items are collected", async () => {
  const calls: unknown[] = [];
  const exec = async (_op: string, params?: Record<string, unknown>) => {
    calls.push(params);
    const page = Number(params?.page ?? 1); // 第一页不带分页参数（有的接口不接受）
    const data = page === 1 ? [1, 2] : page === 2 ? [3, 4] : [5];
    return { data, meta: { current_page: page, per_page: 2, total: 5 } };
  };
  assert.deepEqual(await listAll(exec, "hosting_websites_list"), [1, 2, 3, 4, 5]);
  assert.deepEqual(calls, [{}, { page: 2, per_page: 2 }, { page: 3, per_page: 2 }]);
});

test("listAll accepts plain-array responses (no pagination)", async () => {
  assert.deepEqual(await listAll(async () => [{ id: 1 }], "domains_portfolio_list"), [{ id: 1 }]);
});

test("parseError extracts the HTTP status from MCP error text", () => {
  assert.equal(parseError('HTTP 401: {"message":"Unauthenticated."}').status, 401);
  assert.equal(parseError("connect ETIMEDOUT").status, null);
});
