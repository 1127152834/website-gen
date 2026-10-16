import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { HostingerExec } from "./hostinger.ts";
import { setDefaultMailboxPassword } from "./mail.ts";
import { createMailboxService } from "./mailbox-service.ts";
import { FakeMailTransport, fakeRawMail, key, setup } from "./testing.ts";

interface RemoteMailbox {
  id: string;
  address: string;
  status: string;
}

const inventory = (boxes: RemoteMailbox[]): HostingerExec => async (operation) => {
  if (operation === "mail_orders_list") return [{ id: "order-1", domain: { name: "nordicpaws.com" }, status: "active" }];
  if (operation === "mail_mailboxes_list") return boxes;
  throw new Error(`unexpected ${operation}`);
};

const eventually = async (check: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
};

test("default password succeeds during inventory: saves default credential, enables monitoring, and indexes", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const address = "support@nordicpaws.com", password = "Default1!";
  setDefaultMailboxPassword(db, key, password);
  fake.passwords.set(address, password);
  fake.seed(address, "INBOX", [{
    uid: 1, uidValidity: "default-1", folder: "INBOX", flags: [], size: 100,
    source: fakeRawMail({ from: "sender@example.test", to: [address], subject: "indexed", text: "body" }),
  }]);
  const service = createMailboxService({
    db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }],
    transport: () => fake, push: () => {}, monitor: { pollMs: 5, backoffMs: 1 },
  });
  try {
    const [box] = await service.sync();
    assert.equal(box.credentialSaved, true);
    assert.equal(box.credentialSource, "default");
    assert.equal(box.monitoring, true);
    await eventually(() => (db.prepare("SELECT count(*) AS n FROM mail_messages WHERE mailbox_id=?").get(box.id) as { n: number }).n === 1, "default credential did not start indexing");
  } finally { await service.close(); }
});

test("rejected default is remembered, skipped on the next sync, and retried after the default changes", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const address = "support@nordicpaws.com", wrong = "WrongPwd1!", correct = "Correct1!";
  setDefaultMailboxPassword(db, key, wrong);
  fake.passwords.set(address, correct);
  const attempts: string[] = [];
  const originalVerify = fake.verify.bind(fake);
  fake.verify = async (credentials) => { attempts.push(credentials.password); await originalVerify(credentials); };
  const service = createMailboxService({
    db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }],
    transport: () => fake, push: () => {}, monitor: { pollMs: 5, backoffMs: 1 },
  });
  try {
    let [box] = await service.sync();
    assert.equal(box.credentialSaved, false);
    assert.equal(attempts.filter((value) => value === wrong).length, 1);
    const rejected = JSON.parse((db.prepare("SELECT sync_state_json FROM mailboxes WHERE id=?").get(box.id) as { sync_state_json: string }).sync_state_json) as { failedDefaultPasswordFingerprint?: string };
    assert.match(rejected.failedDefaultPasswordFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(rejected.failedDefaultPasswordFingerprint, createHash("sha256").update(wrong).digest("hex"), "fingerprint must be keyed, not a plain password hash");

    await service.sync();
    assert.equal(attempts.filter((value) => value === wrong).length, 1, "same rejected default must not be retried on routine sync");

    setDefaultMailboxPassword(db, key, correct);
    const result = await service.tryDefaultCredentials();
    assert.deepEqual(result, { succeeded: 1, failed: 0, deferred: 0 });
    [box] = service.list();
    assert.equal(box.credentialSaved, true);
    assert.equal(box.credentialSource, "default");
    assert.equal(box.monitoring, true);
    assert.ok(attempts.includes(correct));
  } finally { await service.close(); }
});

test("explicit retry ignores a remembered rejection", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const address = "support@nordicpaws.com", password = "WrongPwd1!";
  setDefaultMailboxPassword(db, key, password);
  fake.passwords.set(address, "Mailbox1!");
  let attempts = 0;
  const originalVerify = fake.verify.bind(fake);
  fake.verify = async (credentials) => { attempts++; await originalVerify(credentials); };
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }], transport: () => fake, push: () => {} });
  try {
    const [box] = await service.sync();
    assert.equal(attempts, 1);
    assert.deepEqual(await service.tryDefaultCredentials({ mailboxId: box.id }), { succeeded: 0, failed: 0, deferred: 0 });
    assert.equal(attempts, 1);
    assert.deepEqual(await service.tryDefaultCredentials({ mailboxId: box.id, retry: true }), { succeeded: 0, failed: 1, deferred: 0 });
    assert.equal(attempts, 2);
  } finally { await service.close(); }
});

