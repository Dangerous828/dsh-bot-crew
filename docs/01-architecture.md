# 01 · 两层分工

```
消息面（群聊 / 私聊 / @ / IM / 手机）
        │  POST /send
        ▼
适配层  team SourceKind  →  Trigger（actor / addressed / thread / meta.bot_id）
        │
        ▼
后台    Gate → Eval → Mandate → Ticket → Assignment → Outbox
        │                    │
        │                    └─ bot_id 随 Mandate 附到 Assignment，只用于呈现
        ▼
worker-<ticket>  按 bot_id 注入 persona / memory_namespace / 工具集 / 署名
        │
        ▼
SourceChannel.send → 回写消息面（一个 Thread 可挂多个 Channel 地址）
```

## 三条硬约束

1. **一本账**。活的状态只在 Ticket。Bot 不建独立任务表，前台不把 `ticket_ref` 当自己的状态机。
2. **授权与呈现分离**。`meta.bot_id` 只影响「谁露面、用哪份记忆、按哪条 rule 接话」，不参与 Gate；跨 Source 身份映射仍是后台 Policy 的事。
3. **默认少打扰**。开箱 `observe`：只记 `would accept`，人工看过判定记录再小范围切 `auto`。Bot 一多，噪音最先崩。

## 为什么不合并内核

| 问题 | 后台原型 | Tobs | 裁决 |
| --- | --- | --- | --- |
| 状态主体 | Ticket 自定义 open→ended→可重开，明确拒绝「Ticket 跟随 Session」 | Assignment 的规范身份就是 DSH Session id，明确拒绝独立 Task 实体 | 互斥，选后台 |
| 授权 | Policy version → Gate → 不可变 Mandate | 长期 PersonaBot + Service/Workspace Grant，可随时撤销 | 互斥，选后台 |
| 会话拓扑 | 1 Main + 每 Ticket 一个 worker + 每 Ticket 一个目录 | N Bot × Orchestrator Root × Assignment Root | 不同层，前台只做身份 |
| 事件 | Trigger → Eval 决定要不要开工单 | Source Event → Inbox Admission → Wake Policy 决定要不要唤醒 | 层次错开，不叠 |

所以：Bot 做成 **Source 实例 + persona 注入**，Engine 与 `001-domain.md` 的裁决一行都不改。

## 阶段

| # | 产出 | 依赖 |
| --- | --- | --- |
| 0 | 本契约 + `src/contract/types.ts` | — |
| 1 | 消息面能收发（复用现有手机端队列与页面） | 0 |
| 2 | Bot 目录、大哥默认规则、persona 注入 | 1 |
| 3 | 群聊 fan-out、转派、主动回报 | 2 |
| 4 | 记忆桥（另见 `02-memory-bridge.md`） | 2 |
| 5 | 前台 UI 抄皮（roster / 群 / 私聊 / 大哥首页 / 头像 / 记忆演化） | 1 |
| 6 | 泛化上游 `007-architecture.md` 列出的 GitHub/飞书硬编码 glue；再接 IM | 3 |

## 上线前必做

- 官方原型 worker 以 OS 用户**无审批执行命令**，且 worker preset 裁掉了 `ask_user_question` / `present`。接 IM 或公网前先做独立账号 / 容器隔离，命令级人工确认架在执行层外。
- 每个 Source 的 `stateDir`、命令 shim、git config 与宿主工作 profile 分离。
