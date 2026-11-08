# dsh-bot-crew

**一句话**：后台只留一本账，前台摆一排工牌。

后台是 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)：
Gate 判谁能派活、Eval 判该不该开工、Mandate 留不可变授权、Ticket 是唯一的工作状态主体。

前台是「一队 Bot」：每个 Bot 是**一张脸 + 一份记忆 + 一套说话风格**，不是独立 Agent，更不是第二套任务账。
群里没人点名时，**大哥默认接话**；大哥可以转派、可以拉人进同一条讨论，但接活与记账仍归后台。

消息面的字段形状与前台 UI 参照 [BotHarness/DeepSeekBot（Tobs，MIT）](https://github.com/BotHarness/DeepSeekBot)，
只抄表层，不带它的域模型；来源与许可见 `THIRD_PARTY_NOTICES.md`。

## 目录

| 路径 | 是什么 |
| --- | --- |
| `docs/00-contract.md` | **阶段 0**：消息面契约（消息 → Trigger 映射、@ 与默认大哥、回执、错误码） |
| `docs/01-architecture.md` | 两层分工、三条硬约束、为什么不合并内核 |
| `docs/02-memory-bridge.md` | 记忆桥：本地小本本 → `dsh-auto-memory` 格式 → 中枢 Hub |
| `src/contract/types.ts` | 契约的 TS 类型（表层） |
| `src/sources/team.ts` | **阶段 2**：`team` SourceKind 骨架 |
| `src/memory/adapter.ts` | **阶段 3**：记忆读写适配层骨架 |

## 起步顺序

1. 定死 `docs/00-contract.md` 里的两个待拍板项（默认 Bot、记忆形态）；
2. 把 `src/sources/team.ts` 复制进 super-agent 的 `src/sources/` 并注册，接上现有 `tools/mobileq` 队列；
3. 记忆适配层先只做「本地小本本 + 按插件格式落盘」，Hub 上行等第一条稳定事实跑通再接；
4. 前台 UI 从 Tobs 抄皮（roster / 群聊 / 私聊 / 大哥首页 / 头像），数据层换成本契约的 `timeline` / `send`。

## 边界

- 不含 super-agent 内核代码，也不含任何本机私有改动；两边的仓库各自独立演进。
- 不提交任何凭据、本机绝对路径、Hub token。示例路径一律写成 `$DSH_HOME` / `<stateDir>`。
- 后台 worker 在官方原型里是**无审批裸跑**。接入 IM / 公网前必须先做独立账号或容器隔离。
- 默认 `observe`：先只记「本来会做什么」，人工看过判定准了再切 `auto`。

## 状态

骨架 + 契约，尚未接通后台运行时。

## 许可

本项目 MIT，见 `LICENSE`。抄来的表层契约与后续 UI 归原作者，见 `THIRD_PARTY_NOTICES.md`。
