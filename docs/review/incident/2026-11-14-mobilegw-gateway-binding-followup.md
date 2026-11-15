# mobilegw 网关隔离后续：剩余漏洞修复与配置/启动契约验证（2026-11-14）

> 执行者：`wb-gateway`（WorkBuddy DS，lead 监督、本 agent 实施）
> 接回任务：`ds-gateway-contain-max`（原 agent session `e7e0675c-92ad-499e-bb56-c8a215f671fa` 于 19:30 因 Trae QUOTA 429 中止）
> 性质：**修剩余漏洞 + 纯配置/启动契约验证**。全程**未重启任何生产进程**、未 signal 生产、未 `launchctl stop/kickstart`、未改 plist、未轮换 token、未 git add/commit/push。
> 写范围：本文件 + `backend/tools/test_gateway_isolation.py`（唯一源码改动）。生产脚本/网关源码为原 agent 已有改动，本 agent 未改。

---

## 零、结论先说

| 问题 | 结论 |
| --- | --- |
| 生产网关是否被本 agent 动过 | **没有**。`67367` 自 18:31:04 起至今未变，全程只读探测（带 token 发 GET，未回显值）。 |
| 生产健康 | **13/13 ready，0 非 ready**，`paused=false`，`isolationActive=false`。 |
| 轮换是否真的发生 | **未发生**。`mobilegw.token` mtime 仍是 `Nov 6 01:17:53`，size 32，`0600`。 |
| 生产进程跑的是哪版代码 | **旧版**（无 hot re-read、无 owner 记录、无 gateway_binding）。证据：生产状态目录**没有 `mobilegw.owner`**；进程 18:31:04 启动，早于新代码 19:28:43 落盘。 |
| 「必须验证 launchd 重启路径仍可用」 | **通过且已验证**。用 plist 推导出的真实参数（`8788` + `~/.dsh/state/superagent`）调 `binding_problem` 返回 `None`（放行）→ 新版 `mobilegw` 被 launchd 拉起时不会拒起，KeepAlive 不会崩溃循环。 |
| 本次修的剩余漏洞 | **1 个真实缺陷**：`test_gateway_isolation.py` 的 `unittest.main()` 放在文件中部，直跑时**只跑 12/29，17 项静默跳过**。已移到末尾并加**机制护栏**（新增 `CollectionIntegrityTest`）。修复后直跑与完整收集均 **30 项 OK**。 |
| 生产脚本未来能否正常启动 | **能**。`ensure_gateway` 缺省状态目录 → `state_dir_identity` 返回 8788 → 显式 `MOBILEGW_PORT=8788` + 生产状态目录 → 放行。见 §四。 |
| 轮换能否现在做 | **不能**。生产是旧进程、不支持热读取；轮换会让手机断连，除非重启（不许）。轮换必须等维护窗口。见 §五。 |

---

## 一、生产现状（实测，只读）

```
$ lsof -nP -iTCP:8788 -sTCP:LISTEN
Python  67367 cpuser 4u IPv4 ... TCP 127.0.0.1:8788 (LISTEN)      # 仅回环，唯一监听者

$ ps -o pid,ppid,lstart,command -p 67367
67367  1  Sat Nov 14 18:31:04 2026
  /System/.../Python3 .../backend/tools/mobilegw

$ ps -o pid,ppid,lstart,command -p 89697,89699
89697  1     Sat Nov 14 14:26:39 2026  bash -c .../dsh --profile superagent ...
89699  89697 Sat Nov 14 14:26:39 2026  node .../dsh --profile superagent ...
```

- 生产网关 `67367` 的 **PPID=1**（launchd 直接托管），与 dsh `89699` 无父子关系 → dsh/HMR 动不到它。
- **无 `mobilegw.owner`**：`tools/mobilegw` 新版启动才写该文件；67367 启动时（18:31）新版未落盘 ⇒ 它是旧版进程。
- `mobilegw` 磁盘 mtime `2026-11-14 19:28:43`，比 67367 的 `lstart` 晚 **3459 秒** ⇒ 新代码在磁盘、未进运行进程。

---

## 二、日志脱敏与权限（已由原 agent 完成，本 agent 复核通过）

| 文件 | 权限 | 首行 token 处 | 是否残留原值 |
| --- | --- | --- | --- |
| `mobilegw.log` | `0600` | `token=` 后 **32 个 `*`（等长原位替换）** | `raw_token_lines=0` |
| `mobilegw.out.log` | `0600` | `token=` 后 **32 个 `*`** | `raw_token_lines=0` |
| `mobilegw.err.log` | `0600` | 无 token | `raw_token_lines=0` |
| `mobilegw.token` | `0600` | —（凭据本体） | 值未读、未回显 |

