# task-13 / phase3-device — 手机解锁、真机安装与内部答复端到端验证

日期：2026-11-15
负责人：`wb3-device-verify`（独占测试手机 OP-PEDM00 / serial `55c86317`、唯一 ADB/安装/实点窗口）
后端协作：`wb2-executor-closeout`（隔离 canary 后端 8799/8798，独立 DB，只写自己，不碰生产 89699/67367）
客户端协作：`wb3-client-answer`（`.answerverify` 隔离包来源、源码 owner）

> 一句话：**前序「ColorOS 锁屏 ROM 外部阻塞」的归因不成立**。真实根因是**屏幕 AOD/Doze 秒级熄屏**加上**installer/确认框按钮用缩放预览坐标算错**——两者叠加让「input 命令退出码 0 但界面不动、screencap 返回 0 字节」看起来像 ROM 挡输入。改用真 `uiautomator` 组件 bounds 定位 PIN 数字键盘与「安装」蓝按钮逐点，**一次正常 PIN 输入即解锁（deviceLocked=0）**、**`adb install` 真等到确认框点「安装」后 `INSTALL_SUCCEEDED`**。随后真机实点两张答案卡：**stop 零写、go → 真 DshExecutor 自动 deliver → 真 MCP stdio → canary replies 0→1**，正文与审批 text 逐字一致。正式 release APK 已构建+签名（默认包名，非 .answerverify），install-r 覆盖主包**暂缓**（等 lead 决策，叠加后端 lib 未 HMR 的事实，见 §7）。

---

## 0. 结论与证据速览

| 项 | 结果 |
|---|---|
| 解锁归因 | **ROM 外部阻塞不成立**；根因 = AOD 熄屏 + 按钮坐标（实证见 §1） |
| 解锁 | 真机 PIN 键盘 bounds 逐点一次解锁，`deviceLocked=0`，无 rate lock、无重试猜测 |
| `.answerverify` 安装 | `INSTALL_SUCCEEDED`（logcat 实证）；主包 firstInstallTime 未变 |
| 主包完整性 | `firstInstallTime=2026-11-11 22:27:11` 未变；base.apk sha256 `eb951b55…120a40` 未变；权限全 granted |
| A（canary-answer-1 先别做 / stop） | `ended=True/stopped`、`attention_id=null`、**replies 0（零写）** |
| B（canary-answer-2 做吧 / go） | `pending=False`、`attention_id=null`、**replies 0→1**，正文逐字一致 |
| 追加 stop（ticket 3/4/5） | 全零写、replies 稳定=1、无假成功/无重复写 |
| 409 / 400 | 后端旧 attention→409「已过期」、缺 attention→400，均零写（host 实测）；app 端 `AnswerStale→刷新+已更新`（单测+desktop 真链路已证，真机因轮询抢先未生可点陈旧卡，如实记） |
| 单测 | debug **429/429**、release **429/429**，0 fail/0 err（sourcefreeze 后本轮重跑） |
| 正式 release APK | `docs/review/final-android/deliver/dsh-botcrew-internal-final-20261115-0133-answer.apk`，sha256 `44d7799527bf3a39f41307b30a8242bf3f4a004cb915b872ad0ac4e7832d29fc`，package com.dsh.botcrew，debug keystore，无 debuggable |
| install -r 覆盖主包 | **完成（lead+backend owner go，生产 lib 已 rebuild+HMR 有 /answer）**：base.apk 实核 sha=`44d77995…ad0ac4e7832d29fc` 逐字节一致、firstInstallTime 未变、权限 granted、session=work 主配对保留 |
| 真身份补测（phoneGate 修复后） | approve(+1)/stop(0)/notices200(真凭据 derived device)/stale409/缺参400/无凭据401/actor=真实 deviceId 66e74d… 全绿 |

---

## 1. 解锁归因：推翻「ROM 外部阻塞」（诊断闭环）

### 1.1 真实状态（`adb` 指定 serial，逐项区分）
初始：`mWakefulness=Dozing`、`interactiveState=INTERACTIVE_STATE_SLEEP`、`mCurrentFocus=NotificationShade`、`mDreamingLockscreen=true`、`deviceLocked=1`、`strongAuthRequired=0x0`、`isKeyguardShowing=true`；`mFocusedApp` 是残留的 `com.android.packageinstaller/.oplus.OPlusPackageInstallerActivity`（abandon 的旧安装会话）。

