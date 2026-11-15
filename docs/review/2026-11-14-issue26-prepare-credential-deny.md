# #26 prepare 沙箱凭据 deny 覆盖：证据与反向验收

日期：2026-11-14
范围：`backend/src/infra/environment.ts`、`backend/src/executor/dsh.ts`、`backend/src/policy.ts`（仅注释）、
`backend/tests/environment-credentials.spec.ts`（新增）、`backend/tests/runtime.spec.ts`（追加一条）、
`backend/docs/007-architecture.md`（测试表一行）、`docs/adr/0004-worker-isolation-os-user.md`（补两节）。
跟踪 issue：#26（`ready-for-agent`，由 ds-17 建；#17 已按 prepare 限定口径关闭）。

---

## 0. 证据分两轮（**读本文前先看这张表**）

同一件事（prepare 阶段的凭据读不到）有两批证据，**取证的介质不同**，混着读会得出超出证据的结论：

| 轮次 | 时间 / 出处 | 介质 | 能说的 | 不能说的 |
|---|---|---|---|---|
| **第 1 轮（#17 真机活）** | 2026-11-14 06:07–06:11，三条真票（`1d8c7f4f…` / `9aaa07b2…` / `619220c5…`），记录在 ADR 0004「真机活验收」节 | **操作者的真实 HOME**。`wc -c < ~/.ssh/id_ed25519` 在 worker shell 里返回 `419`，`wc -c < ~/.config/gh/hosts.yml` 返回 `68` —— **只取了字节长度，没有打印任何文件内容** | prepare 侧 `Operation not permitted` / `DENIED(1)`，即**真机上 prepare 真的进了沙箱**；同一组命令在 worker shell 里读得到（长度非 0），即 **worker 侧未覆盖** | 不能说「凭据内容被读过」——只读了 `stat` 级长度；也不能拿这一轮说「覆盖全」，它只覆盖当时那 6 个已枚举路径 |
| **第 2 轮（本轮 #26）** | 2026-11-14 15:00–17:10，`backend/tests/environment-credentials.spec.ts` 11 例 + `runtime.spec.ts` 1 例，即本文 §3–§4 | **全部临时 HOME**（`mkdtempSync`），canary 是假 token `CANARY-…-NOT-A-REAL-TOKEN` | 名单 24 条逐条被拒、符号链接前缀、先建后读、带空格路径、`.gitconfig` 替换 A/B、调用点接线 | 不能说「在真实 HOME 上验过」——本轮**一次都没碰**操作者的真实凭据、shell 历史或个人配置，只记「被拒 / 可读」与 exit 码 |

**「本轮 #26」的口径**：本文 §2 之后所有「实测」「证据」「红绿」**只指第 2 轮**（临时 HOME canary，
真 `sandbox-exec` / 真 `git` / 真 `sh`）。第 1 轮的真机活证据在 ADR 0004 里，本文引用它时
一律写成「#17 轮」并标明「只取长度、未打印内容」，不合并成一句「都验过了」。

两轮合起来能支撑的结论只有一句：**prepare 阶段的 deny 对「名单内的路径」真实生效，
且名单已从 5 项扩到 24 条；worker 侧（agent 自由命令）仍未覆盖（#22）。**

---

**这份报告里的所有验证都是源码级**：真 `sandbox-exec`、真 `git`、真 `sh`，canary 全部造在
`mkdtempSync` 出来的临时 HOME 里，假 token（`CANARY-...-NOT-A-REAL-TOKEN`）。
**没有读取操作者的任何真实凭据、shell 历史或个人配置内容**，只记录「被拒 / 可读」与 exit 码。
**生产未上线**：`backend/lib` 未重建（#25 独占），生产 dsh 进程未重启，默认 `isolation` 仍是 `none`。

## 1. 修的是什么根因

