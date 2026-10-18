import test, { before } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { z } from "zod";
import * as openState from "./mail-open-state.ts";
import { composeSendInput, createComposeOperation, quoteOriginal } from "./mail-compose-controller.ts";
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
      rolldownOptions: { external: (id) => { const path=id.replaceAll("\\","/"); if (id.startsWith(".") && !path.endsWith("/mail-body.tsx") && !path.endsWith("/mail-body.ts")) return false; return id!==entry&&(!path.includes("/features/mail/")||path.endsWith("/mail-body.tsx")||path.endsWith("/mail-body.ts")); } } },
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
  let props = { mailboxId: 1, folder: "INBOX", uid: undefined as number | undefined, sourceRef: undefined as import("../../../../shared/mail-triage-types.ts").CaseSourceReaderRef|undefined, composeHandoff: undefined as import("./mail-compose-controller.ts").ComposeHandoff|undefined, onNavigate: (_path: string) => {} };
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
    if (method === "mail.cases.sourceMessage") return { ref: params, message: detail(params.uid, false) };
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
    // Execute the real extracted pure panes; controller/dialog components remain opaque.
    const children = typeof value.type === "function" && /(Pane|Skeleton)$/.test(value.type.name)
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
    textButton(label: string) {
      const node = nodes().find((node) => node.props.onClick && [node.props.children].flat(Infinity).includes(label));
      assert.ok(node, label);
      return node;
    },
    mailBody() {
      const node = nodes().find((node) => node.type === "MailBody");
      assert.ok(node, "MailBody");
      return node;
    },
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

test("translation is opt-in and sends only the selected mailbox folder and UID", async () => {
  const h = pageHarness();
  try {
    h.overrides.set("mail.translate", () => ({ subject: "译文主题", text: "译文正文" }));
    await h.flush(); await h.navigate({ uid: 2 });
    assert.equal(h.count("mail.translate"), 0);
    h.textButton("翻译").props.onClick(); await h.flush();
    assert.equal(h.count("mail.translate"), 1);
    const request = h.requests.find((entry) => entry.method === "mail.translate")!;
    assert.deepEqual({ ...request.params }, { mailboxId: 1, folder: "INBOX", uid: 2 });
  } finally { h.dispose(); }
});

test("translation disables its button and rejects duplicate requests while loading", async () => {
  const h = pageHarness();
  try {
    const pending = deferred<{ subject: string; text: string }>();
    h.overrides.set("mail.translate", () => pending.promise);
    await h.flush(); await h.navigate({ uid: 1 });
    h.textButton("翻译").props.onClick(); await h.flush();
    const loading = h.textButton("翻译中…");
    assert.equal(loading.props.disabled, true);
    loading.props.onClick(); loading.props.onClick(); await h.flush();
    assert.equal(h.count("mail.translate"), 1);
    pending.resolve({ subject: "译文主题", text: "译文正文" }); await h.flush();
  } finally { h.dispose(); }
});

test("translation rejects two clicks before React can render its loading state", async () => {
  const h = pageHarness();
  try {
    const pending = deferred<{ subject: string; text: string }>();
    h.overrides.set("mail.translate", () => pending.promise);
    await h.flush(); await h.navigate({ uid: 1 });
    const click = h.textButton("翻译").props.onClick;
    click(); click();
    await h.flush();
    assert.equal(h.count("mail.translate"), 1);
    pending.resolve({ subject: "译文主题", text: "译文正文" }); await h.flush();
  } finally { h.dispose(); }
});

test("successful translation renders its subject and body", async () => {
  const h = pageHarness();
  try {
    h.overrides.set("mail.translate", () => ({ subject: "中文主题", text: "中文正文" }));
    await h.flush(); await h.navigate({ uid: 1 });
    h.textButton("翻译").props.onClick(); await h.flush();
    assert.ok(h.nodes().some((node) => node.type === "h2" && node.props.children === "中文主题"));
    assert.equal(h.mailBody().props.text, "中文正文");
  } finally { h.dispose(); }
});

test("translation toggles between current original and translation without another RPC", async () => {
  const h = pageHarness();
  try {
    h.overrides.set("mail.translate", () => ({ subject: "中文主题", text: "中文正文" }));
    await h.flush(); await h.navigate({ uid: 1 });
    h.textButton("翻译").props.onClick(); await h.flush();
    const calls = h.count("mail.translate");
    h.textButton("查看原文").props.onClick(); await h.flush();
    assert.ok(h.nodes().some((node) => node.type === "h2" && node.props.children === "Subject 1"));
    assert.equal(h.mailBody().props.text, "Body 1");
    assert.equal(h.count("mail.translate"), calls);
    h.textButton("查看译文").props.onClick(); await h.flush();
    assert.ok(h.nodes().some((node) => node.type === "h2" && node.props.children === "中文主题"));
    assert.equal(h.mailBody().props.text, "中文正文");
    assert.equal(h.count("mail.translate"), calls);
  } finally { h.dispose(); }
});

