# 配对屏四条路径 · 真机验收（2026-11-14）

对象：OPPO PEDM00（`adb` 序列号 `55c86317`，Android 14 / SDK 34）。
契约条款：`docs/00-contract.md` §9.4 `TODO(gw, 2026-11-14)` 里「配对屏三验未做」那一条，
`开发进度.md` §四 `[ ] 配对屏真机三验`。本报告把四条路径逐条给出 **passed / blocked**，
不写「都验过了」这种笼统结论。

## 0. 一句话结论

| # | 路径 | 结论 |
| --- | --- | --- |
| 1 | 干净安装弹系统权限框 | **passed** |
| 2 | 拒绝权限后手输地址仍能配对 | **passed** |
| 3 | 同网段多台时选第二行 | **passed** |
| 4 | 手改过的地址不被发现流抢 | **passed**（附带发现两条退化，见 §7） |

四条都走真实系统弹框、真实 `NsdManager` 发现、真实 `PairingClient` HTTP 提交；
配对的服务端是一个**真实发布 mDNS 的 fixture 服务**（不是伪造产品数据，见 §2），
所以「配对成功」这件事没有碰到主 app 的配对资产 `66e74d226c1e38fa`（§5 有指纹对照）。

## 1. 方法：同源码独立 applicationId 测试包

干净安装要卸载重装，而卸载会抹掉主包 `com.dsh.botcrew` 的配对凭据
（`/data/data/com.dsh.botcrew/shared_prefs/crew-pairing.xml`，`deviceId=66e74d226c1e38fa`）。
所以改用**同一份源码、只改一行 `applicationId`** 的测试包：

```
/tmp/pairing-fixture/app/                     # rsync 自 app/，排除 build/.gradle/.kotlin
  app/build.gradle.kts                        # 仅 applicationId 一行不同
    - applicationId = "com.dsh.botcrew"
    + applicationId = "com.dsh.botcrew.pairingfixture"
```

源码差异的证明（构建前跑，输出即全部差异）：

```
$ diff -r -q --exclude=build --exclude=.gradle --exclude=.kotlin \
    /Users/cpuser/Code/dsh-bot-crew/app /tmp/pairing-fixture/app
Files .../app/app/build.gradle.kts and /tmp/pairing-fixture/app/app/build.gradle.kts differ
```

**只有一个文件不同，且只有 `applicationId` 一行不同**（`namespace` 未动，`${applicationId}.files`
这个 FileProvider authority 跟着 applicationId 走，不需要额外改）。

- 构建：`./gradlew --no-daemon :app:assembleDebug -PcrewGateway=http://192.168.31.127:43499`，
  JDK 用 `/Applications/Android Studio.app/Contents/jbr/Contents/Home`（21.0.8；系统默认是 25）。
- 产物：`app-debug.apk` 16,414,951 B，`aapt2 dump badging` →
  `package: name='com.dsh.botcrew.pairingfixture' versionCode='1' versionName='0.1.0'`。
- 安装：`adb install -r`，`firstInstallTime=lastUpdateTime=2026-11-14 18:13:40`。
- **没有往主源码引入任何测试开关，也没有改生产行为**：仓库 `app/` 目录本轮零改动（§8）。

> 为什么「干净」这件事是真的：`/data/data/com.dsh.botcrew.pairingfixture/` 是全新目录，
> 装完只有 `cache/`、`code_cache/`，`shared_prefs/` 不存在 —— 首次启动必然走配对屏。

## 2. 「第二行」从哪来：真实 mDNS 的 fixture 服务

「选第二行」要求同网段有 ≥2 台。本轮没有第二台真机队伍，于是起了一个
**真实发布 mDNS 记录**的测试服务（源码随证据留在
`docs/review/shots-pairing-ui/pairing-fixture-service.mjs`）：

- 用与后端同一个库（`bonjour-service`）发布 `_dsh-crew._tcp`，TXT 带 `crew` 指纹；
- 名字带 `fixture-` 前缀（`fixture-pairing-audit` / `-second` / `-third`），
  TXT 额外带 `fixture: pairing-audit`；
- 只实现契约里首次配对那一跳 `POST /api/mobile/pair`（校验 code，回一份**明显不是真凭据**的
  `token: fixture-token-not-a-real-credential`），其余 `/api/mobile/*` 回一句
  `{"fixture":true,...}`。

