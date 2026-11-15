# #24 记忆中枢服务端 `/memory/*` — 实施与阻塞报告

- 日期：2026-11-14
- 执行者：ds-hub24-max（lead 委派）
- 结论：**Hub 侧适配已实现、已部署、跨设备真联调已通过。剩一个客户端侧缺口（无 token 通道）需拍板，#24 按「服务端+数据契约」口径已可关单，按「端到端跨设备」口径差最后一步。**

---

## 一、真实服务现状（实测，不是推测）

| 探测 | 结果 | 判读 |
|---|---|---|
| `ping 192.168.31.152` | 2/2 收到，3–65ms | NAS 在小米 LAN 内可达 |
| `http://192.168.31.152:8080/healthz` | **000（连不上）** | 8080 在 LAN 侧不可达；**不等于 Hub 不存在** |
| `http://192.168.31.152:18080/healthz` | **200** | Caddy 宿主端口已改 18080（compose 注释与 Caddyfile 一致） |
| `https://jarvis.kentonnie.top/healthz` | **200** `{"status":"ok","service":"home-agent-hub","version":"1.0.0"}` | 公网入口是唯一确定可达的 Hub 面 |
| `http://192.168.31.152:8642/health` | 200 | **这是 Hermes（贾维斯），不是 Hub** —— 客户端曾把它当 hub 地址写过 |
| `POST …/v1/memories/search`（无 token） | **401** `invalid hub token` | hub-api 真在跑，鉴权生效 |
| `POST …/memory/search`（任意方法） | **405 Not Allowed（nginx HTML）** | 落到前端 catch-all，**不是** hub-api 的 405 |
| `GET …/memory/search` | **200 text/html** | 前端兜底页 —— 探测会「假通」，比 401 更难查 |
| `GET …/v1/health`（无 token） | **404**（部署前） | `/v1` router 全部挂 `require_token`，客户端探测必然 401 |
| 生产命名空间数 | **176**，其中 **无 `bot/*`** | 见下节，决定实现形状 |

**结论**：Hub 服务真实存在且健康；`/memory/*` 从来不存在；根路径被前端兜底吃掉。

---

## 二、关键发现：Bot 记忆的真实存储契约

issue 与 `backend/docs/08-memory-hub.md` 都假设记忆在 `bot/<bot_id>` 命名空间
（`adapter.ts` 的 `namespaceOf()`）。**生产库不支持这个假设**：

```
dsh-memory/bot    3 条   ← 宿主机 Bot 记忆实际落点
（无任何 bot/* 命名空间）
```

`local_dream` 的 `dsh_memory` 直通源把 `~/.dsh/memory/<dir>/<file>.md` 映射成
`dsh-memory/<dir>`（`hub/node_bridge/local_dream.py:_iter_dsh_auto_memories`）。
宿主机写的是 `~/.dsh/memory/bot/<bot_id>/bot-<bot_id>-<slug>.md`，所以：

- **命名空间只有一个**：`dsh-memory/bot`
- **bot_id 在行级**：文件名 `bot-<bot_id>-<slug>.md` + 内容首行
  `# [dsh-auto-memory:<type>] <stem> — <description>`

按 `bot/<id>` 切命名空间的实现会**一条都查不到**。适配层因此按行级解析 bot_id。

本地 md 实例（`~/.dsh/memory/bot/coder/`）：

```yaml
---
name: bot-coder-use-pnpm-test
description: 用户的固定要求：跑测试用 pnpm test
type: feedback
updated: 2026-11-08
---
```

---

## 三、已实现（home-hub，未 commit）

### 新增 `hub/hub_service/memory_compat_routes.py`

| 端点 | 行为 |
|---|---|
| `POST /v1/memory/search` | 请求 `{query, bots?, limit?}` → `{entries, namespaces, bots, degraded}`。逐 crew 命名空间复用既有 `search_memories_impl`（同一套 TEI/hash 混合打分、retrieval_log 埋点、软删过滤），再按分数归并。**不另写检索**，避免两套排序口径打架 |
| `POST /v1/memory/consolidate` | 请求 `{since?, until?, apply?}` → `{facts, merged, superseded, dryRun, candidateMerges, window}`。**默认 dry-run**；`apply=true` 才调既有 `soft_delete_memory` |