### 1.2 关键判据：screencap 0 字节 ≠ FLAG_SECURE，是熄屏
- `dumpsys display` 在 `mScreenState=ON / DOZE / OFF` 间跳；`screencap` 在 **ON 时返回 0 字节**、DOZE 时返回 AOD 小图（25228B）。
- logcat 铁证：`input keyevent KEYCODE_WAKEUP` 后约 1.4s，`DisplayDeviceRepository: Display device changed state: "内置屏幕", DOZE` → 再 `OFF`；`DisplayPowerState: Updating screen state: state=OFF, backlight=-1.0`。**屏幕醒来即被 Doze/AOD 熄掉**，前序「swipe 无反应 / 截图黑」就是截在熄屏帧、输入落在 DOZE 态被 swallowed，**没有 INJECT_EVENTS 报错**（`input` 退出码 0、无 stderr，与前序交接一致——不是被权限拒，是屏幕灭了）。
- 用 `uiautomator dump`（不依赖 screencap、熄屏也能读到 live 树）确认：这是 **swipe 键锁 + 6 位 PIN bouncer**（`oplusos_kgd_security_pin_six_view`、`pinColorNumericKeyboard`），文本「上滑使用面部或指纹解锁 / 紧急求助」——**有 PIN，不是纯滑动**。前序「无 PIN 键盘」是没把 bouncer 唤出。

### 1.3 最小复现/验证环（tight loop）
- 唤醒后**立即**截图（同一 `adb shell` 内）能拿到 3.4MB 正常帧、`mScreenState=ON` → 证明只要不让它睡就能读到画面。
- 环：`input keyevent WAKEUP` + `input swipe 720 2600 720 600 120`（整屏上滑唤 bouncer）+ `sleep 0.5` + 6 个数字键 `input tap <real bounds>` + `KEYCODE_ENTER`，**全部放进一个 `adb shell` 串**（消除主机往返间隙让它睡）；执行后 `deviceLocked=0 / isKeyguardShowing=false / mDreamingLockscreen=false`。

### 1.4 PIN 处理纪律（合规）
- PIN 值（用户已授权）只经**私有文件**（0600）读入 shell 变量，逐字符映射到**真 uiautomator 数字键 bounds**（1..9 三列三行、0 底中），**全程不 echo PIN**；所有 stdout/stderr 输出前已 redact。
- **一次正常输入即解锁**，无第二次；**未使用 `locksettings set-disabled/clear/set-pin`、未改锁屏/验证配置、未清数据、未卸主包、未 adb backup**。仅用 `locksettings get-disabled`（=false，只读）与 `dumpsys` 判据。

---

## 2. `.answerverify` 真机安装（隔离包）

- APK：`/tmp/answerverify-debug.apk`（来自 wb3-client-answer），host sha256 = `3b5d755099d806268b5d046fcfb7ebd7bb16abb9e5c93dcefd69956065958613`；推送到 `/data/local/tmp/av.apk` 后**设备侧 sha256 一致**；`aapt` 核对 `package=com.dsh.botcrew.answerverify`、versionName 0.1.0（**独立 appid，与主包并存，不切主包**）。
- 安装：`adb install -r -t --user 0 …` 挂起等待 `OPlusPackageInstallerActivity` 确认框（这是「install 挂住」的真相，不是 ROM 坏）；`uiautomator` 定位蓝色「安装」按钮 **真实 y≈2854**（前序用预览缩放坐标算错到 y≈1766 → 点空），`input tap 720 2854` 后 logcat：`PackageInstallObserver error_msg:INSTALL_SUCCEEDED: Session installed`、`Install Bot 队伍 com.dsh.botcrew.answerverify spend time:931`；`pm list packages` 出现该包。
- 主包不受影响：见 §3。

---

## 3. 主包完整性（全程只读核对，未覆盖）

