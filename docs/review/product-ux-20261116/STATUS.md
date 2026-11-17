# 端到端状态事实审查：从「消息收据」到「执行活动」

范围：Android `CrewWire.kt` / `CrewClient.kt` / `CrewUi.kt` → 消息面 `backend/src/app/mobile-http.ts` → 网关 `backend/tools/mobilegw` / `mobileq` → 宿主 `runtime.ts` / `work.ts` / `screen.ts` / `retry-health.ts` / `core/*`。

证据级别标注（每节头部）：
- **[静态]** 只读源码与测试，未运行。
- **[隔离]** 纯函数在 Node 里直接调用（`withRequestStates` / `screenOf`），无网络、无生产数据。
- **[未做]** 本轮没有实机观察、没有手机操作、没有发新消息、没有生产写操作。任何「手机上看得到 X」的说法都不在本报告背书范围内。

用户观察「说完话之后、从待处理到已回复中间，是不是应该把 LLM 那边的状态也发过来」是对的。
根因不是「少画一个转圈」，而是**消息面把「回执」和「执行活动」压成了同一个字段 `request_state`，并且这个字段的输入里根本没有模型/工具信号**。

---

## 1. 今天真实存在的状态：有哪些、什么字段、多久刷一次

**[静态]**

### 1.1 消息面下发的取值域

`backend/src/app/mobile-http.ts:1370` 声明了 10 个值：

```
'accepted' | 'queued' | 'evaluating' | 'waiting' | 'processing'
| 'waiting_for_person' | 'replied' | 'finished' | 'declined' | 'unknown'
```

真正会被写出的分支（`withRequestStates`，1464–1494；`requestStateForTicket`，1496–1516）：

| 取值 | 唯一来源 | 判据 |
|---|---|---|
| `declined` | mobile-http.ts:1479 | 消息被撤回 |
| `unknown` | 1480 / 1491 / 1512 / 1514 | 无 `id`；`read_at` 非空但无后续证据；fallback；抛错 |
| `replied` | 1481 | **任一** `role==='agent'` 且 `reply_to===本条 id` 的条目存在 |
| `finished` | 1487 / 1497 / 1501 | 决策为 stop；或票已结束 |
| `waiting_for_person` | 1500 / 1508–1510 | 票阶段 person（等交付/等答复/待复核/blocked/failed） |
| `waiting` | 1486 / 1502 / 1506–1507 / 1511 | `answeredDirectly` 待交付；票阶段 idle；assignment 结束或 report=waiting；已 idle 未再投递 |
| `queued` | 1505 / 1492 | assignment `pending`；或 `read_at === ''` |
| `processing` | 1512 | `assignment.state === 'running'` 的**兜底**分支 |
| `accepted` | 1490 / 1504 | 只在该行**读不到票**时的 fallback（`byTicket.get` miss / `latestAssignment` 为空） |
| `evaluating` | — | 全仓无任何分支产出该值（`grep 'evaluating'` 只命中类型定义与不相关的 threads/records 视图） |

### 1.2 客户端映射与渲染

- `app/.../CrewWire.kt:579-588` `RequestStateCopy.label`：`accepted/null/""` → 「已发送」，`queued/waiting` → 「待处理」，`evaluating/processing` → 「处理中」，`waiting_for_person` → 「等你答复」，`replied` → 「已回复」，`finished` → 「已完成」，`declined` → 「未接收」，**其余一律 → 「已发送」**。
- 字段载体：`CrewWire.kt:13-30` `Message.requestState`（`String?`，未知值原样保留）。
- 渲染位置：`CrewUi.kt:4065-4077`，用户消息气泡下方一行 10.5sp 灰字。

### 1.3 刷新频率

`CrewUi.kt:548-575`：`while (true) { refresh(); …; delay(6_000) }`。一次完整 `GET /api/mobile/timeline`。
子代理树 `CrewUi.kt:3437-3459` 随 `generation`（时间线内容**真的变了**才 +1，见 362-364）重读一次 `/api/mobile/agents`。
工作区画面 `CrewUi.kt:2164` 注释 / `:2171` 首读 / `:2183` `delay(5_000)` 重读。

**结论**：用户看到的状态粒度 = 6 秒 × 状态机离散跳变。中间过程没有任何一次更新，因为下发字段里没有过程。

---

## 2. 哪一层丢了 LLM / 工具活动信号

**[静态]**

三条链路完整存在，但全部止步于工单，没有一条接到用户消息气泡上。

