# #24 记忆撤回（forget/disabled）真实 Hub 撤回 HTTP 契约 — 冻结协议

- 日期：2026-11-14
- 执行者：wb-hub-retract（lead 委派，只监督；我方只核实契约 + 演进协议，不改本仓 `src/`）
- 协作方：wb-memory-sync（本仓 ledger/author 侧实现方）
- 结论：**既有 DELETE/soft-delete 已能按 canonical bot-memory 标识（`namespace` + `metadata.source_file`）精确、幂等撤回；不新增 `/v1/memory/retract`。** 撤回不靠 ledger 业务 dedupe，靠**远端真实 dedupe_key / source_file**；采用「source_file 反查全部历史版本 → 逐条 `DELETE /v1/memories/{id}`（软删、幂等）」实现零条无害。真实 NAS 上已用 canary 记忆端到端实证：精确、幂等、无复活、真实用户 memory 未动。

---

## 一、根因：为什么不能拿 ledger dedupe 当 remote digest（已实测坐实）

上行管道 `local_dream`（`hub/node_bridge/local_dream.py`）落库时算远端 stable key：

```
_digest(content) = sha256(content.encode("utf-8")).hexdigest()[:16]      # 16 hex
```

`content` = **上传的完整渲染正文**：
- native / dsh_direct（dsh_memory）路径：`# [dsh-auto-memory:<type>] <stem>[ — <desc>]\n\n<body>`
- auto-flush 路径：`# Auto-flush (<reason>): <ns>\n\n<points>`

而本仓 ledger 的 `fact.dedupe_key` 是**业务键**（如 `sync24-probe-<ts>`）。二者完全不同源。
⇒ 若拿 ledger dedupe 去删远端，**一条都删不到**。

另一层 `content_hash` = 服务端 `blake2b(normalize(content))`（空白折叠、区分大小写），同样基于同一 content、与 dedupe_key 同源；也不是 ledger 键。

**一条 md 文件改内容 → mtime 变 → 重扫 → 同 namespace 下按新 content 生成新 dedupe_key 的新行；旧行仍留（除非被删）。** 所以“一条逻辑记忆”在远端可能是**多行不同 dedupe_key**（历史版本）。单按 latest hash 删会漏旧版本 —— 由下方 §四③实测证明。

---

## 二、canonical 撤回标识（冻结）

|c| 采用 | 理由 |
|---|---|
| `namespace` | 必带。crew 命名空间：`dsh-memory/bot`（dsh_direct 源）+ `bot/<bot_id>`（若存在）。真实数据在 `dsh-memory/bot`（所有 bot 的 `bot/` 目录 tail 均归一为 `bot`）。 |
| `metadata.source_file` | **canonical 主键**。= md 文件名（含 `.md`），跨版本稳定；同一逻辑记忆的所有历史版本行共享同一 source_file、不同 dedupe_key。`metadata.origin_ref` 同值可互证。 |
| `metadata.dedupe_key`（16 hex） | 只作**行级**精确删除的备选；不作为“撤该条全部历史”的主键。 |

**否决**：把 ledger `dedupe_key` 当远端 digest；用 `/v1/memory/consolidate` 的相似度批删（`apply` 默认 false，且是模糊匹配，不是精确撤回）。

> 为什么是 source_file 而不是“每版本 remote hash”：本仓不持久记 remote content/hash（避免第三真源与 mtime 重扫打架，见 §五）。source_file 是唯一能“一次一网打尽同一条所有历史版本”的稳定标识。

---

## 三、既有接口（不新造 route；已线上、已实测）

| 能力 | 端点 | 鉴权 | 语义 |
|---|---|---|---|
| 精确反查某 source_file 全部行 | `POST /v1/memories/search` body `{namespace, query:"", limit:≤100, metadata_filter:{source_file:"<file>.md"}, include_deleted?:bool}` | `X-Hub-Token`（hub token） | `metadata_filter` 是 JSONB `contains`，`source_file` 精确匹配；**默认只回 live 行**，`include_deleted:true` 连软删一起回。响应每行含 `id`（UUID）。 |
| 软删单行（幂等） | `DELETE /v1/memories/{id}?hard=false&reason=<短因>` | hub token（软删走 `_request_actor`，不强制 admin；`hard=true` 才强制 admin） | 置 `deleted_at/deleted_by`，写 `memory_delete_audit`；已删再删 `already_deleted:true`、不报错、`facts_closed:0`；可 `POST /v1/memories/{id}/restore` 撤销（需 admin）。 |
| 按 (namespace, dedupe_key) 删 | `DELETE /v1/memories` body `{namespace, dedupe_key, hard?, reason?}` | hub token | 精确删该 dedupe_key 行；无匹配 **404**（不是零条）。 |

