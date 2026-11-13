# 模型切换最后一层：request 的模型来源只有一条真源

对应 GitHub issue #13（2026-11-13 00:54 开）。

## 背景

`34269a1`（本仓 `c8acdf4`）根治了「主 Session 绑死已下线 provider」的一层：`initializeRoleModel`
不再「有 selection 就跳过」，改用确定性判据 `selectionInConfigFamily` 判活，脱管时纠正为配置路由。
但提交信息写明真机验证时看到更深一层：`selectModel` 已写入 selection，实际 request 仍用旧 provider。
#13 要求定位覆盖点、根治、并用一条真实 request 验收。

## 定位：request 的 provider/model 从哪里来

按宿主代码逐层读下来，模型来源的链路是**单链**，不存在一个独立的「preset 覆盖点」：

1. `@deepseek-ai/dsh-api-session-controller` 的 `selectionFor(agent)` 暴露一个 `ModelSelectionRef`，
   其 `current` getter 的优先级是：
   1. `projectionState.pending`（下称 `picked`）——由 `selectForNextRequest` 写入；
   2. `agent.session.requestHeader()?.config`——已经落盘的首帧请求头；
   3. `ctx.agentDefaultModel.currentSelection()`——宿主默认模型。
2. `sessionController.selectModel(request)` 校验解析后调
   `agents.selectForNextRequest(agent, selected)`：它**同时**做两件事——
   `session.append('model/selection', selected)` 落盘，以及 `selectionFor(agent).current = selected`
   （即置 `picked`）。
3. `installModelSelection(agentCtx, selection)`（`dsh-agent/lib/types/model-selection.js`）在
   `system-prompt/assemble` 时把 `selection.current` 快照成 `selection.assembled`；随后
   `agent/request` waterfall 用 `assembled` 覆盖 provider / model / reasoningEffort。
   **读的是 `assembled`（组装时的快照），不是 `current` 的实时值。**

所以「selectModel 写进去了、request 还是旧 provider」的机制解释是：如果只往 session 里
`append('model/selection', ...)` 而不走 `selectModel`，`picked` 没被置上，`current` 就回落到
第 2 优先级——那份**早已落盘、指向死 provider 的 `request/header`**；下一次 `assemble` 把旧值
快照成 `assembled`，`agent/request` 于是继续用旧 provider。落盘事件写对了也没用，真源是 `picked`。

## 决策

**纠正脱管的 selection 必须走 `ctx.sessionController.selectModel` 这个正规接口，不许
`agent.session.append('model/selection', ...)` 代替。** `initializeRoleModel` 的纠正分支已经这么
实现（`role-models.ts` 的 `selectionInConfigFamily` 判活 + `selectModel` 切换 + `flush`），本次不
改生产代码，补的是把它钉死的证据。

主 Session 的模型真源就是这一条链（`selectModel` → `picked` → `assembled` → request），与配置
路由一致。本仓另有一套**首帧注入**监听器（`system-prompt/assemble` + `agent/request` 的
`prepend` listener），只作用于「全新会话、还没发过任何请求」的第一次请求：收到
`request/header` 或 `model/selection` 事件后 `initial` 翻 false，此后不再覆盖，交给宿主的
`installModelSelection`。它和宿主那套不冲突，因为作用窗口 disjoint；若将来要动这个边界，
须同时补一条「老会话纠正后首个 request」的回归，否则很容易把两条链并成两个真源。

## 验收与边界

- **自动化回归（本次落地）**：`backend/tests/role-models.spec.ts` 新增一例，模拟
  「老会话 + 落盘 header 指向 `deepseek-account` + 过时 selection」，`initializeRoleModel`
  纠正后断言 `selectModel` 被以 `magpie / workbuddy…` 调用，**并**在 `systemPrompt.assemble()`
  之后断言真实 `request()` 返回新 provider/model。fixture 的 `selectModel` mock 只模拟
  `selectForNextRequest` 置 `picked` 那一半——不调用它 `current` 就不变，request 就仍走死 provider。
- **反向验证（两层）**：
  1. 把生产代码退回 `append('model/selection', replacement)` 后，新例与既有
     `reclaims a resumed Session` 一起变红（2 failed），还原后 13 例全绿。
  2. 更精确的一层：生产代码仍调 `selectModel`，只让 fixture 的 mock 不再置 `picked`
     （模拟宿主 `selectForNextRequest` 那一半没生效）——新例**单独**变红，还原后变绿。
     这证明新例钉住的是「`request()` 走对」本身，不是重复旧例的「`selectModel` 被调用」。
- **仍是边界**：#13 第 3 项要「真机复现 `34269a1` 场景」。本例是宿主契约级的单元回归，
  不是在生产 dsh 进程里发一条真实模型请求。生产进程的复现需要一次重启窗口（红线：不擅自重启
  正在跑的队伍），且要有可用 provider 凭据；该项保持待验，#13 因此不关。

## 依据

- `HANDOFF.md` §十三 / 2026-11-13 追加段：11-13 09:33 端到端日志已有
  `request/header model=workbuddy → orchestrator_route → worker → assistant/message → turn/end completed`。
- 宿主源码：`@deepseek-ai/dsh-api-session-controller/lib/index.js`（`selectModel`、
  `selectForNextRequest`、`selectionFor`）、`@deepseek-ai/dsh-agent/lib/types/model-selection.js`
  （`installModelSelection`）。
- 本仓：`backend/src/app/role-models.ts`、`backend/tests/role-models.spec.ts`。
