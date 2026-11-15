# mobilegw 意外重启事故核查（2026-11-14）

> 执行者：`ds-process-incident-max`（lead 委派，单任务只读核查）
> 性质：**只读取证**。全程未发送任何信号、未重启任何服务、未改配置、未动 launchd、未做任何 git 操作、未读个人 shell 历史、未读任何凭据值。
> 写范围：仅本文件（`docs/review/incident/`）。

---

## 零、结论先说

| 问题 | 结论 |
| --- | --- |
| 谁停了生产 mobilegw | **本树任务 `ds-network20-max` 的两条 `pkill -f "backend/tools/mobilegw"`**，不是第三方、不是 HMR、不是 launchd 自身动作 |
| 几次 | **两次**：`41418`→`65972`（18:29:49.247）、`65972`→`67367`（18:31:04.172） |
| pkill PID | `65970` 与 `67365`（pkill 自身，短命，无 argv 留档） |
| 现在状态 | **已恢复**。`67367` 由 launchd 自动拉起，独占 `127.0.0.1:8788`，健康 13/13 ready |
| dsh 是否被牵连 | **没有**。`89697`（bash 包装壳）与 `89699`（真 node）父子关系、`lstart` 全程未变 |
| 数据是否丢失 | **没有**。`mobileq.db` 三会话消息数与 timeline 实测逐条对齐 |
| 红线 | **被触发**：该任务的红线明文含「不重启 dsh/mobilegw」，它执行了 `pkill` 并实际重启了 mobilegw |

**根因不是「某个人手滑」，是命令模式与托管方式冲突**：`pkill -f "backend/tools/mobilegw"` 是一个**路径子串**匹配，而 launchd 托管的生产网关命令行里正好含这一整段路径。命令作者的目标是自己刚起在 `43510` 的测试网关，实际命中的是 `8788` 上的生产网关。同类模式在历史里已发生过至少两次（见 §六）。

---

## 一、事件本体（launchd 统一日志逐字）

```
$ log show --start '2026-11-14 18:28:00' --end '2026-11-14 18:33:00' \
    --predicate 'process == "launchd" AND eventMessage CONTAINS "dsh-mobilegw"' --style compact

2026-11-14 18:29:49.247 Df launchd[1:7b0a06] [gui/502/com.cpuser.dsh-mobilegw [41418]:] exited due to SIGTERM | sent by pkill[65970], ran for 66521578ms
2026-11-14 18:29:49.247 Df launchd[1:7b0a06] [gui/502 [100024]:] service inactive: com.cpuser.dsh-mobilegw
2026-11-14 18:31:04.172 Df launchd[1:7b125d] [gui/502/com.cpuser.dsh-mobilegw [65972]:] exited due to SIGTERM | sent by pkill[67365], ran for 74921ms
2026-11-14 18:31:04.172 Df launchd[1:7b125d] [gui/502 [100024]:] service inactive: com.cpuser.dsh-mobilegw
```

反推启动时刻（用 `ran for` 毫秒数）：

| PID | 存活 | 反推 lstart | 结束原因 |
| --- | --- | --- | --- |
| `41418` | 66 521 578 ms | **2026-11-14 00:01:07.669** | SIGTERM by pkill[65970] |
| `65972` | 74 921 ms | 2026-11-14 18:29:49.251 | SIGTERM by pkill[67365] |
| `67367` | 至今 | 2026-11-14 18:31:04.173 | — （当前存活） |

两次都由 launchd 的 `KeepAlive:true` 立刻拉起，**没有任何人执行 `launchctl`**。

---

## 二、归因：两条命令，原始工具日志

归因不依赖任何 agent 自述。证据取自 DSH 会话落盘 `~/.dsh/sessions/--Users-cpuser-Code--/d681139d-0b40-436b-a6d5-4a16254a69a4/session.v4.jsonl.zstd` 的 `tool/call` 原始记录（`name=bash`，`arguments.command` 原文）。

会话身份（同文件 `subagent/descriptor` + 父会话 `subagent/catalog`）：

```
childId        d681139d-0b40-436b-a6d5-4a16254a69a4
label          "Max 核验弱网与跨网测试条件"
name           ds-network20-max
parent         session-69d788e7-8052-4800-9a69-1203af1bc245   (delegationDepth 1)
agentPreset    unrestricted-child-b5beb73b2d
```

