# 桌面最终集成审核与打包验收（#27 收口线）

写范围：本文件 + `desktop/build/release-20261114/`（构建产物，`.gitignore` 已忽略 `desktop/build/`）。
未改源码、未改 `开发进度.md` / `HANDOFF*.md` / `crew-watch`、无任何 git 写操作、未重启
dsh / mobilegw、未 `pkill -f`、未发桌面键鼠、未聚焦任何窗口。

被审对象是当前工作树：`HEAD b2f305e` + 未提交改动（`desktop/debug.go`、`desktop/ui.go`、
`desktop/main.go`、新增 `desktop/mainthread.go`、新增 `desktop/debug_mainthread_test.go`、
新增 `desktop/debug_settled_test.go`）。

---

## 一、结论

**审查通过，产物已打包。** 主线程断言是真的；没有阻断级缺陷；#27 可以关。

三处发现按严重度排：

| # | 严重度 | 一句话 |
| --- | --- | --- |
| F1 | 中（真实 bug，已给最小修复） | 动作跑完与窗口关闭同时就绪时，`select` 随机选中 `closedCh`，把「已执行完」报成「这条动作不会执行」。确定性复现 200/200。 |
| F2 | 中（真实 race，已给最小修复） | `bus.listener` 在 `serveDebug` 里无锁写、在 `closeConnections` 里锁内读。`-race` 点名。生产时序下窗口极小但存在。 |
| F3 | 低（记录，不改） | 收口之后 `serveDebug` 仍能 `Listen` 成功，留下一个没人 `accept` 的死 socket：连得上、写得进、永远没回话 —— 正是本轮要消灭的那种状态。 |

**这三条都不阻断本轮发布**：F1/F2 的触发条件需要「窗口关闭」与「动作完成/调试口启动」在极窄窗口内重叠，
正常用户路径（窗口开着、脚本一条条打动作）不会遇到；F3 只在窗口先关、socket 后开的次序下出现，
而 `main.go` 里 `serveDebug` 排在 `OnClosed` 注册之后、`WhenReady` 内，实际不会出现该次序。

lead 已确认 #27 的既定口径：`runOnMain` 超时是「调用方不再等」，不是「动作被撤销」。
我按证据评估为**可接受的调试协议 unknown outcome**，理由见 §四 —— 不是理论风险，是实测过的
可达但被 `sending`/`withdrawing`/`pausing`/`steering` 门挡住的实际行为。

---

## 二、主线程断言是真的（逐条取证）

### 2.1 判据本身有效

`isMainThread()` 的判据是「本 goroutine 编号 == 正在跑批的 goroutine 编号」（`ui.go:556-568`）。
我在真源码上跑了三条探针：

| 探针 | 结果 |
| --- | --- |
| 200 个 goroutine 各自取 `goroutineID()` | 取到 0 的次数 = 0 |
| panic/recover 之后、`runtime.GC()` 之后取 | 稳定返回同一编号 |
| 同一批内嵌套 `runPending` | 外层 = 嵌套 = 2082，批结束后 `batchGID` 恢复为 0 |

第三条是关键：`runPending` 存旧值再恢复（`ui.go:504-505`），嵌套时不会把外层标记清掉 ——
所以 `pumpResults` 在动作体里再跑一次 `runPending` 不会让外层剩余任务被误判成「不在主线程」。

### 2.2 动作体确实在跑批 goroutine 上

沿用 `ds-debug-thread-max` 的 `TestDebugActionRunsOnThePumpingGoroutine`：断言不是「跑完了」，
而是「执行期间 `batchGID` 指向的就是本 goroutine，且不是调用方 goroutine」。该例在冻结树上绿。

### 2.3 与产品 `view()` 不并发

`TestDebugActionsDoNotRaceTheProductView` 让 `view()` 作并发读者、socket 同时改状态，
`-race` 干净。这是唯一直接对准真窗口形态的判据，我复跑了 3 次，稳定。

### 2.4 真进程复验（我自己的无焦点启动）

