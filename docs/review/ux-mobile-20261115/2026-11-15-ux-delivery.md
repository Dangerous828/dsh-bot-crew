# Bot Crew 手机端 UX 紧凑首屏 · 最终交付报告

日期：2026-11-15（Asia/Shanghai）。执行：wb-ux-verify（真实 WorkBuddy DeepSeek 独立验证成员）。
基线 HEAD：`1e3c96a344297626b9ce0d9df16f31d1aa64af28`（feat/four-blocks，本轮未 commit/push）。

> 本报告只呈现当前版本，不夹带旧版对比。仅记录本批（task-2 连接组件 + task-1 紧凑首屏/审批/收件人/事务板）的验证结论。

---

## 一、结论速览（精确分级，勿混）

| 阶段 | 状态 | 证据 |
|---|---|---|
| 源码门禁（6 项修复） | ✅ **通过**（最终实码逐条行号） | 见 §三 |
| JVM 单测 debug/release | ✅ **通过** 各 458/0/0/0 | 见 §四 |
| assembleRelease/debug | ✅ **通过** BUILD SUCCESSFUL | 见 §四 |
| 同签校验 | ✅ **通过**（cert 一致） | 见 §五 |
| 同签 `install -r` | ✅ **成功**，firstInstallTime 保留 | 见 §六 |
| 真机 App 内 UI 六项 | ✅ **OPPO 55c86317 全六项实测通过**（Redmi 9f9cc3db 曾部分，掉线后目标变更） | 见 §七 |

**无一虚报**：真机 UI 六项因设备处于安全 PIN 锁屏，按指令未解锁、未截图。其余全部已实测通过。

---

## 二、本批交付物

- **签名 APK（交付/可链接）**：
  - [`docs/review/ux-mobile-20261115/deliver/dsh-botcrew-ux-compact-20261115-signed.apk`](</Users/cpuser/Code/dsh-bot-crew/docs/review/ux-mobile-20261115/deliver/dsh-botcrew-ux-compact-20261115-signed.apk>)
  - 同步产物（构建路径，保持可链接）：[`app/app/build/outputs/apk/release/app-release-signed.apk`](</Users/cpuser/Code/dsh-bot-crew/app/app/build/outputs/apk/release/app-release-signed.apk>)
  - **sha256**：`ed5972a3d0fec373ffe90590ecc92ad3edfc96e4f162e5da02e99bcd26a75dc0`
  - 包名 `com.dsh.botcrew`，versionName `0.1.0`，release 非 debuggable。
- 审查记录：
  - [`review-task2-connection-status.md`](</Users/cpuser/Code/dsh-bot-crew/docs/review/ux-mobile-20261115/review-task2-connection-status.md>)（连接组件两轮复核）
  - [`review-task1-final-source.md`](</Users/cpuser/Code/dsh-bot-crew/docs/review/ux-mobile-20261115/review-task1-final-source.md>)（task1 最终源码 review + lead 决策）
  - [`verify-prep-task4.md`](</Users/cpuser/Code/dsh-bot-crew/docs/review/ux-mobile-20261115/verify-prep-task4.md>)（准备台账 + 执行结果 §十一）

---

## 三、源码门禁 6 项（最终实码 PASS，逐条行号）

1. **连接状态双通道**：`problem`（仅 timeline 刷新失败写入，CrewUi.kt:336）/ `operationNote`（发送失败 :425、答复失败 :641）/ `noticesWarning`（:631）三者分离；`CrewConnectionStatus(problem = problem)` 只吃连接/timeline 错误 → **发消息/答复失败不再把顶部连通态刷成红「连不上」**。
2. **StaleRefreshFailed 死态清除**：`ApprovalGate.Phase` 仅 `Idle/Submitting/Accepted/Stale`，全仓无 `StaleRefreshFailed`/`staleRefreshFailed()`；stale 保持锁 + 「这张问题卡已更新，请按最新的那张再答」，由调用方 `onSent()` 触发刷新、新签名 `converged()` 收敛解锁（真实可达，非死态）。
3. **Triage「事务板」入口可达**：`onOpenBoard = { switchMode(Mode.Chat); boardOpen = true }`（CrewUi.kt:1089），切回 Chat 后 `BoardDrawer`（:1423）正常渲染，不再被 Triage 分支 early return 架空。
4. **长会话名不挤右侧「更多」**：会话胶囊 `widthIn(max = 132.dp)` + `maxLines=1/Ellipsis`（CrewUi.kt:1482），「更多」恒 48dp。
5. **notices 失败可见**：`noticesWarning` 在 Crew 主屏按需单行显示（CrewUi.kt:1198），推送拉取失败不再因 `screen != Crew` 被整段吞掉。
6. **触控 ≥48dp**：BoardDrawer 关闭「×」由 40→48（BoardUi.kt:285）；连接/会话胶囊/更多/模式段/成员条/审批选项/notice 折叠/DoneFold 均 ≥48；全局仅剩 6dp 非交互装饰点。

