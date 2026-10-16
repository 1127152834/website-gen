const TOOL_TEXT: Record<string, string> = {
  // Snapshot of the explicit backend assistant registry. Keep this browser-only map free of server imports.
  get_site: "查看站点概况", get_copy: "读取文案", get_policy: "读取政策页", list_products: "查看商品列表", get_product: "读取商品", list_changes: "查看变更记录",
  update_copy: "修改文案", update_policy: "修改政策页", update_announcement: "修改公告栏", update_style: "切换风格", update_product: "修改商品", revert_change: "回滚变更", schedule_revert: "设置定时恢复",
  system_overview: "查看运营总览", entity_templates_list: "列出经营主体模板", entity_template_save: "保存经营主体模板", entity_template_remove: "删除经营主体模板",
  sites_all: "查看全部站点", site_get: "查看站点详情", sites_history: "查看放弃站点历史", system_info: "查看系统版本",
  hostinger_accounts_list: "列出 Hostinger 账号", hostinger_account_domains: "查看 Hostinger 账号域名", hostinger_account_sync: "同步 Hostinger 账号", hostinger_account_remove: "移除 Hostinger 账号",
  model_presets: "查看模型厂商预设", model_providers: "查看模型厂商", model_roles: "查看模型用途", model_provider_delete: "删除模型厂商", model_provider_fetch_models: "刷新可用模型", model_role_set: "设置用途模型", model_test: "测试模型",
  domains_free: "查看空闲域名", batches_list: "列出建站批次", batch_sites: "查看批次站点", batch_create: "创建建站批次",
  site_steps: "查看站点步骤", site_events: "查看站点日志", site_qa_report: "查看站点复核报告", sites_ready_list: "列出已建站点", site_launch: "站点上线", site_retry: "重试建站任务", cj_status: "查看 CJ 配置状态",
  site_mail_status: "检查站点邮箱", site_mail_fix: "修复站点邮箱", mail_default_password_status: "查看默认邮箱密码状态", mailboxes_list: "列出邮箱", mailboxes_sync: "同步邮箱", mail_folders: "列出邮箱文件夹", mail_messages: "查询邮件", mail_message: "读取邮件", mail_credential_reset: "重置邮箱密码", mail_monitor_set: "设置邮件监听", mail_seen_set: "设置邮件已读状态", mail_message_trash: "把邮件移入垃圾箱", mailbox_delete: "永久删除邮箱", mail_send: "发送邮件",
  smtp_status: "查看交易邮件状态", smtp_reset_password: "重置交易邮箱密码", smtp_test: "发送交易邮件测试", smtp_disable: "关闭交易邮件",
  site_changes_list: "查看站点变更", site_change_revert: "回滚站点变更", site_change_cancel_schedule: "取消定时恢复", site_abandon_start: "启动站点放弃流程", site_abandon_status: "查看站点放弃状态", site_abandon_retry: "重试站点放弃任务",
  grist_settings_status: "查看 Grist 配置状态", grist_rpc_list_orgs: "列出 Grist 团队站点", grist_rpc_list_workspaces: "列出 Grist 工作空间", grist_rpc_list_docs: "列出 Grist 文档", grist_rpc_get_doc: "查看 Grist 文档", grist_rpc_get_tables: "列出 Grist 数据表", grist_rpc_get_columns: "列出 Grist 表列", grist_rpc_list_records: "查询 Grist 记录", grist_rpc_add_records: "新增 Grist 记录", grist_rpc_update_records: "更新 Grist 记录",
  read_user_manual: "查阅操作手册", admin_list_users: "列出所有用户", admin_query_user_data: "跨用户只读查询",
  grist_help: "查看 Grist 工具说明", grist_get_user_profile: "查看 Grist 用户资料", grist_list_orgs: "列出 Grist 团队站点", grist_list_workspaces: "列出 Grist 工作空间", grist_list_docs: "列出 Grist 文档", grist_get_doc_info: "查看 Grist 文档信息", grist_get_tables: "列出 Grist 数据表", grist_get_table_columns: "列出 Grist 表列", grist_list_records: "读取 Grist 记录", grist_query_document: "查询 Grist 文档", grist_list_snapshots: "列出 Grist 文档快照", grist_list_attachments: "列出 Grist 附件", grist_add_records: "新增 Grist 记录", grist_update_records: "更新 Grist 记录", grist_remove_records: "删除 Grist 记录", grist_create_doc: "新建 Grist 文档", grist_create_table: "新建 Grist 数据表", grist_add_table_column: "新增 Grist 表列", grist_update_table_column: "更新 Grist 表列", grist_rename_table: "重命名 Grist 数据表", grist_remove_table: "删除 Grist 数据表", grist_remove_table_column: "删除 Grist 表列",
};

const PREFIX_TEXT: Record<string, string> = {
  system: "系统", entity: "经营主体模板", hostinger: "Hostinger", accounts: "Hostinger 账号", batch: "建站批次", batches: "建站批次", site: "站点", sites: "站点", domains: "域名", cj: "CJ", mail: "邮箱", mailboxes: "邮箱", smtp: "交易邮件", changes: "变更", grist: "Grist 表格", model: "模型", models: "模型", admin: "管理员查询",
};

const WORD_TEXT: Record<string, string> = {
  overview: "总览", info: "信息", list: "列表", all: "全部", get: "查看", status: "状态", history: "历史", save: "保存", remove: "移除", delete: "删除", sync: "同步", free: "空闲", create: "创建", steps: "步骤", events: "日志", qa: "复核报告", report: "报告", ready: "已完成", launch: "上线", retry: "重试", fix: "修复", folders: "文件夹", messages: "邮件列表", message: "邮件", reset: "重置", monitor: "监听", seen: "已读状态", trash: "移入垃圾箱", send: "发送", disable: "关闭", revert: "回滚", cancel: "取消", schedule: "定时恢复", start: "启动", provider: "厂商", providers: "厂商", roles: "用途", role: "用途", test: "测试", settings: "设置", records: "记录", tables: "数据表", columns: "列", docs: "文档", orgs: "团队站点", workspaces: "工作空间", user: "用户", data: "数据", manual: "操作手册", query: "查询",
};

export function toolDisplayName(name: string): string {
  if (TOOL_TEXT[name]) return TOOL_TEXT[name];
  const normalized = name.replace(/[.:]/g, "_");
  if (TOOL_TEXT[normalized]) return TOOL_TEXT[normalized];
  const [prefix, ...rest] = normalized.split("_");
  if (PREFIX_TEXT[prefix] && rest.length > 0) return `${PREFIX_TEXT[prefix]}：${rest.map((word) => WORD_TEXT[word] ?? word).join(" ")}`;
  return name;
}
