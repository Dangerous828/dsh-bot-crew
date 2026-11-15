# #20 第三阶段：跨 NAT 打洞条件 一次真实实测复核（2026-11-15 02:05 CST）

2026-11-15 02:04–02:05 CST（Asia/Shanghai）。WorkBuddy DS（`wb4-nat-recheck`）复核共享 `task-15`。
本轮为**当前时刻的一次有意义真实实测**，非复制上一轮 22:00 结论：重新跑只读 preflight、DNS 解析、
路由/ARP、三路限定短 timeout 只读 SSH、手机只读状态、生产 PID 复核。未改任何业务 source / 正式包 / 用户设置 / 网络。

## 一句话结论

**缺可用异网对端，现在在线设备同网。** 唯一现成异网候选 `win-laptop`（TP-Link `192.168.0.0/24` 出口）
三路本轮再次全部实测超时（LAN/EasyTier/公网 IPv6 各 ~6s `Operation timed out`），EasyTier peer 表无 `10.10.10.1`（当前三路不可达 + mesh 未见 + Hub 报告 offline；不据此断言物理电源状态）；
手机蜂窝 `mobile_data=0 / OUT_OF_SERVICE / 无移动口 IPv4`（不可用）；两台小米 Windows（win-desktop/mi-desktop）本轮 ARP incomplete、
且本就是**同 NAT**（不可当异网 peer）。**#20 第 1 项维持 OPEN，第 2 项早已由 #33 收口。**

## 二、逐路径实测（2026-11-15 02:04，均为限定短 timeout 只读探测）

Mac 当前：`192.168.31.127`（小米 LAN）、EasyTier `10.10.10.3`、默认网关 `192.168.31.1`、DNS 解析 `win.kentonnie.top` → AAAA `240e:3b3:26ff:f70::1000`（无 A 记录）。

| 路径 | 命令要点 | 实测 return/error | 耗时 | 结论 |
|---|---|---|---|---|
| LAN `192.168.0.109:22` | `ssh BatchMode ConnectTimeout=6` | rc=255 `Operation timed out` | 6.09s | 跨网段+当前不可达 |
| EasyTier `10.10.10.1:22` | 同上 | rc=255 `Operation timed out` | 6.07s | 不在 mesh |
| 公网 IPv6 `win-public:22`（`240e:3b3:26ff:f70::1000`） | 同上（StrictHostKeyChecking=yes，先核身份不降级） | rc=255 `Operation timed out` | 6.07s | 当前不可达 |
| EasyTier peer 表 | `easytier-cli peer` | 仅 `10.10.10.3 mac`(Local)+`10.10.10.2 nas-z4`(p2p 3.45ms) | — | **无 10.10.10.1** |
| 对照 win-desktop `192.168.31.175` | `ssh win-desktop` | rc=255 `Connection timed out during banner exchange`；ARP incomplete | 6.08s | **同 NAT**，不可用；当前不可达 |
| 对照 mi-desktop `192.168.31.183` | `ssh mi-desktop` | rc=255 `No route to host`；ARP incomplete | 0.06s | **同 NAT**，不可用 |
| NAS `10.10.10.2`（EasyTier） | peer 表 | p2p 3.45ms | — | 同 NAT，仅佐证 mesh 正常 |

`route -n get 192.168.0.109` → gateway `192.168.31.1` / en0（跨网段预期走默认网关）；`ping 192.168.0.109` 100% loss。
三路都是**连接超时**，不是 hostkey 不匹配；**未**改 known_hosts / 未 `ssh-keygen -R` / 未 `StrictHostKeyChecking=no`。

## 三、手机蜂窝（只读，未输入/唤醒/触 App/开 data/切 WiFi）

OPPO PEDM00（adb `55c86317`，在线）：`airplane_mode_on=0`、`mobile_data=0`、`wifi_on=1`、`mDataRegState=1(OUT_OF_SERVICE)`、`rmnet/ccmni` 无 IPv4。
→ 蜂窝不可用，不能当异网出口。全程只读快照，操作前后三态一致。

## 四、生产未动（复核 PID & lstart 不变）