for (const action of [
  { label: "回复", mode: "reply" },
  { label: "转发", mode: "forward" },
] as const) {
  test(`${action.label} composition keeps the original message while translation is visible`, async () => {
    const h = pageHarness();
    try {
      const attachment = { partId: "2.1", name: "original.pdf", type: "application/pdf", size: 4096 };
      h.overrides.set("mail.message", () => ({
        ...detail(1), subject: "Original subject", text: "Original body", attachments: [attachment], hasAttachments: true,
      }));
      h.overrides.set("mail.translate", () => ({ subject: "译文主题", text: "译文正文" }));
      await h.flush(); await h.navigate({ uid: 1 });
      h.textButton("翻译").props.onClick(); await h.flush();
      assert.equal(h.mailBody().props.text, "译文正文");
      h.textButton(action.label).props.onClick(); await h.flush();
      const dialog = h.nodes().find((node) => typeof node.type === "function" && node.type.name === "ComposeDialog");
      assert.ok(dialog?.props.state, "ComposeDialog state");
      assert.equal(dialog.props.state.mode, action.mode);
      assert.equal(dialog.props.state.mailbox.id, 1);
      assert.equal(dialog.props.state.original.subject, "Original subject");
      assert.equal(dialog.props.state.original.text, "Original body");
      assert.equal(dialog.props.state.original.folder, "INBOX");
      assert.equal(dialog.props.state.original.uid, 1);
      assert.deepEqual({ ...dialog.props.state.original.attachments[0] }, attachment);
    } finally { h.dispose(); }
  });
}

test("failed translation shows an error and can be retried", async () => {
  const h = pageHarness();
  try {
    const first = deferred<{ subject: string; text: string }>();
    h.overrides.set("mail.translate", () => first.promise);
    await h.flush(); await h.navigate({ uid: 1 });
    h.textButton("翻译").props.onClick(); await h.flush();
    first.reject(new Error("翻译服务暂不可用")); await h.flush();
    assert.ok(h.nodes().some((node) => node.props.role === "alert" && node.props.children === "翻译服务暂不可用"));
    assert.equal(h.textButton("翻译").props.disabled, false);
    h.overrides.set("mail.translate", () => ({ subject: "重试成功", text: "重试正文" }));
    h.textButton("翻译").props.onClick(); await h.flush();
    assert.equal(h.count("mail.translate"), 2);
    assert.equal(h.nodes().some((node) => node.props.role === "alert" && node.props.children === "翻译服务暂不可用"), false);
    assert.equal(h.mailBody().props.text, "重试正文");
  } finally { h.dispose(); }
});

for (const scenario of [
  { name: "UID", update: { uid: 2 } },
  { name: "folder", update: { folder: "Sent", uid: 1 } },
  { name: "mailbox", update: { mailboxId: 2, folder: "INBOX", uid: 1 } },
] as const) {
  test(`late translation success is ignored after switching ${scenario.name}`, async () => {
    const h = pageHarness();
    try {
      const pending = deferred<{ subject: string; text: string }>();
      h.overrides.set("mail.list", () => [mailbox(1), mailbox(2)]);
      h.overrides.set("mail.message", ({ mailboxId, folder, uid }) => ({
        ...detail(uid), folder, subject: `Current ${mailboxId}/${folder}/${uid}`, text: `Current body ${mailboxId}/${folder}/${uid}`,
      }));
      h.overrides.set("mail.translate", () => pending.promise);
      await h.flush(); await h.navigate({ uid: 1 });
      h.textButton("翻译").props.onClick(); await h.flush();
      await h.navigate(scenario.update);
      pending.resolve({ subject: "过期译文主题", text: "过期译文正文" }); await h.flush();
      assert.equal(h.nodes().some((node) => node.type === "h2" && node.props.children === "过期译文主题"), false);
      assert.notEqual(h.mailBody().props.text, "过期译文正文");
    } finally { h.dispose(); }
  });

  test(`late translation error is ignored after switching ${scenario.name}`, async () => {
    const h = pageHarness();
    try {
      const pending = deferred<{ subject: string; text: string }>();
      h.overrides.set("mail.list", () => [mailbox(1), mailbox(2)]);
      h.overrides.set("mail.message", ({ mailboxId, folder, uid }) => ({
        ...detail(uid), folder, subject: `Current ${mailboxId}/${folder}/${uid}`, text: `Current body ${mailboxId}/${folder}/${uid}`,
      }));
      h.overrides.set("mail.translate", () => pending.promise);
      await h.flush(); await h.navigate({ uid: 1 });
      h.textButton("翻译").props.onClick(); await h.flush();
      await h.navigate(scenario.update);
      pending.reject(new Error("过期翻译错误")); await h.flush();
      assert.equal(h.nodes().some((node) => node.props.role === "alert" && node.props.children === "过期翻译错误"), false);
    } finally { h.dispose(); }
  });
}