test("connectivity failure stops the batch, stores no rejection, and retries on the next sync", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const password = "Default1!";
  const boxes = [
    { id: "box-1", address: "support@nordicpaws.com", status: "active" },
    { id: "box-2", address: "sales@nordicpaws.com", status: "active" },
  ];
  setDefaultMailboxPassword(db, key, password);
  for (const box of boxes) fake.passwords.set(box.address, password);
  let unavailable = true;
  const attempts: string[] = [];
  const originalVerify = fake.verify.bind(fake);
  fake.verify = async (credentials) => {
    attempts.push(credentials.address);
    if (unavailable) {
      const error = new Error("connect ECONNREFUSED 127.0.0.1") as Error & { code: string };
      error.code = "ECONNREFUSED";
      throw error;
    }
    await originalVerify(credentials);
  };
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory(boxes) }], transport: () => fake, push: () => {}, monitor: { pollMs: 5, backoffMs: 1 } });
  try {
    let result = await service.sync();
    assert.equal(attempts.length, 1, "obvious connectivity failure must stop the remaining batch");
    assert.ok(result.every((box) => !box.credentialSaved));
    assert.ok(result.every((box) => box.defaultPasswordStatus === "unavailable"), "every deferred mailbox must show unavailable, not a pending spinner");
    for (const state of db.prepare("SELECT sync_state_json FROM mailboxes ORDER BY id").all() as { sync_state_json: string | null }[]) {
      assert.equal(JSON.parse(state.sync_state_json ?? "{}").failedDefaultPasswordFingerprint, undefined);
    }

    unavailable = false;
    result = await service.sync();
    assert.ok(result.every((box) => box.credentialSaved));
    assert.ok(result.every((box) => box.credentialSource === "default"));
  } finally { await service.close(); }
});

test("a network error during explicit retry clears the old rejection so routine sync can retry", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const address = "support@nordicpaws.com", password = "Default1!";
  setDefaultMailboxPassword(db, key, password);
  let mode: "reject" | "network" | "success" = "reject", attempts = 0;
  fake.verify = async () => {
    attempts++;
    if (mode === "reject") throw new Error("IMAP authentication failed");
    if (mode === "network") {
      const error = new Error("connect ECONNREFUSED") as Error & { code: string };
      error.code = "ECONNREFUSED";
      throw error;
    }
  };
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }], transport: () => fake, push: () => {}, monitor: { pollMs: 5, backoffMs: 1 } });
  try {
    const [box] = await service.sync();
    assert.equal(box.defaultPasswordStatus, "rejected");
    mode = "network";
    assert.deepEqual(await service.tryDefaultCredentials({ mailboxId: box.id, retry: true }), { succeeded: 0, failed: 0, deferred: 1 });
    const state = JSON.parse((db.prepare("SELECT sync_state_json FROM mailboxes WHERE id=?").get(box.id) as { sync_state_json: string }).sync_state_json) as { failedDefaultPasswordFingerprint?: string };
    assert.equal(state.failedDefaultPasswordFingerprint, undefined, "transient retry error must remove the stale rejection fingerprint");
    mode = "success";
    await service.sync();
    assert.ok(attempts >= 3, "routine sync must retry after a transient explicit-retry failure");
    assert.equal(service.list()[0].credentialSource, "default");
  } finally { await service.close(); }
});

test("without a configured default password inventory performs no IMAP verification", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  let attempts = 0;
  fake.verify = async () => { attempts++; throw new Error("must not be called"); };
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address: "support@nordicpaws.com", status: "active" }]) }], transport: () => fake, push: () => {} });
  try {
    const [box] = await service.sync();
    assert.equal(attempts, 0);
    assert.equal(box.credentialSaved, false);
    assert.equal(box.defaultPasswordStatus, "unconfigured");
  } finally { await service.close(); }
});

