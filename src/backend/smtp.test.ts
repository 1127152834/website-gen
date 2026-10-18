import { test } from "node:test";
import assert from "node:assert/strict";
import { siteSteps } from "./batches.ts";
import { siteContext } from "./pipeline.ts";
import { enableSmtp, resetMailboxPassword, saveMailboxPassword, sendTestEmail, smtpStatus } from "./smtp.ts";
import { deps, DOMAIN, EMAIL, fakeHostinger, fakeSite, key, runToEnd, setup } from "./testing.ts";
import { seal, unseal } from "./secrets.ts";
import { hasDefaultMailboxPassword, setDefaultMailboxPassword } from "./mail.ts";

function seedSiteMailbox(db: ReturnType<typeof setup>["db"], siteId: number, password = "Saved1!pass") {
  db.prepare("UPDATE sites SET mailbox_ciphertext=? WHERE id=?")
    .run(seal(key, JSON.stringify({ address: EMAIL, password })), siteId);
}

test("a selected existing mailbox with saved credentials sends order emails and confirms the test email", async () => {
  const { db, siteId } = setup();
  seedSiteMailbox(db, siteId);
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  const checked: string[] = [];
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  await runToEnd(deps(db, exec, fetchImpl, events, {
    inbox: async (creds, token) => {
      checked.push(creds.address);
      return wp.sentMails.some((m) => m.to === creds.address && m.subject.includes(token));
    },
  }), siteId);

  const mailbox = JSON.parse(unseal(key, (db.prepare("SELECT mailbox_ciphertext FROM sites WHERE id = ?").get(siteId) as { mailbox_ciphertext: Uint8Array }).mailbox_ciphertext));
  assert.deepEqual(wp.smtp, { host: "smtp.hostinger.com", port: 465, username: EMAIL, password: mailbox.password, from_email: EMAIL });
  assert.equal(wp.settings.woocommerce_email_from_address, EMAIL);
  assert.equal(wp.settings.woocommerce_email_from_name, "Nordicpaws");
  assert.deepEqual(wp.sentMails.map((m) => [m.to, m.viaSmtp]), [[EMAIL, true]]);
  assert.deepEqual(checked, [EMAIL]);
  const step = siteSteps(db, siteId).find((s) => s.key === "smtp")!;
  assert.equal(step.status, "done");
  assert.match(step.detail!, /已送达/);
  assert.ok(!JSON.stringify(events).includes(mailbox.password), "the mailbox password never reaches the log");
});

test("if the test email cannot be sent, SMTP is switched off so order emails still go out through the host", async () => {
  const { db, siteId } = setup();
  seedSiteMailbox(db, siteId);
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  wp.failSmtp = true;
  await runToEnd(deps(db, exec, fetchImpl, []), siteId);
  assert.equal(wp.smtp, null, "fell back to the default mailer");
  const step = siteSteps(db, siteId).find((s) => s.key === "smtp")!;
  assert.equal(step.status, "skipped");
  assert.match(step.detail!, /Could not authenticate/);
  const site = db.prepare("SELECT status, qa_json FROM sites WHERE id = ?").get(siteId) as { status: string; qa_json: string };
  assert.equal(site.status, "done");
  assert.equal((JSON.parse(site.qa_json) as { checks: { id: string; ok: boolean }[] }).checks.find((c) => c.id === "smtp")!.ok, false);
});

test("an existing mailbox needs its password first; a wrong password is rejected before anything is saved", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  const d = deps(db, exec, fetchImpl, []);
  await runToEnd(d, siteId);
  assert.match(siteSteps(db, siteId).find((s) => s.key === "smtp")!.detail!, /没有 support@nordicpaws\.com 的密码/);
  assert.equal(wp.smtp, null);

  const login = async (c: { password: string }) => {
    if (c.password !== "Right1!pass") throw new Error("[AUTHENTICATIONFAILED] Authentication failed.");
  };
  await assert.rejects(saveMailboxPassword(siteContext(d, siteId), "wrong", login), /登录 support@nordicpaws\.com 失败/);
  assert.equal((await smtpStatus(siteContext(d, siteId))).passwordSaved, false);

  await saveMailboxPassword(siteContext(d, siteId), "Right1!pass", login);
  const r = await enableSmtp(siteContext(d, siteId), async () => true);
  assert.equal(r.ok, true);
  assert.equal(wp.smtp!.password, "Right1!pass");
  assert.deepEqual(await smtpStatus(siteContext(d, siteId)), { enabled: true, host: "smtp.hostinger.com", username: EMAIL, passwordSaved: true });
});

test("a test email to another address is reported as sent; a missing delivery is reported, not hidden", async () => {
  const { db, siteId } = setup();
  seedSiteMailbox(db, siteId);
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  const d = deps(db, exec, fetchImpl, []);
  await runToEnd(d, siteId);

  const other = await sendTestEmail(siteContext(d, siteId), `owner@${DOMAIN}`, async () => true);
  assert.deepEqual([other.sent, other.delivered], [true, null]);
  assert.equal(wp.sentMails.at(-1)!.to, `owner@${DOMAIN}`);

  const lost = await sendTestEmail(siteContext(d, siteId), EMAIL, async () => false, { tries: 2, pauseMs: 0 });
  assert.deepEqual([lost.sent, lost.delivered], [true, false]);
  assert.match(lost.detail, /还没看到/);
});

