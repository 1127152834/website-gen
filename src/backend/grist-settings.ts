import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { assertGristBaseUrl, gristClient, normalizeGristBaseUrl, type GristClient } from "./grist.ts";
import type { Handlers } from "./rpc.ts";
import { getSecret, secretHint, setSecret } from "./secrets.ts";

const connection = z.object({ baseUrl: z.string().max(2048), apiKey: z.string().max(8192).optional() });
const doc = z.object({ docId: z.string().min(1).max(512) });
const table = doc.extend({ tableId: z.string().min(1).max(512) });
const fields = z.record(z.string(), z.unknown());

export function createGristService(options: {
  db: DatabaseSync; key: Buffer; fetch?: typeof globalThis.fetch;
  /** Only tests override DNS validation; production always uses the strict network guard. */
  validateBaseUrl?: (url: string) => Promise<void>;
}): { handlers: Handlers; client(): GristClient } {
  const { db, key } = options;
  const validate = options.validateBaseUrl ?? assertGristBaseUrl;
  const baseUrl = () => (db.prepare("SELECT value FROM workspace_settings WHERE name = 'grist.baseUrl'").get() as { value: string } | undefined)?.value ?? "";
  const settings = () => {
    const url = baseUrl(), apiKeyHint = secretHint(db, "grist.apiKey");
    return { baseUrl: url, apiKeyHint, configured: Boolean(url && apiKeyHint !== null) };
  };
  const client = (): GristClient => {
    const url = baseUrl(), apiKey = getSecret(db, key, "grist.apiKey");
    if (!url || !apiKey) throw new Error("请先在设置页配置 Grist 地址和 API Key");
    return gristClient({ baseUrl: url, apiKey, fetch: options.fetch });
  };
  const handlers: Handlers = {
    "grist.settings.get": settings,
    "grist.settings.save": async (input) => {
      const parsed = connection.parse(input);
      const url = parsed.baseUrl.trim() ? normalizeGristBaseUrl(parsed.baseUrl) : "";
      if (url) await validate(url);
      const apiKey = parsed.apiKey?.trim();
      if (apiKey && /[\r\n]/.test(apiKey)) throw new Error("Grist API Key 不能包含换行符");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`INSERT INTO workspace_settings (name, value, updated_at) VALUES ('grist.baseUrl', ?, ?)
          ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(url, Date.now());
        if (apiKey) setSecret(db, key, "grist.apiKey", apiKey, apiKey.slice(-4));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return settings();
    },
    "grist.testConnection": async (input) => {
      const parsed = connection.partial().parse(input ?? {});
      const url = normalizeGristBaseUrl(parsed.baseUrl ?? baseUrl());
      const apiKey = parsed.apiKey?.trim() || getSecret(db, key, "grist.apiKey");
      if (!apiKey) throw new Error("请先填写 Grist API Key");
      await validate(url);
      return gristClient({ baseUrl: url, apiKey, fetch: options.fetch }).getUserProfile();
    },
    "grist.listOrgs": () => client().listOrgs(),
    "grist.listWorkspaces": (p) => client().listWorkspaces(z.object({ orgId: z.union([z.string().min(1), z.number().int().positive()]) }).parse(p).orgId),
    "grist.listDocs": (p) => client().listDocs(z.object({ workspaceId: z.number().int().positive() }).parse(p).workspaceId),
    "grist.getDocInfo": (p) => client().getDocInfo(doc.parse(p).docId),
    "grist.getTables": (p) => client().getTables(doc.parse(p).docId),
    "grist.getTableColumns": (p) => { const v = table.parse(p); return client().getTableColumns(v.docId, v.tableId); },
    // One extra row allows the UI to distinguish exactly 1000 rows from truncation.
    "grist.listRecords": (p) => {
      const v = table.extend({ filter: z.record(z.string(), z.array(z.unknown())).optional(), sort: z.string().optional(), limit: z.number().int().min(1).max(1001).default(1000) }).parse(p);
      return client().listRecords(v.docId, v.tableId, { filter: v.filter, sort: v.sort, limit: v.limit });
    },
    "grist.addRecords": (p) => { const v = table.extend({ records: z.array(z.object({ fields })).min(1).max(1000) }).parse(p); return client().addRecords(v.docId, v.tableId, v.records); },
    "grist.updateRecords": (p) => { const v = table.extend({ records: z.array(z.object({ id: z.number().int().positive(), fields })).min(1).max(1000) }).parse(p); return client().updateRecords(v.docId, v.tableId, v.records); },
  };
  return { handlers, client };
}