### 2.1 第一条（对应 `pkill[65970]`）

```
tool/call  time = 2026-11-14 18:29:49.208   callId = call_00_rycogp4j8wgqffqwcmjv581t

cd /Users/cpuser/Code/dsh-bot-crew && pkill -f "backend/tools/mobilegw" 2>/dev/null; sleep 1
DSH_HOME=/tmp/i20/gwhome MOBILEGW_PORT=43510 MOBILEGW_HOST=127.0.0.1 nohup python3 backend/tools/mobilegw > /tmp/i20/gw.log 2>&1 &
echo "gw pid $!"; sleep 3; head -3 /tmp/i20/gw.log; lsof -nP -iTCP:43510 -sTCP:LISTEN | tail -2; echo "=== token file ==="; ls /tmp/i20/gwhome/state/*/ 2>/dev/null | head
```

```
launchd 记录 SIGTERM        = 2026-11-14 18:29:49.247
命令发起                    = 2026-11-14 18:29:49.208
差值                        = 39 ms
```

### 2.2 第二条（对应 `pkill[67365]`）

```
tool/call  time = 2026-11-14 18:31:04.137   callId = call_00_8zcm81xnjk9f5rkj394k71h8

cd /Users/cpuser/Code/dsh-bot-crew && pkill -f "backend/tools/mobilegw" 2>/dev/null; pkill -f "tailcat serve --key=i20probe" 2>/dev/null; sleep 1
# 用可控服务器当「隧道那头」：/api/mobile/timeline 回 200，其余 404 —— 与产品 probe() 的判据一致。
cd docs/review/i20 && nohup python3 probe_server.py 43510 normal > /tmp/i20/pserver.log 2>&1 &
echo "pserver pid $!"; sleep 2; head -2 /tmp/i20/pserver.log; lsof -nP -iTCP:43510 -sTCP:LISTEN | tail -1
```

```
launchd 记录 SIGTERM        = 2026-11-14 18:31:04.172
命令发起                    = 2026-11-14 18:31:04.137
差值                        = 35 ms
```

### 2.3 为什么能确定是这两条

四条独立证据同时成立，缺一不可：

1. **全库唯一匹配**。扫描 `~/.dsh/sessions` 下 **1038** 个 `session.v4.jsonl.zstd`，把所有 `tool/call(name=bash)` 的 `command` 文本过滤 `pkill` + (`mobilegw`|`tailcat`)，**只有 `d681139d` 这一个会话在 11-14 18:2x–18:3x 命中生产路径**。同期其他会话的 `pkill` 目标分别是 `fixture/server.py 18899`、`fixture.py 18911`、`tailcat-mac forward`、`tailcat serve --key=i20probe`、`probe_server.py 43510` —— **都不匹配 `backend/tools/mobilegw`**。
2. **毫秒级时间对齐**。两次命令发起都在 launchd 记录 SIGTERM 之前 35–39 ms，正是 `fork+exec pkill` 到内核投递信号的量级。
3. **PID 序号关系**。`pkill` 的 PID 严格小于随后 launchd 拉起的 PID（`65970 < 65972`、`67365 < 67367`），与「pkill 先退出、launchd 再 spawn」的因果顺序一致。
4. **该会话自述与之吻合**。同会话 18:31:04 的 assistant 文本原文：「隧道已连通，但 `mobilegw` 提供的是 `/timeline`，而不是生产路径 `/api/mobile/timeline`；同时 forward 进程已经退出。」—— 说明它当时确实在操作 `mobilegw` 进程本身。

### 2.4 动机链（为什么它会去 pkill）

同会话 18:29:39.949 的一次尝试（`call_00_p1uowj38tkfik7oyzwl0p6m0`）失败，原文结果：

```
gw pid 65832
mobilegw on 127.0.0.1:8788 conv=main session_api=1
Traceback (most recent call last):
  File "/Users/cpuser/Code/dsh-bot-crew/backend/tools/mobilegw", line 354, in <module>
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
  File ".../socketserver.py", line 452, in __init__
```

它设了 `DSH_HOME=/tmp/i20/gwhome` 但**没设** `MOBILEGW_PORT`，于是落回默认 `8788`，撞上生产网关 → `Errno 48`（address already in use）。下一步它的修法就是「先 pkill 掉占端口的网关再重起」—— 但 pattern 写成了路径子串 `backend/tools/mobilegw`，把生产那份一起带走了。

