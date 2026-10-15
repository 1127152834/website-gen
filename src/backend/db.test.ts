import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, eventsSince, migrate, openDb, schemaVersion } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";

test("migrate brings an empty db to the latest version and is idempotent", () => {
  const db = openDb(":memory:");
  migrate(db);
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  migrate(db);
  assert.equal(schemaVersion(db), MIGRATIONS.length);
});

test("events get increasing seq and can be replayed after a given seq", () => {
  const db = openDb(":memory:");
  migrate(db);
  const a = appendEvent(db, { siteId: "s1", kind: "step", payload: { message: "one" } });
  const b = appendEvent(db, { siteId: "s1", kind: "step", payload: { message: "two" } });
  assert.ok(b.seq > a.seq);
  assert.deepEqual(eventsSince(db, 0).map((e) => e.payload.message), ["one", "two"]);
  assert.deepEqual(eventsSince(db, a.seq).map((e) => e.payload.message), ["two"]);
});

test("the database rejects unknown event kinds", () => {
  const db = openDb(":memory:");
  migrate(db);
  assert.throws(() => appendEvent(db, { siteId: null, kind: "bogus" as never, payload: {} }));
});
