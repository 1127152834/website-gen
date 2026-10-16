import { test } from "node:test";
import assert from "node:assert/strict";
import { toolDisplayName } from "./chat-message-utils.ts";
import { ASSISTANT_RPC_TOOLS } from "../../../backend/assistant-tools.ts";
import { GRIST_TOOL_NAMES } from "../../../backend/grist-tools.ts";

test("shared chat renderer labels known tools in Chinese and keeps unknown names visible", () => {
  assert.equal(toolDisplayName("get_site"), "查看站点概况");
  assert.equal(toolDisplayName("sites_all"), "查看全部站点");
  assert.equal(toolDisplayName("custom_tool"), "custom_tool");
  assert.equal(toolDisplayName("grist.list_tables"), "Grist 表格：列表 数据表");
  assert.equal(toolDisplayName("system_overview"), "查看运营总览");
  assert.equal(toolDisplayName("site_launch"), "站点上线");
});

test("every registered global assistant tool has an explicit Chinese browser label", () => {
  const names = [...ASSISTANT_RPC_TOOLS.map((tool) => tool.name), ...GRIST_TOOL_NAMES, "read_user_manual", "admin_list_users", "admin_query_user_data"];
  for (const name of names) {
    const label = toolDisplayName(name);
    assert.match(label, /[\u3400-\u9fff]/, `${name} should have a Chinese label, received ${label}`);
    assert.doesNotMatch(label, /\b(?:fetch|profile|help|list|get|set|create|update|remove|delete|query|records?|tables?|columns?|docs?|workspaces?|orgs?)\b/i, `${name} has an untranslated action: ${label}`);
  }
});
