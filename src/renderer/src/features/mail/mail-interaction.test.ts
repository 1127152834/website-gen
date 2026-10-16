import test, { before } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { z } from "zod";
import * as openState from "./mail-open-state.ts";
import type { MailEvent, MailMessageDetail, MailMessageSummary } from "../../../../shared/mail-types.ts";

// Execute the real page's hooks and event handlers with controlled RPC/timers.
// This deliberately does not claim browser layout or React DOM acceptance.
type Node = { type: string | ((props: any) => unknown); props: Record<string, any> };
const entry = fileURLToPath(new URL("./mail-page.tsx", import.meta.url));
let compiled = "";
before(async () => {
  const bundle = await build({
    configFile: false, envDir: false, logLevel: "silent", oxc: { jsx: { runtime: "automatic" } },
    build: { write: false, minify: false, lib: { entry, formats: ["cjs"] },
      rolldownOptions: { external: (id) => id !== entry && !id.replaceAll("\\", "/").endsWith("/features/mail/mail-page.tsx") } },
  });
  const result = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!("output" in result)) throw new Error("Expected an in-memory page bundle");
  compiled = result.output.find((output) => output.type === "chunk")!.code;
});
const item = (uid: number, seen = true): MailMessageSummary => ({
  uid, folder: "INBOX", from: `Sender ${uid}`, to: ["a@example.test"], cc: [], subject: `Subject ${uid}`,
  date: 1_700_000_000_000, snippet: `Preview ${uid}`, seen, hasAttachments: false, size: 100,
});
const detail = (uid: number, seen = true): MailMessageDetail => ({ ...item(uid, seen), text: `Body ${uid}`, attachments: [] });
const mailbox = (id = 1) => ({ id, accountId: 1, accountLabel: "Test", orderId: "o", domain: "example.test", address: `${id}@example.test`, credentialSaved: true, defaultPasswordStatus: "unconfigured", monitoring: false, unreadCount: 1, lastSyncAt: null, lastError: null });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pageHarness(initialItems = [item(1), item(2)]) {
  const slots: any[] = [], effects: (() => void)[] = [], frames: unknown[] = [];
  const timers = new Map<number, { at: number; run: () => void }>();
  const listeners = new Set<(event: MailEvent) => void>();
  const queries = new Set<{ method: string; params: any; refresh: () => Promise<unknown> }>();
  const querySnapshots = new Map<string, { data: any; error: Error | null; refreshing: boolean }>();
  const requests: { method: string; params: any }[] = [], errors: string[] = [];
  const overrides = new Map<string, (params: any) => unknown>();
  let index = 0, dirty = true, tree: unknown, now = 0, timerId = 0;
  let mailTimer: number | null = null;
  let mailBatch: MailEvent[] = [];
  let props = { mailboxId: 1, folder: "INBOX", uid: undefined as number | undefined, onNavigate: (_path: string) => {} };
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
  const hooks = {
    useState(initial: any) {
      const id = index++;
      if (!(id in slots)) slots[id] = typeof initial === "function" ? initial() : initial;
      return [slots[id], (update: any) => {
        const value = typeof update === "function" ? update(slots[id]) : update;
        if (!Object.is(value, slots[id])) { slots[id] = value; dirty = true; }
      }];
    },
    useRef(initial: any) { const id = index++; return slots[id] ??= { current: initial }; },
    useMemo(make: () => unknown, deps?: unknown[]) {
      const id = index++;
      if (!slots[id] || !same(slots[id].deps, deps)) slots[id] = { deps, value: make() };
      return slots[id].value;
    },
    useCallback(fn: unknown, deps?: unknown[]) { return hooks.useMemo(() => fn, deps); },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const id = index++;
      if (!slots[id] || !same(slots[id].deps, deps)) {
        const previous = slots[id];
        slots[id] = { deps, cleanup: undefined };
        effects.push(() => { previous?.cleanup?.(); slots[id].cleanup = effect(); });
      }
    },
  };
  const defaults = (method: string, params: any) => {
    if (method === "mail.list") return [mailbox()];
    if (method === "mail.folders") return ["INBOX", "Sent"].map((path) => ({ name: path, path, total: 2, unread: 0 }));
    if (method === "mail.messages") return { items: initialItems.map((entry) => ({ ...entry, folder: params.folder })), total: 61, page: params.page, pageSize: 30 };
    if (method === "mail.message") return detail(params.uid);
    if (method === "mail.seen") return { ok: true };
    throw new Error(`Unexpected RPC ${method}`);
  };
  const backend = {
    call(method: string, params: any) { requests.push({ method, params }); return Promise.resolve().then(() => overrides.has(method) ? overrides.get(method)!(params) : defaults(method, params)); },
    useRpcData(method: string, params?: any) {
      const key = JSON.stringify(params ?? null);
      const queryKey = `${method}\u0000${key}`;
      const [, setRevision] = hooks.useState(0);
      const snapshot = querySnapshots.get(queryKey) ?? { data: undefined, error: null, refreshing: false };
      if (!querySnapshots.has(queryKey)) querySnapshots.set(queryKey, snapshot);
      const setSnapshot = (update: any) => {
        const current = querySnapshots.get(queryKey)!;
        querySnapshots.set(queryKey, typeof update === "function" ? update(current) : update);
        setRevision((value: number) => value + 1);
      };
      const refresh = hooks.useCallback(async () => {
        if (params === null) return undefined;
        setSnapshot((current: any) => ({ ...current, error: null, refreshing: true }));
        try {
          const data = await backend.call(method, params);
          setSnapshot({ data, error: null, refreshing: false });
          return data;
        } catch (error) {
          setSnapshot((current: any) => ({ ...current, error, refreshing: false }));
          throw error;
        }
      }, [method, key]);
      hooks.useEffect(() => {
        if (params === null) return;
        let active = true;
        const query = { method, params, refresh: () => active ? refresh() : Promise.resolve(undefined) };
        queries.add(query);
        void refresh().catch(() => undefined);
        return () => { active = false; queries.delete(query); };
      }, [method, key, refresh]);
      return { ...snapshot, loading: params !== null && snapshot.data === undefined && snapshot.error === null, refresh, invalidate() {} };
    },
    invalidateRpcData() {},
    onConnect(fn: () => void) { fn(); return () => {}; },
    onChanged() { return () => {}; },
    onMail(fn: (event: MailEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const setTimeout = (run: () => void, delay = 0) => { timers.set(++timerId, { at: now + delay, run }); return timerId; };
  const clearTimeout = (id: number) => timers.delete(id);
  const exports: any = {};
  const components = new Proxy({}, { get: (_target, name) => String(name) });
  new Script(compiled, { filename: "mail-page.tsx" }).runInNewContext({
    exports, setTimeout, clearTimeout, window: { setTimeout, clearTimeout }, console,
    require(name: string) {
      if (name === "react") return hooks;
      if (name === "zod") return { z };
      if (name === "react/jsx-runtime") return { jsx: (type: Node["type"], props: Node["props"]) => ({ type, props }), jsxs: (type: Node["type"], props: Node["props"]) => ({ type, props }), Fragment: "Fragment" };
      if (name.includes("/lib/backend")) return backend;
      if (name.includes("mail-open-state")) return openState;
      if (name.includes("/lib/utils")) return { cn: (...args: unknown[]) => args.filter(Boolean).join(" ") };
      if (name.includes("/components/feedback")) return { useConfirm: () => async () => true, toast: (text: string) => errors.push(text) };
      return components;
    },
  });
  const walk = (value: any): Node[] => {
    if (Array.isArray(value)) return value.flatMap((entry) => walk(entry));
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    // These are pure, hook-free page children; execute them to inspect skeleton output.
    const children = typeof value.type === "function" && /Skeleton$/.test(value.type.name)
      ? value.type(value.props) : value.props.children;
    return [value, ...walk(children)];
  };
  const nodes = () => walk(tree);
  const flush = async () => {
    for (let turn = 0; turn < 30; turn++) {
      if (dirty) { dirty = false; index = 0; tree = exports.MailPage(props); frames.push(tree); }
      for (const effect of effects.splice(0)) effect();
      await Promise.resolve();
    }
    assert.equal(dirty, false, "page effects settled");
  };
  return {
    requests, errors, overrides, nodes, flush, frames,
    frame(index: number) { return walk(frames[index]); },
    async navigate(update: Partial<typeof props>) { props = { ...props, ...update }; dirty = true; await flush(); },
    renderBeforeEffects(update: Partial<typeof props>) {
      props = { ...props, ...update }; dirty = false; index = 0;
      tree = exports.MailPage(props); frames.push(tree);
    },
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
      await flush();
    },
    async push(event: MailEvent) {
      for (const fn of listeners) fn(event);
      mailBatch.push(event);
      if (mailTimer == null) mailTimer = setTimeout(() => {
        mailTimer = null;
        const batch = mailBatch;
        mailBatch = [];
        for (const query of queries) {
          if (query.method === "mail.list"
            || batch.some((item) => query.params?.mailboxId === item.mailboxId
              && (query.method === "mail.folders" || !item.folder || query.params?.folder === item.folder))) void query.refresh().catch(() => undefined);
        }
      }, 150);
      await flush();
    },
    count(method: string) { return requests.filter((request) => request.method === method).length; },
    rows() { return nodes().filter((node) => typeof node.type === "function" && node.type.name === "MessageRow"); },
    button(label: string) { const node = nodes().find((node) => node.props["aria-label"] === label); assert.ok(node, label); return node; },
    search() { const node = nodes().find((node) => node.props.placeholder === "搜索发件人或主题"); assert.ok(node); return node; },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test("folder switch retains tabs while showing six busy skeleton rows", async () => {
  const h = pageHarness();
  try {
    await h.flush();
    h.overrides.set("mail.messages", () => new Promise(() => {}));
    await h.navigate({ folder: "Sent" });
    const sent = h.nodes().find((node) => [node.props.children].flat().includes("Sent") && node.props.variant === "secondary");
    assert.ok(sent, "selected Sent tab remains mounted");
    assert.equal(h.rows().length, 0);
    assert.equal(h.nodes().filter((node) => node.props["data-testid"] === "mail-row-skeleton").length, 6);
    assert.ok(h.nodes().some((node) => node.props["aria-busy"] === true));
  } finally { h.dispose(); }
});

test("search is debounced and refresh keeps rows, pagination does not blank them", async () => {
  const h = pageHarness();
  try {
    await h.flush();
    const before = h.count("mail.messages");
    h.overrides.set("mail.messages", () => new Promise(() => {}));
    h.search().props.onChange({ target: { value: "a" } }); await h.flush();
    await h.advance(100);
    h.search().props.onChange({ target: { value: "ab" } }); await h.flush();
    assert.equal(h.search().props.value, "ab");
    await h.advance(249);
    assert.equal(h.count("mail.messages"), before);
    await h.advance(1);
    assert.equal(h.count("mail.messages"), before + 1);
    assert.equal(h.requests.at(-1)?.params.query, "ab");
    assert.equal(h.rows().length, 2);
    assert.ok(h.nodes().some((node) => node.props["aria-busy"] === true && node.props.className?.includes("opacity-60")));
    h.button("下一页").props.onClick(); await h.flush();
    assert.equal(h.rows().length, 2);
    await h.navigate({ folder: "Sent" });
    assert.equal(h.search().props.value, "");
    const lastList = h.requests.filter((entry) => entry.method === "mail.messages").at(-1)!;
    assert.equal(lastList.params.query, undefined);
    assert.equal(lastList.params.page, 1);
  } finally { h.dispose(); }
});

test("push batches counts but reloads messages only for the active mailbox and folder", async () => {
  const h = pageHarness();
  try {
    await h.flush();
    const lists = h.count("mail.messages"), boxes = h.count("mail.list"), folders = h.count("mail.folders");
    await h.push({ type: "changed", mailboxId: 1, folder: "Sent" });
    await h.push({ type: "changed", mailboxId: 2, folder: "INBOX" });
    await h.advance(150);
    assert.equal(h.count("mail.messages"), lists);
    assert.equal(h.count("mail.list"), boxes + 1);
    assert.equal(h.count("mail.folders"), folders + 1);
    await h.push({ type: "changed", mailboxId: 1, folder: "INBOX" });
    await h.push({ type: "new", mailboxId: 1, folder: "INBOX" });
    await h.advance(150);
    assert.equal(h.count("mail.messages"), lists + 1);
  } finally { h.dispose(); }
});

test("reader immediately shows the selected summary, never the previous body", async () => {
  const h = pageHarness();
  try {
    await h.flush(); await h.navigate({ uid: 1 });
    assert.ok(h.nodes().some((node) => node.props.text === "Body 1"));
    h.overrides.set("mail.message", () => new Promise(() => {}));
    await h.navigate({ uid: 2 });
    assert.ok(h.nodes().some((node) => node.type === "h2" && node.props.children === "Subject 2"));
    assert.equal(h.nodes().some((node) => node.props.text === "Body 1"), false);
    assert.ok(h.nodes().some((node) => node.props["data-testid"] === "mail-detail-skeleton"));
  } finally { h.dispose(); }
});

test("auto and manual seen updates are immediate and failed writes roll back with a toast", async () => {
  const h = pageHarness([item(1, false), item(2)]);
  try {
    const seen = deferred<unknown>();
    h.overrides.set("mail.message", () => detail(1, false));
    h.overrides.set("mail.seen", () => seen.promise);
    await h.flush(); await h.navigate({ uid: 1 });
    assert.equal(h.rows()[0].props.item.seen, true);
    h.button("标为未读");
    seen.reject(new Error("STORE failed")); await h.flush();
    assert.equal(h.rows()[0].props.item.seen, false);
    assert.ok(h.errors.includes("STORE failed"));
    const manual = deferred<unknown>();
    h.overrides.set("mail.seen", () => manual.promise);
    const boxes = h.count("mail.list"), folders = h.count("mail.folders");
    void h.button("标为已读").props.onClick(); await h.flush();
    assert.equal(h.rows()[0].props.item.seen, true);
    manual.resolve({ ok: true }); await h.flush();
    assert.equal(h.count("mail.list"), boxes);
    assert.equal(h.count("mail.folders"), folders);
  } finally { h.dispose(); }
});

test("old folder/list/detail replies cannot overwrite the current selection", async () => {
  const h = pageHarness();
  try {
    await h.flush();
    const oldList = deferred<unknown>(), oldDetail = deferred<unknown>();
    h.overrides.set("mail.messages", ({ folder }) => folder === "INBOX" ? oldList.promise
      : { items: [{ ...item(2), folder: "Sent" }], total: 1, page: 1, pageSize: 30 });
    h.overrides.set("mail.message", ({ uid }) => uid === 1 ? oldDetail.promise : detail(uid));
    await h.push({ type: "changed", mailboxId: 1, folder: "INBOX" }); await h.advance(150);
    await h.navigate({ uid: 1 });
    await h.navigate({ folder: "Sent", uid: undefined });
    oldList.resolve({ items: [item(1)], total: 1, page: 1, pageSize: 30 });
    oldDetail.resolve(detail(1)); await h.flush();
    assert.deepEqual(h.rows().map((row) => [row.props.item.uid, row.props.item.folder]), [[2, "Sent"]]);
    assert.equal(h.nodes().some((node) => node.props.text === "Body 1"), false);
  } finally { h.dispose(); }
});

test("seen failure after navigation rolls back only the original row, not another reader", async () => {
  const h = pageHarness([item(1, false), item(2)]);
  try {
    const pending = deferred<unknown>();
    h.overrides.set("mail.message", ({ uid }) => detail(uid, uid !== 1));
    h.overrides.set("mail.seen", () => pending.promise);
    await h.flush(); await h.navigate({ uid: 1 }); await h.navigate({ uid: 2 });
    pending.reject(new Error("delayed failure")); await h.flush();
    assert.equal(h.rows()[0].props.item.seen, false);
    assert.ok(h.nodes().some((node) => node.props.text === "Body 2"));
    h.button("标为未读");
    assert.ok(h.errors.includes("delayed failure"));
  } finally { h.dispose(); }
});

test("two failed opposite seen writes restore the confirmed state", async () => {
  const h = pageHarness([item(1, false)]);
  try {
    const writes = [deferred<unknown>(), deferred<unknown>()];
    let next = 0;
    h.overrides.set("mail.message", () => detail(1, false));
    h.overrides.set("mail.seen", () => writes[next++].promise);
    await h.flush(); await h.navigate({ uid: 1 });
    const toggle = h.button("标为未读");
    if (toggle.props.disabled) {
      writes[0].reject(new Error("first failed")); await h.flush();
    } else {
      void toggle.props.onClick(); await h.flush();
      if (h.count("mail.seen") === 1) {
        writes[0].reject(new Error("first failed")); await h.flush();
        writes[1].reject(new Error("second failed")); await h.flush();
      } else {
        writes[1].reject(new Error("second failed")); await h.flush();
        writes[0].reject(new Error("first failed")); await h.flush();
      }
    }
    assert.equal(h.rows()[0].props.item.seen, false);
    h.button("标为已读");
  } finally { h.dispose(); }
});

test("cross-mailbox equal UIDs never render the prior body or rows, even before effects", async () => {
  const h = pageHarness();
  try {
    h.overrides.set("mail.list", () => [mailbox(1), mailbox(2)]);
    await h.flush(); await h.navigate({ uid: 1 });
    h.overrides.set("mail.message", () => new Promise(() => {}));
    h.overrides.set("mail.messages", () => new Promise(() => {}));
    const start = h.frames.length;
    await h.navigate({ mailboxId: 2, uid: 1 });
    for (let index = start; index < h.frames.length; index++) {
      assert.equal(h.frame(index).some((node) => node.props.text === "Body 1"), false);
      assert.equal(h.frame(index).some((node) => typeof node.type === "function" && node.type.name === "MessageRow"), false);
      if (index === start) assert.equal(h.frame(index).some((node) => node.props.onClick && [node.props.children].flat().includes("Sent")), false);
    }
  } finally { h.dispose(); }
});

test("leaving a pending detail prevents its late auto-seen write", async () => {
  const h = pageHarness([item(1, false)]);
  try {
    const pending = deferred<unknown>();
    h.overrides.set("mail.message", () => pending.promise);
    await h.flush(); await h.navigate({ uid: 1 }); await h.navigate({ uid: undefined });
    pending.resolve(detail(1, false)); await h.flush();
    assert.equal(h.count("mail.seen"), 0);
    assert.equal(h.rows()[0].props.item.seen, false);
  } finally { h.dispose(); }
});

test("push refresh overlays pending optimistic seen instead of reverting it", async () => {
  const h = pageHarness([item(1, false)]);
  try {
    const pending = deferred<unknown>();
    h.overrides.set("mail.message", () => detail(1, false));
    h.overrides.set("mail.seen", () => pending.promise);
    await h.flush(); await h.navigate({ uid: 1 });
    await h.push({ type: "changed", mailboxId: 1, folder: "INBOX" }); await h.advance(150);
    assert.equal(h.rows()[0].props.item.seen, true);
    pending.reject(new Error("failed after refresh")); await h.flush();
    assert.equal(h.rows()[0].props.item.seen, false);
  } finally { h.dispose(); }
});

test("typing from a later page does not request the old query before debounce", async () => {
  const h = pageHarness();
  try {
    await h.flush(); h.button("下一页").props.onClick(); await h.flush();
    const before = h.count("mail.messages");
    h.search().props.onChange({ target: { value: "new query" } }); await h.flush();
    await h.advance(249);
    assert.equal(h.count("mail.messages"), before);
    await h.advance(1);
    assert.equal(h.count("mail.messages"), before + 1);
    const request = h.requests.filter((entry) => entry.method === "mail.messages").at(-1)!;
    assert.equal(request.params.query, "new query");
    assert.equal(request.params.page, 1);
  } finally { h.dispose(); }
});

test("navigation during a push batch preserves counts without refreshing the wrong folder", async () => {
  const h = pageHarness();
  try {
    await h.flush();
    const boxes = h.count("mail.list"), folders = h.count("mail.folders");
    await h.push({ type: "changed", mailboxId: 1, folder: "INBOX" });
    await h.advance(100); await h.navigate({ folder: "Sent" });
    const lists = h.count("mail.messages");
    await h.advance(50);
    assert.equal(h.count("mail.list"), boxes + 1);
    assert.equal(h.count("mail.folders"), folders + 1);
    assert.equal(h.count("mail.messages"), lists);
  } finally { h.dispose(); }
});

test("old detail resolving between route render and passive effects cannot auto-mark it", async () => {
  const h = pageHarness([item(1, false), item(2)]);
  try {
    const pending = deferred<unknown>();
    h.overrides.set("mail.message", ({ uid }) => uid === 1 ? pending.promise : detail(2));
    await h.flush(); await h.navigate({ uid: 1 });
    h.renderBeforeEffects({ uid: 2 });
    pending.resolve(detail(1, false));
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    assert.equal(h.count("mail.seen"), 0);
    await h.flush();
  } finally { h.dispose(); }
});

test("old detail failure between route render and effects cannot show an error on the new reader", async () => {
  const h = pageHarness();
  try {
    const pending = deferred<unknown>();
    h.overrides.set("mail.message", ({ uid }) => uid === 1 ? pending.promise : detail(2));
    await h.flush(); await h.navigate({ uid: 1 });
    h.renderBeforeEffects({ uid: 2 });
    pending.reject(new Error("old reader failure"));
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    await h.flush();
    assert.equal(h.nodes().some((node) => node.props.role === "alert" && node.props.children === "old reader failure"), false);
  } finally { h.dispose(); }
});