不是复用别人的结论，我自己按 GUI owner 已验证的 overlay 方案重建了一份：

- 只替换 `/tmp` 副本里的 `main.go`（加 `Hidden: true` + `ShowInactive()`），另注入一个
  只在 `/tmp` 存在的 `zz_verify.go`（`CREW_VERIFY_ACCESSORY=1` 时设 accessory 策略）。
- **仓库工作树里没有这两个文件**，`main.go` 一个字节未改。
- 起真 mygo 主循环 + 真窗口（Hidden），假队伍是我自己的 `httptest` 风格 Python fixture。

结构化结果（`/tmp/crewrel-verify/run_verify.sh`）：

```json
{"state.dump": {"ok": true, "messages": 3, "unread": 1}}
{"refresh":    {"ok": true, "result": {"messages": 3, "refreshing": false, "session": "work", "settled": true}}}
{"session.set":{"ok": true, "result": {"loaded": true, "messages": 3, "session": "work", "settled": true}}}
{"actions.list": 37 个动作}
```

焦点：`front before: Finder`，4 次采样全程 `Finder`，**零次抢焦点**。
进程按精确 PID `kill -TERM` + `wait` 回收，`pgrep` 无残留。

### 2.5 「帧不来」这条已被 GUI owner 实测

`ds-desktop-gui-max` 在无焦点、accessory 策略、`ShowInactive` 的真窗口上实测：全程零帧被系统主动推来，
但 `state.dump` 的 `messages` / `tasks` / `unread` / `unreadReplies` 仍随刷新逐次落地。
这条我只引用、不重复生产。

**它的边界必须一起引用**：像素证据走的是 mygo `Window.CapturePage → raster.Render`（窗口内容内存重绘），
**不是**屏幕截图 —— `screencapture -l <windowid>` 对 accessory + ShowInactive 窗口报
`could not create image from window`。所以「帧不来时界面会不会停」是**结构化落地**钉住的，
像素只是窗口自渲染。两者都不能单独当「屏幕上那一刻」的证据。

### 2.6 真锁屏 / 真 App Nap 仍未实测

按约束不去制造锁屏。`Hidden: true` 与锁屏在「帧不来」这一点上等价，但 App Nap 还会降频定时器，
那个条件下没有证据。这是**已知局限**，不是「已证明没问题」。

---

## 三、三条发现

### F1（中）动作已执行完，调用方却拿到「这条动作不会执行」

**位置**：`desktop/ui.go:539-546`

```go
select {
case err := <-done:
	return err
case <-s.closedCh:      // ← 与 done 同时就绪时，select 随机选
	return errMainClosed
case <-timer.C:
	return fmt.Errorf("主线程 %s 内没有执行完这条动作", timeout)
}
```

**问题**：`done` 是带缓冲的（`make(chan error, 1)`），动作跑完就把 `nil` 塞进去了，从不阻塞。
所以「动作已完成」与「窗口已关闭」可以同时 ready。Go 的 `select` 在多个 case 同时 ready 时
**均匀随机**选一个 —— 选中 `closedCh` 就把「已经跑完、副作用已落地」报成
「窗口已经关掉，这条动作不会执行」。

**证据**（确定性复现，`/tmp/crewrel-probe` 探针，非随机压测）：

```
200 轮：动作确实执行、调用方却拿到错误的轮数 = 200（100%）
★ 错误文案是「窗口已经关掉，这条动作不会执行」，但副作用已落地
```

探针让动作体在返回前卡住，主线程先 `closeMain()`，再放行动作返回 —— 两个 case 必然同时 ready。
用随机时序压 2000 轮时是 0/2000（因为调用方通常先被调度），说明**这是窄窗口，不是常态**，
但一旦撞上，外部脚本拿到的是**方向性错误的结论**：以为没执行，实际执行了。

这与 `TestDebugActionFailsFastAfterTheQueueCloses` 不矛盾：那条例是「先关、后完成」，本发现是
「完成与关闭同时」。