`backend/src/executor/dsh.ts` 原 `workerSensitivePaths(_stateDir)` 按「猜哪里可能存了凭据」列了
五条（`~/.ssh`、`~/.config`、`~/.aws`、`~/.gnupg`、`~/.docker`），参数收了不用。结果是
「名字里有 ssh/aws 的目录挡住了，其余凭据载体一个没挡」。

两个根因，一起收：

1. **枚举按目录名拍脑袋，不按载体类别。** git 自己的凭据（`.git-credentials`、`.gitconfig`）、
   kube/azure、包管理器 token、密码管理器、shell 历史全部落在名单外。
2. **`realSubpath()` 对不存在的路径只 `resolve()`。** macOS 上 `/var`、`/tmp` 是符号链接，内核按
   真实路径（`/private/var/...`）匹配 SBPL 的 `subpath`。于是**deny 一条尚不存在的路径时整条
   规则静默失效**——而新增的载体恰恰大多「本机还没有」。这条不修，光加名字等于加了个摆设。

## 2. 改动

| 文件 | 改了什么 |
|---|---|
| `backend/src/infra/environment.ts` | 新增 `sensitivePaths(home?)`：按 6 个载体类别枚举 24 条路径（git 凭据 / 云与集群 / 容器 registry / 包管理器 token / 密码管理器 / shell 历史）；新增 `prepareVariables(stateDir)` 收拢 `GH_CONFIG_DIR` + `GIT_CONFIG_GLOBAL` + `GIT_CONFIG_NOSYSTEM`；`realSubpath()` 改为「向上找第一个存在的祖先做 realpath，再接回剩余段」 |
| `backend/src/executor/dsh.ts` | `prepareDirectory()` 改用 `readableDeny: sensitivePaths()` 与 `Object.assign(env, prepareVariables(...))`；删掉 `workerSensitivePaths` 与 `homedir` import |
| `backend/src/policy.ts` | 仅 `ExecutorConfigSchema.isolation` 的 doc 注释：写清覆盖范围是 `sensitivePaths()` 那张表、表外不覆盖、只包 prepare（#22 的边界） |
| `backend/tests/environment-credentials.spec.ts` | 新增 10 条（见 §4） |
| `backend/tests/runtime.spec.ts` | 追加 1 条：`/state`→prepare 的 profile 里必须含全部载体路径（钉接线） |
| `backend/docs/007-architecture.md` | 测试表加一行 |
| `docs/adr/0004-worker-isolation-os-user.md` | 「凭据 deny 的覆盖与残余边界」新节 + 强度表补两行 + 测试节补 6 条 |

`GIT_CONFIG_GLOBAL` 指向的是 `<stateDir>/worker-gitconfig`，那是 `writeEnvironment()` **生成**的
文件（`own()` 写、带 MARKER、拒绝覆写外来文件），**不是真实用户配置的副本**：内容只有
`useConfigOnly`、空的 `credential.helper`、指向 `gh auth git-credential` 的 helper、github 的
`insteadOf` 与 LFS filter。没有任何 token，也没有从 `~/.gitconfig` 抄来的东西。

### 为什么必须引入这个副本（必要性证明，不是顺手加的）

同一 profile（deny `~/.gitconfig`），只差 `GIT_CONFIG_GLOBAL`：

```
=== A：deny ~/.gitconfig 且不设 GIT_CONFIG_GLOBAL ===
fatal: unable to access '/private/tmp/.../home/.gitconfig': Operation not permitted
EXIT=128
=== B：同一 profile + GIT_CONFIG_GLOBAL 指 stateDir 那份 ===
EXIT=0
```

A 的 128 就是「推荐的 prepare（`worktree add`）在完整 deny 名单下会全挂」的那条路径。所以
「deny 原文件 + 指向自己生成的那份」是必需的，而不是把原文件放过。stateDir 那份的完整内容
（`cat` 出来只有 5 行配置，无凭据）见 §5。

## 3. 覆盖前后对照（真 sandbox-exec，临时 HOME canary）

