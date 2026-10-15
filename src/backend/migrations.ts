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

  // 002：Hostinger 账号（Token 只存密文）+ 每次同步的资源快照
  `CREATE TABLE hostinger_accounts (
     id               INTEGER PRIMARY KEY,
     label            TEXT NOT NULL UNIQUE CHECK (length(trim(label)) > 0),
     token_ciphertext BLOB NOT NULL,
     token_hint       TEXT NOT NULL,
     status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','ok','auth_failed','error')),
     last_error       TEXT,
     last_synced_at   INTEGER,
     created_at       INTEGER NOT NULL
   );
   CREATE TABLE hosting_orders (
     account_id  INTEGER NOT NULL REFERENCES hostinger_accounts (id) ON DELETE CASCADE,
     external_id INTEGER NOT NULL,
     plan        TEXT,
     status      TEXT,
     created_at  TEXT,
     PRIMARY KEY (account_id, external_id)
   );
   CREATE TABLE hosting_websites (
     account_id   INTEGER NOT NULL REFERENCES hostinger_accounts (id) ON DELETE CASCADE,
     domain       TEXT NOT NULL,
     username     TEXT,
     order_id     INTEGER,
     website_type TEXT,
     is_enabled   INTEGER,
     created_at   TEXT,
     PRIMARY KEY (account_id, domain)
   );
   CREATE TABLE domains (
     account_id  INTEGER NOT NULL REFERENCES hostinger_accounts (id) ON DELETE CASCADE,
     external_id INTEGER NOT NULL,
     domain      TEXT NOT NULL,
     type        TEXT,
     status      TEXT,
     expires_at  TEXT,
     created_at  TEXT,
     PRIMARY KEY (account_id, external_id)
   );
   CREATE INDEX domains_domain ON domains (domain);
   CREATE TABLE mail_orders (
     account_id  INTEGER NOT NULL REFERENCES hostinger_accounts (id) ON DELETE CASCADE,
     external_id TEXT NOT NULL,
     domain      TEXT,
     plan        TEXT,
     status      TEXT,
     seats       INTEGER,
     is_trial    INTEGER,
     expires_at  TEXT,
     PRIMARY KEY (account_id, external_id)
   );`,
];
