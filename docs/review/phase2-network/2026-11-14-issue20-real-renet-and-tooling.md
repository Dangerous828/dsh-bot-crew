# #20 第二阶段：真实第二网络出口重测 + 可复跑判别工具

2026-11-14 22:03 CST（Asia/Shanghai）。WorkBuddy DS（`wb2-nat`）承接共享 `task-1`。
本轮**真实重测**第二网络出口条件（不沿用上一轮「三路超时」结论，重新逐项探测），
并交付**可复跑**的跨 NAT 判别工具。未改产品源码、未改 `开发进度.md`/`HANDOFF.md`/`crew-watch`、
未 git add/commit/push、未重启 dsh(89699)/mobilegw(67367)/tailcat-prod(43499)、未改系统网络/路由/防火墙/VPN/Wi-Fi、
未 toggle 手机数据、未付费开服务、未读 SIM 号码/凭据、未抢桌面焦点。

## 一句话结论

- **第二网络出口真实重测：仍不具备。** 唯一现成的异网候选 `win-laptop`（TP-Link `192.168.0.0/24` 出口）
  三条路**本轮全部实测超时**，且 EasyTier peer 表里根本没有 `10.10.10.1` —— 它**不在 mesh**，是离线/未接入，不是「间歇」。
- **手机蜂窝仍不可用**：`mobile_data=0`、`mDataRegState=OUT_OF_SERVICE`、无移动口 IPv4。手机不能当异网出口。
- **同 NAT 冒充打洞的判别已机器化修正**：上一版台架把「direct 且公网 IP」错当打洞成功（实测 7/30 的
  direct 落在与 Mac **同一 /64** 的全局 IPv6 上）。新判别器用 **前缀/子网比对 + fail-closed**，对真实 `path-30.txt`
  复算 = `derp=19 / same-lan=11 / candidate(异网)=0` → `SAME-NAT-ONLY-NOT-CROSS-NAT`。
- **判据校准（lead 2026-11-14）**：不同公网 IP / 不同 IPv6 /64 **只算 different-network 候选，不单独证明「不同 NAT 已打洞」**
  —— 原生全局 IPv6 直连通常压根没有 NAT。同 /64 可作「排除同 LAN」证据；不同 /64 不能当「必为不同 NAT」。
  故 `direct-foreign` 已更名 `different_network_candidate`，且**不自动判成功**（fail-closed）。
- **#20 第 1 项维持 OPEN**，阻塞条件已写成「一台不同 NAT 出口的对端」。工具已就位：异网 peer 一旦上线，
  `cross_nat_preflight.sh` 退出码转 0（**仅候选可达**），`tailcat_nat_probe.sh` 一条命令**收证**；
  但**仍须已知双方拓扑 / IPv4 NAT 映射，或明确跨网 IPv6（标非 NAT）+ direct 路径实证**才满足原条款，
  满足后加 `--verify-cross-nat --topology-note` 才可能升级 `CROSS-NAT-VERIFIED`。

## 一、第二网络出口真实重测（逐项实测，2026-11-14 22:01）

Mac 当前地址：`192.168.31.127`（小米 LAN）、EasyTier `10.10.10.3`、默认网关 `192.168.31.1`。

| 候选 | 路径 | 本轮实测 | 结论 |
|---|---|---|---|
| **win-laptop** | LAN `192.168.0.109:22` | `nc` 超时 | 跨网段+离线 |
| **win-laptop** | EasyTier `10.10.10.1:22` | `nc` 超时 | 不在 mesh（见下） |
| **win-laptop** | 公网 IPv6 `win.kentonnie.top:22`（`240e:3b3:26ff:f70::1000` 解析成功） | `ssh`/`nc` 超时 | 离线 |
| EasyTier peer 表 | `easytier-cli peer` | 仅 `10.10.10.3 mac`(Local) + `10.10.10.2 nas-z4`(p2p) | **无 10.10.10.1** |
| 对照 win-desktop | `192.168.31.175:22`（小米网有线） | **OK**（rc=0） | **与 Mac 同 NAT，不可用** |
| 对照 mi-desktop | `192.168.31.183:22` | 超时 | 同 NAT |
| 对照 NAS | EasyTier `10.10.10.2:8080/healthz` | 通（p2p 5ms） | 同 NAT，仅佐证 mesh 正常 |

**关键身份澄清**（这一轮明确写死，防混用）：
- `win-desktop-cf` = `xc@` **小米网段**（DESKTOP-10Q7AIV，`192.168.31.x`）—— **与 Mac 同一 NAT**，**不能**当跨 NAT peer。
  它 SSH 可达（`192.168.31.175:22` OK）只说明同网段，说明不了异网。
- `win-laptop` / `win-public` = `Administrator@` **TP-Link `192.168.0.0/24`** —— **唯一现成第二 NAT 出口**，但当前离线。
- 上一轮 `win-desktop 192.168.31.175` 上跑出的 120/120「直连」正是同 NAT 直连，本轮 `path-30` 判别器复算再次证实。

