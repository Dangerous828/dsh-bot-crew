# Bot Crew 手机端 · 单行顶栏 + 侧边栏（drawer）· 最终交付报告

日期：2026-11-15（Asia/Shanghai）。执行：wb-drawer-verify（真实 WorkBuddy DeepSeek 独立验证成员，独立于实现）。
基线 HEAD：`1e3c96a344297626b9ce0d9df16f31d1aa64af28`（feat/four-blocks，本轮未 commit/push）。

> 本报告只呈现当前版本本身。变更过程见各轮 review 记录；不复述旧版对比。

---

## 一、结论速览

| 阶段 | 状态 | 证据 |
|---|---|---|
| 源码独立 review（两轮） | ✅ 通过（首冻版发现 2 必修，owner 修后复审通过） | §三 |
| 最小门禁 compileDebugKotlin | ✅ exit 0 | §四 |
| DrawerNavigationTest（专项） | ✅ **20/20**（0 fail/err/skip） | §四 |
| assembleRelease | ✅ BUILD SUCCESSFUL | §四 |
| 同签校验 | ✅ cert SHA-256 与设备一致 | §五 |
| 同签 install -r | ✅ Success，firstInstallTime 保留 | §六 |
| 真机 App 内 UI 全项 | ✅ **OPPO PEDM00 / 55c86317 实测通过** | §七 |

472 全量为上一 checkpoint（同方案、更早一版）完整门禁；本次为**焦点/Back/通知/role 专项**最小复验（20 专项 + assemble），按 lead 指示不重跑全量 472。

---

## 二、交付物

- **签名 APK**：[`deliver/dsh-botcrew-sidebar-20261115-signed.apk`](</Users/cpuser/Code/dsh-bot-crew/docs/review/ux-sidebar-20261115/deliver/dsh-botcrew-sidebar-20261115-signed.apk>)
  - **sha256**：`e6450ee395a3a86f55f294e5b6fb4ab13702585aa4ea30206fc0161275822ed2`
  - 包名 `com.dsh.botcrew`，versionName `0.1.0`，release 非 debuggable（debug key 同签，见 §五）。
- 过程记录：`verify-prep-task8.md`（准备台账 + 两轮 review）、`ref-design-*.png`（设计参）。

---

## 三、源码独立 review（两轮，独立于实现）

### 3.1 首冻版必修（已由 owner 修复，复审通过）

1. **drawer「会话管理」死入口**：两分支 `onSessions` 仅 `drawerState.close()`，不弹会话面板。修：上提 `showSessions` 为 CrewScreen 单一真源，drawer 与顶栏点会话共用，`onSessions = { openSessions(); close }`，两分支一套 `ModalNavigationDrawer`。
2. **Triage「资料」死**：`onOpenProfile` 仅设 `profile=bot`，而 `BotCardSheet` 原只在 Chat 分支渲染。修：统一 `openProfile`（设 profile、非 Chat 先切 Chat、关 drawer），两分支都渲染 `ProfileOverlay`。

### 3.2 第二轮（最终版）复验点（实码 + 真机双证）

- **BackHandler**：`BackHandler(enabled = drawerState.isOpen) { scope.launch { drawerState.close() } }` 挂在 shared drawer 同一 `drawerState`。真机：drawer 开→单 back→焦点仍 `botcrew/MainActivity`（不退 launcher）。
- **通知导航**：drawer 导航区「通知 · N」（`CrewNavigation.noticeRowLabel`，真实 `notices.size`，仅 >0 画）；点→ `switchMode(Chat)` + `pendingNoticeJump=true` + 关 drawer；聊天分支 `LaunchedEffect(pendingNoticeJump)` 一帧后 `scrollToItem(CrewNavigation.noticeItemIndex())`（纯函数恒返首项 0，不伪造 message id、不发请求、不清通知）。正常消息 `pendingJump` 偏移不变（逐处 `messagesListOffsetIfNotice`）。
- **role 中文化**：`CrewNavigation.roleLabel`：default→「默认接话」、member→「成员」、未知→「角色：…」、空→不画；**只改显示，不动 role 真值/路由**。
- **onTalk 焦点**：不再固定帧盲 `requestFocus`。`focusWhenPlaced` armed 标记从 onTalk 传到 ComposerRow，TextField `onGloballyPositioned` 判 `coords.isAttached` 后一次性 `requestFocus()+keyboard.show()`，成功回调清标记（`focusFired` 一次性守卫防每帧重复），失败 `Log.w` 不静默吞；仅显式 onTalk 置位（导航/进页/切会话不弹键盘、不抢系统焦点）。
- **会话唯一真源**：单一 `sessionState`（CrewRoot）+ 单一 `showSessions`；drawer 不建第二份。
- **收件人真实语义**：输入区 label 来自 `CrewNavigation.recipientLabel(draft, bots, defaultBotId)`；没点名走后端 `default_bot_id`（`conversation.defaultBotId`，后端真值），读不到报「未指定」，**不硬编码第一位**。
- **草稿保留**：`Recipient.select` 保正文、不叠多个 @；成员选人/切页/开 drawer draft 不丢。
- **审批不回退**：`ApprovalGate` 同题互斥（Submitting/Accepted/Stale）、`stillSameTicket()` 换票隔离、按 `ticket.id|attentionId` 各持一份，A/B 不互锁、409 stale 锁+刷新，行为与上批一致。
- **无死码**：旧 `ModeHeader`/`ModeRow`/`MemberRow`/`GlassIconButton`/`BackendIconButton` 已删。