- 两处疑似泄露行都是 **32 位等长原位脱敏**，全局 grep `token=[0-9a-f]{32}` 零命中。
- 四份文件均为 `0600`（原事故为 `0644`）。
- **保留正在写 inode/offset**：未 truncate、未 mv 日志文件，`mobilegw.out.log` 在 19:19 仍有新写入（旧进程 stdout 继续追加），偏移连续。
- 未动其他 user 日志。

---

## 三、修掉的剩余漏洞：测试被静默跳过（真缺陷）

### 3.1 缺陷

`backend/tools/test_gateway_isolation.py` 原结构：

```
class ... (12 项)          # 前 12 项
if __name__ == '__main__':
    unittest.main(verbosity=2)     # ← 在这里就执行了
class BindingRuleTest ...           # 之后定义的 4 组 17 项
class OwnershipRecordTest ...
class BenchLaunchRecipeTest ...
class HotRotationTest ...
```

`python3 test_gateway_isolation.py` 直跑时，`unittest.main()` 在第 258 行已执行，**其后定义的 4 组、17 项测试根本不会被收集**。实测：

- 修复前：`python3 test_gateway_isolation.py` → **Ran 12 tests**（后 17 项静默跳过）
- 修复前：`python3 -m unittest backend.tools.test_gateway_isolation` → **Ran 29 tests**（模块加载方式才全收集）

这正是 AGENTS.md 明确不接受的那一类：**静默少跑测试**，会让人误以为「绿了」。所谓「24 项绿」既不等于直跑的 12，也不等于全跑的 29。

### 3.2 修复（根因，非现象）

1. 把 `if __name__ == '__main__': unittest.main(...)` 挪到**文件最末尾**。
2. 新增 **`CollectionIntegrityTest`**：断言文件里 `unittest.main()` 是**最后一条语句**、且 loader 收集到的用例数 `>= 29`。把「测试必须全被跑到」从**注释约定**变成**机制**。

### 3.3 修复验证

| 场景 | 结果 |
| --- | --- |
| 修复后直跑 `python3 backend/tools/test_gateway_isolation.py` | **Ran 30 tests OK** |
| 修复后完整收集 `python3 -m unittest backend.tools.test_gateway_isolation` | **Ran 30 tests OK** |
| 护栏有效性（变异测试：把 `unittest.main()` 挪回中部，隔离副本运行） | `CollectionIntegrityTest` **FAIL**（`283 != 494`），且直跑仅收集 13 项 → 护栏能抓回归 |
| 连带回归 `test_mobile_transport` | Ran 29 OK（未破坏） |

> 30 = 原 29 + 新增护栏 1。变异副本在 `/tmp` 隔离，跑完即删，真文件未被污染。

---

## 四、启动契约验证（未实际重启生产，纯配置/判定验证）

### 4.1 launchd 重启路径（事故余波最关心的点）

plist：`~/Library/LaunchAgents/com.cpuser.dsh-mobilegw.plist`

```
KeepAlive = true
RunAtLoad = true
ProgramArguments = [ /usr/bin/python3, <repo>/backend/tools/mobilegw ]
EnvironmentVariables = { MOBILEGW_PORT=8788, MOBILEGW_HOST=127.0.0.1, MOBILEGW_CONV=main, PATH=... }
# 注意：无 DSH_HOME，也无 MOBILEGW_STATE —— 状态目录由缺省推出
StandardOut/ErrPath = ~/.dsh/state/superagent/mobilegw.{out,err}.log
```

用 plist **实际推导参数**验证新版 `mobilegw` 的启动判定（`gateway_binding.binding_problem`）：

```
state from plist  realpath: /Users/cpuser/.dsh/state/superagent
PRODUCTION_STATE  realpath: /Users/cpuser/.dsh/state/superagent     # 相等
binding_problem('8788', plist_state) => None                        # 放行 ✓
binding_problem('',     plist_state) => 拒绝（非 None）              # 空端口仍会拒 ✓
```

**含义**：将来旧进程退出、launchd 用**新版** `mobilegw` 拉起时，`check_binding` 对「8788 + 生产状态目录」这一唯一合法组合**放行**，不会拒起 ⇒ **`KeepAlive` 不会陷入崩溃循环**。反之若人为把端口留空，新版会以退出码 2 拒起（这是进步，不是回归）。

