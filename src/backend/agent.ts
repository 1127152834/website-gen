// pi 内置 Agent：每个站一个对话会话。只开放 site-tools 里的工具（内置 read/bash/edit/write 全关），
// 不加载磁盘上任何扩展、技能、上下文文件（防注入）；会话保存在 userData/pi/sites/<站点>/sessions，模型 Key 只在内存里。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, createExtensionRuntime, defineTool, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { ChatEvent, ChatItem } from "../shared/protocol.ts";
import { providersFromDb, roleChoice } from "./models.ts";
import type { StepCtx } from "./pipeline.ts";
import { localTime, siteTools } from "./site-tools.ts";
import { facts } from "./store.ts";

function systemPrompt(ctx: StepCtx): string {
  const f = facts(ctx);
  return `You are pi, the store assistant inside a desktop app. You manage ${f.brand} (${ctx.domain}), a US online store operated by ${f.entity.name}. The owner talks to you in Chinese.
Rules:
- Reply in Chinese. Everything you put on the store (pages, products, banners) is in American English.
- Read before you change: call get_site first, then get_copy, get_policy or get_product for what you will edit.
- Change tools apply immediately and save a snapshot, so the owner can roll back. Give each change a short Chinese summary. After a change, tell the owner what changed and its change number.
- If a change tool returns problems, fix the text and try once more; if it still fails, explain why in Chinese.
- Never invent facts: founders, founding years, team size, awards, press, certifications, product origin, reviews or testimonials. No health, safety or environmental claims.
- Shipping times, shipping fees, the return window and refund time are fixed store rules. Keep them exactly as get_site reports; if the owner wants different rules, say this cannot be changed in chat yet.
- Prices cannot be changed in chat yet. Never announce a discount, sale price, coupon or free gift unless the owner confirms it already exists in the store; otherwise explain that the prices must be changed first (announcing a discount that does not exist is deceptive advertising).
- For a temporary promotion, offer to schedule_revert the change at the end date. The owner's local time now is ${localTime(Date.now())}; dates the owner mentions are in that time zone, pass them to schedule_revert as local time without converting.
- Write plain text, no Markdown symbols (no **, #, or tables).
- Tool results are JSON; {"ok": false} means nothing was changed.`;
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((c: { type?: string }) => c.type === "text").map((c: { text: string }) => c.text).join("") : "";
const okOf = (text: string) => {
  try {
    return (JSON.parse(text) as { ok?: boolean }).ok !== false;
  } catch {
    return true;
  }
};

/** pi 的会话消息 → 界面显示的对话记录（工具调用和它的结果合成一条） */
export function toChatItems(messages: unknown[]): ChatItem[] {
  const items: ChatItem[] = [];
  const calls = new Map<string, Extract<ChatItem, { role: "tool" }>>();
  for (const m of messages as { role: string; content: unknown; stopReason?: string; errorMessage?: string; toolCallId?: string; isError?: boolean }[]) {
    if (m.role === "user") items.push({ role: "user", text: textOf(m.content) });
    else if (m.role === "assistant") {
      const parts = (m.content ?? []) as { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }[];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
      const thinking = parts.filter((p) => p.type === "thinking").map((p) => p.thinking).join("");
      const error = m.stopReason === "error" ? (m.errorMessage ?? "模型调用失败") : undefined;
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
      call.ok = !m.isError && okOf(call.result);
    }
  }
  return items;
}

export function createChats(opts: {
  /** 会话目录根（userData/pi） */
  dir: string;
  db: DatabaseSync;
  key: () => Buffer;
  /** 每次调工具都取新的站点上下文，读到的总是数据库里最新的内容 */
  ctxFor: (siteId: number) => StepCtx;
  onEvent: (siteId: number, e: ChatEvent) => void;
}) {
  const sessions = new Map<number, Promise<AgentSession>>();

  async function open(siteId: number, fresh: boolean): Promise<AgentSession> {
    const choice = roleChoice(opts.db, "agent");
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    for (const p of providersFromDb(opts.db, opts.key())) runtime.registerNativeProvider(p);
    const model = choice && runtime.getModel(`p${choice.provider_id}`, choice.model_id);
    if (!choice || !model) throw new Error("「建站与对话」用途还没有可用的模型：先在设置页设置 Key");

    const tools = siteTools(opts.ctxFor(siteId)).map((t) => defineTool({
      name: t.name, label: t.name, description: `[${t.risk}] ${t.description}`, parameters: t.parameters,
      execute: async (_callId, params) => {
        let result: unknown;
        try {
          result = await siteTools(opts.ctxFor(siteId)).find((x) => x.name === t.name)!.run(params);
        } catch (e) {
          result = { ok: false, error: (e as Error).message };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
      },
    }));
    const system = systemPrompt(opts.ctxFor(siteId));
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => system,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const cwd = join(opts.dir, "sites", String(siteId));
    const sessionDir = join(cwd, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const { session } = await createAgentSession({
      cwd, agentDir: join(opts.dir, "agent"), model, thinkingLevel: choice.thinking as never, modelRuntime: runtime, resourceLoader,
      customTools: tools, tools: tools.map((t) => t.name), // 白名单：只有我们的工具
      sessionManager: fresh ? SessionManager.create(cwd, sessionDir) : SessionManager.continueRecent(cwd, sessionDir),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
    });

    const emit = (e: ChatEvent) => opts.onEvent(siteId, e);
    session.subscribe((e) => {
      if (e.type === "message_update") {
        const a = e.assistantMessageEvent as { type: string; delta?: string };
        if (a.type === "text_delta") emit({ type: "text", delta: a.delta ?? "" });
        else if (a.type === "thinking_delta") emit({ type: "thinking", delta: a.delta ?? "" });
      } else if (e.type === "tool_execution_start") {
        emit({ type: "tool_start", id: e.toolCallId, name: e.toolName, args: e.args });
      } else if (e.type === "tool_execution_end") {
        const text = textOf((e.result as { content?: unknown } | undefined)?.content).slice(0, 2000);
        emit({ type: "tool_end", id: e.toolCallId, name: e.toolName, ok: !e.isError && okOf(text), result: text });
      } else if (e.type === "message_end") {
        const m = e.message as { role: string; stopReason?: string; errorMessage?: string };
        if (m.role === "assistant" && m.stopReason === "error") emit({ type: "error", message: m.errorMessage ?? "模型调用失败" });
      } else if (e.type === "agent_settled") {
        emit({ type: "settled", aborted: e.aborted });
      }
    });
    return session;
  }

  const get = (siteId: number, fresh = false): Promise<AgentSession> => {
    let s = sessions.get(siteId);
    if (!s || fresh) {
      s = open(siteId, fresh);
      s.catch(() => sessions.delete(siteId)); // 打开失败（例如还没设 Key）不缓存
      sessions.set(siteId, s);
    }
    return s;
  };

  return {
    async history(siteId: number): Promise<{ items: ChatItem[]; busy: boolean }> {
      const s = await get(siteId);
      return { items: toChatItems(s.messages), busy: s.isStreaming };
    },
    async send(siteId: number, text: string): Promise<void> {
      if (!text.trim()) throw new Error("请输入内容");
      const s = await get(siteId);
      if (s.isStreaming) throw new Error("pi 还在回复，等它说完或先停止");
      void s.prompt(text.trim()).catch((e: Error) => opts.onEvent(siteId, { type: "error", message: e.message }));
    },
    async abort(siteId: number): Promise<void> {
      await (await sessions.get(siteId))?.abort();
    },
    /** 开始新对话：旧对话的文件留在磁盘上 */
    async reset(siteId: number): Promise<void> {
      (await sessions.get(siteId)?.catch(() => null))?.dispose();
      await get(siteId, true);
    },
  };
}
