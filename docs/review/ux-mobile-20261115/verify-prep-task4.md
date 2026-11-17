# task4 独立验证 · 只读准备（wb-ux-verify）

准备时间：2026-11-15 15:26（Asia/Shanghai）。基线 HEAD `1e3c96a344297626b9ce0d9df16f31d1aa64af28`（feat/four-blocks）。

本文件仅记录**验证路径与入口**，不构建、不安装、不操作手机、不改源码。task4 被 task-1/task-2 阻塞，等 lead 放行后 claim 执行。

## 一、当前现场（只读核对）

- 设备：`adb devices` → `9f9cc3db  device`（Redmi 24117RK2CC / Android 16），在线。
- `com.dsh.botcrew` versionName `0.1.0`，release non-debuggable；`firstInstallTime=2026-11-11 18:15:06`（本轮验证须保持此值不变），`lastUpdateTime=2026-11-15 15:07:29`。
- 工作树他人/产物改动（勿覆盖、勿清理）：`M HANDOFF.md`、`M MainActivity.kt`、`?? CrewConnectionStatus.kt`、`?? ConnectionStatusTest.kt`、`?? app/.kotlin/`、`?? backend/.backup-publish-*/`（不读）、`?? designs/crew-mobile-ux/`、`?? docs/review/final-android/deliver/`、`?? scripts/crew-watch/`。
- 现有交付 APK `dsh-botcrew-internal-final-20261115-0133-answer.apk` sha256 `44d77995…32d29fc`（未被覆盖）。

## 二、构建工具链入口（关键坑）

- **必须用 JDK 21**：默认 `java` 是 JDK 25，Gradle 8.11.1 直接 `FAILURE ... 25`。已验证 `JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.9/libexec/openjdk.jdk/Contents/Home ./gradlew :app:tasks` 正常列出任务。
- 目录：`app/`（Gradle wrapper `./gradlew`），模块 `:app`。
- 相关任务（已确认存在）：
  - `testDebugUnitTest`、`testReleaseUnitTest`（JVM 单测）
  - `assembleDebug`、`assembleRelease`
- 环境变量（名，不含值）：`JAVA_HOME`（指向 JDK21）。
- release 变体**无项目 signingConfig**（`app/app/build.gradle.kts` 无 storeFile/kael 配置）→ 沿用与设备现有安装**同一把 debug key** 才能 `install -r` 保留配对/数据。

## 三、签名入口（文件路径与变量名，不输出值）

- keystore：`~/.android/debug.keystore`（`CN=Android Debug`，设备证书 signer `29b26ea2`）。
- 签名工具：`$HOME/Library/Android/sdk/build-tools/36.0.0/apksigner`（同目录还有 35.0.0/35.0.1）。
- 流程：`assembleRelease` → `app-release-unsigned.apk` → apksigner 用 debug key 签成 `app-release-signed.apk` → 校验 signer 与设备 `29b26ea2` 一致 → 记录 sha256。
- 变量名：`JAVA_HOME`、keystore 路径、apksigner 路径、`ANDROID_SERIAL`（`9f9cc3db`）。
- **签名/安装仅在 lead 发最终指令后执行**，准备阶段不跑。

## 四、独立验收路径（放行后执行顺序）

1. **审最终 diff**（ponytail-review 口径）：`git diff 1e3c96a3 -- app/app/src/main/java app/app/src/test`。逐文件核对：
   - 首屏应用控制区 ≤160dp 左右、正常字体触控 ≥48dp。
   - 消息任务优先（占可用区 ≥65%）；连接/会话/更多合并一行；移除大标题；成员紧凑且明确「发给谁」；通知折叠。
   - 成员选择走真实 mentions 路由且**不丢 draft**。
   - 办完默认折叠；未知状态诚实展示。
   - 审批同题互斥；提交中无成功勾号；失败保留 draft；stale 不假成功。
   - 连接三档（loading/problem/ok）不冒充已连接（ConnectionStatusTest 钉住 tone）。
