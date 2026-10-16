import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GristClient } from "./grist.ts";
import { createGristMcpServer, GRIST_TOOL_NAMES } from "./grist-tools.ts";

const expectedTools = [
  "grist_help", "grist_get_user_profile", "grist_list_orgs", "grist_list_workspaces", "grist_list_docs", "grist_get_doc_info",
  "grist_get_tables", "grist_get_table_columns", "grist_list_records", "grist_query_document", "grist_list_snapshots", "grist_list_attachments",
  "grist_add_records", "grist_update_records", "grist_remove_records", "grist_create_doc", "grist_create_table", "grist_add_table_column",
  "grist_update_table_column", "grist_rename_table", "grist_remove_table", "grist_remove_table_column",
];

async function setup(getClient: () => GristClient | Promise<GristClient>) {
  const server = createGristMcpServer(getClient);
  const client = new Client({ name: "grist-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function fakeClient(run: (method: string, args: unknown[]) => unknown): GristClient {
  return new Proxy({} as GristClient, { get: (_target, method) => method === "then" ? undefined : (...args: unknown[]) => run(String(method), args) });
}

test("Grist MCP lists exactly the 22 REST tools without accessing user configuration", async () => {
  let accesses = 0;
  const { client, close } = await setup(() => { accesses++; throw new Error("not configured"); });
  try {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [...expectedTools].sort());
    assert.deepEqual([...GRIST_TOOL_NAMES].sort(), [...expectedTools].sort());
    assert.ok(result.tools.every((tool) => tool.description && tool.inputSchema.type === "object"));
    const help = await client.callTool({ name: "grist_help", arguments: {} });
    assert.notEqual(help.isError, true);
    assert.match(JSON.stringify(help.content), /grist_get_attachment_url/);
    assert.match(JSON.stringify(help.content), /grist_get_grist_access_rules_reference/);
    assert.match(JSON.stringify(help.content), /grist_get_available_custom_widgets/);
    assert.equal(accesses, 0);
  } finally { await close(); }
});

test("Grist MCP validates input, defaults records to 100, caps at 1000 and returns tool errors", async () => {
  const calls: { method: string; args: unknown[] }[] = [];
  let revoked = false;
  const { client, close } = await setup(() => {
    if (revoked) throw new Error("MCP token revoked");
    return fakeClient((method, args) => {
      calls.push({ method, args });
      if (method === "listRecords") return { records: Array.from({ length: 1002 }, (_, index) => ({ id: index + 1, fields: {} })) };
      throw new Error("Grist 请求失败 (HTTP 403): API Key 无效或没有权限");
    });
  });
  try {
    const result = await client.callTool({ name: "grist_list_records", arguments: { docId: "doc", tableId: "Tasks" } });
    assert.deepEqual(calls[0], { method: "listRecords", args: ["doc", "Tasks", { limit: 100 }] });
    const text = (result.content as { type: string; text: string }[])[0].text;
    assert.equal(JSON.parse(text).records.length, 100);
    assert.equal(JSON.parse(text).truncated, true);
    const invalid = await client.callTool({ name: "grist_list_records", arguments: { docId: "doc", tableId: "Tasks", limit: 1001 } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 1);
    const failure = await client.callTool({ name: "grist_get_user_profile", arguments: {} });
    assert.equal(failure.isError, true);
    assert.match(JSON.stringify(failure.content), /HTTP 403/);
    revoked = true;
    const afterRevocation = await client.callTool({ name: "grist_list_orgs", arguments: {} });
    assert.equal(afterRevocation.isError, true);
    assert.match(JSON.stringify(afterRevocation.content), /revoked/);
    assert.equal(calls.length, 2);
  } finally { await close(); }
});

test("Grist MCP accepts only SELECT SQL and applies a server-side and output row limit", async () => {
  const calls: unknown[][] = [];
  const { client, close } = await setup(() => fakeClient((_method, args) => {
    calls.push(args);
    return { records: Array.from({ length: 5 }, (_, index) => ({ id: index })) };
  }));
  try {
    const invalid = await client.callTool({ name: "grist_query_document", arguments: { docId: "doc", sql: "DELETE FROM Tasks" } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 0);
    const multiple = await client.callTool({ name: "grist_query_document", arguments: { docId: "doc", sql: "SELECT * FROM Tasks; DELETE FROM Tasks" } });
    assert.equal(multiple.isError, true);
    assert.equal(calls.length, 0);
    const result = await client.callTool({ name: "grist_query_document", arguments: { docId: "doc", sql: "SELECT * FROM Tasks WHERE id > ?;", args: [2], limit: 3 } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls, [["doc", "SELECT * FROM (\nSELECT * FROM Tasks WHERE id > ?\n) AS grist_mcp_result LIMIT 3", [2]]]);
    assert.equal(JSON.parse((result.content as { text: string }[])[0].text).records.length, 3);
    const commented = await client.callTool({ name: "grist_query_document", arguments: { docId: "doc", sql: "SELECT * FROM Tasks -- note", limit: 2 } });
    assert.notEqual(commented.isError, true);
    assert.deepEqual(calls.at(-1), ["doc", "SELECT * FROM (\nSELECT * FROM Tasks -- note\n) AS grist_mcp_result LIMIT 2", undefined]);
  } finally { await close(); }
});

test("Grist MCP caps attachment metadata records with a default and maximum limit", async () => {
  const calls: unknown[][] = [];
  const { client, close } = await setup(() => fakeClient((method, args) => {
    assert.equal(method, "listAttachments");
    calls.push(args);
    return { records: Array.from({ length: 1002 }, (_, index) => ({ id: index + 1, fields: { fileName: `${index}.txt` } })) };
  }));
  try {
    const result = await client.callTool({ name: "grist_list_attachments", arguments: { docId: "doc" } });
    assert.equal(JSON.parse((result.content as { text: string }[])[0].text).records.length, 100);
    assert.deepEqual(calls[0], ["doc", { limit: 100 }]);
    const maximum = await client.callTool({ name: "grist_list_attachments", arguments: { docId: "doc", limit: 1000 } });
    assert.equal(JSON.parse((maximum.content as { text: string }[])[0].text).records.length, 1000);
    assert.deepEqual(calls[1], ["doc", { limit: 1000 }]);
    const invalid = await client.callTool({ name: "grist_list_attachments", arguments: { docId: "doc", limit: 1001 } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 2);
  } finally { await close(); }
});

test("Grist MCP dispatches schema and record writes with validated REST shapes", async () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const { client, close } = await setup(() => fakeClient((method, args) => { calls.push({ method, args }); return { ok: true }; }));
  try {
    const cases: [string, Record<string, unknown>, string, unknown[]][] = [
      ["grist_get_user_profile", {}, "getUserProfile", []],
      ["grist_list_orgs", {}, "listOrgs", []],
      ["grist_list_workspaces", { orgId: 4 }, "listWorkspaces", [4]],
      ["grist_list_docs", { workspaceId: 5 }, "listDocs", [5]],
      ["grist_get_doc_info", { docId: "d" }, "getDocInfo", ["d"]],
      ["grist_get_tables", { docId: "d" }, "getTables", ["d"]],
      ["grist_get_table_columns", { docId: "d", tableId: "T" }, "getTableColumns", ["d", "T"]],
      ["grist_list_snapshots", { docId: "d" }, "listSnapshots", ["d"]],
      ["grist_list_attachments", { docId: "d" }, "listAttachments", ["d", { limit: 100 }]],
      ["grist_add_records", { docId: "d", tableId: "T", records: [{ fields: { Name: "a" } }] }, "addRecords", ["d", "T", [{ fields: { Name: "a" } }]]],
      ["grist_update_records", { docId: "d", tableId: "T", records: [{ id: 1, fields: { Name: "b" } }] }, "updateRecords", ["d", "T", [{ id: 1, fields: { Name: "b" } }]]],
      ["grist_remove_records", { docId: "d", tableId: "T", recordIds: [1] }, "removeRecords", ["d", "T", [1]]],
      ["grist_create_doc", { workspaceId: 5, name: "new" }, "createDoc", [5, "new"]],
      ["grist_create_table", { docId: "d", tableId: "T", columns: [{ id: "Name", fields: { type: "Text" } }] }, "createTable", ["d", "T", [{ id: "Name", fields: { type: "Text" } }]]],
      ["grist_add_table_column", { docId: "d", tableId: "T", column: { id: "Name", fields: { type: "Text" } } }, "addTableColumn", ["d", "T", { id: "Name", fields: { type: "Text" } }]],
      ["grist_update_table_column", { docId: "d", tableId: "T", columnId: "Name", fields: { label: "Title" } }, "updateTableColumn", ["d", "T", "Name", { label: "Title" }]],
      ["grist_rename_table", { docId: "d", tableId: "T", newTableId: "New" }, "renameTable", ["d", "T", "New"]],
      ["grist_remove_table", { docId: "d", tableId: "T" }, "removeTable", ["d", "T"]],
      ["grist_remove_table_column", { docId: "d", tableId: "T", columnId: "Name" }, "removeTableColumn", ["d", "T", "Name"]],
    ];
    for (const [name, args, method, expected] of cases) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, name);
      assert.deepEqual(calls.at(-1), { method, args: expected }, name);
    }
  } finally { await close(); }
});
