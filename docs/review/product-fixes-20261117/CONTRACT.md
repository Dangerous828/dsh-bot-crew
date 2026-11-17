# 本轮修复协作契约

全部实现当前八项审查问题，保留现有 dirty 和协议兼容；不提交 Git，不操作实体手机。Root 独占构建/生产部署/签名发布与主文档。

## 文件归属

- task14 审批：runtime.ts、approval.ts、connections.ts、core/model.ts、integrations/messages-mcp/server.ts 与对应审批/runtime测试。
- task15 状态：mobile-http.ts、sessions.ts、新 activity.ts、outbox.ts、sources/mobile.ts/team.ts、tools/mobileq/mobilegw 与对应状态/队列测试。勿改 runtime.ts；将必要接线片段发 Root，待 task14 冻结后合并。
- task16 Android：所有 Android Kotlin 与 tests。勿跑 assemble；只用 JDK21 unit。Root 统一生成最终 APK。
- 冲突前先发消息，不靠格式化器覆盖他人修改；不批量改源文件格式。

## 审批投影（task14 → task15 → task16）

保留 question/options/attention_id，增量提供 `tasks[].approval`（可选），从 `ticket.attention.presentation` 只读映射：

```
{ kind: "connection" | "task", action: "发送消息", target: "当前对话", preview: "真实换行的内容", details: "脱敏工具详情" }
```

字段均可选，消费者缺字段保持旧协议。question 本身也必须人读可懂，不把 stringify(args) 当正文。预览按字段解码，正文不做全局反转义。细节默认折叠。options.label 必须明确后果；取消连接操作与停止整票区别处理，保留旧卡/签名/跨会话/发送者身份约束。bot_id 可选时绑定本票身份，不能仅放宽检查而导致实际发送者不同。

## 状态协议（task15 → task16）

- 网关 agent 条目新增可选 `reply_kind: "acknowledgement" | "reply" | "notice"`；新写入必须从出站类型持久化，历史缺类型不猜文本。缺字段保持老版本兼容。
- 用户 timeline item 保留 `request_state`，可追加 `ticket_ref` 与 `activity`。消息回执与执行活动正交，ack 不当成最终答复。
- 增量轻量 `GET /api/mobile/activity?session_id=...` 返回：

```
{ session_id, session_api: 1, state: "live", at: ISO,
  items: [{ request_id, request_state, ticket_ref?, activity?: {
    kind: "evaluating" | "model" | "tool" | "retrying" | "waiting_for_person" | "idle" | "ended" | "unknown",
    since?: ISO, at?: ISO, label?: "读取文件"
  }}] }
```

`at` 为快照新鲜度；activity.since/at 为当前活动起点/事件时间。没有原生事件证据不能由最后日志猜 model/tool，缺证据可用 evaluating/unknown + 真实排队/工单阶段。评估还没生成 ticket 时也要按 trigger/request 关联。多个会话/多个 Bot 不串到全局 busy；事件结束/工具结束/模型重试结束要收口，落后事件不复活终态。

任务15须将 event-kind 可用性与实际接线实现发给 Root，不能只写假 fixture 使测试通过。轻量 endpoint 经现有鉴权与会话能力位，不能加载全量 timeline 后叫轻量。

Android 正常前台：有活跃/未确定发送时轻量活动约1秒刷新，完整时间线保留较低频；无活跃任务/后台降频或停止；不加无必要依赖。失败显示状态暂未同步，保留上次事实且标示陈旧，不当作重新未发送。不需要持续事件流改变整个转发链。

## Android 恢复与交互

草稿按会话保存正文和收件人；未确定发送在 POST 前持久化完整 envelope（正文/mentions/接收者/request_id/session）。恢复用同 id 对账/重试。修改新正文可生成新意图但不把旧不确定发送丢掉。明确成功才清对应记录；迟到回调不擦新草稿。失败提示按请求归属，成功 B 不被 A 的错误盖住。全局暂停按钮明确暂停全队，当前任务停止使用现有独立 stop/takeover 语义并明确后果；多待决定给总数和逐项入口，不平铺巨型审批。

## 验证

成员为真实分支/持久化/边界写有意义测试并运行目标回归；禁止重置 dirty。Root 独立集成测试、隔离 AVD 真实交互与下一版本 OTA，保存证据，不把未跑实机说成实机通过。