### 2.5 归因的边界（不夸大）

`65970` / `67365` 这两个 pkill 进程本身**没有留下 argv 或父进程记录**：

```
$ log show --predicate 'process == "pkill"' --start '2026-11-14 18:29:40' --end '2026-11-14 18:31:10'
（零条）
```

所以严格说：**归因对象是「该会话的两条 bash 命令」**，不是「抓到了 pkill 的调用栈」。上面四条证据共同支持这一归因，没有一条能单独成立。这不构成「第三方」或「非本树」的暗示——恰恰相反，本树内已有直接命令文本。

---

## 三、dsh 侧未受牵连（核验，非引用）

```
$ ps -o pid,ppid,lstart,command -p 89697,89699
   PID   PPID STARTED
 89697      1 Sat Nov 14 14:26:39 2026   bash -c cd /Users/cpuser && nohup .../dsh --profile superagent ...
 89699  89697 Sat Nov 14 14:26:39 2026   node .../dsh --profile superagent --no-open --trusted-host ...

$ lsof -nP -iTCP:43499 -sTCP:LISTEN
node 89699  ... TCP 192.168.31.127:43499 (LISTEN)
node 89699  ... TCP 127.0.0.1:43499 (LISTEN)
node 89699  ... TCP [::1]:43499 (LISTEN)
node 89699  ... TCP 10.10.10.3:43499 (LISTEN)   （共 7 条）
```

- `89697` 是 `bash -c` 包装壳（PPID=1），`89699` 是真 node 进程（PPID=89697）。**二者是父子，不是「PID 记录误差」**，`lstart` 完全一致且都是 `Sat Nov 14 14:26:39 2026`，与 release 报告记录相同。
- 口径订正一处：release 报告写的「dsh PID **89697** 前后不变」——严格讲**真正的 dsh 进程是 89699**，89697 只是它的 nohup 外壳。两个 PID 都没变，结论不受影响，但后续文档以 `89699` 指代 dsh 更准确。
- **`67367` 的 PPID 是 1**，即 launchd 直接托管，**不是 `89699` 的子进程**。这从结构上证明：HMR 重组、重启 dsh、改 profile patch 都不可能碰到 mobilegw。

---

## 四、当前服务状态（实测）

### 4.1 launchd

```
$ launchctl print gui/502/com.cpuser.dsh-mobilegw
	state = running
	pid = 67367
	runs = 5
	program = /usr/bin/python3
	arguments = { /usr/bin/python3, /Users/cpuser/Code/dsh-bot-crew/backend/tools/mobilegw }
	environment = { MOBILEGW_CONV => main, MOBILEGW_PORT => 8788, MOBILEGW_HOST => 127.0.0.1 }
	stdout path = /Users/cpuser/.dsh/state/superagent/mobilegw.out.log
	stderr path = /Users/cpuser/.dsh/state/superagent/mobilegw.err.log
```

`runs = 5` 是 launchd 对该 job 的累计运行次数，不是本次事故次数。

### 4.2 精确 bind

```
$ lsof -nP -iTCP:8788 -sTCP:LISTEN
Python  67367  cpuser  4u  IPv4  ...  TCP 127.0.0.1:8788 (LISTEN)
```

**只有 `67367` 一个监听者，回环口，无 `0.0.0.0` 暴露**。与 plist 的 `MOBILEGW_HOST=127.0.0.1` 一致。

### 4.3 健康 13 项全 ready

```
$ curl -s -H 'X-Orchestrator-Request: 1' http://127.0.0.1:3082/orchestrator/api/state
```

| 项 | state | detail |
| --- | --- | --- |
| runtime | ready | Orchestrator is ready |
| relay | ready | Nothing waiting |
| notice | ready | Nothing waiting |
| memory | ready | 中枢凭据来自凭据文件 |
| launch | ready | Nothing waiting |
| delivery | ready | Nothing waiting |
| assessment | ready | Nothing waiting |
| reply | ready | Nothing waiting |
| evals | ready | No unavailable Eval in the last hour |
| models | ready | No managed Session is waiting on a model budget retry |
| p2p | ready | direct tunnel at tcpGFwWCDQf-… |
| github | ready | 0 notifications; next poll ≥ 60s |
| team | ready | 0 messages, 0 unreadable |

