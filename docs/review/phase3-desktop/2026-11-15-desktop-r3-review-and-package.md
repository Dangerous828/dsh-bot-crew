# Desktop r3 独立审核与打包报告（task-14）

日期：2026-11-15 · 审核/打包：wb3-desktop-package · 产物版本：r3（release-20261115-r3）

## 结论

**Ship。** 新增 Answer/attention 控件逻辑正确、主线程交互无违规、无真实 bug 需改代码；以当前冻结完整树编译并通过 ad-hoc 签名，产出可交付 `.app` + `.zip`。未启动任何窗口（package.sh 只 build/copy/sign，不 open）。

## 功能范围（本 r3 相对既有桌面能力的新增/关联）

- **审批答复走审批通道**（`client.go` `Answer` / `ErrAnswerStale`）：带 `attention_id` 的票点选项/自写一句打 `POST /api/mobile/answer`，body 只 `{ticket, text, attention_id}`，身份由服务端认证，客户端不发 `actor`。409→`ErrAnswerStale`，零变更。
- **待决卡内联答复控件**（`ui.go` `pendingCard` / `sendRevise` / `answer` / `answerResult` 处理器）：有 `attention_id` 的卡在卡内提供自写输入格 + 「回」按钮，走 `/answer`；无 `attention_id` 的老后端卡保持既有 `@某人` prefill → `/send`，逐字不变。
- **过期刷新**：409 时不当成功、不当断连（不写全局 `problem`），刷新时间线换最新一张卡并在卡上明说「这张问题卡已更新，请按最新的那张再答」，刷新后保留提示（`answerStale` 例外分支）。
- **主线程纪律 + 生命周期**（`main.go` / `mainthread.go`，前 actor 长期验收、整体保留）：后台结果经 `postMain`→`runPending` 主线程队列落状态，`wake()` 不依赖帧；debug socket 移到 `bindPost` 之后启动；窗口关闭 `closeMain` + 关调试连接。

## 独立源码审核（读真实源码，非仅 diff）

审查点全部通过，无 F1/F2/F3 退化：

| 审查点 | 位置 | 结论 |
|---|---|---|
| 新增控件 callback | `ui.go` L2683/L2712 `OnClick` | 只调用 `s.answer`/`s.sendRevise`，二者均经 goroutine + `wake()` |
| inner-revise 状态 | `answerRevise`/`answerReviseBusy`（按票号 key）、`reviseOf` | 两张待决卡各写各的不串；`*reviseDraft` 指针给 TextInput 稳定绑定；懒初始化兜底 |
| 异步结果主线程 | `answered` chan（newApp make + 发送端 nil 兜底），handler L1294-1326 | 状态只在主线程改；成功清草稿+清 busy；409→stale；普通错→`actionNote` 不挂断连横幅 |
| wake / lifecycle | `wake()` L446、`enqueue`/`runPending` L477-519、`closeMain` | 状态推进挂数据到达不挂帧，窗口遮挡/锁屏不丢结果；关闭后入队返回 false |
| 过期/成功回执不串题 | `answerSignature`/`answerIsCurrent`、`applyConversation` L812 | 成功回执只在同票同题组时显示；刷新换题即收起；stale 提示按同票保留 |
| 无 attention_id 回退 | `answer` L2560-2564 | 完全走既有 `/send`，不误触 `/answer` |

未发现需改源码的真实 bug；`debug.go` 变更为既有调试口迁移，无 answer/attention 相关新增，保留原样。

## 构建与验证证据

- 构建脚本：真实 `desktop/package.sh`（无自动 open/launch）。命令：`bash desktop/package.sh "build/release-20261115-r3/Bot Crew.app"`，exit 0。
- 编译：`CGO_ENABLED=1 go build`（go1.27.3 darwin/arm64），随后 `cp Info.plist`、`plutil -lint` OK、`codesign --force --sign -`、`codesign --verify --strict` 通过。
- **不启动窗口**：全程未 `open`/未 launch app。
- **源 cohort（actual file sha256，非 HEAD/非 diff）**：
  - client.go `6187e5ee…69 16b53`
  - ui.go `c2e80121…f0142ac9`
  - main.go `8c5ab118…9c3b19f0`
  - mainthread.go `7a4e29cc…54a0d6ef65`
  - debug.go `c1862a9b…fb77e79d8d`
  - Info.plist `bbb71517…6226a2910298`
  - go.mod `ffa6715d…d6a849588a8` / go.sum `975e1f5b…95dfd417c3b7`
  - 全非测试树拼接 `sha256 = dd7d98d1…e08b76cb19d2092a5`