`legacy5` = b2f305e 的 `workerSensitivePaths`；`new-list` = `sensitivePaths(home)`。判定方式：
`spawnSync(sandbox-exec -p <profile> /bin/cat <path>)`，exit 0 → `READABLE`，非 0 → `DENIED`。

| 载体类别 | 路径 | legacy5 | new-list |
|---|---|---|---|
| git 凭据 | `.git-credentials` | READABLE | DENIED |
| git 配置 | `.gitconfig` | READABLE | DENIED |
| netrc | `.netrc` | READABLE | DENIED |
| 包管理器 | `.npmrc` | READABLE | DENIED |
| 包管理器 | `.npm/_authToken` | READABLE | DENIED |
| 包管理器 | `.yarnrc` | READABLE | DENIED |
| 包管理器 | `.yarnrc.yml` | READABLE | DENIED |
| 包管理器 | `.pypirc` | READABLE | DENIED |
| 包管理器 | `.cargo/credentials.toml` | READABLE | DENIED |
| 包管理器 | `.gem/credentials` | READABLE | DENIED |
| 包管理器 | `.m2/settings.xml` | READABLE | DENIED |
| 集群 | `.kube/config` | READABLE | DENIED |
| 云厂商 | `.azure/azureProfile.json` | READABLE | DENIED |
| 云厂商 | `.azure/msal_token_cache.json` | READABLE | DENIED |
| 密码管理器 | `.vault-token` | READABLE | DENIED |
| 密码管理器 | `.password-store/github.gpg` | READABLE | DENIED |
| shell 历史 | `.zsh_history` | READABLE | DENIED |
| shell 历史 | `.bash_history` | READABLE | DENIED |
| shell 历史 | `.zsh_sessions/session.history` | READABLE | DENIED |
| 既有 | `.ssh/id_ed25519` | DENIED | DENIED |
| 既有 | `.gnupg/secring.gpg` | DENIED | DENIED |
| 既有 | `.aws/credentials` | DENIED | DENIED |
| 既有 | `.docker/config.json` | DENIED | DENIED |
| 既有（顺带覆盖） | `.config/gh/hosts.yml` | DENIED | DENIED |
| 既有（顺带覆盖） | `.config/gcloud/credentials.db` | DENIED | DENIED |

正对照：同一 profile 下 `printf ok > <execDir>/x.txt` exit 0（沙箱起来了，不是「全被拒」）。

### 符号链接前缀那条，单独给证据

```
deny subpath "/var/tmp/naive-probe/f"            → 读到内容，EXIT=0      ← 静默失效
deny subpath "/private/var/tmp/naive-probe/f"    → Operation not permitted, EXIT=1
deny subpath "/var/folders/.../asym2-xxxx/f"     → 读到内容，EXIT=0      ← 同一条
deny subpath "/private/var/folders/.../f"        → Operation not permitted, EXIT=1
```

而 deny 一个**尚不存在**的路径本身是有效的（不需要文件先存在）：

```
profile 造好时 .npmrc 不存在 → 沙箱里写出来 → 同 profile 下 cat → Operation not permitted
```

所以修的是「前缀没解析」，不是「路径不存在就跳过」。

## 4. 测试与反向验收（撤掉修复 → 精确变红）

新增 `backend/tests/environment-credentials.spec.ts`，11 条全绿（`npx vitest run`，exit 0）：

