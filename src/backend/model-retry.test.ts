import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientModelError, withModelRetry } from "./model-retry.ts";

// 实测 2026-10-15：整站复核中一次「terminated」网络中断让整轮 QA 失败
test("transient model errors are retried, permanent ones are not", async () => {
  let calls = 0;
  const value = await withModelRetry(async () => { calls++; if (calls < 3) throw new Error("terminated"); return "ok"; }, [0, 0]);
  assert.equal(value, "ok");
  assert.equal(calls, 3);

  let permanent = 0;
  await assert.rejects(withModelRetry(async () => { permanent++; throw new Error("401 invalid api key"); }, [0, 0]), /401/);
  assert.equal(permanent, 1);

  for (const m of ["terminated", "fetch failed", "ECONNRESET", "socket hang up", "429 Too Many Requests", "503 Service Unavailable", "overloaded", "The operation was aborted due to timeout"]) assert.ok(isTransientModelError(new Error(m)), m);
  for (const m of ["401 invalid api key", "400 bad request: max_tokens", "model not found"]) assert.ok(!isTransientModelError(new Error(m)), m);
});