### 4.2 `dsh-superagent ensure_gateway` 未来路径

- `state_dir_identity(缺省状态目录) == 8788`；`environment.setdefault('MOBILEGW_PORT', '8788')` 显式给出 ⇒ 与 4.1 同组合 ⇒ 放行。
- 非缺省 stateDir ⇒ `18800 + digest%100`，与生产端口不同 ⇒ 两套队伍不抢端口。
- **隐含冲突（须 lead 知晓）**：`ensure_gateway` 的 launchd 分支用 `gateway.stat().st_mtime > 启动时刻` 判断「代码变了就 `launchctl kickstart -k`」。当前 `mobilegw` mtime（19:28:43）> 生产 67367 启动（18:31:04）⇒ **下一次有人跑 `dsh-superagent`（走 ensure_gateway）会自动 kickstart 重启生产网关一次**。这是脚本「让磁盘新代码生效」的既定自愈路径，不是本任务动作；但它意味着「生产网关迟早会被这一次自愈重启换成新版」。本 agent **未触发**它，也不会触发（不跑该启动路径）。

### 4.3 台架隔离三要件（实测）

真实 `scripts/gateway-fixture.sh start --home /tmp/bench-verify-... --print-port`：

```
fixture: home=/tmp/bench-verify-78397 port=32191 pid=78409
owner: {"pid":78409,"parent":78398,"port":32191,"state":"/private/tmp/bench-verify-78397/state/superagent",...}
ps -p 78409 → 真属于台架（命令行 <repo>/backend/tools/mobilegw）
生产 8788 仍由 67367 守护（全程未动）
stop → 只结束 78409；stop 后 kill -0 78409 → gone
```

- **独立 port**（32191 ≠ 8788）、**独立 state**（`/tmp/.../state/superagent`）、**独立 pid owner**（owner 记录对得上 pid/port/state）。
- **未给 port 直接失败**：`DSH_HOME=... python3 backend/tools/mobilegw`（无 MOBILEGW_PORT）→ **退出码 2**，不写 owner，提示指名状态目录。
- **占用端口不杀未知进程**：python 占一端口 → 网关 exit 1、`stderr` 含 `in use`、**占用者仍 listening（connect_ex==0）**。

> 以上三条均由 30 项测试覆盖（`test_fixture_state_without_port_refuses_instead_of_guessing_8788`、`test_refuses_a_port_someone_else_is_listening_on`、`test_wrapper_start_claims_its_own_pid_and_stops_only_that_one` 等），全部 OK。

---

## 五、轮换 token：为什么现在不能做（具体阻塞与已验证方案）

### 5.1 阻塞（客观、已验证）

1. **生产进程 67367 是旧版**：`TOKEN` 是模块级常量，**不支持热读取**（`current_token()` 只在新版代码里，且未进运行进程）。
2. 若现在改写 `~/.dsh/state/superagent/mobilegw.token`：
   - 旧进程仍只认**旧值** ⇒ 所有已配对手机用新值会被 `401`，用旧值才行 ⇒ **轮换对旧进程无效且制造不一致**。
   - 一旦外部调用方（手机桥接）改用新值而旧进程不认 ⇒ **断连**。
3. 让新值生效的唯一途径是**重启生产网关**——这是本任务**明确禁止**的动作。

### 5.2 已验证的正确方案（待维护窗口执行）

- **热轮换代码已就位且测绿**（`HotRotationTest`，2 项）：新版 `current_token()` 每次校验都从 `mobilegw.token` 重读；写新文件 → 旧值立刻 401、新值立刻 200、**进程不重启**；文件临时缺失时退回启动值，不锁死已配对设备。
- 因此**轮换的前置条件**是「生产进程已换成新版」。可行的窗口内步骤（**不在本轮实施**）：
  1. 在维护窗口，用 launchd 正常路径让新版生效（例如 `launchctl kickstart -k` 生产 job，或等 4.2 的自愈重启）；这是**唯一需要重启的一步**，须 owner 批准。
  2. 新版起来后，写新 `mobilegw.token`（32 字节，`0600`）+ 原子替换 → **无需再重启**，旧值立刻失效。
  3. 因 `mobilegw.token` 只是 **backend↔gateway 桥接凭据**（见 §六），轮换它**不要求手机重配**；手机侧 `x-crew` credential 独立。

