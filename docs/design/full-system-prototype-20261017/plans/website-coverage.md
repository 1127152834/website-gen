# 网站模块覆盖盘点

日期：10/17/2026。仅文档盘点，不生成图、不改既有设计或应用代码、不调用外部服务。

## 当前结论

- 固定范围：**W01–W12 共12个主页面/子视图，O-W01–O-W14 共14个覆盖层，合计26项**，不是26条路由。
- 已有主态图片 **12/12**：W02用用户所选方案3、W04用所选方案1、W03原图不动；根任务本轮已生成W01、W05–W12。这里只核对文件位置，不代替其独立视觉审阅。
- 待补覆盖层主态 **14/14**。主态存在不等于其错误、未知、加载等状态已出图；未查看的新图不自动宣称通过。
- 精确机器清单见 [website-coverage.json](F:/projects/website-gen/docs/design/full-system-prototype-20261017/plans/website-coverage.json)。每项含id/title/kind/purpose/existing_image/required_content/actions/states/source_refs，并区分现有能力与新增整合设计。

## 优先顺序

1. **O-W03 → O-W04 → O-W05 → O-W06**：启动前真实问题、失败重试、上线前QA、步骤日志。
2. **O-W11 → O-W12**：网站修复/复核执行与证据。
3. **O-W02 → O-W13 → O-W14 → O-W07 → O-W08 → O-W09 → O-W10**：移出、邮箱/发信、对话、变更恢复。
4. **O-W01**：保留既有CSV兼容入口，但客户逐项映射未定细节标pending，不恢复一企多站，不自动创建客户。

## 页面清单

| ID | 名称 | 当前主态 | 能力性质 |
| --- | --- | --- | --- |
| W01 | 建站总览 | [已有PNG](F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/W01-v1.png) | existing_function_ui_optimization |
| W02 | 新建网站：客户与经营资料 | [已有PNG](F:/projects/website-gen/docs/design/group-03-website-management/W02-W04-layout-options-20261017/W02-option-03.png) | existing_wizard_plus_customer_integration_design |
| W03 | 新建网站：站点配置 | [已有PNG](F:/projects/website-gen/docs/design/group-03-website-management/W03-site-configuration-v1.png) | existing_configuration_plus_customer_integration_design |
| W04 | 新建网站：确认启动 | [已有PNG](F:/projects/website-gen/docs/design/group-03-website-management/W02-W04-layout-options-20261017/W04-option-01.png) | existing_submit_plus_customer_integration_design |
| W05 | 批次列表 | [已有PNG](F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/W05-v1.png) | existing_function_plus_customer_labels_design |
| W06 | 批次详情 | [已有PNG](F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/W06-v1.png) | existing_function_plus_customer_labels_design |
| W07 | 站点列表 | [已有PNG](F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/W07-v1.png) | existing_function_plus_customer_labels_design |
| W08 | 站点详情：概况 | [已有PNG](F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/W08-v1.png) | existing_function_plus_customer_context_design |
| W09 | 站点详情：AI对话 | [已有PNG](F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/W09-v1.png) | existing_function_ui_optimization |
| W10 | 站点详情：邮箱与交易发信 | [已有PNG](F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/W10-v1.png) | existing_function_plus_inbox_navigation_design |
| W11 | 站点详情：变更记录 | [已有PNG](F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/W11-v1.png) | existing_function_plus_actor_attribution_design |
| W12 | 站点详情：网站复核 | [已有PNG](F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/W12-v1.png) | existing_function_ui_optimization |
| O-W01 | CSV站点配置导入结果 | 待绘 | existing_import_with_pending_customer_mapping_design |
| O-W02 | 移出本次建站项确认 | 待绘 | existing_remove_action_ui_optimization |
| O-W03 | 启动前条件提示 | 待绘 | existing_validation_plus_customer_prerequisite_design |
| O-W04 | 重试建站确认与反馈 | 待绘 | existing_retry_action_ui_optimization |
| O-W05 | 上线前网站复核提示 | 待绘 | existing_launch_gate_ui_optimization |
| O-W06 | 运行步骤与日志详情 | 待绘 | existing_execution_detail_ui_optimization |
| O-W07 | 站点新对话确认 | 待绘 | existing_chat_reset_confirmation |
| O-W08 | 网站变更详情 | 待绘 | new_detail_presentation_on_existing_change_records |
| O-W09 | 整体恢复确认 | 待绘 | existing_rollback_confirmation_ui_optimization |
| O-W10 | 取消定时恢复确认 | 待绘 | existing_scheduled_restore_cancel_confirmation |
| O-W11 | 网站修复与复核运行面板 | 待绘 | existing_qa_run_presentation |
| O-W12 | 网站复核证据放大 | 待绘 | existing_qa_evidence_view |
| O-W13 | 邮箱修复与SMTP启用确认 | 待绘 | existing_email_configuration_actions_ui_optimization |
| O-W14 | 交易测试邮件发送 | 待绘 | existing_transactional_test_mail_action |

## 必须守住的跨页规则

- 单客户和多客户用同一流程；每客户、企业、域名、商业邮箱保持同一建站项归属，不能共享整批企业资料。
- W02纵向工作表、W04纵向完整清单随客户数扩展，不把三位DEMO当上限。总数和启动目标是完整已选集合，不是当前可见、搜索或分页中的客户。
- 切换、滚动、筛选、分页保留各项输入；完整集合校验必须定位隐藏项冲突，不能只检查可见行或静默跳过问题客户。
- 企业资料/EIN就绪是客户新建站前提；个人电话和企业地址来源正确；EIN/SSN/证件/银行数据不因建站而公开。
- 客户当前档案、本次配置、线上实际内容分开；配置编辑不自动回写档案，旧网关定稿不变。
- 处理/运输时效是订单履约工作日，不是生成网站耗时。W03原Jamie示例60件、USD25–120、处理2–4/运输5–10保持。
- 建站生成、网站QA、上线、客户网关获批各自独立。未知结果先核验，不重复创建网站或自动重复发信。
- 现有放弃网站会影响邮箱/续费，不能复用客户删除；原客户删除要求域名保留解绑、邮箱不动。
- 无客户负责人；具体操作归因和新增客户关联只能标设计整合，不能冒充底层已实现。AI对话直接修改网站的事实要明确。

## 真正关键补充态（归属原ID，不增加主界面编号）

- W02：客户选择及就绪/已建站限制、多客户滚动/分页与完整集合。
- W03：资源读取失败/无资源/占用冲突、参数错误与输入保留。
- W04：未勾选、提交中、提交失败、提交结果未知和完整集合问题定位。
- W06/W08：部分成功、失败/等待、生成完成仍维护、上线失败或未知。
- W10：缺凭据/拒绝/网络错误、修复部分成功、测试发信未知。
- W11/W12：恢复冲突、复核读取失败、需人工处理和旧报告失效。

这些仅是待画状态队列，不构成全部已绘或交互通过结论。通用未保存/并发/权限等复用客户模块既有设计，不重复创造功能。

## 依据与回退

以已确认范围修订04、当前v2讨论稿、选型决定及原W/O-W职责为依据；较早清单中的一企多站、客户负责人、手工无证件建档、独立材料页不能复活。源码证据只复用既有快照，未重新探索应用。

本代理只新增本文件和同名JSON，未覆盖旧文件。若不采纳，可保留为盘点快照；无应用或业务数据回滚。

