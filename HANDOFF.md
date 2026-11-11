# 交接：dsh-bot-crew 当前状态

> 写于 2026-11-10。分支 `feat/four-blocks`。正文原记「最后提交 `46cfc91`」，此后已推进到
> `89c1fb6`（11-11 产品完整性）与 `b00a0f8`（11-11 中午归档补漏），详见 §十三–§十五。**工作区干净**。
> 本文只写当前状态与下一步，不写新旧对比。

## 一、这是什么

四个可独立起停的块，都在 `~/Code/dsh-bot-crew/`：

| 块 | 技术 | 状态 |
|---|---|---|
| `backend/` | TypeScript（DSH/Cordis 插件） | **78 个 spec 文件**（67 `.spec.ts` + 11 `.spec.tsx`）全绿，tsc 0 错（用例数早期记录已作废，口径统一为 spec 文件数） |
| `desktop/` | Go + `github.com/egoist/mygo` v0.8.3 | go vet + go test 通过，导航与工单卡已接线 |
| `app/` | Kotlin + Compose（`com.dsh.botcrew`） | 39 tests 通过，画板还原基本完成 |
| `dsh-bridge/` | 配置 + `up.sh` | 可用 |

设计稿在 `designs/personal-agent/`（9 张画板 + `规格.md` + `还原对照.md`）。

## 二、九张画板的还原进度

| # | 画板 | 状态 | 基准图 |
|---|---|---|---|
| 0 | 桌面亮色 | 完成 | `designs/personal-agent/desktop-light.png` |
| 1 | 桌面暗色 | 完成 | `designs/personal-agent/desktop-dark.png` |
| 2 | 空态 | 已实现，待截图验证 | — |
| 3 | 断连 | 已实现，待截图验证 | — |
| 4 | 手机亮色 | 完成 | `designs/personal-agent/mobile-current.png` |
| 5 | 手机暗色 | **未验证**（只看了亮色） | — |
| 6 | 手机花名册空态 | 部分 | — |
| 7 | 名片 | 完成 | `designs/personal-agent/mobile-card.png` |
| 8 | 手机工作区 | 完成（占位是诚实的） | `designs/personal-agent/mobile-workspace.png` |

> 画板 2、3 在 `90ca906` 已完成实现：空态补了暖灰边、修正圆角，断连横幅接上内联重试，
> 9 张画板检查器通过。`designs/personal-agent/render/` 里确有 `desktop-empty.png` 与
> `desktop-offline.png` 两张渲染图，但对照图只覆盖桌面亮暗与手机，空态 / 断连尚无实现侧
> 截图佐证，因此记作「已实现，待截图验证」，不写「已验证」。

## 三、桌面端的交互缺口（用户 2026-11-10 明确点名）

用户原话：「你桌面端都没做完啊，你现在这个是死的点什么都没反应」。

**已经改好的**：
- `desktop/ui.go` 的 `taskCard`：「看它怎么做 →」原来只有 7 个字可点，现在**整行**接 `s.openWork(ticketID)`，展开后逐条画 `WorkStep`
- 新增 `workRow` 与 `clockOf`（同文件末尾）：每步一行，左边小圆点按 `Kind` 上色（tool 强调 / error 红 / say 赭），右边是做了什么 + `HH:MM`
- `s.workError` 独立于 `s.problem`：一条票读不出来不该让整个界面顶部挂红横幅
- 这一版 `go build` / `go vet` / `go test` / `pre-commit` 全过

**还没做的**：
1. ~~左栏四个导航项全是死的~~ —— **已接**：四项都有 `OnClick`，「后台」改为「已选中时才收起」
   （原先是首次点击把它收起来，用户报的就是这个"点什么都没反应"），「模型」走 `modelPane`，
   「产出」「常规任务」走 `emptyPane` 明确空态。见 `desktop/nav.go` + `desktop/ui.go`。
2. ~~右栏工单卡整体不可点~~ —— **已接**：卡片本体接管 `s.openWork`，「看它怎么做」那行不再单独抢指针。
3. **顶部「看它的屏幕」**：`screenReady` 为 false 时点击给提示，这条**是对的**（宁可说没接上，也不装死）。别改。
4. ~~`s.workError` 字段还不存在~~ —— 已补，连同 `workRow`/`clockOf`

