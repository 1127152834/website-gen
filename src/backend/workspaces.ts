import { join } from "node:path";
import { deriveUserKey } from "../server/keys.ts";
import { createWorkspace, type Workspace } from "./index.ts";

/** 用户 ID 只来自管理库，不接受前端指定目录；停用后关闭其所有后台任务。 */
export class WorkspaceManager {
  private readonly options: { dataDir: string; masterKey: Buffer; resourcesDir?: string };
  private readonly workspaces = new Map<string, Workspace>();
  private readonly closing = new Set<string>();

  constructor(options: { dataDir: string; masterKey: Buffer; resourcesDir?: string }) {
    this.options = options;
  }

  private id(value: number | string): string {
    const id = String(value);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("无效的用户 ID");
    return id;
  }

  get(userId: number | string): Workspace | undefined {
    return this.workspaces.get(this.id(userId));
  }

  open(userId: number | string): Workspace {
    const id = this.id(userId);
    if (this.closing.has(id)) throw new Error("工作区正在关闭");
    let workspace = this.workspaces.get(id);
    if (!workspace) {
      workspace = createWorkspace({
        userDir: join(this.options.dataDir, "users", id),
        key: deriveUserKey(this.options.masterKey, id),
        resourcesDir: this.options.resourcesDir,
      });
      this.workspaces.set(id, workspace);
    }
    return workspace;
  }

  /** 跨用户查询永远使用独立 SQLite 只读连接，不复用目标的可写工作区。 */
  async withReadOnly<T>(userId: number | string, read: (workspace: Workspace) => Promise<T>): Promise<T> {
    const id = this.id(userId);
    if (this.closing.has(id)) throw new Error("工作区正在关闭");
    const workspace = createWorkspace({
      userDir: join(this.options.dataDir, "users", id),
      key: deriveUserKey(this.options.masterKey, id),
      resourcesDir: this.options.resourcesDir,
      backgroundTasks: false,
      readOnly: true,
    });
    try { return await read(workspace); }
    finally { await workspace.close(); }
  }

  async close(userId: number | string): Promise<void> {
    const id = this.id(userId);
    const workspace = this.workspaces.get(id);
    if (!workspace) return;
    this.closing.add(id);
    try {
      await workspace.close();
      this.workspaces.delete(id);
    } finally {
      this.closing.delete(id);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.workspaces.keys()].map((id) => this.close(id)));
  }
}
