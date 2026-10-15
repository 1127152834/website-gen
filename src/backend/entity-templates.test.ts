import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, openDb } from "./db.ts";
import { listTemplates, removeTemplate, saveTemplate } from "./entity-templates.ts";
const entity = { kind: "company", name: "Example LLC", address: "1 Main St", phone: "+1 555 123 4567", supportEmail: "auto", processingDays: [1, 2], transitDays: [3, 7] };
test("entity templates validate, persist, update, remove and stay workspace-isolated", () => {
  const db = openDb(":memory:"), other = openDb(":memory:");
  try {
    migrate(db); migrate(other);
    assert.throws(() => saveTemplate(db, { name: "bad", entity: { ...entity, name: "" } }), /公司法定名称/);
    assert.throws(() => saveTemplate(db, { name: "bad", entity: { ...entity, processingDays: [] } }), /格式/);
    const [saved] = saveTemplate(db, { name: "主公司", entity }, 1);
    assert.equal(saved.entity.name, entity.name); assert.deepEqual(listTemplates(other), []);
    const updated = saveTemplate(db, { id: saved.id, name: "新名称", entity }, 2);
    assert.equal(updated.length, 1); assert.equal(updated[0].updatedAt, 2);
    assert.deepEqual(removeTemplate(db, saved.id), []);
  } finally { db.close(); other.close(); }
});
