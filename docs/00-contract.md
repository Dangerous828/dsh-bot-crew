# 00 · 消息面契约

> 本文件只定义**前后台之间线上跑的字节**，不定义任何一方的内部状态。
> 状态主体在后台（Ticket）；本契约里出现的 `ticket_id` 只是给前台展示用的**只读引用**，前台不得据此维护自己的任务账。

## 1. 三个角色

| 角色 | 在哪 | 职责 |
| --- | --- | --- |
| 消息面（前台） | 手机 / 网页 / IM | 收发消息、展示 Bot 名单与状态、把人的话送进来、把回话显示出去 |
| 适配层（本仓库） | `team` Source + timeline/send HTTP | 消息 ↔ Trigger 翻译、botId 与记忆的注入/回写 |
| 后台 | dsh-superagent Engine | Gate / Eval / Mandate / Ticket / Assignment / Outbox，唯一真源 |

## 2. Bot 目录（前台展示 + 后台路由共用）

```jsonc
{
  "bots": [
    {
      "bot_id": "lead",                 // 稳定 id，[a-z0-9_-]
      "name": "大哥",
      "role": "default",               // default | member
      "persona": "简练、先应一声、能转派就转派",
      "avatar": "lead.png",
      "color": "#...",
      "memory_namespace": "bot/lead"  // 记忆桥用，见 02
    }
  ],
  "default_bot_id": "lead"             // 全表有且只有一个 role=default
}
```

规则：
- 全表**有且只有一个** `role: "default"`；启动时校验，重复或缺失直接拒绝加载。
- Bot 是身份与呈现，**不是 Agent**：一个 Bot 不对应一个 Orchestrator Session，不持有任务状态。
- 增删 Bot 不改变任何 Ticket；`bot_id` 一旦被 Ticket 引用过就不可复用（改名可以，换 id 不行）。
- 手机面可以读写花名册：`GET /api/mobile/bots` 返回 `{bots:[{bot_id,name,role}]}`；
  `POST /api/mobile/bots` 接收 `{bot_id,name,role?,persona?}`。队里没有 default 时，新加的这位顶上，
  这样一份「有 Bot 没 default」的坏配置能在手机上自愈。

## 3. 入站：`POST /send`

```jsonc
{
  "request_id": "uuid-v4",        // 必填；重试必须沿用同一个值
  "conversation": "group-ops",    // 群 / 私聊 / IM 会话的稳定标识
  "thread": "t-42",               // 可选；同会话内的话题串
  "sender": { "id": "u-1", "bot": false },
  "mentions": ["lead"],           // @ 到的 bot_id，可为空数组
  "text": "大哥，看下这周的日志",
  "at": "2026-11-08T23:00:00+08:00",
  "url": "https://..."            // 可选，消息深链
}
```

成功：`200 {"ok":true,"id":"<message-id>","request_id":"<同值>"}`
错误：`{ "error": "<code>" }`，码表见 §6。

### 路由判定（确定性，不由模型决定）

| 条件 | 结果 |
| --- | --- |
| `mentions` 含已知 `bot_id` | 目标 Bot = 第一个已知的 `bot_id`；`addressed = "mention"` |
| `mentions` 为空，且 `conversation` 是私聊 | 目标 Bot = `default_bot_id`；`addressed = "direct"` |
| `mentions` 为空，且是群聊 | 目标 Bot = `default_bot_id`；`addressed = "mention"`（大哥默认接话；若 Bot 自身发言，`addressed` 省略） |
| `mentions` 全是未知 id | 目标 Bot = `default_bot_id`，并在 `meta` 记 `unknown_mentions` |

### 已定：群聊无人 @ 时，大哥接话

选「大哥默认接话」，不选「只在有人叫时才开口」。理由是后者要人多打一个 `@` 才能说上一句话，
那就不像一个队伍，像一个命令行。代价是可能话痨，用两条已有的东西兜住：

- Policy 的 `eval.mode` 默认 `observe`，它不主动多说话；
- 每条回复都署名，话痨一眼看得出来是谁；点一下芯片就能换人。

极端情况下想让它闭嘴，把 `source:team` 的 `default_bot_id` 指到一个只会简短应答的 Bot 即可，
不需要改代码。

### 映射到后台 Trigger

