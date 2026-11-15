# #24 最后真实同步闭环 — A 本机 author 记忆 → 既有 local_dream 上行 → B 真实客户端中枢召回

- 日期：2026-11-14 18:48–18:58（Asia/Shanghai）
- 执行者：ds-sync24-max（lead 委派）
- 结论：**author 文件这一条路已端到端实证**（A 落盘 → 既有管道 queued/flushed → 中枢行 → B 真实客户端进程按 bot_id 召回 → 软删后不再召回）。
  **但产品账本（KV）→ author 目录没有写入接线**：`MemoryLedger.plan()` / `adapter.planWrite()` 在 `backend/src/**` 零调用点，生产账本 28 条 `toHub` 全为 `false`、`lead` 有 23 条账本却连 author 目录都不存在。
  所以 #24 只能按「author 文件路径」口径关；按「产品账本自动上行」口径，缺的正是这条 production seam（见 §六）。

---

## 一、拓扑（先说清「不是两物理设备」）

```
[A] 本 Mac，产品 adapter 渲染 → ~/.dsh/memory/bot/coder/bot-coder-sync24-probe-<ts>.md
        │   (local_dream.sources.dsh_memory.root = ~/.dsh/memory，enabled: true)
        ▼
   既有管道（launchd com.homeagent.dream，WatchPaths=dream.trigger + 每小时兜底）
        │   event hint: dsh-memory compact  →  dsh-memory/* 命名空间旁路 scan_throttle/min_hours
        │   MemoryOutbox → HTTP POST /v1/memories（publish_transport: http）
        ▼
[NAS] home-agent-hub-postgres-1 / agent_hub，namespace = dsh-memory/bot
        │
        ▼
[B] 本 Mac 上的**第二个独立进程**（pid 不同、stateDir 为全新 tmp、本机账本 0 条）
        │  产品真实代码：HubProbe + HubHttp + pickMemoryPort + readHubToken（按引用读凭据）
        ▼
    中枢 /v1/memory/search 命中该条
```

**明确标注**：A 与 B 都在同一台 Mac 上，B 只是**跨进程**（另一个 pid、另一份空账本、走真实 HTTP 到 NAS 再回来），
**不是两台物理设备**。本轮没有走「已连接手机入口」——手机输入属 pairing owner 独占，我不操作手机；
`remote-devices.json` 里已配对的三台设备（crew-desktop / Redmi 24117RK2CC / OPPO PEDM00）本轮未使用。
真正的物理跨设备证据是既有 7.4 节那条（A 写 → B 读），本次补的是「A 是**本机 author 记忆**、走**既有管道**」这一环。

---

## 二、A 侧：落地（产品代码渲染，不是手搓 frontmatter）

脚本：`docs/review/issue24-sync/01-author-write.ts`

- 用产品自己的 `MemoryLedger.settle()`（真 Store，临时 stateDir）+ `adapter.planWrite()` 渲染并落盘。
- Bot：`coder`（设置里已存在的合法 bot_id，未新建任何 Bot、未改设置）。
- 落点：`/Users/cpuser/.dsh/memory/bot/coder/bot-coder-sync24-probe-1794653328.md`（0600）。

实际落盘内容（产品 `renderMarkdown` 输出，逐字）：

```markdown
---
name: bot-coder-sync24-probe-1794653328
description: 短寿命探针 1794653328：验证 author 记忆经既有管道上行到中枢
type: reference
status: candidate
importance: 1
dedupe_key: sync24-probe-1794653328
created: 1794653329
updated: 1794653329
---

这是一条**短寿命测试事实**，标记 1794653328，用于验证 dsh-bot-crew #24 的真实上行闭环。

- 归属 Bot：coder（现有合法 bot_id，未新建）。
- 写入方：产品 adapter 渲染，落盘到 local_dream 的 dsh_memory 源监听目录。
- 清理：验证完按 forget/软删清理，不进用户真实事实。
```

`LEDGER written = 1 name = bot-coder-sync24-probe-1794653328 bot_id = coder state = active`

---

## 三、上行：既有管道真的搬了它（不是我 curl 出来的）

触发方式用的是管道自己给 agent 的入口 `~/.home-agent-bridge/dream_notify.sh`（launchd WatchPaths 监听的就是它写的
`dream.trigger`），**没有**手工 `POST /v1/memories`。