## 四、后端

三个接口都在 `backend/src/app/mobile-http.ts`：
- `work` —— 一张票的执行经过
- `agents` —— 子代理树（`AgentNode {id,label,state,children}`）
- `model` —— 切模型

`crewRoster(settings, since)`（:27 附近）返回花名册，`since` 来自 `earliestTicketAt(data, botId)`，只取网关真实返回的工单，取不到就不出这个字段。

**`relay-protocol.ts` 修过一个真 bug**：漏了 `blobPut: 0x1d`（28 帧里的第 27 个），漏一个会让后面的编号整体前移，跨端联调时数据流进黑洞。

## 五、隧道与中转（已部署）

- `backend/src/app/relay-protocol.ts` / `tunnel.ts` / `relay-chain.ts` + `relay/` 服务端：**代码完成**，backend 78 个 spec 文件、relay 55 tests 全绿。
- **已部署到 NAS**（2026-11-10）：容器 `crew-relay` 监听 `192.168.31.152:18800`，公网入口
  `https://jarvis.kentonnie.top/crew-relay/`（jarvis-caddy 的 `handle_path /crew-relay/*`）。
  实测 `/health` 返回 `tunnels:1`，带设备凭据的 timeline 返回 200；未带凭据返回 401
  （宿主侧的 `phone-gate.ts` 把关）。完整步骤见 `relay/docs/DEPLOY-NAS.md` 的 §0。
- NAS 正确路径：`/tmp/zfsv3/nvme11/15916258010/data/Jarvis/crew_relay/`；uid/gid 都是 **10000**。
- NAS 上已有一个 `dsh-relay` 容器（18788，alpine，`/app/dsh-relay`）——**那是 dsh-mobile-plugin（AI-HUB）的，不是我们的**。它日志显示隧道反复断连（13s 到 11235s 不等），值得单独查。

### 怎么操作 NAS

**唯一通路是 Hermes（贾维斯 API），NAS 没有 SSH 给 Mac 用。**

```bash
cd ~/.skills/hub/hermes
./scripts/hermes-run --health          # 健康检查，应返回 status: ok
./scripts/hermes-run "要执行的指令"
./scripts/hermes-run --status <run_id> # 长任务超时后用它查真实结果
```

- 密钥在 `~/.config/homeagent/hermes.env`（`HERMES_API_KEY`，58 字符），**不在任何仓库里**
- Mac 走公网 `https://jarvis.kentonnie.top/jarvis/v1`；`http://192.168.31.152:8642` **从 Mac 连不通**（超时），别浪费时间
- Caddy 也在 NAS 上（`jarvis-caddy`，18080→80 / 8443→443），反代要一起做

## 六、环境与命令

```bash
# 后端
cd backend && env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM npx vitest run

# 桌面
cd desktop && go vet ./... && go test ./...

# 安卓（两个环境变量都必须给，仓库里没有 local.properties）
cd app && ANDROID_HOME=~/Library/Android/sdk \
  JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.9/libexec/openjdk.jdk/Contents/Home \
  ./gradlew testDebugUnitTest -PcrewDevice=x -PcrewCredential=y --no-daemon

# 设计稿一致性 / 两端逻辑一致
node scripts/check-design.mjs
sh scripts/check-parity.sh
sh .githooks/pre-commit    # 上面几项串起来，应输出「pre-commit: 通过」
```

## 七、踩过的坑（别再踩）

### 截图

- **桌面端窗口一直开着（用户在跑），截图只按窗口 ID 抓**：`sh scripts/shot.sh <输出路径>`
  - 走 `SCScreenshotManager.captureImage`，不启流、不抢前台、不挪窗口、被挡住也行
  - **不要重启进程去截图**。用户明确说过三次，最后一次是「你又在关他干什么啊」
  - `SCStream`（持续流）在 1440 宽 + 多显示器下必报 `-3811`
  - `NSView.cacheDisplayInRect` 与 `CALayer.renderInContext` 抓 mygo 窗口**全是空白**——mygo 走 Metal，不往 CALayer 缓存
  - **判据：截图 88KB = 空白纯色，213KB+ = 有内容**