- **unsigned build cohort 等价性**：以当前冻结树 `go build` 的未签名二进制 `sha256 = 6dc5b33f8eada9540bedcd3bfa8e77c586f74ada50f8fc7842df8183cc903354`，与 `/tmp/desktop-crew` source-freeze 参考**字节完全一致**。签名版 exe 仅因 ad-hoc 签名注入而哈希不同（预期）。

## 产物哈希与属性

| 项 | 值 |
|---|---|
| .app exe `Contents/MacOS/desktop` | `04140927be5060adec5425d62ef0e911c64cfa392fcffd5792be2f47b8b9f3df`，18,719,408 bytes |
| .zip | `8765108fa93e08ed4a0436efe62a4365ae729ec66c40460029a404e4ed0ec625`，10,431,783 bytes |
| Info.plist（bundle 内） | `bbb71517873e31a62d1231e19cbb7aef0824e5ca6c4911fe62e36226a2910298` |
| 架构 | Mach-O 64-bit arm64（thin） |
| 签名 | ad-hoc，`valid on disk` / `satisfies its Designated Requirement` |
| Bundle ID | `top.kentonnie.dsh-bot-crew.desktop`（生产 identifier 保持） |
| LSUIElement | 不存在（Regular，与原策略一致，未改） |
| 动态依赖 | 全部为系统 framework/lib（Foundation/AVFoundation/CoreFoundation/Security/AVFAudio/libobjc/libresolv/libSystem），均可解析 |

## 无 canary / 测试夹具泄入正式包（核验）

对签名版 `Contents/MacOS/desktop` 做 `strings` 精确匹配：
- `127.0.0.1:8799` / `127.0.0.1:8798` / `:8799` / `:8798`：**无**
- `CREW_CANARY`：**无**
- `attention-approval-tk`（测试票 id）：**无**
- `canary-answer`（测试票 token）：**无**

canary live 测试为 `_test.go` 且无 `CREW_CANARY` 时 `t.Skip`，不入生产二进制。

## zip 完整性（ditto + 往返验证）

- `ditto -c -k --sequesterRsrc --keepParent` 打包，保留 .app 权限与结构。
- 解压往返：exe `sha256 = 04140927…b8b9f3df`（与源一致）、`codesign --verify --strict` `valid on disk`、exe 权限 `-rwxr-xr-x`。往返临时目录已按 ownpath cleanup。
- r2（`release-20261114-r2/`）未被覆盖。

## 测试证据

- 复用前 source-owner 已冻结的 290 pass / `-race` 0 fail 证据（源码哈希相同，不重复跑全 suite）。
- 本任务仅定向新增控件测试（4 契约 + canary skip），实跑：
  - `TestAnswerGoesThroughTheApprovalEndpoint` PASS
  - `TestStaleAnswerRefreshesWithoutPretending` PASS
  - `TestTicketWithoutAttentionStillUsesSend` PASS
  - `TestReviseSendsTheTypedLineThroughAnswer` PASS
  - `TestLiveCanaryAnswerClick` SKIP（未设 CREW_CANARY，符合预期）
- 真机 canary 实证（真 Client + view + Tester.OnClick → 8799 approve→working/stop→ended/stale 缺 id 409）由 backend owner 侧已实证，本报告仅引用。

## 边界

- 未动 ADB/手机、未动 backend profile/源/lib、未干扰 canary(8799)/gateway(8798)、未 run 生产 dsh 脚本、未改全局 models/sandbox、无 git 写操作、未动进度/HANDOFF/crew-watch。
- 未读取任何私钥/凭据值；未为 OS 截图启动 Regular 窗口，不伪称 production 窗口截图。
