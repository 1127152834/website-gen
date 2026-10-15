import test from "node:test";
import assert from "node:assert/strict";

test("QA tries configured Chromium, Windows Edge, then bundled Chromium", async () => {
  const { browserLaunchOptions } = await import("./qa-browser.ts");
  assert.deepEqual(browserLaunchOptions("linux", undefined), [{ headless: true }]);
  assert.deepEqual(browserLaunchOptions("win32", undefined), [{ headless: true, channel: "msedge" }, { headless: true }]);
  assert.deepEqual(browserLaunchOptions("linux", "/opt/chromium"), [{ headless: true, executablePath: "/opt/chromium" }, { headless: true }]);
});
