# Android 八项产品修复实施记录

2026-11-17，task-16。范围：`app/app/src/main/java/com/dsh/botcrew/**`、`app/app/src/test/java/com/dsh/botcrew/**`。
只跑 JDK21 JVM 单测；assemble / 签名 / 部署 / 实体机与 AVD 验收由 Root 统一执行。

## 一、数据结构与存储

| 文件 | 作用 |
|---|---|
| `RecordState.kt`（新） | 盘上记录的三态 `MISSING / OK / CORRUPT` + `recordRead()`。损坏时带回原串，供调用方拒绝覆盖并给可见提示。 |
| `CrewNamespace.kt`（新） | 本地存储命名空间。身份 = `dev:<设备凭据id>|c:<serverCrew>`；没有指纹时 `dev:<id>|o:<scheme://host:port/path>`。`plan()` 是纯函数迁移计划，`adopt()` 落盘执行并记指针。 |
| `DraftStore.kt`（新） | 每会话草稿：正文 + 收件人快照 + 时间。无会话数上限；空正文=用户自己清空。 |
| `SendRecovery.kt`（新） | 未确定发送的完整 envelope、同 id 不允许换 payload、按 requestId 单条移除、`SendNoteBook` 多条提示、`SendCopy` 文案。 |
| `ActivityWire.kt`（新） | 轻量活动协议解析、能力位、轮询节奏、活动/收据文案。 |

### 身份隔离的三条约束（对应用户真实损失）

1. **设备 id 不能单独当身份**：它是手机的 ANDROID_ID，换一台电脑重配仍是同一个值，两台电脑的 `main` 会撞在一格。所以身份里必须再有 `serverCrew` 或完整 base。
2. **身份不含"还没拿到的"东西就搬不了格**：`serverCrew` 首次要等 timeline 回来，从空变非空会整体搬一次命名空间。`adopt()` 在那一刻把旧格**搬**过去（只搬一次，指针落盘），不丢还没发出去的字。
3. **完整 base 含 port 与 path**：同 host 不同端口、同域名不同 relay 路径都是不同实例。

「重新配对」**不**清草稿与本机发送账：那个入口的意思是换台电脑/重连，不是删未发内容。命名空间按 crew 隔离，同一台电脑重配后原样回来。

`crew-drafts` / `crew-sends` 与 `crew-pairing`、`crew-notices`、`ota` 都是**不同 prefs 文件**：`PairingStore.save()` 会 clear 整个 `crew-pairing`（不看键名），本地内容住那儿会被一次 mDNS 广播抹掉。

## 二、八项问题逐条

### P1-03 草稿按会话恢复（含收件人）
- 每会话一格，切会话不删、进程重建从盘上读回（`CrewRoot` 的 `draftBySession` 初始化自 `DraftStore`）。
- 收件人真源仍是正文里的 `@`（`Recipient`）；盘上那份只是快照，供花名册还没拉回来时说清"发给谁"。

### P1-04 未确定发送（request_id 不丢）
- POST **之前**把完整 envelope（request_id / session / text / mentions / recipient）`commit` 落盘；落盘失败就不发（否则重启后无法对账）。
- 明确成功只删 request_id 相等的那一条；同会话允许多条并存。
- 恢复：界面给"另有 N 条发送结果待确认"的总数与逐项入口，`用原内容重试`（同一个 id）与`不再重试，移除本机记录`（只删这条）。
- 改字重发生成新 id，**不删**旧记录；时间线里出现同一 `request_id` 即视为已送达，清本机记录（`refresh()` 内对账）。

### P1-04 收尾：对账成功也收输入框
- 对账（重启后按原 `request_id` 匹配上时间线）与直接 200 成功走**同一个** `settleDraft(sessionKey, requestId, text)`，判据是 `SendOwnership.shouldClearDraft`：当前草稿仍等于当时发出去那一版才清。
- 用户后来改过字、或草稿属于别的会话，一律不动。
- 少了这一步的后果是实机上见到的那一屏：记录与提示都清了、输入框还留着原文，用户再点一次就生成新 UUID 重复发送。

### P1-07 失败提示按请求归属
- `SendNoteBook` 按 requestId 存列表（每会话最多 4 条提示；丢的是提示，未确认 envelope 仍在盘上并可逐条到达）。
- B 成功只清 B 的提示；A 的失败仍在、带 A 的原文片段。
- `SendOwnership.shouldClearDraft` 原样保留：迟到回调不会擦掉用户后来打的新草稿。

### P1-06 审批投影（消费 `tasks[].approval`）
- `WorkTicket.approval: TicketApproval?`（`kind/action/target/preview/details` 全可选）。全空即视为老协议，行为逐字不变。
- 卡片正文优先 `preview`（**只 optString**：不做 %XX 解码、不做 `\n` 反转义）；副标题「动作 · 对象」；`details` 默认折叠。
- `question` 仍是兜底，但结构化（JSON / `name({...})`）或超 6 行/400 字的原文会被 `ApiQuestionCopy` 折成一句人话 + 可展开原文，不把 `stringify(args)` 平铺到屏幕上。
- `attention_id` 过期校验（`AnswerStale`/409）与 `ApprovalGate` 同题互斥**原样保留**；`answerSignature` 现在包含 approval，换卡即换签名，旧的在途答复不会写到新卡上。
- 取消后果按 kind 说明：`connection` = 只拒绝这一次操作、任务继续；其它 = 会结束这张任务。

