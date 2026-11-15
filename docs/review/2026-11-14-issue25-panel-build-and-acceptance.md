# #25 · 面板 backup 表单上线与真验收（2026-11-14）

承接 `549d4e8`（表单 + 三项收口线证据）的遗留：「`backend/lib/` 未 build，生产面板要看到表单需 `pnpm build` + 一次 profile 重组」。本轮把这一条走完，并在**生产进程**上真看一眼、真填一次、真跑一张票。

结论：**上线成功，四条验收线全部通过**。生产 dsh 未重启（PID 89699 前后一致），mobilegw 未动（PID 41418），HTTP 管理面 142/142 次 200，新代码 2.48 秒生效，面板 backup 表单真实可见，主路由断时真实 request 走了新备选。

---

## 一、上线前审计：lib 确实落后于 src

| 事实 | 证据 |
| --- | --- |
| `lib/client.js` mtime 11:40，`src/client/locales.ts` / `settings-kit.tsx` mtime 14:13 | `stat` 对比 |
| 旧 `lib/client.js` 里 `backupLabel` 命中 **0** 次 | `grep -c backupLabel lib/client.js` → `0`（exit 1） |
| 旧 `lib/index.js` 里 `isolationActive` 命中 **0** 次 | `grep -rln isolationActive lib/` → 空 |
| 生产 `/state` 无 `isolationActive` 键 | 触发前 `GET /state` 顶层 keys = `[health, isolation, load, masterId, paused, setup, watchdog]` |
| 旧 `lib/client.js` SHA-256 | `ee46346a…2c6e35`，376340 B |
| 旧 `lib/index.js` SHA-256 | `b799ec55…8e7f69` |

即：生产跑的是 11:40 的构建，`2364d40`（isolationActive）与 `549d4e8`（backup 表单）都不在里面。

## 二、构建

构建前确认工作树等于 HEAD，避免把别人的半成品打进上线产物：

```
$ git status --porcelain                       →  M HANDOFF.md / ?? scripts/crew-watch/
$ git status --porcelain backend/src backend/tests → （空）
$ git diff HEAD --stat -- backend/src backend/tests → （空）
$ find backend/src backend/tests -type f -newermt '2026-11-14 14:40' → （空）
$ git rev-parse HEAD → b2f305e616f52fd19ca75bae3960d669e8aaa823
```

`HANDOFF.md` 与 `scripts/crew-watch/` 是他人未提交内容，且不在 backend 构建面内。

```
$ cd backend && pnpm build
✔ Build complete in 1631ms      (CJS lib/client.js 380.69 kB)
✔ Build complete in 1783ms      (ESM 17 files, total 1.08 MB)
EXIT=0        real 2.455s
```

产物：

| 文件 | SHA-256 | 字节 | 关键内容 |
| --- | --- | --- | --- |
| `lib/client.js` | `182fcc2b…e5b50090` | 380687 | `backupLabel` ×4、`备选路由` ×2 |
| `lib/index.js` | `33f11a9a…93026c012` | 766188 | `isolationActive` ×1 |

`backend/lib/` 在 `.gitignore:17`，不进版本库；`git status` 构建后仍只有 `HANDOFF.md` + `scripts/crew-watch/`。

## 三、HMR 触发（文档方法核实有效）

按 `docs/07-hot-reload.md` §五：`pnpm build` 之后写一次 profile patch 即触发重组。

触发前的安全条件（逐条核实，不是照抄文档）：

| 条件 | 实测 |
| --- | --- |
| 无 running assignment | `load.running = 0` |
| 无 queued | `load.queued = 0` |
| 无 open ticket | `tickets?state=open` → `total: 0` |
| 未暂停 | `paused = false` |
| 健康全 ready | 12 项全 `ready`（runtime/relay/notice/launch/delivery/assessment/reply/evals/models/p2p/github/team） |
| 协调到位 | ds-17（prepare 验收）、ds-23-max（晨报）、ds-prepare-max（environment/policy）、ds-19-max（远程恢复）逐一确认无在跑活、无未提交 src |

备份：

```
$ cp -a ~/.dsh/profiles/superagent/cordis.patch.yml \
        ~/.dsh/profiles/superagent/cordis.patch.yml.bak-hmr25-20261114-163428
$ shasum -a 256 cordis.patch.yml → 813d1d7e87aa266889b66bf79882ea7cd8a8809629c58188633c772f053f3d10
```

