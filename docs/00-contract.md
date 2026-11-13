# 00 · 消息面契约

> 本文件只定义**前后台之间线上跑的字节**，不定义任何一方的内部状态。
> 状态主体在后台（Ticket）；本契约里出现的 `ticket_id` 只是给前台展示用的**只读引用**，前台不得据此维护自己的任务账。

> **书写约定**：凡写「客户端还没接」「后端还没接入」这类尚未落地的句子，一律用
> `TODO(owner, 日期)` 标出（例如 `TODO(app, 2026-11-12)`），`owner` 写 `app` / `desktop` / `backend` / `gw`。
> 用 `grep -n 'TODO(' docs/00-contract.md` 可一次捞出全部欠账，并按日期核对是否过期；
> 没有这个标记的句子一律按「已实现」读，写之前先确认代码里有。

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

### 队伍配置：`GET/POST /api/mobile/bots`

手机端可写队伍配置：新增 `{bot_id,name,role?,persona?}`，编辑
`{action:"edit",bot_id,name,persona?}`，移除 `{action:"remove",bot_id}`。
编辑保留 `bot_id` 与记忆命名空间；移除 default 时由剩余第一位接任，移除全部成员后目录为空。
写入只更新 `source:team` 配置并记录该 block 的 revision，保留 Source 的 enabled 状态；记忆不随移除删除。

**能力边界**：手机端可写队伍配置（`bots` POST，本节），也可写 `routines` 账本（`POST /api/mobile/routines`：
`{action:"create",title,cycle,bot_id?,enabled?}` / `{action:"edit",id,title?,cycle?,bot_id?,enabled?}` /
`{action:"remove",id}`）；`memory` 见 §5.7 的 `POST /api/mobile/memory`。其余账本仍只读。

### 写常规任务：`POST /api/mobile/routines`

`GET /routines` 只读账本；写侧开口在同一个路径的 `POST`，三种 `action`：

| 请求 | 做到的事 | 回什么 |
| --- | --- | --- |
| `{action:"create",title,cycle,bot_id?,enabled?}` | 新建一条；`id` 由服务端生成（客户端不能自造 id） | `{ok:true,record:{id,title,cycle,...,created_at}}` |
| `{action:"edit",id,title?,cycle?,bot_id?,enabled?}` | 覆盖允许改的字段；`created_at` 与 `last_run` 保留 | `{ok:true,record:{...}}` |
| `{action:"remove",id}` | 删除一条 | `{ok:true}` |

- `title` 必填、≤100 字符；`cycle` 只认 `hourly`/`daily`/`weekly`；`bot_id` 给了就要合 `^[a-z0-9_-]+$`（空串=谁有空谁接）。
  校验不过 400 并带一句人话 `reason`；宿主没接写侧 503。写只落 `routines` 前缀下的 KV，与读侧同一本账，**不派单**：
  到点真派单仍由调度器按账本跑。

### 进度：`tasks[].total_steps` · `steps_done`

工单卡上的进度条要一个**分母**。分母只有一个出处：worker 自己写的待办清单
（DSH 的 `todo_write`，落成 worker 会话的 `todo/write` 事件）。后台把最后一条待办
的计数记在 Ticket 上，再随 `tasks` 下发：

```jsonc
{
  "id": "tk-1",
  "state": "working",
  "total_steps": 3,               // 计划里的总步数（待办清单的条数）
  "steps_done": 1                 // 其中已经走完的步数，0 ≤ steps_done ≤ total_steps
}
```

- **两个字段要么一起出现，要么一起不出现。** 没有待办清单 = 没有计划，两个字段都缺省；
  客户端**不得**拿已发生的事件条数、报告条数、`steps` 的条数当分母 —— 那不是计划，
  画出来的进度条会永远停在 100%。
- `total_steps` 是 `≥ 1` 的整数。`steps_done` 后端保证已夹在 `[0, total_steps]` 内，
  客户端仍应自行夹一次（后端版本可能不一致），宽度不超过 100%。
- 进度是**只读展示**：它不参与页签归属、不决定 `open` / `retryable`，也不表示工单「完成了几成」。
  一张票可能计划 3 步、走了 1 步就报 `ready` —— 以 `state` 为准，不以进度为准。
- worker 每改一次待办就整份重写，后台取**最后一条**，不把历史叠起来。计划被改小时
  `total_steps` 随之变小（进度条可能因此回退），这是真话，不做单调化。
- 客户端没有别的进度来源：**不得**新增「进度查询」接口，也不得从 `/api/mobile/work`
  的 `steps` 反推分母。
- 桌面与手机已接计划进度：手机 `CrewWire` 解析 `total_steps` / `steps_done` 到
  `WorkTicket.totalSteps` / `stepsDone`；字段缺省时本地取 0，表示没有可展示的计划。
  两端 `progressOf` 都先判断分母，再把分子夹到 `[0, total]`；手机 `TaskRow` 只在
  `totalSteps > 0` 时画轨道与比例填充。进度来自计划，不来自事件条数；无需新增路由。

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
  `delivery` 与 `attention` 共存时 stage 算 `delivery`，`question` 不下发。
- `options` 有且只有 2–4 条：`id` 在同一问题内唯一且稳定（[a-z0-9_-]{1,40}），`label` 是一句给人看的话（≤80 字）。
  **缺省表示只有一个自写框** —— 前端不得自己编 A/B，也不得把 `question` 拆成选项。
- 选项只是呈现，不是审批：回答仍走 §3 的 `POST /send`，`text` 里带上选中的 `label`
  （前端可以前加 `@Bot 名字或 id` 让它路由到那位 Bot）。网关不解析选项，也没有单独的「选选项」路由或字段；
  撤回、排队、幂等全部按这条普通消息的规则算。
- 问题被换掉（文本或选项不同）时后台重新下发整组 `options`，旧的一组随即作废；工单结束、
  `human_action: null` 或 `ready` 报告清空问题，`question` 与 `options` 一起消失。
  前端以最新一次时间线为准，不缓存旧选项。

### 代码卡：`items[].code` 与它下面那两个按钮

消息里带一段**改动**时，就用 §4 那个 timeline 项上的 `code` 字段下发（字段名不叫 `code`
就是 `diff`，两者同形，客户端两个都认）。画板上那张「文件名 + `+N −M` + 逐行增删」的
代码卡就是从这儿来的：

```jsonc
{
  "id": "r7",
  "role": "agent",
  "bot_id": "coder",
  "text": "输入框间距改 16px，底部留 24px 安全区。",
  "at": "...",
  "ticket_ref": "tk-1",          // 这段改动属于哪张工单；只读引用，不是任务账
  "code": {
    "id": "tk-1|login.tsx",      // 可选。同一段对话里这段改动的稳定标识，缺省由客户端拼
    "path": "login.tsx",
    "added": 8,
    "removed": 4,
    "lines": [                   // 逐行；kind 只有 added / removed / 空 三种
      { "text": "  gap: 12px;", "kind": "" },
      { "text": "  gap: 16px;", "kind": "added" }
    ],
    "ticket_ref": "tk-1"         // 可选，与消息上的同值；两处都可，代码块里的优先
  }
}
```

代码卡下面有两个按钮，**都不新开接口**，都走已经存在的通道：

- **采用**：不是一条「把这几行写回工作区」的写操作 —— 宿主机上没有这样的通道，
  前台也不该绕过 worker 去动它的工作目录。它是一次**表态**，按 §3 的 `POST /send`
  发一句普通消息（「采用 login.tsx 这段改动，加 8 行、删 4 行，按这个改。」），
  点名写这段的那位 Bot。因此幂等、排队、撤回、错误码全部按那条消息的规则算，
  这是第 N 次说话，不是第 N 种审批。**没有单独的「应用改动」路由，也不许新造一个。**
- **看看改完的样子**：按 §5.1 的 `GET /api/mobile/screen?ticket=<ticket_ref>` 读这张
  工单的活动快照（它刚跑了什么、输出了什么）。拿到的就是「看它的屏幕」那块画面。

两条规则：

