import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  MailAttachment, MailEvent, MailFolder, MailListResult, MailMessageDetail, MailMessageSummary,
  MailSendInput, MailSendResult, MailboxSummary, MailCredentialSource, MailMonitorMode, MailDefaultPasswordResult,
} from "../shared/mail-types.ts";
import type { CaseSourceReaderRef, SourceReaderRef } from "../shared/mail-triage-types.ts";
import { listAll, type HostingerExec } from "./hostinger.ts";
import { parseMailText, type ParsedSafeMessage } from "./mailbox-parser.ts";
import { cacheReadIdentity, cachedParsedMessage, fingerprintSource, invalidateCachedLocator, invalidateFolderGeneration, reconcileFolderSnapshot, recoverCachedSources, registerCachedSource, sourceTransaction, verifiedUidValidity, type SourceRegistrationHooks } from "./mail-triage-source.ts";
import { CaseSourceMessageOutputSchema, CaseSourceReaderRefSchema, ReviewSourceMessageOutputSchema, ReviewSourcePreviewInputSchema } from "./mail-triage-schema.ts";
import { MailboxMonitor } from "./mailbox-monitor.ts";
import type { MailCredentials, MailTransport, MailTransportFactory, RemoteMessage } from "./mailbox-transport.ts";
import { getSecret, seal, unseal } from "./secrets.ts";
import { createMailTransport, MailSentAppendError } from "./mailbox-adapter.ts";
import { prepareMailSend, settleMailSendAccepted, settleMailSendFailure, validateMailSendSelection } from "./mail-triage-send.ts";

const MAX_INCOMING = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20 * 1024 * 1024;
const DEFAULT_PASSWORD_SECRET = "mail.defaultPassword";
const DEFAULT_ATTEMPT_DELAY_MS = 200;
const FOLDER_METADATA_TTL_MS = 10 * 60 * 1000;

interface MailboxRow {
  id: number;
  account_id: number;
  order_id: string;
  remote_id: string;
  address: string;
  domain: string;
  credential_ciphertext: Uint8Array | null;
  monitoring: number;
  sync_state_json: string | null;
  last_synced_at: number | null;
}

interface SyncState {
  credentialSource?: MailCredentialSource;
  monitorMode?: MailMonitorMode;
  lastError?: string | null;
  folders?: Record<string, { uidValidity?: string; syncedAt?: number; nonSeenFlagsDigest?: string }>;
  /** 重置结果未知时保留同一候选密码，后续重试绝不再生成第二个。值本身仍是 AES-GCM 密文。 */
  pendingReset?: string;
  /** 只记工作区密钥派生的指纹；既不存明文，也不暴露可离线猜测的裸密码哈希。 */
  failedDefaultPasswordFingerprint?: string;
}

export interface MailboxServiceDeps {
  db: DatabaseSync;
  key: Buffer;
  accounts(): { id: number; exec: HostingerExec }[];
  transport?: MailTransportFactory;
  push(event: MailEvent): void;
  monitor?: { idleLimit?: number; pollMs?: number; backoffMs?: number };
  readOnly?: boolean;
  triageSourceHooks?: SourceRegistrationHooks;
  /** Task9 注入 lifecycle/worker；所有 DB 回调同步，abort 只在 SAVEPOINT 提交后调用。 */
  triageLifecycleHooks?: {
    invalidateScope?(input: { mailboxIds: number[]; reason: "disable" | "scope_removed" | "mailbox_delete" | "abandon" }, now: number): { abortSourceIds: string[] };
    invalidateSource?(sourceId: string, reason: "stale" | "missing" | "explicit_delete", now: number): void;
    abortSources?(sourceIds: string[]): void;
  };
}

export interface MailboxService {
  list(): MailboxSummary[];
  /** 与队列/worker共享的进程内 deleting/closed guard。 */
  isAvailable(mailboxId: number): boolean;
  sync(accountId?: number): Promise<MailboxSummary[]>;
  reconcile(): Promise<void>;
  /** 内部授权握手：完整同步和同步提交在同一串行槽；不得 await/reenter。 */
  withInboxSnapshot<T>(mailboxId: number, commit: (snapshot: { uidValidity: string; maxUid: number; complete: true }) => T): Promise<T>;
  folders(mailboxId: number): Promise<MailFolder[]>;
  messages(input: { mailboxId: number; folder: string; query?: string; page?: number; pageSize?: number }): Promise<MailListResult>;
  message(input: { mailboxId: number; folder: string; uid: number }): Promise<MailMessageDetail>;
  /** 申请详情专用的本地缓存读取；完整来源绑定失效时绝不退回旧三元组 reader。 */
  sourceMessage(input: CaseSourceReaderRef): { ref: CaseSourceReaderRef; message: MailMessageDetail };
  /** 待确认页专用的当前授权来源缓存读取；不要求或伪造 case 关系。 */
  sourcePreview(input: { sourceId: string; sourceVersion: number }): { sourceRef: SourceReaderRef; readerRef: CaseSourceReaderRef | null; message: MailMessageDetail };
  saveCredential(input: { mailboxId: number; password: string }): Promise<{ ok: true }>;
  tryDefaultCredentials(input?: { mailboxId?: number; retry?: boolean; accountId?: number }): Promise<MailDefaultPasswordResult>;
  resetCredential(input: { mailboxId: number; confirmed: boolean }): Promise<{ ok: true }>;
  setMonitoring(input: { mailboxId: number; enabled: boolean }): Promise<{ ok: true }>;
  markSeen(input: { mailboxId: number; folder: string; uid: number; seen: boolean }): Promise<{ ok: true }>;
  trash(input: { mailboxId: number; folder: string; uid: number; confirmed: boolean }): Promise<{ ok: true }>;
  deleteMailbox(input: { mailboxId: number; confirmed: boolean }): Promise<{ ok: true }>;
  send(input: MailSendInput): Promise<MailSendResult>;
  attachment(input: { mailboxId: number; folder: string; uid: number; partId: string }): Promise<{ name: string; type: string; size: number; data: Buffer }>;
  stopDomain(domain: string): Promise<void>;
  close(): Promise<void>;
}

const parseState = (row: Pick<MailboxRow, "sync_state_json">): SyncState => {
  try { return row.sync_state_json ? JSON.parse(row.sync_state_json) as SyncState : {}; } catch { return {}; }
};

const normalizeFolder = (folder: string) => {
  const value = folder.trim();
  if (!value || value.length > 512 || /[\0\r\n]/.test(value)) throw new Error("邮件文件夹无效");
  return value;
};

const emailOf = (value: string): string | null => {
  if (/[\r\n]/.test(value)) return null;
  const candidate = (/<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1] ?? /^[^\s,<>]+@[^\s,<>]+$/.exec(value.trim())?.[0])?.trim();
  return candidate && /^[^@\s]+@[^@\s]+$/.test(candidate) ? candidate : null;
};
const normalizeEmailList = (values: string[] | undefined) => (values ?? []).map((value) => {
  const email = emailOf(value);
  if (!email) throw new Error(`邮件地址无效：${value.slice(0, 80)}`);
  return email;
});
const uniqueEmails = (values: string[], except?: string) => [...new Map(values
  .map(emailOf).filter((value): value is string => Boolean(value)).filter((value) => value.toLowerCase() !== except?.toLowerCase())
  .map((value) => [value.toLowerCase(), value])).values()];

const redactPassword = (message: string, password: string) => message.split(password).join("[密码已隐藏]");

