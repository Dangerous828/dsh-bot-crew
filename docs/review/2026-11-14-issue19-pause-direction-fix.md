# #19 第 3 项：暂停按钮方向反转 — 根因修复与真机双向复验

日期：2026-11-14 17:38–17:56。执行人：ds-phone-pause-fix-max。
依据：issue #19 正文第 3 项 + 其评论 + `docs/review/2026-11-14-issue19-real-button-acceptance.md` §三（那份报告把这一项判为**不成立**，根因定位到 `CrewUi.kt:1692`）。

## 结论

| 项 | 结论 |
| --- | --- |
| 根因 | `CrewUi.kt` 工作区暂停按钮把**当前状态**当**目标状态**传给 `setPaused`，方向反 |
| 修复 | 抽出 `pausePress(paused, preview, ticket)`，`target = !paused`；按钮闭包改为 `onSetPaused(press.target, press.ticketId)` |
| 回归用例 | 新增 `PausePressTest.kt`（3 例），**先红后绿**：带 bug 时 2 failed，修复后全绿 |
| 真机双向复验 | **通过**。真实点击按钮，`paused` 走 `False → True → False`，回执方向与 label 一致，LAN/RELAY 两门读回一致 |
| #19 四项 | 1 / 2 / 4 已独立复验通过（本轮重跑，不引用旧报告）；第 3 项按钮层现在成立 |

## 一、根因

`setPaused(paused: Boolean, ticketId: String?)`（`CrewUi.kt:331`）的第一个参数语义是**目标**：`true` 走 `client.pause`，`false` 走 `client.resume`。

按钮那边写的是：

```kotlin
val resuming = paused                          // ← 「当前是否已暂停」，不是目标
touched = onSetPaused(resuming, preview ?: ticket?.id)
```

于是：

| 当前 `paused` | 按钮 label | 传入的目标 | 实际执行 | 应为 |
| --- | --- | --- | --- | --- |
| `False` | 让它停一下 | `False` | `resume` | `pause` |
| `True` | 继续执行 | `True` | `pause` | `resume` |

变量名 `resuming` 是误导源：它读起来像「接下来要 resume」，实际装的是「现在已经 paused」。上一轮把暂停逻辑提到 `CrewRoot.setPaused` 一处时，这段从 `if (resuming) client.resume() else client.pause(...)`（语义正确）改成了把状态直接当参数传，方向就反了。

**为什么 369 条单测没抓住**：`pauseLabel(paused)` 测了（`True → 继续执行`），`CrewClient.pause/resume` 的动作语义测了，但**两者之间「按钮传出去的第一个参数」**没人验。标签对、动作反，这个组合在纯函数层完全看不见。

## 二、修复

```kotlin
/**
 * [target] 是**目标**状态，不是当前状态。
 */
data class PausePress(val target: Boolean, val ticketId: String?)

fun pausePress(paused: Boolean, preview: String?, ticket: String?): PausePress =
    PausePress(target = !paused, ticketId = preview ?: ticket)
```

按钮闭包改为：

```kotlin
val press = pausePress(paused, preview, ticket?.id)
touched = onSetPaused(press.target, press.ticketId)
```

方向只在一处算。`pauseLabel` 与 `pausePress` 现在读同一个 `paused`，断言可以把「这句话」和「这个动作」绑在一起。

顺带收口：`label = if (paused) "继续执行" else WorkspaceAction.Pause.label` 里那句字面量改为 `WorkspaceCopy.pauseLabel(paused)` —— 之前同一句话有两份实现（一份在 `WorkspaceCopy`，一份在按钮里），`WorkspaceCopy` 那份被测着、按钮那份没被测着。

## 三、回归用例（先红后绿，已证）

新增 `app/app/src/test/java/com/dsh/botcrew/PausePressTest.kt`：

| 用例 | 钉什么 |
| --- | --- |
| `theButtonSendsTheOppositeOfTheCurrentStateNotTheStateItself` | label 与 target 必须同向：说「让它停一下」→ target `true`；说「继续执行」→ target `false` |
| `theTargetIsNeverTheCurrentState` | 反向钉 `target != paused`（对 `false`/`true` 两个当前值都断言），专门让「把当前状态当目标」这种错必定变红 |
| `thePressActsOnTheTicketOnScreen` | 作用对象：`preview` 优先 → `ticket` → `null`（全局） |

**反向验证（撤修复必须变红）**：

