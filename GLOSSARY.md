# GLOSSARY

这个仓库里的词，只在这一个地方定义。代码、文档、提交信息都用这里的说法。

## 四个块

**backend**
superagent 后端。原来的 dsh-superagent，现在住在本仓 `backend/`。它在 dsh 进程里跑（是 dsh 的 bundle 插件），不是独立服务。
它持有唯一的工作状态账（Ticket），并对外提供两套 HTTP 面：管理面与消息面。

**dsh-bridge**
dsh 侧的配置层。放 profile 补丁、worker/router 两个 preset 的定义、启动脚本。
它**不是**一个插件工程，也不重新实现 dsh 的会话接口——那些调用发生在 dsh 进程内，不经过网络。

**desktop**
macOS 桌面端。Go + mygo（`github.com/egoist/mygo`），原生 UI，不用 webview。

**app**
Android 客户端。Kotlin + Compose 原生重写。旧仓 `~/Code/dsh-mobile-app` 已不再被引用。

## 两套 HTTP 面

**管理面（management surface）**
`/orchestrator/api/*`，后端在 dsh 的 webServer 上注册的一层。
给配置与排障用：settings、sources、prompts、executor。
外部客户端**不接这一层**，原因是它的同源围栏要求 Host 头严格等于 `127.0.0.1:<port>`。

**消息面（message surface）**
`/api/mobile/*`。两个入口：浏览器走 DSH Connection（Host/Origin/会话）；桌面端与手机走独立监听
（`lan-server`），鉴权是设备凭据（`x-crew-device` + `x-crew-credential`）。
除首次配对那一条外都要凭据，见 [ADR 0003](docs/adr/0003-client-pairing-and-roster-writes.md)。
这是人跟 Bot 说话的唯一入口。

## 对话

三者分层，别混用：`masterId` 是 DSH 会话层、`conversation` 是队列 / 领域层、`session_id` 是线上消息面层。取舍见 [ADR 0007](docs/adr/0007-multi-session-seam.md)，线上字节与客户端规矩见 [契约 §9](docs/00-contract.md)。

**masterId**
DSH 总路由 Session 的 id，全队伍**单值**，不随人开的「会话」增减。多会话只落在 `conversation` / `session_id` 那一层，不动它；worker 各自的 Session 与它也不是一回事。
_Avoid_: 会话 id、session_id、crew 指纹、instanceId

**conversation**
一段消息流的稳定标识，领域词：队列按它分列、按 thread 分组。它切的是**消息**，不是 DSH 的 Session。id 缺省 `main`，可有多段；与线上消息面的 `session_id` 一一映射。
_Avoid_: Session、masterId、session_id（线上字段名）

**session_id**
线上消息面的字段名：一次请求选哪一段 conversation，值就是那段 conversation 的 id，缺省 `main`。它是**传输层的字段**，不是 DSH Session，也不是队列列本身。载体有 URL query 参数 `session_id` 与请求头 `x-crew-session` 两种，**query 优先、header 兜底**；两者都给且不一致 → 400 `invalid_session`。手机端只用 query，桌面端非 `main` 双写且值相同；两种载体都不带即老调用，缺省 `main`。它只有 id 没有显示名 —— 名字由客户端派生，后端不提供（见 **会话名单（sessions）**）。取舍见 [ADR 0007](docs/adr/0007-multi-session-seam.md)，线上字节与裁决见 [契约 §9.7](docs/00-contract.md)。
_Avoid_: masterId、Session id、conversation_id、X-Session-Id（头名是 `x-crew-session`）、会话标题 / 显示名

**x-crew-session（header 形态 session_id）**
`session_id` 的 header 载体，与 `x-crew-device` / `x-crew-credential` 同族。query 优先、它兜底；能力位判据同步覆盖带它的请求。老网关不认它由能力位先验 / 409 兜住，**不静默按 `main` 落库**（[ADR 0007](docs/adr/0007-multi-session-seam.md) 的裁决）。
_Avoid_: X-Session-Id、X-Crew-Session-Id、`session_id`（那是 query 参数名）

**能力位（session_api）**
后端在显式会话响应里回显的标记，`1` 表示这台后端按会话分片、认得 `session_id`；判据同时覆盖 query 与 `x-crew-session` 两种载体。口径是「显式会话请求的**所有**响应都带」，不按状态码分档，错误响应也不例外 —— 消息面把它做成**单一注入点**（`reply()`），所以这条口径不靠逐条分支记得补。唯一的例外是 `unsupported_session`（那条错误的意思正是「对端未升级」，再说 `1` 会自相矛盾）与网关的 400（那里 `_send` 解析不出会话值就注入不了）。它只说明「对端已升级」，不说明那个 id 合法、也不说明这次请求被服务了。客户端先验它再启用显式非 `main`；缺位即视为老后端，锁 `main` 并如实提示，不静默降级。细则见 [契约 §9.3](docs/00-contract.md)。
_Avoid_: feature flag、版本号、能力协商（它不是一次协商，只是响应里的一个回显字段）

