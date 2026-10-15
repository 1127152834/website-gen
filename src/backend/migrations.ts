// SQL 迁移按顺序执行，第 n 条执行完把 PRAGMA user_version 设为 n。只能追加，不能改已发布的条目。
export const MIGRATIONS: string[] = [
  `CREATE TABLE run_events (
     seq          INTEGER PRIMARY KEY AUTOINCREMENT,
     ts           INTEGER NOT NULL,
     batch_id     TEXT,
     site_id      TEXT,
     kind         TEXT NOT NULL CHECK (kind IN ('step','mcp','ai_text','ai_thinking','ai_tool','warn','error')),
     payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
   );
   CREATE INDEX run_events_site ON run_events (site_id, seq);`,
];