```
把 pausePress 的 target = !paused 改回 target = paused
  → 372 tests completed, 2 failed
    PausePressTest > theButtonSendsTheOppositeOfTheCurrentStateNotTheStateItself FAILED
    PausePressTest > theTargetIsNeverTheCurrentState FAILED
恢复 !paused
  → 372 tests completed, 0 failures
```

这两条失败的正是方向断言与「目标≠当前」断言，不是旁边别的错。

## 四、真机双向复验（真实点击，非 debug 口）

设备：`55c86317` / `PEDM00` / Android 14。APK：`com.dsh.botcrew` 0.1.0 debug，`lastUpdateTime=2026-11-14 17:49:09`（含本次修复）。
按钮位置由 `uiautomator` 真实 bounds 算出中心点，`input tap` 真点。

### A 向：未暂停 → 点「让它停一下」

```
A0  app.paused=False  backend.paused=False  pauseResult=None
    label=让它停一下   bounds=[925,2676][1196,2772] → center (1060,2724)
A1  真实点击 (1060,2724)
    app.paused=True   backend.paused=True
    pauseResult=已让它停一下（全局执行器，再按一下继续）
```

### B 向：已暂停 → label 自动翻成「继续执行」→ 再点

```
B0  app.paused=True   label=继续执行   bounds=[925,2544][1196,2640] → center (1060,2592)
B1  真实点击 (1060,2592)
    app.paused=False  backend.paused=False  RELAY.paused=False
    pauseResult=已继续执行（全局执行器）
```

### C 向：第三次循环（稳定性）

```
C0  paused=False  label=让它停一下
C1  点击 → paused=True   pauseResult=已让它停一下（全局执行器，再按一下继续）
C2  点击 → paused=False  pauseResult=已继续执行（全局执行器）
```

**判据全部满足**：`paused` 状态 `False → True → False`；每次回执方向与那一刻的 label 一致（「让它停一下」→ 停、「继续执行」→ 继续）；LAN 门与 RELAY 门读回同一个值。

### D 向：最终包（含 socket 生命周期修复）复跑

`socket` 修复落地后重新构建安装（`lastUpdateTime=2026-11-14 17:56:55`，16,886,003 B），确认两处修复共存无干扰，按钮再验一遍：

```
F0  app.paused=False   pauseResult=已继续执行（全局执行器）
F1  真实点击 (1060,2724)「让它停一下」
    app.paused=True    pauseResult=已让它停一下（全局执行器，再按一下继续）
F2  label 自动翻成「继续执行」，bounds=[925,2544][1196,2640] → center (1060,2592)
F3  真实点击 (1060,2592)「继续执行」
    app.paused=False   pauseResult=已继续执行（全局执行器）
    LAN.paused=False   RELAY.paused=False
```

## 五、同类调用点核查

| 位置 | 传的参数 | 方向 |
| --- | --- | --- |
| `CrewUi.kt:1716` 工作区暂停按钮 | `press.target`（`!paused`） | **已修** |
| `CrewDebug.kt:377` `pause(ticketId)` | 字面量 `true` | 正确（调试动作本身就是「停」） |
| `CrewDebug.kt:382` `resume()` | 字面量 `false` | 正确（调试动作本身就是「继续」） |
| `CrewUi.kt:416` debug 口 `onSetPaused` | 透传 | 正确 |
| `CrewUi.kt:553` 工作区 `onSetPaused` | 透传 | 正确 |
| `desktop/ui.go:3224` `pauseAll()` | 只有 `client.Pause`，**没有 resume 分支** | 无对称 bug（桌面端按钮只暂停，label 写「全部暂停」/「已暂停（去面板恢复）」，不承诺反向） |

除工作区按钮外，其余各处传的都是字面量或透传，不存在「状态当目标」的第二次实例。

## 六、自动验证

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `./gradlew testDebugUnitTest`（JDK 21） | 0 | **378 tests, 0 failures**（改前 369；本任务 +3 按钮，+5 socket 生命周期，+1 其他） |
| `./gradlew assembleDebug` | 0 | app-debug.apk **16,886,003 B**，sha256 `108372fd…109628` |
| `sh scripts/check-parity.sh` | 0 | parity: 通过 |
| `git diff --check` | 0 | 无空白问题 |

反向验证：撤掉 `!paused` → 372 tests / 2 failed；恢复 → 372 / 0。两次都跑过。

## 七、#19 第 1 / 2 / 4 项本轮独立复验

