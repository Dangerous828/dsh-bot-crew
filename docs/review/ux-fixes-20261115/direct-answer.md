# 直接回复路由

日期：2026-11-16，Asia/Shanghai。

## 行为

- `orchestrator_route` 接受 `kind: "answer"` 与 `text`，通过现有 `Engine.reply({ purpose: "answer" })` 回复来源消息。
- 在同一 Store 事务中结束候选并登记回复；回复创建失败时保留候选，允许重试。
- 复用 `followupOwners` 拒绝仍由 Ticket worker 负责的跟进消息。
- 成功后走现有 outbox / channel 发送流程，并向调用方返回发送状态。direct answer 将 `@handoff` 按正文发送；其它回复沿用原有 handoff 解析默认值。候选卡、dispatch 与 explicit-candidate 评估提示列出直接回复动作；路由 API 文档同步列出此动作。
- 决定使用结构化 reason code `answeredDirectly`（模板为「已直接回复」）。outbox 尚未送达时，手机状态显示 `waiting`；实际回复关联到消息后显示 `replied`。
- 拒收列表跳过 `answeredDirectly` 和已有 `reply_to` 的消息。拒收列表与 `ticketRefs` 共用 `requestDecisionRow`，只接受当前 session 的 team/mobile Thread key。

## 回归覆盖

- 普通问候收到直接回复，候选结束；没有 Ticket、worker 或接受确认。
- worker 持有的跟进消息保持 worker 路由。
- 回复登记失败时回滚候选处置。
- `text` 长度限制出现在工具 schema 描述中；explicit-candidate 评估提示与回归断言包含 `answer` 路由。
- `@handoff` 正文按字面发送；同一候选后续的 route 项被拒绝；发送状态只归属实际排入回复的项。
- `answeredDirectly` 不进拒收列表；outbox 待送达状态为 `waiting`，实际回复为 `replied`；已有回复不再标记拒收。
- `github:72` 或其它非 team/mobile 后缀不会串联到手机请求或 `ticket_ref`。

## 验证

- `pnpm exec vitest run tests/tools.spec.ts tests/mobile-http.spec.ts tests/mobile-work.spec.ts`：139 项通过。
- `pnpm typecheck`：通过。
- HMR 发布由 lead 收尾。
