# 桌面端契约修复与接线核验（desktop 专项）

- 核验时间：2026-11-12 15:02–15:50（Asia/Shanghai）
- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`
- 角色：独立子代理（desktop 客户端契约与 WorkStep 映射）
- 可写范围：`desktop/`、`docs/PHASE_DESKTOP_CHECK.md`。其余只读。
- 方法：按 `ponytail`（最小完整改动）与 `diagnosing-bugs`（先建红测反馈回路）执行。开局先探测匹配 MCP：本任务落在本地 Go 源码与 `go test`，magpie 下挂载的是会话检索 / Hub 记忆 / 生图 / 网页搜索，与「直接用既有静态证据」相冲突，故未调用。
- 证据来源：沿用上一轮子代理的静态结论，直接建立失败测试并修复，未重新漫游全仓。

## 一、结论

1. 修复 **2 处已确认缺陷**，各有红→绿证据：memory 写入把 `HTTP 200 + {ok:false}` 误报成功（§三）；`WorkStep.kind` 与 `workRow` 颜色映射不匹配（§四）。
2. 补齐 **4 个缺失入口**：播报 `speak`、语音输入 `voice`（含 AVFoundation 录音与 WAV 转码）、接手工单 `takeover`、记忆编辑按钮（§五）。**175 个用例通过、1 个按设计跳过**。
3. 用户要求核验的映射问题**属实**：后端只发 `said / did / checked`，desktop 原来认 `tool / error / say`，三种真实值全部命不中、一并落到默认最弱色，注释里承诺的「小圆点区分种类」实际没有生效。已按后端契约做最小映射并加测试。
4. 四个入口只到 **`go test` / `httptest` 级证据**，**没有**启动 GUI、没有真录音、没有真出声（§五表格下已注明）。缺的是真机验收，不是实现。
5. 全程只跑 `go build` / `go test` / `go vet`：未运行任何服务、未重启 Desktop、未碰 ADB / 运行态配置 / 数据库 / `backend/lib`、未做全仓格式化、未提交 / push。用户已停推送，未发送任何通知。其他会话负责的记忆、常规任务真机验收均未触碰。

## 二、改动文件

### 第一轮（契约修复）

| 文件 | 改动 |
|---|---|
| `desktop/client.go` | 新增 `memoryAck` + `memoryWrite`；`ForgetMemory` / `EditMemory` 改为读回执判 `ok`（+23 −4） |
| `desktop/ui.go` | `workRow` 抽出纯函数 `workDot` 并换成后端三值映射（+16 −9） |
| `desktop/memory_test.go` | +3 例：`ok:false` 带 reason、`ok:false` 无 reason、`ok:true` 防回归（+51） |
| `desktop/work_test.go` | 新建，+2 例：真实 kind 在亮暗两套主题下可区分、未知 kind 落默认色 |
| `docs/PHASE_DESKTOP_CHECK.md` | 本报告（新建） |

### 第二轮（四个入口）

| 文件 | 行数 | 改动 |
|---|---|---|
| `desktop/actions_client.go` | 247 | 新建：`Speak` / `Voice` / `Takeover` 三个客户端方法 + `parseSpeak` / `parseTranscript` / `parseTakeover` + `playWav` / `systemPlay` |
| `desktop/ui_actions.go` | 209 | 新建：`actionState`（各入口的跨线程状态）、`deliver`、`applyAction` 四类 kind 分支 |
| `desktop/ui_speak.go` | 38 | 新建：`app.speak` 播报入口 |
| `desktop/ui_voice.go` | 81 | 新建：`startVoice` / `stopVoice` / `cancelVoice` 录音入口 |
| `desktop/ui_takeover.go` | 40 | 新建：`app.takeoverTask` 接手工单入口 |
| `desktop/record.go` | 125 | 新建：`micSession`（权限状态、单例串行、临时文件收尾）+ `voiceRecorder` 端口 |
| `desktop/record_darwin.go` | 56 | 新建：cgo 绑定（`AVFoundation`） |
| `desktop/record_darwin.m` | 115 | 新建：`AVAudioRecorder` 16k/mono/16bit 录音 + `AVCaptureDevice` 权限 |
| `desktop/record_stub.go` | 16 | 新建：非 darwin / 无 cgo 时明确报「没有原生录音」 |
| `desktop/wav.go` | 156 | 新建：`normalizeVoiceWav`（重采样 + 混单声道）、`isWav`、`maxVoiceBytes` |
| `desktop/Info.plist` | 26 | 新建：`NSMicrophoneUsageDescription`（打包必需，否则首次录音被系统拒） |
| `desktop/action_client_test.go` | 158 | 新建：Speak 回包 / 临时文件 / 编码 |
| `desktop/action_voice_test.go` | 248 | 新建：WAV 转码 7 种拒绝 + `parseTranscript` 8 种 + `Client.Voice` 裸字节 + 麦克风空闲安全 |
| `desktop/action_takeover_test.go` | 123 | 新建：`{ok,stopped}` 双真才算接手 + busy 去重 + 已结束本地拒 |
| `desktop/actions_test.go` | 134 | 新建：`deliver` 队列语义 + 各 kind 的 `applyAction` |
| `desktop/voice_seam_test.go` | 136 | 新建：用 `fakeRecorder` 注入 `actionState.recorder` 走全链路（录音 → 16k mono WAV → 真实 `POST /api/mobile/voice` → 文字只进草稿不发送 / 取消收干净 / 权限拒绝 / 后端 reason 原样 / 收尾失败不像空草稿） |
| `desktop/ui.go` | — | 四处入口的按钮接线（播报 / 三按钮录音 / 接手 / 编辑记忆） |

新建文件合计 **1908 行**（含测试 799 行）。

## 三、缺陷 1：memory 写入把失败回执当成功

### 契约与现象

后端 `backend/src/app/mobile-http.ts:534-546`，`POST /api/mobile/memory`：

- `forget`：无能力时 `response(200, {ok:false, reason:'后端还没有接入记忆'})`；正常路径 `response(200, {ok: forget(target), name: target})`。`forget` 找不到那条返回 `false`，此时正文**没有 reason**。
- `edit`：无能力时 `response(200, {ok:false, reason:...})`；正常路径 `response(200, {ok: edit(target, patch), name: target})`。
- 失败信号只在正文 `ok` 字段，HTTP 状态一律 200。

`desktop/client.go` 的 `ForgetMemory` / `EditMemory` 调 `c.do(..., body, nil)`；`do()`（`client.go:888-890`）在 `into == nil` 时直接 `return nil`，不读正文。于是「忘掉没成功」被当成成功，`ui.go:3171-3184` 随即重读账本，那条记忆还在，界面却没有任何失败说明。

### 复现（红）

命令：`go test ./... -run 'TestMemoryWrite|TestWorkDot' -count=1 -v`

```
=== RUN   TestMemoryWriteReportsBackendRefusal/forget
    memory_test.go:107: HTTP 200 + ok:false 被当成了成功
