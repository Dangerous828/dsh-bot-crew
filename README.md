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
| `docs/03-host-wiring.md` | **怎么接进宿主**：复制哪些文件、注册点、提示词小节、宿主自带的两条文档测试 |
| `docs/04-verified.md` | 已经验证到哪、还没验证什么 |
| `docs/05-running.md` | **怎么跑起来**：后端、网关、名录、模型、一条真消息、手机 APK |

## 两条命令

```sh
python3 scripts/configure.py   # 配名册、Policy、角色模型（幂等）
./scripts/doctor.sh            # 只读自检全链路
```
| `src/contract/types.ts` | 契约的 TS 类型（表层） |
| `src/crew/directory.ts` | Bot 名录：一个大哥 + 成员，以及名录必须守的规则 |
| `src/crew/route.ts` | 确定性路由：这条消息该谁露面；话题串 id |
| `src/sources/team.ts` | **完整**的 `team` SourceKind（放进宿主编译，见 docs/03） |
| `src/memory/adapter.ts` | 记忆读写适配层（渲染、路径、注入规则已测；落盘由宿主实现） |

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

- 契约、名录、路由、`team` Source、记忆适配层**已实现并通过类型检查**。
- 在宿主 `~/Code/dsh-superagent` 里已验证：`tsc` 0 错、1213 个测试全绿、构建通过。
- **完整闭环已跑通**：手机/队列消息 → Trigger → Eval → Ticket → worker 执行 → 回话，实测建了文件并两段回复。
- **@ 路由已验证**：@写手 → `scribbler`、@码农 → `coder`、无人 @ → `lead`；回话按 `bot_id` 署名，并已透传到手机时间线。
- **团队意识**：worker 知道自己队里还有谁，不会替队友作答。
- **记忆真正可用**：worker 能把自己的事实写进 `~/.dsh/memory/bot/<id>/`，下一个工单读得到（已实测跨工单召回）。
- **隔离是约定不是强制**：所有 worker 跑在操作者同一个 OS 用户下，别的 Bot 的记忆文件读得到。提示词如实说了这点，没有假装有隔离。
- 手机端已加 Bot 芯片与署名，APK 可构建；后端已绑局域网地址，手机可直连。
- 前台还没做 Tobs 那套多会话/群组视图；现在是「一个对话 + 一排 Bot」。

详见 `docs/04-verified.md` 与 `docs/05-running.md`。

## 许可

本项目 MIT，见 `LICENSE`。抄来的表层契约与后续 UI 归原作者，见 `THIRD_PARTY_NOTICES.md`。
