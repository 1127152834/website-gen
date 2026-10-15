import type { DatabaseSync } from "node:sqlite";
import { validateBatch, type EntityForm } from "../shared/forms.ts";

interface Template { id: number; name: string; entity: EntityForm; updatedAt: number }
export function listTemplates(db: DatabaseSync): Template[] {
  return (db.prepare("SELECT id,name,payload_json,updated_at FROM entity_templates ORDER BY updated_at DESC,id DESC").all() as { id: number; name: string; payload_json: string; updated_at: number }[])
    .map((row) => ({ id: row.id, name: row.name, entity: JSON.parse(row.payload_json) as EntityForm, updatedAt: row.updated_at }));
}
export function saveTemplate(db: DatabaseSync, value: unknown, now = Date.now()): Template[] {
  const input = value as { id?: number; name?: string; entity?: EntityForm };
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) throw new Error("请填写模板名称（最多 100 字）");
  if (input.id != null && (!Number.isSafeInteger(input.id) || input.id <= 0)) throw new Error("模板编号不正确");
  const entity = input.entity;
  if (!entity || !["company", "individual"].includes(entity.kind) || ![entity.name, entity.address, entity.supportEmail, entity.phone].every((field) => typeof field === "string") || !Array.isArray(entity.processingDays) || !Array.isArray(entity.transitDays) || entity.processingDays.length !== 2 || entity.transitDays.length !== 2) throw new Error("经营主体格式不正确");
  const errors = validateBatch({ entity, sites: [] });
  const problem = Object.entries(errors).find(([field]) => field.startsWith("entity."));
  if (problem) throw new Error(problem[1]);
  // 只保存允许的字段，拒绝把任意请求数据塞进模板。
  const clean: EntityForm = { kind: entity.kind, name: entity.name.trim(), address: entity.address.trim(), supportEmail: entity.supportEmail.trim(), phone: entity.phone.trim(), processingDays: entity.processingDays, transitDays: entity.transitDays };
  if (input.id != null) {
    const result = db.prepare("UPDATE entity_templates SET name=?,payload_json=?,updated_at=? WHERE id=?").run(input.name.trim(), JSON.stringify(clean), now, input.id);
    if (!result.changes) throw new Error("模板不存在");
  } else db.prepare("INSERT INTO entity_templates(name,payload_json,created_at,updated_at) VALUES(?,?,?,?)").run(input.name.trim(), JSON.stringify(clean), now, now);
  return listTemplates(db);
}
export function removeTemplate(db: DatabaseSync, id: number): Template[] {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("模板编号不正确");
  db.prepare("DELETE FROM entity_templates WHERE id=?").run(id);
  return listTemplates(db);
}
