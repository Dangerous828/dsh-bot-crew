# Activity 重建后调试口永久失效：socket 归属按 Activity 而不是按进程

对应 issue [#29](https://github.com/Dangerous828/dsh-bot-crew/issues/29)。
写范围：`app/app/src/main/java/com/dsh/botcrew/CrewDebug.kt`、`app/app/src/main/java/com/dsh/botcrew/MainActivity.kt`、
新增 `app/app/src/test/java/com/dsh/botcrew/CrewDebugPortsTest.kt`、本报告。
未改 `CrewUi.kt` / `CrewWire.kt` / `CrewDebugTest.kt` / `WorkspaceCopyTest.kt` / `AndroidManifest.xml` / 后端 / desktop / `开发进度.md` / `HANDOFF.md` / `scripts/crew-watch/`。

## 一、现象（真机 5 次复现）

debug 构建下，手机端调试口（abstract namespace `crew-debug`）在 **Activity 重建**后永久失效，直到杀进程重启 App：

```
17:49:14.918 I CrewDebug: 调试口已开：localabstract:crew-debug
17:49:50.760 W CrewDebug: 调试口没起来：localabstract:crew-debug
17:49:50.760 W CrewDebug: java.io.IOException: Address already in use
17:49:50.760 W CrewDebug:   at android.net.LocalSocketImpl.bindLocal(Native Method)
17:49:50.760 W CrewDebug:   at android.net.LocalServerSocket.<init>(LocalServerSocket.java:49)
17:49:50.760 W CrewDebug:   at com.dsh.botcrew.CrewDebugServer.start(CrewDebug.kt:490)
17:49:50.760 W CrewDebug:   at com.dsh.botcrew.MainActivity.onCreate(MainActivity.kt:52)
```

之后 `adb forward tcp:9099 localabstract:crew-debug` 仍能建，但连上去读到**空响应**（`raw: b''`），动作面全死。

| 触发（真机 PEDM00 / 55c86317） | 结果 |
| --- | --- |
| `cmd window user-rotation lock 0`（锁竖屏） | Activity 重建 → EADDRINUSE |
| `cmd window user-rotation free`（解锁） | Activity 重建 → EADDRINUSE |
| 真转到横屏（`ROTATION_0 → ROTATION_270`） | Activity 重建 → EADDRINUSE |
| `am force-stop` + 重启 App | 立即恢复 |

复现记录：17:27 / 17:35（`docs/review/2026-11-14-issue19-real-button-acceptance.md` §五）、17:49 / 17:52 ×2（本轮）。

**范围比「转屏」大**：`AndroidManifest.xml` 的 `.MainActivity` 没有声明 `configChanges`，任何配置变化
（字体大小、深色模式、语言、锁竖屏）都走 `handleRelaunchActivity`，都会打死调试口。

## 二、根因

> **socket 的归属被绑在 Activity 实例上，而 abstract namespace 里的名字是进程级的。**

四条证据把它钉住：

1. **失败栈落在 `onCreate`**：`CrewDebugServer.start(CrewDebug.kt:490)` ← `MainActivity.onCreate(MainActivity.kt:52)`。
   旧实现每届 Activity 各 `new CrewDebugServer(...)` 并各 `bind()` 一次。
2. **`pid` 不变**（10486 → 10486）：同进程内重建，不是新进程抢名字。
3. **`/proc/net/unix` 里 `crew-debug` 计数 = 0，但 bind 仍报占用**：abstract namespace 的释放对
   同进程后续 bind **不是同步可见的**。
4. **`am force-stop` + 重启立即恢复**：只有「进程内重建」这条路坏 —— 进程没了，名字跟着内核一起释放。

完整时序：

```
旧 Activity 活着，listener 绑着 @crew-debug
  ↓ 配置变化 → handleRelaunchActivity（新的先起，旧的还没死）
新 Activity.onCreate → new CrewDebugServer().start() → bind @crew-debug → EADDRINUSE（旧 listener 还活着）
  ↓ 新实例 start() 返回 false，debugServer 保持 null
旧 Activity.onDestroy → debugServer?.stop() → 旧 listener 关掉
  ↓ 进程内从此没有任何 listener；内核里那个名字的释放还没同步可见
adb forward 能建 → 连上 → 无 listener 接 → 读空响应 → 直到杀进程
```

所以这不是「忘了关」（`onDestroy` 确实调了 `stop()`），也不是「关得不够快」，更不是「重试能救」。

## 三、排除的修法

| 修法 | 为什么不采用 |
| --- | --- |
| 声明 `configChanges="orientation\|screenSize\|..."` | 只是把重建藏起来。用户改字体 / 深色模式 / 语言照样重建（真机已验证锁竖屏就触发），且会让 Compose 界面拿不到新的 configuration。属于「用配置屏蔽生命周期」，不是修根因 |
| `stop()` 后对 EADDRINUSE 做退避重试 | 重建窗口内口一直是死的，验收脚本照样读到空响应；而且把「时序不可靠」变成抖动重试，属于「反复重试吞错」 |
| 换 socket 名字（加实例序号 / 随机后缀） | `adb forward` 侧、验收脚本、文档全部要跟着变，且违背「一个进程一个调试口」的既定口径（与桌面端 `ctx.Done()` 那一路也不再对应） |
| `onDestroy` 里加 `isFinishing` 判断再 stop | 只能挡住「旧实例关新口」这一半；新实例 bind 撞旧 listener 那一半仍然发生，EADDRINUSE 照旧 |

## 四、改法：让 bind 只发生一次

socket 属于**进程**，Activity 只是「谁挂在台前」。

### `CrewDebug.kt`

新增两个类型：

```kotlin
interface CrewDebugPort {
    fun open(): Boolean                  // 起监听
    fun bind(target: CrewDebugTarget)    // 换台前的挂载点，socket 不动
    fun unbind()                         // 摘挂载点，socket 照旧开着
    fun close()                          // 真正关，只由进程收尾调
}

class CrewDebugPorts(private val port: CrewDebugPort) {
    fun attach(who: Any, target: CrewDebugTarget): Boolean  // 第一次才 open，之后只 bind
    fun detach(who: Any)                                    // 只摘挂载点，且只认自己那一届
    companion object { val process: CrewDebugPorts by lazy { CrewDebugPorts(CrewDebugServer()) } }
}
```

`attach` 的关键一行是 `if (!isOpen) isOpen = port.open()`：**socket 一旦开着，后面每届 Activity 都不再碰 bind**，
EADDRINUSE 在结构上不可能出现。

`detach` 用令牌判身份（`if (owner !== who) return`）：转屏时旧的 `onDestroy` 晚于新的 `onCreate`，
它来摘口时令牌已经换人，于是什么都不做 —— 不会把新实例刚接上的口摘掉。这正是原报告里
「老实例 stop 误杀新实例」那一半。

`CrewDebugServer`：
- `start()/stop()` → `open()/close()`，实现 `CrewDebugPort`；
- 挂载点从构造参数改成 `@Volatile var debug: CrewDebug?`，`bind()` 只换这一份；
- `dispatch()` 开头取一次快照（`val active = debug ?: return DebugReply.fail("界面还没挂上：这一届 Activity 已退场")`）：
  `close()` 之后或两届之间如实报错，不 NPE、不假成功。
- `close()` 清 `listener` / `debug` / `acceptThread`；accept 线程因 listener 关闭抛错退出（原有行为）。
- **协议、动作表、主线程 `Handler` + `UI_WAIT_MS` 时序一字未改** —— 与 pause/resume 那条链路无关。

### `MainActivity.kt`

```kotlin
private var debugBridge: DebugBridge? = null
private val debugToken = Any()   // 这一届的令牌

// onCreate
if (bridge != null) CrewDebugPorts.process.attach(debugToken, bridge)

// onDestroy
if (debugBridge != null) CrewDebugPorts.process.detach(debugToken)
debugBridge?.screen = null
debugBridge = null
```

`AndroidManifest.xml` **未改**（不加 `configChanges`）：转屏该重建就重建，调试口跟着活。

## 五、测试

新增 `CrewDebugPortsTest.kt`（6 例，纯 JVM，不依赖 Android 运行时）。假 port 复刻了内核规矩：
同一个名字在**已经绑着**的时候再 bind 就失败 —— 所以「旧实现」在测试里会真的报 EADDRINUSE 语义，而不是靠断言自证。

| 用例 | 钉住什么 |
| --- | --- |
| `aSecondActivityTakesOverWithoutOpeningTheSocketAgain` | 转屏只换人，socket 只开一次（旧实现读到 `opens=2`） |
| `aRotationNeverHitsAddressAlreadyInUse` | 新的 attach 早于旧的 detach 的**真实顺序**下，新实例必须能接上，且全程不 close |
| `aDeadActivitysDetachLeavesTheNewOwnerAlone` | 老实例的 detach 不许摘新实例的口，也不许摘挂载点 |
| `theCurrentOwnerDetachingUnbindsButKeepsTheSocketOpen` | 现任退场只摘挂载点，socket 照旧开着；没人挂时 `bound=null`（不拿旧 target 冒充） |
| `aFailedOpenIsReportedAndRetriedByTheNextActivity` | 开失败如实 false；下一届再试一次（一次，不循环重试） |
| `attachAndDetachAreIdempotentForTheSameActivity` | 同一届重复 attach / detach 不多开一次、也不把口弄丢（重建期回调重入、收尾重入） |

### 变异验证（证明测试咬得住根因）

把 `attach`/`detach` 换回旧语义（每届 `open()` + detach 时 `close()`）：

```
6 tests completed, 4 failed
  aSecondActivityTakesOverWithoutOpeningTheSocketAgain -> AssertionError
  theCurrentOwnerDetachingUnbindsButKeepsTheSocketOpen  -> AssertionError
  aRotationNeverHitsAddressAlreadyInUse                -> AssertionError: 转屏重建时新实例必须能接上
  aDeadActivitysDetachLeavesTheNewOwnerAlone           -> AssertionError
```

恢复后 6 例全绿。

### 全量

```
./gradlew :app:testDebugUnitTest --offline
total 378  failures 0
```

（含 `ds-phone-pause-fix-max` 的 `PausePressTest` 3 例；本改动未碰它。）

`./gradlew :app:assembleDebug` 成功，`app/build/outputs/apk/debug/app-debug.apk`（16.9 MB），
`classes3.dex` 内含 `CrewDebugPorts`（确认新类真的进了包）。

## 六、真机复验（通过）

真机操作由唯一手机输入 owner `ds-phone-pause-fix-max` 执行（本 agent 不 adb 安装、不旋转）。
装的正是本报告 §五 编译出的包：`16,886,003 B` / `2026-11-14 17:56`，设备侧 `lastUpdateTime=2026-11-14 17:56:55`。

### 结果

```
=== 验证开始 17:58:20（logcat -c 清空后从冷启动跑全套）===
STEP1 冷启动 pid=13130
  state.dump: ok=True paired=True way=p2p

STEP2 重建#1 (lock 0)  pid=13130  state.dump: ok=True paired=True
STEP2 重建#2 (free)    pid=13130  state.dump: ok=True paired=True
STEP2 重建#3 (lock 1)  pid=13130  state.dump: ok=True paired=True
STEP2 重建#4 (free)    pid=13130  state.dump: ok=True paired=True
STEP2 重建#5 (lock 0)  pid=13130  state.dump: ok=True paired=True
      ↑ 全程同一条 adb forward（tcp:18099 localabstract:crew-debug），一次都没重建

STEP3 动作面 pause:  paused=True  | 已让它停一下（全局执行器，再按一下继续）
STEP3 动作面 resume: paused=False | 已继续执行（全局执行器）

STEP4 pid 结束=13130  起始=13130        ← 不变
STEP4 前台: mCurrentFocus=Window{bb7128d u0 com.dsh.botcrew/com.dsh.botcrew.MainActivity}
STEP4 FATAL EXCEPTION 次数: 0            ← 不闪退
```

### 最硬的那条判据（bind 只发生一次）

```
Address already in use 次数: 0
调试口没起来 次数: 0
调试口已开 次数: 1        ← 整个进程生命周期只 1 次

--- 完整 CrewDebug 时间线 ---
11-14 17:58:23.948 13130 13130 I CrewDebug: 调试口已开：localabstract:crew-debug
```

**5 次 Activity 重建，时间线只有一行。** 旧实现同样条件下会打 5 条 `调试口没起来` + 5 条
`Address already in use`（17:49 / 17:52 各抓到一次，见 §一）。这是本次修复的直接反证：新实现在
重建期间**根本不碰 bind**，所以内核里那条 EADDRINUSE 连出现的机会都没有。

### 一次完整的 `state.dump`（截断到调试口协议那一层）

```json
{"ok": true, "result": {"paired": true, "crew": "0kvcc5t", "device": "66e74d226c1e38fa",
 "way": "p2p", "tunnelMillis": 12, "p2pNote": "", "route": "隧道已连接（12ms）",
 "lanVerdict": "ok", "lanHost": "192.168.31.127", "lanSubnet": "", "lanFailures": 0,
 "session": "work", "screenReady": true,
 "screen": {"session": "work", "capability": "live", "switchable": true, "defaultSession": "main",
  "sessions": ["main", "work"], "cached": ["main", "work"], "tab": "crew", "mode": "chat",
  "paused": false, "pauseResult": null, "problem": null, "draft": "", "sending": false,
  "entries": ["http://127.0.0.1:43349", "http://192.168.31.127:43499", "https://crew.kentonnie.top"],
  "e...
```

重建之后 `screenReady: true` 且 `screen` 里字段齐全 —— 说明挂载点也跟着换了届
（`attach` 里那句 `port.bind(target)`），不是「socket 活着但指向已死的旧界面」。

### 扩展面：深色模式（Activity 重建的另一条触发路径）

`cmd uimode night yes` → `state.dump ok=True`；`night no` → `ok=True`，pid 仍 `12422`，
累计 `Address already in use` 仍为 **0**。

这一轮在主序列之前、且**之后清过 logcat 重跑主序列**，所以它不与上面那份时间线合并计数 ——
单独作为「修的是 Activity 重建这一类，不只转屏」的证据。

### 逐条对账

| 判据 | 结果 |
| --- | --- |
| 1 冷启动 `state.dump` ok | ✅ |
| 2 单次重建后**同一条 forward** 仍 ok | ✅（旧实现这一下就死） |
| 3 连续 3 次重建每次 ok | ✅（实际做了 5 次） |
| 4 重建 5 次后 `pause`/`resume` 可用 | ✅ `paused` 双向翻转、回执原话对得上 |
| 5 logcat 无 EADDRINUSE，`调试口已开` 只 1 次 | ✅ 0 / 0 / 1 |
| 6 pid 不变、不闪退、前台仍是本 App | ✅ `13130 → 13130`，FATAL 0 次 |
| 7 扩展面（深色模式） | ✅ |

issue [#29](https://github.com/Dangerous828/dsh-bot-crew/issues/29) 据此关闭。

## 七、未做与边界

| 项 | 状态 |
| --- | --- |
| 真机安装 / 旋转 / logcat 采集 | 由 `ds-phone-pause-fix-max` 执行（唯一手机输入 owner），本 agent 未碰；证据见 §六 |
| `configChanges` 屏蔽重建 | 明确不做（见 §三） |
| socket 名字带实例后缀 | 明确不做（见 §三） |
| `CrewUi.kt` / `CrewWire.kt` / pause 测试 | 未改（`ds-phone-pause-fix-max` 独占） |
| 桌面端同类根因（Go `bus.handleConn` 后台 goroutine 直接推进状态） | 不在本范围，`ds-debug-thread-max` 负责，已确认两条路径独立 |

未做 `git stash` / `checkout` / `restore` / `reset` / `add` / `commit` / `push`；未重启 dsh / mobilegw；未抢 mac 焦点。