test("default attempts are serial and spaced before trying the next mailbox", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const password = "WrongPwd1!";
  setDefaultMailboxPassword(db, key, password);
  const boxes = ["one", "two", "three"].map((name, index) => ({ id: `box-${index}`, address: `${name}@nordicpaws.com`, status: "active" }));
  const attempts: number[] = [], active: number[] = [];
  fake.verify = async () => {
    active.push(Date.now());
    assert.equal(active.length, 1, "default password attempts must be serial");
    attempts.push(Date.now());
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    active.pop();
    throw new Error("IMAP authentication failed");
  };
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory(boxes) }], transport: () => fake, push: () => {} });
  try {
    await service.sync();
    assert.equal(attempts.length, 3);
    assert.ok(attempts[1] - attempts[0] >= 180, `attempt gap was ${attempts[1] - attempts[0]} ms`);
    assert.ok(attempts[2] - attempts[1] >= 180, `attempt gap was ${attempts[2] - attempts[1]} ms`);
  } finally { await service.close(); }
});

test("default password and password-bearing errors never escape into DB state, logs, events, or results", async (t) => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const password = "SecretDefault1!", address = "support@nordicpaws.com";
  setDefaultMailboxPassword(db, key, password);
  fake.verify = async () => { throw new Error(`IMAP authentication failed: ${password}`); };
  const events: unknown[] = [];
  const logs: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "info", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }], transport: () => fake, push: (event) => events.push(event) });
  try {
    const result = await service.sync();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((row) => row.name);
    const stored: string[] = [];
    for (const table of tables) {
      const ident = `"${table.replaceAll('"', '""')}"`;
      for (const column of db.prepare(`PRAGMA table_info(${ident})`).all() as { name: string }[]) {
        const col = `"${column.name.replaceAll('"', '""')}"`;
        stored.push(...(db.prepare(`SELECT quote(${col}) AS value FROM ${ident}`).all() as { value: string | null }[]).map((row) => row.value ?? "NULL"));
      }
    }
    assert.doesNotMatch(JSON.stringify({ result, events, logs, stored }), new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally { await service.close(); }
});

test("indexing errors after a default credential succeeds cannot persist or emit the password", async (t) => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const password = "SecretDefault1!", address = "support@nordicpaws.com";
  setDefaultMailboxPassword(db, key, password);
  fake.passwords.set(address, password);
  fake.fetchMessages = async (credentials) => {
    await fake.verify(credentials);
    throw new Error(`index failed with ${password}`);
  };
  const events: unknown[] = [], logs: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "info", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const service = createMailboxService({
    db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }],
    transport: () => fake, push: (event) => events.push(event), monitor: { idleLimit: 0, pollMs: 1_000, backoffMs: 1_000 },
  });
  try {
    const [box] = await service.sync();
    assert.equal(box.credentialSource, "default");
    await eventually(() => Boolean(service.list()[0]?.lastError), "indexing failure did not reach mailbox state");
    const state = (db.prepare("SELECT sync_state_json FROM mailboxes WHERE id=?").get(box.id) as { sync_state_json: string }).sync_state_json;
    const summary = service.list()[0];
    const exposed = JSON.stringify({ state, summary, events, logs });
    assert.doesNotMatch(exposed, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(summary.lastError ?? "", /index failed/, "sanitizing a default credential error must preserve its useful diagnostic");
  } finally { await service.close(); }
});

test("IDLE errors after a default credential succeeds cannot persist or emit the password", async (t) => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const password = "SecretDefault1!", address = "support@nordicpaws.com";
  setDefaultMailboxPassword(db, key, password);
  fake.passwords.set(address, password);
  fake.seed(address, "INBOX", []);
  fake.idle = async (credentials) => {
    await fake.verify(credentials);
    throw new Error(`idle failed with ${password}`);
  };
  const events: unknown[] = [], logs: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "info", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const service = createMailboxService({
    db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }],
    transport: () => fake, push: (event) => events.push(event), monitor: { pollMs: 1_000, backoffMs: 1_000 },
  });
  try {
    const [box] = await service.sync();
    assert.equal(box.credentialSource, "default");
    await eventually(() => Boolean(service.list()[0]?.lastError), "IDLE failure did not reach mailbox state");
    const state = (db.prepare("SELECT sync_state_json FROM mailboxes WHERE id=?").get(box.id) as { sync_state_json: string }).sync_state_json;
    const summary = service.list()[0];
    assert.doesNotMatch(JSON.stringify({ state, summary, events, logs }), new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(summary.lastError ?? "", /idle failed/, "sanitizing an IDLE error must preserve its useful diagnostic");
  } finally { await service.close(); }
});

