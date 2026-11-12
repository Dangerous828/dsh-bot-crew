# 远程恢复执行：B1 / B2 / B3 实现记录

日期：2026-11-12。已查看当前技能目录并加载 `ponytail`，按最小完整改动实施。
本票依据 [交接条目](review/2026-11-12-handoff.md) 的 B1 / B2 / B3；具体行为以当前源码为准。

## 实现

- [mobile-http.ts](../backend/src/app/mobile-http.ts)：登记 `POST /api/mobile/resume`，沿用 Connection 的 exact-route Fetch 注册，调用 `await runtime.settings.pause(false, 'panel')`。
- 支持空 body 和 `{}`，客户端推荐发送 `{}`；成功返回 `200 {"ok":true,"resumed":true,"scope":"executor"}`。只处理 POST，GET 返回 404；重复恢复仍成功。
- JSON 畸形、数组或 null 返回 400，body 超过 8KB 返回 413，缺控制器返回 503；同步抛错或异步失败返回 500 与可读错误，不泄露内部异常，也不返回成功。控制器可能在通知失败前已经保存设置，客户端失败后应刷新 `status.paused`。
- 认证沿用现有 [phone-gate.ts](../backend/src/app/phone-gate.ts) 的设备凭据判定；恢复接口没有配对例外，也没有另挂公开入口。
- [消息面契约](00-contract.md) 已明确全局 pause / resume 与单票 takeover 的区别：resume 只解除全局暂停，takeover 留下人工终止记录，该票永久停止；继续同一件事需要重新接纳为新工作。

## 当前源码核对

| 能力 | 已核对的源码与契约事实 |
| --- | --- |
| 计划进度 | [mobile-http.ts](../backend/src/app/mobile-http.ts) 从票的 plan 下发计数；[CrewWire.kt](../app/app/src/main/java/com/dsh/botcrew/CrewWire.kt) 已解析两个字段并夹紧展示值；[CrewUi.kt](../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt) 的 TaskRow 已按分母显示进度。缺省 0 是本地无计划状态。 |
| 采用 | [CrewUi.kt](../app/app/src/main/java/com/dsh/botcrew/CrewUi.kt) 的 CodeCard 已调用 client.send；发送中与成功后禁重复点击，失败允许重试。已采用表示表态成功发送，不证明文件落盘。 |
| steer | [mobile-http.ts](../backend/src/app/mobile-http.ts) 已支持非空 text 走 send + steer:true；无 text / 空白走 claim；网关成功后才交给 runtime.steer，false 返回 409。契约分别描述两条顺序。 |
| screen | [runtime.ts](../backend/src/app/runtime.ts) 先 inspect 活会话，再读持久化存档；[mobile-http.ts](../backend/src/app/mobile-http.ts) 如实返回快照或 unavailable。这是会话活动快照，像素截帧与远程桌面操作尚未接入。 |
| bots | [mobile-http.ts](../backend/src/app/mobile-http.ts) 已支持新增、编辑、移除，保存 team 配置并保留 enabled；契约 §5 已明确手机端可写队伍配置。 |
| takeover | [tickets.ts](../backend/src/core/tickets.ts) 的 stop 以 human / stopped 结束票；全局恢复只改设置，不重开人工停止的票。 |

以上能力只校对契约，未重做其实现。上述源码核对只读，不涉及对运行时、会话、核心或执行器审批代码的改动。

## 自动验证证据

执行目录：`backend`。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm exec vitest run tests/mobile-http.spec.ts` | 退出码 0；1 个测试文件通过，35 / 35 用例通过。最终复跑测试耗时 240ms，总耗时 1.08s。 |
| `pnpm typecheck` | 最终复跑退出码 0，`tsc --noEmit` 通过。首轮发现本票测试 headers 推断的类型错误，已在允许的测试文件内修正后复跑；没有修改范围外文件。 |
| `git diff --check` | 退出码 0。 |

[mobile-http.spec.ts](../backend/tests/mobile-http.spec.ts) 新增 4 条用例，覆盖空 body / `{}` / 重复恢复、调用 false + panel、仅 POST、无网关转发、无单票 stop、400 / 413、503、同步与异步失败 500，以及缺失 / 错误设备凭据 401、有效凭据放行。现有注册用例已补 resume 并校验 24 条路径。

鉴权证据为实际 phoneGate 函数与处理器的单元组合，加上 Connection 注册断言；不等于已通过真实 Connection 网络联调。

## 剩余验收

**真实在线端到端尚未验收。** 本票没有运行完整测试套件或 backend lib 构建，没有服务启停、ADB、通知、数据库操作、commit 或 push。

待联调验证：

1. 真实设备凭据通过局域网与中转入口调用恢复，确认未配对请求在入口处返回 401。
2. 手机暂停后按钮切换为继续，点击发送 `{}`，成功后以时间线 `status.paused:false` 校验；观察受暂停影响的工作恢复处理。
3. 对 takeover 已人工终止的票执行全局 resume，确认原票仍为 stopped；需要继续时重新接纳新工作。
4. 控制通知或连接失败时，客户端展示失败并刷新实际状态，不提前显示恢复成功。

本票完成的是后端接口、契约与定向自动测试，产品在线可用性仍以上述联调结果为准。
