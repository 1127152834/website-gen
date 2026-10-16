import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { clearRpcQueries, invalidatePush, matchesPush, matchesRpc, queryClient, rpcQueryKey, stableRpcParams } from "./query-client.ts";

const freshClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: Infinity } } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("RPC query keys ignore object key order and separate logged-in users", () => {
  assert.equal(stableRpcParams({ b: 2, a: { d: 4, c: 3 } }), stableRpcParams({ a: { c: 3, d: 4 }, b: 2 }));
  assert.deepEqual(rpcQueryKey(1, "sites.all", { b: 2, a: 1 }), rpcQueryKey(1, "sites.all", { a: 1, b: 2 }));
  assert.notDeepEqual(rpcQueryKey(1, "sites.all"), rpcQueryKey(2, "sites.all"));
});

test("QueryClient deduplicates concurrent RPC reads with the same user, method and params", async () => {
  const client = freshClient();
  let calls = 0;
  let finish!: (value: number[]) => void;
  const queryKey = rpcQueryKey(7, "sites.all", { includeHistory: false });
  const queryFn = async () => { calls++; return await new Promise<number[]>((resolve) => { finish = resolve; }); };
  const first = client.fetchQuery({ queryKey, queryFn });
  const second = client.fetchQuery({ queryKey, queryFn });
  assert.equal(calls, 1);
  finish([1, 2]);
  assert.deepEqual(await first, [1, 2]);
  assert.deepEqual(await second, [1, 2]);
  assert.deepEqual(client.getQueryData(queryKey), [1, 2]);
  client.clear();
});

test("clearing the previous identity drops cached data and ignores its late response", async () => {
  const client = freshClient();
  const oldKey = rpcQueryKey(1, "overview.get");
  const newKey = rpcQueryKey(2, "overview.get");
  let finish!: (value: { owner: number }) => void;
  const oldRequest = client.fetchQuery({ queryKey: oldKey, queryFn: async () => await new Promise((resolve) => { finish = resolve; }) });
  await client.cancelQueries({ queryKey: ["rpc", 1] });
  client.removeQueries({ queryKey: ["rpc", 1] });
  finish({ owner: 1 });
  await assert.rejects(oldRequest);
  await tick();
  assert.equal(client.getQueryData(oldKey), undefined);
  assert.equal(client.getQueryData(newKey), undefined);
  client.clear();
});

test("an active observer keeps stale data visible throughout successful revalidation", async () => {
  const client = freshClient();
  const queryKey = rpcQueryKey(1, "sites.all");
  let calls = 0;
  let finish!: (value: { name: string }) => void;
  const observer = new QueryObserver(client, { queryKey, queryFn: async () => ++calls === 1 ? { name: "cached" } : await new Promise((resolve) => { finish = resolve; }) });
  const unsubscribe = observer.subscribe(() => undefined);
  await observer.refetch();
  const pending = observer.refetch();
  assert.deepEqual(observer.getCurrentResult().data, { name: "cached" });
  assert.equal(observer.getCurrentResult().isFetching, true);
  finish({ name: "updated" });
  await pending;
  assert.deepEqual(observer.getCurrentResult().data, { name: "updated" });
  unsubscribe();
  client.clear();
});

test("failed revalidation retains stale data, exposes the error and leaves no fetching flag", async () => {
  const client = freshClient();
  const queryKey = rpcQueryKey(1, "mail.list");
  let fail = false;
  const observer = new QueryObserver(client, { queryKey, queryFn: async () => { if (fail) throw new Error("offline"); return [1]; } });
  const unsubscribe = observer.subscribe(() => undefined);
  await observer.refetch();
  fail = true;
  await assert.rejects(observer.refetch({ throwOnError: true }), /offline/);
  assert.deepEqual(observer.getCurrentResult().data, [1]);
  assert.match(observer.getCurrentResult().error?.message ?? "", /offline/);
  assert.equal(observer.getCurrentResult().isFetching, false);
  unsubscribe();
  client.clear();
});

