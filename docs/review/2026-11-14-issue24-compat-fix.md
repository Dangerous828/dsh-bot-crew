# #24 记忆中枢兼容层 — 审计缺陷修复与二次部署报告

- 日期：2026-11-14
- 执行者：ds-hub-server-fix-max（lead 委派）
- 结论：**审计列出的高置信缺陷已全部落到代码与测试，服务端兼容层新版已从「当前线上 compat 镜像」最小 overlay 部署并复验（读 / 鉴权 / 健康 / dry-run 语义）。#24 保持 open：客户端 token 通道已由客户端侧闭环，但「真实跨设备」与 release 的生产验收仍需另一条线收口。**
- 前一份报告：`docs/review/2026-11-14-issue24-memory-hub-report.md`（首版实施与部署，仍有效，本文只覆盖增量）

---

## 一、这一轮修的是什么（逐项对账）

| # | 缺陷 | 旧行为 | 现在 |
|---|---|---|---|
| 1 | 带 `bots` 时只查 `dsh-memory/bot`，漏 `bot/<id>` | `crew_namespace()`（已删）对任何 bot 都返回同一命名空间，`bots=["writer"]` 永不查 `bot/writer` —— 过滤看着生效，实际是「另一个命名空间被整体跳过」，空召回且无报错 | `crew_namespaces_for()` 返回 `{dsh-memory/bot} ∪ {bot/<id> for id in bots}`，两个都查 |
| 2 | BOT_ID 服务端首字符/长度约束与客户端不一致 | 服务端 `^[a-z0-9][a-z0-9_-]{0,63}$`：不许以 `-` 开头、≤64；客户端 `BOT_ID = /^[a-z0-9_-]+$/` 认的 id 服务端回 422 | 收到 `^[a-z0-9_-]{1,64}$`：字符集与客户端逐字同口径，`{1,64}` 只承接写入侧 `mobile-http.ts` 已有的 64 上限，不再是自造规则 |
| 3 | `since=0` truthiness 丢值 | `if body.since` / `if body.until` 判假值，`0` 被静默换成「24 小时前 / 现在」；调用方要「从最早开始」却拿到窄窗口，统计少算且无提示 | 只判 `None`；`0` 就是 Unix 纪元 |
| 4 | health 注册失败仍无条件 `ok` | 兼容面模块导入失败也回 `{"status":"ok"}`，探针 200 → 客户端认为中枢可用，每次召回 404 后静默降级，运维只看到「hub reached」 | `/v1/health` 增加 `memory_compat` 字段，取值 `registered` / `unavailable:<异常类名>`；通用 `status` 仍 `ok`（兼容面挂了≠hub 挂了），既有按 `service`/`version` 断言的消费者一个字段不少；`/healthz` 完全不动 |
| 5 | candidate metrics 把事实统计误作新提炼 | `facts` 返回窗口内 `origin in {distill,flush,native}` 的**存量**行数，客户端日志写「本次巩固提炼了 N 条」，实际一条没提炼 | `facts` 恒 `0`（本层不跑 LLM 蒸馏）；存量另立 `existingFacts`，新增 `scanned`（实际扫过的 crew 行数）。`merged`/`superseded`/`dryRun`/`candidateMerges` 语义不变 |
| 6 | `known_bots` 三参数从未接线 | `_stem_bot_id(known_bots)` 有实现、无调用方；`bot-my-bot-2-slug.md` 被惰性切成 `my`，调用方 `bots=["my-bot-2"]` 于是过滤掉自己刚写的那条 | `CompatSearch.known_bots` 新增并下传到 `entry_from_memory` → `bot_id_of_row`；名录 = `bots ∪ known_bots`（两者都只是消歧线索） |
| 7 | header 重复解析 | `bot_id_of_row()` 自己扫前 3 行标头，`entry_from_memory()` 再 `_parse_header()` 一遍，两份「前 3 行 + 正则」口径，任一处改动就让 bot_id 与 name 来自不同行 | `_parse_header()` 只调用一次，结果以 `header=` 参数传入 `bot_id_of_row()`，type/stem/description/bot_id 同源 |
| 8 | `updated` 无真实来源 | 赋值 `"updated": created` 没有说明，容易被后来人当成「有更新时间」 | 保留 `updated == created`（Hub `memories` 表只有 `created_at`/`deleted_at`，没有行更新时间列，也没有写入方在 metadata 落 `updated`），并在代码里写明**不编 now()** 的原因 |