**最小修复**（已在 `/tmp` 副本上验证：200/200 → 0/200，且全量 281 例仍绿）：

```go
case <-s.closedCh:
	// 完成与收口可能同时就绪：select 在多个 case 同时 ready 时随机选，
	// 会把「已经跑完的动作」报成「这条动作不会执行」。done 里已有答案时以它为准。
	select {
	case err := <-done:
		return err
	default:
	}
	return errMainClosed
```

6 行，不加锁、不加字段、不改协议。**我没有改源码**，这条给 lead 决定。

**跳过会怎样**：窗口关闭那一瞬间正在收尾的动作，外部脚本会收到「不会执行」而实际已执行。
脚本若据此重试，就是重复副作用（见 §四）。

---

### F2（中）`bus.listener` 一个无锁写、一个锁内读

**位置**：写 `desktop/debug.go:817`（`bus.listener = listener`，不在 `connMu` 内）；
读 `desktop/debug.go:862`（`listener := bus.listener`，在 `connMu` 内）。

**证据**：`-race` 直接点名，两个 goroutine 分别是 `serveDebug` 与 `closeConnections`：

```
WARNING: DATA RACE
Write at ... by goroutine N:
  desktop.(*DebugBus).serveDebug()      debug.go:817
Previous read at ... by goroutine M:
  desktop.(*DebugBus).closeConnections() debug.go:862
```

生产时序：`main.go` 里 `serveDebug` 与 `OnClosed` 都发生在 `WhenReady` 内，`OnClosed` 只在窗口
真正关闭时才跑，那时 `serveDebug` 早已返回 —— 所以**实际撞上的概率极低**。但这是真 race，
不是误报：`ctx` 被取消时 `serveDebug` 里那个 `<-ctx.Done()` goroutine 会调 `closeConnections()`，
而 `debugCtx` 的 `cancel` 是 `main` 的 `defer`，进程退出时才触发，那时 `serveDebug` 早返回了。
**现有测试没覆盖这条路径**，我的探针是人为构造并发。

**最小修复**：把 `bus.listener = listener` 挪进 `connMu`，或者更彻底 —— 让 `serveDebug`
先 `trackConn` 语义化地登记 listener。前者 3 行：

```go
bus.connMu.Lock()
bus.listener = listener
bus.connMu.Unlock()
```

**跳过会怎样**：`-race` 构建下会报；release 构建下理论上可能读到半写的 interface 值
（Go 的 interface 是两个字，非原子），概率极低但一旦发生就是 panic 而不是错值。

---

### F3（低）收口后再 `serveDebug` 会留下死 socket

**位置**：`desktop/debug.go:817-833`

`closeConnections()` 之后 `connClosed = true`。此时若 `serveDebug` 被调用：
`net.Listen` 照样成功（它不知道 `connClosed`），然后 accept 循环拿到第一条连接、
`trackConn` 返回 false、`conn.Close()` 后 **`return`** —— 但 listener 还开着，没人再 `accept`。

**证据**（探针，两步都实测）：

```
serveDebug 在已收口后仍然 Listen 成功
★ 第二条连接：连上、写入成功、无回话（0 字节）—— 无人 accept 的死 socket
```

**生产可达性**：`main.go` 里 `serveDebug` 在 `WhenReady` 内、`OnClosed` 之前注册，
而 `OnClosed` 只在窗口关闭时触发 —— 所以正常启动路径**不会**出现「先收口、后 serve」。
只有「窗口在 `WhenReady` 到 `serveDebug` 之间就关了」这种极端时序才可能。

**最小修复**（二选一，都 3 行内）：
- `serveDebug` 开头：`if bus.isClosed() { return errMainClosed }`（加一个 3 行的 `isClosed()`）；或
- accept 循环里把 `return` 改成 `continue`（但那样会空转，不好）。

**跳过会怎样**：极端时序下留一个死 socket。它不会被清理，脚本会「连着但没反应」——
正是本轮要消灭的症状。低概率，但症状与修的目标相反，值得记一笔。