```jsonc
{
  "id": "team:<message-id>",                       // 幂等键
  "source": "team",
  "threads": [{ "source": "team", "id": "<conversation>:<thread|message-id>" }],
  "actor":  { "source": "team", "id": "<sender.id>" },
  "human":  true,                                  // sender.bot=true 时为 false
  "addressed": "mention",
  "at": "<at>",
  "text": "<text>",
  "channel": {
    "source": "team",
    "thread": "team:<conversation>:<thread|message-id>",
    "address": { "conversation": "<conversation>", "message": "<message-id>", "bot_id": "<目标 bot_id>" }
  },
  "meta": {
    "bot_id": "<目标 bot_id>",
    "mentions": ["..."],
    "unknown_mentions": ["..."],
    "conversation": "<conversation>",
    "root": "<thread|message-id>"
  }
}
```

- `meta.bot_id` 是**注入给 worker 的呈现参数**（人格提示词、记忆 namespace、回话署名），不参与 Gate 与 Mandate。
- 授权仍走后台：`SourcePolicyPart.allowed` 管谁能派活，admission rows 管群/私聊的接收范围，`observe` 先只记 `would accept`。
- 大哥转派 = 后台 hand back 后重新 Eval；拉人讨论 = subscription fan-out。两者都不产生第二张账。

## 4. 出站：Outbox → 回写

后台 `OutboundMessage` 的 `kind` 只有三种：`acknowledgement` / `reply` / `notice`，全部经 `SourceChannel.send` 发出（幂等，按 message id 去重；返回 `gone` 表示会话不可再回）。

前台 timeline 项：

```jsonc
{
  "id": "...",
  "role": "bot",                 // bot | user | system
  "bot_id": "lead",              // 回话署名，取自 channel.address.bot_id
  "text": "收到，我看一下",
  "at": "...",
  "request_id": "...",           // 可选，关联原请求
  "kind": "acknowledgement",     // 可选
  "ticket_ref": "..."            // 可选，只读展示；前台不得据此改状态
}
```

## 5. `GET /timeline`

```jsonc
{
  "items": [ /* 上面的 timeline 项 */ ],
  "tasks":  [ /* 后台 Ticket 的只读投影，字段由后台给什么就展示什么 */ ],
  "queued": [ "request_id" ],      // 已接受、还没有回复、仍可尝试撤回的消息
  "declined": [                    // 后台看过并决定不动手的消息，带一句理由
    { "request_id": "...", "reason": "..." }
  ],
  "status": { "runtime": "observe|auto|off", "mobile": "on|off", "paused": false }
}
```

- 页面 `stop` 时不轮询；不强制每条更新滚到底；未知字段必须保留、不得丢弃。
- **未实现的审批能力不得虚构按钮或审批状态**。
- 被撤回的消息不出现在 `items`，也不出现在 `queued`。

### 等你决定：`tasks[].needs_person` · `question` · `options`

后台卡在等某个人拍板时，`tasks` 里那一项除了 `needs_person`（`stage.action`，取值
`delivery` / `answer` / `review` / `blocked` / `failed`）还会带上它当前在等的那句问题，
以及这句话的备选答案 —— 画板上那条「等你决定」卡里的 A/B 就是从这儿来的：

```jsonc
{
  "id": "tk-1",
  "state": "person",              // 阶段（person / working / idle）或终态 outcome
  "needs_person": "answer",       // 等你做的是哪一类：delivery | answer | review | blocked | failed
  "question": "付款条款对不上。合同第 4 条写 30/70，客户 11 点的邮件说 50/50。两条路：按合同回，或者我改合同。",
  "options": [                    // 可选；只在有 question 时出现
    { "id": "contract-30-70", "label": "按合同 30/70 回客户" },
    { "id": "accept-50-50", "label": "接受 50/50，我改合同" }
  ]
}
```

- `question` / `options` 是**同一条**工单待人工决定的问题；没有这个问题（`delivery` / `review` /
  `blocked` / `failed` 这几种「等你」）时两个字段都不出现，前端只能说「为什么在等」，不得补一个空问题。
- `options` 有且只有 2–4 条：`id` 在同一问题内唯一且稳定（[a-z0-9_-]{1,40}），`label` 是一句给人看的话（≤80 字）。
  **缺省表示只有一个自写框** —— 前端不得自己编 A/B，也不得把 `question` 拆成选项。
