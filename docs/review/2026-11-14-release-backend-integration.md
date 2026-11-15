# 单任务统一后端集成构建 + 不重启 HMR 上线 + 生产复验（2026-11-14）

> 执行者：`ds-release-backend-max`（lead 委派）
> 覆盖：#28（面板隔离三态）/ #26（prepare 凭据 deny 覆盖）/ #23（晨报窗口语义）/ #24（记忆中枢客户端认证）
> 本轮职责：**只做验证 / 构建 / 热部署 / 报告**，不实施源码改动；发现 bug 交 lead 派新 Max。
> 未做：`git add/commit/push/stash/checkout/restore/reset`；未改 `开发进度.md` / `HANDOFF.md` / `scripts/crew-watch` / 任何 `backend/src`。

---

## 零、结论先说

| 项 | 结论 |
| --- | --- |
| 构建 | `pnpm typecheck` EXIT=0；全量 **113 文件 / 2022 例全绿**；`pnpm build` EXIT=0 |
| 上线 | HMR 重组生效，**dsh 父子两个 PID（89697 父壳 / 89699 子进程）与 lstart 全程未变**；`GET /state` **111/111 次 200** |
| 进程 | **本任务未重启任何进程**；观测到 `mobilegw` 被外部 `pkill` 两次触发 launchd 重拉，属**外因事件，待 `ds-process-incident-max` 取证** |
| #28 | **已关单（CLOSED）**。四态全部在真实 headless Chromium 里看到；缺字段态是**隔离 fixture**，不是生产真能缺字段 |
| #26 | 生产同构 `sandboxArgv` + `sensitivePaths`，**24/24 全部 DENIED，0 readable，0 泄露**（临时 HOME + 假 token） |
| #23 | 晨报**在 18:21 由正常每分钟 tick 触发**（不是 08:00 那一拍，也不是我调专用入口）；`push` 三条全 **`queued`**，**已入队 ≠ 设备送达**；**#23 保持 OPEN** |
| #24 | 生产**真实 `recall mode=hub`** 已跑出来；**401 可观察**（health `error` + overview `problems`）；换回正确凭据后恢复。**#24 保持 OPEN**（跨设备上行另 task） |
| 生产临时设置 | 全部恢复（`isolation: none` / `prepare: ''`）；`memory.hub` + token 引用**按验证成功保留** |

**两个必须单列的发现（不是本轮改动引入，但会误导验收）**

1. `memory.timeoutMs` 默认 **1500ms** 小于线上 `/v1/health` 实测 **0.88–1.86s** → 探测被判不可达 → **静默降级本机，日志里看不出异常**。提到 8000ms 后立刻出现真实 `recall mode=hub`。
2. **`memory` 设置块保存后不会重建 `HubProbe`**（`runtime.ts:265` 在构造期捕获 `tokenEnv/tokenFile`）。改 token 引用后必须再来一次 profile 重组才生效，否则「设置改了、行为没变」。

---

## 一、上线前审计（不 build 先读现状）

```
$ git status --porcelain | wc -l        → 27 个已跟踪文件 M + 若干 ??
$ git diff --check                      → EXIT=0（无空白错误）
$ git rev-parse HEAD                    → b2f305e（feat/four-blocks）
```

`backend/lib/` 上线前是 **16:32:54** 那次构建（#25 基线）。用旧构建做区分性探针（旧 → 新）：

| 探针 | 旧 `lib` | 新 `lib` |
| --- | --- | --- |
| `sensitivePaths`（#26） | index=0 | **index=3** |
| `runMorning`（#23） | index=0 | **index=2** |
| `windowLabel`（#23 文案） | index=0 | **index=2** |
| `hubHealthOf`（#24） | index=0 | **index=3** |
| `tokenEnv` / `tokenFile`（#24） | 0 / 0 | **10 / 10** |
| `isolation.unknown`（#28） | client=0 | **client=2** |
| `仅 prepare 阶段`（#28 措辞） | client=0 | **client=1** |
| `仅 worker 执行面`（被打回的错误措辞） | 0 | **0（不得出现）** |

`realSubpath` / `GIT_CONFIG_GLOBAL` / `notices-reported` 落在分包（`lib/poll-*.js`、`lib/kv-*.js`），不在 `index.js` 里——这是 tsdown 分包，不是缺失。

---

## 二、测试与构建（独占，不与其他 agent 并发 vitest）

工作树上曾有并发 vitest 抢 `tests/fixtures` 临时目录导致假红的先例，所以本轮先确认没有别的 vitest 在跑，再独占执行。

