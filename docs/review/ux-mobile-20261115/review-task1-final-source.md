# task1 最终独立源码 review（wb-ux-verify）

审查时间：2026-11-15 15:39（Asia/Shanghai）。基线 HEAD `1e3c96a3`。**只读**，不采信 owner 主张，逐条读实码给行号。审查时 CrewUi.kt/BoardUi.kt 仍在 mtime 波动（owner 正修 lead 追加项），下列为当前快照证据；owner 修完 build 时以最终实码复核。

范围：`Recipient.kt` `ApprovalGate.kt` `BoardUi.kt`（含就地 Triage/BoardAnswerState）`CrewUi.kt`；测试 `RecipientSelectionTest/ApprovalFeedbackTest/BoardUiTest`。

## 一、lead 四重点 + 追加项逐条

### ① Recipient 多 mention + @id 显式切换，保正文 —— ✅ 通过
`Recipient.select`（Recipient.kt:36-46）：先取 `knownMembers`（mentionsIn 实算），逐个 `stripMention` 移除已知 @token，`trimStart` 后前置 `@target `，正文其余原样接上。`replaceOrRemove`(L83-101) 词边界 `@ab` 不误伤 `@a`、未知 @ 不动。保证 `mentionsIn(out).firstOrNull()==bot.id`。切换成员保留正文（只动已识别收件人 token）。主收件人提示 `primaryRecipient` 取 `mentionsIn` 第一个。集成处 CrewUi:1115-1118/1144 `onPick={bot->onDraft(Recipient.select(...))}` 显式走。通过。

### ② Approval Submitting 期间签名变化旧 HTTP 隔离 —— ✅ 通过
`ApprovalGateHolder.begin()` 记 `answeredSignature=signatureOf()`；`accepted()/stale()/failed()` 先 `stillSameTicket()`（当前签名==begin 签名）才写状态，否则直接回 Idle 丢弃旧结果（ApprovalGate.kt:126-147）。holder 按 `ticketKey=ticket.id` 建（BoardUi:521 `getOrPut(ticket.id)`），切票=新 holder，旧请求只更新已不渲染的旧 holder。签名含 `answerSignature(ticket)+"|"+attentionId`（BoardUi:523）。`converged`(L101-104) 只对 Accepted/Stale/StaleRefreshFailed 生效，签名变/票消失才解锁。通过。

### ③ Board 多 deciding 不得全局单 gate —— ✅ 通过（1 处死变量）
per-ticket：`holders = mutableStateMapOf<String, ApprovalGateHolder>()`，`holderFor` 按 `ticket.id` 各建（BoardUi:518-525），`phaseOf={id->holders[id]?.state}`、`answer` 按票发（L528-543）。答 A 锁不住 B。**小瑕疵**：`holderFor` 里 `val key = "${ticket.id}|${ticket.attentionId}"` 定义后**未使用**（getOrPut 实际用 ticket.id）→ 死代码。attention 变化靠签名收敛兜住，不算 bug，建议删该行。

### ④ 待决排序第一 + Triage 去 58dp 大按钮 —— ✅ 通过
`boardSections` 渲染序：deciding(514-534) → running → waiting → done；deciding 在最先。全文 g 无 `58.dp`；`"还没有事务，丢一件进来"`(BoardUi:507) 仅为**空态 11sp faint 文字**，非按钮。Triage 底有输入（TriageScreen onDrop + 群聊 Composer）。通过。

### 追加1｜Triage onOpenBoard={} 空 + early return 不画 BoardDrawer —— ❌ **缺陷（owner 修中）**
CrewUi:1069 `if(mode==Mode.Triage){ … CrewTopBar(onOpenBoard={}) … return }`；boardOpen 的 `BoardDrawer` 在 1396（Triage 分支 1096 已 return，永不渲染）。→ Triage 下事务板入口死。lead 已交 owner。

### 追加2｜长会话名 Box 无宽度约束挤掉右 48 更多 —— ❌ **缺陷（owner 修中）**
会话胶囊 Box(CrewUi:1451-1467) 仅 `height(48.dp)+defaultMinSize(minWidth=48.dp)+padding(h12)`，**无 widthIn(max)**；`defaultMinSize` 只设下限。Text 有 `maxLines=1+Ellipsis` 但父 Box 未限宽，超长 sessionName 会把胶囊撑宽、经 `Spacer(weight(1f))` 前的实测把右侧 48 更多按钮挤出。lead 已交 owner。

