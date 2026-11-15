# #19 真实按钮实屏验收（补齐 §六 那一格）

日期：2026-11-14 17:10–17:40。执行人：ds-phone-ui-max。
依据：issue #19 正文四项 + `docs/PHASE_REMOTE_RESUME.md` 末节「剩余验收」+ `docs/review/2026-11-14-issue19-remote-resume.md` §六 唯一未做项。

## 结论（先说三件不绕的事）

| 项 | 结论 |
| --- | --- |
| 上一份报告 §六「工作区按钮像素级目视没做」 | **已补齐。** 解锁后 `uiautomator` 拿到真实 bounds，真实点击，截图在案 |
| 第 3 项「暂停后按钮切回继续，以 `status.paused: false` 校验真的恢复」 | **不成立。真实按钮方向反了。** 见 §三，双向复现 |
| 第 1 / 2 / 4 项 | **复验通过**，两门 × 各变体逐条重跑，证据在 §二 |
| 手机 takeover 按钮（`TODO(desktop, …)` 之外的手机侧同类欠账） | **首次 GUI 按钮级验过**：真票 `working → stopped`，worker 日志停增 |

第 3 项因此**不能按正文关**。这是本轮抓到的第二个真 bug，性质与 `cf8dd59`（takeover 假报成功）同类：**按钮说的和它做的是两件事**。

## 一、环境与设备身份前置

| 项 | 值 |
| --- | --- |
| 手机 | `adb` 序列号 `55c86317`，`product/model=PEDM00`，Android 14（与交接 §1 指定的测试机逐字一致） |
| 配对资产 | `66e74d226c1e38fa`（`~/.dsh/state/superagent/remote-devices.json` 里既有记录，未新建账号） |
| APK | `com.dsh.botcrew` 0.1.0 debug，`lastUpdateTime=2026-11-14 16:57:39`；与工作区源码同批（`CrewUi.kt` mtime 16:58:17），dex 内含 `setPaused` 符号，**不是旧包** |
| 后端 | dsh PID **89699**（全程未重启，验收结束时 ELAPSED 03:09:52） |
| mobilegw | PID **41418**（全程未重启，ELAPSED 17:35:24） |
| 两门 | LAN `http://192.168.31.127:43499` / RELAY `https://crew.kentonnie.top` |

**设备身份前置检查**（先做，避免对错误设备操作）：`adb devices -l` 只列出一台，`product:PEDM00 model:PEDM00`，序列号 `55c86317`；与交接文档记录逐字比对一致后才开始操作。

**解锁**：进场时 `isKeyguardShowing=true`、`mDreamingLockscreen=true`。用交接 §1 记录的该测试机 PIN，经 bouncer 数字键盘 `input keyevent` 逐位输入后 `isKeyguardShowing=false`。**PIN 只用于解锁手机，未写入本报告、未进任何截图或日志**（`grep -rl` 全 `docs/review/` 无命中）。全程未发送任何桌面输入事件、未聚焦任何窗口。

**不枚举个人数据**：只读 `com.dsh.botcrew` 自己的 `shared_prefs/crew-pairing.xml`（配对凭据，产品自身的存储），未读通讯录、短信、相册或其它 App 数据。

## 二、第 1 / 2 / 4 项复验（全部通过）

### 第 1 项：真实设备凭据经 LAN 与中转两条路调用恢复

```
LAN    resume {"ok":true,"resumed":true,"scope":"executor"} http=200
RELAY  resume {"ok":true,"resumed":true,"scope":"executor"} http=200
```

同一枚真实设备凭据（从已配对手机的 `crew-pairing.xml` 读出，未打印）。两条门逐字返回同一份回执。

### 第 2 项：未配对请求回 401

三条变体 × 两条门，六次全 401，错误体一致：

```
LAN    none / badtoken / baddevice  -> 401 401 401   {"error":"Not paired"}
RELAY  none / badtoken / baddevice  -> 401 401 401   {"error":"Not paired"}
```

`baddevice`（设备号假、凭据真）证明判定不是只看凭据存在与否。

