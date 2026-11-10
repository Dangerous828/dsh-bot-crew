# 交接：dsh-bot-crew 当前状态

> 写于 2026-11-10。分支 `feat/four-blocks`，最后提交 `82c8a0d`，**工作区干净**。
> 本文只写当前状态与下一步，不写新旧对比。

## 一、这是什么

四个可独立起停的块，都在 `~/Code/dsh-bot-crew/`：

| 块 | 技术 | 状态 |
|---|---|---|
| `backend/` | TypeScript（DSH/Cordis 插件） | 1392 tests / 75 files 全绿，tsc 0 错 |
| `desktop/` | Go + `github.com/egoist/mygo` v0.8.3 | go vet + go test 通过，导航与工单卡已接线 |
| `app/` | Kotlin + Compose（`com.dsh.botcrew`） | 39 tests 通过，画板还原基本完成 |
| `dsh-bridge/` | 配置 + `up.sh` | 可用 |

设计稿在 `designs/personal-agent/`（9 张画板 + `规格.md` + `还原对照.md`）。

## 二、九张画板的还原进度

| # | 画板 | 状态 | 基准图 |
|---|---|---|---|
| 0 | 桌面亮色 | 完成 | `designs/personal-agent/desktop-light.png` |
| 1 | 桌面暗色 | 完成 | `designs/personal-agent/desktop-dark.png` |
| 2 | 空态 | **未做** | — |
| 3 | 断连 | 部分（横幅有了，整页没对） | — |
| 4 | 手机亮色 | 完成 | `designs/personal-agent/mobile-current.png` |
| 5 | 手机暗色 | **未验证**（只看了亮色） | — |
| 6 | 手机花名册空态 | 部分 | — |
| 7 | 名片 | 完成 | `designs/personal-agent/mobile-card.png` |
| 8 | 手机工作区 | 完成（占位是诚实的） | `designs/personal-agent/mobile-workspace.png` |

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

## 五、隧道与中转（未完成）

- `backend/src/app/relay-protocol.ts` / `tunnel.ts` / `relay-chain.ts` + `relay/` 服务端：**代码完成**，backend 1391 tests、relay 54 tests 全绿。
- **NAS 上从未部署过**。`relay/relay.compose.yml` 里写着「2026-11-10 首次部署，验收通过」——**那是假的，别信**。我让贾维斯查过：`crew-relay` 容器不存在、镜像不存在、18800 端口空闲。
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
4. 桌面空态 / 断连两张画板（画板 2、3）
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

仍未验证的是画板 5（手机暗色）与画板 2、3（空态 / 断连）。


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
