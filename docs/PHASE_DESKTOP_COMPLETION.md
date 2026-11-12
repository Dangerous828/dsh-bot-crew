# 桌面端四入口补齐报告

- 时间：2026-11-12 15:24–15:52（Asia/Shanghai）
- 仓库：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`
- 角色：desktop 子代理（补齐桌面尚缺的四个真实入口）
- 可写范围：`desktop/`、`docs/PHASE_DESKTOP_COMPLETION.md`；`docs/PHASE_DESKTOP_CHECK.md` 仅追加 §八 状态指针，§一至§七 原验证记录与并发会话追加的实现说明均保留。其余只读。
- 方法：`ponytail`（最小完整实现）逐入口落盘即测；出现并发写入造成的构建冲突时按 `diagnosing-bugs` 以 `go test ./...` 为反馈回路定位并合并。

## 一、结论

四个入口都已落在代码里，接进 UI 状态/事件循环，并各有自动化验证：

| 入口 | UI 位置 | 客户端调用 | 成功 | 失败 |
|---|---|---|---|---|
| 改记忆 | 记忆卡「编辑」→ 浮层填标题/正文 | `Client.EditMemory`（已有） | 关层并重读 `Memory` | 后端 `reason` 留在层里，层不关 |
| 听播报 | 每条 Bot 回复下「听播报」 | `POST /api/mobile/speak` | 写临时 WAV → `afplay` → 秒数/截断回执 | 后端没接、没声音、播放失败均显示原因 |
| 接手工单 | 在跑的工单卡「接手 →」 | `POST /api/mobile/takeover` | 仅 `{ok:true,stopped:true}` 显示「已接手」并重读时间线 | 404/409/503、缺字段、票已结束都如实说，不冒充 |
| 语音输入 | 输入卡「录音 / 停止并识别 / 取消」 | `POST /api/mobile/voice` | 识别文字只并进 `s.input` 草稿 | 权限拒绝、录音收尾、转码、识别失败分别显示原因 |

播报与语音输入全程在后台 goroutine：请求音频、写临时文件、`afplay`、请求麦克风、`AVAudioRecorder`、转码、识别都不占 UI 线程；结果统一走 `actionState.results` → `drain()` 的 `applyAction()`。临时文件在 `playWav` / `micSession.stop()` / `micSession.cancel()` 里 `defer os.Remove` 收走。

## 二、四端点真实契约与实现

契约取自 `backend/src/app/mobile-http.ts`（只读）：`speak` 470–490、`voice` 492–501、`memory` 516–549、`takeover` 640–649；WAV 规格取自 `app/voice.ts`（`looksLikeWav` / `MAX_WAV_BYTES` / `MAX_SECONDS`）与 `app/speech.ts`（`SpeakOutcome`）。

**播报**：成功是 `200` + `content-type: audio/wav` 的二进制 WAV，头带 `x-speech-seconds` / `x-speech-truncated`；没接入或念失败是 `200` 的 JSON `{available:false,status,reason}`；`text` 为空是 `400 {error}`。`parseSpeak` 严格按 `content-type` + `RIFF....WAVE` 双判据分岔，非 WAV 的 200 不会被拿去播。`actions_client.go` 的 `postRaw` 是四个端点共用的原始字节请求辅助（15s 的 `do()` 不够 `say`/本地识别，这里给 120s）。

**语音输入**：请求体就是 WAV 原字节（`Content-Type: audio/wav`），不是 JSON/base64；回执是 `{available:true,text,...}` 或 `{available:false,reason}`。`Client.Voice` 本地先挡下空/非 WAV/超 8MB；`normalizeVoiceWav` 解析 `fmt`/`data`，混成单声道、线性插值重采样到 16kHz、重写标准 44 字节头，并拦下非整数 PCM、无 `fmt`、空数据、超过 120 秒的录音。

**接手**：请求体 `{"ticket":"…"}`；`200 {ok:true,stopped:true}` 是唯一成功形态。`takeoverAck` 用 `*bool` 区分「字段缺失」与「false」，`takeoverOK` 要两个字段都为真才允许显示「已接手」并刷新；`takeoverNote` 把 404/409/400/503 的 `{error}` 与缺字段情况逐档说清。没有在跑的票、票已结束、没连上时分别显示「没有可接手的活儿」「这张票已经结束」「还没连上队伍」，不发请求。

**改记忆**：`POST /api/mobile/memory` 的 `{action:'edit',name,description,body}`；失败信号只在正文 `ok:false`（HTTP 仍 200），`Client.EditMemory` 的回执处理由上一轮修复提供，本轮接上 UI：编辑层草稿预填该条 `Description`/`Body`，保存成功关层 + `loadMemory()`，失败把 `err.Error()`（含后端 `reason`）留在层里，取消清空草稿且不写账本。

## 三、macOS 原生录音与权限

- `desktop/record_darwin.go` + `desktop/record_darwin.m`（`//go:build darwin && cgo`）：`AVFoundation` 的 `AVAudioRecorder` 按 16000 Hz / 单声道 / 16 位线性 PCM 写 WAV；`#cgo darwin LDFLAGS: -framework Foundation -framework AVFoundation`。
- 权限声明：`desktop/Info.plist` 的 `NSMicrophoneUsageDescription`（第 11 行）。运行时先查 `AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio`，未决定时 `requestAccessForMediaType:` 并用 `NSCondition` 同步等回话（60 秒超时）；拒绝 / 受限 / 超时分别有能照着做的中文文案（`micStatusMessage`），且明确指向「系统设置 → 隐私与安全性 → 麦克风」与 `.app` 打包。
- 取消与资源释放：`crew_record_cancel` 停止、`deleteRecording`、release 掉 `AVAudioRecorder` 单例；Go 侧 `micSession.cancel()` 清空 active/path 并 `os.Remove` 临时文件。`micSession` 的 mutex 串行化开始/停止/取消，句柄不跨线程传。
- 跨平台兜底：`record_stub.go`（`//go:build !darwin || !cgo`）明确报「这次编译没有 macOS 原生录音」，不假装有麦克风。
- 并发协作保留：`actionState.recorder voiceRecorder` 注入 seam 与 `record.go` 的 `voiceRecorder` 接口已合入；`voiceRecorderOf()` 在没注入时用真机 `micSession`，测试注入写固定 WAV 的假录音器，整条链路（录音→转码→识别→草稿、取消、权限拒绝）都不碰真麦克风即可自动化。

