# #20 第二阶段前置：真机蜂窝数据可用性只读核对（第一阶段）

2026-11-14。**只读**确认 OPPO PEDM00（adb serial `55c86317`）当前是否具备**已启用可用 CELLULAR 传输 / 数据网络**。
本轮**未关 WiFi**、未改 APN / 系统 VPN / 防火墙 / 路由、未发短信 / 打电话、未付费开服务、
未读 SIM 号码 / IMSI / 通讯录 / 个人账号内容（只读连接状态与注册态字段）、未碰生产服务、
未 git 操作、未抢焦点、未动手机配对资产。**结论：当前不具备可用蜂窝数据，第二阶段按规则不启动。**

## 一句话结论

手机 SIM 卡是**装着的**（`gsm.sim.state=ABSENT,LOADED`，卡槽2 已加载）且**飞行模式关闭**（`airplane_mode_on=0`），
但**移动数据开关是关的**（`mobile_data=0`）、**数据业务注册是 OUT_OF_SERVICE / NOT_REG_SEARCHING**、
**无任何移动口 IPv4**（`rmnet_data0` 只有 link-local IPv6）、**默认网络是 WiFi**。四处独立证据一致：
**当前没有一条已启用、可用的 CELLULAR 数据网络**。按任务约定，第二阶段（关 WiFi 让路由走手机数据）**不启动**。

## 只核对、未读取的边界

- 只读 `settings`（airplane / mobile_data）、`getprop gsm.sim.state`、`dumpsys connectivity` 的传输与路由、
  `dumpsys telephony.registry` 的注册态、`ip addr` 接口。
- **未**读 `gsm.sim.operator.numeric` 之外的号码 / IMSI / ICCID，**未**读通讯录、短信、账号。
- **未**做任何写操作：未 toggle 数据、未改 APN、未动 WiFi、未改系统网络。

## 证据（均为只读字段）

| 项 | 观测值 | 判定 |
|---|---|---|
| 飞行模式 | `airplane_mode_on = 0` | 关闭（不是飞行模式挡住） |
| 移动数据总开关 | `mobile_data = 0` | **数据关闭** |
| 每订阅数据使能 | `mIsDataEnabled=false`（两 subscription 均 false） | **未使能数据** |
| SIM 卡槽 | `gsm.sim.state = ABSENT,LOADED` | 卡槽2 已加载 SIM（卡在） |
| 数据注册态（phoneId=1 / subId=8） | `mDataRegState=1 (OUT_OF_SERVICE)`、PS WWAN `NOT_REG_SEARCHING`、`availableServices=[EMERGENCY]` | **仅紧急，未注册数据业务** |
| 协议栈可用性标志 | `isNrAvailable=false`、`isEnDcAvailable=false` | 数据承载不可用 |
| 移动口地址 | `rmnet_data0` 仅 `fe80::…` link-local IPv6，**无 IPv4** | 无可用 IP 承载 |
| 默认网络 | `network{109}` `Transports: WIFI`（`wlan0`，SSID `Xiaomi_DangerN_5G`，`192.168.31.55`） | 唯一在用的网络是 WiFi |

注：日志里 `mDataRegState` 全程 `OUT_OF_SERVICE`；偶见 `getRilDataRadioTechnology` 在 NR_SA/LTE 间跳变、
`rRplmn=46001/46011` 等，那是**底层射频扫到的邻区/RAT 变化**，配合 `registrationState=NOT_REG_SEARCHING`
与 `availableServices=[EMERGENCY]` 说明**只是能搜到信号，并未注册上任何运营商数据业务**——搜到 ≠ 注册 ≠ 可用。
`mobile_data=0` 是硬门槛：开关关着，即便有卡有信号也不会建立数据 PDP。

## 具体缺口（第二阶段启动前必须补齐）

要让「关 WiFi → 路由走手机数据」这条路成立，需要**同时**满足：

1. **打开移动数据开关**（`mobile_data` 置 1 / `svc data enable`）。当前为 0——这是人为关闭，非网络限制。
2. **SIM 能注册上数据业务**：当前该订阅 `mDataRegState=OUT_OF_SERVICE`、仅 EMERGENCY。
   这可能是：该卡无数据套餐 / 欠费 / 卡未激活 / 该位置当前无对应运营商数据覆盖。
   —— 本轮按约束**未去查询套餐、未拨打客服、未付费开服务**。
3. 上述两项满足后，需确认 `rmnet` 口拿到 IPv4/IPv6 全局地址且 `mDataRegState=IN_SERVICE`，
   才算「已启用可用 CELLULAR」。

其中第 1 项是手机设置里一个开关（操作者可自行打开，无需付费开服务）；第 2 项是否可满足**取决于该卡套餐与
当前位置运营商数据覆盖**，属操作者侧信息，超出本轮只读范围，不作猜测。

## 处置（已裁定：本轮暂停，保持现状）

- **第二阶段不启动、移动数据不打开、不查套餐**：本轮只读核对已给出具体外部条件，到此结束。
  未关 WiFi、未 toggle 数据、未做跨网出口探测、未发 canary，手机保持现状。
- **#20 第 1 项维持 OPEN**，真实跨 NAT 条件仍不成立。阻塞在既有文档
  （`2026-11-14-issue20-weaknet-nat.md`）之外再精确一条并在本报告固化：
  手机侧当前**无可用蜂窝数据**——`mobile_data=0`（数据开关关闭）且 `mDataRegState=OUT_OF_SERVICE`
  （未注册可用数据承载）。因此手机不能作为「与 Mac 不同 NAT 出口」的对端。
- 本条为**既定暂停条件**，不再向用户追问套餐或任何一般操作确认。

## 后续需满足的可观测信号（满足后由 owner 决定是否重开第二阶段，无需一般操作确认）

进入第二阶段的前提不是「口头确认」，而是下列**可观测信号同时为真**（可用上面的只读命令复现）：

1. `settings get global mobile_data` → `1`（移动数据开关已打开）。
2. `dumpsys telephony.registry` 中该订阅 `mDataRegState=0 (IN_SERVICE)`，不再是 `OUT_OF_SERVICE`；
   `registrationState=REGISTERED`（不再是 `NOT_REG_SEARCHING`），`availableServices` 含 `DATA`（不再仅 `EMERGENCY`）。
3. `ip -4/-6 -o addr` 中 `rmnet_data0`（或对应 ccmni）拿到**全局可路由地址**（非仅 link-local）。
4. 默认网络在关 WiFi 后可切到 `Transports: CELLULAR`（此时才具备「与 Mac 不同 NAT 出口」的前提）。

上述 1–4 全绿 = 「已启用可用 CELLULAR」，才重新发起第二阶段；届时按既定记录项执行
（换网前 WiFi/数据/飞行/路由/暂停快照、小量探测 + canary、结束或失败即恢复、
与 wb-memory-sync 协调时间窗不全局 pause）。任一不满足，保持 OPEN、手机不动。

## 复现命令（只读）

```bash
S=55c86317
adb -s $S shell settings get global airplane_mode_on        # 0
adb -s $S shell settings get global mobile_data             # 0  ← 数据开关关闭
adb -s $S shell getprop gsm.sim.state                       # ABSENT,LOADED ← 卡在
adb -s $S shell dumpsys connectivity | grep -m1 "Active default network"   # WIFI
adb -s $S shell dumpsys telephony.registry | grep -E "mDataRegState=|mIsDataEnabled"
adb -s $S shell ip -4 -o addr | grep -E "rmnet|ccmni" || echo "no mobile IPv4"
```
