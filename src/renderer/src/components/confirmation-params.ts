export interface ConfirmationParamEntry {
  label: string;
  value: string;
}

const VALUE_LIMIT = 120;
const LABEL_LIMIT = 40;
const PARAM_LABELS = new Map<string, string>([
  ["docId", "文档"],
  ["tableId", "表"],
  ["newTableId", "新表"],
  ["columnId", "列"],
  ["recordIds", "行 ID"],
  ["records", "记录"],
  ["fields", "修改内容"],
  ["workspaceId", "工作空间编号"],
  ["siteId", "站点编号"],
  ["batchId", "批次编号"],
  ["accountId", "Hostinger 账号编号"],
  ["providerId", "模型厂商编号"],
  ["modelId", "模型"],
  ["mailboxId", "邮箱编号"],
  ["email", "邮箱"],
  ["to", "收件人"],
  ["cc", "抄送"],
  ["bcc", "密送"],
  ["subject", "主题"],
  ["text", "正文"],
  ["replyTo", "回复邮件"],
  ["folder", "邮件文件夹"],
  ["uid", "邮件 UID"],
  ["changeId", "变更记录编号"],
  ["jobId", "任务编号"],
  ["domain", "域名"],
  ["confirmation", "确认内容"],
  ["id", "编号"],
  ["name", "名称"],
]);

function truncate(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  return `${characters.slice(0, Math.max(1, limit - 3)).join("")}…（共 ${characters.length} 字符）`;
}

function displayValue(value: unknown): string {
  if (value == null || value === "") return "（空）";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) return `[${value.join(", ")}]`;
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? "（空）";
  } catch {
    return "（无法显示）";
  }
}

/** 只格式化后端已经脱敏的确认参数，不读取或推导额外数据。 */
export function confirmationParamEntries(args: unknown): ConfirmationParamEntry[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  let entries: Array<[string, unknown]>;
  try { entries = Object.entries(args); } catch { return []; }
  return entries.map(([key, value]) => ({
    label: truncate(PARAM_LABELS.get(key) ?? key, LABEL_LIMIT),
    value: truncate(displayValue(value), VALUE_LIMIT),
  }));
}
