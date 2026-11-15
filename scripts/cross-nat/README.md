# cross-nat — #20 跨 NAT 打洞成功率 可复跑工具

本目录是 **#20「弱网 / 跨 NAT 条件下 Tailcat 打洞成功率专项」** 的可复跑探针与**候选判别器（fail-closed，非验收器）**。
不含产品源码改动，独立 port / state / pid，**不碰生产隧道**（生产 `tailcat serve --key=default 43499` 与 dsh 89699 不受影响）。

> ⚠️ **判据校准（2026-11-14）**：不同公网 IP / 不同 IPv6 /64 **最多只能证明「different-network 候选」**，
> **不能单独证明「不同 NAT 已打洞」**。原生全局 IPv6 直连通常**压根没有 NAT**（端到端点对点），谈不上「打洞」。
> 同 /64 可作「排除同 LAN」的证据；**不同 /64 不能当「必为不同 NAT」**。所以 `direct-foreign`（现名
> `different_network_candidate`）**只是候选分类，不是 cross-NAT verified**。

## 为什么需要专门的判别器：public IP ≠ 不同 NAT

issue 正文警告过：「当前网络 20/20 成功」证明的是「测不出来」，不是「已修好」。根因是：
**两台在同一路由器后时，公网 IPv4 共享一个出口，IPv6 通常共享同一个 /64 前缀。**
所以 `tailcat ping` 报的 `via <addr>` 即使是**公网地址**，也可能是**同 NAT 内直连**。

- 上一版台架把「direct 且对端是公网 IP」当成打洞成功 —— 这会**把同 NAT 冒充成打洞成功**（实测 7/30 的 direct 落在与 Mac 同一 /64 的全局 IPv6 上）。
- 本目录的 `cross_nat_classify.py` 改用 **前缀 / 子网比对 + fail-closed**：
  - direct 对端落在 Mac 任一本机 `/24`(IPv4) 或 `/64`(IPv6) 内 → `same-lan`（**排除跨网**，不是打洞）。
  - direct 对端落在**所有**本机前缀之外 → `different_network_candidate`（**仅候选，不自动 verified**）。
- 对真实 `docs/review/i20/path-30.txt`（30 个 pong）复算：`derp=19 / direct=11 / same-lan=11 /
  candidate=0` → `SAME-NAT-ONLY-NOT-CROSS-NAT`（rc=2）。与人工判断一致，且**机器可复现、不误判成功**。

## 文件

| 文件 | 作用 |
|---|---|
| `cross_nat_preflight.sh` | **只读**预检：现在有没有一台「与 Mac 不同网络出口」的对端可用。退出码 0=有异网候选 peer，1=不具备。注意：0 只表示**有候选**，不表示跨 NAT 可验收。 |
| `tailcat_nat_probe.sh` | 对给定 peer `tailcat ping` N 轮，逐轮采集 final pong，交判别器归类，输出 `candidate / same-lan / derp / fail` 计数与 verdict。 |
| `cross_nat_classify.py` | 核心判别器：前缀/子网比对 + fail-closed 候选分类。默认只出候选，需显式 `--verify-cross-nat --topology-note` 才可能升级。 |
| `runs/` | 每次运行的原始产物（`preflight-*.txt`、`probe-*.txt/.json`、`pongs-*.txt`）。入库前可清。 |

## 用法

### 1) 先预检第二网络出口是否具备

```bash
./cross_nat_preflight.sh
# exit 0 = FOREIGN-NETWORK-PEER-CANDIDATE-AVAILABLE  （有异网候选，但仍非跨NAT验收）
# exit 1 = NO-FOREIGN-NAT-PEER                        （不具备，#20 第1项维持 OPEN，当前态）
```

### 2) 有候选 peer 后，起远端 serve，本机做 client 压打洞路径

```bash
# 远端（异网那台，用隔离 key）：
#   tailcat --key=i20probe serve --json 43510   → 记下输出的 listenAddr
# 本机（Mac）：
./tailcat_nat_probe.sh --peer '<listenAddr>' --count 30 --timeout 10s
# 默认 fail-closed 归类：
#   CANDIDATE-ONLY-NOT-VERIFIED（rc=2，仅候选，未验收）
#   SAME-NAT-ONLY-NOT-CROSS-NAT（rc=2，直连全是同 LAN，排除跨网）
#   NO-DIRECT-PATH（rc=3，全 derp/无 pong）
```