### 追加3｜noticesHealth 因 Root screen!=Crew 整段隐藏，聊天错误静默 —— ❌ **缺陷（owner 修中）**
CrewUi:510 `if (screen != Screen.Crew){ … noticesLine=noticesHealth.line() … }`。Crew 屏（主聊天）不画 noticesHealth.line() → 推送拉取连续失败（L497 onFailure）在聊天屏**静默无提示**。lead 已交 owner。

## 二、lead 指定：StaleRefreshFailed 是否真 wired —— ❌ **未接线（死代码）**
`ApprovalGateHolder.staleRefreshFailed()`（ApprovalGate.kt:148）与 `Status.StaleRefreshFailed` **全仓无调用点**。实例：`answerByTicket`(CrewUi:1017-1037) 遇 `AnswerStale` 只 `onFailed(...)+Outcome.Stale`→`holder.stale()`；**没有**「stale 后再刷新、刷新失败→StaleRefreshFailed」的分支。故 `Phase.StaleRefreshFailed` 与「刷新失败，可重试读取」文案是**死代码**，lead 关注成立：helper 存在 ≠ wired。二选一修：真接上（stale 后 refresh 的 catch 调 `holder.staleRefreshFailed(detail)`），或删掉死态避免误导。

## 三、我方新增：连接态假红（lead 明确要求核）—— ❌ **缺陷**
`CrewConnectionStatus(problem = problem)`（CrewUi:1445，Triage 同 1073）。`problem` 是 CrewRoot **单一**错误位，被 timeline 刷新失败（L333）、**发送失败**（L422 `problem = error.message ?: "发送失败"`）共用。→ 主聊天里**发消息失败**（网络/校验）会把顶部连接状态刷成红色「连不上」——非连接动作 error 让连通态假红。修法：连接组件只吃**连接/timeline 专属**的 problem（如 refresh 的 catch 单独存 `connProblem`），业务动作错误走别处（composer 下 inline/`sending` 文案）。

### 连接 loading 成功真值 —— ✅ 基本正确
`connLoading = conversation==null && problem==null`（L661）：首份 timeline 未到→loading（灰「连接中」）；到则 `problem==null`→绿。约束「未成功拉回前不绿」成立。唯一被上面的 problem 混用污染（发送失败会把它变红，不代表真断连）。

## 四、menus/会话弹层/48dp —— ✅ 通过
- 更多：DropdownMenu(CrewUi:1480) 含 Board/Models/Backend/Workspace/Sessions 全入口；48×48 命中（1473 `.size(48.dp)`）。
- 会话弹层：`showSessions`→AlertDialog 复用 SessionBar（1495-1510）。
- 触控：连接 48、会话胶囊 48、更多 48、模式段 48、成员条 48、notice 折叠 48（已 40→48）。WaitingLine 使用说明 48（task2）。

## 五、结论
- **源码复核通过项**：①②③④、menus/会话弹层/48dp、连接 loading 真值。
- **缺陷（多为 lead 已交 owner 修中）**：追加1/2/3（Triage 入口死、会话名挤更多、notices 静默）+ StaleRefreshFailed 未接线（死代码）+ 连接态假红（问题混用）。
- 按 lead 指令等 owner 修完 + notice48 冻结后再 build；build 后以最终实码复核上述是否收口，并跑 ConnectionStatusTest/两变体单测/assemble/同签/真机。当前不声称任何缺陷已修。

Not checked：build/真机（等 owner 释放 Gradle）。

## 六、lead 决策（2026-11-15 15:41，待 owner 修完复审）

- **连接假红（本报告三）必修**：必须拆「连接错误」与「操作提示」两条读源——连接组件只读连接/timeline 专属错误；发送等业务动作错误走操作提示，不灌连接态。
- **StaleRefreshFailed**：允许 owner 选 **B = 删除死 phase/helper**；stale 仍保持锁，由**实际可达**的「刷新」/连接错误刷新入口恢复；文案/文档不得虚称「单独卡内读取失败」状态。不要求为 UX 再造刷新框架。**B 可验收，但须严格真实接线**（删死态后 stale 锁要有可达恢复入口）。
- **其余三项 + 48dp 必修**（Triage 入口/会话名挤更多/notices 静默）。
- owner 做完 → 我再复审实码；build 待 lead 放行。
