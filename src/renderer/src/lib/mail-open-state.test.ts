import test from "node:test";
import assert from "node:assert/strict";
import { MailOpenState } from "./mail-open-state.ts";
import { mailSelectionRedirect } from "./mail-open-state.ts";

test("mobile mailbox selection stays on /mail instead of jumping back to the first mailbox", () => {
  assert.equal(mailSelectionRedirect(undefined, [1, 2]), null);
  assert.equal(mailSelectionRedirect(2, [1, 2]), null);
  assert.equal(mailSelectionRedirect(9, [1, 2]), "/mail");
});

test("mail list refresh cannot auto-mark the same open message after the user marks it unread", () => {
  const state = new MailOpenState();
  assert.equal(state.shouldAutoMark(4, "INBOX", 9, false), true);
  assert.equal(state.shouldAutoMark(4, "INBOX", 9, false), false);
  assert.equal(state.shouldAutoMark(4, "INBOX", 9, true), false);
  state.leaveMessage();
  assert.equal(state.shouldAutoMark(4, "INBOX", 9, false), true);
});

test("an already-read message is still recorded as the current distinct open message", () => {
  const state = new MailOpenState();
  assert.equal(state.shouldAutoMark(4, "INBOX", 9, true), false);
  assert.equal(state.shouldAutoMark(4, "INBOX", 9, false), false);
  assert.equal(state.shouldAutoMark(4, "INBOX", 10, false), true);
});