```
$ pgrep -fl vitest                      → （空）
$ npx tsc --noEmit                      → EXIT=0

# 定向（本轮四条 issue 相关的 9 个 spec）
$ vitest run tests/crew-morning.spec.ts tests/notices-morning.spec.ts \
             tests/crew-notices-out.spec.ts tests/environment-credentials.spec.ts \
             tests/panel-execution.spec.tsx tests/crew-memory-hub-auth.spec.ts \
             tests/crew-memory-hub-client.spec.ts tests/locales.spec.ts tests/docs.spec.ts
  Test Files  9 passed (9)
  Tests     147 passed (147)            EXIT=0

# 全量
$ vitest run
  Test Files  113 passed (113)
  Tests      2022 passed (2022)         EXIT=0
```

```
$ pnpm build
✔ Build complete in 1552ms   (CJS lib/client.js 386.02 kB)
✔ Build complete in 1713ms   (ESM 17 files, total 1.11 MB)
BUILD_EXIT=0
```

产物：

| 文件 | 旧 | 新 |
| --- | --- | --- |
| `lib/index.js` | 766188 B / `33f11a9a…` | **796432 B / `26a25843…`** |
| `lib/client.js` | 380687 B / `182fcc2b…` | **386018 B / `cd0c50d2…`** |

`backend/lib/` 在 `.gitignore:17`，不进版本库；构建后 `git status` 里没有新增 lib 条目。

---

## 三、HMR 上线（本任务未重启任何进程）

### 3.1 触发前的安全条件（逐条实测，不是照抄文档）

| 条件 | 实测 |
| --- | --- |
| `load.running` | **0** |
| `load.queued` | **0** |
| `open tickets` | **`total: 0`** |
| `paused` | **false** |
| 健康 | 13 项全 `ready` |
| 接口冻结 | `ds-hub-server-fix-max` 明确回复：**不碰 `dsh-bot-crew/backend/src/**` 一个字节**，写范围只在 `home-hub/` 与 `home-agent-memory-v2/` |
| 其他 owner 生产窗口 | 各手机/desktop owner 无在跑活（`running 0 / queued 0 / open 0`） |

### 3.2 备份（凭据脱敏，备份不入 git）

```
~/.dsh/backups/release-backend-20261114-1820/
  lib/                         ← 上线前的完整构建（2.1 MB）
  profile-cordis.patch.yml     ← 生产 profile patch 原件
  home-cordis.patch.yml
  orchestrator.sqlite.bak      ← sqlite .backup 快照（712704 B）
```

备份目录在 `~/.dsh/` 下，不在仓库里，不含任何 token 值。

### 3.3 触发与观测

按 `docs/07-hot-reload.md` §五：`pnpm build` 之后写一次 profile patch 即触发重组。

```
$ cp -a ~/.dsh/profiles/superagent/cordis.patch.yml …bak-release-20261114-1821
$ shasum -a 256 cordis.patch.yml   → 813d1d7e87aa2668…53f3d10   （与 #25 记录一致）
$ printf '\n# release-backend-20261114-1821: touch …\n' >> cordis.patch.yml
touched at 2026-11-14T10:20:48Z
```

50ms–200ms 采样 `GET /orchestrator/api/state` 覆盖触发窗口：

```
samples: 111   codes: {'200': 111}   non-200: []
window: 1794651641.501 → 1794651671.029
```

- **`GET /state` 111/111 次 200，零失败**。
- 新代码生效的判据不是「请求没报错」，而是**旧构建里不可能存在的符号出现在 API 行为上**：`/settings` 的 `memory` 块从 `{hub,timeoutMs}` 变成 `{hub,timeoutMs,tokenEnv,tokenFile}`。

### 3.4 进程与状态

**dsh 侧是父子两个 PID，必须分开说，不能笼统写「PID 不变」：**

```
89697  PPID=1      Sat Nov 14 14:26:39 2026   bash -c cd /Users/cpuser && nohup … dsh --profile superagent … 
89699  PPID=89697  Sat Nov 14 14:26:39 2026   node …/bin/dsh --profile superagent --no-open --trusted-host …
```

89697 是拉起它的 `bash -c` 父壳（PPID=1），89699 才是真正跑插件的 node 进程。**两个 PID 与两者 lstart 全程未变**——这才是「HMR 没有重启宿主」的完整判据。

| 指标 | 触发前 | 触发后 |
| --- | --- | --- |
| dsh 父壳 | **89697**（PPID=1，lstart `14:26:39`） | **89697，lstart 不变** |
| dsh node | **89699**（PPID=89697，lstart `14:26:39`） | **89699，lstart 不变** |
| mobilegw | 41418 | **67367** —— 见 §八·偏差 3，**外因事件，非本任务操作** |
| `masterId` | `orchestrator-bbbb4bafe8…` | 同 |
| `paused` | false | false |
| `load` | `{running:0, queued:0, maxWorkers:3}` | 同 |
| 健康 | 13 项 ready | 13 项 ready |