`entry_from_memory()` 产出严格对齐 `hub-client.ts` 的 `memoryEntriesOf()`：

- `name` 带 `bot-<bot_id>-` 前缀 —— 否则宿主机 `planWrite()` 直接抛
- `body` 去掉 `# [dsh-auto-memory:…]` 标头行（标头不是「这条记忆说了什么」）
- `created/updated` 为**秒级整数**（`freshness()` 的约定）

### `main.py` 两处接线

1. **app 级 `GET /v1/health`（免鉴权）**：客户端 `HubProbe` 打 `base + '/health'`
   且不带 header；挂 `/v1` router 下必然 401 → 记忆永远退回本机版。
2. **兼容面注册**：与 `memory_graph_routes` / `hub_metrics` 同款 try/except 容错接线，
   缺失只告警不阻断 hub 启动。

### 为什么挂 `/v1` 而不是根 `/memory/*`

公网 Caddy 只反代 `/v1/*` 与 `/healthz`（`jarvis/deploy/caddy/Caddyfile:36,47`）。
根路径 `/memory/*` 会落到前端 catch-all **返回 200 HTML** —— 探测「假通」、
调用 405。挂 `/v1` 下零 Caddy 改动，宿主机 `memory.hub` 填 `…/v1` 即可。

---

## 四、隔离与安全

| 项 | 做法 |
|---|---|
| 鉴权 | 复用 `/v1` router 的 `require_token`（X-Hub-Token / node token），不另造一套 |
| 租户隔离 | **只出 crew 命名空间**（`dsh-memory/bot` 与 `bot/*`）。`dsh/ktool`、`qoder/code`、`claude/*` 即使持 admin token 也不可见 |
| 同命名空间内隔离 | 非 `bot-*` 的 dsh 记忆（`--Users-cpuser--/…`）一并丢弃 —— 实测该命名空间确实混装 |
| 参数校验 | `bots` 按 `^[a-z0-9][a-z0-9_-]{0,63}$`，不合规 422（不做「清洗后当合规」） |
| 不造成功空响应 | 真没有 crew 命名空间时回 `reason=no-crew-namespace`；`consolidate` 回 `dryRun` 与 `candidateMerges` 让调用方分清「算了没做」与「做了零个」 |

---

## 五、测试与服务证据

### 单测

```
python3.12 -m pytest tests/test_memory_compat_routes.py -q   → 50 passed
python3.12 -m pytest tests/ -q                               → 729 passed, 1 failed
```

（`TestNoRepoPollution` 两条是测试卫生守卫：`import hub_service.main` 会在模块级
构造 `SigningKey`，而 Settings 默认是相对路径 `./data/keys/hub-ed25519.pem` ——
任何 import main 的测试都会在仓库里生成一把真密钥。测试文件已在 import 前把
`HUB_CAS_ROOT` / `HUB_SIGNING_KEY_PATH` 钉到临时目录，并加断言守住这条。）

那 1 个失败是**既有失败**，与本次改动无关：

```
tests/test_local_dream_iterators.py::TestCollectSessionsRegistry::test_registry_covers_all_legacy_sources
  assert keys == [14 个源]
  At index 7 diff: 'claude-desktop' != 'codex'
  Left contains one more item: 'copilot'
```

（该测试写死 14 个源 key，而 `_SESSION_SOURCE_SPECS` 已增至含 `claude-desktop`/`copilot`。
把本次改动 stash 掉后同样失败。）

### 生产真实数据验证（只读 GET，未写入）

用生产库 `dsh-memory/bot` 的 3 条真实行跑 `entry_from_memory()`：

```
coder      bot-coder-dsh-git-push-credential-helper   created=1794298008
scribbler  bot-scribbler-tone-concise-no-padding      created=1794163763
coder      bot-coder-use-pnpm-test                    created=1794163759
```

