# BotCrew r2 真机验收报告（cellular-20261115-r2）

验证员：wb-drawer-verify（独立真机，Android）
设备：USB 红米 `9f9cc3db` / 24117RK2CC / Android 16
交付包：[`dsh-botcrew-cellular-20261115-r2-signed.apk`](</Users/cpuser/Code/dsh-bot-crew/docs/review/cellular-20261115/deliver/dsh-botcrew-cellular-20261115-r2-signed.apk>)，sha256 `0eb388ba9ac942c5cc3ac50fd7e5716614f83b1c21a71e981a3c125274436569`
构建：`-PcrewBuildId=cellular-20261115-r2 -PcrewPublicBase=https://crew.kentonnie.top -PcrewExpectedCrew=0kvcc5t`

## 一、门禁与安装

- 单测实读 XML：`testDebugUnitTest` 与 `testReleaseUnitTest` 各 **575 / 0 失败 / 0 错误 / 0 跳过**（66 个测试类）。覆盖 Diag 家族（ClientDiag 12、DiagAck 10、DiagContractReview 6、DiagRingStoreFile 11、DiagUploader 21）与执行层（CrewClientExecution 3）。
- `assembleRelease` BUILD SUCCESSFUL。
- 签包 cert `ad0e4480…af7eb`（CN=Android Debug，与既有同签）；`install -r` Success；**firstInstallTime `2026-11-11 18:15:06` 保留**；device base.apk sha = 上述签包 sha。

## 二、覆盖升级 + 重启免配（不生成码、不重配）

- 同签覆盖安装后启动 → 直接进 main（`main▾` + 真实历史），**未落配对页**。
- `am force-stop` 后 `am start -n com.dsh.botcrew/.MainActivity`（未 mint 任何配对码）→ **仍直接进 main**，未落配对页；连接点正常（隧道/公网）。
- 全程服务端 Redmi 条目（id 尾 `d554`）**pairedAt 恒为 `2026-11-15T14:02:48.425Z`，不变**；device 数恒 3（OPPO `38fa`、Redmi `d554`、crew-desktop 未动）。
- 结论：凭据持久化 + 重启自动恢复成立，身份未丢、无需重配。

## 三、WIFI ↔ CELLULAR 免配 + 蜂窝只读

- 切换（读 `dumpsys connectivity`，非状态栏图标）：关 WiFi → 默认网络 **191 = MOBILE[LTE]，Transports CELLULAR + INTERNET + VALIDATED + NOT_VPN**。开 WiFi → 默认 **200 = WIFI**，读取恢复。
- 切换期间无 `adb reverse` / `adb forward`、`http_proxy=null`（不借 USB 或代理绕回本机）。
- 两轮切换全程 server pairedAt 仍 `2026-11-15T14:02:48.425Z` 不变。
- App 手机日志（关 WiFi 后读取）：`CrewTimeline session=main changed msgs=99 ... last=r52`（时间线读取成功）。

## 四、r2 真实 PUBLIC 业务 200（蜂窝，以 capture-at 为准）

- 服务端按真实 Redmi `d021988751fdd554`、`build=0.1.0(1)/cellular-20261115-r2`、**capture at（发生时间）≥15:09Z 且 networkKind=cellular** 筛：业务 **25 条全部 HTTP 200、routeKind=public、真域名**（`/api/mobile/timeline`×12、`/api/mobile/notices`×12、`/api/mobile/read`×1；另有 `/app/network` 切换标记 1 条不计业务）。
- capture at 时窗 `15:10:43Z … 15:12:15Z`；对应服务端 receivedAt 时窗 `15:11:02.323Z … 15:12:19.586Z`；实测 ms 范围 **610 – 6778**（真蜂窝含秒级延迟）。
- 关键：本包蜂窝业务 routeKind 均为 **public**（走真公网域名，非隧道回退）。
- `/app/network` 切换点：`15:10:25Z wifi → 15:10:43Z none → cellular`，与设备侧关 WiFi 时刻（本地 23:10:43）一致。

## 五、诊断页与手动补传

- 诊断页构建标记 `cellular-20261115-r2 · 0.1.0(1)/cellular-20261115-r2` 正确；隐私声明只记方法/去 query 路径/耗时/状态/换路/前后台/异常/崩溃，不采正文/审批/凭据/cookie/配对码。
- 点「手动补传」后，诊断页原文明确显示 **[已上报：发送 1，服务端确认 1，拒收隔离 0（保留供诊断）]**（本地有界 1 条 / 0KB；隔离 0），其下方即时行 `23:11:38 · other GET /api/mobile/timeline →200 1980ms · receive · public`。**即 manual 真实 ACK：发送 1、服务端确认 1**，非仅「无错误」。见 [`r2-03-diag-manual.png`](</Users/cpuser/Code/dsh-bot-crew/docs/review/cellular-20261115/r2-03-diag-manual.png>)。

## 六、口径与限界

- 历史 `UnknownHostException`（约 466 条）经服务端按 **capture-at** 双筛核，确认为**捕获时间早期（<15:09Z）的离线积压，于重连后集中补传**，与本轮蜂窝 **25 条 200 成功分开记录**，非本轮 WiFi 实测失败；不以 receivedAt 当发生时间。其具体成因（是否 Doze 触发）不作为结论断言。
- 双包 `com.dsh.botcrew`（cert `ad0e4480…af7eb`）与 `com.dsh.mobile`（cert `878a1159…95bef`）**异签** → 不共享 SSAID、无 device-ID 碰撞依据；`crew-pairing` prefs schema 一致（deviceId+token+crew 在即保身份）。首次缺失凭据之历史原因证据不足，不作「从未 pair」定论。

## 七、收尾

恢复 WiFi（默认 WIFI）、data 开；App 停在 main 聊天空草稿、drawer 关、诊断页/会话弹层已关、连接正常。未发送任何业务消息、未点生产审批；未触碰 `com.dsh.mobile` / OPPO；未 commit / push。

截图：[r2-02-restart-automain-public.png](</Users/cpuser/Code/dsh-bot-crew/docs/review/cellular-20261115/r2-02-restart-automain-public.png>)（重启免配后 main）、[r2-03-diag-manual.png](</Users/cpuser/Code/dsh-bot-crew/docs/review/cellular-20261115/r2-03-diag-manual.png>)（诊断页 r2 构建 + 手动补传 ACK）、[r2-04-final-main.png](</Users/cpuser/Code/dsh-bot-crew/docs/review/cellular-20261115/r2-04-final-main.png>)（收尾 main 空草稿）。

结论：r2 满足验收——门禁 575/0/0/0、同签覆盖 firstInstall 保留、覆盖/force-stop/双网切换均免配自动恢复、server pairedAt 全程不变、蜂窝 CELLULAR+VALIDATED+NOT_VPN（无 USB 代理）、**PUBLIC 业务 25 条全 200**、手动补传实际发送。
