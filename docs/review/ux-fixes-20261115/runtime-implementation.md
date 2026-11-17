# Runtime 实施记录

## 内部消息回复

`Runtime.guardConnection` 仅在 `messages.send_message` 的目标精确命中当前工单来源时免除例行审批：来源消息须属于 `mobile` 或 `team`，目标会话与来源会话相同，目标消息号一致，且 `bot_id`（调用方提供时）相同。

同票正式后续消息只有在 `ticket.inputs` 中记录为人工 `trigger`、非 context，且 `reached(ticket, trigger, ..., false)` 确认已到达当前工单时才可直接回复。旁支、context-only、其他会话、另一张工单的历史消息继续走 connection 审批。

隔离 canary 集成用例覆盖来源消息回复与同票正式后续各新增一条回复；旁支、context-only、他票历史 `m19`、跨会话尝试都保持审批等待，reply 行数不变。

## 请求与 worker 状态

`withRequestStates` 从回复、当前决策和工单阶段投影请求状态。只有 `read_at`、没有当前决策或关联工单的消息投影为 `unknown`；空 `read_at` 仍表示 `queued`。独立回归覆盖旧已读消息，状态保持 `unknown`。移动端 timeline 响应合同包含 `queued_state`，完整 `mobile-http.spec.ts` 覆盖空队列对应的 `live`。

`agentTree` 的工单根状态来自 `ticketStage`，子代理状态来自 DSH session registry 的状态；树继续保留工单根节点和其子节点。`AgentRegistry.get/list` 使用 DSH 的 `Agent` 类型，父链从 `agent.session.header.parentSession` 遍历，列表以 `agent.id` 作为 session registry key。根 worker 存在时保持为树根；完整路由与根节点回归使用真实 Agent 对象形状。

## 验证

- `pnpm typecheck`：通过。
- `pnpm exec vitest run tests/mobile-work.spec.ts`：33 项通过。

## 坏票收敛步骤

目标工单：`19467b31071433bf3e5e5c552602765c`。当前只按既有检查记录识别：来源 `main/71`，已回复 `r55`，错误待审批目标 `m19`。实际处置由 lead 在新 SQLite 备份后执行。

1. 备份后只读重查该工单，确认 origin、现存回复与 `pendingApproval` 参数仍分别对应 `main/71`、`r55`、`m19`；记录 mobileq 的 `messages`、`replies` 行数基线。
2. 调用现有路由 `POST /orchestrator/api/tickets/19467b31071433bf3e5e5c552602765c/stop`，不批准旧参数，也不重发消息。
3. 只读回查工单已停止；确认没有新增发往 `m19` 的回复，并比较 `messages`、`replies` 行数与基线一致。

本分支未执行停票、审批、重发或生产库写入。
