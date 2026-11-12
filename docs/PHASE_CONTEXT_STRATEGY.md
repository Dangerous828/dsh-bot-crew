# 上下文策略：去入口截断，回归 DSH compaction 的存算分离

2026-11-12。这是一次**架构对齐**，不是改阈值。

## 目标

无限上下文 + 存算分离：**存** = 完整会话日志永不丢；**算** = 每次只把「摘要 + 近期窗口 + 按需回读」喂进模型。上下文对使用者无限，对模型是有限窗口，靠压缩 + 回读桥接，**不靠在入口把用户写的话砍掉**。

## DSH 已提供的能力（实测确认）

`/Applications/DeepSeek Harness.app/.../node_modules/@deepseek-ai/` 下有完整压缩体系：

- `dsh-compaction`（约定）、`dsh-compaction-basic`（后端，token 压力自动压缩 + 溢出压缩重试 + `/compact`）、`dsh-compaction-tool-result-pruner`（超大工具输出修剪）、`dsh-compaction-image-offload`、`dsh-token-meter`（测量）。
- 其机制：token 压力上升时把最旧历史压成摘要、保留近期；**被遮蔽内容仍在会话日志，可确定性回放**。

本项目 `backend/cordis.patch.yml` 的 **worker preset 与 router preset 两处**都已挂 `compaction-basic` + `command-compact` + `tool-result-pruner`。所以大哥（worker）与主 Session **本来就在无限上下文机制下工作**。

## 修掉的错误设定（入口硬截断，共 4 处）

这些截断发生在 compaction 之前，把本应由 compaction 管理的完整内容在交付层就砍掉了，与无限上下文设计相反：

| 文件 | 原值 | 现值 |
|---|---|---|
| `backend/src/executor/dsh.ts` `triggerMessage` | `TRIGGER_CHARS = 600`（用户消息只喂前 600 字） | 全文进上下文；仅单条 > `INLINE_HARD_CAP = 200_000` 字（防一次几 MB 贴文打爆网关）才退回指针 |
| `backend/src/executor/dsh.ts` 派工说明 / input 交付 | `ASSIGNMENT_CHARS = 1500` | 同上，全文进；极端超长才指针 |
| `backend/src/app/notices.ts` `resultRelay` | worker 报告回主 Session 截 600 | 全文进（主 Session 也有 compaction） |
| `backend/src/app/assessment.ts` `orchestrator_eval` | 待评估 trigger 只读 `TRIGGER_CHARS = 4000` | 全文进（`text: trigger.text`） |

## 保留的截断（正确，未动）

- **列表/卡片预览**（`cards.ts` preview 160、`views/*` preview、`resources.ts` 列表 `preview 80`）：带 `chars` + `read`，点开分页读全文 —— 是展示缩略，不是丢内容。
- **资源正文读取**（`cards.ts` `textPage` / `resources.ts`）：`total_chars` + `next_offset` + `offset` 严格分页，全文可完整读回。
- **线程历史邻居**（`assessment.ts` `NEAR_CHARS 1200` / `WINDOW_CHARS 400` / `STUB_CHARS 50`）：评估窗口只内联窗口内消息，窗外经 `orchestrator_eval_read` 读全文 —— 分页上下文，正确。
- **记忆召回**（`memory/recall.ts` `RECALL_MAX_CHARS 1200`、`memory-layer.ts`）：召回本就是「相关的一小片」，是记忆不是对话串。
- **压缩摘要落账**（`compact-memory.ts` `MAX_SUMMARY_CHARS 1200`）：账本里一条摘要本就该短。

## 必须保留的硬边界（协议/存储/安全，未动）

`relay-protocol` 1MiB 帧、`tunnel` 64KiB 分帧、`lan-server` 256KiB（语音 8MB）、`voice` 8MB/120s、`push` 50 条、`pairing-throttle`、`outputs` 40/60、`work` 200 步、`screen` 500 字/120 条、`store-read` SQL LIMIT、`commands` stderr 2000、`retry-health` 8192 等 —— 全为防内存爆 / 防滥用 / 协议上限。

## 全仓审计方法

逐文件扫过 `backend/src` 全部 131 个非测试 `.ts` 文件的所有 `.slice(0,…)`、`_CHARS`、`_BYTES`、`_MS`、`Math.min` 上限，逐条定性为「入口丢内容（改）/ 摘要可回读（留）/ 协议硬边界（留）/ 单行显示省略（留）」。

## 验证

- `backend` 全量 **1712 用例通过**，`tsc --noEmit` 退出 0，隔离 `tsdown` 构建成功（未写 `backend/lib`）。
- 更新回归：`followups.spec`、`runtime-concurrency.spec` 的 trigger 卡断言、`tools.spec` 的 worker_report 断言，由「截断到 600/1500」改为「全文进」。
- 期间 `lan-server.spec` 的 300KB 真实 socket 用例在全并发下偶发超时，单跑与二次全量均稳定通过 —— 是测试时序抖动，与本次改动无关。

## 待真实环境

运行中的独立 crew profile 未重载新构建；部署后长消息全文进上下文、跨压缩边界的行为需真机联调确认。