- 选项只是呈现，不是审批：回答仍走 §3 的 `POST /send`，`text` 里带上选中的 `label`
  （前端可以前加 `@bot_id` 让它路由到那位 Bot）。网关不解析选项，也没有单独的「选选项」路由或字段；
  撤回、排队、幂等全部按这条普通消息的规则算。
- 问题被换掉（文本或选项不同）时后台重新下发整组 `options`，旧的一组随即作废；工单结束、
  `human_action: null` 或 `ready` 报告清空问题，`question` 与 `options` 一起消失。
  前端以最新一次时间线为准，不缓存旧选项。

### 撤回排队消息：`POST /api/mobile/withdraw`

```jsonc
{ "request_id": "uuid-v4" }        // 必填，与 /send 用的是同一个值
```

成功：`200 {"ok":true,"id":"<message-id>","request_id":"<同值>"}`。
撤回后这条消息从 `GET /timeline` 的 `items` 消失，`queued` 也不再包含它。

失败（错误体与 §6 一致，客户端只展示文本）：

| HTTP | 何时 | `error` 文本 |
| --- | --- | --- |
| 400 | 缺 `request_id`、不是字符串、为空或超过 128 字符 | `request_id is required` |
| 404 | 这个对话里没有该 `request_id` | `no such message` |
| 409 | 已经回复 / 已被 worker 读走 / 已经撤回过 | `message was already answered` / `message was already picked up` / `message already withdrawn` |
| 401 · 502 · 503 | 与其余消息面路由相同（未认证 / 后台不可用 / 暂停或过载） | — |

判定规则：

- 可撤回 = **尚未被回复**（没有 reply 挂在消息下）**且尚未被读走**（队列 `pull` 还没把它交给任何 Source）。
- 已经进入 worker 的消息不允许删除：后台可能正在做这件事，删掉会让界面与后台的账分叉。网关返回 409，不静默成功。
- 撤回是标记而不是物理删除：`request_id` 仍被占用，之后用同一个 `request_id` 重发不会把消息复活
  （同文返回首次结果，异文仍按 §6 的 `conflict` 拒绝）。
- 客户端展示的撤回入口可以按时间窗先收窄，但最终以网关判定为准；收到 409 时应刷新时间线，而不是假定撤回成功。

## 5.1 `GET /api/mobile/screen?ticket=<id>`

「看它的屏幕」返回的是这张工单的**会话活动快照**，不是像素截帧：worker 跑的是终端与文件活，
有信息量的是它刚执行了什么命令、输出了什么、说了什么。像素画面将来若接，是另一种 `kind`，
这里的状态与 `reason` 不变。

```jsonc
{
  "state": "live",             // live | unavailable
  "kind": "terminal",
  "ticket_id": "tk-1",
  "live": true,
  "at": "2026-11-10T15:02:11.000Z",   // 最后一条活动的时间
  "cwd": "/Users/me/Code/dsh-bot-crew",
  "lines": [
    { "at": "...", "kind": "command", "text": "$ pnpm test" },
    { "at": "...", "kind": "output",  "text": "1429 passed" },
    { "at": "...", "kind": "said",    "text": "看完了" },
    { "at": "...", "kind": "status",  "text": "这一轮结束" }
  ]
}
```

- `kind` 只有 `command` / `output` / `said` / `status` 四种；`output` 与 `said` 的区别是
  「命令的输出」还是「它自己说的话」。
- 只取最近的活动（默认 120 条），单行超过 500 字符截断；命令与输出里的
  `KEY=value`、`TOKEN: value`、`Bearer xxx` 一律掩码成 `***` 再下发。
- 没有票号、没有会话、会话里没有可显示的事件时返回 `state: "unavailable"` 与一句真实
  `reason`（例如「这张工单还没有可读的执行记录」）。不得用「在加载」或空数组冒充有画面。
- 认证与其余 `/api/mobile/*` 相同；局域网与中转隧道都走同一道门。

## 5.2 模型：`GET /api/mobile/models` · `GET /api/mobile/efforts` · `POST /api/mobile/model`

```jsonc
// GET /api/mobile/models
{
  "current": { "provider": "magpie", "model": "workbuddy/deepseek-v4.1-flash" },
  "bot_models": { "coder": { "provider": "magpie", "model": "workbuddy/glm-5.3", "reasoningEffort": "high" } },
  "providers": [ { "id": "...", "name": "...", "models": [ { "id": "...", "name": "...", "description": "..." } ] } ],
  "failures": [ { "id": "...", "name": "..." } ]
}
```

