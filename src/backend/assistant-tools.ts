import { Type, type TSchema } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { Handlers } from "./rpc.ts";

export type AssistantRisk = "read" | "write" | "confirm";

export interface AssistantToolDefinition {
  /** RPC-backed tools keep the original method for admin read-only dispatch and audit. */
  method?: string;
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;
  risk: AssistantRisk;
  run(args: unknown): unknown | Promise<unknown>;
}

export interface AssistantRpcToolSpec extends Omit<AssistantToolDefinition, "run"> {
  method: string;
}

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const empty = object({});
const positiveInt = (description: string) => Type.Integer({ minimum: 1, description });
const siteId = positiveInt("站点编号");
const mailboxId = positiveInt("邮箱编号");
const changeId = positiveInt("变更记录编号");
const providerId = positiveInt("模型厂商编号");
const accountId = positiveInt("Hostinger 账号编号");
const jobId = positiveInt("放弃任务编号");
const entity = object({
  kind: Type.Union([Type.Literal("company"), Type.Literal("individual")]),
  name: Type.String(), address: Type.String(), supportEmail: Type.String(), phone: Type.String(),
  processingDays: Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 }),
  transitDays: Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 }),
});
const site = object({
  domain: Type.String(), categories: Type.String(), count: Type.Integer({ minimum: 1, maximum: 200 }),
  priceMin: Type.Union([Type.Number(), Type.Null()]), priceMax: Type.Union([Type.Number(), Type.Null()]), brand: Type.String(),
});

function rpc(method: string, name: string, description: string, parameters: TSchema, risk: AssistantRisk): AssistantRpcToolSpec {
  return { method, name, label: description.split(/[，。]/, 1)[0], description, parameters, risk };
}

/**
 * Explicit allow-list for workspace RPC methods. Parameters mirror the handlers in backend/index.ts;
 * methods that can accept or reveal credentials are deliberately absent and classified below.
 */
