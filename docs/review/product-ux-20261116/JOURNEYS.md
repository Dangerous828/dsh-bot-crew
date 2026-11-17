# BotCrew Android 用户旅程审查（独立）

2026-11-16，Asia/Shanghai。对象：已安装 0.2.0(3) 对应的当前工作树。
方式：只读追代码，按「用户发出的一句话 → 谁在处理 → 要不要等 → 何时介入 → 失败能否恢复」串成旅程。
本轮**没有**启动模拟器、没有连实体手机、没有 HTTP 写生产、没有改源码/部署/提交。凡未实机执行的结论都按证据分级标注。
后端投影链由另一成员独立审查，本文件只引用其结论不重复推导。

技能：按会话技能目录加载了 `ui-ux-pro-max` 与 `mobile-android-design`。目录里**没有**独立 `product-manager-toolkit`，本轮没有假称使用未安装的 PM 工具；只在 UI/UX 状态可见性与原生触控/命中区判定上使用这两个技能。UIUX 检索脚本在本机系统 Python 上未跑（3.9 语法不兼容其 f-string），未改共享技能，判定全部靠读代码。
基准：沿用项目现有 Brand 与布局，本文件不含换皮、配色重排或整页重排建议。

证据分级：**[静态]** 读代码即可确定的行为；**[运行]** 需要真机/模拟器观察才成立（本轮未做）；**[建议]** 无现成缺陷，仅是方向。

---

## J1（P1）发送失败的红字不会消失，改字重发成功后仍写着「失败」

**用户触发**
1. 发一句话，后端未收到（断网、超时、后端 5xx）。
2. 输入区上方出现红字「发送失败」一类文案（`failSend`）。
3. 用户改一个字（或补一句）重新发送，这次成功。

