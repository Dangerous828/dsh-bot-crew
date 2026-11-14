# 常驻托管方案分析（#12 第 1 项的前置）— **已归档，暂不推进**

> **决策（2026-11-14，用户）**：常驻托管**不推进**，当前就以 Mac 为终端。
> 本文留档备将来重开，不是待办事项。下面保留调研内容，供将来参考。

> 2026-11-14 只读调研。本文只摆事实与取舍，不代替决策。

## 问题

后端跑在 Mac 的 tmux 里（`dsh-superagent` session）。Mac 睡了 / 断网 / 关机 = 助手没了。
#12 第 1 项要求「选一个地方让后端一直住着」，验收标准是「宿主机关机/断网后，
手机仍能连上助手并收到回复；或降级状态明确可查」。

## 已核实的事实

| 项 | 事实 | 证据 |
|---|---|---|
| dsh 本体 | **纯 node 包**，`#!/usr/bin/env node`，`--no-open` 不需要 Electron | `~/.nvm/.../bin/dsh` 首行 |
| 当前托管 | Mac 上的 tmux session，PPID 是 tmux 而非 launchd | `tmux ls` / `ps -o ppid` |
| 开机自启 | **只给 mobilegw 和 mobile-tunnel 配了 launchd，dsh 本体没有** | `~/Library/LaunchAgents/` |
| NAS node | v22.22.3（dsh 要求见 `package.json` engines） | `hermes-run` 实测 |
| NAS docker | 26.1.5 | 同上 |
| NAS git/python3 | 都有 | 同上 |
| NAS `gh` | **没有**（GitHub Source 需要它） | 同上 |
| NAS 磁盘 | 411G 可用（79% 已用） | `df -h` |
| relay 已在 NAS | `crew-relay` 容器，0.1.1，`tunnels: 1` | 本轮部署记录 |

## 三个方案

### A. Mac + launchd（最小改动）

把现在 tmux 里跑的 dsh 改成 launchd 常驻，`KeepAlive` + `RunAtLoad`。

- **能解决**：崩溃自拉起、开机自启、tmux 不用手开。
- **不能解决**：Mac 睡眠 = 进程挂起（`caffeinate` 只能防闲时睡眠，合盖还是会睡）；
  断网 = 连不上；关机 = 没了。**不满足 #12 的验收标准。**
- 工作量：小（一个 plist + 迁移现有启动参数）。

### B. NAS 常驻（满足验收标准的正路）

在 NAS 上跑 dsh（纯 node，可直接跑；或用现有 `crew-relay` 那套 docker 模式）。

- **能解决**：Mac 睡了/关机了助手仍在线；NAS 本来就是常开。
- **代价与风险**：
  1. **worker 执行环境变了**。现在 `executor.directory` 是空（用默认），worker 在 Mac 上跑
     shell / 读写文件 / 用 `gh`。搬到 NAS 后这些都在 NAS 的容器里 —— 要确认 worker 需要的
     东西（git 有、gh 没有、仓库要不要 clone 到 NAS）都在。
  2. **stateDir 迁移**：`~/.dsh/state/superagent/` 里有会话、票、队列、凭据。
     搬过去要么整份拷、要么从空开始（后者会丢历史票与配对）。
  3. **配对凭据**：手机现在配的是 Mac 的 instanceId / 公钥。换宿主要么沿用同一份凭据
     （搬 stateDir），要么手机重新配对。
  4. **NAS 缺 `gh`**：GitHub Source 会不可用（除非装）。当前 `sources.github.enabled = false`，
     所以**暂时不影响**，但要在文档里写明。
- 工作量：中（stateDir 迁移 + 启动方式 + 一次真机重连验收）。

### C. 云主机（最彻底，成本最高）

VPS 上跑 dsh + relay。

- **能解决**：真正 7×24，与家里网络解耦。
- **代价**：要付钱、要管凭据、worker 要能访问 GitHub（需要 token）、
  家庭局域网相关的能力（LAN 直连、mDNS 发现、P2P 打洞到家里的机器）会失去意义 ——
  而 P2P/LAN 正是这套东西花了很多功夫的部分。
- 工作量：大。

## 建议

**先做 A，再做 B。** 理由：

1. A 是 B 的前置：launchd 那套 plist 的写法、日志落点、重启策略，B 里能直接复用思路。
2. A 单独就有价值：现在 dsh 跑在 tmux 里，tmux 一关就没了，这个脆弱性跟「一直在线」是两件事，
   但先修掉它成本很低。
3. B 的真正难点不是「能不能跑起来」，是 **stateDir 迁移与配对凭据**。
   这两件事做错会丢历史票、让手机要重新配对 —— 应该单独一轮做，且有回滚路径。

## B 要落地前必须先回答的三个问题

1. **stateDir 怎么迁**：整份拷（保留历史票与配对）还是从空开始（干净但要重配）？
   整份拷的话，Mac 与 NAS 不能同时跑（同一个 stateDir 锁会冲突）。
2. **worker 在哪跑**：NAS 容器里（需要 clone 仓库、装 gh）还是仍回 Mac 跑（那就没解决「Mac 关机」）？
3. **手机要不要重配**：沿用同一 instanceId + 凭据（手机无感），还是换新（要重新配对）？

## 本文没做的事

- 没有改任何配置、没有部署、没有迁移数据。
- 没有测 NAS 上跑 dsh 的可行性（只确认了 node/docker/git 存在）。
  真要验，得在 NAS 上起一个**独立的** DSH_HOME 试跑，不碰生产 stateDir。