/** 只有明确的认证拒绝才记错密码；未知错误保留脱敏诊断，不假称是连接故障。 */
const defaultFailureKind = (error: unknown, password: string): "rejected" | "unavailable" | "unknown" => {
  if (!(error instanceof Error)) return "unknown";
  const detail = error as Error & { code?: string; authenticationFailed?: boolean; serverResponseCode?: string };
  const code = String(detail.code ?? "");
  const responseCode = String(detail.serverResponseCode ?? "");
  const message = redactPassword(error.message, password);
  if (/^(?:E(?:CONN|HOST|NET|PIPE|AI_|NOTFOUND|TIMEDOUT|SOCKET)|ERR_(?:TLS|SSL)|ETLS)/i.test(code)
    || /^(?:UNAVAILABLE|SERVERBUG|LIMIT|CONTACTADMIN)$/i.test(responseCode)
    || /timeout|timed out|rate.?limit|too many|temporar|unavailable|certificate|\bTLS\b/i.test(message)) return "unavailable";
  if (detail.authenticationFailed === true || /^(?:EAUTH|AUTHENTICATIONFAILED)$/i.test(code)
    || /^AUTHENTICATIONFAILED$/i.test(responseCode)
    || /authentication (?:failed|failure)|invalid (?:credentials|password)|login failed|password (?:incorrect|rejected)/i.test(message)) return "rejected";
  return /connection|socket|network/i.test(message) ? "unavailable" : "unknown";
};