**实际行为 [静态]**
- 失败写入按会话一张表：`sendNotesBySession` 只存**一条** `SendNote(requestId, message)`（[CrewUi.kt:402-405](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L402>)）。
- 新文本会拿到**新的** request id 并覆盖 `pendingSendBySession`（[CrewUi.kt:407-414](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L407>)）。
- 成功回调只清「与本次 requestId 相同」的 note（[CrewUi.kt:389-396](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L389>)、[SendOwnership.kt:20](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/SendOwnership.kt#L20>)）。
- 于是：改字后重发成功 → 旧 note 的 requestId 与新的不等 → 红字继续常驻（渲染点 [CrewUi.kt:1364-1369](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1364>)、来源 [CrewUi.kt:275](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L275>)）。只有**原文原样重发**才会被清掉。

**用户损失**
屏幕同时存在「我这条已经出现、队伍已收到」和「发送失败」。用户据红字判断没发出去，于是再发一遍 —— 这正是重复发送/重复起活的实际入口，也直接影响「知道自己到底有没有发出去」。

**最小验收**
同一会话内任意一次发送成功，必须清除该会话所有 `SendNote`；或把失败态挂到对应气泡上（气泡级状态本来就有 `requestState` 位置），不要做成会话头部常驻行。验收判据：改字重发成功后，任何位置都不再出现上一次的失败文案。

---

## J2（P1）任务页「丢」失败后，屏幕上没有任何下文

**用户触发**
1. 切到任务页（分拣台）。
2. 在底部「丢 →」写一句，点 ↑。
3. 这一次 POST 失败（断网、后端拒绝、超时）。

**实际行为 [静态]**
- 任务页的入口忽略结局：`onDrop = { text -> sendBoardText(text) {} }`，`done` 回调是空函数（[CrewUi.kt:1245](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1245>)）。
- 失败确实被记录（`sendBoardText` → `onSendFailed` → `failSend`，[CrewUi.kt:1096-1113](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1096>)）。
- 但那条 note 只在**聊天分支**渲染（[CrewUi.kt:1364](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1364>)）。`TriageScreen` 的参数表里没有任何 note 或 problem-adjacent 提示位（[BoardUi.kt:332-343](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/BoardUi.kt#L332>)）。
- 唯一可见变化是按钮从「…」回到「↑」——与「发出去了」在视觉上完全相同。

**用户损失**
一次「丢了但没进去」被画成「丢了」。用户以为事务已进入队列，于是继续等一个根本不存在的工单；这是「操作没结果」的典型，也是本应用最核心动作的一处。

**最小验收**
任务页把 `sendNotesBySession[本次会话]` 的失败文案显示在「丢」这一行附近（或该输入框下沿），并在下一次成功「丢」后清除；验收判据：断网后点 ↑，屏幕上出现一句可读的失败原因且草稿仍在，恢复网络再点成功后该提示消失。

---

## J3（P1）聊天页只露一张「等你决定」，其余静默隐藏

**用户触发**
1. 同时有两张以上工单在等主人作答（后端 `needs_person` 非空）。
2. 用户停留在聊天页等结果，不主动进任务页。

**实际行为 [静态]**
- 卡片组件自己只取第一张：`conversation.tickets.firstOrNull { it.open && it.needsPerson.isNotEmpty() } ?: return`（[CrewUi.kt:3166](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L3166>)）。
- 外层也只插**一条** ticket 项，不带数量（[CrewUi.kt:1422-1434](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1422>)）。
- 全量视图只在任务页（`deciding` 分组，[BoardUi.kt:113](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/BoardUi.kt#L113>)），而聊天页没有任何「另有 N 张等你」的指路。

**用户损失**
第二张票等不到人，任务就停在原地；而主屏看起来一切正常。这正是「何时该介入」这一问被吞掉的位置：用户不知道自己被等。

**最小验收**
聊天页在「等你决定」卡处出现可数的其余数量（例如「还有 2 张等你」）并能一键到达；验收判据：构造两张 `needs_person` 票，聊天页必须同时传达「共 2 张」且可达第二张。

---

## J4（P1）某个 Bot 的工作区里点「让它停一下」，停的是整队执行器

**用户触发**
1. 从侧栏「屏幕」或名片「看他的屏幕」进入某个 Bot/工单的工作区。
2. 点底部「让它停一下」。

**实际行为 [静态]**
- 按钮文案仍指向单个对象：「让它停一下」，按钮文字由 `WorkspaceAction.Pause.label` 给出（[CrewWire.kt:1246-1249](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewWire.kt#L1246>)、[CrewUi.kt:2407](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L2407>)）。
- 请求即便带 ticket，后端也只 `settings.pause(true)` 并回 `scope: executor`（[mobile-http.ts:1042-1052](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/mobile-http.ts#L1042>)）。
- 范围只在**成功后**的回执文案里出现：「已让它停一下（全局执行器，再按一下继续）」（[CrewWire.kt:1314-1315](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewWire.kt#L1314>)）。
- 失败时按钮回到常态、只有 `failed(...)` 一句（[CrewUi.kt:2422-2426](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L2422>)），范围信息一个字都不出现。

**用户损失**
为了按住一个人，把整队调度与投递一起停了；其他会话在等的人不知道自己为什么没进度。用户在按之前无法从界面得知范围 ——「操作前范围认知」缺失，属于「错作用域」而非文案问题。

**最小验收**
操作前标签直接说明范围（例如「暂停全队执行」），或拆成「停这张票」与「暂停全队」两个不同动作；验收判据：不点开任何弹层，只看按钮文字即可判断会影响多少对象。

---

## J5（P1）草稿与休假中的幂等键都只在内存：切会话即清空，进程重启不可恢复

**用户触发**
1. 写了一段还没发的内容；或刚点发送、结果尚未回来。
2. 切到另一个会话再切回（或系统回收 App 后重开）。

**实际行为 [静态]**
- 草稿是 `remember` 的一格字符串（[CrewUi.kt:269](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L269>)），`enterSession` 直接 `draft = ""`（[CrewUi.kt:446-453](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L446>)，赋空在 [450](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L450>)）。
- 幂等键表同样只是 `remember`（[CrewUi.kt:272](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L272>)），新建请求 id 在 [CrewUi.kt:407-414](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L407>)。
- 注意区分：持久化的是**推送**（`NoticeStore`，[NoticeStore.kt:56-90](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/NoticeStore.kt#L56>)），不是草稿；本文件不把推送的落盘当成草稿已有存储。

**用户损失**
切会话查看另一个人的资料，写了一半的话就没了。更严重的是「POST 已到服务端但响应没回来」这一窗口：重启后同一句话会拿到新 id，服务端无法按幂等合并，一次交代可能变成两条消息/两次起活。

**最小验收**
按会话保存 `{正文, 收件人, request_id, 是否处于不确定态}`；切换与进程恢复都不丢；只有该次发送明确成功，或用户主动清空时才删除。验收判据：写半句 → 切会话 → 切回，正文与「发给谁」都还在。

---

## J6（P2）`request_state=unknown` 被画成「已发送」

**用户触发**
1. 发出消息后，后端投影说不清这条的状态（无读回执、无决策、行号对不上）。
2. 用户看自己那条气泡下的状态小字。

**实际行为 [静态]**
- 后端确实会产出 `unknown`（[mobile-http.ts:1480](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/mobile-http.ts#L1480>)、[1489](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/mobile-http.ts#L1489>)、[1494](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/mobile-http.ts#L1494>)）。
- 前端文案表没有 `unknown` 分支，落到 `else -> "已发送"`（[CrewWire.kt:579-587](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewWire.kt#L579>)）。
- 同一份 UI 对「说不清」本来是有原则的：`queued_state`、`unread_replies` 都保留 unknown 不画成 0（[CrewWire.kt:104-110](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewWire.kt#L104>)、[BoardUi.kt:699-704](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/BoardUi.kt#L699>)）。此处是唯一一处把三态压成两态的地方。

**用户损失**
「说不清」被画成确定的「已发送」，用户据一个不成立的事实决定继续等还是重发。与 J1 叠加时，屏幕上会同时出现「已发送」和「发送失败」两种自相矛盾的确定态。

**最小验收**
`unknown` 单独文案（如「状态未同步」），与 `accepted` 的「已发送」互不冒充；验收判据：单测输入 `request_state=unknown` 时 `label` 不等于 `"已发送"`。

---

## J7（P2）通知不按会话区分，切会话后仍是上一条会话的数量

**用户触发**
1. 在会话 A 收到一条设备推送。
2. 切到会话 B。
3. 看侧栏「通知 · N」与聊天列表顶部那条通知摘要。

**实际行为 [静态]**
- 推送取回不带会话参数：`client.notices()` 只有设备维度（[CrewClient.kt:560](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewClient.kt#L560>)、[CrewUi.kt:555](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L555>)）。
- 本地那份整体读出、整体渲染（[CrewUi.kt:253](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L253>)、[731](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L731>)、[1390](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1390>)）。
- `CrewNotice` 其实带着 `sessionId`（[CrewWire.kt:2316-2323](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewWire.kt#L2316>)），但界面侧没有用它过滤；侧栏计数直接是 `notices.size`（[CrewUi.kt:1200](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1200>)）。

**用户损失**
信息串台：会话 B 里显示会话 A 的提醒，用户点「通知」被带回当前会话顶部却找不到那条来源；多会话时「被谁处理/在哪处理」的归属被抹平。这是错目标信息，不是样式问题。

**最小验收**
有 `sessionId` 的通知只在对应会话计数与展示；无 `sessionId` 的老数据如实标注来源不明，不并入当前会话计数。

---

## 交叉确认（不重复计分，只补 UI 侧证据）

- **暂停作用域**：与 J4 同因，用户旅程的落点在「按下之前看不懂范围」。按钮文案 [CrewWire.kt:1248](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewWire.kt#L1248>)，范围披露位置 [CrewWire.kt:1314-1315](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewWire.kt#L1314>)（成功之后）。
- **草稿/幂等键**：同 J5，已由状态链成员独立取证，本条只补「聊天页与任务页共用同一格草稿」这一面（`draft` 由 CrewRoot 持有，两页共用，[CrewUi.kt:269](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L269>)）。

## 已确认但不算本轮缺陷（避免下次重复报）

- **未读数悬空**：`BoardDrawer` 在聊天页实际打不开 —— `boardOpen` 只有初始化 `false`（[CrewUi.kt:1072](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1072>)）与两处置 `false`（[1172](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1172>)、[1177](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1177>)），全仓无置 `true`；`boardUnread` 只被单测引用（[BoardUi.kt:123](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/BoardUi.kt#L123>)）；侧栏工具注释写着「事务板」但实际没有这一项（注释 [CrewUi.kt:1681](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1681>) vs 实际 [1817-1825](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1817>)）。功能由侧栏「任务」页承担，不影响用户，归为注释与未读数清理，不进优先级。
- **没有流式、没有花哨动画、字号偏小**：不单列为缺陷。字号在 10–13sp 区间的位置都是次级元信息（状态行、计时、署名），主正文是 14sp（[CrewUi.kt:3929-3932](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L3929>)），触控命中区普遍 ≥48dp（发送键、收件人、选项、抽屉行）。这些没有造成具体旅程损失。
- **历史聊天滚动问题**：本轮未复现，不重报。

## 边界

- 本文件所有「实际行为」均标注为 [静态]（读代码）；[运行] 项一条都没有 —— 本轮没有设备，不宣称看到过真机画面。
- 断网重连主路径按代码是：时间线抛错 → `problem` 非空 → 顶部显示「连不上队伍：…」+「重试」/「重新配对」，同时输入框禁用（`enabled = problem == null`，[CrewUi.kt:1494](</Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1494>)）。这条链路本身没有发现缺陷；与 J1 的关系是：发送失败**不写** `problem`，所以输入框不会被禁，用户可以在红字还在的情况下继续发 —— 这是 J1 能发生的前提。
- 审批卡显示原始工具调用（`mcp_messages_send_message({...})`、字面 `\n`、大段正文进审批卡）有用户实机截图，其根因在后端生成与分类，由 lead 与后端成员处置，本文件不重复推理。
