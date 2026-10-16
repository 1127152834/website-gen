import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEvent, ChatItem } from "../../../shared/protocol.ts";
import { applyChatEvent, emptyLiveChat, LatestRequest, mergeLiveChat } from "./assistant-state.ts";

test("assistant streaming reducer accumulates text, thinking and tool outcomes", () => {
  const events: ChatEvent[] = [
    { type: "thinking", delta: "先查" },
    { type: "tool_start", id: "one", name: "sites_all", args: { status: "done" } },
    { type: "tool_end", id: "one", name: "sites_all", ok: true, result: "2 个站点" },
    { type: "text", delta: "查到了" },
  ];
  const live = events.reduce(applyChatEvent, emptyLiveChat());
  assert.equal(live.thinking, "先查");
  assert.equal(live.text, "查到了");
  assert.deepEqual(live.tools, [{ role: "tool", id: "one", name: "sites_all", args: { status: "done" }, ok: true, result: "2 个站点" }]);
});

test("settled live output can be merged without losing streamed tool state", () => {
  const items: ChatItem[] = [{ role: "user", text: "查站点" }];
  const live = applyChatEvent(emptyLiveChat(), { type: "text", delta: "完成" });
  assert.deepEqual(mergeLiveChat(items, live), [
    { role: "user", text: "查站点" },
    { role: "assistant", text: "完成", thinking: "" },
  ]);
});

test("history requests cannot overwrite newer streamed or optimistic state", () => {
  const gate = new LatestRequest();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
});