**13/13 ready，0 项非 ready**。`paused=false`，`load={running:0,queued:0,maxWorkers:3}`，`masterId=orchestrator-bbbb4bafe8b5e5afe49748149f93df3d`，`isolation=none`、`isolationActive=false`（本轮未翻默认）。

> 说明：`/orchestrator/api/*` 有 same-origin 围栏（`backend/src/app/http.ts:78` 的 `sameOrigin()`），必须带 `X-Orchestrator-Request: 1`，否则一律 403「Same-origin management request required」。只读取证用该头即可，不需要 token。

### 4.4 会话能力（`session_api=1`）实测

用 `<stateDir>/mobilegw.token` 作 `X-GW-Token`（**值不复述**）：

| 请求 | HTTP | items | 回显 |
| --- | --- | --- | --- |
| `/timeline?session_id=main` | 200 | 96 | `session_id=main, session_api=1` |
| `/timeline?session_id=work` | 200 | 16 | `session_id=work, session_api=1` |
| `/timeline?session_id=team` | 200 | 1 | `session_id=team, session_api=1` |
| `/timeline`（不带 session，老调用） | 200 | 96 | 仍回 `session_id`（=main） |
| `/api/mobile/timeline`（生产前缀） | 401 | — | 无 token 正确拒绝 |
| `/health` | 200 | — | `{"ok": true}` |

`roles` 含 `user` 与 `agent` 两类，`reply_to` / `read_at` 字段在位。**会话分流是真实生效的，不是只回显**：`work` 只有 16 条而 `main` 有 96 条。

### 4.5 数据一致性（重启未丢消息）

```
$ sqlite3 mobileq.db "select (select count(*) from messages where conversation='main' and withdrawn_at is null),
                             (select count(*) from replies where conversation='main');"
56|40          → 56 + 40 = 96   = timeline 实测 96   ✓

work:  9 + 7  = 16  = timeline 实测 16              ✓
team:  1 + 0  =  1  = timeline 实测  1              ✓
```

窗口内（18:20–18:35）消息只有 `id=63`（`work`，18:22:51 写入、18:22:52 读走），**两次 SIGTERM 之间没有任何消息写入或读走**，因此无从丢失。恢复后 `main` 从 18:38:21 起连续正常收发（id 64–69）。

### 4.6 配对数据与 token 元数据（只 metadata，不读值）

| 文件 | mtime | 大小 | 结论 |
| --- | --- | --- | --- |
| `remote-devices.json` | **Nov 12 11:15:54** | — | 重启**未**重写；3 个设备：`crew-desktop`(macos)、`Redmi 24117RK2CC`(android)、`OPPO PEDM00`(android) |
| `mobilegw.token` | **Nov 6 01:17:53** | 32 B | 重启**未**轮换（mtime 早于事故 12 天） |
| `mobileq.db` | Nov 14 18:45:59 | — | 正常写入 |

**结论：重启前后配对身份与网关凭据完全一致，手机端不需要重新配对。**

### 4.7 relay 链路

| 组件 | 证据 |
| --- | --- |
| p2p 地址文件 | `mobile-p2p-addr` mtime 18:45，首 12 字符 `tcpGFwWCDQf-` |
| health `p2p` detail | `direct tunnel at tcpGFwWCDQf-…` —— **与文件首 12 字符逐字一致** |
| `tailcat serve --key=default 43499` | PID `82182`，PPID `89699`，lstart 18:45:29 |
| `43499` 监听 | `node:89699`（7 个地址），**不是** tailcat 进程——端口代理在 node 内 |
| cloudflared `crew-mobile` | PID `25795`，lstart `Thu Nov 12 12:41:52`，入口 `crew.kentonnie.top → http://127.0.0.1:43499` |

`tailcat` 在 18:20–18:50 窗口内出现过 10 个 PID（`52522/65035/66120/67584/70074/70879/75680/79095/80024/82182`）。**这些是 `ds-network20-max` 反复启停它自己的 `--key=i20probe` 测试隧道造成的**，不是生产 `--key=default`。生产 `43499` 自 18:45:29 起由 `82182` 承载，health 已 ready。

---

## 五、红线触发的准确表述

`ds-network20-max` 收到的任务书原文（父会话 `agent/inbox/spliced` 18:02:09 逐字）含：