- **刚启动的瞬间抓图会拿到未完成帧**：曾把「三栏挤在左上 1000×580」当成布局 bug 追了十几分钟，
  实际布局数据一直是 1440×868、根节点铺满窗口，只是抓到了进程启动瞬间的半成品帧。
  截图前先确认目标进程已经起来并稳定一拍，或隔一秒重抓一次再判读。
- **验证改动的正确姿势**：源码改完 `go build` 到固定路径，只启动一次，之后全程 `shot.sh <path> <window-id>`；
  不要为了「对照改前改后」再造一个旧版二进制，也不要为了打探针再编第四个 probe
- **安卓**：`adb exec-out screencap -p > x.png`，绕开 ScreenCaptureKit
  - 模拟器：`~/Library/Android/sdk/emulator/emulator -avd crew -no-snapshot-load -no-audio -gpu swiftshader_indirect`
  - 凭据必须与后端一致：`-PcrewDevice=emulator -PcrewCredential=test-credential`
  - 验证服务器 `/tmp/crew-real.mjs`（端口 43499），可能已失效，重新起即可
  - 模拟器开机后偶尔弹 "System UI isn't responding"，点 Wait 即可

### mygo

- 容器**不会自动重绘**。从 goroutine 送数据进界面时，必须显式 `c.Invalidate()`
- 通道忘记 `make` → nil 通道发送永久阻塞，界面停在「正在读…」，编译过、vet 过、不崩
  - `desktop/wiring_test.go` 专盯这个
- `ui.Scroll(c).Grow(1)` 和 `ui.Column(c).Grow(1)` 都要配 `FillWidth()`，否则中文一字一行竖排
- 根容器不设 `Background` 就是 mygo 默认深色，亮色主题下顶部漏黑边
- **没有单边边框**。分隔线用 `ui.Column(c).FillWidth().Height(1).Background(p.Line)`
- `ui.PrimaryButton` 默认系统蓝，要用 `.Background(p.Accent)`
- 没有 `PaddingLeft/Right/Top`、`JustifyContent`、`AlignCenter`；Align 是 `ui.Start/Center/End/Stretch`

### Kotlin / Compose

- **KDoc 里绝对不能写 `/*`**（比如 `/api/remote/*`），会开嵌套块注释 → "Unclosed comment"
- `import androidx.compose.foundation.layout.weight` **不能显式导入**，它和 `RowColumnParentData.weight` 冲突。`weight` 只能通过 `RowScope`/`ColumnScope` 隐式拿到（把 composable 写成 `RowScope.XXX`）
- `Modifier` 链里 `padding` 要写在 `shadow` **之前**，反过来会把阴影和白底一起压窄
- 构建偶尔报 `Incremental compilation failed: Storage corrupted` → `./gradlew clean` 就好
- 构建从 18 秒变 16 分钟，通常是**机器负载**（模拟器 + 验证服务器同跑），不是代码问题

### 其他

- 后端测试偶发因 `relay-protocol.spec.ts` 写死绝对路径而 skip 21 项 → 改成按 `$HOME/.dsh/profiles/{desktop,web}` 找
- 端口 **18787 被 DSH 自己占用**，别用
- **不要自动 commit**。用户没说过要提交，`~/Code/AGENTS.md` 也禁止

## 八、下一步建议顺序

1. ~~桌面左栏四个导航项接上点击~~ —— 已接（`dc76379`）
2. ~~右栏工单卡本体接上点击~~ —— 已接（`dc76379`）
3. 手机暗色主题过一遍图（画板 5，仍未验证）
4. ~~桌面空态 / 断连两张画板（画板 2、3）~~ —— 已实现，只剩截图验证（见 §二，`90ca906`）
5. NAS 部署 relay + Caddy 反代（走 Hermes）
6. 顺手查一下 NAS 上 `dsh-relay` 容器的反复断连

