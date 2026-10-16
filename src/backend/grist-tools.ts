import { Type, type TSchema } from "@earendil-works/pi-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sanitizeAssistantValue, type AssistantRisk, type AssistantToolDefinition } from "./assistant-tools.ts";
import { assertGristSelectSql, type GristClient } from "./grist.ts";

export type GetGristClient = () => GristClient | Promise<GristClient>;
export const GRIST_TOOL_NAMES = [
  "grist_help", "grist_get_user_profile", "grist_list_orgs", "grist_list_workspaces", "grist_list_docs", "grist_get_doc_info",
  "grist_get_tables", "grist_get_table_columns", "grist_list_records", "grist_query_document", "grist_list_snapshots", "grist_list_attachments",
  "grist_add_records", "grist_update_records", "grist_remove_records", "grist_create_doc", "grist_create_table", "grist_add_table_column",
  "grist_update_table_column", "grist_rename_table", "grist_remove_table", "grist_remove_table_column",
] as const;
type GristToolName = (typeof GRIST_TOOL_NAMES)[number];
type Schema = z.ZodObject<z.ZodRawShape>;
export interface GristToolDefinition extends AssistantToolDefinition { name: GristToolName; inputSchema: Schema }

const docId = z.string().trim().min(1).max(200).describe("Grist 文档 ID 或 URL ID，来自 grist_list_docs，不是完整网址。");
const tableId = z.string().trim().min(1).max(200).describe("来自 grist_get_tables 的表 ID，不是显示名称。");
const columnId = z.string().trim().min(1).max(200).describe("来自 grist_get_table_columns 的列 ID，不是显示名称。");
const workspaceId = z.number().int().positive().describe("grist_list_workspaces 返回的数字工作空间 ID。");
const limit = z.number().int().min(1).max(1000).default(100).describe("最多返回行数：默认 100，最大 1000。");
const fields = z.record(z.string(), z.unknown()).describe("列 ID 到 Grist JSON 单元格值的映射；日期用 Unix 秒，引用用行 ID。");
const columnFields = z.object({
  type: z.string().optional().describe("Grist 类型，例如 Text、Numeric、Int、Bool、Date、Choice 或 Ref:TableId。"),
  label: z.string().optional(), formula: z.string().optional().describe("Python 公式文本；公式列同时设置 isFormula=true。"),
  isFormula: z.boolean().optional(), widgetOptions: z.string().optional().describe("JSON 编码的控件选项；Choice 选项保存在 choices 中。"),
}).catchall(z.unknown());
const column = z.object({ id: columnId, fields: columnFields.optional() });
const strict = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();

function jsonResult(data: unknown): CallToolResult { return { content: [{ type: "text", text: JSON.stringify(data ?? null) }] }; }
function boundedRows(value: unknown, max: number): unknown {
  if (Array.isArray(value)) return { records: value.slice(0, max), ...(value.length > max ? { truncated: true } : {}) };
  if (value && typeof value === "object") {
    const result = { ...value } as Record<string, unknown>;
    for (const key of ["records", "rows"]) {
      const rows = result[key];
      if (Array.isArray(rows)) { result[key] = rows.slice(0, max); if (rows.length > max) result.truncated = true; }
    }
    return result;
  }
  return value;
}
const failures = new WeakSet<object>();
function failure(error: unknown): { ok: false; error: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const result = { ok: false as const, error: String(sanitizeAssistantValue(raw) ?? "Grist 操作失败") };
  failures.add(result);
  return result;
}
function typeboxSchema(schema: Schema): TSchema {
  // Copy JSON fields only: Type.Unsafe would expose Zod's non-enumerable ~standard marker.
  return Type.Unsafe({ ...z.toJSONSchema(schema, { io: "input" }) } as Record<string, unknown>);
}