`~/.home-agent-hub/dream.err.log` 原文（行号即文件行）：

```
138448  2026-11-14 18:49:27,415 INFO node_bridge.local_dream: event hint consumed: agent=dsh-memory event=compact age=4s
138462  2026-11-14 18:49:27,497 INFO node_bridge.local_dream: queued native dsh-memory/bot bot-coder-sync24-probe-1794653328.md #2772153677039a9d
138463  2026-11-14 18:49:30,592 INFO node_bridge.local_dream: flushed dsh-memory-bot-2772153677039a9d.json
```

`queued native` 这一行是关键：它来自 `iter_dsh_auto_memory`（`dsh_memory` 直通源，**不二次蒸馏**），
`flushed` 表示 outbox 已拿到 2xx 并从 `memory/pending/` 删掉（触发后 `pending/` 计数 = 0）。

NAS 侧只读核对（经 hermes，`SELECT` only，容器 `home-agent-hub-postgres-1` / 库 `agent_hub`）：

```
id:          5516d0bd-f695-4f72-9844-a28c07c13675
created_at:  2026-11-14 18:49:29.925202+08
deleted_at:  2026-11-14 18:52:12.514978+08      ← 我的清理
source_file: bot-coder-sync24-probe-1794653328.md
dedupe_key:  2772153677039a9d
```

**pipeline metadata 正确**（MCP `hub_memory_search` 取回的行，删除前）：

| 字段 | 值 | 判读 |
|---|---|---|
| namespace | `dsh-memory/bot` | 与 `_iter_dsh_auto_memories` 的 `dsh-memory/<dir>` 一致 |
| layer | `Context` | dsh 直通源固定 layer |
| origin | `native` | 直通源，**不是** `distill`（未二次蒸馏） |
| source | `native-memory` | |
| imported_from | `local-dream-native` | 证明来自 local_dream 直通，不是客户端 POST |
| node_id | `mac-workstation` | |
| origin_ref / source_file | `bot-coder-sync24-probe-1794653328.md` | 与磁盘文件名一致 |
| dedupe_key | `2772153677039a9d` | 与日志 `#2772153677039a9d` 一致 |
| embedding_kind | `tei` | 真向量化，不是 hash 降级 |

---

## 四、B 侧：真实客户端进程按 bot_id 召回

脚本：`docs/review/issue24-sync/02-b-recall.ts`（每次跑都是新进程、新 tmp stateDir）

```
[B:before2] process pid=87396 stateDir=/var/folders/.../sync24-b-before2-bibsGb
[B:before2] 本机账本条目数 = 0  (本机源为空)
  [memory] hub 鉴权就绪 via file (https://jarvis.kentonnie.top/v1)
  [memory] hub reached (https://jarvis.kentonnie.top/v1)
[B:before2] probe /health = true | auth=ok | source=file
[memory] recall mode=hub chars=443 taken=["bot-coder-sync24-probe-1794653328","bot-coder-dsh-git-push-credential-helper","bot-coder-use-pnpm-test"]
[B:before2] recall chars=484 探针命中=true
队伍记得这些（不是这次的要求，只用来补上下文；与本次请求冲突时以本次请求为准）：
- 短寿命探针 1794653328：验证 author 记忆经既有管道上行到中枢 [coder]：这是一条**短寿命测试事实**，标记 1794653328，用于验证 dsh-bot-crew #24 的真实上行闭环。
```

判据成立的三点：

1. **本机源为空**：`local.all().length === 0`，召回不可能是本机账本兜的；
2. **`recall mode=hub`**：走的是 `HubMemory.recall` 的中枢分支（`compose` 用中枢返回的 entries）；
3. **探针命中**：注入片段第一行就是探针，`[coder]` 是 `injectText` 打的 bot 标。

另外，**生产进程本身**（`dsh --profile superagent`，pid 89699）的中枢召回路径是活的，
`/private/tmp/dsh-superagent-restore.log:98,137`（该文件是它的 stdout，最后写入 18:46，即探针之前）：

```
[memory] recall mode=hub chars=332 taken=["bot-coder-use-pnpm-test","bot-coder-dsh-git-push-credential-helper"]
```