```
✓ 正对照：workspace 里正常读写，且带空格的路径可用（沙箱确实起来了）
✓ 负对照：按载体类别枚举的每一个凭据路径都被拒（逐条断言 verdict + exit 码 1）
   └ 同一条里还做名单↔canary 双向对齐（名单每条都有 canary、canary 不落在名单外）——
     这条断言写的时候就抓出两处真实缺口：`.cargo/credentials` 与 `.cargo/credentials.toml` 原先没造 canary
✓ 名单外的普通文件仍可读（deny 是定向的，不是把整个 HOME 关掉）
✓ 不存在的路径也进 profile：祖先 realpath 解析后才是内核匹配的形态
✓ profile 造好时还不存在的凭据文件，之后建出来仍读不到
✓ 带空格的凭据路径照样被拒
✓ 跑 prepareVariables + sensitivePaths 后，git init / config 成功，而 ~/.gitconfig 读不到
✓ 推荐的 prepare（worktree add）在完整 deny 名单下仍成功，同一条命令里凭据读不到
✓ prepare 的调用点真的用了这张名单与这组变量（不是只导出了函数没人用）
✓ `.gitconfig` 的替换方案有直接证据：deny 原文件会让 git 挂，注入 GIT_CONFIG_GLOBAL 后恢复
✓ 名单里没有 stateDir 自己的 worker 配置，所以 git 的凭据 helper 仍可用
Tests  11 passed (11)   exit=0
```

`runtime.spec.ts` 追加的一条：`puts every credential carrier in the prepare profile, not just the five directories`
—— 从 `/state` 走一遍真 prepare 路径，断言 profile 里每条 `sensitivePaths()` 都在，并按名字抽查
`.git-credentials`/`.gitconfig`/`.netrc`/`.kube`/`.azure`/`.npmrc`/`.zsh_history`/`.bash_history`。

### 反向验收（每条都实测，exit 码是 vitest 的）

| 撤掉什么 | 结果 | exit |
|---|---|---|
| R1：`sensitivePaths()` 退回旧五条 | 6 条变红：负对照、符号链接那条、带空格那条、git init 对照、worktree add 对照、`.gitconfig` 替换 A/B | 1 |
| R2：`realSubpath()` 退回 `try realpath catch resolve` | 2 条变红：profile 形态那条、先建后读那条 | 1 |
| R3：prepare 调用点 `readableDeny: []` | 1 条变红：调用点接线那条 | 1 |
| R4：调用点退回只设 `GH_CONFIG_DIR`（不设 `GIT_CONFIG_GLOBAL`） | 1 条变红：调用点接线那条 | 1 |
| 全部恢复 | 11 passed | 0 |

R1 的具体红名单（说明覆盖是真被钉住的，不是只钉了一条）：
`负对照`、`profile 造好时还不存在的凭据文件`、`带空格的凭据路径`、
`跑 prepareVariables + sensitivePaths 后…`、`推荐的 prepare（worktree add）…`、
`` `.gitconfig` 的替换方案有直接证据… ``。

R3/R4 的红是**接线**层面的：只导出函数不接线，功能测试全绿而生产一行都没生效——这正是
「schema 有字段、profile 没路径」那类静默，所以单独钉一条。

## 5. 覆盖范围与残余边界（明确写下，不承诺更多）

**覆盖**：`sensitivePaths()` 表内 24 条，按 6 个载体类别。加上 `.config` 整片覆盖
（`gh`、`gcloud`、`pip` 都在其下），实际挡住的宿主凭据载体是这张表 + `.config` 子树。

**不覆盖（明确不承诺）**：

1. **表外任意路径的 secret。** 自定义目录里的 `.env`、某个工具自建的凭据文件、
   `~/Documents/notes-with-tokens.md`——本机制按载体类别枚举，不是 secret 扫描器，发现不了。
2. **表内路径的别名/软链目标。** deny 的是路径本身；若凭据真身在别的路径（`~/.ssh` 软链到
   `~/Dropbox/keys`），软链目标不在名单里。`realSubpath()` 会解析软链前缀，但不会枚举「指向哪」。
3. **keychain。** 放行的 `com.apple.SecurityServer` 让 worker 能读**自己的** keychain 项；
   实测（临时 keychain + 假密码）沙箱内 `security find-generic-password -w` exit 0 能读出，
   而同 profile 下 deny 该 keychain 文件时 exit 44。这是 worker 的 git 凭据 helper 必需的通道，
   属于**已知放行面**，不是遗漏。
