// 访问站点 REST 的网络层：读请求遇到网络错误自动重试；写请求不重试（服务器可能已经执行过）。
// 报错写明是哪个接口、底层是什么网络错误（Node 把它藏在 error.cause 里，只抛一句 "fetch failed"）。
import { setTimeout as sleep } from "node:timers/promises";

const READ = new Set(["GET", "HEAD"]);

function describe(error: unknown): string {
  const e = error as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause ? [e.cause.code, e.cause.message].filter(Boolean).join(" ") : "";
  return cause ? `${e?.message ?? String(error)}（${cause}）` : e?.message ?? String(error);
}

export async function siteFetch(fetchImpl: typeof fetch, url: string, init: RequestInit, delaysMs: number[] = [1000, 3000]): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      // 超时（AbortSignal.timeout）不重试：再等一轮只会更慢
      const timeout = (error as Error)?.name === "TimeoutError";
      if (!READ.has(method) || timeout || attempt >= delaysMs.length) {
        const path = new URL(url).pathname.replace(/^\/wp-json\//, "");
        throw new Error(`访问网站接口失败（${method} ${path}）：${describe(error)}`);
      }
      await sleep(delaysMs[attempt]);
    }
  }
}