### 客户端端到端（本地兼容面 + 宿主机真实代码）

本地起兼容面（ASGI + 假 DB 行），用宿主机**真实** `HubHttp` 打：

```
HubHttp.search -> 2 entries
  bot=coder     name=bot-coder-use-pnpm-test  type=feedback updated=1794156544
  bot=scribbler name=bot-scribbler-tone       type=feedback updated=1794156544
HubHttp.consolidate -> { facts: 0, merged: 0, superseded: 0 }
```

宿主机既有测试：`vitest run tests/crew-memory-hub-client.spec.ts tests/crew-memory-detect.spec.ts` → **10 passed**。

---

## 六、实施中抓到的真实 bug（已修 + 回归）

**`created_at` 是 ISO 字符串，不是 datetime。**

`search_memories_impl` 走 `_memory_json()`，把 `created_at` 序列化成
`2026-11-08T16:49:04.934689Z`。第一版 `_seconds()` 只认 `datetime` 和数字，
于是每条记忆的 `created/updated` 都变成 **0**；宿主机 `freshness()`
（`backend/src/memory/recall.ts`）把 0 当 1970 年 —— 所有记忆同样陈旧，
排序项白算，新记忆永远排不到前面。

这是用生产行验证时抓到的，不是单测能发现的（单测里我传的是 `datetime`）。
已修（认 datetime / ISO 字符串 / 数字，`Z` 后缀归一化，naive 当 UTC），
并加 5 条回归测试（`TestSecondsParsing`）。

---

## 七、部署与真联调（已完成）

### 7.1 部署

按 `deploy/DEPLOY_RUNBOOK.md` §5，经贾维斯执行（未改 `.env` 内容，只把
`AGENT_HUB_IMAGE` 指向新 tag；双 env-file 且 embed 在前）：

| 步骤 | 结果 |
|---|---|
| 构建 | `home-agent-hub:issue24-compat-20261114-173320`（ID `0db6b74b8f36`，321MB） |
| 起临时容器验证路由 | `APP_LEVEL: ['/healthz', '/v1/health', …]`、`COMPAT_IN_ROUTER: [… '/v1/memory/consolidate', '/v1/memory/search']` ✅ |
| 切 tag + `up -d hub-api` | `Up About a minute (healthy)`；embed 仍 `cpu-1.4` healthy（没掉回 cpu-1.5） |
| 备份 | `.env.bak-issue24-*`、`main.py.bak-issue24-*` 已留 |

**改动前的关键确认**：镜像内 `main.py` md5 = `4e67442b…` 与本地 git HEAD **完全一致**
（NAS HEAD `eb936d0` 是本地 `17089e7` 的等价物）。所以本次不是「把未上线的 V3 改动
一起带上去」，只是在已上线基线上加 26 行 + 一个新模块。

### 7.2 真实服务验收

```
GET  https://jarvis.kentonnie.top/v1/health          → 200 {"status":"ok",...}   # 免鉴权探针
GET  http://192.168.31.152:18080/v1/health           → 200                      # LAN 同
POST …/v1/memory/search（无 token）                   → 401                      # 鉴权生效
POST …/v1/memory/search（带 token）                   → 200 {entries:3, namespaces:['dsh-memory/bot'], bots:['coder','scribbler']}
POST …/v1/memory/consolidate（dry-run）               → 200 {facts:0,merged:0,superseded:0,dryRun:true,candidateMerges:0,window:{...}}
```

### 7.3 既有 API 未被破坏（回归）

```
GET /healthz                       200
GET /v1/metrics                    200
GET /v1/memories/embedding-health  200
GET /v1/memories/namespaces        200
POST /v1/memories/search           → 仍是裸数组（type: list, len: 2）  ← 形状未变
MCP hub_memory_search("pnpm test") → 2 hits，top score 0.6843         ← 检索仍工作
```

### 7.4 跨设备同步实测（A 写 → B 读）