**没做强连**：对 `win-public` 用 `StrictHostKeyChecking=yes` 探活（先核身份，不 `-o StrictHostKeyChecking=no`），
结果是**连接超时**（`Operation timed out`），不是 hostkey 不匹配。没有任何改 known_hosts / `ssh-keygen -R` 的操作。

## 二、手机蜂窝（独占初始只读核查，已释放窗口给 wb2-receive）

OPPO PEDM00（adb `55c86317`）只读快照（**未 toggle、未读 SIM 号码/通讯录**）：

| 项 | 值 | 判定 |
|---|---|---|
| `airplane_mode_on` | 0 | 非飞行模式挡住 |
| `mobile_data` | **0** | 数据开关关闭（人为关闭的硬门槛） |
| `gsm.sim.state` | `ABSENT,LOADED` | 卡槽2 有卡 |
| `mDataRegState` | `1(OUT_OF_SERVICE)`，`mIsDataEnabled=false` | **未注册数据业务** |
| 移动口 IPv4 | `rmnet/ccmni` 无 IPv4 | 无承载 |
| 默认网络 | WiFi `network{109}` | 唯一在用是 WiFi（同小米网出口） |

→ 手机**不能**作为「与 Mac 不同 NAT 出口」的对端。三态快照（airplane=0/mobile_data=0/wifi_on=1）在操作前后一致，
我进来是什么样、出去还是什么样。核查结束后**立即 send_message 释放手机独占窗口给 `wb2-receive`**。

## 三、判别器修正：public IP ≠ 不同 NAT（本轮核心工程增量）

### 上一版的缺陷
`docs/review/i20/path-30.txt` 30 个 pong 里 7 个落在 `2409:8a55:2236:2590:...`（win-desktop 的**全局 IPv6**）。
按「公网 IP = 打洞成功」会把这 7 个错判为真打洞。

### 实测证明是同一 /64
```
Mac  IPv6 网关侧: 2409:8a55:2236:2590:1840:259c:ef38:3d90
peer           : 2409:8a55:2236:2590:303a:cef0:2496:ee1b
                 ^^^^^^^^^^^^^^^^^^^^ 同 /64 前缀（同一运营商前缀委派 = 同一 NAT）
```

### 修正后判别（`cross_nat_classify.py`，fail-closed 候选分类）
- direct 对端落在 Mac 任一本机 `/24`(v4) 或 `/64`(v6) 内 → `same-lan`（确证同 LAN，**排除跨网**）。
- 落在**所有**本机前缀之外 → `different_network_candidate`（**仅候选，不自动 verified**）。
  - **不能**据「不同公网 IPv4 / 不同 IPv6 /64」单独判「不同 NAT 已打洞」：公网直连可能根本没 NAT，
    或中间是对称 NAT/CGNAT，打洞是否真的发生无法只靠地址前缀确认。
- 升级 `CROSS-NAT-VERIFIED` 的必要条件（全满足）：显式 `--verify-cross-nat` + 非空 `--topology-note`
  + 至少一次 direct + **无** same-lan 反证 + **无** unknown。缺任一即 fail-closed 不升级。

对真实 `path-30.txt` 复算结果（机器输出，见 `scripts/cross-nat/runs/classify-path30-*.json`）：
```json
{"derp":19,"direct":11,"direct_same_nat":11,"different_network_candidate":0,"candidate_verified":false,"verdict":"SAME-NAT-ONLY-NOT-CROSS-NAT"}
```
与人工结论一致，且**不误判成功**。对照矩阵（详见 README）：
- T1 真实 path-30（同 /64+私网）→ `SAME-NAT-ONLY-NOT-CROSS-NAT` rc=2
- T2 异网候选（8.8.8.8/1.1.1.1+异 /64）无拓扑 → `CANDIDATE-ONLY-NOT-VERIFIED` verified=false rc=2
- T3 同 T2 + `--verify-cross-nat --topology-note`（IPv6 无 NAT 标注）→ `CROSS-NAT-VERIFIED` rc=0
- T4 候选 + 同 LAN 反证（带 `--verify`）→ 拒升级 `CANDIDATE-ONLY-NOT-VERIFIED` rc=2
- T5 全 derp → `NO-DIRECT-PATH` rc=3

## 四、交付物（`scripts/cross-nat/`，均在 `task-1` write scope 内）

| 文件 | 作用 | 复跑命令 |
|---|---|---|
| `cross_nat_preflight.sh` | 只读预检第二网络出口是否具备，退出码 0/1 | `./cross_nat_preflight.sh` |
| `tailcat_nat_probe.sh` | 对 peer 压 N 轮 `tailcat ping`，归类 candidate/same-lan/derp/fail | `./tailcat_nat_probe.sh --peer '<addr>' --count 30` |
| `cross_nat_classify.py` | 前缀/子网比对 + **fail-closed** 候选判别器（默认只出候选，需显式 `--verify-cross-nat --topology-note` 才可能升级） | `python3 cross_nat_classify.py --file <pongs> [--verify-cross-nat --topology-note ...]` |
| `cross_nat_classify.py` | 前缀/子网比对判别器 | `python3 cross_nat_classify.py --file <pongs>` |
| `README.md` | 工具契约与「public IP≠不同 NAT」陷阱说明 | — |
| `runs/` | 本轮 preflight + classify 取证产物 | — |

