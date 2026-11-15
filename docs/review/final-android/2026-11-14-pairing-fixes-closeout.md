# 配对 #31/#32/#34 收尾 · pause 方向 · probe deadline · 最终统一 APK 真机终验

2026-11-14。本轮从 `a25361f8` 的实际代码与证据续做（该会话在 19:30 被截断于变异封堵中途），
**不重复安装、不复跑全会话**；每项以「源码是否已落地 + 单测/变异 + 真机证据」三面收口。
只改 `app/` 及测试/独立报告/交付目录，未碰 backend / desktop / relay。

## 0. 一句话结论（stable-ready）

- 配对 fix 源码（#31/#32/#34）已在工作树完整落地，debug/release 各 **410 tests 全绿**；
  3 处关键域变异验证**全部变红**（非假保障）。
- **最终统一 APK** `dsh-botcrew-final-2056.apk` sha256=`6e16ae2d041e3e1f616b6bc3c742b4e6f0e58f1ca57cb986f8d9ae88a5fe6755`
  （16,421,767 B），含 pausePress 方向 / 进程级 debugport / TailcatP2p 硬 20s deadline / 配对 fix / **本轮新增复核文案单位修复**。
- 主包 `install -r` **一次装成、OPPO 未拦**；安装前后主配对资产 `crew-pairing.xml`
  sha256=`819cd884...c665`（604 B）**一字未变**；启动进队伍页「隧道已连接（10ms）」。
- 真机 UI 复验（独立 applicationId `com.dsh.botcrew.pairverify`，tmp 副本仅改一行 applicationId）：
  路径一/拒绝手输/**#34 重进不再弹**/**#32 手改不被抢**/**#31 陈旧条目待复核不删 + 点它先复核** 全部 passed。
- pause `False→True→False`、同 forward 5 次配置重建：真机 passed。
- **#31 额外抓到并修掉一个真机单位 bug**：复核句「上次发现于 X」把毫秒直接喂给 `age()`（要秒），
  2 分钟显示成「25 小时前」。已修 + 新增单测锁。
- TailcatP2p 20s deadline：**JVM 产品代码证据边界**（当前源码台架 1.5s 封慢滴 / 20.09s 生产 / 连接归零 / 快回不误杀）。
  真机慢滴无法在不改隧道对端下注入产品 `probe()` 真实路径，如实标边界，见 §6。
- 未重启 dsh / mobilegw / tailcat serve，未 pkill/killall，未抢 mac 桌面焦点，未做任何 git 写操作。

## 1. 源码状态（实际代码，非会话转述）

工作树 `git status` 中 app 相关改动均存在且完整：

| 文件 | 作用 | sha256 |
|---|---|---|
| `PairingScreen.kt` | #31 复核接线 / #32 三语义转移接线 / #34 持久化 asked / **本轮复核文案单位修复** | `06d67d77…bd6c1` |
| `CrewNearby.kt` | stale(只复核不删)/needsCheck/autoPick/rows/shouldAsk/AddressField(无 copy 旁路)/NearbyCopy 三档文案 | `b985f8d6…0cdba1` |
| `PairingStore.kt` | PermissionStore(独立 crew-permission 文件)/PermissionRecord 纯函数 | `8c462f18…1cd5b` |
| `TailcatP2p.kt` | 整轮墙钟硬截止 20s + disconnect 收口 + 读线程回收 | `112d3641…b4b2`（与 #20 报告记录逐字一致） |

新增测试：`PairingScreenStateTest.kt`、`PermissionRecordTest.kt`、`PausePressTest.kt`、
`CrewDebugPortsTest.kt`、`TailcatProbeDeadlineTest.kt`。

### #31 的结论（不造 TTL 误删）
条目何时消失**只听系统 `onServiceLost`**（`CrewDiscovery.kt:61`）。`stale()`/`needsCheck()` 只做两件事：
把「多久没响」如实显示、点它之前先做一次 **TCP `reachable()` 复核**（可证伪的网络事实，不是时长猜测）。
绝不用「一段时间没听见」冒充「已关闭」去摘行——同网段正常重复广播间隔一旦拉长（bonjour 1/3/9/27/81s）
就会误删一台活着的队伍。

### #32 的结论（旁路写不出来）
`AddressField` 构造函数私有、无 `copy`，改地址只能经 `typed()`/`picked()`/`autoFilled()` 三条语义路径，
只有 `autoFilled` 允许不置 `touched`。旧版「屏幕里写一行 touched=true」的假保障被机制封死（编译期写不出旁路）。

### #34 的结论（跨生命周期成立）
判据落 **独立 `crew-permission` 文件**（不是 `rememberSaveable`，也不并进 `crew-pairing`——后者 `save()` 先 clear
不看键名，一次广播刷新就抹掉「问过」）。`shouldAsk = needsPermission && !permitted && !asked`。

## 2. 单测 + 变异验证（证明非假保障）

```
:app:testDebugUnitTest     tests=410 failures=0 errors=0
:app:testReleaseUnitTest   tests=410 failures=0 errors=0
```

