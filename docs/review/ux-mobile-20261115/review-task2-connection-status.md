# task2 只读审查 · CrewConnectionStatus（wb-ux-verify）

审查时间：2026-11-15 15:33（Asia/Shanghai）。基线 HEAD `1e3c96a3`。仅只读审查，不构建不装。

范围（task2 三文件）：
- `app/app/src/main/java/com/dsh/botcrew/CrewConnectionStatus.kt`（新增 292 行）
- `app/app/src/test/java/com/dsh/botcrew/ConnectionStatusTest.kt`（新增 108 行）
- `app/app/src/main/java/com/dsh/botcrew/MainActivity.kt`（WaitingLine 改动 +40/-2）

口径：ponytail-review + mobile-android-design。

## What this change does

新增一个独立 Compose 组件 `CrewConnectionStatus`：一行 48dp 紧凑摘要（状态点+一句路线），点开 `AlertDialog` 看详情（日常开机联网不睡眠、无需桌面 App、仅服务停止才跑 start 命令）。状态判据抽成纯函数 `statusTone/summaryText/shortSummary` 由 JVM 单测钉住；`MainActivity.WaitingLine` 挂一个「使用说明」小字复用同款详情 Dialog。不碰配对、不自建连接。

## lead 关注点逐条核对

1. **loading/error 真值由调用传入** ✅ 组件只吃 `route/loading/problem/onRefresh` 四个入参，自身不初始化连接、不自判连通。`WaitingLine` 明确传 `loading=true, route=""`（还在连上队伍的过程），详情不会说「已连接」。`statusTone` 优先级 problem>loading>OK，`loading` 绝不绿。测试 `loadingIsNeverGreen/onlySettledNoProblemIsOk/compactLoadingNeverSaysConnected` 钉住。
2. **复制命令仅用户主动** ✅ 命令只是一个 `Text`（`CommandBlock`），无按钮、无自动复制、无自动执行；文案「只复制，本组件不会自动执行」。`startCommandUsesStartNotRestart` 防 restart 误伤在跑服务。
3. **compact 宽度不抢会话空间** ✅ 组件侧正确：`compact` 时不加 `weight(1f)`、不 `fillMaxWidth`，宽度由调用方 `modifier`（建议 `widthIn(max=…)`）约束；非 compact 才 `weight(1f)`。**注**：真正塞进一行顶栏由 task1 的 `CrewUi` 集成决定，本组件已让出控制权（集成面待 task1 完成后一并核对）。
4. **dialog 小屏/大字体可滚动** ❌ **存在缺口，见 Must fix 1。**

## Must fix

1. **详情 Dialog 在小屏/大字体下会被裁切**（`CrewConnectionStatus.kt:L166-188`）
   - **What this is:** `ConnectionDetailDialog` 的 `text` 用普通 `Column(verticalArrangement=spacedBy(10.dp))` 装：summary + 完整 route + `最近错误：$problem`（**不截断，原样全文**）+ 2 条分隔线 + 2 个分区标题 + 4 行指引 + 命令块（11sp，长命令会折 2–3 行）。
   - **Problem:** Material3 `AlertDialog` 对 `text` 槽不明文自动滚动，内容超过对话框最大高度就**裁掉底部**，把「关闭/刷新连接」按钮挤出可视区；`problem` 长串（后端错误原文可能几十上百字符）会显著加高。Android 大字体（`fontScale 1.3~2.0`）或小屏（本项目目标机型 Redmi 24117RK2CC 竖屏）都会触发。这直接违反 lead「dialog 在小屏/大字体可滚动」的验收点。
   - **Fix:** 给 `text` 的 `Column` 加滚动 + 限高，最小改动：
     ```kotlin
     text = {
         Column(
             modifier = Modifier
                 .heightIn(max = 360.dp)          // 或按 availableHeight 比例
                 .verticalScroll(rememberScrollState()),
             verticalArrangement = Arrangement.spacedBy(10.dp),
         ) { … }
     },
     ```
     加 `import androidx.compose.foundation.rememberScrollState`、`androidx.compose.foundation.verticalScroll`（`heightIn` 已 import）。同时建议 `最近错误` 也套 `maxLines`/或保持全文但靠滚动兜住（有了滚动可保留全文）。
   - **If we skip it:** 真机大字体/长错误串时用户看不到「刷新连接/关闭」，只能靠返回键退——体验断点，且正是本次 UX 优化要治的「信息挤出/够不到」。

## Nice to have

2. **`summaryText` 的 problem 截断按字符非按宽度**（`CrewConnectionStatus.kt:L256`）
   - 非 compact 行里 `problem.length>40` 截 40 字，但该 `Text` 本身有 `maxLines=1 + Ellipsis` 兜底，视觉不会溢出（仅作说明，不需改）。可保留。

