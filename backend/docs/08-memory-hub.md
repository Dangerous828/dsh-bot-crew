# 08 · 记忆中枢（Hub）契约与双分叉

> 给中枢升级用：本仓（宿主机）已按「有中枢/没中枢」分叉，中枢侧按本契约实现即可接上。
> 宿主机侧实现见 `backend/src/memory/{port,local,hub,detect,hub-client,auth,distill}.ts`、`app/memory-layer.ts`。
>
> 生产中枢（2026-11-14 实测）：基址 `https://jarvis.kentonnie.top/v1`（LAN 备选
> `http://192.168.31.152:18080/v1`，注意是 18080）。**base 必须含 `/v1`**，因为探测打
> `base + '/health'`。`/v1/health` 免鉴权；`/v1/memory/*` 要 `X-Hub-Token`，无/错一律
> `401 {"detail":"invalid hub token"}`。

## 一、双分叉规则（宿主机侧已实现）

| 条件 | 记忆读（召回） | 记忆写（提炼/巩固） |
| --- | --- | --- |
| 配了 `memory.hub` 且 `/health` 可达、凭据未被拒 | 走向量检索（Hub `POST /memory/search`，带 `X-Hub-Token` 与本票 `bots`） | 向中枢要合并**计划**（`POST /memory/consolidate`，默认 dry-run）；**账本写入仍走本机**（`LocalMemory.consolidate`：拉 episodic → 提炼 → 落 KV） |
| 没配 Hub、探测不通、或凭据被 401 拒绝 | 本机二元组召回（`memory/local.ts`） | 本机 consolidator（规则提炼 + 便宜模型可选），收尾顺手末位淘汰 |

- 探测：`HubProbe` 每 30 秒（TTL）打一次 `GET <hub>/health`（**不带 token**，探针就该免鉴权），2xx 即可达；
  并发调用走单飞，不会各自 fire-and-forget；TTL 过期由记忆操作顺手触发一次重探，中枢掉线再回来能自愈。
- **探测超时按公网现实取值**：`memory.timeoutMs` 默认 **8000ms**，不是 1500ms。生产中枢
  `GET /v1/health` 走公网实测 **0.877s / 1.861s / 1.410s**；1500ms 会让一台 RTT 稍高的机器
  **永久**拿到「hub 配了、记忆全本机」，而超时本身不报错。8000ms 覆盖实测最慢值的 4 倍余量，
  上界仍是 10s（这个预算有天花板）。
- **配置保存即生效**：`memory` 块保存后宿主机 `retarget` 整套引用（hub 地址 / 超时 / 凭据引用）
  到同一个 `HubProbe` 上，探测、检索、鉴权、health 四个读数始终来自同一份配置。
  不需要重启，也不会出现「探测打新中枢、检索还打旧中枢」的状态分裂。旧探测迟到的结果
  按配置代数丢弃，不会覆盖新配置的健康面。
- **探测通 ≠ 中枢可用**：`/health` 免鉴权，401 只出现在真正调 `/memory/*` 时。鉴权状态是独立维度
  （`HubAuth`：`ok` / `anonymous` / `rejected`），被拒会落成 `/state.health.memory` 的 `error`
  并进 overview 的 problems —— 不再出现「日志说 reached、检索全降级」的假成功。
- **不可达 ≠ ready**：可达性是第三个维度（`up` / `down` / `unknown`）。探测失败或超时落成
  `error`「中枢不可达」，还没探过是 `starting`（刚启动不挂假故障），没配中枢是 `ready`「全在本机」。
  四种情况分开说，不再出现「探测超时降级本机、health 却写 ready」这种查不出来的假成功。
- 两版共用同一个本机账本（`MemoryLedger`，KV 落 SQLite），管理面看到的是同一批条目。

### 四层要分清（别把上一层当下一层）

| 层 | 调用 | 能证明什么 |
| --- | --- | --- |
| 1 探测 | `GET <base>/health`（免鉴权） | 网络通、地址对。**不**证明记忆能用 |
| 2 检索 | `POST <base>/memory/search` + `X-Hub-Token` | 记忆真的从中枢来（跨设备读取就在这里成立） |
| 3 合并计划 | `POST <base>/memory/consolidate`（默认 dry-run） | 只出计划：`merged` 是**计划数**，不是执行数 |
| 4 真实持久化 | 本机 `LocalMemory.consolidate` | 账本真的写了。`ConsolidateResult.facts/merged/superseded` 只报这一层 |

中枢那份读数放在 `ConsolidateResult.hubPlan` 里（含 `dryRun` / `candidates`），与真实写入分开报。

### 凭据：只存引用，不存值

`memory.tokenEnv`（环境变量名）与 `memory.tokenFile`（0600 文件绝对路径）是**引用**，不是 token 值。
两者都给时按 `KEY=VALUE` 从文件里取该键；只给文件时整份内容就是 token；环境优先。
值在每次请求时现读（`memory/auth.ts` 的 `readHubToken`），不进设置、不进 `/state`、不进日志与错误消息。
权限过宽（非 0600）仍会用，但会如实报「建议 chmod 600」。

`bots` 参数按中枢口径 `^[a-z0-9][a-z0-9_-]{0,63}$` 过滤后才发：宿主机自己的 `BOT_ID` 更宽
（允许 `_lead`、超长 id），原样发会整次 422、整轮召回降级。召回**必须**带本票 `bot_id` ——
中枢的租户隔离只到 crew 命名空间（`dsh-memory/bot`），不带 `bots` 就是全队记忆混用。

## 二、中枢要提供的两个接口（待中枢升级实现）

### 1. 检索 `POST <hub>/memory/search`

请求：`{ "query": string, "bots"?: string[], "limit"?: number }`
响应：`{ "entries": MemoryRecord[] }`（按相似度从高到低）

- `MemoryRecord` 字段同 `memory/adapter.ts`（`name/description/body/type/importance/dedupe_key/...`）。
- 宿主机拿到 `entries` 后复用本机 `compose()` 拼注入片段，不依赖中枢做拼装。

### 2. 巩固 `POST <hub>/memory/consolidate`

请求：`{ "since"?: number, "until"?: number }`（秒级时间窗；**客户端不传 `apply`**）
响应：`{ "facts": number, "merged": number, "superseded": number, "dryRun": boolean, "candidateMerges": number }`

- 生产兼容面默认 `apply=false` → `dryRun:true`、`merged:0`、`candidateMerges` 才是可合并对数。
- 宿主机把这份读数放进 `hubPlan` 并**照跑本机提炼**：中枢不写、本机也不写，等于两边都没写。
- 为什么客户端不传 `apply`：客户端超时只有 3s，而 `soft_delete_memory` 每对内部自己 commit；
  超时后服务端会继续删完剩下的对，客户端却按超时以为「没做」—— 半完成态比不写更难查。

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