### 3) 只有具备跨 NAT 验收前提时才允许升级（**一条命令收证，不是自动收口**）

「异网 peer 上线」只能让工具**跑起来收证**；要满足 #20 原条款，仍须**已知双方拓扑 / IPv4 NAT 映射**，
或**明确跨网且确认是 IPv6 无 NAT 直连（须标非-NAT）**，并伴有 **direct 路径实证**：

```bash
# 例：已确认对端在另一条宽带、IPv6 原生全局无 NAT、双方出口确不同
./tailcat_nat_probe.sh --peer '<listenAddr>' --count 30 \
  --verify-cross-nat --topology-note "对端另一条宽带;IPv6原生全局无NAT点对点;已验证双方公网出口不同;附direct路径实证"
# 仅当：有direct 且 无 same-lan 反证 且 无 unknown 且 给了topology-note → CROSS-NAT-VERIFIED (rc=0)
```

> 缺 `--verify-cross-nat --topology-note`，即使 direct 全落在异网候选，verdict 仍是 `CANDIDATE-ONLY-NOT-VERIFIED`（rc=2）。

### 4) 只核对已有 pong 日志的归类

```bash
python3 cross_nat_classify.py --file <path-to-pongs>
```

## 分类规则（关键，fail-closed）

- `via DERP(...)` → `derp`（中继兜底；**relay 成功 ≠ 打洞成功**）。`--until-direct` 模式下 tailcat 不打印 derp pong，
  用 `--no-until-direct`（plain ping）才采得到 derp 轮。
- `via <addr>` 且 addr 在 Mac 某本机 `/24`(v4) 或 `/64`(v6) 内 → `same-lan`（**排除跨网**，不算打洞）。
- `via <addr>` 且 addr 在**所有**本机前缀之外 → `different_network_candidate`（**仅候选**）。
  - **不能**据「不同公网 IPv4 / 不同 IPv6 /64」单独判「不同 NAT 已打洞」：公网直连可能根本没 NAT，
    或中间是对称 NAT/CGNAT，打洞是否真的发生无法只靠地址前缀确认。
- `candidate_verified=true` 的**必要条件**（全满足）：显式 `--verify-cross-nat` + 非空 `--topology-note`
  + 至少一次 direct + **无** same-lan 反证 + **无** unknown。否则一律 fail-closed 不升级。

## 对照测试（判别器行为已钉死）

| 用例 | 输入 | 期望 verdict | rc |
|---|---|---|---|
| T1 真实 path-30 | 同/64 + 私网 direct | `SAME-NAT-ONLY-NOT-CROSS-NAT` | 2 |
| T2 异网候选无拓扑 | 8.8.8.8/1.1.1.1 + 异/64 IPv6 | `CANDIDATE-ONLY-NOT-VERIFIED`（verified=False） | 2 |
| T3 异网候选+显式验收前提 | 同 T2 + `--verify-cross-nat --topology-note` | `CROSS-NAT-VERIFIED` | 0 |
| T4 候选+同LAN反证 | 8.8.8.8 + 192.168.31.175，带 `--verify` | `CANDIDATE-ONLY-NOT-VERIFIED`（拒升级） | 2 |
| T5 全 derp | 2× DERP | `NO-DIRECT-PATH` | 3 |

## 边界（哪些不算数）

- 代理层弱网（hang/drip/delay）≠ UDP 打洞 NAT 条件，`docs/review/i20/` 的第 2 项结论不外推到打洞。
- 同 NAT 的 direct（无论私网还是同 /64 的全球 IPv6）**不是**打洞成功率证据。
- 不同公网 IP / 不同 /64 只证明「different-network 候选」，**不等于** cross-NAT verified。
- 本工具不改系统网络 / 路由 / 防火墙 / VPN / Wi-Fi，不 toggle 手机数据，不读凭据。
