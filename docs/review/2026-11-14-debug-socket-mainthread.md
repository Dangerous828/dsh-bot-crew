# 调试口的主线程串行与生命周期收口（#27 集成审查遗留）

对应 issue [#27](https://github.com/Dangerous828/dsh-bot-crew/issues/27) 关闭后的集成审查发现：
产品路径（`wake → postMain → drain`）已修好，**调试口那一半仍是跨线程**。

写范围：`desktop/ui.go`、`desktop/debug.go`、`desktop/main.go`、新增 `desktop/mainthread.go`、
新增 `desktop/debug_mainthread_test.go`。未改 `app/`、`backend/`、`开发进度.md`、`HANDOFF*.md`、
`scripts/crew-watch/`。

## 一、根因

`DebugBus.invoke` 在**调用方的 goroutine**（`bus.handleConn`，即 socket 连接的处理协程）
上直接跑动作体：

```go
func (bus *DebugBus) invoke(name string, args ...) (any, error) {
	fn, ok := bus.actions[name]
	...
	bus.mu.Lock()
	defer bus.mu.Unlock()
	return fn(args)   // ← 在 socket goroutine 上执行
}
```

而动作体里有 `s.pumpResults(...)`：

```go
for {
	s.runPending()   // 跑主线程队列
	s.drain(nil)     // 把结果写进 app 状态
	...
}
```

`app` 的状态归主线程所有（`view()` 就在那条线程上跑）。于是同一批字段有两个写者：
socket goroutine 走 `drain` 写，主线程走 `view` 写。`bus.mu` 只串行化**动作之间**，
对 `view()` 一点约束都没有 —— 这就是「产品路径已修、调试口仍跨线程」。

`wake()` 本身是对的：它只把 `drain(nil)` 交给主线程（`postMain`）。问题在 `pumpResults`
自己又直接跑了一遍 `runPending + drain`，绕过了那条规矩。

## 二、核实 mygo 的线程语义

读 `github.com/egoist/mygo@v0.8.3`：

| 事实 | 出处 | 对本次修复的含义 |
| --- | --- | --- |
| 主线程队列是一个 FIFO，由后端 `Dispatch` 在 UI 线程上 drain | `loop.go:17-58` | `Window.Update(fn)` 的 `fn` 确实在 UI 线程执行 |
| `Window.Update` = `postMain(fn)` + 执行后请求一帧 | `content.go:190-196` | 产品路径的绑定方式正确，不动 |
| darwin 后端把队列跑在 CFRunLoop 的 C 回调里（`dispatchCallback`） | `internal/darwin/app.go:161-166` | **不能**靠 goroutine 编号判断「我是不是主线程」——每次从 C 进 Go 都是新 goroutine |
| `init()` 里 `runtime.LockOSThread()` | `mygo.go:74-76` | UI 线程固定在主 goroutine 的 OS 线程上；但 Go 的 goroutine 身份仍不稳定 |
| `RunOnMain` 在主线程上会**直接执行**，否则投递并等待 | `loop.go:82-99` | 这正是需要的语义；但它不导出「我是不是主线程」，且无超时 |

结论：**执行位置用「跑批的那个 goroutine 是谁」来判定**，不能用「绑窗口时记下的编号」。

## 三、改法

### 1. 入队与执行彻底分离（`ui.go`）

原来有两条执行路径：有窗口 → 直接丢给 `Window.Update`；没窗口 → 攒着等 `runPending`。
两条路径谁都能在任意 goroutine 上把任务跑起来。现在只有一条：

```go
// 入队（任何 goroutine）→ 去重地给主线程排一次 runPending → 主线程按 FIFO 跑完
func (s *app) postMain(fn func()) { s.enqueue(fn) }

func (s *app) enqueue(fn func()) bool {
	s.postMu.Lock()
	if s.closed { s.postMu.Unlock(); return false }
	s.pending = append(s.pending, fn)
	post := s.post
	needPump := post != nil && !s.pumpQueued
	if needPump { s.pumpQueued = true }
	s.postMu.Unlock()
	if needPump { post(s.runPending) }
	return true
}
```

`pumpQueued` 只在**真的排进窗口队列**时置真 —— 否则 `bindPost` 会以为攒下的任务已经有人跑过
（这条是测试 `TestBindPostFlushesWhatArrivedBeforeIt` 抓出来的真 bug，见 §五）。

顺带收益：同一批到达的结果合成一次重绘，不再「一条结果一帧」。

### 2. 主线程判据：跑批 goroutine 的编号（`ui.go` + `mainthread.go`）

```go
func (s *app) runPending() {
	...
	previous := s.batchGID.Swap(goroutineID())
	defer s.batchGID.Store(previous)   // 嵌套安全：pumpResults 会重入
	for _, fn := range batch { fn() }
}

func (s *app) isMainThread() bool {
	if !bound { return true }          // 单测：没有第二个线程
	batch := s.batchGID.Load()
	return batch != 0 && goroutineID() == batch
}
```

不用 `mainDepth > 0`（「有人在跑」）：队列执行期间 socket goroutine 也可能来问，
那样会把它误判成主线程，等于又放开了跨线程写。存旧值再恢复是为了嵌套
（动作体在主线程上会自己再跑一次 `runPending`）。

`goroutineID` 读 `runtime.Stack` 首行（`mainthread.go`），只在两条边界上用，不在热路径。

### 3. 动作体整体投到主线程（`debug.go`）

```go
func (bus *DebugBus) invoke(name string, args ...) (any, error) {
	fn, ok := bus.actions[name]
	if !ok { return nil, fmt.Errorf("unknown action: %s", name) }
	bus.mu.Lock()          // 动作之间串行（edit → save 有先后关系）
	defer bus.mu.Unlock()

	var result any; var err error
	if waitErr := bus.app.runOnMain(timeout, func() { result, err = fn(args) }); waitErr != nil {
		return nil, fmt.Errorf("%s: %w", name, waitErr)
	}
	return result, err
}
```

`runOnMain` 的三种返回：

| 情形 | 行为 |
| --- | --- |
| 已在主线程队列里（动作体自己重入） | 直接执行，不投递 —— 投递并等待自己是必死死锁 |
| 队列已收掉（窗口关了） | 立刻返回 `errMainClosed`，不干等超时 |
| 主线程超时不来 | 返回带动作名的超时错误，`ok:false` |

超时 20s（`debugActionTimeout`）：动作里最长的等待是自己的 settle 预算，给足余量；
测试里 `bus.timeout` 可调小。

**超时的语义是「调用方不再等」，不是「动作被撤销」。** 队列项没有取消机制：Go 的切片
队列要删中间一项，要么加锁改结构、要么留空洞，都不值当。所以超时返回之后，主线程一旦
恢复，那条动作**仍会照常执行**，副作用（改状态、发请求）也照常发生。外部脚本拿到的是
「我没等到结果」，不能据此假设「这件事没发生」—— 要么重试，要么重新 `state.dump` 读现状。

这条语义有专门用例钉住（`TestTimedOutActionStillRunsWhenTheMainThreadComesBack`）：
超时后手动跑主线程队列，动作必须执行恰好一次且副作用落地。将来若引入真正的取消机制，
这条会红，提醒同步改文档与脚本假设。

### 4. 主线程等待封顶（`debug.go`）

`pumpResults` 现在整段跑在主线程上，等待会占住主线程（那期间窗口不画）。
加 `mainThreadSettleCap = 3s` 封顶：后端正常时几毫秒就落定；后端卡住时到点返回
`settled:false`，让界面继续画，而不是把窗口冻到 15s 预算用尽。判据字段语义不变。

### 5. 生命周期（`ui.go` + `debug.go` + `main.go`）

- `closeMain()`：关闭 `closedCh`，之后的任务一律丢弃，等在 `runOnMain` 里的调用立刻返回
  `errMainClosed`。
- `DebugBus.closeConnections()`：记着 listener 与所有活连接，收口时一起关掉。
  不这么做，窗口关了之后连接上的动作会立刻报错，但连接本身不会断（decoder 还在等下一行），
  外部脚本看到的是「连着但没反应」。
- `main.go`：动作表在 `main` 里建（它只看 app），**socket 改到 `WhenReady` 里 `bindPost`
  之后才开**。原来 `serveDebug` 早于 `WhenReady`，那期间到达的动作会落进「没有主线程队列」
  的分支，等于又回到跨线程。现在窗口 `OnClosed` 里 `closeMain()` + `closeConnections()`。

## 四、测试证据

```
$ cd desktop && go vet ./...
vet exit=0

$ go test -count=1 ./...
ok  	github.com/Dangerous828/dsh-bot-crew/desktop	1.983s
test exit=0        # 278 PASS / 0 FAIL

$ go test -count=1 -race ./...
ok  	github.com/Dangerous828/dsh-bot-crew/desktop	7.010s
race exit=0        # DATA RACE 计数 0，连跑 3 次稳定
```

`state_pump_test.go` 原有 8 例（#27 那一轮的成果）**一条未改，全部仍绿**。

### 新增 `debug_mainthread_test.go`（10 例）

| 用例 | 钉住什么 |
| --- | --- |
| `TestDebugActionRunsOnThePumpingGoroutine` | 动作体执行时 `batchGID` 指向的就是本 goroutine，且**不是**调用方 goroutine |
| `TestActionOnTheCallerGoroutineWouldFailTheCheck` | 判据自身有效：在调用方 goroutine 上直接跑时 `batchGID` 必为 0 |
| `TestConcurrentDebugSocketsSerializeActions` | 8 连接 × 5 次真 socket 调用，动作体最大重叠层数 = 1 |
| `TestConcurrentDumpsNeverSeeATornState` | 成对字段（`sidebarClosed`+`navTab`）在并发读下不撕裂 |
| `TestDebugActionsDoNotRaceTheProductView` | **产品 `view()` 作为并发读者**，socket 同时改状态；`-race` 下必须干净 |
| `TestDebugActionTimesOutWhenTheMainThreadNeverRuns` | 主线程不跑 → 120ms 内返回带动作名的错误，不永远挂着 |
| `TestTimedOutActionStillRunsWhenTheMainThreadComesBack` | **超时≠撤销**：主线程恢复后动作照常执行一次，副作用落地 |
| `TestDebugActionFailsFastAfterTheQueueCloses` | `closeMain()` 后等在里面的动作立刻返回 `errMainClosed`；新动作也立刻失败；关两次不 panic |
| `TestPostMainIsRefusedAfterClose` | 关掉之后 `postMain` 不再接受任务 |
| `TestCloseConnectionsEndsOpenSockets` | `closeConnections()` 后连接被服务端关掉（读到 EOF 而非超时），listener 不再接受新连接 |

（10 例；上表覆盖执行位置、并发串行、状态不撕裂、view 竞态、超时、超时后语义、
关闭生命周期、连接生命周期八个维度。）

### 反向验证（红→绿）

**探针 1：`invoke` 改回在调用方 goroutine 上直接跑**

```
--- FAIL: TestDebugActionRunsOnThePumpingGoroutine
    debug_mainthread_test.go:65: 动作体执行时不在主线程队列里（batchGID=0）：说明它是在调用方 goroutine 上直接跑的
--- FAIL: TestDebugActionTimesOutWhenTheMainThreadNeverRuns
    debug_mainthread_test.go:284: 主线程没跑，动作却成功了
--- FAIL: TestDebugActionFailsFastAfterTheQueueCloses
    debug_mainthread_test.go:327: 动作没排进主线程队列
```

**探针 2（最关键）：同一处回退，`-race` 直接点名两个写者**

```
$ go test -race -run TestDebugActionsDoNotRaceTheProductView
WARNING: DATA RACE
      desktop/debug.go:103   ← 动作体在 socket goroutine 上写状态
      desktop/debug.go:581
      desktop/debug.go:828   ← handleConn
      desktop/ui.go:1071     ← 主线程 view()/drain 同一批字段
      desktop/ui.go:991
WARNING: DATA RACE
      desktop/debug.go:76
      ...
      desktop/ui.go:3448 / 3443 / 3442 / 1043 / 1042 / 1041 / 1023 / 1021 / 999 / 993
```

栈上两侧分别是 `debug.go` 的 action 与 `ui.go` 的 view —— 正是「产品 wake→postMain 正确、
调试口仍跨线程」这一条。修复后同一用例 `-race` 干净。

> 说明：`TestConcurrentDebugSocketsSerializeActions` 与 `TestConcurrentDumpsNeverSeeATornState`
> 在探针 1 下**不会**变红 —— `bus.mu` 本来就串行化动作之间，它们证明的是「动作之间串行、
> 状态不撕裂」，不能替代「与 view 并发」这条。真正的红点是 `-race` 那条，已单独列出。

## 五、改出来的真 bug（被测试抓到）

第一版 `postMain` 无条件把 `pumpQueued` 置真。没绑窗口时队列攒着没人跑，
但 `bindPost` 看到 `pumpQueued=true` 就不再排泵 —— 绑定之前到达的任务永远不跑。

```
--- FAIL: TestBindPostFlushesWhatArrivedBeforeIt (0.00s)
    state_pump_test.go:176: bindPost 没把攒下的任务倒出来：flushed=0 ran=0
```

改成「只有真的排进窗口队列才置真」后转绿。这条是 #27 原有测试抓出来的，
说明那 8 例不是摆设。

## 六、真进程复验（真 mygo 主循环 / 真窗口 / Hidden）

做法：`desktop/*.go` 复制到 `/tmp/crewprobe2`，配一个只在该目录存在的 `main.go`：
起**真的 mygo 应用 + 真的窗口**（`Hidden: true` —— 窗口存在、主循环在跑、`post` 已绑，
只是不显示，因此不绘制、不抢焦点），假队伍是 `httptest` 起的真 HTTP 服务。

### 结构化输出（`-race` 构建，22 秒）

```json
{"step":"start"}
{"actionGID":1,"batchGID":1,"onMain":true,"step":"where"}
{"failures":null,"ok":48,"step":"concurrent"}
{"result":{"loaded":true,"messages":3,"session":"work"},"step":"session.set"}
{"elapsedMs":0,"ok":false,"step":"after_close",
 "transportError":"dial unix /tmp/crewprobe-46232.sock: connect: no such file or directory"}
{"step":"done"}
```

逐条读：

- `actionGID == batchGID == 1`：动作体在 **goroutine 1**（mygo 主线程，`init()` 里
  `LockOSThread` 的那条）上执行，与跑批的是同一条。这正是修复目标。
- `ok: 48`，`failures: null`：8 连接 × 6 轮真 socket 调用全成功。
- `session.set` 返回 `loaded:true, messages:3`：动作语义与参数一格未变，外部脚本照旧可用。
- `after_close`：关窗后连接已被 `closeConnections()` 收掉，新连接**连不上**（`no such file`）。
  0ms 返回，不是干等超时。
- `WARNING: DATA RACE` 计数 **0**。

### 焦点

```
front before: Finder
front after:  Finder
```

窗口 `Hidden: true`，20 次采样（每 0.5s）全程 `Finder`，**零次抢焦点**。
探针进程按精确 PID `wait` 回收，`ps` 无残留；`/tmp/crewprobe2` 与 `/tmp/crewprobe_race` 已删。
未触碰 `build/Bot Crew.app`，未重启生产 dsh / mobilegw，未 `pkill -f`。

## 七、局限（未覆盖的）

1. **`batchGID` 判据依赖 `runtime.Stack` 首行格式。** 这是 runtime 的稳定输出，但不是
   导出 API；且只在入队前判一次，不在热路径。若未来 runtime 改了格式，`goroutineID()`
   返回 0，`isMainThread()` 会退化成「永远不是主线程」—— 表现为动作一律走投递（仍然正确，
   只是主线程内重入会多绕一圈），不会退化成跨线程写。这个退化方向是安全的。
2. **真锁屏 / 真 App Nap 未实测。** 本机未锁屏，按约束不去制造。`Hidden: true` 与锁屏在
   「帧不来」这一点上等价，但 App Nap 还会降频定时器，那条件下没有证据。
3. **生产 `.app` 未重新打包。** `build/Bot Crew.app` 不含本次改动；要在真窗口里看到效果需
   重新打包（`desktop/package.sh`），本次未做。
4. **`debugActionTimeout`（20s）与 `mainThreadSettleCap`（3s）是估值。** 依据是现有
   `pumpResults` 预算（10–15s）与本地假后端实测（毫秒级）。真实慢后端下的手感未测。
5. **并发用例只压到 8 连接。** 更高并发（几十上百）没有证据；`bus.mu` 是全局串行锁，
   高并发下会排队，这是设计取舍（动作之间有先后关系），不是缺陷。
6. **超时之后动作仍会执行（无取消机制）。** 见 §三.3。这是当前有意的取舍，不是遗漏；
   外部脚本按「超时≠没发生」处理。若将来要真正的取消，需要给队列项加 id + 取消标记，
   并把 `TestTimedOutActionStillRunsWhenTheMainThreadComesBack` 一起改掉。
