# Worker 执行面用独立 OS 用户隔离（+ 最小权限工具）

## 背景

`backend/src/infra/environment.ts:4` 自己写着：worker 的护栏是「default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user」。`runAsWorker`（同文件 `:128`）走 `subprocess.spawn`，没有 uid/gid 切换、没有容器、没有 namespace —— worker 的 bash / git / 文件读写全部继承操作者的 OS 用户权限。

后果（gap 3）：agent 一旦被提示注入、或被上游原型牵着乱跑，就能 `cat ~/.ssh/id_ed25519`、读别的 ticket 目录、翻操作者 `~/.config`。审批闸只约束「经过工具层的外部写」，不防「worker 直接读文件」。

这是接真账号、扩行动面（第 7 步）之前的硬前提。看门狗（#8）已收口——隔离后出问题也有人报警；审批闸已接进执行路径，可复用。

## 决策

**采用 A（独立 OS 用户）为主，叠加 C（最小权限工具）为辅。** 具体：

1. worker 进程以专用低权限账号运行，而不是操作者账号。macOS 本机用 `sudo -u <worker-user>`（或 subprocess 层带 uid/gid）启动 worker 子进程，使其**只**对「本 ticket 执行目录」有读写，读不到宿主 `~/.ssh`、`~/.config`、别的 ticket 目录。
2. worker 拿到的工具集收到最小（C）：只读 git + 指定工作目录写入为主，任意 bash / 任意文件读默认关或经审批。
3. 记忆不走 worker 的文件系统：记忆账本已在 `host.store`（SQLite），worker 进程不持有明文记忆库路径。

## 为什么不选 B（容器 / sandbox-exec）打头

- **容器**（docker/nsjail）：隔离最强，但引入 daemon 依赖、镜像分发、卷挂载配置，代价与本机「给技术 owner 在 Mac 上自用」的定位不匹配；先做成一次性成本低、可逆的方案，容器作为将来「上公网多租户」时的升级路径。
- **`sandbox-exec` profile**：macOS 上可用，但 profile 语法脆弱、随系统版本漂移，且只限文件/网络白名单，不管进程身份。可作为 A 的补充（约束 worker 只能写执行目录），但不作为唯一的身份边界。

## 为什么 A+C 够用

- **够挡住 gap 3 描述的实测症状**：worker 读别的记忆文件、读操作者凭据——独立用户 + 目录权限就挡住。
- **可逆、零外部依赖**：建一个系统用户即可；不想要了删用户。不改进程模型（backend 仍在 dsh 进程里，见 ADR 0001）。
- **与审批闸叠加**：身份隔离挡「读」，审批闸挡「经过工具层的外部写」，两者互补不重叠。

## Consequences

- 需要一个 worker 系统用户，且 `stateDir` / 执行根目录 / git credential 的属主要让这个用户能读写——启动时要检查并（必要时）报错指引，不擅自改系统权限。
- `runAsWorker` 的调用点要统一带身份切换；不能在某个分支漏掉（漏一个就是裸奔）。
- 测试里要能造「恶意 worker」用例：`cat ~/.ssh/id_ed25519` 失败、读别的 ticket 目录失败、读自己目录成功。
- 将来要上公网多租户，这条 ADR 需重新审视——那时 B（容器）成为主方案。
- 跨平台：Linux 同理（独立用户 + 目录权限）；Windows 另议（本机是 macOS）。

## 已知边界（本轮实现范围）

- 本仓用 `runIsolated` 包住的是**我们自己的** `runAsWorker` 调用（ticket 的 `prepare` 命令、git 探活等）。
- worker 在 agent 会话里**实际跑的每一条命令**由 DSH 的 subprocess provider 起，不在本仓 `runAsWorker` 这条缝上——要连那些也关进沙箱，需要在 DSH provider 层支持 uid/gid 或 per-session 沙箱包装，超出本仓能控范围。这是 A 方案「完整落地」的下一步：向 DSH 提 provider 能力，或在 provider 外包一层。
- 因此当前隔离强度：**ticket 准备阶段与 git/文件基线命令已隔开凭据**；agent 自由命令的隔离依赖 DSH。如实记录，不把「部分隔离」说成「全隔离」。

## 档位可见（#11 第 3 项的前半，2026-11-13）

翻默认到 `sandbox` 的**前置**是「面板上要让人一眼看出当前档位」。此前 `executor.isolation`
只存在 settings schema 里，`/state`、面板、手机、桌面都不显示，读的人无从判断现在裸没裸跑。
现在：

