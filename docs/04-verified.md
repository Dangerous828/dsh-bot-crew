# 04 · 已经验证到什么程度

日期：2026-11-08

| 项 | 结果 |
| --- | --- |
| 契约纯逻辑（本仓库） | `tsc --noEmit` 0 错；20 个测试通过（Bot 目录校验、@ 路由、记忆渲染与路径、注入规则） |
| 宿主 `team.ts` 路由 | 10 个测试通过：成员 @ → 该成员、群里无人 @ → 大哥、私聊 → direct、未知 @ 记录后仍归大哥、Bot 回声丢弃、话题串 `conv:msg` / `conv:thread` |
| 环境注入 | `DSH_SUPERAGENT_CREW_{BOT,PERSONA,MEMORY,CONVERSATION}` 取值正确；非 team 来源的工单取空 |
| worker 提示词 | `## Bot you are` 只在 team 来源出现；无 crew 时提示词逐字节不变 |
| 宿主全量回归 | 1213 个测试通过，`tsdown` 构建通过 |
| `mobileq` | 新 `--mention` 与旧 `--mentions-me` 并存；`reply` 仍按 key 幂等；`thread` 含 Bot 回话 |

## 还没验证

- 真的跑起 orchestrator 的完整闭环（消息 → Trigger → Eval → Ticket → worker 回话）。需要配置模型、打开 Source、配好名单。
- 记忆落盘与 Hub 上行：适配层是纯函数 + 计划对象，真正的原子写与 `recall` 由宿主实现，尚未接。
- 前台 UI：还没从 Tobs 抄。
