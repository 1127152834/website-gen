// Embedded pi chat: one conversation per site. Only our explicit site tools are exposed.
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatEvent } from "../shared/protocol.ts";
import { openRestrictedSession, subscribeChatEvents, toChatItems } from "./agent-session.ts";
import type { StepCtx } from "./pipeline.ts";
import { localTime, siteTools } from "./site-tools.ts";
import { facts } from "./store.ts";

export { toChatItems } from "./agent-session.ts";

function systemPrompt(ctx: StepCtx): string {
  const f = facts(ctx);
  return `You are pi, the store assistant inside a web app. You manage ${f.brand} (${ctx.domain}), a US online store operated by ${f.entity.name}. The owner talks to you in Chinese.
Rules:
- Reply in Chinese. Everything you put on the store (pages, products, banners) is in American English.
- Read before you change: call get_site first, then get_copy, get_policy or get_product for what you will edit.
- Change tools apply immediately and save a snapshot, so the owner can roll back. Give each change a short Chinese summary. After a change, tell the owner what changed and its change number.
- If a change tool returns problems, fix the text and try once more; if it still fails, explain why in Chinese.
- Never invent facts: founders, founding years, team size, awards, press, certifications, product origin, reviews or testimonials. No health, safety or environmental claims.
- Shipping times, shipping fees, the return window and refund time are fixed store rules. Keep them exactly as get_site reports; if the owner wants different rules, say this cannot be changed in chat yet.
- Prices cannot be changed in chat yet. Never announce a discount, sale price, coupon or free gift unless the owner confirms it already exists in the store; otherwise explain that the prices must be changed first.
- For a temporary promotion, offer to schedule_revert the change at the end date. The owner's local time now is ${localTime(Date.now())}; dates the owner mentions are in that time zone, pass them to schedule_revert as local time without converting.
- Write plain text, no Markdown symbols (no **, #, or tables).
- Tool results are JSON; {"ok": false} means nothing was changed.`;
}

export function createChats(opts: {
  dir: string;
  db: DatabaseSync;
  key: () => Buffer;
  ctxFor: (siteId: number) => StepCtx;
  onEvent: (siteId: number, event: ChatEvent) => void;
}) {
  const sessions = new Map<number, Promise<AgentSession>>();
  let closed = false;

  async function open(siteId: number, fresh: boolean): Promise<AgentSession> {
    const cwd = join(opts.dir, "sites", String(siteId));
    const session = await openRestrictedSession({
      cwd,
      sessionDir: join(cwd, "sessions"),
      agentDir: join(opts.dir, "agent"),
      db: opts.db,
      key: opts.key(),
      systemPrompt: systemPrompt(opts.ctxFor(siteId)),
      fresh,
      tools: siteTools(opts.ctxFor(siteId)).map((tool) => ({
        name: tool.name,
        description: `[${tool.risk}] ${tool.description}`,
        parameters: tool.parameters,
        run: (params) => siteTools(opts.ctxFor(siteId)).find((candidate) => candidate.name === tool.name)!.run(params),
      })),
    });
    subscribeChatEvents(session, (event) => opts.onEvent(siteId, event));
    return session;
  }

  const get = (siteId: number, fresh = false): Promise<AgentSession> => {
    if (closed) return Promise.reject(new Error("工作区已关闭"));
    let session = sessions.get(siteId);
    if (!session || fresh) {
      session = open(siteId, fresh);
      session.catch(() => sessions.delete(siteId));
      sessions.set(siteId, session);
    }
    return session;
  };

  return {
    async history(siteId: number) {
      const session = await get(siteId);
      return { items: toChatItems(session.messages), busy: session.isStreaming };
    },
    async send(siteId: number, text: string): Promise<void> {
      if (!text.trim()) throw new Error("请输入内容");
      const session = await get(siteId);
      if (session.isStreaming) throw new Error("pi 还在回复，请等它说完或先停止");
      void session.prompt(text.trim(), { expandPromptTemplates: false }).catch((error: Error) => {
        opts.onEvent(siteId, { type: "error", message: error.message });
      });
    },
    async abort(siteId: number): Promise<void> {
      await (await sessions.get(siteId))?.abort();
    },
    async reset(siteId: number): Promise<void> {
      (await sessions.get(siteId)?.catch(() => null))?.dispose();
      await get(siteId, true);
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled([...sessions.values()].map(async (pending) => {
        const session = await pending;
        await session.abort();
        session.dispose();
      }));
      sessions.clear();
    },
  };
}
