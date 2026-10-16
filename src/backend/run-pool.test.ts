import { test } from "node:test";
import assert from "node:assert/strict";
import { runPool } from "./run-pool.ts";

// 实测 2026-10-16：并行复核中一页出错后，其余工人仍在后台复核、调用模型，进度日志排到「完成」之后
test("after a failure no new items start, and the error is raised only when every worker has stopped", async () => {
  const started: number[] = [];
  let running = 0, maxAfterFail = 0, failedAt = -1;
  await assert.rejects(runPool([0, 1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    started.push(n); running++;
    await new Promise((r) => setTimeout(r, n === 1 ? 5 : 20));
    running--;
    if (n === 1) { failedAt = started.length; throw new Error("boom"); }
    if (failedAt >= 0) maxAfterFail = Math.max(maxAfterFail, running);
    return n;
  }), /boom/);
  assert.equal(running, 0, "rejects only after in-flight items finished");
  assert.ok(started.length <= failedAt + 2, `no new items after the failure (started ${started.length})`);
});

test("results keep input order", async () => {
  assert.deepEqual(await runPool([3, 1, 2], 2, async (n) => { await new Promise((r) => setTimeout(r, n * 3)); return n * 10; }), [30, 10, 20]);
});