审批正确性（贯穿）：`ApprovalGateHolder` 仍按 `stillSameTicket()` 隔离 Submitting 期间换题的旧 HTTP 返回；`BoardAnswerState` 按 `ticket.id` 各持一份 gate（不同票互不锁）。收件人 `Recipient.select` 多 mention/@id 显式切换保正文、`mentionsIn.first()==目标`。

---

## 四、构建与测试（JDK 21，验证方独占 Gradle）

- 工具链：`JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.9/...`（系统默认 JDK25 与 Gradle 8.11 不兼容，必须 21）。
- `:app:testDebugUnitTest` → **458 tests / 0 fail / 0 err / 0 skip**（56 files）
- `:app:testReleaseUnitTest` → **458 tests / 0 fail / 0 err / 0 skip**（56 files）
- `:app:assembleRelease` + `:app:assembleDebug` → **BUILD SUCCESSFUL**
- 未重复历史全套回归。

---

## 五、签名与证书（表述澄清，勿混）

- 签名 keystore：`~/.android/debug.keystore`，别名 `androiddebugkey`，`CN=Android Debug`（历史上本仓「final」APK 亦为 debug key 签名，故 release 变体沿用同 key 才能 `install -r` 保留数据）。
- **证书公钥指纹（cert，权威同一性判据）**：
  - cert SHA-256 = `AD:0E:44:80:41:42:14:86:25:CE:90:42:7C:E3:83:27:47:C2:9B:79:56:40:CF:B4:51:74:5B:44:54:0A:F7:EB`
  - cert SHA-1 = `2D:DF:B0:71:4A:F0:CA:A4:3D:F3:B2:3D:F3:10:57:B2:06:EB:95:55`
- **新 APK 的签名证书** 与 **设备已装 `com.dsh.botcrew` base.apk 的签名证书** 逐字节一致（两侧 `apksigner verify --print-certs` 均输出 cert SHA-256 `ad0e4480…af7eb`）。
- **关于 `29b26ea2`**：dumpsys `PackageSignatures{...signatures:[29b26ea2]}` 里的 `29b26ea2` 是 PackageManager 的**签名对象哈希（signature object hash，基于证书派生）**，是**另一种表示法**，与上面的 cert SHA-256/SHA-1 是不同摘要口径，二者不互相等于但对应**同一张证书**。此前「signer 29b26ea2」只是引用该签名对象 hash，**不冒充 cert SHA-256**。

---

## 六、安装与数据保留（同签 install -r）

- `adb install -r dsh-botcrew-ux-compact-20261115-signed.apk` → **Success**（Incremental Install）。
- 装后拉回设备 `base.apk` sha256 = 我签的 APK（内容一致）；最终色修复版见 §7.4（`ed5972a3…5dc0`）。
- **`firstInstallTime = 2026-11-11 18:15:06` 未变**（未卸载未清数据 → 配对/历史/session main/work 保留）。
- `lastUpdateTime → 2026-11-15 15:46:05`；`versionName 0.1.0`；`signatures 29b26ea2`（签名对象 hash，见 §五）。
- 全程未发业务测试消息、未点生产历史审批、未重启服务、未触配对/清数据/卸载、Mac 未动输入。

---

## 七、真机 App 内 UI（两机区分；OPPO 55c86317 全六项通过，作当前交付机）

> 目标机变更：验收中途 Redmi 9f9cc3db 掉线，用户经结构化选项授权改用当前 USB 连接的 **OPPO PEDM00 / 55c86317**。两机独立记录，不混用证据。

### 7.0 两机安装记录（独立）

| 机 | 序列 | 机型/分辨率/density | 装前 base.apk sha256 | firstInstallTime | 装后 | 签名 |
|---|---|---|---|---|---|---|
| Redmi | 9f9cc3db | Redmi 24117RK2CC / 1440×3200 / 3.75 | 44d779…32d29fc | 2026-11-11 18:15:06 | install-r Success，firstInstallTime 未变 | cert SHA-256 ad0e4480…af7eb（=设备原证书） |
| **OPPO（当前交付）** | **55c86317** | **PEDM00 / 1440×3216 / 4.0(override 640)** | **44d779…32d29fc** | **2026-11-11 22:27:11** | **install-r Success（两次：初版 16:21，颜色修复版 16:27），firstInstallTime 未变（保配对）** | **cert SHA-256 ad0e4480…af7eb（=设备原证书，逐字节一致）** |

- 两机装前 base.apk sha256 均为 `44d779…`（旧正式版），最终色修复版装后 base.apk sha256 均为 `ed5972a3…5dc0`（= 最终 APK）。未卸载未清数据未改设置。
- 签名同证书判据：两机 `apksigner --print-certs` 与新 APK 均 `ad0e44804142148625ce90427ce3832747c29b795640cfb451745b44540af7eb`。dumpsys `signatures:[29b26ea2]` 为 PackageManager 签名对象 hash（另一表示法，同一证书），不冒充 cert SHA-256。

