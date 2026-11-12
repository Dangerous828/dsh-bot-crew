# 审批与外部连接执行接线

2026-11-12，源码与自动化验证记录。生产 profile 本轮未重载。

## 已实现

- 工单的 `pendingApproval` 与问题、输入、assignment 一起持久化在 Ticket 中。等待期间保留原始 Mandate 的授权强度；`DshExecutor.start` 与实际 launch 队列入口均检查审批状态，等待时不会创建 worker。
- 真实入站入口（Sources / Runtime.receive 经 Passes）处理「做吧／先别做／换个做法」。只有原请求人、同一来源会话、同一 Bot 的唯一待答问题匹配时才消费回答；多个问题时优先精确线程匹配，仍有歧义则不推测批准对象。回答进入同一 Trigger / Ticket 输入账。
- 「做吧」释放当前请求并启动／唤醒对应 assignment；「先别做」以 human/stopped 结束该票；「换个做法」继续等待新要求，新要求写入 assignment 后再次展示确认选项，确认前不开工。
- Sessions 的实际逐工具 guard（worker 与其子代理共用）调用 Runtime 的外部连接判定。读工具直接通过；写工具形成待答问题并阻止执行，等待期间也拦住改用其它工作工具的尝试。
- 外部写批准只覆盖工具名、完整参数、当前连接配置共同确定的一次调用。参数更换需再确认；消费之后再调用需再确认；当前配置已移除的连接／工具在已有会话中也失效。策略变更会撤销尚未消费的已批准外部调用。
- 审批展示中的 token/password/credential/authorization/secret/API key 字段脱敏；完整参数只参与调用指纹计算。
- `policyVersion` 纳入 approval / connections，使授权相关配置进入策略版本；外部工具每次调用仍读取最新配置。

主要文件：`backend/src/app/runtime.ts`、`sessions.ts`、`backend/src/core/model.ts`、`backend/src/executor/dsh.ts`、`backend/src/policy.ts`。

## 自动验证

`backend/tests/runtime.spec.ts` 新增 9 条集成回归：

1. 等待时无 worker、保留 explicit Mandate，批准后启动。
2. 选择先别做时停止且无 worker。
3. 修订要求与再次确认的完整链路。
4. Runtime 重建后继续等待，批准后再启动。
5. 其他发送者的文字不构成批准。
6. 读通过、写等待、批准同参一次、再次调用重问；凭据展示脱敏；等待期间其它工具受阻。
7. 批准后更换参数重问。
8. 已有 worker 配置撤权即时生效，重新添加也不会复用已失效批准。
9. 子代理使用相同实时 guard。

另有模块层分类与预算判定测试，见 `PHASE_APPROVAL_CONNECTIONS_CHECK.md`。统筹最终全套：98 个文件、1701 条用例通过；`pnpm typecheck` 退出码 0。

## 尚待运行态验证

- 尚未让独立 crew profile 加载这些源码；当前宿主的真实工具调用、重启恢复与手机三选项联调仍待在部署窗口验证。
- 外部邮箱／日历／文件供应商的真实凭据与写入未用于本轮测试，集成测试以真实执行 guard 加受控宿主验证，不代表供应商端操作已完成。
- `askWhenBudgetUsed` 仍缺真实剩余额度供应商数据；本轮没有把未知额度填成数字，也没有声称预算阈值已在生产触发。
- approval / connections 的完整管理界面与设置保存入口仍需单独核对；类型定义、判定函数和执行 guard 已接上，不据此推断管理 UI 已齐备。
