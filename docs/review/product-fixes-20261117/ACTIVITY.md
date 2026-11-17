# 轻量活动与出站类型（task-15）

实现落在 `backend/`。契约见 `CONTRACT.md`「状态协议」，评审问题见
`../product-ux-20261116/REVIEW.md` P0-1 / P0-2。

## 为什么要这两件事

手机主屏此前有两处说不清：

1. **接手回执被显示成「已回复」**。队伍回一句「收到」也算答过，于是消息立刻变成已答复，
   中间真正在算、在跑工具的那段完全没有展示窗口。消费方只能拿「最后一条日志」冒充
   「正在思考」——那是最不可能是真状态的一种猜法。
2. **评估阶段没有投影**。消息被读走、线程正在判断、还没形成工单时，界面只能显示 `unknown`。

根因都在写入侧缺一个字段：出站消息没有类型，队列没有把 `request_id` 带出来，
活动没有从真实会话事件投影。

## 一、出站类型（`kind`）

`OutboundMessage.kind` 是 `'acknowledgement' | 'reply' | 'notice'`，一路传到手机：

```
core/ports.ts OutboundMessage.kind
  → sources/mobile.ts · sources/team.ts   reply ... --kind <kind>
  → tools/mobileq    replies.kind (TEXT, NULL 允许)
  → tools/mobilegw   /timeline agent 条目 reply_kind
  → app/mobile-http.ts isFinalReply / isLegacyReply
```

- **列是 `kind TEXT`，允许 NULL**，迁移走 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`，
  老库打开即补列，不动已有行。
- **NULL 就是「类型未知」，不回填推断值。** 没有类型时，一句回执和一句答复长得一模一样，
  「大概算答复」正是 P0-1 的根因。这类行仍原样出现在时间线上（正文照常可读），只是
  不把消息收据推向 `replied`。
- 只有**显式 `reply`** 才算最终答复（`isFinalReply`）。`acknowledgement` / `notice` 不终结
  消息状态，所以那段执行活动有展示窗口。
- `mobileq reply --kind` 用 `choices` 白名单，非法值**写之前**就拒（退出码 2，不留半条记录）。
  省略 `--kind` 仍合法，落 NULL——SDK/手动 CLI 的老写入口径不变。
- 存量补齐由部署期脚本按 `outbox.id` == `replies.rkey` 精确匹配（`outbox` 表里 receipt 是
  完整的 `OutboundMessage`，带 `kind`）；匹配不上的继续表示未知。

## 二、`request_id` 关联

`/activity` 的 `items[].request_id` 恒为**用户消息自己的 request_id**（客户端幂等键），
不是 Trigger id、不是消息 id。

- `tools/mobileq pull` 输出 `messages.request_id`；
- `sources/mobile.ts` / `sources/team.ts` 把它放进 `Trigger.meta.request_id`；
- 网关新增 `GET /meta`，只回 `id / request_id / read_at / root / answered / acknowledged`，
  **不含正文**。轻量端点因此不必为了一个关联键去拉整份时间线。
- `&row=<n>` 可点名要行：活跃票的队列行（可能远在最近窗口之外）与正在评估的行都点名，
  所以「更早但仍活跃」的任务不会因为不在最近 N 条里而从快照消失。总量有界（点名 200 +
  最近 50），不是全历史扫描。

## 三、`activity` 投影

**不重新实现原生解析。** `app/native-activity.ts`（Root）负责把 Session 事件
（`turn/start`、`step/start`、`tool/call`、`tool/result`、`assistant/message`、`llm/retry*`、
`step/end`、`turn/end`）投影成 `NativeActivity`；`app/activity.ts` 只做接线：

```ts
wireActivity({ stage?, evaluating?, native? }): Activity | undefined
activityFrom(tracker, facts, options): Activity | undefined
```

优先级：**结束 > 等人 > 评估 > 原生（重试 > 工具 > 模型 > 空闲）**。

- `ended` / `waiting_for_person` 来自持久阶段（`ticketStage`），压过易失事件：
  已经结束了，最后一条工具调用改不了这件事。
- **阶段改写 kind 时只有同 kind 才携带**原生的 `label` / `since` / `at`。`kind` 说「在等人」
  而 `label` 说「模型处理中」是假状态，比不写更糟。
- `evaluating` 来自 `thread.evaluating`（`Evaluation.startedAt` / `delivered`）——持久事实，
  不靠 trigger id 猜。评估阶段不携带工具/模型的 label：那时还没有工具在跑。
- 读活动抛错 → `{ kind: 'unknown', label: '执行状态读取失败' }`，**不造时间**；
  tracker 缺席 → `undefined`（没有证据就不画状态），不写 `unknown` 假状态。
- `label` 是白名单短词（`toolActivityLabel`），只由工具名查得，**不含参数、路径、命令、
  推理文本**。未知工具名一律「执行工具」，并行 ≥2 个是「并行执行工具」。

## 四、`GET /api/mobile/activity`

轻量快照，**不拉全量时间线**：

```json
{ "session_id": "main", "session_api": 1, "state": "live", "at": "2026-11-17T07:00:00.000Z",
  "items": [{ "request_id": "…", "request_state": "processing", "ticket_ref": "tk-…",
              "activity": { "kind": "tool", "since": "…", "at": "…", "label": "读取文件" } }] }
