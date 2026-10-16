import type { GristClient, GristSqlResult } from "./grist.ts";

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