=== RUN   TestMemoryWriteReportsBackendRefusal/edit
    memory_test.go:107: HTTP 200 + ok:false 被当成了成功
--- FAIL: TestMemoryWriteReportsBackendRefusal
=== RUN   TestMemoryWriteRefusalWithoutReasonStillFails
    memory_test.go:125: ok:false 无 reason 必须报错，实际 <nil>
--- FAIL: TestMemoryWriteRefusalWithoutReasonStillFails
=== RUN   TestMemoryWriteAcceptsOK
--- PASS: TestMemoryWriteAcceptsOK (0.00s)
```

`ok:true` 那一例本来就是绿的，红只落在失败回执上——失败模式与用户描述的症状一致，没有误伤成功路径。

### 修法

`ForgetMemory` / `EditMemory` 共用 `memoryWrite`：向 `c.do` 传 `&memoryAck` 读回执，`!ack.OK` 时 `errors.New(ack.Reason)`，无 reason 时兜底一句「队伍没有改这条记忆」。

**没有改 `do()`**：它是 `send / withdraw / retry / pause / steer / bots / model` 等十余个 POST 共用的 HTTP 辅助，各端点成功响应形态不同（`{ok:true}`、`{retried:true}`、空正文等）。在 `into == nil` 分支强制读正文会波及所有调用点；`ok` 是 memory 端点自己的契约，修在端点调用点上是波及面最小的完整改动。

### 调用者追踪

- `ui.go:3171 forgetMemory` → `:3178` 已有 `if err != nil` → `:3179` `s.memoryCh <- memoryResult{note: "忘掉没成功：" + err.Error()}`。
- `ui.go:811-813` 消费 `memoryCh`，把 `note` 写进 `s.memoryNote`，记忆栏显示。修复后后端 reason 能一路到界面。
- `EditMemory` 在桌面 UI 里没有调用点（见 §五）。
- 现有 `TestMemoryClientRoundTrip`（`memory_test.go:58`）的 mock 本就返回 `{"ok":true}`，修复后仍绿。

## 四、缺陷 2：WorkStep.kind 与 workRow 颜色映射不匹配

### 核验为真

- `backend/src/app/work.ts:16`：`export interface WorkStep { at: string; kind: 'said' | 'did' | 'checked'; text: string }`。
- `work.ts:82-91` `stepsOf` 实际产出 `did`（assignment 已结束）/ `said`（未结束）；类型契约还含 `checked`。
- `mobile-http.ts:782`：`operation === 'work'` 时直接 `response(200, workOf(...))`，`steps` 原样透传，不改名。
- `desktop/client.go:977-982` `WorkStep` 只做 JSON 解码，`Kind` 保持后端原值；`client_test.go:290` 的后端样例也是 `"kind":"did"`。
- 修复前 `ui.go workRow` 的 `switch` 只认 `tool / error / say`。三个真实 kind 一个都命不中，`dot` 全部停在 `p.Faint`，种类区分失效。

补充：`ui.go:1462` 那处 `switch line.Kind`（`command / said / status`）属于 screen 视图的 `ScreenLineKind`（`backend/src/app/screen.ts:12`），不是 `WorkStep`，本轮未改动，也不该一起改。

### 复现（红）

```
=== RUN   TestWorkDotUsesBackendStepKinds/light
    work_test.go:14: 真实 kind 落到了默认色：did={138 131 119 255 …} said=… checked=… faint={138 131 119 255 …}
