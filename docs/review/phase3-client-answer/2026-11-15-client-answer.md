# task-12 / phase3-client-answer — 接通 desktop/mobile 待决问题答复控件

日期：2026-11-15
负责人：wb3-client-answer（客户端 / Android + desktop 源码独占）
后端协作：wb2-executor-closeout（backend owner，独占 runtime/index/mobile-http/DTO/executor）

## 一句话结论

用户内部消息工具写的问题在 backend 生成 `pendingApproval` 后，**两端现有问题/选项卡已能投影成可操作卡并调用认证 POST /api/mobile/answer**；普通聊天与老后端无 ticket 的 timeline stage.answer 通道保持原有 /send 路径不变。409（旧卡/已结束/重复答）刷新旧卡并明说「已更新」，请求中禁重入。真机点按受 ColorOS 锁屏 ROM 阻塞未覆盖（环境，非代码/APK）；桌面真 Client/view/OnClick 打真 canary 已实证 approve/stop/409 三态。

## 根因（真实缺口，非「有 API 就算能用」）

后端早已有 `POST /api/mobile/answer`（mobile-http.ts:670-686）+ `index.ts:48 → runtime.answerTicket`，审批状态机 `applyApprovalAnswer` 与 feishu approvalReply 同源。但：

1. **GET /api/mobile/timeline 的 tasks[] 只下发 question+options，没有 attention_id** → 客户端拿不到当前问题卡 id，**根本无法构造合法 /answer 请求**。
2. 两端客户端把「答复」实现成**拼 `@某人 optionLabel` 文本 → POST /send** → 引擎起一段新活，而不是回这张卡的审批（正是用户描述「有后端新 API 不等用户能用」）。
3. connection 审批（`guardConnection` 产出的 attention-connection-*）也走 `ticket.attention`，`stage.ts` 都判 `answer`，同样没有可操作入口。

## 契约冻结（与 backend owner 双向确认）

- `GET /api/mobile/timeline` → `tasks[]` 中 `needs_person==='answer'` 且带问题时，**新增下发 `attention_id: string`**（与 question/options 同处）。其它票不带。connection 审批与 task 审批共用这一字段，无需第二套。
- `POST /api/mobile/answer` 入参 `{ ticket, text, attention_id }`（三者必填）；**body 内 actor 一律忽略**，actor 只取入口注入的 `x-crew-principal`（客户端不发可伪造身份）。成功 `200 {ok,answer:'go'|'stop'|'revise',ticket,attention_id}`；失败 `409 {error}`（旧卡/已结束/重复答/非可执行答复）**零状态变更**；缺字段 `400`；未接 `503`。
- revise：text 为**用户自由输入原文**，后端认不出具体选项即走 revise 分支（记新要求、回「等确认」）；选项按钮 text 传 label 或 id 均可。

后端已落该 hunk（mobile-http.ts tasks[] asking 分支 `attention_id: ticket.attention!.id`），tsc 0；canary timeline 实测已下发。

## 改动（独占写入范围）

### Android（app/app/src，com.dsh.botcrew）
- `CrewWire.kt`：`WorkTicket` 新增 `attentionId: String = ""`（默认，向后兼容老后端= 空 → 退回 /send）；`parseTimeline` 读 `attention_id`。
- `CrewClient.kt`：新增 `suspend fun answer(ticketId, text, attentionId, session)` → `POST /api/mobile/answer`，body 只 `{ticket,text,attention_id}`；**捕获 409 → 抛 `AnswerStale`**（区别于普通 IOException，界面据此刷新而非当成功）。
- `CrewUi.kt`：
  - `answerByTicket()`：审批卡走 `client.answer`；成功 onSent 刷新。
  - `answerTicket()`：`attentionId` 为空 → 退回既有 `sendBoardText`（/send 拼 @，逐字不变）；非空 → `answerByTicket`。
  - 队伍消息区 `TicketStrip`（既有「等你决定」组件）：选项点击走 `fire()`（有 attentionId→/answer；无→/send）；**审批卡内联「自己写一句」输入框**（复用既有 question 布局），typed 原文带 attention_id 走 /answer，不猜票号、不滑进群聊；409 → 刷新 + 提示「这张问题卡已更新，请按最新的那张再答」。

### desktop（desktop/，同逻辑）
- `client.go`：`Task` 新增 `AttentionID`（unmarshal `attention_id`）；新增 `func (c *Client) Answer(ctx, ticketID, text, attentionID, session...)`（POST /api/mobile/answer，仅三项 body，409→`ErrAnswerStale`）。
- `ui.go`：
  - `answer()`：有 `AttentionID` → `client.Answer`（goroutine 里发 HTTP，结果经 `s.answered` 通道回主循环，**UI 变更不跨线程**）；无 → 既有 `Send`（逐字不变）。`answerResult` 加 `stale bool`。
  - `answered` 事件处理：stale → 刷新 + `answerStale` 标记「已更新」提示（刷新换题后仍按「同一张票」显示，不因签名变化被清掉）；普通失败只写卡上 note 不当断连。
  - `pendingCard`：审批卡（有 attentionId）渲染**内联自写格**（`ui.TextInput` + 回 → `sendRevise`→`client.Answer`）；无 attentionId 保持原 prefill→普通 /send。
  - 新 OnClick（sendRevise/answer）均走 mygo 主线程（结果经通道 + `s.wake()`），无 fork goroutine 碰 UI。

