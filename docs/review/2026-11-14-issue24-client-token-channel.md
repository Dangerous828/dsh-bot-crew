# #24 客户端 token 通道 — 实施与验证报告

- 日期：2026-11-14
- 执行者：ds-hub-token-max（lead 委派）
- 决策：**方案 A** —— 客户端发 `X-Hub-Token`，不放大 node token 权限（`_is_node_report` 白名单不动）。
- 结论：**客户端侧代码 stable-ready**。定向测试 + 全量套件 + 真实中枢联调全部通过；
  生产 `memory.hub` 仍未填（按 lead 要求「统一上线后验」，本任务不碰生产设置）。

---

## 一、这次改的是什么（四层分开）

原报告 §七之二 的缺口是「客户端没有 token 通道」，但把它当成一个字段的缺失会低估范围。
实际要分清四层，每层能证明的事不同：

| 层 | 调用 | 能证明什么 | 这次的处理 |
|---|---|---|---|
| 1 探测 | `GET <base>/health`（免鉴权） | 网络通、地址对。**不**证明记忆能用 | 保持不带 token（探针就该免鉴权） |
| 2 检索 | `POST <base>/memory/search` + `X-Hub-Token` | 记忆真的从中枢来（跨设备读取在此成立） | 新增 token header、bot_id 过滤 |
| 3 合并计划 | `POST <base>/memory/consolidate`（默认 dry-run） | 只出计划：`merged` 是**计划数** | 不传 `apply`；读数单列 `hubPlan` |
| 4 真实持久化 | 本机 `LocalMemory.consolidate` | 账本真的写了 | **修了 dry-run 截断本机写入的缺陷** |

### 1.1 修掉的三个实质缺陷（不是本次新增功能的附带项）

**(a) `dryRun` 截断了本机真实巩固 —— 两边都没写，看起来却像成功**

原 `HubMemory.consolidate()` 在中枢回了结果时直接 `return`。而生产兼容面默认
`apply=false` → `dryRun:true`、`merged:0`、**一条不写**；本机 `LocalMemory.consolidate`
才是拉 episodic → 提炼 → 落 KV 的那条路。合起来就是：**hub 一配上，宿主机巩固写入永久停摆，
服务端也一条不写**。

修法：本机账本是唯一写入者。先问中枢要计划（只为可见性与日志），**然后仍然跑本机提炼**；
返回值 `facts/merged/superseded` 只报真写了的数，中枢那份读数放进 `hubPlan`。
反向做法（让服务端默认 `apply=true`）被否掉：`soft_delete_memory` 每对内部自己 commit，
客户端 3s `AbortSignal.timeout` abort 后服务端不取消协程 → 会删完剩下的对而客户端以为「没做」，
半完成态比不写更难查。

**(b) 召回不带 `bot_id` —— 全队记忆混用**

`HubMemory.recall` 原来调 `search(query, { limit: 6 })`，从不传 `bots`。中枢的租户隔离只到
crew 命名空间（`dsh-memory/bot`），**不分 Bot**。于是 lead 的注入里会混进 coder 的规矩，
而条目形状对、分数高，看起来完全正常。本机版召回本来就按 Bot 过滤，这里对齐：
召回必带本票 `bot_id`（`botOf(ticket)`）。

**(c) `bot_id` 口径不一致 —— 一次 422 打掉整轮召回**

服务端 `_BOT_ID_RE = ^[a-z0-9][a-z0-9_-]{0,63}$`，宿主机 `BOT_ID = /^[a-z0-9_-]+$/`（无首字符
限制、无长度上限）。`_lead`、`-lead`、65 字符的 id 在宿主机合法，发过去整次 422 →
`HubHttp.search` 抛 → 整轮召回降级本机，且看不出是哪位 Bot 的问题。
修法：发请求前按服务端口径过滤（`hubBots`）；一个都不认得就降级本机，
**不**退化成「不带 bots」的宽查询（那等于把 (b) 的混用重新引入一遍）。

### 1.2 鉴权可观察：不再有「hub reached」假成功

原来 `HubProbe.refresh()` 回 `true`（`/v1/health` 免鉴权），紧接着 `HubHttp.search()` 抛 401，
`hub.ts` 的 catch 只打一句 `degraded` 就静默降级 —— 运维看到「hub reached」会以为接通了。

