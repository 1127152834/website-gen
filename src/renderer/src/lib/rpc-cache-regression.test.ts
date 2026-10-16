import assert from "node:assert/strict";
import test from "node:test";
import { RpcCache } from "./rpc-cache.ts";

test("SWR exposes previous data synchronously for the entire pending revalidation", async () => {
  let finish!: (value: unknown) => void;
  let calls = 0;
  const cache = new RpcCache(async () => {
    if (++calls === 1) return { name: "cached" };
    return await new Promise((resolve) => { finish = resolve; });
  });
  cache.setUser(1);
  await cache.refresh("sites.all");
  const pending = cache.refresh("sites.all");
  assert.deepEqual(cache.snapshot("sites.all").data, { name: "cached" });
  assert.equal(cache.snapshot("sites.all").refreshing, true);
  finish({ name: "updated" });
  await pending;
  assert.deepEqual(cache.snapshot("sites.all").data, { name: "updated" });
});

test("failed revalidation keeps stale data and reports an error without an endless refreshing flag", async () => {
  let fail = false;
  const cache = new RpcCache(async () => {
    if (fail) throw new Error("offline");
    return [1];
  });
  cache.setUser(1);
  await cache.refresh("mail.list");
  fail = true;
  await assert.rejects(cache.refresh("mail.list"), /offline/);
  assert.deepEqual(cache.snapshot("mail.list").data, [1]);
  assert.match(cache.snapshot("mail.list").error!.message, /offline/);
  assert.equal(cache.snapshot("mail.list").refreshing, false);
});

test("logout clears data, pending debounce timers and late responses", async () => {
  let finish!: (value: unknown) => void;
  let calls = 0;
  const cache = new RpcCache(async () => {
    calls++;
    return await new Promise((resolve) => { finish = resolve; });
  });
  cache.setUser(7);
  const pending = cache.refresh("overview.get");
  cache.scheduleRefresh("mail.list", undefined, 10);
  cache.setUser(null);
  finish({ owner: 7 });
  await assert.rejects(pending, /登录状态已变化/);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1);
  assert.equal(cache.snapshot("overview.get").data, undefined);
});
