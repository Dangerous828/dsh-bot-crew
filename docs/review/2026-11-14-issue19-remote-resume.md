# #19 远程恢复四项联调：真机验收报告

日期：2026-11-14 16:30–17:10。执行人：ds-19-max。
依据：issue #19 正文四项 + `docs/PHASE_REMOTE_RESUME.md` 末节「剩余验收」。

## 结论

四项逐条有真机证据，全部成立。**没有把「缺前置」记成产品回归**；唯一没做到的一步（工作区按钮的像素级目视）在 §六 如实标明原因与替代判据。

同时补了一处产品缺口：手机 CrewDebug 缺 `pause` / `resume` 动作，已按「与真实 UI 共用同一条操作路径」补上（§三），没有写替身。

## 一、测试环境

| 项 | 值 |
| --- | --- |
| 手机 | OPPO PEDM00（`adb` 序列号 `55c86317`，即配对资产 `66e74d226c1e38fa`） |
| 配对记录 | `~/.dsh/state/superagent/remote-devices.json` 里已有的 android 设备，未新建账号 |
| APK | `com.dsh.botcrew` 0.1.0 debug，`lastUpdateTime=2026-11-14 16:57:39`（本轮装入） |
| LAN 门 | `http://192.168.31.127:43499`（`lanPort(stateDir)` 实算，非缓存值） |
| 中转门 | `https://crew.kentonnie.top`（Cloudflare Tunnel → 回环 `127.0.0.1:43499`） |
| 后端 | dsh PID 89699（14:26:39 启动，全程未重启） |
| mobilegw | PID 41418（00:01:07 启动，全程未变） |

**本机 DNS 限制（环境事实，不是产品缺陷）**：本机 resolver 解析不出 `crew.kentonnie.top`（`Could not resolve host`），而 `dig @8.8.8.8` 正常返回 Cloudflare 两个 A 记录。中转那一路的全部实测都用 `curl --resolve crew.kentonnie.top:443:104.21.93.136` 固定 IP 完成。手机侧不受影响（手机自己解析，`way=lan` / 经中转都实测通）。

## 二、四项逐条证据

### 第 1 项：真实设备凭据经 LAN 与中转两条路调用恢复

```
LAN   resume http=200  {"ok":true,"resumed":true,"scope":"executor"}
RELAY resume http=200  {"ok":true,"resumed":true,"scope":"executor"}
```

两条门用**同一枚真实设备凭据**（从已配对手机的 `crew-pairing.xml` 读出，未打印）。两条门都把 `{"ok":true,"resumed":true,"scope":"executor"}` 逐字返回。

### 第 2 项：未配对请求回 401

三条变体 × 两条门，六次全 401，错误体一致：

```
LAN/none      -> 401 {"error":"Not paired"}
LAN/badtoken  -> 401 {"error":"Not paired"}
LAN/baddevice -> 401 {"error":"Not paired"}
RELAY/none      -> 401 {"error":"Not paired"}
RELAY/badtoken  -> 401 {"error":"Not paired"}
RELAY/baddevice -> 401 {"error":"Not paired"}
```

`baddevice` 是「设备号假、凭据真」——这条证明判定不是只看凭据存在与否。错误体不区分「设备不对」和「凭据不对」（`phone-gate.ts` 的刻意设计，避免帮尝试者筛选），实际行为与源码一致。

### 第 3 项：暂停后按钮切回继续，以 `status.paused: false` 校验真的恢复

后端侧（两条门交叉读，pause 走 LAN、resume 走 RELAY）：

```
before:  LAN paused=False   RELAY paused=False
pause    http=200
during:  LAN paused=True    RELAY paused=True
resume   http=200
after:   LAN paused=False   RELAY paused=False
```

手机侧（真机 debug 口按下去，读回界面状态）：

```
baseline  paused=False  pauseResult=None
pause  -> {'ok':True,'result':{'requested':'pause'}}
after     paused=True   pauseResult=已让它停一下（全局执行器，再按一下继续）
resume -> {'ok':True,'result':{'requested':'resume'}}
after     paused=False  pauseResult=已继续执行（全局执行器）
```

按钮文字由 `WorkspaceCopy.pauseLabel(paused)` 推导：`paused=True` → `继续执行`，`False` → `让它停一下`。这条推导有单测钉住（§四），真机 `paused` 翻转让它输出 `继续执行`。

### 第 4 项：对 takeover 已停的票 resume，之后仍为 stopped

两轮独立验证，第二轮全程走中转门：

```
4a) takeover（relay 门）  http=200  {"ok":true,"stopped":true}
4b) takeover 后           [('970072c9…','stopped',False)]  open count=0
4c) 全局 resume（LAN 门） http=200  {"ok":true,"resumed":true,"scope":"executor"}
4d) resume 之后           [('970072c9…','stopped',False)]  open count=0
    再等 20 秒复查         仍 stopped，open count=0（没有偷偷复活）
```