test("an A to B to A route cycle cannot accept A's stale translation", async () => {
  const h = pageHarness();
  try {
    const pending = deferred<{ subject: string; text: string }>();
    h.overrides.set("mail.translate", () => pending.promise);
    await h.flush(); await h.navigate({ uid: 1 });
    h.textButton("翻译").props.onClick(); await h.flush();
    await h.navigate({ uid: 2 }); await h.navigate({ uid: 1 });
    pending.resolve({ subject: "过期 A 主题", text: "过期 A 正文" }); await h.flush();
    assert.ok(h.nodes().some((node) => node.type === "h2" && node.props.children === "Subject 1"));
    assert.equal(h.mailBody().props.text, "Body 1");
    h.textButton("翻译");
  } finally { h.dispose(); }
});

test("an A to B to A route cycle cannot show A's stale translation error", async () => {
  const h = pageHarness();
  try {
    const pending = deferred<{ subject: string; text: string }>();
    h.overrides.set("mail.translate", () => pending.promise);
    await h.flush(); await h.navigate({ uid: 1 });
    h.textButton("翻译").props.onClick(); await h.flush();
    await h.navigate({ uid: 2 }); await h.navigate({ uid: 1 });
    pending.reject(new Error("过期 A 错误")); await h.flush();
    assert.equal(h.nodes().some((node) => node.props.role === "alert" && node.props.children === "过期 A 错误"), false);
    assert.equal(h.mailBody().props.text, "Body 1");
  } finally { h.dispose(); }
});

test("an A to B to A render cycle cannot expose stale translation before passive effects", async () => {
  const h = pageHarness();
  try {
    const pending = deferred<{ subject: string; text: string }>();
    h.overrides.set("mail.translate", () => pending.promise);
    await h.flush(); await h.navigate({ uid: 1 });
    h.textButton("翻译").props.onClick(); await h.flush();
    h.renderBeforeEffects({ uid: 2 });
    h.renderBeforeEffects({ uid: 1 });
    pending.resolve({ subject: "瞬时过期主题", text: "瞬时过期正文" });
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    const start = h.frames.length;
    await h.flush();
    for (let index = start; index < h.frames.length; index++) {
      assert.equal(h.frame(index).some((node) => node.type === "h2" && node.props.children === "瞬时过期主题"), false);
      assert.equal(h.frame(index).some((node) => node.type === "MailBody" && node.props.text === "瞬时过期正文"), false);
    }
  } finally { h.dispose(); }
});

test("a detail refresh invalidates a translation request for the same mailbox folder and UID", async () => {
  const h = pageHarness();
  try {
    const pending = deferred<{ subject: string; text: string }>();
    h.overrides.set("mail.message", () => ({ ...detail(1), subject: "原主题一", text: "原正文一" }));
    h.overrides.set("mail.translate", () => pending.promise);
    await h.flush(); await h.navigate({ uid: 1 });
    h.textButton("翻译").props.onClick(); await h.flush();
    h.overrides.set("mail.message", () => ({ ...detail(1), subject: "原主题二", text: "原正文二" }));
    await h.push({ type: "changed", mailboxId: 1, folder: "INBOX" }); await h.advance(150);
    assert.ok(h.nodes().some((node) => node.type === "h2" && node.props.children === "原主题二"), JSON.stringify(h.nodes().filter((node) => node.type === "h2").map((node) => node.props.children)));
    assert.equal(h.mailBody().props.text, "原正文二");
    pending.resolve({ subject: "旧译文主题", text: "旧译文正文" }); await h.flush();
    assert.ok(h.nodes().some((node) => node.type === "h2" && node.props.children === "原主题二"), JSON.stringify(h.nodes().filter((node) => node.type === "h2").map((node) => node.props.children)));
    assert.equal(h.mailBody().props.text, "原正文二");
    h.textButton("翻译");
  } finally { h.dispose(); }
});

