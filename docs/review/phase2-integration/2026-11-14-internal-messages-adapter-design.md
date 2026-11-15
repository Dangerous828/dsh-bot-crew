# 内部 desktop/mobile 消息 adapter —— 薄 Interface 设计（task-2，按用户 22:20 澄清）

日期：2026-11-14 · 角色：`wb2-client-messages`（子委派 task-2，claim rev6）
范围准则（用户明确）：**不接 Telegram/飞书/购物等外部平台、不索外部账号；只处理本人 desktop/mobile 客户端消息，用真实 WorkBuddy DS 与真实既有会话/消息存储。**

---

## 一、先把「真实存储」认准：内部消息有两个客户端可见面（不能合并）

| 面 | 存储 | 生产/消费 | 客户端怎么看见 |
|---|---|---|---|
| **会话面** | `<stateDir>/superagent/mobileq.db` 的 `messages`（client→server）与 `replies`（server→client）两张表 | `mobileq` CLI；mobile Source 只 **pull `messages`**；队伍回话写 `replies` | `/api/mobile/timeline`（经 mobilegw 转发）把两张表按 `at` 合并成聊天条目；desktop 走独立 LAN 监听、phone 走 DSH Connection，同渲染 |
| **通知面** | `pushOutbox`（进程内）+ `KV.notice.seen(deviceId)` 已持久化账本 | `runtime.pushNotice`；`/api/mobile/notices` GET=peek(不删)/POST=ack(只删点名) | 设备通知横幅 / 待发队列；device-persisted ACK（非人眼读过） |

结论：**「回话出现在客户端聊天里」= `replies` 表（`mobileq reply`）**；「设备横幅收到一条提醒」= pushOutbox。两条是不同面，adapter 绝不能用一条冒充另一条。

## 二、既有真实回路已经端到端存在（不用新造）

worker 内置工具 → 真实写回复，整条链在 backend 内、无需外部平台或 MCP connector：

```
Executor Session tool (orchestrator_ack / orchestrator_report …)
  → engine.reply({purpose, ticketId, triggerId, text})      （core/replies.ts，确定性 id 幂等）
  → Outbox.send → sendReplies()                              （app/outbox.ts）
  → Source channel.send = sendMobile                         （sources/mobile.ts）
  → commands.run('mobileq', ['reply','--conversation','--to','--key','--text','--db',<stateDir>/mobileq.db])
  → mobileq.db.replies   (rkey UNIQUE ⇒ 幂等)
  → /api/mobile/timeline 合并 messages+replies → desktop/mobile 聊天可见
```

**这条链不产生 Trigger**：mobile Source 的 `pollQueue` 只 pull `messages WHERE read_at IS NULL`，写 `replies` 不碰 `messages`，所以**不会触发 worker 自循环**。团队 Source（`sendTeam`）同理写 `replies`。

## 三、adapter 要补的真缺口（这才是 task-2 的增量）

既有回路是「worker 对自己这张票 → 回话」。缺的是：**一个连接「用户客户端消息」与「队伍回复」的 adapter，可供 worker 以工具形式读真实会话消息、在既有 connection 审批/批准只执行一次的约束下写一条回复**。落地为：

- **MCP stdio server**（`src/integrations/messages-mcp/server.ts`，可注册进 superagent worker 宿主），其 **store 是真实 `mobileq.db`**（`MESSAGES_MCP_DB` = `<stateDir>/superagent/mobileq.db`），**不是** 上一版的本地 JSON 信箱。
- 工具语义（读/写按 connections 分类）：
  - 读：`list_channels`（`mobileq` 新增 `conversations` 子命令，列 distinct conversation）、`list_messages`（读 timeline/thread）、`get_message`。
  - 写：`send_message`（→ `mobileq reply`，落 `replies` 表，`rkey` 幂等）。
- 审批闸门用**既有** `connections.ts` 的 `allowedTools`/`judgeCall` + `runtime.guardConnection`：读 allow、写 ask；批准只重试同一次调用一次；拒绝则 `pendingApproval` 清空、`replies` 不新增。

## 四、接口冻结（与 wb2-receive）

- 写「会话面回复」：走既有 `sendMobile`→`mobileq reply`；**不新增 backend 路由**，不写 `messages`、不产 Trigger。
- 通知面（可选横幅）：只复用 wb2-receive 的 `pushOutbox`/`noticeId`/`/api/mobile/notices`。若发 internal 横幅，需它在 `Notice.kind` union 加一个 `'internal'` 值（1 处字符串）；不发则零改动。
- 写范围：`backend/src/integrations/**`、`backend/tests/integrations/**`、`docs/review/phase2-integration`、以及为真实读会话给 `backend/tools/mobileq` 加一条只读 `conversations` 子命令。

