import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { migrate, openDb } from "./db.ts";
import { createWorkspace, type Workspace } from "./index.ts";
import type { MailTranslateFn } from "./mail-translation.ts";
import type { MailTransport } from "./mailbox-transport.ts";
import { handleRequest } from "./rpc.ts";
import { createProviderConfig, setRole } from "./models.ts";

function offlineTransport(counter: { calls: number }): MailTransport {
  const noNetwork = async (): Promise<never> => {
    counter.calls++;
    throw new Error("测试禁止任何 IMAP/SMTP 网络访问");
  };
  return {
    verify: noNetwork,
    listFolders: noNetwork,
    fetchMessages: noNetwork,
    fetchMessage: noNetwork,
    setSeen: noNetwork,
    moveToTrash: noNetwork,
    downloadAttachment: noNetwork,
    send: noNetwork,
    idle: noNetwork,
  };
}

function seedMessage(
  dir: string,
  input: { mailboxId?: number; domain?: string; uid?: number; subject?: string; body?: string | null; abandoned?: boolean } = {},
) {
  const mailboxId = input.mailboxId ?? 1;
  const domain = input.domain ?? "example.test";
  const uid = input.uid ?? 2;
  const db = openDb(join(dir, "website-gen.sqlite"));
  migrate(db);
  db.prepare("INSERT OR IGNORE INTO hostinger_accounts(id,label,token_ciphertext,token_hint,created_at) VALUES(1,'test',X'00','hint',0)").run();
  db.prepare("INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain) VALUES(?,1,?,?,?,?)")
    .run(mailboxId, `order-${mailboxId}`, `remote-${mailboxId}`, `mail-${mailboxId}@${domain}`, domain);
  db.prepare("INSERT INTO mail_messages(mailbox_id,folder,uid,subject,body_text) VALUES(?,'INBOX',?,?,?)")
    .run(mailboxId, uid, input.subject ?? "Private subject", input.body === undefined ? "Private body" : input.body);
  if (input.abandoned) db.prepare("INSERT INTO abandoned_domains(domain,abandoned_at) VALUES(?,1)").run(domain);
  db.close();
}

const rpc = (workspace: Workspace, method: string, params?: unknown) =>
  handleRequest(workspace.handlers, { kind: "req", id: 1, method, params });

function removeTemp(root: string, prefix: string) {
  if (!resolve(root).startsWith(prefix)) throw new Error("临时目录越界");
  rmSync(root, { recursive: true, force: true });
}

test("mail.translate cannot cross the authenticated workspace even with spoofed user and account IDs", async () => {
  const prefix = resolve(tmpdir(), "website-mail-translation-isolation-");
  const root = mkdtempSync(prefix);
  const network = { calls: 0 };
  let aModelCalls = 0;
  let bModelCalls = 0;
  const a = createWorkspace({
    userDir: join(root, "a"),
    key: randomBytes(32),
    dependencies: {
      mailTransport: () => offlineTransport(network),
      mailTranslate: async () => { aModelCalls++; return { text: '{"subject":"泄漏","text":"泄漏"}', cost: 0 }; },
    },
  });
  const b = createWorkspace({
    userDir: join(root, "b"),
    key: randomBytes(32),
    dependencies: {
      mailTransport: () => offlineTransport(network),
      mailTranslate: async () => { bModelCalls++; return { text: '{"subject":"译文","text":"正文"}', cost: 0 }; },
    },
  });
  try {
    seedMessage(join(root, "b"), { mailboxId: 42, uid: 8, body: "B workspace secret" });
    const response = await rpc(a, "mail.translate", { mailboxId: 42, folder: "INBOX", uid: 8, userId: "b", accountId: 1 });
    assert.equal(response.ok, false);
    assert.doesNotMatch(JSON.stringify(response), /B workspace secret|译文|正文/);
    assert.equal(aModelCalls, 0);
    assert.equal(bModelCalls, 0);
    assert.equal(network.calls, 0);
  } finally {
    await a.close();
    await b.close();
    removeTemp(root, prefix);
  }
});

test("mail.translate returns only translated fields and does not modify the cached row", async () => {
  const prefix = resolve(tmpdir(), "website-mail-translation-cached-");
  const dir = mkdtempSync(prefix);
  const network = { calls: 0 };
  let modelCalls = 0;
  const key = randomBytes(32);
  const translate: MailTranslateFn = async (_db, _key, role) => {
    assert.equal(role, "translation");
    modelCalls++;
    return { text: '{"subject":"译文标题","text":"译文正文","mailboxId":999,"uid":999}', cost: 0 };
  };
  const workspace = createWorkspace({ userDir: dir, key, dependencies: { mailTransport: () => offlineTransport(network), mailTranslate: translate } });
  try {
    seedMessage(dir);
    const db = openDb(join(dir, "website-gen.sqlite"));
    const providerId = createProviderConfig(db, key, { name: "Dedicated translation", protocol: "openai", baseUrl: "https://translation.example.test/v1", apiKey: "fixture-key", models: [{ id: "translate-only", name: "Translate", contextWindow: 128000, maxOutputTokens: 8192, vision: false, thinkingLevels: ["off"] }] });
    setRole(db, "translation", { providerId, modelId: "translate-only", thinking: "off" });
    const before = db.prepare("SELECT * FROM mail_messages WHERE mailbox_id=1 AND folder='INBOX' AND uid=2").get();
    db.close();
    const response = await rpc(workspace, "mail.translate", { mailboxId: 1, folder: "INBOX", uid: 2 });
    assert.deepEqual(response, { kind: "res", id: 1, ok: true, result: { subject: "译文标题", text: "译文正文" } });
    const check = openDb(join(dir, "website-gen.sqlite"));
    assert.deepEqual(check.prepare("SELECT * FROM mail_messages WHERE mailbox_id=1 AND folder='INBOX' AND uid=2").get(), before);
    check.close();
    assert.equal(modelCalls, 1);
    assert.equal(network.calls, 0);
  } finally {
    await workspace.close();
    removeTemp(dir, prefix);
  }
});

