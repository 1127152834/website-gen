import { MAIL_TRIAGE_LIMITS } from "../shared/mail-triage-types.ts";
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
  // Global assistant tool audit. Never stores credentials: callers must pass sanitized params.
  `CREATE TABLE assistant_tool_audit (
     id           INTEGER PRIMARY KEY,
     created_at   INTEGER NOT NULL,
     tool         TEXT NOT NULL,
     params_json  TEXT NOT NULL CHECK (json_valid(params_json)),
     risk         TEXT NOT NULL CHECK (risk IN ('write','confirm')),
     confirmed    INTEGER NOT NULL CHECK (confirmed IN (0,1)),
     success      INTEGER NOT NULL CHECK (success IN (0,1)),
     error        TEXT
   );
   CREATE INDEX assistant_tool_audit_created ON assistant_tool_audit (created_at DESC);`,
  // 014：邮件翻译使用独立模型用途；保留现有提供方、Key 和四种用途的原始绑定。
  `CREATE TABLE model_roles_new (
     role        TEXT PRIMARY KEY CHECK (role IN ('agent','vision','bulk','review','translation')),
     provider_id INTEGER NOT NULL REFERENCES model_providers (id) ON DELETE RESTRICT,
     model_id    TEXT NOT NULL,
     thinking    TEXT NOT NULL CHECK (thinking IN ('off','minimal','low','medium','high','max'))
   );
   INSERT INTO model_roles_new (role, provider_id, model_id, thinking)
     SELECT role, provider_id, model_id, thinking FROM model_roles;
   DROP TABLE model_roles;
   ALTER TABLE model_roles_new RENAME TO model_roles;`,
  // 015：邮件预审领域存储。默认关闭，不复制任何用途绑定或密钥。
  `ALTER TABLE mail_messages ADD COLUMN uid_validity TEXT;
   ALTER TABLE model_providers ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1 CHECK(config_revision > 0);
   CREATE TABLE model_roles_triage (
     role TEXT PRIMARY KEY CHECK(role IN ('agent','vision','bulk','review','translation','mail_triage')),
     provider_id INTEGER NOT NULL REFERENCES model_providers(id) ON DELETE RESTRICT,
     model_id TEXT NOT NULL,
     thinking TEXT NOT NULL CHECK(thinking IN ('off','minimal','low','medium','high','max'))
   );
   INSERT INTO model_roles_triage SELECT role,provider_id,model_id,thinking FROM model_roles;
   DROP TABLE model_roles;
   ALTER TABLE model_roles_triage RENAME TO model_roles;
   CREATE TABLE mail_triage_settings (
     id INTEGER PRIMARY KEY CHECK(id=1),
     enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
     state TEXT NOT NULL DEFAULT 'disabled' CHECK(state IN ('disabled','initializing','enabled','paused_budget','blocked_config','paused_audit')),
     config_epoch INTEGER NOT NULL DEFAULT 1 CHECK(config_epoch>0),
     model_config_revision INTEGER NOT NULL DEFAULT 1 CHECK(model_config_revision>0),
     version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
     mode TEXT NOT NULL DEFAULT 'auto_suggest' CHECK(mode IN ('auto_suggest','suggest_only')),
     daily_attempt_limit INTEGER NOT NULL DEFAULT ${MAIL_TRIAGE_LIMITS.dailyAttemptLimit} CHECK(daily_attempt_limit>0),
     consent_provider_revision INTEGER,
     reminder_enabled INTEGER NOT NULL DEFAULT 0 CHECK(reminder_enabled IN (0,1)),
     reminder_settings_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(reminder_settings_json)),
     auto_notifications INTEGER NOT NULL DEFAULT 0 CHECK(auto_notifications IN (0,1))
   );
   INSERT INTO mail_triage_settings(id) VALUES (1);
   CREATE TABLE mail_triage_scope (
     mailbox_id INTEGER PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
     epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>0),
     state TEXT NOT NULL DEFAULT 'revoked' CHECK(state IN ('authorized','revoked')),
     uid_validity TEXT,
     baseline_uid INTEGER NOT NULL DEFAULT 0 CHECK(baseline_uid>=0),
     effective_at INTEGER,
     scope_version INTEGER NOT NULL DEFAULT 1 CHECK(scope_version>0)
   );
   CREATE TABLE mail_triage_contacts (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
     mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
     address TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
     reason TEXT NOT NULL CHECK(length(trim(reason))>0),
     confirmed_by TEXT NOT NULL,
     confirmed_at INTEGER NOT NULL
   );
   CREATE TABLE mail_triage_sources (
     id TEXT PRIMARY KEY,
     mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
     source_hash TEXT NOT NULL,
     critical_headers_hash TEXT NOT NULL,
     source_version INTEGER NOT NULL DEFAULT 1 CHECK(source_version>0),
     state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','stale','missing','deleted')),
     trust TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(trust IN ('unconfirmed','contact_mapped','human_confirmed')),
     observed_at INTEGER NOT NULL,
     missing_since INTEGER,
     UNIQUE(id,mailbox_id)
   );
   CREATE INDEX mail_triage_sources_mailbox_state ON mail_triage_sources(mailbox_id,state);
   CREATE TABLE mail_triage_source_aliases (
     mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
     folder TEXT NOT NULL,
     uid_validity TEXT NOT NULL,
     uid INTEGER NOT NULL CHECK(uid>0),
     source_id TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
     PRIMARY KEY(mailbox_id,folder,uid_validity,uid),
     FOREIGN KEY(source_id,mailbox_id) REFERENCES mail_triage_sources(id,mailbox_id) ON DELETE CASCADE
   );
   CREATE INDEX mail_triage_source_aliases_source_active ON mail_triage_source_aliases(source_id,active);
   CREATE TABLE mail_triage_jobs (
     id TEXT PRIMARY KEY,
     source_id TEXT NOT NULL REFERENCES mail_triage_sources(id) ON DELETE CASCADE,
     source_version INTEGER NOT NULL CHECK(source_version>0),
     provider_id INTEGER NOT NULL,
     model_id TEXT NOT NULL,
     model_config_revision INTEGER NOT NULL CHECK(model_config_revision>0),
     prompt_version INTEGER NOT NULL CHECK(prompt_version>0),
     rule_version INTEGER NOT NULL CHECK(rule_version>0),
     schema_version INTEGER NOT NULL CHECK(schema_version>0),
     context_version TEXT NOT NULL,
     generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
     config_epoch INTEGER NOT NULL CHECK(config_epoch>0),
     state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','retry_wait','succeeded','needs_review','failed','paused_budget','blocked_config','stale_source','cancelled')),
     priority INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL DEFAULT 0,
     lease_token TEXT,
     lease_expires_at INTEGER,
     attempt_seq INTEGER NOT NULL DEFAULT 0 CHECK(attempt_seq>=0),
     manual_version INTEGER NOT NULL DEFAULT 0 CHECK(manual_version>=0),
     created_at INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     UNIQUE(source_id,source_version,provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,context_version,generation,config_epoch)
   );
   CREATE INDEX mail_triage_jobs_due ON mail_triage_jobs(state,next_attempt_at,priority);
   CREATE INDEX mail_triage_jobs_source_epoch ON mail_triage_jobs(source_id,config_epoch);
   CREATE TABLE mail_triage_attempts (
     id TEXT PRIMARY KEY,
     job_id TEXT REFERENCES mail_triage_jobs(id) ON DELETE SET NULL,
     attempt_seq INTEGER NOT NULL CHECK(attempt_seq>0),
     budget_day TEXT NOT NULL CHECK(length(budget_day)=10),
     reserved_at INTEGER NOT NULL,
     deadline_at INTEGER NOT NULL,
     settled_at INTEGER,
     outcome TEXT NOT NULL DEFAULT 'reserved' CHECK(outcome IN ('reserved','succeeded','failed','unknown','cancelled')),
     usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
     UNIQUE(job_id,attempt_seq)
   );
   CREATE INDEX mail_triage_attempts_budget ON mail_triage_attempts(budget_day);
   CREATE TABLE mail_triage_assessments (
     id TEXT PRIMARY KEY,
     job_id TEXT NOT NULL UNIQUE REFERENCES mail_triage_jobs(id) ON DELETE CASCADE,
     source_id TEXT NOT NULL REFERENCES mail_triage_sources(id) ON DELETE CASCADE,
     provider_id INTEGER NOT NULL,
     model_id TEXT NOT NULL,
     model_config_revision INTEGER NOT NULL CHECK(model_config_revision>0),
     prompt_version INTEGER NOT NULL CHECK(prompt_version>0),
     rule_version INTEGER NOT NULL CHECK(rule_version>0),
     schema_version INTEGER NOT NULL CHECK(schema_version>0),
     prompt_hash TEXT NOT NULL,
     validated_json TEXT NOT NULL CHECK(json_valid(validated_json)),
     support_source_ids_json TEXT NOT NULL CHECK(json_valid(support_source_ids_json)),
     grade TEXT NOT NULL CHECK(grade IN ('evidence_complete','needs_review','failed')),
     stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)),
     stale_at INTEGER,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE mail_application_cases (
     id TEXT PRIMARY KEY,
     identity_state TEXT NOT NULL DEFAULT 'unconfirmed_case' CHECK(identity_state IN ('unconfirmed_case','confirmed')),
     site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
     provider TEXT,
     application_identity TEXT,
     identity_provenance_json TEXT NOT NULL DEFAULT '{"supportSourceIds":[],"kind":"source_derived","verifiedAt":null,"reason":null}' CHECK(json_valid(identity_provenance_json)),
     version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
     manual_version INTEGER NOT NULL DEFAULT 0 CHECK(manual_version>=0),
     projection_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(projection_json)),
     created_at INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE mail_case_sources (
     case_id TEXT NOT NULL REFERENCES mail_application_cases(id) ON DELETE CASCADE,
     source_id TEXT NOT NULL REFERENCES mail_triage_sources(id) ON DELETE CASCADE,
     match_basis TEXT NOT NULL,
     manual_locked INTEGER NOT NULL DEFAULT 0 CHECK(manual_locked IN (0,1)),
     PRIMARY KEY(case_id,source_id)
   );
   CREATE TABLE mail_case_events (
     id TEXT PRIMARY KEY,
     case_id TEXT NOT NULL REFERENCES mail_application_cases(id) ON DELETE CASCADE,
     source_id TEXT NOT NULL REFERENCES mail_triage_sources(id) ON DELETE CASCADE,
     event_slot TEXT NOT NULL,
     kind TEXT NOT NULL,
     decision_cycle INTEGER NOT NULL DEFAULT 1 CHECK(decision_cycle>0),
     claimed_at INTEGER,
     observed_at INTEGER NOT NULL,
     evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
     provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
     UNIQUE(case_id,source_id,event_slot),
     UNIQUE(id,case_id)
   );
   CREATE INDEX mail_case_events_observed ON mail_case_events(case_id,observed_at);
   CREATE TABLE mail_case_tasks (
     id TEXT PRIMARY KEY,
     case_id TEXT NOT NULL REFERENCES mail_application_cases(id) ON DELETE CASCADE,
     event_id TEXT NOT NULL,
     obligation_key TEXT NOT NULL,
     kind TEXT NOT NULL CHECK(kind IN ('reply','action','review')),
     object TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','awaiting_external','resolved_by_evidence','resolved_by_human','dismissed','blocked')),
     title TEXT NOT NULL,
     requested_items_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(requested_items_json)),
     deadline_raw TEXT,
     deadline_at INTEGER,
     version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
     provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
     UNIQUE(case_id,event_id,obligation_key),
     FOREIGN KEY(event_id,case_id) REFERENCES mail_case_events(id,case_id) ON DELETE CASCADE
   );
   CREATE INDEX mail_case_tasks_state ON mail_case_tasks(case_id,state);
   CREATE TABLE mail_case_manual_decisions (
     id TEXT PRIMARY KEY,
     case_id TEXT REFERENCES mail_application_cases(id) ON DELETE CASCADE,
     actor TEXT NOT NULL,
     object_id TEXT NOT NULL,
     field TEXT NOT NULL,
     expected_version INTEGER NOT NULL CHECK(expected_version>=0),
     applied_version INTEGER NOT NULL CHECK(applied_version>0),
     reason TEXT NOT NULL CHECK(length(trim(reason))>0),
     before_json TEXT NOT NULL CHECK(json_valid(before_json)),
     after_json TEXT NOT NULL CHECK(json_valid(after_json)),
     undo_of TEXT REFERENCES mail_case_manual_decisions(id) ON DELETE SET NULL,
     provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
     created_at INTEGER NOT NULL
   );
   CREATE TABLE mail_triage_send_receipts (
     id TEXT PRIMARY KEY,
     request_id TEXT NOT NULL UNIQUE,
     mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
     reply_source_id TEXT REFERENCES mail_triage_sources(id) ON DELETE SET NULL,
     smtp_status TEXT NOT NULL DEFAULT 'prepared' CHECK(smtp_status IN ('prepared','smtp_accepted','failed','unknown')),
     message_id TEXT,
     appended INTEGER NOT NULL DEFAULT 0 CHECK(appended IN (0,1)),
     selected_task_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(selected_task_ids_json)),
     created_at INTEGER NOT NULL
   );
   CREATE TABLE mail_triage_qualifications (
     id TEXT PRIMARY KEY,
     provider_id INTEGER NOT NULL,
     model_id TEXT NOT NULL,
     model_config_revision INTEGER NOT NULL CHECK(model_config_revision>0),
     prompt_version INTEGER NOT NULL CHECK(prompt_version>0),
     rule_version INTEGER NOT NULL CHECK(rule_version>0),
     schema_version INTEGER NOT NULL CHECK(schema_version>0),
     evidence_hash TEXT NOT NULL,
     strata_counts_json TEXT NOT NULL CHECK(json_valid(strata_counts_json)),
     missed_action_count INTEGER NOT NULL DEFAULT 0 CHECK(missed_action_count>=0),
     approved_by TEXT,
     approved_at INTEGER,
     revoked_at INTEGER,
     UNIQUE(provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version)
   );
   CREATE TABLE mail_triage_audits (
     id TEXT PRIMARY KEY,
     assessment_id TEXT NOT NULL UNIQUE REFERENCES mail_triage_assessments(id) ON DELETE CASCADE,
     sequence INTEGER NOT NULL CHECK(sequence>0),
     sampled INTEGER NOT NULL CHECK(sampled IN (0,1)),
     reviewed_at INTEGER,
     verdict TEXT CHECK(verdict IN ('passed','missed_action','needs_review')),
     last_passed_boundary INTEGER NOT NULL DEFAULT 0 CHECK(last_passed_boundary>=0)
   );
   CREATE INDEX mail_triage_audits_review ON mail_triage_audits(sampled,reviewed_at);
   CREATE TABLE mail_triage_requests (
     request_id TEXT NOT NULL,
     operation TEXT NOT NULL,
     canonical_input_hash TEXT NOT NULL,
     result_ref_json TEXT CHECK(result_ref_json IS NULL OR json_valid(result_ref_json)),
     created_at INTEGER NOT NULL,
     PRIMARY KEY(request_id,operation)
   );`,
  // 016：缓存完整性必须显式证明，旧正文/占位文本默认不具备预审资格。
  `ALTER TABLE mail_messages ADD COLUMN body_complete INTEGER NOT NULL DEFAULT 0 CHECK(body_complete IN (0,1));
   ALTER TABLE mail_messages ADD COLUMN body_issue TEXT;
   ALTER TABLE mail_messages ADD COLUMN from_addresses_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(from_addresses_json));`,
  // 017：保留单调attempt审计；严格已证零HTTP的预约不计实际尝试或预算。
  `CREATE TABLE mail_triage_attempts_v17 (
     id TEXT PRIMARY KEY,
     job_id TEXT REFERENCES mail_triage_jobs(id) ON DELETE SET NULL,
     attempt_seq INTEGER NOT NULL CHECK(attempt_seq>0),
     budget_day TEXT NOT NULL CHECK(length(budget_day)=10),
     reserved_at INTEGER NOT NULL,
     deadline_at INTEGER NOT NULL,
     settled_at INTEGER,
     outcome TEXT NOT NULL DEFAULT 'reserved' CHECK(outcome IN ('reserved','succeeded','failed','unknown','cancelled','not_dispatched')),
     usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
     UNIQUE(job_id,attempt_seq)
   );
   INSERT INTO mail_triage_attempts_v17 SELECT * FROM mail_triage_attempts;
   DROP TABLE mail_triage_attempts;
   ALTER TABLE mail_triage_attempts_v17 RENAME TO mail_triage_attempts;
   CREATE INDEX mail_triage_attempts_budget ON mail_triage_attempts(budget_day);`,
  // 018：内部逐case人工版本快照，不包含人工备注或正文；旧作业保持NULL未知。
  `ALTER TABLE mail_triage_jobs ADD COLUMN manual_versions_json TEXT
     CHECK(manual_versions_json IS NULL OR json_valid(manual_versions_json));`,
  // 019：独立人工事实可在邮件来源删除后保留；NULL source 只允许无邮件证据的严格人工核验事件。
  `CREATE TABLE mail_case_events_v19 (
     id TEXT PRIMARY KEY,
     case_id TEXT NOT NULL REFERENCES mail_application_cases(id) ON DELETE CASCADE,
     source_id TEXT REFERENCES mail_triage_sources(id) ON DELETE CASCADE,
     event_slot TEXT NOT NULL,
     kind TEXT NOT NULL,
     decision_cycle INTEGER NOT NULL DEFAULT 1 CHECK(decision_cycle>0),
     claimed_at INTEGER,
     observed_at INTEGER NOT NULL,
     evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
     provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
     UNIQUE(case_id,source_id,event_slot),
     UNIQUE(id,case_id),
     CHECK(source_id IS NOT NULL OR COALESCE((
       json_extract(provenance_json,'$.kind')='independent_manual'
       AND json_type(provenance_json,'$.supportSourceIds')='array'
       AND json_array_length(provenance_json,'$.supportSourceIds')=0
       AND json_type(provenance_json,'$.verifiedAt') IN ('integer','real')
       AND json_extract(provenance_json,'$.verifiedAt')>0
       AND json_type(provenance_json,'$.reason')='text'
       AND length(trim(json_extract(provenance_json,'$.reason')))>0
       AND json_type(evidence_json)='array'
       AND json_array_length(evidence_json)=0
     ),0)=1)
   );
   INSERT INTO mail_case_events_v19 SELECT * FROM mail_case_events;
   CREATE TABLE mail_case_tasks_v19 (
     id TEXT PRIMARY KEY,
     case_id TEXT NOT NULL REFERENCES mail_application_cases(id) ON DELETE CASCADE,
     event_id TEXT NOT NULL,
     obligation_key TEXT NOT NULL,
     kind TEXT NOT NULL CHECK(kind IN ('reply','action','review')),
     object TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','awaiting_external','resolved_by_evidence','resolved_by_human','dismissed','blocked')),
     title TEXT NOT NULL,
     requested_items_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(requested_items_json)),
     deadline_raw TEXT,
     deadline_at INTEGER,
     version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
     provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
     UNIQUE(case_id,event_id,obligation_key),
     FOREIGN KEY(event_id,case_id) REFERENCES mail_case_events_v19(id,case_id) ON DELETE CASCADE
   );
   INSERT INTO mail_case_tasks_v19 SELECT * FROM mail_case_tasks;
   DROP TABLE mail_case_tasks;
   DROP TABLE mail_case_events;
   ALTER TABLE mail_case_events_v19 RENAME TO mail_case_events;
   ALTER TABLE mail_case_tasks_v19 RENAME TO mail_case_tasks;
   CREATE INDEX mail_case_events_observed ON mail_case_events(case_id,observed_at);
   CREATE UNIQUE INDEX mail_case_events_sourceless_slot ON mail_case_events(case_id,event_slot) WHERE source_id IS NULL;
   CREATE INDEX mail_case_tasks_state ON mail_case_tasks(case_id,state);`,
  // 020：RPC联系人是分组映射；旧平表继续供Task6精确地址匹配，域名只作人工辅助元数据。
  `CREATE TABLE mail_triage_contact_groups (
     id TEXT PRIMARY KEY,
     provider_key TEXT NOT NULL CHECK(length(trim(provider_key))>0),
     site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
     mailbox_ids_json TEXT NOT NULL CHECK(json_valid(mailbox_ids_json) AND json_type(mailbox_ids_json)='array'),
     sender_addresses_json TEXT NOT NULL CHECK(json_valid(sender_addresses_json) AND json_type(sender_addresses_json)='array'),
     domains_json TEXT NOT NULL CHECK(json_valid(domains_json) AND json_type(domains_json)='array'),
     version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
     reason TEXT NOT NULL CHECK(length(trim(reason))>0),
     confirmed_by TEXT NOT NULL CHECK(length(trim(confirmed_by))>0),
     confirmed_at INTEGER NOT NULL
   );
   ALTER TABLE mail_triage_contacts ADD COLUMN group_id TEXT REFERENCES mail_triage_contact_groups(id) ON DELETE CASCADE;
   INSERT INTO mail_triage_contact_groups(id,provider_key,site_id,mailbox_ids_json,sender_addresses_json,domains_json,version,reason,confirmed_by,confirmed_at)
     SELECT id,provider,site_id,json_array(mailbox_id),json_array(lower(address)),json_array(),version,reason,confirmed_by,confirmed_at
     FROM mail_triage_contacts;
   UPDATE mail_triage_contacts SET group_id=id;
   CREATE UNIQUE INDEX mail_triage_contacts_group_mailbox_address ON mail_triage_contacts(group_id,mailbox_id,address);
   CREATE INDEX mail_triage_contact_groups_site ON mail_triage_contact_groups(site_id);`,
  // 021：发信时冻结无正文的精确任务/来源绑定，并持久化 SMTP 接受后的投影核对状态；旧收据 NULL 绑定严格失败关闭。
  `ALTER TABLE mail_triage_send_receipts ADD COLUMN binding_json TEXT
     CHECK(binding_json IS NULL OR (json_valid(binding_json) AND json_type(binding_json)='object'));
   ALTER TABLE mail_triage_send_receipts ADD COLUMN review_state TEXT NOT NULL DEFAULT 'none'
     CHECK(review_state IN ('none','pending','cleared'));
   ALTER TABLE mail_triage_send_receipts ADD COLUMN review_code TEXT
     CHECK(review_code IS NULL OR review_code IN ('task_outcome_pending','sent_append_unconfirmed','task_binding_conflict','task_projection_failed'));`,
  // 022：真实人工评估报告保留不可变历史；通知批准/暂停按版本CAS，抽查序号与匿名位置不随来源删除而重置。
  `CREATE TABLE mail_triage_evaluation_reports (
     provider_id INTEGER NOT NULL,
     model_id TEXT NOT NULL,
     model_config_revision INTEGER NOT NULL CHECK(model_config_revision>0),
     prompt_version INTEGER NOT NULL CHECK(prompt_version>0),
     rule_version INTEGER NOT NULL CHECK(rule_version>0),
     schema_version INTEGER NOT NULL CHECK(schema_version>0),
     report_hash TEXT NOT NULL CHECK(length(report_hash)=64),
     report_json TEXT NOT NULL CHECK(json_valid(report_json) AND json_type(report_json)='object'),
     eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
     created_by TEXT NOT NULL CHECK(length(trim(created_by))>0),
     created_at INTEGER NOT NULL,
     PRIMARY KEY(provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,report_hash)
   );
   ALTER TABLE mail_triage_qualifications ADD COLUMN current_report_hash TEXT;
   ALTER TABLE mail_triage_qualifications ADD COLUMN approval_revision INTEGER NOT NULL DEFAULT 0 CHECK(approval_revision>=0);
   ALTER TABLE mail_triage_qualifications ADD COLUMN notification_state TEXT NOT NULL DEFAULT 'not_qualified' CHECK(notification_state IN ('not_qualified','approved','paused_audit'));
   ALTER TABLE mail_triage_qualifications ADD COLUMN paused_at INTEGER;
   ALTER TABLE mail_triage_qualifications ADD COLUMN paused_report_hash TEXT;
   ALTER TABLE mail_triage_qualifications ADD COLUMN unresolved_recheck INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_recheck IN (0,1));
   CREATE TABLE mail_triage_audit_counters (
     provider_id INTEGER NOT NULL, model_id TEXT NOT NULL, model_config_revision INTEGER NOT NULL,
     prompt_version INTEGER NOT NULL, rule_version INTEGER NOT NULL, schema_version INTEGER NOT NULL,
     next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence>0),
     last_passed_boundary INTEGER NOT NULL DEFAULT 0 CHECK(last_passed_boundary>=0),
     PRIMARY KEY(provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version)
   );
   CREATE TABLE mail_triage_audit_positions (
     provider_id INTEGER NOT NULL, model_id TEXT NOT NULL, model_config_revision INTEGER NOT NULL,
     prompt_version INTEGER NOT NULL, rule_version INTEGER NOT NULL, schema_version INTEGER NOT NULL,
     sequence INTEGER NOT NULL CHECK(sequence>0), assessment_id TEXT NOT NULL UNIQUE,
     sampled INTEGER NOT NULL CHECK(sampled IN (0,1)), verdict TEXT CHECK(verdict IN ('passed','missed_action')),
     reviewed_at INTEGER, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
     PRIMARY KEY(provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,sequence)
   );
   CREATE INDEX mail_triage_audit_positions_review ON mail_triage_audit_positions(provider_id,model_id,model_config_revision,prompt_version,rule_version,schema_version,sampled,reviewed_at);
   CREATE TABLE mail_triage_audit_verdict_history (
     request_id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL, expected_version INTEGER NOT NULL,
     before_verdict TEXT, after_verdict TEXT NOT NULL CHECK(after_verdict IN ('passed','missed_action')),
     reason TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL
   );`,
];
