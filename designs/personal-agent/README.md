# Personal Agent 设计稿

九张画板。亮暗两套配色、对话与后台、空态与断连。

## 稿子与代码的对照

改稿子前先看这张表：标「已实现」的改动要同步到代码，标「仅设计」的改动只活在稿子里。

| 画板 | 稿子里有什么 | 落到哪 | 状态 |
|---|---|---|---|
| `Desktop.dc.html` | 三栏：花名册 / 对话 / 后台 | `desktop/ui.go` 的 `roster`、`conversationPane`、`backendPane` | 已实现 |
| | 花名册每行分两截：人设 + 任务状态 | `desktop/ui.go` 的 `roster` | 已实现 |
| | 子代理卡（可展开，按层缩进） | `desktop/ui.go` 的 `agentRow` + `client.go` 的 `Agents` | 已实现 |
| | 等你决定卡（赭色） | `desktop/ui.go` 的 `taskCard` 按 `NeedsPerson` 着色 | 已实现 |
| | 后台失败态 + 重试 | `desktop/ui.go` 的 `taskCard` 按 `state == "failed"` 着色 | 部分：着色有，**重试没接线**（后端有 `POST tickets/:id/retry`，界面没调） |
| | 排队插话的可见状态 | `desktop/ui.go` 的 `composer` 读 `conversation.Queued` | 部分：只显示条数，**撤回没做**（见下） |
| | 「看它的屏幕」按钮 | — | 仅设计 |
| | 模型切换标签 | — | 仅设计：后端无切模型 UI 入口 |
| `Desktop-dark.dc.html` | 同一套结构，暗色 | `desktop/theme.go` 的 `DarkPalette`，`ThemeColors` 跟随系统 | 已实现 |
| `Desktop-empty.dc.html` | 队伍为空、后台 0 张 | `desktop/ui.go` 的空态分支 | 已实现 |
| `Desktop-offline.dc.html` | 断连横幅 + 重试 + 输入框禁用 | `desktop/ui.go` 的 `problem` 横幅与 `composer` | 已实现 |
| `Mobile.dc.html` | 配对屏（首次打开） | `app/.../PairingScreen.kt` | 已实现，**真机截图验证过亮暗两套** |
| | 队伍、对话、后台两屏切换 | `app/.../CrewUi.kt` 的 `CrewRoot` | 代码在，**未在真机连上后端** |
| | 子代理折叠卡 | `app/.../CrewUi.kt` 的 `SubagentCard` | 已实现 |
| | 等你决定卡 | `app/.../CrewUi.kt` 的 `TicketStrip` | 已实现 |
| | 排队条数 | `app/.../CrewUi.kt` 的 `Composer` | 部分：只显示条数，**撤回没做**（见下） |
| `Mobile-dark.dc.html` | 暗色 | `app/.../CrewUi.kt` 的 `DarkPalette` + `isSystemInDarkTheme` | 已实现 |
| `Mobile-roster.dc.html` | 队伍空态，加「队伍 / 后台」切换 | `app/.../CrewUi.kt` 的 `EmptyState` | 已实现 |
| `Mobile-card.dc.html` | 名片：人设全文、`bot/<id>`、最近工单、"跟他说话" | `app/.../CrewUi.kt` 的 `BotCardSheet` | 已实现 |
| `Mobile-workspace.dc.html` | 全屏工作区、接手操作、让它停一下 | — | 仅设计：需要后端暴露接管接口 |

## 稿子里还没落地的三块

- **看它的屏幕 / 全屏工作区**：要后端能转发 worker 的实时画面，现在没有任何接口。
- **排队消息的撤回**：`queued` 给了 request id，但 `tools/mobileq` 只有 pull / reply / thread / inject / outbox，
  没有撤回。要做就得动队列语义，还要回答「已经派出去的工单怎么收回」，那是独立的一块。
- **公网隧道**：局域网这条路已经通了（`/api/remote/enter` 只认凭据、不限来源，实测从 192.168.31.127 可达）。
  出门仍然连不上：那需要一台公网中转服务器，`dsh-mobile-plugin` 自己的 `relayUrl` 默认也是空的 —— 中转要自备。
- **后台的重试按钮**：后端 `POST tickets/:id/retry` 已经有了，两个客户端都没接。

