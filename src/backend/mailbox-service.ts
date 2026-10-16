import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  MailAttachment, MailEvent, MailFolder, MailListResult, MailMessageDetail, MailMessageSummary,
  MailSendInput, MailboxSummary, MailCredentialSource, MailMonitorMode, MailDefaultPasswordResult,
} from "../shared/mail-types.ts";
import { listAll, type HostingerExec } from "./hostinger.ts";
import { parseMailText } from "./mailbox-parser.ts";
import { MailboxMonitor } from "./mailbox-monitor.ts";
import type { MailCredentials, MailTransport, MailTransportFactory, RemoteMessage } from "./mailbox-transport.ts";
import { getSecret, seal, unseal } from "./secrets.ts";
import { createMailTransport } from "./mailbox-adapter.ts";

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
}

export interface MailboxService {
  list(): MailboxSummary[];
  sync(accountId?: number): Promise<MailboxSummary[]>;
  reconcile(): Promise<void>;
  folders(mailboxId: number): Promise<MailFolder[]>;
  messages(input: { mailboxId: number; folder: string; query?: string; page?: number; pageSize?: number }): Promise<MailListResult>;
  message(input: { mailboxId: number; folder: string; uid: number }): Promise<MailMessageDetail>;
  saveCredential(input: { mailboxId: number; password: string }): Promise<{ ok: true }>;
  tryDefaultCredentials(input?: { mailboxId?: number; retry?: boolean; accountId?: number }): Promise<MailDefaultPasswordResult>;
  resetCredential(input: { mailboxId: number; confirmed: boolean }): Promise<{ ok: true }>;
  setMonitoring(input: { mailboxId: number; enabled: boolean }): Promise<{ ok: true }>;
  markSeen(input: { mailboxId: number; folder: string; uid: number; seen: boolean }): Promise<{ ok: true }>;
  trash(input: { mailboxId: number; folder: string; uid: number; confirmed: boolean }): Promise<{ ok: true }>;
  deleteMailbox(input: { mailboxId: number; confirmed: boolean }): Promise<{ ok: true }>;
  send(input: MailSendInput): Promise<{ messageId: string; appended: boolean }>;
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

