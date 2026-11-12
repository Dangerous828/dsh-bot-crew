# TaskCard

工单卡是右栏「后台」的主体，展示 Ticket 的只读投影：标题、状态、执行人、进度、耗时、入口。

分层改用结构：`card` 底 + `line` 分隔 + `space-4` 内边距 + 字重 640，替掉旧的九种近白面。进度条分母只认后端 `total_steps`（worker 的待办清单），没有计划就不画 —— 这条口径见 `docs/00-contract.md` §5，**不因视觉优化改变**。

**静态参考**：Go (mygo) / Kotlin (Compose) 原生绘制，本卡片不挂载 bundle。

对应 `desktop/ui.go` 的 `taskCard` / `progressOf`（`:3996-4004`）与 `app/.../CrewUi.kt` 的 `TaskRow`（`:2128-2147`）。后者已实现 `total_steps` / `steps_done` 解析与夹取，契约 `:173-178` 那句「手机端还没接」是过期的，别按它重做。