### 2.1 会话事件层（真实、原生、含工具与模型）

`backend/src/app/screen.ts:123` `readEvent` 认这些原生事件：
`tool/call`（→ 命令行）、`tool/result`（→ 输出）、`assistant/message`（→ 说过的话）、`turn/start|end`、`command/run|done`、`job/registered`、`todo/write`、`step/start`、`llm/retry`（含 `provider` 与第几次 `retry`）。

`screen.ts:183` `activityOf` 把它推成 `running | thinking | waiting | idle | ended`。
注意：**这是推断，不是原生状态**——它用「阶段机 + 最后一条可显示日志」推的。`last.kind === 'said'` → `thinking` 只是因为最后一句是回话，并不代表模型此刻在生成。

`runtime.ts:527-563` `screen()`：先 `ctx.sessionController.inspect(workerSessionId)`，读不到再翻持久化存档，还读不到就返回 `unavailable` + 真因。

### 2.2 模型预算重试（真正的原生 LLM 事件）

`backend/src/app/retry-health.ts:26-91` `RetryHealth` 消费原生 `llm/retry`（`budget_exceeded` 判据）、`step/start`、`assistant/message`、`turn/start|end`，产出 `{provider, attempts, since, lastAt}`。
出口只有两个：`sessions.ts:245` `modelRetry()` → `resources.ts:126/259`（工单卡与 status 卡）与 `tools/main.ts` 的 status 列表；另外 `sessions.ts:250` 把它写进 `ctx.health` 的 **error detail 字符串**。

**`timeline` 没有带它**：`mobile-http.ts:1291-1355` 的 timeline 响应体里没有任何 `model_retry` 字段。

### 2.3 传输层

`mobile-http.ts:1220` 对网关是 `await upstream.json()` 整包；全仓无 `text/event-stream` / SSE / `delta` 实现（grep 零命中）。
`mobilegw` 只有 `GET /timeline`、`POST /send|/claim|/withdraw`（`tools/mobilegw:235-360`）。

**准确表述**：当前聊天未传输流式增量或模型活动事件。HTTP 通道本身存在且可承载 `application/json`，缺的是**协议里没有这个字段/事件**，以及后端不产生端到端增量。

### 2.4 丢在哪一层

| 信号 | 生产者 | 终点 | 用户消息气泡 |
|---|---|---|---|
| 工具调用/输出 | `screen.ts:123` | `/api/mobile/screen?ticket=`（CrewUi 工作区页，5s） | ✗ 无关联 |
| 模型 in-flight | `screen.ts:183` 推断 | 同上 | ✗ 无关联 |
| 模型预算重试（原生） | `retry-health.ts:26` | 工单卡 `model_retry` / `ctx.health` | ✗ 完全不下发到 timeline |
| 内部任务状态 | `work.ts:agentTree` | `/api/mobile/agents`（工单卡内） | ✗ 需人点进卡片 |

**根因**：气泡上的 `request_state` 由 `withRequestStates` 从**队列行 + 决策 + 票**合成，这三者的时间分辨率是「秒级的持久事实」，而模型活动是**秒级以下的易失事件**。两者从来没有一个共同的关联键下发（`ticket_ref` 只贴在 `role==='agent'` 条目上，见 §3 与 `mobile-http.ts:241`），所以单一 `request_state` 字段无论怎么加词都表达不了「它此刻在不在动」。

---

## 3. `replied` 会把「收到」判成「答完」——最高优先级

**[静态] + [隔离]**（`STATE_PROBE.json` 的 `anyLinkedAgentMessage → replied` 与此一致）

### 3.1 回执在核心层是有身份的，落到时间线时身份被抹掉

- `backend/src/core/ports.ts:72`：`OutboundMessage.kind = 'acknowledgement' | 'reply' | 'notice'`。
- `core/replies.ts:40-44` `acknowledgeAccepted`：`outbox.send({ id: key('ack', trigger.id), …, kind: 'acknowledgement', ticketId })`——**接受即发的回执，独立于真回复**。
- `core/tickets.ts:53`：accept 决定创建工单时，`if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(...)`。
- `app/outbox.ts:33-54` `send`：`kind` 只用于 `splitHandoff`（仅 `kind==='reply'`）与飞书 IM 长度校验，**写入 receipt 后不再保留可读的类型差异**。

### 3.2 网关只有「回话」，没有「回执」