- `ticket_ref` 缺省时「看看改完的样子」**不得拿别的工单顶替**：客户端只能如实说
  「这段改动没带工单号」。把 A 的活显示成 B 的结果，比不给看更糟。
- `ticket_ref` 不只挂在代码卡上：后端会给**每条**对得上票的回话补这个字段（补不上就缺着）。
  消息结果条（§5.4）读的就是它。它是来源，不是猜出来的：对不上时宁可不画，也不按时间挑一张票。
- 代码块缺失或为空（`path` 与 `lines` 都没有）时不画代码卡，也不画这两个按钮：
  **没有改动就没有「采用」**。按钮是这张卡的一部分，不为它单独下发状态或开关。
  客户端可以采用之后把按钮标成「已采用」，但那是本次会话里的界面状态，不落盘、不回传。
- 两个按钮两端都接了：桌面端在 `desktop/ui.go`，手机端在 `app/.../CrewUi.kt` 的 `CodeCard`。
  手机端读 `Message.code`，`ticket_ref` 取代码块自己的、其次取消息上的（`CrewWire.parseCode`），
  两处都没有就如实说「这段改动没带工单号」。手机「采用」已调用 `client.send`，发送中
  `adopting`、成功后 `adopted` 均禁重复点击；失败显示发送失败文案并允许重试，只有发送成功
  才标「已采用」。该标记表示表态已发送，不证明文件已经落盘。**不新增路由。**

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

「看它的屏幕」返回的是这张工单的**实景**：它此刻在干什么、这一段是从几点开始的、它刚执行了什么命令、
输出了什么、说了什么。**不是像素截帧** —— worker 跑的是终端与文件活，不跑浏览器，也没有画布可抓。
所以这里不画「浏览器窗口」的样子，也不摆黑白方块装作画面；有真事就说真事，没有就说没有。

像素画面将来若真的接上（CUA 或有浏览器可抓），是另一种 `kind`（例如 `frame`）加一个 `image` 字段，
`state` / `reason` / `lines` 这一套不变；在那之前，`kind` 只有 `terminal` 一种。

```jsonc
{
  "state": "live",             // live | unavailable
  "kind": "terminal",
  "ticket_id": "tk-1",
  "live": true,
  "at": "2026-11-10T15:02:11.000Z",   // 最后一条活动的时间
  "since": "2026-11-10T14:55:02.000Z", // 这次作业开工的时间；没有在跑的作业就不给
  "stage": "working",                 // working | person | idle | ended（阶段机的原词，不认识就不给）
  "activity": "running",              // running | thinking | waiting | idle | ended
  "cwd": "/Users/me/Code/dsh-bot-crew",
  "hidden": 3,                        // 有多少条事件没变成行（认不出的类型 + 超出上限没看的）；省略即一条没丢
  "lines": [
    { "at": "...", "kind": "command", "text": "$ pnpm test" },
    { "at": "...", "kind": "output",  "text": "1429 passed" },
    { "at": "...", "kind": "said",    "text": "看完了" },
    { "at": "...", "kind": "status",  "text": "这一轮结束" }
  ]
}
```

- `lines[].kind` 只有 `command` / `output` / `said` / `status` 四种；`output` 与 `said` 的区别是
  「命令的输出」还是「它自己说的话」。
- `activity` 是**推出来的、不是猜的**：`stage` 为 `person` / `idle` / `ended` 时直接对应
  `waiting` / `idle` / `ended`（最后一条活动是什么都不改变这件事）；只有 `stage` 为 `working`（或缺席）时
  才看最后一行 —— 命令与输出是 `running`，回话是 `thinking`。什么都推不出来时**不给这个字段**，
  客户端就整行不写，而不是写一个「未知」。客户端不得自己重算这个词。
- `since` 只在这张票有正在跑的作业时给；`stage` 读不懂就不给。两者都是可选字段，
  缺了不等于「没有」，只是这一格说不了。
- `hidden` 只在大于 0 时给。客户端可以据此写一句「另有 N 条没展开」，不许把它当成有画面。
- 数据来源：先读活着的 worker 会话（`sessionController.inspect`），读不到再读会话持久化存档 ——
  进程重启过、worker 已归档，屏幕上也还有东西可看。两道都读不到时返回
  `state: "unavailable"` 与「这张工单的 worker 会话读不出来」，不把「读不到」说成「没有记录」。
- 只取最近的活动（默认 120 条，上限 500），单行超过 500 字符截断；命令与输出里的
  `KEY=value`、`TOKEN: value`、`Bearer xxx` 一律掩码成 `***` 再下发。掩码在**后端**做，
  客户端不得依赖「反正没有凭据」。
- 以下情况如实返回 `state: "unavailable"` 与一句真实 `reason`，**不得**用「在加载」或空数组冒充：
  - 没给票号 → 「没有指定是哪张工单」；
  - 票号在队伍里不存在 → 「队伍里没有这张工单」；
  - 票在、会话里一条可读事件都没有 → 「这张工单还没有可读的执行记录」；
  - 会话读得到但没有一行能显示（全是认不出的类型）→ 「执行记录里没有可显示的内容」；
  - 会话与存档都读不出来 → 「这张工单的 worker 会话读不出来」；
  - 宿主根本没接这项能力 → 「后端还没有接入画面源」。
- 认证与其余 `/api/mobile/*` 相同；局域网与中转隧道都走同一道门。

配套的两个动作（同一页上的按钮，语义见 §5.1.1）：

| 动作 | 现在真实做到的事 | 回什么 |
| --- | --- | --- |
| `POST /api/mobile/takeover` `{ticket}` | 人工终止**这一张**票（`engine.stopTicket`），记为 `ended.by: human`、`outcome: stopped` | `{"ok":true,"stopped":true}`；票不存在 404，引擎不可用 503，停不下来 409 |
| `POST /api/mobile/pause` `{ticket?}` | **全局**暂停执行器（`settings.pause(true, 'panel')`）；带上票号只做校验，不会只停那一张 | `{"ok":true,"scope":"executor"}` |
| `POST /api/mobile/resume` 空 body 或 `{}` | **全局**恢复执行器（`settings.pause(false, 'panel')`），不指定单票 | `{"ok":true,"resumed":true,"scope":"executor"}` |

`resume` 与其他手机动作沿用同一认证入口，只登记 POST；重复恢复仍返回成功。
空 body 与 JSON 对象均可用，客户端推荐发送 `{}`；畸形 JSON、数组与 null 返回 400，超过 8KB 返回 413。
缺恢复控制器返回 503，控制调用抛错返回 500 与可读错误，不返回成功；失败后应刷新时间线里的
`status.paused` 再决定重试。`resumed:true` 表示恢复控制调用已成功完成，实际派单仍受队伍策略约束。

### 5.1.1 工作区画面上「有什么、没有什么」

- **接管操作**现在等于「停这张票」，不是「把控制权交给手机」：手机上能往 worker 递话的只有
  §5.3 的 steer（一句消息，在下一步边界读到），没有直接敲终端的通道。
  所以按钮回话只说「已接手，这个工单停了」，不说「现在归你操作」。
- **让它停一下 / 继续**分别调用 `pause` / `resume`，作用域都是整台执行器，界面按
  `scope: "executor"` 说明；手机入口可直接恢复，不必转去桌面。
- **接手是对单票的永久停止**：全局 `resume` 只解除暂停，不清除该票的人工终止记录，
  不复活被 takeover 的票；继续做这件事需要重新接纳成新工作。
- 会话活动快照已提供：活会话读不到时回退持久化存档，两者都读不到就返回 `unavailable`。
  像素截帧与像素全屏尚未接入，快照不得呈现为可点击的远程桌面。
  §5.3 的 steer 已支持新消息插队和排队消息认领；它递交一句话，在 worker 下一步边界读取，
  没有直接终端操作通道。


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

把一句新写的话，或一条仍在排队的消息，直接交给正在跑的 worker：它在下一步边界读到这句，
不等队列轮询；当前正在执行的命令不会被中断。

```jsonc
{ "ticket": "tk-1", "request_id": "uuid-v4", "text": "可选：新写的一句" }
```

- 带 `text`：**发送即插队**。这句先以「已读」写进网关时间线（路由不会再当新活接一遍），
  再 steer 给 worker；返回 `{"ok":true,...}`。