export function createMailboxService(deps: MailboxServiceDeps): MailboxService {
  const transportFactory = deps.transport ?? createMailTransport;
  let serial = Promise.resolve();
  let closed = false;
  const deleting = new Set<number>();
  const deletedRemote = new Set<string>();
  const abortSources = (ids: Iterable<string>) => {
    const unique = [...new Set(ids)].sort();
    if (!unique.length) return;
    try { deps.triageLifecycleHooks?.abortSources?.(unique); } catch { /* 提交后的最佳努力；fence 已经失效。 */ }
  };
  const lifecycleSourceHooks = (invalidated: Set<string>): SourceRegistrationHooks => ({
    onPendingSource: deps.triageSourceHooks?.onPendingSource,
    onSourceInvalidated: (input) => {
      const first = deps.triageSourceHooks?.onSourceInvalidated?.(input) as unknown;
      if (first != null && typeof first === "object" && "then" in first) throw new Error("来源失效钩子必须同步 synchronous");
      const second = deps.triageLifecycleHooks?.invalidateSource?.(input.sourceId, input.reason, input.now) as unknown;
      if (second != null && typeof second === "object" && "then" in second) throw new Error("来源生命周期钩子必须同步 synchronous");
      invalidated.add(input.sourceId);
    },
  });
  const triageTransaction = <T>(work: (hooks: SourceRegistrationHooks) => T): T => {
    const invalidated = new Set<string>();
    const result = sourceTransaction(deps.db, () => work(lifecycleSourceHooks(invalidated)));
    abortSources(invalidated);
    return result;
  };
  const assertWritable = () => {
    if (deps.readOnly) throw new Error("当前工作区是只读模式，不能执行会连接邮箱或修改数据的操作");
  };

  // 与索引写入队列分离，避免协调监听时互相等待；并发同步/设置/手动重试仍共用一条尝试队列。
  let defaultSerial = Promise.resolve();
  let lastDefaultAttemptAt = 0;
  const defaultTrying = new Map<number, string>();
  const defaultUnavailable = new Map<number, { fingerprint: string; error: string }>();
  const folderSyncs = new Map<string, Promise<void>>();
  type FolderMetadata = Awaited<ReturnType<MailTransport["listFolders"]>>;
  const folderMetadataCache = new Map<number, { expiresAt: number; value: FolderMetadata }>();
  const folderMetadataLoads = new Map<number, Promise<FolderMetadata>>();
  const sendsInFlight = new Map<string, { fingerprint: string; promise: Promise<MailSendResult> }>();
  const folderMetadataGeneration = new Map<number, number>();
  const defaultFingerprint = (password: string) => createHmac("sha256", deps.key)
    .update("mail.defaultPassword\0").update(password).digest("hex");

  const invalidateFolderMetadata = (mailboxId: number) => {
    folderMetadataGeneration.set(mailboxId, (folderMetadataGeneration.get(mailboxId) ?? 0) + 1);
    folderMetadataCache.delete(mailboxId);
    folderMetadataLoads.delete(mailboxId);
  };

  const loadFolderMetadata = (mailboxId: number): Promise<FolderMetadata> => {
    const box = row(mailboxId);
    const creds = credentials(box);
    const cached = folderMetadataCache.get(mailboxId);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
    const pending = folderMetadataLoads.get(mailboxId);
    if (pending) return pending;
    const generation = folderMetadataGeneration.get(mailboxId) ?? 0;
    const load = Promise.resolve().then(() => transportFactory().listFolders(creds)).then((value) => {
      if ((folderMetadataGeneration.get(mailboxId) ?? 0) === generation) {
        folderMetadataCache.set(mailboxId, { expiresAt: Date.now() + FOLDER_METADATA_TTL_MS, value });
      }
      return value;
    });
    folderMetadataLoads.set(mailboxId, load);
    void load.then(
      () => { if (folderMetadataLoads.get(mailboxId) === load) folderMetadataLoads.delete(mailboxId); },
      () => { if (folderMetadataLoads.get(mailboxId) === load) folderMetadataLoads.delete(mailboxId); },
    );
    return load;
  };

  let inSnapshotCommit = false;
  const exclusive = <T>(work: () => Promise<T> | T): Promise<T> => {
    if (inSnapshotCommit) throw new Error("快照提交不能再次进入 exclusive 串行槽");
    const task = serial.then(work, work);
    serial = task.then(() => undefined, () => undefined);
    return task;
  };

  const row = (id: number): MailboxRow => {
    const value = deps.db.prepare("SELECT * FROM mailboxes WHERE id = ?").get(id) as unknown as MailboxRow | undefined;
    if (!value || deleting.has(id)) throw new Error("邮箱不存在或正在删除");
    if (isAbandoned(value.domain)) throw new Error(`${value.domain} 已进入放弃流程，不能再操作邮箱`);
    return value;
  };
  const isAbandoned = (domain: string) => Boolean(deps.db.prepare("SELECT 1 FROM abandoned_domains WHERE domain = ? COLLATE NOCASE").get(domain));
  const credentials = (value: MailboxRow): MailCredentials => {
    if (!value.credential_ciphertext) throw new Error(`${value.address} 还没有保存密码`);
    const parsed = JSON.parse(unseal(deps.key, value.credential_ciphertext)) as MailCredentials;
    if (parsed.address.toLowerCase() !== value.address.toLowerCase() || !parsed.password) throw new Error("保存的邮箱凭据无效");
    return parsed;
  };
  const accountExec = (accountId: number) => {
    const account = deps.accounts().find((item) => item.id === accountId);
    if (!account) throw new Error(`Hostinger 账号 ${accountId} 已断开`);
    return account.exec;
  };
  const writeState = (id: number, patch: Partial<SyncState>) => {
    const current = deps.db.prepare("SELECT sync_state_json,credential_ciphertext FROM mailboxes WHERE id = ?").get(id) as Pick<MailboxRow, "sync_state_json" | "credential_ciphertext"> | undefined;
    if (!current) return;
    const state = { ...parseState(current), ...patch };
    // 默认凭据后续也会用于索引/IDLE；保留诊断，但服务器回显的密码不能写进数据库。
    if (state.credentialSource === "default" && state.lastError && current.credential_ciphertext) {
      const creds = JSON.parse(unseal(deps.key, current.credential_ciphertext)) as MailCredentials;
      state.lastError = redactPassword(state.lastError, creds.password);
    }
    deps.db.prepare("UPDATE mailboxes SET sync_state_json = ? WHERE id = ?").run(JSON.stringify(state), id);
  };
  const saveSiteCredential = (box: MailboxRow, creds: MailCredentials | null) => {
    const sites = deps.db.prepare(`SELECT s.id,s.form_json,s.mailbox_ciphertext,b.entity_json FROM sites s JOIN batches b ON b.id=s.batch_id
      WHERE s.domain=? COLLATE NOCASE`).all(box.domain) as unknown as { id: number; form_json: string; mailbox_ciphertext: Uint8Array | null; entity_json: string }[];
    for (const site of sites) {
      if (site.mailbox_ciphertext) {
        try {
          const old = JSON.parse(unseal(deps.key, site.mailbox_ciphertext)) as MailCredentials;
          if (old.address.toLowerCase() !== box.address.toLowerCase()) continue;
        } catch { continue; }
      } else {
        if (!creds) continue;
        try {
          const form = JSON.parse(site.form_json) as { supportEmail?: string };
          const entity = JSON.parse(site.entity_json) as { supportEmail?: string };
          const configured = form.supportEmail?.trim() || entity.supportEmail?.trim();
          const expected = configured === "auto" ? `support@${box.domain}` : configured;
          if (!expected || expected.toLowerCase() !== box.address.toLowerCase()) continue;
        } catch { continue; }
      }
      deps.db.prepare("UPDATE sites SET mailbox_ciphertext=? WHERE id=?").run(creds ? seal(deps.key, JSON.stringify(creds)) : null, site.id);
    }
  };

  const monitor = new MailboxMonitor({
    candidates: () => (deps.db.prepare(`SELECT * FROM mailboxes m WHERE monitoring = 1 AND credential_ciphertext IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM abandoned_domains a WHERE a.domain = m.domain COLLATE NOCASE) ORDER BY id`).all() as unknown as MailboxRow[])
      .filter((item) => !deleting.has(item.id)).map((item) => ({ id: item.id, domain: item.domain, credentials: credentials(item) })),
    transport: transportFactory,
    syncInbox: (mailboxId) => syncFolder(mailboxId, "INBOX"),
    setMode: (mailboxId, mode, error = null) => writeState(mailboxId, { monitorMode: mode, lastError: error }),
    ...deps.monitor,
  });

  async function importPipelineCredential(mailboxId: number, address: string, domain: string): Promise<void> {
    const siteRows = deps.db.prepare(`SELECT mailbox_ciphertext FROM sites
      WHERE domain = ? COLLATE NOCASE AND mailbox_ciphertext IS NOT NULL AND abandoned_at IS NULL`).all(domain) as unknown as { mailbox_ciphertext: Uint8Array }[];
    for (const site of siteRows) {
      try {
        const parsed = JSON.parse(unseal(deps.key, site.mailbox_ciphertext)) as MailCredentials;
        if (parsed.address.toLowerCase() !== address.toLowerCase() || !parsed.password) continue;
        deps.db.prepare("UPDATE mailboxes SET credential_ciphertext = ?, monitoring = 1 WHERE id = ? AND credential_ciphertext IS NULL").run(site.mailbox_ciphertext, mailboxId);
        invalidateFolderMetadata(mailboxId);
        writeState(mailboxId, { credentialSource: "pipeline" });
        return;
      } catch { /* 旧密文坏了不能阻断账号同步。 */ }
    }
  }

  async function inventory(accountId?: number): Promise<MailboxSummary[]> {
    assertWritable();
    if (closed) throw new Error("工作区已关闭");
    const accounts = deps.accounts().filter((account) => accountId == null || account.id === accountId);
    for (const account of accounts) {
      const orders = await listAll(account.exec, "mail_orders_list") as { id: string | number; status?: string; domain?: { name?: string } }[];
      const found: { orderId: string; remoteId: string; address: string; domain: string; status: string }[] = [];
      for (const order of orders) {
        const domain = order.domain?.name?.trim().toLowerCase();
        if (!domain || isAbandoned(domain) || monitor.isDomainBlocked(domain)) continue;
        const boxes = await listAll(account.exec, "mail_mailboxes_list", { orderId: String(order.id) }) as { id: string | number; address: string; status?: string }[];
        for (const box of boxes) {
          const remoteId = String(box.id);
          if (!deletedRemote.has(`${account.id}:${remoteId}`)) found.push({ orderId: String(order.id), remoteId, address: box.address.toLowerCase(), domain, status: box.status ?? "active" });
        }
      }
      const old = deps.db.prepare("SELECT id, remote_id FROM mailboxes WHERE account_id = ?").all(account.id) as unknown as { id: number; remote_id: string }[];
      const seen = new Set(found.map((item) => item.remoteId));
      const staleRows = old.filter((item) => !seen.has(item.remote_id));
      for (const stale of staleRows) {
        deleting.add(stale.id);
        deps.db.prepare("UPDATE mailboxes SET monitoring=0 WHERE id=?").run(stale.id);
        await monitor.stopMailbox(stale.id);
      }
      await exclusive(async () => {
        for (const item of found) {
          if (isAbandoned(item.domain)) continue;
          if (deletedRemote.has(`${account.id}:${item.remoteId}`)) continue;
          const existing = deps.db.prepare("SELECT id FROM mailboxes WHERE account_id=? AND remote_id=?").get(account.id, item.remoteId) as { id: number } | undefined;
          if (existing && deleting.has(existing.id)) continue;
          deps.db.prepare(`INSERT INTO mailboxes(account_id,order_id,remote_id,address,domain,status)
            VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,remote_id) DO UPDATE SET
            order_id=excluded.order_id,address=excluded.address,domain=excluded.domain,status=excluded.status`)
            .run(account.id, item.orderId, item.remoteId, item.address, item.domain, item.status);
          const saved = deps.db.prepare("SELECT id, credential_ciphertext FROM mailboxes WHERE account_id = ? AND remote_id = ?").get(account.id, item.remoteId) as { id: number; credential_ciphertext: Uint8Array | null };
          if (!saved.credential_ciphertext) await importPipelineCredential(saved.id, item.address, item.domain);
        }
        for (const stale of staleRows) {
          invalidateFolderMetadata(stale.id);
          deps.db.prepare("DELETE FROM mailboxes WHERE id = ?").run(stale.id);
          deleting.delete(stale.id);
        }
      });
    }
    await tryDefaultCredentials({ accountId });
    await monitor.reconcile();
    return list();
  }

  function list(): MailboxSummary[] {
    const password = getSecret(deps.db, deps.key, DEFAULT_PASSWORD_SECRET);
    const fingerprint = password ? defaultFingerprint(password) : null;
    const rows = deps.db.prepare(`SELECT m.*, a.label AS account_label,
      (SELECT count(*) FROM mail_messages x WHERE x.mailbox_id=m.id AND x.folder='INBOX' AND x.seen=0) AS unread
      FROM mailboxes m JOIN hostinger_accounts a ON a.id=m.account_id
      WHERE NOT EXISTS (SELECT 1 FROM abandoned_domains d WHERE d.domain=m.domain COLLATE NOCASE)
      ORDER BY m.domain,m.address`).all() as unknown as (MailboxRow & { account_label: string; unread: number })[];
    return rows.map((item) => {
      const state = parseState(item);
      return {
        id: item.id, accountId: item.account_id, accountLabel: item.account_label, orderId: item.order_id,
        domain: item.domain, address: item.address, credentialSaved: Boolean(item.credential_ciphertext),
        credentialSource: state.credentialSource ?? null, monitoring: Boolean(item.monitoring),
        defaultPasswordStatus: !fingerprint ? "unconfigured" : defaultTrying.get(item.id) === fingerprint ? "trying"
          : state.failedDefaultPasswordFingerprint === fingerprint ? "rejected"
          : defaultUnavailable.get(item.id)?.fingerprint === fingerprint ? "unavailable" : "pending",
        monitorMode: state.monitorMode ?? "off", unreadCount: Number(item.unread), lastSyncAt: item.last_synced_at,
        lastError: !item.credential_ciphertext && defaultUnavailable.get(item.id)?.fingerprint === fingerprint
          ? defaultUnavailable.get(item.id)!.error : state.lastError ?? null,
      };
    });
  }

  function tryDefaultCredentials(input: { mailboxId?: number; retry?: boolean; accountId?: number } = {}): Promise<MailDefaultPasswordResult> {
    if (deps.readOnly) return Promise.reject(new Error("当前工作区是只读模式，不能执行会连接邮箱或修改数据的操作"));
    // 指定邮箱必须先验证归属/墓碑；即使未配置默认密码，也不能把别人的 id 当成功处理。
    if (input.mailboxId != null) row(input.mailboxId);
    const task = defaultSerial.then(() => attemptDefaultCredentials(input));
    defaultSerial = task.then(() => undefined, () => undefined);
    return task;
  }

  async function attemptDefaultCredentials(input: { mailboxId?: number; retry?: boolean; accountId?: number }): Promise<MailDefaultPasswordResult> {
    const result: MailDefaultPasswordResult = { succeeded: 0, failed: 0, deferred: 0 };
    if (closed) return result;
    const password = getSecret(deps.db, deps.key, DEFAULT_PASSWORD_SECRET);
    if (!password) return result;
    const fingerprint = defaultFingerprint(password);
    const connected = new Set(deps.accounts().map((account) => account.id));
    const candidates = (deps.db.prepare(`SELECT * FROM mailboxes m WHERE credential_ciphertext IS NULL
      AND NOT EXISTS (SELECT 1 FROM abandoned_domains a WHERE a.domain=m.domain COLLATE NOCASE) ORDER BY id`).all() as unknown as MailboxRow[])
      .filter((box) => connected.has(box.account_id) && !deleting.has(box.id) && !monitor.isDomainBlocked(box.domain)
        && (input.mailboxId == null || box.id === input.mailboxId) && (input.accountId == null || box.account_id === input.accountId)
        && !parseState(box).pendingReset && (input.retry || parseState(box).failedDefaultPasswordFingerprint !== fingerprint));
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (closed || getSecret(deps.db, deps.key, DEFAULT_PASSWORD_SECRET) !== password) {
        result.deferred += candidates.length - index;
        break;
      }
      const delay = DEFAULT_ATTEMPT_DELAY_MS - (Date.now() - lastDefaultAttemptAt);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      // 等待期间可能手动输入、重置、删除、放弃或断开账号；不能覆盖或复活凭据。
      const eligible = (): MailboxRow | null => {
        if (closed || getSecret(deps.db, deps.key, DEFAULT_PASSWORD_SECRET) !== password
          || !deps.accounts().some((account) => account.id === candidate.account_id)) return null;
        try {
          const current = row(candidate.id);
          return !current.credential_ciphertext && !parseState(current).pendingReset
            && !monitor.isDomainBlocked(current.domain) && current.address === candidate.address ? current : null;
        } catch { return null; }
      };
      if (!eligible()) continue;
      // 用户明确重试就撤销旧结论：这轮若断网，下次同步仍应自动重试，而非沿用上次拒绝。
      if (input.retry) writeState(candidate.id, { failedDefaultPasswordFingerprint: undefined, lastError: null });
      defaultTrying.set(candidate.id, fingerprint);
      defaultUnavailable.delete(candidate.id);
      deps.push({ type: "changed", mailboxId: candidate.id });
      lastDefaultAttemptAt = Date.now();
      let rejected = false;
      let unavailable = false;
      let failureMessage = "邮件服务器暂时无法连接，稍后同步时会重试默认密码";
      try {
        try { await transportFactory().verify({ address: candidate.address, password }); }
        catch (error) {
          const kind = defaultFailureKind(error, password);
          rejected = kind === "rejected";
          unavailable = !rejected;
          if (kind === "unknown") failureMessage = `默认密码验证未完成：${redactPassword(error instanceof Error ? error.message : String(error), password)}`;
        }
        await exclusive(() => {
          const current = eligible();
          if (!current) return;
          if (unavailable) {
            defaultUnavailable.set(current.id, { fingerprint, error: failureMessage });
            writeState(current.id, { lastError: failureMessage });
          } else if (rejected) {
            writeState(current.id, { failedDefaultPasswordFingerprint: fingerprint, lastError: "默认密码不对，请输入这个邮箱的密码" });
            result.failed++;
          } else {
            const creds = { address: current.address, password };
            deps.db.prepare("UPDATE mailboxes SET credential_ciphertext=?, monitoring=1 WHERE id=? AND credential_ciphertext IS NULL")
              .run(seal(deps.key, JSON.stringify(creds)), current.id);
            invalidateFolderMetadata(current.id);
            writeState(current.id, { credentialSource: "default", lastError: null, failedDefaultPasswordFingerprint: undefined });
            saveSiteCredential(current, creds);
            result.succeeded++;
          }
        });
      } finally {
        defaultTrying.delete(candidate.id);
        deps.push({ type: "changed", mailboxId: candidate.id });
      }
      if (unavailable) {
        result.deferred += candidates.length - index;
        // 后续邮箱这轮已不会执行，不能继续把它们显示为“正在登录”。
        for (const deferred of candidates.slice(index + 1)) {
          defaultUnavailable.set(deferred.id, { fingerprint, error: "本轮默认密码验证已暂停，将在下次同步时重试" });
          deps.push({ type: "changed", mailboxId: deferred.id });
        }
        break;
      }
      // 与手动保存密码一致：立即开启监听，由监听器的首次 INBOX 同步建立索引。
      if (!rejected) await monitor.reconcile();
    }
    return result;
  }

  function recoverSources(): number {
    return recoverCachedSources(deps.db, deps.key, {
      hooks: deps.triageSourceHooks,
      isMailboxAvailable(mailboxId) {
        if (closed) return false;
        try { row(mailboxId); return true; } catch { return false; }
      },
    });
  }

  function syncFolder(mailboxId: number, requestedFolder: string): Promise<void> {
    if (deps.readOnly) return Promise.reject(new Error("当前工作区是只读模式，不能执行会连接邮箱或修改数据的操作"));
    const folder = normalizeFolder(requestedFolder);
    const syncKey = `${mailboxId}\0${folder}`;
    const pending = folderSyncs.get(syncKey);
    if (pending) return pending;
    const task = exclusive(() => performFolderSync(mailboxId, folder)).then(() => undefined);
    folderSyncs.set(syncKey, task);
    void task.then(
      () => { if (folderSyncs.get(syncKey) === task) folderSyncs.delete(syncKey); },
      () => { if (folderSyncs.get(syncKey) === task) folderSyncs.delete(syncKey); },
    );
    return task;
  }

  async function performFolderSync(mailboxId: number, folder: string) {
    const box = row(mailboxId);
    const state = parseState(box);
    const previous = state.folders?.[folder]?.uidValidity;
    const priorRows = deps.db.prepare("SELECT uid,seen,size,uid_validity,body_complete,body_issue FROM mail_messages WHERE mailbox_id=? AND folder=?").all(mailboxId, folder) as unknown as { uid: number; seen: number; size: number; uid_validity: string | null; body_complete: number; body_issue: string | null }[];
    const prior = new Map(priorRows.map((item) => [item.uid, item]));
    const before = new Set(prior.keys());
    const knownUids = new Set(priorRows.filter((item) => item.uid_validity === previous && (item.body_complete === 1 || item.body_issue !== null)).map((item) => item.uid));
    const nextFlags = new Map<number, string>();
    const present = new Set<number>();
    const fresh: number[] = [];
    let validity: string | undefined;
    let reset = false;
    let metadataChanged = false;
    let deleted = false;
    try {
      const upsert = deps.db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,message_id,from_json,to_json,cc_json,subject,date,snippet,seen,has_attachments,size,body_text,attachments_json,references_json,in_reply_to,uid_validity,body_complete,body_issue,from_addresses_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mailbox_id,folder,uid) DO UPDATE SET
        message_id=excluded.message_id,from_json=excluded.from_json,to_json=excluded.to_json,cc_json=excluded.cc_json,
        subject=excluded.subject,date=excluded.date,snippet=excluded.snippet,seen=excluded.seen,has_attachments=excluded.has_attachments,
        size=excluded.size,body_text=excluded.body_text,attachments_json=excluded.attachments_json,references_json=excluded.references_json,in_reply_to=excluded.in_reply_to,
        uid_validity=excluded.uid_validity,body_complete=excluded.body_complete,body_issue=excluded.body_issue,from_addresses_json=excluded.from_addresses_json`);
      const transport = transportFactory();
      const events = transport.streamMessages
        ? transport.streamMessages(credentials(box), folder, { uidValidity: verifiedUidValidity(previous) ? previous : undefined, uids: knownUids })
        : legacyMessageStream(transport, credentials(box), folder);
      for await (const event of events) {
        if (event.kind === "mailbox") {
          validity = event.uidValidity;
          if (!validity || /[\0\r\n]/.test(validity)) throw new Error("服务器返回无效 UIDVALIDITY");
          if (previous && validity !== previous) { reset = true; before.clear(); }
          triageTransaction((hooks) => {
            row(mailboxId);
            if (verifiedUidValidity(validity)) invalidateFolderGeneration(deps.db, { mailboxId, folder, uidValidity: validity }, Date.now(), hooks);
            // 已证实的世代重置立即撤销旧缓存；未验证的旧缓存保留给只读界面，逐封成功重建后才替换。
            if (previous && validity !== previous) deps.db.prepare("DELETE FROM mail_messages WHERE mailbox_id=? AND folder=?")
              .run(mailboxId, folder);
          });
          continue;
        }
        const message = event.message;
        if (!validity) throw new Error("邮件 MIME 前必须提供 UIDVALIDITY");
        if (message.uidValidity && message.uidValidity !== validity) throw new Error("邮件 UIDVALIDITY 与文件夹世代不匹配");
        present.add(message.uid);
        const flags = [...new Set(message.flags.filter((flag) => flag !== "\\Seen"))].sort().join("\0");
        nextFlags.set(message.uid, flags);
        if (!before.has(message.uid)) fresh.push(message.uid);
        else {
          const old = prior.get(message.uid)!;
          const seenChanged = old.seen !== (message.flags.includes("\\Seen") ? 1 : 0);
          if (seenChanged || old.size !== message.size) metadataChanged = true;
        }
        if (message.source) {
          const parsed = await safeParse(message);
          triageTransaction((hooks) => {
            row(mailboxId);
            upsert.run(mailboxId, folder, message.uid, parsed.messageId, JSON.stringify(parsed.from), JSON.stringify(parsed.to), JSON.stringify(parsed.cc),
              parsed.subject, parsed.date, parsed.snippet, message.flags.includes("\\Seen") ? 1 : 0, parsed.attachments.length ? 1 : 0,
              message.size, parsed.text, JSON.stringify(parsed.attachments), JSON.stringify(parsed.references), parsed.inReplyTo,
              verifiedUidValidity(validity) ? validity : null, parsed.bodyComplete ? 1 : 0, parsed.bodyIssue, JSON.stringify(parsed.fromAddresses));
            if (verifiedUidValidity(validity)) registerCachedSource(deps.db, { locator: { mailboxId, folder, uidValidity: validity, uid: message.uid }, mail: parsed, observedAt: Date.now() }, deps.key, hooks);
          });
        } else {
          row(mailboxId);
          const changed = deps.db.prepare("UPDATE mail_messages SET seen=?,size=? WHERE mailbox_id=? AND folder=? AND uid=?")
            .run(message.flags.includes("\\Seen") ? 1 : 0, message.size, mailboxId, folder, message.uid);
          if (changed.changes !== 1) throw new Error(`邮件 ${folder}/${message.uid} 缺少 MIME 原文，无法建立索引`);
        }
      }
      if (!validity) throw new Error(`邮件服务器没有返回 ${folder} 的 UIDVALIDITY`);
      triageTransaction((hooks) => {
        row(mailboxId);
        if (verifiedUidValidity(validity)) reconcileFolderSnapshot(deps.db, { mailboxId, folder, uidValidity: validity, presentUids: [...present], complete: true }, Date.now(), hooks);
        for (const uid of before) if (!present.has(uid)) {
          deps.db.prepare("DELETE FROM mail_messages WHERE mailbox_id=? AND folder=? AND uid=?").run(mailboxId, folder, uid);
          deleted = true;
        }
        const nonSeenFlagsDigest = createHash("sha256")
          .update(JSON.stringify([...nextFlags].sort(([left], [right]) => left - right))).digest("hex");
        if (state.folders?.[folder]?.nonSeenFlagsDigest
          && state.folders[folder].nonSeenFlagsDigest !== nonSeenFlagsDigest) metadataChanged = true;
        const syncedAt = Date.now();
        const current = parseState(row(mailboxId));
        const nextState: SyncState = { ...current, lastError: null, folders: { ...(current.folders ?? {}), [folder]: { uidValidity: validity, syncedAt, nonSeenFlagsDigest } } };
        deps.db.prepare("UPDATE mailboxes SET last_synced_at=?,sync_state_json=? WHERE id=?").run(syncedAt, JSON.stringify(nextState), mailboxId);
      });
      recoverSources();
    } catch (error) {
      const safeError = state.credentialSource === "default"
        ? new Error(redactPassword(error instanceof Error ? error.message : String(error), credentials(box).password)) : error;
      writeState(mailboxId, { lastError: safeError instanceof Error ? safeError.message : String(safeError) });
      throw safeError;
    }
    const unread = Number((deps.db.prepare("SELECT count(*) AS n FROM mail_messages WHERE mailbox_id=? AND folder='INBOX' AND seen=0").get(mailboxId) as { n: number }).n);
    if (reset) deps.push({ type: "changed", mailboxId, folder });
    else if (folder.toUpperCase() === "INBOX" && fresh.length) {
      if (!previous) deps.push({ type: "changed", mailboxId, folder, unreadCount: unread });
      else deps.push({ type: "new", mailboxId, folder, uid: Math.max(...fresh), unreadCount: unread });
    }
    else if (fresh.length) deps.push({ type: "changed", mailboxId, folder });
    else if (deleted || metadataChanged) deps.push({ type: "changed", mailboxId, folder });
    return { uidValidity: validity!, maxUid: Math.max(0, ...present), complete: true as const };
  }

  function withInboxSnapshot<T>(mailboxId: number, commit: (snapshot: { uidValidity: string; maxUid: number; complete: true }) => T): Promise<T> {
    assertWritable();
    if (commit.constructor.name === "AsyncFunction") return Promise.reject(new Error("快照 commit 必须同步 synchronous"));
    return exclusive(async () => {
      const snapshot = await performFolderSync(mailboxId, "INBOX");
      if (!verifiedUidValidity(snapshot.uidValidity)) throw new Error("授权快照需要真实 UIDVALIDITY");
      return sourceTransaction(deps.db, () => {
        row(mailboxId);
        inSnapshotCommit = true;
        try { return commit(snapshot); } finally { inSnapshotCommit = false; }
      });
    });
  }

  async function safeParse(message: RemoteMessage): Promise<ParsedSafeMessage> {
    if (message.size > MAX_INCOMING || (message.source?.byteLength ?? 0) > MAX_INCOMING) return {
      fromAddresses: [], bodyComplete: false, bodyIssue: "oversized",
      messageId: null, from: "", to: [] as string[], cc: [] as string[], subject: "邮件过大，未缓存正文", date: 0,
      text: "这封邮件超过 25 MB，本地没有解析正文。", snippet: "这封邮件超过 25 MB，本地没有解析正文。",
      inReplyTo: null, references: [] as string[], attachments: [] as MailAttachment[],
    };
    if (!message.source) throw new Error(`邮件 ${message.folder}/${message.uid} 缺少 MIME 原文`);
    try {
      return await parseMailText(message.source);
    } catch {
      const text = "这封邮件的正文无法安全解析，本地没有渲染其 HTML 内容。";
      return { fromAddresses: [], bodyComplete: false, bodyIssue: "parse_failed", messageId: null, from: "", to: [] as string[], cc: [] as string[], subject: "邮件正文无法安全解析", date: 0,
        text, snippet: text, inReplyTo: null, references: [] as string[], attachments: [] as MailAttachment[] };
    }
  }

  async function* legacyMessageStream(transport: MailTransport, creds: MailCredentials, folder: string) {
    const messages = await transport.fetchMessages(creds, folder);
    yield { kind: "mailbox" as const, uidValidity: messages[0]?.uidValidity ?? "legacy" };
    for (const message of messages) yield { kind: "message" as const, message };
  }

  const messageFromRow = (item: Record<string, unknown>): MailMessageDetail => {
    let readIdentity:string|undefined;
    try {
      const uidValidity=String(item.uid_validity??"");
      if(verifiedUidValidity(uidValidity)) readIdentity=cacheReadIdentity(deps.key,{mailboxId:Number(item.mailbox_id),folder:String(item.folder),uidValidity,uid:Number(item.uid)},fingerprintSource(deps.key,cachedParsedMessage(item)));
    } catch { /* malformed cache rows remain readable but cannot receive annotations */ }
    return {
    uid: Number(item.uid), folder: String(item.folder), from: JSON.parse(String(item.from_json)) as string,
    to: JSON.parse(String(item.to_json)) as string[], cc: JSON.parse(String(item.cc_json)) as string[],
    subject: String(item.subject), date: item.date == null ? 0 : Number(item.date), snippet: String(item.snippet),
    seen: Boolean(item.seen), hasAttachments: Boolean(item.has_attachments), size: Number(item.size), text: String(item.body_text ?? ""),
    messageId: item.message_id == null ? null : String(item.message_id), inReplyTo: item.in_reply_to == null ? null : String(item.in_reply_to),
    references: JSON.parse(String(item.references_json)) as string[], attachments: JSON.parse(String(item.attachments_json)) as MailAttachment[],
    ...(readIdentity?{readIdentity}:{}),
  };};

  function sourceMessage(raw: CaseSourceReaderRef): { ref: CaseSourceReaderRef; message: MailMessageDetail } {
    const input = CaseSourceReaderRefSchema.parse(raw);
    const unavailable = (): never => { throw new Error("source_unavailable"); };
    const source = deps.db.prepare(`SELECT s.source_hash,s.critical_headers_hash FROM mail_case_sources cs
      JOIN mail_triage_sources s ON s.id=cs.source_id
      JOIN mail_triage_source_aliases a ON a.source_id=s.id AND a.mailbox_id=s.mailbox_id
        AND a.folder=? AND a.uid_validity=? AND a.uid=? AND a.active=1
      JOIN mail_triage_settings cfg ON cfg.id=1 AND cfg.enabled=1 AND cfg.state<>'disabled'
      JOIN mail_triage_scope scope ON scope.mailbox_id=s.mailbox_id AND scope.epoch=cfg.config_epoch
        AND scope.state='authorized' AND scope.uid_validity=a.uid_validity AND scope.effective_at IS NOT NULL
      JOIN mailboxes box ON box.id=s.mailbox_id AND box.status NOT IN ('deleting','closed','deleted')
      WHERE cs.case_id=? AND cs.source_id=? AND s.source_version=? AND s.mailbox_id=? AND s.state='active'
        AND NOT EXISTS(SELECT 1 FROM abandoned_domains abandoned WHERE abandoned.domain=box.domain COLLATE NOCASE)`)
      .get(input.folder,input.uidValidity,input.uid,input.caseId,input.sourceId,input.sourceVersion,input.mailboxId) as { source_hash: string; critical_headers_hash: string } | undefined;
    if (!source || closed || deleting.has(input.mailboxId)) return unavailable();
    const cached = deps.db.prepare("SELECT * FROM mail_messages WHERE mailbox_id=? AND folder=? AND uid_validity=? AND uid=?")
      .get(input.mailboxId,input.folder,input.uidValidity,input.uid) as Record<string, unknown> | undefined;
    if (!cached) return unavailable();
    let parsed: ParsedSafeMessage;
    try { parsed = cachedParsedMessage(cached); } catch { return unavailable(); }
    const fingerprints = fingerprintSource(deps.key, parsed);
    if (fingerprints.sourceHash !== source.source_hash || fingerprints.criticalHeadersHash !== source.critical_headers_hash) return unavailable();
    return CaseSourceMessageOutputSchema.parse({ ref: input, message: messageFromRow(cached) });
  }

  function sourcePreview(raw: { sourceId: string; sourceVersion: number }) {
    const input = ReviewSourcePreviewInputSchema.parse(raw);
    const unavailable = (): never => { throw new Error("source_unavailable"); };
    const rows = deps.db.prepare(`SELECT s.source_hash,s.critical_headers_hash,s.mailbox_id,a.folder,a.uid_validity,a.uid
      FROM mail_triage_sources s
      JOIN mail_triage_source_aliases a ON a.source_id=s.id AND a.mailbox_id=s.mailbox_id AND a.active=1
      JOIN mail_triage_settings cfg ON cfg.id=1 AND cfg.enabled=1 AND cfg.state<>'disabled'
      JOIN mail_triage_scope scope ON scope.mailbox_id=s.mailbox_id AND scope.epoch=cfg.config_epoch AND scope.state='authorized' AND scope.uid_validity=a.uid_validity AND scope.effective_at IS NOT NULL
      JOIN mailboxes box ON box.id=s.mailbox_id AND box.status NOT IN ('deleting','closed','deleted')
      WHERE s.id=? AND s.source_version=? AND s.state='active'
        AND NOT EXISTS(SELECT 1 FROM abandoned_domains abandoned WHERE abandoned.domain=box.domain COLLATE NOCASE)
      ORDER BY a.folder,a.uid`).all(input.sourceId,input.sourceVersion) as { source_hash:string;critical_headers_hash:string;mailbox_id:number;folder:string;uid_validity:string;uid:number }[];
    if(rows.length!==1)return unavailable();
    const row=rows[0]!,mailboxId=Number(row.mailbox_id);
    if(closed||deleting.has(mailboxId))return unavailable();
    const cached=deps.db.prepare("SELECT * FROM mail_messages WHERE mailbox_id=? AND folder=? AND uid_validity=? AND uid=?").get(mailboxId,row.folder,row.uid_validity,row.uid) as Record<string,unknown>|undefined;
    if(!cached)return unavailable();
    let parsed:ParsedSafeMessage;try{parsed=cachedParsedMessage(cached);}catch{return unavailable();}
    const fingerprints=fingerprintSource(deps.key,parsed);
    if(fingerprints.sourceHash!==row.source_hash||fingerprints.criticalHeadersHash!==row.critical_headers_hash)return unavailable();
    const sourceRef:SourceReaderRef={sourceId:input.sourceId,sourceVersion:input.sourceVersion,mailboxId,folder:row.folder,uidValidity:row.uid_validity,uid:Number(row.uid)};
    const cases=deps.db.prepare("SELECT case_id FROM mail_case_sources WHERE source_id=? ORDER BY case_id LIMIT 2").all(input.sourceId) as {case_id:string}[];
    const readerRef=cases.length===1?{...sourceRef,caseId:String(cases[0]!.case_id)}:null;
    return ReviewSourceMessageOutputSchema.parse({sourceRef,readerRef,message:messageFromRow(cached)});
  }

  async function getMessage(input: { mailboxId: number; folder: string; uid: number }): Promise<MailMessageDetail> {
    const box = row(input.mailboxId);
    if (!deps.readOnly) credentials(box);
    const folder = normalizeFolder(input.folder);
    let found = deps.db.prepare("SELECT * FROM mail_messages WHERE mailbox_id=? AND folder=? AND uid=?").get(input.mailboxId, folder, input.uid) as Record<string, unknown> | undefined;
    if (!found) {
      if (deps.readOnly) throw new Error("只读查询未缓存这封邮件；为避免连接邮箱或写入数据，没有自动同步");
      await syncFolder(input.mailboxId, folder);
      found = deps.db.prepare("SELECT * FROM mail_messages WHERE mailbox_id=? AND folder=? AND uid=?").get(input.mailboxId, folder, input.uid) as Record<string, unknown> | undefined;
    }
    if (!found) throw new Error("邮件不存在或已被其他客户端删除");
    return messageFromRow(found);
  }

  async function saveCredential(input: { mailboxId: number; password: string }, source: Exclude<MailCredentialSource, "pipeline" | null> = "user") {
    assertWritable();
    const box = row(input.mailboxId);
    if (!input.password) throw new Error("请输入邮箱密码");
    const creds = { address: box.address, password: input.password };
    await transportFactory().verify(creds);
    await exclusive(() => {
      row(input.mailboxId);
      invalidateFolderMetadata(input.mailboxId);
      deps.db.prepare("UPDATE mailboxes SET credential_ciphertext=?, monitoring=1 WHERE id=?").run(seal(deps.key, JSON.stringify(creds)), input.mailboxId);
      writeState(input.mailboxId, { credentialSource: source, lastError: null, pendingReset: undefined, failedDefaultPasswordFingerprint: undefined });
      defaultUnavailable.delete(input.mailboxId);
      saveSiteCredential(row(input.mailboxId), creds);
    });
    await monitor.reconcile();
    deps.push({ type: "changed", mailboxId: input.mailboxId });
    return { ok: true as const };
  }

  async function performSend(input: MailSendInput): Promise<MailSendResult> {
    assertWritable();
    const box = row(input.mailboxId);
    const selection = validateMailSendSelection(deps.db, input);
    const creds = credentials(box);
    const attachments = (input.attachments ?? []).map((attachment) => {
      const content = Buffer.from(attachment.dataBase64, "base64");
      if (content.byteLength !== attachment.size) throw new Error(`附件 ${attachment.name} 大小校验失败`);
      return { filename: attachment.name, contentType: attachment.type || "application/octet-stream", content };
    });
    if (attachments.reduce((sum, item) => sum + item.content.byteLength, 0) > MAX_ATTACHMENTS) throw new Error("附件总大小不能超过 20 MB");
    let to = normalizeEmailList(input.to), cc = normalizeEmailList(input.cc), subject = input.subject.trim(), text = input.text;
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    if ((input.mode ?? "new") !== "new") {
      if (!input.replyTo) throw new Error("回复或转发缺少原邮件");
       const original = input.replyTo.readerRef
         ? sourceMessage(input.replyTo.readerRef).message
         : await getMessage({ mailboxId: input.mailboxId, folder: input.replyTo.folder, uid: input.replyTo.uid });
      inReplyTo = original.messageId ?? undefined;
      references = [...(original.references ?? []), ...(original.messageId ? [original.messageId] : [])];
      if (input.mode === "reply") to = uniqueEmails([original.from]);
      if (input.mode === "replyAll") {
        to = uniqueEmails([original.from, ...original.to], box.address);
        cc = uniqueEmails(original.cc, box.address).filter((address) => !to.some((target) => target.toLowerCase() === address.toLowerCase()));
      }
      const prefix = input.mode === "forward" ? "Fwd:" : "Re:";
      if (!subject) subject = new RegExp(`^${prefix}`, "i").test(original.subject) ? original.subject : `${prefix} ${original.subject}`;
      text = `${text.trim()}\n\n--- 原始邮件 ---\n发件人：${original.from}\n日期：${new Date(original.date).toISOString()}\n主题：${original.subject}\n\n${original.text}`;
    }
    if (!to.length) throw new Error("请填写收件人");
    row(input.mailboxId); // 读取原邮件期间可能开始放弃域名；准备收据和 SMTP 前必须再拦一次。
    const bcc = normalizeEmailList(input.bcc), messageId = `<${randomUUID()}@${box.domain}>`;
    const prepared = prepareMailSend(deps.db, {
      requestId: input.requestId, mailboxId: input.mailboxId, caseId: input.caseId,
      selectedTaskIds: selection.selectedTaskIds, replySourceId: selection.replySourceId,
      canonicalContent: {
        from: box.address, to, cc, bcc, subject, text, inReplyTo: inReplyTo ?? null, references: references ?? [],
        attachments: attachments.map((item) => ({ filename: item.filename, contentType: item.contentType, size: item.content.byteLength, sha256: createHash("sha256").update(item.content).digest("hex") })),
      },
    });
    if (prepared.replay) {
      if (!prepared.replay.appended) throw new Error(`发送成功，但未保存到已发送（${prepared.replay.messageId}）；请核对副本，不能直接重发`);
      return prepared.replay;
    }
    let sent: Awaited<ReturnType<MailTransport["send"]>>;
    try {
      sent = await transportFactory().send(creds, { from: box.address, to, cc, bcc, subject, text, messageId, inReplyTo, references, attachments });
    } catch (error) {
      if (error instanceof MailSentAppendError) {
        settleMailSendAccepted(deps.db, { receiptId: prepared.receiptId, caseId: input.caseId, selectedTaskIds: prepared.selectedTaskIds, messageId: error.messageId, appended: false, replySourceId: prepared.replySourceId });
        throw new Error(`发送成功，但未保存到已发送（${error.messageId}）；请核对副本，不能直接重发`);
      }
      const knownNotDispatched = error !== null && typeof error === "object" && (error as { dispatched?: unknown }).dispatched === false;
      settleMailSendFailure(deps.db, prepared.receiptId, knownNotDispatched ? "failed" : "unknown");
      throw new Error(knownNotDispatched ? "邮件未出站；请使用新的发送操作重试" : "发送状态未知，请核对后再决定，系统不会自动重发");
    }
    return settleMailSendAccepted(deps.db, { receiptId: prepared.receiptId, caseId: input.caseId, selectedTaskIds: prepared.selectedTaskIds, messageId: sent.messageId, appended: sent.appended, replySourceId: prepared.replySourceId });
  }

  return {
    list,
    isAvailable(mailboxId) {
      if (closed || deleting.has(mailboxId)) return false;
      const state = deps.db.prepare("SELECT status FROM mailboxes WHERE id=?").get(mailboxId);
      return Boolean(state && !["deleting", "closed", "deleted"].includes(String(state.status)));
    },
    withInboxSnapshot,
    sourceMessage,
    sourcePreview,
    sync: inventory,
    async reconcile() { if (!closed && !deps.readOnly) { await exclusive(() => recoverSources()); await monitor.reconcile(); } },
    async folders(mailboxId) {
      const box = row(mailboxId);
      if (deps.readOnly) {
        const cached = deps.db.prepare("SELECT DISTINCT folder FROM mail_messages WHERE mailbox_id=?").all(mailboxId) as unknown as { folder: string }[];
        const paths = [...new Set([...Object.keys(parseState(box).folders ?? {}), ...cached.map((item) => item.folder), "INBOX"])]
          .sort((left, right) => left.localeCompare(right));
        return paths.map((path): MailFolder => {
          const counts = deps.db.prepare("SELECT count(*) AS total,sum(CASE WHEN seen=0 THEN 1 ELSE 0 END) AS unread FROM mail_messages WHERE mailbox_id=? AND folder=?")
            .get(mailboxId, path) as { total: number; unread: number | null };
          return { name: path, path, total: Number(counts.total), unread: Number(counts.unread ?? 0), specialUse: path.toUpperCase() === "INBOX" ? "\\Inbox" : null };
        });
      }
      const folders = await loadFolderMetadata(mailboxId);
      return folders.map((folder): MailFolder => {
        const counts = deps.db.prepare("SELECT count(*) AS total,sum(CASE WHEN seen=0 THEN 1 ELSE 0 END) AS unread FROM mail_messages WHERE mailbox_id=? AND folder=?")
          .get(mailboxId, folder.path) as { total: number; unread: number | null };
        return { ...folder, total: Number(counts.total), unread: Number(counts.unread ?? 0) };
      });
    },
    async messages(input) {
      const box = row(input.mailboxId);
      const folder = normalizeFolder(input.folder);
      const latest = parseState(box).folders?.[folder]?.syncedAt;
      if (!deps.readOnly) {
        if (latest == null) await syncFolder(input.mailboxId, folder);
        else if (Date.now() - latest > 30_000) void syncFolder(input.mailboxId, folder).catch(() => undefined);
      }
      const page = Math.max(1, Math.floor(input.page ?? 1));
      const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize ?? 50)));
      const query = input.query?.trim() ?? "";
      const where = `mailbox_id=? AND folder=?${query ? " AND (subject LIKE ? ESCAPE '\\' OR from_json LIKE ? ESCAPE '\\')" : ""}`;
      const escaped = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
      const args: (string | number)[] = [input.mailboxId, folder, ...(query ? [escaped, escaped] : [])];
      const total = Number((deps.db.prepare(`SELECT count(*) AS n FROM mail_messages WHERE ${where}`).get(...args) as { n: number }).n);
      const rows = deps.db.prepare(`SELECT * FROM mail_messages WHERE ${where} ORDER BY date DESC,uid DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as unknown as Record<string, unknown>[];
      return { items: rows.map((item): MailMessageSummary => { const detail = messageFromRow(item); const { text: _text, attachments: _attachments, ...summary } = detail; return summary; }), total, page, pageSize };
    },
    message: getMessage,
    saveCredential,
    tryDefaultCredentials,
    async resetCredential(input) {
      assertWritable();
      if (!input.confirmed) throw new Error("重置密码会让其他邮件客户端停止工作，必须明确确认");
      const box = row(input.mailboxId);
      invalidateFolderMetadata(input.mailboxId);
      const state = parseState(box);
      let creds: MailCredentials;
      if (state.pendingReset) creds = JSON.parse(unseal(deps.key, Buffer.from(state.pendingReset, "base64"))) as MailCredentials;
      else {
        creds = { address: box.address, password: getSecret(deps.db, deps.key, DEFAULT_PASSWORD_SECRET) ?? `Aa1!${randomBytes(18).toString("base64url")}` };
        writeState(box.id, { pendingReset: Buffer.from(seal(deps.key, JSON.stringify(creds))).toString("base64") });
      }
      row(input.mailboxId); // 写远端前再次检查放弃墓碑。
      let writeError: unknown;
      try { await accountExec(box.account_id)("mail_mailboxes_change-mailbox-password", { mailboxId: box.remote_id, password: creds.password }); } catch (error) { writeError = error; }
      let verifyError: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await transportFactory().verify(creds); verifyError = undefined; break; } catch (error) { verifyError = error; if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt)); }
      }
      if (verifyError) throw new Error(`密码重置后的 IMAP 验证失败：${verifyError instanceof Error ? verifyError.message : String(verifyError)}${writeError ? "（Hostinger 写入结果未知）" : ""}`);
      return saveCredential({ mailboxId: input.mailboxId, password: creds.password }, "reset");
    },
    async setMonitoring(input) {
      assertWritable();
      const box = row(input.mailboxId);
      if (input.enabled) credentials(box);
      deps.db.prepare("UPDATE mailboxes SET monitoring=? WHERE id=?").run(input.enabled ? 1 : 0, input.mailboxId);
      if (!input.enabled) await monitor.stopMailbox(input.mailboxId);
      await monitor.reconcile();
      deps.push({ type: "changed", mailboxId: input.mailboxId });
      return { ok: true };
    },
    async markSeen(input) {
      assertWritable();
      const box = row(input.mailboxId);
      const folder = normalizeFolder(input.folder);
      await transportFactory().setSeen(credentials(box), folder, input.uid, input.seen);
      deps.db.prepare("UPDATE mail_messages SET seen=? WHERE mailbox_id=? AND folder=? AND uid=?").run(input.seen ? 1 : 0, input.mailboxId, folder, input.uid);
      deps.push({ type: "changed", mailboxId: input.mailboxId, folder, uid: input.uid });
      return { ok: true };
    },
    async trash(input) {
      assertWritable();
      if (!input.confirmed) throw new Error("删除邮件前必须确认");
      const box = row(input.mailboxId);
      const folder = normalizeFolder(input.folder);
      const cached = deps.db.prepare("SELECT uid_validity FROM mail_messages WHERE mailbox_id=? AND folder=? AND uid=?")
        .get(input.mailboxId, folder, input.uid) as { uid_validity: string | null } | undefined;
      const fencedSource = await exclusive(() => {
        return triageTransaction((hooks) => {
          row(input.mailboxId);
          return verifiedUidValidity(cached?.uid_validity)
            ? invalidateCachedLocator(deps.db, { mailboxId: input.mailboxId, folder, uidValidity: cached.uid_validity, uid: input.uid }, Date.now(), hooks, "missing")
            : null;
        });
      });
      if (fencedSource && !fencedSource.lastAlias) abortSources([fencedSource.sourceId]);
      // fence/abort 已提交后才接触远端；未知结果保持 missing/cancelled，不猜成功也不恢复自动化。
      await transportFactory().moveToTrash(credentials(box), folder, input.uid);
      await exclusive(() => triageTransaction((hooks) => {
        row(input.mailboxId);
        if (fencedSource?.lastAlias) hooks.onSourceInvalidated?.({ sourceId: fencedSource.sourceId, reason: "explicit_delete", now: Date.now() });
        // 远端等待期间若世代已换，不能误删同 UID 的新邮件。
        if (cached) deps.db.prepare("DELETE FROM mail_messages WHERE mailbox_id=? AND folder=? AND uid=? AND uid_validity IS ?")
          .run(input.mailboxId, folder, input.uid, cached.uid_validity);
      }));
      deps.push({ type: "changed", mailboxId: input.mailboxId, folder, uid: input.uid });
      return { ok: true };
    },
    async deleteMailbox(input) {
      assertWritable();
      if (!input.confirmed) throw new Error("删除邮箱前必须确认");
      const box = row(input.mailboxId);
      deleting.add(input.mailboxId);
      invalidateFolderMetadata(input.mailboxId);
      deps.db.prepare("UPDATE mailboxes SET monitoring=0 WHERE id=?").run(input.mailboxId);
      const sourceIds = (deps.db.prepare("SELECT id FROM mail_triage_sources WHERE mailbox_id=? ORDER BY id").all(input.mailboxId) as { id: string }[]).map((item) => item.id);
      const revoked = deps.triageLifecycleHooks?.invalidateScope?.({ mailboxIds: [input.mailboxId], reason: "mailbox_delete" }, Date.now());
      abortSources(revoked?.abortSourceIds ?? sourceIds);
      await monitor.stopMailbox(input.mailboxId);
      try {
        let writeError: unknown;
        try { await accountExec(box.account_id)("mail_mailboxes_delete-mailbox", { mailboxId: box.remote_id }); } catch (error) { writeError = error; }
        const remaining = await listAll(accountExec(box.account_id), "mail_mailboxes_list", { orderId: box.order_id }) as { id: string | number }[];
        if (remaining.some((item) => String(item.id) === box.remote_id)) throw writeError instanceof Error ? writeError : new Error("Hostinger 没有确认邮箱已删除，请稍后重试");
        deletedRemote.add(`${box.account_id}:${box.remote_id}`);
        sourceTransaction(deps.db, () => {
          for (const sourceId of sourceIds) deps.triageLifecycleHooks?.invalidateSource?.(sourceId, "explicit_delete", Date.now());
          saveSiteCredential(box, null);
          deps.db.prepare("DELETE FROM mailboxes WHERE id=?").run(input.mailboxId);
        });
        abortSources(sourceIds);
        deps.push({ type: "changed", mailboxId: input.mailboxId });
        return { ok: true };
      } finally {
        deleting.delete(input.mailboxId);
        await monitor.reconcile();
      }
    },
    send(input) {
      if (!input.requestId) return performSend(input);
      const pending = sendsInFlight.get(input.requestId);
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      if (pending) {
        if (pending.fingerprint !== fingerprint) return Promise.reject(new Error("request_id_conflict：requestId 已用于不同内容"));
        return pending.promise;
      }
      const running = performSend(input);
      sendsInFlight.set(input.requestId, { fingerprint, promise: running });
      void running.finally(() => { if (sendsInFlight.get(input.requestId!)?.promise === running) sendsInFlight.delete(input.requestId!); }).catch(() => {});
      return running;
    },
    async attachment(input) {
      assertWritable();
      const box = row(input.mailboxId);
      const detail = await getMessage(input);
      const attachment = detail.attachments.find((item) => item.partId === input.partId);
      if (!attachment) throw new Error("附件不存在");
      if (attachment.size > MAX_ATTACHMENTS) throw new Error("附件超过 20 MB，不能下载");
      const data = await transportFactory().downloadAttachment(credentials(box), input.folder, input.uid, attachment);
      if (data.byteLength > MAX_ATTACHMENTS) throw new Error("附件超过 20 MB，已停止下载");
      return { name: attachment.name, type: attachment.type, size: data.byteLength, data };
    },
    async stopDomain(domain) {
      assertWritable();
      await monitor.stopDomain(domain);
      await exclusive(() => undefined);
    },
    async close() {
      if (closed) return;
      closed = true;
      await defaultSerial;
      await monitor.close();
      await exclusive(() => undefined);
    },
  };
}