### 附带收口（同一根因的同类隐患）

- **`_RowView` 不再往 `metadata.bot_id` 里塞命名空间推出来的 id。** 那一步把「命名空间说的」和「写入方说的」写进同一个字段，正是第 8 条缺陷里「自述当身份」的同一个坑。现在命名空间由 `bot_id_of_row()` 直接读。
- **crew 之外的命名空间在行级再挡一道。** SQL 已按命名空间过滤，但漏一次条件就把别人的记忆当 crew 的上报，代价太高。
- **删掉两个误导性死函数** `_bot_id_of_namespace()`（调用点随第 1 条消失）与 `crew_namespace()`（名字暗示「每个 bot 一个命名空间」，而它恒定返回同一个——正是第 1 条的成因；只剩测试在用，一并删掉，避免下一个接手的人照着名字继续写错）。

---

## 二、归属与隔离：明确「这不是权限边界」

审计建议里有一条「把 `metadata.bot_id` 与 `source_file` 两个自述字段组合起来即可宣称已做 Bot 级鉴权隔离」。**没有采纳，因为它不成立。**

事实：`metadata.bot_id`、`metadata.source_file`、`metadata.imported_from` 都由**写入方**填写，`bot-<id>-` 文件名也只是约定——任何人都能写一条自称属于别人的行。把两个自述字段拼在一起，得到的是「写入方说它属于谁」，不是「谁有权读它」。

这套系统里真正可信的只有两件：

1. `/v1` 的 `require_token` 认证出的 `request.state.actor`（`admin` 或 `node:<id>`）；
2. 命名空间本身（由写入路径决定，不接受行内自述覆盖）。

由此的真实边界是：**一个 node 凭据 = 一个操作者 = 全队记忆可见**。系统里没有可验证的独立 Bot principal（每 Bot 一套凭据、只能读写自己那份），所以：

> **`bot` 过滤是数据归类，不是权限边界。**

本层因此只做**可验证的收窄**，不做无法验证的宣称：

- crew 命名空间硬过滤（`dsh-memory/bot`、`bot/<id>`）+ `bots` 正则校验，路径注入无从下手；
- 自述 `bot_id` 与 canonical 文件名**冲突时整行拒绝**（`logger.warning` 记下两个值），不把两种说法混起来用；
- `bot/<id>` 命名空间优先于任何行内自述；
- **不扩张 node token 白名单**（`_is_node_report` 未动，`/v1/memory/*` 仍需 admin token 或既有路径白名单）；
- **不打开 `apply` 批删**：`apply` 默认 `false`，路由层不提供任何「一次删很多」的入口，`soft_delete` 只在显式 `apply=true` 时逐对调用。

模块 docstring 里把这段写成明文，避免下一个接手的人又把 `bots` 当权限。

---

## 三、测试证据

```
python3.12 -m pytest tests/test_memory_compat_routes.py -q
→ 82 passed
```

（首版 50 例 → 现 82 例；新增 32 例覆盖上表 8 项 + 负对照。）

```
python3.12 -m pytest tests/ -q
→ 761 passed, 1 failed, 68 subtests passed
```

那 1 个失败是**既有失败**，与本次无关：
`tests/test_local_dream_iterators.py::TestCollectSessionsRegistry::test_registry_covers_all_legacy_sources`
（写死 14 个源 key，`_SESSION_SOURCE_SPECS` 已增至含 `claude-desktop`/`copilot`）。

```
python3.12 -m pytest hub/hub_service/tests/ -q   （home-hub 自带）
→ 24 passed
```

