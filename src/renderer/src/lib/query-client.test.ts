import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { clearRpcQueries, invalidatePush, invalidateRpcState, matchesPush, matchesRpc, queryClient, rpcQueryKey, stableRpcParams } from "./query-client.ts";

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
  invalidatePush({ kind: "changed", topic: "batches" }, 3);
  invalidatePush({ kind: "changed", topic: "batches" }, 3);
  invalidatePush({ kind: "changed", topic: "batches" }, 3);
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
  const stringMailboxKey = rpcQueryKey(3, "mail.message", { mailboxId: "7", folder: "INBOX", uid: 1 });
  const triageStatusKey = rpcQueryKey(3, "mail.triage.status");
  const casesKey = rpcQueryKey(3, "mail.cases.list", { page: 1 });
  const tasksKey = rpcQueryKey(3, "mail.tasks.recordOutcome");
  const otherMailMethodKey = rpcQueryKey(3, "mail.defaultPassword.status");
  const otherUserKey = rpcQueryKey(4, "mail.messages", { mailboxId: 7, folder: "INBOX" });
  client.setQueryData(globalKey, []);
  client.setQueryData(addressedKey, []);
  client.setQueryData(otherMailboxKey, []);
  for (const queryKey of [stringMailboxKey, triageStatusKey, casesKey, tasksKey, otherMailMethodKey, otherUserKey]) client.setQueryData(queryKey, []);
  const [global, addressed, otherMailbox, stringMailbox, triageStatus, cases, tasks, otherMailMethod, otherUser] = [globalKey, addressedKey, otherMailboxKey, stringMailboxKey, triageStatusKey, casesKey, tasksKey, otherMailMethodKey, otherUserKey].map((queryKey) => client.getQueryCache().find({ queryKey, exact: true }));
  assert.ok(global && addressed && otherMailbox && stringMailbox && triageStatus && cases && tasks && otherMailMethod && otherUser);
  const push = { kind: "mail" as const, mailboxId: 7 };
  assert.equal(matchesPush(global, push, 3), true);
  assert.equal(matchesPush(addressed, push, 3), true);
  assert.equal(matchesPush(otherMailbox, push, 3), false);
  assert.equal(matchesPush(stringMailbox, push, 3), false, "mailboxId must be the exact numeric mailbox");
  assert.equal(matchesPush(triageStatus, push, 3), false, "ordinary mail push must not refresh triage status");
  assert.equal(matchesPush(cases, push, 3), false, "ordinary mail push must not refresh cases");
  assert.equal(matchesPush(tasks, push, 3), false, "ordinary mail push must not refresh task mutations");
  assert.equal(matchesPush(otherMailMethod, push, 3), false, "ordinary mail push must not refresh unrelated mail methods");
  assert.equal(matchesPush(otherUser, push, 3), false, "push must remain bound to the connected user");
  client.clear();
});

test("mail_triage changed pushes invalidate every subscribed triage view without broadening ordinary mail events", () => {
  const client = freshClient();
  const status = client.getQueryCache().build(client, { queryKey: rpcQueryKey(3, "mail.triage.status"), queryFn: async () => ({}), meta: { topics: ["mail_triage"] } });
  const cases = client.getQueryCache().build(client, { queryKey: rpcQueryKey(3, "mail.cases.list", { page: 1 }), queryFn: async () => ({}), meta: { topics: ["mail_triage"] } });
  const mailboxSeven = client.getQueryCache().build(client, { queryKey: rpcQueryKey(3, "mail.messages", { mailboxId: 7 }), queryFn: async () => ({}), meta: { topics: ["mail"] } });
  const mailboxEight = client.getQueryCache().build(client, { queryKey: rpcQueryKey(3, "mail.messages", { mailboxId: 8 }), queryFn: async () => ({}), meta: { topics: ["mail"] } });
  assert.equal(matchesPush(status, { kind: "changed", topic: "mail_triage" }, 3), true);
  assert.equal(matchesPush(cases, { kind: "changed", topic: "mail_triage" }, 3), true);
  assert.equal(matchesPush(mailboxSeven, { kind: "changed", topic: "mail_triage" }, 3), false);
  assert.equal(matchesPush(mailboxSeven, { kind: "mail", mailboxId: 7 }, 3), true);
  assert.equal(matchesPush(mailboxEight, { kind: "mail", mailboxId: 7 }, 3), false);
  client.clear();
});

test("changed push invalidation refetches only the connected user's active triage queries", async () => {
  clearRpcQueries();
  let currentReads = 0;
  let otherReads = 0;
  const current = new QueryObserver(queryClient, { queryKey: rpcQueryKey(3, "mail.triage.status"), queryFn: async () => ++currentReads, meta: { topics: ["mail_triage"] } });
  const other = new QueryObserver(queryClient, { queryKey: rpcQueryKey(4, "mail.triage.status"), queryFn: async () => ++otherReads, meta: { topics: ["mail_triage"] } });
  const offCurrent = current.subscribe(() => undefined);
  const offOther = other.subscribe(() => undefined);
  await Promise.all([current.refetch(), other.refetch()]);
  invalidatePush({ kind: "changed", topic: "mail_triage" }, 3);
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(currentReads, 2);
  assert.equal(otherReads, 1);
  offCurrent(); offOther(); clearRpcQueries();
});

