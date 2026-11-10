# 客户端配对的出码例外，以及手机写花名册

> 状态：Accepted，2026-11-10。修订 [0002](0002-clients-use-message-surface-only.md) 的两条边界：
> 「客户端不接管理面」与「要改配置就回面板」。

## 背景

0002 的结论是 desktop 与 app 都只接消息面。它留下了一个没有回答的问题：客户端怎么合法拿到凭据。

现在的答案是设备凭据（`x-crew-device` + `x-crew-credential`），而签发它需要一支配对码。
配对码只由管理面的 `DeviceStore.issue` 产生，`POST /api/remote/pairing` 是唯一出口；
它被 `pairingFence` 限制在回环 Host + `x-orchestrator-request`。

同时，空态页要求人在手机上「加第一位」。原来的实现只能让人回电脑改配置，
这不是一个可交付的空态。

## 决策

1. **本机客户端可以用管理面的一条路由出码**。`desktop/` 打 `POST http://127.0.0.1:<webPort>/orchestrator/api/remote/pairing`，
   带头 `Host: 127.0.0.1:<webPort>`、`x-orchestrator-request: 1`、`origin`。它本来就在本机，围栏要的就是这个。
   出码后立刻走消息面 `POST /api/mobile/pair` 兑换，凭据只落本机 `~/.config/crew-desktop/credential.json`。
2. **手机永远不碰管理面**。手机只调 `/api/mobile/*`；兑换码这一跳由 `lan-server` 放行，
   因为这时它还没有凭据，码就是它的凭据。放行有速率上限（每来源地址 60 秒 20 次）。
3. **手机可以写花名册**。`GET` / `POST /api/mobile/bots`，写入的是 team Source 的 `config.bots`。
   只改 `config`，不动 `enabled`；队里没有 default 时，新加的这位顶上，让坏配置能自愈。

## Consequences

- 0002 的「客户端拿不到配置能力」不再成立：手机能增 Bot，但只能增 Bot——没有 settings、prompts、executor 的入口。
- 新增了一个小小的信任面：局域网里任何人可以拿一支码来换凭据。限速 + 码的 5 分钟有效期 + 兑换即作废，
  加上 `remote.pairing = deny` 可以整体关掉。
- Electron 的网页端口是启动时随机分配的，desktop 用「同一进程的监听端口」反查它；
  这是发现逻辑，不是鉴权绕过。