**明确区分**：界面上「真实队伍」是 `dsh-crew-0kvcc5t`（Mac 上真跑的 backend，端口 43499），
fixture 是 `fixture-pairing-*`（端口 43991/43992/43993）。报告与截图里两者逐字分开写，
不把 fixture 说成「真实发现到的第二台电脑」。

## 3. 路径一：干净安装弹系统权限框 — passed

| 步骤 | 观测 |
| --- | --- |
| 18:13:40 安装完成，`pm list packages` 有 `com.dsh.botcrew.pairingfixture`，`shared_prefs/` 不存在 | 干净 |
| 18:14 启动 → `topResumedActivity=com.android.permissioncontroller/.permission.ui.GrantPermissionsActivity` | **系统框真的弹了** |
| 框内文案（`01-perm.xml`） | `允许“Bot 队伍”访问附近的设备?` / `扫描附近的设备以配对、连接设备` / `允许` / `拒绝` |

证据：`shots-pairing-ui/01-permission-dialog.png`、`01-perm.xml`。

这是 `AndroidManifest.xml` 里 `NEARBY_WIFI_DEVICES`（API 33+）+ `PairingScreen` 的
`LaunchedEffect(Unit)` 在 `!settled && !permitted()` 时 `askPermission.launch(...)` 的真实结果。

## 4. 路径二：拒绝后手输仍能配对 — passed

| 步骤 | 观测 |
| --- | --- |
| 点「拒绝」 | 回到配对屏；顶部提示 `没有附近设备权限，自动发现关了，地址可以手填`（`NearbyCopy.NO_PERMISSION`） |
| 地址框里预填 `http://192.168.31.127:43499`（`BuildConfig.GW_BASE`） | 手输路径可用，不需要先给权限 |
| 清空 → 手打 `192.168.31.127:43991`（**故意不带 `http://`**，验证 `CrewPairing.normalize`） | 输入框显示原样 `192.168.31.127:43991` |
| 配对码 `314159` → 点「连上」 | fixture 收到 `POST /api/mobile/pair {"deviceId":"66e74d226c1e38fa","name":"OPPO PEDM00","platform":"android","code":"314159"}` |
| 配对后 | 界面进队伍页，`现在走：局域网`；`crew-pairing.xml` 写入 `base=http://192.168.31.127:43991`、`crew=""`（手输路径没有指纹，符合设计） |

证据：`02-after-deny.png`、`02-after-deny.xml`、`05-typed.png`、`05-typed.xml`、
`02b-paired-main.png`、`08-paired.xml`、`fixture.log`。

**边界说明**：这一条验的是「拒绝权限后手输仍能走通整条配对链」，服务端是 fixture。
对着**真实后端**配对会写 `~/.dsh/state/superagent/remote-devices.json`，
并且因为两个包同签名（`signatures:[29b26ea2]`，都是 debug key）**`ANDROID_ID` 相同**
（都是 `66e74d226c1e38fa`），`DeviceStore.redeem` 会按 `deviceId` **替换**那条真记录 ——
等于抹掉主配对资产。所以真实后端那条路本轮刻意不重跑（它在 `2026-11-14-issue19-*`
几份报告里已有接口级与真机级证据），本轮只走 fixture。

## 5. 路径三：同网段选第二行 — passed

起 `fixture-pairing-audit`(43991) 与 `fixture-pairing-second`(43992) 两个真 mDNS 实例，
Mac 侧 `dns-sd -B _dsh-crew._tcp local` 同时看到 3 条。手机侧（`14-two-rows.xml`）：

```
已选中 dsh-crew-0kvcc5t，地址已填好。        ← 自动填（只有「真实一台 + 0 台 fixture」时才是单台）
电脑地址  http://192.168.31.127:43499
[ fixture-pairing-audit   http://192.168.31.127:43991   用它 ]
[ fixture-pairing-second  http://192.168.31.127:43992   用它 ]
[ dsh-crew-0kvcc5t        http://192.168.31.127:43499   用它 ]  ← 强调色边框＝当前这一行
```

点**第二行**（`fixture-pairing-second`）：