## 四、改动文件

| 文件 | 内容 |
|---|---|
| `desktop/ui.go` | `app.actions` 字段、`drain` 结果分支、记忆编辑浮层钩子、Bot 回复「听播报」、播报回执行、工单卡「接手」+ 按票回执、空态「没有可接手的活儿」、输入卡录音/停止/取消与回执行 |
| `desktop/main.go` | `newApp` 初始化 `actions: newActionState()` |
| `desktop/ui_actions.go` | `actionState` / `actionResult` / `applyAction` / `mergeDraft` / 记忆编辑层与保存 |
| `desktop/ui_speak.go` / `ui_takeover.go` / `ui_voice.go` | 三个入口的异步动作与状态机 |
| `desktop/actions_client.go` | `postRaw`、`backendMessage`、`isWav`、`Speak`/`parseSpeak`、`playWav`/`systemPlay`、`Takeover`/`parseTakeover`/`takeoverNote`、`Voice`/`parseTranscript` |
| `desktop/wav.go` | `normalizeVoiceWav` / `readPCM` / 混音 / 重采样 / 标准 WAV 头 |
| `desktop/record.go` / `record_darwin.go` / `record_darwin.m` / `record_stub.go` / `Info.plist` | 麦克风会话、权限、原生录音、跨平台桩、权限声明 |
| `desktop/actions_test.go` / `action_client_test.go` / `action_takeover_test.go` / `action_voice_test.go` / `voice_seam_test.go` | httptest 与纯函数单测（见下） |

上一轮的 `desktop/client.go`（`memoryWrite` 回执）、`desktop/ui.go`（`workDot`）、`desktop/memory_test.go`、`desktop/work_test.go` 全部保留，未重复实现。`backend/`、`app/`、`dsh-bridge/`、`relay/`、`scripts/`、`desktop/desktop` 已编译产物均只读未碰。

## 五、自动化验证（已执行）

| 命令 | 结果 |
|---|---|
| `cd desktop && go test ./... -count=1` | `ok github.com/Dangerous828/dsh-bot-crew/desktop 1.232s` |
| `cd desktop && go vet ./...` | 无输出，通过 |
| `go list -f 'CgoFiles={{.CgoFiles}} MFiles={{.MFiles}}' .` | `CgoFiles=[record_darwin.go] MFiles=[record_darwin.m]` |
| `go build -o /tmp/dsh-crew-desktop-cgo .` + `otool -L` | 链接 `Foundation.framework`、`AVFoundation.framework` |
| `CGO_ENABLED=0 go build -o /tmp/dsh-crew-desktop-nocgo .` | 通过（`record_stub.go` 分支） |
| `grep -rn '\[DEBUG-' desktop/*.go` | 无插桩残留 |

单测覆盖（`httptest` 模拟后端四种回执 + 纯函数边界）：