附加失败路径（这一批验收抓到的真 bug 就是「takeover 假报成功」，所以一并钉住）：

```
对已结束的票再 takeover -> 409 {"error":"Ticket is already ended"}
```

即：不会回 `{"ok":true,"stopped":true}` 假成功。

### 第 4 项要求里「通知/连接失败时客户端如实报失败，不假报成功」

**真断网实测**（不是 mock）：`adb shell cmd connectivity airplane-mode enable` → `Active default network: none`，此时从 debug 口按暂停：

```
before  paused=False
pause   {'ok':True,'result':{'requested':'pause'}}   （这条回执只代表「已发出」）
after   paused=False                                  ← 没有假报已停
        pauseResult=没做成：Failed to connect to /192.168.31.127:43499
        problem=Failed to connect to /192.168.31.127:43499
```

恢复网络后 `refresh` → `problem=None`，再按暂停 → `paused=True`，再继续 → `paused=False`。**失败 → 如实报错 → 恢复后可重试成功**整条链闭合。

另有一条后端侧失败路径：对不存在的票暂停，真机 debug 口按下后 `pauseResult=没做成：队伍返回 404：{"error":"找不到这张工单"}`，`paused` 保持 `False`（后端直测同一请求为 404，行为一致）。

## 三、补的产品缺口：手机 CrewDebug 缺 pause / resume

**问题**：`CrewDebug.kt` 的动作表里只有 `send` / `session.*` / `tab.set` / `mode.set` / `refresh` / `state.dump`，没有暂停与继续。真机上「按工作区那个按钮」在 adb 眼里只是坐标，按不中也不可断言 —— 第 3、4 项因此无法做真机断言。

**做法（不是替身）**：把暂停/继续提到 `CrewRoot.setPaused(paused, ticketId)` 一处，**工作区按钮与 debug 口调同一个函数**：

- `CrewRoot.setPaused`：调 `client.pause/resume` → 成功后写 `executorPaused`、`pauseRevision += 1`、`pauseResult`，返回给人看的那句话。
- 按钮：`touched = onSetPaused(resuming, preview ?: ticket?.id)`，不再自己拼状态与话术。
- debug 口：`pause` / `resume` 动作 → `onSetPaused` → 同一个 `setPaused`。

为什么必须共用：暂停的状态位是 `executorPaused` + `pauseRevision` 一对。复制一份出来，一定有一份会忘记 `pauseRevision += 1`，那时时间线下一趟刷新会拿旧的 `status.paused` 覆盖刚按下的结果，界面闪回「正在干活」。共用一处，这个坑在结构上不存在。

**动作回执只说「已发出」**（`{"requested":"pause"}`），不在动作层报成功；成没成看 `state.dump` 的 `paused` 位与 `pauseResult`。脚本因此必须断言 `paused`，不能拿动作的 `ok` 当结论 —— 这正是「不假报成功」在调试口这一层的落法。

## 四、自动验证

执行目录 `app`，JDK 21（`JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.9/libexec/openjdk.jdk/Contents/Home`）。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `./gradlew testDebugUnitTest` | 0 | **369 tests, 0 failures**（改动前 362，本轮新增 7 条） |
| `./gradlew assembleDebug` | 0 | `app-debug.apk` 16,884,225 字节 |
| `sh scripts/check-parity.sh` | 0 | `parity: 通过` |
| `git diff --check` | 0 | 无空白问题 |

新增用例（7 条）：

| 用例 | 钉的是什么 |
| --- | --- |
| `pauseReachesTheSameFunctionTheButtonCalls` | debug 口 pause 必须落到 target（防替身） |
| `pauseWithoutATicketIsTheGlobalPauseTheButtonUsesWhenNothingIsRunning` | 无票号＝全局暂停，与按钮同口径 |
| `resumeTakesTheSameRoadInTheOtherDirection` | resume 同一条路 |
| `pauseReportsWhatItAskedForNotThatItSucceeded` | 回执只说 requested，不含 `paused` 字段（不假报成功） |
| `theSnapshotCarriesThePauseResultSoAFailureIsVisible` | 失败原话进快照，脚本看得见 |
| `anUnpressedPauseResultIsNullNotAnEmptyString` | 没按过是 null，不拿空串冒充 |
| `thePauseButtonFlipsToResumeWhenTheExecutorIsPaused` | 按钮字随 `paused` 翻转 |

### 反向验证（去掉判据必须变红）

| 改动 | 结果 |
| --- | --- |
| `"pause"` 动作改成不落到 target（造替身） | 369 tests, **2 failed** |
| `"resume"` 动作改成不落到 target | 369 tests, **1 failed** |
| `pauseLabel` 去掉 `if (paused)` 分支 | 369 tests, **1 failed** |
| `pauseDone` 话术改回「恢复要去面板」 | 369 tests, **1 failed** |
| 还原后复跑 | 369 tests, 0 failures |