现在的状态机（`memory/auth.ts` 的 `HubAuth`）：

- `ok`：凭据读到了。
- `anonymous`：配了地址但一个凭据引用都没有（免鉴权的开发中枢仍能用，所以不报 error）。
- `rejected`：401/403。之后 `usable()` 为 false，**不再打网络**（省 3s 超时、日志不刷屏）。

`hubHealthOf()` 把它翻成 `/state.health.memory` 一行，被拒是 **`error`** —— 会直接进 overview
的 `problems`（`runtime-error`），面板看得见。日志只在状态**变化**时写，措辞明确否定：

```
[memory] hub 鉴权被拒 (401) (https://…/v1) — 中枢不接受 memory.tokenEnv/memory.tokenFile 的凭据；hub 未启用，记忆走本机
```

探测通但凭据不对时还会多一句 `hub reached but NOT usable: auth rejected (401)`，
不会只剩一个 `reached`。

### 1.3 TTL 单飞与自愈

- 原实现 TTL 过期后，每个调用方各自 `void refresh()` fire-and-forget —— 一次召回就可能并发
  打 N 个 `/health`，中枢一慢就自我加压。
- 现在 `HubProbe` 有 `inflight`：同一时刻只有一个探测在跑，并发调用共用它的结果。
  `refresh()` 遇到已在跑的先 await 再判断是否需要新的一次（直接 `return inflight` 会让
  「明确要求按 now 重探」拿到上一轮结果，换对 token 后恢复被推迟一整个 TTL）。
- 新增 `ensureFresh()`：记忆操作前顺手保鲜，过期才起一次单飞重探、不阻塞本次调用。
  中枢掉线再回来能自愈，不用重启。
- 每轮重探顺手重读一次凭据 → 换对 token 后下一个 TTL 自动恢复（有测试）。

### 1.4 凭据只存引用

`MemoryConfigSchema` 新增两项（都是**引用**，不是值）：

| 字段 | 含义 |
|---|---|
| `tokenEnv` | 环境变量名（`^[A-Za-z_][A-Za-z0-9_]*$`）。与 `tokenFile` 同时给时，从该文件里取这个键 |
| `tokenFile` | 凭据文件**绝对路径**（应为 0600）。只给文件时整份内容就是 token |

- 环境优先（不碰磁盘；文件优先会让人改了环境变量却没生效，更难查）。
- 值在每次请求那一刻现读（`readHubToken`），**不挂在客户端对象上**、不进设置、不进 `/state`、
  不进日志与错误消息。
- 设置块是 `.strict()` 的：往里塞 `token` 字段直接拒绝 —— 不给「顺手存值」留口子（有测试）。
- 文件权限过宽（非 0600）仍会用（链路要能通），但 health 报 `paused` 并写明「建议 chmod 600」。
- 文件读不出来 / 键不存在 / 空值 / 值含空白 / 值过长 → 一律返回空 token 并带 `problem`，
  **不返回半个值**、不改写原 token（改过的 token 一定不是原 token）。

运行时也允许环境兜底 `DSH_SUPERAGENT_MEMORY_HUB_TOKEN_ENV` / `_TOKEN_FILE`（与既有的
`DSH_SUPERAGENT_MEMORY_HUB` 同思路），环境里给的同样只是引用。

---

## 二、改动的文件

**只动了允许的写范围**（`backend/src/memory/**`、`policy.ts` 的 memory 段、配套 tests、
`backend/docs/007-architecture.md` 与 `08-memory-hub.md` 的登记、独立 docs/review 报告）：