变异验证（改源码→跑→期望红→还原，源文件 md5 全程一致）：

| 变异 | 改动 | 结果 |
|---|---|---|
| A #32 | `typed()` 不置 `touched` | `PairingScreenStateTest` 2 例红（typingThenAnotherBeacon…、autoFill…SameInstance） |
| B #34 | `shouldAsk` 忽略 `asked` | `PairingScreenStateTest` 3 例红（DeniedAnswer…、retryingNeverReopens…、needing…NotTheSameAs…） |
| C #31 | `merge` 按 `stale` 删行（时长冒充已关） | `PairingScreenStateTest` 1 例红（aStaleRowStays…UntilSystemReportsItLost） |

## 3. 最终统一 APK 与主包装载（保数据）

| 项 | 值 |
|---|---|
| APK 路径 | `docs/review/final-android/deliver/dsh-botcrew-final-2056.apk` |
| SHA-256 | `6e16ae2d041e3e1f616b6bc3c742b4e6f0e58f1ca57cb986f8d9ae88a5fe6755` |
| 字节 | 16,421,767 |
| 版本 | versionCode=1 / versionName=0.1.0 / minSdk26 / targetSdk35 |
| 安装 | `adb install -r` → **Success**（未触发 OPPO -99；-99 只在首次/重装，同签名 install -r 直过） |
| 设备 base.apk hash | `6e16ae2d…6755`（与交付 APK 逐字一致） |
| 主包 lastUpdateTime | 2026-11-14 21:13:59（更新）；firstInstallTime 2026-11-11 22:27:11（**未变**） |
| 主配对资产 `crew-pairing.xml` | sha256 `819cd884847d3ebf2d7b0e3a425dfd5c73d6f396604be8664120853a30acc665` / 604 B（**一字未变**） |
| 启动 | 进队伍页「现在走：隧道已连接（10ms）」 |

## 4. 真机 UI 复验（独立 applicationId `com.dsh.botcrew.pairverify`）

副本：当前 `app/` rsync 到 `/tmp/pairing-verify-2056/`，**只改一行** `applicationId`；
`diff -r -q` 仅 `build.gradle.kts` 一个文件不同（产品逻辑零改）。构建 `app-debug.apk`（`com.dsh.botcrew.pairverify`），
`adb install -r` 首次安装遇到 OPPO 安装确认页「Bot 队伍 / 安装」按钮——**用像素定位 `input tap` 点通、一次装成**，
非用户手动、非静默悬着。

| 路径 | 真机观测 | 证据 | 结果 |
|---|---|---|---|
| 一 干净安装弹系统权限框 | `允许"Bot 队伍"访问附近的设备?` / 扫描附近设备以配对 | `pv-01-permission-dialog.png/.xml` | passed |
| 拒绝后手输 | 显 `DENIED`「附近设备权限被拒过，系统不会再弹框…再找一次」，地址预填 | `pv-02-after-deny.png/.xml` | passed |
| **#34 重进不再弹** | 拒绝→`force-stop` 重开→焦点直接 MainActivity（**无** GrantPermissions）；`crew-permission.xml` askedNearby=true 已落盘 | `pv-03-reentry-no-dialog.png/.xml` | passed |
| **#32 手改不被抢** | 手输 `10.9.9.9:1`→地址框保持；文案变「找到 dsh-crew-0kvcc5t，地址是你自己填的；要换成它点下面那行」；行留「用它」换回入口 | `pv-04-handedited-not-stolen.png/.xml` | passed |
| 两台在列 | fixture-audit(43991) + dsh-crew-0kvcc5t(43499)，选中真实那台 | `pv-05-two-rows.png/.xml` | passed |
| **#31 陈旧待复核不删** | kill fixture(SIGKILL 无 goodbye) 后条目**仍在表**，+5s 显「上次发现 30 秒前 · 待复核」，+30s 变「1 分钟前 · 待复核」，**未按时长删行** | `pv-06-stale-review.png/.xml` | passed |
| **#31 点它先 TCP 复核** | 点死条目 fixture-audit + 输码点「连上」→ 真实 `reachable()` 握手失败→「这台电脑上次发现于…，现在连不上。可能已经关了，换一台或核对地址再试。」 | `pv-07-stale-check-refused.png/.xml` | passed |

fixture 是**真发 mDNS 的测试服务**（`docs/review/shots-pairing-ui/pairing-fixture-service.mjs`，
`_dsh-crew._tcp`，crew=fixture0001，名字带 fixture- 前缀），与真实队伍 `dsh-crew-0kvcc5t` 界面逐字可分；
配对资产 `66e74d226c1e38fa` 全程未受影响（验证包独立 shared_prefs）。

## 5. pause 方向 / forward 重建（主包真机）

### pause False→True→False（工作区「大哥 的屏幕」）
| 步 | 按钮文案 | 回执 | 证据 |
|---|---|---|---|
| 起（paused=False） | 让它停一下 | — | `pv-08` |
| 点1 → pause(true) | 继续执行 | 已让它停一下（全局执行器，再按一下继续） | `pv-08-pause-true.png/.xml` |
| 点2 → resume(false) | 让它停一下 | 已继续执行（全局执行器） | `pv-09-pause-false-final.png/.xml` |

