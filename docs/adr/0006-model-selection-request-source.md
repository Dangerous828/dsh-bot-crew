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

三层证据，各层证明的东西不同，不要混用。

### 第一层：宿主契约替身（2026-11-13 已落地，只证明「调了正规接口」）

`backend/tests/role-models.spec.ts` 的 `routes the actual request through the configured provider
after reclaiming a dead selection (#13)`：`selectModel` 是 mock，`selection.current` 由测试自己赋值，
`llm` 是 `resolveCallConfig: value => value` 的假服务。它证明本仓**调了** `selectModel`，
证不了宿主真会把 request 送到新 provider——mock 的语义正是待验的那一环。

### 第二层：真实宿主装配（2026-11-14 落地，证明「宿主实现确实这么走」）

新增两例，把替身换成宿主自己的实现：真实 `SessionController.selectModel`、真实
`modelSelection` 投影（`dsh-session-projection`）、真实 `installModelSelection`、真实
`LlmRuntime` 加真实 adapter 注册表。只在 **adapter 的 `stream()` 边界**（provider 真正收到请求
的那一层）记录 provider/model，断言落在那里，不落在 selection 或 `agent/request` 的返回值上。

- `routes a real request to the new provider through the host's own selection chain (#13)`：
  老会话（落盘 header 与 selection 都指向 `dead-provider`）→ 走**生产代码** `initializeRoleModel`
  → 真实组装 → 真实 `agent/request` → 真实 `llm.stream`。断言 `dispatched === ['live-provider/live-model']`。
- `would fail the real-request assertion if the switch only appended a selection`：
  同一套装配下只 `append('model/selection', …)` 不走 `selectModel`，断言
  `dispatched === ['dead-provider/dead-model']`。这一例是前一例的**负对照**：它绿，说明前一例
  的绿不是恒真。

**反向验证（两层）**：

1. 生产代码退回 `agent.session.append('model/selection', replacement)`：三个用例一起变红
   （`reclaims a resumed Session`、旧的第 3 项回归、新的真实装配例），还原后 15 例全绿。
2. 更精确的一层：生产代码照旧调 `selectModel`，只在 `selectModel` 之后把宿主
   `selectionFor(agent).current` 清成 `undefined`（模拟宿主 `selectForNextRequest` 没置上 `picked`）
   ——**只有**新例变红，报错正是
   `expected [ 'dead-provider/dead-model' ] to deeply equal [ 'live-provider/live-model' ]`，
   其余 14 例保持绿。这证明新例钉的是「request 走对」本身。

### 第三层：真实 dsh 进程（2026-11-14 落地，`34269a1` 场景复现）

**做法**：不改生产队伍（`PID 70723` / `:3082` 全程未动、未重启），另起一个真实 dsh 进程：
`dsh --profile superagent --patch <临时 overlay> --no-open`，`stateDir` 指向 `/tmp/crew-probe/state`，
`webserver` 指向 `127.0.0.1:3399`。它是同一个 bundle、同一套 provider 配置、同一份 `lib/`，
只是状态目录和端口独立。

**复现步骤**：先让主 Session 在 `magpie/workbuddy/deepseek-v4.1-flash-500k` 上真跑过几轮
（真实 `request/header`、真实 `assistant/message`），再通过真实管理接口
`PUT /orchestrator/api/settings/eval` 把主 Session 的路由改成另一个 provider
（`magpie-anthropic/kiro/claude-sonnet-5.5`），重启该进程，投一条真实消息。

**证据**（`orchestrator-9fe0750252f39c6462ca9034927496ab` 的 session log，seq 为事件序号）：

| seq | 事件 | provider/model | 说明 |
|---|---|---|---|
| 3 | `model/selection` | `magpie/workbuddy/deepseek-v4.1-flash-500k` | 老会话落盘的旧选择 |
| 20 / 55 / 82 / 111 | `request/header` | `magpie/workbuddy/…-500k` | 旧路由上的真实请求（含真实回复与 `turn/end completed`） |
| **139** | `model/selection` | **`magpie-anthropic/kiro/claude-sonnet-5.5`** | `initializeRoleModel` 判定旧选择脱管，走 `selectModel` 纠正 |
| **147** | `request/header` | **`magpie-anthropic/kiro/claude-sonnet-5.5`** | 纠正后的**第一条真实请求** |
| 148 | `request/context` | `magpie-anthropic/kiro/claude-sonnet-5.5` | 上下文窗口随新模型重建 |
| 154 / 170 | `assistant/message` | — | 新路由上真实产出（受理 + 完成回执） |

seq=139 那条不是测试里 append 的，是 `initializeRoleModel` 在真实进程里调
`ctx.sessionController.selectModel` 的结果；seq=147 的 `request/header` 也不是断言，是
`dsh-agent-loop` 在真正发起请求时写的。**这一层证明 request 走对了，不只是 selection 写对了。**

**边界（诚实交代）**：第三层跑在临时 `stateDir` + 独立端口上，不是正在服务用户的那个
生产进程（红线：不擅自重启队伍）。它用的是同一份 bundle 代码、同一套 provider 配置、
同一个 magpie 网关，所以能证明「真实进程里这条链走对了」；不能证明「生产进程当前那次
历史切换当时走对了」——那部分由下面的历史日志证据补。

### 历史真实日志（生产进程，只读核对）

把 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 全量解开做交叉核对（975 个会话）：

- 「某条 `model/selection` 之后、下一条真实 `request/header`」的配对共 1070 组，
  其中 **970 组完全一致**；100 组不一致的全部是「中间又来了更新的 selection」（last-wins，
  宿主语义正确）——**真正的「最新 selection ≠ 请求路由」为 0 例**。
- 主队伍（`state/superagent`）当前主 Session `orchestrator-bbbb4bafe8b5e5afe49748149f93df3d`
  的 `model/selection` 是 `magpie/workbuddy/deepseek-v4.1-flash-500k`，其 3 条真实
  `request/header` 全部落在同一路由上；生产 settings 的 `eval.model` / `executor.model`
  也正是这条路由。
- 另有 6 个历史 worker 会话卡在 `deepseek-account/deepseek-flash`（`34269a1` 的现场），
  那是修复前的存量，不是修复后的行为。

## 结论

`selectModel` → `picked` → `assembled` → `request` 这条链在**真实 dsh 进程**里成立：
主 Session 原 selection 指向已不可用的路由时，启动后会被纠正为配置路由，随后一条真实
请求确实打到新 provider/model。第 2 项的真源设计不需要改动，`role-models.ts` 本次零改动。

## 依据

- `HANDOFF.md` §十三 / 2026-11-13 追加段：11-13 09:33 端到端日志已有
  `request/header model=workbuddy → orchestrator_route → worker → assistant/message → turn/end completed`。
- 宿主源码：`@deepseek-ai/dsh-api-session-controller/lib/index.js`（`selectModel`、
  `selectForNextRequest`、`selectionFor`）、`@deepseek-ai/dsh-agent/lib/types/model-selection.js`
  （`installModelSelection`）、`@deepseek-ai/dsh-agent-loop/lib/index.js`（`prepareRequest`
  里 `agent/request` waterfall 与 `request/header` 落盘）。
- 本仓：`backend/src/app/role-models.ts`、`backend/tests/role-models.spec.ts`。
