# 本轮用户体验验收

日期：2026-11-15，Asia/Shanghai。目标设备 OPPO PEDM00 / 55c86317。

## 决策与范围

- 成员真实使用 `magpie-responses / codex/gpt-6-luna / max`，Android 与运行链路分开实施。
- 使用 ask-matt 路由、ponytail 实施与 ponytail-review 评审，故障按 diagnosing-bugs 建立回归。
- 保留全部未提交改动、设备数据、配对和会话；不 commit/push。
- 不重复蜂窝、免重配恢复和日志补传已完成的验收。本轮只验证新增交互与对应运行逻辑。
- 侧栏只有一个主要任务入口，普通用户无需理解看板和分拣台的内部差异。
- 移除语音入口与触发链。
- 对当前会话用户的正常回复应直接送达，外部消息写操作继续按实际权限处理。
- 独立 profile 无 Web 指停止其 Web 服务，不仅是禁止自动打开浏览器；本会话 64333 GUI 不受影响。

## 验收路径

1. 同签覆盖安装，保留 firstInstallTime，进入现有会话。
2. 从系统 launcher 查看应用名称、常规和自适应图标。
3. 打开侧栏，任务入口唯一，点击进入后返回聊天；必要任务操作可达。
4. 聊天、任务、消息菜单没有听播报或语音入口。
5. 空闲发送后的状态可区分接收、处理、实际等待，不将所有未回复消息显示成资源排队。
6. ticket-bound 隔离 DB 回归「只回复嗨」的消息工具：回复到本票来源，无普通回复审批，无跨会话写绕过；生产历史审批不点击。
7. 检查输入、会话/成员切换、抽屉返回、任务详情/审批可读性等用户路径。
8. 独立 profile 使用无 Web 模式启动；手机 API 和调度正常，主工作会话 GUI 保持运行。

## 初始环境

- USB 当前只有 OPPO 55c86317，包 `com.dsh.botcrew` 已安装且在前台。
- firstInstallTime：2026-11-11 22:27:11。
- 当前独立 profile：superagent，进程 89699；Web 3082；消息网关独立进程 67367。
- 基线变更留存在同目录 baseline-tracked.patch 与 baseline-status.txt。

## 执行结果

日期：2026-11-16，Asia/Shanghai。

- 消息请求状态文案为中性状态；缺状态显示「已发送」，未知状态不显示常驻状态标签，`evaluating` 显示「处理中」。撤回要求消息状态精确为 `queued`，且 request ID 同时存在于 `Conversation.queued`。
- 发送状态、pending request 和提示按 session/request owner 隔离；延迟回调不会清理其他会话的草稿、请求或提示。Workspace、Models、Backend、Routine、Memory 的系统返回由 root `BackHandler` 路由，Workspace 清理屏幕/预览并保留模式与草稿；页面内 drawer 的 BackHandler 后注册以优先消费。
- 聚焦 JVM 回归：状态与发送归属阶段 `CrewWireTest` 6 项 + `DrawerNavigationTest` 21 项通过；抽屉动画返回修复后重跑 `DrawerNavigationTest` 22 项通过。最终同签包已在 OPPO 连续 3 次执行「点开抽屉后立即系统 Back」，均留在应用内；安装包回拉哈希匹配交付包，firstInstallTime 保持不变，结果见 `oppo-final-install.json`。
- JDK 21 下 `:app:assembleRelease` 成功，构建标记 `ux-fixes-20261116-r1`，网络参数为 `crew.kentonnie.top` / `0kvcc5t`。交付 APK：[`dsh-botcrew-ux-fixes-20261116-r1-signed.apk`](</Users/cpuser/Code/dsh-bot-crew/docs/review/ux-fixes-20261115/deliver/dsh-botcrew-ux-fixes-20261116-r1-signed.apk>)；SHA-256 `60c1fe57e8ce200275a462c05bffadedb29d2ddeac5178216e906dc5b7471516`。签名证书 SHA-256 与已装版本一致：`ad0e44804142148625ce90427ce3832747c29b795640cfb451745b44540af7eb`。
- OPPO 已由 lead 同签覆盖安装，firstInstallTime 保持 2026-11-11 22:27:11；聊天→屏幕→系统 Back 与任务→屏幕→页面返回都保留验收草稿，后者仍返回任务模式。验收草稿随后已清空，未发送；结果见 `oppo-navigation-results.json`。
- 系统 launcher 实拍可见绿色团队/对话图标。另发现同名遗留 `com.dsh.botcrew.recvtest` 验收包；已用 `pm disable-user --user 0 com.dsh.botcrew.recvtest` 停用，保留包与数据，正式包保持启用。若后续需恢复此验收包，用 `pm enable --user 0 com.dsh.botcrew.recvtest`。
- 存量错误审批票在新 SQLite 备份后仅经现有 stop API 收敛。该票已停止、活动审批已移除；messages 保持 69、replies 保持 52，m19 回复数不变。任务页实拍无活动审批卡，办完 23 项折叠；结果见 `bad-ticket-reconciled.json` 与 `oppo-09-clean-tasks.png`。
- 唯一导航入口标签「任务」已通过对应 21 项回归；最终 APK 已按同构建参数重建、同签覆盖到 OPPO。实机侧栏只有一处「任务」，无事务板、任务 · 分拣台、语音或听播报入口；实拍 `oppo-10-final-drawer.png`。现有 superagent profile 已切到无 Web，健康组件全 ready、load=0/0，3082/9082 无监听；43499 手机 API、8788 gateway 与主会话 64333 保持可用，身份文件与非 Web 配置不变。生产真机发送 Only reply hi 得到唯一 hi、工单总数保持 28（消息 69→70、回复 52→53）。直答状态与时间线跟随已完成：最终同签包在 04:08 实机发送 Reply with OK，仅有一条 OK；工单保持 28，消息 70→71、回复 53→54，结构化 reason 为 answeredDirectly，最新本人消息与答复均在视口内，无未接手/排队/审批提示。结果与实拍为 `oppo-final-live-ux.json` / `oppo-final-chat.png`。AgentRegistry 的 get/list 已绑定真实宿主 Agent 类型，父链使用 Agent.session.header；33 项移动 work 回归和 typecheck 通过。07:43 在 idle 与新备份后构建/HMR，PID 16534 保持、健康全 ready；随后 OPPO 对话底部无空子代理卡，最新 OK 可见，消息/回复仍 71/54，未新增发送。结果见 `agents-final-publish.json` 与 `oppo-final-agents-ux.json`。
- Android 最终聊天跟随切片执行 `:app:testDebugUnitTest --rerun-tasks` 全量通过；最终同签 APK 与安装回拉哈希相同。后端全量覆盖及最终受影响用例回归记录见 `backend-final-checks.json`、`direct-answer.md`、`runtime-implementation.md`。
- 2026-11-16 07:46 最终状态：独立 profile 无 Web、全部健康 ready、load 0/0；两次额度唤醒均 inactive，没有未来兜底任务。OPPO 已恢复熄屏，后台临时唤屏任务已结束；本轮交付完成。
