import type { GristClient, GristRecord, GristSqlResult } from "./grist.ts";

export interface GristStructureColumn {
  colRef: number;
  colId: string;
  label: string;
  type: string;
  isFormula: boolean;
  widgetOptions: string;
  parentPos?: number;
}

export interface GristStructureTable {
  tableRef: number;
  tableId: string;
  primaryViewId: number;
  rawViewSectionRef: number;
  columns: GristStructureColumn[];
}

export interface GristStructureSection {
  id: number;
  parentKey: string;
  title: string;
  displayTitle: string;
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

export interface GristDocStructure {
  pages: GristStructurePage[];
  tables: GristStructureTable[];
  rawTables: GristStructureTable[];
}

type Row = Record<string, unknown>;
const rows = (result: GristSqlResult): Row[] => result.records.map((record) => record.fields);
const number = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value: unknown): string => value == null ? "" : String(value);

export const GRIST_STRUCTURE_SQL = {
pages: `SELECT p.id AS pageId, p.viewRef, p.indentation, p.pagePos, v.name
FROM _grist_Pages AS p
LEFT JOIN _grist_Views AS v ON v.id = p.viewRef
ORDER BY p.pagePos, p.id`,
sections: `SELECT s.id AS sectionId, s.parentId AS viewRef, s.tableRef, s.title, s.parentKey,
       t.tableId
FROM _grist_Views_section AS s
LEFT JOIN _grist_Tables AS t ON t.id = s.tableRef
ORDER BY s.parentId, s.id`,
tables: `SELECT id AS tableRef, tableId, primaryViewId, rawViewSectionRef
FROM _grist_Tables
ORDER BY id`,
columns: `SELECT c.id AS colRef, c.parentId AS tableRef, c.colId, c.label, c.type,
       c.isFormula, c.widgetOptions, f.parentId AS sectionId, f.parentPos
FROM _grist_Tables_column AS c
LEFT JOIN _grist_Views_section_field AS f ON f.colRef = c.id
ORDER BY c.parentId, c.id, f.parentId, f.parentPos`,
} as const;

export async function getGristDocStructure(client: GristClient, docId: string): Promise<GristDocStructure> {
  const [pageResult, sectionResult, tableResult, columnResult] = await Promise.all([
    client.queryDocument(docId, GRIST_STRUCTURE_SQL.pages), client.queryDocument(docId, GRIST_STRUCTURE_SQL.sections),
    client.queryDocument(docId, GRIST_STRUCTURE_SQL.tables), client.queryDocument(docId, GRIST_STRUCTURE_SQL.columns),
  ]);
  return assembleGristDocStructure({
    pages: rows(pageResult), sections: rows(sectionResult), tables: rows(tableResult), columns: rows(columnResult),
  });
}

export function assembleGristDocStructure(input: {
  pages: Row[]; sections: Row[]; tables: Row[]; columns: Row[];
}): GristDocStructure {
  const allColumns = new Map<number, GristStructureColumn[]>();
  const sectionColumns = new Map<number, GristStructureColumn[]>();
  for (const row of input.columns) {
    const column: GristStructureColumn = {
      colRef: number(row.colRef), colId: text(row.colId), label: text(row.label) || text(row.colId),
      type: text(row.type), isFormula: Boolean(row.isFormula), widgetOptions: text(row.widgetOptions),
    };
    const tableRef = number(row.tableRef);
    const tableList = allColumns.get(tableRef) ?? [];
    if (!tableList.some((item) => item.colRef === column.colRef)) tableList.push(column);
    allColumns.set(tableRef, tableList);
    if (row.sectionId != null) {
      const sectionId = number(row.sectionId);
      const sectionList = sectionColumns.get(sectionId) ?? [];
      sectionList.push({ ...column, parentPos: number(row.parentPos) });
      sectionColumns.set(sectionId, sectionList);
    }
  }
  for (const list of sectionColumns.values()) list.sort((a, b) => (a.parentPos ?? 0) - (b.parentPos ?? 0) || a.colRef - b.colRef);

  const tables = input.tables.map((row): GristStructureTable => {
    const tableRef = number(row.tableRef), rawViewSectionRef = number(row.rawViewSectionRef);
    return { tableRef, tableId: text(row.tableId), primaryViewId: number(row.primaryViewId), rawViewSectionRef,
      columns: allColumns.get(tableRef) ?? [] };
  });
  const pageViews = new Set(input.pages.map((row) => number(row.viewRef)));
  const tableIds = new Map(tables.map((table) => [table.tableRef, table.tableId]));
  const sectionsByView = new Map<number, GristStructureSection[]>();
  const placedTables = new Set<number>();
  for (const row of input.sections) {
    const tableRef = number(row.tableRef);
    const viewRef = number(row.viewRef);
    if (tableRef && pageViews.has(viewRef)) placedTables.add(tableRef);
    const tableId = text(row.tableId) || tableIds.get(tableRef) || "";
    const title = text(row.title);
    const section: GristStructureSection = {
      id: number(row.sectionId), parentKey: text(row.parentKey), title, displayTitle: title || tableId,
      tableRef, tableId, columns: sectionColumns.get(number(row.sectionId)) ?? [],
    };
    const list = sectionsByView.get(viewRef) ?? [];
    list.push(section);
    list.sort((a, b) => a.id - b.id);
    sectionsByView.set(viewRef, list);
  }
  const pages = input.pages.map((row): GristStructurePage => ({
    id: number(row.pageId), viewRef: number(row.viewRef), name: text(row.name), indentation: number(row.indentation),
    pagePos: number(row.pagePos), sections: sectionsByView.get(number(row.viewRef)) ?? [],
  })).sort((a, b) => a.pagePos - b.pagePos || a.id - b.id);
  return { pages, tables, rawTables: tables.filter((table) => !placedTables.has(table.tableRef)) };
}