- 记忆：`TestEditMemorySendsDescriptionAndBody`（请求体四字段）、`TestSaveMemoryRefusalShowsBackendReason`（200 + `ok:false` 的 reason 到界面）、`TestMemoryEditOutcomes`（成功关层 / 旧回执忽略 / 取消清草稿）。
- 播报：`TestParseSpeakContract` 9 例（WAV 成功、截断头、后端没接、`say` 失败、400、401、类型不符、伪 WAV、空 200）、`TestClientSpeakRoundTrip`、`TestClientSpeakRefusal`、`TestPlayWavCleansTempFile`（播完 / 播放失败后临时文件都删、非 WAV 不建文件）。
- 接手：`TestParseTakeoverStrict` 10 例（`{ok:true,stopped:true}`、缺 `stopped`、缺 `ok`、显式 false、空对象、404/409/400/503、坏 JSON）、`TestClientTakeoverSendsTicket`、`TestTakeoverRefusalIsShownAsRefusal`、`TestTakeoverNoWorkIsHonest`、`TestApplyActionTakeoverKeepsNotesPerTicket`。
- 语音：`TestNormalizeVoiceWavAlreadySpec`（同规格不改数据）、`TestNormalizeVoiceWavResamplesAndMixes`（44.1k 立体声 → 16k 单声道、左右相反混成静音）、`TestNormalizeVoiceWavRefusals` 7 例、`TestParseTranscript` 8 例、`TestClientVoiceRoundTrip`（WAV 原字节）、`TestClientVoiceRefusals`（reason + 本地不发注定失败的请求）、`TestMicStatusMessage`、`TestMicSessionIdleIsSafe`、`TestVoiceStateTransitionsKeepDraft`；seam 链路 `TestVoiceChainFillsDraftOnly`（不发送）、`TestVoiceCancelReleasesAndKeepsDraft`、`TestVoiceStartPermissionDenied`、`TestVoiceStopRefusalShowsReason`、`TestVoiceStopRecorderFailure`。

环境：`go version go1.25.3 darwin/arm64`（`desktop/go.mod` 写 `go 1.27.3`，由 Go 工具链解析），`CGO_ENABLED=1`，Xcode SDK 可用，`/usr/bin/afplay` 存在。

## 六、待人工 GUI / 麦克风权限验收（本轮明确未做）

本轮没有启动 GUI、没有运行 `desktop` 二进制、没有弹出 TCC 授权框、没有真录音、没有让 `afplay` 出声、没有与真实后端联调。以下需在其他会话的真机验收里逐项点过：

1. 把桌面程序打成 `.app` 并带上权限声明（示例命令，本轮未执行）：
   ```
   mkdir -p "Bot 队伍.app/Contents/MacOS"
   cp desktop/Info.plist "Bot 队伍.app/Contents/Info.plist"
   cd desktop && go build -o "../Bot 队伍.app/Contents/MacOS/desktop" .
   codesign -s - --deep "Bot 队伍.app"
   ```
   裸二进制运行时 macOS 会把麦克风权限算在启动它的终端上；打包后 `NSMicrophoneUsageDescription` 才会作用到本程序。
2. 首次按「录音」时系统弹框允许麦克风；再验拒绝（去「系统设置 → 隐私与安全性 → 麦克风」关掉后重试）与取消（录音中点「取消」后临时目录无残留）。
3. 说一句话 → 点「停止并识别」→ 确认识别文字只出现在输入框草稿里、没有自动发出；后端没接识别时确认显示后端 `reason`。
4. 在一条 Bot 回复下点「听播报」确认出声，并显示秒数/截断；后端没接播报或 `say`/`afconvert` 失败时确认显示原因。
5. 在一张在跑的工单上点「接手 →」确认后端停票、卡片显示「已接手：这张票停下了」；票不存在/已结束/执行器不可用时确认如实显示，不出现「已接手」。
6. 记忆卡点「编辑」改标题与正文 → 保存后列表刷新；后端返回 `ok:false` 时确认层不关且显示 `reason`。

## 七、边界与风险

- 未做：`git commit` / `push` / `checkout` / `reset`、启停服务或重启 DSH Desktop、ADB、运行态配置与数据库、`backend/lib`、全仓格式化、启动 GUI 抢窗口、任何通知推送。
- 并发写入：本轮期间 desktop 目录有另一会话同时落盘（`actionState.recorder` seam、`record.go` 接口、`docs/PHASE_DESKTOP_CHECK.md` 追加）。曾出现瞬时重复定义导致 `go test` 构建失败，已按 `diagnosing-bugs` 以构建命令为反馈回路定位并合并，最终状态全绿；他人改动全部保留。
- 风险：`AVAudioRecorder` 真机写出的头可能带额外 chunk 或跟随设备采样率，`normalizeVoiceWav` 已在交给识别器前统一规格；该路径只有自动化字节级证据，真机格式仍需上条验收。
- 风险：播报秒数与截断依赖后端自定的 `x-speech-*` 响应头，中转若剥掉未知头只显示「已念完」，音频本身仍能播。`afplay` 同步播放最长约两分钟，期间按钮显示「正在播报…」，UI 不阻塞。
- 风险：`postRaw` 把响应正文上限设为 12MB（后端 `voice.ts` 的 WAV 上限 8MB），更大的回包会被截断并按 JSON/文本报错，不会静默当成功。
