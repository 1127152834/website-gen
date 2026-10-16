import test from "node:test";
import assert from "node:assert/strict";
import { isValidMailAddressList, normalizeMailAddress, splitMailAddresses } from "./mail-form.ts";

test("邮件地址列表接受显示名和中英文分隔习惯，并保持 RPC 地址数组", () => {
  assert.equal(isValidMailAddressList("Alice <alice@example.com>, bob@example.cn", true), true);
  assert.deepEqual(splitMailAddresses("Alice <alice@example.com>; bob@example.cn"), ["alice@example.com", "bob@example.cn"]);
  assert.deepEqual(splitMailAddresses('"Doe, Alice" <alice@example.com>, bob@example.cn'), ["alice@example.com", "bob@example.cn"]);
  assert.equal(normalizeMailAddress("客服 <support@example.test>"), "support@example.test");
});

test("邮件地址列表拒绝垃圾文本、缺少域名和混入的无效地址", () => {
  for (const value of ["garbage", "foo@", "@example.com", "a@example.com, bad", "a@example.com; victim@localhost", "a..b@example.com", "a@example..com", "a@-example.com", "a@example-.com"]) {
    assert.equal(isValidMailAddressList(value, true), false, value);
  }
  assert.equal(isValidMailAddressList("", true), false);
  assert.equal(isValidMailAddressList("", false), true);
});
