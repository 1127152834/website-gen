import { test } from "node:test";
import assert from "node:assert/strict";
import { gristMcpCommand } from "./grist-settings-helpers.ts";

test("Grist MCP command includes the endpoint and one-time token", () => {
  assert.equal(
    gristMcpCommand("https://console.example", "secret"),
    'claude mcp add --transport http grist https://console.example/api/mcp --header "Authorization: Bearer secret"',
  );
  assert.match(gristMcpCommand("https://console.example"), /<MCP 令牌>/);
});
