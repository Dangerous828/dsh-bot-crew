# 桌面收口期三条生命周期缺陷的修复与产物（release-20261114-r2）

写范围：`desktop/ui.go`、`desktop/debug.go`、新增 `desktop/debug_lifecycle_test.go`、
本文件、`desktop/build/release-20261114-r2/`（`.gitignore` 已忽略 `desktop/build/`）。

未改产品其他逻辑；未碰 `开发进度.md` / `HANDOFF*.md` / `crew-watch` / 其他源码；
无任何 git 写操作（无 add / commit / push / stash / checkout / restore / reset）；
未重启 dsh / mobilegw、未 `pkill -f`、未发桌面键鼠、未聚焦任何窗口。
`desktop/build/Bot Crew.app`（用户可能正在用的那份）与 `build/release-20261114/`（r1）一个字节未动。

---

## 一、结论

三条缺陷是**同一个根**：**「已经收口」与「动作/监听器已经就绪」是两个独立信号，
而代码让「谁先被调度」决定结论**。于是同一份状态会给出方向相反的答复。

| # | 缺陷 | 修法 | 判据 |
| --- | --- | --- | --- |
| F1 | 动作已执行完，调用方拿到「这条动作不会执行」/「没有执行完」 | `runOnMain` 的两个非完成分支先非阻塞读一遍 `done` | `TestRunOnMainPrefersFinishedResultOverClosed` / `...OverTimeout` |
| F2 | `bus.listener` 无锁写、锁内读 | 写挪进 `connMu`（`admitListener`），加 `isClosed()` | `TestServeDebugAndCloseConnectionsRaceSafely`（`-race`） |
| F3 | 收口后再 `serveDebug` 留死 socket | 启动前判已收口；登记失败就自己关掉并报 `errMainClosed` | `TestServeDebugAfterCloseLeavesNoSocket` / `...IsIdempotent` |

没有加新 goroutine、没有加取消架构、没有改协议字段、没有改动作表。
`go vet` exit 0；全量 **286 PASS / 0 FAIL**（原 281 例一条未改，新增 5 例）；
`-race` 连跑三次 0 race。

---

## 二、F1：完成与收口/超时同时就绪，结果必须优先

### 2.1 位置与机制

`desktop/ui.go` 的 `runOnMain`：

```go
select {
case err := <-done:
	return err
case <-s.closedCh:      // 与 done 同时 ready 时随机选
	return errMainClosed
case <-timer.C:         // 同上
	return fmt.Errorf("主线程 %s 内没有执行完这条动作", timeout)
}
```

`done` 是 `make(chan error, 1)`，动作跑完就把 `nil` 塞进去、从不阻塞。所以
「动作已完成」与「窗口已关闭 / 计时器到期」可以**同时 ready**；Go 的 `select` 在多 case
同时 ready 时均匀随机选一个。选中非完成分支，就把「已经跑完、副作用已落地」报成
「这条动作不会执行」——**方向相反的结论**：外部脚本据此重试就是重复副作用。

### 2.2 修法（`desktop/ui.go`）

```go
case <-s.closedCh:
	return finishedOr(done, errMainClosed)
case <-timer.C:
	return finishedOr(done, fmt.Errorf("主线程 %s 内没有执行完这条动作", timeout))
```

```go
func finishedOr(done <-chan error, otherwise error) error {
	select {
	case err := <-done:
		return err
	default:
		return otherwise
	}
}
```

**为什么这是根治而不是补丁**：`done` 带缓冲、完成即写，本来就承载着「已经跑完了」这个
既成事实；缺的只是「读它一次」。两个非完成分支共用同一段判定，以后再加分支也不会漏。
不加锁、不加字段、不改队列结构。

### 2.3 确定性复现（不是随机压测）

两条用例都让两个信号**必然同时 ready**，然后跑固定 200 轮：

- `TestRunOnMainPrefersFinishedResultOverClosed`：`post` 回调里先跑完动作（`done` 就绪）、
  再 `closeMain()`（`closedCh` 关闭），然后才返回 —— `runOnMain` 进 `select` 时两 case
  都 ready，每轮各有一次机会选错。
- `TestRunOnMainPrefersFinishedResultOverTimeout`：超时给 `time.Nanosecond`，动作在同步
  `post` 里立刻跑完，`done` 与 `timer.C` 都 ready。

修前/修后实测（同一份测试文件，只改源码）：