## 客户端连哪个地址（重要）

| 端口 | 提供什么 | 凭据 |
|---|---|---|
| 网关（默认 8788） | 只有对话条目 `items` | `X-GW-Token`，就是 `mobilegw.token` |
| 插件消息面（DSH web 端口，本机 7862） | 对话 + 花名册 + 工单 + 状态 + 配对 | **DSH Connection 签发**，不是网关那份 token |

客户端必须连插件，否则花名册和工单永远是空的。但**插件那面要的是 DSH Connection 的凭据**，
现在两个客户端都只会发网关 token，所以真机上会 401。

实测证据：`curl POST http://127.0.0.1:7862/api/mobile/timeline` → 401（不是 404，说明路由在）。

这一层没打通，是目标 (2) 里除了公网隧道之外剩下的第二件事。

### 实测：401 到底是什么

对运行中的 7862 直接读响应体：

```
GET http://127.0.0.1:7862/api/mobile/timeline
→ {"error":{"message":"invalid or missing bearer token"}}
```

**不是 Host 围栏，是缺 bearer token。** 而且从局域网地址打它也返回同样的 401（不是连不上）——
说明端口本来就是网络可达的，卡的是凭据。

这个 token 从哪来？`dsh-client-connection` 的 `browser-auth.d.ts`：

> Process launch-token exchange and persistent signed-cookie verification.
> Add this process's launch token to the caller's application URL.

**是 DSH 进程启动时生成的 launch token，用 URL 换一个签名 cookie —— 给浏览器用的。**

### 所以三个数

| 观察 | 结论 |
|---|---|
| 7862 从局域网可达 | 端口不是问题 |
| 401 说的是 bearer token | 不是 Host 围栏 |
| token 是进程启动的 launch token | 体系为浏览器设计，没有长期设备凭据的位置 |

### 这解释了 AI-HUB 为什么自建凭据

它不是在绕过什么，是 Connection 这套本来就没打算服务「长期携带凭据的手机 App」。
它的做法是：自签设备凭据（`credentials.issue`），在独立端口的代理层验，验过再转发给本机 dsh web。

我们的 `DeviceStore` 已经在做前半截（签发、落盘摘要、撤销），缺的是后半截：
**一个独立的监听**，用 `X-Crew-Credential` 验过之后再转发。

已实测：插件进程里可以用 Node 原生 `http.createServer` 绑端口，而且**整套已经在真实环境跑通**：

```
真实网卡上选中的地址: 192.168.31.127   端口: 43499
没凭据: 401    有凭据: 200    别的路径: 404
```

绑定地址的挑选顺序：真网卡 IPv4 → 隧道/虚拟网卡 IPv4 → 其他 → 回环，**永不返回 0.0.0.0**。
这台机器上有 EasyTier 的 `utun4`（10.10.10.3），必须先于它选中 `en0`，否则会出现
「明明在同一个 Wi-Fi 却说连不上」。

## 真机验证记录

模拟器 `crew`（1080×1920）上跑过：

- 配对屏亮色：暖白底、深墨标题、主题绿聚焦框 ✓
- 配对屏暗色：深墨底、浅字 ✓
- 数字键盘：点配对码框弹出纯数字键盘 ✓
- 输入六位数字后"连上"按钮由禁用到可用 ✓

**验证中发现并修掉的三个缺陷**：

1. 暗色下地址文字几乎看不见 —— `OutlinedTextField` 吃了 Material 默认色，改为跟队伍配色
2. 暗色下"连上"按钮完全消失 —— 禁用态用了 Material 默认色，与背景融为一体
3. 默认地址指向网关 8788（只有对话条目），而配对在独立监听上 —— 改为 43499

**未验证**：队伍页、后台页、子代理卡、名片、断连态 —— 它们要后端真的在白名单端口上响应，
而插件要重新加载才会执行新代码，那不是这个会话能做的。

**已知小问题**：收起键盘后焦点跳到地址框并弹出字母键盘（应为数字键盘或保持无焦点）。

## 内置配对（调试用）

```bash
./gradlew assembleDebug -PcrewDevice=<设备号> -PcrewCredential=<凭据>
```

带上这两个参数，应用跳过配对屏直接进队伍页。`PairingStore.load()` 先读本机存的，
没有才回落到构建期内置的那份 —— 所以内置只是省掉手输，不是绕过配对。