## 检查过且无问题

- 所有 `CrewPalette` 字段（`card/ink/muted/faint/danger/accent/line/field`）在 `CrewUi.kt:L78-98` 均存在，无编译期缺字段。
- 48dp 触控：摘要行 `heightIn(min=48.dp)`；但 `WaitingLine` 的「使用说明」`Text` 触控区仅 ~vertical padding 4dp+字高，**未达 48dp**（见下：非 lead 本轮硬点，但属触控规格隐患）。
- `shortSummary` 6 字截断 + 12sp，紧凑 chip 宽度可控。
- 单测覆盖三档/摘要/紧凑/命令逐字，含「loading 不得出现已连接」断言，足够。

## 附：触控规格隐患（建议 task1 集成时一并收口）

`MainActivity.kt:L325-332`：「使用说明」可点 `Text` 只有 `padding(vertical=4.dp)`，实际触控高度 ≈ 12sp 行高 + 8dp ≈ 30dp，**低于 48dp**。最小改法：套 `Modifier.heightIn(min=48.dp)` 或 `Box`+`minimumInteractiveComponentSize`。不是阻塞项，但和「正常字体触控≥48dp」目标同类。

## Verdict

**fix 1 后再进真机验证**（dialog 滚动是本轮 lead 明确验收点，小屏/大字体必现）。其余通过。

Not checked：compact 真正并进顶栏一行后的宽度分配（属 task1 `CrewUi` 集成，待 task1 完成统一审）。

---

# 第二轮：wb-connection 修正后复核（2026-11-15 15:29）

wb-connection 称已收口四点（滚动加固/可复制/文案/对比度）并追加 WaitingLine 触控。源码级逐条复核：

| 修正点 | 源码证据 | 结论 |
|---|---|---|
| ① Dialog 正文滚动 | `CrewConnectionStatus.kt:176-178` `Modifier.heightIn(max=360.dp).verticalScroll(rememberScrollState())`；import `rememberScrollState`(L4)/`verticalScroll`(L6) 齐全 | ✅ 通过 |
| ② 命令真可复制 | `CopyableCommand`(L245-)：默认「显示命令」折叠→展开后 `SelectionContainer`(L266) 长按可选中 + 独立「复制命令」按钮(L295) `heightIn(min=48.dp)`(L281) 经 `ClipboardManager.setPrimaryClip`(L287) 写剪贴板 | ✅ 通过（真实可复制，非主张） |
| ③ 文案纠偏 | L194「配对信息已保留；连接失败时先点刷新，并检查 Mac 上的服务是否在跑。」；L198「仅在 Mac 服务停止时运行下面的命令：」；**已无**「已配好就一直是连着」「本组件不会自动执行」 | ✅ 通过 |
| ④ 标题对比度 | `SectionTitle`(L228-229) `color=palette.muted`（原 faint） | ✅ 通过 |
| 附：WaitingLine 触控 | `MainActivity.kt` 「使用说明」`heightIn(min=48.dp)`+`padding(h12,v12)` | ✅ 通过 |

**正确性约束未变**：`statusTone/summaryText/shortSummary`(L310-360) 与首轮逐字一致；loading→WAIT/「正在连接…/连接中」、problem→PROBLEM/「连不上」、绿只在 OK。ConnectionStatusTest 13 单测未变。

**验证阻塞（真实，非本组件问题）**：`./gradlew :app:testDebugUnitTest --tests ConnectionStatusTest` 失败于 `:app:compileDebugKotlin`，报错**全部在 `BoardUi.kt`**（ApprovalGate.Outcome 签名不匹配、doneExpanded/onToggleDone/phase/answering 等参数）——属 task-1 正在编辑的半成品（BoardUi.kt mtime 15:28:51 仍在变，TriageUi.kt/BoardAnswerState.kt 尚未建）。CrewConnectionStatus.kt/MainActivity.kt/ConnectionStatusTest.kt 编译错误数=0。**故 ConnectionStatusTest 此刻无法执行，待 task1 收敛后统一 build 复跑。**

**真机参数（只读采集，未改任何设置）**：物理 1440×3200，density 600dpi→`density=3.75`，`fontScale=1.0`。
- 正常字体逻辑宽 = 1440/3.75 = **384dp**（≈390 画布目标），逻辑高 ≈ **853dp**。
- 控制区 ≤160dp ⇒ 物理 ≤ 600px；≤170dp⇒638px；≤190dp⇒712px。装 App 后真机截图量这组即可。本轮未测大字体（禁改全局 fontScale），需隔离预览或用当前 fontScale 下的 Compose 测量。
