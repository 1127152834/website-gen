import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createWorkspace } from "./index.ts";
import { openDb } from "./db.ts";
import { qaView } from "./qa-view.ts";
import type { QaReport } from "./store.ts";
import type { QaView } from "../shared/protocol.ts";

const fixture = () => {
  const root = mkdtempSync(join(import.meta.dirname, "../../.phase3-backup/qa-view-"));
  const work = join(root, "work"); mkdirSync(join(work, "qa"), { recursive: true });
  const own = join(work, "qa", "page.png"), foreign = join(root, "foreign.png");
  writeFileSync(own, Buffer.from("89504e470d0a1a0a", "hex")); writeFileSync(foreign, "private");
  const issue = { id: "product-size", level: "P1" as const, kind: "product" as const, page: "Product", url: "https://example.com/product/1/", evidence: "27m", why: "Unverified measurement", fix: "Provide real dimensions", status: "needs_you" as const };
  const report: QaReport = { at: 123, checks: [], shots: [{ name: "own", file: own }, { name: "foreign", file: foreign }], review: { at: 123, rounds: 2, passed: false, issues: [{ ...issue, shot: own }, { ...issue, id: "foreign", shot: foreign }, { ...issue, id: "data-url", shot: "data:image/png;base64,cHJpdmF0ZQ==" }] } };
  return { root, work, report };
};

test("QA view converts own review screenshots and drops foreign paths and model-supplied data URLs", () => {
  const { work, report } = fixture(); const result = qaView(report, work);
  assert.equal(result.shots.length, 1); assert.match(result.shots[0].src, /^data:image\/png;base64,/);
  assert.equal(result.review?.rounds, 2); assert.equal(result.review?.passed, false);
  assert.match(result.review!.issues[0].shot!, /^data:image\/png;base64,/);
  assert.equal(result.review!.issues[1].shot, undefined); assert.equal(result.review!.issues[2].shot, undefined);
  assert.ok(!JSON.stringify(result).includes('"file":'));
});

test("sites.qa returns the fixed QaView contract including review, with per-workspace screenshot isolation", async () => {
  const { root, report } = fixture(); const workspace = createWorkspace({ userDir: root, key: randomBytes(32) });
  const db = openDb(join(root, "website-gen.sqlite"));
  try {
    db.prepare("INSERT INTO batches(entity_json,created_at) VALUES ('{}',0)").run();
    db.prepare("INSERT INTO sites(batch_id,domain,form_json,created_at,updated_at,qa_json) VALUES (1,'qa.example','{}',0,0,?)").run(JSON.stringify(report));
    const result = await workspace.handlers["sites.qa"]({ siteId: 1 }) as QaView;
    assert.equal(result.at, 123); assert.equal(result.review!.rounds, 2); assert.equal(result.review!.passed, false);
    assert.equal(result.review!.issues[0].status, "needs_you"); assert.match(result.review!.issues[0].shot!, /^data:image\/png;base64,/);
    assert.equal(result.shots.length, 1); assert.equal(result.review!.issues[1].shot, undefined);
  } finally { db.close(); await workspace.close(); }
});


test("QA view also renders a checkpoint containing only the in-progress review", () => {
  const { work, report } = fixture();
  const partial = qaView({ review: report.review } as QaReport, work);
  assert.equal(partial.at, 123); assert.deepEqual(partial.checks, []); assert.deepEqual(partial.shots, []);
  assert.equal(partial.review!.rounds, 2);
});

test("QA report presents underwriting results by severity and review theme", () => {
  const source = readFileSync(join(import.meta.dirname, "../renderer/src/pages/qa-report.tsx"), "utf8");
  assert.match(source, /商户网站审核（规则与 AI）/);
  assert.match(source, /config: "一致性与完整性"/);
  assert.match(source, /policy: "政策与法律一致性"/);
  assert.match(source, /product: "商品与合规"/);
  assert.match(source, /copy: "业务真实性与声明"/);
  assert.match(source, /visual: "品牌与视觉"/);
  assert.match(source, /\["P1", "P2", "P3"\]/);
  assert.match(source, /KIND_ORDER\.map/);
});
