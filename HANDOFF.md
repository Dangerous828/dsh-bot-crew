# 交接：dsh-bot-crew 当前状态

> 写于 2026-11-10。分支 `feat/four-blocks`，最后提交 `61c0997`，**69 个文件未提交**。
> 本文只写当前状态与下一步，不写新旧对比。

## 一、这是什么

四个可独立起停的块，都在 `~/Code/dsh-bot-crew/`：

| 块 | 技术 | 状态 |
|---|---|---|
| `backend/` | TypeScript（DSH/Cordis 插件） | 1391 tests / 75 files 全绿，tsc 0 错 |
| `desktop/` | Go + `github.com/egoist/mygo` v0.8.3 | go vet + go test 通过，**交互有缺口** |
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
1. **左栏四个导航项全是死的**：`▤ 后台` / `◐ 模型` / `▢ 产出` / `◷ 常规任务`，`desktop/ui.go:230-260` 附近，没有一个有 `OnClick`。
   - 「后台」应该就是右栏三标签那块的聚焦/展开
   - 「模型」应该能切模型（后端接口 `switchModel` 已有，见 `backend/src/app/work.ts`）
   - 「产出」「常规任务」目前后端没有对应数据，要么做成明确的空态，要么先不摆
2. **右栏工单卡整体不可点**：只有标题文字有 `OpenWork` 入口，卡片本体是死的。
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

1. **桌面左栏四个导航项接上点击**（后台/模型/产出/常规任务目前全没 `OnClick`）
2. **右栏工单卡本体接上点击**（现在只有标题行可点）
3. 手机暗色主题过一遍图
4. 桌面空态 / 断连两张画板
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