- dsh 主进程 `89699`：**alive**，lstart `Sat Nov 14 14:26:39 2026`（不变）。
- mobilegw `67367`：**alive**，lstart `Sat Nov 14 18:31:04 2026`（不变）。
- tailcat 生产 `43499`：监听由**主进程 89699 持有**（`node 89699 ... :43499 LISTEN`），并非旧报告所写独立 PID 80750；本轮未重启。
- UU `2222`：无 LISTEN（仅有 UU 守护进程），ControlMaster 无 socket；**未**新建重连，符合“reuse 不频繁重连”。

## 五、判据纪律（沿用 lead 2026-11-14 校准，本轮坚持）

- **不**把「不同公网 IP / 不同 IPv6 /64 / native IPv6 direct」当 NAT 打洞通过。
- 原生全局 IPv6 直连通常**无 NAT**，谈不上打洞；可**单列**为“跨网 IPv6 候选（非 NAT）”，但本轮连这个候选都没有（win-laptop IPv6 也超时）。
- 同 /64 仅作“排除同 LAN”证据；本轮同 NAT 两台小米 Windows 本就同网，不作任何打洞证据。

## 五.5、lead MCP 实时节点元数据交叉核验（tool 来源：`hub_memory__hub_nodes_list`）

> 归因：以下数据由 **lead 在 goal round2 只读调用 `hub_memory__hub_nodes_list`** 获得，**非本 agent 本地再 probe**；本 agent 不冒称执行了该 MCP 调用。用途：补排 Hub registry 里是否遗漏某台「在线异网 node」。

- 返回 `count=4`：
  | node | online | last_seen_at (UTC) |
  |---|---|---|
  | `mac-workstation` | **true** | 2026-11-14T17:53:08.902891Z |
  | `mi-desktop` | false | 2026-09-26T09:16:01.735741Z |
  | `win-desktop` | false | 2026-11-14T09:14:22.232353Z |
  | `win-workstation`（笔记本） | false | 2026-11-13T23:01:40.269610Z |
- Mac 动态地址：`192.168.31.127` + EasyTier `10.10.10.3`；Hub `192.168.31.152` ping 2/2 avg `2.644ms`；global IPv6 仍 `2409:8a55:2236:2590::/64`。
- **交叉核验结论**：4 个节点中**仅 `mac-workstation` online**；笔记本（`win-workstation`）**online=false**，与本 agent 本地三路不可达 + EasyTier 无节点相互印证；**无遗漏的「在线异网 node」**——即当前 registry 里不存在可用的异网对端。lead 未改任何服务/配置。

## 六、缺什么（精确）

要让 #20 第 1 项收口，需要**一台与 Mac 不同 NAT 出口的对端**，二选一：
1. **win-laptop 接入 TP-Link `192.168.0.0/24` 出口**（唯一现成候选，当前三路不可达 + EasyTier 无节点；不据此断言物理电源状态），且**不能搬进小米网段**（一搬即同 NAT，条件消失）。
2. **另一条不同出口的网**（另一条宽带 / 手机热点）让某机接入，Mac 留小米网段；手机蜂窝当前不可用，此路暂不成立。

**拿到后仍只是“收证=候选”**：须已知双方拓扑 / IPv4 NAT 映射，或明确跨网 IPv6（标非 NAT）+ direct 路径实证，才满足原条款；
工具 `scripts/cross-nat/` 无需重写，只把 `--peer` 换成异网那台 `tailcat serve` 地址，再加 `--verify-cross-nat --topology-note` 才可能升级 `CROSS-NAT-VERIFIED`。

## 七、边界

本轮未重跑上个全 backend 测试、未改 classify 工具（无新 bug）、未更新其他最终 doc / GH 状态（保持 #20 open）、
未 git 操作、未启动/杀进程/launchctl、未抢桌面焦点、未改手机配对/权限/屏幕、未读密钥内容/argv/凭据。

## 八、取证产物

- 机器可读 JSON：`scripts/cross-nat/runs/recheck-20261115-020520.json`
- preflight 原始输出：`scripts/cross-nat/runs/preflight-20261115-020404.txt`
- 本报告：`docs/review/phase3-network/2026-11-15-issue20-recheck.md`