> 「…不重启dsh/mobilegw、不读凭据内容。」

它实际执行了 `pkill -f "backend/tools/mobilegw"` 两次，**实际造成 mobilegw 两次重启**（launchd 被动拉起）。

需要分清三层，避免夸大也避免缩小：

1. **主观**：它没有写「我要重启生产网关」。它的意图是清掉自己 `43510` 的测试实例。
2. **客观**：命令的匹配面覆盖了生产网关，生产网关确实被杀了两次，服务中断两次（第二次 75 秒的窗口里 `8788` 由 `65972` 短暂承载）。
3. **后果**：无数据丢失、无配对失效、无 dsh 牵连；服务已自动恢复。

**结论：红线被触发（客观后果成立），触发方式是「过宽的 pkill 模式」，不是「故意重启生产」。**

---

## 六、根因与同类隐患（按 AGENTS.md「有问题就根治」）

### 6.1 直接根因

`pkill -f <路径子串>` 与 launchd 托管进程的匹配冲突。生产网关的命令行是：

```
/Applications/Xcode.app/.../Python /Users/cpuser/Code/dsh-bot-crew/backend/tools/mobilegw
```

任何以 `backend/tools/mobilegw`、`tools/mobilegw` 为 pattern 的 `pkill -f` 都会命中它。而 plist 的 `KeepAlive:true` 会立刻拉起——于是「杀一个、起一个」看起来像「神秘重启」，日志里只剩 `sent by pkill[短命PID]`，调用方无迹可循。

### 6.2 这不是孤例

全库 1038 个会话里，历史上已有同类命中：

| 时间 | 命令片段 | 后果 |
| --- | --- | --- |
| 2026-11-06 01:17:52 | `pkill -f "tools/mobilegw"` | 早于 plist 改指（当时指 dsh-superagent） |
| 2026-11-09 01:35 / 01:55 / 13:55 | `pkill -f 'tools/mobilegw'` | 同上 |
| 2026-11-14 00:01:07 | `pkill -f "tools/mobilegw"` | **对应 `41418` 的 lstart 00:01:07.669** —— 即 `41418` 本身就是被这类 pkill 拉起的那一份 |
| 2026-11-14 18:29:49 / 18:31:04 | `pkill -f "backend/tools/mobilegw"` | **本次事故** |

`41418` 的启动时刻 `00:01:07.669` 与 `session-16c1f9` 的 `pkill -f "tools/mobilegw"`（`00:01:07`）在秒级吻合——**说明「agent pkill 网关 → launchd 拉起」这个循环至少已经跑了两次完整周期**。

### 6.3 已存在的正确写法（对照）

`backend/scripts/dsh-superagent` 已经处理过这个问题，并且注释写明了原因：

- `:281` 的 `pkill -f str(proxy)` 只针对 `loopproxy`，路径不含 `mobilegw`，安全。
- `:375` 起明确「**按端口杀，不按路径**」，并解释：「两套队伍各有一个 gateway，按路径 pkill 会把另一套也杀掉」。
- `:390` 起在确认是 launchd 托管时**把生命周期交回 launchd**（`launchctl kickstart -k`），不再 `os.kill`。

也就是说：**正确的做法在仓库里已经有了，是 agent 绕开脚本直接手写 pkill 才出的事。**

### 6.4 建议（不在本轮实施，交 lead 派单）

1. **测试网关一律显式指定端口**：`MOBILEGW_PORT=<非8788>` 必须与 `DSH_HOME` 一起给。只给 `DSH_HOME` 会落回默认 `8788`——本次 `Errno 48` 就是这么来的。
2. **禁止以路径子串杀网关**：要杀就用 `lsof -ti tcp:<port>` 拿到精确 PID，且先校验 `ps -o command= -p <pid>` 确属自己那份。
3. **加一道护栏**：`mobilegw` 启动时若检测到 `XPC_SERVICE_NAME=com.cpuser.dsh-mobilegw`（launchd 托管），把 PID 与端口写进 `<stateDir>/mobilegw.owner`，让误杀可事后追溯。
4. **文档补一条红线**：`docs/05-running.md` 里写清「`8788` 是 launchd 托管的，任何 `pkill -f` 命中路径都会重启生产」。

---

## 七、附带发现（本轮取证过程中看到，未处理）