### 5.3 不会做错的事

- **不改仍被旧进程使用的 token**（避免断连）——本轮**未改**。
- **不为轮换重启**——本轮**未重启**。

---

## 六、凭据边界订正（防止误导）

- `mobilegw.token`（`~/.dsh/state/superagent/mobilegw.token`）是 **backend ↔ mobilegw 网关之间的桥接凭据**（`X-GW-Token`），**不是**手机的 `x-crew` credential。
- 手机 → 网关的鉴权与配对走 `remote-devices.json` + 上层（crew / x-crew），**独立于** `mobilegw.token`。
- 因此**轮换 `mobilegw.token` 不需要 3 台设备重新配对**；「重启后需 3 设备重配」的说法是错的（原事故 §7.1 也已更正配对文件未重写）。
- 前提仍是「轮换要在生产换新版的维护窗口做」（§五）——这是**进程版本**约束，不是**配对**约束。

---

## 七、未执行清单（只读/隔离声明）

本轮**未**：`kill`/`pkill`/`killall` 任何生产进程；`launchctl stop|kickstart|bootout`；重启 dsh 或 mobilegw；改 plist；轮换 token；`git add|commit|push|stash|checkout|restore|reset`；改 `backend/src`/`memory`/`runtime`/`app`/`desktop`/`开发进度.md`/`HANDOFF.md`/`crew-watch`；读 token 值（仅通过 `X-GW-Token` 头发 GET，未回显）；读个人 shell 历史；抢焦点/发桌面输入。

- 所有测试网关都在 `/tmp` 或自有 `--home` 下起，**独立 PID**，验证所有权（`ps` 核对命令行）后由 `gateway-fixture.sh stop` / `terminate()` **只清理自己那个**；生产 67367 全程零触碰。
- 唯一源码改动：`backend/tools/test_gateway_isolation.py`（`unittest.main()` 归位 + `CollectionIntegrityTest` 护栏）。其余（`mobilegw`、`gateway_binding.py`、`dsh-superagent`、`gateway-fixture.sh`）为原 agent 已有改动，本 agent 仅验证未改。

---

## 八、证据来源（命令 + 退出码）

| 结论 | 证据 |
| --- | --- |
| 生产 8788 唯一监听 67367、旧版 | `lsof -nP -iTCP:8788 -sTCP:LISTEN`；`ps -p 67367`；状态目录无 `mobilegw.owner` |
| dsh 89697/89699 未变 | `ps -o pid,ppid,lstart -p 89697,89699` |
| 健康 13/13 | `curl -H 'X-Orchestrator-Request: 1' .../orchestrator/api/state`，health 13 项全 ready |
| 未轮换 | `stat` token：mtime `Nov 6 01:17:53`、size 32、`0600` |
| 日志脱敏+0600 | `mobilegw.log`/`.out.log` 首行 token= 后 32 个 `*`；`grep token=[0-9a-f]{32}` 零命中；四文件 `0600` |
| 测试缺陷与修复 | 修复前直跑 Ran 12 / 模块 Ran 29；修复后二者均 Ran 30 OK（`FINAL_DIRECT_EXIT=0`、`FINAL_MODULE_EXIT=0`） |
| 护栏有效 | 变异副本移回 `unittest.main()` → `CollectionIntegrityTest` FAIL（283!=494），直跑仅收集 13 |
| launchd 契约放行 | `binding_problem('8788', /Users/cpuser/.dsh/state/superagent) == None` |
| 未给 port 退出码 2 | `python3 backend/tools/mobilegw`（无 MOBILEGW_PORT）`REAL_EXIT_CODE=2`，无 owner |
| 占用不杀未知 | python 占端口 → 网关 exit 1、stderr 含 `in use`、占用者仍 listening |
| 台架独立 pid | `gateway-fixture.sh start` → port 32191/pid 78409，owner 相符，stop 只清 78409 |
| 未 staged/committed | `git diff --cached --stat` 为空 |

---

## 九、文件清单

- 修改：`backend/tools/test_gateway_isolation.py`（`unittest.main()` 移末尾；新增 `CollectionIntegrityTest`；466→496 行）
- 新增（本报告）：`docs/review/incident/2026-11-14-mobilegw-gateway-binding-followup.md`
- 原 agent 已有改动（本 agent 未改，仅验证）：`backend/tools/mobilegw`、`backend/tools/gateway_binding.py`、`backend/scripts/dsh-superagent`、`scripts/gateway-fixture.sh`
