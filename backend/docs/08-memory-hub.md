# 08 · 记忆中枢（Hub）契约与双分叉

> 给中枢升级用：本仓（宿主机）已按「有中枢/没中枢」分叉，中枢侧按本契约实现即可接上。
> 宿主机侧实现见 `backend/src/memory/{port,local,hub,detect,distill}.ts`、`app/memory-layer.ts`。

## 一、双分叉规则（宿主机侧已实现）

| 条件 | 记忆读（召回） | 记忆写（提炼/巩固） |
| --- | --- | --- |
| 配了 `memory.hub` 且 `/health` 可达 | 走向量检索（Hub `POST /memory/search`） | 交 Hub consolidator（`POST /memory/consolidate`）；本机账本仍同步落一份 |
| 没配 Hub，或探测不通 | 本机二元组召回（`memory/local.ts`） | 本机 consolidator（规则提炼 + 便宜模型可选），收尾顺手末位淘汰 |

- 探测：`HubProbe` 每 30 秒（TTL）打一次 `GET <hub>/health`，2xx 即可达；失败降级本机，不阻塞 worker 开工。
- 两版共用同一个本机账本（`MemoryLedger`，KV 落 SQLite），管理面看到的是同一批条目。

## 二、中枢要提供的两个接口（待中枢升级实现）

### 1. 检索 `POST <hub>/memory/search`

请求：`{ "query": string, "bots"?: string[], "limit"?: number }`
响应：`{ "entries": MemoryRecord[] }`（按相似度从高到低）

- `MemoryRecord` 字段同 `memory/adapter.ts`（`name/description/body/type/importance/dedupe_key/...`）。
- 宿主机拿到 `entries` 后复用本机 `compose()` 拼注入片段，不依赖中枢做拼装。

### 2. 巩固 `POST <hub>/memory/consolidate`

请求：`{ "since"?: number, "until"?: number }`（秒级时间窗）
响应：`{ "facts": number, "merged": number, "superseded": number }`

- 中枢在窗口内做：拉原始 episodic → LLM 提炼成 semantic（带主题标签）→ 向量化入库 → 去重/合并/冲突消解。
- 返回计数供宿主机记日志。

## 三、上行：原始对话不上中枢，只上行筛选过的

- **原始 Trigger/工单日志留在宿主机 SQLite**，不上中枢。
- 本机 `local_dream` 先按 `02-memory-bridge.md` 的分流规则过滤一层：人格/碎碎念留本地，
  owner 偏好 / 明确决策 / 已关单结论才按插件 frontmatter 落 md，由 `local_dream` 直通源上行。
- 中枢的 consolidator 吃的是**这些筛选后的 md**，不是全量聊天；向量库里也只有筛选过的事实。
- 没有「第三真源」：宿主机账本、Hub 向量库各司其职，靠本契约对齐。

## 四、治理（宿主机侧已实现）

- **时序**：每条记忆带 `created/updated`；冲突时旧条标 `superseded` 不删，形成时间轴（能回查「它曾经这么以为」）。
- **遗忘区 + 末位淘汰**：`forget` 进遗忘区（`forgotten` + `forgottenAt`），超 30 天且期间没被召回（`lastUsedAt` 不晚于 `forgottenAt`）才真删行 —— 兼顾 issue #5 的隐私诉求与近期审计。
- **使用强化/衰减**：召回命中记 `lastUsedAt`，打分里常被命中的加权、久未命中的随 freshness 降权。

## 五、跨设备同步

向量库在中枢：设备 A 记住的事实（经筛选上行、中枢向量化）后，设备 B 在 `memory.hub` 指向同一中枢且 `/health` 可达时，召回归中枢检索即可拿到 A 的事实。本机账本仍在各自本地；要「本机也有一份可离线看」，靠 `local_dream` 的下行镜像（不在本仓范围）。

## 六、状态

- 宿主机侧：双分叉、探测降级、本机巩固（规则提炼+可选 LLM）、末位淘汰、使用强化 —— 已实现并有测试（`crew-memory-port/distill/ledger.spec`）。
- 中枢侧（`/memory/search`、`/memory/consolidate`）：**待中枢升级实现**；宿主机在中枢不可用/未提供时全走本机，功能不残废。
