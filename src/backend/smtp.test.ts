import { test } from "node:test";
import assert from "node:assert/strict";
import { siteSteps } from "./batches.ts";
import { siteContext } from "./pipeline.ts";
import { enableSmtp, resetMailboxPassword, saveMailboxPassword, sendTestEmail, smtpStatus } from "./smtp.ts";
import { deps, DOMAIN, EMAIL, fakeHostinger, fakeSite, key, runToEnd, setup } from "./testing.ts";
import { unseal } from "./secrets.ts";

test("a new site sends its order emails through the support mailbox, and the test email is confirmed in the inbox", async () => {
  const { db, siteId } = setup();
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
  st.mailboxes.push({ id: "AC9", address: EMAIL, status: "active" });
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
  st.mailboxes.push({ id: "AC9", address: EMAIL, status: "active" });
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
