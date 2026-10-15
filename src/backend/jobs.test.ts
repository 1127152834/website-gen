import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, openDb } from "./db.ts";
import { claimDue, createRunner, enqueue, PermanentError, recoverStale } from "./jobs.ts";

const fresh = () => {
  const db = openDb(":memory:");
  migrate(db);
  return db;
};
const status = (db: ReturnType<typeof fresh>, id: number) =>
  db.prepare("SELECT status, attempts, run_at, last_error FROM jobs WHERE id = ?").get(id) as { status: string; attempts: number; run_at: number; last_error: string | null };

test("a claimed job is leased and cannot be claimed twice", () => {
  const db = fresh();
  const id = enqueue(db, "t", null, 0);
  assert.deepEqual(claimDue(db, 0, 5, 1000).map((j) => j.id), [id]);
  assert.deepEqual(claimDue(db, 0, 5, 1000), []);
});

test("a waiting job is rescheduled without using a slot or an attempt", async () => {
  const db = fresh();
  let now = 0;
  const id = enqueue(db, "t", null, now);
  const runner = createRunner({ db, now: () => now, handlers: { t: async () => ({ waitMs: 5000 }) } });
  await runner.tick();
  assert.deepEqual([status(db, id).status, status(db, id).attempts, status(db, id).run_at], ["queued", 0, 5000]);
  now = 4999;
  assert.deepEqual(claimDue(db, now, 5, 1000), []);
});

test("failures retry with growing backoff, then fail; permanent errors fail at once", async () => {
  const db = fresh();
  let now = 0;
  const flaky = enqueue(db, "flaky", null, now);
  const doomed = enqueue(db, "doomed", null, now);
  const runner = createRunner({
    db,
    now: () => now,
    handlers: {
      flaky: async () => { throw new Error("timeout"); },
      doomed: async () => { throw new PermanentError("domain already has a website"); },
    },
  });
  await runner.tick();
  assert.equal(status(db, doomed).status, "failed");
  assert.equal(status(db, flaky).status, "queued");
  assert.equal(status(db, flaky).run_at, 30_000);
  now = 30_000;
  await runner.tick();
  assert.equal(status(db, flaky).run_at, 30_000 + 60_000);
  now = 90_000;
  await runner.tick();
  assert.deepEqual([status(db, flaky).status, status(db, flaky).attempts, status(db, flaky).last_error], ["failed", 3, "timeout"]);
});

test("jobs left running by a crash are recovered once their lease expires", () => {
  const db = fresh();
  const id = enqueue(db, "t", null, 0);
  claimDue(db, 0, 1, 1000);
  assert.equal(recoverStale(db, 500), 0);
  assert.equal(recoverStale(db, 1001), 1);
  assert.equal(status(db, id).status, "queued");
});

test("the runner never runs more jobs at once than its concurrency", async () => {
  const db = fresh();
  for (let i = 0; i < 5; i++) enqueue(db, "t", null, 0);
  let active = 0;
  let peak = 0;
  const runner = createRunner({
    db,
    concurrency: 2,
    now: () => 0,
    handlers: {
      t: async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
    },
  });
  await Promise.all([runner.tick(), runner.tick(), runner.tick()]);
  assert.equal(peak, 2);
});