### 负对照（每条都成对写了「不该发生的那一面」）

| 正例 | 负对照 |
|---|---|
| `bots=["writer"]` 时两个命名空间都被查 | 假实现只回 `dsh-memory/bot` 的行 → 结果里没有 `writer` 的 `bot/` 行，证明查询集合真的变了 |
| `known_bots=["my-bot-2"]` 解出 `my-bot-2` | 不给名录时同一行解出 `my`（旧行为仍可复现，说明修复靠名录而非改匹配逻辑） |
| `since=0` → 纪元 | 不传 `since` → 仍是 24h 默认窗口 |
| 自述与 canonical 一致 → 采用 | 自述 `lead` + 文件名 `bot-coder-…` → 整行 `None` |
| `bot/writer` 命名空间覆盖自述 `lead` | `dsh-memory/bot` 下只有自述、无文件名 → 仍按自述归类（不误杀） |
| health `registered` | `unavailable:ImportError` → `memory_compat` 如实否定，`status` 仍 `ok` |
| `facts=0` + `existingFacts=1` + `scanned=1` | 非 crew 行不进 `scanned` |
| 客户端认的 `-lead`/`my_bot`/64 字符 → 通过 | `Bot`/`bot/lead`/`a.b`/`a b`/65 字符 → 422 |

`TestNoRepoPollution` 两条卫生守卫仍在：`import hub_service.main` 会构造 `SigningKey`，测试已在 import 前把 `HUB_CAS_ROOT` / `HUB_SIGNING_KEY_PATH` 钉到临时目录；跑完 `tests/` 后仓库内无 `data/`。

---

## 四、部署（从当前线上 compat 镜像最小 overlay）

### 4.1 做法

不是重新 build 整个 `hub_service`，而是从**当前线上**的 `home-agent-hub:issue24-compat-20261114-173320` 出发，只替换本次改动的两个文件：

```dockerfile
FROM home-agent-hub:issue24-compat-20261114-173320
USER root
COPY --chown=hub:hub hub_service/main.py /app/hub_service/main.py
COPY --chown=hub:hub hub_service/memory_compat_routes.py /app/hub_service/memory_compat_routes.py
RUN rm -rf /app/hub_service/__pycache__ \
 && python -m compileall -q /app/hub_service/main.py /app/hub_service/memory_compat_routes.py \
 && chown -R 10001:10001 /app/hub_service/__pycache__
USER 10001:10001
```

`rm -rf __pycache__` + `USER root` 是**构建期**必需：基线镜像里那份 pycache 是 root 所有、而基线默认 USER 是 10001，`compileall` 覆盖不了会 `PermissionError`。首次构建正是撞在这里（不是源文件问题）。清掉重建后运行期字节码属主也正确。

**没有带任何其他未部署的 V3 改动**：`COPY` 只有两个文件，`FROM` 是线上镜像。

### 4.2 步骤与结果

| 步骤 | 结果 |
|---|---|
| 备份部署树两文件 | `main.py.bak-issue24fix-20261114-182339`、`memory_compat_routes.py.bak-issue24fix-20261114-182339` |
| 同步两文件 | md5 与本地一致：`main.py` `afc850d39573d5c2c2248d677506ad98`、`memory_compat_routes.py` `f8fa22a224ccfc14770f7c5c092cc6ff`（最终版；镜像内 `md5sum` 已核对同一对值） |
| 构建（第一版） | `home-agent-hub:issue24fix-20261114-1825`（ID `652e10a9836a`，321MB） |
| 构建（最终版） | `home-agent-hub:issue24fix2-20261114-1845`（ID `4d9739ad2345`，321MB）—— 第一版上线后又删掉两个误导性死函数，故重建一次；overlay 基线改为第一版镜像，仍只 COPY 两个文件 |
| 临时容器验证 | `COMPAT: registered`；`HEALTH: {...,'memory_compat':'registered'}`；`/v1/memory/{search,consolidate}` 在 router 上；`/v1/health`、`/healthz` 在 app 级 |
| 备份 `.env` | `.env.bak-issue24fix-20261114-182716` |
| 切 tag + `up -d hub-api` | `home-agent-hub-hub-api-1` → 最终版镜像，`Up (healthy)`；embed 仍 `cpu-1.4` healthy（没掉回 cpu-1.5），postgres 全程 Running 未重启 |