---

## 四、超时语义：可接受的 unknown outcome（按证据判）

lead 问的核心是：**主线程卡住时，排队中的 `send` / `takeover` 会不会造成实际阻断或重复副作用？**

### 4.1 结论

**可接受，不阻断。** 我实测了三条时间线，`send` 在所有生产可达路径上都被
`sending` 门挡住，不会重复发。理由如下。

### 4.2 `sending` 门是真的门

`send()`（`ui.go:928-947`）第一件事：

```go
if text == "" || s.sending || s.problem != "" {
	return
}
s.sending = true
```

`sending` 只在后台 goroutine 的 `defer s.postMain(func() { s.sending = false })` 里回落 ——
即**网络往返结束后、并且主线程真的跑到那条 defer 任务**。这给了一个天然的重入屏障。

### 4.3 三条时间线实测

| 时间线 | 结果 | 说明 |
| --- | --- | --- |
| 两次调用都卡在**同一个 pending 批**里，主线程恢复时背靠背跑掉 | 后端收到 **1 次** | 第一条 `send` 还没回来，`sending` 仍是 true，第二条被门挡掉 |
| 主线程一条一条恢复，中间留出网络往返 | 后端收到 **1 次** | 同上，只要第一条没落地，门就关着 |
| ghost 已执行完、`sending` 已回落，调用方才**迟到重试** | 后端收到 **2 次** | 这时门开了，第二次真的发出去 |

第三条是唯一能重复的路径，而且**它不是本改动的缺陷，是「超时≠撤销」这条协议的直接后果**：
脚本拿到 `ok:false` 之后若重发同一句，就是第二句话。

### 4.4 为什么这仍算可接受

1. **协议已明说**：`runOnMain` 的注释、报告 §三.3、`TestTimedOutActionStillRunsWhenTheMainThreadComesBack`
   都把「超时≠撤销」钉死了。脚本拿到超时就该 `state.dump` 读现状，而不是重放。
2. **lead 已定口径**：`settled:false` 之后**用只读 dump 再查**（`state.dump` / `memory.dump` /
   `session.list`），**不重发有副作用的动作**。`ds-settled-max` 已把这条写进 #27 评论。
3. **同一批重放被门挡住**：生产里最常见的「脚本卡住 → 主线程恢复」是同一批背靠背执行，
   实测不会重复。
4. **没有更便宜的修法**：要给队列项加取消，要么加锁改切片结构、要么留空洞，
   两样都比「超时 + 明确字段 + 只读复查」贵。为一个调试口引入取消架构不值当。

### 4.5 明确不声称的东西

- **不声称**「ghost mutation 不会发生」。它会 —— `TestTimedOutActionStillRunsWhenTheMainThreadComesBack`
  就是钉它的。
- **不声称**「所有动作都幂等」。`send` / `memory.save` / `session.set` 都不幂等，靠的是门 + 协议。
- **不声称** 真 relay 3.8s 慢窗口下实测过。`httptest` 假后端覆盖了「秒回」与「挂住」两态，
  3s cap 的截断行为我用 5s 慢 fixture 在真进程上验过（见 §五），但真 relay 的长尾没测。

---

## 五、`settled` 回执（`ds-settled-max` 的改动）

我独立复核，没采信报告：

| 检查 | 结果 |
| --- | --- |
| `go vet ./...` | exit 0 |
| `go test -count=1 ./...` | ok，281 PASS（原 278 例一条未改） |
| `go test -count=1 -race ./...` | ok，0 race |
| `mainThreadSettleCap` 从 `const` 改 `var` | 值仍是 3s；生产路径无赋值点 |
| 有无 `t.Parallel` | **全包零处**，所以 `withSettleCap` 改全局 var 不产生跨例 race |
| 原字段 | 一个没动，只新增 `settled`，向后兼容 |

真进程验证（我自己的 5s 慢 fixture，`session.set` 与 `refresh` 各打一次）：

