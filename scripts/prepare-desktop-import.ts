import { resolve } from "node:path";
import { openAdminStore } from "../src/server/admin-db.ts";
import { loadMasterKey } from "../src/server/keys.ts";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const dataDir = resolve(option("--data-dir"));
  const password = process.env.IMPORT_ADMIN_PASSWORD;
  if (!password) throw new Error("IMPORT_ADMIN_PASSWORD is required");
  if (process.env.WEBSITE_GEN_MASTER_KEY) {
    throw new Error("WEBSITE_GEN_MASTER_KEY must be unset so the generated master.key remains authoritative");
  }

  loadMasterKey(dataDir, "").fill(0);
  const admin = openAdminStore(resolve(dataDir, "admin.sqlite"));
  try {
    const result = await admin.bootstrap({ username: "admin", password, now: Date.now() });
    if (!result) throw new Error("staging admin database was not fresh");
  } finally {
    admin.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
