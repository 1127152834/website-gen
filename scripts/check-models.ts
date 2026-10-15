// 用 .env 里的 DEEPSEEK_API_KEY 真实调用：两种格式的提供方各测一次，再按四个用途各发一次请求。数据只在内存数据库里。
// 用法：npm run check:models
import { randomBytes } from "node:crypto";
import { migrate, openDb } from "../src/backend/db.ts";
import { buildRuntime, listProviders, pingModel, ROLES, seedModelDefaults, setProviderKey } from "../src/backend/models.ts";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY missing in .env");

const db = openDb(":memory:");
migrate(db);
seedModelDefaults(db);
const key = randomBytes(32);
setProviderKey(db, key, listProviders(db)[0].id, apiKey);
const runtime = buildRuntime(db, key);

for (const p of listProviders(db)) {
  const model = runtime.models.getModel(`p${p.id}`, p.models[0].id)!;
  const r = await pingModel(runtime.models, model as Parameters<typeof pingModel>[1]);
  console.log(`✔ ${p.name} / ${model.id}: ${r.ms}ms reply="${r.reply}" $${r.cost.toFixed(5)}`);
}
for (const role of ROLES) {
  const { model, thinking } = runtime.resolve(role);
  const r = await pingModel(runtime.models, model);
  console.log(`✔ role ${role.padEnd(6)} → ${model.id} (${model.api}, thinking ${thinking}): ${r.ms}ms reply="${r.reply}"`);
}