**鉴权边界（实测）**：`DELETE /v1/memories/{id}` 挂在 `/v1` 的 `require_token` 上，软删不需 admin；但 **DELETE 不在 `_is_node_report` 白名单**（白名单仅 `POST /v1/nodes/heartbeat`、`POST /v1/memories`、`POST /v1/skills/activation`、`/v1/traces/`），所以 **node token 不能删，必须用 admin 的 `api_token`**。兼容层不放宽任何白名单。

**兼容层 `/v1/memory/search` 的两个坑（实测）**：
1. entries **含 `id`（字段名 `hub_id`）和 `dedupe_key`** —— 可用。
2. **但它不透传 `metadata_filter`**（`compat_search_impl` 只构造 `MemorySearch(namespace,query,limit)`），且默认 `include_deleted=false`。
   ⇒ **撤回反查必须走原始 `/v1/memories/search`**（支持 `metadata_filter` + `include_deleted`），不要用兼容层 `/v1/memory/search` 做反查。

---

## 四、冻结协议：按 source_file 撤回全部历史版本

### 4.1 算法（客户端 `HubRetraction.bySourceFile` 实现口径）

```
input: { namespace, sourceFile }        # sourceFile = "<stem>.md"
1. res = POST /v1/memories/search
     {namespace, query:"", limit:100, metadata_filter:{source_file: sourceFile}}
   # 仅 live 行；已软删的历史版本无需再动（已是撤回态）
2. ids = [row.id for row in res]        # 0..N
3. for id in ids: DELETE /v1/memories/{id}?hard=false&reason="retract:<stem>"
     # 404 → 视为已消失，ok（并发/已硬删）；5xx/超时 → 抛出，上层持久重试
4. return { ok:true, deleted:成功删除数, ids:已删id, alreadyDeleted: alreadys,
            total: 该 source_file 曾出现的历史版本数(可用 include_deleted 另查仅作报告) }
   # ids 为空 → ok:true, deleted:0（**零条=成功**，不引入 404）
```

### 4.2 Typed shape（建议冻结，字段以服务端零改动为准）

```ts
interface RetractBySourceFileInput {
  namespace: string          // 例 'dsh-memory/bot'
  sourceFile: string         // 例 'bot-coder-use-pnpm-test.md'（含 .md，=远端 metadata.source_file）
}
interface RetractBySourceFileResult {
  ok: boolean                // 所有 live 行均处理完（含 0 行）
  deleted: number            // 本次真正软删的行数
  ids: string[]              // 本次删除命中的行 UUID
  alreadyDeleted: number     // 反查时即已是 deleted 的（若查了 include_deleted）
  totalVersions?: number     // 含历史（include_deleted）版本总数，仅报告用
}
```

### 4.3 各 mutation → 远端效果（与 wb-memory-sync 对齐）

| 本机动作 | 远端效果（协议） |
|---|---|
| `forget` | 本机 md 打 `disabled:true`；远端 `bySourceFile(ns, sf)` 软删**该 source_file 全部 live 版本**。 |
| `evict` | 同 forget；本机真删 md。 |
| `supersede`（A 被 B 替代） | 软删**被替代旧版本**（旧 source_file 全部 live 行），保留新版本。 |
| `edit`（内容变） | 本机 md 重写（新 content→下次上行新行）；**旧版本 live 行先 `bySourceFile` 软删**，避免旧内容仍被召回；新版本保留。 |
| `toHub: true→false` | 若曾上行，`bySourceFile` 软删全部 live 行；本机删 md。 |
| `settle` 新增 active+toHub=true | 不删远端，等管道自然上行。 |

