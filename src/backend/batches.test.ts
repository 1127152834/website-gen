import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, openDb } from "./db.ts";
import { batchSites, createBatch, listFreeDomains, retrySite } from "./batches.ts";
import type { BatchForm } from "../shared/forms.ts";

function setup() {
  const db = openDb(":memory:");
  migrate(db);
  db.prepare("INSERT INTO hostinger_accounts (id, label, token_ciphertext, token_hint, created_at) VALUES (1, '主账号', x'00', 'abcd', 0)").run();
  for (const [i, d] of ["a.com", "b.com", "c.com"].entries()) db.prepare("INSERT INTO domains VALUES (1, ?, ?, 'domain', 'active', NULL, NULL)").run(i, d);
  db.prepare("INSERT INTO hosting_websites (account_id, domain) VALUES (1, 'c.com')").run();
  return db;
}
const form = (domains: string[]): BatchForm => ({
  entity: { kind: "company", name: "X LLC", address: "1 Main St", supportEmail: "auto", phone: "+1 512 555 0100", processingDays: [1, 3], transitDays: [5, 10] },
  sites: domains.map((domain) => ({ domain, categories: "mugs", count: 10, priceMin: null, priceMax: null, brand: "" })),
});

test("free domains exclude ones with a website or already in a batch; taken domains are refused", () => {
  const db = setup();
  assert.deepEqual(listFreeDomains(db).map((d) => d.domain), ["a.com", "b.com"]);
  createBatch(db, form(["a.com"]), 0);
  assert.deepEqual(listFreeDomains(db).map((d) => d.domain), ["b.com"]);
  assert.throws(() => createBatch(db, form(["b.com", "c.com"]), 0), /c\.com 不可用/);
  assert.deepEqual(listFreeDomains(db).map((d) => d.domain), ["b.com"], "nothing half-created");
});

test("retry puts a failed site back in the queue from the failed step", () => {
  const db = setup();
  const { batchId, siteIds: [id] } = createBatch(db, form(["a.com"]), 0);
  db.prepare("INSERT INTO provision_steps VALUES (?, 'precheck', 'done', NULL, 0, 1), (?, 'create_site', 'failed', 'boom', 1, 2)").run(id, id);
  db.prepare("UPDATE sites SET status = 'failed', last_error = 'boom' WHERE id = ?").run(id);
  db.prepare("UPDATE jobs SET status = 'failed', attempts = 3 WHERE site_id = ?").run(id);

  assert.equal(batchSites(db, batchId)[0].currentStep, "创建网站");
  retrySite(db, id, 5);
  const [site] = batchSites(db, batchId);
  assert.equal(site.status, "queued");
  assert.equal(site.lastError, null);
  assert.equal(site.completed, 1);
  assert.deepEqual({ ...db.prepare("SELECT status, attempts, run_at FROM jobs WHERE site_id = ?").get(id) }, { status: "queued", attempts: 0, run_at: 5 });
});