| 项 | 基线（工作前） | 工作后复核 | 判定 |
|---|---|---|---|
| `firstInstallTime` | 2026-11-11 22:27:11 | 2026-11-11 22:27:11 | 未变 |
| base.apk sha256 | `eb951b55d3e93cf4d40fb05f20c1c74fe0268bf2277e9a02780a793379120a40` | 同左 | 未变 |
| 权限 | INTERNET / ACCESS_NETWORK_STATE / CHANGE_WIFI_MULTICAST_STATE / NEARBY_WIFI_DEVICES 全 granted | 全 granted | 保留 |
| 主配对 deviceId | `66e74d226c1e38fa`（生产 client 侧） | 未动（只动 `.answerverify` 独立 prefs） | 保留 |

---

## 4. 真机内部答复端到端（隔离 canary，非生产）

**链路**：真机 `.answerverify` 事务板点卡 → 真 `POST http://192.168.31.127:8799/api/mobile/answer`（body 仅 ticket/text/attention_id）→ canary 审批状态机 `applyApprovalAnswer` → go 分支真 `DshExecutor` launch/guard → 真 `MCP stdio` send_message → canary `mobileq.db replies` 落行。**不是只看 HTTP 200**。

**配对**：手机 → canary 8799 认领式配对成功；canary `remote-devices.json` 记 `deviceId=66e74d226c1e38fa`@17:28:56；app `crew-pairing.xml` token sha256 = canary 存 `digest` = `a915c6e2…495a0`（双端一致，file 内 token 已 redact）。

### 4.1 A — canary-answer-1「先别做」(stop)
- 点前（01:30:42 双方共同锚点）：`replies count=0 max_id=空`；A `ended=False pending=True attn=…77e23f741bb0`。
- 真机点 `先别做`（真机 bounds ctr 828,2336）→ UI「等你拍板·1」+「办完·1」。
- 点后：`canary-answer-1 ended={at:17:30:51, by:human, outcome:stopped, reason:主人选择先别做}`、`attention_id=null`、**replies 仍 0（零写）**。`wb2-executor-closeout` side 对账一致 PASS。

### 4.2 B — canary-answer-2「做吧」(go)
- 点前（01:31:13）：`replies count=0 max_id=空`；B `ended=False pending=True attn=…7cb13971d989`。
- 真机点 `做吧`（真机 bounds ctr 468,1356）→ UI「在跑·1」+「办完·1」。
- 点后：B `pending=False / attention_id=null / ended=None（running）`；**`replies count=1 max_id=1`**。
- **reply 行实值**：`id=1, conversation=main, to_msg=1, rkey=canary-reply-canary-answer-2, text="canary 批准后回话 canary-answer-2", at=2026-11-15T01:31:14+0800, bot_id=空` —— 正文与票 B 审批 mandate 的 text **逐字一致** = 真执行器自动 deliver + 真 MCP stdio，绝非 200 假成功。`wb2-executor-closeout` side 独立对账一致 PASS。

### 4.3 追加 stop / 陈旧态（零写 & 刷新）
- ticket3/4/5 均真机实点或 host 消费 stop：各 `ended=True/stopped`、`attention_id=null`、**replies 稳定=1（无新增写）**。
- 陈旧卡：host 先消费某 attention 后，app 轮询把该卡刷成「办完」、按钮消失（点空→不发请求），**replies 不变、无重复提交、无假成功**——这是安全方向（宁可刷新清卡也不发注定 409 的请求）。

### 4.4 409 / 400（真值判据）
- 后端 host 实测：旧 attention_id → **409 `{"error":"这张问题卡已经过期（票或请求已变），请刷新后再答"}`**；缺 attention_id → **400 `attention_id is required`**；两次均 **replies 0（零写）**。
- app 端 409：`CrewClient.answer` 捕 409 抛 `AnswerStale` → `CrewUi.answerByTicket` refresh + 明说「这张问题卡已更新，请按最新的那张再答」，不冒充成功、不重复提交。**证据**：单测 `CrewClientAnswerTest.a409BecomesAnswerStaleNotSuccess`（429 集内）+ desktop 真链路 409 三态（phase3-client-answer 报告）。真机因轮询刷新抢先，**未产生可点陈旧卡**（安全方向，如实记本机限制）。

---

## 5. canary 夹具接线缺口（如实记，非产品缺陷）

