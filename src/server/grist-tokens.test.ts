import assert from "node:assert/strict";
import { test } from "node:test";
import { openAdminStore } from "./admin-db.ts";
import { tokenHash } from "./auth.ts";
import { GristTokenStore } from "./grist-tokens.ts";

test("Grist MCP tokens use 32 random bytes, store only SHA256, rotate and revoke per user", async () => {
  const admin = openAdminStore(":memory:");
  try {
    const alice = await admin.addUser({ username: "alice", password: "initial pass", now: 0 });
    const bob = await admin.addUser({ username: "bob", password: "initial pass", now: 0 });
    admin.db.exec("UPDATE users SET must_change_password = 0");
    const store = new GristTokenStore(admin);
    assert.deepEqual(store.status(alice.id), { createdAt: null, lastUsedAt: null });
    const first = store.generate(alice.id, 10);
    assert.equal(Buffer.from(first.token, "base64url").length, 32);
    const row = admin.db.prepare("SELECT * FROM grist_mcp_tokens").get()!;
    assert.equal(row.token_hash, tokenHash(first.token));
    assert.ok(!JSON.stringify(row).includes(first.token));
    assert.equal(store.authenticate("wrong", 11), undefined);
    assert.equal(store.authenticate(first.token, 12)?.id, alice.id);
    assert.deepEqual(store.status(alice.id), { createdAt: 10, lastUsedAt: 12 });
    const second = store.generate(alice.id, 20);
    const bobToken = store.generate(bob.id, 21);
    assert.notEqual(second.token, first.token);
    assert.equal(store.authenticate(first.token, 22), undefined);
    assert.equal(store.authenticate(second.token, 22)?.id, alice.id);
    store.revoke(alice.id);
    assert.equal(store.authenticate(second.token, 23), undefined);
    assert.equal(store.authenticate(bobToken.token, 23)?.id, bob.id);
  } finally { admin.close(); }
});

test("disabled users immediately lose Grist MCP access and cannot generate tokens", async () => {
  const admin = openAdminStore(":memory:");
  try {
    const actor = await admin.addUser({ username: "admin", password: "initial pass", role: "admin", now: 0 });
    const alice = await admin.addUser({ username: "alice", password: "initial pass", now: 0 });
    admin.db.exec("UPDATE users SET must_change_password = 0");
    const store = new GristTokenStore(admin);
    const { token } = store.generate(alice.id, 10);
    admin.setDisabled(alice.id, true, actor.id);
    assert.equal(store.authenticate(token, 11), undefined);
    assert.throws(() => store.generate(alice.id, 12), /停用/);
    admin.setDisabled(alice.id, false, actor.id);
    assert.equal(store.authenticate(token, 13), undefined, "reenabling does not revive an old token");
  } finally { admin.close(); }
});

test("admin password resets revoke existing MCP credentials instead of reviving after a password change", async () => {
  const admin = openAdminStore(":memory:");
  try {
    const user = await admin.addUser({ username: "alice", password: "initial pass", now: 0 });
    admin.db.exec("UPDATE users SET must_change_password = 0");
    const store = new GristTokenStore(admin);
    const { token } = store.generate(user.id, 1);
    await admin.resetPassword(user.id, "reset password");
    admin.db.exec("UPDATE users SET must_change_password = 0");
    assert.equal(store.authenticate(token, 2), undefined);
  } finally { admin.close(); }
});