test("a detail refresh ignores a pending translation error for the same mailbox folder and UID", async () => {
  const h = pageHarness();
  try {
    const pending = deferred<{ subject: string; text: string }>();
    h.overrides.set("mail.message", () => ({ ...detail(1), subject: "原主题一", text: "原正文一" }));
    h.overrides.set("mail.translate", () => pending.promise);
    await h.flush(); await h.navigate({ uid: 1 });
    h.textButton("翻译").props.onClick(); await h.flush();
    h.overrides.set("mail.message", () => ({ ...detail(1), subject: "原主题二", text: "原正文二" }));
    await h.push({ type: "changed", mailboxId: 1, folder: "INBOX" }); await h.advance(150);
    pending.reject(new Error("旧正文的翻译错误")); await h.flush();
    assert.equal(h.nodes().some((node) => node.props.role === "alert" && node.props.children === "旧正文的翻译错误"), false);
    assert.ok(h.nodes().some((node) => node.type === "h2" && node.props.children === "原主题二"));
    assert.equal(h.mailBody().props.text, "原正文二");
    h.textButton("翻译");
  } finally { h.dispose(); }
});

test("a detail refresh discards an existing translation for the same mailbox folder and UID", async () => {
  const h = pageHarness();
  try {
    h.overrides.set("mail.message", () => ({ ...detail(1), subject: "原主题一", text: "原正文一" }));
    h.overrides.set("mail.translate", () => ({ subject: "旧译文主题", text: "旧译文正文" }));
    await h.flush(); await h.navigate({ uid: 1 });
    h.textButton("翻译").props.onClick(); await h.flush();
    assert.equal(h.mailBody().props.text, "旧译文正文");
    h.overrides.set("mail.message", () => ({ ...detail(1), subject: "原主题二", text: "原正文二" }));
    await h.push({ type: "changed", mailboxId: 1, folder: "INBOX" }); await h.advance(150);
    assert.ok(h.nodes().some((node) => node.type === "h2" && node.props.children === "原主题二"));
    assert.equal(h.mailBody().props.text, "原正文二");
    h.textButton("翻译");
  } finally { h.dispose(); }
});

test("translated content stays plain text even when it resembles active HTML", async () => {
  const h = pageHarness();
  try {
    const plain = '<img src="https://tracker.invalid/pixel">\n<script>alert(1)</script>\n[jump](javascript:alert(2))';
    h.overrides.set("mail.translate", () => ({ subject: "<b>纯文本主题</b>", text: plain }));
    await h.flush(); await h.navigate({ uid: 1 });
    h.textButton("翻译").props.onClick(); await h.flush();
    assert.equal(h.mailBody().props.text, plain);
    assert.ok(h.nodes().some((node) => node.type === "h2" && node.props.children === "<b>纯文本主题</b>"));
    assert.equal(h.nodes().some((node) => node.props.dangerouslySetInnerHTML), false);
    assert.equal(h.nodes().some((node) => node.type === "img" || node.type === "script" || node.type === "a"), false);
  } finally { h.dispose(); }
});

test("R20 source-bound preview uses the dedicated reader and performs zero Seen/translate/trash/download actions", async () => {
  const h=pageHarness(),ref={caseId:"00000000-0000-4000-8000-000000000010",sourceId:"00000000-0000-4000-8000-000000000011",sourceVersion:1,mailboxId:1,folder:"INBOX",uidValidity:"14",uid:1};
  try{
    await h.flush();const folders=h.count("mail.folders"),messages=h.count("mail.messages");await h.navigate({uid:1,sourceRef:ref});
    assert.equal(h.count("mail.cases.sourceMessage"),1);
    assert.equal(h.count("mail.message"),0);
    assert.equal(h.count("mail.folders"),folders);
    assert.equal(h.count("mail.messages"),messages);
    assert.equal(h.count("mail.seen"),0);
    assert.equal(h.nodes().some(node=>node.props.children==="翻译"||node.props["aria-label"]==="标为已读"||node.props["aria-label"]==="标为未读"||node.props["aria-label"]==="移到废纸篓"),false);
    assert.equal(h.nodes().some(node=>node.type==="a"&&node.props.download),false);
    assert.equal(h.mailBody().props.text,"Body 1");
  }finally{h.dispose();}
});

test("R20 stale source-binding response is ignored instead of falling back to the legacy triple", async()=>{
  const h=pageHarness(),ref={caseId:"00000000-0000-4000-8000-000000000010",sourceId:"00000000-0000-4000-8000-000000000011",sourceVersion:1,mailboxId:1,folder:"INBOX",uidValidity:"14",uid:1};
  try{
    h.overrides.set("mail.cases.sourceMessage",()=>({ref:{...ref,sourceVersion:2},message:{...detail(1),text:"WRONG REUSED UID BODY"}}));
    await h.flush();await h.navigate({uid:1,sourceRef:ref});
    assert.equal(h.count("mail.message"),0);
    assert.equal(h.nodes().some(node=>node.type==="MailBody"&&node.props.text==="WRONG REUSED UID BODY"),false);
  }finally{h.dispose();}
});