  const exclusive = <T>(work: () => Promise<T> | T): Promise<T> => {
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
    const sites = deps.db.prepare(`SELECT s.id,s.mailbox_ciphertext,b.entity_json FROM sites s JOIN batches b ON b.id=s.batch_id
      WHERE s.domain=? COLLATE NOCASE`).all(box.domain) as unknown as { id: number; mailbox_ciphertext: Uint8Array | null; entity_json: string }[];
    for (const site of sites) {
      if (site.mailbox_ciphertext) {
        try {
          const old = JSON.parse(unseal(deps.key, site.mailbox_ciphertext)) as MailCredentials;
          if (old.address.toLowerCase() !== box.address.toLowerCase()) continue;
        } catch { continue; }
      } else {
        if (!creds) continue;
        try {
          const entity = JSON.parse(site.entity_json) as { supportEmail?: string };
          const expected = entity.supportEmail === "auto" ? `support@${box.domain}` : entity.supportEmail?.trim();
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

  function syncFolder(mailboxId: number, requestedFolder: string): Promise<void> {
    if (deps.readOnly) return Promise.reject(new Error("当前工作区是只读模式，不能执行会连接邮箱或修改数据的操作"));
    const folder = normalizeFolder(requestedFolder);
    const syncKey = `${mailboxId}\0${folder}`;
    const pending = folderSyncs.get(syncKey);
    if (pending) return pending;
    const task = exclusive(async () => {
      const box = row(mailboxId);
      const state = parseState(box);
      const previous = state.folders?.[folder]?.uidValidity;
      const priorRows = deps.db.prepare("SELECT uid,seen,size FROM mail_messages WHERE mailbox_id=? AND folder=?").all(mailboxId, folder) as unknown as { uid: number; seen: number; size: number }[];
      const prior = new Map(priorRows.map((item) => [item.uid, item]));
      const before = new Set(prior.keys());
      const nextFlags = new Map<number, string>();
      const present = new Set<number>();
      const fresh: number[] = [];
      let validity: string | undefined;
      let reset = false;
      let metadataChanged = false;
      let deleted = false;
      try {
        const upsert = deps.db.prepare(`INSERT INTO mail_messages(mailbox_id,folder,uid,message_id,from_json,to_json,cc_json,subject,date,snippet,seen,has_attachments,size,body_text,attachments_json,references_json,in_reply_to)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mailbox_id,folder,uid) DO UPDATE SET
          message_id=excluded.message_id,from_json=excluded.from_json,to_json=excluded.to_json,cc_json=excluded.cc_json,
          subject=excluded.subject,date=excluded.date,snippet=excluded.snippet,seen=excluded.seen,has_attachments=excluded.has_attachments,
          size=excluded.size,body_text=excluded.body_text,attachments_json=excluded.attachments_json,references_json=excluded.references_json,in_reply_to=excluded.in_reply_to`);
        const transport = transportFactory();
        const events = transport.streamMessages
          ? transport.streamMessages(credentials(box), folder, { uidValidity: previous, uids: before })
          : legacyMessageStream(transport, credentials(box), folder);
        for await (const event of events) {
          if (event.kind === "mailbox") {
            validity = event.uidValidity;
            if (previous && validity !== previous) {
              reset = true;
              deps.db.prepare("DELETE FROM mail_messages WHERE mailbox_id=? AND folder=?").run(mailboxId, folder);
              before.clear();
            }
            continue;
          }
          const message = event.message;
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
            upsert.run(mailboxId, folder, message.uid, parsed.messageId, JSON.stringify(parsed.from), JSON.stringify(parsed.to), JSON.stringify(parsed.cc),
              parsed.subject, parsed.date, parsed.snippet, message.flags.includes("\\Seen") ? 1 : 0, parsed.attachments.length ? 1 : 0,
              message.size, parsed.text, JSON.stringify(parsed.attachments), JSON.stringify(parsed.references), parsed.inReplyTo);
          } else {
            const changed = deps.db.prepare("UPDATE mail_messages SET seen=?,size=? WHERE mailbox_id=? AND folder=? AND uid=?")
              .run(message.flags.includes("\\Seen") ? 1 : 0, message.size, mailboxId, folder, message.uid);
            if (changed.changes !== 1) throw new Error(`邮件 ${folder}/${message.uid} 缺少 MIME 原文，无法建立索引`);
          }
        }
        if (!validity) throw new Error(`邮件服务器没有返回 ${folder} 的 UIDVALIDITY`);
        for (const uid of before) if (!present.has(uid)) {
          deps.db.prepare("DELETE FROM mail_messages WHERE mailbox_id=? AND folder=? AND uid=?").run(mailboxId, folder, uid);
          deleted = true;
        }
        const nonSeenFlagsDigest = createHash("sha256")
          .update(JSON.stringify([...nextFlags].sort(([left], [right]) => left - right))).digest("hex");
        if (state.folders?.[folder]?.nonSeenFlagsDigest
          && state.folders[folder].nonSeenFlagsDigest !== nonSeenFlagsDigest) metadataChanged = true;
        const syncedAt = Date.now();
        const nextState: SyncState = { ...state, lastError: null, folders: { ...(state.folders ?? {}), [folder]: { uidValidity: validity, syncedAt, nonSeenFlagsDigest } } };
        deps.db.prepare("UPDATE mailboxes SET last_synced_at=?,sync_state_json=? WHERE id=?").run(syncedAt, JSON.stringify(nextState), mailboxId);
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
    });
    folderSyncs.set(syncKey, task);
    void task.then(
      () => { if (folderSyncs.get(syncKey) === task) folderSyncs.delete(syncKey); },
      () => { if (folderSyncs.get(syncKey) === task) folderSyncs.delete(syncKey); },
    );
    return task;
  }

  async function safeParse(message: RemoteMessage) {
    if (message.size > MAX_INCOMING || (message.source?.byteLength ?? 0) > MAX_INCOMING) return {
      messageId: null, from: "", to: [] as string[], cc: [] as string[], subject: "邮件过大，未缓存正文", date: 0,
      text: "这封邮件超过 25 MB，本地没有解析正文。", snippet: "这封邮件超过 25 MB，本地没有解析正文。",
      inReplyTo: null, references: [] as string[], attachments: [] as MailAttachment[],
    };
    if (!message.source) throw new Error(`邮件 ${message.folder}/${message.uid} 缺少 MIME 原文`);
    try {
      return await parseMailText(message.source);
    } catch {
      const text = "这封邮件的正文无法安全解析，本地没有渲染其 HTML 内容。";
      return { messageId: null, from: "", to: [] as string[], cc: [] as string[], subject: "邮件正文无法安全解析", date: 0,
        text, snippet: text, inReplyTo: null, references: [] as string[], attachments: [] as MailAttachment[] };
    }
  }

  async function* legacyMessageStream(transport: MailTransport, creds: MailCredentials, folder: string) {
    const messages = await transport.fetchMessages(creds, folder);
    yield { kind: "mailbox" as const, uidValidity: messages[0]?.uidValidity ?? "legacy" };
    for (const message of messages) yield { kind: "message" as const, message };
  }

  const messageFromRow = (item: Record<string, unknown>): MailMessageDetail => ({
    uid: Number(item.uid), folder: String(item.folder), from: JSON.parse(String(item.from_json)) as string,
    to: JSON.parse(String(item.to_json)) as string[], cc: JSON.parse(String(item.cc_json)) as string[],
    subject: String(item.subject), date: item.date == null ? 0 : Number(item.date), snippet: String(item.snippet),
    seen: Boolean(item.seen), hasAttachments: Boolean(item.has_attachments), size: Number(item.size), text: String(item.body_text ?? ""),
    messageId: item.message_id == null ? null : String(item.message_id), inReplyTo: item.in_reply_to == null ? null : String(item.in_reply_to),
    references: JSON.parse(String(item.references_json)) as string[], attachments: JSON.parse(String(item.attachments_json)) as MailAttachment[],
  });

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

  return {
    list,
    sync: inventory,
    async reconcile() { if (!closed && !deps.readOnly) await monitor.reconcile(); },
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
      await transportFactory().moveToTrash(credentials(box), folder, input.uid);
      deps.db.prepare("DELETE FROM mail_messages WHERE mailbox_id=? AND folder=? AND uid=?").run(input.mailboxId, folder, input.uid);
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
      await monitor.stopMailbox(input.mailboxId);
      try {
        let writeError: unknown;
        try { await accountExec(box.account_id)("mail_mailboxes_delete-mailbox", { mailboxId: box.remote_id }); } catch (error) { writeError = error; }
        const remaining = await listAll(accountExec(box.account_id), "mail_mailboxes_list", { orderId: box.order_id }) as { id: string | number }[];
        if (remaining.some((item) => String(item.id) === box.remote_id)) throw writeError instanceof Error ? writeError : new Error("Hostinger 没有确认邮箱已删除，请稍后重试");
        deletedRemote.add(`${box.account_id}:${box.remote_id}`);
        saveSiteCredential(box, null);
        deps.db.prepare("DELETE FROM mailboxes WHERE id=?").run(input.mailboxId);
        deps.push({ type: "changed", mailboxId: input.mailboxId });
        return { ok: true };
      } finally {
        deleting.delete(input.mailboxId);
        await monitor.reconcile();
      }
    },
    async send(input) {
      assertWritable();
      const box = row(input.mailboxId);
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
        const original = await getMessage({ mailboxId: input.mailboxId, ...input.replyTo });
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
      row(input.mailboxId); // 读取原邮件期间可能开始放弃域名；SMTP 前必须再拦一次。
      const messageId = `<${randomUUID()}@${box.domain}>`;
      return transportFactory().send(creds, { from: box.address, to, cc, bcc: normalizeEmailList(input.bcc), subject, text, messageId, inReplyTo, references, attachments });
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
