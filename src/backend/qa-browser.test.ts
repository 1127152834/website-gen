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
      ? { evaluate: async () => ({ header: "", footer: "", body: `Visible body for ${current}` }) }
      : selector === "a[href]" ? { evaluateAll: async () => [{ url: "https://shop.test/product/one/", text: "Product One", location: "body" }] }
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
  assert(result.captures?.every((x) => x.productLinks?.[0] === "https://shop.test/product/one/"));
  assert(result.captures?.every((x) => x.sections?.body.startsWith("Visible body for ")));
  assert(result.captures?.every((x) => x.links?.[0]?.location === "body"));
  assert(result.captures?.every((x) => x.status === 200));
  assert.equal(screenshots.length, 5);
  assert(screenshots.every((x) => x.fullPage));
  assert.deepEqual(viewports, [{ width: 390, height: 844 }]);
  assert.equal(clears, 2, "cart is cleared before and after checkout review");
  assert.equal(closed, true);
});

test("underwriting link audit GETs discovered safe internal links and deduplicates equivalent URLs", async () => {
  const { browseWithLauncher } = await import("./qa-browser.ts");
  let current = "";
  const requested: string[] = [];
  const links = [
    { url: "https://shop.test/about/", text: "About", location: "footer" },
    { url: "https://shop.test/about/#team", text: "About us", location: "body" },
    { url: "https://shop.test/about?utm_source=footer", text: "Tracked about", location: "footer" },
    { url: "https://shop.test/missing/", text: "Missing", location: "body" },
    { url: "https://shop.test/about/?broken=1", text: "Broken query", location: "body" },
    { url: "https://shop.test/jump/", text: "Safe redirect", location: "body" },
    { url: "https://shop.test/unsafe-jump/", text: "External redirect", location: "body" },
    { url: "https://shop.test/file.pdf", text: "PDF", location: "body" },
    { url: "https://shop.test/cart/", text: "Cart", location: "header" },
    { url: "https://shop.test/?add-to-cart=12", text: "Buy", location: "body" },
    { url: "https://other.test/about/", text: "Other", location: "body" },
  ];
  const page = {
    goto: async (url: string) => { current = url; return { status: () => url.endsWith("/about/") ? 503 : 200 }; },
    waitForLoadState: async () => {},
    getByText: () => ({ first: () => ({ waitFor: async () => {} }) }),
    locator: (selector: string) => selector === "body"
      ? { evaluate: async () => ({ header: "Store", footer: "About", body: "Page body" }) }
      : selector === "a[href]" ? { evaluateAll: async () => links }
      : { first: () => ({ count: async () => 0, click: async () => {} }) },
    screenshot: async () => {},
    url: () => current,
    request: { get: async (url: string, options: Record<string, unknown>) => {
      requested.push(url);
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.failOnStatusCode, false);
      if (url.endsWith("/jump/")) return { status: () => 302, headers: () => ({ location: "/final/" }) };
      if (url.endsWith("/unsafe-jump/")) return { status: () => 302, headers: () => ({ location: "https://other.test/landing/" }) };
      return { status: () => url.endsWith("/final/") ? 204 : url.includes("missing") || url.includes("broken=1") || url.includes("utm_source") ? 404 : 200, headers: () => ({}) };
    } },
    setViewportSize: async () => {},
  };
  const result = await browseWithLauncher({
    loginUrl: "https://login.test/once", origin: "https://shop.test", outDir: `${process.cwd()}/.phase3-backup/test-tmp/browser-audit`,
    pages: [{ name: "home", path: "/" }, { name: "about", path: "/about/" }, { name: "cart-page", path: "/cart/" }],
    auditInternalLinks: true,
  }, async () => ({ newPage: async () => page, close: async () => {} }));

  assert.deepEqual(requested, ["https://shop.test/about/", "https://shop.test/about?utm_source=footer", "https://shop.test/missing/", "https://shop.test/about/?broken=1", "https://shop.test/jump/", "https://shop.test/unsafe-jump/", "https://shop.test/final/"]);
  assert.equal(result.problems.length, 0, "HTTP failures are structured capture data during underwriting review");
  assert.equal(result.captures?.find((capture) => capture.name === "about")?.status, 503);
  assert.deepEqual(result.captures?.[0].linkStatuses, [
    { url: "https://shop.test/about/", status: 200 },
    { url: "https://shop.test/about?utm_source=footer", status: 404 },
    { url: "https://shop.test/missing/", status: 404 },
    { url: "https://shop.test/about/?broken=1", status: 404 },
    { url: "https://shop.test/jump/", status: 204 },
    { url: "https://shop.test/unsafe-jump/", status: 302 },
  ]);
  assert(result.captures?.every((capture) => capture.linkStatuses?.every((link) => !/cart|add-to-cart/.test(link.url))));
  assert(requested.every((url) => !/cart|add-to-cart|file\.pdf|other\.test/.test(url)));
});

test("fake browser supplies realistic page sections, footer links and broken canonical-link status", async () => {
  const { fakeBrowse, fakeHostinger, fakeSite, DOMAIN } = await import("./testing.ts");
  const hostinger = fakeHostinger();
  const { fetchImpl, wp } = fakeSite(hostinger.st);
  wp.options.blogname = "Nordic Paws";
  wp.info = { entity: "Nordic Paws LLC", address: "7428 Harbor Avenue, Portland, OR 97205", email: `support@${DOMAIN}`, phone: "+1 503 555 0198" };
  wp.pages.set(100, { id: 100, slug: "home", title: "Home", content: `<p>First paragraph.</p><p>Second paragraph with <a href="/missing/">missing page</a>.</p>`, status: "publish" });
  wp.pages.set(101, { id: 101, slug: "about", title: "About", content: "<p>About Nordic Paws LLC.</p>", status: "publish" });
  const browse = fakeBrowse(fetchImpl);
  const result = await browse({
    loginUrl: "https://unused.test", origin: `https://${DOMAIN}`, outDir: `${process.cwd()}/.phase3-backup/test-tmp/fake-browser`,
    pages: [{ name: "home", path: "/" }, { name: "missing", path: "/missing/" }], auditInternalLinks: true,
  });
  const home = result.captures?.find((capture) => capture.name === "home");
  assert.match(home?.sections?.body ?? "", /First paragraph\.\nSecond paragraph/);
  assert.match(home?.sections?.footer ?? "", /Nordic Paws LLC\n7428 Harbor Avenue/);
  assert(home?.links?.some((link) => link.location === "footer" && link.url === `https://${DOMAIN}/about/`));
  assert(home?.linkStatuses?.some((link) => link.url === `https://${DOMAIN}/missing/` && link.status === 404), "discovered links are audited even when absent from input.pages");
  assert.equal(result.captures?.find((capture) => capture.name === "missing")?.status, 404);
});
