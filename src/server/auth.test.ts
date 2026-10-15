import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashPassword, tokenHash, verifyPassword } from "./auth.ts";
import { openAdminStore } from "./admin-db.ts";
import { deriveUserKey, loadMasterKey } from "./keys.ts";
import { acquireServerLock } from "./lock.ts";

test("passwords are scrypt hashed and verified without storing plaintext", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assert.match(encoded, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!encoded.includes("correct horse"));
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("wrong password", encoded), false);
  assert.equal(await verifyPassword("x", "broken"), false);
  await assert.rejects(hashPassword("x".repeat(1025)), /1024/);
});

test("master keys persist and derive different stable keys per user", () => {
  const dir = mkdtempSync(join(tmpdir(), "website-gen-key-"));
  try {
    const first = loadMasterKey(dir, "");
    const second = loadMasterKey(dir, "");
    assert.deepEqual(first, second);
    assert.deepEqual(deriveUserKey(first, 1), deriveUserKey(first, 1));
    assert.notDeepEqual(deriveUserKey(first, 1), deriveUserKey(first, 2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("server lock is exclusive and can be acquired again after release", () => {
  const dir = mkdtempSync(join(tmpdir(), "website-gen-lock-"));
  try {
    const release = acquireServerLock(dir);
    assert.throws(() => acquireServerLock(dir), /数据目录已被进程/);
    release();
    acquireServerLock(dir)();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("first run bootstraps one admin and prints a generated password only once", async () => {
  const store = openAdminStore(":memory:");
  const messages: string[] = [];
  const first = await store.bootstrap({ now: 100, printPassword: (message) => messages.push(message) });
  assert.equal(first?.user.username, "admin");
  assert.equal(first?.user.role, "admin");
  assert.equal(first?.user.mustChangePassword, true);
  assert.equal(messages.length, 1);
  assert.deepEqual(await store.authenticate("admin", first!.generatedPassword!), first?.user);
  assert.equal(await store.bootstrap({ now: 200, printPassword: (message) => messages.push(message) }), null);
  assert.equal(messages.length, 1);
  store.close();
});

test("five failed logins limit the same IP and username for ten minutes", () => {
  const store = openAdminStore(":memory:");
  for (let index = 0; index < 5; index++) store.recordLogin("127.0.0.1", "admin", false, index * 1000);
  assert.equal(store.isLoginLimited("127.0.0.1", "admin", 5_000), true);
  assert.equal(store.isLoginLimited("127.0.0.2", "admin", 5_000), false);
  assert.equal(store.isLoginLimited("127.0.0.1", "other", 5_000), false);
  assert.equal(store.isLoginLimited("127.0.0.1", "admin", 10 * 60_000 + 4_001), false);
  store.close();
});

test("the ten-minute login lock lasts from the fifth failure, not the first", () => {
  const store = openAdminStore(":memory:");
  try {
    for (let index = 0; index < 5; index++) store.recordLogin("ip", "alice", false, index * 2 * 60_000);
    assert.equal(store.isLoginLimited("ip", "alice", 11 * 60_000), true);
    assert.equal(store.isLoginLimited("ip", "alice", 18 * 60_000), false);
  } finally { store.close(); }
});

test("one IP cannot reserve an unbounded hash queue by varying usernames", () => {
  const store = openAdminStore(":memory:");
  for (let index = 0; index < 50; index++) assert.equal(store.beginLogin("127.0.0.1", `name-${index}`, 0), true);
  assert.equal(store.beginLogin("127.0.0.1", "name-50", 0), false);
  assert.equal(store.beginLogin("127.0.0.2", "name-50", 0), true);
  assert.equal(store.beginLogin("127.0.0.1", "name-51", 10 * 60_000), true);
  store.close();
});

test("sessions expire after seven idle days and slide when used", async () => {
  const store = openAdminStore(":memory:");
  const user = await store.addUser({ username: "alice", password: "initial pass", now: 0 });
  store.createSession(user.id, "one", 0);
  const day = 24 * 60 * 60_000;
  assert.ok(store.session("one", 6 * day));
  assert.ok(store.session("one", 12 * day), "the request at day six extends the session");
  assert.equal(store.session("one", 20 * day), undefined);
  store.createSession(user.id, "sse", 0);
  assert.ok(store.session("sse", 6 * day, false));
  assert.equal(store.session("sse", 8 * day, false), undefined, "SSE heartbeats do not slide expiry");
  store.close();
});

test("authentication rejects a password reset or disable that happens while scrypt is running", async () => {
  const store = openAdminStore(":memory:");
  const alice = await store.addUser({ username: "alice", password: "initial pass", now: 0 });
  const replacement = await hashPassword("replacement pass");
  const resetRace = store.authenticate("alice", "initial pass");
  store.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(replacement, alice.id);
  assert.equal(await resetRace, undefined);

  const bob = await store.addUser({ username: "bob", password: "initial pass", now: 0 });
  const disableRace = store.authenticate("bob", "initial pass");
  store.db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(bob.id);
  assert.equal(await disableRace, undefined);
  store.close();
});

test("login issues a session only for the exact password version verified by scrypt", async () => {
  const store = openAdminStore(":memory:");
  const alice = await store.addUser({ username: "alice", password: "initial pass", now: 0 });
  const replacement = await hashPassword("replacement pass");
  const resetRace = store.login("alice", "initial pass", "stale-reset", 1);
  store.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(replacement, alice.id);
  assert.equal(await resetRace, undefined);
  assert.equal(store.session("stale-reset", 1, false), undefined);

  const bob = await store.addUser({ username: "bob", password: "initial pass", now: 0 });
  const disableRace = store.login("bob", "initial pass", "stale-disabled", 1);
  store.db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(bob.id);
  assert.equal(await disableRace, undefined);
  assert.equal(store.session("stale-disabled", 1, false), undefined);

  const loggedIn = await store.login("alice", "replacement pass", "current", 2);
  assert.equal(loggedIn?.id, alice.id);
  assert.equal(store.session("current", 2, false)?.user.id, alice.id);
  store.close();
});

test("password change loses safely to a concurrent reset or revoked current session", async () => {
  const store = openAdminStore(":memory:");
  const user = await store.addUser({ username: "alice", password: "initial pass", now: 0 });
  store.createSession(user.id, "current", 0);
  const replacement = await hashPassword("admin reset pass");
  const resetRace = store.changePassword(user.id, "initial pass", "my new password", tokenHash("current"));
  store.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(replacement, user.id);
  await assert.rejects(resetRace, /重新登录/);
  assert.ok(await store.authenticate("alice", "admin reset pass"));

  store.createSession(user.id, "current-2", 1);
  const logoutRace = store.changePassword(user.id, "admin reset pass", "another password", tokenHash("current-2"));
  store.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash("current-2"));
  await assert.rejects(logoutRace, /会话已变更/);
  assert.ok(await store.authenticate("alice", "admin reset pass"));
  store.close();
});

test("admin reset logs out every session and self or last-admin disable is refused", async () => {
  const store = openAdminStore(":memory:");
  const admin = await store.addUser({ username: "admin", password: "initial pass", role: "admin", now: 0 });
  const user = await store.addUser({ username: "user", password: "initial pass", now: 0 });
  store.createSession(user.id, "one", 0);
  store.createSession(user.id, "two", 0);
  await store.resetPassword(user.id, "reset password");
  assert.equal(store.session("one", 1), undefined);
  assert.equal(store.session("two", 1), undefined);
  assert.equal(store.getUser(user.id)?.mustChangePassword, true);
  assert.equal(await store.authenticate("user", "initial pass"), undefined);
  assert.ok(await store.authenticate("user", "reset password"));
  assert.throws(() => store.setDisabled(admin.id, true, admin.id), /自己/);
  assert.throws(() => store.setDisabled(admin.id, true, user.id), /最后一个管理员/);
  store.close();
});

test("changing a password preserves only the current session", async () => {
  const store = openAdminStore(":memory:");
  try {
    const user = await store.addUser({ username: "alice", password: "initial pass", now: 0 });
    store.createSession(user.id, "current", 0);
    store.createSession(user.id, "other", 0);
    await store.changePassword(user.id, "initial pass", "different password", tokenHash("current"));
    assert.equal(store.session("current", 1)?.user.mustChangePassword, false);
    assert.equal(store.session("other", 1), undefined);
    assert.equal(await store.authenticate("alice", "initial pass"), undefined);
  } finally { store.close(); }
});
