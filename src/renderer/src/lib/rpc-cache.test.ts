import assert from "node:assert/strict";
import test from "node:test";
import { RpcCache, stableRpcParams } from "./rpc-cache.ts";

test("stableRpcParams ignores object key order", () => {
  assert.equal(stableRpcParams({ b: 2, a: { d: 4, c: 3 } }), stableRpcParams({ a: { c: 3, d: 4 }, b: 2 }));
});

test("RpcCache coalesces concurrent requests for the same user, method and params", async () => {
  let calls = 0;
  let resolve!: (value: unknown) => void;
  const cache = new RpcCache(async () => {
    calls++;
    return await new Promise((done) => { resolve = done; });
  });
  cache.setUser(7);

  const first = cache.refresh("sites.all", { includeHistory: false });
  const second = cache.refresh("sites.all", { includeHistory: false });
  assert.equal(calls, 1);
  assert.equal(first, second);
  resolve([1, 2]);
  assert.deepEqual(await first, [1, 2]);
  assert.deepEqual(cache.snapshot("sites.all", { includeHistory: false }).data, [1, 2]);
});

test("RpcCache clears on user switch and ignores late responses from the previous user", async () => {
  let resolve!: (value: unknown) => void;
  const cache = new RpcCache(async () => await new Promise((done) => { resolve = done; }));
  cache.setUser(1);
  const oldRequest = cache.refresh("overview.get");

  cache.setUser(2);
  assert.equal(cache.snapshot("overview.get").data, undefined);
  resolve({ owner: 1 });
  await assert.rejects(oldRequest, /登录状态已变化/);
  assert.equal(cache.snapshot("overview.get").data, undefined);
});

test("RpcCache debounces repeated scheduled refreshes", async () => {
  let calls = 0;
  const cache = new RpcCache(async () => ++calls);
  cache.setUser(3);

  cache.scheduleRefresh("overview.get", undefined, 20);
  cache.scheduleRefresh("overview.get", undefined, 20);
  cache.scheduleRefresh("overview.get", undefined, 20);
  await new Promise((resolve) => setTimeout(resolve, 45));

  assert.equal(calls, 1);
  assert.equal(cache.snapshot("overview.get").data, 1);
});

test("RpcCache invalidates all parameter variants for a method without discarding visible SWR data", async () => {
  const cache = new RpcCache(async (_method, params) => params);
  cache.setUser(4);
  await cache.refresh("example.listDocs", { workspaceId: 1 });
  await cache.refresh("example.listDocs", { workspaceId: 2 });

  cache.invalidate("example.listDocs");

  assert.deepEqual(cache.snapshot("example.listDocs", { workspaceId: 1 }).data, { workspaceId: 1 });
  assert.deepEqual(cache.snapshot("example.listDocs", { workspaceId: 2 }).data, { workspaceId: 2 });
});

test("targeted invalidation prevents a stale response winning without cancelling unrelated reads", async () => {
  const resolvers = new Map<string, (value: unknown) => void>();
  const cache = new RpcCache(async (method) => await new Promise((resolve) => { resolvers.set(method, resolve); }));
  cache.setUser(5);
  const stale = cache.refresh("accounts.list");
  const unrelated = cache.refresh("overview.get");

  cache.invalidate("accounts.list");
  resolvers.get("accounts.list")?.(["stale"]);
  resolvers.get("overview.get")?.({ ok: true });

  await assert.rejects(stale, /登录状态已变化/);
  assert.deepEqual(await unrelated, { ok: true });
  assert.equal(cache.snapshot("accounts.list").data, undefined);
  assert.deepEqual(cache.snapshot("overview.get").data, { ok: true });
});

test("refresh after invalidation waits for the stale request then coalesces one fresh request", async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  let calls = 0;
  const cache = new RpcCache(async () => {
    calls++;
    return await new Promise((resolve) => { resolvers.push(resolve); });
  });
  cache.setUser(6);
  const stale = cache.refresh("accounts.list");
  cache.invalidate("accounts.list");
  const fresh = cache.refresh("accounts.list");
  const duplicate = cache.refresh("accounts.list");

  assert.equal(calls, 1);
  assert.equal(fresh, duplicate);
  resolvers[0]?.(["stale"]);
  await assert.rejects(stale, /登录状态已变化/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  assert.equal(cache.snapshot("accounts.list").data, undefined);
  resolvers[1]?.(["fresh"]);
  assert.deepEqual(await fresh, ["fresh"]);
  assert.deepEqual(cache.snapshot("accounts.list").data, ["fresh"]);
});

test("a queued refresh cannot cross into the next logged-in user", async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  let calls = 0;
  const cache = new RpcCache(async () => {
    calls++;
    return await new Promise((resolve) => { resolvers.push(resolve); });
  });
  cache.setUser(10);
  const stale = cache.refresh("example.listDocs", { workspaceId: 9 });
  cache.invalidate("example.listDocs", { workspaceId: 9 });
  const queued = cache.refresh("example.listDocs", { workspaceId: 9 });

  cache.setUser(11);
  resolvers[0]?.(["old-user"]);
  await assert.rejects(stale, /登录状态已变化/);
  await assert.rejects(queued, /登录状态已变化/);
  assert.equal(calls, 1);
  assert.equal(cache.snapshot("example.listDocs", { workspaceId: 9 }).data, undefined);
});
