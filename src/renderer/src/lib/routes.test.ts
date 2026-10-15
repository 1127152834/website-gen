import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute } from "./routes.ts";
test("console routes support bookmarkable site tabs and reject malformed detail URLs", () => {
  assert.deepEqual(parseRoute("/"), { page: "overview" });
  assert.deepEqual(parseRoute("/sites/12/chat"), { page: "sites", id: 12, tab: "chat" });
  assert.deepEqual(parseRoute("/batches/4"), { page: "batches", id: 4 });
  for (const url of ["/sites/0/chat", "/accounts/2", "/batches/2/chat", "/sites/2/delete", "/other"]) assert.equal(parseRoute(url).page, "not-found");
});