```
session.set 耗时 3.00s -> {"ok": true, "result": {"loaded": false, "messages": -1, "session": "work", "settled": false}}
refresh     耗时 0.42s -> {"ok": true, "result": {"messages": 1, "refreshing": false, "session": "work", "settled": true}}
```

`session.set` 精确在 3.00s 返回 `settled:false` —— cap 生效、没有假称落定。随后 `refresh`
拿到 1 条，证明前一条不是「没发生」而是「还没落定」。

**`settled:true` 的正确读法**：五个动作（`session.set` / `memory.save` / `refresh` /
`session.reload` / `memory.reload`）的 `settled` 语义完全一致 —— **都只代表「3s 内落定与否」**，
没有任何一个是「一直等到真落定」。`ok:true` + `settled:true` 才等于「派生字段已刷新」；
`ok:true` + `settled:false` 表示「动作成了，但派生字段是这一刻的真值（可能旧值 / `-1`）」。

---

## 六、构建与产物

### 6.1 打包

按仓内约定 `desktop/package.sh`（`CGO_ENABLED=1 go build` + `Info.plist` + ad-hoc `codesign`）：

```
$ cd desktop && bash package.sh "build/release-20261114/Bot Crew.app"
build/release-20261114/Bot Crew.app/Contents/Info.plist: OK
build/release-20261114/Bot Crew.app: replacing existing signature
build/release-20261114/Bot Crew.app
```

- `codesign --verify --strict` → `valid on disk` / `satisfies its Designated Requirement`
- `plutil -lint` → OK
- `file` → `Mach-O 64-bit executable arm64`
- 可复现：同一工作树打两次，`Contents/MacOS/desktop` 的 sha256 完全相同
  （`1d35394c...`），说明构建本身可复现，签名也没有引入随机。

### 6.2 未覆盖用户产物

`desktop/build/Bot Crew.app`（用户可能正在用的那份，14:18 构建）**一个字节未动**：
sha256 仍是 `6baf841b...`。新产物在独立目录 `desktop/build/release-20261114/`，
且 `desktop/build/` 本来就在 `.gitignore` 里。

### 6.3 版本记录

```
HEAD                        b2f305e
冻结源码树 sha256           e0ffd4bd318ce4dfe7b6611cd6946223eb5510b05d04203f6d12ecc8f32a91fe
  （非测试 .go + record_darwin.m + Info.plist + package.sh，按文件名排序后取总 hash）
desktop/debug.go            32c2f179106c9e694935de3df443a98e7c7e5453d366282e152b8f810d91d187
desktop/ui.go               828945e0c0c8f8508cf44b7be463afeeb811b5f85f9dcfd9be59766f122ad136
desktop/main.go             8c5ab118939d30741cae0b39907b2714b905b5c9a20ebf5d2fc3fe719c3b19f0
desktop/mainthread.go       7a4e29cc55213275c03a55455cf92925ba7db999feaca7a236590d54a0d6ef65
debug_settled_test.go       e553c2c1f3aa3acaf152fc1317e85db2c0ddf879fa1ddcf7e32ccc8aef5fe6a1
debug_mainthread_test.go    bb9bb706abab4ff83b70810eee7ea74acb6e8463c177538b3900ba640488cf54
state_pump_test.go          c6a2c1071cc73900312ed54c8ced66f7b1ca323fd516e438ba744ed7b23b7d49
产物                        desktop/build/release-20261114/Bot Crew.app  (18M)
产物二进制 sha256           1d35394c6b46c001b723675a458eb5d3bdd0aadbeafd73cff551be88ea012a29
```

### 6.4 产物含新代码的证据

直接 grep 二进制里的 UTF-8 字符串（`LC_ALL=C grep -a`）：

| 字符串 | 命中 |
| --- | --- |
| `窗口已经关掉` | 1 |
| `这条动作不会执行` | 1 |
| `没有执行完这条动作` | 1 |
| `errMainClosed` | 1 |
| `settled` / `batchGID` | 1 / 1 |