### P2-08 多个待决定
- 聊天里详细展开第一张，同时显示「另有 N 项待决定」+ 逐项列表 + 「逐项看」（打开事务板的待你一栏，每项都可答）。
- 不把每张的长正文都铺进聊天。

### P1-05 暂停范围
- 按钮：`停止此任务`（实际是 `stopTicket`，结束这张票）与 `暂停全队` / `恢复全队`（执行器全局暂停）。
- 回执按后端实际 `scope` 说话：`executor` → 「全队已暂停调度和回复投递（正在跑的这一步不会被中断，再按一下恢复）」；不承诺当前模型调用已停止。

### P1-01 / P1-02 消息收据与执行活动分开
- 收据：`RequestStateCopy.label(state, hasQuestion)`。`finished` → 「已结束」（具体结局由 activity/outcome 细分，不再一律「已完成」）；`waiting_for_person` 有问题才「等你答复」，否则「需要你处理」；未知值 → 「未知状态」，不并入「已发送」。
- `reply_kind`：只有 `reply` 算最终答复；`acknowledgement` / `notice` 与历史缺类型都不画完成标记。
- 活动：`GET /api/mobile/activity` 解析成 `RequestActivity`，按 `request_id` 挂到那条用户消息下方，单独一行（「模型处理中」「使用工具 · 读取文件」「正在重试模型请求」「已结束」「未知状态」）。
- 轮询：前台且（有活跃活动或存在未确认发送）→ 1 秒；否则 4 秒；后台或能力位 unsupported → 不发。完整时间线仍是低频。
- 迟到响应由代际 guard（`activityGeneration` + 会话相等）丢弃；成功 200 才以本次 `items` 为全活跃集合清 overlay，非 200 一律不清。
- 读不到 → 标「状态暂未同步」并保留上一次事实，不当成「没发出去」、也不清空已有活动行。
- 能力位：只有 **501** 或 **404 且错误体无 `code`** 判 unsupported（路由不存在）；`409 unsupported_session`、`502 session_mismatch/malformed_meta`、`503` 等都按可恢复，不永久关掉能力。

### 后端未接该能力时的行为
404（无 code）/ 501 → 记 `UNSUPPORTED`，停止轻量轮询、退回旧 6 秒时间线，不刷错误、不伪造活动、不静默假装有新能力。

## 三、测试

新增纯层用例（JVM，不依赖 Android）：

- `WiringRecoveryTest`：`DraftRecord`（按会话、只清发出那一版、损坏不覆盖、非法 id 丢弃）、`SendRecoveryRecord`（新草稿不丢旧未确认、整条 envelope 可恢复、同 id 不可换 payload、单条移除、损坏拒写、按会话分组）、`SendCopy`（成功只清自己的提示、POST 后只能说"结果待确认"、只有未发出才说"没有发出"、按钮文案不暗示能撤回服务端消息）、`CrewNamespace`（同设备不同 crew、同 host 不同 port/path、指纹到来后换 IP 不搬格、迁移只搬旧格且不覆盖）。
- `ActivityWireTest`：快照解析（含可选 activity、缺 capability 位不当空活动）、错误三档分类、轮询节奏、unknown 单列、`reply_kind` 与 ack 不算最终答复。
- `ApprovalProjectionTest`：approval 全字段读取且 preview 不被二次解码、老后端无 approval 行为不变、结构化与超长 question 折叠、取消后果分 kind、approval 纳入签名、只有 approval 没有 question 也保留选项。
- `ReconciliationDraftTest`：对账成功清掉仍是原文的草稿、改过字/别的会话不清、直接成功与对账对同一份意图结论一致、一次 settle 多条时各清各的提示。
- 既有用例按新语义更新：`WorkspaceCopyTest`、`PausePressTest`、`CrewWireTest`（unknown / finished / waiting_for_person / reply_kind）。

结果：`./gradlew :app:testDebugUnitTest`（JDK21）**643 用例，0 失败**。

## 四、显式未做与边界

- 未跑 assemble / 签名 / 安装 / AVD 或实体机交互（归 Root）。
- 消息正文仍沿用既有 `readable()`（仅在出现 `%XX` 时做一次 URL 解码），这是既有协议路径，本轮不改；审批 `preview` 明确不走它。
- 子代理树：展开且前台时 12 秒补一次读，收起时不启动；不因 1 秒活动快照重拉全树或全列产出。
- 会话切换/退屏靠 Compose 取消协程 + 代际 guard；后台由生命周期观察者停掉活动轮询。
- 「重新配对」不清草稿与本机发送账（见第一节）。要抹掉需要一个明说删除后果的入口，本轮不加。