**必须说清**：这份日志在探针存活的 2 分 43 秒里没有任何新行，所以「生产进程召回探针」**没有观测到**，
不能拿它当证据。B 侧证据用的是我自己起的第二个真实进程（§四），那个是本轮实测的。

### 4.1 归属正确（产品 `HubHttp` 按 bots 过滤）

`docs/review/issue24-sync/03-attribution.ts`：

```
bots=[coder]     entries=3 探针命中=1
   - bot=coder name=bot-coder-sync24-probe-1794653328 type=reference created=1794653369 updated=1794653369
   - bot=coder name=bot-coder-dsh-git-push-credential-helper ...
   - bot=coder name=bot-coder-use-pnpm-test ...
bots=[scribbler] entries=1 探针命中=0
bots=[lead]      entries=0 探针命中=0
```

服务端 `bot_id` 由文件名 `bot-<bot_id>-<slug>.md` 解析（`_stem_bot_id`），与客户端 `bots` 过滤一致；
`lead` 在中枢本来就是 0 条（release 也独立核过），所以用 lead 验会像失败，本轮用 coder。

---

## 五、其余三条硬要求

### 5.1 token 不泄漏

`docs/review/issue24-sync/05-token-leak.ts`（错凭据走真实中枢）：

```
isHubAuthError = true | status = 401
错误文本 = hub /memory/search rejected the credential (401): {"detail":"invalid hub token"}
错误文本含 token 值 = NO
错误文本含整条错 token = NO
```

- 全程只按**引用**读（`memory.tokenEnv=HUB_TOKEN` + `memory.tokenFile=/Users/cpuser/.config/hub-memory-mcp/env`），值不进设置、不进日志、不进错误文本。
- 落库脚本 `docs/review/issue24-sync/*.ts` 里只有引用名与路径，`grep` 全目录 **token 值出现 0 次**。
- B 侧每次跑都打印 `token 值是否出现在本次输出 = NO`。

### 5.2 真实 consolidate 持久化只在本机，服务端是 dry-run

`docs/review/issue24-sync/04-consolidate.ts`（真 Hub + 产品 `RuleDistiller` + 本机 episodic）：

```
本机账本(前) = 0
[memory] consolidate hub plan facts=0 merged=0 superseded=0 dryRun=true candidates=0（中枢只出计划，不写库）
[memory] consolidate mode=local facts=1 superseded=0
consolidate 返回 = {"facts":1,"merged":0,"superseded":0,"dryRun":true,"candidates":0,
                    "hubPlan":{"facts":0,"merged":0,"superseded":0,"dryRun":true,"candidates":0}}
本机账本(后) = 1 → bot-coder-person-记住-验收时先跑-pnpm-test-再动别的|bot=coder|state=active
```

- 服务端 `hubPlan.dryRun = true`、`merged=0`、`candidates=0` → **一条没写**（兼容面默认 `apply=false`，客户端也不传 `apply`）。
- 本机 `facts=1` → 账本真写了，`ConsolidateResult` 的计数只报这一层。
- 生产侧同一结论：`/private/tmp/dsh-superagent-restore.log` 里每次 `consolidate hub plan … dryRun=true` 紧跟 `consolidate mode=local facts=2`。

### 5.3 清理用正常软删，并验证 B 不再召回

1. 先给 author 文件加 `disabled: true` 再触发管道 —— 管道**跳过**了它（`grep sync24-probe` 的 `queued` 行数全程恒为 1，没有第二次）。
   用管道自己的迭代器做了最小复现（临时目录）：`disabled: true` 与 `status: superseded` 都被跳过，只产出 normal 那条。
2. 中枢按正常软删端点删（MCP `hub_memory_delete`，`confirm=true`，`hard` 未开）：

```
{"id":"5516d0bd-...","namespace":"dsh-memory/bot","deleted":true,"already_deleted":false,
 "mode":"soft","deleted_at":"2026-11-14T10:52:12.514978Z","deleted_by":"admin","facts_closed":0}
```

3. 删 author 文件，再触发一次管道确认**不回灌**：`pending/` = 0，`dead-letter/` = 0，日志无新 `queued`。
4. B 侧复跑（新进程、空账本）：

