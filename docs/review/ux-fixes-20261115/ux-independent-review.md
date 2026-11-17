# 独立用户路径评审

日期：2026-11-16，Asia/Shanghai。  
范围：对照本目录的基线截图、首轮记录与验收路径，沿 Android Compose → mobile API → runtime/MCP 的实际调用链做只读审查。

本轮没有操作手机、安装 APK、启动或重启服务，也没有运行构建和测试。以下区分源码路径结论与设备/运行时验收；成员提交后需复读最终差异并完成对应验收。

## 已落到源码的路径

这些调用链目前可以从代码追到，但本轮没有做设备端或集成运行验收：

- 切换会话会更新当前会话、清空草稿与该次发送幂等键，并刷新会话时间线。发送、答复、撤回、插话请求都显式带会话 ID；旧后端未报告会话能力时锁定在 `main`。见 [`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L381) 与 [`CrewClient.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewClient.kt#L592)。
- 普通聊天发送失败时保留草稿；同一正文再次提交会沿用 request ID。带 `attention_id` 的审批卡走 `/answer`，遇到过期卡会刷新时间线；同卡答复由闸门阻止重复提交。见 [`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L645)、[`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L3094) 与 [`ApprovalGate.kt`](../../../app/app/src/main/java/com/dsh/botcrew/ApprovalGate.kt#L56)。
- 侧栏打开时按系统返回会关闭抽屉。见 [`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1021)。
- 成员选择会把明确的 `@成员` 写入草稿，收件人标签与已知提及一致；未点名时显示该会话默认成员。见 [`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1138) 与 [`CrewNavigation.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewNavigation.kt#L27)。

## 可复现问题

### UX-01 · 发送回执会清除用户后来输入的草稿

**影响：高；源码路径可复现。** 发送期间输入框仍可编辑；成功回调不比较当前草稿与发出正文，直接清空草稿。重现：发送一条响应较慢的消息，在请求返回前输入下一条；第一条成功后，第二条草稿消失。切到会话 B 后再输入也会被会话 A 的成功回调清空。`sending`、`pendingSend` 与草稿目前是跨会话共享状态。

调用链：发送回调捕获正文与会话 ID，然后成功时无条件调用 `onDraft("")`；会话切换只清草稿和幂等键，不会使旧请求的回调失效；输入框仅由连接状态决定是否可编辑。见 [`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L386)、[`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L645)、[`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1444) 与 [`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L4270)。

建议把发送结果绑定发起时的会话和正文；只有当前会话仍匹配且草稿仍是所发正文时才清空。此问题已交 `luna-app`，待其交付后独立复读。

### UX-02 · 从侧栏打开「屏幕」后返回到错误页面

**影响：中；源码路径可复现。** 从聊天或任务页打开侧栏，点「屏幕」，再按 Workspace 返回；当前逻辑在 `onScreen == null` 且没有预览票时固定回 `Backend`，因此离开了刚才的队伍页。任务模式也回不到原任务上下文。

调用链：侧栏调用 `onWorkspace(null)`；根层切到 `Workspace`；返回分支以 `onScreen` 和 `previewTicket` 猜来源，而没有保存来源页面。见 [`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L620)、[`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L667) 与 [`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1152)。

建议记录进入 Workspace 时的来源页和模式，返回时恢复；成员 ID 仅在 profile 或预览指定了成员时作为显式上下文，侧栏入口的 `null` 保持“按会话默认成员显示”。此问题已交 `luna-app`，待其交付后独立复读。

### UX-03 · 未回复消息被统一显示为“排队中”，并出现撤回入口

**影响：高；基线运行数据已证明状态会误导。** `queuedRequests` 当前按“用户消息、无关联回复、发送时间在 90 秒窗口内”推断排队，未使用 `read_at`、活跃工单或实际队列状态。Composer 将结果展示为“等队伍读完手上这一步”，并提供撤回。已读且正在处理的消息在有回复前也满足这个筛选条件，因而会被当作待读队列；此时撤回操作可能已不成立。

基线中，消息 `71` 在入队后 2 秒已读，关联工单处于 `running`，但仍无回复；同屏又出现排队/处理中提示。原始数据见 [`lead-findings.md`](lead-findings.md#L9)。判定代码与文案见 [`mobile-http.ts`](../../../backend/src/app/mobile-http.ts#L1336)、[`mobile-http.ts`](../../../backend/src/app/mobile-http.ts#L1431) 与 [`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L4047)。

建议只用可证明的接收、读取、活动工单和队列状态表达阶段；不确定时呈现未知，不把“未回复”推断成“资源排队”。待 `luna-runtime` 交付后复读并验收。

### UX-04 · 普通回复生成了指向旧消息的内部写审批

**影响：高；基线运行数据已证明错目标。** “只回复嗨”已收到“嗨！”，同一工单仍产生 `send_message` 审批，请求目标是 `m19`；本次来源是 `message 71`。若批准，写入会关联到旧消息，而不是本次触发消息。现场审批未点击，未写生产消息。

消息 MCP 将 `send_message` 映射到 `mobileq reply`，写入回复表；连接运行时对写调用生成精确参数审批，但这个审批记录本身未证明目标与当前工单来源相同。证据见 [`lead-findings.md`](lead-findings.md#L11) 与 [`server.ts`](../../../backend/src/integrations/messages-mcp/server.ts#L5)、[`runtime.ts`](../../../backend/src/app/runtime.ts#L867)。

验收需在隔离 DB 的 ticket-bound worker 中确认：普通回复关联本票实际来源、不生成普通回复审批；跨消息、跨会话及外部写仍走既有检查。此项由 `luna-runtime` 实施，待交付后复读；生产历史审批不参与验收。

### UX-05 · 任务有两个近似入口

**影响：中；当前源码可复现。** 侧栏导航提供“任务 · 分拣台”；工具区还提供“事务板”。后者会切回聊天并打开另一种任务视图，要求用户先理解“看板”和“分拣台”的内部差异，与验收要求的单一主要任务入口不符。

入口和切换行为见 [`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1143) 与 [`CrewUi.kt`](../../../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt#L1712)。建议保留一个主要任务入口，把必要任务操作放在同一用户路径下。待 `luna-app` 导航改动交付后复读。

### UX-06 · Launcher 图标资源尚未接入

**影响：中；配置可确认，设备 launcher 显示未实测。** 当前 Manifest 的 application/activity 都没有 `android:icon` 或 `android:roundIcon`，`res` 下仅见 `values/themes.xml` 与 `xml/file_paths.xml`，没有 launcher mipmap 资源。验收路径要求从系统 launcher 检查常规与自适应图标；此项需随图标实现一起在设备上验收。见 [`AndroidManifest.xml`](../../../app/app/src/main/AndroidManifest.xml#L14)。

该项已由 `luna-app` 处理，待交付后核对资源、Manifest 引用及系统 launcher 实际显示。

## 尚待成员交付后的验收

- 复读 `luna-app` 的图标、导航、Workspace 返回与发送状态差异；用真实 UI 路径覆盖聊天/任务、会话切换、快速连续输入及系统返回。
- 复读 `luna-runtime` 的消息回复绑定、队列阶段展示与无 Web 启动差异。无 Web 验收必须确认独立 profile 的 Web 服务未启动、手机 API 与调度正常、主工作会话 GUI 继续运行；本轮没有启动或检查这些进程。现有监工接线文档仍写有 `dsh web` 启动命令，需在新交付路径中核实实际启动语义，见 [`监工接线.md`](../../../scripts/crew-watch/监工接线.md#L73)。
- 语音移除属于已知实施范围；遵循负责人安排，留待最终差异复读，不作为本轮新增阻断。
- 本报告只记录源码路径与已取得的基线运行数据；没有把尚未运行的设备、构建或集成验收写成通过。