> 注意 `supersede` 若新旧版本**同 source_file**（同名文件编辑），`bySourceFile` 会把新版本也删掉 —— 此时应改用**按旧 dedupe_key 精确删**（`DELETE /v1/memories` body `{namespace, dedupe_key}`，无匹配 404 视为已无害）或先反查后按 `id` 只删旧行。冻结约定：**同名编辑（edit）= 走 4.4 的“新行保留、旧行按 id 删”**；**换名/整条弃用（forget/supersede/evict/toHub-false）= 走 bySourceFile 全删**。

### 4.4 edit 场景精确算法（同名 source_file，保留新版本）

```
1. 本机把 md 重写为 v2 → 等管道上行产生 v2 新行（dedupe_key_v2）
2. retract 旧版本：POST /v1/memories/search {namespace, query:"", limit:100,
     include_deleted:false, metadata_filter:{source_file: sf}}
   → live 行里 dedupe_key != dedupe_key_v2 的（即旧内容行）逐条 DELETE /{id}
   （如果没有 v2 的“已知 dedupe_key”，退化为“保留 created 最新的一条，其余 live 删”）
```

---

## 五、为什么不持久记 remote hash（决策依据）

- author md 是**唯一真源**；管道每次按 content 复算 dedupe_key。
- 客户端再存一份 remote-digest/remote-content = **第三真源**，与 mtime 重扫逻辑打架（md 改了但存的 digest 没跟上 → 撤错行或漏撤）。
- 因此**撤回一律走 source_file 反查全版本**，不依赖跨会话的 remote hash 账。

---

## 六、复活（revival）防护 — 为什么 disabled/forget 后旧待发上行不会复活远端

### 6.1 源端：`disabled:true` 不再上行

`local_dream._iter_dsh_auto_memories`（`hub/node_bridge/local_dream.py:2206`）读到 md 时：
```
if meta.get("disabled") in {"true","1","yes"}: continue      # 跳过，不上行
if meta.get("status") in {"superseded","disputed"}: continue # 跳过
```
且该 md mtime 若未变、`mtime <= cutoff` 也跳过。⇒ 打 `disabled:true` 后，**该文件不再产生新 payload**。

### 6.2 端：即便同一 content 再次上行，也不会复活软删行（实测）

- `uq_memories_namespace_dedupe_key` = `UNIQUE (namespace, (metadata->>'dedupe_key')) WHERE metadata->>'dedupe_key' IS NOT NULL`
  —— **partial 条件只看 dedupe_key 非空，不看 deleted_at**。⇒ **软删行仍占 dedupe_key 槽位**。
- 重投同 content（同 dedupe_key）→ `ON CONFLICT DO NOTHING` → 读回既有**软删**行 → `_dedup_hit_response` 回 `{deduplicated:true, deleted:true}`，**不新建 live 行**。
- 应用层 exact-content 分支（`create_memory_impl` 近 50 条含软删）同样拦截并回 `deleted:true`（R3：防悄悄复活）。

### 6.3 边界（必须知道）

- 复活防护**依赖 dedupe_key 稳定**（= content 稳定）。若源端把 **disabled 的 md 改了内容**（mtime 变、content 变→新 dedupe_key），会生成**新 live 行** —— 但正常 forget 流程是先打 disabled、**内容不再变**，故不触发。**约定：forget/evict 后不得再编辑该 md 内容。**
- 若源端**删掉** `dsh-memory/bot/<bot>/x.md` 文件：管道不再看到它（不会“补删”远端），需客户端显式 `bySourceFile` 软删远端（forget/evict 已含此步）。
- 本项目**没有独立的“待发上行队列复活”路径**：`MemoryOutbox` 只发不重放已 2xx 的 payload；软删后同 content 重发被 dedupe 吸收（§6.2）。

---

## 七、实测证据（真实 NAS hub，canary crew 记忆，非用户事实）

全部只读/软删、可 restore；真实用户 memory（`7d4d88a6 / 316fa67e / 284e0f62`）全程 live 未动。

### 7.1 精确反查 + 幂等软删
```
POST /v1/memories/search {namespace:"dsh-memory/bot", metadata_filter:{source_file:"bot-coder-retractcanary-<ts>.md"}}
  → matched ids: ['30beface-...']                         # 精确 1 行
DELETE /v1/memories/30beface-...?hard=false → {deleted:true, already_deleted:false, mode:"soft"}
DELETE 再删一次               → {deleted:true, already_deleted:true, facts_closed:0}   # 幂等，不报错
```