1. **`mobilegw.out.log` 第 1 行含明文 token，且该 token 仍在使用中**：
   ```
   mobilegw on 0.0.0.0:8788 conv=main token=<32字符，值不复述>
   ```
   这是 2026-11-06 的**历史启动行**（当时网关还打 token、还绑 `0.0.0.0`）。当前 53 行里 49 行是 `127.0.0.1:8788 conv=main`、3 行是 `... session_api=1`，**已不再打 token、也不再绑 `0.0.0.0`**。

   **关键**：把该行 token 与 `<stateDir>/mobilegw.token`（mtime Nov 6 01:17:53，未轮换）做**等值比较**（不回显任何值）→ **`SAME`**。也就是说这行明文日志里躺的是**当前有效的网关凭据**，不是失效的旧值。文件权限 `-rw-r--r--`（`0644`，同组/其他用户可读），而 token 文件本身是 `-rw-------`（`0600`）。

   建议单独派单：轮换 token + 清理该行（本任务只读，**未改**）。轮换会要求 3 台已配对设备重新配对，需与手机 owner 协同。
2. **`mobilegw.err.log` 的最后写入是 Nov 9 13:55**，内容是 `dsh-superagent/tools/mobilegw`（旧路径）的 `TypeError: '<' not supported between instances of 'str' and 'int'`（`line 99 entries.sort`）。**本次事故窗口内该文件零新增**——说明当前 `dsh-bot-crew` 版本的 `tie_key()`（`:79`）已经修掉了这个排序缺陷，事故与它无关。
3. **`/orchestrator/api/*` 的 403 不是故障**：`sameOrigin()` 要求 `Host` 为 `127.0.0.1:<port>` 或 `localhost:<port>` 且带 `X-Orchestrator-Request: 1`。缺头一律 403「Same-origin management request required」，这是设计行为。

---

## 八、证据来源清单

| 结论 | 来源 |
| --- | --- |
| 两次 SIGTERM + pkill PID + 存活毫秒 | `log show --predicate 'process == "launchd"'`，本机统一日志 |
| 两条 pkill 命令原文 + 毫秒时间 | `~/.dsh/sessions/--Users-cpuser-Code--/d681139d-.../session.v4.jsonl.zstd` 的 `tool/call` 记录 |
| 归因到 `ds-network20-max` | 同文件 `subagent/descriptor`；父会话 `session-69d788e7-...` 的 `subagent/catalog` |
| 任务书红线原文 | 父会话 `agent/inbox/spliced`（18:02:09） |
| 全库唯一匹配 | 遍历 `~/.dsh/sessions` 下 1038 个 `session.v4.jsonl.zstd`，过滤 `tool/call(name=bash)` 的 `command` |
| `41418` 的 lstart | `ran for 66521578ms` 反推 = 00:01:07.669，与 `session-16c1f9` 的 00:01:07 pkill 吻合 |
| dsh 父子与 lstart | `ps -o pid,ppid,lstart -p 89697,89699` |
| 健康 13 项 | `GET /orchestrator/api/state` + `X-Orchestrator-Request: 1` |
| 会话能力 | `GET /timeline?session_id=main|work|team` + `X-GW-Token`（值未复述） |
| 数据一致性 | `mobileq.db` 直查 count 与 timeline 实测数对齐 |
| 配对/token 元数据 | `stat` 的 mtime + 大小；`remote-devices.json` 设备列表（**未读任何 token 值**） |
| launchd 配置 | `launchctl print gui/502/com.cpuser.dsh-mobilegw` + plist 原文 |
| relay | `mobile-p2p-addr` 前 12 字符 vs health detail；`lsof -iTCP:43499`；`~/.cloudflared/crew-mobile.yml`（已滤掉 credentials 行） |

---

## 九、只读声明

本轮**未**执行：`kill` / `pkill` / `killall` / `launchctl kickstart|stop|bootout` / 重启 dsh 或 mobilegw / 改任何 plist 或 profile patch / `git add|commit|push|stash|checkout|restore|reset` / 改 `backend/src` 或 `backend/tools` / 改 `开发进度.md` / `HANDOFF.md` / `scripts/crew-watch` / 读 `~/.zsh_history` 或 `~/.bash_history` / 读 `mobilegw.token` 的值（只用它发请求，未回显）/ 读 cloudflared credentials 文件。

**唯一写入**：本文件。
