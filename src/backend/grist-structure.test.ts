import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assembleGristDocStructure, GRIST_STRUCTURE_SQL } from "./grist-structure.ts";

test("文档结构 SQL 只使用实测元数据列", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE _grist_Pages (id INTEGER, viewRef INTEGER, indentation INTEGER, pagePos REAL);
      CREATE TABLE _grist_Views (id INTEGER, name TEXT);
      CREATE TABLE _grist_Views_section (id INTEGER, parentId INTEGER, tableRef INTEGER, title TEXT, parentKey TEXT);
      CREATE TABLE _grist_Tables (id INTEGER, tableId TEXT, primaryViewId INTEGER, rawViewSectionRef INTEGER);
      CREATE TABLE _grist_Views_section_field (parentId INTEGER, colRef INTEGER, parentPos REAL);
      CREATE TABLE _grist_Tables_column (id INTEGER, parentId INTEGER, colId TEXT, label TEXT, type TEXT, isFormula INTEGER, widgetOptions TEXT);
    `);
    for (const sql of Object.values(GRIST_STRUCTURE_SQL)) assert.doesNotThrow(() => db.prepare(sql).all());
  } finally { db.close(); }
});

test("文档结构按页面/缩进/多组件组装，组件只保留可见列顺序并列出原始表", () => {
  const structure = assembleGristDocStructure({
    pages: [
      { pageId: 2, viewRef: 20, name: "邮箱", indentation: 1, pagePos: 2 },
      { pageId: 1, viewRef: 10, name: "4", indentation: 0, pagePos: 0.5 },
    ],
    sections: [
      { sectionId: 101, viewRef: 10, tableRef: 1, tableId: "Sheet1_2", title: "", parentKey: "record" },
      { sectionId: 102, viewRef: 10, tableRef: 2, tableId: "Other", title: "卡片", parentKey: "single.advanced" },
      { sectionId: 201, viewRef: 20, tableRef: 1, tableId: "Sheet1_2", title: "第二表格", parentKey: "record" },
      { sectionId: 301, viewRef: 0, tableRef: 3, tableId: "RawOnly", title: "", parentKey: "record" },
      { sectionId: 302, viewRef: 999, tableRef: 3, tableId: "RawOnly", title: "孤立视图", parentKey: "record" },
    ],
    tables: [
      { tableRef: 1, tableId: "Sheet1_2", primaryViewId: 10, rawViewSectionRef: 9 },
      { tableRef: 2, tableId: "Other", primaryViewId: 11, rawViewSectionRef: 8 },
      { tableRef: 3, tableId: "RawOnly", primaryViewId: 12, rawViewSectionRef: 7 },
    ],
    columns: [
      { colRef: 12, tableRef: 1, colId: "Hidden", label: "隐藏", type: "Text", isFormula: 0, widgetOptions: "" },
      { colRef: 11, tableRef: 1, colId: "Name", label: "姓名", type: "Text", isFormula: 0, widgetOptions: "{}", sectionId: 101, parentPos: 2 },
      { colRef: 10, tableRef: 1, colId: "Files", label: "附件", type: "Attachments", isFormula: 0, widgetOptions: "{}", sectionId: 101, parentPos: 1 },
      { colRef: 11, tableRef: 1, colId: "Name", label: "姓名", type: "Text", isFormula: 0, widgetOptions: "{}", sectionId: 201, parentPos: 1 },
      { colRef: 30, tableRef: 3, colId: "Raw", label: "Raw", type: "Int", isFormula: 1, widgetOptions: "{}", sectionId: 7, parentPos: 1 },
      { colRef: 31, tableRef: 3, colId: "RawHidden", label: "Raw hidden", type: "Text", isFormula: 0, widgetOptions: "{}" },
    ],
  });
  assert.deepEqual(structure.pages.map(({ name, indentation }) => [name, indentation]), [["4", 0], ["邮箱", 1]]);
  assert.equal(structure.pages[0]!.sections.length, 2);
  assert.equal(structure.pages[0]!.sections[0]!.displayTitle, "Sheet1_2");
  assert.deepEqual(structure.pages[0]!.sections[0]!.columns.map((column) => column.colId), ["Files", "Name"]);
  assert.deepEqual(structure.tables[0]!.columns.map((column) => column.colId), ["Hidden", "Name", "Files"]);
  assert.deepEqual(structure.rawTables.map((table) => table.tableId), ["RawOnly"]);
  assert.deepEqual(structure.rawTables[0]!.columns.map((column) => column.colId), ["Raw", "RawHidden"], "原始视图 field 顺序不能隐藏全表列元数据");
});