### 7.2 无复活
```
重投同 content (同 dedupe_key=5600505b097158e8)
  → {deduplicated:true, dedup_layer:"content_exact", deleted:true, deleted_at:"...12:56:37Z"}  # 回软删行
include_deleted 反查: rows=1, 全部 deleted=True            # 未新建 live 行
live-only 反查:        rows=0                              # 不再被召回
```

### 7.3 多版本（edit/内容变）+ source_file 全撤
```
上行 v1(dk=5600505b…) → 上行编辑版 v2(dk=d4e8f8d7…, 新行)
include_deleted 反查 source_file: rows=2  {v2 live, v1 deleted}    # 两版本不同 dedupe_key
（证明：只删 latest hash 会漏掉 v1 类旧版本）
bySourceFile: live 反查=[v2] → DELETE v2 → live-only 反查 rows=0   # 该源全部撤回
```

### 7.4 真实用户 memory 不受影响
```
POST /v1/memories/search {query:"pnpm test"} → live rows: 3 [7d4d88a6,316fa67e,284e0f62]   # 原样
```

canary 两行最终 `all deleted:true`（软删、有 audit、可 restore），标记含 `retractcanary-<ts>`，与真实事实可区分。

---

## 八、给 wb-memory-sync 的四点确认（全部实测）

1. **`/v1/memory/search`（兼容层）entries 是否回 `id`/`dedupe_key`**：**回**。`entry_from_memory` 返回 `hub_id`（=行 UUID）与 `dedupe_key`。但见第 2 点：**反查不要用它**。
2. **`metadata_filter` 是否透传**：兼容层 `/v1/memory/search` **不透传**（`compat_search_impl` 只构造 `MemorySearch(namespace,query,limit)`，实测给了 filter 仍回 2 条无关条目）。⇒ **撤回反查用原始 `POST /v1/memories/search`**（实测 `metadata_filter:{source_file}` 精确命中）。
3. **软删鉴权**：`DELETE /v1/memories/{id}` 软删**只需 hub token**（`_request_actor`，非 admin）；`hard=true` 才要 admin。但 **DELETE 不在 node 白名单** ⇒ node token 删不了，用 admin `api_token`。客户端应带与 search/consolidate 同一 `X-Hub-Token`（若该 token = admin api_token 则足够；若是 node token 则删不了，需换 admin）。
4. **重试语义**：`DELETE /{id}` 404 → 视为已消失 = ok；网络/5xx 抛出供上层持久重试；同 id 重试 `already_deleted:true` 幂等无害。`bySourceFile` 零 match → `ok:true, deleted:0`（成功零条，不改既有 404 语义）。

---

## 十、未入库的 pending 旧版本（lead 点出的硬边界）——真实机制与最小待办

### 10.1 问题（准确表述）

`MemoryOutbox` 的 pending 队列（`~/.home-agent-hub/memory/pending/<ns>-<dedupe_key>.json`，`local_dream.py:185`）是**管道私有**。
若一条旧版本**只在 pending、尚未上行入库**（无对应 row），仅靠“删已有 row”挡不住它——它稍后 flush 时是**首次创建**，当时没有任何 row 可删。
`soft-deleted row DO NOTHING` 只证明“**已知 dedupe_key** 不复活”，不覆盖“pending 里尚未创建过的旧版本”。

### 10.2 真实机制：客户端写 canonical tombstone（软删占位），无需服务端改动

管道 flush 时按 content 算 `dedupe_key=_digest(content)` 且 `ON CONFLICT DO NOTHING`；唯一索引 `(namespace, dedupe_key)` 是 **partial on dedupe_key 非空、不排除 deleted_at**。⇒ **先写一条软删占位（tombstone）占用该 dedupe_key 槽位，后到的 pending 首次创建就被吸收成 `deleted:true`，不新建 live 行。**

**实测（tombcanary）**：
```
A) create 同 content → id=c1f7bf6f… ；立即 DELETE /{id}?hard=false → deleted:true        # 写 tombstone
B) 模拟 pending flush（同 content 首次创建）→ {deduplicated:true, dedup_layer:"content_exact", deleted:true}
C) live 反查 source_file → 0 rows                                                          # 未复活
```