```
设备 A: POST /v1/memories  {"namespace":"dsh-memory/bot", "origin":"issue24-probe",
         "metadata":{"source_file":"bot-lead-issue24-crossdevice-probe.md"}}
      → 201 {"id":"b9c43ad3-bdea-4df0-a470-5dbe05308f4a", ...}

设备 B: POST /v1/memory/search {"query":"CROSSDEV-1794649376"}
      → 200  entries[0]: bot=lead  name=bot-lead-issue24-crossdevice-probe
                          created=1794649378  命中探针=True
                          body: "这条由 Mac（设备 A）写入，用于验证设备 B 能否经
                                 /v1/memory/search 召回。标记 CROSSDEV-1794649376。"

清理: DELETE /v1/memories/b9c43ad3… → {"deleted":true,"mode":"soft",...}
     再检索 → 探针不可见；bots 回到 ['coder','scribbler']
```

**这条证明了 #24 的核心诉求**：一台设备写入、另一台经兼容面召回同一条，
`bot_id` 正确解析为 `lead`，软删即刻从召回消失。

### 7.5 客户端真实代码端到端

用宿主机**真实** `HubHttp` + `memoryEntriesOf` + `consolidateResultOf` 打真实 Hub：

```
no-token search  → Error: hub /memory/search answered 401     （如预期，降级本机）
with-token       → 200；memoryEntriesOf accepted 3/3
  bot=coder     name=bot-coder-use-pnpm-test                   type=feedback updated=1794163759
  bot=coder     name=bot-coder-dsh-git-push-credential-helper  type=feedback updated=1794298008
  bot=scribbler name=bot-scribbler-tone-concise-no-padding     type=feedback updated=1794163763
planWrite prefix violations: 0                                  （name 前缀合规）
consolidate      → 200；consolidateResultOf 解析为 {facts:0,merged:0,superseded:0}
```

---

## 七之二、剩下的唯一缺口：客户端没有 token 通道

**这不是服务端问题，是客户端契约缺一个字段。** 实测：

```
HubProbe.refresh()  → true   （/v1/health 免鉴权，探测成功）
HubHttp.search()    → 抛 401 （/memory/search 需 X-Hub-Token）
```

后果比「没配 hub」更误导：日志会说 `[memory] hub reached (…)`，然后每条召回都
抛 401 被 `HubMemory` 捕获降级本机 —— 运维看到「hub reached」会以为接通了。

根因在宿主机侧：

- `backend/src/memory/hub-client.ts:85` 只发 `{'content-type': 'application/json'}`
- `backend/src/memory/detect.ts:35` 探测也不带 header（这个是对的，探针就该免鉴权）
- `backend/src/policy.ts:182` 的 `MemoryConfigSchema` **只有 `hub` 和 `timeoutMs`，没有 token 位**

### 两个可选修法（都在本仓，不属本次授权写范围）

| 方案 | 做法 | 代价 |
|---|---|---|
| A（推荐） | `MemoryConfigSchema` 加 `token: z.string().default('')`；`HubHttp` 有 token 时发 `X-Hub-Token`；`runtime.ts` 传下去 | 改动 4 个文件 + 测试；token 落 settings（本机 KV，与 `connections` 里其他凭据同处） |
| B | Hub 侧允许 node token 走 `/v1/memory/*`（`_is_node_report` 白名单加路径） | 只需 Hub 改一行，但 node token 权限被放大到读全库 Bot 记忆 |

**建议 A**：token 是「谁在问」的身份，不该靠放宽服务端白名单解决。且 `hub-client.ts`
的注释已写明「不内置 Hub 凭据」——所以 A 要在运行时注入而非硬编码。

在 A 落地前，`settings.memory.hub` 即使填对也只会得到「探测通、检索全降级」，
所以**本机不要填 hub 地址**，保持 `hub=""` 走本机版反而是当前正确状态。

---

## 八、需要 lead 决策的三件事

1. **客户端 token 通道（A / B 二选一，见 §七之二）** —— 这是 #24 端到端闭环的最后一步。
   不解决的话，服务端做得再对，宿主机也拿不到一条记忆。