---

## 四、构建与测试（JDK 21，验证方独占 Gradle，串行不并发）

- `JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.9/libexec/openjdk.jdk/Contents/Home`（系统 JDK25 与 Gradle 8.11.1 不兼容）。
- `:app:compileDebugKotlin` → exit 0
- `:app:testDebugUnitTest --tests DrawerNavigationTest` → **20 tests / 0 fail / 0 err / 0 skip**
- `:app:assembleRelease` → **BUILD SUCCESSFUL**
- 未复跑全量 472（上批 checkpoint 已完整门禁；本批仅焦点/Back/通知/role 改动，按 lead 指示跑专项 20）。

---

## 五、签名与证书（同签判据）

- keystore：`~/.android/debug.keystore`，别名 `androiddebugkey`，`CN=Android Debug`（release 变体沿用同 key 才能 install -r 保数据）。
- **cert SHA-256（权威同一性）= `AD:0E:44:80:41:42:14:86:25:CE:90:42:7C:E3:83:27:47:C2:9B:79:56:40:CF:B4:51:74:5B:44:54:0A:F7:EB`**；新 APK 与设备已装 base.apk 两侧 `apksigner --print-certs` 均一致。
- `29b26ea2` 是 PackageManager 签名对象 hash（另一表示法，同一证书），不冒充 cert SHA-256。

---

## 六、安装与数据保留

- `adb -s 55c86317 install -r` → **Success**（Incremental）。
- 装后 device base.apk sha256 = `e6450ee3…822ed2` = 我签的包。
- **firstInstallTime = 2026-11-11 22:27:11 未变**（未卸载未清数据 → 配对/历史/session main/work 保留）；lastUpdateTime → 2026-11-15 17:00:47；versionName 0.1.0。
- 全程未发业务测试消息、未点生产审批、未重启服务、未触配对/清数据/卸载、Mac 无输入。

---

## 七、真机 App 内 UI（OPPO PEDM00 / 55c86317，逐项实测，截图本目录）

| # | 项 | 结果 | 截图 |
|---|---|---|---|
| 1 | 首屏单行顶栏（☰ · 会话 · 连接）+ 消息占满 + 输入区（收件人⌄·语音·正文·发送） | ✅ | 01-main.png |
| 2 | Drawer 300dp 可滚；导航(聊天selected/任务·分拣台/通知·1)、成员(大哥默认接话[选中]/写手·成员/码农·成员，各带资料)、工具；遮罩压暗 | ✅ | 11-drawer-roles-cn.png / 02-drawer.png |
| 3 | **系统 back 关 drawer，不退 App**（焦点仍 MainActivity） | ✅ | 10-back-stays.png |
| 4 | **遮罩点击关 drawer**（App 仍前台） | ✅ | 05-scrim-close.png |
| 5 | **通知导航**：drawer「通知·1」→关 drawer+切 Chat+滚到首项摘要；展开显示全文变收起 | ✅ | 12-notice-jump.png / 13-notice-expanded.png |
| 6 | 成员选人不发送：点「写手」→收件人变写手、正文 `@写手 `、未发送 | ✅ | 06-member-switch.png |
| 7 | 任务页顶「任务 · main ▾」区分所在页；办完默认折叠；底部输入 | ✅ | 07-tasks.png |
| 8 | 任务页「资料」→自动切 Chat 显示名片 | ✅ | 08-tasks-profile.png |
| 9 | 名片「跟他说话」→profile 关、正文 `@大哥`、**EditText focused=true + IME 弹出** | ✅ | 14-ontalk-focus-final.png |
| 10 | drawer「会话管理」→弹真实 SessionBar(main/work/新建) | ✅ | 03-drawer-sessions.png |
| 11 | **最终态**：main 聊天、空草稿（占位「跟队伍说点什么」）、drawer 关、无键盘 | ✅ | 15-final-main-empty.png |

### 7.1 实测 touch bounds（density 4.0，原 px/4 = dp）

- ☰ 汉堡：192×192 px = **48×48 dp** ✓
- 会话胶囊：947×192 = 237×48 dp ✓
- 连接状态：221×192 = 55×48 dp ✓
- 输入区收件人按钮：199×192 = **49.75×48 dp** ✓
- 输入正文宽：543×224 = **136 dp** 可用（按剩余宽自适应，非固定 180）
- **发送 clickable Box：298×192 = 74.5×48 dp** ✓（内层文本节点视觉更小，但语义点击 bounds 48 高，达标）
- drawer 导航/成员行/资料/工具项：均 heightIn(min 48)；资料 `view 48`。

### 7.2 尺寸口径

- 顶栏代码布局 `.height(56.dp)`；**系统状态栏/导航栏高度由系统决定，本次不冒充容器精测**。凡「56dp」均为代码布局值，不作真机整体容器 dp/百分比断言（避免以语义子节点 bounds 冒充整体容器）。
- drawer 宽 `widthIn(max=300.dp)`；真机抽屉右侧约 300dp（截图佐证），遮罩露出背后页。

---

## 八、边界与状态

- 全程仅 App 内操作：未发业务消息/审批、未删通知、未改系统设置/网络/通知、未碰其它 App、未卸载未清数据、Mac 无桌面输入/焦点抢占。
- task-8 完成。交付机 OPPO PEDM00 / 55c86317；配对历史/session main/work 保留（firstInstallTime 未变）。