触发（最小注释 touch，不重启任何进程）：

```
$ printf '\n# hmr-touch-25 %s\n' "$(date -Iseconds)" >> ~/.dsh/profiles/superagent/cordis.patch.yml
trigger 16:34:35.442656
```

### 3.1 生效时间与可用性

50ms 采样，覆盖触发窗口：

```
NEW-CODE-AT 16:34:37.918852000
state 200=142 fail=0
```

- **生效耗时 2.48 秒**（16:34:35.44 → 16:34:37.92），与文档记录的 2.19–2.69 秒区间一致。
- **`GET /state` 142/142 次 200，零失败**。文档记的是 331/331，同量级。
- 判定「新代码生效」的探针是 `isolationActive` 键的出现 —— 它在旧构建里不存在，不可能被缓存命中。

### 3.2 进程与状态

| 指标 | 触发前 | 触发后 |
| --- | --- | --- |
| dsh PID | 89699（lstart `Sat Nov 14 14:26:39 2026`） | **89699，lstart 不变** |
| mobilegw PID | 41418（lstart `Sat Nov 14 00:01:07 2026`） | **41418，lstart 不变** |
| `masterId` | `orchestrator-bbbb4bafe8b5e5afe49748149f93df3d` | 同 |
| `paused` | false | false |
| `load` | `{running:0, queued:0, maxWorkers:3}` | 同 |
| 健康 | 12 项 ready | 12 项 ready |
| 票/线程/trigger/kv | 11 / 51 / 51 / 147 | 12 / 52 / 52 / 155 |

计数各 +1 是**我随后投的验收票**（`b50ed30f`，见 §五），不是状态丢失或重建。

## 四、`/state` 新字段

```
keys pre : [health, isolation, load, masterId, paused, setup, watchdog]
keys post: [health, isolation, isolationActive, load, masterId, paused, setup, watchdog]
NEW keys : ['isolationActive']

isolation        pre=none   post=none
isolationActive  pre=<ABSENT>  post=False
```

`isolation=none` → `isolationActive=false` 是正确的三态之一（`none → false`、`sandbox + 空 prepare → false`、`sandbox + 有 prepare → true`，见 `2364d40` 与 `backend/src/app/http.ts:121`）。

**一条必须说清的边界**：`isolationActive` 目前**没有客户端消费者**。`grep -rn isolationActive backend/src/client/` 为空，`desktop/` 与 `scripts/` 也没有。字段在 API 上真实存在、语义正确，但面板的 Isolation 行仍只读 `isolation`（`backend/src/client/execution.tsx:37`），显示的是「None · runs as your OS user」。也就是说「档位配了但没生效」这件事**在 API 层可见、在面板上还不可见**。这属于 #17 的收口范围，不是 #25 的验收项，但它决定了 `2364d40` 的完整价值尚未兑现 —— 记为后续限制（§八）。

## 五、面板表单真实验收（headless，不抢鼠标/焦点）

用 headless Chromium 打开 `http://127.0.0.1:3082/?token=…`（token 取自 `/private/tmp/dsh-superagent-restore.log` 的启动行），全程 `page.evaluate` 驱动，**不聚焦任何窗口**。

### 5.1 表单可见

路径：侧栏 `Superagent` → `Execution` 标签 → Status 区 `Settings` → 侧栏 `Execution`。

DOM 实测：

```
.dt-field-head  "Backup route"
button          "Add a backup"          （未配置备选时）
[role=group][aria-label="Backup route"]  （展开后 3 个 input）
  input[list=dt-worker-model-backup-providers]  placeholder="Inherit the DSH default"
  input[list=dt-worker-model-backup-models]     placeholder="Inherit the DSH default"
  input[list=dt-worker-model-backup-efforts]    placeholder="Model default"
button          "Remove the backup"
```

页面可见文案（英文 locale）：

```
Backup route
Add a backup
Takes effect on save, no restart: the routes resolve when a Session is created,
so this applies to new Sessions and to Assignments that start again;
a Session already running keeps its route.
```

截图证据：
- 未配置备选（`Add a backup`）：`docs/review/2026-11-14-issue25-backup-form.png`
- 展开后（三个字段 + `Remove the backup`）：`docs/review/2026-11-14-issue25-backup-form-expanded.png`

### 5.2 填 → 存 → 读回

面板填 `provider=magpie`、`model=workbuddy/deepseek-v4.1-flash-500k`，点 `Save`：

