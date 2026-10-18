import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, openDb } from "./db.ts";
import { batchSites, createBatch, listFreeDomains, retrySite } from "./batches.ts";
import type { BatchForm } from "../shared/forms.ts";

function setup() {
  const db = openDb(":memory:");
  migrate(db);
  db.prepare("INSERT INTO hostinger_accounts (id, label, token_ciphertext, token_hint, status, created_at) VALUES (1, '主账号', x'00', 'abcd', 'ok', 0)").run();
  for (const [i, d] of ["a.com", "b.com", "c.com"].entries()) db.prepare("INSERT INTO domains VALUES (1, ?, ?, 'domain', 'active', NULL, NULL)").run(i, d);
  db.prepare("INSERT INTO hosting_websites (account_id, domain) VALUES (1, 'c.com')").run();
  return db;
}
const mailbox = (domain: string, supportEmail = `support@${domain}`, accountId = 1) => ({
  domain,
  accountId,
  mailboxes: [{ address: supportEmail }],
  defaultEmail: supportEmail,
});
const form = (domains: string[]): BatchForm => ({
  entity: { kind: "company", name: "X LLC", address: "1 Main St", supportEmail: "auto", phone: "+1 512 555 0100", processingDays: [1, 3], transitDays: [5, 10] },
  sites: domains.map((domain) => ({ domain, supportEmail: `support@${domain}`, categories: "mugs", count: 10, priceMin: null, priceMax: null, brand: "" })),
});

test("free domains exclude case variants of existing websites and newly queued sites", () => {
  const db = setup();
  db.prepare("UPDATE domains SET domain=upper(domain)").run();
  assert.equal(listFreeDomains(db).some((item) => item.domain.toLowerCase() === "c.com"), false);
  assert.deepEqual(listFreeDomains(db).map((item) => item.domain), ["a.com", "b.com"]);
  createBatch(db, form(["A.COM"]), 0, [mailbox("a.com")]);
  assert.equal(listFreeDomains(db).some((item) => item.domain.toLowerCase() === "a.com"), false);
});

test("free domains exclude ones with a website or already in a batch; taken domains are refused", () => {
  const db = setup();
  assert.deepEqual(listFreeDomains(db).map((d) => d.domain), ["a.com", "b.com"]);
  createBatch(db, form(["a.com"]), 0, [mailbox("a.com")]);
  assert.deepEqual(listFreeDomains(db).map((d) => d.domain), ["b.com"]);
  assert.throws(() => createBatch(db, form(["b.com", "c.com"]), 0, [mailbox("b.com"), mailbox("c.com")]), /c\.com 不可用/);
  assert.deepEqual(listFreeDomains(db).map((d) => d.domain), ["b.com"], "nothing half-created");
});

test("createBatch rejects a site without a verified existing mailbox and writes nothing", () => {
  const db = setup();
  let error: unknown;
  try { createBatch(db, form(["a.com"]), 0, []); } catch (caught) { error = caught; }
  assert.match(String(error), /邮箱|验证/);
  for (const table of ["batches", "sites", "jobs"])
    assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, `${table} must stay empty`);
});

test("createBatch persists each site's verified mailbox instead of the shared legacy entity value", () => {
  const db = setup();
  const input = form(["a.com", "b.com"]);
  input.sites[0].supportEmail = "sales@a.com";
  input.sites[1].supportEmail = "hello@b.com";
  const { batchId } = createBatch(db, input, 0, [mailbox("a.com", "sales@a.com"), mailbox("b.com", "hello@b.com")]);
  const entity = JSON.parse((db.prepare("SELECT entity_json FROM batches WHERE id=?").get(batchId) as { entity_json: string }).entity_json) as { supportEmail: string };
  const sites = (db.prepare("SELECT domain,form_json FROM sites WHERE batch_id=? ORDER BY domain").all(batchId) as { domain: string; form_json: string }[])
    .map((row) => ({ domain: row.domain, supportEmail: (JSON.parse(row.form_json) as { supportEmail: string }).supportEmail }));
  assert.equal(entity.supportEmail, "auto", "legacy entity data remains readable but is not used as the per-site selection");
  assert.deepEqual(sites, [
    { domain: "a.com", supportEmail: "sales@a.com" },
    { domain: "b.com", supportEmail: "hello@b.com" },
  ]);
});

test("createBatch rejects a mailbox address outside the selected site domain", () => {
  const db = setup();
  const input = form(["a.com"]);
  input.sites[0].supportEmail = "owner@outside.test";
  assert.throws(() => createBatch(db, input, 0, [mailbox("a.com", "owner@outside.test")]), /不属于/);
});

test("createBatch rejects a mailbox verified under the wrong Hostinger account", () => {
  const db = setup();
  db.prepare("INSERT INTO hostinger_accounts (id, label, token_ciphertext, token_hint, status, created_at) VALUES (2, '其他账号', x'00', 'efgh', 'ok', 0)").run();
  assert.throws(() => createBatch(db, form(["a.com"]), 0, [mailbox("a.com", "support@a.com", 2)]), /邮箱|账号/);
});

test("retry puts a failed site back in the queue from the failed step", () => {
  const db = setup();
  const { batchId, siteIds: [id] } = createBatch(db, form(["a.com"]), 0, [mailbox("a.com")]);
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
