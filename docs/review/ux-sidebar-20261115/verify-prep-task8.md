# task-8 侧边栏真机流程 · 只读准备台账（wb-drawer-verify）

时间：2026-11-15 16:43 CST。本文件为**只读准备**，不代表 task-7 实现已开始或已可验证。
task-8 仍 blocked_by task-7（pending，blocked_by task-6 in_progress）。

## 一、依赖与门禁状态（读时快照）

- task-6 设计（`wb-drawer-design`，`designs/crew-mobile-ux/project`）：**in_progress**，`Drawer.dc.html`/`Main.dc.html`/`Tasks.dc.html` 于 16:42 仍在写。
- task-7 实施（改 CrewUi/BoardUi + DrawerNavigationTest）：**pending**，尚未开始；源码未冻结。
- task-8（本成员）：**pending**，blocked_by task-7。**agent 不抢跑**：不对半成品跑编译，等 lead 通知源码冻结且 Gradle 释放后再 claim。

## 二、设备身份（已重新识别，符合授权目标）

- `adb devices -l` → `55c86317 device usb:... product:PEDM00 model:PEDM00 device:OP4E5D`。
  **即 OPPO PEDM00 / 55c86317**，= 用户明确要求的目标机。未切换别的设备（Redmi 9f 不在线，未尝试）。
- 屏幕：`mWakefulness=Awake`（非锁屏）。未做任何解锁/PIN/改设置。未抢 Mac 焦点、未启动桌面 App。

## 三、安装基线（同签覆盖的前置，全部与上次交付一致）

| 项 | 值 |
|---|---|
| 包名 | `com.dsh.botcrew` |
| versionName | `0.1.0` |
| firstInstallTime | **2026-11-11 22:27:11**（保留，未卸载未清数据） |
| lastUpdateTime | 2026-11-15 16:27:42 |
| 设备已装 base.apk sha256 | `ed5972a3d0fec373ffe90590ecc92ad3edfc96e4f162e5da02e99bcd26a75dc0` |
| 上次交付 APK sha256 | `ed5972a3…5dc0`（与设备已装逐字节一致 → 验证基线干净） |
| 设备 base.apk cert SHA-256 | `ad0e44804142148625ce90427ce3832747c29b795640cfb451745b44540af7eb` |
| 交付 APK cert SHA-256 | `ad0e4480…af7eb`（= 设备，同证） |
| 签名 keystore | `~/.android/debug.keystore`，别名 `androiddebugkey`，cert SHA-256 `AD:0E:44…F7:EB`（同证） |

→ **同签 install -r 条件成立**（本次优化已含同签覆盖授权，无需再询问）。`29b26ea2` 仍是 PackageManager 签名对象 hash，不是 cert SHA-256，不混用。

## 四、工具链（就绪）

- JDK：`/opt/homebrew/Cellar/openjdk@21/21.0.9`（系统 JDK25 会致 Gradle 失败，必须 21）。
- Gradle wrapper：8.11.1（`app/gradle/wrapper/gradle-wrapper.properties`）。
- SDK build-tools：`~/Library/Android/sdk/build-tools/{34,35.0.0,35.0.1,36}`，`apksigner` 用 35.0.1。
- `local.properties` 的 `sdk.dir` 已设。

## 五、当前源码结构（review 基线，等 task-7 改后对比）

- `CrewUi.kt`（4421 行）：现为 **3 行控制区** —— `CrewTopBar`（52dp：连接胶囊≤120 · 会话胶囊≤132 · ⋯更多）→ `ModeRow`（48dp：聊天/分拣台）→ `MemberRow`（48dp：「发给」成员胶囊，`Recipient.select` 落 @名字）。Triage 分支（`mode==Triage`）同样 top bar + ModeRow，后者 early return。
- 输入区 `Composer`/`ComposerRow`：麦克风 + `OutlinedTextField`（占位「跟队伍说点什么」）+ 可选「插队」+ 发送。**当前输入区不显示实际收件人**（收件人只在 MemberRow 高亮 + draft 里 @名字）。
- `BoardUi.kt` `BoardDrawer`（右侧 306dp Dialog 抽屉，遮罩点击关闭，× 48dp）—— 与原生 NavigationDrawer 不同，是自定义右侧 Dialog。
- 测试现有：`ApprovalFeedbackTest` / `BoardUiTest` / `ConnectionStatusTest` / `RecipientSelectionTest`。task-7 将新增 `DrawerNavigationTest.kt`。

## 六、设计目标（task-6 Drawer.dc.html 已读，作验收参照）

- 单行顶栏 **56dp**：`☰ 菜单` · 会话名（如 main）· 右侧连接点 + 「局域网」。**无常驻模式行 / 成员行**。
- 原生 `ModalNavigationDrawer` 语义：宽 **300dp**，分组「常用导航 → 成员 → 工具」，内容可滚动，**系统 back / 点遮罩关闭**。
- 输入区显示**实际收件人**；通知进可滚动列表紧凑处理。