```
保存前 GET settings: executor.model = {provider: magpie, model: workbuddy/deepseek-v4.1-flash-500k}
                     revision = 20
保存后 GET settings: executor.model = {provider: magpie, model: workbuddy/deepseek-v4.1-flash-500k,
                                       backup: {provider: magpie, model: workbuddy/deepseek-v4.1-flash-500k}}
                     revision = 21
```

`revision 20 → 21` 说明走的是真实落库路径，不是前端假状态。

页面 reload → 重新进面板 → 读回：

```
[role=group][aria-label="Backup route"] 存在
values = ["magpie", "workbuddy/deepseek-v4.1-flash-500k", ""]
```

**读回一致**。

### 5.3 负对照（证明放行不是校验被关掉）

| 配置 | 结果 |
| --- | --- |
| 主路由 `no-such-provider/x` + 备选 `also-missing/y` | **400** `modelUnavailable`：`no adapter registered for provider "also-missing"` |
| 主路由 `no-such-provider/x` + 无备选 | **400** `modelUnavailable`：`no adapter registered for provider "no-such-provider"` |
| 主路由 `no-such-provider/x` + 备选 `magpie/workbuddy/deepseek-v4.1-flash-500k` | **200** `{"saved":true,"revision":22,"restarting":false}` |

两条负对照都拒，正对照放行 —— 说明 200 不是「校验被绕过」，而是「主路由不通时退到备选」这条路径真的通了。同时 `restarting: false` 证实第 3 项要求的「保存即生效，不用重启」。

## 六、真实 request 走 backup（issue 收口线）

issue 原文：**「在面板上改一次 backup，并用一条真实 request 验证主路由断时走了新备选，才算完。表单能打开不算。」**

做法：把主路由故意配成不存在的 provider，备选配成与主路由不同的模型（便于在日志里区分），然后投一张真票。

```
PUT settings/executor  revision=24
  model = {provider: no-such-provider, model: x,
           backup: {provider: magpie, model: trae-cn/deepseek-v4.1-flash-max}}
  directory = /tmp/25-live
  → 200 {"saved":true,"restarting":false}

POST http://127.0.0.1:8788/send   (mobilegw, X-Crew-Session: main)
  "@lead 在 /tmp/25-live 下创建 backup-route-proof.txt，内容写 backup-ok，然后只回复 done"
  → 200 {"ok":true,"id":55,"request_id":"ds25-backup-proof-2","session_id":"main"}
```

结果：

```
decision  accept / explicitRouted / 2026-11-14T08:40:14.686Z
ticket    b50ed30fc143f6b2de3df0acea8d9fb6
          title  "在 /tmp/25-live 创建 backup-route-proof.txt（内容 backup-ok）"
          ended  {"by":"executor","outcome":"completed"}
          report "已在 /tmp/25-live/backup-route-proof.txt 写入内容 backup-ok（9 字节，无换行），
                  并 cat 校验通过。无代码改动、无需 PR。"
文件      /tmp/25-live/backup-route-proof.txt → "backup-ok"
```

**决定性证据** —— worker 会话的 `request/header`：

```
~/.dsh/sessions/--private-tmp-25-live--/worker-b50ed30fc143f6b2de3df0acea8d9fb6/session.v4.jsonl.zstd

{"type":"request/header", "data":{"header":{"config":{
   "provider": "magpie",
   "model":    "trae-cn/deepseek-v4.1-flash-max",
   "maxTokens": 64000 }}}}
```

worker 实际用的是 **`trae-cn/deepseek-v4.1-flash-max`**，即我配的备选；主路由 `no-such-provider/x` 在 `llm-pi-ai.providers` 里不存在。如果 fallback 没生效，这张票会像 #25 提交信息里的负对照那样直接 400，不可能跑出文件。

同时这验证了 issue 第 3 项要求的边界：路由在**建 Session 时解析** —— 票是在改完设置之后新建的，所以走新路由。

## 七、回滚与恢复

三处改动全部回滚，逐项核对：

| 改动 | 回滚 | 核对 |
| --- | --- | --- |
| profile patch 追加的注释 | `cp -a cordis.patch.yml.bak-hmr25-20261114-163428 cordis.patch.yml` | SHA-256 回到 `813d1d7e…53f3d10`，与触发前逐字节一致 |
| executor 设置（备选 + 坏主路由 + directory） | `PUT revision=24 → 25`，恢复 `{provider: magpie, model: workbuddy/deepseek-v4.1-flash-500k}`、`directory=""`、`prepare=""`、`maxWorkers=3`、`isolation=none` | 读回逐字段一致 |
| 面板保存时写入的备选 | 随上一条一并清掉（最终 model 无 `backup` 键） | 读回无 `backup` |

