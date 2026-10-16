import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { assertGristSelectSql, type GristClient } from "./grist.ts";
import { getGristDocStructure } from "./grist-structure.ts";

export type GetGristClient = () => GristClient | Promise<GristClient>;

export const GRIST_TOOL_NAMES = [
  "grist_help", "grist_get_user_profile", "grist_list_orgs", "grist_list_workspaces", "grist_list_docs", "grist_get_doc_info",
  "grist_get_tables", "grist_get_table_columns", "grist_list_records", "grist_query_document", "grist_list_snapshots", "grist_list_attachments",
  "grist_get_pages", "grist_get_attachment_url",
  "grist_add_records", "grist_update_records", "grist_remove_records", "grist_create_doc", "grist_create_table", "grist_add_table_column",
  "grist_update_table_column", "grist_rename_table", "grist_remove_table", "grist_remove_table_column",
] as const;

const docId = z.string().trim().min(1).max(200).describe("Grist document ID or URL ID, obtained from grist_list_docs; not a full URL.");
const tableId = z.string().trim().min(1).max(200).describe("Table ID from grist_get_tables, not the display label.");
const columnId = z.string().trim().min(1).max(200).describe("Column ID from grist_get_table_columns, not the display label.");
const workspaceId = z.number().int().positive().describe("Numeric workspace ID returned by grist_list_workspaces.");
const limit = z.number().int().min(1).max(1000).default(100).describe("Maximum rows to return: default 100, maximum 1000.");
const fields = z.record(z.string(), z.unknown()).describe("Map of column IDs to Grist JSON cell values. Date values use Unix seconds, references use row IDs.");
const columnFields = z.object({
  type: z.string().optional().describe("Grist type such as Text, Numeric, Int, Bool, Date, Choice, or Ref:TableId."),
  label: z.string().optional(),
  formula: z.string().optional().describe("Python formula text. Use isFormula=true for a formula column."),
  isFormula: z.boolean().optional(),
  widgetOptions: z.string().optional().describe("JSON-encoded widget options; Choice options are stored in choices."),
}).catchall(z.unknown());
const column = z.object({ id: columnId, fields: columnFields.optional() });

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data ?? null) }] };
}

/** Defend the AI context limit even if an upstream server ignores its row limit. */
function boundedRows(value: unknown, max: number): unknown {
  if (Array.isArray(value)) return { records: value.slice(0, max), ...(value.length > max ? { truncated: true } : {}) };
  if (value && typeof value === "object") {
    const result = { ...value } as Record<string, unknown>;
    for (const key of ["records", "rows"]) {
      const rows = result[key];
      if (Array.isArray(rows)) {
        result[key] = rows.slice(0, max);
        if (rows.length > max) result.truncated = true;
      }
    }
    return result;
  }
  return value;
}

