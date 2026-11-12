# 四期收尾分工与验收账

更新：2026-11-12。统筹会话：session-74b2b725-3989-4641-afea-b2307d8e2ac0。

## 并行分工

| 负责人 | 范围 | 写入边界 |
|---|---|---|
| 会话 session-d1cc0d95-0faf-400a-a30a-7af98388eb6e | 真机性能、截图、记忆及常规任务等业务实测 | 其已有改动及运行态由其管理；本会话不操作 ADB、不改生产设置、不重启服务 |
| Hy4 连接条线 | Android 隧道重试、认证探测、连接状态文案 | MainActivity / TailcatP2p / CrewRoute / CrewClient 与相关路由测试；报告 PHASE_CONNECTION_CHECK.md |
| Hy4 审批与连接条线 | 审批三档、MCP 工具分类及只读/写审批规则；将判定真正接入 worker 执行路径 | 模块层报告 PHASE_APPROVAL_CONNECTIONS_CHECK.md；恢复任务允许修改 sessions.ts / runtime.ts 审批方法及测试，报告 PHASE_APPROVAL_WIRING_CHECK.md |
| Hy4 桌面条线 | 四期桌面入口、字段映射、状态与错误呈现 | desktop/；报告 PHASE_DESKTOP_CHECK.md |
| 统筹 | 成本账模型归属、逐条上下文窗口、集成验证 | spend.ts、runtime.ts 成本方法、对应现有测试；本文件 |

三个子代理通过 DSH workflow 的独立 agent 运行，明确指定 provider=magpie、model=workbuddy/hy4free。网关模型目录包含该路由，最小实际调用返回该模型响应；不是通过提示词假扮 WorkBuddy。

## 停止及避让项

- 用户已在另一会话明确停止 App 推送接收链，保留缺口说明，不派开发任务。
- 不重复另一会话的手机性能、截图、记忆 settle/recall、常规任务与业务验收。
- 不修改已有监工脚本、不替其他会话提交文件。
- 未获本轮提交指令，不执行 git commit / push。
- 子代理不得修改运行中配置、数据库、构建产物或服务进程。

## 成本账修复证据

已复现并修复：

1. 会话的实际模型记录在 model/selection 和 request/header 中。成本汇总曾忽略这些记录，把历史调用全部归给当前默认模型。
2. 缺历史记录时，票据的 bot_id 对应独立模型未被采用。
3. 逐条上下文余量曾统一使用默认模型窗口，切换模型后显示错误。

修复按事件顺序还原路由，实际请求头/选模事件覆盖默认值；逐条明细按各自模型查询窗口，同一模型在单次请求内复用查询结果；没有历史路由时按 Bot 独立配置再退全局配置。

已实际执行：

- crew-spend.spec.ts 新增模型切换回归：修复前失败，修复后通过。
- runtime.spec.ts 新增独立 Bot 默认模型、逐模型窗口集成回归：修复前两条失败，修复后通过。
- 针对用例 12 条通过；后端 TypeScript 类型检查退出码 0。
- 14:50 后端全量回归：98 文件 / 1675 用例通过，退出码 0（含当时另一会话的记忆修复）。三个并行报告待汇总。

## 桌面条线验收

2026-11-12 15:22 统筹复验：桌面报告已落盘，修复两项明确缺陷。

- 记忆修改与忘记的 HTTP 200 回执必须解析 `ok`；`ok:false` 现在返回后端原因，无原因时给出失败说明，不再误报成功。
- 工单工作步骤按真实 `said / did / checked` 类型区分颜色，未知类型保留默认色。
- 子代理留有失败测试→修复通过证据；统筹独立执行 `go test ./... -count=1 && go vet ./...`，退出码 0。
- 桌面记忆编辑、播报、接手工单和原生语音输入四入口已落盘，统筹 Go 测试与 vet 通过；报告 PHASE_DESKTOP_COMPLETION.md。原生 .app 已打包签名并实际打开，另有 package.sh 可复建。
- Android 连接条线由统筹接手完成；见 PHASE_CONNECTION_CHECK.md。审批真实开工闸门、回答闭环及 MCP 调用时校验已接入；见 PHASE_APPROVAL_WIRING_CHECK.md。
- 评审交接 B1/B2/B3 与 M1/M2 已落盘：resume 后端与手机继续按钮、契约核对、花名册横滚和 48dp 触控区，报告 PHASE_REMOTE_RESUME.md、PHASE_PHONE_UX.md。亮色 Hint 使用 #6F6A60。
- 运行窗口实际播报请求暴露了 speak 分支未读取 POST 正文，源码已修复并补失败→通过回归。语音上传还暴露 LAN 载体的 UTF-8 转码与 256KB 限额问题，已以真实回环 HTTP 测试复现并修复；公网载体正在独立补齐。
- 用户于 2026-11-12 再次明确要求不要抢鼠标：所有桌面输入和窗口聚焦操作已停止，临时输入脚本已清理，后续窗口手点由用户完成。后台代码、编译、测试继续。

## 当前集成验证

- 后端全量 98 文件 / 1701 用例通过，pnpm typecheck 通过（本轮 LAN 载体修复前的全量结果）；LAN 与手机 HTTP 最新定向 55 用例通过并再次通过 typecheck。
- 后端 tsdown 隔离构建到 .artifacts/four-phase-build 通过，未覆盖运行中的 lib。
- Android JVM 最新套件 211 用例通过，生命周期收尾调整后的复跑也已退出 0。
- 桌面最终 go test ./... -count=1 与 go vet ./... 退出 0，.app 的 plist 与签名校验通过。独立 superagent profile 的 doctor 只读体检通过。
- 两项后台收口仍在进行：公网语音字节载体，以及 approval/connections 的版本化设置保存与管理页入口；完成后重跑全量与隔离构建。

## 收口最终验证（2026-11-12 16:52）

两条 Hy4 子代理在读取阶段被工具中断，统筹直接接手完成并验证：

- 后端：99 文件 / **1712 用例通过**，`tsc --noEmit` 退出 0；隔离 `tsdown` 构建到 `.artifacts/final-build` 成功（不写 `backend/lib`）。
- relay：`tsc --noEmit` 退出 0。
- Android：`testDebugUnitTest` BUILD SUCCESSFUL 退出 0。
- 桌面：`go test ./... -count=1` 与 `go vet ./...` 退出 0。
- 修复项：语音载体四处（LAN UTF-8/256KB、公网 UTF-8/256KB、>1MiB 单帧、响应缓冲）与 speak 未读正文；审批真实开工闸门与外部连接逐调用闸门；`approval`/`connections` 版本化设置与管理页入口。
- 报告：PHASE_VOICE_CARRIER.md、PHASE_SETTINGS_ENTRY.md、PHASE_APPROVAL_WIRING_CHECK.md、PHASE_CONNECTION_CHECK.md、PHASE_PHONE_UX.md、PHASE_REMOTE_RESUME.md、PHASE_DESKTOP_COMPLETION.md。

剩余外部条件（不在本会话可行范围，需另一会话/用户）：真实设备上的 GUI 手点、真麦克风与出声、真机 Apk 安装、公网/局域网端到端联调、运行中 profile 加载新构建、语音识别器接入、真实额度数据源。均已在各报告「待验收」列出。

## 完成判据

实现、自动化测试、运行中加载和真机验收分开记录。测试通过不等于真机验收通过；源码修改不等于运行中宿主已加载。另一会话持有真机和服务，本轮不通过重启替其改变验收基线。