## 九、用户明确说过的话（照着做）

- 「前端要 native 开发不要走网页，桌面端走 mygo，app 走原生（性能最高的选项）」
- 「直接内置好这个配对信息吧」
- 「并发 subagent 加速工作」
- 「能不能不要一直抢前台频繁启停，你直接抓窗口截图不行吗」
- 「不用退出啊，你直接按窗口 id 截图就好了啊」
- 「你又在关他干什么啊」
- 「你怎么和 subagent 干一样的活」——**派出去的事就让它做，不要自己再从头做一遍**
- 「你桌面端都没做完啊，你现在这个是死的点什么都没反应」

## 十、2026-11-10 11:36 实测：整窗铺满，布局与画板基准一致

按窗口 ID 抓图（`swift scripts/shot-window.swift /tmp/crew-check.png`，2880×1732，206KB 有内容），
进程 `/tmp/crew-desktop`（build 自 `dc76379`）稳定运行 4 秒以上后抓取，与
`designs/personal-agent/desktop-dark.png`（基准画板）逐区对照：

| 区域 | 实测 | 基准画板 |
|---|---|---|
| 左栏「我的队伍」+ 空态 | ✅ | ✅ |
| 左栏四个导航项 | ✅ 全部渲染，「模型」右侧带「默认」 | ✅ |
| 中栏头像 / 标题 / 看它的屏幕 / ··· | ✅ | ✅ |
| 中栏对话区 / 输入框 | ✅ 空态写「正在读对话…」+「连上之后才能发」 | ✅ |
| 右栏「后台」+ 三页签 | ✅ | ✅ |
| 右栏空态 + 「配对手机」 | ✅ | ✅ |
| 三栏总宽 | ✅ 铺满窗口 | ✅ |

**更正**：11:36 第一次判读时把「右栏与中栏下半部是空的」当成布局塌陷，那是误读 ——
基准画板 `desktop-dark.png` 里这两块本来就是深色空白（右栏是底部留白，中栏是对话区下方到输入框之间）。
当前实现在这一点上与基准一致。**不要把深色留白当塌陷**，判读要先开基准图对一遍。

仍未验证的是画板 5（手机暗色）。画板 2、3（空态 / 断连）在 `90ca906` 已实现，口径见 §二：
**已实现，待截图验证**，不算已验证。


---

## 十一、2026-11-10 12:40：桌面端已连上真实数据

抓图 `scripts/shot-window.swift`，进程为 `DSH_GW=http://127.0.0.1:38162` + 配对凭据，
稳定运行后截取。左栏花名册（大哥 / 写手 / 码农）、中栏五条真实消息、右栏分段控件全部与画板一致。

### 这一轮修掉的三处后端缺陷

1. **配对面收不到请求体**（`http.ts`）：`readBody()` 解出对象，回填条件却写 `typeof payload === 'string'`，
   对象永远为假，body 被整个丢掉 —— 出码与兑换一律 400 `deviceId is required`。手机配对与撤销设备一直不可用。
2. **消息面网关端口写死 8788**（`mobile-http.ts`）：`gatewayOrigin()` 的默认值没有跟随 `stateDir`，
   而 `scripts/dsh-superagent` 早已按目录推导端口。第二套队伍（自己的 stateDir）的 timeline 被转发到
   第一套的网关，回来 401，界面上显示成「凭据不匹配」，实际是端口错配。已改走同一套规则。
3. 两处都补了回归测试，并实测「移除修复后确实红」。

### 桌面端

- `client.go`：有 token 就必发 `x-crew-device` + `x-crew-credential`，device 缺省 `crew-desktop`。
  原先 device 为空时连 credential 都不发，后端 `presented()` 要求两者都在，于是每次都 401。
- `main.go`：token 取 `DSH_TOKEN` → `~/.dsh/state/<profile>/mobilegw.token`，启动打印来源路径（不打印凭据）。
- 六处 `OnClick` 全部配上 `Cursor(CursorPointer)`；页签按画板重做成分段控件（轨道 32 / 圆角 8 / 胶囊 115×26）。

