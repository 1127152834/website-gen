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
export interface GristStructureColumn {
  colRef: number;
  colId: string;
  label: string;
  type: string;
  isFormula: boolean;
  widgetOptions?: string | null;
  parentPos?: number;
}
export interface GristStructureSection {
  id: number;
  parentKey: string;
  title: string;
  tableRef: number;
  tableId: string;
  columns: GristStructureColumn[];
}
export interface GristStructurePage {
  id: number;
  viewRef: number;
  name: string;
  indentation: number;
  pagePos: number;
  sections: GristStructureSection[];
}
export interface GristStructureTable {
  tableRef: number;
  tableId: string;
  primaryViewId: number;
  rawViewSectionRef: number;
  columns: GristStructureColumn[];
}
export interface GristDocStructure {
  pages: GristStructurePage[];
  tables: GristStructureTable[];
  rawTables: GristStructureTable[];
}
export interface GristAttachment {
  id: number;
  fileName: string;
  fileSize?: number | null;
  imageHeight?: number | null;
  imageWidth?: number | null;
  timeUploaded?: number | null;
}

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

export function sectionColumnToGristColumn(column: GristStructureColumn): GristColumn {
  return {
    id: column.colId,
    fields: {
      label: column.label,
      type: column.type,
      isFormula: column.isFormula,
      widgetOptions: column.widgetOptions ?? undefined,
    },
  };
}

/** Component-visible fields first; the row drawer must not omit the table's other fields. */
export function rowDetailColumns(visible: GristStructureColumn[], all: GristStructureColumn[] = []): GristStructureColumn[] {
  const seen = new Set<string>();
  return [...visible, ...all].filter((column) => {
    if (seen.has(column.colId)) return false;
    seen.add(column.colId);
    return true;
  });
}

export function parseAttachmentIds(value: unknown): number[] {
  if (!Array.isArray(value) || value[0] !== "L") return [];
  return [...new Set(value.slice(1).filter((id): id is number => Number.isSafeInteger(id) && id > 0))];
}

export function collectAttachmentIds(records: GristRecord[], columnIds: string[]): number[] {
  const ids = new Set<number>();
  for (const record of records) {
    for (const columnId of columnIds) {
      for (const id of parseAttachmentIds(record.fields[columnId])) ids.add(id);
    }
  }
  return [...ids];
}

export function gristAttachmentUrl(docId: string, attachmentId: number): string {
  return `/api/grist/attachment?docId=${encodeURIComponent(docId)}&id=${encodeURIComponent(String(attachmentId))}`;
}

export function attachmentKind(fileName: string): "image" | "pdf" | "file" {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) return "image";
  return extension === "pdf" ? "pdf" : "file";
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

export function gristMcpCommand(origin: string, token?: string): string {
  return `claude mcp add --transport http grist ${origin}/api/mcp --header "Authorization: Bearer ${token || "<MCP 令牌>"}"`;
}
