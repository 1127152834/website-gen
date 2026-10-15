import assert from "node:assert/strict";
import test from "node:test";
import { apiRequest, invalidateApiRequests } from "./auth.ts";

test("web mutations carry the requested-with CSRF marker", async () => {
  const originalFetch = globalThis.fetch;
  let received: RequestInit | undefined;
  globalThis.fetch = (async (_input, init) => {
    received = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await apiRequest("/api/example", { method: "POST", body: "{}" });
    const headers = new Headers(received?.headers);
    assert.equal(headers.get("X-Requested-With"), "website-gen");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(received?.credentials, "same-origin");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an in-flight response cannot write through after the login identity changes", async () => {
  const originalFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
  try {
    const request = apiRequest("/api/admin/users");
    invalidateApiRequests();
    finish(new Response(JSON.stringify({ users: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await assert.rejects(request, /登录状态已变化/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
