import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute } from "./routes.ts";
test("console routes support bookmarkable site tabs and reject malformed detail URLs", () => {
  assert.deepEqual(parseRoute("/"), { page: "overview" });
  assert.deepEqual(parseRoute("/sites/12/chat"), { page: "sites", id: 12, tab: "chat" });
  assert.deepEqual(parseRoute("/batches/4"), { page: "batches", id: 4 });
  assert.deepEqual(parseRoute("/mail/7/Sent%20Messages/42"), { page: "mail", id: 7, folder: "Sent Messages", uid: 42 });
  assert.deepEqual(parseRoute("/mail"), { page: "mail" });
  assert.deepEqual(parseRoute("/tables"), { page: "tables" });
  assert.deepEqual(parseRoute("/tables/"), { page: "tables" });
  for (const url of ["/sites/0/chat", "/accounts/2", "/batches/2/chat", "/sites/2/delete", "/mail/0/INBOX", "/mail/2/INBOX/0", "/tables/2", "/tables/2/overview", "/tables/other", "/other"]) assert.equal(parseRoute(url).page, "not-found");
});
