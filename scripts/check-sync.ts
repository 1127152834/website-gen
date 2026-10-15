// 用 .env 里的 HOSTINGER_TOKEN_MAIN 跑一遍真实的「添加账号 + 同步」（只读接口），数据只放在内存数据库里。
// 用法：npm run check:sync
import { randomBytes } from "node:crypto";
import { addAccount, listAccounts, listDomains, syncAccount } from "../src/backend/accounts.ts";
import { migrate, openDb } from "../src/backend/db.ts";
import { createHostingerPool } from "../src/backend/hostinger.ts";

const token = process.env.HOSTINGER_TOKEN_MAIN;
if (!token) throw new Error("HOSTINGER_TOKEN_MAIN missing in .env");

const db = openDb(":memory:");
migrate(db);
const pool = createHostingerPool();
try {
  const t0 = performance.now();
  const id = await addAccount(db, randomBytes(32), { label: "主账号", token }, pool.forAccount(1, token));
  console.log(`✔ token verified (${Math.round(performance.now() - t0)}ms)`);
  const t1 = performance.now();
  const counts = await syncAccount(db, id, pool.forAccount(1, token));
  console.log(`✔ synced in ${Math.round(performance.now() - t1)}ms:`, counts);
  const [a] = listAccounts(db);
  console.log(`  status=${a.status} tokenHint=…${a.tokenHint}`);
  for (const d of listDomains(db, id)) console.log(`  ${d.domain.padEnd(22)} ${d.status} expires ${d.expiresAt?.slice(0, 10)} website=${d.hasWebsite} mail=${d.hasMail}`);
} finally {
  await pool.closeAll();
}