**没有做的事**：没改 NAS 主 worktree `/opt/data/Jarvis/home_agent_hub`（只动部署树 `/opt/data/home-hub-deploy`）；没重启 dsh、mobilegw、caddy、postgres、embed；没执行任何 `git stash/checkout/restore/reset/add/commit/push`；Caddyfile 未动（`/v1/*` 与 `/healthz` 反代规则首版就在，本次零改动）。

### 4.3 回滚（精确到本次之前）

```bash
cd /opt/data/home-hub-deploy/hub/deploy
# 1) 恢复 env（镜像 tag 回 compat）
cp -p .env.bak-issue24fix-20261114-182716 .env
# 2) 恢复源文件（可选，镜像已固化，仅当后续要重建时用）
cp -p ../hub_service/main.py.bak-issue24fix-20261114-182339 ../hub_service/main.py
cp -p ../hub_service/memory_compat_routes.py.bak-issue24fix-20261114-182339 ../hub_service/memory_compat_routes.py
# 3) 只重建 hub-api
docker compose --env-file .env.embed --env-file .env \
  -f docker-compose.agent-hub.yml -f docker-compose.embed.yml up -d hub-api
```

回滚后镜像为 `home-agent-hub:issue24-compat-20261114-173320`（首版兼容层，仍可服务，只是带本文第一节列出的 8 项缺陷）。再往前退到无兼容层：`AGENT_HUB_IMAGE=home-agent-hub:wp-e547d74-20260917-073423`。中间那版 `issue24fix-20261114-1825` 只上过约 18 分钟、已不在 `.env` 里，可留可删。

---

## 五、线上复验（真实服务，不是本地 ASGI）

### 5.1 公网 / 无凭据（探针与鉴权）

```
GET  https://jarvis.kentonnie.top/v1/health
  → 200 {"status":"ok","service":"home-agent-hub","version":"1.0.0","memory_compat":"registered"}
GET  https://jarvis.kentonnie.top/healthz
  → 200 {"status":"ok","service":"home-agent-hub","version":"1.0.0"}        ← 通用探针形状未变
POST https://jarvis.kentonnie.top/v1/memory/search   (无 token)
  → 401 {"detail":"invalid hub token"}
POST https://jarvis.kentonnie.top/v1/memory/search   (错 token)
  → 401 {"detail":"invalid hub token"}
```

探针免鉴权、业务面必须带 token —— 两条都还在。

### 5.2 容器内带真 token（读 / 校验 / dry-run）

用 hub-api 自己的 `/run/secrets/hub_api_token` 打自己（响应体不含 token）：

```
health      (200, {"status":"ok","service":"home-agent-hub","version":"1.0.0","memory_compat":"registered"})
search      (200, {"entries":[{"name":"bot-coder-use-pnpm-test","bot_id":"coder",
                               "description":"用户的固定要求：跑测试用 `pnpm test`，不要用 `npm test` / `npm run test`",
                               "body":"2026-11-08 用户原文（团队主对话）：…", ...}], ...})
search bots (200, {"entries":[],"namespaces":["bot/lead","dsh-memory/bot"],"bots":[],"degraded":false})
bad bot     (422, {"detail":[{"type":"value_error","loc":["body","bots"],
                              "msg":"Value error, invalid bot id: 'Bot/Lead'"}]})
consolidate (200, {"facts":0,"merged":0,"superseded":0,"dryRun":true,
                   "candidateMerges":0,"scanned":0,"existingFacts":0,
                   "window":{"since":1794565757,"until":1794652157}})
```

逐条读：

