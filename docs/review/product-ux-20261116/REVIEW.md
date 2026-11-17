# BotCrew 首轮产品体验审查

2026-11-16 开始，2026-11-17 收口，Asia/Shanghai。范围：当前 Android 0.2.0(3) 对应代码的发消息、等待回复、执行过程、草稿恢复、任务控制及错误恢复。本轮只审查，没有改产品代码、部署或连接实体手机。

使用 UI/UX Pro Max 的系统状态可见、提交反馈、错误恢复准则，以及原生 Android/Compose 交互方法。检索了现有技能目录和 Matt Pocock 技能路由，当前目录没有独立的 product-manager-toolkit；本次没有假称使用未安装的产品经理套件，也未采纳通用落地页配色或布局建议。两名真实 OpenConsole DeepSeek 成员分别审状态链与用户旅程，lead 交叉核查并执行隔离状态复现。

## 结论

需要把真实的模型和工具执行状态送到手机，并关联到对应消息。当前聊天把发送回执、队列状态、是否出现过回话、工单状态放进一条状态文案；用户因此看不清「收到没有、正在做什么、是否需要介入、是否已经结束」。

先修状态真实性、输入保留和操作范围。视觉换肤、动画、字号统一不列为这轮的主要改动。

## 已证实的首要问题

### P1-01：消息被读走后的模型评估阶段没有投影，状态会退回「已发送」

**触发：** 发出消息，后台已读走，评估/模型调用仍在进行，尚未形成决策或工单。

**实际：** `withRequestStates` 不接收当前 thread/evaluation；这种输入输出 `unknown`。App 把 `unknown` 也显示为「已发送」。类型里虽然有 `evaluating`，这段投影没有产出它。6 秒一次的刷新也会错过短阶段。

**用户损失：** 分不清排队、模型已开始、网络失联；长时间等待时容易重复发送或误以为没有接单。

