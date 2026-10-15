import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureBranding, fallbackBrandSvgs, renderBrandSvgPng, sanitizeBrandSvg, type BrandingRecord } from "./branding.ts";
import { FALLBACK_STYLE } from "./style.ts";

const wordmark = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160" viewBox="0 0 600 160"><rect width="48" height="48" x="20" y="56" rx="8" fill="#1F4B3F"/><text x="88" y="96" fill="#1F4B3F" font-family="Georgia, serif" font-size="48">North Star</text></svg>`;

test("SVG sanitizer accepts a safe, high-contrast wordmark", () => {
  assert.equal(sanitizeBrandSvg(wordmark, { brand: "North Star", style: FALLBACK_STYLE, kind: "logo" }), wordmark);
});

test("SVG sanitizer rejects scripts, handlers, external references and oversized input", () => {
  const input = { brand: "North Star", style: FALLBACK_STYLE, kind: "logo" as const };
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("</svg>", "<script>alert(1)</script></svg>"), input), /element|script/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("<text ", "<text onclick=\"alert(1)\" "), input), /attribute|event/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("<text ", "<text href=\"https:\/\/evil.test\/x\" "), input), /reference|href/i);
  assert.throws(() => sanitizeBrandSvg(wordmark + " ".repeat(70_000), input), /64 KiB/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replaceAll("#1F4B3F", "#F8F8F6"), input), /contrast/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("#1F4B3F", "u&#114;l(https://evil.test/x)"), input), /paint|entit/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("#1F4B3F", "\\75rl(https://evil.test/x)"), input), /paint|escape/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("<text ", "<g opacity=\"0\"><text ").replace("</text>", "</text></g>"), input), /attribute|opacity/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("<text ", "<defs><text ").replace("</text>", "</text></defs>"), input), /defs|child/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace('font-size="48"', 'font-size="0"'), input), /font-size/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace('x="88"', 'x="888"'), input), /canvas/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("</svg>", '<rect x="0" y="0" width="600" height="160" fill="#FFFFFF"/></svg>'), input), /after.*text|cover/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("North Star", "North Star Outlet"), input), /exact/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace('<rect width="48" height="48" x="20" y="56" rx="8" fill="#1F4B3F"/>', '<rect width="600" height="160" x="0" y="0" fill="#FFFFFF"/>'), input), /mark|120|full/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace('x="20"', 'x="70"'), input), /overlap/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace('<rect width="48" height="48" x="20" y="56" rx="8" fill="#1F4B3F"/>', '<path d="M0 0h20v20z" fill="#1F4B3F"/>'), input), /path|bounded/i);
});

test("SVG sanitizer requires exact asset geometry, chosen colors and icon-background contrast", () => {
  const logoInput = { brand: "North Star", style: FALLBACK_STYLE, kind: "logo" as const };
  assert.throws(() => sanitizeBrandSvg(wordmark.replace('width="600"', 'width="601"'), logoInput), /600x160/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace('viewBox="0 0 600 160"', 'viewBox="0 0 0 160"'), logoInput), /viewBox/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("#1F4B3F", "#123456"), logoInput), /palette/i);
  const icon = fallbackBrandSvgs("North Star", FALLBACK_STYLE).iconSvg;
  assert.equal(sanitizeBrandSvg(icon, { ...logoInput, kind: "icon" }), icon);
  assert.throws(() => sanitizeBrandSvg(icon.replace('fill="#1F4B3F"', 'fill="#F8F8F6"'), { ...logoInput, kind: "icon" }), /contrast/i);
  assert.throws(() => sanitizeBrandSvg(icon.replace('width="512" height="512" rx="96"', 'width="400" height="400" rx="96"'), { ...logoInput, kind: "icon" }), /full-canvas/i);
});

test("fallback wordmark shrinks long brand names to stay inside the canvas", () => {
  const brand = "North Star Outdoor Adventure Supply Company With An Extraordinarily Long Name";
  const { logoSvg } = fallbackBrandSvgs(brand, FALLBACK_STYLE);
  const size = Number(/font-size="([\d.]+)"/.exec(logoSvg)?.[1]);
  assert(size < 18 && size > 0);
  assert.equal(sanitizeBrandSvg(logoSvg, { brand, style: FALLBACK_STYLE, kind: "logo" }), logoSvg);
});