- `current` 是全场默认；`bot_models` 是每位成员自己的路由，缺省表示跟随全员。
- `providers` 只列读得出来的模型；`failures` 只列名字，不把内网地址或凭据带上屏。

```jsonc
// GET /api/mobile/efforts?provider=<id>&model=<id>
{ "efforts": [ { "id": "off", "name": "Off" }, { "id": "high", "name": "High", "description": "..." } ], "default": "low" }
```

- 档位由适配器现查；这条路由不支持就是空数组，不编一列猜测值。

```jsonc
// POST /api/mobile/model
{ "provider": "<id>", "model": "<id>", "reasoningEffort": "high", "bot_id": "coder" }
```

- 带 `bot_id` 时只改这位成员的模型；不带则是全场默认。`bot_id` 必须是花名册里存在的 id。
- 成员提交 `model: ""`（provider 可为空）表示删掉成员自己的路由，回到全场默认；
  全场默认不允许提交空模型。
- 换模型沿用旧值未显式给出的 `reasoningEffort`；路由由 `Settings.save` 在落盘前验证。

## 5.3 插队：`POST /api/mobile/steer`

把一条**还在排队**的消息直接交给正在跑的 worker：它在下一步边界先读到这句，不等队列轮询；
当前正在执行的命令不会被中断。

```jsonc
{ "ticket": "tk-1", "request_id": "uuid-v4", "text": "可选：新写的一句" }
```

- 带 `text`：**发送即插队**。这句先以「已读」写进网关时间线（路由不会再当新活接一遍），
  再 steer 给 worker；返回 `{"ok":true,...}`。
- 不带 `text`：针对队列里已有的那条 `request_id`，先 claim（标记读走）再 steer；两个都必填。

成功：`200 {"ok":true,"ticket":"tk-1","request_id":"uuid-v4"}`。

判定与顺序：

- 工单必须仍在跑；已结束/不存在 → 409 `Ticket is not running`。
- 先从网关队列**认领**这条消息（标记读走）。认领成功才说明它还没被路由读过，因此不会送两遍；
  认领失败原样透传网关的 404 / 409（`no such message` / `message was already answered` /
  `message was already picked up`）。
- 认领后把它作为 steer 投递给 `worker-<ticket>`，消息前会加一句「主人插话（请优先处理…）」。
- 已回复、已被读走、已撤回过都不能插队，返回 409 并提示刷新时间线。

## 6. 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `bad_request` | 400 | 缺字段 / 格式错 |
| `unauthorized` | 401 | 未通过宿主已认证入口 |
| `not_found` | 404 | 指定的 `request_id`（或工单）不存在 |
| `conflict` | 409 | `request_id` 已存在且内容不同；撤回时消息已回复、已被读走或已经撤回过 |
| `too_large` | 413 | 正文超限 |
| `upstream` | 502 | 后台不可用 |
| `unavailable` | 503 | 暂停 / 过载 |

`request_id` 相同且内容相同的重发直接返回首次结果（幂等），不入队第二次。

实现里的错误体是 `{ "error": "<可读文本>" }`，上表是它按语义应归的类；客户端只展示文本，不解析码。

## 7. 认证边界

- `/api` 下挂宿主已认证入口，复用宿主登录 / relay 身份；**不新增无鉴权路由**。
- **唯一的例外是首次配对**：`POST /api/mobile/pair` 在设备还没有凭据时放行，凭据就是那支
  5 分钟有效的配对码；按来源网段限速（IPv4 /24、IPv6 /64，每 60 秒 20 次），超过返回 429。
  其余 `/api/mobile/*` 一律要设备凭据。
- **局域网与中转隧道是同一道门**：两条入口都调用 `phone-gate.ts` 的判定。中转本身不持有设备表，
  它转来的请求也必须带 `x-crew-device` + `x-crew-credential`，否则宿主返回 401。
- 不把网关凭据当宿主凭据，不把凭据下发给任何 Bot。

## 8. 表层来源

上述 timeline/send 形状、`request_id` 幂等与错误码，参照 BotHarness/DeepSeekBot（MIT）的消息面表层，以及本机既有的同源 `/api/mobile/*` 契约；只取字段形状，不取其 Assignment / Inbox / humanAttention 等状态字段。详见 `THIRD_PARTY_NOTICES.md`。
