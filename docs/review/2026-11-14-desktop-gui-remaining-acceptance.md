# 桌面 GUI 剩余三项验收：双徽标同屏 / 群组栏真实打开 / takeover 按钮产品处理器

- 核验时间：2026-11-14 17:52–18:26（Asia/Shanghai）
- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`（HEAD `b2f305e`，**本轮零提交**）
- 对应欠账：
  - `docs/00-contract.md:976`「**桌面真 GUI 双徽标未看过**」
  - `docs/00-contract.md:1214`「**在真 GUI 里实际打开看过这栏（群组栏）仍未做**」
  - `docs/00-contract.md:1001` `TODO(desktop, 2026-11-14)`「桌面 **GUI 上真点一次「接手 →」** 仍未验」
- 可写范围：本目录（`docs/review/desktop-gui-accept-20261114/`）+ 本报告。源码 / 配置 /
  `开发进度.md` / `HANDOFF.md` / `scripts/crew-watch` / 生产 `.app` **一个字节没动**。

## 一、结论

**三项全部验到，且都是真窗口像素证据，不是 state 代替。**

| # | 要求 | 结论 | 像素证据 | 结构化证据 |
| --- | --- | --- | --- | --- |
| 1 | 双徽标同屏（「未读」+「未读回话」） | **通** | `04-fixture-dual-badges-live.png`、`04b-crop-dual-badges.png`、`10-ready-dual-badges.png` | `state.dump` 的 `unread: 3` / `unreadReplies: 2` |
| 2 | 群组栏真实打开（三态） | **通** | `05-crop-groups-live.png`、`06-crop-groups-empty.png`、`07-crop-groups-unavailable.png` | 无障碍树里三态各一句原文 |
| 3 | 桌面 takeover 按钮走产品处理器 | **通**（真票真停） | `02-prod-takeover-button-visible.png`、`03-prod-after-press-stopped.png`、`13-prod-takeover-ack.png` | 票 `stopped` / `open=false`；fixture 请求日志有 `POST /api/mobile/takeover` |

**关键点：第 3 项不是「接口级」，也不是「fixture 假成功」** —— 按钮按下后产品代码真的发出了
`POST /api/mobile/takeover {"ticket":"<真票>"}`，生产后端把两张真票都停成了 `stopped`，
20 秒后复查仍不复活（见 §五）。

**没有发现产品 bug。** 唯一一处「按字面验收会以为漏了」的边界写在 §七。

## 二、约束遵守（逐条）

| 约束 | 做法 | 证据 |
| --- | --- | --- |
| 无鼠标 / 键盘桌面输入 | 全程没有 `osascript` / `cliclick` / `CGEvent`；驱动只走 unix socket | 见 §三 |
| 不聚焦窗口（硬约束） | 首次尝试被 `mygo` 的 `activateIgnoringOtherApps` 抢了焦点，**当场发现并回滚**，之后改法（§三.2）；每轮前后都记 `lsappinfo front` | §三.2、§三.5 |
| 不动用户已开的 desktop 进程 | 没有 `dsh-bot-crew/desktop/desktop` 或 `Bot Crew.app` 在跑；自己的测试 app 单独 PID | §三.5 |
| 不 build 覆盖生产 `.app` | 编到 `/tmp/crew-gui-accept/`；`desktop/build/Bot Crew.app` 未触碰 | §三.1 |
| 独立 profile / 配置副本 | 两份隔离 HOME：`home`（生产凭据副本）、`home-fixture`（指向本机 fixture 端口） | §三.1 |
| 精确 PID 回收自己的进程 | 按 PID `kill -TERM`，结束前后 `pgrep` 核对 | §三.5 |
| 不锁屏 / 不解锁 mac | 全程 `CGSSessionScreenIsLocked` 计数 0，没有任何解锁动作 | §三.5 |
| 不 HMR / 不重启 dsh / 不 git 操作 | 零 git 写操作、零服务重启 | `git status` 只多出本报告与截图目录 |

## 三、怎么做到「不抢焦点还能真验」

### 3.1 三条工具链，都是只读接入

1. **测试 app**：从源码编到 `/tmp/crew-gui-accept/Bot Crew Test.app`（独立 `CFBundleIdentifier`
   `…desktop.accept`），`codesign --force --sign -` + `codesign --verify --strict` 通过。
   - 编译用了 `go build -overlay`：把两个**只在 /tmp 存在**的文件注入构建，仓库里没有这两个文件：
     - `zz_automation_e2e.go` —— 链入 `mygo` 自带的 `plugins/automation`（unix socket 驱动真窗口）；
     - `main.go` 的副本 —— 把 `NewWindow` 改成 `Hidden: true` + `ShowInactive()`。
   - 因此「不抢焦点」这件事是**测试构建的差异**，产品源码的窗口行为一个字没改。

2. **驱动通道**：两条 unix socket，都 `chmod 0600`，都只在本机。
   - `MYGO_AUTOMATION=<sock>`：读窗口、读无障碍树、`act{action:press}`、`capture` 出 PNG。
   - `CREW_DEBUG=1` + `CREW_DEBUG_SOCK=<sock>`：产品自带的调试动作表（`state.dump` / `nav.*` /
     `backend.tab` / `refresh`）。

3. **fixture 后端**：`fixture-server.py`（本报告同目录），只监听 `127.0.0.1:18899`，
   按契约形状回 `/api/mobile/{sessions,timeline,read,takeover,pause,send}` 与
   `/orchestrator/api/state`。它**不连生产**，用于把「双徽标同屏」「群组栏三态」摆成确定性状态。

### 3.2 焦点：第一次抢了，当场纠正

第一次启动用的是 `open -g`（后台启动），结果 `lsappinfo front` 从 `DeepSeek Harness` 变成了
`Bot 队伍测试`。原因不在 `open`，而在 `mygo` 的 darwin 后端：

```
internal/darwin/app.go:294-297
  if send(b.app, "activationPolicy") == nsApplicationActivationPolicyRegular {
      send(b.app, "activateIgnoringOtherApps:", 1)
  }