```
[B:after] 本机账本条目数 = 0
[B:after] probe /health = true | auth=ok | source=file
[memory] recall mode=hub chars=332 taken=["bot-coder-dsh-git-push-credential-helper","bot-coder-use-pnpm-test"]
[B:after] recall chars=373 探针命中=false
[B:final] recall chars=373 探针命中=false
```

5. MCP 检索确认不可见：`hub_memory_search(query="bot-coder-sync24-probe", metadata_filter={source_file:...})` → `count: 0`。
6. **用户记忆没动**：NAS 只读核对 `namespace='dsh-memory/bot'` → `live=3 / total=5`，
   软删的两条都是今天下午的探针（`bot-lead-issue24-crossdevice-probe.md`、`bot-coder-sync24-probe-1794653328.md`），
   `use-pnpm-test` / `tone-concise-no-padding` / `dsh-git-push-credential-helper` 三条 live 原样。

---

## 六、缺的 production seam（#24 不能按「产品账本自动上行」口径关）

**事实**（都是只读实测，不是推断）：

| 探测 | 结果 |
|---|---|
| `grep -rn "\.plan(" backend/src --include=*.ts` | **0** 处调用 |
| `planWrite(` 的全部出现 | 只有 `app/memory.ts:182` 的方法体与 `memory/adapter.ts:98` 的定义本身 |
| `memoryRoot()` 的使用 | 只在 `app/prompts.ts`（拼进 worker 提示词，让 worker 自己读写目录） |
| 生产账本 `memory:entry:*` | 28 条，`toHub=true` **0 条**，bot 分布 `lead:23 / coder:5` |
| `~/.dsh/memory/bot/` 实际目录 | 只有 `coder/`、`scribbler/`；**`lead/` 不存在** |

也就是说：

- **管道这一侧是通的**：`~/.dsh/memory/bot/<bot_id>/*.md` → `dsh-memory/bot` → 中枢，本轮已端到端实证。
- **产品这一侧没接上**：`Runtime` 的 `hear` / `close` / `consolidate` 全部写进 KV 账本，
  而 KV 账本 → author 目录的那一步（`MemoryLedger.plan()` 本来是为此写的）**没有调用点**。
  结果：lead 的 23 条账本记忆永远不会上行；今天中枢里能看到的 coder/scribbler 两条，是 worker 按提示词
  **自己写**的 md，不是账本写的。
- 顺带一个治理缺口：`/api/mobile/memory` 的 `action=forget` 只翻 KV 的 `state='forgotten'`，
  既不删 author md，也不打中枢。所以「忘掉一条」在真实链路上只作用于账本展示层。
  本轮清理因此必须做三件事（禁 `disabled` → 删文件 → 软删中枢行），这也反证了缺口存在。

**给 lead 的新 Max 实现清单（精确到文件与函数，不含实现细节拍板）**：

1. `backend/src/app/runtime.ts`：在 `memory.ledger.settle()` 成功（`written.length > 0`）后，
   按 `planWrite(memoryRoot(), entry.bot_id, entry)` 落盘；`root` 用 `prompts.ts` 的同一套 `DSH_HOME` 推导，
   不要另造一个根（否则管道监听目录与写入目录会分叉）。
2. 落盘只对 `toHub === true` 的条目（`memory.ts` 现在恒为 `false`，语义位要先定：谁置 true、按 `02-memory-bridge.md` 的分流规则）。
3. `forget` 与 `evict` 要同步处理 author md：`forget` → 写 `disabled: true`（管道会跳过且不上行）；
   `evict` 真删 KV 行时 → 删 md。否则「忘了的还在中枢被召回」。
4. `superseded` 要把旧 md 标 `status: superseded`（管道同样跳过），否则旧条会被反复搬运。
5. 这些都要有测试：`planWrite` 落盘 → `iter_dsh_auto_memory` 能读到 → `forget` 后读不到。