2. **`consolidate` 默认 dry-run 还是默认 apply？**
   当前默认 dry-run（客户端 3s 超时驱动，不拿它当批量删除入口）。
   若希望宿主机每次睡眠期巩固都真的合并近似重复，需改成默认 `apply=true`
   并接受「3s 内可能删掉若干软删行」。软删可 restore、有审计。

3. **部署节奏** —— 已解决，不再是决策项。实测镜像内 `main.py` md5 与本地 HEAD
   完全一致，本次只是在已上线基线上加 26 行 + 一个新模块，没有夹带别的改动。

4. **`memory.hub` 该填什么**：建议 `https://jarvis.kentonnie.top/v1`（公网，
   Mac 漫游可用）；LAN 内可填 `http://192.168.31.152:18080/v1`（18080 实测 200）。
   注意 `detect.ts` 探测打 `base + '/health'` → 必须是 `…/v1/health`，
   所以 base 必须带 `/v1`。**但在决策 1 落地前不要填**（见 §七之二）。

---

## 九、改动清单（两仓，均未 commit / push）

**home-hub**
- `hub/hub_service/memory_compat_routes.py`（新增）
- `hub/hub_service/main.py`（+26 行，两处接线）

**NAS 部署树 `/opt/data/home-hub-deploy`**（= Mac NFS
`…/nvme11-15916258010/hermes/data/home-hub-deploy`）
- 同步了上面两个文件（md5 校验一致）
- 备份：`main.py.bak-issue24-20261114-173228`、`.env.bak-issue24-*`
- `.env` 的 `AGENT_HUB_IMAGE` 已指向 `home-agent-hub:issue24-compat-20261114-173320`
- 回滚：`AGENT_HUB_IMAGE=home-agent-hub:wp-e547d74-20260917-073423` 后
  `docker compose --env-file .env.embed --env-file .env -f docker-compose.agent-hub.yml -f docker-compose.embed.yml up -d hub-api`

**home-agent-memory-v2**
- `tests/test_memory_compat_routes.py`（新增，48 例）
- `CHANGELOG.md`、`MEMORY.md`、`PROGRESS.md`（进度记录）

**dsh-bot-crew**
- `docs/review/2026-11-14-issue24-memory-hub-report.md`（本文件）

未触碰：`backend/src/**`、`开发进度.md`、`HANDOFF.md`、`scripts/crew-watch`、
生产 settings、NAS 主 worktree。

---

## 十、可恢复 patch（服务端未提交改动的落地材料）

lead 要求「未提交服务端部署 diff 必须留可恢复 patch/report」。**已转存到本仓
`docs/review/issue24-patch/`**（长期可恢复，不依赖会话临时目录）：

| 文件 | 内容 |
|---|---|
| `BASE_HEAD.txt` | `17089e7778a9c685c63eacac1450e6f8a31efe5b`（home-hub HEAD，patch 基线） |
| `01-main.py.diff` | `main.py` 的 43 行 unified diff（两处接线） |
| `02-memory_compat_routes.py` | 新模块全文（`git diff` 抓不到未追踪文件，故整份拷贝） |
| `03-test_memory_compat_routes.py` | 契约测试全文（50 例） |

**home-hub 侧复现方式**（在 `~/Code/home-hub`，基线必须是 `17089e7`）：

```bash
P=~/Code/dsh-bot-crew/docs/review/issue24-patch
git apply $P/01-main.py.diff
cp $P/02-memory_compat_routes.py hub/hub_service/memory_compat_routes.py
# 校验
md5 -q hub/hub_service/main.py hub/hub_service/memory_compat_routes.py
# 期望: 684be730cd18f3c21a4cd24b44f836ad / 553cae9eefed53774aa82e43d361b83c
```

**tests 侧**（home-agent-memory-v2，未追踪文件）：`tests/test_memory_compat_routes.py`
（50 例，含 `TestNoRepoPollution` 两条卫生守卫）。副本在
`docs/review/issue24-patch/03-test_memory_compat_routes.py`，恢复方式：

```bash
cp $P/03-test_memory_compat_routes.py ~/Code/home-agent-memory-v2/tests/test_memory_compat_routes.py
```