## 七、task-8 待验证清单（源码冻结后执行，现不跑）

1. **实际 diff 审查**（CrewUi/BoardUi/DrawerNavigationTest）：逐条对照旧 3 行动作/入口是否 **零丢失**（连接、会话管理、模式切换、成员选人+名片、事务板、模型、后台、看屏幕）。
2. **会话唯一真源**：drawer 里的会话/成员/导航不改 `sessionState` 单一 sources，不臆造第二份。
3. **收件人以实际 mentions/default 语义**：输入区显示必须来自 `Recipient.primaryRecipient()` / `mentionsIn` 真实语义，非独立状态。
4. **草稿保留**：drawer 开关、选人、切会话前后 draft 不丢；`Recipient.select` 保正文、不叠多个 @。
5. **返回与 drawer 系统 back / 遮罩**：系统 back 先关 drawer 再退屏；点遮罩关闭；不吞返回键。
6. **触控 ≥48dp**：菜单/会话/连接/成员项/导航项/关闭均 ≥48。
7. **长名与大字不挤 menu/连接**：会话名 `widthIn` + ellipsis，连接点不被挤压（大字/长名压力）。
8. **connection 色不随 Triage 变红**：健康点仍为 `connectionGreen(surface)` 固定语义绿，不复用 accent。
9. **审批逻辑不回退**：`ApprovalGate` / `BoardAnswerState` 按 ticket.id 隔离、Submissive 换题锁定、A/B 不互锁保持。
10. **两变体 JVM + assembleRelease**：debug/release 单测全绿 + assembleRelease 通过（用 JDK21，验证方独占 Gradle）。
11. **同签 install -r Success**：base hash=新包、firstInstallTime 保留。
12. **App 内真机流程**：drawer 开关 → 成员选人草稿不发送 → main/work 切换 → 导航「更多」每项可达 → 通知滚动展开 → 任务折叠 → 最终 main 聊天空草稿关闭 drawer。**截图真实视觉验收**；准确尺寸须容器 bounds 证据才说，不凭代码常量+语义子节点 bounds 编造容器 dp/比例。

## 七·补 A、task-6 设计终稿已交付（16:43 收到 handoff，画布 http://127.0.0.1:4720/design/qoSrF9Btc6KNHVP5iaxDGD/）

三画板参考截图已存本目录：`ref-design-Main.png` / `ref-design-Drawer.png` / `ref-design-Tasks.png`。交接文档：`designs/crew-mobile-ux/project/IMPLEMENTATION.md`。设计方给的**真机验收关注点**，纳入我方 checklist：

1. 顶部唯一常驻行 ~56dp、三件（menu/会话/连接）均 ≥48 命中、**无**模式行/成员横条/更多⋯常驻。
2. 任务页顶部显示「任务 · 会话」**可区分所在页**（聊天页仅会话名）。
3. drawer 300dp **可滚**、**系统 back / 遮罩关**；**导航 selected=当前页** vs **成员 selected(aria-pressed)=实际主收件人** 区分；成员行尾 **「资料」可点**（不止长按）。
4. 输入区收件人 **label 可点开 drawer 选人**、**正文不被 chip 挤压**、**默认收件人来自后端 default 而非硬编码第一位**（后端无 role/default 字段则显示「未指定」，不造 default）。
5. 通知 = **列表内一条可展开**（默认一行摘要，展开全文，保留历史），**非独立常驻块**。
6. **真机系统栏真实高度以实测为准**，不以画布 24dp 假设当实测。

设计口径 vs 真机实测严格分开（IMPLEMENTATION §九）；真机通过前不标「已验证」。画布口径 56dp 单行 + 安全区 24 = 80dp 画布目标，**非容器实测**。

## 七·补 B、当前实施进度（读时）

- task-7（`wb-drawer-impl`）**尚未动代码**：`CrewUi.kt`/`BoardUi.kt` mtime 仍是 15:42/15:44（上一批 UX），`DrawerNavigationTest.kt` 仍不存在。
- → 继续 blocked，等源码冻结再整包验证，不中途对半成品跑编译。

## 七·补 C、lead 终稿更正（2026-11-15 16:5x，以此为准，覆盖 IMPLEMENTATION §四两层写法）

