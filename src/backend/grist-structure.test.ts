import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assembleGristDocStructure, getGristAttachments, getGristPageRecords, GRIST_STRUCTURE_SQL } from "./grist-structure.ts";

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

test("当前页多个表并行读取且附件 ID 合并成一次 SQL 查询", async () => {
  const calls: unknown[][] = [];
  const client = {
    async listRecords(_docId: string, tableId: string, options: unknown) {
      calls.push(["records", tableId, options]);
      return { records: tableId === "A" ? [{ id: 1, fields: { Files: ["L", 12, 13] } }] : [{ id: 2, fields: { Docs: ["L", 13] } }] };
    },
    async queryDocument(_docId: string, sql: string, args: unknown[]) {
      calls.push(["sql", sql, args]);
      return { statement: sql, records: [{ fields: { id: 12, fileName: "a.pdf", fileSize: 3, imageHeight: null, imageWidth: null, timeUploaded: 4 } }] };
    },
  } as never;
  const result = await getGristPageRecords(client, { docId: "d", tableIds: ["A", "B"], attachmentColumns: { A: ["Files"], B: ["Docs"] }, limit: 1000 });
  assert.deepEqual(Object.keys(result.tables), ["A", "B"]);
  assert.deepEqual((calls.find((call) => call[0] === "sql") as unknown[])[2], [12, 13]);
  assert.equal(calls.filter((call) => call[0] === "sql").length, 1);
  assert.equal(result.attachments[0]!.fileName, "a.pdf");
});

test("空附件 ID 不调用 SQL", async () => {
  let called = false;
  const result = await getGristAttachments({ queryDocument: async () => { called = true; throw new Error("unexpected"); } } as never, "d", []);
  assert.deepEqual(result, { attachments: [] });
  assert.equal(called, false);
});

test("页面多表读取最多两并发且任一错误会取消其余请求", async () => {
  let active = 0, maximum = 0;
  const signals: AbortSignal[] = [];
  const client = { listRecords: async (_doc: string, tableId: string, options: { signal: AbortSignal }) => {
    active++; maximum = Math.max(maximum, active); signals.push(options.signal);
    try {
      if (tableId === "bad") throw new Error("bad table");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 20);
        options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
      });
      return { records: [] };
    } finally { active--; }
  } } as never;
  await assert.rejects(getGristPageRecords(client, { docId: "d", tableIds: ["a", "b", "c", "bad", "e", "f"], limit: 1000 }), /bad table/);
  assert.ok(maximum <= 2);
  assert.ok(signals.every((signal) => signal.aborted));
});

test("页面多表聚合超过 16 MiB 会终止并取消共享信号", async () => {
  const signals: AbortSignal[] = [];
  const large = "x".repeat(4_300_000);
  const client = { listRecords: async (_doc: string, tableId: string, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    return { records: [{ id: 1, fields: { [tableId]: large } }] };
  } } as never;
  await assert.rejects(getGristPageRecords(client, { docId: "d", tableIds: ["a", "b", "c", "d"], limit: 1000 }), /16 MiB/);
  assert.ok(signals.every((signal) => signal.aborted));
});

test("页面附件 ID 去重后仍限制为一万，超限前不发 SQL", async () => {
  let sqlCalls = 0;
  const ids = Array.from({ length: 10_001 }, (_, index) => index + 1);
  const client = {
    async listRecords() { return { records: [{ id: 1, fields: { Files: ["L", ...ids] } }] }; },
    async queryDocument() { sqlCalls++; return { statement: "", records: [] }; },
  } as never;
  await assert.rejects(getGristPageRecords(client, { docId: "d", tableIds: ["A"], attachmentColumns: { A: ["Files"] }, limit: 1000 }), /10000/);
  assert.equal(sqlCalls, 0);
});