**客户端操作口径（forget 流程）**：md 内容在手的场景（forget/evict 都要读该 md），客户端本地复算 `sha256(utf8(renderContent)).hexdigest()[:16]`，若远端尚无该 dedupe_key 行，则 `POST /v1/memories`（与管道同 shape 的 content）后立即 `DELETE /{id}?hard=false` —— 即写 tombstone。此后无论 pending 何时 flush、重扫何时重跑，都被吸收。

> ⚠️ tombstone 的 content 必须与管道上传的 content **逐字一致**（含 `# [dsh-auto-memory:<type>] <stem>[ — <desc>]\n\n<body>` 标头格式），否则 dedupe_key 不同源，tombstone 占不到槽位。**这条对齐责任在客户端**（渲染模板须与 `_iter_dsh_auto_memories` 的 header 拼法一致）。

### 10.3 最小待办（无法用 tombstone 覆盖的部分，不声称全竞态保证）

| 场景 | 是否可被 tombstone 挡住 | 处理 |
|---|---|---|
| pending 旧版本，md 内容客户端仍可读（正常 forget/evict） | ✅ 是 | 客户端写 tombstone（10.2）。 |
| pending 旧版本，md 已被删/内容已不可读 | ❌ 否（算不出 dedupe_key） | **最小待办**：需要 pipeline 侧提供一个“按 source_file 精确清 pending”的能力（见下）。 |
| pending 里已是**坏消息**（422/409） | 不相关 | 管道已 dead-letter 隔离（`local_dream.py:266`），不阻塞。 |

**最小待办方案（若需要，属 pipeline/部署侧，不在本仓 src）**：给 `MemoryOutbox` 增一个“按 `metadata.source_file` 精确删除 pending 文件”的维护入口（pending 文件名不含 source_file，只能是**读每个 pending json 的 payload.metadata.source_file 匹配**再 unlink）。或在客户端 accept 的范围内，由 wb-memory-sync 侧在 forget 时**同步**保证“先写 tombstone 再打 disabled”，使 pending flush 必被吸收。

**结论（不夸大）**：**“已知 dedupe_key 不复活”已由唯一索引 + 应用层 exact 双向保证（实测）**；**“pending 里内容可读的旧版本不复活”可由客户端 tombstone 保证（实测）**；**“pending 里内容不可读的旧版本”当前无自动保证**，需上述最小待办，不声称全竞态覆盖。

### 10.4 search 分页/limit 与 edit 保留新 digest（冻结）

- `POST /v1/memories/search` 的 `limit` **硬上限 100**（`MemorySearch.limit: le=100`）。同一 source_file 的历史 live 版本数 **家用尺度 ≤ 几条**，一次 100 足够；若某源历史版本 >100（异常），**必须分页**：`metadata_filter` 无法排序游标，改为 `include_deleted:false` 后按返回逐条删，删完再查一次，直到 `rows==0`（收敛式分页，简单且不依赖游标）。
- **edit 保留新 digest**：同名文件编辑后，新版本行 `dedupe_key_new=_digest(content_v2)`。retract 旧版本用 live 反查后，**保留 `dedupe_key==dedupe_key_new` 的那条**，删其余 live 行（§4.4）。若客户端在 edit 完成、v2 已上行后再撤回，`dedupe_key_new` 从 live 反查即得，无需预算。

---

## 九、改动与范围

- **本仓 `src/` 零改动**（`backend/src/memory/*` 由 wb-memory-sync 按其 typed 契约实现）。
- 服务端 **零新增 route / 零 schema 变更**：复用既有 `DELETE /v1/memories/{id}` + `POST /v1/memories/search`。
- 若未来需“服务端一条请求按 source_file 全删”，可在 `memory_compat_routes.py` 增 `POST /v1/memory/retract {namespace, source_file}` 内部复用上述算法；当前**判定无必要**（客户端两条请求即可，且不放开任何白名单/不 batch 模糊删）。
- 本文件 = `docs/review/2026-11-14-issue24-retract-contract.md`（dsh 独立评审稿）。

**未触碰**：真实用户 memory、`backend/src/**`、`开发进度.md`/`HANDOFF.md`/`crew-watch`、NAS 主 worktree、`_is_node_report` 白名单、git add/commit/push。