- `stateView`（`GET /orchestrator/api/state`）多一个 `isolation: 'none' | 'sandbox'`，报的是
  **配置值**，不是「已隔离」的结论。
- 管理面板执行页状态行显示档位；`none` 用警示色，两档都带 `title` 提示说清上面的边界
  （只包住 `runAsWorker`，agent 自由命令仍依赖 DSH provider）。文案里**不许**出现
  「已全覆盖」「完全隔离」这类话。
- 手机 / 桌面暂不显示：#11 说的是「面板」，且两端状态行改动要跟真机一起验，别先铺开。

**没做的**：默认仍是 `none`，没有翻到 `sandbox` —— issue #11 的收口线要求真机一条活验收
通过后才翻。这里只把「现在是哪一档」变成看得见的事实，不替人做那个决定。

## 落地顺序（对应 #9 五项）

1. 本 ADR（定方案）。
2. 执行面隔离落地：`runAsWorker` / subprocess 层带身份切换；恶意 worker 用例。
3. 记忆落盘收口：确认 worker 拿不到明文记忆库。
4. 审批闸与隔离衔接：隔离环境下外部写仍 ask。
5. 重验全部流程：三端测试 + 真机一条活 + `doctor.sh`。

## 沙箱 profile 的放行项（2026-11-14 实测修订）

「面板看得见档位」做完之后，下一步本该是翻默认。**实测发现翻不了**：`sandbox` 档位当时
的 profile 连一条真活的 prepare 都跑不通。这一节记下那三个缺口、修法，以及修完之后
**隔离边界到底划在哪**。

### 当初漏了什么，为什么会漏

原先的 profile 只有 `process* / signal / file-read* / 写白名单目录 / 写 /dev`。测试只覆盖
本地 `git init`、`git config --get-regexp`、写 `note.txt`、读 fake 凭据目录——这些都过，
于是全量测试全绿，而真活 100% 挂。三个缺口都不是「代码写错」，是「profile 少了一条规则，
而测试从没碰过需要那条规则的程序」：

| 缺口 | 实测症状 | 修法 |
|---|---|---|
| 没有 `sysctl-read` | `gh --version` → `fatal error: failed to get system page size`（Go 运行时启动即崩，exit 2） | `(allow sysctl-read)` |
| 没有网络放行 | 推荐的 prepare（`git fetch` + `worktree add`）→ `Could not resolve host: github.com` | `(allow network-outbound)` |
| 没有 Mach 服务 | keychain 读不到（`security find-generic-password` → `SecKeychainSearchCreateFromAttributes`，exit 44）；`gh auth token` → `no oauth token found`；`gh api` → `x509: OSStatus -2627` | `(allow mach-lookup …)` 三个具名服务 |

第四个缺口不在 profile 里，在调用点：`writableRoots` 只有「工单目录 + 其父」，而推荐的
prepare 要写**仓库**的 `.git/refs/heads/` 与 `.git/worktrees/`：

```
git -C <仓库> worktree add -b agent/t1 <工单目录>
→ fatal: cannot lock ref 'refs/heads/agent/t1': Operation not permitted
```

修法是新增 `executor.repositories`（绝对路径数组，最多 8 条），由它补进 `writableRoots`。
**不从 prepare 文本里反推路径**：命令是 shell，带变量、管道、多条语句，解析必然脆；
显式列出的目录才是白名单该有的形态。

### 网络：收窄到了「只出不进」，但这仍然不是网络隔离

先用的是 `(allow network*)`，实测能收窄：

- `(allow network-outbound)` 下 `socket.bind()+listen()` **失败**，`network*` 下成功。
- 两种写法下 `git ls-remote`、`gh api` 都正常。

worker 只需要出站（fetch / push / API），不需要对外开端口，所以取窄的那个。`gh` 的 TLS
还要 `trustd`：只放 `trustd` 时 `git ls-remote` 已通，但 `gh api` 报 401（能连、验不过证书）；
`git ls-remote` 走 libcurl 用系统根证书，所以它通不代表 TLS 通——这条差异是本轮实测发现的。