回滚后再核对：`isolationActive=false`、`isolation=none`、`masterId` 不变、12 项健康全 ready、PID 89699 / 41418 均不变。

**`pkill -f` 全程未使用**，未向任何生产进程发信号。

## 八、后续限制（不夸大）

1. **`isolationActive` 面板消费已有人做，但不在我这次上线里**（本条已订正，见 §十）。
   我验收当时（16:32 构建、16:34 上线）`grep -rn isolationActive backend/src/client/` 为空，所以部署的 `lib/client.js` 里 `isolationStatus` 命中 **0**。
   之后 `#28`（Part of #17）在源码层补上了这一行（`execution.tsx` 新增 `isolationStatus()` 三态、`locales.ts` 补 6 个键），但**未 build、未 HMR**。
   因此现状是：**源码有了，部署的还是只读 `isolation` 的老版本**。这半条价值要等下一次构建 + 重组才在生产兑现。
2. **HMR 是插件级重启，不是零中断**。`apply()` 卸载再挂载；本次因 `load.running=0` 未切断任何活。手机 LAN 口有约 0.2 秒窗口（文档 §3.2），本轮未单独采样 LAN 口，只采了 HTTP 管理面。ds-19-max 若要在这段时间测 LAN 门，端口可能已变。
3. **`mobilegw` 不在 HMR 覆盖范围**。PID 41418 仍跑旧代码。凡涉及 `backend/tools/` 的改动仍需 `scripts/dsh-superagent restart`。
4. **本轮未 build ds-23-max / ds-prepare-max 的改动**。lead 口径是「未验证不得混入」。lib 是纯 HEAD `b2f305e` 快照；他们改完需要各自单独 build + 重组。
5. **`GET models` 目录未在面板里逐项核对**。表单的 datalist 来自 `GET models`，我只验证了手填 provider/model 能存能读、能真实走通；没验证下拉候选集是否完整覆盖 `llm-pi-ai.providers` 的全部 provider。
6. **未跑桌面端与 App 端验收**。`desktop/ui_actions.go` 在 `549d4e8` 里也改了 15 行，本轮只验 web 面板。
7. **`panel-settings.spec.tsx` 的两例是源码测试**，全量 1927 例全绿（exit 0，33.25s），但它验的是 React 组件，不是生产部署 —— 生产部署由本报告 §五、§六 的实测覆盖。

## 九、命令与退出码清单

| 命令 | exit | 说明 |
| --- | --- | --- |
| `git status --porcelain backend/src backend/tests` | 0 | 空输出，src = HEAD |
| `pnpm build`（backend） | **0** | 2.455s，client.js 380687 B / index.js 766188 B |
| `grep -c backupLabel lib/client.js` | 0 | 4 |
| `grep -c isolationActive lib/index.js` | 0 | 1 |
| `cp -a cordis.patch.yml cordis.patch.yml.bak-hmr25-…` | 0 | 备份 |
| `printf … >> cordis.patch.yml` | 0 | 触发 |
| 采样脚本（142 次 /state） | 0 | 142×200，0 失败 |
| `pnpm test`（backend） | **0** | 110 files / **1927 tests** passed，33.25s |
| `PUT settings/executor` ×5（负对照 2、正对照 1、恢复 2） | 400/400/200/200/200 | 见 §5.3、§七 |
| `cp -a …bak-hmr25-… cordis.patch.yml` | 0 | 回滚，SHA-256 一致 |
| `POST mobilegw /send` | 0 | 200，id=55 |
## 十、订正与并发写入核查（17:01 追加）

### 10.1 订正：§八.1 的「没有面板消费者」已过时

写报告时（16:43）为真，17:01 复核时已不成立。区别在于**源码层**与**部署层**不是一回事：

| 层 | `execution.tsx` 有 `isolationStatus` | 谁做的 |
| --- | --- | --- |
| HEAD `b2f305e` | **无**（`git show HEAD:backend/src/client/execution.tsx \| grep -c isolationStatus` → 0） | —— |
| 当前工作区 | **有**（`execution.tsx:19`、`:41`） | `#28`（Part of #17），见 `docs/review/2026-11-14-isolation-row-active-state.md` |
| 我 16:32 构建的 `lib/client.js` | **无**（`grep -c isolationStatus` → 0） | 我构建的是纯 HEAD 快照 |
| 生产进程 89699 正在跑的面板 | **无** | 同上 |

