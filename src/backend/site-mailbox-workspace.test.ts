import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkspace } from "./index.ts";
import { migrate, openDb } from "./db.ts";
import { seal } from "./secrets.ts";
import type { HostingerExec } from "./hostinger.ts";

test("batches.create 规范化缺失的共享邮箱，并在任何 Hostinger 查询前拒绝无效表单", async () => {
  const root = mkdtempSync(join(tmpdir(), "site-mailbox-workspace-"));
  const key = randomBytes(32);
  const db = openDb(join(root, "website-gen.sqlite"));
  migrate(db);
  db.prepare("INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,status,created_at) VALUES(1,'主账号',?,'oken','ok',0)").run(seal(key, "token"));
  db.prepare("INSERT INTO domains(account_id,external_id,domain,status) VALUES(1,1,'shop.test','active')").run();
  db.close();

  const calls: string[] = [];
  const exec: HostingerExec = async (operation) => {
    calls.push(operation);
    if (operation === "domains_portfolio_list") return [{ id: 1, domain: "shop.test", status: "active" }];
    if (operation === "mail_orders_list") return [{ id: "mail-1", domain: { name: "shop.test" }, status: "active" }];
    if (operation === "mail_mailboxes_list") return [{ id: "box-1", address: "hello@shop.test", status: "active" }];
    throw new Error(`unexpected ${operation}`);
  };
  const pool = { forAccount: () => exec, close: async () => {}, closeAll: async () => [] };
  const workspace = createWorkspace({ userDir: root, key, dependencies: { hostingerPool: pool } });
  const entity = { kind: "company", name: "Shop LLC", address: "1 Main St", phone: "+1 555 0100", processingDays: [1, 3], transitDays: [5, 10] };
  const site = { domain: "shop.test", supportEmail: "hello@shop.test", categories: "mugs", count: 10, priceMin: null, priceMax: null, brand: "" };
  try {
    await assert.rejects(async () => workspace.handlers["batches.create"]({ entity, sites: [site, { ...site }] }), /重复/);
    assert.deepEqual(calls, [], "本地已知无效的表单不得查询 Hostinger");

    const result = await workspace.handlers["batches.create"]({ entity, sites: [site] }) as { batchId: number; siteIds: number[] };
    assert.equal(result.siteIds.length, 1);
  } finally {
    await workspace.close();
  }

  const saved = new DatabaseSync(join(root, "website-gen.sqlite"), { readOnly: true });
  try {
    const batch = saved.prepare("SELECT entity_json FROM batches").get() as { entity_json: string };
    const storedSite = saved.prepare("SELECT form_json FROM sites").get() as { form_json: string };
    assert.equal(JSON.parse(batch.entity_json).supportEmail, "auto");
    assert.equal(JSON.parse(storedSite.form_json).supportEmail, "hello@shop.test");
  } finally {
    saved.close();
    rmSync(root, { recursive: true, force: true });
  }
});
