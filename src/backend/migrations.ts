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

  // 003：模型提供方（Key 只存密文）+ 用途到模型的路由
  `CREATE TABLE model_providers (
     id                 INTEGER PRIMARY KEY,
     name               TEXT NOT NULL UNIQUE,
     protocol           TEXT NOT NULL CHECK (protocol IN ('openai','anthropic')),
     base_url           TEXT NOT NULL,
     api_key_ciphertext BLOB,
     api_key_hint       TEXT,
     models_json        TEXT NOT NULL CHECK (json_valid(models_json)),
     created_at         INTEGER NOT NULL
   );
   CREATE TABLE model_roles (
     role        TEXT PRIMARY KEY CHECK (role IN ('agent','vision','bulk','review')),
     provider_id INTEGER NOT NULL REFERENCES model_providers (id) ON DELETE RESTRICT,
     model_id    TEXT NOT NULL,
     thinking    TEXT NOT NULL CHECK (thinking IN ('off','minimal','low','medium','high','max'))
   );`,

  // 004：批次、站点、建站步骤进度、任务队列
  `CREATE TABLE batches (
     id          INTEGER PRIMARY KEY,
     entity_json TEXT NOT NULL CHECK (json_valid(entity_json)),
     created_at  INTEGER NOT NULL
   );
   CREATE TABLE sites (
     id                   INTEGER PRIMARY KEY,
     batch_id             INTEGER NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
     domain               TEXT NOT NULL UNIQUE,
     form_json            TEXT NOT NULL CHECK (json_valid(form_json)),
     status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting','done','failed')),
     account_id           INTEGER REFERENCES hostinger_accounts (id) ON DELETE SET NULL,
     order_id             INTEGER,
     hostinger_username   TEXT,
     wp_software_id       TEXT,
     wp_admin_ciphertext  BLOB,
     enroll_ciphertext    BLOB,
     enroll_generation    INTEGER,
     companion_ciphertext BLOB,
     last_error           TEXT,
     created_at           INTEGER NOT NULL,
     updated_at           INTEGER NOT NULL
   );
   CREATE TABLE provision_steps (
     site_id     INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
     step        TEXT NOT NULL,
     status      TEXT NOT NULL CHECK (status IN ('running','waiting','done','skipped','failed')),
     detail      TEXT,
     started_at  INTEGER NOT NULL,
     finished_at INTEGER,
     PRIMARY KEY (site_id, step)
   );
   CREATE TABLE jobs (
     id           INTEGER PRIMARY KEY,
     type         TEXT NOT NULL,
     site_id      INTEGER REFERENCES sites (id) ON DELETE CASCADE,
     status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
     run_at       INTEGER NOT NULL,
     attempts     INTEGER NOT NULL DEFAULT 0,
     max_attempts INTEGER NOT NULL DEFAULT 3,
     lease_until  INTEGER,
     last_error   TEXT,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   );
   CREATE INDEX jobs_due ON jobs (status, run_at);`,
];
