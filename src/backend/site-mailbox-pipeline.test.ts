import assert from "node:assert/strict";
import test from "node:test";
import { PermanentError } from "./jobs.ts";
import { prepareExistingMailboxCredentials } from "./mail.ts";
import { provisionSite, siteContext } from "./pipeline.ts";
import { seal, unseal } from "./secrets.ts";
import { deps, DOMAIN, EMAIL, fakeHostinger, fakeSite, key, setup } from "./testing.ts";

function makeLegacyAfterPrecheck(emptyMailbox: boolean) {
  const { db, siteId } = setup();
  const row = db.prepare("SELECT form_json FROM sites WHERE id=?").get(siteId) as { form_json: string };
  const form = JSON.parse(row.form_json) as Record<string, unknown>;
  delete form.supportEmail;
  db.prepare("UPDATE sites SET form_json=?,account_id=1,order_id=1010129013 WHERE id=?").run(JSON.stringify(form), siteId);
  db.prepare("INSERT INTO provision_steps(site_id,step,status,detail,started_at,finished_at) VALUES(?,'precheck','done','legacy',0,1)").run(siteId);
  const remote = fakeHostinger();
  if (emptyMailbox) remote.st.mailboxes = [];
  return { db, siteId, ...remote };
}

test("旧任务即使 precheck 已完成，create_site 前没有实际邮箱仍永久阻断", async () => {
  const { db, siteId, st, exec } = makeLegacyAfterPrecheck(true);
  await assert.rejects(
    provisionSite(deps(db, exec, fakeSite(st).fetchImpl, []), siteId),
    (error: Error) => error instanceof PermanentError && /邮箱/.test(error.message),
  );
  assert.equal(st.calls.includes("hosting_websites_start-setup"), false);
});

test("旧任务缺站点邮箱时只采用唯一实际邮箱并补写，不限制前缀", async () => {
  const { db, siteId, st, exec } = makeLegacyAfterPrecheck(false);
  st.mailboxes = [{ id: "AC2", address: `hello@${DOMAIN}`, status: "active" }];
  await provisionSite(deps(db, exec, fakeSite(st).fetchImpl, []), siteId);
  const saved = db.prepare("SELECT form_json FROM sites WHERE id=?").get(siteId) as { form_json: string };
  assert.equal(JSON.parse(saved.form_json).supportEmail, `hello@${DOMAIN}`);
  assert.equal(st.calls.includes("hosting_websites_start-setup"), true);
});

test("站点旧地址凭据不会冒充当前邮箱，改为复用精确匹配的工作区凭据", async () => {
  const { db, siteId } = setup();
  const old = seal(key, JSON.stringify({ address: `old@${DOMAIN}`, password: "Old1!password" }));
  const current = seal(key, JSON.stringify({ address: EMAIL, password: "Current1!password" }));
  db.prepare("UPDATE sites SET account_id=1,mailbox_ciphertext=? WHERE id=?").run(old, siteId);
  db.prepare(`INSERT INTO mailboxes(account_id,order_id,remote_id,address,domain,status,credential_ciphertext)
    VALUES(1,'OR1','AC1',?,?, 'active',?)`).run(EMAIL, DOMAIN, current);
  const remote = fakeHostinger();
  const ctx = siteContext(deps(db, remote.exec, fakeSite(remote.st).fetchImpl, []), siteId);
  const result = await prepareExistingMailboxCredentials(ctx, { email: EMAIL, accountId: 1 });
  assert.equal(result.saved, true);
  assert.deepEqual(JSON.parse(unseal(key, ctx.site.mailbox_ciphertext!)), { address: EMAIL, password: "Current1!password" });
});

test("损坏的站点邮箱密文会被清除，绝不当作已验证凭据", async () => {
  const { db, siteId } = setup();
  db.prepare("UPDATE sites SET account_id=1,mailbox_ciphertext=X'0102' WHERE id=?").run(siteId);
  const remote = fakeHostinger();
  const ctx = siteContext(deps(db, remote.exec, fakeSite(remote.st).fetchImpl, []), siteId);
  const result = await prepareExistingMailboxCredentials(ctx, { email: EMAIL, accountId: 1 });
  assert.equal(result.saved, false);
  assert.equal(ctx.site.mailbox_ciphertext, null);
  assert.equal((db.prepare("SELECT mailbox_ciphertext FROM sites WHERE id=?").get(siteId) as { mailbox_ciphertext: Uint8Array | null }).mailbox_ciphertext, null);
});
