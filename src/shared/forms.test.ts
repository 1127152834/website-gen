import { test } from "node:test";
import assert from "node:assert/strict";
import { brandFromDomain, validateBatch, type BatchForm } from "./forms.ts";

const valid = (): BatchForm => ({
  entity: { kind: "company", name: "Nordic Paws LLC", address: "1 Main St, Austin, TX", supportEmail: "auto", phone: "+1 512 555 0100", processingDays: [1, 3], transitDays: [5, 10] },
  sites: [{ domain: "nordicpaws.com", categories: "dog beds", count: 20, priceMin: 19, priceMax: 79, brand: "" }],
});

test("a complete form has no errors", () => {
  assert.deepEqual(validateBatch(valid()), {});
});

test("required fields, email, count and price range are checked per field", () => {
  const f = valid();
  f.entity.name = " ";
  f.entity.supportEmail = "not-an-email";
  f.entity.transitDays = [10, 5];
  f.sites.push({ domain: "", categories: "", count: 0, priceMin: 80, priceMax: 20, brand: "" });
  const errors = validateBatch(f);
  assert.deepEqual(Object.keys(errors).sort(), ["entity.name", "entity.shipping", "entity.supportEmail", "sites.1.categories", "sites.1.count", "sites.1.domain", "sites.1.price"].sort());
});

test("the same domain cannot appear twice in one batch", () => {
  const f = valid();
  f.sites.push({ ...f.sites[0] });
  assert.ok(validateBatch(f)["sites.1.domain"]);
});

test("brandFromDomain turns a domain into a readable name", () => {
  assert.equal(brandFromDomain("nordicpaws.com"), "Nordicpaws");
  assert.equal(brandFromDomain("glow-lab.store"), "Glow Lab");
});
