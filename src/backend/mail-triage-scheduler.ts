import type { TriagePriority } from "./mail-triage-queue.ts";

export interface TriageScheduler {
  acquire(workspaceKey: string, priority: TriagePriority, signal: AbortSignal): Promise<() => void>;
  close(): void;
}
interface Waiter { key: string; priority: TriagePriority; signal: AbortSignal; resolve: (release: () => void) => void; reject: (reason: Error) => void; abort: () => void }
const abortError = () => new DOMException("调度许可已中断", "AbortError");

/** 服务级单例由调用方共享；不持有正文。等待按优先级，再按工作区上次获准次序轮询。 */
export function createTriageScheduler(limit = 4): TriageScheduler {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4) throw new RangeError("服务并发必须为1–4");
  const waiting: Waiter[] = []; const active = new Map<string, () => void>();
  const lastAdmitted = new Map<string, number>(); let turn = 0; let closed = false;
  function drain() {
    if (closed) return;
    while (active.size < limit) {
      const eligible = waiting.filter(w => !active.has(w.key));
      eligible.sort((a,b) => (a.priority === "new" ? 0 : 1) - (b.priority === "new" ? 0 : 1)
        || (lastAdmitted.get(a.key) ?? 0) - (lastAdmitted.get(b.key) ?? 0));
      const next = eligible[0]; if (!next) return;
      waiting.splice(waiting.indexOf(next),1); next.signal.removeEventListener("abort",next.abort);
      let released = false;
      const release = () => {
        if (released) return; released = true;
        next.signal.removeEventListener("abort",release); active.delete(next.key); drain();
      };
      active.set(next.key,release); lastAdmitted.set(next.key,++turn);
      next.signal.addEventListener("abort",release,{once:true}); next.resolve(release);
    }
  }
  return {
    acquire(key,priority,signal) {
      if (closed) return Promise.reject(new Error("调度器已关闭"));
      if (signal.aborted) return Promise.reject(abortError());
      if (!key || (priority !== "new" && priority !== "history")) return Promise.reject(new TypeError("工作区或优先级无效"));
      return new Promise((resolve,reject) => {
        const waiter: Waiter = {key,priority,signal,resolve,reject,abort:() => {
          const index = waiting.indexOf(waiter); if(index < 0) return;
          waiting.splice(index,1); signal.removeEventListener("abort",waiter.abort); reject(abortError()); drain();
        }};
        waiting.push(waiter); signal.addEventListener("abort",waiter.abort,{once:true}); drain();
      });
    },
    close() {
      if(closed) return; closed=true;
      for(const waiter of waiting.splice(0)) {waiter.signal.removeEventListener("abort",waiter.abort);waiter.reject(new Error("调度器已关闭"));}
      for(const release of [...active.values()]) release(); lastAdmitted.clear();
    },
  };
}