2. **JVM 单测**（JDK21）：`./gradlew :app:testDebugUnitTest :app:testReleaseUnitTest`。关注：ConnectionStatusTest、BoardUiTest、RecipientSelectionTest、ApprovalFeedbackTest。基线：release/debug 各 429（本批新增 ConnectionStatusTest 等，数量应只增）。task1 说明 test 排除 `ConnectionStatusTest.kt`，执行时按 lead 最终口径确认。
3. **assemble 正式 release**：`./gradlew :app:assembleRelease` → 签名 → sha256 + apksigner verify（signer `29b26ea2`）。
4. **真机只读 UI 验证**（放行后、lead 明确指令后）：确认 `firstInstallTime` 不变、配对/历史/session main/work 保留、首屏控制区实测高度（截图量高）。不锁屏、不动系统设置、不碰其它 app、不重启后台、不 open Mac 窗口抢焦点。
5. **审批验证边界**：生产缺真实任务时不造假成功；只在隔离 fixture 验证审批同题互斥/pending/stale，不发生产演示/canary 消息。
6. 结论写回本目录（review 文档），源码修正交回 owner，不改源码、不更新进度（归 lead 指派成员）。

## 五、lead 预置决策（2026-11-15 15:30）

- **安装前置**：源码评审 + 两变体单测 + assemble + 同签验证全通过后，可对 9f9cc3db 做 `adb install -r`（仅覆盖不卸载不清数据），保 firstInstallTime 与配对历史。实际执行前先报 lead 前置检查结果；lead 发现阻断即时叫停。
- 以当前现场读取的时间/签名为准，不硬套历史另时区值。
- 审批缺真生产待决票时用纯状态测试 + 隔离 fixture；**不点生产历史审批、不发新业务任务**。
- 截图保存到 `docs/review/ux-mobile-20261115/`（本目录）。

## 六、安装后 App 内只读/交互测试清单（不发送业务消息）

只 App 内操作，Mac 不动输入、不抢焦点。逐项截图留证：

1. **主界面**：控制区实测高度 ≤160dp（截图量高）、消息/任务区优先、触控 ≥48dp。存 `01-main.png`。
2. **成员切换不发送**：点成员选择器切换「发给谁」，确认输入区 draft 不丢、mentions 真实路由（不清空/不误发），不发送。存 `02-member-pick.png`。
3. **会话切换**：main↔work 切换正常、历史保留。存 `03-session.png`。
4. **更多菜单**：原入口都在（紧凑更多/弹层）。存 `04-more.png`。
5. **通知折叠**：折叠为摘要、可展开。存 `05-notice-fold.png`。
6. **任务/审批折叠**：办完默认折叠；pending/受理/stale/失败反馈如实（无假成功勾号）。生产无待决票则仅看折叠态，审批状态面走隔离 fixture。存 `06-task-fold.png`。
- 若手机锁屏：不触锁屏/系统设置，直接报告 lead 由 lead 决策。

## 七、状态

- 准备工作完成，含 lead 安装预置与安装后测试清单。
- task4 仍被 task-1/task-2 阻塞（未 ready）。**先勿构建**。
- 等 task1/2 完成 + lead 放行后 claim 执行正式验证。

## 八、统一 build 前口径（lead 定稿 2026-11-15 15:31）

- **严格等 task1 完成 / owner 释放 Gradle 再统一跑**；不再尝试半成品编译（施工态编译失败属正常进展，非阻塞）。
- **首屏口径**：真机 `density=3.75`、`fontScale=1.0` → 逻辑 **384×853dp**（≈390 画布目标）。
  - 应用控制区 **≈148dp ≈ 555px**（148×3.75）；若按 ≤160dp 上限则 ≤600px。
  - 系统 insets 另量：当前 cutout top=161px ≈ **42.9dp**（状态栏）。截图对照「应用控制区高度」时区分是否含系统 insets。
- 安装后真机只读 UI：截图量应用控制区像素高 / 3.75 = dp，与 148dp（555px）对照记录，不判死档、只记录实测。
- 大字体：禁改全局 fontScale，只在隔离预览按当前 fontScale 观察。
- 统一 build 执行序（放行后）：ConnectionStatusTest → 两变体单测 → assembleRelease → 同签校验(signer 29b26ea2) → 真机同签 install -r（保 firstInstallTime/配对）→ 六项 UI 截图 → 结论落本目录。

## 九、进度台账

- **task-2（wb-connection）已 complete**（task 状态 completed）。边界核实：严格 3 文件，`MainActivity.kt` 仅 WaitingLine+imports（43+/2-，连接初始化未动），`CrewConnectionStatus.kt`/`ConnectionStatusTest.kt` 新增；未碰 CrewUi/BoardUi/TriageUi/服务/配对。源码级复核四点+触控全 PASS（见 review-task2-connection-status.md 第二轮节）。
- **task-1（wb-mobile-implement）进行中**：BoardUi/ApprovalGate/Recipient 仍在改，TriageUi.kt/BoardAnswerState.kt 尚未建。等其完成/释放 Gradle。
- 剩余：统一 build（等 task1）→ ConnectionStatusTest→两变体单测→assembleRelease→同签→真机 install -r→六项 UI 截图→结论。
- 当前只读待命，不碰 Gradle。

