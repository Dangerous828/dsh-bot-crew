# 审批归属与可读确认（task-14）

实现落在 `backend/`。契约见 `CONTRACT.md`「审批投影」，评审问题见
`../product-ux-20261116/REVIEW.md` P1-06。三个根因各自归位，没有一处靠「放宽检查」了事。

## 一、正常回报不再被误送审批（归属）

**现象**：票来自 `team/main/82`、`human=true`、Bot=`lead`；worker 用
`channel=main, to=m82` 回话（`bot_id` 未填，schema 里它是可选的），却被记成一次待批的写。

**根因**：`isTicketMessageReply` 拿 `origin.bot_id` 与 `call.bot_id` 严格相等，
缺值 `undefined === 'lead'` 不成立 —— 判定条件把「可选参数」当成了「没有身份」。

**修法**（`runtime.ts`）：身份先解析再比对。

- `ticketBot()`：从来源 Trigger 的 `channel.address.bot_id` 取，取不到再看票的 Channels。
  票本身没有 Bot 字段（署名一直写在 Channel 里）。
- `isTicketMessageReply`：`sender = call.bot_id ?? ticketBot(ticket)`，然后比对
  `trigger.channel.address.bot_id === sender`。
- 两张形态各自保留：显式传了**别的** Bot 名 → 不匹配 → 照旧出卡（冒充拦截没有松）；
  别的收件人、别的会话、别的来源，各自独立判定，没有一条被这次修改合并掉。

### 署名要真的落成，不能只靠放行

只放宽 guard 会留下一个更坏的洞：审批放行了，实际 `send_message` 仍然不带 `bot_id`，
队列按自己的默认署名 —— 判定说「以 lead 回话」，落库却是别人。

SDK 在 dispatch 前对参数做 `snapshotJsonValue` + `deepFreeze`
（`@deepseek-ai/dsh-tools/lib/index.js` 的 `createExecution`），所以**不能就地补字段**。
现在：

- `connections.ts:signMessageCall(args, bot)` 返回一份**拷贝**，只补缺失的 `bot_id`；
  显式给了就原样返回（那是一次「以别人的身份说话」，判定要看得见）。
- `connections.ts:connectionOfCall(config, name)` 精确切出「哪条连接上的哪个工具」，
  签名与署名都只对 `kind === 'messages' && tool === 'send_message'` 生效 ——
  别的服务碰巧有同名工具时，不会被塞一个它不认的字段。
- `runtime.ts:guardConnection` 用 `signed`（规范化后的那一份）算 `signature`，
  也用它做回复归属判定：**审批签名与真实执行参数是同一份**。
- `runtime.ts:signConnectionCall(ticketId, name, args)` + `botOfTicket(ticketId)` 是
  给 worker 作用域同名 wrapper 的公开入口（wrapper 在 `sessions.ts`，Root 接线）。
  wrapper 把 `signConnectionCall` 的结果交给原 MCP tool 执行，于是真实落库的署名
  就是本票的 Bot。

## 二、问题卡不再显示工具协议（呈现）

**现象**：卡上直接是 `mcp_messages_send_message({channel,to,text...})`，带字面 `\n`、
Markdown 星号、本地路径，正文占满屏。

**根因**：`JSON.stringify(args).slice(0, 500)` 被拼进了 `approvalPrompt` 的标题里。
序列化把换行变成 `\n`，截断把消息切在半句上。

**修法**：

- `core/model.ts` 新增 `Attention.presentation?: ApprovalPresentation`
  （`kind: 'connection' | 'task'`，可选 `action` / `target` / `preview` / `details`）。
  字段全可选，旧数据处理与旧协议消费方不受影响。
- `approval.ts:presentCall()`：从**有类型的字段**取正文（`text`/`body`/`content`/…），
  完整保留真实换行 —— 不截断、不反转义、不替换反斜杠。其余参数逐字段按名脱敏
  （`token|password|credential|authorization|secret|api_key|cookie`）后进 `details`，
  默认折叠。同会话的收件人写成「当前对话」，别让人猜 `main/m82` 是哪。
- `approval.ts:connectionPrompt()`：`question` 只由人话组成
  （`要发送这条消息给「当前对话」吗？`），工具名与参数不进正文。
- 任务审批同样带 `kind: 'task'` 的 presentation。

