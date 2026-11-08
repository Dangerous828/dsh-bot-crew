# Third-party notices

## BotHarness/DeepSeekBot (Tobs)

- 仓库：https://github.com/BotHarness/DeepSeekBot
- 许可：**MIT**（见上游 `LICENSE`）
- 用到什么：消息面**表层**字段形状（`timeline` / `send` 的 JSON、Bot 卡片字段、`@` 的表达、`request_id` 幂等、错误码），以及后续阶段计划搬运的前台 UI 组件（roster / 群聊 / 私聊 / 管家首页 / 像素头像 / 记忆演化视图）。
- 不用什么：PersonaBot、Channel、Source Event、Inbox Admission、Assignment Directory、Service Grant 等域模型与状态字段。本项目的状态主体只有后台的 Ticket。
- 上游 `packages/client/THIRD_PARTY_NOTICES.md` 中列出的第三方素材，在搬运对应 UI 组件时需一并核对并随该组件保留。

## deepseek-ai/dsh-superagent-prototype

- 仓库：https://github.com/deepseek-ai/dsh-superagent-prototype
- 许可：MIT
- 关系：本项目是它的**前台扩展层**，不 fork、不复制其源码；`src/sources/team.ts` 通过 `SourceKind` 插件位接入，需放到宿主 checkout 内编译。
- 上游 README 声明这是 research prototype，部分文章设计未实现；本项目继承该前提。

## dsh-auto-memory / 中枢 Hub

- `dsh-auto-memory` 与 home-hub 的记忆直通链路属于用户自有本地基建，不是本仓库依赖。
- 本仓库只约定**按插件 frontmatter 格式落盘**与**分流规则**，不内置任何 Hub 地址、凭据或写入实现。