export const ASSISTANT_RPC_TOOLS: AssistantRpcToolSpec[] = [
  rpc("overview.get", "system_overview", "查看当前用户的运营总览、待办和站点统计。", empty, "read"),
  rpc("templates.list", "entity_templates_list", "列出当前用户保存的经营主体模板。", empty, "read"),
  rpc("templates.save", "entity_template_save", "新增或更新经营主体模板。", object({ id: Type.Optional(positiveInt("模板编号，更新时填写")), name: Type.String({ minLength: 1, maxLength: 100 }), entity }), "write"),
  rpc("templates.remove", "entity_template_remove", "删除一个经营主体模板。", object({ id: positiveInt("模板编号") }), "confirm"),
  rpc("sites.all", "sites_all", "查看当前用户全部站点及其完整状态。", empty, "read"),
  rpc("sites.get", "site_get", "按站点编号查看站点详情。", object({ siteId }), "read"),
  rpc("sites.history", "sites_history", "查看已经放弃的站点历史。", empty, "read"),
  rpc("system.info", "system_info", "查看 Node、SQLite 和工作区数据库版本。", empty, "read"),

  rpc("accounts.list", "hostinger_accounts_list", "列出当前用户的 Hostinger 账号摘要，不返回 Token。", empty, "read"),
  rpc("accounts.domains", "hostinger_account_domains", "查看一个 Hostinger 账号下已同步的域名。", object({ id: accountId }), "read"),
  rpc("accounts.sync", "hostinger_account_sync", "立即同步一个 Hostinger 账号的资源快照。", object({ id: accountId }), "write"),
  rpc("accounts.remove", "hostinger_account_remove", "从系统移除一个 Hostinger 账号连接及其本地关联。", object({ id: accountId }), "confirm"),

  rpc("models.presets", "model_presets", "查看可用的模型厂商预设。", empty, "read"),
  rpc("models.providers", "model_providers", "查看已配置的模型厂商和模型摘要，不返回 API Key。", empty, "read"),
  rpc("models.roles", "model_roles", "查看建站、对话、截图和复核等用途当前绑定的模型。", empty, "read"),
  rpc("models.delete", "model_provider_delete", "删除一个模型厂商配置。", object({ providerId }), "confirm"),
  rpc("models.fetch", "model_provider_fetch_models", "从已配置厂商刷新可用模型列表。", object({ providerId }), "read"),
  rpc("models.setRole", "model_role_set", "修改一个系统用途所使用的模型和思考强度。", object({
    role: Type.Union([Type.Literal("agent"), Type.Literal("vision"), Type.Literal("bulk"), Type.Literal("review")]),
    providerId, modelId: Type.String({ minLength: 1 }), thinking: Type.String(),
  }), "write"),
  rpc("models.test", "model_test", "向已配置模型发送极短测试请求；可能产生少量模型调用费用。", object({ providerId, modelId: Type.String({ minLength: 1 }) }), "confirm"),

  rpc("domains.free", "domains_free", "查看可用于新建站点的空闲域名。", empty, "read"),
  rpc("batches.list", "batches_list", "列出建站批次。", empty, "read"),
  rpc("batches.sites", "batch_sites", "查看一个批次内尚未放弃的站点。", object({ batchId: positiveInt("批次编号") }), "read"),
  rpc("batches.create", "batch_create", "创建建站批次并启动资源占用和自动建站任务。", object({ entity, sites: Type.Array(site, { minItems: 1 }) }), "confirm"),
  rpc("sites.steps", "site_steps", "查看一个站点的流水线步骤。", object({ siteId }), "read"),
  rpc("sites.events", "site_events", "查看一个站点的运行事件。", object({ siteId }), "read"),
  rpc("sites.qa", "site_qa_report", "查看一个站点的 QA 报告和本地截图数据。", object({ siteId }), "read"),
  rpc("qa.runs", "site_qa_runs", "查看一个站点的复核与修复任务记录。", object({ siteId }), "read"),
  rpc("qa.recheck", "site_qa_recheck", "对一个站点重新整站复核；会调用模型，产生费用。", object({ siteId }), "confirm"),
  rpc("qa.fixIssue", "site_qa_fix_issue", "按复核报告自动修复一个站点的单个问题，会直接修改线上站点内容。", object({ siteId, issueId: Type.String({ minLength: 1 }) }), "confirm"),
  rpc("qa.fixAll", "site_qa_fix_all", "按复核报告自动修复一个站点的全部问题，会直接修改线上站点内容。", object({ siteId }), "confirm"),
  rpc("sites.list", "sites_ready_list", "列出已经建完且未放弃的站点。", empty, "read"),
  rpc("sites.launch", "site_launch", "把一个站点正式上线。", object({ siteId }), "confirm"),
  rpc("sites.retry", "site_retry", "重新排队失败的建站任务，可能继续占用 Hostinger 或外部资源。", object({ siteId }), "confirm"),

  rpc("cj.status", "cj_status", "查看 CJ API Key 是否已配置及其安全提示。", empty, "read"),

  rpc("mail.status", "site_mail_status", "检查站点客服邮箱和邮件 DNS 状态。", object({ siteId }), "read"),
  rpc("mail.fix", "site_mail_fix", "创建或修复站点客服邮箱、DNS 和交易邮件配置。", object({ siteId }), "confirm"),
  rpc("mail.defaultPassword.status", "mail_default_password_status", "查看默认邮箱密码是否已在设置页配置。", empty, "read"),
  rpc("mail.list", "mailboxes_list", "列出邮箱摘要和未读状态，不返回密码。", empty, "read"),
  rpc("mail.sync", "mailboxes_sync", "同步邮箱清单和邮件缓存。", empty, "write"),
  rpc("mail.folders", "mail_folders", "列出一个邮箱的文件夹。", object({ mailboxId }), "read"),
  rpc("mail.messages", "mail_messages", "分页查询邮箱中的邮件摘要。", object({
    mailboxId, folder: Type.String({ minLength: 1, maxLength: 512 }), query: Type.Optional(Type.String()),
    page: Type.Optional(Type.Integer({ minimum: 1 })), pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), "read"),
  rpc("mail.message", "mail_message", "读取一封邮件的正文与附件元数据。", object({ mailboxId, folder: Type.String({ minLength: 1, maxLength: 512 }), uid: positiveInt("邮件 UID") }), "read"),
  rpc("mail.credential.reset", "mail_credential_reset", "重置一个邮箱的密码并保存新凭据。", object({ mailboxId, confirmed: Type.Literal(true) }), "confirm"),
  rpc("mail.credential.retryDefault", "mail_credential_retry_default", "用设置页保存的默认邮箱密码重新尝试登录一个邮箱，不返回密码。", object({ mailboxId }), "write"),
  rpc("mail.monitor","mail_monitor_set", "开启或关闭一个邮箱的新邮件监听。", object({ mailboxId, enabled: Type.Boolean() }), "write"),
  rpc("mail.seen", "mail_seen_set", "标记一封邮件为已读或未读。", object({ mailboxId, folder: Type.String({ minLength: 1, maxLength: 512 }), uid: positiveInt("邮件 UID"), seen: Type.Boolean() }), "write"),
  rpc("mail.trash", "mail_message_trash", "把一封邮件移入垃圾箱。", object({ mailboxId, folder: Type.String({ minLength: 1, maxLength: 512 }), uid: positiveInt("邮件 UID"), confirmed: Type.Literal(true) }), "confirm"),
  rpc("mail.delete", "mailbox_delete", "永久删除一个远端邮箱及本地记录。", object({ mailboxId, confirmed: Type.Literal(true) }), "confirm"),
  rpc("mail.send", "mail_send", "通过一个已配置邮箱发送邮件。", object({
    mailboxId, to: Type.Array(Type.String(), { minItems: 1 }), cc: Type.Optional(Type.Array(Type.String())), bcc: Type.Optional(Type.Array(Type.String())),
    subject: Type.String(), text: Type.String(), mode: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("reply"), Type.Literal("replyAll"), Type.Literal("forward")])),
    replyTo: Type.Optional(object({ folder: Type.String({ minLength: 1, maxLength: 512 }), uid: positiveInt("被回复邮件 UID") })),
    attachments: Type.Optional(Type.Array(object({ name: Type.String(), type: Type.String(), size: Type.Integer({ minimum: 0 }), dataBase64: Type.String() }))),
  }), "confirm"),
  rpc("smtp.status", "smtp_status", "查看一个站点的交易邮件发信状态。", object({ siteId }), "read"),
  rpc("smtp.resetPassword", "smtp_reset_password", "重置站点邮箱密码并启用交易邮件发信。", object({ siteId }), "confirm"),
  rpc("smtp.test", "smtp_test", "向指定地址发送一封交易邮件测试。", object({ siteId, to: Type.String({ minLength: 1 }) }), "confirm"),
  rpc("smtp.disable", "smtp_disable", "关闭一个站点的交易邮件发信。", object({ siteId }), "write"),

  rpc("changes.list", "site_changes_list", "查看站点内容变更和定时恢复状态。", object({ siteId }), "read"),
  rpc("changes.revert", "site_change_revert", "立即回滚一条站点内容变更。", object({ siteId, changeId }), "confirm"),
  rpc("changes.cancelSchedule", "site_change_cancel_schedule", "取消一条变更已安排的定时恢复。", object({ siteId, changeId }), "write"),

  rpc("abandon.start", "site_abandon_start", "启动不可逆的站点放弃流程，删除远端邮箱和网站并关闭域名续费。", object({
    domain: Type.String({ minLength: 1 }), confirmation: Type.String({ minLength: 1 }),
    siteId: Type.Optional(Type.Union([positiveInt("站点编号"), Type.Null()])), accountId: Type.Optional(Type.Union([accountId, Type.Null()])),
  }), "confirm"),
  rpc("abandon.status", "site_abandon_status", "按任务、域名、站点或账号查看放弃任务状态。", object({
    jobId: Type.Optional(jobId), domain: Type.Optional(Type.String()), siteId: Type.Optional(siteId), accountId: Type.Optional(accountId),
  }), "read"),
  rpc("abandon.retry", "site_abandon_retry", "重试失败的站点放弃任务并继续远端删除。", object({ jobId }), "confirm"),

  rpc("grist.settings.get", "grist_settings_status", "查看当前用户的 Grist 地址、配置状态和 Key 提示，不返回 Key。", empty, "read"),
];

