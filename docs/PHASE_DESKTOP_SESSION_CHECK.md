# 桌面端切会话补验（issue #14 第 2 项后半）

- 核验时间：2026-11-14 10:46–11:10（Asia/Shanghai）
- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`（HEAD `33c53e3`）
- 可写范围：`desktop/` 下**新增**测试文件、`docs/`。`desktop/client.go` / `ui.go` / `debug.go` 未改一个字节。
- 约束遵守：没有起 GUI 窗口、没有发任何桌面输入事件、没有 `osascript` / `cliclick`、没有重启 dsh 与 mobilegw、没有 git add / commit / push。

## 一、结论

1. **桌面调试口里没有任何切会话的动作。** `desktop/debug.go` 的 `bus.register(...)` 共 26 处（`nav.*` 那处是循环，展开成 6 条），
   实际动作表 **31 条**，逐字是：
   `actions.list, adopt, answer, backend.tab, memory.forget, memory.reload, mode.set, model.open, model.reload, model.scope,
   model.switch, nav.backend, nav.board, nav.memory, nav.models, nav.outputs, nav.routines, nav.selectBot, pauseAll, preview,
   refresh, routines.reload, screen.fullscreen, screen.look, send, sidebar.toggle, sidebar.width, state.dump, steer, withdraw, work.open`。
   `grep -n 'session' desktop/debug.go` **零命中** —— 既没有 `session.list` / `session.create` / `session.switch`，也没有任何名字里带 session 的动作。
   按任务约束**没有自行新增**（那要改 `desktop/debug.go`，超出范围）。这条结论现在由测试钉住，不再靠人眼：
   `TestDebugBusHasNoSessionActions`（进程内动作表）与 `TestDebugSocketHasNoSessionAction`（真 unix socket，一条 JSON 进一条 JSON 出；`session.switch` 走真 socket 会被明确拒为 `unknown action`）。
2. 因此走的是**等价路径**：用 `httptest` 起真 HTTP 假队伍，按界面里那条真路径驱动 ——
   左栏会话列表（`sessionPane`）→ `switchSession` → `Client.WithSession` → 下一次请求带 `session_id`。
   五件事逐条钉住（列 / 建 / 切 / 发 / 缓存互不串），断言的是**真的发出去的 URL、头、body**，不是内部状态。
3. 再加两层真实证据：**真网关 + 真队列**（起独立临时 `mobilegw`，读它自己的 `mobileq.db`）与**本机真消息面只读**（43499，本机已配对凭据）。
4. **桌面端切会话是真的通。** 五条链路全部成立，无一条需要改产品代码；`go vet` 干净，`go test -count=1 ./...` 全绿（新增 7 例，其中 2 例按环境变量跳过）。

## 二、验证路径与分层理由

桌面端与手机端不同：手机端有 relay 与 lan-server 两道门，桌面端只有**消息面**一道（本机 43499）。
而 `Client` 说的路由是消息面的 `/api/mobile/*`，网关（8788）说的是它自己的 `/timeline` / `/send` ——
拿网关地址问 `/api/mobile/sessions` 会 404，桌面端按契约 §1 判成「老后端」锁 `main`。所以证据分三层：

| 层 | 覆盖什么 | 怎么起 | 跑的条件 |
| --- | --- | --- | --- |
| A. 假队伍 + 整扇窗 | Client → app → 界面 这一层的字节与状态：列 / 建 / 切 / 发 / 缓存 | `httptest`（回环真 HTTP） | 默认跑 |
| B. 真网关 + 真队列 | 传输层与落库：分片、回显、query/header 双形态、冲突 400、`mobileq.db` 里的 `conversation` 分布 | 独立临时 `mobilegw`（`MOBILEGW_STATE`=mktemp、随机端口） | `CREW_REAL_GW=1` |
| C. 真消息面（只读） | 桌面端真正那道门的名单与两段 timeline 互不串 | 本机 43499 + `~/.config/crew-desktop/credential.json` | `CREW_REAL_LAN=1` |

C 层**刻意只读**：往真队列发一句会真的派活给 worker，那不是「验桌面端切会话」该付的代价；
「切过去之后发的那句落对会话」由 B 层按字节钉住（真落库、真分片）。

## 三、A 层证据（默认跑）

`desktop/session_gui_test.go`，`go test ./... -run 'TestDesktopSession|TestDebug'`：

```
--- PASS: TestDesktopSessionSwitchListCreateSendAndCaches (0.08s)
--- PASS: TestDesktopSessionPaneWaitsForTheCapabilityProbe (0.00s)
--- PASS: TestDebugBusHasNoSessionActions (0.00s)
--- PASS: TestDebugSocketHasNoSessionAction (0.04s)
--- PASS: TestDesktopLateTimelineFromAnotherSessionDoesNotOverwriteTheView (0.07s)
```

`TestDesktopSessionSwitchListCreateSendAndCaches` 一条走完五步，断言如下（都是真发出去的请求）：

| 步 | 动作 | 断言 |
| --- | --- | --- |
| 1 列 | 启动 `refresh()` → 能力位先验 | `GET /api/mobile/sessions` **恰好一次**；`s.sessions == [main work]`（`main` 恒首位）；左栏真画出 `main` 与 `work` 两个字 |
| 2 切 | `tt.Click("work")`（点左栏那一段） | `s.currentSession == "work"`、`s.client.ActiveSession() == "work"`；出现 `GET /api/mobile/timeline?session_id=work`，且该请求 `x-crew-session: work`（与 query 同值） |
| 3 发 | 输入框写一句 → `tt.Click("↑")` | `POST /api/mobile/send?session_id=work`，头 `x-crew-session: work`，body 含那句正文；**没有**任何 `/api/mobile/send` 不带 `session_id` |
| 4 落对 | 读假队伍那一侧的库 | `work` 时间线 2 条（原 1 + 新 1），`main` 仍 2 条 —— 这一句没串到 main |
| 5 缓存 | 点回 `main`，再比对两段缓存 | `main` 的消息仍是 `主线第一句`；`work` 的缓存指针没被换掉，仍是 `工作线第一句`；`s.conversations["work"]` 与切走前同一份 |
| 6 建 | `sessionDraft = "beta"` → `tt.Click("新建")` | 恰好一次 `POST /api/mobile/sessions`，body 逐字 `{"id":"beta"}`，**不带** `session_id`（名单管理不是会话读写）；名单刷成 `[main work beta]` 并切到 `beta`，随后发 `GET /api/mobile/timeline?session_id=beta`；草稿清空 |

`TestDesktopLateTimelineFromAnotherSessionDoesNotOverwriteTheView` 是桌面端切会话最容易串的一处：
`work` 的时间线卡在服务端 → 切回 `main` 让 `main` 先落地 → 再放 `work` 回来。
断言：当前视图仍是 `main` 那份（2 条、首条 `主线第一句`），迟到的 `work` 只落进 `s.conversations["work"]`（1 条、`工作线第一句`）。

`TestDesktopSessionPaneWaitsForTheCapabilityProbe` 钉住门禁：先验没回来之前左栏一个会话字都不画，且**零请求**。

## 四、B 层证据（`CREW_REAL_GW=1`）

```
$ CREW_REAL_GW=1 go test -run TestDesktopSessionShardingAgainstARealGateway -v ./...
--- PASS: TestDesktopSessionShardingAgainstARealGateway (0.14s)
```

起的是**自己的一支** mobilegw（`MOBILEGW_STATE`=mktemp 目录、端口随机、`127.0.0.1`），跑完 `Kill` + `Wait`；
生产 8788 / 43499 一次都没连，生产 `mobileq.db` 一个字节都没读。

| 步 | 断言 |
| --- | --- |
| 路由归属 | 网关上的 `GET /api/mobile/sessions` → **404**（名单在消息面，不在网关；桌面端据此判老后端锁 main） |
| 分片 | `/timeline` 回显 `session_id: main`，`/timeline?session_id=work` 回显 `session_id: work`；两者都带 `session_api: 1` |
| 落库 | `/send?session_id=work` 一条、`/send`（老路径，不带任何会话字段）一条 → 队列分布 **work:1 / main:1** |
| 不串 | `work` 的时间线含「属于 work」且**不含**「属于 main」；`main` 反之 |
| header 形态 | 只带 `x-crew-session: work`、不带 query 发一句 → 分布变成 **work:2 / main:1**（header 形态在同一支真网关上成立） |
| 冲突 | query `main` + header `work` 同时给 → **400**，且分布仍是 work:2 / main:1（被拒的请求没落库，不猜哪个算数） |

## 五、C 层证据（`CREW_REAL_LAN=1`，只读）

```
$ CREW_REAL_LAN=1 go test -run TestDesktopSessionAgainstTheLivePhoneSurface -v ./...
真实消息面 http://127.0.0.1:43499 的会话名单：[main work]（缺省 main）
work 会话：1 条消息，queued 0 条
main 会话：58 条消息，queued 0 条
--- PASS: TestDesktopSessionAgainstTheLivePhoneSurface (0.02s)
```

同一时刻队列侧（`~/.dsh/state/superagent/mobileq.db`）：

```
messages: main 43（其中 1 条 withdrawn，可见 42）/ work 1        replies: main 16
```

口径对得上：`main` 的 timeline 58 条 = 42 条可见消息 + 16 条回复；`work` 的 1 条 = 1 条消息 + 0 条回复，
正是手机端那半验收时经 LAN 门发的那句。两段会话各自读各自的，**没有一条 message id 交集**（测试逐条比对 id）。
手机端那半的结论（`main` 37 / `work` 1 互不串）与这里一致；`main` 从 37 长到 42 是之后别的会话在真机上的验收消息，不是串线。

## 六、没做的事（如实标注）

- **没有**起 GUI 窗口看左栏实际长相。起窗口会抢焦点，与本轮「不抢鼠标、不聚焦窗口」的硬约束冲突；
  界面上那一段由 `ui.NewTester` 离屏渲染整扇窗（1440×900）+ `tt.Click("work")` / `tt.Click("新建")` / `tt.Click("↑")` 驱动，
  点击走的是 mygo 真实的命中测试（`targetCenter` 会校验指针是否真落在那个控件上），不是直接调函数。
- **没有**用 `osascript` / `cliclick` 点任何东西（约束）。
- **没有**验证手机端那两道门 —— 那半已完成，本轮不重复。

## 七、改动文件

| 文件 | 改动 |
| --- | --- |
| `desktop/session_gui_test.go` | 新建，837 行，7 个用例 + 夹具（假队伍、真网关、socket、队列统计） |
| `docs/PHASE_DESKTOP_SESSION_CHECK.md` | 本报告（新建） |

`desktop/client.go` / `desktop/ui.go` / `desktop/debug.go` **未改**（本轮没有发现真 bug）。