export interface GristAttachment {
  id: number;
  fileName: string;
  fileSize: number;
  imageHeight: number | null;
  imageWidth: number | null;
  timeUploaded: number | null;
}

export async function getGristAttachments(client: GristClient, docId: string, ids: number[]): Promise<{ attachments: GristAttachment[] }> {
  const unique = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!unique.length) return { attachments: [] };
  const placeholders = unique.map(() => "?").join(",");
  const result = await client.queryDocument(docId, `SELECT id, fileName, fileSize, imageHeight, imageWidth, timeUploaded
FROM _grist_Attachments WHERE id IN (${placeholders}) ORDER BY id`, unique);
  return { attachments: rows(result).map((row) => ({
    id: number(row.id), fileName: text(row.fileName), fileSize: number(row.fileSize),
    imageHeight: row.imageHeight == null ? null : number(row.imageHeight), imageWidth: row.imageWidth == null ? null : number(row.imageWidth),
    timeUploaded: row.timeUploaded == null ? null : number(row.timeUploaded),
  })) };
}

export const GRIST_PAGE_RECORDS_MAX_BYTES = 16 * 1024 * 1024;
export const GRIST_PAGE_RECORDS_MAX_ATTACHMENT_IDS = 10_000;
const GRIST_PAGE_RECORDS_CONCURRENCY = 2;

function collectAttachmentIds(records: GristRecord[], columns: string[], ids: Set<number>): void {
  for (const record of records) for (const column of columns) {
    const value = record.fields[column];
    if (!Array.isArray(value) || value[0] !== "L") continue;
    for (const id of value.slice(1)) if (Number.isSafeInteger(id) && Number(id) > 0) {
      ids.add(Number(id));
      if (ids.size > GRIST_PAGE_RECORDS_MAX_ATTACHMENT_IDS) throw new Error(`当前页面附件超过 ${GRIST_PAGE_RECORDS_MAX_ATTACHMENT_IDS} 个上限`);
    }
  }
}

export async function getGristPageRecords(client: GristClient, input: {
  docId: string; tableIds: string[]; attachmentColumns?: Record<string, string[]>; limit: number;
}): Promise<{ tables: Record<string, { records: GristRecord[]; truncated: boolean }>; attachments: GristAttachment[] }> {
  const uniqueTables = [...new Set(input.tableIds)];
  const controller = new AbortController();
  const results = new Map<string, { records: GristRecord[]; truncated: boolean }>();
  let nextIndex = 0;
  let aggregateBytes = 32;
  const workers = Array.from({ length: Math.min(GRIST_PAGE_RECORDS_CONCURRENCY, uniqueTables.length) }, async () => {
    while (!controller.signal.aborted) {
      const index = nextIndex++;
      if (index >= uniqueTables.length) return;
      const tableId = uniqueTables[index]!;
      try {
        const result = await client.listRecords(input.docId, tableId, { limit: input.limit + 1, signal: controller.signal });
        const visible = { records: result.records.slice(0, input.limit), truncated: result.records.length > input.limit };
        aggregateBytes += Buffer.byteLength(JSON.stringify(tableId)) + Buffer.byteLength(JSON.stringify(visible)) + 2;
        if (aggregateBytes > GRIST_PAGE_RECORDS_MAX_BYTES) throw new Error("当前页面数据超过 16 MiB 聚合上限，请减少每页记录数");
        results.set(tableId, visible);
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }
  });
  try { await Promise.all(workers); }
  catch (error) { controller.abort(error); throw error; }
  const tables = Object.create(null) as Record<string, { records: GristRecord[]; truncated: boolean }>;
  const ids = new Set<number>();
  for (const tableId of uniqueTables) {
    const result = results.get(tableId)!;
    const records = result.records;
    tables[tableId] = result;
    const attachmentColumns = input.attachmentColumns && Object.prototype.hasOwnProperty.call(input.attachmentColumns, tableId)
      ? input.attachmentColumns[tableId] ?? [] : [];
    try { collectAttachmentIds(records, attachmentColumns, ids); }
    catch (error) { controller.abort(error); throw error; }
  }
  const output = { tables, ...(await getGristAttachments(client, input.docId, [...ids])) };
  if (Buffer.byteLength(JSON.stringify(output)) > GRIST_PAGE_RECORDS_MAX_BYTES) {
    controller.abort(new Error("当前页面数据与附件元数据超过 16 MiB 聚合上限"));
    throw controller.signal.reason;
  }
  return output;
}
