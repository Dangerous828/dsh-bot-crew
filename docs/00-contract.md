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
  "status": { "runtime": "observe|auto|off", "mobile": "on|off", "paused": false }
}
```

- 页面 `stop` 时不轮询；不强制每条更新滚到底；未知字段必须保留、不得丢弃。
- **未实现的审批能力不得虚构按钮或审批状态**。

## 6. 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `bad_request` | 400 | 缺字段 / 格式错 |
| `unauthorized` | 401 | 未通过宿主已认证入口 |
| `conflict` | 409 | `request_id` 已存在且内容不同 |
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