**生产 bundle 命中全部新符号**（不是只命中一个）：`sensitivePaths`、`runMorning`、`windowLabel`、`reportedFrom`、`hubHealthOf`、`tokenEnv`/`tokenFile`、`isolation.unknown`/`isolation.active`/`isolation.inactive`、`仅 prepare 阶段`、`worker 未覆盖`、`生效状态未知`、`prepare 已生效`、`上次汇报以来`。**被打回的错误措辞 `仅 worker 执行面` 命中 0**。

---

## 四、#28 面板隔离行三态（真实 headless 浏览器，不抢焦点）

**验收对象**：`http://127.0.0.1:3082/`（生产进程，`?token=` 取自启动行），headless Chromium，全程 `page.evaluate` 驱动，未聚焦任何窗口。

### 4.1 四态实测

| 态 | 生产设置 | 实测行文本 | 色调 | 截图 |
| --- | --- | --- | --- | --- |
| **A** `none` | `isolation=none` | `Isolation  None · runs as your OS user`（严格等于 `isolation.none`，**不挂后缀**） | `warning` | `shots-issue28/A-none.png` |
| **C** `sandbox` + 空 prepare | 真实热设置：`isolation=sandbox`、`prepare=''` | `Isolation  Platform sandbox · prepare stage only · not in effect` | `error` | `shots-issue28/C-sandbox-empty-prepare.png` |
| **B** `sandbox` + 真 canary prepare | 真实热设置：`isolation=sandbox`、canary prepare | `Isolation  Platform sandbox · prepare stage only · prepare in effect` | `ongoing` | `shots-issue28/B-sandbox-active.png` |
| **D** 宿主缺 `isolationActive` | **隔离 fixture**（见 §4.3） | `Isolation  Platform sandbox · prepare stage only · effect unknown` | `warning` | `shots-issue28/D-fixture-host-omits-field.png` |

B / C 两次都是**真实生产热设置**：走 `PUT /orchestrator/api/settings/executor`（`revision 25→26→27→28`），保留 `model` / `botModels` / `maxWorkers` / `directory` / `repositories` / `blockedCommands` 全部其他字段，`restarting:false`。

B 态的 canary prepare 是**真的跑得起来的一行命令**（`mkdir -p .canary-release-28 && printf … > .canary-release-28/marker.txt && cat …`），所以「prepare 已生效」对应的是 `isolationActive:true` 这个真实计算结果，不是伪造字段。

### 4.2 三态 hint 都显式写明 worker 未覆盖

B 态 tooltip 原文（`aria-label`）：

> The sandbox covers the prepare stage only; the worker is not covered — commands an agent runs in its session start from the DSH host without a sandbox and can still read your credentials. Confirm this boundary before connecting real accounts.

C 态：`The sandbox level is configured, but prepare is empty: this repo isolates inside prepare, so nothing runs sandboxed. The worker was never covered either, so nothing is isolated at all and your credentials stay readable. Fill in prepare to make it take effect.`

D 态：`The host did not report whether the level is in effect (isolationActive); this build may predate 2364d40. A configured sandbox does not mean prepare actually ran sandboxed, so read it as unknown; the worker is not covered either way.`

**没有一态把 worker 说成已覆盖。**

### 4.3 D 态的边界（必须说清，不许含糊）

**生产宿主现在确实返回 `isolationActive`**（`/state` 顶层 keys 含该键，实测 `false`/`true` 都出现过）。所以 D 态**不可能**在生产真机上自然出现。

D 态用的是一个**明确隔离的响应 fixture**：在浏览器页面上下文里包一层 `fetch`，只对 `GET /orchestrator/api/state` 的响应 `delete data.isolationActive`（并把 `isolation` 设为 `sandbox` 以便走到该分支）。页面里同时打了 `window.__fixture28.hits` 计数，截图时该计数为 **1**，即这一帧确实由 fixture 产出。

口径红线：**这不是「生产能缺字段」的证据**，只是「旧宿主（早于 `2364d40`）缺字段时面板不会把它读成 `false`」的行为证据。说成前者就是假证据。

### 4.4 反向事实：`none` 档不被拖成未知

D 态同一次 fixture 响应下，`none` 档仍然严格等于 `isolation.none` 全文——证明「缺字段」只影响 `sandbox` 分支，没有把整个字段的缺席当成全局降级。

---

## 五、#26 prepare 凭据 deny 覆盖（生产同构，临时 HOME，假 token）

**不读操作者真实凭据、不读真实 shell 历史、不打印任何文件内容。**

方法：临时 `HOME` 里为 `sensitivePaths()` 的每一条造一个**假内容**（`CANARY-FAKE-NOT-A-REAL-SECRET`），然后用生产同一条构造路径 `sandboxArgv([execDir], sensitivePaths(home))` 包 `/bin/cat` 真跑，只看退出码与 stderr 分类。

```
sandboxAvailable=true  entries=24
prepareVariables keys=GH_CONFIG_DIR,GIT_CONFIG_GLOBAL,GIT_CONFIG_NOSYSTEM
```