- canary minimal launcher：`const handler = phoneHandler(runtime, gatewayUrl); await handler(request)` **未套 `phoneGate`/`presentedDevice`** → 内部头 `x-crew-principal` 从不注入 → `GET /api/mobile/notices` 永远 `principalOf=undefined` → 401「Not paired」，app notices 轮询日志持续「token 不对」。
- **不影响 `/answer`**：`/answer` 只用 `principalOf` 当 **audit actor（可空）**，功能靠 ticket+text+attention_id。故本次 approve/stop 端到端全绿。
- 真部署走 `registerMobileHttp` 的 Connection + phoneGate，此缺口仅为**验收夹具简化**；已与 backend owner 对齐，**不为 notices 单独重启 canary**。

---

## 6. 正式 release APK（Android 当前版本产物）

- **路径**：`docs/review/final-android/deliver/dsh-botcrew-internal-final-20261115-0133-answer.apk`
- **sha256（盘上实测，`shasum` 与 `sha256sum` 一致，len=64）**：`44d7799527bf3a39f41307b30a8242bf3f4a004cb915b872ad0ac4e7832d29fc`
- size 12,700,437 B；**package `com.dsh.botcrew`**（默认包名，**非** `com.dsh.botcrew.answerverify`）；versionName 0.1.0 / versionCode 1；**无 debuggable flag**（release）。
- 构建：`./gradlew :app:assembleRelease`（**JDK 21**；JDK 25 会因 JavaVersion 解析失败）。unsigned sha `96d136d1e72fa2c37677d6cb93c40f2f586aaea5dcb94878afd2568edef9329f`。
- 签名：历史 debug keystore，`CN=Android Debug`，证书 SHA-1 `2D:DF:B0:71:4A:F0:CA:A4:3D:F3:B2:3D:F3:10:57:B2:06:EB:95:55`（= 设备 signer `29b26ea2` 同证书），SHA-256 `ad0e44804142148625ce90427ce3832747c29b795640cfb451745b44540af7eb`。
- manifest 权限：INTERNET / ACCESS_NETWORK_STATE / CHANGE_WIFI_MULTICAST_STATE / NEARBY_WIFI_DEVICES。
- **未改** app 源码、默认 appid、签名配置。

---

## 7. install -r 覆盖主包：已完成（lead + backend owner go）

前置门先由 `wb2-executor-closeout` 完成：**生产 `pnpm build` 重建 lib 成功**（新 lib/index.js 含 `/api/mobile/answer`+answerTicket+attention_id）→ touch+HMR 标记 → **89699/67367 lstart 未变（无重启）**，`/answer` 已热更新（无凭据→401 非 404）；生产真库 messages 68 / replies 49 / maxreply 52 / integrity ok **全程未变（零写）**；备份 `.backup-publish-20261115-013720/` 可精确回退。lead 授权后 GO install-r。

**install-r 实证（`adb install -r -t --user 0 <正式包>` → `Success`，620ms incremental）**：
| 项 | 结果 |
|---|---|
| (1) base.apk 实际 sha256 | **`44d7799527bf3a39f41307b30a8242bf3f4a004cb915b872ad0ac4e7832d29fc`** = 正式 signed APK **逐字节一致**（`/data/app/~~niJATvQl…/com.dsh.botcrew-pxQaVTf7…/base.apk`） |
| (2) firstInstallTime | **2026-11-11 22:27:11 未变**（lastUpdateTime 01:38:42 = 本次 install-r） |
| (3) 权限 | INTERNET / ACCESS_NETWORK_STATE / CHANGE_WIFI_MULTICAST_STATE / NEARBY_WIFI_DEVICES **全 granted=true** |
| (4) 主配对 | UI 实证 **session=main / work / 隧道已连接(13ms)**；deviceId 66e74d226c1e38fa（release 非 debuggable 后 run-as 读不到 prefs，以 UI session=work + 生产连通实证） |
| (5) 签名 | `signatures=[29b26ea2]`（历史 debug key），`flags=0x0`（无 debuggable，release） |

**生产零写复核**：`~/.dsh/state/superagent/mobileq.db` messages 68 / replies 49 / maxreply 52 / integrity ok **install-r 前后一致**。生产侧不做任何真实 approval 写（真 approval 全在隔离 canary，生产只 401/400/404 类零写 smoke）。

## 7.5 真身份补测（phoneGate 修复后的 canary DU6wgM）