test("authoritative RPC invalidation stays scoped to the current user", async () => {
  const client = freshClient();
  let currentUserReads = 0;
  let otherUserReads = 0;
  const current = new QueryObserver(client, { queryKey: rpcQueryKey(3, "mail.triage.status"), queryFn: async () => { currentUserReads++; return { enabled: true }; } });
  const other = new QueryObserver(client, { queryKey: rpcQueryKey(4, "mail.triage.status"), queryFn: async () => { otherUserReads++; return { enabled: true }; } });
  const offCurrent = current.subscribe(() => undefined);
  const offOther = other.subscribe(() => undefined);
  await Promise.all([current.refetch(), other.refetch()]);
  await invalidateRpcState(3, client);
  assert.equal(currentUserReads, 2);
  assert.equal(otherUserReads, 1);
  offCurrent(); offOther(); client.clear();
});

test("the real SSE transport re-fetches authorized RPC state on both reconnect and reset", async () => {
  clearRpcQueries();
  const previousWindow = globalThis.window;
  const previousEventSource = globalThis.EventSource;
  const previousFetch = globalThis.fetch;
  class FakeEventSource {
    static current: FakeEventSource | undefined;
    readonly url: string;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) { this.url = url; FakeEventSource.current = this; }
    close() {}
  }
  Object.assign(globalThis, { window: globalThis, EventSource: FakeEventSource });
  const backend = await import("./backend.ts");
  const triageClient = await import("../features/mail/mail-triage-client.ts");
  let reads = 0;
  let otherUserReads = 0;
  let unrelatedReads = 0;
  const wireMethods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    wireMethods.push(request.method);
    const result = request.method === "mail.cases.link"
      ? { caseId: "00000000-0000-4000-8000-000000000001" }
      : { enabled: true };
    return new Response(JSON.stringify({ kind: "res", id: request.id, ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const unboundStatusKey = rpcQueryKey(31, "mail.triage.status");
  queryClient.setQueryData(unboundStatusKey, { enabled: true });
  triageClient.invalidateTriageViews();
  await tick(); await tick();
  assert.equal(queryClient.getQueryState(unboundStatusKey)?.isInvalidated, false, "exported helper is a no-op without a bound transport user");
  backend.startBackendTransport(31, true, true);
  assert.equal(FakeEventSource.current?.url, "/api/events");
  const observer = new QueryObserver(queryClient, { queryKey: unboundStatusKey, queryFn: async () => { reads++; return await backend.call("mail.triage.status"); } });
  const otherUser = new QueryObserver(queryClient, { queryKey: rpcQueryKey(32, "mail.triage.status"), queryFn: async () => { otherUserReads++; return { enabled: true }; } });
  const unrelated = new QueryObserver(queryClient, { queryKey: rpcQueryKey(31, "accounts.list"), queryFn: async () => { unrelatedReads++; return []; } });
  const unsubscribe = observer.subscribe(() => undefined);
  const unsubscribeOther = otherUser.subscribe(() => undefined);
  const unsubscribeUnrelated = unrelated.subscribe(() => undefined);
  try {
    await Promise.all([observer.refetch(), otherUser.refetch(), unrelated.refetch()]);
    assert.deepEqual(wireMethods, ["mail.triage.status"], "initial active read traverses the real backend.call RPC path");
    wireMethods.length = 0;
    FakeEventSource.current?.onopen?.();
    await tick(); await tick();
    assert.equal(reads, 2, "reconnect refetches persisted state");
    assert.deepEqual(wireMethods, ["mail.triage.status"], "reconnect reaches only the expected persisted-state read RPC");
    wireMethods.length = 0;
    FakeEventSource.current?.onmessage?.({ data: JSON.stringify({ seq: 9, reset: true }) } as MessageEvent<string>);
    await tick(); await tick();
    assert.equal(reads, 3, "reset refetches persisted state");
    assert.deepEqual(wireMethods, ["mail.triage.status"], "reset reaches only the expected persisted-state read RPC");
    const beforeChanged = { reads, otherUserReads, unrelatedReads };
    FakeEventSource.current?.onmessage?.({ data: JSON.stringify({ seq: 10, message: { kind: "changed", topic: "mail_triage" } }) } as MessageEvent<string>);
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(reads, beforeChanged.reads + 1, "changed event refreshes the connected user's triage query");
    assert.equal(otherUserReads, beforeChanged.otherUserReads, "changed event does not cross users");
    assert.equal(unrelatedReads, beforeChanged.unrelatedReads, "changed event stays within triage views");
    const beforeHelper = { reads, otherUserReads, unrelatedReads };
    triageClient.invalidateTriageViews();
    await tick(); await tick();
    assert.equal(reads, beforeHelper.reads + 1, "exported helper refreshes the connected user's triage query");
    assert.equal(otherUserReads, beforeHelper.otherUserReads, "exported helper does not cross users");
    assert.equal(unrelatedReads, beforeHelper.unrelatedReads, "exported helper stays within triage views");
    const unrelatedReadsBeforeWrite = unrelatedReads;
    wireMethods.length = 0;
    await backend.call("mail.cases.link", { requestId: "00000000-0000-4000-8000-000000000002" });
    await tick(); await tick();
    assert.equal(reads, beforeHelper.reads + 2, "successful triage write refreshes triage views");
    assert.equal(otherUserReads, 1, "write invalidation does not cross users");
    assert.equal(unrelatedReads, unrelatedReadsBeforeWrite, "write invalidation does not broaden to unrelated RPCs");
    assert.deepEqual(wireMethods, ["mail.cases.link", "mail.triage.status"], "explicit write is followed only by its expected triage read refetch");
  } finally {
    unsubscribe(); unsubscribeOther(); unsubscribeUnrelated();
    backend.stopBackendTransport(true, true);
    Object.assign(globalThis, { window: previousWindow, EventSource: previousEventSource, fetch: previousFetch });
    clearRpcQueries();
  }
});