- 不带 `text`、为空或仅空白：针对队列里已有的那条 `request_id`，先 claim（标记读走）再 steer。
- 两条语义都必填 `ticket` 与 `request_id`；`request_id` 最多 128 字符。

成功：`200 {"ok":true,"ticket":"tk-1","request_id":"uuid-v4"}`。

判定与顺序：

- 工单必须仍在跑；已结束/不存在 → 409 `Ticket is not running`。
- 新写的话先走网关 `/send`，带 `steer:true`、`mentions:[]`，写成已读消息；已有排队消息先走
  `/claim`，成功才说明尚未被路由读过。认领失败原样透传网关的 404 / 409（`no such message` /
  `message was already answered` / `message was already picked up`）。两条分支不会同时执行。
- 网关写入 / 认领成功后，才调用 `runtime.steer(ticket, request_id, text)`；只有它返回 true
  才回成功，返回 false 则回 409。已写入或认领的消息此时可能已经是已读，客户端应刷新状态。
- 认领已有消息时，已回复、已被读走、已撤回过均不再投递；按网关返回的 404 / 409 展示失败。

## 5.4 产出：`GET /api/mobile/outputs`

「产出」是**队伍真正写过的文件**：worker 在它那张工单的工作目录里 `write` / `edit` 过的路径。
它不是一张新表，也不是另一份状态 —— 后台读的是每张工单 worker 会话的事件流。因此：

- 没写过的文件不会出现；会话里读不出来的那张票，不会拿别的票的产出顶替；
- **没有截帧**：`kind: "image"` 只表示「路径以图片扩展名结尾」，不代表后台拍过照。
  画板里那句「两张截图已放进产出」在真机上就是 `counts.image === 2`。

```jsonc
{
  "items": [
    {
      "id": "tk-1|src/login.tsx",   // 稳定标识，客户端按它去重，不要自己拼
      "ticket_id": "tk-1",
      "ticket_title": "调开登录页间距",
      "bot_id": "coder",            // 可选：做这件事的那位
      "kind": "file",               // file | image
      "path": "src/login.tsx",      // 事件里给什么就是什么，不补绝对路径
      "cwd": "/Users/me/Code/shop", // 可选：这张票的工作目录
      "title": "login.tsx",         // path 的末段，给人看的一行
      "writes": 2,                  // 同一个文件被写了几次
      "at": "2026-11-11T10:05:00.000Z"  // 最后一次写的时间；说不清时是空串
    }
  ],
  "state": "live",                  // live | empty | unavailable
  "counts": { "file": 1, "image": 0 },
  "reason": "…",                    // 只在 state 不是 live 时出现
  "ticket_id": "tk-1"               // 只在带 ?ticket= 查询时出现
}
```

查询参数：

| 调用 | 含义 |
| --- | --- |
| `GET /api/mobile/outputs` | 最近 12 张手机/队伍工单的产出合在一起，按 `at` 倒排，最多 60 条 |
| `GET /api/mobile/outputs?ticket=<id>` | 只看这一张。票不存在回 404 `{ "error": "No such ticket" }` |

`state` 的三种取值是这一节的重点，**不许合并**：

- `live`：`items` 非空。有产出就画出来。
- `empty`：**读得到、确实没有**文件改动（`items` 为空）。空态就说「还没有产出」，不要画假条目。
- `unavailable`：**读不到**（会话已回收、宿主没接这项能力）。客户端只能说「读不出来」，
  不得说「没有产出」—— 那是替队伍编一句话。`reason` 是一句给人看的中文原因，可直接显示。

限制与掩码：`path` 超过 200 字符截断；单票最多 40 条、整栏最多 60 条；
产出只列路径与次数，**不下发文件内容**（要看内容用 §5.1 的会话活动）。

### 消息结果条：挂在消息下面那一行「✓ 两张截图已放进产出」

这条结果条**不新开接口**，用的就是本节这一条，顺序固定：

1. 消息必须带 `ticket_ref`（§4）。没带就没有结果条 —— **不得按时间猜**，也不得拿最近一张票顶替。
2. 用 `GET /api/mobile/outputs?ticket=<ticket_ref>` 读那一条。
3. 只有 `state == "live"` 时才画结果条，文案由 `counts` 拼：
   `image > 0` 说「N 张图片已放进产出」，否则说「N 个文件已放进产出」；`file` 与 `image` 都有时
   说「N 个文件 · M 张图片已放进产出」。`counts` 两个都是 0 时（理论上只可能是 `empty`）**不画**。
4. `empty` / `unavailable` / 请求失败：不画结果条。结果条只在**有事发生**时出现，
   把「读不到」画成一条提示，等于把故障当成队伍的成果。
5. **同一张票号只挂在最后一条回复上。** 同一个 `ticket_ref` 常常既挂在「收到」那条、
   又挂在「报结果」那条；每条各画一遍，屏幕上就是连着两条同一句话，看着像交了两回活。
   规则：同一票号，只有时间线上**最后一条**带它的 Bot 回复画结果条，之前的同票号消息不画。
   「最后一条」按列表给的顺序判（从这一条往后找，后面没有同票号的 Bot 回复即是），
   **不按 `at` 比时间、也不看 id** —— 两端照同一个顺序判，才不会因为时钟差一秒而画出不同结果。
   人发的消息不挂结果条，因此也不算「压住上面那条」。

> 上一轮画板里这条是「后端没有产出接口所以不画」（见 `designs/personal-agent/设计系统.md` §六）。
> 现在接口有了，规则就按上面这几条走。判定实现各一处纯函数：
> 桌面端 `lastOfTicket`（`desktop/ui.go`）、手机端 `OutputsCopy.lastOfTicket`（`CrewWire.kt`）。

## 5.5 常规任务：`GET /api/mobile/routines`

「常规任务」是**主人写下的定时账本**：一条任务 = 标题 + 周期 + 负责的 Bot + 开关 + 上次跑 / 下次跑的时间。
它不从会话事件推、也不新开一张表 —— 存在宿主的 KV 里（`routines:task:<id>`，一条一个键），
跟工单无关：工单没了账还在。

**它会到点真派单**（`src/app/routine-runner.ts`），但只有三件事：

- 到点的走 `Engine.receive` 派给负责的那位 —— 和手机发消息同一条路，所以那活在同一本账上；
- 派出去的那一刻写 `last_run`，这是「真跑过」的**唯一**证据；`next_run` 顺着周期推到**真正比此刻晚**的第一格，
  停机两天不补跑（补跑只会让主人被同一件事刷屏）；
- 派不出去（队伍暂停、账本没指定 Bot 而队伍里又没人）只记一次「逾期」，**不动 `last_run`** ——
  没跑成不能记成跑过。

`runner` 说的是**这台后端现在有没有调度器**：

- `"live"`：有，到点会真派单。客户端该说清「会派给谁、跑过记什么、逾期怎么办」；
- `"none"`：没有（宿主没接、或老版本）。客户端必须说出来（「到点不会自己跑，逾期只是提醒」），
  不许画成「已排好」「等待执行」。

认不出的取值一律当 `"none"`：说多了是许空诺，说少了是假装有人会跑。
## 5.6 未读：`GET /timeline` 上的 `unread`

画板把徽标挂在**「后台」入口**上：手机是页头那枚按钮右上角的赭色角标
（`Mobile.dc.html:39-41`，暗色同位置的 `Mobile-dark.dc.html:39-41`）。
桌面画板那一行右端只有一枚「张数」chip（`Desktop.dc.html:78`，绿底），没有未读；
桌面这枚赭色未读 chip 就摆在同一行的张数左边 —— 同一个「有活等着你」的位置，先未读后张数。
它回答的是「我发出去的话，队伍读到了没有」，不是「队伍回了我没有」。
两者差一步：一条消息可以先被读走，隔几分钟才回。

### 未读的定义

**人发出去、队伍还没读走的消息条数。** 就这一句，不夹带别的。

