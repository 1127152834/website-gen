import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { InMemoryCredentialStore, type TSchema } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { ChatEvent, ChatItem } from "../shared/protocol.ts";
import { providersFromDb, roleChoice } from "./models.ts";

export interface RestrictedTool {
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;
  run(params: any): Promise<unknown> | unknown;
}

export interface RestrictedSessionOptions {
  cwd: string;
  sessionDir: string;
  agentDir: string;
  db: DatabaseSync;
  key: Buffer;
  systemPrompt: string;
  tools: RestrictedTool[];
  fresh?: boolean;
}

export const textOf = (content: unknown): string =>
  typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((c: { type?: string }) => c.type === "text").map((c: { text: string }) => c.text).join("") : "";

export const resultOk = (text: string): boolean => {
  try {
    return (JSON.parse(text) as { ok?: boolean }).ok !== false;
  } catch {
    return true;
  }
};

export const safeAgentError = (value: unknown): string => String(value ?? "模型调用失败")
  .replace(/\b(api[-_ ]?key|token|password|secret|authorization)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
  .slice(0, 1000);

/** pi transcript -> UI chat items. */
export function toChatItems(messages: unknown[]): ChatItem[] {
  const items: ChatItem[] = [];
  const calls = new Map<string, Extract<ChatItem, { role: "tool" }>>();
  for (const m of messages as { role: string; content: unknown; stopReason?: string; errorMessage?: string; toolCallId?: string; isError?: boolean }[]) {
    if (m.role === "user") items.push({ role: "user", text: textOf(m.content) });
    else if (m.role === "assistant") {
      const parts = (m.content ?? []) as { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }[];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
      const thinking = parts.filter((p) => p.type === "thinking").map((p) => p.thinking).join("");
      const error = m.stopReason === "error" ? safeAgentError(m.errorMessage) : undefined;
      if (text || thinking || error) items.push({ role: "assistant", text, thinking, ...(error ? { error } : {}) });
      for (const p of parts.filter((x) => x.type === "toolCall")) {
        const call: Extract<ChatItem, { role: "tool" }> = { role: "tool", id: p.id!, name: p.name!, args: p.arguments, ok: null, result: "" };
        calls.set(call.id, call);
        items.push(call);
      }
    } else if (m.role === "toolResult") {
      const call = calls.get(m.toolCallId!);
      if (!call) continue;
      call.result = textOf(m.content).slice(0, 2000);
      call.ok = !m.isError && resultOk(call.result);
    }
  }
  return items;
}

export function restrictedResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** SDK 1.2 selection: suppress built-ins and allow only the explicit custom-tool names. */
export function restrictedToolSelection(tools: readonly Pick<RestrictedTool, "name">[]) {
  return { noTools: "builtin" as const, tools: tools.map((tool) => tool.name) };
}

/** Open an embedded pi session with only explicitly supplied tools. */
export async function openRestrictedSession(opts: RestrictedSessionOptions): Promise<AgentSession> {
  const choice = roleChoice(opts.db, "agent");
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  for (const provider of providersFromDb(opts.db, opts.key)) runtime.registerNativeProvider(provider);
  const model = choice && runtime.getModel(`p${choice.provider_id}`, choice.model_id);
  if (!choice || !model) throw new Error("“建站与对话”用途还没有可用模型，请先到设置页配置模型和 Key");

  const tools = opts.tools.map((tool) => defineTool({
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_callId, params) => {
      let result: unknown;
      try {
        result = await tool.run(params);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
    },
  }));
  const selection = restrictedToolSelection(tools);
  mkdirSync(opts.sessionDir, { recursive: true });
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    model,
    thinkingLevel: choice.thinking as never,
    modelRuntime: runtime,
    resourceLoader: restrictedResourceLoader(opts.systemPrompt),
    customTools: tools,
    ...selection,
    sessionManager: opts.fresh ? SessionManager.create(opts.cwd, opts.sessionDir) : SessionManager.continueRecent(opts.cwd, opts.sessionDir),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
  });
  return session;
}

export function subscribeChatEvents(session: AgentSession, emit: (event: ChatEvent) => void): () => void {
  return session.subscribe((event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent as { type: string; delta?: string };
      if (update.type === "text_delta") emit({ type: "text", delta: update.delta ?? "" });
      else if (update.type === "thinking_delta") emit({ type: "thinking", delta: update.delta ?? "" });
    } else if (event.type === "tool_execution_start") {
      emit({ type: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end") {
      const text = textOf((event.result as { content?: unknown } | undefined)?.content).slice(0, 2000);
      emit({ type: "tool_end", id: event.toolCallId, name: event.toolName, ok: !event.isError && resultOk(text), result: text });
    } else if (event.type === "message_end") {
      const message = event.message as { role: string; stopReason?: string; errorMessage?: string };
      if (message.role === "assistant" && message.stopReason === "error") emit({ type: "error", message: safeAgentError(message.errorMessage) });
    } else if (event.type === "agent_settled") {
      emit({ type: "settled", aborted: event.aborted });
    }
  });
}