| 判定 | 数量 |
| --- | --- |
| **DENIED** | **24 / 24** |
| readable | 0 |
| absent | 0 |
| 泄露 canary 内容 | **0** |

24 条全部 `DENIED`：`.ssh` `.gnupg` `.git-credentials` `.gitconfig` `.netrc` `.aws` `.azure` `.kube` `.config` `.docker` `.npmrc` `.npm/_authToken` `.yarnrc` `.yarnrc.yml` `.pypirc` `.cargo/credentials` `.cargo/credentials.toml` `.gem/credentials` `.m2/settings.xml` `.vault-token` `.password-store` `.zsh_history` `.bash_history` `.zsh_sessions`。

`prepareVariables()` 确实带上了 `GIT_CONFIG_GLOBAL`（对应 #26 里「prepare 补 GIT_CONFIG_GLOBAL」那条）。

**残余边界照旧成立、不因这条夸大**：这是按**载体类别枚举的 24 条明确名单**，不是 secret 扫描器；表外 secret、软链目标、keychain、网络、**worker 侧（归 #22）**、非 macOS 都不在覆盖内。`isolation` 默认仍 `none`，本轮**没翻默认**。

---

## 六、#23 晨报：真实触发方式、时间窗口、送达边界

### 6.1 晨报是怎么触发的（必须如实说）

生产日志（新构建上线后）：

```
[push] queued kind=morning device=crew-desktop
[push] queued kind=morning device=d021988751fdd554
[push] queued kind=morning device=66e74d226c1e38fa
[morning] sent day=2026-11-14 pending=0
```

时间对齐：

- 新代码生效：`runtime` health `2026-11-14T10:20:52.155Z` = **18:20:52 CST**
- `notices-reported` 落库：`2026-11-14T10:21:52.160Z` = **18:21:52 CST**
- 差值 **恰好 60 秒 = 一个 `TICK_MS`**

**结论：这不是我调用的专用验证入口，也不是「08:00 那一拍」。** 是 `startRoutines()` 的每分钟 tick 在新构建上线后的**第一拍**跑到了 `runMorning()`，而 `morningDue()` 的窗口是 `MORNING_HOUR(8) <= hour < DAILY_HOUR(21)`，18:21 落在窗口内，于是它发了。

**lead 已裁定：保持这条既有语义**（本地 `8 ≤ hour < 21` 的窗口内首拍就发），**不把 18:21 说成 8 点定时**，窗口与水位文案一律如实。所以下面描述的是**既定行为**，不是缺陷：

- 它不是「定时到 8 点整」，是「落在窗口内的第一拍」。
- 真实后果：**一台 15:00 才开机的机器，会在 15:01 收到一份「晨报」**。这是该语义的预期表现。
- 日志写 `[morning]`，正文抬头由 `windowLabel` 按真实水位给（本例没有水位线 → 兜底 `今日`，不是「昨夜」）——**文案不冒充时间范围**。

### 6.2 持久水位真的落了库

| 时刻 | `kv` 里的 `notices-*` |
| --- | --- |
| 上线前（18:19 备份快照） | **两条都没有** |
| 上线后 | `notices-morning = {"day":"2026-11-14","spoken":[]}`、`notices-reported = "2026-11-14T10:21:52.160Z"` |

即：新构建第一次真跑到就**建了水位线并推进**，`spoken` 原样落库（`pending=0` 表示没有点名明细，不是失败）。同一份水位同时供早报与日报使用，这是 #23 的「不重不漏」机制。

窗口内可数的票：按 `ended.at ∈ [水位, now]` 统计为 **13 件**，与正文口径一致。

### 6.3 时钟：没有改全局、没有改宿主系统时间

- 全程未执行任何 `date` / `systemsetup` 写操作，未改时区。
- 验证时段内 `date` 始终是正常推进的 `Sat Nov 14 18:2x–18:4x CST 2026`。
- 「跨日 / 停机多天」的窗口语义**只在测试里**用假时钟验（`crew-morning.spec.ts` 20 例 + `notices-morning.spec.ts` 28 例），**没有**拿生产系统时钟做实验。

### 6.4 送达：入队 ≠ 送达

三条 `[push]` 全是 **`queued`**，不是 `delivered`。按 `push.ts` 的语义：

- 隧道那一档发出去 → 中转接管（在线直送 / 离线留件都在中转侧）→ 回 `queued`；
- `queued` 只说明「这条已经交给某一档」，**不说明设备收到**。

我没有拿到任何一台设备的「已收到」证据：`GET /remote/devices` 里三台设备（`crew-desktop` / Redmi `d021988751fdd554` / OPPO `66e74d226c1e38fa`）的配对记录是历史事实，不是本次送达回执。中转侧没有暴露可查询的留件队列深度，`health.notice` 报 `Nothing waiting` 也只说明宿主本地这一档没积压。

