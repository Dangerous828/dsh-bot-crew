# 内部 desktop/mobile 消息 adapter —— 独立审核（task-7，wb2-messages-review）

日期：2026-11-14 · 角色：`wb2-messages-review`（独立 review 成员，claim task-7 rev2）
对象：task-2（wb2-client-messages）冻结的 messages-mcp adapter + mobileq 只读子命令 + 两条 integration 测试
范围：仅本人 desktop/mobile 内部消息，不追外部平台/账号（按用户收窄）。

---

## 零、结论先行（阻断 / 无阻断）

- **生产注册无阻断**（源码级）：adapter 是"可注册到 superagent worker 的真 stdio 子进程 adapter"，读放行/写审批闸门在宿主 `runtime.guardConnection` 真接得上，写只落 `replies` 不写 `messages`（无 worker 自循环），`--db` 优先级修复正确。**本结论=源码与真实存储层就绪，不等于已接入**（未注册 profile、未重启、未真机点按）。
- 审计中**命中并已修 3 处真实业务 bug**（adapter/契约层，均非凑绿）：
  1. **P1 派生幂等键按 120 字符截断会撞键 → 静默吞掉回话**（已修 + 测试）。`${channel}:${to}:${text}`.slice(0,120)，两条只在 120 字后才分岔的长回话共用一个 `rkey`，`rkey UNIQUE` 把第二条当重放**丢弃**且仍回 `ok:true`。→ 改 SHA-256 摘要派生键。
  2. **P2 重放/并发同文时 `visible_reply_id` 报 null**（已修 + 测试）。原以"agent 且 text 相等"回找可见回话：幂等重放报 null，并发同文可能指错行。→ 回执改由 `mobileq reply` 按 UNIQUE rkey 精确回 stable id（见 3）。
  3. **P3 返回/查询无界 + get-by-id 窗口误报 + 坏值静默**（本轮按 lead 收口，已修 + 测试）。`list_messages.limit` 无上限且坏值静默回落、`get_message` 用「最近 500」窗口会误报旧 id 不存在、`send_message` 回执重拉整会话、显式同 key 不同正文静默吞新正文。→ limit 明确契约（未传 50/小数取整/超大 500/**显式非法报错不回落**）、`get_message` 走**精确主键** `mobileq get`（无窗口，>500 旧 id 命中、跨会话拒读）、回执按 UNIQUE rkey 回 stable id 并标 **`replayed`**（不假称新正文送达）、正文复用 64KB 传输上限（详见二·3）。
- **2 例测试是空断言，已改实**（P2，收紧而非凑绿）：幂等测试只数行数（看不到"visible id 报 null"）；"拒后不执行"根本没调 adapter（行数天然不变）。
- **全量质量门已收口（最终 freeze）**：worker 给 GO、源码 stable 后我独占跑一次 —— `vitest run` 全 backend（含 untracked）= **124 files / 2155 passed / 0 failed**，`tsc --noEmit` = **0 错**。`docs.spec` 由我补登记、`class-docs.spec` 的 JSDoc 由 wb2-worker-e2e 补齐。

## 一、审了什么（真实命令，非台架）

| 维度 | 方法 | 结果 |
|---|---|---|
| 源码冻结基线 | `sha256sum` 5 文件 vs review-ready 末尾 | **5/5 一致**（server 曾为我修复变更，见下注） |
| 真实库只读 | `mobileq conversations/timeline` 打 `~/.dsh/state/superagent/mobileq.db` | main(58)/work(9)/team(1)；top-level `--db` 与 subcmd `--db` **等价** |
| `--db` SUPPRESS | 两位置各跑一次 | 一致，未回退到 `~/.dsh` 默认库 |
| transport 回归 | `pytest tools/test_mobile_transport.py` | **29 passed**（既有 reply/pull/thread/outbox 不变） |
| adapter 边界 | 只读探针：注入 `' OR 1=1 --` 当 channel、空 channel、负数/超大 limit、缺 channel 的 get_message | 参数化——注入串当**普通会话名**返回 `[]`，无 SQL 拼接；空串/负值被 requireString/守卫挡；超大 limit 只是全取（见二·返还大小） |
| 写路径 | **临时库**（`/tmp` 的 `mobileq.db`，绝不打生产库） | 派生键/SHA 修复前后均见测试 |
| 类型门槛 | `tsc -p tsconfig.json --noEmit` | **0 错** |
| 全量 | `vitest run` | **2147 passed / 3 failed**（3 红全是他成员未登记/未 JSDoc；详见四） |

> 注：review-ready 里 `server.ts` 的 SHA `dc49…b43fe` 是**修复前**基线；我修的 2 处后 SHA 已变。修复仅限 adapter 本 scope，语义=修上面两 bug，未改工具语义/协议/存储方向。

## 二、逐条回答 lead 指定的六个审计点

### 1) CLI 注入 / 任意 DB path 的 scope
- **无命令注入**：`runCli` 用 `spawn(cliPath(), [...args])`，args 是 argv 数组，不经 shell；`channel`/`text`/`to`/`key` 只会成为 `--conversation/--to/--key/--text` 的**值**，不构成额外命令或额外参数。探针把 `' OR 1=1 --` 当 channel 只得到空视图，证实是参数而非拼接。
- **DB path scope**：`MESSAGES_MCP_DB` 决定库；**但生产注册由宿主 env 固定**，worker（模型）拿不到改 env 的入口——db path 是部署面，不进工具入参。`--db` 位置由 `runCli` 固定拼接（顶层 `--db X <cmd>`），worker 无法改。所以"任意 DB path"只在**部署者**手里，对 worker 不可达，符合最小面。（残留：env 可被宿主配置随意设，属部署信任边界，非 worker 面。）
- **CLI 二进制来源**：`MESSAGES_MCP_CLI` env 覆盖 > 仓内 sibling `tools/mobileq` > PATH。同样部署面；`spawn` 失败会 reject（`child.on('error')`）→ 作为 `isError` 回给 worker，不静默。

### 2) 上下文/会话归属（main / work / team）
- `list_channels` 走 `mobileq conversations`（`SELECT conversation … GROUP BY`），如实列真实 `main/work/team`，不猜。
- `list_messages/get_message` 走 `mobileq timeline --conversation`，会话名是**入参**、原样下传，无默认会话硬编码——worker 传 `work` 就读 `work`。**未做** mobile 面 `/api/mobile/timeline` 那套 `session_id` 校验（`SESSION_ID` 正则、`otherSessionRows` 跨会话剔行）——但这里只是**只读列举**，读出的是 `conversation` 列精确匹配的行，不混会话；`get_message` 找不到即报 `isError`，不串会话。**结论：只读面会话归属干净；但不享有消息面的 session_api/非法会话 400 那层防护**（adapter 是给 worker 的工具，不是手机 HTTP 面，二者不同层）。

### 3) 返回大小与 get-by-id —— **本轮按 lead P3 收口（已修）**
- 原状（P3 已实锤）：`list_messages` 的 `limit` 只在正数时 floor，**无上限封顶**且坏值静默回落；`send_message` 回执为回填 `visible_reply_id` **再拉一次整会话 timeline 按 text 找**，O(会话长度)。
- 首轮收口后按 lead 语义再修（**本版为最终 freeze**）：
  - `list_messages.limit` 契约**明确不静默**：**未传**才缺省 50；正整数（小数向下取整得正整数）取 `min(值,500)`；**显式非法值（负数/0/NaN/非数字）抛清楚参数错误**（`isError`），不再悄悄换成 50。超大按文档封顶 500（600 条会话 `limit:9e9` 实测恰 500）。
  - `get_message(id)` **改精确主键查一行**（新 `mobileq get --conversation C --id m<N>|r<N>`，参数化查询、按会话过滤、内部只读，MCP 不暴露 SQL/path）：**不再用「最近 500」窗口**——>500 历史里的旧 id（如 m1）照样命中，绝不误报「不存在」；别的会话的 id 查到 `null`→如实报不存在（会话过滤，不跨会话读）。非法 id（非 `m\d+/r\d+`）在 CLI 直接拒（rc=2），不进 SQL。
  - `send_message` 回执：`mobileq reply` 在 commit 后按 UNIQUE `rkey` 精确 `SELECT id` 回 stable `r<N>`；**显式 rkey 同 key 不同正文**时 `replayed:true` 并回**原有行**（正文仍是旧的），调用方看得见「这是重放、不是新正文送达」——不再静默吞新正文又回 ok 让人以为发了新话。派生键（内容寻址 SHA-256）撞键即同正文，重放语义天然正确。
  - 正文长度：**复用传输面同一条约束** `64*1024` 字节（`mobile-http.ts` send 的 "Message too large"），adapter 更早同口径挡下，**不另立小阈值**；超限如实 `isError`、不落库。
- 测试：`limit` 未传/小数/超大 + 显式非法值报错（负数/0/NaN）、`get` 的 >500 旧 id 命中 + 跨会话 id 拒读、长历史回执 stable id、重放/并发同文、显式同 key 不同正文标 replayed 且库中正文本不变、正文超限不落库，均新增且绿。

### 4) rkey 冲突与重放 —— **本轮实锤并修复**
- 修复前：
  - `mobileq reply` 对同 `rkey` 是 `INSERT … except IntegrityError: pass`——**同 key 不同正文被静默忽略**，只留第一条（实测 `K:first` 后 `K:second` 不落库）。
  - adapter 派生键 `slice(0,120)`：`'main:1:'+200×'A'+"TAIL-A"` 与 `+TAIL-B` 截断后**完全相同** → 第二条业务回话丢失（实测：仅 1 行）。
  - `visible_reply_id` 以 text 回找：重放时报 null。
- 修复后（本 scope）：
  - `derivedKey` = `auto-` + `sha256(channel\0to\0text)[:56]`：长文差异保留、键长受控、形状安全进 CLI argv。
  - `mobileq timeline` 增列 `rkey`；adapter 按 `rkey` 回找可见回话。
  - 验证：同内容重放→同键同 `r1`、仅 1 行；`TAIL-A/TAIL-B`→`r1/r2`、2 行；显式 `key:K` 重放→回 `r1`（此前 null）。
- 语义说明：**"同 key 不同正文=视为重放、不重发"仍是正确契约**（宿主审批签名也按参数算，改正文会重问）。问题只在"缺省 key 撞键误判重放"与"重放无回执"，两点已修。

### 5) stdio 协议
- `initialize` 回 `protocolVersion` 协商（支持 2024-11-05 / 2025-03-26 / 2025-06-18）、`tools.listChanged:false`、serverInfo `messages`；`notifications/initialized` 无 id 静默置位；`ping`→`{}`；`tools/list`；`tools/call` 校验 `params.name`/`arguments`，业务错误包成 `isError:true` 的 text 而不崩进程；行级解析失败回 `-32700`、非对象回 `-32600`、未知方法 `-32601`。**协议实现正确**，我全测均据此跑通（8→9 例）。

### 6) 凭据 / 正文进日志
- adapter 自身**不打印**工具入参/正文/凭据，只在 `runCli` reject 时把 CLI `stderr` 前 300 字塞进 `isError` 回 worker（正文可能出现在 stderr 的 SQL 报错里，属低敏）。adapter 无 token、无凭据。
- 宿主侧：`runtime.guardConnection` 生成审批摘要时对 `token|password|credential|authorization|secret|api_?key` 字段 `[redacted]`，并 slice(0,500)——既有机制，本 adapter 的 `send_message` 参数会进审批摘要（`text/to/key/channel`），**正文会进审批提示**（这是"给人看要发什么"的合理需要），**不是**凭据泄漏。
- 判定：**无凭据泄漏**。正文进审批提示属产品预期；若担心正文进 attention 持久化，属通知面/审批面策略，不在本 adapter 面。

## 三、本 scope 改了哪些（全部未 git）

| 文件 | 改动 | 归属 |
|---|---|---|
| `backend/src/integrations/messages-mcp/server.ts` | 派生键 SHA-256；`send_message` 回执取 reply 的 stable id 并透传 `replayed`；`list_messages.limit` 明确契约（未传 50/小数取整/超大 500/显式非法报错）；`get_message` 走精确主键 `mobileq get`（无窗口）；正文早挡 64KB；`TimelineItem` 加 `rkey`；描述同步 | my scope `backend/src/integrations`（task-2 冻结源码的 review 修复） |
| `backend/tools/mobileq` | 新增只读 `get --conversation --id`（参数化主键、会话过滤、`m\d+/r\d+` 形状约束）；`cmd_reply` commit 后按 UNIQUE rkey 精确回 `id` 且标记 `replayed`；`cmd_timeline` 增列 `rkey`（只读，无任意 SQL/path 暴露） | 真实读/写回执最小改动 |
| `backend/tests/integrations/messages-mcp.spec.ts` | 收紧幂等/拒后；新增长文不撞键、`limit` 边界（未传/小数/超大 + 显式非法报错）、`get` 的 >500 旧 id 命中 + 跨会话拒读、长历史回执 stable id、显式同 key 不同正文标 replayed、正文超限不落库 | my scope `backend/tests/integrations` |
| `backend/docs/007-architecture.md` | 登记 `tests/worker-isolation.spec.ts`、`tests/worker-files.spec.ts`、`src/executor/sandbox.ts`（docs 守卫，均只登记不改他人语义；`worker-search-subprocess` 行本已存在） | 007 登记守卫 |

**未碰**：`runtime.ts/index.ts/kv.ts/mobile-http.ts/push.ts/sessions.ts`（wb2-receive/worker 独占）、`src/executor/*`（wb2-worker-e2e/worker-files 独占）、生产 profile、生产进程、手机。

## 四、测试门槛真实结果（唯一全量质量门，worker 给 GO 后跑一次）

```
vitest run（全 backend，含 untracked）      → 124 files / 2155 passed / 0 failed
tsc -p tsconfig.json --noEmit             → 0 错
vitest run tests/integrations/            → 11 passed（P1/P2/P3 全部对应用例）
pytest tools/test_mobile_transport.py     → 29 passed
```

- 全量由我独占跑一次（不与 wb2-worker-e2e 并发）；其 task-6 真 E2E 在 `backend/tests/worker-runtime/*.e2e.mjs`（**非 `.spec`，不进默认 vitest glob**，故不占本全量），另跑，属它自己的验收。
- 历史：曾 **2147/3**（3 红=他成员未登记/未 JSDoc）。`docs.spec` 我补登记、`class-docs.spec` 的 JSDoc 由 wb2-worker-e2e 补齐后，全量到 **2155/0** 收口。

## 五、最终 prod 受控注册方案（给 lead 合并后的 new-release 成员执行；**本 review 不部署、不重启、不 HMR**）

1. **profile**：只落 **superagent**（当前零 `dsh-mcp-client` 行），**不是 desktop**（desktop 的 5 条 MCP 对生产 worker 无效——已在 issue21 bench §二实证）。desktop 只用于本地演示。
2. **注册 hunk**（`~/.dsh/profiles/superagent/cordis.patch.yml` 顶层数组追加 insert，形同 review-ready §三）：
   ```yaml
   - insert:
       - id: mcp-messages
         name: '@deepseek-ai/dsh-mcp-client'
         config:
           transport: stdio
           serverName: messages                  # → mcp__messages__<tool>
           command: /Users/cpuser/Code/dsh-bot-crew/backend/src/integrations/messages-mcp/messages-mcp
           args: []
           env:
             MESSAGES_MCP_DB: /Users/cpuser/.dsh/state/superagent/mobileq.db   # 必须=该 profile stateDir 下真库
             MESSAGES_MCP_CLI: /Users/cpuser/Code/dsh-bot-crew/backend/tools/mobileq
           toolCallTimeoutMs: 60000
   ```
3. **connections（面板写、`readOnly:true` 保持、读写两列显式写全——reason: 声明任一工具后内置读白名单整批失效）**：
   ```json
   { "readOnly": true,
     "connections": [{ "kind": "messages", "server": "messages",
       "readTools": ["list_channels","list_messages","get_message"],
       "writeTools": ["send_message"] }] }
   ```
4. **生效链**：`sessions.ts:workOnly` 的 `[...WORK_TOOLS, ...allowedTools(connections)].filter(name => agent.ctx.tools.get(name,parent))` —— 只有第 2 步把 `dsh-mcp-client` 真注册进 superagent、宿主真拉起到 stdio 子进程后，`mcp__messages__*` 才会出现在 `ctx.tools`，交集才非空；`judgeCall` 读 allow / 写 ask 在 `runtime.guardConnection`（runtime.ts:857）当场判。
5. **生产验收（必须真机点按，源码层不能替代）**：
   - 受控读：worker 调 `mcp__messages__list_messages` → allow 直接返回真实会话；
   - 获批写：worker 调 `mcp__messages__send_message` → `attention` 审批 → 人工**批准** → 只重试同一次 → 真 `replies` 行 + 桌面/手机聊天可见 + `visible_reply_id` 非 null；
   - 拒绝零写：再发一条 → **拒绝** → `pendingApproval` 清空、`replies` 零新增、客户端无新条。
   - 全程 `messages WHERE read_at IS NULL` 条数不变（不自循环）。
6. **回滚**：删 superagent profile 的 `mcp-messages` insert + 清 panel connections 的 `messages`；不重启则 HMR 生效，`workOnly` 交集复空即收回。

## 六、仍不做 / 边界
- 未注册生产 profile、未配生产 connections、未重启 dsh/mobilegw、未 HMR、未 git、未操作手机（避免与后续安装窗口争用）。
- 未跑 `/build`、未动 desktop 打包、未改 `src/executor/*` 或 `sessions.ts`。
- `visible_reply_id` 依赖 `mobileq timeline` 的 `rkey` 列——**该列是我加在只读视图上的**，若后续有人改 `cmd_timeline` 去掉 `rkey`，`visible_reply_id` 会退化回 null；已在 007 与本文件记录。

## 七、修复后源码 SHA256（最终 freeze，含 P1/P2/P3 与 lead 语义修正，供后续对照）

```
e44149b5139c93ec8a77c188e9055c66d760ff4d632c7c8446b9842198a269cd  backend/src/integrations/messages-mcp/server.ts
5a3a62d0532a0d0eedfe08591b85328f98db5a4e44546b1498689f0c45df67ea  backend/src/integrations/messages-mcp/messages-mcp
d2752dbd27fb456b44238678f4e45b2ee03563c924027decaabe564f83defbb1  backend/tools/mobileq
cac72250d3575fd70f8a6a2a42dc137f0cfe84b4989ece7c2d919e76ebe2b78  backend/tests/integrations/messages-mcp.spec.ts
137122fe25331b87a54667f517cdc31417abc28d6746e7a50f8888bb4a9478a5  backend/tests/integrations/internal-messages-e2e.spec.ts
```

（`server.ts`、`mobileq`、`messages-mcp.spec.ts` 由 review 修复变更；`messages-mcp` 入口与 e2e 测试未变。）



