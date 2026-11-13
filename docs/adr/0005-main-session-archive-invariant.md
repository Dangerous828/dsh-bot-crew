# 主 Session 永不归档：准入拦截 + 运行时巡检

## 背景

DSH 的 `ArchivedSessionGate`（`@deepseek-ai/dsh-api-session-controller`）在 `agent/pre-step`
对「已归档会话」直接返回 `{ kind: 'reject' }`。主 Session 是这支队伍的总路由：它一旦被归档，
每张 candidate 卡都在 pre-step 被拒，turn 以 `blocked` 收口、连一次模型请求都不发，
Eval 等不到判定就超时，所有消息卡在「排队中」。这与模型、余额、权限都无关。

`~/.dsh/storages/workspace.json` 是**一台机器一份、所有宿主共用**的状态文件，归档集合
`global.archivedSessionIds` 就在里面。各宿主各持一份内存状态、整文件原子覆写，谁后写谁赢。
于是同一条脏状态有两条复发路径：

1. 另一台宿主（另一个 profile / Electron）拿着含主 Session 的旧集合整份写回磁盘，
   下一次进程启动读到的就是脏集合；
2. 本进程运行途中，任何走 `workspaceRegistry.archiveSession` 的调用（面板误点、历史迁移、
   别的插件）都可能把主 Session 写进归档集合。

只在 `finishSetup()` 里解一次，覆盖不了第 2 条；而第 1 条会让「重启又回到旧状态」，
每次手改文件都是擦屁股，不是修根因。

## 决策

把「主 Session 不许被归档」从约定变成机制，三道一起：

1. **准入拦截**：`Runtime.installMasterArchiveGuard()` 在 `workspace/session-activity`
   waterfall 上对主 Session 报一条常驻活动。`workspaceRegistry.archiveSession` 在写盘前
   会跑这个 waterfall，非空结果以 `WorkspaceActiveSessionError` 拒绝归档 —— 走正规接口的
   请求在**写入之前**就被挡下。别的会话不受影响，worker 归档照常。
2. **启动 + 运行时巡检**：`ensureMasterActive(phase)` 在 `finishSetup()` 跑一次（startup），
   并挂到已有的一分钟 tick（watch）。发现主 Session 又在归档集合里就调正规接口
   `unarchiveSession()` 解出，不用等重启。
3. **复发可见**：watch 阶段的复发写一条 `master_archived` 看门狗告警（桌面右栏与管理面
   `/state` 都读得到），一小时内只记一条，免得两台宿主来回覆写时刷屏；解除失败则把
   `runtimeHealth` 置 `error`，不再静默瘫队。

同时收掉同类静默吞错：`ticket.ended` 那条归档的 `.catch(() => undefined)` 改成
`logger.warn` —— 它曾经把「归档从来没成功过」藏了很久。

## 边界

跨进程整文件覆写发生在 DSH 的 workspace 存储层，不在本仓能改的范围。这里**不去猜别人的
文件路径、不绕过正规接口读盘**：只用 `workspaceRegistry` 保证本进程看到的状态不变量，
并把磁盘上残留的脏集合在每次启动时清掉。要根治多宿主互相覆写，得改 DSH 的存储合并策略
（按 id 合并而不是整文件覆写），那是另一件事。

`ArchiveSessionOptions.stopActivity: true` 会跳过 activity waterfall，直接进入写入与
`workspace/session-stop`。本仓自己的归档调用只针对 `worker-<ticket>`，从不指向主 Session；
别的宿主若带 `stopActivity` 归档主 Session，由第 2、3 道巡检兜住并告警。

## 验收

- `backend/tests/runtime.spec.ts`：启动解归档、准入 waterfall 只挡主 Session、
  运行中复发被巡检解出并记一条告警、一小时内不重复刷、别的会话不受影响。
- 全部经 `pnpm check`（typecheck + 全量 vitest + build）与 `sh scripts/check-parity.sh` 验证。
