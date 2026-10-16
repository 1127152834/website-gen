import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, migrate } from "./db.ts";
import { getOverview } from "./overview.ts";

test("overview aggregates current workspace status, attention and 30-day expiry without writes", () => {
  const db = openDb(":memory:");
  try {
    migrate(db);
    const now = Date.UTC(2026, 9, 15);
    db.exec("INSERT INTO hostinger_accounts (id,label,token_ciphertext,token_hint,created_at) VALUES (1,'主账号',x'00','0000',0); INSERT INTO batches VALUES (1,'{}',0)");
    const insert = db.prepare("INSERT INTO sites (id,batch_id,domain,form_json,status,created_at,updated_at,launched_at,qa_json) VALUES (?,1,?,'{}',?,0,0,?,?)");
    insert.run(1, "running.example", "running", null, null);
    insert.run(2, "failed.example", "failed", null, null);
    insert.run(3, "done.example", "done", null, JSON.stringify({ checks: [{ ok: false, level: "warn" }], review: { issues: [{ status: "needs_you" }] } }));
    insert.run(4, "live.example", "done", now, null);
    db.exec("INSERT INTO provision_steps VALUES(4,'mailbox','done',NULL,0,0)");
    const domain = db.prepare("INSERT INTO domains (account_id,external_id,domain,expires_at) VALUES(1,?,?,?)");
    for (const [id, offset] of [[1, -1], [2, 0], [3, 30], [4, 31]]) domain.run(id, `${id}.example`, new Date(now + offset * 86_400_000).toISOString());
    domain.run(5, "invalid.example", "not-a-date");
    const before = db.prepare("SELECT total_changes() AS n").get();
    const view = getOverview(db, now);
    assert.deepEqual(view.counts, { total: 4, queued: 0, running: 1, waiting: 0, done: 2, failed: 1, abandoned: 0, launched: 1 });
    assert.equal(view.runningBatches.length, 1);
    assert.deepEqual(view.attention.map((site) => site.siteId), [2, 3]);
    assert.equal(view.attention[1].reasons.length, 4);
    assert.equal(view.attention[1].tab, "qa");
    assert.deepEqual(view.expiringDomains.map((item) => item.daysLeft), [0, 30]);
    assert.deepEqual(db.prepare("SELECT total_changes() AS n").get(), before);
  } finally { db.close(); }
});

test("overview is empty for a new isolated workspace", () => {
  const db = openDb(":memory:");
  try { migrate(db); const view = getOverview(db); assert.equal(view.counts.total, 0); assert.deepEqual(view.attention, []); assert.deepEqual(view.expiringDomains, []); } finally { db.close(); }
});

test("overview keeps a passed QA site with a payment needs_you review issue in attention", () => {
  const db = openDb(":memory:");
  try {
    migrate(db);
    db.exec("INSERT INTO batches VALUES (1,'{}',0)");
    const qa = {
      at: 0,
      checks: [{ id: "payments", name: "Payment methods", level: "warn", ok: true, detail: "Configured" }],
      shots: [],
      review: {
        at: 0,
        rounds: 0,
        passed: true,
        issues: [{
          id: "payment-gateway", level: "P2", kind: "config", page: "Site-wide", url: "https://shop.example/",
          evidence: "No enabled card payment gateway was found.", why: "Customers cannot pay by card.",
          fix: "Connect a payment gateway such as Stripe so credit cards are accepted.", status: "needs_you",
        }],
      },
    };
    db.prepare("INSERT INTO sites (id,batch_id,domain,form_json,status,created_at,updated_at,launched_at,qa_json) VALUES (1,1,?,'{}','done',0,0,1,?)")
      .run("shop.example", JSON.stringify(qa));
    db.exec("INSERT INTO provision_steps VALUES(1,'mailbox','done',NULL,0,0)");

    const view = getOverview(db);

    assert.equal(view.attention.length, 1);
    assert.equal(view.attention[0]?.siteId, 1);
    assert.equal(view.attention[0]?.tab, "qa");
    assert.equal(view.attention[0]?.reasons.length, 1);
    assert.match(view.attention[0]?.reasons[0] ?? "", /1/);
  } finally { db.close(); }
});