- `app/sources/mobile.ts:208-218` `sendMobile`：`mobileq reply --conversation --to --key --text`。**不传 `--bot`，也不传任何 kind**。
- `tools/mobileq:53-61` 与 `tools/mobilegw:112-113`：`replies` 表列只有 `id, conversation, to_msg, rkey, text, at, bot_id`。**没有 kind 列**。
- `tools/mobilegw:265-272`：每条 reply 一律产出 `{role:'agent', text, at, id:'r<id>', reply_to:'m<to_msg>'}`。

### 3.3 于是判据退化成「有没有一条挂在它下面的 agent 消息」

`mobile-http.ts:1467`：
```js
const replies = new Set(items.filter(i => i.role === 'agent').map(i => i.reply_to).filter(Boolean))
```
`mobile-http.ts:1481`：
```js
if (replies.has(item.id)) return { ...item, request_state: 'replied' }
```

`replies.has` 在 **1481**，早于 `read_at`（1491–1492）、票阶段（1489 → `requestStateForTicket`）、idle/assignment 判定。

### 3.4 最小触发条件（可复现）

1. 用户发一条被 accept 的消息（`threadKey = mobile:<sid>:<row>`）。
2. accept 带 `acknowledgement` 文本 → `acknowledgeAccepted` 入 outbox，`sendMobile` 写进 `replies`，`to_msg = N`。
3. 下一次 6s 轮询：时间线里出现 `{role:'agent', reply_to:'mN'}`。
4. `replies` 集合含 `'mN'` → 该用户消息立刻 `request_state='replied'` → 气泡「已回复」。

**而此刻 worker 可能连 `launch` 都还没跑完**（`tickets.ts:54` 的 `executor.start` 在 ack 之后）。

**因此「中间那段」不是没画，是被一次回执提前终止了。** 用户想问的「LLM 状态」在这条链上永远没有展示窗口。

### 3.5 反面情况：真回复到了气泡还停在「已发送」

**[静态]** 不是「待处理」，是「已发送」——因为 `null` 与 `unknown` 都映到这一格（`CrewWire.kt:580` 与 `CrewWire.kt:587`）。

最小触发：`replies.to_msg` 为 NULL。此时 `mobilegw:270-271` 只输出 `role/text/at/id`，没有 `reply_to` →
`answered`（1446/1467）与 `queuedRequests`（1450）都认为「没答过」→ 1481 不成立 →
`read_at` 非空（1491）→ `unknown` → 客户端「已发送」。**同一屏上完整答复已经在了，气泡仍写「已发送」。**

`mobileq` 侧 `reply_target`（`tools/mobileq:132-173`，`cmd_reply` 在 `174`）会拒绝非法 `--to`，所以这条路径来自**上游没给 `--to`** 或 `to_msg` 写空，不是用户侧输入错误。
两个已知的写入方都必传 `--to`：`sources/mobile.ts:210-213`（缺 `conversation`/`to` 直接 throw）与 `sources/team.ts:322-323`。因此今天这条路径的**唯一现实入口是历史行/手工写库**，不是当前代码的新写入。它的价值在于验收：一旦某天有写入方漏了 `--to`，症状就是「答复已在屏上、气泡写已发送」，而这条症状目前没有任何告警。

---

## 4. 产品状态模型：把「收据」和「执行活动」分开

**[静态]** 现状只有一个字段承载两件事，这是所有歧义的共同根因。建议的模型（**不改代码，仅作验收基线**）：

### 4.1 两个正交维度

**A. 收据（durable，队列/工单事实，可持久化、可回溯）**

| 值 | 含义 | 权威来源（已存在） |
|---|---|---|
| `sent` | 已进队列，队伍未取走 | `messages.read_at === ''` + 无 reply（`mobile-http.ts:1450`） |
| `picked_up` | 队伍已读走（`pull` / `claim` 写过 `read_at`） | `messages.read_at` 非空（`mobilegw:255` 注释与列定义） |
| `judged` | 路由已决定（accept / attach / ignore / stop） | `decisions` 表（`store-read.ts:76`） |
| `acknowledged` | 工单已回执（**明确不再等同 answered**） | `kind:'acknowledgement'` 的 receipt（`replies.ts:44`） |
| `answered` | 有**非回执**回话挂在它下面 | `kind:'reply'` 的 receipt |
| `declined` | 判定不动手 | `kind:'ignore'` 且无 `answeredDirectly`（`mobile-http.ts:199`） |
| `closed` | 票已结束（完成/合并/放弃/停止） | `ticket.ended`（`stage.ts:10`） |

