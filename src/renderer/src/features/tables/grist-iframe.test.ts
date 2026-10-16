import { test } from "node:test";
import assert from "node:assert/strict";
import { gristLoginUrl, openGristLogin, watchGristPopupClosed, type GristPopupHandle } from "./grist-iframe.ts";

test("Grist login URL keeps a configured path and uses a relative home next path", () => {
  assert.equal(gristLoginUrl("https://grist.example/"), "https://grist.example/login?next=%2F");
  assert.equal(gristLoginUrl("https://grist.example/o/team/#ignored"), "https://grist.example/o/team/login?next=%2F");
});

test("Grist login keeps a popup handle without noopener and navigates it after severing opener", () => {
  const navigations: string[] = [];
  const calls: [string, string, string | undefined][] = [];
  const popup: GristPopupHandle = {
    closed: false,
    opener: {},
    location: { replace: (url) => navigations.push(url) },
  };

  const result = openGristLogin("https://grist.example/login", (url, target, features) => {
    calls.push([url, target, features]);
    return popup;
  });

  assert.equal(result, popup);
  assert.deepEqual(calls, [["about:blank", "_blank", "popup,width=1100,height=800"]]);
  assert.equal(popup.opener, null);
  assert.deepEqual(navigations, ["https://grist.example/login"]);
});

test("blocked popup falls back to exactly one noopener tab without mistaking its null result for another block", () => {
  const calls: [string, string, string | undefined][] = [];
  const result = openGristLogin("https://grist.example/login", (url, target, features) => {
    calls.push([url, target, features]);
    return null;
  });

  assert.equal(result, null);
  assert.deepEqual(calls, [
    ["about:blank", "_blank", "popup,width=1100,height=800"],
    ["https://grist.example/login", "_blank", "noopener,noreferrer"],
  ]);
});

test("failed popup navigation closes the blank popup and safely falls back once", () => {
  const calls: [string, string, string | undefined][] = [];
  let closed = 0;
  const popup: GristPopupHandle = {
    closed: false,
    opener: {},
    location: { replace: () => { throw new Error("navigation denied"); } },
    close: () => { closed++; },
  };
  const result = openGristLogin("https://grist.example/login", (url, target, features) => {
    calls.push([url, target, features]);
    return calls.length === 1 ? popup : null;
  });

  assert.equal(result, null);
  assert.equal(closed, 1);
  assert.deepEqual(calls, [
    ["about:blank", "_blank", "popup,width=1100,height=800"],
    ["https://grist.example/login", "_blank", "noopener,noreferrer"],
  ]);
});

test("popup close polling refreshes exactly once and clears its timer", () => {
  const popup = { closed: false };
  const callbacks = new Map<number, () => void>();
  const cleared: number[] = [];
  let nextTimer = 0;
  let refreshed = 0;
  const timers = {
    setInterval(callback: () => void, milliseconds: number) {
      assert.equal(milliseconds, 500);
      callbacks.set(++nextTimer, callback);
      return nextTimer;
    },
    clearInterval(timer: number) { cleared.push(timer); callbacks.delete(timer); },
  };

  watchGristPopupClosed(popup, () => { refreshed++; }, timers);
  callbacks.get(1)?.();
  assert.equal(refreshed, 0);
  popup.closed = true;
  callbacks.get(1)?.();
  assert.equal(refreshed, 1);
  assert.deepEqual(cleared, [1]);
  assert.equal(callbacks.size, 0);
});

test("repeated login and component disposal stop prior popup polling", () => {
  const callbacks = new Map<number, () => void>();
  const cleared: number[] = [];
  let nextTimer = 0;
  let refreshed = 0;
  const timers = {
    setInterval(callback: () => void) { callbacks.set(++nextTimer, callback); return nextTimer; },
    clearInterval(timer: number) { cleared.push(timer); callbacks.delete(timer); },
  };
  const first = { closed: false };
  const second = { closed: false };

  let dispose = watchGristPopupClosed(first, () => { refreshed++; }, timers);
  dispose(); // A repeated login replaces the previous watcher.
  dispose = watchGristPopupClosed(second, () => { refreshed++; }, timers);
  first.closed = true;
  callbacks.get(1)?.();
  assert.equal(refreshed, 0);
  dispose(); // Component unmount or base URL change.
  second.closed = true;
  callbacks.get(2)?.();
  assert.equal(refreshed, 0);
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(callbacks.size, 0);
});