**但边界必须说清**：即便收窄到 outbound，**sandbox 档位挡的是文件系统与凭据，不挡网络**。
`sandbox-exec` 的 profile 只能按 socket 方向放行，不能按域名或端口过滤。worker 一旦被
提示注入，仍可把读到的内容发到任意地址。真正拦住外泄的是「读不到凭据」（`~/.ssh`、
`~/.config`、`~/.aws`、`~/.gnupg`、`~/.docker` 仍 deny）与审批闸，不是网络策略。
不要把这一档说成「网络隔离」。

### 凭据：配置进 stateDir，token 不落盘

`workerSensitivePaths` deny 了 `~/.config`，而 `gh` 的配置就在 `~/.config/gh`。原先没意识到
这两件事冲突：deny 掉之后 `gh` 连偏好设置都读不到，而 `gh auth git-credential` 正是 worker
的 git 凭据 helper，于是 fetch/push 全断。

修法：`agentVariables` 注入 `GH_CONFIG_DIR`，指向 stateDir 内的 `worker-gh/`，由
`writeEnvironment` 写两个文件：

- `config.yml`：只有偏好（https、不交互、不分页）；
- `hosts.yml`：只有 `user: <login>`，**没有任何 token**。

token 仍由 keychain 提供（靠放行的 `com.apple.SecurityServer`）。这样即使 `worker-gh/` 被
读走也不泄露凭据——它本来就没有。这也解释了为什么**不能**图省事去复制操作者的
`~/.config/gh/hosts.yml`：那个文件在 token 存于文件时是明文的，复制等于把凭据搬进
worker 可写目录。

### 现在的隔离强度（如实记录）

| 面 | `none` | `sandbox` |
|---|---|---|
| 写文件 | 操作者权限内任意位置 | 仅工单目录 + 其父 + `executor.repositories` |
| 读凭据目录（`~/.ssh` 等） | 可以 | 被 deny |
| 网络出站 | 可以 | 可以（**不按目标过滤**） |
| 网络监听 | 可以 | 被挡 |
| Mach 服务 | 全部 | 仅 `trustd` / `trustd.agent` / `SecurityServer` |
| agent 自由命令 | 不受本仓约束 | **仍不受本仓约束**（见上文「已知边界」） |

最后一行没变：本仓 `runIsolated` 只包住 `runAsWorker` 的调用点（当前唯一处是 prepare），
agent 在会话里跑的每条命令仍由 DSH subprocess provider 起。**别把这张表读成「全覆盖」。**

### 测试怎么防住再次退化

新增的回归用例不再只测本地 git，而是直接跑真程序、真沙箱：

- `gh --version` 在沙箱里必须成功（钉住 `sysctl-read`）；
- 出站请求不被沙箱挡、`listen()` 必须失败（钉住 `network-outbound` 而非 `network*`）；
- `security find-generic-password` 的 stderr 里不许出现 `SecKeychainSearchCreateFromAttributes`（钉住 `SecurityServer`）；
- 推荐的那条 prepare（`worktree add`）必须成功并留下 `.git`（钉住 `writableRoots` 含仓库）；
- `executor.repositories` 必须真的出现在 prepare 的 profile 里（钉住接线，不只钉 schema）。

每条都做过反向验证：把对应的修复撤掉，用例精确变红，恢复后转绿。

### 仍然没做的

**默认值仍是 `none`。** 这一节修的是「`sandbox` 档位的 prepare 阶段能不能跑通一条活」，
答案是能；但翻默认还牵两个未决问题：非 macOS 上 `sandbox` 会让启动一致性检查直接报错
（现在这是有意的「拒绝冒充」，但默认值会把它变成常态），以及真机一条活尚未在隔离开启
状态下全程验收。这两件不做完，不翻。

> 下一节是真机验收的结果。它把「能跑通一条活」这句话收窄了：**只有 prepare 阶段进了沙箱，
> worker 在会话里跑的命令没有**。所以本节说的「能」，指的是 prepare 那一段，不是整条活。

## 真机活验收（#17 第 1 项，2026-11-14）

在 `isolation: sandbox` 下真跑了三条活，配置经管理接口 `PUT /orchestrator/api/settings/executor`
热改（`restarting: false`，生产 PID 不变），`repositories` 填本仓绝对路径。三条都是
`ended.by: executor` / `outcome: completed` / `prepared: true` / 单 assignment 无重试：

| 票 | 做了什么 | 起止 |
|---|---|---|
| `1d8c7f4fae01…` | prepare 建 worktree、worker 建 `sandbox-proof.txt`、回话 | 06:07:29 → 06:07:48 |
| `9aaa07b2be71…` | prepare 内写敏感目录探针，worker 复读 | 06:09:28 → 06:09:42 |
| `619220c5864e…` | 同一组命令在 prepare 与 worker shell 各跑一遍 | 06:10:42 → 06:10:59 |

