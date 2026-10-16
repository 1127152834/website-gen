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

  // 005：流水线后半段的产出（选品、AI 文案与政策、QA 报告）+ 加密保存的其他凭据（CJ API Key 等）
  `ALTER TABLE sites ADD COLUMN picks_json TEXT CHECK (picks_json IS NULL OR json_valid(picks_json));
   ALTER TABLE sites ADD COLUMN spec_json TEXT CHECK (spec_json IS NULL OR json_valid(spec_json));
   ALTER TABLE sites ADD COLUMN qa_json TEXT CHECK (qa_json IS NULL OR json_valid(qa_json));
   CREATE TABLE secrets (
     name       TEXT PRIMARY KEY,
     ciphertext BLOB NOT NULL,
     hint       TEXT,
     updated_at INTEGER NOT NULL
   );`,

  // 006：上线时间（为空 = 还在维护模式）
  `ALTER TABLE sites ADD COLUMN launched_at INTEGER;`,

  // 007：内容变更集。每条记下改了哪些对象、改之前（快照）和改之后的实际内容，回滚时把快照写回去
  `CREATE TABLE changesets (
     id           INTEGER PRIMARY KEY,
     site_id      INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
     summary      TEXT NOT NULL,
     initiator    TEXT NOT NULL CHECK (initiator IN ('pi','you','schedule')),
     ops_json     TEXT NOT NULL CHECK (json_valid(ops_json)),
     status       TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','reverted')),
     created_at   INTEGER NOT NULL,
     revert_at    INTEGER,
     reverted_at  INTEGER,
     revert_error TEXT
   );
   CREATE INDEX changesets_site ON changesets (site_id, id);
   CREATE INDEX changesets_due ON changesets (status, revert_at);`,

  // 008：流水线新建的客服邮箱的地址和密码（加密）；复用已有邮箱时为空，密码在 hPanel 里管理
  `ALTER TABLE sites ADD COLUMN mailbox_ciphertext BLOB;`,

  // 009：旧版同步把待设置域名（Hostinger 返回 domain=null）存成了字符串 "null"，改为空字符串
  `UPDATE domains SET domain = '' WHERE domain = 'null';`,

  // 010：旧模型表的结构已经能承载用户自建厂商，原样保留提供方、Key、模型和用途路由；经营主体模板在本阶段落库。
  `UPDATE model_providers SET models_json = models_json WHERE json_valid(models_json);
   CREATE TABLE IF NOT EXISTS entity_templates (
     id           INTEGER PRIMARY KEY,
     name         TEXT NOT NULL,
     payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   );`,

  // 011：工作区邮件索引与可恢复的放弃任务。流水线状态不变，abandoned_at 是独立生命周期。
  `ALTER TABLE sites ADD COLUMN abandoned_at INTEGER;
   CREATE TABLE abandoned_domains (
     domain TEXT PRIMARY KEY COLLATE NOCASE,
     abandoned_at INTEGER NOT NULL,
     abandon_job_id INTEGER
   );
   CREATE TABLE mailboxes (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL REFERENCES hostinger_accounts(id) ON DELETE CASCADE,
     order_id TEXT NOT NULL,
     remote_id TEXT NOT NULL,
     address TEXT NOT NULL COLLATE NOCASE,
     domain TEXT NOT NULL COLLATE NOCASE,
     status TEXT,
     credential_ciphertext BLOB,
     monitoring INTEGER NOT NULL DEFAULT 0 CHECK(monitoring IN (0,1)),
     sync_state_json TEXT CHECK(sync_state_json IS NULL OR json_valid(sync_state_json)),
     last_synced_at INTEGER,
     UNIQUE(account_id,remote_id), UNIQUE(account_id,address)
   );
   CREATE INDEX mailboxes_domain ON mailboxes(domain);
   CREATE TABLE mail_messages (
     mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
     folder TEXT NOT NULL,
     uid INTEGER NOT NULL,
     message_id TEXT,
     from_json TEXT NOT NULL DEFAULT '[]',
     to_json TEXT NOT NULL DEFAULT '[]',
     cc_json TEXT NOT NULL DEFAULT '[]',
     subject TEXT NOT NULL DEFAULT '',
     date INTEGER,
     snippet TEXT NOT NULL DEFAULT '',
     seen INTEGER NOT NULL DEFAULT 0 CHECK(seen IN (0,1)),
     has_attachments INTEGER NOT NULL DEFAULT 0 CHECK(has_attachments IN (0,1)),
     size INTEGER NOT NULL DEFAULT 0,
     body_text TEXT,
     attachments_json TEXT NOT NULL DEFAULT '[]',
     references_json TEXT NOT NULL DEFAULT '[]',
     in_reply_to TEXT,
     PRIMARY KEY(mailbox_id,folder,uid)
   );
   CREATE INDEX mail_messages_list ON mail_messages(mailbox_id,folder,date DESC,uid DESC);
   CREATE TABLE abandon_runs (
     job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
     domain TEXT NOT NULL COLLATE NOCASE,
     requested_account_id INTEGER,
     site_id INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE abandon_steps (
     job_id INTEGER NOT NULL REFERENCES abandon_runs(job_id) ON DELETE CASCADE,
     step TEXT NOT NULL CHECK(step IN ('local_mail','remote_mail','website','domain_renewal','finalize')),
     status TEXT NOT NULL CHECK(status IN ('pending','running','done','failed')),
     detail TEXT,
     started_at INTEGER,
     finished_at INTEGER,
     PRIMARY KEY(job_id,step)
   );`,
  // Grist connection address is workspace-local; API keys stay encrypted in secrets.
  `CREATE TABLE workspace_settings (
     name TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
];
