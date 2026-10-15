import { test } from "node:test";
import assert from "node:assert/strict";
import { checkStyleProposal, contrastRatio, FALLBACK_STYLE, safeStyleProposal, toObelGlobalStyles, type AiStyleProposal } from "./style.ts";

const valid: AiStyleProposal = {
  palette: { base: "#FFFFFF", surface: "#F8F8F6", subtle: "#F0F1EE", text: "#222222", heading: "#111111", primary: "#194D3C", primaryText: "#FFFFFF", link: "#174C70", muted: "#535A57" },
  fonts: { heading: "Georgia, serif", body: "Arial, sans-serif" }, radius: 12, rationale: "Calm travel utility",
};

test("AI style passes only with 4.5:1 text contrast", () => {
  assert.ok(contrastRatio(valid.palette.text, valid.palette.base) >= 4.5);
  assert.deepEqual(checkStyleProposal(valid), []);
  assert.equal((toObelGlobalStyles(valid).styles.elements.button.border as { radius: string }).radius, "12px");
});

test("low contrast style falls back deterministically", () => {
  const bad = structuredClone(valid); bad.palette.text = "#AAAAAA"; bad.palette.link = "#BBBBBB"; bad.palette.muted = "#CCCCCC";
  const result = safeStyleProposal(bad);
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.style, FALLBACK_STYLE);
  assert.match(result.problems.join("\n"), /contrast/);
  assert.match(result.problems.join("\n"), /link contrast on surface/);
  assert.match(result.problems.join("\n"), /muted text contrast on subtle/);
});
