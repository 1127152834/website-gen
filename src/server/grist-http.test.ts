import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gristClient } from "../backend/grist.ts";
import { createApp, type WorkspaceLike, type WorkspaceManagerLike } from "./http.ts";
import { GristTokenStore } from "./grist-tokens.ts";

test("/api/mcp is Bearer-only, supports stateless initialize/tools/list and isolates tool calls", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "website-gen-grist-http-"));
  const manager: WorkspaceManagerLike = {
    open(id) { return workspace(id); }, get() { return undefined; }, async close() {}, async closeAll() {},
  };
  const requests: number[] = [];
  function workspace(id: number): WorkspaceLike {
    return {
      handlers: {}, subscribe: () => () => {}, async close() {},
      gristClient: () => gristClient({ baseUrl: "https://8.8.8.8", apiKey: `owner-key-${id}`, fetch: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer owner-key-${id}`);
        requests.push(id);
        return Response.json({ user: { id, name: `owner-${id}`, email: `owner-${id}@example.com` } });
      } }),
    };
  }
  const app = await createApp({ dataDir, workspaceManager: manager, env: { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin password" }, logger: { log() {}, warn() {}, error() {} } });
  try {
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}`;
    const request = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    const login = await request("/api/login", { username: "admin", password: "admin password" }, { "X-Requested-With": "website-gen" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    await request("/api/password", { old: "admin password", new: "changed password" }, { Cookie: cookie, "X-Requested-With": "website-gen" });
    const alice = await app.admin.addUser({ username: "alice", password: "initial pass", now: 0 });
    app.admin.db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(alice.id);
    const store = new GristTokenStore(app.admin);
    const { token } = store.generate(alice.id, 1);
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
    assert.equal((await request("/api/mcp", initialize)).status, 401);
    assert.equal((await request("/api/mcp", initialize, { Cookie: cookie, "X-Requested-With": "website-gen" })).status, 401, "a valid cookie cannot authenticate MCP");
    assert.equal((await request("/api/mcp", initialize, { Authorization: "Bearer invalid" })).status, 401);
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream" };
    const initialized = await request("/api/mcp", initialize, headers);
    assert.equal(initialized.status, 200);
    assert.equal((await initialized.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name, "website-gen-grist");
    assert.equal(requests.length, 0, "initialize does not call Grist");
    const listed = await request("/api/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers);
    assert.equal(listed.status, 200);
    const tools = (await listed.json() as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    assert.deepEqual(tools.sort(), ["grist_help", "grist_get_user_profile", "grist_list_orgs", "grist_list_workspaces", "grist_list_docs", "grist_get_doc_info", "grist_get_tables", "grist_get_table_columns", "grist_list_records", "grist_query_document", "grist_list_snapshots", "grist_list_attachments", "grist_get_pages", "grist_get_attachment_url", "grist_add_records", "grist_update_records", "grist_remove_records", "grist_create_doc", "grist_create_table", "grist_add_table_column", "grist_update_table_column", "grist_rename_table", "grist_remove_table", "grist_remove_table_column"].sort());
    const called = await request("/api/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "grist_get_user_profile", arguments: {} } }, headers);
    const result = await called.json() as { result: { content: { text: string }[]; isError?: boolean } };
    assert.equal(result.result.isError, undefined);
    assert.match(result.result.content[0].text, new RegExp(`owner-${alice.id}`));
    assert.deepEqual(requests, [alice.id]);
    assert.equal((await fetch(`${base}/api/mcp`, { headers })).status, 405);
    store.revoke(alice.id);
    assert.equal((await request("/api/mcp", initialize, headers)).status, 401);
    const replacement = store.generate(alice.id, 3);
    app.admin.setDisabled(alice.id, true, app.admin.findUserByUsername("admin")!.id);
    assert.equal((await request("/api/mcp", initialize, { ...headers, Authorization: `Bearer ${replacement.token}` })).status, 401);

    // Token RPCs use the authenticated identity, ignoring any caller-supplied user ID.
    const generated = await request("/api/rpc", { method: "grist.mcpToken.generate", params: { userId: alice.id } }, { Cookie: cookie, "X-Requested-With": "website-gen" });
    const issued = await generated.json() as { ok: boolean; result: { token: string } };
    assert.equal(issued.ok, true);
    assert.equal(store.authenticate(issued.result.token, Date.now())?.id, app.admin.findUserByUsername("admin")!.id);
    const status = await request("/api/rpc", { method: "grist.mcpToken.status" }, { Cookie: cookie, "X-Requested-With": "website-gen" });
    assert.ok(!JSON.stringify(await status.json()).includes(issued.result.token));
    await request("/api/rpc", { method: "grist.mcpToken.revoke" }, { Cookie: cookie, "X-Requested-With": "website-gen" });
    assert.equal(store.authenticate(issued.result.token, Date.now()), undefined);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
