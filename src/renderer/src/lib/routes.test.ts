import { test } from "node:test";
import assert from "node:assert/strict";
import { positiveId, safeReturnTo, siteTabs } from "./route-params.ts";

test("TanStack detail routes share strict positive integer guards", () => {
  assert.equal(positiveId("12"), 12);
  assert.equal(positiveId(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  for (const value of ["0", "-1", "01", "1.2", "abc", String(Number.MAX_SAFE_INTEGER + 1)]) assert.throws(() => positiveId(value));
});

test("site detail route accepts only the five bookmarkable tabs", () => {
  assert.deepEqual(siteTabs, ["overview", "chat", "mail", "changes", "qa"]);
  for (const tab of ["overview", "chat", "mail", "changes", "qa"]) assert.equal(siteTabs.includes(tab as typeof siteTabs[number]), true);
  for (const tab of ["delete", "admin", "", "../qa"]) assert.equal(siteTabs.includes(tab as typeof siteTabs[number]), false);
});

test("authentication redirects preserve local bookmark URLs without creating login loops", () => {
  for (const path of ["/", "/sites/12/chat", "/batches/4", "/mail/7/Sent%20Messages/42", "/tables", "/settings#grist"]) assert.equal(safeReturnTo(path), path);
  for (const path of [undefined, "", "https://evil.test/", "//evil.test/", "/\n/evil.test", "/\t/evil.test", "/login?next=/sites", "/change-password", "/sites\\12\\chat"]) assert.equal(safeReturnTo(path), "/");
});