- 顶部提示变成 `已选中 fixture-pairing-second，地址已填好。`
- 地址框变成 `http://192.168.31.127:43992`（带上了协议，行里给的就是归一化后的 base）
- 再用第二台自己的码 `271828` 配对 → `43992` 收到 `POST /api/mobile/pair`，
  `43991` **一条 `/api/*` 都没收到**（证明真的连的是第二行，不是第一行/自动填那台）
- 写盘：`base=http://192.168.31.127:43992`、`crew=fixture0002`

证据：`14-two-rows.png/.xml`、`15-second-row-selected.png/.xml`、`17-row2-selected.png`、
`18-before-connect.xml`、`fixture2.log`。

顺序也值得记一笔：列表按「先发现的在上」，本轮 `fixture-*` 两条排在真实 `dsh-crew-0kvcc5t`
之前（fixture 后起、但 mDNS 缓存顺序如此）。`CrewNearby.add` 的「位置不动」策略在
`28-two-spots-handedited.xml` 里也复现了：新起的 `fixture-pairing-third` 追加到末尾，
已有两行不跳位。

## 6. 路径四：手改地址不被发现流抢 — passed

三种扰动，地址框都没被改：

| 时刻 | 扰动 | 地址框 |
| --- | --- | --- |
| 18:24 | 单台在列（真实一台），手改成 `10.9.9.9:1` | `10.9.9.9:1`，顶部改口为 `已自动找到 dsh-crew-0kvcc5t，点一下填上地址。` |
| 18:25 | 起第 2 台（`fixture-pairing-audit` 已在 + 新起 `-third`） | 仍是 `10.9.9.9:1`；顶部 `找到 3 台队伍，点一台填上地址。` |
| 18:27 | 把两台 fixture 全 kill，只剩真实一台 | 仍是 `10.9.9.9:1`；顶部 `已自动找到 dsh-crew-0kvcc5t，点一下填上地址。` |

证据：`21-handedited-single.xml`、`22-after-new-beacon.png/.xml`、
`27-handedited-before-churn.xml`、`28-two-spots-handedited.xml`、`31-path4-single-again.png/.xml`。

这与 `CrewNearby.autoPick(spots, touched=true) == null` 的实现一致：`onValueChange` 里
`touched = true` 是**永久**让位，之后任何广播都不抢。同时 `rows()` 在「单台但地址不是它」时
仍然把那一行列出来（`31-path4-single-again.xml` 里 `dsh-crew-0kvcc5t` + `用它` 还在），
也就是「换回去」的入口没被拿掉 —— 这条边界是对的。

## 7. 本轮发现的退化（已各自开 issue，未在本任务里改源码）

1. **#31 发现列表对已关闭的队伍滞后 75–90 秒才消失。**
   kill 掉 fixture 进程后：+15s/+30s/+45s/+60s/+75s 界面仍是「找到 2 台」，
   `fixture-pairing-third` 那行还能点；+90s 才变单台。同一时刻 Mac 侧 `dns-sd -B` 已经只剩一条
   （goodbye 生效）。即 `NsdManager.onServiceLost` 对这种「进程被 kill、没有 goodbye」的情形
   没及时回调，整条链把「条目何时消失」完全外包给了系统。
   证据：`shots-pairing-ui/30-lost-t{1..6}.xml`（t=15/30/45/60/75/90s）。
2. **#32 手改地址的正确性缺回归锁 + 一处文案说反。**
   行为对（见 §6），但 `CrewNearbyTest` 只测了纯函数，「屏幕真的把 `touched` 置上了」没有测试；
   另外「手改过 + 单台在列」时顶部写 `已自动找到 X，点一下填上地址。`，而地址框里是用户自己打的
   `10.9.9.9:1` —— 读起来像「已帮你填成 X」。
3. **#34 「问过被拒不再反复弹」没做到。**
   18:14 干净安装拒绝一次；18:21 在队伍页点「重新配对」回配对屏，**又弹一次**同一个系统框
   （`13-back-to-pairing.xml` 里 `允许`/`拒绝` 两个节点又出现）。`settled` 是 composable 级
   `rememberSaveable`，重新进场没恢复。

## 8. 隔离与恢复（主资产前后一致）