### 第 3 项后端侧：两门交叉读，pause 走 LAN、resume 走 RELAY

```
before:  LAN=False  RELAY=False
pause    {"ok":true,"scope":"executor"} http=200
during:  LAN=True   RELAY=True
resume   {"ok":true,"resumed":true,"scope":"executor"} http=200
after:   LAN=False  RELAY=False
```

后端这一层是干净的。问题只在手机按钮那一层，见 §三。

### 第 4 项：对 takeover 已停的票 resume，之后仍为 stopped

```
4a) takeover(RELAY) 对已停票 409 {"error":"Ticket is already ended"}
4b) takeover 后      970072c9 stopped open=False   open count=0
4c) 全局 resume(LAN) {"ok":true,"resumed":true,"scope":"executor"} http=200
4d) resume 之后      970072c9 stopped open=False   open count=0
    再等 20 秒复查    仍 stopped，open count=0
```

### 第 4 项要求里「连接失败时客户端如实报失败，不假报成功」

真断网（`cmd connectivity airplane-mode enable` → `Active default network: none`），从真机 debug 口按暂停：

```
pause 回执   {"ok":true,"result":{"requested":"pause"}}   ← 只代表「已发出」
after       paused=False                                ← 没有假报已停
            pauseResult=没做成：Connection reset
            problem=timeout
```

恢复网络（`airplane-mode disable` → `Active default network: 108`）→ `refresh` → `problem=None`、`way=p2p`、`tunnel=10ms` → 再按暂停 `paused=True` → 继续 `paused=False`。**失败 → 如实报错 → 恢复后可重试成功**整链闭合。

## 三、第 3 项：真实按钮方向反了（**本条不成立**）

### 现象

`paused=False`（界面写「让它停一下」）时真实点击那个按钮，`pauseResult` 被写成 **「已继续执行（全局执行器）」**，而 `paused` 保持 `False` —— 按钮执行的是 **resume**。

### 双向复现

**A 向**（`paused=False`，label=`让它停一下`，真实点击按钮真实中心点 `(1060,2724)`）：

```
A0 基线   orchestrator.paused=False  app.paused=False  pauseResult=None
          label=让它停一下
A1 点击后 orchestrator.paused=False  app.paused=False  pauseResult=已继续执行（全局执行器）
          label=让它停一下
```

`pauseResult` 从 `None` 变成「已继续执行」——**这一格证明点击确实落到了按钮的处理函数**（否则它不会被写），而它执行的动作是 resume。

**B 向**（先用 debug 口把 `paused` 置 `True`，label 变 `继续执行`，再真实点击同一个按钮）：

```
B0  debug 口 pause → paused=True  pauseResult=已让它停一下（全局执行器，再按一下继续）
    label=继续执行
B1  真实点击       → paused=True  pauseResult=已让它停一下（全局执行器，再按一下继续）
    label=继续执行
```

两个方向都**不翻转**，且都执行了与标签相反的那个动作。

### 根因（源码定位到行）

`app/app/src/main/java/com/dsh/botcrew/CrewUi.kt:1692`、`:1699`：

```kotlin
val resuming = paused                       // ← 这是「当前是否已暂停」，不是「目标」
...
touched = onSetPaused(resuming, preview ?: ticket?.id)
```

`setPaused(paused: Boolean, …)`（`CrewUi.kt:331`）的第一个参数语义是**目标状态**（`if (paused)` 走 `client.pause`，否则走 `client.resume`）。按钮把**当前状态**当目标传进去，于是：

| 当前 `paused` | 按钮标签 | 传入的目标 | 实际执行 | 应为 |
| --- | --- | --- | --- | --- |
| `False` | 让它停一下 | `False` | `resume` | `pause` |
| `True` | 继续执行 | `True` | `pause` | `resume` |

正确写法是 `val target = !paused`。这个错在 HEAD（`git show HEAD:` 版本）里**不存在**——HEAD 写的是 `if (resuming) client.resume() else client.pause(...)`，语义是对的。是本次「把暂停提到 `CrewRoot.setPaused` 一处」的重构把方向弄反了。