## 十、最终独立 review 重点（lead 下达，待 task1 出实码后逐条验，不采信 owner 主张）

lead 施工中已要求 owner 修以下，最终须读**实码**确认：

1. **Recipient 多 mention + @id 显式切换**：确保 `mentionsIn.first() == 目标`，且切换成员时**保留正文**（draft 不丢）。
2. **Approval holder 签名在 Submitting 期间变化后旧 HTTP 返回隔离**：避免旧返回把**新题**锁错（同一 holder 在提交中被换题，旧响应不得作用到新题）。
3. **Board 多张 deciding 不得用全局单 gate / first signature 锁全部题**：锁必须 **ticket + signature 粒度**，不能一个全局单锁把多题串死。
4. **待决排序第一**；**Triage 去掉常驻 58dp「丢一件进来」大按钮**（底部已有输入）以保护内容空间。

验证方式：读 `Recipient.kt`/`ApprovalGate.kt`/`BoardUi.kt`/`TriageUi.kt`/`BoardAnswerState.kt` 实码 + 对应单测（RecipientSelectionTest/ApprovalFeedbackTest/BoardUiTest），逐条给证据行号，owner 声称不算通过。若实码与主张不符，直发 owner 并抄 lead。

## 十一、task4 执行结果（2026-11-15 15:47）

### 源码门禁 6 项（最终实码，全部 PASS）
1. 连接双通道：problem(仅 timeline catch L336)/operationNote(发送 L425、答复 L641)/noticesWarning(L631) 分离；CrewConnectionStatus 只吃 problem → 发消息失败不再假红 ✅
2. StaleRefreshFailed 死态已删；Phase=Idle/Submitting/Accepted/Stale；stale 保持锁+「请按最新那张」、onSent() 触 refresh 由签名收敛 ✅
3. Triage onOpenBoard={switchMode(Chat);boardOpen=true}(L1089)→Chat 分支 BoardDrawer(L1423) 可达 ✅
4. 会话胶囊 widthIn(max=132.dp)+ellipsis，更多恒 48 ✅
5. noticesWarning 在 Crew 屏按需显示(L1198)，不吞 ✅
6. 触控：BoardDrawer 关闭「×」40→48(L285) 修完；全局仅剩 6dp 非交互装饰 ✅

### 统一 build（JDK21，独占 Gradle）
- `testDebugUnitTest` = 458 tests / 0 fail / 0 err / 0 skip（56 files）
- `testReleaseUnitTest` = 458 / 0 / 0 / 0（56 files）
- `assembleRelease` + `assembleDebug` BUILD SUCCESSFUL。

### 签名 + 安装
- 签名 keystore `~/.android/debug.keystore`（CN=Android Debug），signer cert SHA-256 `ad0e4480…af7eb`，**与设备已装 base.apk 签名逐字节一致**。
- 新 APK：`app/app/build/outputs/apk/release/app-release-signed.apk`
  sha256 `31e96cd6eb6ef0fe5584ce519ef1b383066cd26c7c8b113b8cb47b51c7ba57a8`
- `adb install -r` → **Success**。装后 device base.apk sha256 = `31e96cd6…ba57a8`（= 我签的 APK）。
- **firstInstallTime 2026-11-11 18:15:06 未变**（保配对/历史）；lastUpdateTime→15:46:05；versionName 0.1.0；signatures 29b26ea2。

### 真机 UI 六项截图 —— ⛔ 受阻（设备锁屏）
- 现场：`state OFF / mAwake=false / isKeyguardShowing=true / deviceLocked=1`（**安全 PIN 锁屏**）。
- KEYCODE_WAKEUP 仅亮屏，仍停在安全 keyguard（锁屏时钟 03:46+媒体通知），未解锁。
- 按 lead 规则「手机锁屏不触锁屏设置直接报告」：**不输 PIN、不解除锁定屏**，六项 App 内 UI 截图**未执行**。
- 证据图：`lock-state-blocker.png`（当前锁屏态）。
- 待 lead 决策：用户解锁后我可立即补截图六项（主界面/成员切换不发送/会话切换/更多/通知折叠/任务折叠），全程仅 App 内、Mac 不动输入。