初轮 canary minimal launcher 未套 phoneGate → notices 恒 401、answer 走无名请求。`wb2-executor-closeout` 按 lead 指令修好夹具（phoneGate：未认证/坏凭据→401、伪造 `x-crew-principal` 被剔、正确配对 derived device）。用**已配对真机 answerverify**（deviceId 66e74d226c1e38fa，`.answerverify` 独立 appid）在修好的 DU6wgM 上补验，**全走真身份 actor**：

| 判据 | 结果 |
|---|---|
| `GET /api/mobile/notices` 正确凭据 | **200** `{"device":"66e74d226c1e38fa","items":[],...}`（device 由真凭据 derived） |
| 同上 错凭据 | **401**（phoneGate 拦） |
| A 先别做 stop（canary-answer-2） | 200 stop → `ended=True/attention=null`；**replies 0（零写）** |
| B 做吧 go（canary-answer-3） | 200 go → **replies 0→1**；reply `rkey=canary-reply-canary-answer-3, text="canary 批准后回话 canary-answer-3"` 正文逐字一致；`pendingApproval→None` |
| stale 409（真凭据 + 已消费 attention） | **409 `这张票没有在等审批`**，零写 |
| 缺 attention_id（真凭据） | **400 `attention_id is required`**，零写 |
| 无凭据 | **401 "Not paired"**（phoneGate 真拦） |
| 审计 actor（A/B 均） | **`actor=66e74d226c1e38fa`**（真机真实 deviceId，非空非伪造；伪造 principal 会被 gate 剔，记不到 EVIL） |

canary 隔离：DU6wgM state mobileq.db inode `216454521` ≠ 生产 `205078136`；端口 8799/8798 独立；生产 89699/67367 全程未动、真库 68/49/52 不变。`wb2-executor-closeout` side 对 A/B/notices 逐项独立对账一致。

---

## 8. 纪律与未做
- 手机 `55c86317` 独占；未读其他 app 个人数据、未 adb backup、未清数据、未卸主包、未改锁屏/验证配置；PIN 不落日志/报告。
- 未 pkill/killall/launchctl、未 start/restart/ensure_gateway、未改全局网络/WiFi/clock；生产 dsh89699/mobilegw67367 未碰（仅与隔离 canary 8799/8798 交互）。
- 未 git add/commit/push/stash/checkout/restore/reset；未改进度/HANDOFF。
- canary 独立临时 DB + 独立端口；临时 UI 状态只在自己副本，未删 `notice-*` 全量。
- 未抢 mac 鼠标/窗口焦点（纯 adb + uiautomator，未开 GUI/scrcpy）。

## 8.5 收尾清理
- `.answerverify` 隔离副本**已卸载**（`adb uninstall` → Success）；主包 `com.dsh.botcrew` 保留=已 install-r 的正式版（firstInstallTime 2026-11-11 22:27:11 未变）。
- `/data/local/tmp/av.apk`、`answerverify-debug.apk` 等自有临时已删；PIN 私有文件（0600）已删。
- **AOD 亮屏还原**：`svc power stayon` 曾置 true 用于抗熄屏，已**还原 false**（`mStayOn=false`）；`locksettings get-disabled=false` / `settings secure lockscreen.disabled=0` 全程未动（原值）；未改锁屏/验证配置。
- canary DU6wgM 由 `wb2-executor-closeout` 精确停+删临时 state（端口释放、无残留 launcher）；生产 89699/67367 lstart 未变、真库 68/49/52 ok 不变。

## 9. 未覆盖 / 限制
- 真机 409 **UI 实点**：因 app 轮询即时刷新，陈旧卡在可点前被换成最新卡，未产生「可点陈旧卡」→ 409 以「后端真 409（真凭据，§7.5）+ 单测 `a409BecomesAnswerStaleNotSuccess` + desktop 真链路 409」为客户端证据（安全方向：宁可刷新清卡也不发注定 409 的请求）。真身份轮（§7.5）已用真凭据 host 侧 + 真机 notices200/approve/stop 覆盖。
- 初轮 notices 401 是 canary 夹具简化（§5），非产品缺陷；**已由 backend owner 修好 phoneGate 并在 DU6wgM 真身份补测 notices 200（§7.5）**，此限制已消解。
- 残余：真机 UI 上「陈旧卡仍可见且点它得 409」这一具体交互窗口因轮询抢先难以稳定复现；其处理器代码路径由上述三 seam 覆盖。
