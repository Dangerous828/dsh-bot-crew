# 客户端只接消息面，不接管理面

两套 HTTP 面并存：管理面 `/orchestrator/api/*` 给配置与排障，消息面 `/api/mobile/*` 给人跟 Bot 说话。

管理面的同源围栏（`backend/src/app/http.ts:75-79`）要求 Host 头严格等于 `127.0.0.1:<port>`，并要求 `x-orchestrator-request: 1`。浏览器发不出这个头——这正是「去 team 回答」按钮点开是 401 的根本原因。Android 的 OkHttp 与 Go 的 http.Client 能覆盖 Host，但那是绕过围栏，不是接入。

所以决定：**desktop 与 app 都只接消息面**（`/api/mobile/send`、`/api/mobile/timeline`），鉴权走 DSH Connection。管理面留给面板和 `scripts/dsh-superagent status`。

## Consequences

- 客户端拿不到 settings、prompts、executor 这些配置能力。第一版不需要；要改配置就回面板。
- 消息面返回 `tasks[]` 只是 Ticket 的只读投影，客户端不得据此维护任务状态机（见 `GLOSSARY.md` 的 Ticket 条）。
