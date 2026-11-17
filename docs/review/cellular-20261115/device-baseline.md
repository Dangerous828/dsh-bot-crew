# 蜂窝（异网）基线 — 真实设备只读核验

时间：2026-11-15 21:14 CST 起。执行：wb-drawer-verify（Android 独立真机验证）。lead 只决策。

> 本文件脱敏：不含手机号/IMSI/ICCID/SSID/BSSID/MAC/具体 IP。仅记网络类型、状态、能力、耗时。

## 一、设备身份（USB，实时 adb devices -l）

- `adb devices -l` → **`9f9cc3db device usb:17825792X product:zorn model:24117RK2CC device:zorn`**
  = **红米 Redmi 24117RK2CC / zorn / serial 9f9cc3db**（lead 指定目标）。
- 仅 USB transport 一条；**无无线 adb（adb-...tls）通道**（不存在，故非唯一通道问题）。
- Android 16（ro.build.version.release=16）。
- 锁屏：`mWakefulness=Awake`、`isKeyguardShowing=false` → **未锁屏**，无需 PIN/未碰锁屏。
- **未尝试** OPPO 55c86317（不在列表，非目标）。

## 二、App 包（勿混包）

| 包 | versionName | firstInstallTime | lastUpdateTime | base.apk sha256 | cert SHA-256 |
|---|---|---|---|---|---|
| **com.dsh.botcrew（目标）** | 0.1.0 | **2026-11-11 18:15:06** | 2026-11-15 15:46:05 | **`31e96cd6eb6ef0fe5584ce519ef1b383066cd26c7c8b113b8cb47b51c7ba57a8`** | `ad0e4480…af7eb` |
| com.dsh.mobile（**另一包，勿混**） | 0.5.37 | 2026-10-23 22:53:27 | — | — | — |

- 红米上 `com.dsh.botcrew` base.apk = `31e96…57a8` = **旧版（未含本批 sidebar）**，非新 sidebar `e645…`。符合 lead「旧红米 31e96…上一批未装 sidebar」。
- cert `ad0e4480…af7eb` = 与后续同签覆盖同一把 debug key（`CN=Android Debug`），后续同样可 install-r 保数据。

## 三、网络基线（关 WiFi 前）

- **WiFi**：`wifi_on=1`，**active default network = 197（WIFI，VALIDATED）**。SSID/BSSID 已脱敏。
- **移动数据**：`settings global mobile_data=0`（全局读数误导）；实测 **`mobile_data1=1`（SIM1 数据启用）**、**`multi_sim_data_call=6`（默认数据 = subId 6）**、**`mActiveDataSubId=6`**。→ 蜂窝数据实际启用，默认数据卡为 subId 6。
- **双 SIM 服务态**（脱敏）：
  - subId 4 = 中国移动，LTE，`mDataRegState=IN_SERVICE`，PS 域 DATA+MMS 可用。
  - subId 6 = 中国电信，NR_SA，`mDataRegState=IN_SERVICE`，PS 域 DATA+MMS 可用；（WiFi 下另有 IWLAN=VoWiFi 注册）。
- **蜂窝 Internet 代理存在**：`ni{MOBILE[LTE] CONNECTED extra: ctnet}` 带 `INTERNET&VALIDATED`（subId 6），非仅 IMS。→ 关 WiFi 后有可用且已验证的蜂窝 Internet 网络可承接默认网。
- METERED：WiFi 侧 `NOT_METERED`；蜂窝侧（`ctnet` INTERNET 代理）**METERED**（预期，`LinkUp/Dn` 有带宽估计）。

## 四、基线复现前提（关 WiFi 前确认）

- USB 可用（`adb -s 9f9cc3db` 稳定，非无线通道）→ 关该机 WiFi 后仍可全程 adb 取证。
- 已排除误用 OPPO / com.dsh.mobile；仅操作 `-s 9f9cc3db` 的 `com.dsh.botcrew`。

## 五、后续步骤（本文件只记基线；实测结论写 verification.md）

关 WiFi → 确认 `active default network` 变 CELLULAR 且 **VALIDATED**（读 connectivity，非看图标）→ 排除 USB reverse/tether/VPN 绕回 Mac → 取 App UI/route 状态、过滤本包 pid 的 logcat（脱敏）→ 只读 timeline 加载 → 恢复原 WiFi。记录原 WiFi 状态以便恢复（SSID 不落盘，仅记「原 WiFi 网络，恢复开 wifi_on=1 自动重连同网」）。