**会话名单（sessions）**
后端持有的会话 id 列表，`main` 恒在首位，配一个 `default_session_id`。唯一真源在后端，客户端每次启动重新拉，不落盘；它也是 Source 准入的唯一真源（S4）：`scope()` / `channel.allowed` 合并手配 `conversations` 与注册名单。
**条目就是 id 字符串**（`["main", "work", ...]`），后端不提供 `name` / `title` 之类的显示名，这是明确裁决而非遗漏：显示名是产品决策（叫什么、能不能改名、改到哪去），后端先发一个就成了事实上的默认值。显示名由客户端按需派生（如 `main` 显示为「主会话」，其余先显示 id）。裁决与理由见 [契约 §9.2](docs/00-contract.md)。
_Avoid_: 本地名单、缓存名单、花名册（那是 Bot 目录）、显示名 / name（后端不提供）、会话标题

**当前会话（current session）**
客户端此刻选中的那一段 conversation 的 id。它落盘以便下次启动恢复，缺键回落 `main`；只是名单里被选中的一个值，不是名单本身。
_Avoid_: 默认会话（那是 `default_session_id`）、masterId、会话名单

**Bot 队伍（crew）**
一组 Bot 在 conversation 里接话。Bot 靠 `@bot_id` 被点名；没人点名时由 default 那个接。

**BotCard**
Bot 的名片：`bot_id`、`name`、`role`（default 或 member）、`persona`、`memory_namespace`。
Bot 是身份与呈现，**不是** Agent，也不持有任何任务状态。

**mention**
消息里 `@<bot_id>` 的引用。只决定谁接话，不构成任何授权。

## 工作

**Ticket**
一件活的状态主体，也是唯一的真源。开→干→结束，可以重开。
前端看到的 `ticket_ref`、`tasks[]` 都只是 Ticket 的只读投影，**不得**据此维护自己的状态机。

**worker**
一个 Ticket 对应一个 dsh Session，id 恒为 `worker-<ticketId>`。

**attention**
Bot 卡在某个问题上等人回答的状态。表现为 Ticket 上的一条 question。

## 出门

**relay / 中转**
`relay/` 那个服务。宿主**出站**连它，手机从任何地方连它，它按 `instanceId` 把请求送回宿主。
它不存状态、不验设备凭据、不认识业务路径。

**tunnel / 隧道**
宿主与中转之间那条 WebSocket 连接（`backend/src/app/tunnel.ts`）。`live` 之外的状态
都意味着此刻手机走隧道会失败。

**instanceId**
一台宿主在中转上的名字。手机用它选机器，所以必须稳定 —— 换了它，手机就要重新找路。
不显式配置时由状态目录算出来。

**crew 指纹**
mDNS TXT 的 `crew` 字段（`backend/src/app/discovery.ts` 的 `crewFingerprint`），同样是
由状态目录算出的短哈希，与网卡、IP、网段都无关。手机配对时把它存进 `PairedCrew.crew`，
重新发现时靠它认「还是同一台」并刷新随网段变化的局域网地址。
与 `instanceId` 同源但用途不同：`instanceId` 是**中转上的机器名**（手机选路），
`crew` 是**局域网广播里的队伍身份**（手机认人）。两者都不是 DSH 的 Session id
（那是 `masterId`）；三套词别混用。

**降级链**
从便宜到贵排好的三条路：`lan` → `relay.self` → `relay.fallback`（`docs/06-relay.md`）。
兜底与被兜底不能共享故障域，否则兜底等于没有。

## 网关与队列

**gateway / mobilegw**
`backend/tools/mobilegw`，一个本机小服务（默认 `127.0.0.1:8788`），只认 `X-GW-Token`。
它把消息面翻译成队列读写。

**queue / mobileq**
`<stateDir>/mobileq.db`（SQLite）。gateway 与 backend 之间的传输层，人看不到。

**读走（read_at）**
`mobileq.db` 的 `messages.read_at`：`mobileq pull` 把一条消息交给路由、或插队的 `claim`
把它交给 worker 的那一刻写下的时间。它是队列那一侧**唯一**的「读没读」记录，撤回也按它判 409。
它说的是「队伍有没有拿到这条话」，**不是**「主人有没有看过队伍的回话」——后者没有任何回执。

**未读（unread）**
人发出去、队伍还没读走的条数，就是从 `read_at` 空着的那些消息数出来的（契约 `00` §5.6）。
`unknown` 表示网关没报这一列，此时**不画徽标**：算不出来不等于 0 条。

## 群组与准入

**Source 准入（conversation_not_listed）**
Source 判一段 conversation 能否派单的结果。未登记会话明确给 `conversation_not_listed` 并留可观测记录；消息仍照原会话落队列、可按 `session_id` 读回，只是不派单、不凭空消失。名单见 **会话名单（sessions）**，见 [契约 §9.8](docs/00-contract.md)。
_Avoid_: 静默丢消息、默认会话（那是 `default_session_id`）、会话切换

**群组只读投影（groups）**
从已有 sessions / bots / tickets 派生出的 `groups[]`，每项 `{ id, title, sessions, bots, ticket_count }`。只读：零新增 Ticket 账、零新增持久化状态、不新开写路由；`ticket_count` 只数不写。见 [契约 §10](docs/00-contract.md)。
_Avoid_: 群组账本、第二份 Ticket 账、可编辑群组

**群组三态（groups_state）**
`live`（有归组数据）/ `empty`（读得到、确实没有）/ `unavailable`（读不到）。读不到不许说成没有；`reason` 只在非 `live` 时出现，口径与产出、常规任务、记忆三态一致。
_Avoid_: 把 unavailable 画成空、把空画成 live、布尔开关

