# 本轮根因与评审记录

日期：2026-11-15，Asia/Shanghai。

## 实际症状

OPPO `55c86317` 当前界面可见「只回复嗨」的用户消息、「嗨！」回复、同屏内部消息写审批卡和「1 个子代理 / 1 在跑」。现场截图及 UI 树保存在本目录。

## 只读运行数据

- 当前仅一个未结束 ticket：`19467b31071433bf3e5e5c552602765c`，origin trigger `5e7e28cae34233e2d287983be5d2da67`。
- 该 trigger 对应 conversation `main`、message `71`。mobileq 中该消息于 23:38:41 入站，23:38:43 已读。
- reply `55` 已于 23:38:46 回答 message `71`，正文「嗨！」。
- worker assignment 已启动，当前 `state=running` 同时有 `idleAt=23:39:00`，正在等 connection 审批。
- 审批请求参数却是 `{channel: main, to: m19, text: 嗨}`。message `19` 是 2026-11-13 的「你好」，并非本次来源。
- 这条链需同时修复回复之后继续开工、来源定位、内部回复边界和已生成错误 attention 的收敛；仅隐藏卡片或放行所有 messages 写工具不满足要求。

## 队列呈现

`queuedRequests` 当前按「未回复且处于时间窗口」判断，客户端据此显示「等队伍读完手上这一步」。未回复不能证明 worker 忙碌。原始消息在 2 秒内已读，仍可能处于未回复集合。

## 评审原则

- 内部回复绑定本票实际来源与会话，不以 server/tool 名字作为宽泛放行依据。
- 保留对跨消息、跨会话、外部写操作的检查。
- 普通已完成回复应结束其任务链，避免重复消息或长期活动状态。
- 无 Web 模式保留消息服务与调度；不得只传 `--no-open` 后宣称停止 Web。
- 本轮现场检查仅只读；生产历史审批未点击，未写生产消息、未重配。

## 独立体验回归发现

- 从聊天/任务页侧栏进入「屏幕」，`onScreen=null` 时返回逻辑固定去 Backend。应记录来源页并返回原上下文。
- A 会话发送请求在途时切到 B 并输入新草稿，A 的成功回调无条件调用 `onDraft("")`，会清空 B 的草稿；全局 `pendingSend`/`sending` 同样缺请求会话归属。应将异步结果绑定发起时的会话与发送内容，而不通过禁用输入/切换掩盖。
- 两项已交 luna-app 实施，并纳入本轮用户体验回归。
- `backend/src/app/work.ts` 的 `agentTree.build` 无条件返回 `state: working`，且树数组包含 worker 根本身。客户端将根也计入「子代理」并把缺失状态默认显示在跑，导致实际执行负载为 running=0/queued=0 时仍显示「1 个子代理 / 1 在跑」。已交两端分别修投影与统计。

## 集成评审

- 2026-11-16 02:29:40 宿主提醒按计划投递；02:29:54 Codex 五小时额度读取为剩余 100%。四名原成员均以 send_message 恢复原上下文，没有重复创建。
- 图标/Manifest 片段已完成：root 用 XML 解析检查 10 份 launcher 资源及 Manifest 引用，确认 application 同时接 icon/roundIcon，录音权限与语音专用 Provider 已移除。成员对主资源目录共 12 份 XML 的结构和本地引用检查通过。APK 编译与 launcher 实机显示仍待统一构建、安装。
- 当前 OPPO USB 仍在线，02:30 后处于锁屏；未输入、未安装。生产服务真实执行负载 running=0/queued=0，health 各项 ready。
- Kotlin/runtime/headless 其余改动待各成员交付后继续评审。
- 同类导航复查：全 app 仅 drawer 注册了 BackHandler，功能页系统返回未连接页面返回动作；已交 Android 成员统一功能页系统返回，真机将同时验证页面返回与系统返回。
- 02:55:54 发布前基线私有备份至 `backend/.artifacts/ux-prepublish-20261116-025554/`，包含运行 lib、superagent profile 配置与通过 SQLite backup API 获取的两库一致快照；后续每次发布均另取 fresh gate snapshot。

## 最终交付状态（2026-11-16 07:46）

- 最终 APK 已同签覆盖 OPPO，sha256 `60c1fe57e8ce200275a462c05bffadedb29d2ddeac5178216e906dc5b7471516`。firstInstallTime、配对和原数据保留；正式入口显示团队图标、唯一任务导航且无语音控件。
- 屏幕/模型/后台返回保留来源模式与草稿；抽屉打开动画中快速返回连续 3 次留在 app；时间线以用户滚动意图决定跟随，最终真实发送与答复均在视口内。
- 普通直答复用 outbox，不创建 Ticket/worker/ACK；结构化 answeredDirectly reason 在待送达时呈中性等待，实际 reply_to 优先投影 replied，排除未接手提示。两次受控消息各得到唯一 hi/OK，Ticket 保持 28。
- 精确来源 guard 的 ticket-bound 隔离 DB 回归通过。存量错误审批仅经新备份后的既有 stop API 结束，原 m19 未增回复。
- 独立 superagent 已无 Web：关闭 Web listener/UI/runtime 及三项纯 Web 插件，保留 host 服务、手机 API 和调度；PID 16534、健康全 ready，3082/9082 无监听，43499/8788 与主会话 64333 保留。
- AgentRegistry 接口以真实 Agent 类型约束，父链取 agent.session.header。构建/HMR 后，OPPO 对话底部不再呈现空子代理卡；此轮仅只读刷新，消息/回复保持 71/54。
- 两次额度唤醒均已执行并 inactive；没有未来兜底任务。全部临时 bash 作业已收集，手机已恢复熄屏。未 commit/push。
- 最终事实入口：acceptance.md、final-runtime.json、oppo-final-live-ux.json、oppo-final-agents-ux.json。