### 未改动 / 守住
- 普通聊天、原 timeline `stage.action=answer` 未含 ticket 的新旧通道：仍走 /send（不把每条 native 回复都变审批）。
- 未改 backend runtime/index/mobile-http/KV/007 共享表（由 owner）；build.gradle.kts 的 crewAppId 覆盖为既有改动（非本次作者，仅用于隔离 .answerverify 构建，默认包名不变）。

## 测试证据

### 单元 / 契约（全绿）
- **Android debug：429 pass / 0 fail**（基线 425，+4：CrewClientAnswerTest 3 条 —— /answer 三项 body 无 actor、409→AnswerStale、400 非 stale；CrewWireTest 1 条 —— attention_id 读出/缺省空）。
- **Android release：429 pass / 0 fail**（同集）。
- **desktop：290 PASS / 0 FAIL，`-race` 全绿**（基线 286，+4：answer_contract_test.go —— approve 走 /answer 且不发 /send、409 刷新+已更新+不虚假成功、无 attention_id 仍 /send 向后兼容、内联 revise→/answer 带原文；answer_canary_live_test.go 真后端专用，无 CREW_CANARY 时 skip）。

### 真后端端到端（真 desktop Client + 真 view 渲染 + Tester.OnClick → 真 canary :8799）
- **approve**：点「做吧」→ 复拉 `state=working / needs=None / attention_id=None`（pendingApproval 被 guard 消费、executor 接手）。
- **stop**：点「先别做」(canary-answer-1) → 复拉 `state=stopped / open=False / needs=None / attention_id=None`（stopTicket 生效）。
- **409 三态**：旧 attention_id→「已过期」、未知 option→「不是一个可执行的答复」、缺 attention_id→400；desktop 卡片正确刷新/提示。
- **联合业务效果（backend owner canary 侧独立铁证）**：`做吧→真 DshExecutor 自动 deliver→真 MCP stdio replies+1`（answer-4 replies 1→2、answer-6 2→3 正文真实）；`先别做→零写`（answer-1 无 reply 行、answer-5 before=after）。

### 真机（Android）—— 如实记「未覆盖」
- `.answerverify`（applicationId 覆盖 `com.dsh.botcrew.answerverify`，与主包并存）APK 构建成功、推送到 55c86317；但 `pm install` 卡在 ColorOS 自带 `OPlusPackageInstallerActivity` 确认框，该框在锁屏之后，而本机锁屏 `deviceLocked=1`、`adb input swipe/keyevent` 手势/确认不可达（swipe/dismiss-keyguard/locksettings/power-cycle 均无效，截图为黑=FLAG_SECURE）→ **环境阻塞，非代码/APK**。
- 已清理：abandon 安装 session、删 /data/local/tmp/av.apk、`locksettings set-disabled false` 原样恢复；**主包 com.dsh.botcrew firstInstallTime=2026-11-11 未变、无 answerverify 残留**。
- Android 侧客户端逻辑与 desktop 逐条同构，已由 429 单元/契约覆盖；真机 UI 点击作为已知未覆盖项如实记录。

## 产物 hash（source freeze）
- desktop（`go build` 冻结树）：`/tmp/desktop-crew` sha256 = `6dc5b33f8eada9540bedcd3bfa8e77c586f74ada50f8fc7842df8183cc903354`
- `.answerverify` debug APK：sha256 = `3b5d755099d806268b5d046fcfb7ebd7bb16abb9e5c93dcefd69956065958613`（package `com.dsh.botcrew.answerverify`；仅隔离验证用，不入主包交付）
- 主包 release 统一构建与最终 APK hash 由 release owner 在 sourcefreeze 后出（本次未改主包 applicationId 默认值）。

## 遗留 / 交接
- 主包 release 统一构建 + 最终 APK hash + 真实主包的通知/配对回归：release owner。
- 真机 UI 点击（Android /answer 实点）：ColorOS 锁屏 ROM 阻塞，待可用桌面环境或用户解锁窗口时补；当前以 desktop 真链路 + Android 契约测试为客户端证据。
- sourcefreeze 后 backend owner 跑唯一一次合并门 + 收口 docs + 精确 cleanup canary（停 72805、kill gateway 72885、只删 ccf8Um 及 canary-answer-* 临时目录，不碰生产 89699/67367）。
