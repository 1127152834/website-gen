import type { ChatEvent, ChatItem } from "../../../shared/protocol.ts";

export type LiveChat = { text: string; thinking: string; tools: Extract<ChatItem, { role: "tool" }>[] };

export class LatestRequest {
  #version = 0;
  begin(): number { return ++this.#version; }
  invalidate(): void { this.#version++; }
  isCurrent(version: number): boolean { return version === this.#version; }
}

export function emptyLiveChat(): LiveChat {
  return { text: "", thinking: "", tools: [] };
}

export function applyChatEvent(current: LiveChat, event: ChatEvent): LiveChat {
  if (event.type === "text") return { ...current, text: current.text + event.delta };
  if (event.type === "thinking") return { ...current, thinking: current.thinking + event.delta };
  if (event.type === "tool_start") {
    return { ...current, tools: [...current.tools, { role: "tool", id: event.id, name: event.name, args: event.args, ok: null, result: "" }] };
  }
  if (event.type === "tool_end") {
    return { ...current, tools: current.tools.map((tool) => tool.id === event.id ? { ...tool, name: event.name, ok: event.ok, result: event.result } : tool) };
  }
  return current;
}

/** Used as a visual fallback while a settled history reload is in flight. */
export function mergeLiveChat(items: ChatItem[], live: LiveChat | null): ChatItem[] {
  if (!live) return items;
  const answer: ChatItem[] = live.text || live.thinking ? [{ role: "assistant", text: live.text, thinking: live.thinking }] : [];
  return [...items, ...live.tools, ...answer];
}
