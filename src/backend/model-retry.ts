// 模型调用的临时错误（网络中断、超时、限流、服务端 5xx）自动重试；Key 无效、参数错误等直接失败。
import { setTimeout as sleep } from "node:timers/promises";

export function isTransientModelError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /terminated|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timeout|timed out|overloaded|rate.?limit|\b429\b|\b5\d\d\b/i.test(text);
}

export async function withModelRetry<T>(call: () => Promise<T>, delaysMs: number[] = [2000, 6000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= delaysMs.length || !isTransientModelError(error)) throw error;
      await sleep(delaysMs[attempt]);
    }
  }
}