| 文件 | 改动 |
|---|---|
| `backend/src/memory/auth.ts` | **新增**：凭据引用解析（环境 / env-file / 整文件）、`HubAuth` 三态状态机、`hubHealthOf`、`redactToken` |
| `backend/src/memory/hub-client.ts` | 发 `X-Hub-Token`（每次现读）、`HubAuthError` + `isHubAuthError`、`consolidateMode`、`hubBots`/`HUB_BOT_ID` |
| `backend/src/memory/detect.ts` | token 接入探测、鉴权状态与可达性分离、TTL 单飞 + `ensureFresh`、bot_id 过滤 |
| `backend/src/memory/hub.ts` | 召回带 `bot_id`、鉴权失败单独措辞、**dry-run 不再截断本机巩固** |
| `backend/src/memory/port.ts` | `ConsolidateResult` 增加 `dryRun`/`candidates`/`hubPlan`，真实计数与计划分开 |
| `backend/src/policy.ts` | `MemoryConfigSchema` 加 `tokenEnv`/`tokenFile`（memory 段，只此一处） |
| `backend/src/app/runtime.ts` | 接线（memory 段约 20 行）：传引用、`/state.health.memory` 上报、启动期如实提示 |
| `backend/src/client/approval.tsx` + `locales.ts` | 面板两栏凭据引用 + 说明（不存值） |
| `backend/tests/crew-memory-hub-auth.spec.ts` | **新增** 44 例 |
| `backend/tests/crew-memory-hub-client.spec.ts` | 精确化（不放宽）：dry-run 读数、不传 apply、header、401 归类 |
| `backend/tests/policy.spec.ts`、`settings.spec.ts` | 跟随新字段（精确期望，非 catch-all） |
| `backend/scripts/manual/live-hub-auth.test.ts` | **新增**：真实中枢四层验证 + 端到端召回（按引用读凭据） |
| `backend/docs/007-architecture.md` | 登记 `src/memory/auth.ts`、`tests/crew-memory-hub-auth.spec.ts`，更新 memory 五行真实行为 |
| `backend/docs/08-memory-hub.md` | 四层表、鉴权三态、凭据引用、`bots` 口径、consolidate 不传 apply |

**未触碰**：`prepare` 字段、runtime 晨报、client 执行面板、desktop/、app/、`开发进度.md`、
`HANDOFF.md`、`scripts/crew-watch`、生产 `memory.hub` 设置、生产容器。
未 build `lib/`、未 HMR、未 stash/checkout/restore/reset/add/commit/push、未重启生产、未抢焦点。

---

## 三、测试证据（全部 exit 码）

```
cd backend && pnpm typecheck      → EXIT=0
cd backend && pnpm test           → EXIT=0
  Test Files  113 passed (113)
  Tests       2022 passed (2022)
```

定向（本次相关）：

```
tests/crew-memory-hub-auth.spec.ts     44 passed   （新增）
tests/crew-memory-hub-client.spec.ts    8 passed
tests/crew-memory-detect.spec.ts        3 passed
tests/crew-memory-port.spec.ts          7 passed
tests/policy.spec.ts                  328 passed
tests/settings.spec.ts                  6 passed
tests/docs.spec.ts                      6 passed   （007 登记守门）
```

覆盖的契约（缺/错/对三态 + `/v1` + 脱敏）：

| 场景 | 断言 |
|---|---|
| token 缺失 | 不带 `x-hub-token`；状态 `anonymous`；真被拒后转 `rejected` 且日志含「hub 未启用」 |
| token 错 | 401 → `rejected`；后续召回**不再打网络**；`/state.health.memory` 是 `error` |
| token 对 | header 带上；条目进注入；状态回 `ok`；health 是 `ready` |
| base 含 `/v1` | 请求落在 `/v1/memory/search`；探测落在 `/v1/health` |
| 脱敏 | token 值不进日志、不进 snapshot、不进错误消息、不进设置解析结果 |
| 5xx vs 401 | 5xx 不是 `HubAuthError`（别把网络故障说成凭据问题） |
| TTL 单飞 | 并发三次 `refresh` 只探一次；`ensureFresh` 不叠加 |
| 自愈 | 掉线再回来、换对 token 都能在 TTL 过期后恢复 |
| dry-run | 中枢 `dryRun:true` 时**本机仍然真写**（`distilled=1`、`all()` 有 1 条）；中枢读数在 `hubPlan` |
| bot 口径 | `_lead`/超长 id 不发；一个都不认就降级本机，不发宽查询 |

---

## 四、真实中枢联调（2026-11-14 18:10–18:13）

凭据**按引用**读 `~/.config/hub-memory-mcp/env` 的 `HUB_TOKEN`（脚本里不出现值、不打印值）：

```
cd backend && ./node_modules/.bin/vitest run --config vitest.manual.config.ts
  → 2 passed，EXIT=0
```

输出（原文，token 只报长度）：

