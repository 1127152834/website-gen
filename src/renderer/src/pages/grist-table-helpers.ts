export interface GristSettings { baseUrl: string; apiKeyHint: string | null; configured: boolean }
export interface GristOrg { id: number; name: string; domain: string | null }
export interface GristWorkspace { id: number; name: string }
export interface GristDoc { id: string; name: string; urlId?: string }
export interface GristTable { id: string; fields?: { primaryViewId?: number } }
export interface GristColumn {
  id: string;
  fields: { label?: string; type?: string; isFormula?: boolean; formula?: string; widgetOptions?: string };
}
export interface GristRecord { id: number; fields: Record<string, unknown> }

const EDITABLE_TYPES = new Set(["Text", "Numeric", "Int", "Bool", "Date", "Choice"]);
export function canEditGristColumn(column: GristColumn): boolean {
  return !column.fields.isFormula && EDITABLE_TYPES.has(column.fields.type ?? "");
}

export function gristDateInput(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function gristCellDisplay(column: GristColumn, value: unknown): string {
  if (value == null) return "";
  if (column.fields.type === "Date" && typeof value === "number") return gristDateInput(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function gristCellInput(column: GristColumn, value: unknown): string {
  return column.fields.type === "Date" ? gristDateInput(value) : value == null ? "" : String(value);
}

export function parseGristCellInput(column: GristColumn, value: string | boolean): unknown {
  if (!canEditGristColumn(column)) throw new Error("此列为只读，不能编辑");
  const type = column.fields.type;
  if (type === "Bool") {
    if (typeof value !== "boolean") throw new Error("请输入有效的布尔值");
    return value;
  }
  if (typeof value !== "string") throw new Error("请输入有效的单元格内容");
  if (type === "Text" || type === "Choice") return value;
  if (value.trim() === "") return null;
  if (type === "Date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("请输入有效日期");
    const millis = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) throw new Error("请输入有效日期");
    return millis / 1000;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || (type === "Int" && !Number.isSafeInteger(number))) throw new Error(type === "Int" ? "请输入有效的整数" : "请输入有效的数字");
  return number;
}

export function gristColumnChoices(column: GristColumn): string[] {
  if (column.fields.type !== "Choice" || !column.fields.widgetOptions) return [];
  try {
    const options: unknown = JSON.parse(column.fields.widgetOptions);
    if (options && typeof options === "object" && "choices" in options && Array.isArray(options.choices)) return options.choices.filter((choice): choice is string => typeof choice === "string");
  } catch { /* 远端无效选项不阻止表格浏览。 */ }
  return [];
}

export function gristDocUrl(baseUrl: string, orgDomain: string | null, doc: GristDoc): string | null {
  try {
    const base = new URL(baseUrl);
    if (!/^https?:$/.test(base.protocol) || base.username || base.password) return null;
    base.pathname = `${base.pathname.replace(/\/+$/, "")}${orgDomain ? `/o/${encodeURIComponent(orgDomain)}` : ""}/${encodeURIComponent(doc.urlId || doc.id)}`;
    base.search = ""; base.hash = "";
    return base.toString();
  } catch { return null; }
}

export function visibleGristRecords(records: GristRecord[]): { records: GristRecord[]; truncated: boolean } {
  return { records: records.slice(0, 1000), truncated: records.length > 1000 };
}

export function gristMcpCommand(origin: string, token?: string): string {
  return `claude mcp add --transport http grist ${origin}/api/mcp --header "Authorization: Bearer ${token || "<MCP 令牌>"}"`;
}