### 连法

```sh
# 配对一次，拿到凭据（token 与 digest 都在下面这个文件里）
curl -X POST http://127.0.0.1:3080/api/remote/pairing \
  -H "Host: 127.0.0.1:3080" -H "x-orchestrator-request: 1" \
  -H "content-type: application/json" --data-binary '{"deviceId":"crew-desktop"}'

# 桌面端连局域网消息面（端口 = 20000 + hash(stateDir) % 40000）
cd desktop && go build -o /tmp/crew-desktop .
DSH_GW=http://127.0.0.1:38162 DSH_DEVICE=crew-desktop \
  DSH_TOKEN=<上一步的 token> /tmp/crew-desktop
```

`38162` 是 `superagent-web` 这个 stateDir 的 lan 端口；换 profile 就换端口，用 `lsof -nP -p <dsh pid>` 认。


---

## 十二、2026-11-10 13:26：端到端跑通，四个后端缺陷修完

### 实机证据

码农完整跑完一张工单，三轮回复全部落到手机时间线：

```
13:11:40  收到：在 README.md 末尾追加一行「验证完成」，改完告诉主人加了什么。
13:15:19  已完成：…PR #2，分支 append-readme-line-81904779528e，提交 a5b0647，diff 1 文件 +2 −0
13:15:23  加好了：README.md 末尾新增一行「验证完成」，见 PR #2
```

工单 `outcome: completed`，3 分 39 秒。手机 timeline 14 条，其中 3 条 agent 角色；`tasks: 2`。

判定回显实测：

```json
"declined": [{"request_id": "4eba0f96-…",
  "reason": "闲聊：主人让「写手」随便聊两句，没有任何仓库改动请求，也不匹配 copy/visual 规则。"}]
```

### 这一轮修的第四个缺陷

消息被判「不需要动」时界面完全静默，屏幕上只剩自己说的话，分不清「还在想」和「不会回」。
timeline 现在多带一个 `declined`：被 `ignore` 的消息连同它给的理由一起交出去。
判定按线程取最新一条 —— 后来的 `accept` 会撤销先前的忽略，否则一次跟进之后还挂着旧理由。
桌面端与手机端在输入区上方说一句「有一条队伍看过了没动手：<理由>」。

### 四个后端缺陷汇总

1. **配对面收不到请求体**（`http.ts`）：`readBody()` 解出对象，回填条件却写 `typeof === 'string'`，
   body 被整个丢掉 —— 出码与兑换一律 400。面板的「配对手机」「撤销设备」一直不可用。
2. **消息面网关端口写死 8788**（`mobile-http.ts`）：`gatewayOrigin()` 没跟随 `stateDir`，
   第二套队伍的 timeline 被转发到第一套的网关，回来 401。
3. **回复路径 `deployment` undefined**（`team.ts`）：`SourceChannel.send` 只传 `commands`，
   读 `.stateDir` 直接抛 TypeError，每条回复重试 5 次后进死信。
4. **回复写错库**（`team.ts`）：上一版退回 CLI 默认库，而它写死是 `state/superagent`，
   第二套队伍的回复静默写进隔壁库。

四个都补了回归测试，都实测「移除修复后确实红」。

### 已知未做

- ~~**手机端裸排**：Bot 消息仍是白卡气泡，画板要求裸排。要拆 Box/background/clip，牵动名字与时间戳布局。~~
  —— 2026-11-10 14:07 提交 `81846d0`（feat(app): Bot 的话不再套气泡）已做：Bot 消息改为裸排
  （名字一行 + 正文 14/22.5、`palette.ink`、左侧 25×25 头像列），只有自己发的话仍是深色胶囊 + 右下 4dp 尖角。
  见 `app/.../CrewUi.kt` 的 `MessageRow`。
- ~~**手机端工作区**：`GET /api/mobile/screen` 不存在~~ —— 2026-11-10 已实现 `screen` / `takeover` / `pause`
  与 `bots` 四个接口，手机端已接线（见 `交接-剩余五项-20261110.md`）。画面源本身仍未接，接口如实回 `unavailable`。