```

- `at` = 快照时间；`activity.since` = 当前活动起点；`activity.at` = 最近一条参与投影的事件时间。
- `request_state` 与 timeline **同源同值**：两处都过 `withRequestStates`，都走
  `latestDecisions` 选「同一行上时间最靠后的那条决定」。所以 `processing` / `waiting_for_person`
  / `finished` 不会一边说 A 一边说 B，后来的 `ignore` / `stop` 也不会被旧 `accept` 顶掉。
- 决定按行**精确查**（`store.decisions.byThread('team:<session>:<row>')`，main 另认历史两段 key），
  不截「最近 200 条」——更早但仍活跃的任务不该消失。
- 活跃集合来自 `store.tickets.active()` / `open()`（索引投影）与 `store.threads.active()`。

### 错误语义（客户端据此分档）

| 情况 | 应答 | 客户端处理 |
|---|---|---|
| 宿主没接活动投影 | `501 {"error":"Activity is unavailable","code":"activity_unsupported"}` | 记 unsupported，退回慢速时间线 |
| 网关没有 `/meta`（老版本） | 同上 501 | 同上 |
| 路由未注册 | 兜底 `404 {"error":"Not found"}`（无 `code`） | 同上 |
| 显式非 main 会话但网关无能力位 | `409 {"error":"unsupported_session"}` | 可恢复，不清事实 |
| 网关回的 `session_id` 不符 | `502 {"error":…,"code":"session_mismatch"}` | 可恢复 |
| `/meta` 形状坏掉（`items` 非数组） | `502 {"error":…,"code":"malformed_meta"}` | **不清 overlay** |
| 暂时不可用 | `502 {"error":"Activity is temporarily unavailable"}` | 可恢复 |
| 没配对凭据 | `503 {"error":"Mobile transport is not configured"}` | 提示重新配对 |
| 会话非法 | `400 {"error":"invalid_session",…}` | 请求写错，不重试 |

`items` 是**全活跃集合**：200 之后不在其中的 `request_id`，客户端应清掉它的活动 overlay；
非 200 一律不清。`request_state` 这类收据以 timeline 为准。

## 五、`tasks[].approval`（可选）

只标**真实 `pendingApproval`**，来自 `ticket.attention.presentation`；普通问答（human_action /
human_options）不塞 approval。旧卡可从 `pending.kind` 推 `kind`。`answer` 的宿主侧成功
union 已容纳 `'reply'`（普通 worker 待答），旧客户端只读 `ok`，多一个取值不影响它。

## 六、验证

| 证据 | 覆盖 |
|---|---|
| `tests/activity.spec.ts`（18） | 只有显式 `reply` 算最终答复、legacy 不宣称已回复、`evaluating` 来自持久事实、快照与 timeline 同源（processing/person/finished）、`request_id` 是用户消息的、`&row=` 点名老活跃、后到 ignore 不被旧 accept 顶掉、坏应答 502 带 code 不冒充空集合、409/502/501 三档、阶段改写不携带别种活动的 label、读活动出错给 unknown 不造时间 |
| `tests/mobileq.spec.ts`（6，真 SQLite + 真 `mobilegw` 进程） | `--kind` 落库、省略保持 NULL、非法类型写前拒且不留半条、`/timeline` 只给已标类型的 `reply_kind`、`/meta` 无正文且会话不串线、`&row=` 带回最近窗口之外的老行 |
| `tests/mobile-http.spec.ts` / `mobile-work.spec.ts` / `team.spec.ts` / `outbox.spec.ts`（111） | 既有路由与收据口径不回归 |
| `pnpm typecheck` | 我的域 0 错 |

失败的既有断言（`mobile-work.spec.ts` 三处）已按新语义改写夹具：显式标 `reply_kind: 'reply'`。
原来那三条之所以能过，正因为缺省被当成答复——那是被本次修复掉的根因，不是被放宽的断言。