```
修后： --- PASS: TestRunOnMainPrefersFinishedResultOverClosed (0.00s)
       --- PASS: TestRunOnMainPrefersFinishedResultOverTimeout (0.00s)
修前： debug_lifecycle_test.go:50: 第 2 轮：动作已执行完，调用方却拿到「不会执行」
       --- FAIL: TestRunOnMainPrefersFinishedResultOverClosed
       debug_lifecycle_test.go:73: 第 0 轮：动作已执行完，却返回 主线程 1ns 内没有执行完这条动作
       --- FAIL: TestRunOnMainPrefersFinishedResultOverTimeout
```

### 2.4 与既有用例不冲突

`TestTimedOutActionStillRunsWhenTheMainThreadComesBack`（超时 ≠ 撤销）与
`TestDebugActionFailsFastAfterTheQueueCloses`（先关、后完成）语义未变：前者是
「调用方先不等了、动作后来才跑」，本修只影响「动作**已经**跑完」的那一格。

---

## 三、F2：listener 的写与读必须在同一把锁里

### 3.1 位置与机制

- 写：`serveDebug` 里 `bus.listener = listener`，**不在** `connMu` 内。
- 读：`closeConnections` 里 `listener := bus.listener`，**在** `connMu` 内。

`-race` 直接点名（`serveDebug` 写 / `closeConnections` 读）。除数据竞争外还有一个语义后果：
`closeConnections` 可能在「`Listen` 成功」与「登记 listener」之间跑过，读到 `nil`，
那个 listener 再没人关 —— 收口之后留下一个还能连上的 socket。

### 3.2 修法（`desktop/debug.go`）

```go
func (bus *DebugBus) isClosed() bool {
	bus.connMu.Lock()
	defer bus.connMu.Unlock()
	return bus.connClosed
}

func (bus *DebugBus) admitListener(listener net.Listener) bool {
	bus.connMu.Lock()
	defer bus.connMu.Unlock()
	if bus.connClosed {
		return false
	}
	bus.listener = listener
	return true
}
```

`serveDebug` 用 `admitListener` 取代裸赋值，登记失败就自己 `Close` + `Remove` 并返回
`errMainClosed`。**写与读从此在同一把锁里**，且「登记」与「收口判定」成了同一次原子动作 ——
不会再有「Listen 成功但没人关」的窗口。

### 3.3 判据

`TestServeDebugAndCloseConnectionsRaceSafely`：50 轮并发 `serveDebug` / `closeConnections`
（同一 `start` 闸门同时放行），每轮收口后断言 socket **连不上**。两个失败模式一起钉：
`-race` 报竞争，或 listener 泄漏。

```
修前（-race）： WARNING: DATA RACE
                debug.go:824 (serveDebug 写)  /  debug.go:888 (closeConnections 读)
                --- FAIL: TestServeDebugAndCloseConnectionsRaceSafely
修后：          --- PASS（-race 干净）
```

---

## 四、F3：收口之后不许再 bind

### 4.1 位置与机制

`closeConnections()` 之后 `connClosed = true`。此时若 `serveDebug` 被调用：
`net.Listen` 照样成功（它不知道 `connClosed`），accept 循环拿到第一条连接、
`trackConn` 返回 false、`conn.Close()` 后 **`return`** —— 但 listener 还开着，再没人 `accept`。
结果是一个**连得上、写得进、永远没回话的死 socket**，正是本轮要消灭的症状。

### 4.2 修法

`serveDebug` 开头：已收口直接 `return errMainClosed`，**不 bind、不落 socket 文件**。
配合 §三 的 `admitListener`（锁内登记 + 收口判定同一次），两条路径都关掉了：

- 收口在先 → 启动前就拒绝；
- 收口插在「Listen 成功」与「登记」之间 → 登记失败，自己关掉并报错。

accept 循环里 `trackConn` 拒绝后的 `return` 保留：那时 listener 必然已被
`closeConnections` 关掉（登记是原子的），`return` 不会留下活 listener。

### 4.3 判据

```
修前： debug_lifecycle_test.go:139: 已经收口，调试口却开起来了
       --- FAIL: TestServeDebugAfterCloseLeavesNoSocket
       debug_lifecycle_test.go:166: 第 0 次：应报 errMainClosed，实际 <nil>
       --- FAIL: TestServeDebugAfterCloseIsIdempotent
修后： 两条都 PASS
```

两条用例都断言三件事：返回 `errMainClosed`、socket 文件不存在、`Dial` 连不上；
幂等用例再跑三次，确认反复启动不会「复活」一个 socket。

---

## 五、测试证据

```
$ cd desktop && go vet ./...
vet exit=0

$ go test -count=1 ./...
ok  github.com/Dangerous828/dsh-bot-crew/desktop  2.103s
（286 PASS / 0 FAIL —— 原 281 例一条未改，新增 5 例）

$ go test -count=1 -race ./...
ok  github.com/Dangerous828/dsh-bot-crew/desktop  6.995s   （连跑三次稳定，0 DATA RACE）
```