test("method and exact-parameter invalidation retain visible data and stay scoped", async () => {
  const client = freshClient();
  const one = rpcQueryKey(4, "grist.listDocs", { workspaceId: 1 });
  const two = rpcQueryKey(4, "grist.listDocs", { workspaceId: 2 });
  const unrelated = rpcQueryKey(4, "overview.get");
  client.setQueryData(one, { workspaceId: 1 });
  client.setQueryData(two, { workspaceId: 2 });
  client.setQueryData(unrelated, { ok: true });
  await client.invalidateQueries({ predicate: (query) => matchesRpc(query, "grist.listDocs"), refetchType: "none" });
  assert.deepEqual(client.getQueryData(one), { workspaceId: 1 });
  assert.deepEqual(client.getQueryData(two), { workspaceId: 2 });
  assert.equal(client.getQueryState(one)?.isInvalidated, true);
  assert.equal(client.getQueryState(two)?.isInvalidated, true);
  assert.equal(client.getQueryState(unrelated)?.isInvalidated, false);
  assert.deepEqual(client.getQueryCache().findAll({ predicate: (query) => matchesRpc(query, "grist.listDocs", { workspaceId: 1 }, true) }).map((query) => query.queryKey), [one]);
  client.clear();
});

test("targeted invalidation cancels stale active work, starts one fresh read and leaves unrelated reads alone", async () => {
  const client = freshClient();
  const accountsKey = rpcQueryKey(5, "accounts.list");
  const overviewKey = rpcQueryKey(5, "overview.get");
  client.setQueryData(accountsKey, ["seed"]);
  const accountResolvers: Array<(value: string[]) => void> = [];
  let accountCalls = 0;
  let unrelatedFinished = false;
  const accounts = new QueryObserver(client, { queryKey: accountsKey, queryFn: ({ signal }) => new Promise<string[]>((resolve, reject) => {
    accountCalls++;
    accountResolvers.push(resolve);
    signal.addEventListener("abort", () => reject(new Error("cancelled stale read")), { once: true });
  }) });
  const overview = new QueryObserver(client, { queryKey: overviewKey, queryFn: async () => { unrelatedFinished = true; return { ok: true }; } });
  const offAccounts = accounts.subscribe(() => undefined);
  const offOverview = overview.subscribe(() => undefined);
  await tick();
  assert.equal(accountCalls, 1);
  const invalidation = client.invalidateQueries({ predicate: (query) => matchesRpc(query, "accounts.list") });
  await tick();
  assert.equal(accountCalls, 2);
  assert.equal(unrelatedFinished, true);
  accountResolvers[0]?.(["stale"]);
  assert.deepEqual(client.getQueryData(accountsKey), ["seed"]);
  accountResolvers[1]?.(["fresh"]);
  await invalidation;
  await tick();
  assert.deepEqual(client.getQueryData(accountsKey), ["fresh"]);
  assert.deepEqual(client.getQueryData(overviewKey), { ok: true });
  offAccounts(); offOverview(); client.clear();
});

test("push invalidation debounces repeated bursts into one active-query refetch", async () => {
  clearRpcQueries();
  const queryKey = rpcQueryKey(3, "overview.get");
  let calls = 0;
  const observer = new QueryObserver(queryClient, { queryKey, queryFn: async () => ++calls, meta: { topics: ["batches"] } });
  const unsubscribe = observer.subscribe(() => undefined);
  await observer.refetch();
  invalidatePush({ kind: "changed", topic: "batches" });
  invalidatePush({ kind: "changed", topic: "batches" });
  invalidatePush({ kind: "changed", topic: "batches" });
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(calls, 2);
  assert.equal(observer.getCurrentResult().data, 2);
  unsubscribe();
  clearRpcQueries();
});

test("mail pushes match global mailbox data and only the addressed mailbox's scoped reads", () => {
  const client = freshClient();
  const globalKey = rpcQueryKey(3, "mail.list");
  const addressedKey = rpcQueryKey(3, "mail.messages", { mailboxId: 7, folder: "INBOX" });
  const otherMailboxKey = rpcQueryKey(3, "mail.messages", { mailboxId: 8, folder: "INBOX" });
  client.setQueryData(globalKey, []);
  client.setQueryData(addressedKey, []);
  client.setQueryData(otherMailboxKey, []);
  const [global, addressed, otherMailbox] = [globalKey, addressedKey, otherMailboxKey].map((queryKey) => client.getQueryCache().find({ queryKey, exact: true }));
  assert.ok(global && addressed && otherMailbox);
  const push = { kind: "mail" as const, mailboxId: 7 };
  assert.equal(matchesPush(global, push), true);
  assert.equal(matchesPush(addressed, push), true);
  assert.equal(matchesPush(otherMailbox, push), false);
  client.clear();
});
