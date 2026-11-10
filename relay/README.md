# dsh-bot-crew 中转

宿主的**出站**隧道 + 中转服务端。手机在别的网络时，靠它连回家里那台电脑。

```
手机 ──https──► 反代 ──http──► 中转（本目录） ◄──wss── 宿主（backend/src/app/tunnel.ts）
```

它解决的是 `backend/src/app/lan-server.ts` 解决不了的那一半：局域网直连出了门就不存在。

## 是什么、不是什么

**是**：把手机打到 `/i/<instanceId>/...` 的请求，按 instanceId 路由到那条隧道的宿主上，
流式转发、流式回传，并且在中转和宿主之间维持心跳、重连、背压与限额。

**不是**：

- 不存任何状态。没有数据库、没有磁盘、没有会话，重启即清空。
- 不验设备凭据。凭据摘要只在宿主手里，中转靠「宿主的回答」计数与封禁（见 PROTOCOL.md）。
- 不认识业务路径。它只管 `instanceId` + 剩余路径，不校验 `/api/mobile/` 前缀 ——
  多一道业务白名单只会让「宿主换了前缀、中转没跟上」变成一次线上事故。

## 跑起来

```sh
pnpm install
pnpm test          # 50 条
pnpm typecheck
pnpm build && node dist/main.js
```

零运行时依赖：只用 Node 的 `http` + 手写的 WebSocket 子集（`src/websocket.ts`）。

## 配置

全部走环境变量，缺省值在 `src/main.ts`。

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `RELAY_PORT` | `8787` | |
| `RELAY_HOST` | `0.0.0.0` | 容器里必须这样；**公网暴露前一定要有反代** |
| `RELAY_REGISTER_SECRET` | 无 | 不设则任何人都能抢注一个 instanceId |
| `RELAY_ADMIN_TOKEN` | 无 | 设了才有 `GET /health?detail=1` |
| `RELAY_HEARTBEAT_MS` | `15000` | 发 ping 的节奏 |
| `RELAY_PONG_TIMEOUT_MS` | `60000` | 收不到 pong 就 terminate |
| `RELAY_RESPONSE_TIMEOUT_MS` | `120000` | 宿主多久不给响应头就 504 |
| `RELAY_MAX_BODY_BYTES` | `262144` | 手机请求体上限 |
| `RELAY_MAX_INFLIGHT` | `64` | 一个实例同时在跑的请求上限 |
| `RELAY_AUTH_FAILURE_LIMIT` | `20` | 同一来源在窗口内失败多少次后封禁 |

## 端点

| 路径 | 说明 |
| --- | --- |
| `GET /tunnel` | 宿主的 WebSocket 升级。别的路径一律 404 |
| `GET /health` | 公开：`{ok, uptimeMs, tunnels}`。**不列 instanceId** |
| `GET /health?detail=1` | 要 `Authorization: Bearer <adminToken>`：加上 `instances[]`、`blocked` |
| `ANY /i/<instanceId>/<rest>` | 转发到那条隧道 |

## 部署

见 [`docs/DEPLOY-NAS.md`](docs/DEPLOY-NAS.md)。

## 协议

见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

## 改了协议怎么办

协议实现只有一份，中转这边是拷贝：

```sh
# 改 backend/src/app/relay-protocol.ts，然后
sh relay/sync-protocol.sh
cd backend && npx vitest run tests/relay-protocol.spec.ts   # 对拍 AI-HUB 的参考实现
cd relay && npx vitest run tests/parity.spec.ts              # 两份拷贝逐字节一致
```

`tests/parity.spec.ts` 红了会直接告诉你两条拷贝在第几行分叉、以及要跑哪条命令。