## 五、验收线（本轮可验 vs 需外部/生产）

**本轮可验（真实本地存储 + 真子进程，不碰生产进程）**：
1. adapter 读真实 `mobileq.db` 的 canary 消息（用 `mobileq inject` 造一条本人/测试频道入站，round-trip 读回）。
2. adapter 写回复落 `replies` 表（真写），`/api/mobile/timeline` 逻辑可读回该回复（用 mobileq `thread`/`outbox` 证明合并可见）。
3. 闸门：`judgeCall` 读 allow、写 ask（readOnly）；批准只执行一次（同一 signature 第二次仍要 ask 之外的新调用被拒/或已消费）。
4. 拒后 `replies` 不新增（真断言行数）。
5. 通知面：验收复用 wb2-receive 的 peek/ack 语义（不重复实现），只写一条引用其测试的交叉断言。
6. **不触发 worker 自循环**：写 reply 后 `messages WHERE read_at IS NULL` 条数不变。

**本轮不做/需 root 统一**：不注册到生产 superagent profile、不重启 dsh/mobilegw、不配生产 connections；MCP 若要挂真 worker 宿主，最终 registration hunk 由 root 统一 review 后落（本轮只证明 stdio 协议 + 真实存储 adapter 本身 + 真实投递链）。

## 六、落地结果（已实现 + 已验，证据见 §七）

实现文件（全部未提交，无 git add/commit）：
- `backend/src/integrations/messages-mcp/server.ts` —— 重写为**真实 `mobileq.db` adapter**（store 由 `MESSAGES_MCP_DB` 指定，无默认 JSON；工具映射到真 `mobileq` CLI）。
- `backend/src/integrations/messages-mcp/messages-mcp` —— 入口注释同步为真实队列用法。
- `backend/tools/mobileq` —— 加两条**只读/写兼容**子命令 `conversations`（distinct 会话）、`timeline`（messages+replies 合并视图，同 `/api/mobile/timeline`），并**根治** `--db` 被 subparser 默认值覆盖的老 bug（subparser `--db` 改 `argparse.SUPPRESS`），使 `mobileq --db X <cmd>` / `mobileq <cmd> --db X` 一致可用；既有 reply/pull/thread/outbox 行为不变（回归绿）。
- `backend/tests/integrations/messages-mcp.spec.ts` —— 真实 mobileq.db 端到端（读 canary / 写 replies / 幂等 / 写不增 messages / 闸门读 allow·写 ask / 拒后不增）。
- `backend/tests/integrations/internal-messages-e2e.spec.ts` —— 真 `Outbox`→真 `sendMobile`→真 CLI→真 db 的投递链（回话落 replies、source off 不写）。
- `backend/docs/007-architecture.md` —— 模块表/测试表两条改为「真实 mobileq.db adapter」。

## 七、验收证据（真实产品存储 vs 未覆盖分开）

**已用真实存储验证（本机 `python3`/`sqlite3`/真 `mobileq` CLI，全部绿）**：
1. adapter 读真实状态库：`--self-check` + `list_channels` 读到 `main`(58)/`work`(9)/`team`(1)。
2. 读 canary：真 CLI `inject` 入站 → adapter `list_messages` 读回同会话。
3. 写回复落 `replies` 表并出现在会话视图（`/api/mobile/timeline` 同源），`rkey` 幂等重复不发两次。
4. 写 reply **不新增 `messages`**（未读 `read_at IS NULL` 条数不变）→ 不触发 worker 自循环。
5. 真投递链：`Outbox.send → sendMobile → mobileq reply` 落真 `replies`（客户端可见），receipt 结算 `sent`；source 未启用 → 停在 outbox、`replies` 不新增。
6. 闸门：`allowedTools/judgeCall` 对真注册工具名 读 allow / 写 ask（readOnly）。

**复用既有生产逻辑、未在本文件重复实现**：审批「批准只执行一次 / 改参数重问 / 改配置吊销 / 子 agent 同闸」由 `tests/runtime.spec.ts` 的 `live MCP connection gate`（真 `Runtime.guardConnection`）覆盖，本轮复跑 4 例绿；adapter 工具名 `mcp__messages__*` 走同一 `mcp__<server>__` 前缀匹配，无需另实现。

**未做/需 root**：未把 adapter 注册进生产 superagent profile（其当前零 `dsh-mcp-client` 行）、未配生产 connections、未重启 dsh/mobilegw；真实手机/桌面 GUI 人工点按验收需 root 部署后由人工执行。全程未提交任何 git。