4. **网络。** `(allow network-outbound)` 不按域名/端口过滤，读到的东西仍可外发（ADR 0004 已写）。
5. **worker 会话里的自由命令。** 本仓 `runIsolated` 只包住 prepare 这一个调用点；agent 在会话里
   跑的每条命令由 DSH subprocess provider 起，仍是 `danger-full-access`（#22 追踪）。
6. **非 macOS。** `sandbox-exec` 不存在时启动检查直接报错，不降级（ADR 0004 已有）。

## 5.1 「prepare vs worker」表述订正（lead 指出，同类事实错误一并收口）

UI 已把「仅 worker 执行面」改成「平台沙箱 · 仅 prepare 阶段」。本任务范围内有同一处事实错误：
`backend/src/policy.ts:145` 原文写「**worker 执行面**的隔离档」——把未覆盖的 worker 说成覆盖范围。
已订正，并顺手检查了本任务写到的另外两处：

| 位置 | 原文 | 现在 |
|---|---|---|
| `policy.ts` `ExecutorConfigSchema.isolation` | 「worker 执行面的隔离档」+ 只列 `~/.ssh`/`~/.config` | 「**prepare 阶段**的隔离档」+ 完整载体表 + 明写「**这一档不覆盖 worker**」「`prepare` 为空时本档一行都不生效」 |
| ADR 0004 开头 | 标题「Worker 执行面用独立 OS 用户隔离」，读起来像 worker 已隔离 | 新增「现状口径」块：A 方案**没落地**，实际是 `sandbox-exec` 只包 prepare；表格并列 prepare（进沙箱）/ worker（**未覆盖**，`danger-full-access`） |
| ADR 0004 强度表 | 表头只写 `sandbox` | 表头改 `sandbox`（**仅 prepare**），并加一句：除「agent 自由命令」那一行，**其余各行说的都是 prepare，不是 worker** |
| ADR 0004 决策节 / Consequences | 「可作为 A 的补充（约束 worker 只能写执行目录）」「测试里造恶意 worker 用例」 | 明确「实际落地的就是它，且只包 prepare」「本轮只对 prepare 成立；worker 会话里的同名命令仍会成功（#22）」 |

标题不改（不改写历史），靠开头的现状口径纠正读法。

## 6. 与 #22 / #17 / #25 的口径

- **#22（worker 覆盖）**：本任务一行没碰。`isolation` 默认仍是 `none`，没翻；没改宿主
  `sandbox-exec` 补丁；没碰 DSH provider。ADR 0004 强度表最后一行照旧写着「agent 自由命令
  仍不受本仓约束」。
- **#17**：已按 prepare 限定口径关闭。本任务不重开它，也不把「prepare 阶段凭据读不到」说成
  「sandbox 档整体凭据读不到」。
- **#25（`backend/lib` 构建产物）**：独占，本任务**没有** `pnpm build`。所以这份修复
  **只存在于源码与测试**，生产 dsh（PID 89699）加载的 `lib/` 里没有它，**不能说已上线**。
  上线需要一次包含本改动的构建 + 部署，那是另一件事。

## 7. 未做 / 留给后续

- 未改 `backend/src/app/http.ts` 的 `isolationActive` 判定、未改面板文案（不在本任务写面；面板侧已由另一 agent 改成「仅 prepare 阶段」，我按它对齐了 `policy.ts` 与 ADR 的表述）。
- 未把 deny 名单做成可配置项：按载体类别枚举的价值就在「明确、可 review、可逐条测」，
  做成配置等于把 review 责任转移给每个部署者。
- 未处理「表内路径的软链目标」（§5 第 2 条）：要真做，需要一次 readlink 遍历，收益与代价
  都远大于本轮，且会引入「解析失败怎么算」的新歧义。真要收，另开 issue。

## 8. 变更期间的协作事故（记录，不影响结论）

