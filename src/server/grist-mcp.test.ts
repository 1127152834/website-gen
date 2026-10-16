import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { handleGristMcp } from "./grist-mcp.ts";
import { GRIST_TOOL_NAMES } from "../backend/grist-tools.ts";

test("Grist stateless native HTTP transport initializes and lists tools independently without configuration", async () => {
  let accesses = 0;
  const server = createServer((req, res) => {
    void handleGristMcp(req, res, () => { accesses++; throw new Error("not configured"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown) => fetch(baseUrl, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
  try {
    const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.headers.get("mcp-session-id"), null);
    assert.equal((await initialized.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name, "website-gen-grist");
    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(listed.status, 200);
    const result = await listed.json() as { result: { tools: { name: string }[] } };
    assert.deepEqual(result.result.tools.map((tool) => tool.name).sort(), [...GRIST_TOOL_NAMES].sort());
    assert.equal(accesses, 0);
    const called = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "grist_list_orgs", arguments: {} } });
    assert.equal(called.status, 200);
    assert.equal((await called.json() as { result: { isError: boolean } }).result.isError, true);
    assert.equal(accesses, 1);
    assert.equal((await fetch(baseUrl)).status, 405);
    assert.equal((await fetch(baseUrl, { method: "DELETE" })).status, 405);
    const malformed = await fetch(baseUrl, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{" });
    assert.equal(malformed.status, 400);
    const oversized = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "grist_help", arguments: { padding: "x".repeat(1024 * 1024) } } });
    assert.equal(oversized.status, 413);
    assert.equal(accesses, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