## 真机上验证出来的四个缺陷

| # | 缺陷 | 症状 |
|---|---|---|
| 1 | 配对屏用 `Arrangement.Center`，键盘弹起后整列上移 | **点配对码框，数字进了地址框** |
| 2 | 暗色下 `OutlinedTextField` 吃 Material 默认色 | 地址文字几乎看不见 |
| 3 | 暗色下按钮禁用态与背景融合 | "连上"按钮消失 |
| 4 | Android 五条路径全缺 `/api/mobile` 前缀 | 连通之后仍报 404 Not found |
| 5 | 只绑一块网卡 | 局域网通、回环不通，模拟器连不上 |

第 1 条只有上手点才发现：`uiautomator` 报的坐标是布局坐标，键盘弹出后视觉位置已经变了。

第 5 条改成 `listenAll` 多地址绑定：实测 9 个地址（IPv4 × 4、IPv6 × 5）全部绑成功。

## 已验证 / 未验证

**已验证**：配对屏亮暗两套、数字键盘、输入校验、内置配对直进队伍页、
监听器的 401/200/404、多地址绑定、应用与监听器的真实连接。

**本轮新增验证**（用真实网关数据 + 真实三人队伍）：

- 队伍页有内容时：三个 bot 花名册、五条真实对话、输入框 ✓
- 子代理卡展开：层级缩进、完成对勾、标签 ✓
- 后台页：工单卡、状态、执行人、"看他怎么做"展开两条结论 ✓
- 亮暗两套主题下的页面切换 ✓

**本轮新发现的缺陷**：

| # | 缺陷 | 症状 |
|---|---|---|
| 6 | 队伍内容块写在 `when (screen)` **外面** | 切到后台页时队伍内容叠在下面 |
| 7 | 子代理卡显示 `node.id` 而不是 `label` | 画面上是 `a1-1`，数据里其实是「查 390 宽度」 |
| 8 | 历史消息正文是 URL 编码 | 显示 `App%e5%8F%91...` 而不是「App发的一句」 |

第 6 条是这次最严重的：它不是样式问题，是**两个页面同时渲染**。

**第二轮真机验证**：

- 名片弹层：人设全文、`bot/<id>`、最近工单数、两个按钮 ✓
- 断连态：红色横幅 + 重试 + 重新配对 ✓
- 重连：点重试后横幅消失、内容恢复、输入框可用 ✓

**又发现三个缺陷**：

| # | 缺陷 | 症状 |
|---|---|---|
| 9 | 名片里的按钮用了 Material 默认紫 | 和队伍的主题绿打架 |
| 10 | 断连横幅排在撑满高度的内容区**之后** | 断连时整页空白，连提示和重试都没有 |
| 11 | 外层 Column 没有安全区 | 断连横幅顶到状态栏，和系统时间重叠 |

第 10 条是真问题：断连本来是最需要提示的时候，结果画面上什么都没有。

### 桌面端

窗口第一次真的起来了：进程存活、无报错、系统里能看到标题为「Bot 队伍」的 880×620 窗口。

**数据层已对着真实监听器验证通过**（`DSH_GW=http://127.0.0.1:43499 DSH_DEVICE=emulator`）：

```
messages=5 bots=3 tickets=1 queued=0
agents under tk1: 2 top-level
steps of tk1: 2
```

**画面仍未看到**：`screencapture` 不可用，ScreenCaptureKit 要屏幕录制权限（本会话没有）。
所以桌面端的三栏布局、花名册、暗色主题都只是「数据齐了」，不是「看着对了」。

**桌面端发现并修掉的缺陷**：它只发 `X-Crew-Token`，而独立监听要的是
`x-crew-device` + `x-crew-credential`，两者对不上，桌面端根本连不上新监听。
现在统一走一个 `auth()`：两套头都带，由对端决定认哪个。

### 桌面端画面（本轮首次看到）

截图方式：ScreenCaptureKit + 先 `_ = NSApplication.shared` 接 WindowServer，
否则 SkyLight 会以 `CGS_REQUIRE_INIT` abort。产物见 `desktop-shadow.png`。

**看到画面后立刻发现四个缺陷**：

