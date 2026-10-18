import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate, openDb } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";
import { seal } from "./secrets.ts";

const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const migrateThrough014 = (db: ReturnType<typeof openDb>) => {
  const version = db.prepare("PRAGMA user_version").get()?.user_version as number;
  for (let index = version; index < 14; index++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
};

test("migration 014 adds translation without changing providers, keys, or existing roles", () => {
  const db = openDb(":memory:");
  for (const sql of MIGRATIONS.slice(0, 13)) db.exec(sql);
  db.exec("PRAGMA user_version = 13");

  const ciphertext = seal(randomBytes(32), "provider-key-that-must-not-change");
  const providerId = (db.prepare(`
    INSERT INTO model_providers
      (name, protocol, base_url, api_key_ciphertext, api_key_hint, models_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get("Existing Provider", "openai", "https://models.example.test/v1", ciphertext, "ange", "[]", 123) as { id: number }).id;
  const insertRole = db.prepare("INSERT INTO model_roles (role, provider_id, model_id, thinking) VALUES (?, ?, ?, ?)");
  const expectedRoles = [
    { role: "agent", provider_id: providerId, model_id: "agent-model", thinking: "high" },
    { role: "vision", provider_id: providerId, model_id: "vision-model", thinking: "medium" },
    { role: "bulk", provider_id: providerId, model_id: "bulk-model", thinking: "low" },
    { role: "review", provider_id: providerId, model_id: "review-model", thinking: "max" },
  ];
  for (const role of expectedRoles) insertRole.run(role.role, role.provider_id, role.model_id, role.thinking);
  const beforeKey = db.prepare("SELECT api_key_ciphertext FROM model_providers WHERE id = ?").get(providerId) as { api_key_ciphertext: Uint8Array };

  // 历史行为只执行到 014；后续迁移的保留行为由独立用例覆盖。
  migrateThrough014(db);

  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 14);
  assert.deepEqual(db.prepare("SELECT role, provider_id, model_id, thinking FROM model_roles ORDER BY rowid").all().map((row) => ({ ...row })), expectedRoles);
  const afterKey = db.prepare("SELECT api_key_ciphertext FROM model_providers WHERE id = ?").get(providerId) as { api_key_ciphertext: Uint8Array };
  assert.equal(digest(afterKey.api_key_ciphertext), digest(beforeKey.api_key_ciphertext));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

  assert.doesNotThrow(() => insertRole.run("translation", providerId, "translation-model", "off"));
  db.prepare("DELETE FROM model_roles WHERE role = 'translation'").run();
  assert.throws(() => insertRole.run("unsupported", providerId, "bad-model", "off"), /CHECK constraint failed/);
  assert.throws(() => insertRole.run("translation", providerId, "bad-model", "extreme"), /CHECK constraint failed/);
  assert.throws(() => insertRole.run("translation", providerId + 999, "bad-model", "off"), /FOREIGN KEY constraint failed/);
  insertRole.run("translation", providerId, "translation-model", "off");
  assert.throws(() => db.prepare("DELETE FROM model_providers WHERE id = ?").run(providerId), /FOREIGN KEY constraint failed/);

  const snapshot = db.prepare("SELECT role, provider_id, model_id, thinking FROM model_roles ORDER BY role").all();
  migrateThrough014(db);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 14);
  assert.deepEqual(db.prepare("SELECT role, provider_id, model_id, thinking FROM model_roles ORDER BY role").all(), snapshot);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("upgrading v14 to current preserves translation binding and sealed provider key", () => {
  const db = openDb(":memory:");
  try {
    for (const sql of MIGRATIONS.slice(0, 14)) db.exec(sql);
    db.exec("PRAGMA user_version = 14");
    const ciphertext = seal(randomBytes(32), "translation-fixture-key");
    db.prepare("INSERT INTO model_providers (id,name,protocol,base_url,api_key_ciphertext,models_json,created_at) VALUES (1,'fixture','openai','https://models.example.test',?,'[]',1)").run(ciphertext);
    db.exec("INSERT INTO model_roles VALUES ('translation',1,'translation-model','high')");
    const before = db.prepare("SELECT * FROM model_roles").all();
    migrate(db);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
    assert.deepEqual(db.prepare("SELECT * FROM model_roles").all(), before);
    assert.deepEqual(db.prepare("SELECT api_key_ciphertext FROM model_providers").get()?.api_key_ciphertext, new Uint8Array(ciphertext));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    migrate(db);
    assert.deepEqual(db.prepare("SELECT * FROM model_roles").all(), before);
  } finally { db.close(); }
});