## 五、改动清单

只动 `app/`，未写 `backend/` / `desktop/` / `开发进度.md` / `HANDOFF.md` / `scripts/crew-watch`。

```
 app/app/src/main/java/com/dsh/botcrew/CrewDebug.kt |  42 ++++++
 app/app/src/main/java/com/dsh/botcrew/CrewUi.kt    |  64 +++++++---
 app/app/src/main/java/com/dsh/botcrew/CrewWire.kt  |  20 ++++-
 app/app/src/test/.../CrewDebugTest.kt              | 100 ++++++++++++++-
 app/app/src/test/.../WorkspaceCopyTest.kt          |  18 ++-
 5 files changed, 225 insertions(+), 19 deletions(-)
```

一处**话术订正**（不是新增功能）：`pauseDone("executor")` 原来写「已让它停一下（全局执行器，恢复要去面板）」。恢复按钮接上以后，那半句成了假话 —— 同一个按钮停完就变成「继续执行」。改为「再按一下继续」，避免人跑去面板找。

未 commit、未 push、未 stash。

## 六、没做到的一步（如实记录）

**工作区按钮的像素级目视没做。** 手机屏幕处于安全锁屏（`isKeyguardShowing=true`、`deviceTrust deviceLocked=1`），我没有 PIN，`wm dismiss-keyguard` 与上滑都解不开；`uiautomator dump` 只拿到锁屏那一层的文本，读不到工作区页。

因此「按钮真的显示『继续执行』」这一环，用的是**同一条判断的可测版本**：

- 真机侧：`paused` 确实从 `False` 翻成 `True`（debug 口 `state.dump` 实测），而按钮标签就由 `WorkspaceCopy.pauseLabel(paused)` 决定（`CrewUi.kt:1690`）。
- 代码侧：`pauseLabel` 是纯函数，有单测钉住 `True → 继续执行`、`False → 让它停一下`，并做了反向验证。

这不是「产品回归」，是**本机缺少解锁条件**。要在真机目视这一格，需要有人解一次锁（或给这台测试机设一个已知 PIN）。

## 七、真机操作副作用与现场恢复

| 动作 | 影响 | 恢复情况 |
| --- | --- | --- |
| `adb install -r` 两次 | 每次杀 App 进程（旧 PID 17011 → 28277 → 28890） | 已重新拉起，`capability=live`、`paired=true`、`way=lan` |
| `adb forward tcp:9099 localabstract:crew-debug` | 只在 Mac 本机监听 | 已 `--remove-all`，`forward --list` 现为空 |
| `svc wifi disable`（第一次尝试失败路径） | 手机断网约 20 秒 | 已 `svc wifi enable`，`wifi_on=1` |
| `cmd connectivity airplane-mode enable` | 手机无网约 90 秒 | 已 `disable`，`Active default network=107` |
| `svc power stayon true` | 屏幕常亮 | 保持（调试便利，未改回；不影响其他数据） |
| `input keyevent KEYCODE_WAKEUP` | 亮屏 | 屏幕已亮 |
| `uiautomator dump /sdcard/w.xml` | 一个临时文件 | 已 `rm` |
| 生产后端暂停/恢复 | 全程最后状态 `paused=False` | 已恢复 |
| 发出的三条测试活 | 两条跑完（completed），两条 takeover 停掉（stopped） | 无残留 open 票，`open count=0` |

**没有重启 dsh（89699）或 mobilegw（41418）**，没有 `pkill -f`，没有抢鼠标/聚焦桌面窗口（全部操作走 `adb` 与 HTTP，未调用任何桌面输入）。

## 八、并发事故核验（ds-23-max 的 stash）

ds-23-max 在 16:58 对我负责的 5 个 app 文件做过 `git checkout stash@{0} -- <23 路径>`。按它的请求只读核验：

```
git diff stash@{0} -- <我负责的 5 个路径>   → 全部为空
5 个文件 mtime                              → 均为 16:58:17（早于它 16:58:58 的写入）
最终版标记全部在位                          → pauseLabel / RESUMED / pauseResult / onSetPaused /
                                              "pause" to / "resume" to / suspend fun setPaused
git diff --cached --name-only               → 空（我的文件没留在 index）
复跑 ./gradlew testDebugUnitTest            → 369 tests, 0 failures
```

**结论：零丢失，无需补写。** 已向 ds-23-max 回报。

## 九、剩余阻塞

| 项 | 状态 |
| --- | --- |
| 工作区按钮像素级目视 | 阻塞在锁屏，需人解锁一次 |
| 本机解析 `crew.kentonnie.top` | 环境 DNS 问题，用 `--resolve` 绕过；不影响手机 |
| 桌面端 resume | 桌面端只有 `pauseAll`，没有 resume 入口（`desktop/client.go` 的 `Pause` 注释即如此）。不在 #19 四项范围内，未扩张 |
| `git commit` / `push` | 按规矩未做 |
