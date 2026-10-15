import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./rpc.ts";

const handlers = {
  add: (p: unknown) => (p as { a: number; b: number }).a + (p as { a: number; b: number }).b,
  boom: () => {
    throw new Error("kaput");
  },
};

test("calls the named handler and returns its result", async () => {
  const res = await handleRequest(handlers, { kind: "req", id: 1, method: "add", params: { a: 1, b: 2 } });
  assert.deepEqual(res, { kind: "res", id: 1, ok: true, result: 3 });
});

test("an unknown method becomes an error response instead of a crash", async () => {
  const res = await handleRequest(handlers, { kind: "req", id: 2, method: "nope" });
  assert.deepEqual(res, { kind: "res", id: 2, ok: false, error: "unknown method: nope" });
});

test("a throwing handler becomes an error response", async () => {
  const res = await handleRequest(handlers, { kind: "req", id: 3, method: "boom" });
  assert.deepEqual(res, { kind: "res", id: 3, ok: false, error: "kaput" });
});
