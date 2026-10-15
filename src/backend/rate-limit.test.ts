import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter } from "./rate-limit.ts";

test("allows `limit` calls per window and makes the next one wait for the window to slide", async () => {
  let now = 0;
  const waits: number[] = [];
  const limiter = createLimiter(2, 1000, () => now, async (ms) => {
    waits.push(ms);
    now += ms;
  });
  await limiter.take();
  now = 100;
  await limiter.take();
  now = 200;
  await limiter.take(); // 第 1 次在 t=0，要等到 t=1000 才有名额
  assert.deepEqual(waits, [800]);
  assert.equal(now, 1000);
});