### 为什么 369 条单测没抓住

新增的 7 条用例钉的是：`pause`/`resume` 动作是否落到 target、回执是否只说 `requested`、失败原话是否进快照、`pauseLabel` 的纯函数分支。**没有一条钉「按钮传出去的第一个参数是取反后的目标」**——按钮那一层在 Compose 里，测试只测到 `CrewDebug` 与 `WorkspaceCopy` 两个纯函数边界。`pauseLabel` 测对了（`True → 继续执行`），所以「标签对、动作反」这种错在纯函数层完全看不见。

**这正是上一份报告 §六 用「可测版本替代目视」留下的洞**：`paused` 真的翻转了（debug 口测的），`pauseLabel` 真的对（单测测的），但两者之间那句 `onSetPaused(resuming, …)` 没人验。**接口通 ≠ 按钮通**，与 `TODO(desktop, …)` 记的是同一类欠账。

### 旁证：按钮点击确实到达（不是「点了没反应」）

断网状态下真实点击同一个按钮，`problem` 从 `None` 变 `timeout` —— 说明点击触发了网络请求。这条排除了「坐标点空了」的可能。

## 四、手机 takeover 按钮：首次 GUI 按钮级验过（通过）

issue #15 第 1 项与 `TODO(desktop, 2026-11-14)` 记的是「takeover 只到接口级，GUI 按钮未点」。手机侧同类欠账本轮补上。

造一张自己的测试票（`work` 会话，`send` 经真机 debug 口）：

```
T0 基线   2c23257a working open=True    工作区显示「正在干活 · 从 17:32:01 起」
T1 真实点击「接手操作」(380,2724)
          界面：已接手，这个工单停了
T2 后端   2c23257a stopped open=False    open count=0
再等 20s  仍 stopped（没有偷偷复活）
```

**worker 真的停了**（不是假成功）：探针日志 `/tmp/19-ui-takeover-probe.log` 在点击后 25 秒内停在 11 行不增。

已按「清理自己数据」处理：探针日志删除；该票 `stopped`、`open=False`，按正文「已结束票保持 stopped」保留不复活。

## 五、另抓到一个真缺陷：转屏即让调试口永久失效

**不是本 issue 四项的内容，但它是本轮验收的实际障碍，且是可复现的产品缺陷，记下来。**

手机转到横屏（`config changes=20000480`，`ROTATION_0 → ROTATION_270`）会重建 `MainActivity`。重建时 `onCreate` 新建的 `CrewDebugServer.start()` 报：

```
W CrewDebug: 调试口没起来：localabstract:crew-debug
W CrewDebug: java.io.IOException: Address already in use
W CrewDebug:   at android.net.LocalSocketImpl.bindLocal(Native Method)
W CrewDebug:   at com.dsh.botcrew.CrewDebugServer.start(CrewDebug.kt:490)
```

之后 `adb forward` 仍能建，但连上去**读到空响应**（`raw: b''`），调试口整个不可用，直到杀进程重启 App。受控复现两次（17:27 与 17:35），两次一致。

判据：`/proc/net/unix` 里 `crew-debug` 已不在（旧实例随 `onDestroy` 关了），但新实例 bind 仍报 `Address already in use` —— 旧 listener 的 `close()` 与新实例的 `bind()` 在 abstract namespace 上撞车。`MainActivity.onDestroy` 确实调了 `debugServer?.stop()`（`:284`），所以不是「忘了关」，是**关与开之间的时序**没有保证。

`AndroidManifest.xml` 的 `.MainActivity` 没有声明 `configChanges`，转屏必重建，所以这条路在真机上很容易踩到。

**影响**：只影响调试口（debug 构建），不影响产品界面与生产面（release 永远不开）。但「验收脚本靠调试口」这件事会因此中断，值得单开一条。

## 六、未做与边界（不含糊）