test("B43 selected reply handoff opens the same compose controller on the original receiving mailbox",async()=>{
  const h=pageHarness(),ref={caseId:"00000000-0000-4000-8000-000000000010",sourceId:"00000000-0000-4000-8000-000000000011",sourceVersion:3,mailboxId:1,folder:"INBOX",uidValidity:"14",uid:1},taskId="00000000-0000-4000-8000-000000000012";
  try{await h.flush();await h.navigate({uid:1,sourceRef:ref,composeHandoff:{caseId:ref.caseId,selectedTaskIds:[taskId],readerRef:ref}});const dialog=h.nodes().find(node=>typeof node.type==="function"&&node.type.name==="ComposeDialog");assert.equal(dialog?.props.state.mailbox.id,1);assert.equal(dialog?.props.state.original.text,"Body 1");assert.deepEqual({...dialog?.props.state.handoff.readerRef},ref);assert.deepEqual(Array.from(dialog?.props.state.handoff.selectedTaskIds),[taskId]);
    const payload=composeSendInput(dialog!.props.state,{to:"sender@example.test",cc:"",bcc:"",subject:"Re: Subject 1",text:"reply"},[],"00000000-0000-4000-8000-000000000099");assert.equal(payload.mailboxId,1);assert.equal(payload.caseId,ref.caseId);assert.deepEqual(payload.selectedTaskIds,[taskId]);assert.deepEqual(payload.replyTo?.readerRef,ref);assert.equal(quoteOriginal(dialog!.props.state.original).includes("Body 1"),true);
  }finally{h.dispose();}
});

test("B22 linked reply draft invokes the actual MailPage close handler and never calls mail.send",async()=>{
  const h=pageHarness(),ref={caseId:"00000000-0000-4000-8000-000000000020",sourceId:"00000000-0000-4000-8000-000000000021",sourceVersion:1,mailboxId:1,folder:"INBOX",uidValidity:"14",uid:1},taskId="00000000-0000-4000-8000-000000000022";
  try{
    await h.flush();
    await h.navigate({uid:1,sourceRef:ref,composeHandoff:{caseId:ref.caseId,selectedTaskIds:[taskId],readerRef:ref}});
    const opened=h.nodes().find(node=>typeof node.type==="function"&&node.type.name==="ComposeDialog");
    assert.ok(opened?.props.state,"linked ComposeDialog opened");
    assert.deepEqual(Array.from(opened.props.state.handoff.selectedTaskIds),[taskId]);
    opened.props.onClose();
    await h.flush();
    const closed=h.nodes().find(node=>typeof node.type==="function"&&node.type.name==="ComposeDialog");
    assert.equal(closed?.props.state,null,"MailPage cleared compose state through the dialog onClose callback");
    assert.equal(h.count("mail.send"),0);
  }finally{h.dispose();}
});

test("Task15 Fix1 compose operation uses one idempotency key and locks unknown or pending sends",()=>{
  const unknown=createComposeOperation("00000000-0000-4000-8000-000000000090");
  assert.equal(unknown.tryStart(),true);assert.equal(unknown.tryStart(),false);
  assert.match(unknown.fail("connection reset").message??"",/结果未知.*防重复 SMTP/);
  const pending=createComposeOperation("00000000-0000-4000-8000-000000000091");assert.equal(pending.tryStart(),true);
  const review=pending.settle({messageId:"m",appended:false,sendReceiptId:"00000000-0000-4000-8000-000000000092",reviewState:"pending",reviewCode:"sent_append_unconfirmed"});
  assert.deepEqual([review.terminal,review.close],[true,false]);assert.match(review.message??"",/收据.*不要重复发送/);assert.equal(pending.tryStart(),false);
  const cleared=createComposeOperation("00000000-0000-4000-8000-000000000093");assert.equal(cleared.tryStart(),true);
  assert.deepEqual(cleared.settle({messageId:"m",appended:true,sendReceiptId:"00000000-0000-4000-8000-000000000094",reviewState:"cleared",reviewCode:null}),{terminal:true,close:true,message:null});
  assert.match(compiled,/compose-to-error/);assert.match(compiled,/compose-text-error/);assert.match(compiled,/aria-invalid/);
});