补充：`disposition.acked` 已经是一个**现成但没被用**的收据信号。`core/part.ts:50-54` `takeUp` 在回执（`replies.ts:61`）与 worker 报告答复（`assignments.ts:140`）两处把 `acked: [ticketId]` 写进 `disposition` 表（`store.ts:215-216`），持久化、可回溯；但时间线一侧从不读它（`mobile-http.ts` 全文无 `disposition`）。它正好能表达「这条消息被哪张票接住了」，而这是今天 `request_state` 想表达却只能靠「有没有任意 agent 回话」去猜的那件事。

**B. 执行活动（volatile，随时可变，不可持久化为历史）**

| 值 | 含义 | 权威来源（已存在但未下发） |
|---|---|---|
| `working` | worker 在跑工具 | `screen.ts:123` `tool/call` / `tool/result` |
| `thinking` | 在生成/推理（**推断**） | `screen.ts:183` `last.kind==='said'` |
| `retrying` | 模型预算重试中，第 N 次 | `retry-health.ts:26`（原生 `llm/retry`） |
| `blocked` | 等人（问题/交付/复核） | `stage.ts:11-18` |
| `idle` | 手上空着 | `stage.ts:19` |
| `ended` | 结束 | `stage.ts:10` |

### 4.2 法规

- **不显示百分比**：现有 `progressOf`（`CrewWire.kt:656-661`）只认 `todo/write` 的计划分母，`mobile-http.ts:1317-1319` 在 `plan.total === 0` 时整块不下发 —— 这条纪律继续有效。
- **不公开推理正文**：`screen.ts:123` 只把 `assistant/message` 的文本作为「说了什么」一行，不区分思维链；`maskSecrets`（`screen.ts:99`）已掩码凭据。活动维度只允许输出上表 6 个词，不带任何模型原文。
- **活动不写历史**：活动维度只对「当前未结束的那条」有意义，落盘即为陈旧。因此它**不能**进 `messages` / `replies` 表。
- **收据必须可回溯**：`A` 维度必须来自持久事实（`read_at` / `replies` / `decisions` / `ticket.ended`），重启后仍成立。

### 4.3 与现状的差异（这是用户感受到的缺口）

现状把 `A.acknowledged` 直接报成 `replied`（=`A.answered`），导致：
1. 窗口被提前关闭，`B` 维度本该出现的时段被吃掉；
2. `B` 维度完全没有下发通道，所以即使不提前关，也没有词可说。

---

## 5. 高价值问题与验收条件（6 条）

每条给：影响 → 最小触发 → **可直接写成断言的验收条件**。

### P0-1 回执（acknowledgement）被当作「已回复」

- 影响：用户看到「已回复」时 LLM 可能还没开始；此后无论卡多久、重试多少次，气泡都不会再变。这是用户原话指向的那一格。
- 触发：accept 带 `acknowledgement`，见 §3.4。
- 验收：
  - 给定 `kind:'acknowledgement'` 的回执挂在 `mN` 下、无 `kind:'reply'` 的回话，`withRequestStates(...)[mN].request_state !== 'replied'`。
  - 给定同样场景 + 一条 `kind:'reply'` 的回话，`=== 'replied'`（或新模型中 `answered`）。
  - `mobilegw` timeline 的 agent 条目必须能被区分出「回执」与「答复」两者之一，且该区分来自持久列而非文本启发。

### P0-2 消息面判据只看 `role/reply_to`，没有任何类型位

- 影响：P0-1 的机制性根因。`replies` 表与 `timeline` 响应都无 `kind`，任何消费方（手机、桌面）都只能把一切 agent 消息当答复。
- 触发：读 `mobilegw:265-272` 与 `mobileq:53-61`。
- 验收：
  - `GET /timeline` 的每条 `role==='agent'` 条目带一个类型位（回执/答复/通知三选一，与 `ports.ts:72` 同名），且该位在网关重启后不变。
  - 新增该字段后，旧客户端不读它时不改变任何既有字段的字节（向后兼容）。

### P1-3 `request_state` 把执行活动与收据混成一域，`evaluating` 是死值

- 影响：`evaluating` 永不下发却留在类型与客户端词表里（`CrewWire.kt:582` 有「处理中」映射），任何按类型写的分支都会以为它可达；`processing` 被三层前置分支压成窄兜底（`mobile-http.ts:1512`），用户几乎看不到「处理中」。
- 触发：`grep "'evaluating'"` 全仓无产出分支。
- 验收：
  - 类型里出现的每个取值，至少有一个可达分支，或从类型与客户端词表中删除（两者同一次提交）。
  - 用户消息气泡上的状态，在「已发出 → 已取走 → 已判 → 已回执 → 已回答」阶段各至少可达一次，并且不依赖 `assignment` 的窄兜底。