方向正确（传出去的是目标=取反，非当前状态），与 `PausePressTest` 单测一致。

### 同 forward 规则重建 5 次
`tcp:18080→tcp:18080` 建→list→remove 各 5 次，每次 build 返回端口、list 一致、remove 干净、无残留；
收尾 `forward --list` / `reverse --list` 均空。

## 6. TailcatP2p 20s deadline（JVM 产品代码证据边界）

当前产品源码 `TailcatP2p.kt` hash=`112d3641…b4b2`（与 #20 报告逐字一致，逻辑 = `TailcatP2p.fixed.kt`，仅 import 行序不同）。
用独立 runner 直接编当前源码 + `ProbeHarness2` 调产品 `probe()`，`probe_server.py` 当「隧道那头」：

| 用例 | 预算 | 墙钟 | ok | 对端 ESTABLISHED |
|---|---|---|---|---|
| 慢滴 800ms/字节（原 81.64s 那例） | 1500 | **1.56s** | false | 0 |
| 慢滴 100ms/字节（原 22.52s 且误报 ok） | 1500 | **1.57s** | false（不再误报） | 0 |
| 对端收下不回 | 1500 | 1.57s | false | 0 |
| 慢滴连续 3 轮（连接不累积） | 1500/轮 | 4.61s | false | 0 |
| 快回（正常探测不误杀） | 1500 | 0.09s | **true** | 0 |
| 慢滴 800ms，**生产默认 20s 预算** | 20000 | **20.09s** | false | 0 |

产物：`docs/review/i20/deadline_current_2056.json`、`run_dl_current_2056.py`。

**为何是真机边界而非跳过**：产品 `probe()` 的真实调用点 `MainActivity.kt:169` 探的是
`TailcatP2p.start(p2pAddr)` 建出的 **libtailcat 隧道本地代理端口**，对端由真实 `p2pAddr`（dsh-crew backend）决定。
要把真机慢滴注进这条**产品 probe 真实路径**，必须把隧道对端换成慢滴服务（改 p2pAddr / 伪造 tunnel peer，涉隧道密钥），
超出「只修 app 配对/测试范围」；且当前主包「走局域网（P2P 没通）」，隧道未建、probe 循环不跑。
故真机慢滴如实标 JVM 证据边界——收口逻辑全在 JVM 侧（HttpURLConnection + Thread），隧道本身是 `libtailcat.so` 与改动无关，JVM 台架覆盖被测路径。

## 7. 本轮额外修复（真机抓到）

`PairingScreen.kt:302` 复核句 `NearbyCopy.age(CrewNearby.silence(...))` 把 **毫秒**直接喂给 `age()`（要秒），
真机把「2 分钟前」显示成「25 小时前」（截图 `pv-07`）。根因修复：`silence(...) / 1_000`；新增单测
`theRecheckSentenceConvertsMillisToSecondsBeforeAging`（含 `assertNotEquals` 反面锁，证明 /1000 必需）。
其余两处 `age()` 调用（`one()`/`staleRow()`）经 `staleSeconds()` 已折秒，无误。

## 8. 隔离与恢复

| 项 | 开工前 | 收尾 |
|---|---|---|
| 主包 `crew-pairing.xml` | `819cd884…c665` / 604B | **一致**（两次 install-r 均保） |
| 主包 lastUpdateTime | 17:56:55 | 21:13:59（本轮终装）；firstInstallTime 未变 |
| 测试包 pairverify | — | 已 `adb uninstall` Success，仅剩主包 |
| 屏幕方向 | user_rotation=0 / accel=1 | 一致 |
| `adb forward` / `reverse` | 空 | 空 |
| `/sdcard` 临时 dump/截图 | — | 已删 |
| dsh / mobilegw / tailcat serve | 1765/1766、67367、86560 | 1765/1766、67367（未动）；86560 由 **dsh 自身**重启为 23375（非我 kill，我从未触碰 dsh/tailcat serve） |
| fixture / probe_server | — | 全清（`pgrep` 无残留，43991-43993 端口空） |
| 桌面焦点 | — | 全程未发 mac 桌面输入、未 open、未抢焦点 |
| PIN | 全程未进入任何命令/日志/截图/报告 | 同 |

- 未做任何 `git add/commit/push/stash/checkout/restore/reset`；未改 `开发进度.md`/`HANDOFF*`/`crew-watch`。
- 唯一 scoped `pkill` 只针对自起的 `probe_server.py` / `pairing-fixture-service`（fixture PID 已单独 kill）。

## 9. 边界与仍 open

- **#20 第 1 项（跨 NAT 打洞成功率）：仍 OPEN**，外部阻塞不变（缺跨 NAT 对端）。
- 真机慢滴：JVM 证据边界（§6），非跳过。
- 独立报告/截图/最终 APK 专用交付目录：`docs/review/final-android/`（报告 + `evidence/pv-*` + `deliver/`）。