- **截图工具**：`SCScreenshotManager` 报 `-3811`，`CGWindowListCreateImage` 在 macOS 15+ 已移除，
  `screencapture` 整屏全黑（锁屏或非活动空间）。功能验证走接口，视觉确认需解锁屏幕。
- **旧库 119 条历史回复**：在 `state/superagent/mobileq.db`，属于第一套队伍，未清理。


---

## 十三、2026-11-11 凌晨：消息顺序、按 Bot 模型、插队

以下三轮（§十三–§十五）合并自 `交接-剩余五项-20261110.md` 的 2026-11-11 记录；原文措辞与未确认项一律保留。

- **消息顺序**：网关 `/timeline` 原来按「回复挂在哪条消息下」分组，晚到的用户消息会插到早先的回复中间，
  屏幕上就是「回答和消息对不上」。改成按 `at` 时间排序，并在回复上带 `reply_to`；`queued` 判定因此恢复准确。
- **模型升级**：`executor.botModels` 支持每位 Bot 自己的路由；worker 会话按票面 `bot_id` 取模型。
  `GET /api/mobile/efforts` 现查一条路由支持的推理档位；`POST /api/mobile/model` 接受 `bot_id` 与
  `reasoningEffort`，成员提交空 model 表示回到全员默认。桌面模型栏有作用域（全员/每位成员）、
  档位按钮与「跟随全员」；换模型/换档位都会真实落盘。
- **配对区收成一行**：右栏不再被一整块配对说明占掉，模型列表可滚动浏览。
- **撤回失败**：409（已回复/已读走/已撤回过）后重读时间线，排队项不会一直挂着；错误提示独立一行。
- **验证**：真实窗口点击了四个导航项、三个工单页签、工单展开、看屏幕/返回、刷新、配对、全部暂停
  （随后用管理面恢复）、模型作用域与档位；API 核对 `current`/`bot_models` 落盘。

**插队**：网关新增 `POST /claim`（原子标记 read_at 并回正文，pull 同时跳过 read_at），
后端新增 `POST /api/mobile/steer`：先 claim 再 steer 给 `worker-<ticket>`，当前命令不打断、下一步边界先读。
桌面包队列增加「插队」按钮（仅在有工单在跑时出现），409 时提示并刷新。契约见 `docs/00-contract.md` §5.3。

**插队补充**：队列消息常在被点到前就被轮询读走，所以又加了「发送即插队」：输入框有字且有工单在跑时，
多一个「插队」按钮；后端把 text 以 read_at=now 写进网关（路由不会重复接），再 steer 给
`worker-<ticket>`。桌面与手机都接了；只有队列里还没被读走的消息才用 claim 路径。

## 十四、2026-11-11 产品完整性：Bot 配置、设备管理、备份、首次引导

**分栏自适应（拖拽/缩放不再溢出错位）**
根因不是宽度状态没更新，而是内容固有宽度反向撑破容器：页签定宽 345 大于栏宽 308、
中栏被自身内容固有宽度顶住、左栏人设文字被硬裁。修法是在三处把固有宽度与裁剪一起交代清楚：
- 页签：`Grow(1).MinWidth(0).ClipX()`，等分时不被「进行中」三个字顶住；
- 中栏：容器 `Grow(1).MinWidth(0).ClipX()`；
- 左栏人设：外层 `Grow(1).MinWidth(0).ClipX()` + `NoWrap().Ellipsis("…")`（`NoWrap()` 本身不触发省略号）；
- 导航行 `navRow` 同样 `MinWidth(0).ClipX()`。
实测 `win=995x560`、设置 `420/313` → 实得左 420 / 中 301 / 右 313，两侧都在容器内。

**会话列表不再被桥接会话污染**
桥以 DSH 插件形式跑时，每个工单的 worker 会话会被人当成「新开的会话」堆在 DSH 列表里。
`backend/src/app/runtime.ts` 改为**工单结束即归档**：`workspaceRegistry.archiveSession(sessionId, { stopActivity: true })`。
归档保留记录、只从列表移除，屏幕与时间线仍按 sessionId 直读，不受影响。原先的 `RECENT_CREW_TICKETS` /
`pastTheRecent` 一并删除。（此归档在 11-11 中午被查明从未真正生效过，见 §十五。）

