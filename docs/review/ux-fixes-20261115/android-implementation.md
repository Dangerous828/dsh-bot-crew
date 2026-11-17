# Android 实现与验证

日期：2026-11-16，Asia/Shanghai。

## 实现

- 侧栏任务入口使用 `NavEntry.Tasks.label = 「任务」`；任务模式与页面内容保持原有路由。
- 移除语音录制与播报入口、调用链及专用客户端 API。
- 每条用户消息按请求生命周期显示中性状态：`accepted` 与缺失状态显示「已发送」，`queued` / `waiting` 显示「待处理」，`evaluating` / `processing` 显示「处理中」；未知状态不显示常驻异常标签。撤回要求消息状态精确为 `queued`，且 request ID 同时存在于服务端 `Conversation.queued`。
- 发送状态、待处理请求与提示按 session/request owner 隔离；旧回调不会改写其他会话的草稿、请求或提示。
- root `BackHandler` 处理子页面系统返回：Workspace、Models、Backend 回到 Crew，Routine、Memory 回到 Backend。Workspace 同时清除 `onScreen` 与预览状态，并保留模式和草稿；drawer 的 BackHandler 以 `currentValue == Open || targetValue == Open` 保持在开启动画、打开状态和关闭动画期间启用，让 drawer 优先消费系统返回并直接关闭。
- 聊天跟随意图按 `sessionId` 初始化；仅在用户拖动及惯性滚动结束后读取底部位置并更新。新消息和回复沿用已保存意图，活跃滚动期间不触发自动定位；历史消息与通知跳转会暂停跟随。

## 验证

- JVM 回归：`:app:testDebugUnitTest` 全量通过，包含 `TimelineFollowTest` 的消息连续跟随、滚动中抑制、历史跳转停跟随与新会话初始化覆盖。
- OPPO 实机发送与回复跟随由 lead 做最终复验；本轮未操作手机。
- JDK 21 下 release 构建成功：`:app:assembleRelease -PcrewBuildId=ux-fixes-20261116-r1 -PcrewPublicBase=https://crew.kentonnie.top -PcrewExpectedCrew=0kvcc5t`。
- `apksigner verify` 通过。签名证书 SHA-256：`ad0e44804142148625ce90427ce3832747c29b795640cfb451745b44540af7eb`。

## 交付

- APK：[dsh-botcrew-ux-fixes-20261116-r1-signed.apk](</Users/cpuser/Code/dsh-bot-crew/docs/review/ux-fixes-20261115/deliver/dsh-botcrew-ux-fixes-20261116-r1-signed.apk>)
- SHA-256：`60c1fe57e8ce200275a462c05bffadedb29d2ddeac5178216e906dc5b7471516`
- 最终包已覆盖 deliver 原路径；lead 将安装并复核发送后的自动跟随。