### P1-4 模型活动信号存在但从未到达消息面

- 影响：用户问的那件事（「LLM 那边在干什么」）所需数据全都已经生产出来了（`screen.ts` 的工具/回话、`retry-health.ts` 的预算重试），只是没有按消息/票关联下发。手机只能靠人点进工作区页才看得到，且 5 秒一次、只对单张票。
- 触发：`mobile-http.ts:1291-1355` 响应体无 `model_retry`，也无任何 `activity`。
- 验收：
  - 对一条**未结束**的消息所属票，`GET /timeline` 能带上一个活动位（取值集合 = §4.1 B 表），且该位缺失时客户端不画任何状态（不写「未知」、不画假进度）。
  - 预算重试期间，该位为 `retrying` 且带 `provider` 与次数；重试结束后下一次轮询变回 `working` 或 `idle`（依据 `retry-health.ts:67-72` 的 `assistant/message` 收口判据）。
  - 该位**不得**出现在任何已结束票上，也不得进入 `messages`/`replies` 持久表。

### P1-5 真回复到了，气泡仍停在「已发送」（`to_msg` 缺失路径）

- 影响：与 P0-1 相反的假象。人已经拿到答复，气泡却说「已发送」，看起来像没送达。且这个错误会让「未读回话」「可撤回集合」一起错。
- 触发：`replies.to_msg` 为 NULL，见 §3.5。
- 验收：
  - agent 条目缺 `reply_to` 时，`withRequestStates` **不得**据此把用户消息降为 `unknown`→「已发送」；要么按「无法归属」显式表达，要么由后端补 `to_msg`（写入侧拒绝空 `--to`，`mobileq:132-160` 已是此策略，需确认 `sources/mobile.ts:212` 永不产生空值）。
  - 影响面核对（现状事实，供验收时不要误判）：`queued` 还额外要求 `read_at === ''`（`mobile-http.ts:1449`），所以**已被读走**的消息即使缺 `reply_to` 也不会回到可撤回集合；`unreadOf` 只看 `read_at`（`1404-1409`），`unread_replies` 只按位置数 `role==='agent'`（`1424-1432`），两者都不依赖 `reply_to`。缺 `reply_to` 唯一打坏的就是本条消息的 `request_state`。

### P2-6 `queued_state` 下发了却没有消费者

- 影响：`mobile-http.ts:1339-1340` 会因网关缺 `read_at` 而下发 `queued_state:'unknown'`（`1436-1439`），语义是「可撤回集合不完整，说不清」。`CrewWire.kt:129/525` 解析后，全仓 UI **零引用**（`grep queuedState CrewUi.kt` = 0）。于是「算不出来」被静默画成「没有可撤回」。
- 触发：老网关或 `read_at` 缺失时，`queued` 为空数组 + `queued_state:'unknown'`。
- 验收：
  - `queued_state !== 'live'` 时，客户端不把「没有撤回入口」表达为「不可撤回」，而是表达为「撤回状态读不到」（与 §2.1 三态口径一致）。
  - 该断言可写成纯函数测试：给定 `queuedState='unknown'`，撤回入口的表达 != 正常态表达。

---

## 6. 明确没做的事

- 没有实机观察，没有手机操作，没有截图取证；本报告所有结论均为 **[静态]** 或 **[隔离]**。
- 没有发送任何消息、没有创建工单、没有碰生产写 API、没有运行 headless 健康检查以外的运行态探测。
- 没有读宿主 `DeepSeek Harness.app` 内的 `dsh` 实现：`ctx.sessionController.inspect` / `ctx.agents` 的返回形状按本仓调用点（`runtime.ts:549`、`work.ts:agentTree`）与 `screen.ts` 的 `ScreenEvent` 契约认定，未向上游核对其事件类型全集。若上游新增事件类型，`screen.ts:123` 的 `switch` 会静默跳过（`hidden` 计数可见，`screen.ts:223`）。
- 没有改善 `progressOf` / `stepOf` 的语义，也没有评估桌面端 UI 是否同样受 P0-1 影响（`desktop/` 无 `request_state` 解析）。
- 未追审批卡（`mcp_messages_send_message` 原文外泄）链路——按分工留给 Root。