`go version -m` 的依赖与构建参数与独立重建逐行一致。

### 6.5 真实启动覆盖差异（必须写清）

我验证用的**不是**这个 release 产物，而是同一个工作树 + `/tmp` overlay 重建的二进制。
差异只有两处，都在 `main.go` 里、只在 `/tmp` 副本中存在：

1. `Hidden: true` + `window.ShowInactive()` —— 窗口真实创建、真实绘制，但不显示。
2. `zz_verify.go`：`CREW_VERIFY_ACCESSORY=1` 时 `SetActivationPolicy(Accessory)` —— 不抢焦点。

**release 产物是 Regular 策略、正常显示窗口、启动时按 mygo 默认 `activateIgnoringOtherApps` 到前台。**
那是正常用户启动行为，不为测试改生产默认。所以：release 产物的「窗口可见 + 抢焦点」这条，
本轮**没有**在我的验证里覆盖；它走的是 mygo 既有路径，本轮没碰。

---

## 七、测试证据（冻结树）

```
$ cd desktop && go vet ./...
vet exit=0

$ go test -count=1 ./...
ok  github.com/Dangerous828/dsh-bot-crew/desktop  2.520s
（281 PASS / 0 FAIL）

$ go test -count=1 -race ./...
ok  github.com/Dangerous828/dsh-bot-crew/desktop  7.000s
（0 DATA RACE，连跑 3 次稳定）
```

原 278 例一条未改；`state_pump_test.go` 的 8 例、`debug_mainthread_test.go` 的 9 例全绿。

---

## 八、局限（没覆盖的）

1. **真锁屏 / 真 App Nap 未实测。** 本机未锁屏，按约束不制造。`Hidden` 与锁屏在「帧不来」上等价，
   但 App Nap 降频定时器这一条没有证据。
2. **真 relay 3.8s 慢窗口未测。** 3s cap 的截断我用 5s 慢 fixture 验过，但那是本机 `http.server`，
   不是真 relay 的长尾分布。
3. **F1 / F2 / F3 的修复我没实施**，只在 `/tmp` 副本上验证了 F1 的最小补丁（200/200 → 0/200，
   全量 281 例仍绿）。源码保持冻结，等 lead 决定。
4. **并发只压到 8 连接**（`ds-debug-thread-max` 的用例）与我自己 4 连接 × 12 轮。
   几十上百连接没有证据；`bus.mu` 是全局串行锁，高并发下会排队，这是设计取舍。
5. **`goroutineID()` 依赖 `runtime.Stack` 首行格式。** 我实测了 200 goroutine / panic-recover / GC
   三种情况下都稳定返回非 0；但这是 runtime 的稳定输出、不是导出 API。若未来格式变了，
   `goroutineID()` 返回 0 → `isMainThread()` 恒 false → 主线程内重入会走「投递 + 等自己」。
   我实测了这条退化路径：**会超时（100ms 内返回错误），任务残留在队列里，主线程恢复后照常执行**。
   所以退化**不是**「仍然正确」，是「退化成超时 + ghost 执行」——
   与 §四的 unknown outcome 同一类后果，但比正常路径差一档。这是**已知风险**，不是「不会发生」。

---

## 九、给 lead 的处置建议

1. **#27 可以关**，产物与证据齐（本文件 §二 / §六 / §七）。
2. **F1 建议下一轮修**（6 行，`ui.go:542` 加内层 `select`）。它是真实的方向性错误结论，
   且修法极便宜。不修的话，在文档里明写「窗口关闭瞬间完成的动作可能被报成未执行」。
3. **F2 建议顺手修**（3 行，`bus.listener` 写进锁）。`-race` 会报，早晚有人踩。
4. **F3 记录即可**，生产时序不可达；要修就是 `serveDebug` 开头加一句已收口判断。
5. **`goroutineID` 退化路径写进文档**：现在只在报告里，脚本作者看不到。