test("SVG content model rejects nested canvases, gradient text, offsets and clipped baselines", () => {
  const input = { brand: "North Star", style: FALLBACK_STYLE, kind: "logo" as const };
  const nested = wordmark.replace("<text ", '<svg width="1" height="1" viewBox="0 0 1 1"><text ').replace("</text>", "</text></svg>");
  assert.throws(() => sanitizeBrandSvg(nested, input), /nested|root|parent/i);
  const gradientText = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160" viewBox="0 0 600 160"><defs><linearGradient id="g"><text x="24" y="100" fill="#1F4B3F" font-family="Georgia, serif" font-size="48">North Star</text></linearGradient></defs></svg>`;
  assert.throws(() => sanitizeBrandSvg(gradientText, input), /text|parent|defs/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("<text ", '<text dy="9999" '), input), /attribute|dy/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace('y="96"', 'y="0"'), input), /clip|canvas/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("North Star", '<tspan x="0" y="0">North Star</tspan>'), input), /tspan|position/i);
  assert.throws(() => sanitizeBrandSvg(wordmark.replace("North Star", '<tspan dominant-baseline="hanging">North Star</tspan>'), input), /tspan|position/i);
});

test("PNG renderer blocks page network, uses exact size and closes the browser", async () => {
  const calls: string[] = [];
  let viewport: unknown;
  const page = {
    route: async (pattern: string, handler: (route: { abort: () => Promise<void> }) => Promise<void>) => {
      calls.push(`route:${pattern}`);
      await handler({ abort: async () => { calls.push("abort"); } });
    },
    setContent: async () => { calls.push("content"); },
    locator: () => ({ screenshot: async (options: unknown) => { calls.push(`shot:${JSON.stringify(options)}`); return Buffer.from("png"); } }),
  };
  const browser = {
    newPage: async (options: { viewport: unknown }) => { viewport = options.viewport; return page; },
    close: async () => { calls.push("close"); },
  };
  const png = await renderBrandSvgPng(wordmark, "logo", async () => browser as never);
  assert.deepEqual(viewport, { width: 600, height: 160 });
  assert.equal(png.toString(), "png");
  assert.deepEqual(calls.slice(0, 3), ["route:**/*", "abort", "content"]);
  assert.equal(calls.at(-1), "close");

  let closedAfterFailure = false;
  const failingBrowser = {
    newPage: async () => ({ route: async () => {}, setContent: async () => { throw new Error("render failed"); } }),
    close: async () => { closedAfterFailure = true; },
  };
  await assert.rejects(renderBrandSvgPng(wordmark, "icon", async () => failingBrowser as never), /render failed/);
  assert.equal(closedAfterFailure, true);
});

test("two invalid AI replies use deterministic fallback artwork", async () => {
  let aiCalls = 0;
  const uploaded: string[] = [];
  const saved: BrandingRecord[] = [];
  const result = await ensureBranding({
    brand: "North Star",
    style: FALLBACK_STYLE,
    ai: async () => { aiCalls++; return { text: '{"logoSvg":"<svg><script/></svg>","iconSvg":"bad"}', cost: 0 }; },
    render: async (_svg, kind) => Buffer.from(kind),
    upload: async (kind) => { uploaded.push(kind); return kind === "logo" ? 41 : 42; },
    install: async () => {},
    save: async (record) => { saved.push(structuredClone(record)); },
  });
  assert.equal(aiCalls, 2);
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(uploaded, ["logo", "icon"]);
  assert.deepEqual([result.logoMediaId, result.iconMediaId, result.installed], [41, 42, true]);
  assert.deepEqual({ logoSvg: result.logoSvg, iconSvg: result.iconSvg }, fallbackBrandSvgs("North Star", FALLBACK_STYLE));
  assert.ok(saved.some((record) => record.logoMediaId === 41 && record.iconMediaId === undefined));
});

test("completed generated branding is idempotent", async () => {
  const existing: BrandingRecord = {
    generator: "website-gen",
    version: 1,
    logoSvg: fallbackBrandSvgs("North Star", FALLBACK_STYLE).logoSvg,
    iconSvg: fallbackBrandSvgs("North Star", FALLBACK_STYLE).iconSvg,
    logoMediaId: 41,
    iconMediaId: 42,
    installed: true,
    fallbackUsed: false,
  };
  let calls = 0;
  const result = await ensureBranding({
    brand: "North Star", style: FALLBACK_STYLE, existing,
    ai: async () => { calls++; throw new Error("must not run"); },
    render: async () => { calls++; throw new Error("must not run"); },
    upload: async () => { calls++; throw new Error("must not run"); },
    install: async () => { calls++; },
    save: async () => { calls++; },
  });
  assert.equal(result, existing);
  assert.equal(calls, 0);
});

test("partial generated branding resumes from the missing upload", async () => {
  const art = fallbackBrandSvgs("North Star", FALLBACK_STYLE);
  const existing: BrandingRecord = { generator: "website-gen", version: 1, ...art, logoMediaId: 41, fallbackUsed: true };
  const uploaded: string[] = [];
  const result = await ensureBranding({
    brand: "North Star", style: FALLBACK_STYLE, existing,
    ai: async () => { throw new Error("must not run"); },
    render: async (_svg, kind) => Buffer.from(kind),
    upload: async (kind) => { uploaded.push(kind); return 42; },
    install: async () => {}, save: async () => {},
  });
  assert.deepEqual(uploaded, ["icon"]);
  assert.equal(result.installed, true);
});