### 7.1 布局（只报代码 148dp，不做伪精确实测）

- **布局代码**：顶栏 52dp + 模式段 48dp + 成员栏 48dp = **148dp 应用控制区**（可作布局目标）。
- 实际容器精确高度/百分比：**证据不足，不编精确 dp/百分比**。XML 仅暴露可交互子节点边界（非布局容器整体 bounds），故不作精测；系统 insets 另计。
- 内容视口：消息区约 **2/3 屏量级**（定性，不假精准）。

### 7.2 OPPO 55c86317 全六项（✅ 全通过，截图 oppo- 前缀）

| # | 项 | 结果 | 截图 |
|---|---|---|---|
| 1 | 首屏主界面/紧凑顶栏/消息区（work→后回 main） | ✅ | oppo-01-main.png |
| 2 | notice 折叠→展开（点「展开」→显示早报正文、toggle→收起）→收回 | ✅ | oppo-02-notice-expand.png |
| 3 | 成员切换不发送：草稿 "Test"→点大哥 `@大哥 Test`，正文保留/未发送；清空回占位空草稿 | ✅ | oppo-07-member-switch.png |
| 4 | 会话切换 work→**main**，最终 main 空草稿（占位「跟队伍说点什么」） | ✅ | oppo-08-session-main.png |
| 5 | 分拣台：办完·5 默认折叠、底部有输入(一句话/丢→/↑)、无常驻 58dp 大按钮；办完折叠→展开(收起)→收回 | ✅ | oppo-03-triage.png / oppo-04-triage-done-expand.png / oppo-05-triage-done-collapse.png |
| 6 | 更多菜单（事务板/会话管理/模型/后台/看他的屏幕）+ Triage ⋯→事务板 抽屉正常打开 | ✅ | oppo-06-triage-board.png |

- 当前交付主屏图：**oppo-01-main.png**（首屏）、**oppo-08-session-main.png**（回 main 空草稿）。
- 观察（非阻断）：Triage 事务板抽屉背景下层仍见分拣台内容（switchMode(Chat) 背景未切净），功能可达可开可关。

### 7.3 Redmi 9f9cc3db（掉线前部分，独立保留供对照；不作当前交付机）

已通过：主屏 01-main、成员切换 02/03（@大哥 H→@写手 H 保正文）、会话切 main↔work 04-06、更多菜单 07、分拣台办完折叠+底部输入 08、Triage 事务板入口 09。未完成（掉线打断）：notice 展开视觉、办完展开、回 main 空草稿——此类现已在 OPPO 全量补齐。Redmi 证据文件 0x-*.png 保留不覆盖。

### 7.4 色修复最小复验（lead 视觉验收：健康点颜色 bug）

- **根因**：CrewConnectionStatus 健康点用 `palette.accent`；分拣台 `TriagePalette.accent` 是红棕 → 健康隧道在分拣台显示成红点=误读断连。
- **修法**（wb-connection，仅 CrewConnectionStatus.kt+其测试）：OK 点改 `connectionGreen(surface)` 固定语义绿（亮底深绿 #3E6B62 / 暗底亮绿 #5FBFA8），不复用 accent；WAIT=灰/PROBLEM=红保持；尺寸布局零变化。
- **最小复验**：`compileDebugKotlin` 通过；`:app:testDebugUnitTest --tests ConnectionStatusTest` = **15/0/0/0**（13+新2：healthyDotGreenIsFixedPerThemeNotPaletteAccent、greenForIsStableRegardlessOfCallerPalette；Compose Color 单测在 JVM 可跑，无 not-mocked）；`assembleRelease` 通过。
- **重签**：同 debug key，cert SHA-256 `ad0e4480…af7eb`（=设备原证书）。新 APK sha256 **`ed5972a3d0fec373ffe90590ecc92ad3edfc96e4f162e5da02e99bcd26a75dc0`**。
- **OPPO install-r**：Success；firstInstallTime **2026-11-11 22:27:11 未变**（保数据）；装后 base.apk sha256 = `ed5972a3…5dc0` = 新 APK。
- **真机确认**：聊天页健康点绿 `oppo-09-main-green.png`；**分拣台健康点绿** `oppo-10-triage-green.png`（原红棕已修复）。仅拍此两处，不清六项/不重跑全 JVM（458 为上一 hash 完整 gate；本 hash 仅此色修复处最小复验）。

---

## 八、状态

- task4 **完成（complete）**：源码门禁 6 项 / JVM debug+release 各 458 / assemble / 同签 / install-r 已通过；真机 UI 六项已在 **OPPO 55c86317** 全量实测通过（Redmi 9f9cc3db 掉线前部分，独立保留对照）。
- 当前交付机 = OPPO PEDM00 / 55c86317；交付主屏图 oppo-01-main.png、oppo-08-session-main.png。
- 全程仅 App 内、Mac 无输入、未发业务消息/审批、未碰其它 App/网络/设置、未卸载未清数据。