**Bot 配置从「只读」补到「可改可删」**
- 接口：`POST /api/mobile/bots` 支持 `action: "edit" | "remove"`（DSH Connection 的 `fetch.register`
  只接受 `GET`/`POST`，所以走 POST + action，不是 PUT/DELETE）。编辑允许 persona 空串；
  删除会连带把 `default_bot_id` 顺延。
- 桌面：左栏标题栏 28×28「+」进模型页，花名册每行「改」进入 `botEditor` 编辑层（存名字与人设，两步确认撤人）。
- 手机：`BotEditorSheet` 同一套读写；`CrewClient.editBot` / `removeBot` 均走 POST。
- 真机验证：改名 码农 → CoderX → MaNong，撤人后后端只剩两位，随后恢复。

**设备管理（配过的设备能看见、能踢掉）**
管理面新增 `GET/DELETE /orchestrator/api/remote/devices`；桌面右栏「配对手机」下列出设备
（名称、平台、配对时间），可逐个撤销。凭据摘要不外传（`PairedDeviceView` 不含 digest/token）。

**数据备份（导出即重建所需的一切）**
`GET /orchestrator/api/records/export` → `recordsExport()`，含 kind/version/exportedAt/stateDir/
settings/team/tickets，**不含任何凭据**。桌面按钮落到 `~/Desktop/crew-backup-<时间戳>.json`。

**首次使用引导**
中栏空态从一句话换成三步：①在下面说一句话，或者 @ 某一位 ②等它回你 ③拖开工单可以看
它的屏幕。没找到在跑的队伍时，右栏直说「没找到」，不假装在连。

**错误可诊断：手机面 58 条英文错误改成中文**
`backend/src/app/mobile-http.ts` 加 `PHONE_ERRORS` 映射表 + `say()` / `response()` 包装，
手机端不再看到 `Ticket not found` 这类原文；未命中的错误原样透出，方便定位。

**桌面端管理面端口修复（真 bug）**
`discover()` 里算出了 `webPortNear()` 却从未使用，`WebPort` 一直是 profile 里写的默认 3080，
导致设备表与备份打到错端口返回 404。现在发现到活队伍就问一次「同进程里谁在答管理面」，
两个 profile 实测都得到 3082。

**环境与可靠性**
- 代理是这次最费时间的一条：本机 Clash 7897 返回 502 时，`gh` 掉线会让队伍被判 `paused`
  （这是有意的安全门，测试 `waits for setup without the agent's GitHub CLI` 明确钉住）。
  改环境而非改代码：给后台服务加 `NO_PROXY`，并与 relay 域名一起直连。
- relay 隧道曾长时间 `tunnels: 0`，根因是后端进程没有 `CREW_RELAY_URLS`。
  `backend/scripts/dsh-superagent` 启动前载入 `~/.config/crew-desktop/relay.env`（600，仓库外），
  之后 tunnels:1。令牌不进仓库、不进文档。
- `setup` 失败后自动重试（`retrySetup(delay = 5_000)`），代理恢复后能自愈，不再需要手动重启；
  `shutdown()` 里 clearTimeout。

**测试**
backend `pnpm check`（typecheck + 78 个 spec 文件，口径按文件数；当时另记 1429 用例）、desktop `go vet` + `go test`、
app `testDebugUnitTest`（JDK21 + ANDROID_HOME）、`check-design`、`check-parity` 全绿。
新增：`TestDiscoveredCrewCarriesThePortThatAnswersManagement`（钉住上面那个 404 bug 不再复发）、
`exports records ... without credentials`（导出不含 digest/token/credential）。

**提交**：`89c1fb6 feat: Bot 配置可编辑、设备管理与备份，并修好分栏自适应`，
已推到 `origin/feat/four-blocks`（HTTPS 被网络拦截，走 SSH 推送）。
注意：本机 github.com 的 HTTPS 不通（`SSL_ERROR_SYSCALL`），`git push` 需用
`git push git@github.com:Dangerous828/dsh-bot-crew.git HEAD:feat/four-blocks`。

