import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
const component = readFileSync(new URL("./global-assistant.tsx", import.meta.url), "utf8");

test("assistant motion is explicitly disabled for reduced-motion users", () => {
  const media = css.match(/@media \(prefers-reduced-motion: reduce\) \{([^}]|\}(?!\s*$))+/)?.[0] ?? "";
  assert.match(media, /animation-name:\s*none\s*!important/);
  assert.match(media, /transition-duration:\s*0\.01ms\s*!important/);
});

test("assistant panel minimum height remains bounded by the live viewport", () => {
  assert.match(css, /min-height:\s*min\(26rem, calc\(100dvh - 8rem\)\)/);
  assert.match(css, /min-height:\s*min\(22rem, calc\(100dvh - 6\.25rem\)\)/);
});

test("assistant example questions send immediately through the shared send path", () => {
  assert.match(component, /EXAMPLES\.map\(\(example\) =>[\s\S]*?onClick=\{\(\) => void send\(example\)\}/);
  assert.doesNotMatch(component, /EXAMPLES\.map\(\(example\) =>[\s\S]*?onClick=\{\(\) => setDraft\(example\)\}/);
});