```
base = https://jarvis.kentonnie.top/v1
credential = present via /Users/cpuser/.config/hub-memory-mcp/env#HUB_TOKEN (len=64)
probe /health = true                       ← 层 1：免鉴权探测
wrong token → HubAuthError 401             ← 层 4 的反面：错 token 被单独识别成鉴权错误
search entries = 3                         ← 层 2：带对 token 真回条目
  coder     bot-coder-use-pnpm-test
  coder     bot-coder-dsh-git-push-credential-helper
  scribbler bot-scribbler-tone-concise-no-padding
consolidate = {"facts":0,"merged":0,"superseded":0,"dryRun":true,"candidates":0}
  ↑ dryRun=true：中枢只出了计划（candidates=0），没有写库   ← 层 3：如实是计划
```

**端到端（宿主机真实 `pickMemoryPort` + 真实凭据引用）**：

```
[memory] recall mode=hub chars=332 taken=["bot-coder-use-pnpm-test","bot-coder-dsh-git-push-credential-helper"]
recall chars = 373
recall head = 队伍记得这些（…）：| - 用户的固定要求：跑测试用 `pnpm test`，不要用 `npm test`… [coder]…
```

判据不是「请求没报错」，而是：**本机账本是空的**（`port.all()` 长度 0），这段注入片段只能来自中枢；
且片段里不含 token。

**token 泄漏检查**：`git diff`、`git status --porcelain`、全仓 `grep -rF "$HUB_TOKEN"` 三处均 0 命中。

---

## 五、仍未闭环的（按 lead 口径如实说明）

1. **生产 `memory.hub` 没填**（`hub: ""`）—— 按「统一上线后验」，本任务不碰生产设置。
   代码就绪，但真实生产进程仍走本机版。
2. **跨设备「上行」未验**：本次证明的是**读取侧**（客户端按凭据从中枢召回真实生产记忆）。
   真正的跨设备写入应由既有 `local_dream` 在本机 author 一条事实 → 上行 → 另一设备召回，
   那属于 local_dream 链路，不在本任务范围。手工 curl 造 hub 记录只算服务端探针，不算跨设备。
3. **`consolidate` 的真实持久化仍是 0**：中枢默认 dry-run，客户端不传 `apply`（不擅加批删）。
   本机侧巩固是真实的（测试里 `facts=1`、账本有行），但「中枢侧合并近似重复」还没发生。
   这是服务端产品决策，已另派 `ds-hub-server-fix-max`。
4. **凭据权限过大**：`HUB_TOKEN` 是 admin 全库 token。兼容面的租户隔离在**服务端强制**
   （只出 `dsh-memory/bot` 与 `bot/*`），所以链路本身不越界；但凭据本身没有 per-namespace scope。
   建受限 token 属 Hub 新功能，不在本任务。
5. **服务端 `POST /v1/memories` 对 node token 开放**（`_is_node_report` 含该路径）——
   任何 node token 都能往 `dsh-memory/bot` 写任意 content，兼容面会把它当 Bot 记忆回给宿主机
   并进 worker 上下文。**这是服务端要收的口子**；客户端侧刻意没加「信任 hub 返回」的旁路，
   加了只会放大它。

---

## 六、交给新 Max 的上线动作（未执行）

```bash
cd backend
pnpm typecheck && pnpm test          # 期望 EXIT=0，113 files / 2022 tests
pnpm build                           # 本任务按要求未 build lib
```

面板填（管理页 → 记忆中枢）：

- 中枢地址：`https://jarvis.kentonnie.top/v1`（含 `/v1`；LAN 备选 `http://192.168.31.152:18080/v1`）
- 凭据环境变量名：`HUB_TOKEN`
- 凭据文件：`/Users/cpuser/.config/hub-memory-mcp/env`（0600）
- 或走环境兜底：`DSH_SUPERAGENT_MEMORY_HUB`、`DSH_SUPERAGENT_MEMORY_HUB_TOKEN_ENV`、
  `DSH_SUPERAGENT_MEMORY_HUB_TOKEN_FILE`

上线后验（`GET /orchestrator/api/state`）：

- `health.memory.state` 应为 `ready`，`detail` 说明凭据来自环境还是文件；
- 若出现 `error` + 「中枢拒绝凭据」→ 凭据引用指错了（看 `detail` 里的 `problem`）；
- 日志里应看到 `[memory] hub 鉴权就绪 via file` 与 `[memory] recall mode=hub …`，
  不再有「hub reached」后紧跟全量降级的组合。

#24 **保持 open**，直到生产部署后真实客户端跨设备搜索与 consolidate 都验过。