| # | 缺陷 | 症状 |
|---|---|---|
| 12 | **后台数据回来时不请求重绘** | 界面永远停在「正在读对话…」，数据拿到了但画不出来 |
| 13 | 按钮用 mygo 默认系统蓝 | 与队伍配色不是一套 |
| 14 | 子代理显示 `a1-1` 而非「查 390 宽度」 | 与 Android 同一处漏改 |
| 15 | 历史消息仍是 URL 编码 | 与 Android 同一处漏改 |

第 12 条最要命：`refresh()` 在 goroutine 里把结果送进 `arrived`，
但没人调用 `Invalidate()`，mygo 只在有输入事件时自己画 —— 所以窗口开着一片「正在读对话…」，
看起来像后端没响应，其实数据早就到了。

**仍未验证**：排队插话。

## 本次工作的回顾

### 最花时间的三件事

1. **看不见界面**（约占一半时间）。Android 前十几轮"测试全绿"，但一次都没启动过模拟器。
   启动之后几个小时里抓出 8 个只有肉眼能发现的缺陷：暗色下文字隐形、按钮消失、
   点错输入框、两页叠在一起、断连时整页空白。**测试和编译对这类问题完全无感。**
2. **截不了桌面窗口**。`screencapture` 不可用、`CGWindowListCreateImage` 被移除、
   ScreenCaptureKit 报 `CGS_REQUIRE_INIT`。我一度判断成"没权限"，实际权限一直是授予的，
   真正原因是要先 `_ = NSApplication.shared` 接上 WindowServer。
3. **同一个 bug 在两端各修一遍**。URL 编码、子代理标签，Android 修完忘了桌面端。

### 可以更早做的事

- **第一天就把界面跑起来**。哪怕只是启动模拟器截一张图，也胜过二十轮测试全绿的安心感。
- 改完 Android 立刻问"桌面端有没有同一处"，而不是等看到桌面截图才发现。
- 截图失败时先查 `ps` 确认进程身份，而不是猜。我曾把验证脚本误认成插件。

### 现在的守卫

`.githooks/pre-commit` 已装（`core.hooksPath=.githooks`），按改动块分别跑：
backend 是 `pnpm check`（typecheck + 测试 + 构建），desktop 是 `go vet` + `go test`，
app 是 `testDebugUnitTest`。刚跑过，通过。

**它在这次会话里没拦住任何视觉缺陷** —— 因为守卫只能验逻辑，验不了画面。
如果要把这次的教训固化成检查，唯一可自动化的是「两端同类逻辑一致性」：
`readable` 解码与 `label` 回退这两处，两端各有一份实现，值得加一条跨端契约测试。


## 隧道层（远端连接）

参照 AI-HUB 的做法：**不是 Cloudflare、不是 tailscale，是自建中转的出站 WebSocket**。
出站连接不需要开端口，所以在任何网络下都工作。

| 层 | 位置 | 职责 |
|---|---|---|
| 协议 | `backend/src/app/relay-protocol.ts` | v2 二进制帧，28 个编号 |
| 中转服务端 | `relay/` | TypeScript，零运行时依赖，手写 RFC 6455 子集 |
| 宿主隧道 | `backend/src/app/tunnel.ts` | 出站、退避重连、双向心跳 |
| 降级链 | `backend/src/app/relay-chain.ts` | lan → relay → fallback |

**协议对拍是真的**：`relay-protocol.spec.ts` 把 AI-HUB 的 `protocol.js` 直接装进来，
28 个编号 × 7 种 id × 6 种 payload 逐字节比。找不到参考实现时整组**明确跳过**
（21 项），不会假装通过。

**一处有意的偏离**：参考实现的 `parseJson` 把裸标量原样返回，而调用点紧接着做
`msg.path` —— 公网发一个 payload 为 `5` 的帧就能让它抛。我们统一降级成空对象，已测。

**兜底不是同一个故障域里的第二个端口**。同一台 NAS 上的 8787 和 8788 只能覆盖
「进程挂了」；NAS 关机、家里断网时两个一起没。所以第二档要求在**另一个落地点**跑同一个镜像。

**没验的**：Docker 镜像没 build 过（本机 daemon 没起，产物 `dist/main.js` 起真进程验过
`/health` 200）；没在真 NAS 上跑过；没经过真手机。
