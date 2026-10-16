// 这是服务器授予工作区的窄能力。backend 无需知道管理库或 WorkspaceManager。
import type { AdminStore } from "./admin-db.ts";
import type { Handlers } from "../backend/rpc.ts";
import { assistantRpcToolByMethod, assistantRpcToolDefinitions, sanitizeAssistantValue } from "../backend/assistant-tools.ts";
import { gristToolDefinitions } from "../backend/grist-tools.ts";
import type { GristClient } from "../backend/grist.ts";

type ReadWorkspace = { handlers: Handlers; gristClient?(): GristClient };

export function createAssistantAdminAccess(options: {
  actorId: number;
  admin: Pick<AdminStore, "getUser" | "listUsers">;
  workspaceManager: {
    open(userId: number): ReadWorkspace;
    withReadOnly?<T>(userId: number, read: (workspace: ReadWorkspace) => Promise<T>): Promise<T>;
  };
}) {
  const authorize = () => {
    const actor = options.admin.getUser(options.actorId);
    if (!actor || actor.disabled || actor.role !== "admin") throw new Error("仅启用的管理员可以跨用户只读查询");
  };
  return {
    async listUsers(): Promise<{ id: number; username: string }[]> {
      authorize();
      return options.admin.listUsers().map(({ id, username }) => ({ id, username }));
    },
    async query(input: { method: string; params?: unknown; userId?: number | string }): Promise<unknown> {
      authorize();
      const gristDefinitions = gristToolDefinitions(() => { throw new Error("尚未选择用户工作区"); });
      const definition = assistantRpcToolByMethod(input.method) ?? gristDefinitions.find((tool) => tool.name === input.method);
      if (!definition || definition.risk !== "read") throw new Error("跨用户只允许已登记的只读查询，不能执行修改或内部接口");
      let users = options.admin.listUsers();
      if (input.userId != null) {
        const id = String(input.userId);
        if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("无效的用户 ID");
        users = users.filter((user) => user.id === Number(id));
        if (!users.length) throw new Error("用户不存在");
      }
      const groups: { userId: number; username: string; result?: unknown; error?: string }[] = [];
      for (const user of users) {
        authorize();
        try {
          if (!options.admin.getUser(user.id)) throw new Error("用户不存在");
          const read = async (workspace: ReadWorkspace) => {
            authorize();
            const tools = [
              ...assistantRpcToolDefinitions(workspace.handlers),
              ...gristToolDefinitions(() => {
                if (!workspace.gristClient) throw new Error("目标用户没有可用的 Grist 连接");
                return workspace.gristClient();
              }),
            ];
            const tool = tools.find((tool) => tool.name === definition.name && tool.risk === "read");
            if (!tool) throw new Error("此用户工作区没有该只读查询");
            return tool.run(input.params ?? {});
          };
          // 即便目标用户在线也不能复用可写 handler：邮件读取会自动更新缓存。
          if (!options.workspaceManager.withReadOnly) throw new Error("工作区管理器不支持安全只读视图");
          const result = await options.workspaceManager.withReadOnly(user.id, read);
          authorize(); // 异步读取期间发生降权/停用也不能返回数据。
          // Shared Grist results are business data; their client/tool boundary already redacts errors.
          groups.push({ userId: user.id, username: user.username, result: definition.method ? sanitizeAssistantValue(result) : result });
        } catch (error) {
          authorize();
          const cacheMiss = error instanceof Error && /缓存/.test(error.message);
          groups.push({ userId: user.id, username: user.username, error: cacheMiss
            ? "目标工作区尚无这封邮件的本地缓存；跨用户只读查询不会触发邮箱同步"
            : "查询失败，请检查查询参数或目标工作区配置" });
        }
      }
      authorize();
      return groups;
    },
  };
}
