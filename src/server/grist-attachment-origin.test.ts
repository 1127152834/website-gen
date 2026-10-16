import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GristClient } from "../backend/grist.ts";
import { GristTokenStore } from "./grist-tokens.ts";
import { createApp, type WorkspaceLike } from "./http.ts";

for (const trustProxy of [false, true]) {
  test(`MCP attachment URL uses Host and ${trustProxy ? "trusts" : "ignores"} forwarded protocol`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "grist-origin-test-"));
    const workspace: WorkspaceLike = {
      handlers: {}, subscribe: () => () => {}, async close() {},
      gristClient: () => ({} as GristClient),
    };
    const app = await createApp({ dataDir, masterKey: Buffer.alloc(32, 2), clock: () => 10_000,
      workspaceManager: { open: () => workspace, get: () => workspace, async close() {}, async closeAll() {} },
      env: { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "fixture password", ...(trustProxy ? { TRUST_PROXY: "1" } : {}) },
      logger: { log() {}, warn() {}, error() {} },
    });
    try {
      const user = app.admin.findUserByUsername("admin")!;
      app.admin.db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(user.id);
      const { token } = new GristTokenStore(app.admin).generate(user.id, 10_000);
      await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
      const address = app.server.address();
      assert.ok(address && typeof address !== "string");
      const host = `127.0.0.1:${address.port}`;
      const response = await fetch(`http://${host}/api/mcp`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          Accept: "application/json, text/event-stream", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "untrusted.invalid" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "grist_get_attachment_url", arguments: { docId: "doc", attachmentId: 12 },
        } }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
      assert.equal(body.result.isError, undefined);
      const link = JSON.parse(body.result.content[0]!.text) as { url: string; expiresAt: number };
      const signed = new URL(link.url);
      assert.equal(signed.origin, `${trustProxy ? "https" : "http"}://${host}`);
      assert.equal(signed.pathname, "/api/grist/attachment/signed");
      assert.equal(link.expiresAt, 610_000);
      assert.equal(signed.searchParams.get("docId"), "doc");
      assert.equal(signed.searchParams.get("id"), "12");
      assert.ok(!link.url.includes(token));
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