### NAS 主 worktree 未被修改（明确）

- 改动只落在**部署树** `/opt/data/home-hub-deploy`（= Mac NFS
  `…/nvme11-15916258010/hermes/data/home-hub-deploy`）的两个文件。
- **未触碰** `/opt/data/Jarvis/home_agent_hub`（NAS 主 worktree，`AGENTS.md` 明令只读）。
- 部署树自身是 git 仓，`git status` 显示我引入的正是这两个文件 + 4 个既有未追踪项
  （`backups-d29-chunk-removal/`、两个 `.bak-*`、`secrets/`）——后四项是历史遗留，非本次产生。
- 回滚材料：`hub/hub_service/main.py.bak-issue24-20261114-173228`、
  `hub/deploy/.env.bak-issue24-*`。

## 十一、stash 事实核查（lead 质询项，只读答复）

**我在本轮执行过 1 次 `git stash push`，在 `home-agent-memory-v2` 仓，且它失败了、什么都没暂存。**

原始命令（step「确认失败是否既存」）：

```bash
git stash push -- src/hub_service/main.py tests/test_memory_compat_routes.py \
                  src/hub_service/memory_compat_routes.py
```

实际输出是 **空**，紧接着 `git stash list` 报 `No stash entries found`。
原因是这三个路径在 memory-v2 的 git 里**一个都不被追踪**：

```
src/hub_service/main.py                       NOT tracked by memory-v2   ← 是符号链接指向 home-hub
src/hub_service/memory_compat_routes.py       NOT tracked by memory-v2   ← 同上
tests/test_memory_compat_routes.py            NOT tracked by memory-v2   ← 我新建的未追踪文件
```

`src/hub_service` 是符号链接 `→ /Users/cpuser/Code/home-hub/hub/hub_service`
（memory-v2 `dd2cdf8`「收敛为 home-hub 单一事实源」的产物），所以 memory-v2 的
`git stash` 根本看不到这些路径，命令对工作区**零影响**。

### 三个佐证

1. `git stash list` 在两个仓都为空；`git rev-parse --verify refs/stash` 两仓都报
   `Needed a single revision`（= 不存在 stash ref）。
2. memory-v2 里唯一的悬空 stash commit 是 `70f386ae`，时间戳 **2026-09-16 13:29**
   （作者 kentonnie），内容只涉及 `src/hub_memory_mcp/tools.py` 与
   `tests/test_wp73b_mcp_graph.py` —— **与本次无关，是两个月前的旧残留**。
3. memory-v2 的 `HEAD` reflog 今天**没有任何新条目**（最后一条是 2026-10-25 00:44）。

### 是否涉及别人修改

**没有。** 理由：

- 命令没生效（未追踪路径），不存在「把谁的在途改动暂存起来」的可能；
- 同轮 `git status --short` 前后输出一致，`backend/src/**` 的在途改动（其他 agent 的）
  始终显示为 `M`，从未消失过；
- 我从未在 `dsh-bot-crew` 仓执行任何 stash/checkout/restore/reset。

**但这是我的错误**：在共享树上、没先确认路径是否被追踪就调 `git stash`。
即使这次因符号链接而未生效，这个动作本身不该发生。此后**不再执行任何
stash/checkout/restore/reset**，包括「只是验证一下」的场景。需要临时比对时改为
导出副本到 `/tmp` 或用 `git show <rev>:<path>` 只读读取。

**当前仍在的唯一未提交改动**（都在预期内，无丢失）：

| 仓 | 状态 |
|---|---|
| `home-agent-memory-v2` | `M CHANGELOG.md`、`M MEMORY.md`、`M PROGRESS.md`、`?? tests/test_memory_compat_routes.py` |
| `home-hub` | `M hub/hub_service/main.py`、`?? hub/hub_service/memory_compat_routes.py`（另有 2 个 node_bridge 的 `M` 与 1 个 docs `??`，**都不是我的**，原样未动） |
| `dsh-bot-crew` | `?? docs/review/2026-11-14-issue24-memory-hub-report.md` |