/** One definition table powers both the embedded assistant and /api/mcp. */
export function gristToolDefinitions(getClient: GetGristClient): GristToolDefinition[] {
  const definitions: GristToolDefinition[] = [];
  const add = <S extends z.ZodRawShape>(
    name: GristToolName, description: string, risk: AssistantRisk, inputSchema: z.ZodObject<S>,
    execute: (client: GristClient, args: z.output<z.ZodObject<S>>) => unknown | Promise<unknown>, options: { noClient?: boolean } = {},
  ) => definitions.push({
    name, label: description.split(/[，。]/, 1)[0], description, risk, inputSchema, parameters: typeboxSchema(inputSchema),
    async run(args: unknown) {
      try {
        const parsed = inputSchema.parse(args ?? {});
        return await execute(options.noClient ? (undefined as unknown as GristClient) : await getClient(), parsed);
      } catch (error) { return failure(error); }
    },
  });

  add("grist_help", "说明 Grist 工具的发现顺序、行数限制、SQL 查询、单元格编码和未支持能力。", "read", strict({}), async () => ({
    overview: "这是基于 REST 的 Grist 连接器，使用当前登录用户在设置页保存的 Grist 地址和 API Key。建议依次发现团队站点、工作空间、文档、表、列，再读写记录。",
    tools: GRIST_TOOL_NAMES,
    records: "列表与 SQL 查询默认返回 100 行，最多 1000 行。写入前先读取列定义。日期使用 UTC Unix 秒，公式、引用、附件和编码列表遵循 Grist REST API 格式。",
    query: "grist_query_document 只接受一条只读 SELECT，不接受自然语言；调用方需自行生成 SQL。查询会在服务端包裹 LIMIT，不支持 WITH。",
    unsupported: [
      "grist_get_pages", "grist_update_page", "grist_remove_page", "grist_add_page_widget", "grist_get_page_widgets",
      "grist_update_page_widget", "grist_remove_page_widget", "grist_get_page_widget_select_by_options", "grist_set_page_widget_select_by",
      "grist_get_attachment_url", "grist_get_grist_access_rules_reference", "grist_get_available_custom_widgets",
    ],
    limitations: "不提供页面/组件管理、附件下载 URL、访问规则参考、自定义组件目录、自然语言转 SQL、OAuth 或 Grist 原生 MCP。删除和改列工具必须先由用户确认。",
  }), { noClient: true });
  add("grist_get_user_profile", "查看当前 Grist 会话的用户名、邮箱和可用组织上下文。", "read", strict({}), (client) => client.getUserProfile());
  add("grist_list_orgs", "列出当前 Grist API Key 可见的团队站点（组织）及其 ID、名称和域名。", "read", strict({}), (client) => client.listOrgs());
  add("grist_list_workspaces", "列出指定 Grist 团队站点中的工作空间和访问摘要。", "read", strict({
    orgId: z.union([z.number().int().positive(), z.string().trim().min(1).max(200)]).describe("grist_list_orgs 返回的组织 ID 或域名。"),
  }), (client, args) => client.listWorkspaces(args.orgId));
  add("grist_list_docs", "列出指定 Grist 工作空间中的文档 ID、名称和元数据。", "read", strict({ workspaceId }), (client, args) => client.listDocs(args.workspaceId));
  add("grist_get_doc_info", "查看指定 Grist 文档的元数据、工作空间和访问摘要，不读取表格行。", "read", strict({ docId }), (client, args) => client.getDocInfo(args.docId));
  add("grist_get_tables", "列出指定 Grist 文档中的表和表 ID。", "read", strict({ docId }), (client, args) => client.getTables(args.docId));
  add("grist_get_table_columns", "列出指定 Grist 表的列 ID、类型、标签、公式和控件选项；写入前应先调用。", "read", strict({ docId, tableId }), (client, args) => client.getTableColumns(args.docId, args.tableId));
  add("grist_list_records", "读取一个 Grist 表的记录；支持按列过滤、排序，默认 100 行，最多 1000 行。", "read", strict({
    docId, tableId, filter: z.record(z.string(), z.array(z.unknown())).optional().describe("示例：{Status:[\"Open\"],Owner:[3,4]}；不同列之间为 AND。"),
    sort: z.string().max(2000).optional().describe("示例：-CreatedAt,Name。"), limit,
  }), async (client, args) => boundedRows(await client.listRecords(args.docId, args.tableId, {
    ...(args.filter ? { filter: args.filter } : {}), ...(args.sort ? { sort: args.sort } : {}), limit: args.limit,
  }), args.limit));
  add("grist_query_document", "对指定 Grist 文档执行一条只读 SQL SELECT；调用方必须提供 SQL，默认 100 行，最多 1000 行。", "read", strict({
    docId, sql: z.string().trim().min(1).max(100_000).regex(/^SELECT\b/i, "只支持 SQL SELECT 查询。").describe("一条 SELECT；不允许写入、多语句、WITH 或自然语言。"),
    args: z.array(z.union([z.string(), z.number()])).max(1000).optional().describe("用于 ? 占位符的位置参数。"), limit,
  }), async (client, args) => {
    const sql = args.sql.replace(/;\s*$/, "");
    assertGristSelectSql(sql);
    return boundedRows(await client.queryDocument(args.docId, `SELECT * FROM (\n${sql}\n) AS grist_mcp_result LIMIT ${args.limit}`, args.args), args.limit);
  });
  add("grist_list_snapshots", "列出指定 Grist 文档的快照或备份元数据，不执行恢复。", "read", strict({ docId }), (client, args) => client.listSnapshots(args.docId));
  add("grist_list_attachments", "列出指定 Grist 文档的附件文件名、类型和大小，不返回内容或下载地址。", "read", strict({ docId, limit }), async (client, args) => boundedRows(await client.listAttachments(args.docId, { limit: args.limit }), args.limit));
  add("grist_add_records", "向指定 Grist 表追加 1–1000 条记录；不能写公式列。", "write", strict({
    docId, tableId, records: z.array(z.object({ fields }).strict()).min(1).max(1000),
  }), (client, args) => client.addRecords(args.docId, args.tableId, args.records));
  add("grist_update_records", "按数字行 ID 更新指定 Grist 表中的 1–1000 条记录；未给出的列保持不变。", "write", strict({
    docId, tableId, records: z.array(z.object({ id: z.number().int().positive(), fields }).strict()).min(1).max(1000),
  }), (client, args) => client.updateRecords(args.docId, args.tableId, args.records));
  add("grist_remove_records", "永久删除指定 Grist 表中的 1–1000 行；这是破坏性操作。", "confirm", strict({
    docId, tableId, recordIds: z.array(z.number().int().positive()).min(1).max(1000),
  }), (client, args) => client.removeRecords(args.docId, args.tableId, args.recordIds));
  add("grist_create_doc", "在指定 Grist 工作空间中新建文档。", "write", strict({ workspaceId, name: z.string().trim().min(1).max(1000) }), (client, args) => client.createDoc(args.workspaceId, args.name));
  add("grist_create_table", "在指定 Grist 文档中新建表，可同时提供列定义。", "write", strict({
    docId, tableId, columns: z.array(column).max(500).optional(),
  }), (client, args) => client.createTable(args.docId, args.tableId, args.columns));
  add("grist_add_table_column", "向指定 Grist 表新增一列，可设置类型、标签、公式和控件选项。", "write", strict({ docId, tableId, column }), (client, args) => client.addTableColumn(args.docId, args.tableId, args.column));
  add("grist_update_table_column", "更新指定 Grist 列的类型、标签、公式或控件选项；改类型或公式可能改变数据。", "confirm", strict({
    docId, tableId, columnId, fields: columnFields,
  }), (client, args) => client.updateTableColumn(args.docId, args.tableId, args.columnId, args.fields));
  add("grist_rename_table", "使用 Grist RenameTable 操作重命名指定表。", "write", strict({
    docId, tableId, newTableId: tableId.describe("新的 Grist 合法表 ID。"),
  }), (client, args) => client.renameTable(args.docId, args.tableId, args.newTableId));
  add("grist_remove_table", "永久删除指定 Grist 表及其中全部记录；这是破坏性操作。", "confirm", strict({ docId, tableId }), (client, args) => client.removeTable(args.docId, args.tableId));
  add("grist_remove_table_column", "永久删除指定 Grist 列及其数据；这是破坏性操作。", "confirm", strict({ docId, tableId, columnId }), (client, args) => client.removeTableColumn(args.docId, args.tableId, args.columnId));
  return definitions;
}

/** New server per HTTP request; resolving the user client remains lazy per tool call. */
export function createGristMcpServer(getClient: GetGristClient): McpServer {
  const server = new McpServer({ name: "website-gen-grist", version: "1.0.0" }, { maxToolInputElements: 25_000 });
  for (const definition of gristToolDefinitions(getClient)) {
    server.registerTool(definition.name, {
      description: definition.description, inputSchema: definition.inputSchema,
      annotations: { readOnlyHint: definition.risk === "read", destructiveHint: definition.risk === "confirm", openWorldHint: definition.name !== "grist_help" },
    }, async (args) => {
      const result = await definition.run(args);
      if (result && typeof result === "object" && failures.has(result)) return { content: [{ type: "text", text: (result as { error: string }).error }], isError: true };
      return jsonResult(result);
    });
  }
  return server;
}