**取舍**：`preview` 宁可长，也不截断 —— 让人批准一段自己没看全的内容，
比多占一屏更糟。折叠是客户端的事（`details`），服务端只负责给全。

## 三、取消这一次 ≠ 停整票

**现象**：连接写审批沿用「做吧／先别做／换个做法」，选 stop 调到 `stopTicket`，
作用于整张票。用户面对一条发送动作，从「先别做」看不出整个任务会结束。

**修法**（`runtime.ts:applyApprovalAnswer` + `cancelCall`）：

- 连接审批的 stop 走 `cancelCall`：清 `pendingApproval` / `attention`，写
  `ticket.approvalDenied = { signature, at }`，并**注入一条带因果的 text input**
  （`undelivered` + `deliver`/`start` 唤醒原 worker）—— 否则只清状态会让 worker
  停在已结束的那一轮里永远 idle。票不结束。
- 同一签名再调：`guardConnection` 直接回可读拒绝，**不再出卡**（不会陷入
  同调用无限审批），也不静默执行。参数变了就是新签名，重新问一次。
- 任务审批的 stop 仍然是 `stopTicket`（结束整票）—— 两种后果不同的动作没有被合并。
- 按钮文案各自说出后果：`确认执行这一次` / `取消这一次（任务继续）` / `修改内容`。

### 服务端按 `option.id` 解读

`approval.ts:answerOf(option)` 按 `option.id` 分派（`go`/`stop`/`revise`），
改文案不改行为；老卡没有 id 时回退到词表。`legacyAnswerId()` 只认整套老词
（`做吧`/`先别做`/`换个做法`…），随手一句「随便」不算任何选项 —— 审批入口照旧如实拒绝。

## 四、顺带修掉的死路：普通待答卡

`answerTicket` 之前在没有 `pendingApproval` 时直接回 409，而 `stage.ts` 对**任意**
`ticket.attention` 都判 `action: 'answer'`，Android 对任何非空 `attentionId` 都走
`/answer`。于是 worker 自己的提问在手机上是死路。

现在 `answerTicket` 在这一分支调 `answerQuestion`：把答案当**这位人的一句话**
投给原 worker（与审批批准后同一条 input/唤醒路径），返回 `answer: 'reply'`。
不读 `go/stop/revise`、不把任何选项解释成停票、不新造问答状态机 ——
问题卡由 worker 自己的下一份报告收掉。

## 新增/变更的共享类型

| 位置 | 变化 |
|---|---|
| `core/model.ts` | 新增 `ApprovalPresentation`；`Attention.presentation?`；`Ticket.approvalDenied?` |
| `app/approval.ts` | 新增 `connectionPrompt` / `presentCall` / `answerOf` / `legacyAnswerId`；`approvalPrompt` 带 `presentation`，文案改后果化 |
| `app/connections.ts` | 新增 `signMessageCall` / `connectionOfCall` |
| `app/runtime.ts` | `guardConnection` 改造；新增 `ticketBot` / `botOfTicket` / `signConnectionCall` / `answerQuestion` / `cancelCall`；`answerTicket` 返回增加 `'reply'` |
| `app/mobile-http.ts` | （task-15 落）`PhoneHost.answer` 返回联合加 `'reply'` |
| `integrations/messages-mcp/server.ts` | `send_message` 显式落 `--kind reply`（不经 core Outbox，类型必须在这里写） |
| `app/sessions.ts` | `workOnly` 为 messages 连接的 `send_message` 注册同名 scoped wrapper，把 `signConnectionCall` 的结果交给原 MCP tool（Root 接线） |

全部新增字段可缺省：旧票、旧 App、旧队列数据按原语义继续工作。

## 五、署名在真实 dispatch 上成立

guard 放行只证明「这次调用没被拦」，不证明**执行时带的是谁的身份**。只放宽检查会留下最坏的一种洞：
判定说「以本票 Bot 回话」，落库却是队列默认署名。

`tests/sessions-message-dispatch.spec.ts` 用真 DSH `Context` + 真 `tools` 服务（参数真的经过
`snapshotJsonValue` + `deepFreeze`），注册一个假的 `mcp__messages__send_message`，让真
`Sessions.ensure` 建 worker、真 `workOnly` 装 scoped wrapper，然后从 worker 自己的工具视图
取到**真正会被执行的那一份**：