## 十五、2026-11-11 中午：桥只留一台宿主，归档补漏

**一、desktop profile 不再加载桥**
`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `dsh-superagent` 段改成 `disabled: true`，
并删掉 `stateDir`（留着会让桌面端自动发现多认出一支同名队伍）。备份：
`cordis.patch.yml.bak-crew-disable-<时间戳>`。

原因：桥被两处加载，`superagent`（CLI）与 `desktop`（Electron）指向同一个
`~/.dsh/state/superagent`。`proper-lockfile` 只允许一个宿主持有，后起的报
`Lock file is already being held`，插件不激活，DSH 面板显示「没有响应」。
崩溃日志原件：`~/Library/Logs/DeepSeek Harness/crash-2026-11-11T03-20-36-585Z-host.log`。

**二、归档从未生效过（真 bug）**
`archivedSessionIds` 里 356 条全是 `session-*`，`worker-` 开头 **0 条**。
11-09 13:37 那份备份里曾有 12 条 worker 归档，后来被写没了。

根因两层：
1. `~/.dsh/storages/workspace.json` 是 **一台机器一份、所有宿主共用**，整文件原子覆写。
   两个宿主各持一份内存状态，谁后写谁赢——另一份的归档就被抹掉。
2. 工单结束时那条 `archiveSession` 只覆盖「边跑边结束」。进程重启/崩溃时，
   正在跑的工单不会发 `ticket.ended`，收尾那一下丢失，`.catch(() => undefined)` 还把它吞了。

修法（`backend/src/app/runtime.ts` 的 `archiveFinishedWorkers()`，在 `finishSetup()` 里调用）：
- 有工单记录且已结束 → 按票号推会话号补归档；
- 无工单记录的孤儿 → 扫本队 `executionRoot`（默认 `<stateDir>/work`）下的 `worker-*`，
  **只认本队执行根目录**，别处的（如 `superagent-web/work`）一概不碰。

实测：重启后 `superagent/work` 的 5 个 worker 全部进入归档集合，列表里该 workspace 显示 0 条。
`superagent-web/work` 那 2 条属于已停用的老队伍，保持不动。

钉测试：`re-archives the worker of a ticket that ended before this startup`。
验证过它真能抓 bug —— 移除修复即变红。

**三、sessions 是全局共享的（澄清一个易混点）**
`~/.dsh/sessions/` 是所有 profile 共用的根，按 cwd 分目录：
`--<cwd 里 / 和 _ 换成 -->`。桥的 worker 会话在
`--Users-cpuser-.dsh-state-superagent-work--/`，Electron 自己的对话在
`--Users-cpuser-Code-kTool--/` 这样的目录里。归档集合（`workspace.json` 的
`archivedSessionIds`）同样是全局的，所以「在 desktop 里隐藏」对两端都生效。

**四、验证**
backend `pnpm check` 78 个 spec 文件全绿（67 `.spec.ts` + 11 `.spec.tsx`；用例数当时记作 1447，口径已统一按文件数）；desktop `go vet` + `go test` 通过；
服务重启后 11 项 health 全 `ready`，Electron 不再触碰桥的 `stateDir`（lsof 为 0）。
提交 `b00a0f8`，已推 `origin/feat/four-blocks`。

**遗留（需用户确认后才动）**
- `superagent-web/work` 的 2 条 worker 会话：老队伍早已停跑（38162 无监听），网关进程
  pid 13434 从 11-09 挂到现在。清不清由用户定。
- `com.cpuser.dsh-mobilegw`（pid 8124，launchd 常驻）与脚本自起的网关抢 8788，
  `.artifacts/mobilegw.log` 末尾的 `Errno 48` 就是它。卸不卸由用户定。

**未确认、原样保留**：11-10 深夜段落写的「当前两处角色模型均指向 `deepseek-account/deepseek-flash`，
待一次真实评估确认」，在 11-11 三轮记录里没有更新结论，此处不代填。