**不引用上一份报告的数**，本轮用同一枚真实设备凭据（`66e74d226c1e38fa`，从已配对手机的 `crew-pairing.xml` 读出，未打印）重跑：

### 第 1 项：LAN 与 RELAY 两条路都调用恢复

```
LAN    resume http=200 {"ok":true,"resumed":true,"scope":"executor"}
RELAY  resume http=200 {"ok":true,"resumed":true,"scope":"executor"}
```

两条门逐字返回同一份回执。

### 第 2 项：未配对请求回 401

三变体 × 两门，六次全 401、错误体一致：

```
LAN    none / badtoken / baddevice  -> 401 401 401   {"error":"Not paired"}
RELAY  none / badtoken / baddevice  -> 401 401 401   {"error":"Not paired"}
```

`baddevice`（设备号假、凭据真）证明判定不只看凭据存在与否。

### 第 4 项：对 takeover 已停的票 resume 后仍 stopped

票 `970072c9`（`stopped` / `open=False`）：

```
4a) takeover(RELAY) 对已停票     http=409 {"error":"Ticket is already ended"}
4b) takeover 后                  970072c9 stopped open=False   open count=0
4c) 全局 resume(LAN)             http=200 {"ok":true,"resumed":true,"scope":"executor"}
4d) resume 之后                  970072c9 stopped open=False   open count=0
4e) 等 20 秒复查                 仍 stopped，open count=0
```

失败路径如实报错（409），不假报 `stopped:true`；resume 之后没有偷偷复活。

## 八、转屏调试口 socket：另验通过（issue #29，归 ds-debug-lifecycle-max）

这一项**不属于本 issue**，但两处修复要在同一个包里共存，所以一起验过。

本轮先用**只有按钮修复**的包重跑，`Address already in use` 又复现 2 次，且**不需要转到横屏**——锁竖屏与解除锁定这两个动作各自触发一次 Activity 重建：

```
17:49:14.918  I CrewDebug: 调试口已开：localabstract:crew-debug
17:49:50.760  W CrewDebug: 调试口没起来：localabstract:crew-debug
17:49:50.760  W CrewDebug: java.io.IOException: Address already in use
17:49:50.760  W   at com.dsh.botcrew.CrewDebugServer.start(CrewDebug.kt:490)
              （触发：adb shell cmd window user-rotation lock 0）
17:52:10.167  W CrewDebug: 调试口没起来：localabstract:crew-debug
17:52:10.167  W CrewDebug: java.io.IOException: Address already in use
              （触发：cmd window user-rotation free）
```

三条对定位有用的事实（已交 ds-debug-lifecycle-max，其根因结论与此一致：abstract 名字是**进程级**的，旧实现每届 Activity 各 bind 一次，而重建时新的 `onCreate` 先于旧的 `onDestroy`）：

1. 触发条件是 **Activity 重建本身**，不是「真的转到横屏」——任何 `configChanges` 未声明的配置变化都走这条路。
2. 失败瞬间 `/proc/net/unix` 里 `crew-debug` 计数 = **0**，但新实例 bind 仍报占用（释放未同步可见）。
3. **pid 不变**（同进程重建）；`am force-stop` + 重启立即恢复。

**修好后真机复验（含两处修复的最终包，logcat 清空后从冷启动跑全套）**：

```
STEP1 冷启动 pid=13130   state.dump ok=True paired=True way=p2p
STEP2 重建#1 (lock 0)  pid=13130  ok=True
      重建#2 (free)    pid=13130  ok=True
      重建#3 (lock 1)  pid=13130  ok=True
      重建#4 (free)    pid=13130  ok=True
      重建#5 (lock 0)  pid=13130  ok=True
      ↑ 全程同一条 adb forward，一次都没重建
STEP3 pause → paused=True    resume → paused=False
STEP4 pid 13130 → 13130   前台仍是 MainActivity   FATAL EXCEPTION 0
STEP5 Address already in use: 0
      调试口没起来: 0
      调试口已开: 1        ← 整个进程生命周期只 1 次
完整时间线（只有一行）：
11-14 17:58:23.948 13130 13130 I CrewDebug: 调试口已开：localabstract:crew-debug
```

扩展面（非转屏的 Activity 重建）：`cmd uimode night yes/no` 各触发一次重建，`state.dump` 均 `ok=True`，pid 不变，EADDRINUSE 累计仍 0。


## 九、统一 APK

