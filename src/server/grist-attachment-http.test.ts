import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { GristClient } from "../backend/grist.ts";
import { tokenHash } from "./auth.ts";
import { createSignedGristAttachmentUrl, deriveGristAttachmentSigningKey } from "./grist-attachment-signing.ts";
import { GristTokenStore } from "./grist-tokens.ts";
import { createApp, type WorkspaceLike, type WorkspaceManagerLike } from "./http.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "website-gen-grist-attachment-"));
  const masterKey = Buffer.alloc(32, 9);
  const workspaces = new Map<number, WorkspaceLike>();
  const manager: WorkspaceManagerLike = {
    open(userId) {
      const workspace: WorkspaceLike = {
        handlers: {}, subscribe: () => () => {}, async close() {},
        gristClient: () => ({ downloadAttachment: async (_docId: string, id: number) => {
          const type = id === 2 ? "image/svg+xml" : "application/pdf";
          const body = id === 2 ? "<svg/>" : "%PDF";
          return new Response(body, { headers: {
            "Content-Type": type, "Content-Length": String(Buffer.byteLength(body)),
            "Content-Disposition": `attachment; filename*=UTF-8''${id === 2 ? "unsafe.svg" : "report%20one.pdf"}`,
          } });
        } } as GristClient),
      };
      workspaces.set(userId, workspace); return workspace;
    },
    get(userId) { return workspaces.get(userId); }, async close(userId) { workspaces.delete(userId); }, async closeAll() { workspaces.clear(); },
  };
  let now = 10_000;
  const app = await createApp({ dataDir, workspaceManager: manager, masterKey, clock: () => now,
    env: { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin password" }, logger: { log() {}, warn() {}, error() {} } });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const post = (path: string, body: unknown, cookie?: string) => fetch(`${base}${path}`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Requested-With": "website-gen", ...(cookie ? { Cookie: cookie } : {}),
  }, body: JSON.stringify(body) });
  const login = await post("/api/login", { username: "admin", password: "admin password" });
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  await post("/api/password", { old: "admin password", new: "changed password" }, cookie);
  return { app, base, cookie, masterKey, setNow(value: number) { now = value; } };
}

test("Grist Cookie 附件代理要求登录、校验参数并强制安全响应头", async () => {
  const { base, cookie } = await setup();
  assert.equal((await fetch(`${base}/api/grist/attachment?docId=d&id=1`)).status, 401);
  assert.equal((await fetch(`${base}/api/grist/attachment?docId=d&id=bad`, { headers: { Cookie: cookie } })).status, 400);
  const pdf = await fetch(`${base}/api/grist/attachment?docId=d&id=1`, { headers: { Cookie: cookie } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition")!, /^inline;.*report%20one\.pdf/);
  assert.equal(pdf.headers.get("x-content-type-options"), "nosniff");
  assert.equal(pdf.headers.get("cache-control"), "private, max-age=86400");
  assert.equal(await pdf.text(), "%PDF");
  const svg = await fetch(`${base}/api/grist/attachment?docId=d&id=2`, { headers: { Cookie: cookie } });
  assert.match(svg.headers.get("content-disposition")!, /^attachment;/);
  assert.equal(svg.headers.get("content-security-policy"), "sandbox");
});

test("签名附件链接在有效期内可用，篡改、过期、撤销和停用均拒绝", async () => {
  const { app, base, masterKey, setNow } = await setup();
  const admin = app.admin.findUserByUsername("admin")!;
  const store = new GristTokenStore(app.admin);
  const issued = store.generate(admin.id, 10_000);
  const sign = (userId: number, hash: string) => createSignedGristAttachmentUrl({ origin: base,
    key: deriveGristAttachmentSigningKey(masterKey), tokenHash: hash,
    payload: { userId, docId: "d", attachmentId: 1, expiresAt: 610_000 } });
  const signed = sign(admin.id, tokenHash(issued.token));
  assert.equal((await fetch(signed)).status, 200);
  const tampered = new URL(signed); tampered.searchParams.set("id", "2");
  assert.equal((await fetch(tampered)).status, 401);
  setNow(610_000);
  assert.equal((await fetch(signed)).status, 401);
  setNow(10_000); store.revoke(admin.id);
  assert.equal((await fetch(signed)).status, 401);

  const alice = await app.admin.addUser({ username: "alice", password: "alice password", now: 10_000 });
  app.admin.db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(alice.id);
  const aliceToken = store.generate(alice.id, 10_000);
  const aliceSigned = sign(alice.id, tokenHash(aliceToken.token));
  app.admin.setDisabled(alice.id, true, admin.id);
  assert.equal((await fetch(aliceSigned)).status, 401);
});