16:57:48 ds-23-max 在共享工作树上执行了 `git stash`（未加 `-u`），把当时所有**已跟踪**的未提交
改动收进 `stash@{0}`；16:58:58–16:59:11 用 `git checkout stash@{0} -- <23 路径>` 写回；
**这条命令会同时写工作区与 index，所以那几十秒里 index 是被暂存的**；
17:02 前后他用 `git restore --staged` 撤回（`.git/index` 的 mtime 落在 17:02:20），
现在 `git diff --cached` 为空、`stash@{0}` 仍冻结未 drop。

**核验结果（我的 6 个文件）：**

| 文件 | 核验时刻与 `stash@{0}` 比对 | 结论 |
|---|---|---|
| `backend/src/infra/environment.ts` | 非空 diff（仅 `.npm/_authToken` 那一行） | 是 stash 之后我加的，未被覆盖 |
| `backend/src/executor/dsh.ts` | 空 | 与 stash 时刻逐字一致 |
| `backend/src/policy.ts` | 空（核验时刻） | 与 stash 时刻一致；**此后我又改了注释**（§5.1 的表述订正、载体表补全），那是我在恢复之后的主动改动 |
| `backend/tests/runtime.spec.ts` | 空 | 同上（之后未再改） |
| `docs/adr/0004-worker-isolation-os-user.md` | 空（核验时刻） | 与 stash 时刻一致；**此后我又加了「现状口径」块与若干限定**，同属恢复后的主动改动 |
| `backend/tests/environment-credentials.spec.ts` | untracked，未被 stash 收走 | 完整 |

即：stash 发生在我的改动全部落盘**之后**，checkout 写回的就是我那份。

**这里要收窄一句（原文写过「没有丢失 stash 之后的并发修改」，那句话超出了证据）**：
上面这张表是**我这 6 个路径**的逐条比对，它能证明的是「这 6 个文件在核验时刻与 stash 内容一致、
没有丢失已落盘的内容」。它**不能**推广成「所有潜在并发丢失已被证明不可能」——
16:57:48–16:59:11 这 73 秒里若有别的 agent 正在写某个已跟踪文件，理论上仍存在被 stash 前版本
覆盖的窗口；本轮各 owner 的 mtime / 内容比对都没有发现这种情形（见
`docs/review/2026-11-14-ledger-closeout.md` §「一处非我所为、但要交代的状态变化」的 owner 核对表），
但那是**逐路径实证覆盖**，不是形式化证明。**别把「已核对」读成「已证明」。**

恢复后重跑：4 个 spec 488 passed / 全量 112 文件 1959 passed；后续订正完成后再跑
全量仍是 112 文件 1959 passed（exit 0）。

**副产物修正**：我用「HEAD + 只我那一行」的 007 覆盖共享工作树时，一度抹掉 ds-23-max 在
`backend/docs/007-architecture.md` 的两行（`notices-morning` 增补、`crew-morning` 新增）。
已按 stash 内容原样恢复，现在共享工作树里三行并存（他两行 + 我一行），我的 patch 只带我那一行。

## 9. 本文的两处口径限定（2026-11-14 17:48 审计后补）

1. **「本轮 #26」只指第 2 轮**（临时 HOME canary）。凡本文写「实测」「证据」「红绿」，
   指的都是 `backend/tests/environment-credentials.spec.ts` 那 11 例与 `runtime.spec.ts` 那 1 例，
   **不是在操作者真实 HOME 上跑出来的**。第 1 轮的真机活（#17，真实 HOME，只取文件长度、
   未打印内容）在 ADR 0004，两者不合并叙述。见本文 §0。
2. **「24 条」是可复核的代码事实，不是引用**。判据是 `backend/src/infra/environment.ts:219`
   的 `sensitivePaths()` 里 `at(...)` 的条数（24），不是本报告或 ADR 里写的数字。
   报告与 ADR 里的「24」如果哪天和代码不一致，以代码为准并回来改这两处。