**所以：#23 的「真实设备晨报送达」这一条仍然没有证据，不写成已完成。** 我没有向任何手机注入输入、没有操作它主人的 App。

---

## 七、#24 记忆中枢：配置、真实召回、401 可观察与恢复

### 7.1 生产配置（只存引用，不存值）

```
memory = {
  hub:       "https://jarvis.kentonnie.top/v1"
  timeoutMs: 8000
  tokenEnv:  "HUB_TOKEN"
  tokenFile: "/Users/cpuser/.config/hub-memory-mcp/env"     ← 0600，原有文件，未改动
  revision:  5
}
```

- **优先用现有 raw secret 引用**：没有新建 token 文件，没有把 `HUB_TOKEN` 提成专用文件，没有输出任何 token 内容，报告里不出现值。
- 设置块是 `.strict()` 的，塞 `token` 字段会被拒——我没有尝试存值。
- `/state`、日志、错误消息里均无 token 值（`HubAuthError` 只带状态码与响应体 detail）。

### 7.2 服务端 ready（由 `ds-hub-server-fix-max` 上线并复验）

- 镜像 `home-agent-hub:issue24fix2-20261114-1845`，`hub-api Up (healthy)`，postgres 全程未重启，caddy/dsh/mobilegw 未触碰。
- `GET /v1/health` → 200，含 `memory_compat: registered`；`GET /healthz` 形状未变。
- 无 token / 错 token 的 `POST /v1/memory/search` → **401 invalid hub token**。
- 带真 token：`search` 回真实生产条目（`bot-coder-use-pnpm-test`）；带 `bots` 时 `namespaces` 含 `bot/lead` 与 `dsh-memory/bot`（修好「带 bots 漏查 `bot/<id>`」的可见证据）。
- `consolidate` → `dryRun:true`、`merged:0`、`candidateMerges:0`、`scanned:0`、`existingFacts:0`。**`facts:0` 是正确值**（兼容层不提炼），不是回归；`apply` 未打开，零破坏性写。
- 接口零变更：`X-Hub-Token` header、`POST /v1/memory/search`（`{query,bots?,limit?,known_bots?}`）、`POST /v1/memory/consolidate`（不传 `apply`）、`GET /v1/health`。客户端代码**零改动**。

### 7.3 生产进程内的真实召回（不是 curl 探针）

用桌面端真凭据（`~/.config/crew-desktop/credential.json`，`deviceId=crew-desktop`）走**真链路**投测试票：
`POST /api/mobile/send?session_id=main` → lan-server → phone-gate → mobilegw → team Source → Trigger → Eval → Ticket → Executor → worker recall。

生产日志：

```
[memory] hub 鉴权就绪 via file (https://jarvis.kentonnie.top/v1)
[memory] hub reached (https://jarvis.kentonnie.top/v1)
[memory] recall mode=hub chars=332 taken=["bot-coder-use-pnpm-test","bot-coder-dsh-git-push-credential-helper"]
```

**`recall mode=hub`** 是关键判据：`mode=local` 时注入片段只能来自本机账本；`mode=hub` 且 `taken` 里是中枢条目名，说明这段注入真的从中枢来。

同一轮还观察到 `bot=lead` 走 `mode=local`：因为中枢里 `bots=[lead]` **一条都没有**（我直接查过：`lead` 0 条、`coder` 2 条、`scribbler` 1 条）。这是数据分布，不是链路故障——但会让人误判「hub 没生效」，值得记一笔。

### 7.4 401 可观察（这是本轮最关键的一条）

把 `tokenFile` 指向一个**我自造的假 token fixture**（`~/.config/dsh-superagent-fixtures/hub-wrong-token.env`，0600，内容是自造字符串），投真票：

```
[memory] hub 鉴权被拒 (401) (https://jarvis.kentonnie.top/v1) — 中枢不接受 memory.tokenEnv/memory.tokenFile 的凭据；hub 未启用，记忆走本机
[memory] hub search auth rejected (401) — hub NOT in use, memory falls back to local; check memory.tokenEnv / memory.tokenFile
[memory] recall mode=local bot=coder chars=1195 …
```

`/state.health.memory`：

```
{"state": "error", "detail": "中枢拒绝凭据 (401)：hub 未启用，记忆走本机；检查 memory.tokenEnv / memory.tokenFile（{\"detail\":\"invalid hub token\"}）"}
```

`GET /overview` 的 `problems`：

```
[{"kind":"runtime-error","name":"memory","detail":"中枢拒绝凭据 (401)…"}]
```

**三条都成立**：日志明确否定（不再有「hub reached」后紧跟全量降级的假成功）、health 是 `error` 而不是 `ready`、错误进了 overview 的 `problems`（面板可见）。fixture 用完已删除（`~/.config/dsh-superagent-fixtures/` 整个目录不存在）。