新增用例连跑五次全绿（`TestRunOnMainPrefers*` + `TestServeDebug*`）。

### 5.1 逐条撤修复都变红

三条缺陷分别单独撤回（其余保持修复），对应用例各自变红，说明**每条测试都能单独抓住它自己那条 bug**：

| 撤回 | 变红的用例 |
| --- | --- |
| `finishedOr` 换回直接 `return errMainClosed` / `fmt.Errorf` | `TestRunOnMainPrefersFinishedResultOverClosed`（第 1–2 轮）+ `...OverTimeout`（第 0 轮） |
| `admitListener` 换回 `bus.listener = listener` | `TestServeDebugAndCloseConnectionsRaceSafely`（`-race`：`debug.go:824` 写 / `debug.go:888` 读） |
| 去掉 `isClosed()` 前置判定 | `TestServeDebugAfterCloseLeavesNoSocket` + `...IsIdempotent` |

### 5.2 一处踩到的坑（记下来，免得下次再踩）

`t.TempDir()` 在 macOS 上的路径就超过 unix socket 的 `sun_path` 104 字节上限，
`net.Listen` 会报 `bind: invalid argument`。第一版 F3 用例因此**假红**（看起来是缺陷，
其实是路径太长）。改到 `os.TempDir()` 下的短路径后才是真红。这个坑不影响产品，
但会影响任何用 `t.TempDir()` 建 unix socket 的测试。

---

## 六、产物：`desktop/build/release-20261114-r2/`

按仓内脚本 `desktop/package.sh`（`CGO_ENABLED=1 go build` + `Info.plist` + ad-hoc `codesign`）：

```
$ cd desktop && bash package.sh "build/release-20261114-r2/Bot Crew.app"
build/release-20261114-r2/Bot Crew.app/Contents/Info.plist: OK
build/release-20261114-r2/Bot Crew.app: replacing existing signature
build/release-20261114-r2/Bot Crew.app
```

### 6.1 核验

| 检查 | 结果 |
| --- | --- |
| `codesign --verify --strict` | `valid on disk` / `satisfies its Designated Requirement` |
| `codesign -dv` | `Identifier=top.kentonnie.dsh-bot-crew.desktop`，`flags=0x2(adhoc)`，`Mach-O thin (arm64)` |
| `plutil -lint` | OK |
| `file` | `Mach-O 64-bit executable arm64` |
| 解压 zip 后重验签名 | `valid on disk` |
| 可复现 | 独立重打一次，`Contents/MacOS/desktop` sha256 完全相同（`f132d7ff...`） |

### 6.2 版本记录

```
HEAD                        b2f305e
冻结源码树 sha256           a13fc956c793d6cc0df122319f5bf53ec187b9fabc59874bc0f4b8df84fdb475
  （非测试 .go + record_darwin.m + Info.plist + package.sh，按文件名排序后取总 hash）
desktop/ui.go               f1094c5936e54d7fe25b8bbe168843bf94e59eca930c131c294aadd8eada7106
desktop/debug.go            c1862a9b7ae480feb3e1cc5954f5ff1c53975a2525dc11e4ae3e55fb77e79d8d
desktop/main.go             8c5ab118939d30741cae0b39907b2714b905b5c9a20ebf5d2fc3fe719c3b19f0
desktop/mainthread.go       7a4e29cc55213275c03a55455cf92925ba7db999feaca7a236590d54a0d6ef65
debug_lifecycle_test.go     5eb065ebea6869bcd05a9b417de3fb567443f0eae1a90a8828f1a1a34e9e4d9d
state_pump_test.go          c6a2c1071cc73900312ed54c8ced66f7b1ca323fd516e438ba744ed7b23b7d49
debug_mainthread_test.go    bb9bb706abab4ff83b70810eee7ea74acb6e8463c177538b3900ba640488cf54
debug_settled_test.go       e553c2c1f3aa3acaf152fc1317e85db2c0ddf879fa1ddcf7e32ccc8aef5fe6a1

产物                        desktop/build/release-20261114-r2/Bot Crew.app  (18M)
产物二进制 sha256           f132d7fff2792f3dce92225bd923680d46ee692188ebfa3d36a6f548c3d54bc1
zip                         Bot-Crew-desktop-release-20261114-r2.zip  (10.4 MB)
zip sha256                  6532659ddae7bdae0218c6bb51576f1a2be0f0076390b4fb118452c7652f564c
```

