import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate, openDb } from "./db.ts";
import { createGristService } from "./grist-settings.ts";
import { getSecret } from "./secrets.ts";
import { MIGRATIONS } from "./migrations.ts";

test("Grist settings migration upgrades existing workspaces without changing saved secrets", () => {
  const db = openDb(":memory:");
  try {
    for (const sql of MIGRATIONS.slice(0, -1)) db.exec(sql);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1};
      INSERT INTO secrets (name,ciphertext,hint,updated_at) VALUES ('existing', X'0123', '0123', 1)`);
    migrate(db); migrate(db);
    assert.deepEqual({ ...db.prepare("SELECT name,hex(ciphertext) AS cipher FROM secrets WHERE name='existing'").get() }, { name: "existing", cipher: "0123" });
    assert.equal(db.prepare("SELECT count(*) AS n FROM workspace_settings").get()!.n, 0);
  } finally { db.close(); }
});

test("Grist settings encrypt keys, show only last four characters and preserve blank keys", async () => {
  const db = openDb(":memory:"); migrate(db);
  const key = Buffer.alloc(32, 7);
  const service = createGristService({ db, key, validateBaseUrl: async () => {} });
  try {
    assert.deepEqual(await service.handlers["grist.settings.get"]({}), { baseUrl: "", apiKeyHint: null, configured: false });
    const saved = await service.handlers["grist.settings.save"]({ baseUrl: "https://8.8.8.8/", apiKey: "sensitive-secret-1234" });
    assert.deepEqual(saved, { baseUrl: "https://8.8.8.8", apiKeyHint: "1234", configured: true });
    assert.equal(getSecret(db, key, "grist.apiKey"), "sensitive-secret-1234");
    const row = db.prepare("SELECT * FROM secrets WHERE name = 'grist.apiKey'").get()!;
    assert.ok(!Buffer.from(row.ciphertext as Uint8Array).includes(Buffer.from("sensitive-secret-1234")));
    await service.handlers["grist.settings.save"]({ baseUrl: "https://other.example", apiKey: "" });
    assert.equal(getSecret(db, key, "grist.apiKey"), "sensitive-secret-1234");
    await assert.rejects(async () => service.handlers["grist.settings.save"]({ baseUrl: "file:///etc/passwd" }), /http/i);
    await assert.rejects(async () => service.handlers["grist.settings.save"]({ baseUrl: "https://other.example", apiKey: "bad\nkey" }), /换行/);
    assert.equal((service.handlers["grist.settings.get"]({}) as { baseUrl: string }).baseUrl, "https://other.example");
  } finally { db.close(); }
});

test("Grist settings and secrets stay isolated to the current workspace", async () => {
  const a = openDb(":memory:"), b = openDb(":memory:"); migrate(a); migrate(b);
  const key = Buffer.alloc(32, 9);
  const alice = createGristService({ db: a, key, validateBaseUrl: async () => {} });
  const bob = createGristService({ db: b, key, validateBaseUrl: async () => {} });
  try {
    await alice.handlers["grist.settings.save"]({ baseUrl: "https://alice.example", apiKey: "alice-key" });
    assert.deepEqual(bob.handlers["grist.settings.get"]({}), { baseUrl: "", apiKeyHint: null, configured: false });
    assert.throws(() => bob.client(), /设置/);
    const denied = createGristService({ db: a, key, validateBaseUrl: async () => { throw new Error("不允许内网"); } });
    await assert.rejects(async () => denied.handlers["grist.settings.save"]({ baseUrl: "http://127.0.0.1", apiKey: "replacement" }), /内网/);
    assert.equal(getSecret(a, key, "grist.apiKey"), "alice-key");
  } finally { a.close(); b.close(); }
});

test("Grist connection tests can use unsaved fields without persisting them or returning saved keys", async () => {
  const db = openDb(":memory:"); migrate(db);
  const key = Buffer.alloc(32, 3);
  const seen: { url: string; authorization: string | null }[] = [];
  const service = createGristService({ db, key, validateBaseUrl: async () => {}, fetch: async (url, init) => {
    seen.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") });
    return Response.json({ user: { id: 1, name: "Fixture", email: "fixture@example.invalid" } });
  } });
  try {
    await service.handlers["grist.settings.save"]({ baseUrl: "https://8.8.8.8", apiKey: "stored-key-abcd" });
    const profile = await service.handlers["grist.testConnection"]({ baseUrl: "https://1.1.1.1", apiKey: "unsaved-key-efgh" });
    assert.deepEqual(profile, { user: { id: 1, name: "Fixture", email: "fixture@example.invalid" } });
    assert.deepEqual(seen[0], { url: "https://1.1.1.1/api/session/access/active", authorization: "Bearer unsaved-key-efgh" });
    await service.handlers["grist.testConnection"]({ apiKey: "" });
    assert.deepEqual(seen[1], { url: "https://8.8.8.8/api/session/access/active", authorization: "Bearer stored-key-abcd" });
    assert.deepEqual(service.handlers["grist.settings.get"]({}), { baseUrl: "https://8.8.8.8", apiKeyHint: "abcd", configured: true });
    assert.equal(getSecret(db, key, "grist.apiKey"), "stored-key-abcd");
  } finally { db.close(); }
});

test("Grist service keeps only settings RPCs while its shared client remains usable", async () => {
  const db = openDb(":memory:"); migrate(db);
  const key = Buffer.alloc(32, 7);
  const seen: string[] = [];
  const service = createGristService({ db, key, validateBaseUrl: async () => {}, fetch: async (url) => {
    seen.push(String(url));
    return Response.json(String(url).endsWith("/tables") ? { tables: [{ id: "People", fields: {} }] } : { records: [] });
  } });
  try {
    await service.handlers["grist.settings.save"]({ baseUrl: "https://8.8.8.8", apiKey: "client-key" });
    assert.deepEqual(Object.keys(service.handlers).sort(), ["grist.settings.get", "grist.settings.save", "grist.testConnection"]);
    const client = service.client();
    assert.deepEqual(await client.getTables("doc"), { tables: [{ id: "People", fields: {} }] });
    assert.deepEqual(await client.listRecords("doc", "People"), { records: [] });
    assert.deepEqual(seen, ["https://8.8.8.8/api/docs/doc/tables", "https://8.8.8.8/api/docs/doc/tables/People/records"]);
  } finally { db.close(); }
});