### 7.5 恢复：换回正确引用后确实恢复

换回 `~/.config/hub-memory-mcp/env` 后，**在设置保存的那一刻不会自动恢复**（见 §八·偏差 2），需要一次 profile 重组让 `HubProbe` 重新捕获引用。重组后：

```
[memory] hub 鉴权就绪 via file (https://jarvis.kentonnie.top/v1)
[memory] hub reached (https://jarvis.kentonnie.top/v1)
[memory] recall mode=hub chars=332 taken=["bot-coder-use-pnpm-test","bot-coder-dsh-git-push-credential-helper"]
```

`health.memory` 回到 `{"state":"ready","detail":"中枢凭据来自凭据文件"}`。**没有模拟成功**：恢复判据是 `mode=hub` + 真实中枢条目名同时出现。

---

## 八、偏差与发现（如实记，不藏）

### 偏差 1：`memory.timeoutMs` 默认 1500ms 小于线上探测耗时 → 静默降级

| 事实 | 数值 |
| --- | --- |
| 默认 `timeoutMs` | **1500ms**（`policy.ts` 的 `MemoryConfigSchema`） |
| 线上 `GET /v1/health` 实测 | **0.877s / 1.861s / 1.410s** |
| 1500ms 下的行为 | 探测偶发超时 → `reachable()=false` → `recall` 走 fallback → 日志只有 `mode=local`，**没有任何错误** |
| 8000ms 下的行为 | 立刻出现 `recall mode=hub` |

这是**真实产品缺陷**（不是本轮引入）：一台到中枢 RTT 稍高的机器会永久拿到「hub 配了但记忆全本机」，而 health 仍报 `ready`（**假 ready**）。本轮我通过把生产 `timeoutMs` 提到 8000 规避，但**默认值本身需要 owner 决定**。

**已派单**：lead 已派 `ds-runtime-memory-max` 根治「网络超时导致 health 假 ready」与「memory 热设置不重建」。**我不要改源码**，只留证据。

### 偏差 2：`memory` 设置保存后不重建 `HubProbe`

`runtime.ts:265` 在 `Runtime` 构造期把 `tokenEnv` / `tokenFile` 捕获进 `HubProbe` 的 `token: { env, file }`；`Settings.save` 对 `memory` 块只做 `merge` + `guard`，**没有任何重建/重定向钩子**（`memoryProbe` 在 `src/` 里除构造处外没有消费者）。

后果：改完 token 引用，`/settings` 立刻显示新值，但**行为不变**，直到下一次 profile 重组（或重启）。我实测到了这个现象：换回正确引用后 `health` 仍是 `error`，直到重组才恢复。

`HubAuth.refresh()` 会在每次 `probeOnce` 时重读凭据——但那读的是**构造期捕获的引用**，引用本身变了它读不到。

**已派单**：与偏差 1 同属 `ds-runtime-memory-max`（「memory 热设置不重建」）。根治方向二选一：把 `memoryProbe` 做成可 `retarget`，或让 `memory` 块保存后触发一次重组。我不改源码。

### 偏差 3：mobilegw 被外部 pkill 两次 —— **本任务未重启，观测到外因事件待取证**

| 指标 | 值 |
| --- | --- |
| 上线前 mobilegw | **41418**（lstart `Sat Nov 14 00:01:07 2026`，存活 66521578ms ≈ 18.5h） |
| 中间态 | **65972**（存活 74921ms ≈ 75s） |
| 现在 | **67367**（lstart `Sat Nov 14 18:31:04 2026`） |

根因（launchd 统一日志原文，两次都是外部 `pkill`）：

```
2026-11-14 18:29:49.247 launchd[1:7b0a06] [gui/502/com.cpuser.dsh-mobilegw [41418]:]
  exited due to SIGTERM | sent by pkill[65970], ran for 66521578ms
2026-11-14 18:29:49.248 launchd[1:7b0a06] [gui/502/com.cpuser.dsh-mobilegw [65972]:]
  xpcproxy spawned with pid 65972
2026-11-14 18:31:04.172 launchd[1:7b125d] [gui/502/com.cpuser.dsh-mobilegw [65972]:]
  exited due to SIGTERM | sent by pkill[67365], ran for 74921ms
2026-11-14 18:31:04.173 launchd[1:7b125d] [gui/502/com.cpuser.dsh-mobilegw [67367]:]
  xpcproxy spawned with pid 67367
```

`com.cpuser.dsh-mobilegw` 是 `KeepAlive:true` 的 LaunchAgent（`/Users/cpuser/Library/LaunchAgents/com.cpuser.dsh-mobilegw.plist`），被杀后 launchd 立刻拉起——**重启是 launchd 做的，不是任何人的 `launchctl`**。