「读走」不是新造的状态，它就是网关队列里已有的那一列：`mobileq.db` 的 `messages.read_at`。
`mobileq pull`（Source 取走交给路由）和插队的 `claim` 都写它，撤回也按它判 409。
因此这条计数**不新开表、不新存状态**，只是把已有的一列数出来。没读过就是空串。

```jsonc
{
  "items": [
    {
      "id": "daily-standup",              // [a-z0-9][a-z0-9-]{0,63}，也是 KV 键的后半段
      "title": "每天站会",                 // 最多 100 字，超了截断
      "cycle": "daily",                   // hourly | daily | weekly，只认这三个词
      "bot_id": "lead",                   // 可选：负责的那位；账本允许不指定
      "enabled": true,                    // 开关
      "created_at": "2026-11-11T09:00:00.000Z",
      "last_run": "2026-11-11T09:30:00.000Z", // 可选：账本里记过的最近一次执行
      "next_run": "2026-11-12T09:30:00.000Z", // 算出来的：参照 last_run，没跑过用 created_at
      "overdue": false                    // next_run 已经过了
    }
  ],
  "state": "live",                        // live | empty | unavailable
  "counts": { "enabled": 1, "paused": 0 },
  "reason": "…",                          // 只在 state 不是 live 时出现
  "runner": "live"                        // 这一栏现在能不能按点跑：live | none
}
```

`state` 的三种取值与产出（§5.4）同一套规矩，**不许合并**：

- `live`：`items` 非空。
- `empty`：**读得到、确实一条都没有**。说「还没有常规任务」，不画假条目。
- `unavailable`：**读不到**（账本打不开、宿主没接这项能力）。只能说「读不出来」，
  不得说「还没有常规任务」—— `reason` 是一句给人看的中文原因，可直接显示。

判定规则：

- `last_run` **只在真的派出去过之后才有**：界面只能写「还没跑过」，
  不许补一个日期，也不许拿 `created_at` 冒充「上次跑」。
- 一条记录认不出来（没 id、没标题、`cycle` 不认识、时间读不懂）时跳过那一条，不拿半个字段凑一行；
  一条都认不出来时整栏是 `empty`，不是「读不到」。
- 排序：开着的在前，同一档按 `next_run` 先后，关掉的排最后；最多 100 条。
- 只有这一条路由，**这一轮没有写接口**：改账（加 / 改 / 开关 / 删）还没有决定由谁来写，
  不先开一个只能看不能改的假入口。客户端不得在本地改完就当成落盘。

### 手机端怎么接

手机端已接（`app/.../CrewUi.kt` 的 `RoutineScreen`），按这四条做，**不新增路由**：

1. 在某处（队伍页头或「后台」旁的入口）进「常规任务」一屏，进屏时读一次本节这一条。
2. `live` 逐条列：标题、周期（`hourly` / `daily` / `weekly` 翻成「每小时 / 每天 / 每周」，
   不认识的周期原样显示）、负责的 Bot、开关、上次跑 / 下次跑。