```

`Regular` 策略的 app 一启动就自己 `activateIgnoringOtherApps`。纠正做了两件事，**两条同时生效**：

1. 测试构建的 `init()` 里 `mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)`（`CREW_TEST_NO_ACTIVATE=1` 时）；
2. 窗口改成 `Hidden: true` 建、`ShowInactive()` 显 —— `darwin/window.go:891` 对 `Panel`/非激活显示
   不发 `activateIgnoringOtherApps`。

改完后每轮都记：`front before: 访达` → `front after: 访达`（生产验收那一轮是 `DeepSeek Harness` 在前、
测试 app 起后仍是它，后来用户自己切到访达，测试 app 一次都没抢）。**没有一次抢焦点留在现场。**

### 3.3 「按钮按下」到底走的是不是产品处理器

这是本轮最需要说清的一点。`mygo` 的 `plugins/automation` 的 `act{action:"press"}` 不是合成鼠标坐标，
而是给窗口内容一条辅助技术动作，最终落到和真人点按同一个 `OnClick`：

```
ui/access.go:1079-1088        case platform.AccessPress:
                                if s.flags&flagClickable != 0 { s.click(0) }
ui/input.go:715-723           func (s *state) click(mods Modifiers) { s.clicks++ ... }
ui/runtime.go:1113-1126       runActions: case actionClick: handled = n.Clicked()
ui/actions.go:35              func (e Element) OnClick(fn func()) Element { return e.on(actionClick, …) }
```

而产品这一侧，按钮的 `OnClick` 直接就是 `s.takeoverTask(task)`：

```
desktop/ui.go:4471            Cursor(ui.CursorPointer).OnClick(func() { s.takeoverTask(task) })
desktop/ui_takeover.go:11     func (s *app) takeoverTask(task Task)
desktop/actions_client.go:178 func (c *Client) Takeover(ctx, ticket)  → POST /api/mobile/takeover
```

所以 `act{press}` → `click` → `OnClick` → `takeoverTask` → `Client.Takeover` → HTTP，
**中间没有一层替身，也没有一条「调试口专用」的分支**。这条链在本轮用两种后端各验了一次（§四、§五）。

### 3.4 为什么截图是真像素而不是 state

`capture` 走 `mygo` 的 `Window.CapturePage → captureContent → raster.Render`，把窗口内容在内存里
重绘成 PNG（`content.go:206-232`、`ui/window.go:687-699`）。它取的是**窗口自己的渲染结果**，
不依赖屏幕录制权限，也不受锁屏影响 —— 这也是这台机器此前 `screencapture` 全黑时唯一能拿到像素的路。

本轮实测尺寸 2560×1428（窗口 1280×746 DIP @2x），图像内容与 `state.dump` 的字段逐项对得上。

### 3.5 回收与现场

```
frontmost 结束：访达（用户自己切的，测试 app 未抢）
测试 app PID 57762 → kill -TERM → pgrep 无残留
fixture 18899  → pkill → 无残留
CGSSessionScreenIsLocked 计数：0（全程没锁屏、没解锁）
生产 desktop 进程：本轮开始时就不存在，结束时也不存在
```

## 四、双徽标 + 群组栏（fixture 后端，真窗口）

### 4.1 双徽标同屏

fixture 把 `unread.count` 设 3、`unread_replies.count` 设 2，切到「后台」后左栏那一行：

`04b-crop-dual-badges.png`（放大 2 倍）：

- 橙底 `3` —— 「未读」：人发出去、队伍还没读走（`unreadCount()`，`ui.go:1728`）；
- 绿底 `2` —— 「未读回话」：队伍回了、主人还没看（`unreadRepliesCount()`，`ui.go:1715`）；
- 右侧绿底 `1` —— 在跑张数（`openCount()`）。

两枚徽标**同时**出现在同一行，颜色不同（`p.Warn` vs `p.AccentSoft`），与契约 §5.6 的「两个数方向相反、
不能互相顶替」一致。`state.dump` 同步读到 `unread: 3` / `unreadReplies: 2`，数字逐字相等。

**这一格此前欠的是「没在真 GUI 里同时看到两枚」，现在看到了。**

### 4.2 群组栏三态

同一扇真窗口，只换 fixture 的 `groups.state`：

| 态 | 窗口上的原文 | 证据 |
| --- | --- | --- |
| `live` | 「群组」+ 右上「2 组」+ `main · 1 会话 · 2 位 · 5 张` / `work · 1 会话 · 0 位 · 1 张` | `05-crop-groups-live.png` |
| `empty` | 「读得到，还没有群组」 | `06-crop-groups-empty.png` |
| `unavailable` | 「读不到群组：fixture：读不到群组投影」（赭色） | `07-crop-groups-unavailable.png` |

三态各说各的话，没有把「读不到」画成「还没有」；`unavailable` 那句用的是 `warn` 色，和空态的灰分得开。
这与 `groupBarLines()`（`ui.go:1334`）的三分支一一对应，**是「在真 GUI 里打开看过这栏」的像素证据**，
不是单测。

### 4.3 顺带钉住的一条：桌面真的会上报已读水位

fixture 请求日志（`fixture-requests.log`）里有：

```
POST /api/mobile/read {"last_read_id":"r2"}
```

这是 `refresh()` 读到时间线后按 `lastAgentMessageID()` 主动上报的（`ui.go:800`）。
它证明「未读回话」那枚徽标的输入链路在真窗口里是活的，而不是只靠后端算好推下来。

## 五、takeover 按钮（生产后端，真票真停）

### 5.1 两张真票

| 票 | 会话 | 发出 | 按钮按下前 | 按钮按下后 | 20 秒后复查 |
| --- | --- | --- | --- | --- | --- |
| `5846d4f0dabd77b36ada87e00bb0a96f` | `work` | 18:14:50 | `working` / `open=true` | `stopped` / `open=false` | — |
| `eb555457854e392aeb7eccae920fbe08` | `work` | 18:22:50 | `working` / `open=true` | `stopped` / `open=false` | 仍 `stopped` / `open=false` |

两张票都是**经真实链路派出去**的（`POST /api/mobile/send?session_id=work` → 网关 → `mobileq.db`
→ team Source → Gate/Eval/判官 → Ticket → Executor），没有 `mobileq inject`、没有手写
`orchestrator.sqlite`、没有伪造 decision 或 ticket。

派票前已与手机侧 owner `ds-phone-pause-fix-max` 协调：`work` 会话可用、不碰主 session 的活、
不碰 `970072c9` / `e12abc18` / `20ec7f99` 三张历史 `stopped` 票、发完必须停掉且不复活。
窗口内也没有按 pause（`status.paused=false` 全程）。

### 5.2 按钮前 / 后

- `02-prod-takeover-button-visible.png`：右栏「进行中」只有那张票，右下角「接手 →」可见。
  此时无障碍树里该元素 `actions: ["press","scrollIntoView"]`，`bounds: x=1202.9, y=149.1, w=35.1, h=13.0`。
- 按下（`act{action:"press"}`）后：
  - `03-prod-after-press-stopped.png`：「进行中」变空态，左栏「大哥」从「正在工作」变「已停止」；
  - `13-prod-takeover-ack.png`：切到「已完成」，卡片上逐字写着 **「已接手：这张票停下了」**。
- 这句文案不是写死的：`takeoverNote()`（`actions_client.go:196`）只在后端回
  `{ok:true, stopped:true}` 时才说这句；任一字段不是真就换别的说法（「后端没有确认接手…」/
  「后端说接手了，但没确认这张票停下…」）。本轮拿到的是最严的那句。

### 5.3 fixture 侧的同一条链（确定性对照）

fixture 后端上按同一个按钮，请求日志逐条落到（`fixture-requests.log`）：

```
POST /api/mobile/takeover {"ticket":"fixture-ticket-0001"}
GET  /api/mobile/timeline
GET  /api/mobile/agents?ticket=fixture-ticket-0001
GET  /orchestrator/api/state
POST /api/mobile/read {"last_read_id":"r2"}
```

第一行就是按钮按下那一刻发出的，**参数名与值逐字来自产品代码**（`map[string]string{"ticket": ticket}`）。
这条把「按钮 → HTTP」的因果钉死：不是定时器、不是别的动作顺手发的。

## 六、ready 版本复验

`ds-debug-thread-max` 在 18:20 报 ready（`go vet` / `go test` / `go test -race` 全 exit=0，
278 PASS / 0 FAIL，DATA RACE 0）。源码冻结后**用工作树重编了一遍测试 app**，把三项又跑了一次：

- 双徽标：`10-ready-dual-badges.png`（橙 3 / 绿 2 同屏，与 18:17 那轮一致）；
- 群组栏：同一份 `groupsPane` 代码，三态未变；
- takeover：fixture 上再按一次，`POST /api/mobile/takeover {"ticket":"fixture-ticket-0001"}`
  再次落日志，回执「已接手：这张票停下了」（`11-ready-takeover-ack.png`）。

两次构建（HEAD 快照 / ready 工作树）结果一致，说明这三项不依赖他那一轮改动，
也不被那一轮改动破坏。

## 七、边界与缺口（逐项明说）

1. **「真窗口」是窗口自己的渲染，不是屏幕截图。**
   这台机器 `screencapture` 能出图（本轮 `lock-probe.png` 23186 色，非锁屏），但测试 app 是
   `accessory` + `ShowInactive` 起的，不保证在最前；`screencapture -l <windowid>` 对这种窗口
   报 `could not create image from window`。所以像素证据统一用 `capture`（窗口内容重绘）。
   这是**真实渲染结果**，但**不是**「屏幕上那一刻的样子」—— 两者在窗口被遮挡时会有差别。
   要求「像素证据」的判据用前者成立；要求「屏幕录制级别截图」的，本轮没有。

2. **双徽标同屏的确定性证据来自 fixture，生产侧是「分别出现」。**
   生产上 `main` 的 `unread=1`、`work` 的 `unread_replies` 会随刷新在 0/1 间变，两枚**同时**大于 0
   的时刻不可控（这也正是不该拿生产当 fixture 的理由）。所以：
   - 「两枚能同时画出来、颜色不同、数字各是各的」→ fixture 真窗口像素（§4.1）；
   - 「生产后端能给出这两个数」→ §4.3 的 `POST /api/mobile/read` + `state.dump` 读数。
   两者合起来才是完整判据，**不拿 fixture 顶替生产**。

3. **`accessory` + `ShowInactive` 是测试构建的差异，产品不是这么起的。**
   产品 `main.go` 用默认 `Regular` 策略 + `NewWindow` 直接显示，会抢焦点 —— 这正是
   `开发进度.md` §四里那条「需要启动 GUI 进程（会抢焦点）」的由来。本轮**没有改产品这一处**，
   也**没有**声称「产品起法不抢焦点」。

4. **`screencapture` 整屏那张没进报告。** 它只是用来判断「是否锁屏」的探针（23186 色 ⇒ 没锁屏），
   与三项判据无关，故未归档。

5. **没有动 `docs/00-contract.md` / `开发进度.md` / `HANDOFF.md` 的欠账行。**
   按分工这三份由 `ds-doc-final-max` 订正；本报告只提供证据与判据。

## 八、复现步骤

```bash
BASE=/tmp/crew-gui-accept
# 1) 测试 app（/tmp，不覆盖生产 .app）
cd /Users/cpuser/Code/dsh-bot-crew/desktop
CGO_ENABLED=1 go build -overlay=$BASE/overlay-ready.json \
  -o "$BASE/Bot Crew Test.app/Contents/MacOS/desktop" .
