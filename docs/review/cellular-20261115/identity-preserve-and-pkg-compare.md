# 身份保留证据 + 包 metadata 对比（只读，不改源码）

时间：2026-11-15 22:1x CST。设备：USB 红米 9f9cc3db。只读事实，无新旧 chronicle。

## 一、身份保留：force-stop → 显式启动，自动重连（不 mint code / 不清数据 / 不重 pair）

- **BEFORE**：服务端 Redmi 条目 id 尾4=`d554`，**pairedAt=2026-11-15T14:02:48.425Z**，device 数 3（OPPO `38fa` + Redmi `d554` + crew-desktop）。
- 操作：`am force-stop com.dsh.botcrew`（pid 清空）→ `am start -n com.dsh.botcrew/.MainActivity`（**未生成任何配对码**）。
- **结果**：启动后**直接进 main 聊天**（顶部 `☰ · main▾ · 隧道` + 真实历史），**未落配对页** → prefs 中的凭据自动恢复、自动建连。
- **AFTER**：Redmi `d554` **pairedAt 仍 = 2026-11-15T14:02:48.425Z（未变）**，device 数仍 3，OPPO/crew-desktop 未动。→ **无需重配、无需手点、token 保留成立**。
- **服务端 startup 记录**：diagnostics 出现 `phase=prefs_loaded`，at=2026-11-15T14:21:13Z，receivedAt=14:21:15Z，networkKind=none，version=0.1.0 → 重启后 App 上报 `prefs_loaded`，且随后 timeline/notices 200 上行。总行 200。
- 结论：**当前自动重连成立、身份未丢**（无需因「为何还重配」再做任何重配）。

## 二、包 metadata 对比（public base APK，apksigner/aapt，未读私有 prefs、未启动/改动 com.dsh.mobile）

| 项 | com.dsh.botcrew | com.dsh.mobile |
|---|---|---|
| App label | **Bot 队伍** | **AI-HUB** |
| versionName / code | 0.1.0 / 1 | 0.5.37 / 452 |
| cert DN | CN=Android Debug | CN=DeepSeek Harness Mobile |
| **cert SHA-256** | **ad0e4480…af7eb** | **878a1159…95bef** |

- **两包签名证书不同**。SSAID（Settings.Secure.ANDROID_ID）作用域 = 签名 key + user + device → **异签即不可能共享 SSAID**，故 `com.dsh.botcrew` 与 `com.dsh.mobile` **无服务端 device-ID 碰撞依据**。
- 因此 shell 侧 `2d03…` 与 App `d021…` 的差异不是两 App 同签碰撞产物；服务器 Redmi `d021988751fdd554` 即本 botcrew 安装（App 自报 ANDROID_ID）。**无碰撞需告警**（异签已排除依据）。

## 三、供 wb-external-diagnose / client owner 只读核对的旧基线包

- 旧安装包（pre-r1，本红米升级前 `31e96…`）：
  [`baseline-apk/botcrew-Redmi-old-31e96-pre-r1.apk`](</Users/cpuser/Code/dsh-bot-crew/docs/review/cellular-20261115/baseline-apk/botcrew-Redmi-old-31e96-pre-r1.apk>)
  sha256 `31e96cd6eb6ef0fe5584ce519ef1b383066cd26c7c8b113b8cb47b51c7ba57a8`
  供其只读核 prefs 文件名 / key schema 对照（我不越沙箱读 private prefs）。