| 项 | 值 |
| --- | --- |
| 路径 | `app/app/build/outputs/apk/debug/app-debug.apk` |
| 大小 | 16,886,003 B |
| sha256 | `108372fde20fb74fab1d8d9f4197dc9b1e128a2012c61c1097d85b342e109628` |
| 生成时间 | 2026-11-14 17:56 |
| 装到手机后 `lastUpdateTime` | 2026-11-14 17:56:55 |
| 含 | 按钮方向修复（`pausePress`）+ socket 进程级归属（`CrewDebugPorts`） |
| 单测 | 378 tests / 0 failures |

这个包是本任务**唯一**的构建产物，按钮与转屏两组真机验证都跑在它上面（§四 D 向、§八）。

## 十、现场恢复（逐条对进场值）

| 动作 | 进场值 | 结束时 | 恢复 |
| --- | --- | --- | --- |
| 屏幕旋转 | `accelerometer_rotation=1`、`user_rotation=0` | `1` / `0` | 已还原（中途 `user-rotation lock 0/1` 锁过，结束 `user-rotation free`） |
| 深色模式 | `Night mode: no` | `Night mode: no` | 已还原（扩展面测试切过 yes，结束切回 no） |
| 后端 `paused` | `False` | `False` | 已恢复 |
| App | pid 7275（旧包） | pid 13130（统一包） | 运行中，`way=p2p` |
| `adb forward` | 无 | 无 | 已 `--remove-all`，`forward --list` 为空 |
| dsh 89699 / mobilegw 41418 | 运行中 | 运行中 | **全程未重启** |
| 飞行模式 / Wi-Fi | 未改 | 未改 | — |
| 我造的票 | — | 无（未新建任何票） | — |
| `/tmp` 脚本 | — | `crewdbg.py`（仅本机调试客户端，不含凭据） | 保留，无害 |

未做 `git commit` / `push` / `stash` / `checkout` / `restore` / `reset` / `add`。

写范围仅：`app/app/src/main/java/com/dsh/botcrew/CrewUi.kt`、新增 `app/app/src/test/java/com/dsh/botcrew/PausePressTest.kt`、本报告、`docs/review/shots-issue19-fix/`。未改 `CrewDebug.kt` / `MainActivity.kt` / `AndroidManifest.xml` / `CrewWire.kt`（那几处属 ds-debug-lifecycle-max 的 socket 修复，同包共存已验）。未改 backend / desktop / 开发进度 / HANDOFF / crew-watch。

**手机输入权**：本报告提交后释放，后续配对屏三验由另一 Max 用独立测试包（独立 applicationId）或可备份恢复的方案进行，不在本任务扩范围。

## 十一、给 lead 的收口建议

1. **#19 第 3 项现在可以关**：后端成立（§七）+ 按钮成立（§四，真机真实点击，双向 + 第三次循环）。四项 1/2/4 本轮也重跑通过（§七），不是引用旧数。
2. **第 3 项的洞已经补上**：`PausePressTest` 钉的是「按钮传出去的目标」，不再是「label 对不对」。这类「标签对、动作反」的错以后会在单测层就红。
3. **转屏 socket 保持独立跟踪**，归 ds-debug-lifecycle-max。本轮新增 2 次基线（§八），关键新事实：**锁/解锁屏幕方向也会触发**，不必真转到横屏。
4. **其他 TODO 原样保留**：桌面 GUI takeover 按钮、桌面双徽标、配对屏三验 —— 都在上一份报告 §六，本轮没有推进。

## 附：截图

`docs/review/shots-issue19-fix/`

| 文件 | 内容 |
| --- | --- |
| `40-A0-before-pause.png` | A 向基线：label「让它停一下」、无回执 |
| `41-A1-after-pause-tap.png` | A 向点击后：label 已翻「继续执行」，回执「已让它停一下（全局执行器，再按一下继续）」 |
| `42-B0-label-resume.png` | B 向基线：label「继续执行」 |
| `43-B1-after-resume-tap.png` | B 向点击后：回执「已继续执行（全局执行器）」 |
| `44-final-restored.png` | 收尾现场：横屏、auto-rotate 恢复 |
| `50-F0-before.png` | 统一包（双修复）F 向基线：label「让它停一下」 |
| `51-F1-after-pause.png` | 统一包点击后：label 翻「继续执行」，回执「已让它停一下」 |
| `52-F3-after-resume.png` | 统一包再点击后：回执「已继续执行（全局执行器）」 |