| 项 | 开工前 18:10:30 | 收尾 18:46 |
| --- | --- | --- |
| 主包 `com.dsh.botcrew` 安装 | `firstInstallTime=2026-11-11 22:27:11` / `lastUpdateTime=2026-11-14 17:56:55` | **完全一致** |
| 主包 `crew-pairing.xml` | sha256 `819cd884847d3ebf2d7b0e3a425dfd5c73d6f396604be8664120853a30acc665`，604 B，17:17 | **一致**（`deviceId=66e74d226c1e38fa` 完好） |
| `~/.dsh/state/superagent/remote-devices.json` | sha256 `f6bd55eed796031b5c08b916896fdbd417ff4d71aa50165b4c1018c446e69ae4` | **一致**（三条记录 `crew-desktop` / `d021988751fdd554` / `66e74d226c1e38fa` 未变） |
| 测试包 | — | 已 `adb uninstall com.dsh.botcrew.pairingfixture`（`Success`），`pm list packages` 只剩主包 |
| 屏幕方向 | `user_rotation=0` / `accelerometer_rotation=1` | **一致**（中途 `cmd window user-rotation lock 1` 拍过横屏，已 `free` 还原） |
| 深色模式 | `Night mode: no` | 未改 |
| `adb forward` | 空 | 空（全程没建） |
| fixture 进程 | — | 全 kill（`pkill -f fixture.mjs`，43991/43992/43993 无 LISTEN） |
| `/sdcard` uiautomator dump | — | 已删本轮临时文件 |
| dsh / mobilegw / tailcat | PID 89699 / 41418 / 48129 | **未重启、未 kill** |
| 桌面焦点 | — | 全程未发桌面输入事件、未 `open`、未抢焦点 |

- 主包只在安装测试包前 `am force-stop` 过一次（配对资产在 `shared_prefs`，force-stop 不丢；
  §8 的 sha256 对照证明没丢），之后 18:46 已 `am start` 回前台，
  当前 `topResumedActivity=com.dsh.botcrew/.MainActivity`，界面 `现在走：隧道已连接（14ms）`。
- 未卸载主包、未 `pm clear` 主包、未改主包任何数据。
- **PIN 全程没用过**：本轮所有操作都在无锁屏状态（`isKeyguardShowing=false`）下进行，
  PIN 没有进入任何命令、日志、截图或本报告。
- 截图里不含凭据：fixture 写进 `crew-pairing.xml` 的 token 是
  `fixture-token-not-a-real-credential`（明摆着的假值），报告里也没有打印主包 token。

## 9. 仓库改动范围

只有新增文档与证据，**本轮没有动 `app/` 下任何文件**（也没有动 `开发进度.md`、`HANDOFF*`、
`crew-watch`、git 索引或 stash）：

```
docs/review/2026-11-14-pairing-screen-four-paths.md          （本报告，新增）
docs/review/shots-pairing-ui/                                 （截图 + uiautomator dump + fixture 源码 + fixture 日志，新增）
```

> 工作树里 `app/` 下另有未提交改动（`build.gradle.kts` 的 `testOptions.unitTests.isReturnDefaultValues`、
> `TailcatP2p.kt`、`CrewDebug.kt`、`CrewUi.kt`、`CrewWire.kt`、`MainActivity.kt` 等），
> 那些来自并行的 probe 硬截止修复（`ds-phone-final-max`），**不是本轮改的**。
> 本轮对 `app/` 的唯一动作是把整目录 rsync 到 `/tmp/pairing-fixture/` 再改一行 `applicationId`，
> 原目录零写入（`git status app/` 里没有本轮新增的路径）。

测试包的构建与 fixture 服务都在 `/tmp/pairing-fixture/` 下，不进仓库；
唯一带进仓库的代码是 fixture 服务脚本本身（`shots-pairing-ui/pairing-fixture-service.mjs`），
它是**证据**，不是产品代码，也不被任何构建引用。

## 10. 附：一次无关的安装拦截（记录备查）

18:44 / 18:48 两次尝试 `adb install -r` 重装测试包（想补一张横屏截图）都被 OPPO 的
`com.oplus.appdetail/.model.guide.ui.InstallGuideActivity` 拦下（`Failure [-99]`，
界面提示「此应用开发者未通过身份验证…继续安装」）。用户侧也遇到了同一次拦截。
**这不影响本报告的结论**：四条路径的证据在 18:14–18:31 之间已经取全，
18:46 的恢复也已完成；后续重装只是可选补充，被拦后未再尝试。

## 11. 附：18:21 生产晨报是否真到手机（lead 追加的只读核查）

