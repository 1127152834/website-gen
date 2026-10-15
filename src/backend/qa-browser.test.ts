import test from "node:test";
import assert from "node:assert/strict";

test("QA tries configured Chromium, Windows Edge, then bundled Chromium", async () => {
  const { browserLaunchOptions } = await import("./qa-browser.ts");
  assert.deepEqual(browserLaunchOptions("linux", undefined), [{ headless: true }]);
  assert.deepEqual(browserLaunchOptions("win32", undefined), [{ headless: true, channel: "msedge" }, { headless: true }]);
  assert.deepEqual(browserLaunchOptions("linux", "/opt/chromium"), [{ headless: true, executablePath: "/opt/chromium" }, { headless: true }]);
});

test("browser crawl captures every requested page, cart/checkout and mobile home with full-page screenshots", async () => {
  const { browseWithLauncher } = await import("./qa-browser.ts");
  let current = "", clears = 0;
  const screenshots: { path: string; fullPage: boolean }[] = [], viewports: { width: number; height: number }[] = [];
  const page = {
    goto: async (url: string) => { current = url; return { status: () => 200 }; },
    waitForLoadState: async () => {},
    getByText: () => ({ first: () => ({ waitFor: async () => {} }) }),
    locator: (selector: string) => selector === "body"
      ? { innerText: async () => `Visible body for ${current}` }
      : { first: () => ({ count: async () => 0, click: async () => {} }) },
    screenshot: async (options: { path: string; fullPage: boolean }) => { screenshots.push(options); },
    url: () => current,
    evaluate: async () => { clears++; return true; },
    waitForTimeout: async () => {},
    setViewportSize: async (viewport: { width: number; height: number }) => { viewports.push(viewport); },
  };
  let closed = false;
  const result = await browseWithLauncher({
    loginUrl: "https://login.test/once", origin: "https://shop.test", outDir: `${process.cwd()}/.phase3-backup/test-tmp/browser-crawl`,
    pages: [{ name: "home", path: "/" }, { name: "product-1", path: "/product/one/" }],
    cart: { addPath: "/?add-to-cart=1", expect: "Product One" },
  }, async () => ({ newPage: async () => page, close: async () => { closed = true; } }));
  assert.deepEqual(result.captures?.map((x) => x.name), ["home", "product-1", "cart", "checkout", "home-mobile"]);
  assert(result.captures?.every((x) => x.text.startsWith("Visible body for ")));
  assert.equal(screenshots.length, 5);
  assert(screenshots.every((x) => x.fullPage));
  assert.deepEqual(viewports, [{ width: 390, height: 844 }]);
  assert.equal(clears, 2, "cart is cleared before and after checkout review");
  assert.equal(closed, true);
});