**还有一条要如实说明的边界**：产品**没有**「新建一条 author 记忆」的对外入口。
`/api/mobile/memory` 的 POST 只认 `action: forget | edit`（且 `name` 必须已以 `bot-` 开头），
desktop 的 `memory.dump/edit/save` 同样只改已有条目。所以本轮 A 侧用的是
「产品自己的 `MemoryLedger.settle()` + `adapter.planWrite()` 跑一次脚本」——
产物与 worker 按提示词写出来的 md 同格式同落点，但**不是**活的 worker 票写的。
要证明「worker 在票里自己写 → 上行」那段，需要一个真票让 worker 落文件；
今天生产日志里只有 `[memory] settle source=ticket … bot=coder`（写 KV 账本），
账本不落 md，所以那一段目前**没有**可复现的产品路径（正是上面第 1 条的缺口）。

在这条接线落地前，**生产上「产品账本里的记忆上行」是不成立的**；本轮证明的只是「author 文件上行」这一半。

---

## 七、与 release 的协调（base / 凭据引用 / 窗口 / 稳定 API）

`ds-release-backend-max` 回复要点（2026-11-14 18:44）：

- 生产 `settings.memory`：`hub=https://jarvis.kentonnie.top/v1`、`tokenEnv=HUB_TOKEN`、
  `tokenFile=/Users/cpuser/.config/hub-memory-mcp/env`、`timeoutMs=8000`。**我没改它任何设置**。
- **它踩到的真坑**：`timeoutMs` 原默认 1500ms，而线上 `/v1/health` 实测 0.88–1.86s → 探测超时被判不可达、
  静默降级本机。提到 8000ms 后才出现真实 `recall mode=hub`。本轮我全部显式给 ≥8s，不会拿到「探测通但检索全本机」的假象。
- 窗口：它不再重建/切镜像/重启 dsh/mobilegw，本轮 18:48–18:58 的写入与清理没有与任何发布动作重叠。
- 稳定 API 四条与客户端一致：`GET /v1/health`（免鉴权、含 `memory_compat`）、`POST /v1/memory/search`（`X-Hub-Token`）、
  `POST /v1/memory/consolidate`（不传 apply → `dryRun:true`）、软删端点未动。
  实测 `/v1/health` → `{"status":"ok","service":"home-agent-hub","version":"1.0.0","memory_compat":"registered"}`（公网与 LAN 18080 同）。
- `consolidate` 的 `facts` 恒 0 是**正确值**（兼容层不提炼），本轮读数与之一致。
- 它独立核过 §六 的 `plan()` 零调用点观察，确认成立且不在它的写范围内。

---

## 八、边界与未触碰项

- 未 `git add/commit/push/stash/checkout/restore/reset`（本报告与 `docs/review/issue24-sync/` 为新增未跟踪文件）。
- 未改 `backend/src/**`、`开发进度.md`、`HANDOFF.md`、`scripts/crew-watch`、生产 settings、NAS 主 worktree。
- 未重启 dsh / mobilegw，未操作手机输入，未抢桌面焦点。
- NAS 侧只跑 `SELECT`（经 hermes），未写库、未改容器。
- 未新建 Bot、未改 bot 名录；只用了既有 `coder`。
- 未手工 `POST /v1/memories`（上行唯一路径是 `local_dream` 的 outbox）。

## 九、复跑方式

```bash
cd backend
# 1) A 侧落 author 文件（会打印 path 与内容）
SYNC24_MARK=$(date +%s) SYNC24_BOT=coder node --experimental-transform-types ../docs/review/issue24-sync/01-author-write.ts
# 2) 让既有管道搬（这是管道自己的入口，不是 curl）
~/.home-agent-bridge/dream_notify.sh dsh-memory compact sync24-probe
# 3) B 侧真实客户端召回
SYNC24_PHASE=check SYNC24_BOT=coder SYNC24_MARK=<上面的 ts> \
  SYNC24_QUERY='sync24 短寿命探针 author 记忆上行' \
  node --experimental-transform-types ../docs/review/issue24-sync/02-b-recall.ts
# 4) 归属 / 巩固 / 泄漏
node --experimental-transform-types ../docs/review/issue24-sync/03-attribution.ts
node --experimental-transform-types ../docs/review/issue24-sync/04-consolidate.ts
node --experimental-transform-types ../docs/review/issue24-sync/05-token-leak.ts
```

清理顺序必须是：`disabled: true` → 触发管道确认不再搬 → 删 md → 中枢软删 → B 侧复跑确认不召回。
