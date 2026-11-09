# dsh-bot-crew

**一句话**：后台只留一本账，前台摆一排工牌。

后台是 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)：
Gate 判谁能派活、Eval 判该不该开工、Mandate 留不可变授权、Ticket 是唯一的工作状态主体。

前台是「一队 Bot」：每个 Bot 是**一张脸 + 一份记忆 + 一套说话风格**，不是独立 Agent，更不是第二套任务账。
群里没人点名时，**大哥默认接话**；大哥可以转派、可以拉人进同一条讨论，但接活与记账仍归后台。

消息面的字段形状与前台 UI 参照 [BotHarness/DeepSeekBot（Tobs，MIT）](https://github.com/BotHarness/DeepSeekBot)，
只抄表层，不带它的域模型；来源与许可见 `THIRD_PARTY_NOTICES.md`。

## 四块

| 块 | 语言 | 是什么 | 从这里开始 |
| --- | --- | --- | --- |
| `backend/` | TypeScript | superagent 后端。持有唯一的工作账，跑在 dsh 进程里 | `cd backend && pnpm install && pnpm build && pnpm test` |
| `dsh-bridge/` | 配置 + 脚本 | 把后端装进一个 dsh profile 并起起来 | `./dsh-bridge/up.sh --profile crew` |
| `desktop/` | Go + mygo | macOS 桌面端，原生 UI，无 webview | `cd desktop && go run .` |
| `app/` | Kotlin + Compose | Android 客户端 | `cd app && ./gradlew assembleDebug` |

为什么后端离不开 dsh、为什么客户端只接消息面，见 `docs/adr/`；词表见 `GLOSSARY.md`。

## 文档

| 路径 | 是什么 |
| --- | --- |
| `GLOSSARY.md` | 这个仓库里每个词的意思，只在这里定义 |
| `docs/00-contract.md` | 消息面契约（消息 → Trigger 映射、@ 与默认大哥、回执、错误码） |
| `docs/01-architecture.md` | 两层分工、三条硬约束、为什么不合并内核 |
| `docs/02-memory-bridge.md` | 记忆桥：本地小本本 → `dsh-auto-memory` 格式 → 中枢 Hub |
| `docs/03-host-wiring.md` | 怎么挂到宿主上 |
| `docs/04-verified.md` | 已经实测过的结论 |
| `docs/05-running.md` | 怎么把后端跑起来 |
| `docs/adr/0001` | 后端留在 dsh 进程里，不抽独立服务 |
| `docs/adr/0002` | 客户端只接消息面，不接管理面 |
| `.scratch/four-blocks/` | 这次拆四块的规格与票据 |

## 状态

- 契约、名录、路由、`team` Source、记忆适配层**已实现并通过类型检查**。
- 在 `backend/` 里已验证：`tsc` 0 错、1276 个测试全绿、构建通过。
- **完整闭环已跑通**：手机/队列消息 → Trigger → Eval → Ticket → worker 执行 → 回话，实测建了文件并两段回复。
- **@ 路由已验证**：@写手 → `scribbler`、@码农 → `coder`、无人 @ → `lead`；回话按 `bot_id` 署名，并已透传到手机时间线。
- **团队意识**：worker 知道自己队里还有谁，不会替队友作答。
- **记忆真正可用**：worker 能把自己的事实写进 `~/.dsh/memory/bot/<id>/`，下一个工单读得到（已实测跨工单召回）。
- **手机端到端已实测**：真 APK 在 Android 15 上连局域网后端，芯片选人、发消息、按 Bot 署名、执行并回报，全部走通。
- **角色边界是软约束**：worker 都有完整能力，提示词劝不住它替队友干活；靠署名让人看得见谁做的，靠点芯片换人。
- **隔离是约定不是强制**：所有 worker 跑在操作者同一个 OS 用户下，别的 Bot 的记忆文件读得到。提示词如实说了这点，没有假装有隔离。
- 手机端已加 Bot 芯片与署名，APK 可构建；后端已绑局域网地址，手机可直连。
- 前台还没做 Tobs 那套多会话/群组视图；现在是「一个对话 + 一排 Bot」。

详见 `docs/04-verified.md` 与 `docs/05-running.md`。

## 许可

本项目 MIT，见 `LICENSE`。抄来的表层契约与后续 UI 归原作者，见 `THIRD_PARTY_NOTICES.md`。