/** Every excluded method has a reviewable reason; this is intentionally not a wildcard policy. */
export const ASSISTANT_EXCLUDED_METHODS: Readonly<Record<string, string>> = {
  "events.since": "SSE 推送内部接口，不是业务工具。",
  "accounts.add": "参数包含 Hostinger Token，只能在设置页面输入，凭据不得经过模型。",
  "models.create": "参数可包含模型 API Key，只能在设置页面配置密钥。",
  "models.update": "参数可包含模型 API Key，只能在设置页面配置密钥。",
  "models.setKey": "参数包含模型 API Key，只能在设置页面输入。",
  "cj.setKey": "参数包含 CJ API Key，只能在设置页面输入。",
  "chat.history": "站点对话内部接口；全局助手不能递归调用另一个对话。",
  "chat.send": "站点对话内部接口；全局助手不能递归发起模型对话。",
  "chat.abort": "站点对话内部控制接口。",
  "chat.reset": "站点对话内部控制接口。",
  "mail.defaultPassword.set": "参数包含默认邮箱密码，只能在设置页面输入。",
  "mail.password": "返回邮箱明文密码，绝不暴露给模型。",
  "mail.credential.save": "参数包含邮箱密码，只能在邮箱页面输入。",
  "smtp.enable": "参数可包含邮箱密码，只能在站点页面输入凭据。",
  "grist.settings.save": "参数可包含 Grist API Key，只能在设置页面输入。",
  "grist.testConnection": "参数可包含 Grist API Key，只能在设置页面测试。",
  "grist.mcpToken.status": "MCP 令牌页面内部接口；助手不需要读取令牌状态。",
  "grist.mcpToken.generate": "返回一次性的明文 MCP Token，只能由用户在设置页面生成并立即复制。",
  "grist.mcpToken.revoke": "MCP 令牌撤销只能由用户在设置页面明确操作。",
  "assistant.history": "全局助手对话内部接口，不能递归调用自身。",
  "assistant.send": "全局助手对话内部接口，不能递归调用自身。",
  "assistant.abort": "全局助手内部停止接口。",
  "assistant.reset": "全局助手内部新对话接口。",
  "assistant.confirm": "全局助手高风险确认回传接口，不能由模型自行确认。",
};

