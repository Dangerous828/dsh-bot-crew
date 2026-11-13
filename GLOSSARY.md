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

三者分层，别混用：`masterId` 是 DSH 会话层、`conversation` 是队列 / 领域层、`session_id` 是线上消息面层。取舍见 [ADR 0007](docs/adr/0007-multi-session-seam.md)。

**masterId**
DSH 总路由 Session 的 id，全队伍**单值**，不随人开的「会话」增减。多会话只落在 `conversation` / `session_id` 那一层，不动它；worker 各自的 Session 与它也不是一回事。
_Avoid_: 会话 id、session_id、crew 指纹、instanceId

**conversation**
一段消息流的稳定标识，领域词：队列按它分列、按 thread 分组。它切的是**消息**，不是 DSH 的 Session。id 缺省 `main`，可有多段；与线上消息面的 `session_id` 一一映射。
_Avoid_: Session、masterId、session_id（线上字段名）

**session_id**
线上消息面的字段名：一次请求选哪一段 conversation，值就是那段 conversation 的 id，缺省 `main`。它是**传输层的字段**，不是 DSH Session，也不是队列列本身。
_Avoid_: masterId、Session id、conversation_id

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