---

## 十一、新增最小接口：`POST /v1/memory/retract-tombstone`（已实现、已部署、已线上验证）

### 11.1 为什么必须新增（既有代价不可接受）

既有 `POST /v1/memories` 无法原子创建「已删除占位」：`create_memory_impl` 把 `deleted_at=None` 写死（`main_memory_routes.py:600`），`MemoryCreate` 无该字段；唯一可行的“占位”是「先 POST 成短暂 live 再 DELETE」，会留一段 live 窗口，且需正文、正文不可读时算不出 dedupe_key。lead 明确否决该路。故新增最小端点，**单事务、不传正文、无 live 窗口**。

### 11.2 契约（冻结，wb-memory-sync 按此实现 `tombstoneByDigests`）

- 方法/路径：`POST /v1/memory/retract-tombstone`（挂 `/v1` router，继承 `require_token`；**显式要求 actor==admin**，否则 403）
- 请求体：
  ```jsonc
  { "namespace": "dsh-memory/bot",              // crew 限定：只接受 dsh-memory/bot 或 bot/<id>，其它 422
    "source_file": "bot-<id>-<slug>.md",        // canonical 源文件名（含 .md）
    "known_digests": ["<16hex>", ...],          // = 远端 metadata.dedupe_key = sha256(utf8(content))[:16]；去重、≤64
    "reason": "forget" }                        // 可选 ≤500
  ```
- 语义（逐 digest，单事务）：
  - 无该 (namespace,dedupe_key) 行 → INSERT 一条 `deleted_at=now, deleted_by=actor, embedding=NULL, content=<中性 tombstone 标记，无用户正文>, metadata.tombstone=true` → 占 dedupe 槽。响应 `placed:[digest]`。
  - 已存在且**已删** → 幂等，`already_retracted:[digest]`。
  - 已存在且 **live** 且 canonical（source_file）匹配 → 本事务内软删（写 audit），`soft_deleted:[digest]`，保证最终 deleted。
  - 已存在但 **source_file 不一致** → `conflicts`，**整请求 409**，不改既有行、不新占、不波及其它来源。
  - **未知 hash（算不出的旧版本）不会被塞进 `placed`**，接口不假称挡住。
- 响应：`{ok, mode:"tombstone", namespace, source_file, placed[], already_retracted[], soft_deleted[], conflicts[]}`
- 错误码：无 token 401；非 admin 403；非 crew namespace 422；digest 非法 hex 422；canonical 冲突 409。
- 复用既有 `MemoryDeleteAudit` 审计（无新表、无版本系统）。`apply` 默认仍关闭（无关此端点，此端点主动调用才写）。

### 11.3 客户端（wb-memory-sync）职责

1. 每次 publish 落 author md 前，持久记该 canonical 的 digest 历史（`memory:digests:<name> → string[]`，只 16hex、不存正文）。
2. forget/evict/supersede(换名)/toHub-false：用历史全部 known_digests 调 `retract-tombstone` 占位（挡 pending/未来重扫），再 bySourceFile live 反查 `DELETE /{id}` 清现存 live，本机 md disabled/删。
3. edit 同名：新版本 digest 保留（不进 known_digests），只把旧版本 digest 占位。
4. **veriform：tombstone 占用的是 `sha256(utf8(pipelineContent))[:16]`，必须与管道 `_iter_dsh_auto_memories` 渲染的 content 逐字一致**（含 `# [dsh-auto-memory:<type>] <stem>[ — <desc>]\n\n<body>` 标头），否则不同源占不到槽。实测 `pipelineContent(bot-coder-use-pnpm-test.md)` → dk=`623bd5fb6702928a` == 远端该行 dedupe_key。

### 11.4 实现与部署（已完成，仅 hub-api）

