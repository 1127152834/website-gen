import { existsSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function relativeWorkPath(file: string): string {
  const match = /(?:^|[\\/])users[\\/]\d+[\\/]work[\\/](.+)$/i.exec(file)
    ?? /(?:^|[\\/])work[\\/](.+)$/i.exec(file);
  if (!match) throw new Error(`cannot safely rebase imported QA path: ${file}`);
  const parts = match[1].split(/[\\/]+/).filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error(`unsafe imported QA path: ${file}`);
  return posix.join(...parts);
}

function main(): void {
  const dataDir = resolve(option("--data-dir"));
  const usersDir = join(dataDir, "users");
  let changed = 0;
  for (const userId of readdirSync(usersDir).filter((name) => /^\d+$/.test(name))) {
    const dbPath = join(usersDir, userId, "website-gen.sqlite");
    if (!existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath);
    try {
      const hasSites = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sites'").get();
      if (!hasSites) continue;
      const rows = db.prepare("SELECT id, qa_json FROM sites WHERE qa_json IS NOT NULL").all() as unknown as { id: number; qa_json: string }[];
      const update = db.prepare("UPDATE sites SET qa_json = ? WHERE id = ?");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const report = JSON.parse(row.qa_json) as { shots?: { file: string; [key: string]: unknown }[] };
          if (!Array.isArray(report.shots)) continue;
          report.shots = report.shots.map((shot) => ({
            ...shot,
            file: posix.join("/app/data/users", userId, "work", relativeWorkPath(String(shot.file))),
          }));
          update.run(JSON.stringify(report), row.id);
          changed += report.shots.length;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  }
  console.log(`rebased ${changed} imported QA paths for the Linux data volume`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
