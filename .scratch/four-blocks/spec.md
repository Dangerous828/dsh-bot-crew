# 四块整理：backend / dsh-bridge / desktop / app

## 问题

`Dangerous828/dsh-bot-crew` 原本只有一个轻量 TS 契约层（637 行），后端主体在另一个检出 `~/Code/dsh-superagent` 里，客户端只有一个已废弃的 Android 仓 `~/Code/dsh-mobile-app`。三处代码互不知道对方，契约与实现已经漂移。

## 目标

一个仓库、四块、各自独立构建：

| 块 | 语言 | 职责 |
|---|---|---|
| `backend/` | TypeScript | superagent 后端，跑在 dsh 进程里，持有唯一工作账 |
| `dsh-bridge/` | 配置 + 少量脚本 | dsh 侧装配：profile 补丁、worker/router preset、启动 |
| `desktop/` | Go + mygo | macOS 桌面端，原生 UI，无 webview |
| `app/` | Kotlin + Compose | Android 客户端 |

已定决策见 `docs/adr/0001`、`docs/adr/0002`；词表见 `GLOSSARY.md`。

## 验收

1. 四块目录都在，各自有独立构建入口，`backend/` 的 1276 个测试全绿。
2. 契约与实现一致：`contract/types.ts` 的 `TimelineItem.role` 与网关实际发出的值相同。
3. `desktop/` 能编译并连上本机后端，显示队伍对话、发出一条消息、看到回复。
4. `app/` 能编译并在模拟器上完成同样的三件事。
5. 全仓没有指向 `~/Code/dsh-superagent` 或 `~/Code/dsh-mobile-app` 的活引用。

## 不做

- 不做通知推送（App 第二版再说）。
- 不做设置/日志的管理界面（回面板）。
- 不删 `~/Code/dsh-mobile-app`（等新 App 跑通并确认后再删）。

## 已完成的整理

- `backend/` 从 `~/Code/dsh-superagent` 迁入，`tsc` 0 错、**1276 测试全绿**、构建通过。
- 独有模块 `contract/`、`memory/` 并入 `backend/src/`；重复的 `crew/`、`sources/team.ts` 旧副本删除。
- 根 `tests/` 并入 `backend/tests/`（`crew-route.spec.ts`、`crew-memory.spec.ts`，20 项全绿）。
- 根 `package.json`、`tsconfig.json`、`vitest.config.ts`、指向别仓的 `node_modules` 软链删除。
- 文档与脚本里的 `~/Code/dsh-superagent` 路径改指 `backend/`。

## 已知缺陷（必须先修）

`backend/src/contract/types.ts:45` 声明 `role: 'bot' | 'user' | 'system'`，
而 `backend/tools/mobilegw:98,101` 实际发出 `'user' | 'agent'`，实测网关返回 `{'agent','user'}`。

新客户端照契约实现，编译期无恙、运行时把 Bot 消息全部当成未知类型。这是客户端开工前的阻塞项。

---

# 第二批：前端设计稿（2026-11-09）

八张票交付完之后，用户补了一系列设计需求。这一批只有设计，不含代码。

## 要什么

1. **亮色与暗色两套主题。** 配色参照 Meta Muse 的暖中性方向，不用原来偏冷的紫。
2. **补齐功能。** 参照 DSH 现有能力与 AI-HUB（`dsh-mobile-plugin`）的功能清单，但只补「队伍对话」说得通的部分。
3. **人设可见。** `BotCard` 有 `persona`、`avatar`、`color`、`memory_namespace`，界面要露出来。
4. **看后台与子代理。** 已派的活怎么做、子代理（含多层）都要能看见。
5. **手机连电脑。** 像 AI-HUB 那样连回桌面端 —— 用户明确说**先做前台能覆盖的，远程最后再做**。

## 明确排除

Git、文件浏览、插件市场、模型切换这几项，用户只保留「切换模型」，且模型切换依赖后端尚未提供的路由。

## 交付

`designs/personal-agent/`：九张画板，桌面四张（亮 / 暗 / 空态 / 断连）、手机五张（对话 / 暗色 / 队伍空态 / 名片 / 工作区）。