结论：`2364d40` 的「让档位空转可见」在**管理面**（`/state` 的 `isolationActive`）已由我这次上线兑现；在**面板**由 `#28` 在源码层兑现，**但尚未构建上线**。两件事不能合并说成「已完成」。

### 10.2 并发写入核查（回应 ds-23-max 的 stash 事故）

ds-23-max 在 16:58 前后跑了 `git stash` 又 `git stash pop`（冲突被拒），随后用 `git checkout stash@{0} -- <文件>` 写回。他请我核对 `execution.tsx` / `locales.ts`。

**前提澄清**：这两个文件从来不在我的写范围。我的写范围是 `backend/lib/` 构建产物 + 本任务 `docs/review/` 报告。`isolationStatus` 与 6 个 isolation 键都是 `#28` 的产物，我一行没写过。所以「我的编辑被覆盖」这个风险对我这边不存在。

**逐文件核对结果**（用 `difflib` 逐行比对，不用 `grep`，避免 `-` 开头行被当参数）：

stash 共 23 个文件，其中 **19 个与工作区完全一致**，**4 个有差异** —— 与 ds-23-max 报告的「22 个一致、只有 `execution.tsx` 不同」不符，实际多出 3 个：

| 文件 | 差异行 | 方向 | 内容 |
| --- | --- | --- | --- |
| `backend/src/client/execution.tsx` | 7 | **工作区更新** | 工作区有 `isolationStatus()` 三态调用；stash 里是旧的二分 `data-state` |
| `backend/src/infra/environment.ts` | 4 | **工作区更新** | 工作区多 `at('.npm/_authToken')`（旧版 npm 落盘位置）；stash 没有 |
| `docs/00-contract.md` | 5 | **工作区更新** | 工作区把队列数字标注为「当时现场值」，并加了一行 `mobileq.db` 复核记录；stash 没有 |
| `backend/docs/007-architecture.md` | 3 | **工作区更新** | 工作区多一行 `tests/crew-morning.spec.ts` 的说明；stash 没有 |

**四处的方向全部一致：工作区是 stash 的超集**，没有任何一行「只在 stash、工作区已丢」。也就是说这次 stash/checkout 事故**没有造成内容丢失**。

另外两点与 ds-23-max 的说法需要对齐：

1. **`locales.ts` 根本不在 stash 里**（`git stash show --name-only` 的 23 个文件没有它）。所以它不是「从 stash 原样写回」，而是**一直没被动过**的独立文件。他说「`locales.ts` 与 stash 内容完全一致」—— 它不在 stash 里，这个对比无意义。当前该文件 `mtime 16:58:58`，`git diff HEAD` 为 +11 行（6 个 isolation 键 + 1 行注释），内容完整。
2. **「`npx tsc --noEmit` 0 错」我复核为真**：`TSC_EXIT=0`。`execution.tsx` 引用的 10 个 isolation 键在 `locales.ts` 全部齐备（逐键核对）。

### 10.3 索引状态的一处观察

核查过程中两次 `git status` 结果不同：第一次 `execution.tsx` 与 `docs/00-contract.md` 显示 `MM`（暂存区有内容），紧接着 `git diff --cached --name-only | wc -l` 为 **0**（暂存区为空）。这期间有别人在并发改索引。

对本次验收**无影响** —— 我 16:32 的构建早于所有这些改动，`lib` 的 SHA-256 仍是 `182fcc2b…50090` / `33f11a9a…6c012`，mtime 仍是 16:32:54，与我上线时逐字节一致。但**提醒**：多人共用同一个工作树时，`git stash` / `git checkout --` / `git add` 都会改共享的索引与工作区，任何一方都不该把 `git stash` 当作「看基线」的手段。看基线应该用 `git show HEAD:<file>` 或 `git worktree add`，不碰工作树。

### 10.4 本次核查对 #25 结论的影响

**无影响**。`#25` 的验收对象是 backup 表单与 backup 路由，我验的四个点（表单可见、填存读回、负对照、真实 request 走备选）全部基于我 16:32 构建的 lib，且证据在 16:34–16:41 之间采集完毕，早于 16:58 的事故。`#25` 已关，不因此重开。