- **读**：`bot-coder-use-pnpm-test` 召回成功，`bot_id` 仍正确解析为 `coder`，`body` 去掉了 `# [dsh-auto-memory:…]` 标头。生产真实数据路径没被改坏。
- **`namespaces` 证明第 1 条修好了**：`bots=["lead"]` 现在回 `["bot/lead","dsh-memory/bot"]` —— 旧版这里只有 `["dsh-memory/bot"]`，`bot/lead` 从来没被查过。
- **鉴权**：无 token / 错 token 均 401；带 token 才 200。node token 白名单未扩张。
- **校验**：`Bot/Lead` 422，且 detail 明确指出是 `bots` 字段。
- **dry-run 语义**：`dryRun:true`、`merged:0`、`candidateMerges:0`、`facts:0`、`existingFacts:0`、`scanned:0`。窗口 24h 内没有 crew 行（探针数据早已清掉），所以四个计数都是 0 —— **这是「算了、没做」的如实上报，不是「做了零个」**。`apply` 未打开，本次无任何破坏性写。

### 5.3 既有 API 未被破坏

`/healthz`、`/v1/health` 形状如上；`/v1/memories/search`、`/v1/metrics`、`/v1/memories/namespaces` 未改一行（本次 diff 只碰 `main.py` 的 health 段与兼容面注册段）。首版报告 §7.3 的回归结论仍然成立。

---

## 六、与客户端的接口（给 release 的最终形状）

**客户端零改动，三处都不变**：

| 项 | 形状 |
|---|---|
| 探测 | `GET <base>/health`，不带 header，2xx 即可达 |
| 检索 | `POST <base>/memory/search`，`X-Hub-Token` header（空串不带），体 `{query, bots?, limit?, known_bots?}` |
| 巩固 | `POST <base>/memory/consolidate`，体 `{since?, until?}`，**不传 `apply`** → 服务端默认 dry-run |

响应：

- search：`{entries, namespaces, bots, degraded}`（形状不变；`namespaces` 现在可能含 `bot/<id>`，客户端只读 `entries`，不受影响）
- consolidate：`{facts, merged, superseded, dryRun, candidateMerges, window, scanned, existingFacts}`

**`facts` 语义变更需要 release 在报告里如实记**：`facts` 从「窗口内存量已蒸馏行数」改成「本次提炼出的事实数」，本层不提炼 → **恒 0**。客户端 `consolidateResultOf()` 只要求 `facts`/`merged`/`superseded` 是**非负安全整数**，`0` 满足；所以旧客户端不会因此失败，但日志会从错的 N 变成正确的 0。**`facts=0` 是正确值，不是回归。**

`known_bots?` 是新增可选字段，不传 = 现有行为；传了只用于消解 `bot-my-bot-2-slug.md` 这类文件名歧义，**不参与任何权限判断**（名录由同一个调用方提供，它若想说谎直接伪造 `bots` 更省事）。

**BOT_ID 放宽的语义缺口（按 lead 要求单列，不进本次验收判据）**：服务端现在接受 `-lead` 这类客户端认的 id，且不再重复校验 64 上限（由写入侧 `mobile-http.ts` 管）。客户端旧过滤不会安全失败，但「服务端比客户端宽」这个差异本身要等客户端对齐后消失。

---

## 七、状态与遗留

| 项 | 状态 |
|---|---|
| 审计 8 项高置信缺陷 | 已修 + 82 例契约测试覆盖（含负对照） |
| 服务端兼容层新版 | 已从线上 compat 镜像最小 overlay 部署（最终版 `issue24fix2-20261114-1845`），复验通过 |
| 客户端 token 通道 | 已由客户端侧闭环（release 线验收），本次服务端零改动 |
| 真实跨设备（A 写 → B 读） | 首版已验；本次未重跑（无行为变更，且需要两设备同时在线） |
| `apply` 批删 | **未打开**，默认 dry-run 不变 |
| `facts` 语义变更 | 已同步 release；客户端日志值会从错的 N 变正确的 0 |
| BOT_ID 放宽 | 服务端已对齐客户端字符集；客户端旧过滤语义缺口单列 |
| #24 关单 | **保持 open**，等 release 生产验收 + 真实跨设备复验 |

