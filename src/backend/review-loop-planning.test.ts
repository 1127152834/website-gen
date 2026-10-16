import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runReviewLoop, type ReviewFinding, type ReviewSnapshot } from "./review.ts";

test("review loop plans actionless open findings, never plans needs_you, and persists rounds before writes", async () => {
  const snapshot = { targets: [], captures: [{ name: "bed", path: "/product/bed/", url: "https://shop.test/product/bed/", text: "Bed", shot: "bed.png" }], products: [], categories: [], sourceFacts: [], spec: {}, config: {} } satisfies ReviewSnapshot;
  const finding = (id: string, needs: boolean): ReviewFinding => ({ issue: { id, kind: "product", level: "P2", page: "Bed", url: snapshot.captures[0].url, evidence: "Main image has a barcode collage", why: "Wrong product image", fix: "Select a clean product photo", status: needs ? "needs_you" : "open" }, needsRealData: needs });
  let collects = 0, planned = 0, written = 0, persisted = 0;
  const review = await runReviewLoop({
    now: () => 1, collect: async () => { collects++; return snapshot; },
    inspect: async () => collects === 1 ? [finding("image", false), finding("facts", true)] : [finding("facts", true)],
    plan: async (f, s) => { planned++; assert.equal(f.issue.id, "image"); assert.equal(s, snapshot); return { tool: "update_product_main_image", params: { id: 1, image_id: 2, summary: "主图" } }; },
    apply: async () => { assert.equal(persisted, 1); written++; return true; },
    persist: (r) => { persisted = r.rounds; },
  });
  assert.equal(planned, 1); assert.equal(written, 1); assert.equal(collects, 2); assert.equal(review.rounds, 1);
  assert.equal(review.issues.find((i) => i.id === "facts")?.status, "needs_you");
  let replanned = false;
  await runReviewLoop({ now: () => 1, collect: async () => snapshot, inspect: async () => [finding("image", false)], previous: { ...review, rounds: 2 }, plan: async () => { replanned = true; return undefined; }, apply: async () => { throw new Error("round limit bypassed"); } });
  assert.equal(replanned, false);
});

test("a fresh model reply cannot remove a historical needs_you gate without changed facts", async () => {
  const snapshot = { targets: [], captures: [{ name: "bed", path: "/product/bed/", url: "https://shop.test/product/bed/", text: "Bed", shot: "bed.png" }], products: [], categories: [], sourceFacts: [], spec: {}, config: {} } satisfies ReviewSnapshot;
  const old: ReviewFinding = { issue: { id: "facts", kind: "product", level: "P2", page: "Bed", url: snapshot.captures[0].url, evidence: "Product contents need source confirmation", why: "No proof", fix: "Obtain verified facts", status: "needs_you" }, needsRealData: true };
  const previous = { at: 0, rounds: 0, passed: true, issues: [old.issue] };
  const hash = createHash("sha256").update(JSON.stringify(snapshot.sourceFacts)).digest("hex");
  let plans = 0, writes = 0;
  const fresh = (): ReviewFinding => ({ ...old, issue: { ...old.issue, status: "open" }, needsRealData: false, action: { tool: "update_product", params: { id: 1, name: "Bed", summary: "修复" } } });
  const review = await runReviewLoop({ now: () => 1, previous, previousFactsHash: hash, collect: async () => snapshot, inspect: async () => [fresh()], plan: async () => { plans++; return undefined; }, apply: async () => { writes++; return true; } });
  assert.equal(plans, 0); assert.equal(writes, 0); assert.equal(review.rounds, 0); assert.equal(review.issues[0].status, "needs_you");
  let inspections = 0;
  const changed = { ...snapshot, sourceFacts: [{ verified: true }] };
  const updated = await runReviewLoop({ now: () => 1, previous, previousFactsHash: hash, collect: async () => changed, inspect: async () => inspections++ === 0 ? [fresh()] : [], plan: async () => { plans++; return undefined; }, apply: async () => { writes++; return true; } });
  assert.equal(plans, 1); assert.equal(writes, 1); assert.equal(updated.rounds, 1); assert.equal(updated.issues[0].status, "fixed");
});