- **输入区改 64dp 单行**：左 48×48（~最大 64dp）**收件人短名按钮** + 正文 `weight` + 发送 48/64。**不采用**设计文档 §四「两层 label48 + 正文48」的命中重叠方案。验证时以此实测口径为准。
- **notice 进 LazyColumn**：索引/消息跳转/新消息滚动**不得错位**（原独立块改列表项后，jump/pendingJump/scrollToItem 的 index 要按含 notice 的实际列表算）。
- **drawer 开名片**：必须先关 drawer 再开名片；`onTalk` 请求 `composerFocus` 要等 TextField 附着后再 requestFocus（不能立即抢焦点落空）。
- 流程纪律：lead 已批 task6、task7 已开工 → **静默等源码冻结**，不再报 mtime/未建文件，不写多份待命台账，不 render 画板/不再额外浏览器截图（claude-design 仅只读 check），独立验证只看真实 App 截图。

## 七·补 D、第一轮 code review 必修（2026-11-15 首冻版，lead 已同向确认并交 owner 修，暂缓安装/全构建）

逐 handler 实码审两分支（Chat / Triage），所有**启用**入口不能只是 close drawer：

1. **`onSessions` 两分支皆死**（CrewUi ~1113 / ~1163）：`{ scope.launch { drawerState.close() } }` 只关抽屉，
   不打开任何会话管理面板。旧「更多 → 会话管理」会 `showSessions=true` 弹 `SessionBar`；现在 `showSessions`
   是 `CrewTopBar` 内部局部态，drawer 够不到 → 「会话管理」点了没反应。**必修**：上提共用 showSessions 并接真实 SessionBar。
2. **Triage `onOpenProfile` 死**（~1110）：`profile = bot; drawerState.close()`，但 `BotCardSheet` 只在 **Chat 分支**
   （CrewUi:1208）渲染，Triage 分支无此渲染 → 分拣台里「资料」设了 profile 却不画名片；且该 profile 残留到切回 Chat
   会意外弹出。**必修**：Triage 分支补 BotCardSheet 渲染（或统一到一处）。
3. **发送按钮触控**（ComposerRow ~4228）：Material3 `Button` 无显式 size，默认 min 高 ~40dp < 48。
   lead 终稿更正口径「发送 48/64」，需核对是否 ≥48 命中（真机 XML 复核 bounds 后再定，不凭记忆）。
4. 已核对**无问题**：onPickRecipient / onNavChat / onNavTasks(chat→triage、triage 自身仅 close 合理) /
   onBoard(两分支语义正确) / onModels / onBackend / onWorkspace 均接真实回调再 close；`defaultBotId` 来自
   `conversation.default_bot_id`（后端真值，非硬编码第一位）；`ApprovalGate` 互斥/受理/stale/换票隔离逻辑不回退；
   notice 偏移（pendingJump + bottom() 逐处 `messagesListOffsetIfNotice`，atBottom 用 totalItemsCount 自适应）正确；
   ModeHeader/ModeRow/MemberRow/GlassIconButton/BackendIconButton 已删无死码；顶栏 Row 固定 `.height(56.dp)`。
- 结论：**首冻版不通过**，等 owner 修 1/2 后再冻结，重审全 handler，再跑构建。

## 八、本回合动作边界

- 仅只读准备；**未编译半成品**、未安装、未发业务消息/审批、未改设置/网络、未碰 Mac 输入。
- 等 lead 通知：task-6 设计评审通过 + task-7 源码冻结 + Gradle 空闲 → 再 claim task-8、升级 task-7→task-8 依赖、跑构建与真机验证、写最终报告并更新进度索引（`开发进度.md` / `docs/review/README.md`）。

## 九、最终收口（2026-11-15，task-8 完成）

- **门禁**：compileDebugKotlin exit0；DrawerNavigationTest **20/20**；assembleRelease BUILD SUCCESSFUL。472×2 全量为上一 checkpoint（更早一版同方案）完整门禁；本批跑焦点/Back/通知/role 专项 20 最小复验，不重跑全量。
- **最终 APK**：`deliver/dsh-botcrew-sidebar-20261115-signed.apk`，sha256 `e6450ee395a3a86f55f294e5b6fb4ab13702585aa4ea30206fc0161275822ed2`，cert SHA-256 `ad0e4480…af7eb`（同签）。install-r Success，firstInstallTime `2026-11-11 22:27:11` 未变（配对/历史/main·work 保留），lastUpdateTime 17:00:47。
- **真机全项通过**（OPPO 55c86317）：见 `2026-11-15-sidebar-delivery.md` §七；01/10/11/12/13/14/15 等截图。
- **两处必修已由 owner 修并复审通过**：drawer 会话管理死入口、Triage 资料死；另 owner 修 onTalk 焦点（onGloballyPositioned+isAttached 一次性 requestFocus+IME）与 BackHandler、通知导航、role 中文化。
- 最终态：main 聊天、空草稿、drawer 关、无键盘（15-final-main-empty.png）。
- 未 commit/push；未发消息/审批、未删通知、未改设置/网络、未卸载清数据、Mac 无输入。
