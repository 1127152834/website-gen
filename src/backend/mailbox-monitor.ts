import type { MailMonitorMode } from "../shared/mail-types.ts";
import type { MailCredentials, MailTransportFactory } from "./mailbox-transport.ts";

export interface MonitorCandidate {
  id: number;
  domain: string;
  credentials: MailCredentials;
}

export interface MailboxMonitorDeps {
  candidates(): MonitorCandidate[];
  transport: MailTransportFactory;
  syncInbox(mailboxId: number): Promise<void>;
  setMode(mailboxId: number, mode: MailMonitorMode, error?: string | null): void;
  idleLimit?: number;
  pollMs?: number;
  backoffMs?: number;
}

interface ActiveTask {
  domain: string;
  credentials: MailCredentials;
  mode: Exclude<MailMonitorMode, "off">;
  controller: AbortController;
  done: Promise<void>;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
  const timer = setTimeout(finish, ms);
  const abort = () => { clearTimeout(timer); finish(); };
  signal.addEventListener("abort", abort, { once: true });
});

/** 每个工作区一份：前 N 个邮箱使用 IDLE，其余按固定周期轮询。 */
export class MailboxMonitor {
  readonly #deps: MailboxMonitorDeps;
  readonly #active = new Map<number, ActiveTask>();
  readonly #blockedDomains = new Set<string>();
  #closed = false;
  #reconcileTask: Promise<void> = Promise.resolve();

  constructor(deps: MailboxMonitorDeps) {
    this.#deps = deps;
  }

  isDomainBlocked(domain: string): boolean {
    return this.#blockedDomains.has(domain.toLowerCase());
  }

  reconcile(): Promise<void> {
    const task = this.#reconcileTask.then(() => this.#reconcile());
    this.#reconcileTask = task.catch(() => {});
    return task;
  }

  async #reconcile(): Promise<void> {
    if (this.#closed) return;
    const candidates = this.#deps.candidates()
      .filter((item) => !this.isDomainBlocked(item.domain))
      .sort((a, b) => a.id - b.id);
    const wanted = new Map(candidates.map((item, index) => [item.id, { item, mode: index < (this.#deps.idleLimit ?? 15) ? "idle" as const : "poll" as const }]));
    const stopping: Promise<void>[] = [];
    for (const [id, task] of this.#active) {
      const next = wanted.get(id);
      if (!next || next.mode !== task.mode || next.item.credentials.address !== task.credentials.address || next.item.credentials.password !== task.credentials.password) {
        task.controller.abort();
        stopping.push(task.done);
        this.#active.delete(id);
        this.#deps.setMode(id, "off");
      }
    }
    await Promise.allSettled(stopping);
    if (this.#closed) return;
    for (const [id, next] of wanted) if (!this.#active.has(id)) this.#start(next.item, next.mode);
  }

  async stopMailbox(mailboxId: number): Promise<void> {
    const task = this.#active.get(mailboxId);
    if (!task) return this.#deps.setMode(mailboxId, "off");
    this.#active.delete(mailboxId);
    task.controller.abort();
    await task.done;
    this.#deps.setMode(mailboxId, "off");
  }

  async stopDomain(domain: string): Promise<void> {
    const normalized = domain.toLowerCase();
    this.#blockedDomains.add(normalized);
    await Promise.all([...this.#active.entries()]
      .filter(([, task]) => task.domain.toLowerCase() === normalized)
      .map(([id]) => this.stopMailbox(id)));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#reconcileTask;
    const tasks = [...this.#active.values()];
    this.#active.clear();
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map((task) => task.done));
  }

  #start(candidate: MonitorCandidate, mode: Exclude<MailMonitorMode, "off">): void {
    const controller = new AbortController();
    const done = mode === "idle" ? this.#idleLoop(candidate, controller.signal) : this.#pollLoop(candidate, controller.signal);
    this.#active.set(candidate.id, { domain: candidate.domain, credentials: candidate.credentials, mode, controller, done });
    this.#deps.setMode(candidate.id, mode, null);
  }

  async #idleLoop(candidate: MonitorCandidate, signal: AbortSignal): Promise<void> {
    let backoff = this.#deps.backoffMs ?? 1_000;
    while (!signal.aborted && !this.#closed && !this.isDomainBlocked(candidate.domain)) {
      try {
        await this.#deps.syncInbox(candidate.id);
        await this.#deps.transport().idle(candidate.credentials, () => this.#deps.syncInbox(candidate.id), signal);
        backoff = this.#deps.backoffMs ?? 1_000;
      } catch (error) {
        if (signal.aborted) break;
        this.#deps.setMode(candidate.id, "idle", error instanceof Error ? error.message : String(error));
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  async #pollLoop(candidate: MonitorCandidate, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.#closed && !this.isDomainBlocked(candidate.domain)) {
      try {
        await this.#deps.syncInbox(candidate.id);
        this.#deps.setMode(candidate.id, "poll", null);
      } catch (error) {
        this.#deps.setMode(candidate.id, "poll", error instanceof Error ? error.message : String(error));
      }
      await sleep(this.#deps.pollMs ?? 120_000, signal);
    }
  }
}