### 6.3 未覆盖既有产物

| 路径 | 二进制 sha256 | 说明 |
| --- | --- | --- |
| `desktop/build/Bot Crew.app` | `6baf841b...` | 用户可能正在用的那份，一个字节未动 |
| `desktop/build/release-20261114/`（r1） | `1d35394c...` | 保留不覆盖，zip `6e2f9a4c...` 也未动 |

### 6.4 产物含本轮修复的证据

直接 `LC_ALL=C grep -a` 二进制：

| 字符串 | 命中 |
| --- | --- |
| `窗口已经关掉` | 1 |
| `这条动作不会执行` | 1 |
| `没有执行完这条动作` | 1 |
| `settled` | 1 |
| `batchGID` | 1 |

`go version -m` → `go1.27.3`，依赖 `mygo v0.8.3` / `purego v0.11.1`，与独立重建一致。

---

## 七、真实启动（无焦点，`/tmp` overlay）

**验证用的不是这个 release 产物**，而是同一份工作树的 `/tmp` 副本重建的二进制 ——
release 产物是 Regular 策略、启动时按 mygo 默认 `activateIgnoringOtherApps` 到前台，
那是正常用户启动行为，不为测试改生产默认，也就不用 `open -g` 去激活它。

副本差异只有两处，都只在 `/tmp` 存在，仓库工作树里没有：

1. `main.go` 加 `Hidden: true` + `window.ShowInactive()`；
2. 新增 `zz_verify.go`：`CREW_VERIFY_ACCESSORY=1` 时 `SetActivationPolicy(Accessory)`。

启动命令（不经 LaunchServices，直接起二进制）：

```
CREW_DEBUG=1 CREW_DEBUG_SOCK=/tmp/r2verify/crew-r2.sock CREW_VERIFY_ACCESSORY=1 \
DSH_GW=http://127.0.0.1:18788 DSH_TOKEN=t DSH_DEVICE=crew-desktop /tmp/r2verify/desktop
```

假队伍是本机 `http.server`（`/api/mobile/sessions` 给 `session_api:1` + 两段会话，
`/api/mobile/timeline` 回 3 条消息并按 `session_id` 回显）。

结构化结果：

```json
state.dump  {"ok":true,"result":{"messages":3,"session":"work","sessionCapability":"live","sessionSwitchable":true,"sessions":["main","work"],"refreshing":false}}
refresh     {"ok":true,"result":{"messages":3,"refreshing":false,"session":"work","settled":true}}
session.set {"ok":true,"result":{"loaded":true,"messages":3,"session":"work","settled":true}}
state.dump2 {"ok":true,"result":{"messages":3,"session":"work","refreshing":false}}
```

焦点：`front before: Finder`，之后 4 次采样**全程 `Finder`** —— 零次抢焦点。
进程按精确 PID `kill -TERM` + `wait` 回收，`pgrep` 无残留，socket 文件已被清掉
（`leftover:` 空 / `socket left: no`）。

启动日志只有两行，没有「调试口开不起来」：

```
19:06:52 发现队伍 ：连 http://127.0.0.1:18788（设备号 crew-desktop）
19:06:52 调试口已开：unix /tmp/r2verify/crew-r2.sock（CREW_DEBUG=1）
```

---

## 八、局限（没覆盖的）

1. **release 产物本身的窗口可见 + 启动抢焦点这条没验**（见 §七）。它走 mygo 既有路径，本轮没碰。
2. **真锁屏 / 真 App Nap 仍未实测**，与上一轮一致：`Hidden` 与锁屏在「帧不来」上等价，
   但 App Nap 降频定时器这条没有证据。
3. **F1 的修复不改变「超时 ≠ 撤销」**：动作在超时之后才跑完的路径照旧是 unknown outcome，
   外部脚本仍应 `state.dump` 读现状而不是重放有副作用的动作。
4. **并发只压到 8 连接**（既有用例）与 50 轮 serve/close（本轮）；几十上百连接没有证据。
5. **`goroutineID()` 依赖 `runtime.Stack` 首行格式**：若未来格式变化，`isMainThread()` 恒 false
   → 退化成「超时 + ghost 执行」。这是已知风险，不是「不会发生」。

---

## 九、跳过的事（明写）

- 没给 `runOnMain` 加取消机制（审计 §四已论证：要改切片结构或留空洞，比「超时 + 只读复查」贵）。
- 没动 `stateSnapshot` 的 gofmt 对齐（既有差异，与本轮无关，改了会扩大 diff）。
- 没重打 r1，也没覆盖 `desktop/build/Bot Crew.app`。