test("an unknown default verification error is sanitized, diagnostic, remembered only as transient, and retried", async (t) => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const password = "SecretDefault1!", address = "support@nordicpaws.com";
  setDefaultMailboxPassword(db, key, password);
  let attempts = 0;
  fake.verify = async () => { attempts++; throw new TypeError(`protocol defect ${password}`); };
  const events: unknown[] = [], logs: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "info", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const service = createMailboxService({
    db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }],
    transport: () => fake, push: (event) => events.push(event),
  });
  try {
    let [box] = await service.sync();
    assert.equal(attempts, 1);
    assert.equal(box.credentialSaved, false);
    assert.equal(box.defaultPasswordStatus, "unavailable");
    const state = JSON.parse((db.prepare("SELECT sync_state_json FROM mailboxes WHERE id=?").get(box.id) as { sync_state_json: string }).sync_state_json) as { failedDefaultPasswordFingerprint?: string };
    assert.equal(state.failedDefaultPasswordFingerprint, undefined, "unknown transport defects are retryable, not password rejection");
    const exposed = JSON.stringify({ state, summary: box, events, logs });
    assert.doesNotMatch(exposed, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(box.lastError ?? "", /protocol defect/, "unknown verification errors must retain a safe diagnostic");
    assert.match(box.lastError ?? "", /验证|登录|默认密码/, "diagnostic must identify the default credential verification stage");

    [box] = await service.sync();
    assert.equal(attempts, 2, "unknown verification errors must retry on the next routine sync");
    assert.equal(box.defaultPasswordStatus, "unavailable");
  } finally { await service.close(); }
});

test("authentication rejection is still classified correctly when the echoed password contains connection text", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const password = "Connection1!", address = "support@nordicpaws.com";
  setDefaultMailboxPassword(db, key, password);
  let attempts = 0;
  fake.verify = async () => { attempts++; throw new Error(`IMAP authentication failed: ${password}`); };
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }], transport: () => fake, push: () => {} });
  try {
    let [box] = await service.sync();
    assert.equal(box.defaultPasswordStatus, "rejected");
    assert.equal(attempts, 1);
    const state = JSON.parse((db.prepare("SELECT sync_state_json FROM mailboxes WHERE id=?").get(box.id) as { sync_state_json: string }).sync_state_json) as { failedDefaultPasswordFingerprint?: string };
    assert.match(state.failedDefaultPasswordFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify({ box, state }), /Connection1!/);
    [box] = await service.sync();
    assert.equal(attempts, 1, "a real authentication rejection must remain skipped on routine sync");
    assert.equal(box.defaultPasswordStatus, "rejected");
  } finally { await service.close(); }
});

test("an explicit network error remains transient even when the error also carries an authentication flag", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const password = "Default1!", address = "support@nordicpaws.com";
  setDefaultMailboxPassword(db, key, password);
  let attempts = 0;
  fake.verify = async () => {
    attempts++;
    const error = new Error("socket was reset") as Error & { code: string; authenticationFailed: boolean };
    error.code = "ECONNRESET";
    error.authenticationFailed = true;
    throw error;
  };
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }], transport: () => fake, push: () => {} });
  try {
    let [box] = await service.sync();
    assert.equal(box.defaultPasswordStatus, "unavailable");
    const state = JSON.parse((db.prepare("SELECT sync_state_json FROM mailboxes WHERE id=?").get(box.id) as { sync_state_json: string }).sync_state_json) as { failedDefaultPasswordFingerprint?: string };
    assert.equal(state.failedDefaultPasswordFingerprint, undefined);
    [box] = await service.sync();
    assert.equal(attempts, 2);
    assert.equal(box.defaultPasswordStatus, "unavailable");
  } finally { await service.close(); }
});

