# desktop 状态推进的根治：从「挂在绘制上」改为「挂在数据到达上」

对应 issue [#27](https://github.com/Dangerous828/dsh-bot-crew/issues/27)。
写范围：`desktop/ui.go`、`desktop/main.go`、`desktop/debug.go`、新增 `desktop/state_pump_test.go`。
未改后端 / app / `开发进度.md` / `HANDOFF.md` / `scripts/crew-watch/`。

## 一、根因

`s.drain(c)` 只在 `desktop/ui.go` 的 `view()` 里被调用一次一帧。后台 goroutine 把结果放进
`arrived` / `sessionsCh` / `memoryCh` / `actions.results` 等通道之后只调 `s.wake()`，
而 `wake()` 只做 `services.Invalidate()` —— 那是「请求一帧」，不是「推进状态」。

窗口不画（锁屏、被遮挡、App Nap、`open -g -j` 隐藏启动）⇒ 没有帧 ⇒ 通道里的结果永远不被收走。
**状态推进挂在绘制上，而不是挂在数据到达上。** 这就是 `state.dump` 恒为 `messages:-1` /
`memoryCount:-1`、以及「重启后界面回到旧状态」这一类现象的同一个洞。

上一轮（`docs/PHASE_ISSUE18_RELAY_AND_GUI.md` §3.5）已把这个根因写清，但只在调试口加了
`pumpResults()` 绕行，产品路径一个字节没改。同处还留了一条错误的「不可行」判断：

> 试过在 `wake()` 里也 `drain(nil)`，但那样会绕过 S3 的能力位先验门禁
> （`TestRefreshWaitsForTheCapabilityProbe` 变红）。

**这条判断只在「后台 goroutine 里直接 drain」时成立**：那样 `drain` 会在任意线程上跑，
`applySessions` 可能先于 `refresh()` 的调用者观察到的状态落地，于是时间线在 `sessionBusy`
尚未被读到之前就发出去了。根治的写法不是「不要 drain」，而是**把 drain 交给主线程**：
队列一换，`applySessions` 与 `refresh()` 仍然严格串行在同一个线程上，门禁自然不受影响。
本次就是这样修的，`TestRefreshWaitsForTheCapabilityProbe` 一条未改、依旧绿。

顺带查出的同类洞（同一根因：后台 goroutine 直接改主线程状态）：

| 位置 | 症状 |
| --- | --- |
| `wake()` 读 `s.services`，`view()` 每帧写它 | `-race` 必报（HEAD 上就存在） |
| `send()` / `sendSteer()` 的 `defer func(){ s.sending = false }()` | `-race` 必报 |
| `sendSteer()` 里直接写 `s.steerNote` | `-race` 必报 |

这三处不是本次引入的，是同一类「后台线程碰主线程状态」的存量问题，一并收口。

## 二、改法

只加了一条通道：**后台结果到达 → 交给主线程队列 → 在主线程上 drain**。

```go
// 后台结果到达即推进状态，不依赖有没有帧；交给主线程执行，保证状态只在一个线程上改。
func (s *app) wake() { s.postMain(func() { s.drain(nil) }) }

// 窗口在时走 mygo 的窗口队列（Window.Update：主线程执行，然后请求一帧）；不在时攒着。
func (s *app) postMain(fn func()) {
	s.postMu.Lock()
	post := s.post
	if post == nil {
		s.pending = append(s.pending, fn)
	}
	s.postMu.Unlock()
	if post != nil {
		post(fn)
	}
}
```

`main.go` 在窗口建好后绑一次：

```go
s.bindPost(window.Update)
```

`bindPost` 会把绑定之前攒下的任务立刻倒给窗口队列（启动那一小段就属于这个窗口期），
并把 `post` 与 `pending` 放在同一把锁下，避免调试口 goroutine 与主线程的绑定动作互相踩。

三处存量竞态改成「后台只把改动交回主线程」：

```go
defer s.postMain(func() { s.sending = false })
s.postMain(func() { s.steerNote = "已插话，…" })
```

`services` 字段在改完后已无人使用，删掉（它本来就是那处竞态的唯一来源）。

### 为什么没有把「依赖画帧」挪到别处

- **没有**改成定时器反复重画（那是把问题从「等帧」换成「烧 CPU 等帧」）。
- **没有**在 `wake()` 里直接 `drain(nil)`（那才是绕过门禁的写法）。
- **没有**为了测试放松门禁：`refresh()` 里那三道判据（`sessionsChecked` → `sessionBusy`/`refreshing`
  → 才发 timeline）一个字没动。
- **没有**给测试开后门：`drain(nil)` 这条路径本来就是「只推进状态、不绘制」，
  `postMain` 走的是产品路径同一个 `drain`。

## 三、测试证据

```
$ cd desktop && go vet ./...
vet=0

$ go test -count=1 ./...
ok  	github.com/Dangerous828/dsh-bot-crew/desktop	1.487s
test exit=0

$ go test -count=1 -race ./...
ok  	github.com/Dangerous828/dsh-bot-crew/desktop	5.012s
race exit=0
```

`-race` 在改前是红的（`TestComposerCanSendANewLineStraightIntoTheRunningTicket`、
`TestDesktopSessionSwitchListCreateSendAndCaches` 两例），在 HEAD 的干净副本上同样红 ——
证明那两条不是我引入的，是存量。

新增 `desktop/state_pump_test.go`，八例，全部**不建 Tester、不调 `view()`**：

| 用例 | 钉住什么 |
| --- | --- |
| `TestStateAdvancesWithoutAFrame` | 一帧都不画：先验 → 时间线 → 条数自己跟上，且等于后端真值 |
| `TestMemoryCountAdvancesWithoutAFrame` | 同上，记忆那一栏的 `memoryCount` |
| `TestWakeHandsTheDrainToTheMainThread` | `wake` 只把任务交出去、自己不落状态；主线程跑了才落 |
| `TestStateStaysPutUntilTheMainThreadRuns` | **反向**：不跑主线程队列，状态必须原地不动 |
| `TestPumpResultsUsesTheSameQueue` | 调试口走同一个机制，`state.dump` 与真值一致 |
| `TestQueuesArePerApp` | 两个 app 的队列互不串 |
| `TestPostMainPrefersTheWindowQueue` | 有窗口队列时不再走本地队列（不出现两套队列） |
| `TestBindPostFlushesWhatArrivedBeforeIt` | 绑窗口前到达的结果不丢，且不会被跑两遍 |

### 反向验证（红→绿，两处独立证据）

**单测级**：把 `wake()` 临时改回 `s.services.Invalidate()`，五例全红：

```
--- FAIL: TestStateAdvancesWithoutAFrame (3.01s)
    state_pump_test.go:40: 不画帧就等不到：能力位先验回来
--- FAIL: TestMemoryCountAdvancesWithoutAFrame (3.00s)
--- FAIL: TestWakeHandsTheDrainToTheMainThread (0.00s)
    state_pump_test.go:80: wake 应把一次状态推进交给主线程，实际 0 次
--- FAIL: TestStateStaysPutUntilTheMainThreadRuns (0.00s)
--- FAIL: TestPumpResultsUsesTheSameQueue (3.00s)
```

**真进程级**：同一份探针二进制，只把 `wake()` 换回旧写法，对比见下节。

## 四、真进程复验（无绘制 / 无焦点）

约束遵守：不抢鼠标、不聚焦、不解锁桌面、不重启生产 dsh / mobilegw、不 `pkill -f`、不 commit / push。

做法：把 `desktop/*.go` 复制到 `/tmp/crewprobe`，配一个只在该目录存在的 `main.go`：
起**真的 mygo 应用 + 真的窗口**（`Window.Update` 已绑定），但 `Hidden: true` ——
窗口存在、主循环在跑、`post` 已绑，**只是不显示**，因此不绘制、不抢焦点。
假队伍是 `httptest` 起的真 HTTP 服务，请求是真发出去的。

### 红绿对照（同一条探针，只差 `wake()` 那一行）

| 观测点 | 旧写法 | 修复后 |
| --- | --- | --- |
| `view()` 被调用次数（start → done） | 1 → 1 | 1 → 1 |
| `after_refresh.messages` | **-1** | **3** |
| `after_refresh.sessions` | **null** | **["main","work"]** |
| `after_memory.memoryCount` | **-1** | **3** |
| `after_switch.loaded` | **false** | **true** |
| `state_dump.sessionCapability` | **pending** | **live** |
| `state_dump.sessionSwitchable` | **false** | **true** |

关键点：两次运行的 `viewCalls` **都是 1** —— 也就是建窗口那一帧之后再没有第二帧。
旧写法在「零新帧」下全部停摆，新写法在同样「零新帧」下全部到位。
这正是「不依赖绘制」的直接证据，不是把依赖挪到了别处。

修复后的完整输出：

```json
{"postBound":true,"step":"start","viewCalls":1}
{"api":false,"checked":false,"step":"capability_before"}
{"api":true,"checked":true,"messages":3,"session":"main","sessions":["main","work"],"step":"after_refresh"}
{"memoryCount":3,"step":"after_memory"}
{"loaded":true,"messages":1,"session":"work","step":"after_switch","switched":true}
{"memoryCount":3,"messages":1,"session":"work","sessionCapability":"live","sessionSwitchable":true,"step":"state_dump","viewCalls":1}
{"step":"done"}
```

旧写法（同一探针，`wake()` 换成 `s.services.Invalidate()`）：

```json
{"postBound":true,"step":"start","viewCalls":1}
{"api":false,"checked":false,"step":"capability_before"}
{"api":false,"checked":false,"messages":-1,"session":"main","sessions":null,"step":"after_refresh"}
{"memoryCount":-1,"step":"after_memory"}
{"loaded":false,"messages":-1,"session":"main","step":"after_switch","switched":false}
{"memoryCount":-1,"messages":-1,"session":"main","sessionCapability":"pending","sessionSwitchable":false,"step":"state_dump","viewCalls":1}
{"step":"done"}
```

### 门禁仍然成立（真进程侧）

同一次运行里按到达顺序记下的请求：

```
/orchestrator/api/remote/devices
/api/mobile/sessions          ← 能力位先验
/api/mobile/timeline          ← 先验过了才发
/orchestrator/api/state
...
/api/mobile/timeline?session_id=work   ← 切会话之后才发
```

`GET /api/mobile/sessions` 严格排在第一条 `/api/mobile/timeline` 之前；
切到 `work` 之前没有任何带 `session_id=work` 的请求。**门禁没有放松。**

### 焦点

```
front before: DeepSeek Harness
front after:  DeepSeek Harness
```

探针进程按精确 PID 回收（`wait`），运行后 `ps` 无残留；临时目录 `/tmp/crewprobe_old` 已删。
**没有触碰用户正在跑的桌面端**（`build/Bot Crew.app` 未启动、未替换、未重新打包）。

## 五、局限（未覆盖的）

1. **真锁屏 / 真 App Nap 未实测。** 本机当前未锁屏，且按约束不去解锁或制造锁屏。
   「无绘制」是用 `Hidden: true` 构造的：窗口存在、主循环在跑、但确实没有第二帧。
   这与锁屏 / 遮挡在「帧不来」这一点上等价，但**不是**同一件事 ——
   App Nap 还会降频定时器、系统睡眠会停进程，那些条件下的行为本次没有证据。
2. **没有真 GUI 像素证据。** 按约束不抢焦点、不解锁，`screencapture` 类手段不使用。
   本节所有结论都来自结构化状态与真实 HTTP 请求序列。
3. **生产 `.app` 未重新打包。** `build/Bot Crew.app` 仍是 11-12 的构建，不含本次改动。
   要在真窗口里看到效果需要重新打包（`desktop/package.sh`），这一步本次没做 ——
   打包会替换用户可能在用的产物。
4. **`refreshing` 标志未纳入本次收口。** 它由 `refreshMu` 保护，是唯一一处
   「后台 goroutine 写、但有明确锁」的状态，`-race` 干净，故不动。
5. **`bindPost` 之前的窗口期**只覆盖到 `WhenReady` 里建窗口那一小段；
   `main.go` 里 `bus.serveDebug` 早于 `WhenReady` 启动，那期间调试口调用 `wake()`
   会落进 `pending`，由 `bindPost` 倒出。这条路径有单测（`TestBindPostFlushesWhatArrivedBeforeIt`），
   但**没有**在真进程里构造「调试口在 bindPost 之前就调用」的时序。