**本任务没有重启任何进程**。我的全部命令类别见 §十一：`git` 只读、`tsc`/`vitest`/`pnpm build`、写 profile patch 注释、`curl`、headless 浏览器、`cp -a` 备份、`rm -f` 自造 fixture、`log show`/`ps`/`lsof`/`launchctl print` 只读。**没有一次 `kill` / `pkill` / `killall` / `launchctl kickstart|stop|bootout`**，也没跑 `scripts/dsh-superagent restart`（那才会 SIGINT dsh 并重建 mobilegw）。

另外两条否定证据，一并交给取证方：

- `log show --predicate 'process == "pkill"' --start "…18:29:40" --end "…18:31:10"` → **零条**（pkill 不写自己的事件，只有 launchd 记录的「sent by」）。
- 全仓 `grep -rn pkill --include=*.sh --include=*.py --include=*.ts --include=*.mjs --include=*.go .`（排除 node_modules）→ **零命中**，本仓脚本没有 pkill。

即：**调用方身份目前无证据**。原始取证（launchd 日志逐字片段、plist 路径与配置、我这边可证明的边界）已完整交给 `ds-process-incident-max`，由它只读取证。

关键区分：HMR 只重组 dsh 插件，**管不到 `backend/tools/` 这类插件外进程**（`docs/07-hot-reload.md` §五已写明）。所以即便我触发过 6 次重组，也不可能向 mobilegw 发 SIGTERM。

### 偏差 4：晨报在「窗口内第一拍」发 —— lead 已裁定保持该语义

见 §6.1。`morningDue` 是 `8 <= hour < 21` 的**窗口**，不是时刻。

**lead 已裁定：保持既有语义**，不把 18:21 说成 8 点定时，窗口/水位文案如实。因此这条**不是待修缺陷**，按既定行为记录。**#23 仍 OPEN**，缺口是真实账号（邮箱/日历源）与真机送达，不是这条。

### 发现 5：`consolidate` 的 `facts` 恒 0 是正确值

服务端兼容层不提炼，`facts` 只报「本层提炼了几条」= 0；窗口内已蒸馏行数移到 `existingFacts`，`scanned` 是实际扫过的 crew 行数。旧客户端只读 `facts/merged/superseded` 三个非负整数，不会失败。**验收时别把 `facts:0` 当回归。**

### 发现 6：`plan()` / `planWrite()` 在 `backend/src/**` 无调用点

`backend/src/app/memory.ts` 的 `MemoryLedger.plan()` 与 `memory/adapter.ts` 的 `planWrite()` 没有调用点，产品账本（KV/SQLite）**没有**写 `~/.dsh/memory/bot/<bot_id>/` 的路径；上行靠 worker 按 prompt 自己写 md。这条由 `ds-sync24-max` 独立核实，我复核**属实**，且不在本轮改动里、我没有补接线。

---

## 九、生产临时设置恢复（前后差异 + 回滚方法）

### 9.1 最终状态

| 设置 | 上线前 | 现在 | 处置 |
| --- | --- | --- | --- |
| `executor.isolation` | `none` | **`none`** | 验证期临时改过 `sandbox`（两次），**已恢复** |
| `executor.prepare` | `''` | **`''`** | 同上，canary prepare **已清除** |
| `executor` 其他字段 | 见下 | **逐字一致** | `model` / `botModels` / `maxWorkers:3` / `directory:''` / `repositories:[]` / `blockedCommands:[]` |
| `memory.hub` | `''` | **`https://jarvis.kentonnie.top/v1`** | **按验证成功保留**（长期启用） |
| `memory.tokenEnv` | `''` | **`HUB_TOKEN`** | 同上 |
| `memory.tokenFile` | `''` | **`/Users/cpuser/.config/hub-memory-mcp/env`** | 同上 |
| `memory.timeoutMs` | `1500` | **`8000`** | 为规避偏差 1；**需 owner 决定是否改默认值** |
| 假 token fixture 文件 | — | **已删除** | `~/.config/dsh-superagent-fixtures/` 整个目录不存在 |

`executor` 块 `revision 25 → 28`（三次保存：sandbox+空、sandbox+canary、恢复 none）；`memory` 块 `revision 0 → 5`。

### 9.2 保留 `memory.hub` 的依据

满足 lead 给的条件：**验证成功 + 无 fallback 误报**。

- `recall mode=hub` 真实出现（两次，§7.3 / §7.5）；
- `health.memory` = `ready`，`detail` 说明「中枢凭据来自凭据文件」；
- `overview.problems` 为空（401 那次已恢复）；
- 没有 fallback 误报：401 场景下 health 是 `error` 且进 problems，**不是** `ready` + 静默降级。

### 9.3 回滚方法

**回滚构建（回到 #25 基线构建）**

