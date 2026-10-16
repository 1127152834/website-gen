import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentKind, canEditGristColumn, collectAttachmentIds, formatFileSize, gristAttachmentUrl, gristCellDisplay, gristColumnChoices, gristDateInput, gristDocUrl, gristMcpCommand, parseAttachmentIds, parseGristCellInput, rowDetailColumns, sectionColumnToGristColumn, visibleGristRecords, type GristColumn } from "./grist-table-helpers.ts";

const column = (type: string, isFormula = false): GristColumn => ({ id: "A", fields: { type, isFormula } });

test("Grist editor only allows supported non-formula scalar columns", () => {
  for (const type of ["Text", "Numeric", "Int", "Bool", "Date", "Choice"]) assert.equal(canEditGristColumn(column(type)), true);
  for (const type of ["Ref:People", "RefList:People", "Attachments", "Any", "ChoiceList", "DateTime:UTC", "Unknown"]) assert.equal(canEditGristColumn(column(type)), false);
  assert.equal(canEditGristColumn(column("Text", true)), false);
  assert.throws(() => parseGristCellInput(column("Text", true), "x"), /只读/);
});

test("Grist dates round-trip Unix seconds as UTC calendar dates without timezone drift", () => {
  assert.equal(gristDateInput(0), "1970-01-01");
  assert.equal(parseGristCellInput(column("Date"), "2024-02-29"), 1709164800);
  assert.equal(gristCellDisplay(column("Date"), 1709164800), "2024-02-29");
  assert.equal(parseGristCellInput(column("Date"), ""), null);
  for (const value of ["2023-02-29", "2024-13-01", "not-a-date", "2024-02-31"]) assert.throws(() => parseGristCellInput(column("Date"), value), /有效日期/);
  assert.equal(gristDateInput(null), "");
  assert.equal(gristDateInput(Infinity), "");
});

test("Grist numeric, boolean, choices, and readonly display preserve value semantics", () => {
  assert.equal(parseGristCellInput(column("Numeric"), "1.25"), 1.25);
  assert.equal(parseGristCellInput(column("Int"), "-3"), -3);
  assert.equal(parseGristCellInput(column("Numeric"), ""), null);
  assert.throws(() => parseGristCellInput(column("Int"), "1.5"), /整数/);
  assert.throws(() => parseGristCellInput(column("Numeric"), "Infinity"), /数字/);
  assert.equal(parseGristCellInput(column("Bool"), false), false);
  assert.throws(() => parseGristCellInput(column("Bool"), "false"), /布尔/);
  assert.equal(parseGristCellInput(column("Text"), "  value  "), "  value  ");
  assert.equal(gristCellDisplay(column("Attachments"), ["L", 1]), '["L",1]');
  assert.deepEqual(gristColumnChoices({ id: "A", fields: { type: "Choice", widgetOptions: '{"choices":["One",2,"Two"]}' } }), ["One", "Two"]);
  assert.deepEqual(gristColumnChoices({ id: "A", fields: { type: "Choice", widgetOptions: "not json" } }), []);
});

test("Grist document links are safe HTTP links and encode identifiers", () => {
  assert.equal(gristDocUrl("https://grist.example/", "team", { id: "doc-id", name: "A" }), "https://grist.example/o/team/doc-id");
  assert.equal(gristDocUrl("https://grist.example/", null, { id: "personal-doc", name: "A" }), "https://grist.example/personal-doc");
  assert.equal(gristDocUrl("https://grist.example/prefix/", "a/b", { id: "doc", urlId: "short id", name: "A" }), "https://grist.example/prefix/o/a%2Fb/short%20id");
  assert.equal(gristDocUrl("javascript:alert(1)", "team", { id: "doc", name: "A" }), null);
});

test("Grist records only render 1000 with exact overflow indication", () => {
  const records = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, fields: {} }));
  assert.equal(visibleGristRecords(records).records.length, 1000);
  assert.equal(visibleGristRecords(records).truncated, true);
  assert.equal(visibleGristRecords(records.slice(0, 1000)).truncated, false);
  assert.equal(gristMcpCommand("https://console.example", "secret"), 'claude mcp add --transport http grist https://console.example/api/mcp --header "Authorization: Bearer secret"');
});

test("Grist attachment list cells are parsed defensively and batched once per page", () => {
  assert.deepEqual(parseAttachmentIds(["L", 12, 13, 12]), [12, 13]);
  for (const value of [null, ["l", 1], ["L", 0, -1, 1.5, "2"], { id: 1 }]) {
    assert.deepEqual(parseAttachmentIds(value), []);
  }
  const records = [
    { id: 1, fields: { docs: ["L", 12, 13], ignored: ["L", 99] } },
    { id: 2, fields: { docs: ["L", 13, 14] } },
  ];
  assert.deepEqual(collectAttachmentIds(records, ["docs"]), [12, 13, 14]);
});

test("attachment presentation keeps URLs local and only previews safe image and PDF types", () => {
  assert.equal(gristAttachmentUrl("doc/a", 12), "/api/grist/attachment?docId=doc%2Fa&id=12");
  assert.equal(attachmentKind("scan.JPEG"), "image");
  assert.equal(attachmentKind("contract.pdf"), "pdf");
  for (const name of ["payload.svg", "page.html", "data.xml", "script.js", "archive.zip"]) assert.equal(attachmentKind(name), "file");
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(undefined), "大小未知");
});

test("section columns retain Grist component ordering and labels", () => {
  const converted = sectionColumnToGristColumn({ colRef: 7, colId: "Legal_Name", label: "公司名称", type: "Text", isFormula: false, widgetOptions: "{}", parentPos: 2 });
  assert.deepEqual(converted, { id: "Legal_Name", fields: { label: "公司名称", type: "Text", isFormula: false, widgetOptions: "{}" } });
});

test("whole row details preserve component order then include fields hidden in that component", () => {
  const a = { colRef: 1, colId: "A", label: "A", type: "Text", isFormula: false };
  const b = { colRef: 2, colId: "B", label: "B", type: "Attachments", isFormula: false };
  const c = { colRef: 3, colId: "C", label: "C", type: "Text", isFormula: true };
  assert.deepEqual(rowDetailColumns([c, a], [a, b, c]).map((column) => column.colId), ["C", "A", "B"]);
  assert.deepEqual(rowDetailColumns([a], undefined), [a]);
});