**结论：没有到手机；而且这台手机上的 App 根本没有接收入口。**「backend 队列里有」不能当送达。

### 后端侧证据（只读）

`/private/tmp/dsh-superagent-restore.log`（backend PID 89699 的 stdout）：

```
[push] queued kind=morning device=crew-desktop
[push] queued kind=morning device=d021988751fdd554
[push] queued kind=morning device=66e74d226c1e38fa
[morning] sent day=2026-11-14 pending=0
```

`queued` 的语义由 `backend/src/app/push.ts` 定义：**离线留件**，`deliver()` 只在
`online === true` 或系统推送成功时才回 `delivered`。这里三条全是 `queued`，
说明当时这台设备**没挂在隧道上**（或中转判离线），消息进了留件桶。

### 手机侧证据（只读）

1. **App 没有推送接收实现**。在 `app/app/src/main/java/com/dsh/botcrew/` 全目录 grep：
   `pushRegister` / `pushSend` / `0x1b` / `Notification` / `POST_NOTIFICATIONS` / `早报` 全部 **0 命中**。
   `AndroidManifest.xml` 里没有 `POST_NOTIFICATIONS`，没有 `Service`，没有通知渠道。
   也就是说：即使中转把 `pushSend` 帧写下来，这台 App 也没有解析它的代码、没有把它变成通知或界面的路径。
2. **`mobileq.db` 里没有晨报**：`messages` 表按 `text like '%早报%'` 查，0 行。
   晨报走的是推送通道，不入 `mobileq` 消息面 —— 与上面第 1 点一致。
3. **`/state` 的 notice 健康位是空的**：`health.notice = {"state":"ready","detail":"Nothing waiting"}`，
   没有「有待发件」的积压提示。
4. 主 app 当前界面（`shots-pairing-ui/50-main-home.xml`）只有会话列表、票、播报按钮，
   没有任何「早报 / 通知」条目。

### 为什么不能算送达

契约 §9（`docs/00-contract.md` 那张表）把手机通知列为**加分项**，并明确写
「手机在线/重连时才有；**不作唯一依赖**」。本轮的事实是：这条加分项在这台设备上
连「接收入口」都不存在（`pushRegister` 没人发、`pushSend` 没人解），
所以 `queued` 之后不会有任何一跳能把它变成「手机上看到」。

**这不是本轮配对验收的缺陷，也没有因此去补发任何通知**（lead 明确要求不为补晨报破坏配对验收）。
要让晨报真到手机，需要的是 App 侧接 `pushRegister`/`pushSend` 与通知 UI —— 那是另一件事，
本报告只如实记录「没到」与「为什么没到」。

## 12. 窗口交接

18:55 收尾快照（同一刻取的，见下），随后**手机独占窗口已交还** `ds-phone-final-max`
（lead 委派的「最终 Android 集成验收 + 主包更新含最新 probe 硬 deadline」）。
交接时给它的现场事实与本文件 §8 的表逐项一致，另附三条它会踩的坑：

1. 手机上装的是 17:56 那份主包（`base.apk` 16,886,003 B），而
   `app/app/build/outputs/apk/debug/app-debug.apk` 在 18:51 被重新构建（16,416,047 B）——
   两者不是同一份，装最新统一包要用 18:51 那个，并核 `applicationId=com.dsh.botcrew`。
2. OPPO 的 `InstallGuideActivity` 会拦 `adb install -r`（`Failure [-99]`），
   那个「继续安装」是 `TextView` 不是 `Button`，`input tap` 打不中，需要人点。
3. 这台机器上 `pm clear` / `pm grant` 都被拒（`CLEAR_APP_USER_DATA` / `GRANT_RUNTIME_PERMISSIONS`
   的 `SecurityException`），权限只能靠真实系统弹框给。

收尾时刻的只读核对（18:55:29）：

```
topResumedActivity = com.dsh.botcrew/.MainActivity
pm list packages | grep botcrew → 只有 com.dsh.botcrew
versionName=0.1.0 / lastUpdateTime=2026-11-14 17:56:55
crew-pairing.xml sha256 = 819cd884…c665   （与 18:10:30 开工前逐字一致）
remote-devices.json sha256 = f6bd55ee…ae4 （与开工前逐字一致）
user_rotation=0 / accelerometer_rotation=1
adb forward --list 为空
fixture 进程：无
```