**证据：** [mobile-http.ts:1464](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/mobile-http.ts#L1464>)、[CrewWire.kt:579](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewWire.kt#L579>)、[CrewUi.kt:573](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L573>)；[隔离复现](</Users/cpuser/Code/dsh-bot-crew/docs/review/product-ux-20261116/STATE_PROBE.json>)得到 `consumedBeforeDecision=unknown`。

**验收：** 未建工单的评估阶段也有真实活动；同一 request 的发送回执不回退；模型阶段、工具阶段、用户等待和传输失联分别表达。正常网络下活跃状态变化应在约 1 秒内可见，而非只等下一次固定轮询。

### P1-02：「已回复」只表示有过关联回话，缺少后续执行状态

**触发：** Bot 已有一条关联回话，工单仍在运行、等人或交付中。

**实际：** 内部出站消息区分 `acknowledgement/reply/notice`，但 `sendMobile` 传给 mobileq 的参数及 replies 表没有保留 kind，网关把它们统一输出为 `role=agent`。只要 `reply_to` 指向原消息，投影就优先返回 `replied`，随后不再判断工单阶段。接手确认落库后也会显示「已回复」，此时执行 worker 的模型可能尚未启动。这适合作为「有过回话」收据，单独使用时不足以说明任务还在做什么。

**用户损失：** 接手确认、阶段性回话与最终交付缺少可见区分，用户容易把一句回话理解为本次处理已经结束。

**证据：** [ports.ts:72](</Users/cpuser/Code/dsh-bot-crew/backend/src/core/ports.ts#L72>)、[replies.ts:44](</Users/cpuser/Code/dsh-bot-crew/backend/src/core/replies.ts#L44>)、[mobile.ts:208](</Users/cpuser/Code/dsh-bot-crew/backend/src/sources/mobile.ts#L208>)、[mobileq:52](</Users/cpuser/Code/dsh-bot-crew/backend/tools/mobileq#L52>)、[mobilegw:265](</Users/cpuser/Code/dsh-bot-crew/backend/tools/mobilegw#L265>)、[mobile-http.ts:1481](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/mobile-http.ts#L1481>)。隔离输入一条关联 Agent 回话，即得到 `replied`，与是否存在执行活动无关。

**验收：** 保留消息收据语义，同时独立显示当前执行活动和结束原因；阶段性回话出现后，运行中、等确认、失败等活动仍可见。最终交付有明确的完成语义。

### P1-03：草稿切换会话即清空，重建后也没有恢复来源

**触发：** 写了一段未发送内容，切换到其他会话再切回，或系统重建 App。

**实际：** 草稿是 `remember { mutableStateOf("") }`；切会话直接赋空串。没有按会话保存的草稿。

**用户损失：** 输入被丢弃，跨会话查看资料或回复另一条消息时要重新写。

**证据：** [CrewUi.kt:269](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L269>)、[CrewUi.kt:446](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L446>)。

**验收：** 每会话独立恢复草稿及其收件人；切换和进程恢复不丢；只有对应发送明确成功或用户主动清空时删除。

### P1-04：发送结果不确定时，重启会丢掉防重复的 request_id

**触发：** 后台收到 POST，但手机没收到成功响应；随后 App 被系统回收，用户重新发送。

**实际：** `pendingSendBySession` 的幂等键只活在 `remember`。重建后同一意图会生成新的 UUID。已有的同进程重试保护没有覆盖这一恢复路径。

**用户损失：** 一次交代可能变成两条消息或两次任务；用户也缺少「刚才到底发成功没有」的可恢复发件记录。

**证据：** [CrewUi.kt:272](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L272>)、[CrewUi.kt:407](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L407>)。

**验收：** 请求发出前保存会话、收件人、正文、request_id 及不确定状态；恢复后用原 id 对账或重试，同一意图最多生成一条服务端消息。失败提示保留恢复操作。

### P1-05：在某个 Bot 的工作区点「让它停一下」，实际影响整队调度和投递

**触发：** 进入某个 Bot/工单工作区，点击「让它停一下」。

**实际：** 请求即使带 ticket，也调用全局 `settings.pause(true)`，返回 `scope=executor`。按钮文案仍指向「它」；全局范围在操作成功的回执里才出现。暂停规则还会影响新评估、派工和消息投递，用户在当前工作区看不出其他会话也受影响。

**用户损失：** 为处理一张票而暂停其他任务；用户可能把全局暂停理解为当前模型请求已经停止。

**证据：** [mobile-http.ts:1042](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/mobile-http.ts#L1042>)、[settings.ts:238](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/settings.ts#L238>)、[CrewWire.kt:1248](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewWire.kt#L1248>)、[CrewWire.kt:1315](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewWire.kt#L1315>)。

**验收：** 「暂停全队」和「停止此任务」分别表达；操作前可直接看懂作用范围。只有对应运行真正停止才显示已停止；暂停调度和暂停投递有一致、可解释的产品含义。

### P1-06：审批卡显示内部工具协议，当前对话的正常回报还被误送审批

**实机证据：** 用户提供的当前截图中，「等你决定」卡直接展示 `mcp_messages_send_message({channel,to,text...})`，可见字面量 `\n`、Markdown 星号、本地路径和大段消息内容，正文占据主要屏幕。此项有用户实机截图，不是源码推测。

**根因一：展示数据缺少人读投影。** 后台把脱敏后 `JSON.stringify(args).slice(0,500)` 与工具名拼进 `approvalPrompt`，手机用普通 `Text` 原样画 question。序列化产生的转义、任意截断的消息和工具参数由此变成面向用户的问题。应从有类型的 `text` 字段生成可读预览，保留真实换行；工具名、参数与路径详情按需展开。

**根因二：正常回原问题的匹配失败。** 对截图 m82 做了只读关联：origin 是 team/main/82、human=true、Bot=lead；截图调用 channel=main、to=m82，未带 bot_id。发送工具的 schema 明确将 bot_id 标为可选；`isTicketMessageReply` 却用 origin 的 bot_id 与调用值严格相等，lead 与缺值不匹配，进入连接写审批。目标会话和问题实际一致，构成可选参数与判定条件之间的契约矛盾。修复应把回复者身份与本票绑定并正确分类本次回复，继续保留其他收件人/其他会话操作的独立判定；不把问题归咎于模型没有填写可选参数。

**根因三：按钮后果过大且文案模糊。** 连接写审批同样使用泛化的「做吧／先别做／换个做法」；选 stop 最终调用 `stopTicket`，作用于整张票。用户面对一条发送动作时，难以从「先别做」理解到整个任务会结束。

**证据：** [用户实机截图](</Users/cpuser/.dsh/attachments/v1/objects/2c/2c1cfa14a4b51f0effd5bee9a46c55ece94fbb019cf0f067fcaf8bac33e8ca16>)、[只读归属记录](</Users/cpuser/Code/dsh-bot-crew/docs/review/product-ux-20261116/APPROVAL_METADATA.json>)、[runtime.ts:895](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/runtime.ts#L895>)、[runtime.ts:904](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/runtime.ts#L904>)、[runtime.ts:931](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/runtime.ts#L931>)、[approval.ts:82](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/approval.ts#L82>)、[CrewUi.kt:3228](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L3228>)、[runtime.ts:1519](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/runtime.ts#L1519>)。

**验收：** 回答已收到的本次用户请求，正确绑定当前 Bot 后正常出现在聊天中；确需确认的发送显示动作、收件人、可读预览和与后果一致的按钮。正文不包含序列化包装和字面换行转义。取消单次发送与结束整个任务分别处理或提前明确后果。保持旧卡校验、精确调用签名和跨会话边界，不用全局关闭审批来处理本例。此次没有点击审批选项或执行截图中的工具调用。

### P1-07：发送失败提示没有清晰的请求归属，改字重发成功仍会显示失败

**触发：** 发送 A 失败，修改正文后发送 B，B 成功。

**实际：** 失败条目按会话存储但携带 A 的 requestId；修改正文生成 B 的新 requestId。B 成功时只清理 requestId 等于 B 的 note，A 的失败条目保留。主界面只读取这个条目的 message，不显示其属于 A，于是在 B 已发出后仍留下泛化的失败提示。

**用户损失：** 用户容易把旧请求的失败当作刚才发送的结果，再次发送。问题在回执展示归属，不应简单删除所有 note 而破坏旧请求回调隔离。

**证据：** [CrewUi.kt:275](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L275>)、[CrewUi.kt:389](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L389>)、[CrewUi.kt:402](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L402>)、[SendOwnership.kt:27](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/SendOwnership.kt#L27>)。

**验收：** A 失败、改字发送 B 成功时，B 明确显示成功；A 的失败如仍需保留，要关联 A 的消息并给对应重试。旧请求迟到回调不覆盖新请求的展示，跨会话也不串线。

### P2-08：聊天只展示第一张待决定任务，其余缺少就地数量提示

**触发：** 同一会话有两张以上需要用户决定的活跃任务。

**实际：** 聊天卡用 `firstOrNull` 选第一张；其余在任务/分拣视图仍能找到，但聊天主路径没有「另有 N 项待决定」或逐项入口。第一张未处理时，后续等待被遮蔽。

**用户损失：** 用户以为当前只有这一个决定，其他任务持续等待；需要主动去任务页才能发现。此项是可发现性缺口，不把任务页仍可达说成数据丢失。

**证据：** [CrewUi.kt:3165](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L3165>)、[BoardUi.kt:113](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/BoardUi.kt#L113>)。

**验收：** 两张及以上待决定时，聊天主路径能看到总数并可直接到达每一项；处理一张不会让另一张失去入口，不强行把所有长审批正文铺满聊天。

## 修复优先级

1. **审批与状态闭环：P1-06、P1-01、P1-02。** 正常回报按原请求正确归属，审批用人读预览；聊天收到真实的模型/工具/等待活动，回执与最终答复分开。
2. **输入与回执恢复：P1-03、P1-04、P1-07。** 草稿、收件人、未确定发送和 request_id 可恢复；每次失败对应到原请求，避免用户重复提交。
3. **操作范围与待办发现：P1-05、P2-08。** 全队暂停与当前任务停止分开，所有待决定任务可见且可达。

共八项独立问题。状态专项对同一根因拆出的多条不重复计数；没有把这些体验问题标成 P0 服务事故。候选的 BoardDrawer 未达入口未列为用户阻塞问题，因为侧栏任务路径仍可用。

## 建议的状态交互

每条请求保留两层：一条简短的消息收据，以及当前执行活动。全部由后端事实投影，不在手机另建一套工单状态机。

| 所处情形 | 主界面表达 | 必要操作 |
|---|---|---|
| 本机正在发送 | 正在发送 | 等待回执；结果不确定时保留同一请求 |
| 服务端已持久化 | 已送达 | 不自动创建第二条请求 |
| 等候分配 | 排队中 | 满足条件时撤回 |
| 评估或模型请求活跃 | 模型处理中 · 已用时 | 可展开当前执行过程 |
| 工具调用活跃 | 使用工具 · 简短动作名 | 详细命令和输出折叠查看 |
| 模型请求在重试 | 正在重试模型请求 | 仅显示真实尝试次数与可用等待信息 |
| 等用户决定 | 需要你确认 | 就地回答或打开对应问题 |
| 网络中断而服务端状态未知 | 状态暂未同步 | 重连；避免把未知画成失败或未发送 |
| 处理结束 | 已答复／已完成／已停止／处理失败 | 按真实结束原因给结果、重试或继续 |

主界面只放当前活动的一行，过程详情按需展开。显示活动变化时间、已用时和数据新鲜度；工具结束、模型响应结束、重试结束或进程结束时收口对应活动。多 Bot/多会话通过 request_id、conversation、evaluation/ticket、worker 关联，避免拿全队的一个全局 busy 点代表每一条消息。

当前 `/screen` 的 `thinking/running` 根据工单阶段和末条日志推导；它不是完整的模型请求生命周期。已有原生 `llm/retry` 观察能力可复用，但聊天清单目前没有这份活动。单独把日志推导的「正在思考」搬过来仍会保留误导。建议先修投影，再选择能覆盖 LAN、公网和现有中转的传输方案；目前 LAN 转发会等待 `arrayBuffer()` 完整响应，持续事件流还需贯通转发链。

证据：[screen.ts:182](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/screen.ts#L182>)、[retry-health.ts:53](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/retry-health.ts#L53>)、[lan-server.ts:128](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/lan-server.ts#L128>)。

## 审查边界

代码中已按发生时间排序的消息不作为「按父消息插入历史」缺陷。没有凭通用字号、动画或配色规则给当前 App 扣分。隔离复现使用合成数据，不是对手机实际操作的录像或生产消息测量。厂商系统行为、视觉手感、读屏实测和长时间后台表现尚未在本轮验证。
