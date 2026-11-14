# relay 门切会话 + 桌面真 GUI 切会话（issue #18 三项）

- 核验时间：2026-11-14 14:00–14:25（Asia/Shanghai）
- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`（起点 HEAD `331371d`）
- 可写范围：`desktop/debug.go`（加 session.* / memory.* 动作）、`desktop/*_test.go`、`docs/`。
  `desktop/client.go`、`desktop/ui.go`、`backend/`、`app/`、`开发进度.md` 一个字节没动。
- 约束遵守：没有发任何桌面输入事件、没有 `osascript` / `cliclick`、没有抢焦点（`open -g`，前台始终是 `loginwindow`）、
  没有重启 dsh（PID 70723 仍在）与 mobilegw、没有 git add / commit / push。手机配对数据只 `run-as cat` 读过，没卸载没 `pm clear`。

## 一、三项结论

| # | 要求 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 手机经 **relay 门**切一次会话、发一条 | 通 | 队列 `work` +1、`main` 不变；relay 响应回显 `session_id:work` |
| 2 | 重打包 `.app`，**真 GUI** 切会话、发一条、切回 | 通 | 队列 `main` +1 / `work` +1，两条各落各的；两段 timeline 68 / 4 条互不串 |
| 3 | 同一次开窗口：记忆改一条、存一条，**重启后还在** | 通 | KV 里 `description`/`body` 前后对比 + 重启后重读一致，最后已回滚原文 |

## 二、第 1 项：手机经 relay 门

### 2.1 为什么必须走 relay 而不是手机 UI 的那三条入口

手机 `state.dump` 的 `entries` 是三条、`entry` 是当前在用的那条：

```
entries = ["http://127.0.0.1:37975", "http://192.168.31.127:43499", "https://crew.kentonnie.top"]
entry   = "http://192.168.31.127:43499"      ← 局域网，不是 relay
```

公网那条是 `crew.kentonnie.top`（Cloudflare Tunnel 直连消息面），**不是** `jarvis.kentonnie.top/crew-relay/i/<instanceId>/...`。
手机 UI 不支持临时改入口，所以按 issue 里给的 b 方案：在**手机 shell 里**（源地址就是手机）用 curl 打 relay 门，
带的是这台手机的真实设备凭据（`run-as cat shared_prefs/crew-pairing.xml` 只读取得）。

### 2.2 relay 健康与身份

```
$ curl -s https://jarvis.kentonnie.top/crew-relay/health
{"ok":true,"uptimeMs":16459710,"tunnels":1}
```

instanceId 取自 `~/.config/crew-desktop/relay.env` 的 `CREW_RELAY_INSTANCE=kenton-mac`。
不带凭据时 relay 回 `401 {"error":"Not paired"}` —— 说明请求**真的到了后端**（不是中转自己编的错）；
带上手机的 `x-crew-device` / `x-crew-credential` 之后回 200：

```
$ adb shell "curl -s -H 'x-crew-device: <phone-device>' -H 'x-crew-credential: <phone-token>' \
    https://jarvis.kentonnie.top/crew-relay/i/kenton-mac/api/mobile/sessions"
{"sessions":["main","work"],"default_session_id":"main","session_api":1}
```

### 2.3 切会话 + 发一条（经 relay）

```
# 切换前读 main
$ adb shell "curl ... '$RELAY/api/mobile/timeline?session_id=main'"
main: session_id=main  items=58  last=好的：逐个列出 backend/src/app 下每个文件的…

# 切到 work（同一条 relay 路径，带 x-crew-session: work）
$ adb shell "curl ... -H 'x-crew-session: work' '$RELAY/api/mobile/timeline?session_id=work'"
work: session_id=work  items=2   texts=['S4 真机验收：work 会话', 'relay 门验收：手机经 relay 切到 w']

# 经 relay 发一条到 work
$ adb shell "curl -s -X POST ... -H 'x-crew-session: work' -d '{"text":"relay 门验收：手机经 relay 切到 work 发的一条","request_id":"relay-1794636079"}' \
    '$RELAY/api/mobile/send?session_id=work'"
{"ok":true,"id":47,"request_id":"relay-1794636079","session_id":"work","session_api":1}
```

源地址是手机（`remote=2606:4700:3036::6815:5d88`，Cloudflare 边缘），耗时 3.8s —— 比局域网的 10ms 高一个量级，
正是「绕了公网中转」的指纹。

### 2.4 队列侧落点（判据）

```
$ sqlite3 ~/.dsh/state/superagent/mobileq.db "select conversation, count(*) from messages group by conversation;"
main|43
work|2          ← 基线是 work|1

$ sqlite3 ... "select id,conversation,text,request_id from messages where id>=47;"
47|work|relay 门验收：手机经 relay 切到 work 发的一条|relay-1794636079
```

`main` 一条没多，`work` +1，`request_id` 与发出时逐字一致（幂等键没被改写）。
手机端调试口 `session.set` 之后 `session.list` 也确认 `current=work`、`cached=["main","work"]`。

## 三、第 2 项：真 GUI 切会话

### 3.1 前提：桌面调试口原来没有 session.*

原状由 `TestDebugBusHasNoSessionActions` / `TestDebugSocketHasNoSessionAction` 钉住（`da28554`），
所以「切会话」在自动化眼里只能点像素。本轮按 issue 授权改 `desktop/debug.go`，补三个与手机端**同名同语义**的动作。

### 3.2 怎么做到「不抢鼠标、不聚焦窗口」

- 重打包：`bash desktop/package.sh`（`go build` + `codesign --force --sign -` + `codesign --verify --strict`）。
- 启动：`open -g --env CREW_DEBUG=1 --env CREW_DEBUG_SOCK=/tmp/crew-debug-gui.sock "desktop/build/Bot Crew.app"`。
  `-g` 是「后台启动、不把应用带到前台」。全程 `lsappinfo front` 都是 `loginwindow`，前台一次没被抢。
- 驱动：只走 unix socket 调试口（`/tmp/crew-debug-gui.sock`，`chmod 0600`），没有一次鼠标/键盘事件。
- 取证：窗口真的存在（`kCGWindowLayer=0`、`onscreen=1`、1280×746、标题「Bot 队伍」），
  像素截图取不到 —— 这台机器当时**处于锁屏**（`CGSSessionScreenIsLocked` 存在，`screencapture -x` 得到全黑 1 色图），
  所以证据用调试口的结构化快照 + 队列计数，而不是截图。这也是本轮唯一没能拿到图片证据的地方，如实记下。

### 3.3 加的动作（37 条，比原来 31 条多 6 条）

```
session.list     capability/switchable/current/default/note/sessions[]（与手机端 CrewDebug 同字段）
session.set      {"session":"work"}；能力位没到 live 一律拒（不绕过先验）；名单外/形状非法也拒
session.reload   等价点界面「重试」：重新 GET /sessions，等三态落地再回话
memory.dump      这一刻账本的结构化快照（state/note/items[]/counts）
memory.edit      {"name","description?","body?"}；走界面「编辑」同一入口，草稿从账本现值起
memory.save      走界面「保存」同一收口（Client.EditMemory → applyMemoryOutcome），同步等结果
```

`state.dump` 同时补了 `session / sessionCapability / sessionSwitchable / sessionNote / sessions / refreshing /
memoryCount / memoryState / memoryEditing / memorySaving / memoryEditError`，脚本不必再看像素。

### 3.4 实跑（真进程、真队列）

```
$ python3 gdbg.py session.list
capability=live switchable=true current=work sessions=[main, work]

$ python3 gdbg.py session.set '{"session":"main"}'
{"session":"main","loaded":true,"messages":67}

$ python3 gdbg.py send '{"text":"真 GUI 验收 A：切到 main 之后发的一句（issue18 第2项）"}'
{"sent":"真 GUI 验收 A：…"}

$ python3 gdbg.py session.set '{"session":"work"}'
{"session":"work","loaded":true,"messages":3}

$ python3 gdbg.py send '{"text":"真 GUI 验收 B：切到 work 之后发的一句（issue18 第2项）"}'
{"sent":"真 GUI 验收 B：…"}

$ python3 gdbg.py session.set '{"session":"main"}'   → messages=68
$ python3 gdbg.py session.set '{"session":"work"}'   → messages=4
```

队列侧（判据）：

```
$ sqlite3 ... "select conversation, count(*) from messages group by conversation;"
main|47      ← 基线 46
work|4       ← 基线 3

$ sqlite3 ... "select id,conversation,text from messages where text like '真 GUI 验收%';"
52|main|真 GUI 验收 A：切到 main 之后发的一句（issue18 第2项）
53|work|真 GUI 验收 B：切到 work 之后发的一句（issue18 第2项）
```

两段 timeline 互不串（不经本进程缓存，直接问后端）：

```
main: items=68  last=真 GUI 验收 A：切到 main 之后发的一句（issue18 第2项）
work: items=4   last=真 GUI 验收 B：切到 work 之后发的一句（issue18 第2项）
```

### 3.5 途中发现的真 bug（未改 ui.go，按约束报告）

**现象**：`open -g -j`（`-j` = 隐藏启动）或用 `open -g` 启动后若窗口一直没被绘制（本机锁屏时就是这样），
`state.dump` 的 `messages` 永远是 `-1`、`memoryCount` 永远是 `-1`，`session.set` 之后也读不到新会话的条数。

**根因**：`s.drain(c)` 只在 `ui.go:821`（`view()` 里）被调一次一帧。后台 goroutine 早把结果放进了
`s.arrived` / `s.sessionsCh` / `memoryCh` / `actions.results`，但一帧都不来，通道里的结果就永远不落状态。
「重启又回到旧状态」「数据早到了界面却停在正在读」是同一个洞 —— 状态推进挂在**绘制**上，而不是挂在**数据到达**上。

**本轮的处理（在授权范围内）**：`debug.go` 里加 `pumpResults()`，调试口自己把 `drain(nil)` 走一遍
（`drain` 里的 `c.Invalidate()` 对 nil 是安全的），等结果真落地再回话。产品路径的行为一个字节没变。

**根治建议（超出本轮可写范围，留给 ui.go 的 owner）**：让 drain 不只在帧里跑 ——
例如后台结果入通道时同时 `post` 一次「只 drain 不重绘」的任务，或在 `wake()` 里除了 `Invalidate()`
再挂一次 drain。判据是：锁屏 / 窗口被遮挡时，`state.dump` 的 `messages` 仍应跟上真实条数。

## 四、第 3 项：记忆改一条、存一条、重启后还在

真 GUI 进程里（同一次开窗口），目标条目 `bot-lead-person-以后都先说结论`：

| | description | body 末段 | updated |
| --- | --- | --- | --- |
| 改前 | `以后都先说结论` | （无） | 1794587238 |
| 改后（存盘） | `以后都先说结论（issue18 验收改过）` | `[issue18 第3项验收：这一行是改过的证据]` | — |
| **重启后重读** | `以后都先说结论（issue18 验收改过）` | 同上 | 1794637135 |
| 回滚后 | `以后都先说结论` | （无） | — |

后端只读核对（`~/.dsh/state/superagent/orchestrator.sqlite` 的 `kv`，键 `memory:entry:bot-lead-person-以后都先说结论`）：

```
改后：{"name":"…","description":"以后都先说结论（issue18 验收改过）","body":"主人原话：「以后都先说结论」\n\n记于 …\n\n[issue18 第3项验收：这一行是改过的证据]",…}
回滚：{"name":"…","description":"以后都先说结论","body":"主人原话：「以后都先说结论」\n\n记于 2026-11-12T06:45:34.000Z。",…}
```

重启是**真的杀进程再起**（旧 PID 84471 → 新 PID 85051），新进程 `memory.reload` 之后重读一致，
说明改动落在后端的 KV 里、不是进程内缓存。收尾已把该条回滚成原文（`description` / `body` 与改前逐字相同）。

## 五、测试

```
$ cd desktop && go vet ./... && go test ./...
ok  github.com/Dangerous828/dsh-bot-crew/desktop  1.7s
```

新增 8 例（`desktop/debug_session_test.go`），并把原来两处「刻意钉住没有 session 动作」的用例
改成钉住新契约（`TestDebugBusSessionActionsAreExactlyTheThreePhoneOnes`、`TestDebugSocketExposesSessionActions`）：

| 用例 | 钉住什么 |
| --- | --- |
| `TestDebugBusSessionListMirrorsPhoneShape` | 字段与手机端同名同义（capability/switchable/current/default/note/sessions） |
| `TestDebugBusSessionSetSwitchesAndSendLandsInThatSession` | 切过去后请求带 `?session_id=work` + 同值 header，发的那句落 work，缓存互不串 |
| `TestDebugBusSessionSetRefusesWhenCapabilityLocked` | 能力位没到 live 一律拒，不绕过先验 |
| `TestDebugBusSessionSetRejectsUnknownAndMalformed` | 名单外 / 缺参 / 形状非法都拒 |
| `TestDebugBusSessionReloadReprobesTheList` | 重拉名单，恰好再发一次 `GET /sessions` |
| `TestDebugBusMemoryEditAndSave` | 编辑层草稿 + 请求体逐字（action/name/description/body） |
| `TestDebugBusMemorySaveReportsRefusalAndKeepsEditor` | 后端 `ok:false` 如实报错、编辑层不关 |
| `TestDebugBusMemoryEditRejectsUnknownName` | 账本里没有的名字不打开编辑层 |
| `TestDebugStateDumpCarriesSessionAndMemory` | `state.dump` 带会话/记忆字段 |

## 六、没做 / 做不了的事

- **窗口像素截图**：机器锁屏，`screencapture` / `CGWindowListCreateImage` / ScreenCaptureKit 都取不到内容。
  用「窗口确实存在（CGWindowList 有 layer 0、onscreen=1）+ 调试口结构化快照 + 队列计数」替代。要图片证据得等屏幕解锁。
- **手机 UI 自己经 relay 切会话**：手机 UI 的公网入口是 `crew.kentonnie.top`（直连消息面），
  不是 relay 门，且 UI 不支持临时改入口。本项按 issue 的 b 方案在手机侧用 curl 打 relay 门完成。
- **`drain` 挂在帧上的根治**：改 `desktop/ui.go` 超出本轮授权，已在 §3.5 写清根因与建议。