---

## 八、可恢复材料

`docs/review/issue24-patch/`（本次已刷新，基线仍是 home-hub `17089e7`）：

| 文件 | 内容 | 校验 |
|---|---|---|
| `BASE_HEAD.txt` | `17089e7778a9c685c63eacac1450e6f8a31efe5b` | — |
| `01-main.py.diff` | `main.py` 69 行 unified diff（health 段 + 注册段） | 在 `17089e7` 上 `git apply --check` 通过，应用后 md5 = `afc850d39573d5c2c2248d677506ad98` |
| `02-memory_compat_routes.py` | 兼容模块全文（662 行） | md5 `f8fa22a224ccfc14770f7c5c092cc6ff` |
| `03-test_memory_compat_routes.py` | 契约测试全文（905 行，82 例） | — |

复现：

```bash
P=~/Code/dsh-bot-crew/docs/review/issue24-patch
cd ~/Code/home-hub            # 基线必须 17089e7
git apply $P/01-main.py.diff
cp $P/02-memory_compat_routes.py hub/hub_service/memory_compat_routes.py
md5 -q hub/hub_service/main.py hub/hub_service/memory_compat_routes.py
# 期望 afc850d39573d5c2c2248d677506ad98 / f8fa22a224ccfc14770f7c5c092cc6ff

cp $P/03-test_memory_compat_routes.py ~/Code/home-agent-memory-v2/tests/test_memory_compat_routes.py
cd ~/Code/home-agent-memory-v2 && python3.12 -m pytest tests/test_memory_compat_routes.py -q   # 82 passed
```

部署树侧回滚材料（NAS，均已存在）：
- `hub/hub_service/main.py.bak-issue24fix-20261114-182339`
- `hub/hub_service/memory_compat_routes.py.bak-issue24fix-20261114-182339`
- `hub/hub_service/memory_compat_routes.py.bak-issue24fix2-20261114-1843`（删死函数前）
- `hub/deploy/.env.bak-issue24fix-20261114-182716`（首版 compat tag，即回滚目标）
- `hub/hub_service/Dockerfile.overlay-issue24fix`（本次新增，最小 overlay 定义，保留可复现构建）

## 九、改动清单（均未 commit / push）

**home-hub**
- `hub/hub_service/memory_compat_routes.py`（改：8 项缺陷 + 隔离口径订正 + 死代码清理）
- `hub/hub_service/main.py`（改：`MEMORY_COMPAT_STATUS` / `health_payload()` / `/v1/health` 报注册状态；`/healthz` 保持原样）

**home-agent-memory-v2**
- `tests/test_memory_compat_routes.py`（50 → 82 例）
- `CHANGELOG.md` / `MEMORY.md` / `PROGRESS.md`（首版进度，本次未再改）

**dsh-bot-crew**
- `docs/review/2026-11-14-issue24-compat-fix.md`（本文件）
- `docs/review/issue24-patch/*`（刷新）

**NAS 部署树**（`/opt/data/home-hub-deploy` = Mac NFS `…/nvme11-15916258010/hermes/data/home-hub-deploy`）
- `hub/hub_service/{main.py,memory_compat_routes.py}` 同步 + 备份
- `hub/hub_service/Dockerfile.overlay-issue24fix`（新增）
- `hub/deploy/.env`（`AGENT_HUB_IMAGE` 指向新 tag）+ 备份

**未触碰**：`dsh-bot-crew/backend/**`（含 `memory/**`、`policy.ts`、`runtime.ts`）、`dsh-bot-crew` 的 `开发进度.md` / `HANDOFF.md` / `scripts/crew-watch`、`home-hub` 的 memory 源码/policy、NAS 主 worktree `/opt/data/Jarvis/home_agent_hub`、生产 settings、`_is_node_report` 白名单。