**不碰生产、独立隔离**：探测用隔离 key `i20probe`、独立端口 43510/43511，独立 state/pid/out dir；
生产 `tailcat serve --key=default 43499`（PID 80750）、dsh 89699、mobilegw 67367 **本轮均未重启**（复核 PID/监听仍在）。

## 五、缺什么（精确到 peer / 网络 / 窗口）

要让 #20 第 1 项真正收口，需要**一个与 Mac 不同 NAT 出口的对端**，二选一：

1. **win-laptop 联网接入 TP-Link `192.168.0.0/24` 那个出口**（唯一现成候选）。
   本轮实测它三条路全超时、EasyTier 无 `10.10.10.1`，即**离线/未接入**。需要操作者让它开机并接那个网络，
   且**不能搬到小米网段**（一搬就同 NAT，条件消失）。之后给它放 `i20-tailcat.exe`（上一轮已编出），
   清掉 `HTTP_PROXY`（若有），本机 `tailcat_nat_probe.sh --peer <listenAddr>` 一条命令**收证**。
   **收证 ≠ 收口**：即使 direct 全落在异网候选，仍须已知双方拓扑 / IPv4 NAT 映射，或明确跨网 IPv6（标非 NAT）
   + direct 路径实证，才满足原条款；满足后加 `--verify-cross-nat --topology-note` 才升级 `CROSS-NAT-VERIFIED`。
2. **另一条不同出口的网络**（手机热点 / 另一条宽带 / 公司网）让某台机器接入，Mac 留小米网段。
   手机蜂窝当前不可用（见 §二），故此路暂不成立。

拿到（1）或（2）后，本文工具**无需重写**，只需把 `--peer` 换成异网那台的 serve 地址。

## 六、本轮做过的真实动作（command / 结果）

- `cross_nat_preflight.sh`：revealed win-laptop 3/3 超时、EasyTier 无 10.10.10.1、手机 mobile_data=0 → `VERDICT: NO-FOREIGN-NAT-PEER`（exit 1）。
- `tailcat genkey --key=i20probe` + 隔离 `serve --json 43510`：拿到 `listenAddr`，起/停净化，证明 serve 侧可用。
- `tailcat_nat_probe.sh --peer <listenAddr> --count 3`：自 ping 一致 `NO-PONG (no direct path after 8s)` → 分类 `NO-DIRECT-PATH`（rc=3），
  证明**探针→采集→判别→汇总**管线端到端可跑、能净化退出。（自 ping 无 direct 属预期，UDP 自 NAT 退化。）
- `cross_nat_classify.py --file docs/review/i20/path-30.txt`：`derp=19/same-lan=11/candidate=0` → `SAME-NAT-ONLY-NOT-CROSS-NAT`（rc=2，verified=false）。
- 合成对照（真公网/异-64 vs 同 NAT）：foreign 判 3 rc=0、same 判 2 rc=2，判别器正确。
- 生产复核：`ps -p 89699`（dsh，14:26 起）、`ps -p 80750`（tailcat serve default 43499）、`lsof :43499 LISTEN` 均在，**未重启**。

## 七、边界声明

- 本轮**未**做真实跨 NAT 打洞（条件不具备）；**没有**拿任何同 NAT 数字冒充收口。
- 未关 WiFi、未 toggle 手机数据、未改 APN / 系统 VPN / 防火墙 / 路由、未付费开服务、未查套餐、未读 SIM 号码/通讯录、未发短信/电话。
- 未读任何凭据内容；未 git 操作；未碰 NAS worktree；未抢桌面焦点。
- 第 2 项 `probeBudget()` 慢滴缺陷的结论沿用上一轮 `docs/review/2026-11-14-issue20-weaknet-nat.md` §一，本轮未重跑（与本轮跨 NAT 任务独立）。

## 八、给 #20 的收口建议

1. 第 1 项**保持 OPEN**，阻塞写死为：「缺一台不同 NAT 出口的对端；唯一候选 win-laptop 本轮实测离线（三路超时+
   EasyTier 无节点）；手机蜂窝不可用（mobile_data=0/OUT_OF_SERVICE）。工具 `scripts/cross-nat/` 就绪，
   **异网 peer 上线只能一条命令收证（候选），仍须已知双方拓扑 / IPv4 NAT 映射 或 明确跨网 IPv6（标非 NAT）
   + direct 路径实证才满足原条款**，满足后加 `--verify-cross-nat --topology-note` 才升级 `CROSS-NAT-VERIFIED`。」
2. 不拿同 NAT 的 direct（私网或同 /64 IPv6）当打洞成功率——本判别器已把这条钉成机器判据。
3. 第 2 项（`probeBudget` 慢滴无上界）另开缺陷单处理，与本条独立。