test("mail.translate does not use other ready purposes before its dedicated model is configured", async () => {
  const prefix = resolve(tmpdir(), "website-mail-translation-dedicated-");
  const dir = mkdtempSync(prefix), key = randomBytes(32), network = { calls: 0 };
  let modelCalls = 0;
  const workspace = createWorkspace({ userDir: dir, key, dependencies: {
    mailTransport: () => offlineTransport(network),
    mailTranslate: async () => { modelCalls++; return { text: '{"subject":"不可调用","text":"不可调用"}', cost: 0 }; },
  } });
  try {
    seedMessage(dir);
    const db = openDb(join(dir, "website-gen.sqlite"));
    const providerId = createProviderConfig(db, key, { name: "Other purposes", protocol: "openai", baseUrl: "https://other.example.test/v1", apiKey: "fixture-key", models: [{ id: "other", name: "Other", contextWindow: 128000, maxOutputTokens: 8192, vision: false, thinkingLevels: ["off"] }] });
    for (const role of ["agent", "bulk"] as const) setRole(db, role, { providerId, modelId: "other", thinking: "off" });
    db.close();
    const response = await rpc(workspace, "mail.translate", { mailboxId: 1, folder: "INBOX", uid: 2 });
    assert.equal(response.ok, false);
    assert.match(response.ok ? "" : response.error, /设置.*用途分配.*邮件翻译/);
    assert.equal(modelCalls, 0);
    assert.equal(network.calls, 0);
  } finally {
    await workspace.close();
    removeTemp(dir, prefix);
  }
});

test("mail.translate rejects an abandoned mailbox before model or IMAP access", async () => {
  const prefix = resolve(tmpdir(), "website-mail-translation-tombstone-");
  const dir = mkdtempSync(prefix);
  const network = { calls: 0 };
  let modelCalls = 0;
  const workspace = createWorkspace({
    userDir: dir,
    key: randomBytes(32),
    dependencies: {
      mailTransport: () => offlineTransport(network),
      mailTranslate: async () => { modelCalls++; return { text: '{"subject":"x","text":"y"}', cost: 0 }; },
    },
  });
  try {
    seedMessage(dir, { domain: "abandoned.example", abandoned: true });
    assert.equal((await rpc(workspace, "mail.translate", { mailboxId: 1, folder: "INBOX", uid: 2 })).ok, false);
    assert.equal(modelCalls, 0);
    assert.equal(network.calls, 0);
  } finally {
    await workspace.close();
    removeTemp(dir, prefix);
  }
});

test("mail.translate rejects an uncached body before model or IMAP access", async () => {
  const prefix = resolve(tmpdir(), "website-mail-translation-body-");
  const dir = mkdtempSync(prefix);
  const network = { calls: 0 };
  let modelCalls = 0;
  const workspace = createWorkspace({
    userDir: dir,
    key: randomBytes(32),
    dependencies: {
      mailTransport: () => offlineTransport(network),
      mailTranslate: async () => { modelCalls++; return { text: '{"subject":"x","text":"y"}', cost: 0 }; },
    },
  });
  try {
    seedMessage(dir, { body: null });
    assert.equal((await rpc(workspace, "mail.translate", { mailboxId: 1, folder: "INBOX", uid: 2 })).ok, false);
    assert.equal(modelCalls, 0);
    assert.equal(network.calls, 0);
  } finally {
    await workspace.close();
    removeTemp(dir, prefix);
  }
});

test("read-only workspace rejects mail.translate before invoking the model", async () => {
  const prefix = resolve(tmpdir(), "website-mail-translation-readonly-");
  const dir = mkdtempSync(prefix);
  seedMessage(dir);
  const network = { calls: 0 };
  let modelCalls = 0;
  const workspace = createWorkspace({
    userDir: dir,
    key: randomBytes(32),
    readOnly: true,
    dependencies: {
      mailTransport: () => offlineTransport(network),
      mailTranslate: async () => { modelCalls++; return { text: '{"subject":"x","text":"y"}', cost: 0 }; },
    },
  });
  try {
    const response = await rpc(workspace, "mail.translate", { mailboxId: 1, folder: "INBOX", uid: 2 });
    assert.equal(response.ok, false);
    assert.match(response.ok ? "" : response.error, /只读/);
    assert.equal(modelCalls, 0);
    assert.equal(network.calls, 0);
  } finally {
    await workspace.close();
    removeTemp(dir, prefix);
  }
});

test("background-disabled workspace rejects mail.translate before invoking the model", async () => {
  const prefix = resolve(tmpdir(), "website-mail-translation-no-background-");
  const dir = mkdtempSync(prefix);
  const network = { calls: 0 };
  let modelCalls = 0;
  const workspace = createWorkspace({
    userDir: dir,
    key: randomBytes(32),
    backgroundTasks: false,
    dependencies: {
      mailTransport: () => offlineTransport(network),
      mailTranslate: async () => { modelCalls++; return { text: '{"subject":"x","text":"y"}', cost: 0 }; },
    },
  });
  try {
    seedMessage(dir);
    const response = await rpc(workspace, "mail.translate", { mailboxId: 1, folder: "INBOX", uid: 2 });
    assert.equal(response.ok, false);
    assert.match(response.ok ? "" : response.error, /只读/);
    assert.equal(modelCalls, 0);
    assert.equal(network.calls, 0);
  } finally {
    await workspace.close();
    removeTemp(dir, prefix);
  }
});