=== RUN   TestWorkDotUsesBackendStepKinds/dark
    work_test.go:14: 真实 kind 落到了默认色：did={146 140 130 255 …} … faint={146 140 130 255 …}
--- FAIL: TestWorkDotUsesBackendStepKinds
=== RUN   TestWorkDotLeavesUnknownKindsFaint
    work_test.go:28: 未知 kind "tool" = {62 107 98 255 …}，应落 {138 131 119 255 …}
    work_test.go:28: 未知 kind "error" = {180 82 82 255 …}，应落 …
    work_test.go:28: 未知 kind "say" = {150 96 58 255 …}，应落 …
--- FAIL: TestWorkDotLeavesUnknownKindsFaint
```

### 修法

把种类→颜色抽成纯函数 `workDot(kind, p) ui.Color`（可测的最小 seam），`workRow` 只调它。映射按后端三值：

| kind | 颜色 | 含义 |
|---|---|---|
| `did` | `p.Accent` | 干活得出了结论，最该被看见 |
| `said` | `p.Warn` | 说过的话 / 未结束的总结 |
| `checked` | `p.Muted` | 核对过的步骤，次要一档 |
| 其它 / 空 | `p.Faint` | 认不出来就留最弱一档，不猜 |

亮暗两套主题都验证三色互异且均不等于 `Faint`（`TestWorkDotUsesBackendStepKinds` 覆盖 light / dark）。`tool / error / say` 不是后端契约值，现在一律落到默认色（`TestWorkDotLeavesUnknownKindsFaint` 钉住）。

## 五、四个入口（本轮已补齐）

本报告 §五 最初登记了四个「桌面没有入口」的后端端点。**同一分支的后续轮次已把它们全部接上**，下表是当前真实状态：

| 后端端点 | 用途 | 桌面现状（2026-11-12 15:50） |
|---|---|---|
| `POST /api/mobile/speak` | 播报：念一句话、回 WAV | **已实现**：`Client.Speak`（`actions_client.go:109`）→ `app.speak`（`ui_speak.go:11`）→ 系统 `afplay` 播放；按钮在每条 Bot 回复旁（`ui.go:1985`） |
| `POST /api/mobile/voice` | 语音输入：原始 WAV 转文字 | **已实现**：录音 `record.go` + `record_darwin.m`（AVFoundation，16k/mono/16bit）→ `normalizeVoiceWav` 兜底重采样（`wav.go`）→ `Client.Voice`（`actions_client.go:235`）→ `app.startVoice/stopVoice/cancelVoice`（`ui_voice.go`）；三个按钮在输入框下方（`ui.go:2477`） |
| `POST /api/mobile/takeover` | 接手工单 | **已实现**：`Client.Takeover`（`actions_client.go:178`，发 `{ticket}`）→ `app.takeoverTask`（`ui_takeover.go:11`）；按钮每张进行中的票旁（`ui.go:3666`） |
| `POST /api/mobile/memory` `{action:edit}` | 改一条记忆的标题与正文 | **已实现**：`Client.EditMemory` → 记忆栏「编辑」按钮（`ui.go:3343`） |

四处入口的共同纪律（都由测试锁住，见 §六）：

1. **跨线程只经 `actionResult` / `deliver`**：请求、录音、转码、播放全在后台 goroutine，主线程只改状态、不阻塞。
2. **不冒充成功**：`ok` 必须来自后端回执的真字段（`speak` 的音频字节、`voice` 的 `available:true`、`takeover` 的 `{ok:true, stopped:true}` 双真、`memory` 的 `{ok:true}`），否则把 `reason` / 错误原文带上界面。
3. **不自动发送**：识别出的文字只写进草稿输入框，用户还得自己按发送。
4. **资源一定收走**：播报与录音的临时文件都 `defer os.Remove`，取消录音也删文件。

契约字段与后端一致（易错点已核对）：`takeover` 的票号字段叫 **`ticket`**（不是 `id`）；`speak` 是**二进制 `audio/wav` 回包**，秒数与截断在响应头 `x-speech-seconds` / `x-speech-truncated`；`voice` 的 body 是**裸 WAV 字节**（不是 JSON、不是 base64）。

> 仍未做：**GUI 真机验收**。以上是 `go test` / `httptest` 级证据，没有启动过窗口、没有真的录过音、没有真的响过扬声器。

## 六、验证

### 本轮（四个入口）

| 命令 | 结果 |
|---|---|
| `go build -o /tmp/crew-desktop .`（darwin + cgo，含 `record_darwin.m`） | 通过，18.5 MB 产物 |
| `go vet ./...` | 无输出，通过 |
| `go test ./... -count=1` | `ok github.com/Dangerous828/dsh-bot-crew/desktop 1.035s` |
| 顶层用例 | 176 个 `=== RUN`：**175 `PASS`**、1 `SKIP`、0 `FAIL` |
| 子测试 | 另有 53 个 `--- PASS`（`t.Run` 展开） |
| 唯一跳过 | `TestAgainstTheLiveGateway` —— 需要真后端在跑，按设计 `t.Skip`。这是本轮「未做联调」的机器可读证据，不是漏跑 |

四个入口的测试文件与覆盖点：

| 文件 | 行数 | 锁住什么 |
|---|---|---|
| `action_client_test.go` | 158 | `Speak` 二进制回包解析（`x-speech-seconds` / `x-speech-truncated` / 非 WAV 拒绝）、`playWav` 临时文件必删、编码失败 |
| `action_voice_test.go` | 248 | `normalizeVoiceWav` 同规格不改字节 / 44.1k 立体声压成 16k mono / 左右相消成静音 / 7 种拒绝；`parseTranscript` 8 种回包；`Client.Voice` 真发裸 WAV 字节；`micStatusMessage` 中文原因；空闲 `stop` 如实报错、`cancel` 安全空转；状态迁移不写草稿 |
| `action_takeover_test.go` | 123 | `{ok,stopped}` 双真才算接手、缺字段/`ok:false`/404 都不冒充、busy 去重、已结束的票本地就拒 |
| `actions_test.go` | 134 | `actionState` 的 `deliver` 队列语义与各 kind 的 `applyAction` 分支 |
| `work_test.go` | 31 | WorkStep 颜色映射（上一轮遗留） |
| `memory_test.go` | +51 | memory 回执（上一轮遗留） |

### 上一轮（memory 回执 + WorkStep 映射）

| 命令 | 结果 |
|---|---|
| `go test ./...`（基线，改动前） | `ok github.com/Dangerous828/dsh-bot-crew/desktop` |
| `go test ./... -run 'TestMemoryWrite|TestWorkDot' -count=1 -v`（红测） | `FAIL`：5 处断言失败，见 §三 / §四 |
| `go test ./... -count=1`（修复后全量） | `ok … 2.348s` |
| `go vet ./...`（修复后） | 无输出，通过 |

环境：`go1.27.3 darwin/arm64`，模块根 `desktop/go.mod`。无 `[DEBUG-*]` 插桩、无临时原型残留；回归测试即最小复现，已留在上表各文件。

新增文件的 `gofmt` 状态：`record_stub.go` 已格式化。`main.go` / `outputs_test.go` / `resize_test.go` / `syntax.go` / `syntax_test.go` / `theme.go` 的 `gofmt` 告警是 **HEAD 上就有的**（`git show HEAD:<file> | gofmt -l /dev/stdin` 同样命中），本轮未顺手改，避免把格式化噪声混进契约修复。

## 七、边界与遗留

- 未跳过：开局 `git status` / `git diff` 确认他人改动后再动笔。`backend/` 的 8 个已修改文件、`docs/FOUR_PHASE_COORDINATION.md`、`docs/PHASE_APPROVAL_CONNECTIONS_CHECK.md`、`scripts/crew-watch/` 全部只读未碰。
- 未做：`git commit` / `push`、启动 GUI 或任何服务、重启 Desktop、ADB、运行态配置 / 数据库、`backend/lib`、全仓格式化、任何通知推送（用户已停推送）。
- **未验**：GUI 真机验收（点按钮、真录音、真出声）、与真实后端的联调。四个入口只有 `go test` / `httptest` 级证据 —— 打包后的 `.app` 还需要 `Info.plist` 的 `NSMicrophoneUsageDescription`（已加，`desktop/Info.plist:23`），否则首次按「录音」会被系统直接拒。
- 平台边界：录音只有 **darwin + cgo** 有实现（`record_darwin.m`）；其它平台 `record_stub.go` 明确报「这次编译没有 macOS 原生录音」，不假装有麦克风。播报走 `afplay`，Linux / Windows 上会在 `exec.LookPath` 处如实说没有系统播放器。
- 风险：`memoryWrite` 现在要求 memory POST 返回可解析的 JSON 正文。后端该端点所有分支都返回 JSON（`mobile-http.ts:534-549`），无回归；若将来网关在 200 上返回空正文，`do()` 会报「读不懂队伍的回应」而不是静默当成功——比误报成功诚实，但错误文案会变。
- 同类风险：`parseSpeak` 判定依据是后端自定的 `x-speech-*` 响应头；中转若剥掉未知头，秒数与截断会退化成「只知道念完了」，但音频本身仍能播（正文是 `audio/wav`）。

## 八、四入口补齐状态（后续轮次追加）

- §五登记的四个入口已落盘实现：记忆编辑、听播报、工单接手、语音输入。实现、契约、自动化验证与待人工验收清单见 [PHASE_DESKTOP_COMPLETION.md](PHASE_DESKTOP_COMPLETION.md)。
- 该轮 `go test ./... -count=1` 与 `go vet ./...` 全绿；`go list` 确认 `record_darwin.m` 参与 cgo 编译，`CGO_ENABLED=0` 的桩分支也可编译。GUI 真机验收、TCC 麦克风授权、真录音与真出声仍待人工。
- §一至§七 的原始验证记录保持不变。