/** New server per HTTP request; resolving the user client is lazy and repeated per tool call. */
export function createGristMcpServer(getClient: GetGristClient, getAttachmentUrl?: (input: { docId: string; attachmentId: number }) => { url: string; expiresAt: number } | Promise<{ url: string; expiresAt: number }>): McpServer {
  const server = new McpServer({ name: "website-gen-grist", version: "1.0.0" }, { maxToolInputElements: 25_000 });

  function register<S extends z.ZodRawShape>(
    name: typeof GRIST_TOOL_NAMES[number], description: string, shape: S,
    run: (client: GristClient, args: z.output<z.ZodObject<S>>) => unknown | Promise<unknown>,
    options: { readOnly?: boolean; destructive?: boolean } = {},
  ) {
    server.registerTool<z.ZodRawShape, z.ZodObject<S>>(name, {
      description, inputSchema: z.object(shape),
      annotations: { readOnlyHint: options.readOnly ?? true, destructiveHint: options.destructive ?? false, openWorldHint: true },
    }, async (args) => {
      try { return jsonResult(await run(await getClient(), args)); }
      catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    });
  }

  server.registerTool("grist_help", {
    description: "Explain this REST-backed Grist MCP server, discovery workflow, row limits, SQL-only query behavior, cell encoding, and unsupported official tools. No parameters; returns a capability overview.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => jsonResult({
    overview: "REST-backed Grist connector. Tools use the authenticated website-gen user's saved Grist API key and inherit that key's permissions. Discover orgs -> workspaces -> docs -> tables -> columns before accessing records.",
    tools: GRIST_TOOL_NAMES,
    records: "list_records and query_document default to 100 rows and allow at most 1000. Read column metadata before writing. Dates use UTC Unix seconds. Attachment cells use [\"L\", attachmentId, ...]; use grist_list_attachments for metadata and grist_get_attachment_url for a temporary download URL.",
    query: "grist_query_document accepts a single read-only SQL SELECT, not natural language. The calling AI must translate the user's request into SQL. Queries are wrapped with LIMIT. WITH statements are not supported.",
    unsupported: [
      "grist_update_page", "grist_remove_page", "grist_add_page_widget", "grist_get_page_widgets",
      "grist_update_page_widget", "grist_remove_page_widget", "grist_get_page_widget_select_by_options", "grist_set_page_widget_select_by",
      "grist_get_grist_access_rules_reference", "grist_get_available_custom_widgets",
    ],
    limitations: "No page/widget mutation, access-rules reference, custom-widget catalog, natural-language query translation, OAuth, or Grist-native MCP service is provided. Destructive tools delete data; confirm user intent before calling.",
  }));

  register("grist_get_user_profile", "Return the active Grist session profile containing user name, email and available organization context. No parameters.", {}, (client) => client.getUserProfile());
  register("grist_list_orgs", "List Grist team sites (organizations) visible to the API key. No parameters; returns organization IDs, names and domains.", {}, (client) => client.listOrgs());
  register("grist_list_workspaces", "List workspaces inside orgId, a numeric organization ID or organization domain. Returns workspace metadata and access information.", {
    orgId: z.union([z.number().int().positive(), z.string().trim().min(1).max(200)]).describe("Organization ID or domain from grist_list_orgs."),
  }, (client, args) => client.listWorkspaces(args.orgId));
  register("grist_list_docs", "List documents in workspaceId. Returns document IDs, names and available metadata from that workspace.", { workspaceId }, (client, args) => client.listDocs(args.workspaceId));
  register("grist_get_doc_info", "Return metadata, workspace and access information for docId. Does not return table row data.", { docId }, (client, args) => client.getDocInfo(args.docId));
  register("grist_get_tables", "List tables and their IDs in docId. Returns Grist table metadata; use table IDs for later column and record tools.", { docId }, (client, args) => client.getTables(args.docId));
  register("grist_get_table_columns", "List column IDs and fields (type, label, isFormula, formula, widgetOptions) for a table. Use before writing records or schema.", { docId, tableId }, (client, args) => client.getTableColumns(args.docId, args.tableId));
  register("grist_get_pages", "Return document pages in Grist sidebar order with indentation, components, underlying table IDs, visible component columns, full table metadata, and raw tables not placed on a page.", { docId }, (client, args) => getGristDocStructure(client, args.docId));
  server.registerTool("grist_get_attachment_url", {
    description: "Create a signed download URL for one attachment ID. The URL expires in 10 minutes and is revoked when this MCP token is revoked or replaced.",
    inputSchema: z.object({ docId, attachmentId: z.number().int().positive() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (args) => {
    try {
      if (!getAttachmentUrl) throw new Error("附件下载链接服务不可用");
      return jsonResult(await getAttachmentUrl(args));
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  register("grist_list_records", "Read records in one table, returning {records:[{id,fields}]}. filter maps column IDs to arrays of allowed values (AND across columns); sort is comma-separated column IDs with '-' for descending. Default limit 100, maximum 1000.", {
    docId, tableId,
    filter: z.record(z.string(), z.array(z.unknown())).optional().describe("Example: {Status:[\"Open\"],Owner:[3,4]}. Values use Grist REST JSON encoding."),
    sort: z.string().max(2000).optional().describe("Example: -CreatedAt,Name."),
    limit,
  }, async (client, args) => boundedRows(await client.listRecords(args.docId, args.tableId, {
    ...(args.filter ? { filter: args.filter } : {}), ...(args.sort ? { sort: args.sort } : {}), limit: args.limit,
  }), args.limit));
  register("grist_query_document", "Run one read-only SQL SELECT against docId. Unlike official Grist MCP, natural language is not accepted: the calling AI must write SQL using table/column IDs. Optional positional args bind '?' placeholders. Returns SQL records; default limit 100, maximum 1000; SELECT is wrapped with LIMIT.", {
    docId,
    sql: z.string().trim().min(1).max(100_000).regex(/^SELECT\b/i, "Only SQL SELECT queries are supported.").describe("One SQL SELECT statement. No writes, multiple statements, WITH, or natural language."),
    args: z.array(z.union([z.string(), z.number()])).max(1000).optional().describe("Positional parameter values for '?' placeholders."),
    limit,
  }, async (client, args) => {
    const sql = args.sql.replace(/;\s*$/, "");
    assertGristSelectSql(sql);
    // A trailing SQL line comment must not swallow the closing wrapper and LIMIT.
    return boundedRows(await client.queryDocument(args.docId, `SELECT * FROM (\n${sql}\n) AS grist_mcp_result LIMIT ${args.limit}`, args.args), args.limit);
  });
  register("grist_list_snapshots", "List saved document snapshots/backups for docId. Returns snapshot identifiers and metadata; does not restore a snapshot.", { docId }, (client, args) => client.listSnapshots(args.docId));
  register("grist_list_attachments", "List attachment metadata in docId (file names, types and sizes). Does not return file content or download URLs. Returns at most limit metadata records: default 100, maximum 1000.", { docId, limit }, async (client, args) => boundedRows(await client.listAttachments(args.docId, { limit: args.limit }), args.limit));

  register("grist_add_records", "Append 1-1000 records to a table. Each record is {fields:{columnId:value}}; do not supply row IDs. Returns newly allocated record IDs. Formula columns cannot be written.", {
    docId, tableId, records: z.array(z.object({ fields })).min(1).max(1000),
  }, (client, args) => client.addRecords(args.docId, args.tableId, args.records), { readOnly: false });
  register("grist_update_records", "Update fields on 1-1000 existing records by numeric row ID. Each record is {id,fields:{columnId:value}}. Omitted fields remain unchanged; formula columns cannot be written. Returns REST update result.", {
    docId, tableId, records: z.array(z.object({ id: z.number().int().positive(), fields })).min(1).max(1000),
  }, (client, args) => client.updateRecords(args.docId, args.tableId, args.records), { readOnly: false });
  register("grist_remove_records", "Permanently delete 1-1000 rows identified by numeric recordIds in a table. Destructive: confirm user intent. Returns REST deletion result.", {
    docId, tableId, recordIds: z.array(z.number().int().positive()).min(1).max(1000),
  }, (client, args) => client.removeRecords(args.docId, args.tableId, args.recordIds), { readOnly: false, destructive: true });
  register("grist_create_doc", "Create a new Grist document named name in workspaceId. Returns the new document ID.", {
    workspaceId, name: z.string().trim().min(1).max(1000),
  }, (client, args) => client.createDoc(args.workspaceId, args.name), { readOnly: false });
  register("grist_create_table", "Create tableId in docId, optionally with columns [{id,fields:{type,label,formula,isFormula,widgetOptions}}]. Returns created table metadata. Use Grist-valid table/column identifiers.", {
    docId, tableId, columns: z.array(column).max(500).optional(),
  }, (client, args) => client.createTable(args.docId, args.tableId, args.columns), { readOnly: false });
  register("grist_add_table_column", "Add a column to a table using column:{id,fields?}. fields may set type, label, formula, isFormula and JSON-encoded widgetOptions. Returns created column metadata.", {
    docId, tableId, column,
  }, (client, args) => client.addTableColumn(args.docId, args.tableId, args.column), { readOnly: false });
  register("grist_update_table_column", "Update column fields by columnId: type, label, formula, isFormula or widgetOptions. Changing type/formula may alter data; inspect existing metadata first. Returns REST update result.", {
    docId, tableId, columnId, fields: columnFields,
  }, (client, args) => client.updateTableColumn(args.docId, args.tableId, args.columnId, args.fields), { readOnly: false, destructive: true });
  register("grist_rename_table", "Rename tableId to newTableId using the Grist RenameTable user action. Returns the action result; use the new ID in subsequent calls.", {
    docId, tableId, newTableId: tableId.describe("New Grist-valid table identifier."),
  }, (client, args) => client.renameTable(args.docId, args.tableId, args.newTableId), { readOnly: false });
  register("grist_remove_table", "Permanently remove a table and its records using the Grist RemoveTable action. Destructive: confirm user intent. Returns the action result.", {
    docId, tableId,
  }, (client, args) => client.removeTable(args.docId, args.tableId), { readOnly: false, destructive: true });
  register("grist_remove_table_column", "Permanently remove columnId and its data from a table. Destructive: confirm user intent. Returns the REST deletion result.", {
    docId, tableId, columnId,
  }, (client, args) => client.removeTableColumn(args.docId, args.tableId, args.columnId), { readOnly: false, destructive: true });

  return server;
}