const sensitiveKey = /(?:password|passphrase|token|api[_-]?key|secret|ciphertext|credential|authorization)/i;
const hintKey = /hint$/i;
const booleanIndicatorKey = /(?:configured|saved|set|present|exists|enabled|status)$/i;
const redactedText = (text: string) => text
  .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi, "$1[已隐藏]")
  .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi, "$1[已隐藏]")
  .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-…[已隐藏]");

/** Remove secret-shaped fields recursively before values reach the model or the tool audit log. */
export function sanitizeAssistantValue(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  const clean = (current: unknown): unknown => {
    if (typeof current === "string") {
      const trimmed = current.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try { return JSON.stringify(clean(JSON.parse(current))); } catch { /* ordinary text */ }
      }
      return redactedText(current);
    }
    if (current == null || typeof current === "number" || typeof current === "boolean") return current;
    if (typeof current === "bigint") return current.toString();
    if (typeof current !== "object") return undefined;
    if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) return "[二进制数据已隐藏]";
    if (current instanceof Date) return current.toISOString();
    if (seen.has(current)) return "[循环引用已隐藏]";
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      seen.set(current, result);
      for (const item of current) result.push(clean(item));
      return result;
    }
    const result: Record<string, unknown> = {};
    seen.set(current, result);
    for (const [key, item] of Object.entries(current)) {
      if (sensitiveKey.test(key)) {
        const safeHint = hintKey.test(key) && (item == null || ["string", "number", "boolean"].includes(typeof item));
        const safeIndicator = booleanIndicatorKey.test(key) && (typeof item === "boolean" || typeof item === "number");
        if (!safeHint && !safeIndicator) continue;
      }
      const cleaned = clean(item);
      if (cleaned !== undefined) result[key] = cleaned;
    }
    return result;
  };
  return clean(value);
}

export function assistantRpcToolByMethod(method: string): AssistantRpcToolSpec | undefined {
  return ASSISTANT_RPC_TOOLS.find((tool) => tool.method === method);
}

/** Bind the static allow-list to one user's guarded workspace handlers. */
export function assistantRpcToolDefinitions(handlers: Handlers): AssistantToolDefinition[] {
  return ASSISTANT_RPC_TOOLS.filter((spec) => Object.hasOwn(handlers, spec.method)).map((spec) => ({
    ...spec,
    async run(args: unknown) {
      const input = args ?? {};
      if (!Value.Check(spec.parameters, input)) {
        const issue = Value.Errors(spec.parameters, input)[0];
        throw new Error(`助手工具参数不符合要求${issue ? `：${issue.message}` : ""}`);
      }
      const parsed = Value.Parse(spec.parameters, input);
      try {
        return sanitizeAssistantValue(await handlers[spec.method](parsed));
      } catch (error) {
        const message = error instanceof Error ? redactedText(error.message) : "未知错误";
        throw new Error(`工具执行失败：${message.slice(0, 500)}`);
      }
    },
  }));
}