```sh
# 1) 停掉这次的新产物，换回备份
rm -rf /Users/cpuser/Code/dsh-bot-crew/backend/lib
cp -a ~/.dsh/backups/release-backend-20261114-1820/lib /Users/cpuser/Code/dsh-bot-crew/backend/lib

# 2) 触发一次 profile 重组（不重启进程）
printf '\n# rollback %s\n' "$(date -Iseconds)" >> ~/.dsh/profiles/superagent/cordis.patch.yml
```

**回滚 profile patch 原件**

```sh
cp -a ~/.dsh/backups/release-backend-20261114-1820/profile-cordis.patch.yml \
      ~/.dsh/profiles/superagent/cordis.patch.yml
```

**回滚设置**

```sh
# isolation / prepare 已在 none / '' —— 无需动作
# memory 想退回「全本机」：
curl -s -X PUT http://127.0.0.1:3082/orchestrator/api/settings/memory \
  -H 'x-orchestrator-request: 1' -H 'content-type: application/json' \
  -d '{"value":{"hub":"","timeoutMs":1500,"tokenEnv":"","tokenFile":""},"revision":<当前 revision>}'
```

**回滚 sqlite（仅状态层面，一般不必要）**

```sh
cp -a ~/.dsh/backups/release-backend-20261114-1820/orchestrator.sqlite.bak /tmp/rollback.sqlite
```

> 注意：`memory` 块的改动的**生效**需要一次 profile 重组（见偏差 2），单独 PUT 不会立刻改变行为。

---

## 十、逐 issue 收口建议

| # | 本轮证据 | 建议 |
| --- | --- | --- |
| **#28** | 四态真实 headless 渲染 + 三条 hint 均写明 worker 未覆盖 + 错误措辞命中 0 + 反向事实（`none` 不被拖成未知） | **已 CLOSED**（lead 决策：三生产态 + 缺字段 fixture 已够覆盖）。验收评论见 issue #28，fixture 性质已写清 |
| **#26** | 生产同构 `sandboxArgv`，24/24 DENIED，0 readable，0 泄露；`GIT_CONFIG_GLOBAL` 已补；`realSubpath` 在分包里生效 | **源码侧已上线**（`sensitivePaths` 命中 3）。残余边界（表外 secret / worker 侧 / 非 macOS）照旧，worker 侧归 #22 |
| **#23** | 晨报真实触发（窗口内第一拍）+ 水位落库 + `push` 三条 `queued` + **无设备送达回执** | **保持 OPEN**：真实账号缺口（邮箱/日历源）与真机送达均无证据。窗口语义已由 lead 裁定保持，不再是待定项 |
| **#24** | 真实 `recall mode=hub` + 401 可观察（health `error` + overview `problems`）+ 恢复 + 服务端 fix2 ready + 零接口变更 | **保持 OPEN**：跨设备**上行**另 task（`ds-sync24-max`）；本轮只证读取侧。偏差 1/2 已派 `ds-runtime-memory-max` |

---

## 十一、写范围与协作

**我改的**

- `backend/lib/**`（构建产物，gitignore，不进版本库）
- `~/.dsh/profiles/superagent/cordis.patch.yml`（追加 6 行注释 touch，原件已备份）
- 生产设置：`executor`（临时验证后恢复）、`memory`（按验证成功保留）
- 本报告 + `docs/review/shots-issue28/*.png`（4 张截图）
- GitHub issue #28 的验收评论与 close（`gh issue comment` / `gh issue close`，非 git 写操作）

**我没改的**

- `backend/src/**`、`backend/tests/**`（一个字节都没动；`git status` 里那些 `M` 全是其他 owner 的未提交改动）
- `开发进度.md`、`HANDOFF.md`、`scripts/crew-watch`、`docs/00-contract.md`
- 任何 `app/`、`desktop/`、`relay/`、`docs/adr/`
- 没有 `git add/commit/push/stash/checkout/restore/reset`

**协作**

- `ds-hub-server-fix-max`：确认接口冻结（不碰 `backend/src`）+ 服务端 fix2 上线复验结论。
- `ds-process-incident-max`：已交付 mobilegw 两次 SIGTERM 的原始取证（launchd 日志逐字片段含时间戳/`sent by pkill[PID]`/存活毫秒数、plist 路径与 `KeepAlive/RunAtLoad`、两条否定证据、我的完整命令类别清单）。它只读取证。
- `ds-runtime-memory-max`：偏差 1（网络超时 → health 假 ready）与偏差 2（memory 热设置不重建）的根治 owner。我不改源码。
- `ds-sync24-max`：已同步 base、凭据引用名、`timeoutMs` 陷阱、`bot=lead` 无条目、`facts:0` 语义、生产活窗口（我不会再动 hub-api / dsh / mobilegw）。

**浏览器**：headless Chromium 全程 `page.evaluate` 驱动，未聚焦任何窗口、未发送桌面输入；结束前 `close(kill:true)`。