test("an existing mailbox can get a new app-generated password; it is saved before the change and verified by logging in", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  const d = deps(db, exec, fakeSite(st).fetchImpl, []);
  await runToEnd(d, siteId);

  let attempts = 0;
  // Hostinger 改密码要几秒才生效：第一次登录失败，第二次成功
  const login = async (c: { password: string }) => {
    attempts++;
    const current = (st.mailboxes[0] as { password?: string }).password;
    if (attempts < 2 || c.password !== current) throw new Error("[AUTHENTICATIONFAILED]");
  };
  await resetMailboxPassword(siteContext(d, siteId), login, 0);
  const saved = JSON.parse(unseal(key, (db.prepare("SELECT mailbox_ciphertext FROM sites WHERE id = ?").get(siteId) as { mailbox_ciphertext: Uint8Array }).mailbox_ciphertext));
  assert.equal(saved.password, (st.mailboxes[0] as { password?: string }).password, "the saved password is the one Hostinger now has, even though the call returned 500");
  assert.match(saved.password, /^Aa1!/);
  assert.equal(attempts, 2);
});

test("an existing mailbox tries the configured default password once and reuses it when login succeeds", async () => {
  const { db, siteId } = setup();
  setDefaultMailboxPassword(db, key, "Default1!pass");
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  const tried: string[] = [];
  await runToEnd(deps(db, exec, fetchImpl, [], {
    login: async (creds) => { tried.push(creds.password); },
    inbox: async () => true,
  }), siteId);
  assert.deepEqual(tried, ["Default1!pass"]);
  const sealed = (db.prepare("SELECT mailbox_ciphertext FROM sites WHERE id = ?").get(siteId) as { mailbox_ciphertext: Uint8Array }).mailbox_ciphertext;
  assert.deepEqual(JSON.parse(unseal(key, sealed)), { address: EMAIL, password: "Default1!pass" });
  assert.equal(wp.smtp?.password, "Default1!pass");
  assert.equal(st.calls.includes("mail_mailboxes_create-mailbox"), false);
  assert.equal(st.calls.includes("mail_aliases_create-alias"), false);
  assert.equal(st.calls.includes("mail_mailboxes_change-mailbox-password"), false);
});

test("a rejected default password is tried once but never saved or followed by a remote mailbox write", async () => {
  const { db, siteId } = setup();
  setDefaultMailboxPassword(db, key, "Default1!pass");
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  const tried: string[] = [];
  await runToEnd(deps(db, exec, fetchImpl, [], {
    login: async (creds) => { tried.push(creds.password); throw new Error("[AUTHENTICATIONFAILED]"); },
  }), siteId);
  assert.deepEqual(tried, ["Default1!pass"]);
  const row = db.prepare("SELECT mailbox_ciphertext FROM sites WHERE id = ?").get(siteId) as { mailbox_ciphertext: Uint8Array | null };
  assert.equal(row.mailbox_ciphertext, null);
  assert.equal(wp.smtp, null);
  assert.equal(st.calls.includes("mail_mailboxes_create-mailbox"), false);
  assert.equal(st.calls.includes("mail_aliases_create-alias"), false);
  assert.equal(st.calls.includes("mail_mailboxes_change-mailbox-password"), false);
});

test("site provisioning reuses the exact cached mailbox credential that existed before the site", async () => {
  const { db, siteId } = setup({ cachedMailbox: { password: "Cached1!pass" } });
  const { st, exec } = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(st);
  await runToEnd(deps(db, exec, fetchImpl, [], { inbox: async () => true }), siteId);
  const sealed = (db.prepare("SELECT mailbox_ciphertext FROM sites WHERE id=?").get(siteId) as { mailbox_ciphertext: Uint8Array }).mailbox_ciphertext;
  assert.deepEqual(JSON.parse(unseal(key, sealed)), { address: EMAIL, password: "Cached1!pass" });
  assert.equal(wp.smtp?.password, "Cached1!pass");
  for (const operation of ["mail_mailboxes_create-mailbox", "mail_aliases_create-alias", "mail_mailboxes_change-mailbox-password"])
    assert.equal(st.calls.includes(operation), false, operation);
});

test("site provisioning never borrows cached credentials from another account or address", async () => {
  for (const cachedMailbox of [
    { accountId: 2, password: "Foreign1!pass" },
    { address: `owner@${DOMAIN}`, password: "Other1!pass" },
  ]) {
    const { db, siteId } = setup({ cachedMailbox });
    const { st, exec } = fakeHostinger();
    const { fetchImpl, wp } = fakeSite(st);
    await runToEnd(deps(db, exec, fetchImpl, []), siteId);
    const row = db.prepare("SELECT mailbox_ciphertext FROM sites WHERE id=?").get(siteId) as { mailbox_ciphertext: Uint8Array | null };
    assert.equal(row.mailbox_ciphertext, null);
    assert.equal(wp.smtp, null);
  }
});

test("a vanished mail order blocks provisioning before the website is created", async () => {
  const { db, siteId } = setup();
  const { st, exec } = fakeHostinger();
  st.mailOrders = [];
  await assert.rejects(runToEnd(deps(db, exec, fakeSite(st).fetchImpl, []), siteId), (error: Error) => error instanceof Error && /邮箱/.test(error.message));
  assert.equal(st.calls.includes("hosting_websites_start-setup"), false);
  assert.equal(st.calls.includes("mail_mailboxes_create-mailbox"), false);
});

test("the default mailbox password must meet Hostinger's rules", () => {
  const { db } = setup();
  for (const weak of ["short1!", "alllower1!", "NoDigits!!", "NoSpecial12"]) assert.throws(() => setDefaultMailboxPassword(db, key, weak), /至少 8 位/);
  setDefaultMailboxPassword(db, key, "Default1!pass");
  assert.equal(hasDefaultMailboxPassword(db), true);
  setDefaultMailboxPassword(db, key, null);
  assert.equal(hasDefaultMailboxPassword(db), false);
});