test("explicit authentication failure is rejected even when harmless context contains the word network", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const password = "Default1!", address = "support@network.example";
  setDefaultMailboxPassword(db, key, password);
  let attempts = 0;
  fake.verify = async () => { attempts++; throw new Error(`IMAP authentication failed for ${address}`); };
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }], transport: () => fake, push: () => {} });
  try {
    let [box] = await service.sync();
    assert.equal(box.defaultPasswordStatus, "rejected");
    [box] = await service.sync();
    assert.equal(attempts, 1);
    assert.equal(box.defaultPasswordStatus, "rejected");
  } finally { await service.close(); }
});

test("structured authentication failure outranks weak connection wording when no network code is present", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const password = "Default1!", address = "support@nordicpaws.com";
  setDefaultMailboxPassword(db, key, password);
  let attempts = 0;
  fake.verify = async () => {
    attempts++;
    const error = new Error("connection handshake rejected") as Error & { authenticationFailed: boolean };
    error.authenticationFailed = true;
    throw error;
  };
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }], transport: () => fake, push: () => {} });
  try {
    let [box] = await service.sync();
    assert.equal(box.defaultPasswordStatus, "rejected");
    [box] = await service.sync();
    assert.equal(attempts, 1);
    assert.equal(box.defaultPasswordStatus, "rejected");
  } finally { await service.close(); }
});

test("a user credential saved while default verification is in flight wins without being overwritten", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const address = "support@nordicpaws.com", defaultPassword = "Default1!", userPassword = "UserMail1!";
  fake.passwords.set(address, userPassword);
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }], transport: () => fake, push: () => {}, monitor: { pollMs: 5, backoffMs: 1 } });
  let releaseDefault!: () => void, reachedDefault!: () => void;
  const defaultReached = new Promise<void>((resolve) => { reachedDefault = resolve; });
  const originalVerify = fake.verify.bind(fake);
  fake.verify = async (credentials) => {
    if (credentials.password === defaultPassword) {
      reachedDefault();
      await new Promise<void>((resolve) => { releaseDefault = resolve; });
      return;
    }
    await originalVerify(credentials);
  };
  try {
    const [box] = await service.sync();
    setDefaultMailboxPassword(db, key, defaultPassword);
    const automatic = service.tryDefaultCredentials();
    await defaultReached;
    await service.saveCredential({ mailboxId: box.id, password: userPassword });
    releaseDefault();
    assert.deepEqual(await automatic, { succeeded: 0, failed: 0, deferred: 0 });
    const saved = service.list()[0];
    assert.equal(saved.credentialSource, "user");
    assert.equal(saved.monitoring, true);
  } finally {
    releaseDefault?.();
    await service.close();
  }
});

test("close drains an in-flight default attempt and prevents it from saving credentials", async () => {
  const { db } = setup();
  const fake = new FakeMailTransport();
  const address = "support@nordicpaws.com", password = "Default1!";
  const service = createMailboxService({ db, key, accounts: () => [{ id: 1, exec: inventory([{ id: "box-1", address, status: "active" }]) }], transport: () => fake, push: () => {} });
  let release!: () => void, reached!: () => void;
  const verifying = new Promise<void>((resolve) => { reached = resolve; });
  fake.verify = async () => {
    reached();
    await new Promise<void>((resolve) => { release = resolve; });
  };
  await service.sync();
  setDefaultMailboxPassword(db, key, password);
  const attempt = service.tryDefaultCredentials();
  await verifying;
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false, "close must wait for the active verification call");
  release();
  await closing;
  assert.deepEqual(await attempt, { succeeded: 0, failed: 0, deferred: 0 });
  const stored = db.prepare("SELECT credential_ciphertext,monitoring FROM mailboxes WHERE address=?").get(address) as { credential_ciphertext: Uint8Array | null; monitoring: number };
  assert.equal(stored.credential_ciphertext, null);
  assert.equal(stored.monitoring, 0);
});
