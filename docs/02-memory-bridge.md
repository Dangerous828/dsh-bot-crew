# 02 · 记忆桥

## 为什么不能直接调现有插件

`dsh-auto-memory` 只在 **agent/disposed**（会话真正关闭）时固化，只采集 `source.kind = user` 的消息；
后台投递的消息来源是 `dsh-superagent`，且 worker/router 的工具允许名单里没有 `memory_*`。
硬调等于白等。所以桥的做法是：**按插件的格式自己落盘，让现成的上行链路把活干完。**

```
每个 Bot 一份小本本（本地：人格 / 口吻 / 本轮上下文 / 稳定事实）
        │  Ticket settled 时挑稳定事实
        ▼
按 dsh-auto-memory frontmatter 写 md，namespace = bot/<bot_id>
        │
        ▼
$DSH_HOME/memory/  ← 插件 + 30 分钟定时兜底都在这读写，照旧
        │  local_dream 的 dsh_memory 直通源（不二次蒸馏）
        ▼
中枢 Hub（跨 Agent 长期事实：owner 偏好 / 决策 / 已关单结论）
        │
        ▼
开新活时按 bot_id 注入 worker（只注入该 Bot 该知道的）
```

## 分流规则（最重要）

| 内容 | 放哪 | 上 Hub |
| --- | --- | --- |
| 人格、口吻、本轮上下文、Bot 自己碎碎念 | 本地 `bot/<bot_id>` | **否** |
| 该 Bot 长期项目事实 | 本地 | 否（除非别的 Agent 也需要） |
| owner 偏好 / 明确决策 / 已关 Ticket 的结论 | 本地 + Hub | **是** |

不这么分流，几个 Bot 天天聊会把 Hub 灌满，且把「谁说过什么」和「全局事实」混成一个真源。

## 写入约定

- 一条记忆一个 md，frontmatter 字段与插件 1.3.0 一致（`name` / `type` / `description` / `created` / `updated` / `status` / `importance` / `evidence` / `disabled`）。
- `name` 带 `bot-<bot_id>-` 前缀，`description` 单行（多行 YAML 曾在桥接解析里丢过）。
- `status: candidate` 照常注入，不需人工验证；`disabled` / `disputed` / `superseded` 不注入。
- 纠错写新条 + `supersedes` 指向旧条，不做 hard delete。
- 只在 **Ticket 关闭 / settled** 时写，避免半截事实；同 `dedupe_key` 幂等。
- 单 Bot 每日上 Hub 条数设上限，防写爆。

## 读取约定

- `recall(bot_id, query)` → 先查该 Bot 的本地 namespace，再查 Hub（注入块有字符预算上限）。
- 只把召回结果作为 **worker 的输入片段**，不写回后台 Ticket 状态。
- 大哥额外可读一份「全队近期已关单结论」的汇总，用于回答「大家都在干嘛」。

## 本仓库不提供什么

- 不内置 Hub 地址、token、写入实现；上行交给用户已有的 `local_dream` 直通链路。
- 不 fork `dsh-auto-memory`；适配层只产/读它认得的 md 格式。
- 不引入第三方记忆框架，避免与中枢 Hub 形成第三个真源。

## 状态

骨架（`src/memory/adapter.ts`），尚未接线。第一阶段先跑通「本地小本本 + 按格式落盘」，Hub 上行等第一条稳定事实跑通再接。

## 实测：记忆真的能写、能读（2026-11-09）

之前这一层只是「渲染 + 路径」的纯函数，真正落盘由宿主实现。现在把路径直接告诉 worker
（它有 `danger-full-access` 的 bash），它自己读写：

**第一单**：「记住一条：文案基调是克制、不堆词，写进你的记忆，告诉我路径。」

```
[scribbler] 写手已存好，路径：`/Users/cpuser/.dsh/memory/bot/scribbler/bot-scribbler-tone-concise-no-padding.md`
```

文件真的出现了，格式正确：

```markdown
---
name: bot-scribbler-tone-concise-no-padding
title: 文案基调：克制、不堆词
description: "写手的固定文案基调 =「克制、不堆词」…"
type: feedback
updated: 2026-11-08
---

（正文：用户原话、这条为什么是长期标准、具体怎么执行）
```

**第二单**（全新工单、新 worker 会话）：「你的记忆里有关于文案基调的东西吗？」

```
[scribbler] 有：「克制、不堆词」。不加情绪渲染，不堆形容词；先交一版可用稿，再按反馈收。
```

跨工单召回成立。关键点：

- `name` 以 `bot-<id>-` 开头，所以文件跑出 namespace 也能看出属于谁；
- 一条事实一个文件，frontmatter 带 `description` 与 `type`，与 `dsh-auto-memory` 的格式一致，
  现有上行链路可以直接搬去 Hub，不需要 fork 插件；
- 提示词里同时写了**什么不该记**：临时闲聊、一次性措辞、用户要求忘掉的。

`docs/02` 前面几节的分流策略（Bot 的留本地、团队的才上 Hub）仍然成立，这里只是把「谁来写」落实了。