codesign --force --sign - "$BASE/Bot Crew Test.app"

# 2) fixture 后端（仅 127.0.0.1:18899）
python3 $BASE/fixture/server.py 18899 live &

# 3) 隔离 HOME + 不抢焦点启动
HOME=$BASE/home-fixture MYGO_AUTOMATION=$BASE/automation.sock \
  CREW_DEBUG=1 CREW_DEBUG_SOCK=$BASE/debug.sock CREW_TEST_NO_ACTIVATE=1 \
  "$BASE/Bot Crew Test.app/Contents/MacOS/desktop" &

# 4) 驱动（全部走 socket，零桌面输入）
python3 $BASE/dbg.py nav.backend
python3 $BASE/dbg.py backend.tab '{"index":0}'
python3 $BASE/press.py <无障碍树里「接手 →」的 id>
```

`overlay-ready.json` 的两项替换（`main.go` 副本、`zz_automation_e2e.go`）都只在 `/tmp` 存在，
仓库工作树里没有这两个文件 —— 这是「不碰源码」的可核对形式。

## 九、证据清单

`docs/review/desktop-gui-accept-20261114/`：

| 文件 | 内容 |
| --- | --- |
| `01-prod-window-initial.png` | 生产后端真窗口首屏（群组栏 2 组、会话 main/work） |
| `02-prod-takeover-button-visible.png` | 真票在跑，「接手 →」可见 |
| `03-prod-after-press-stopped.png` | 按下后：「进行中」空态、大哥「已停止」 |
| `04-fixture-dual-badges-live.png` / `04b-crop-dual-badges.png` | 双徽标同屏（橙 3 + 绿 2 + 绿 1） |
| `05-crop-groups-live.png` | 群组栏 live |
| `06-crop-groups-empty.png` | 群组栏 empty |
| `07-crop-groups-unavailable.png` | 群组栏 unavailable |
| `08-crop-fixture-takeover-empty-state.png` | fixture 按下后「进行中没有工单」 |
| `09-crop-fixture-takeover-note.png` | fixture 回执「已接手：这张票停下了」 |
| `10-ready-dual-badges.png` | ready 版本双徽标复验 |
| `11-ready-takeover-ack.png` | ready 版本 takeover 回执复验 |
| `12-prod-takeover-before.png` | 第二张真票按下前 |
| `13-prod-takeover-ack.png` | 第二张真票回执（已完成页，「已接手：这张票停下了」） |
| `fixture-server.py` | fixture 后端源码（可复跑） |
| `fixture-requests.log` | 按钮按下时落下的请求（含 `POST /api/mobile/takeover`） |
