import test from "node:test";
import assert from "node:assert/strict";
import { MailOpenState } from "./mail-open-state.ts";
import { folderUnread, mailSelectionRedirect } from "./mail-open-state.ts";

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

// 实测 2026-10-15：左侧邮箱显示 3、收件箱文件夹显示 2——打开邮件自动标已读后文件夹数没刷新，且文件夹数要等 IMAP 列表才更新
test("the INBOX folder shows the same unread count as the mailbox, other folders keep their own", () => {
  const mailbox = { unreadCount: 3 };
  assert.equal(folderUnread({ path: "INBOX", unread: 2 }, mailbox), 3);
  assert.equal(folderUnread({ path: "inbox", unread: 2 }, mailbox), 3);
  assert.equal(folderUnread({ path: "INBOX.Sent", unread: 1 }, mailbox), 1);
  assert.equal(folderUnread({ path: "INBOX", unread: 2 }, null), 2);
});
