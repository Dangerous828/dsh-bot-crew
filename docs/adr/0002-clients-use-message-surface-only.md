# 客户端只接消息面，不接管理面

> 2026-11-10 修订：[0003](0003-client-pairing-and-roster-writes.md) 放开了两处——本机出码可以打一条管理面路由，
> 手机可以写花名册。下面「只接消息面」与「要改配置就回面板」按 0003 理解。

两套 HTTP 面并存：管理面 `/orchestrator/api/*` 给配置与排障，消息面 `/api/mobile/*` 给人跟 Bot 说话。

管理面的同源围栏（`backend/src/app/http.ts:75-79`）要求 Host 头严格等于 `127.0.0.1:<port>`，并要求 `x-orchestrator-request: 1`。浏览器发不出这个头——这正是「去 team 回答」按钮点开是 401 的根本原因。Android 的 OkHttp 与 Go 的 http.Client 能覆盖 Host，但那是绕过围栏，不是接入。

所以决定：**desktop 与 app 都只接消息面**（`/api/mobile/send`、`/api/mobile/timeline`），鉴权走 DSH Connection。管理面留给面板和 `scripts/dsh-superagent status`。

## Consequences

- 客户端拿不到 settings、prompts、executor 这些配置能力。第一版不需要；要改配置就回面板。
- 消息面返回 `tasks[]` 只是 Ticket 的只读投影，客户端不得据此维护任务状态机（见 `GLOSSARY.md` 的 Ticket 条）。

## 已知偏离（2026-11-09）

第一版客户端（`desktop/`、`app/`）连的是消息面之外的 gateway，不是本 ADR 说的消息面。
查证后确认这不是随手绕开，因为消息面挂在 DSH Connection 的 Fetch 分发器上（`mobile-http.ts` 的
`ctx.inject(['connection'])`），由 Connection 校验 Host、Origin、签名凭据和 owner；独立进程拿不到这套凭据，
硬接只会得到 401。gateway 则只认自己状态目录里的 `mobilegw.token`。

代价是具体的：消息面在 gateway 的 `items` 之上补了 `bots`/`default_bot_id`、`tasks`、`status` 三样，
而 gateway 只看队列、不读 settings，它的 `bots` 恒为空。所以第一版客户端显示不出 Bot 名录。

要把这条偏离收回去，先得回答"客户端怎么合法拿到 Connection 凭据"。那是设计问题，不是改接线。