1. 调用方没写 `bot_id` → 原 MCP `execute` 收到 `bot_id` = 本票的 Bot；
2. 传给原工具的是**新拷贝**（可写），而 SDK 交进来的那份是冻结的（就地改会抛）；
3. 显式写了别的 `bot_id` → 原样保留，不被覆盖成本票 Bot；
4. wrapper 每次执行都**重新解析**当前工具 —— MCP 重连后拿新的那个，不是缓存对象；
5. `Sessions.dispose()` 之后 wrapper 与限制一起撤掉，工具回到原样、不再被署名；
6. 邮件连接上碰巧同名的 `send_message` **不**被塞 `bot_id`，而同一时刻消息连接的那个仍然署名。

反向验证：把 `signConnectionCall` 换成原样返回（即「只放宽 guard、不真署名」），这组测试
3 项转红 —— 它确实咬住了那个洞，不是只跟着实现走。

## 六、历史卡兼容

线上已有的 `b27d050c` 那一类卡是这次改动**之前**存下来的，两个地方都要兼容。

### 1. 签名换了，旧卡还得能用

历史卡的 `pendingApproval.signature` 是按**模型给的原始参数**算的；guard 改成按补好 `bot_id` 的那一份算之后，
两套值不相等。只认新签名，旧卡会变成「谁答都不动」的死卡：人点了「做吧」，guard 依然 ask。

`signatureOfCall(name, config, raw, signed)` 同时给出两套签名，`guardConnection` 三处判定（已取消 / 已批准 /
残留消费）都认这两套。`config` 与 `name` 保持一致：换了连接配置或换了工具名，旧签名照样失效 ——
那是另一次调用，本来就该重新问。

另外把**取消检查放到「正常回报免审批」之前**：取消是对这一次调用的决定，不能被回复豁免悄悄放行。
（之前它在后面，一次被取消的、恰好又是正常回报的调用会被悄声发出去。）

### 2. 旧卡的问题正文不能当主正文

历史 `attention.question` 是 `JSON.stringify(args).slice(0, 500)`，换行变成字面 `\n`，长消息被切在半句上。
`legacyConnectionCard()` 把它投影成人读的一套：

- 主 `question` 是人话（`要发送这条消息给「…」吗？`），旧的 JSON 不在里面；
- 旧原文整段移进折叠的 `details`；
- 按钮**按 id 映射**到新文案（服务端本来就按 id 分派），`attention.id` 与每个 `option.id` 一字不改，
  客户端答 `/answer` 时照旧对得上；
- 正文能**完整**取出（JSON 解析得开、原文以 `}` 收尾、有 `text`）才给 `preview`；
  取不全就**不捏造** `preview`，`details` 里写明「内容不完整，下面只是原始片段」，并提示选「修改内容」重问一次。

判据宁严勿宽：解析得开只说明这一段还成句，不足以证明它就是全部，所以「以 `}` 收尾」是必须满足的那一条。

### 3. 手机能拿到投影

`mobile-http.ts` 的任务投影原先只发 `question` / `options` / `attention_id`，`attention.presentation`
根本没下发 —— 新卡在手机上也看不到正文 preview。现在按契约带 `approval` 字段；旧卡走上面的投影。

## 验证

```
pnpm typecheck                                            # 全绿
pnpm vitest run tests/crew-approval.spec.ts               # 19 passed
pnpm vitest run tests/crew-connections.spec.ts            # 31 passed
pnpm vitest run tests/integrations/messages-mcp.spec.ts   # 12 passed（含 kind='reply' 直读 SQLite）
pnpm vitest run tests/runtime.spec.ts -t 'approval attribution'  # 7 passed
pnpm vitest run tests/sessions-message-dispatch.spec.ts   # 5 passed（真实 dispatch 署名）
pnpm vitest run tests/mobile-http.spec.ts                 # 77 passed（含 approval.preview 与旧卡投影）
```

`runtime.spec.ts` 的定向组用真实 `tools.guard` 回调与真实 store：缺省 `bot_id` 放行、
显式别的 Bot 仍拦、呈现是人话且正文换行完整、取消只作用于这一次且原 worker 收到事实、
同签名不再出卡、改参数重新问、旧卡按老词消费、普通提问走 reply 且不停票、
过期卡与空答复零变更。