- 新文件 `hub/hub_service/memory_retract_routes.py`（227 行）；`main.py` 加 `MEMORY_RETRACT_STATUS` + `register_retract_routes(router, session_type=Session)` 注册段（try/except 不阻断启动）。
- 测试：`tests/test_memory_retract_routes.py` **10 passed**（placed/already/soft-deleted/conflict/422/403/未知hash不假称/无正文/embedding=None/deleted_at非空）；既有 `test_memory_compat_routes.py` **82 passed** 无回归；真实 app dispatch 200 通过。
- 部署：从线上 `issue24fix2-20261114-1845` 最小 overlay（`Dockerfile.overlay-issue24retract`，只 COPY 两文件）→ `home-agent-hub:issue24retract-20261114-210748`（ID `8adfa2fd70d8`）；双 env-file `up -d hub-api`；embed(cpu-1.4)/postgres/caddy 全程未动、未重建。
- 回滚：`cp .env.bak-retract-<ts> .env` 改回 `issue24fix2` + `up -d hub-api`；文件备份 `main.py.bak-retract-<ts>`。

### 11.5 线上 canary 实证（真实生产，canary crew 记忆，用户 memory 未动）

```
health           → {'status':'ok',...,'memory_compat':'registered'}（容器内 RETRACT registered, has_route True）
retract-tombstone(valid, DK=c1ed3feba2ca07bd)
                 → {placed:['c1ed3feba2ca07bd'], already_retracted:[], soft_deleted:[], conflicts:[], ok:true}
create-after-tombstone(同 content 首次创建，模拟 pending)
                 → {deduplicated:true, dedup_layer:'idempotency', deleted:true}   # 被占位吸收，无 live 行
live-only 反查     → live rows: 0                                                  # 未复活
repeat tombstone   → {placed:[], already_retracted:['c1ed3feba2ca07bd'], ok:true}  # 幂等
冲突(source_file 不同) → http=409 {"detail":"canonical source_file mismatch ..."}   # 不波及其它来源
真实用户 memory    → live user rows: ['7d4d88a6','316fa67e','284e0f62']            # 原样
canary 收尾        → 1 行 tombstone、deleted、live=0
```

**结论**：`POST /v1/memory/retract-tombstone` 已在生产，原子占位（无 live 窗口、无正文）、幂等、canonical 冲突 409、未知 hash 不假称、pending 首次创建被吸收不复活、不波及用户 memory —— 全部线上实测。服务端零 schema/表变更；本仓 `src/` 未改。

### 11.6 health 字段补齐（`memory_retract`）— 已上线

裁定：把 `memory_retract` 注册状态加进 `/v1/health`（与 `memory_compat` 同口径 `registered`/`unavailable:<异常>`/`unknown`），避免「探测绿但功能未注册」的同根误报；注册失败不假称 ready。`/healthz` 通用探针形状不变。

- 实现：`health_payload(memory_compat=None, memory_retract=None)` 各缺省取模块级 `MEMORY_COMPAT_STATUS` / `MEMORY_RETRACT_STATUS`；`/v1/health` 回两字段。**未新增表/版本系统**。
- 测试：`tests/test_memory_retract_routes.py` 增至 **12 passed**（新增 2 例：两字段都在且值域合法；显式 override 原样回且 `status` 仍 ok）。
- 部署：从 `issue24retract-20261114-210748` 再叠一层 health overlay（只 COPY main.py）→ `home-agent-hub:issue24health-20261114-211515`（ID `e06e9fe2a048`）；双 env-file `up -d hub-api`；embed/postgres/caddy 未动。
- 线上实测：
  ```
  GET /v1/health → {"status":"ok","service":"home-agent-hub","version":"1.0.0",
                    "memory_compat":"registered","memory_retract":"registered"}
  /healthz → 200（形状不变）
  retract-tombstone(新镜像 canary) → {placed:['50e5af389baadcd1'], ok:true}
  无 token → 401；真实用户 memory 仍 live
  ```
- 源码 hash 一致：repo-patch `04-memory_retract_routes.py` md5 `23ff6be9…` == 部署树；`main.py` md5 `0809196c…` == 部署树。

### 11.7 最终线上镜像与回滚

- 当前线上：`home-agent-hub:issue24health-20261114-211515`（含 compat + retract + health 三合一）。
- 回滚：`.env.bak-retract-<ts>` / `.env.bak-healthfield-<ts>` 依次回退到 `issue24fix2-…-1845`（无 retract）/ `issue24retract-…-210748`（有 retract 无 health 字段），各 `up -d hub-api`。文件备份 `main.py.bak-*`、`memory_retract_routes.py.bak-*` 均在部署树。