**prepare 侧确实在沙箱里**：三条活都在仓库 `.git/worktrees/` 与 `refs/heads/agent/*` 下留了
worktree，说明 `executor.repositories` 补进 `writableRoots` 的接线成立；prepare 写的探针文件
里三个凭据目录全部 `Operation not permitted`。

**但 worker 侧读得到。** 同一组命令两处对照（票 `619220c5864e…`）：

| 命令 | prepare（`sandbox-exec` 内） | worker shell |
|---|---|---|
| `wc -c < ~/.ssh/id_ed25519` | `Operation not permitted` | `419` |
| `test -r ~/.ssh/id_ed25519` | `DENIED(1)` | `READABLE` |
| `wc -c < ~/.config/gh/hosts.yml` | `Operation not permitted` | `68` |

**第 1 项的验收线「凭据读不到」在 `sandbox` 档下不成立。** 根因有两层，第二层是本轮新发现：

1. **worker 会话被固定为 `danger-full-access`**（`backend/src/app/sessions.ts:169`
   `ctx.permissionPresets.set(result.agent.session, 'danger-full-access')`）。DSH 的
   `bash-sandbox` 在 `danger-full-access` 下直接 `return` 不 confine，所以 worker 在会话里
   跑的每条命令都不进沙箱。这是「已知边界」里写的那条，实测确认它足以让整个档位失效。
2. **`prepare` 为空时 `runIsolated` 根本不被调用**（`backend/src/executor/dsh.ts:291`
   `if (command) await runIsolated(...)`）。默认 `prepare` 就是空字符串，于是「配置说
   `sandbox`、实际一行都没进沙箱」——这是「静默当作有隔离」的最坏形态，比不隔离更危险。

### 非 macOS 策略（#17 第 3 项）

**结论：拒绝启动，不自动降级。** 理由与口径：

| 平台 | `sandbox-exec` | 行为 |
|---|---|---|
| macOS | 有 | 正常启用 |
| 其他平台 | 无 | **启动一致性检查报错并停在 `error`，不进入 `ready`** |

现有机制在 `backend/src/app/runtime.ts:1204`（`finishSetup`）：`isolation === 'sandbox'` 且
`!sandboxAvailable()` 时把 `runtime` health 置 `error`、写明「拒绝以未隔离冒充已隔离」、走
`retrySetup()` 而不是继续起循环；`runIsolated` 自己还有一道
（`backend/src/infra/environment.ts:273`）抛错兜底。**不静默退回 `none`** 是刻意的：操作者以为
隔离了其实没有，比明确不隔离更难发现。

两条已知缺口，都属于「静默当作有隔离」，翻默认前必须堵上：

1. **管理接口热改不校验平台。** `Settings.save`（`backend/src/app/settings.ts`）对
   `executor.isolation` 没有任何平台检查，`isolation` 也不在 `environment()` 与
   `SETUP_FIELDS` 里，所以不触发 `finishSetup`。在非 macOS 上 `PUT settings/executor`
   带 `isolation: 'sandbox'` 会返回 200 并热生效，直到下一次重启才由启动检查暴露——中间
   这段时间面板显示 `sandbox`、实际未隔离。
2. **`prepare` 为空时档位空转**（上文根因 2）。`isolation: sandbox` 与空 `prepare` 同时
   成立时，没有任何一条路径进沙箱，而 `/state` 照样报 `sandbox`。

第 2 条同时说明：**「`sandbox` 档能跑通一条活」这句话只对「配了非空 prepare」成立**。
默认配置（空 prepare）下这一档没有任何效果。

### 为什么不翻默认（#17 第 2 项未执行）

翻默认的前置是「`sandbox` 档下凭据读不到」这条真机验收线通过。本轮实测它不通过，且失败
根因在 DSH provider 层（worker 会话的 `danger-full-access`），本仓改不动。此时把默认从
`none` 翻到 `sandbox` 会让所有安装的 `/state` 显示「已隔离」而实际没有——正好是本 ADR 和
issue #17 都明令禁止的那种静默。**默认保持 `none`，等 worker 会话的隔离在 provider 层落地
（或本仓拿到能覆盖 agent 自由命令的包装点）之后再翻。**