3. `empty` 用空态原话；`unavailable` 与请求失败只说「读不到」。两者不能互相顶替。
4. 开关这一版**只是显示**：后端没有写接口，按下它不该看起来生效。要让它真能改，
   先给本节加一条 `POST /api/mobile/routines`（`{ action: "on" | "off" }`），再改界面。
    { "id": "m1", "role": "user", "text": "在吗", "at": "...", "read_at": "" },
    { "id": "m2", "role": "user", "text": "看一下", "at": "...", "read_at": "2026-11-11T10:01:05+0800" },
    { "id": "r1", "role": "agent", "reply_to": "m2", "text": "好", "at": "..." }
  ],
  "unread": {
    "count": 1,                    // 未读条数；state 不是 live 时是 null
    "state": "live",               // live | unknown
    "reason": "…"                  // 只在 state 不是 live 时出现，一句给人看的中文
  }
}
```

`read_at` 挂在**人的消息**上：空串 = 还没读走，有值 = 读走的时刻。
字段**缺席**是另一件事 —— 这份时间线说不清，见下面 `unknown`。回话没有这个字段，
队伍没有「读没读自己说的话」这回事。

### `state` 的两种取值，**不许合并**

- `live`：读得到。`count` 是整数，可以是 0（**读得到、确实没有未读**）。
- `unknown`：**算不出来**。老版本网关不带 `read_at`，或者这条通道不报读走状态。
  `count` 是 `null`，`reason` 说清为什么。

**`unknown` 不是 0。** 把「读不出来」画成「没有未读」，等于替网关说队伍把话都读过了，
那正是这一格不能做的事。`unknown` 时客户端**不画徽标**，一格都不占。

只要有一条人的消息缺 `read_at`，整份就算 `unknown`：能判的和判不了的不混着数。
一条人的消息都没有时是 `live` + `count: 0` —— 没有可缺的证据。

### 客户端的规矩

- 徽标只在 `state == "live"` **且** `count > 0` 时画。0 条不画，`unknown` 更不画。
- 数字只认后端这一个 `count`，**不得**拿 `items` 自己数一遍：那是第二份口径，迟早对不上。
  手机端在 `CrewWire.unreadOf` 里做的就是这件事，`CrewUi.BackendIconButton` 只认结果。
- 超过 99 写 `99+`（`desktop/ui.go` 的 `badgeText`、`CrewUi.kt` 的 `unreadBadge`）：
  徽标是个提示，不是账本。
- 徽标是**只读展示**：它不参与页签归属、不决定 `open` / `retryable`，点它只是打开后台。

### 回话已读：`POST /api/mobile/read`

| 动作 | 现在真实做到的事 | 回什么 |
| --- | --- | --- |
| `POST /api/mobile/read` `{last_read_id}` | 客户端把它在时间线上读到的最后一条回话 id 报上来；后端把这条 id 记成**会话级**已读水位（后端 KV `mobile-read-cursor`），不改网关 `replies` 表、不逐条加回执 | `{"ok":true,"last_read_id":"r7"}`；缺字段/非对象/畸形 JSON/超 128 字符 400，正文超 8KB 413，宿主记不下水位 503 |

「Bot 的回话主人看没看过」原本没有记录：网关只有主人 → 队伍的队列（`messages.read_at`），
反方向的回话在 `replies` 表里，那上面没有、也不该有「阅读回执」——读没读是客户端的事。
这条路由补的就是那个缺的输入，不改动网关那两张表：后端只收一个位置、记一条水位，
`GET /timeline` 再照它算第二个数。

- `last_read_id` 必填，是 `items` 里某条回话的 `id`（网关给的 `r<n>`），非空、≤128 字符。
  一次只记一条、会话级，不按票分、不按 Bot 分；重复上报（含更旧的位置）都是覆盖写入，
  `ok:true` 只表示「记下了」，不表示徽标数变了。
- 认证与其余 `/api/mobile/*` 相同（§7）：走 Connection 的已认证入口，凭据由 `phone-gate.ts` 判。
  不新开无鉴权路由。
- 客户端进对话屏时上报一次最新读到的回话 id；不上报就没有这一格，不是后端出错。
  App 端已接：进对话屏、有新回话时用 `CrewClient.reportRead(lastAgentId)` 上报（取时间线上最后一条 `role==agent` 的 `id`），
  失败尽力而为不打断看消息；`unreadReplies` 已解析成三态字段（`null` = 说不清，不画徽标）。
  桌面端也已接：`refresh` 拉到时间线后用 `Client.ReportRead(lastAgentMessageID(...))` 上报最后一条回话 id，
  左栏「后台」入口同时挂 `unreadReplies` 徽标（与未读徽标同口径、异底色）。

### `unread_replies`：`GET /timeline` 上的第二个数

`GET /timeline` 在 `unread` 之外多给一格 `unread_replies`，形状沿用 `UnreadView`
（`count` / `state` / `reason`），三态口径与 `unread` 完全一致：

```jsonc
{
  "unread": { "count": 1, "state": "live" },          // 人发出去、队伍还没读走
  "unread_replies": { "count": 2, "state": "live" }   // 队伍回了、主人还没看
}
```

- `live`：`count` 是整数，可以是 0（读得到、确实没有未读回话）；只数水位之后
  `role == "agent"` 的回话，**按时间线给的顺序判，不按 `at` 比时间** —— 两端照同一份
  顺序，才不会因时钟差一秒画出不同的数。
- `unknown`：`count` 是 `null`，`reason` 说清为什么。还没报过已读位置、或报上来的那条
  id 不在这份时间线里，都算 `unknown`。**`unknown` 不是 0**，跟 `unread` 一样不画徽标、
  一格都不占；后端不替客户端编一个已读位置。
- 客户端只认这两个 `count`，**不得**拿 `items` 自己数一遍（同 §5.6「客户端的规矩」）。

**三个数谁也不冒充谁**：`unread` 按「有没有被队伍读走」判（人 → 队伍），
`unread_replies` 按「主人读到哪」判（队伍 → 人），
`queued`（§5，还没回复、还能撤回）按「有没有回复 + 90 秒窗口」判。
方向、输入、判据都不同，两个都要各自的定义，不合并、不互相顶替。

## 5.7 记忆：`GET/POST /api/mobile/memory`

记忆是队伍的**长期账本**：它记得主人定下的规矩、办完的事的结论。与工单、Session 都分开 ——
工单结束、会话归档，记忆还在。它回答的是「这支队伍记得什么」，不是「它现在在干什么」。

写侧有三条硬规矩：

1. **只记认得出来的**。主人的话命中「定下来的规矩」的句式（以后都…／记住…／我习惯…／别…再造句）才记；
   工单只在 `ready` / `dropped` 收尾时记结论。`progress` / `waiting` 是过程，不进账本 ——
   账本一脏，下次召回的全是废话，比没有记忆更糟。
2. **读的时候只取一小片**。上工时按中文二元组相关度 + 新鲜度取 top-k，拼成不超过 1200 字的一段，
   跟在开工那句话后面。**不重放整段历史** —— 这正是拆掉上下文天花板的那一刀。
3. **不上 Hub**。本地提炼的一条都 `to_hub: false`；上行走用户已有的 `local_dream` 直通源，不在这一层二次蒸馏。

```jsonc
{
  "items": [
    {
      "name": "bot-lead-person-以后都用-pnpm",  // 记忆名，也是 KV 键的后半段
      "bot_id": "lead",                        // 归哪位 Bot；调用与召回都按它分命名空间
      "description": "以后都用 pnpm，不要用 npm", // 单行标题
      "body": "主人原话：「以后都用 pnpm」\n\n记于 …",  // 正文，可多段
      "type": "feedback",                      // user | feedback | project | reference
      "importance": 5,                         // 1..5，只影响同分时的次序
      "state": "active",                       // active | forgotten | superseded
      "created": 1794000000,                   // 秒
      "updated": 1794000000,                   // 秒
      "origin": "person:owner",                // person:<id> | ticket:<id> | host
      "source": { "ticket_id": "t1", "at": "2026-11-11T09:00:00.000Z" },
      "to_hub": false                          // 这一条会不会上行到中枢
    }
  ],
  "state": "live",                             // live | empty | unavailable
  "counts": { "active": 1, "forgotten": 0, "superseded": 0 },
  "reason": "…"                                // 只在 state 不是 live 时出现
}
```

`state` 与产出（§5.4）、常规任务（§5.5）同一套规矩，**不许合并**：`empty` 是「读得到、确实没有」，
`unavailable` 是「读不到」，后者只能说「读不出来」，不得说「还没有记住什么」。

判定规则：

- **忘掉不删行**。`POST {"action":"forget","name":…}` 把 `state` 翻成 `forgotten`：
  这条不再进它下一次开口时的上下文，但仍留在账本里 —— 删掉就再也答不出「它曾经这么以为了」。
- **纠错写新条**。同一条事实换个说法写进来，旧条翻成 `superseded`，不做硬删；
  同一 `dedupe_key` 且正文没变的重复写入是**幂等的**，重试一轮不会让账本变长。
- **种命名空间**。去重只在同一位 Bot 内生效：两位 Bot 都记「主人要求先说结论」时各留一条，
  不许互相顶掉 —— 记忆是按人分的。
- `created` / `updated` 是**秒**（插件 frontmatter 的惯例）。客户端自己按本地时区显示，不自己编日期。
- `importance` 只影响同分时次序，不是「重要就一定排第一」；相关度才是主项。

改账：`POST /api/mobile/memory`，body 是 `{"action":"forget"|"edit","name":…, "description"?, "body"?, "importance"?}`。
只认 `bot-` 开头的记忆名 —— 这是让主人改账本，不是任意改 KV。描述不能多行、正文不能为空，
违反时返回 400 并给一句人话。

## 5.8 看门狗时限：多久算「卡住」

静默卡死（#4）的根子是「没人知道它卡了多久」，所以这里把两个时限钉成明确的数，写进配置、
由看门狗按它报警。两个数都从 `settings.eval.timeoutSeconds` / `LIMITS` 派生，不再散落在各处拍脑袋。

| 时限 | 含义 | 取值为默认 | 出处 |
| --- | --- | --- | --- |
| **Eval 无 judgement** | 评估投递给判官 Session 后，多久没拿到裁决算超时 | `eval.timeoutSeconds`，**默认 120s**，可调 30–600s | `settings.eval.timeoutSeconds` → `policy.evalTimeoutMs` |
| **turn 无第一步** | worker 的 turn 被接收后，多久没有进入任何一步（Session 没吃掉输入）算超时 | 同一 `evalTimeoutMs`（与上一条同一套口径，不另立第二个数） | 同上 |

规则：

- **超时必报警**。Eval 超时（`delivered` 后过 `evalTimeoutMs` 仍未裁决）先按 `REQUEUES=2` 重排，
  仍超时则记 `unavailable` + `reason.code=timeout`，看门狗据此推一条「有一件事没判下来」并交给
  自愈重跑一次（见 #8 已验收项）。**不允许出现「卡了几分钟没人知道」**——超时那条一定发出。
- **不作静默重试的死循环**：`healed` 标记保证自愈只做一次，判官正常说「现在别接」的 `unavailable`
  不动（那是裁决，不是故障）。
- 面板改 `timeoutSeconds` 即改这两个数（同一个 `evalTimeoutMs`），改完下一次扫描生效，无需重启。

### 看门狗告警走哪条链（#8-2）

超时未决定（「有一件事没判下来」）这类告警，**落在三条明确的链上，不依赖 App 的独立系统推送**
（那条用户已停，不再作为唯一通道）：

| 链 | 落在哪 | 谁读 | 可靠度 |
| --- | --- | --- | --- |
| **看门狗账本** | `Runtime.watchdogStatus().alerts`（内存最近 10 条，含 `decisionId`） | 桌面右栏横幅、管理面 `GET /orchestrator/api/state` 的 `watchdog` 字段 | **一定写**，与推送无关 |
| **主 Session timeline** | `sessions.relay(key('eval-timeout', id), {kind:'eval_timeout'})` | 手机/桌面读 `GET /timeline` | 一定递（进程内 effect） |
| **手机通知（加分项）** | `pushNotice` → relay 隧道 `pushSend`（手机在线直收）/ `pushOutbox` 留件 | 手机 | 手机在线/重连时才有；**不作唯一依赖** |

结论：即使手机没连、或 App 系统推送停着，超时这件事也一定出现在**看门狗账本 + timeline** 上，
桌面右栏与管理面能看到。这就不留「说不清的链」——每一条都能指到具体落点与读它的地方。

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

## 9. 会话（session_id）

一次请求选哪一段消息流，由 `session_id` 决定。本节只定义线上字节；状态仍以队列与后台为准。
切片划分与 seam 取舍见 [ADR 0007](adr/0007-multi-session-seam.md)，三个词的分工见 [GLOSSARY.md](../GLOSSARY.md)。
header 形态与能力位裁决见 §9.7，Source 准入见 §9.8，群组只读投影见 §10。

**S1 是后端闭环**：网关与消息面按会话分片，S1 阶段手机 / 桌面客户端不改，老调用逐字不变。
~~要开会话、切会话的客户端行为与准入收口是 S2 / S3 / S4 的事，一律按顶部的书写约定标为欠账，
按日期核对；后续切片在本节逐条记为欠账。~~（2026-11-13 原记）
**S2 / S3 已落地，S4 机制已落地**：手机端（S2）与桌面端（S3）的列出 / 新建 / 切换会话已落地；
S4 落下 header 双载体（§9.7）、Source 准入收口（§9.8）与群组只读投影（§10）。
事实描述见 §9.4，客户端能力位先验与缓存隔离见 §9.6。
真机 / 人工验收窗口与 issue #15 七项仍属未做，按本文件顶部的书写约定在 §9.4 留一条欠账；
真机证据缺位时如实标注未做，不作覆盖性结论。

### 9.1 字段形状

| 项 | 约定 |
| --- | --- |
| 名称 | `session_id`（query）／`x-crew-session`（header） |
| 位置 | **两种载体**：URL query 参数 `session_id`，或请求头 `x-crew-session`。**query 优先、header 兜底**；两者都给且不一致 → 400 `invalid_session`（§9.7）。body 不认。relay 把 `url.search` 原样拼回下游路径（`relay/src/server.ts:644`），请求头也原样下送（`relay/src/server.ts:633-642`） |
| 形状 | `^[a-z0-9][a-z0-9-]{0,31}$`，两种载体同形 |
| 缺省 | 两种载体都不给即 `main`；`session_id=main`、只给 `x-crew-session: main`、两者都不给，等价 |
| 映射 | 与队列 `messages.conversation` 列一一映射：`session_id` 是该列在线上消息面的字段名 |

- `session_id` 是**传输层的字段**，不是 DSH 的 Session；DSH 总路由 `masterId` 仍是单值，不随会话增减。
- ~~（原 `desktop` 欠账，2026-11-13）header 形态的 `session_id` 未开放：留给 S3 桌面端，本阶段只认 query 参数。
  S1 的 body 与 header 都不读 `session_id`。~~ → **2026-11-13 第一次订正**：header 形态不开放；
  桌面端与手机端一致走 query，理由：S1 网关只在 query 读 —— `session_of()` 只取
  `urlsplit(path).query`，body / header 一律不认（`test_session_id_is_a_query_only_field` 曾把它钉死）。
  ~~桌面端没有另一套 header 通道可开。~~
  → **2026-11-13 S4 第二次订正**：#14 第 2 项要求的 header 形态已落地，头名 `x-crew-session`；
  网关与消息面都识别它，query 优先、header 兜底，冲突与非法值一律 400 `invalid_session`。
  桌面端非 `main` 请求同时带 query 与 header 且值相同，默认 `main` 不带任何会话字段。
  两段带删除线的原话按 2026-11-13 留作历史，裁决与理由见 §9.7。

### 9.2 能力位（expand 的那一半）

- 网关对**显式带会话的每个响应**（query 带 `session_id`，或请求带 `x-crew-session`；不只是
  `GET /timeline`）回显 `session_id: X` 与 `session_api: 1`，包括 `/send`、`/withdraw`、`/claim`
  及各自的错误响应。能力位注入判据在 `_send` 一处，随 header 识别同步扩到 header（§9.7）。
  理由：客户端可能不先取 timeline 就直发 `send?session_id=work`，若只有 timeline 带能力位，
  这条路径在老网关上会被静默按 `main` 落库且无从发现；header 直发同理。
- 消息面 `GET /api/mobile/timeline` 响应回显 `session_id`、`session_api: 1`、
  `sessions: ["main", ...]`、`default_session_id: "main"`。
- 老调用（既不带 `session_id` query，也不带 `x-crew-session` header）的**请求与响应**都逐字不变：
  网关一个字段都不加（能力位只在显式带会话时注入）；`/timeline` 老调用仍回显
  `session_id: "main"`，响应其余部分逐字不变。消息面老调用的转发 URL 也不带 `session_id`、
  不转发会话头，由网关缺省 `main`。
- `GET /api/mobile/sessions` → `{ sessions, default_session_id: "main", session_api: 1 }`，
  `main` 恒在首位；`POST /api/mobile/sessions` body `{ "id": "work" }` 按 §9.1 校验形状、登记进名单，
  返回 `{ id, sessions, session_api: 1 }`；重复 id 幂等返回 200。
- 能力位是**增量字段**：老客户端按 §5「未知字段必须保留、不得丢弃」照旧处理，不因多出字段报错或改状态。
  新客户端只在确认 `session_api: 1` 之后才发显式非 `main`；缺位即停止发送并明确报错，**禁止静默降级**。

### 9.3 错误码

| `error` | HTTP | 何时 |
| --- | --- | --- |
| `invalid_session` | 400 | 任一载体的值不符合 §9.1 形状（大写 / 空格 / 超长 / 非法字符），或 query 与 header 都给且**不一致**（不许猜哪个算数） |
| `unsupported_session` | 409 | 显式会话 != `main` 而对端未升级（网关响应缺 `session_api`）；header 形态同样适用 |

- 两条都回 `{ "error": "<code>" }`，与 §6 的错误体同形；`error` 的值就是上表的码，客户端按 §6 只展示文本。
- **`unsupported_session` 绝不静默当 `main`**：这是本阶段最重要的防串线约束。
- 消息面对**任何转发 operation**（timeline / send / withdraw / claim 等）一视同仁：网关响应缺
  `session_api` 且请求显式会话 != `main`，回 409 `unsupported_session`。
  因此直发 `send` 到老网关也会被挡，不依赖客户端「先取 timeline 探测」的约定。
- header 形态的「对端未升级」不另立错误码：新客户端发了 `x-crew-session` 而老网关不认时，
  由能力位先验（非 `main` 零发出）与消息面的 409 兜住，**不按缺省 `main` 落库**；裁决见 §9.7。

### 9.4 老客户端兼容

- 不带 `session_id` 的请求形状、状态码、响应其余内容与本阶段之前一致，全程 200；新增字段是增量的，按 §5 处理。
- 会话名单、READ_CURSOR、timeline 过滤在后端按 `session_id` 分开；老调用只落在 `main` 那一份。
- ~~（原 `app` 欠账，2026-11-13）S2：手机端切换 / 新建会话未接，本阶段不改 `app/`。~~
  → **2026-11-13 S2 已落地**：手机端（`app/`）启动 / 首次进入先取 `GET /api/mobile/sessions`
  做能力位先验（`session_api: 1` 才启用会话切换）；老后端或读不到名单时锁 `main` 并如实提示
  「这台后端还只支持一个会话」/「读不到会话列表」；timeline 缓存按每会话一份组织
  （`Map<String, Conversation>`），切回 A 不显示 B；当前会话 id 持久化到 `PairingRecord.SESSION`，
  缺键回落 `main`，会话名单每次启动从后端拉。会话相关请求走 query，细则见 §9.6。
- ~~（原 `desktop` 欠账，2026-11-13）S3：桌面端切换 / 新建会话未接，本阶段不改 `desktop/`。~~
  → **2026-11-13 S3 已落地**：桌面端（`desktop/`）同样先验能力位、缺位锁 `main` 并如实提示；
  `Client` 的 `Sessions()` / `CreateSession(id)` 与 `Timeline/Send/ReportRead/Withdraw/SendAgain`
  带可选 session，非 `main` 时在 path 追加 `?session_id=` / `&session_id=`（走 query，不开放 header），
  `do()` / `auth()` 老路径零改动；timeline 缓存按每会话一份组织
  （`map[string]*Conversation` + `currentSession`），左栏会话列表；当前会话持久化到凭据文件，
  缺键回落 `main`。细则见 §9.6。
- ~~（原 `backend` 欠账，2026-11-13）S4：Source 准入判定（`scope()` / `channel.allowed`）与会话名单的收口未做；
  S1 只写这份契约与「未登记会话不静默丢消息」的说明，`team.ts` / `mobile.ts` 只加说明性注释，不改判定逻辑。~~
  → **2026-11-13 S4 已落地**：`scope()` / `channel.allowed` 在手配 `conversations` 之外合并
  `KV.mobile.sessions` 注册名单，手配清单保留作向后兼容；未登记会话的消息照原 `conversation`
  落 `mobileq.db`、可按 `session_id` 读回，并给出可观测的 `conversation_not_listed` 准入结果，
  不静默吞掉；登记后立刻可派单，不手改 Source 配置、不重启。四条断言与证据见 §9.8。
- ~~（原 `gw` 欠账，2026-11-13）S4：真机 / 人工窗口（APK 切会话经 relay 与 lan-server 两道门、真机配对与
  `phone-gate` 401、mygo GUI 切屏与双徽标、第二个 conversation 真派单后 `/state` 与归档守卫）尚未做。~~
  → **2026-11-13 订正**：S4 真机 / 人工窗口与 issue #15 七项（Step 0 四期收尾）仍属未做，
  需要设备与人工窗口、每项要有截图 / 录屏 / 日志证据；本轮只有独立临时网关的 HTTP 断言，
  不代替真机。欠账按顶部书写约定继续标出：
- `TODO(gw, 2026-11-13)` 真机验收：S4 真机 / 人工窗口（APK 切会话经 relay 与 lan-server 两道门、
  真机配对与 `phone-gate` 401、mygo GUI 切屏与双徽标、第二个 conversation 真派单后 `/state`
  与归档守卫），以及 issue #15 七项（桌面端、手机端、远程恢复、运行中 profile 加载新构建、
  真机 APK 安装、真实额度数据源、relay 重新部署）均未做，缺真机证据；每项有证据才勾。

### 9.5 四种组合与静默串线

两个维度：**客户端**（老 = 不带 `session_id` / 只认 `main`；新 = 会发显式非 `main`）×
**后端**（老 = 网关 + 消息面未升级、不回显 `session_api`；新 = 按会话分片、回显 `session_api: 1`）。

| 组合 | 客户端 | 后端 | 结果 |
| --- | --- | --- | --- |
| C1 | 老 | 老 | 全落 `main`，200，逐字兼容，无串线（双方都只认一段） |
| C2 | 老 | 新 | 缺省回落 `main`，200 + 回显 `session_id: "main"` / `session_api: 1`，老客户端忽略能力位，无串线 |
| C3 | 新 | 新 | 显式非 `main` 被正确分片，200 + 回显 `session_id: X` / `session_api: 1`，无串线 |
| C4 | 新 | **老** | **全程 200 静默串线**：客户端以为在 X，后端仍读写 `main`，不报错、不回显、不拒绝 |

C4 是唯一危险组合，四个口子让它「全程 200」：send body 重构时丢掉未知字段、`CONV` 仍写 `main`、
timeline 全量下发、`READ_CURSOR` 全局单键。S1 逐一对上：query 原样透传（§9.1）、网关请求级
`session_of`、timeline 按会话过滤、READ_CURSOR 按会话分键。

能力位防串：C4 里后端一路 200，靠**客户端先验能力位**兜底 —— 新客户端发现响应没有
`session_api: 1` 就停发并报错；滚动升级时（新消息面 + 老网关）再由消息面把「网关响应缺
`session_api` 且显式非 `main`」翻成 409 `unsupported_session`。两道都指向同一条规矩：
**显式非 `main` 遇未升级对端，宁可报错，也不静默当 `main`。**
header 形态会把同一个 C4 再开一次口子（老网关不读 `x-crew-session`，客户端以为在 X、
消息实际写进 `main`，全程 200）；裁决与两道兜底见 §9.7。

### 9.6 客户端能力位先验与缓存隔离

S2（手机端）/ S3（桌面端）已落地，S4 补上 header 形态与准入收口。本节是两端共同遵守的客户端
规矩：实现语言与存储不同（Kotlin / Go），判定一致。传输形态按 §9.1 —— 手机端会话相关请求在
query 带 `session_id`；桌面端非 `main` 请求 query 与 `x-crew-session` **双写且值相同**（§9.7）。

**能力位先验**：启动 / 首次进入先取 `GET /api/mobile/sessions`，三种响应分开处理，禁止静默降级：

| 状态 | 响应 | 判定 | 界面文案 | 后续请求 |
| --- | --- | --- | --- | --- |
| 可用 | `200` 且 `session_api: 1` | 新后端 | 用 `sessions[]` / `default_session_id` 画会话列表，启用切换 | 允许非 `main` |
| 老后端 | `404` 或响应缺 `session_api: 1` | 未升级 | 「这台后端还只支持一个会话」，锁 `main`，不画切换条 | 不发任何非 `main` |
| 读不到 | 网络错误 / 超时 | 说不清 | 「读不到会话列表」，锁 `main`，不假装成功 | 不发任何非 `main` |

- 缺位与网络错误是两种「说不清」，文案不同，都锁 `main`；这是 §9.5 C4 防线在客户端的落点
  （老后端一路 200，只有客户端先验能拦住）。
- 新建会话 `POST /api/mobile/sessions` body `{"id":"work"}`：`200` 用返回的 `sessions[]`
  刷新列表并切到新会话；`400 invalid_session` / `409 unsupported_session` / `503` 如实展示错误，
  不新增本地条目。
- 会话 id 形状按 §9.1（`^[a-z0-9][a-z0-9-]{0,31}$`）：提交前本地校验（`trail-` 合法、
  32 位上限，大写 / 空格 / 下划线非法），非法 id 不发往后端。
- 默认 `main` 的请求不带 query 参数、也不带 `x-crew-session`（网关缺省 `main`，老路径零改动）；
  只有非 `main` 才追加 `?session_id=<id>`，桌面端同时带同名 header。与会话无关的宿主侧接口
  （models / efforts / model / routines / memory / spend / audit / voice / speak / screen /
  outputs / work / agents / bots / pair / pause / resume / retry / takeover / reply-spend）
  不带 `session_id`，也不带 `x-crew-session`。

**每会话独立缓存**：手机 `Map<String, Conversation>`、桌面 `map[string]*Conversation` +
`currentSession`，键就是 `session_id`。切回 A 时显示 A 的缓存，**绝不显示 B 的消息**。切换会话时
清掉 / 不复用上一个会话的 `messages`、`queued`、`declined`、`unread`、`unread_replies`、`tasks`；
它们都来自各自会话的 timeline 响应，不跨会话拼接。老后端（锁 `main`）时缓存结构与 S1 之前
一致：单份 `Conversation`。

**当前会话持久化，名单不持久化**：当前会话 id 落盘（手机 `PairingRecord` 新键 `SESSION`、
桌面凭据文件新键），下次启动恢复，缺键回落 `main`；会话名单本身不落盘，每次启动从
`GET /api/mobile/sessions` 拉，唯一真源在后端，不以本地缓存的名单为准。老响应缺 `sessionId` /
`name`（桌面 `SessionID`）字段时按 `main` 回落，兼容 S1 之前的时间线形状；缺字段不等于新会话，
不凭空建一段缓存。

本节与 §9.2 的能力位、§9.3 的错误码、§9.5 的 C4 是同一套规矩，不另立字段；`session_id` /
`conversation` / `masterId` 的分工见 [GLOSSARY.md](../GLOSSARY.md)，切片与传输形态裁决见
[ADR 0007](adr/0007-multi-session-seam.md)。

### 9.7 header 形态 `x-crew-session`（#14 第 2 项）与字面要求的差异

#14 第 2 项原文：「另加 header 形态的 session_id 在本片开放（S1 只认 query；header 未被识别时
按缺省 main，不得报错）」。前半句按原样落地；**后半句按下面的裁决收窄**，理由是它会把 §9.5
判定过的危险组合重新放进来。

**线上字节**

| 项 | 约定 |
| --- | --- |
| 头名 | `x-crew-session`（小写，与 `x-crew-device` / `x-crew-credential` 同族） |
| 值形状 | 与 §9.1 同形：`^[a-z0-9][a-z0-9-]{0,31}$` |
| 取值 | **query 优先、header 兜底**；两者都给且不一致 → 400 `invalid_session`，不许猜哪个算数；两者都不给 → 缺省 `main` |
| 能力位 | 显式带 header 的请求，**所有响应**同样回显 `session_id: X` 与 `session_api: 1`（复用 `_send` 一处判据，含 `/send` / `/withdraw` / `/claim` 及错误响应）；老调用一个字段不加 |
| 客户端 | 桌面端默认 `main` 不带任何会话字段；非 `main` 时 query 与 header **双写且值相同**（滚动升级中任一版对端都读得到）。手机端（S2）不改，继续走 query。现有精确路径断言一条都不改 |
| 两道门 | relay 原样下送请求头（`relay/src/server.ts:633-642`；逐跳头集合见 `:883`，不含本头），query 由 `:644` 原样拼回；`phone-gate` 的 401 只认设备凭据两枚头（`backend/src/app/phone-gate.ts:22-29`、`42-49`），新增本头不改判定；`lan-server` 把 `request.headers` 整体交给 `forward`（`backend/src/app/lan-server.ts:108`） |

**与 #14 字面要求的差异及理由（防串线）**

按字面做「header 未被识别时按缺省 `main`，不得报错」会重新引入 §9.5 的 **C4 静默串线**：
S1 网关 `session_of()` 只读 query、不读 header；客户端以为自己在 `work` 会话，消息实际写进
`main`，响应也不回显 `session_api`，**全程 200 无报错**。客户端既拿不到「会话被并进 main」的信号，
也没法在 `work` 的 timeline 上找回这条消息。§9.5 与 [ADR 0007](adr/0007-multi-session-seam.md)
正是把这一组合判为唯一危险组合。

裁决：

1. 「header 未被识别时按缺省 `main`，不得报错」**只在「老客户端压根不发这个 header」这一意义上
   成立**：两种载体都不带的老调用逐字不变、缺省 `main`、全程 200（§9.2 / §9.4）。
2. 「新客户端发了 header 但对端不认」**必须报错，不许降级**：网关与消息面都识别
   `x-crew-session`；老网关不认 header 时，由**能力位先验**（先验没过，非 `main` 请求零发出）
   与**消息面 409 `unsupported_session`**（网关响应缺 `session_api`）两道兜住，
   **绝不静默按 `main` 落库**。
3. query 与 header 都给且不一致一律 400 `invalid_session`：宁可让调用方改对，也不替它挑一段会话。

**验收边界**：`scripts/test-s4-e2e.sh` 用独立临时网关按两道只读能力位探测自动启用 header
断言组（header 形态、query 优先、冲突 400、非法 400、header 响应能力位、老调用逐字不变）；
网关未识别 `x-crew-session` 时逐条标 deferred，由 lead 以
`S4_REQUIRE_HEADER=1 sh scripts/test-s4-e2e.sh` 跑绿。消息面把 header 交给 `phoneHandler`、
向下转发到网关，以及桌面端 query / header 双写，由 lead 集成时合并并另验；本脚本只验独立
临时网关的线上字节，不替代消息面与真机证据。

### 9.8 Source 准入：会话名单是唯一真源

「未登记会话不静默丢消息」在 S1 只是文档说明，S4 落成机制：手配的
`ConfigSchema.conversations` 保留（老配置照旧），`scope()` / `channel.allowed` 在它之外合并
`KV.mobile.sessions` 注册名单；会话名单是准入的唯一真源，`masterId` 与 DSH 上游不动。
Source 拿不到 `store` 时经 `SourceContext` / settings 注入，不用全局可变状态。

四条断言与各自的证据口径：

| # | 断言 | 可观测证据 |
| --- | --- | --- |
| 1 | 落队列 | 未登记会话发的消息进 `mobileq.db` 的 `messages` 行，`conversation` 就是那段会话 id |
| 2 | 可读 | `timeline?session_id=<未登记>` 读回它，不凭空消失 |
| 3 | 不派单 | `scope()` 明确给出 `conversation_not_listed`，并在 health/detail 或日志 / 计数里留一条**可观测记录**；不产生 Trigger / Ticket，禁止「什么都没发生」 |
| 4 | 注册即生效 | `POST /api/mobile/sessions` 登记后，该会话消息立刻可派单，不手改 Source 配置、不重启 |

`scripts/test-s4-e2e.sh` 用独立临时网关覆盖 1 / 2 与 3 的队列层证据（`read_at` 为空、无回复行）；
3 的 `scope()` 记录与 4 的注册即生效由 `backend/tests/source-session-admission.spec.ts` 表达，
脚本在该文件存在时调用它。真机里「第二个 conversation 真派单后 `/state` 与归档守卫仍正常」
仍属 §9.4 的真机欠账，本轮没有真机证据。

**两处边界（实现如此，按字面验收会以为漏了）**：

- **不补派历史**：游标在拒收后照样前进，所以登记**之前**已经越过游标的旧消息不会被补派。
  断言 4 的「立刻可派单」指登记后新到的消息。这是刻意的：否则一次登记会把整个历史队列
  倒进 Engine。需要补历史就手动 `mobileq inject`，别指望登记回溯。
- **`main` 不在注册名单里**：`main` 是缺省会话，恒在名单首位但**不落键**
  （`POST /api/mobile/sessions {id:"main"}` 返回 200 但什么都不写）。它的准入仍靠手配
  `conversations`，所以 `runtime.ts` 里 routine 派单与 handOff 造的 `conversation: 'main'`
  Trigger 不受 S4 影响 —— 那是既有行为，不是回归。
- **快照不回溯**：名单快照随 Trigger 落库，旧 Mandate 的 `revalidate` 按**当时**的快照判。
  会话后来从名单移除，历史票据不会因此失效。要改这条就得在 revalidate 时重读名单，
  属于独立决策，见 ADR 0007。

## 10. 群组只读投影（groups）

群组是**只读投影**，不是第二本账。`backend/src/app/groups.ts` 的纯函数
`groupsOf({ sessions, bots, tickets })` 从已有 sessions / bots / tickets 派生 `groups[]`；
`GET /api/mobile/timeline` 顶层加只读字段 `groups`（与 `items` / `tasks` 同级），不新开路由、
不改路由语义。

```jsonc
{
  // 整份投影是一个对象（groups / state / reason 同层），不是三个并列的顶层字段。
  "groups": {
    "state": "live",              // live | empty | unavailable
    "reason": "…",                // 只在 state != live 时出现，一句给人看的中文
    "groups": [
      {
        "id": "main",             // 按会话归属为主；无归属的 bot 落 main 组
        "title": "主会话",
        "sessions": ["main"],
        "bots": ["lead"],
        "ticket_count": 2         // 从已有 tickets 数出来的只读计数，不是新增 Ticket 账
      }
    ]
  }
}
```

- **结构**：每项 `{ id, title, sessions: [...], bots: [...], ticket_count }`；按会话归属为主，
  bot 按归属会话归组，无归属的落 `main` 组。`groups` 恒为数组，缺省按 `empty` 处理但不许
  把「读不到」说成「没有」。
- **三态不许合并**：`live` = 有归组数据；`empty` = 读得到、确实没有；`unavailable` = 读不到
  （宿主没接这项能力 / 会话树打不开），客户端只说「读不出来」，不得说「还没有群组」。
  `reason` 只在非 `live` 时出现，可直接显示。
- **`empty` 在实际链路上几乎不可达**，这是刻意的：`sessions` 恒含 `main`，而 `main` 组
  确实存在（只是可能没有 bot 与票），所以「只有 main、无 bot、无票」判 `live` 而不是 `empty`。
  真正会说 `unavailable` 的是读票 / 读名单失败 —— 那时整条时间线照常 200，只把这一格标成
  「读不到」，绝不因此让整个时间线失败。
- **只读**：零新增 Ticket 账、零新增持久化状态、不改路由语义；`ticket_count` 只数不写。
  没有群组写路由（不存在 `POST /api/mobile/groups`），客户端不得本地改完 `groups` 当落盘。
- 桌面端 `desktop/ui.go` 用 `Conversation.Groups` 画只读栏，手机端不改（#14 只要求桌面或真机
  二选一）。`groups` 的接入字段位置、import 与断言由 lead 在集成时与本节对齐。
- **验收边界**：三态与结构由 `backend/tests/groups.spec.ts` 覆盖，脚本在该文件存在时调用它；
  群组投影在真机或桌面端实际打开看过（#10 第 4 项）仍属 §9.4 的真机欠账。
