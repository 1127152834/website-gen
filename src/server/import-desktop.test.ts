import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { importDesktopData, workspaceHasBusinessData } from "../../scripts/import-desktop-data.ts";
import { migrate } from "../backend/db.ts";
import { seal, unseal } from "../backend/secrets.ts";
import { deriveUserKey } from "./keys.ts";
import { acquireServerLock } from "./lock.ts";

function desktopFixture(root: string, oldKey: Buffer): string {
  const desktopDir = join(root, "desktop");
  mkdirSync(join(desktopDir, "pi", "7"), { recursive: true });
  mkdirSync(join(desktopDir, "work", "qa", "example.test"), { recursive: true });
  writeFileSync(join(desktopDir, "pi", "7", "chat.jsonl"), "chat\n");
  const shot = join(desktopDir, "work", "qa", "example.test", "home.png");
  writeFileSync(shot, "png");

  const db = new DatabaseSync(join(desktopDir, "website-gen.sqlite"));
  migrate(db);
  const now = 123;
  db.prepare("INSERT INTO hostinger_accounts (id,label,token_ciphertext,token_hint,created_at) VALUES (1,'old',?,'tail',?)").run(seal(oldKey, "hostinger-token"), now);
  db.prepare("INSERT INTO model_providers (id,name,protocol,base_url,api_key_ciphertext,api_key_hint,models_json,created_at) VALUES (1,'old model','openai','https://example.test',?,'tail','[]',?)").run(seal(oldKey, "model-key"), now);
  db.prepare("INSERT INTO batches (id,entity_json,created_at) VALUES (1,'{}',?)").run(now);
  db.prepare(`INSERT INTO sites (
    id,batch_id,domain,form_json,status,wp_admin_ciphertext,enroll_ciphertext,companion_ciphertext,mailbox_ciphertext,qa_json,created_at,updated_at
  ) VALUES (1,1,'example.test','{}','done',?,?,?,?,?,?,?)`).run(
    seal(oldKey, "wp-admin"), seal(oldKey, "enroll"), seal(oldKey, "companion"), seal(oldKey, "mailbox"),
    JSON.stringify({ at: now, checks: [], shots: [{ name: "home", file: shot }] }), now, now,
  );
  db.prepare("INSERT INTO secrets (name,ciphertext,hint,updated_at) VALUES ('cj.apiKey',?,'tail',?)").run(seal(oldKey, "cj-key"), now);
  db.close();
  return desktopDir;
}

test("desktop import stages files, re-seals every encrypted column, and fixes QA paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "website-gen-import-"));
  const oldKey = randomBytes(32), masterKey = randomBytes(32), userId = 9;
  try {
    const desktopDir = desktopFixture(root, oldKey);
    const dataDir = join(root, "web");
    const pristine = join(dataDir, "users", String(userId));
    mkdirSync(join(pristine, "work", "qa"), { recursive: true });
    mkdirSync(join(pristine, "pi"), { recursive: true });
    const emptyDb = new DatabaseSync(join(pristine, "website-gen.sqlite"));
    migrate(emptyDb);
    emptyDb.close();
    assert.equal(workspaceHasBusinessData(pristine), false);

    const result = await importDesktopData({ desktopDir, dataDir, userId, oldKey, masterKey });
    assert.equal(result.rekeyed, 7);
    assert.ok(result.backupDir && existsSync(result.backupDir));
    assert.equal(readFileSync(join(result.targetDir, "pi", "7", "chat.jsonl"), "utf8"), "chat\n");
    assert.equal(readFileSync(join(result.targetDir, "work", "qa", "example.test", "home.png"), "utf8"), "png");

    const key = deriveUserKey(masterKey, userId);
    const db = new DatabaseSync(join(result.targetDir, "website-gen.sqlite"), { readOnly: true });
    const scalar = (sql: string) => (db.prepare(sql).get() as { value: Uint8Array }).value;
    assert.equal(unseal(key, scalar("SELECT token_ciphertext AS value FROM hostinger_accounts")), "hostinger-token");
    assert.equal(unseal(key, scalar("SELECT api_key_ciphertext AS value FROM model_providers")), "model-key");
    assert.equal(unseal(key, scalar("SELECT ciphertext AS value FROM secrets")), "cj-key");
    for (const [column, expected] of [["wp_admin_ciphertext", "wp-admin"], ["enroll_ciphertext", "enroll"], ["companion_ciphertext", "companion"], ["mailbox_ciphertext", "mailbox"]]) {
      assert.equal(unseal(key, scalar(`SELECT ${column} AS value FROM sites`)), expected);
    }
    const qa = JSON.parse((db.prepare("SELECT qa_json FROM sites").get() as { qa_json: string }).qa_json) as { shots: { file: string }[] };
    assert.equal(qa.shots[0].file, join(result.targetDir, "work", "qa", "example.test", "home.png"));
    db.close();
  } finally {
    oldKey.fill(0); masterKey.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop import refuses to overwrite a populated web user", async () => {
  const root = mkdtempSync(join(tmpdir(), "website-gen-import-full-"));
  const oldKey = randomBytes(32), masterKey = randomBytes(32), userId = 3;
  try {
    const desktopDir = desktopFixture(root, oldKey), dataDir = join(root, "web"), target = join(dataDir, "users", String(userId));
    mkdirSync(target, { recursive: true });
    const db = new DatabaseSync(join(target, "website-gen.sqlite"));
    migrate(db);
    db.prepare("INSERT INTO batches (entity_json,created_at) VALUES ('{}',1)").run();
    db.close();
    assert.equal(workspaceHasBusinessData(target), true);
    await assert.rejects(importDesktopData({ desktopDir, dataDir, userId, oldKey, masterKey }), /已有业务数据/);
    const check = new DatabaseSync(join(target, "website-gen.sqlite"), { readOnly: true });
    assert.equal((check.prepare("SELECT count(*) AS n FROM batches").get() as { n: number }).n, 1);
    check.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop import refuses to run while the web server owns the data directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "website-gen-import-live-"));
  const oldKey = randomBytes(32), masterKey = randomBytes(32);
  try {
    const desktopDir = desktopFixture(root, oldKey), dataDir = join(root, "web");
    const release = acquireServerLock(dataDir);
    try {
      await assert.rejects(importDesktopData({ desktopDir, dataDir, userId: 1, oldKey, masterKey }), /数据目录已被进程/);
    } finally {
      release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed desktop re-encryption leaves no partial workspace or import lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "website-gen-import-failed-"));
  try {
    const desktopDir = desktopFixture(root, randomBytes(32));
    const dataDir = join(root, "web");
    await assert.rejects(importDesktopData({ desktopDir, dataDir, userId: 1, oldKey: randomBytes(32), masterKey: randomBytes(32) }));
    assert.deepEqual(readdirSync(join(dataDir, "users")), []);
    assert.equal(existsSync(join(dataDir, "import.lock")), false);
    assert.equal(existsSync(join(dataDir, "server.lock")), false);
    assert.equal(existsSync(join(desktopDir, "website-gen.sqlite")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