| 项 | 状态 |
| --- | --- |
| 桌面 GUI takeover 按钮（`TODO(desktop, …)`） | **未做**。桌面 GUI 进程未运行；按红线不抢鼠标、不聚焦窗口，且启动 GUI 会改变用户桌面状态。本条属 desktop 侧，不在本次手机验收范围 |
| 桌面真 GUI 双徽标（`TODO(gw, …)`） | **未做**，同上（需桌面 GUI 在真屏上同时显示两枚徽标） |
| 配对屏真机三验（干净安装弹权限框 / 拒绝后手输仍能配对 / 同网段选第二行 / 手改地址不被抢走） | **未做**。干净安装要卸载重装，会毁掉现有配对资产（`66e74d226c1e38fa`），与「不抹配对资产」冲突。列为下一条任务 |
| 第二个 conversation 真派单后 `/state` 与归档守卫 | **未做**。本轮 `work` 里造出的那张票是 `main` 之外的第一张真票，但已按 takeover 停掉，没有验 `/state` 与归档守卫的判据。列为下一条任务 |
| #15 其他未验边界 | 按指示**不笼统关**，见 §八 |

## 七、现场恢复（逐条对进场值）

| 动作 | 进场值 | 结束时 | 恢复 |
| --- | --- | --- | --- |
| 飞行模式 | `airplane_mode_on=0` | `0` | 已还原 |
| Wi-Fi | enabled | enabled | 未改 |
| 屏幕旋转 | `accelerometer_rotation=1`、`user_rotation=0` | `1` / `0` | 已还原（验收中途曾锁竖屏，结束已 `user-rotation free`） |
| 屏幕常亮 | 保持 | `svc power stayon true` | 沿用上一轮，未改回 |
| `adb forward` | 无 | 无 | 已 `--remove-all`，`forward --list` 为空 |
| `/sdcard/*.xml` 临时 dump | 无 | 无 | 已删 |
| 后端 `paused` | `False` | `False` | 已恢复 |
| dsh 89699 / mobilegw 41418 | 运行中 | 运行中 | **全程未重启** |
| 健康位 | 全 ready | 全 ready（12 项） | 一致 |
| App 进程 | 28890 | 7275（转屏重建所致） | 当前活着，`way=p2p`、`problem=None` |
| 我造的票 | — | `2c23257a` stopped / open=False | 保留 stopped，不复活 |
| 探针日志 | — | 已删 | — |

未做 `git commit` / `push` / `stash` / `checkout` / `restore`。写范围仅 `docs/review/` 下本报告与 `shots-issue19/` 截图。

## 八、给 lead 的收口建议

1. **#19 第 3 项不能关。** 四项里 1 / 2 / 4 有真机证据，第 3 项的**后端**成立、**按钮**不成立。按正文「四项逐项有真机证据才关」，现在差这一项。
2. **按钮方向修复很小**：`CrewUi.kt:1692` 的 `val resuming = paused` 应为取反的目标值；配套补一条能钉住「按钮传出去的是取反后的目标」的用例（当前 369 例无一覆盖这一层）。
3. **#15 不要笼统关**：除第 3 项外，桌面 GUI takeover 按钮、桌面双徽标、配对屏三验、第二 conversation 的 `/state` 与归档守卫都还没有真机/真 GUI 证据（§六）。
4. **转屏致调试口失效**建议单开一条：影响所有靠调试口的真机验收脚本。
5. 手机 takeover 按钮这一格现在可以从不欠账里划掉（§四）。

## 附：截图

`docs/review/shots-issue19/`

| 文件 | 内容 |
| --- | --- |
| `20-item3-A0-before.png` | A 向基线：`让它停一下`、`pauseResult=None` |
| `21-item3-A1-after-pause-tap.png` | A 向点击后：标签仍 `让它停一下`，下面写着「已继续执行（全局执行器）」 |
| `22-item3-B0-label-resume.png` | B 向基线：标签 `继续执行` |
| `23-item3-B1-after-tap-on-resume.png` | B 向点击后：`paused` 仍 True，未恢复 |
| `30-takeover-T0-before.png` | takeover 前：`正在干活 · 从 17:32:01 起` |
| `31-takeover-T1-after.png` | takeover 后：`已接手，这个工单停了` |
| `32-final-restored.png` | 收尾现场 |
