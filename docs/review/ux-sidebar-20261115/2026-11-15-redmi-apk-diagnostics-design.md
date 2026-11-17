# BotCrew 手机上「实时监听自身诊断信息」· 只读设计与证据

日期：2026-11-15（Asia/Shanghai）。执行成员：`wb-apk-diagnostics`（真实 WorkBuddy 客户端实施成员，独立于后端/lead）。
性质：**只读设计 + 实机证据**。本轮未安装、未改代码、未 commit/push、未改后端/AGENTS/协议、无桌面输入、未改手机网络设置。

> 本报告只呈现当前方案本身。变更过程见各轮 review；不复述旧版对比。

---

## 一、先把「设备身份」实时钉死（不把 OPPO 当红米）

`adb devices -l` 实时识别，两台都在线：

| 设备 | adb 传输名 | brand | model | device | serial | Android |
|---|---|---|---|---|---|---|
| OPPO（曾装，锁屏中） | `55c86317` (usb) | OPPO | PEDM00 | OP4E5D | 55c86317 | 14 |
| **红米（用户指定目标）** | `adb-9f9cc3db-EqVvHK._adb-tls-connect._tcp` | **Redmi** | **24117RK2CC** | **zorn** | **9f9cc3db** | **16** |

判据用 `getprop ro.serialno`（红米真值 `9f9cc3db`），**不是**拿 OPPO 的 `55c86317` 冒充。红米与历史记录一字不差（Redmi 24117RK2CC / zorn / 9f9cc3db）。

### 1.1 红米实时状态（只读）

- 锁屏：`isKeyguardShowing=false`、`mDreamingLockscreen=false` → **未锁屏**，前台为 `com.dsh.mobile/com.dsh.mobile.MainActivity`（注意：这是**另一个 App 包名**，与 `com.dsh.botcrew` 是两个包，不能混谈）。
- `com.dsh.botcrew` 已装：`/data/app/~~5zFyL_xwMwE9uGYx1btoFw==/com.dsh.botcrew-hkL8cRTxdlkXEX0LnWojcQ==/base.apk`
- **firstInstallTime = 2026-11-11 18:15:06**（与历史记录逐字一致）；lastUpdateTime = 2026-11-15 15:46:05；versionName 0.1.0。
- 设备上 base.apk **sha256 = `31e96cd6eb6ef0fe5584ce519ef1b383066cd26c7c8b113b8cb47b51c7ba57a8`**（12,733,205 B）
- **cert SHA-256 = `ad0e44804142148625ce90427ce3832747c29b795640cfb451745b44540af7eb`**（`apksigner verify --print-certs`，Signer #1）

### 1.2 交付 sidebar APK 与红米现装比对（结论：同签、非同包）

| | 红米现装 base.apk | 交付 sidebar APK |
|---|---|---|
| sha256 | `31e96cd6…c7ba57a8` | `e6450ee395a3a86f55f294e5b6fb4ab13702585aa4ea30206fc0161275822ed2` |
| 大小 | 12,733,205 B | 12,749,589 B |
| versionName | 0.1.0 | 0.1.0 |
| cert SHA-256 | `ad0e4480…af7eb` | `ad0e4480…af7eb` |

- **同签**：两者证书一致 → 未来 `adb -s <红米> install -r` 可**保留数据**（配对/历史/session 不丢，firstInstallTime 不变）。
- **非同包**：红米现在跑的是 `31e96cd6…`（另一版构建），**不是**用户点名的 sidebar `e6450ee3…`。覆盖安装会把 12,733,205 B 版本换成 12,749,589 B 的 sidebar 版。
- OPPO 55c86317 当前已装 sidebar 版（`e6450ee3…`，12,749,589 B，cert 同 `ad0e4480…af7eb`，firstInstallTime 2026-11-11 22:27:11，lastUpdateTime 17:00:47，现锁屏）。

> 待 lead 批准后才执行安装。独立验证员最后以「同签覆盖」复核（cert SHA-256 两侧一致 + `firstInstallTime` 保留 + 设备 base.apk sha256 == `e6450ee3…`）。本条只做只读确认，不安装。

---

## 二、现有连接/日志/崩溃基础设施（只读盘点，定 scope 的事实底）

### 2.1 连接与选路（已实现，本轮不动）

- `CrewClient`（`app/.../CrewClient.kt`）：入口表 `P2P → LAN → 公网`，**试出来**而非配置；`read()` 逐条轮询、401 不换路、失败计数 `failures`、`promote()/replaceEntries()/preferBetterEntry()/probeEntry()`。所有请求收口在 `open()` + `attempt()` 一处（socket 开合不泄漏）。
- `CrewRoute`（纯函数）：`entries(paired, proxyPort)`、`kindOf`、`retryDelay(failures)` = `1/2/4/8/16/30s` 有界退避、`label()`。
- `CrewLanHealth`（纯函数）：LAN 地址 `OK/UNREACHABLE/STALE` 三态判定（连续失败 + 跨网段）。
- `MainActivity.onCreate` 的 `LaunchedEffect(paired)`：建 client → `TailcatP2p.start` → `repeatOnLifecycle(STARTED)` 前台探测循环（`P2P_CHECK_INTERVAL_MS=30_000`，失败走 `retryDelay`），后台取消等待。**已有 bounded backoff，无无限高频重试**。
- `PairingClient` / `PairingStore` / `PairingRecord`：配对/凭据落盘（SharedPreferences `crew-pairing`，save 先 clear 再写）。

### 2.2 域名入口（用户说「走域名加 log 输入/入口」）

- 域名（公网 `fallbackBase`/`https://...`）与 P2P `p2pAddr` 由 mDNS 记录的 `pub`/`p2p` 在配对时一并带入（`PairingScreen` → `PairedCrew(..., spot?.publicBase, spot?.p2pAddr, spot?.crew)`）。
- `CrewRoute.kindOf` 按地址内容判定：命中 `fallbackBase` → `PUBLIC`（公网/域名那条）。`CrewClient` 会把它当入口之一试。
- **这是「域名入口」的现状**。用户要求的「域名加 log 输入/入口」，落在两件事：①诊断页能看到当前走过的域名/公网入口（快照已含 `entries`/`entry`/`way`）；②诊断日志可经**配对认证后的域名入口**补传（见 §三 补传通道）。

### 2.3 现有日志与崩溃捕获（结论：**没有结构化客户端诊断**）

- 全仓 `android.util.Log.*` 仅散落在 `CrewDebug`/`TailcatP2p`/`CrewUi`/`CrewTimeline`/`CrewP2p` 等，输出到 **logcat**；App 内部**无**环形缓冲、无落盘、无导出、无诊断页。
- **无** `Thread.setDefaultUncaughtExceptionHandler`，**无** Crashlytics/任何崩溃上报。未捕获崩溃只在系统 `/data/anr`、`logcat` 可见，用户侧无从取。
- `CrewDebug`（`CrewDebug.kt`）：**仅 debug 构建**（release 恒 false）的抽象 socket 调试口，`adb forward localabstract:crew-debug` 驱动，与桌面端协议逐字兼容，`state.dump` 已能摊平 `entries/entry/way/lanVerdict/tunnelMillis` 等。**它不落盘、release 不可用、不是给用户看的诊断页**——只能作为「调试期取状态」的旁证，不是本需求的实现。

**所以本需求的净新增 scope 是确定的**：一个 App 自身、release 可用、环形有界、可关闭/清理、可导出/手动补传的诊断子系统 + 一个侧栏工具入口的诊断页。

---

## 三、最小实现 scope（ponytail：能不改就不改，改就收在一处）

### 3.1 数据流（实际链路）

```
请求发起 (CrewClient.open/attempt)          ─┐
换路 (promote/replaceEntries/preferBetter)  ─┤
探测 (probeEntry/preferBetterEntry)         ─┤
DNS/TLS/网络异常 (IOException/timeout)      ─┼─► ClientDiag.record(Event)   ← 单一写入口
前后台 (MainActivity lifecycle)             ─┤       │
未捕获崩溃 (UncaughtExceptionHandler)       ─┘       ▼
                                          RingStore(有界环形, 本地)
                                                  │  断网保留
                                                  ▼
                              经配对认证的域名入口 → POST /api/mobile/diag (后端另成员，待 lead API 契约)
                                                  ▲
                              诊断页(侧栏工具): 查看/复制/导出/手动补传 + 开关/清理
```

### 3.2 记录字段白名单（只记这些，别的不采）

每条事件固定字段（结构化 JSON，无自由文本正文）：

- `t`：时间戳（epoch ms）
- `ev`：事件类型 `request | route_switch | probe | net_error | foreground | background | crash`
- `method`：仅 `request`（GET/POST…）
- `path`：**去 query 的路径**（`CrewRoute`/`SessionRoute` 拼出的，脱掉 `session_id`/`provider`/`model`/`ticket` 等参数值）
- `ms`：耗时（request/net_error 有）
- `status`：响应状态码（HTTP）
- `route`：`p2p|lan|public|unknown`（由 `kindOf` 已有结果）
- `cause`：`net_error` 的异常类名（`IOException/Timeout/SocketTimeout/UnknownHost/SSLHandshake/...`，**只类名不堆栈正文**）
- `ver` / `model` / `conn`：app versionName、`Build.MODEL`、连接种类（`wifi/cellular/none`，从 `ConnectivityManager` 类型取）

**明确不采集**（硬约束，写进 `ClientDiag` 的注释与白名单里）：聊天正文、审批内容、`Authorization`/cookie/`X-GW-Token`/`x-crew-credential` 的值、配对二维码/6 位码、token 任何原值、其它 App 信息、IMEI/ANDROID_ID 原值。`path` 只留路由段，query 与 body 一律丢。

### 3.3 存储与生命周期（环形、有界、可关、可清）

- **有界环形**：固定容量（建议 `MAX_EVENTS = 500` 条 + 单条 `path` 截断 ≤200 字符），超出 FIFO 丢最旧。落一个 app 私有文件（如 `filesDir/diag/ring.jsonl`，单文件追加、滚动上限 ~512KB）。**绝不无界增长**。
- **断网保留**：事件先本地落盘，补传成功后按 id 删除/标记；断网期间只攒不丢，重连后经域名入口批量补传（bounded：一条一批最多 N 条，失败保留，不无限重发）。
- **可关闭**：设置项布尔（默认开=基础诊断）；关掉后 `record()` 变空操作、不写盘。关开都不要求重新配对。
- **可清理**：诊断页「清空」删本地环形文件 + 重置游标；「导出」生成可分享文本/文件。
- **`shortcut:` 注释**：环形上限与单条截断是刻意的有界取舍；需要更长历史时升级为滚动多文件 + 服务端归档。

### 3.4 诊断页（放侧栏「工具」，不新加常驻排）

- 入口：`CrewDrawerSheet` 的「工具」段新增一枚 `DrawerToolItem("诊断", ...)`（排在「会话管理」之后、「模型」之前即可），**不进顶部常驻、不加第二条导航行**——严格保持现「单行顶栏 + 侧栏」结构不退回。
- 页面（全屏 overlay，复用现有 overlay 模式如 `ProfileOverlay`）：列表展示最近事件（时间/类型/方法+去query路径/耗时/状态/route）、顶部显示 app 版本/机型/连接种类、底部按钮 `复制` / `导出` / `手动补传` / `清空` + 一个「记录诊断信息」开关。
- 复制/导出前做一次**脱敏断言**（见 §五 测试）：正则扫一遍，命中 `token|authorization|cookie|code=` 之类即拒绝导出并提示（防生产日志泄明文凭据）。

### 3.5 写入点（最小侵入，不重写网络层）

- `CrewClient`：在 `attempt()`/`open()` 的成功与各 catch 分支各加**一行** `ClientDiag.record(...)`（拿 method/path/ms/status/cause）。**不改换路逻辑本身**。
- `onRouteSwitched` 回调处加一行 `route_switch`。
- `MainActivity`：`repeatOnLifecycle` 前后 + `ProcessLifecycleOwner`（或现有 lifecycle）处各一行记 `foreground/background`。
- `Application`/`MainActivity.onCreate`：装 `Thread.setDefaultUncaughtExceptionHandler`，记 `crash`（类名 + 消息 + 版本/机型，**不落完整堆栈到可分享区**，或落本地但不导出堆栈正文），再交回原 handler。

### 3.6 补传接口（后端另成员，本轮不写）

- **等 lead 批准 API 契约后**，后端另成员实现 `POST /api/mobile/diag`。本设计只约定客户端侧：走 `CrewClient` 同一入口表/同一认证（配对凭据），经域名入口补传，body 为已脱敏事件数组。**本轮不写后端、不改协议**。

### 3.7 新增/改动文件清单（供 lead 定 write scope）

新增（纯 helper，独立可测）：
- `app/.../ClientDiag.kt` —— 事件模型 + 白名单序列化 + 脱敏断言（**纯函数**，JVM 可单测）
- `app/.../DiagRingStore.kt` —— 有界环形落盘/读/清（薄 IO 层）
- `app/.../DiagPage.kt` —— 诊断页 Compose overlay（入口/展示/复制/导出/补传/开关）
- `app/src/test/java/com/dsh/botcrew/ClientDiagTest.kt` —— 白名单与脱敏断言测试

改动（最小侵入）：
- `CrewClient.kt`：`attempt()/open()` 与 route 回调各加记录行（不改逻辑）
- `CrewUi.kt`：`CrewDrawerSheet` 加「诊断」工具项 + 挂 overlay（约 3~5 行 + 一个 state）
- `MainActivity.kt`：生命周期前后台记录 + 崩溃 handler 装配（约 10 行）
- `AndroidManifest.xml`：如需读取连接种类，已有 `ACCESS_NETWORK_STATE` 权限，**无需新增权限**

---

## 四、对「出门用不了、走域名+log 入口」的直接结论（只读）

1. 出门后走的是 `PUBLIC/域名` 那条（`fallbackBase`，`kindOf` 判 PUBLIC）。现有 `CrewClient` 会依次试入口、`retryDelay` 有界退避，**已有 bounded backoff**；若「用不了」是外网入口不通，诊断页的 `way/entries/entry/net_error/cause` 就能一眼看出卡在 DNS/TLS/连接超时哪一步——这正是本需求要补的可观测性缺口（当前只能看 logcat）。
2. 红米现装版（`31e96cd6…`）**不是** sidebar 版；要复现用户点名的 sidebar 行为，需批准后同签 `install -r` 覆盖到 `e6450ee3…`（保数据）。
3. 诊断入口从侧栏「工具」进，**不动顶部单行/侧栏结构**，不新增常驻排。

---

## 五、证据与验收口径（本轮只读能给的）

- [x] 红米实时身份 = Redmi 24117RK2CC / zorn / 9f9cc3db（getprop），未与 OPPO 混谈
- [x] 红米未锁屏；`com.dsh.botcrew` firstInstallTime 2026-11-11 18:15:06
- [x] 红米 base.apk sha256 `31e96cd6…` + cert SHA-256 `ad0e4480…af7eb`（同签）
- [x] 交付 sidebar APK sha256 `e6450ee3…`（与用户给的一致）+ 同 cert
- [x] OPPO 现状（已装 `e6450ee3…`，锁屏）
- [x] 现有日志/崩溃捕获盘点：无结构化客户端诊断，仅 logcat + debug-only `CrewDebug`

**待实施后应由独立验证补充的验收**（本轮不做）：
- [ ] `install -r` 后红米 base.apk sha256 == `e6450ee3…` 且 firstInstallTime 未变
- [ ] 诊断页可从侧栏工具打开；列表/复制/导出/清空/开关可用
- [ ] 白名单与脱敏断言单测通过（无 token/cookie/code 泄漏）
- [ ] 断网攒、重连经域名入口补传一次、幂等不重发
- [ ] 崩溃 handler 记 `crash` 事件且不改变原有崩溃行为
- [ ] `compileDebugKotlin` / `assembleRelease` 通过（JDK21，验证方独占 Gradle，串行）

---

## 六、换路超时/阻塞只读核实（lead 追问项，2026-11-15 增补）

### 6.1 各次 connect/read timeout（实码）

| 调用点 | connectTimeout | readTimeout | 说明 |
|---|---|---|---|
| `CrewClient.open()`（所有业务请求收口） | **15_000ms** | 20_000ms | 每条入口一次 |
| `CrewClient.read()` | —— | —— | 串行 `for step in table`，**逐条** `attempt()`，某条抛 IOException 才试下一条 |
| `CrewClient.probeEntry()` | 3_000ms | 20_000ms | 只探不换路，记失败计数 |
| `CrewClient.preferBetterEntry()` | 3_000ms | —— | 探更优入口 |
| `TailcatP2p.probe() → request()` | 2_000ms | `waitMs`(默认15s) | 整轮 `PROBE_BUDGET_MS=20_000` 墙钟上限 |

### 6.2 「蜂窝不可达时是否每轮阻塞域名」——**确认阻塞，且是每请求一次**

- `read()` 用**同一条 15s connectTimeout** 逐条试：`current` 在最前开始绕。若 `current` 是死 LAN：
  - 蜂窝下 LAN 的 RFC1918 地址**不可路由** → `Socket.connect` 不会「连接被拒」秒回，而是**阻塞到 connectTimeout=15s** 才抛。
- **实测佐证**（本机 curl 对黑洞地址 `10.255.255.1:43499`）：`connect_time` 直到 `time_total=20.0s`（curl −m 20 的上限）才返回 → 不可路由地址是**纯 connect 阻塞满超时**，不是快失败。可路由但无监听的 `192.168.31.127:43499` 则 `connect_time≈2ms` 后被 401 拒（=地址活着）。故「死/不可路由的 LAN」是真阻塞源。
- **关键区分**：`retryDelay(1/2/4/8/16/30s)` 与 `preferBetterEntry` **只在 `MainActivity` 的后台探测循环里**跑（`P2P_CHECK_INTERVAL_MS=30_000`）；**它们不管 `read()` 的每请求超时**。所以「bounded backoff」保护的是探测频率，**没保护**用户每一次业务请求：出门后每个请求若从死 LAN 起手，都要先吃满 15s 再落到域名 → 表现为「打开很久/像用不了」。这正是要修的换路自愈点。

### 6.3 `fallbackBase`（域名）来源——**仅配对快照 + 重新发现元数据，无静态兜底**

- `PairedCrew.fallbackBase` 唯一写入：①配对时 `spot.publicBase`（mDNS `pub`）；②`CrewNearby.refresh()`：`fallbackBase = beacon.publicBase.ifEmpty { paired.fallbackBase }`（仅 mDNS `crew` 指纹判同机、且 `pub` 非空时更新）。
- `CrewRoute.entries` 第三条即 `paired.fallbackBase`；**空串则不出现**该入口 → 出门只剩死 LAN。
- `BuildConfig.GW_BASE` 只做**首次配对地址框初值/内置 base**（LAN），**不是 fallback**。全仓无「硬编码公网域名」作 fallback。
- 结论：用户「旧/空 fallback 是假设未坐实」成立——我无法在不越权读私有 prefs 的前提下读到这台红米 live 的 `fallbackBase` 值（release 非 debuggable、App 当前未运行、debug 口 release 关闭、`run-as` 拒绝）。**但代码路径证明**：只要配对时 `pub` 为空（红米配于 2026-11-11），出门必无公网入口。注意红米 ANDROID_ID=`2d03dff8a399a281`，与管理面记录 `d021988751fdd554` 不同名空间，**不能拿管理面那条记录直接当这台 live 装机的配对**——进一步说明「坐实」需真机读到 App 内的值（诊断页正是为此，见 §三）。

### 6.4 已验证：crew.kentonnie.top 携凭据 Mac 出站 timeline 200（复核）

- DNS 解析正常（104.21.93.136 / 172.67.210.217，CF）；无凭据 `https://crew.kentonnie.top/api/mobile/timeline` → **401**（TLS/DNS/边缘链路通、需凭据），与本会话只读实测一致。
- 与 `external-diagnostics-20261115/network-findings.md` 记载的「带真凭据 200」一致；本成员未打印任何凭据，凭据只在进程内取用。**Mac 出站 ≠ 红米蜂窝可用**，但服务与域名本身健康已排除。

### 6.5 最小自愈路径（草拟，等 taskscope/后端 schema 冻结后实施；本轮不改代码）

1. **保留既有配对身份**：不动 `deviceId/token/crew`，不重配对、不清数据。
2. **现有可信元数据同步 current public base**：把「域名」从「只在配对那一刻抄一次」升级为**每次拿到可信 timeline 成功响应 / mDNS discovery 元数据（`crew` 指纹同机 + `pub` 非空）**时更新 `fallbackBase` 并 `replaceEntries`（不重启隧道）。即：出门前若曾在家连通过域名，就把最后可信的公网 base 记下。
3. **bootstrap 兜底（严格同机校验，绝不无条件改陌生 host）**：将本次固定部署的公网域名由 build 配置注入（如 `BuildConfig.PUBLIC_BASE`）作为**配对缺 fallback 时的 bootstrap**；采用前必须**同 paired 服务器身份校验**——用该域名发一次带凭据 `/api/mobile/timeline`，**200 且响应指纹/`crew` 与本地配对一致**才采纳为 `fallbackBase`；校验不过则丢弃，不回退、不写陌生 host。
4. **换路快失败**：`read()` 起手若 `current` 非公网，先**快速探公网域名**（短 connectTimeout，如 2–3s）与 P2P；对不可路由的 LAN 用**短探测超时（2–3s）**或在已知跨网段时**跳过 LAN 直接域名**，避免每请求吃满 15s。改的是 `CrewClient`/`MainActivity` 的换路自愈，不重配对。

### 6.6 诊断补传 API 方向（先准备，等后端 schema 冻结）

- `POST /api/mobile/diag`，body = 批量已脱敏事件数组（`events:[{t,ev,method,path,ms,status,route,cause,ver,model,conn}]`），经入口表+配对凭据。**等 lead 统一冻结 schema 后再定字段细节**，本轮不写后端/协议。

> 本轮仍只读：未装中间 sidebar 包（lead 指示直接交独立验证员最后将「诊断+外网修复」完整新包同签覆盖红米）、未改 `CrewUi`/manifest/源码、未 commit。§6.5/§6.6 为建议路径，等 taskscope 明确后实施。

### 6.7 冻结 API 落地（wb-domain-log 2026-11-15 冻结，lead 已批）——客户端实现 spec

> 已冻结，按此实现客户端批量补传。**本轮仍不写码**（lead：等 taskscope 放行）；以下为落地到 `ClientDiag.kt` / `DiagRingStore.kt` / `DiagUploader.kt` 的字段映射与行为规范，放行即写。

**端点**：`POST https://crew.kentonnie.top/api/mobile/diagnostics`（公网主域名，非 NAS relay 子路径）
**鉴权**：复用 paired 头 `x-crew-device` + `x-crew-credential`（同 `/api/mobile/timeline`）。**凭据绝不放 URL/query/body/日志**。

**请求 body（JSON ≤64KiB；batch ≤50 条；单条 ≤1KiB）**
```json
{"app":"BotCrew","build":"<verName>(<verCode>)","batch":[
  {"id":"<UUID 幂等键>","at":"<ISO8601 带时区>","event":"<短词>","route":"<去query path>",
   "method":"GET|POST","status":200,"ms":15,"err":"<类名/码>","session":"main",
   "extra":{"phase":"connect|send|receive|auth|render","networkKind":"wifi|cellular|none",
            "model":"","version":"","routeKind":"lan|p2p|tunnel|public"}}
]}
```
**响应**：`{"ok":true,"acceptedIds":[...]}` → 出现在 acceptedIds 的删除本地缓存；未出现的（含服务端去重老 id）视为已处理、不重发，**以服务端返回为准做幂等**。

**客户端职责（`DiagUploader`）**
1. **本地有界缓存**：环形（建议 ≤500 条 / ≤512KiB），超限丢最老。事件在 `record()` 时生成 `id`(UUID) + `at`(ISO8601 带时区) + 白名单字段。
2. **断网不发**：`networkKind==none` 时不发；恢复（`ConnectivityManager` 回调/flags）后批量补传。
3. **批量**：每批 ≤50 条、单条 ≤1KiB、总 ≤64KiB（超限先切批；单条超 1KiB 截断/丢弃该条并记一次本地自丢计数，不发超大）。
4. **幂等**：只删 acceptedIds 命中的；未命中保留到下次（但若连续 N 轮服务端都成功却不含某 id，按「已去重」删除，避免卡在本地）。**以响应为准**，不自行猜测。
5. **429 指数退避**：收到 429 → 按 `1/2/4/8/…/≤60s` 退避重试同批（bounded，不无限高频）；退避期间不并发多批。
6. **地址**：`https://crew.kentonnie.top`（可由 `BuildConfig.PUBLIC_BASE` 注入，默认此值；仍走 §6.5 的**同 paired 服务器身份校验**——但补传本身带 paired 凭据、200/401 即验证身份，等价）。

**build 号**：`${versionName}(${versionCode})` = `0.1.0(1)`，来自 `BuildConfig.VERSION_NAME/VERSION_CODE`。

**字段映射（白名单硬约束，写进 `ClientDiag`）**
| schema 字段 | 客户端来源 | 备注 |
|---|---|---|
| `id` | 客户端 UUID | 幂等去重键 |
| `at` | 事件发生时刻 ISO8601+offset | |
| `event` | `http_error/screen_crash/net_fail/ui_exception/connect_fail` | 由捕获点映射 |
| `route` | 去 query 的 path（`/api/mobile/timeline`） | **脱 query、脱 body**，同 §3.2 白名单 |
| `method/status/ms/session` | 请求侧已有 | session 仅 id |
| `err` | 异常**类名/码短词**（Timeout/ECONNREFUSED/…） | **不塞任意 message**（可能带凭据） |
| `extra.phase/networkKind/routeKind/model/version` | `kindOf`/`ConnectivityManager`/`Build` | routeKind 用 `lan/p2p/tunnel/public` |

**仍不采集**（服务端也会过滤）：token/query/headers/body/text/聊天正文/Authorization/cookie/配对码/其它 App。device 由服务端用已验 principal 覆盖，**客户端 body 不带 device、不伪造**。

**测试点（落地时补）**：①单条 ≤1KiB / 批 ≤50 / 总 ≤64KiB 切批；②acceptedIds 幂等只删命中；③429 退避序列 bounded；④断网不发起、恢复补传；⑤`err` 只出类名、`route` 无 query（正则断言无 `token|authorization|cookie|code=`）。

---

## 七、边界声明（本轮实际遵守）

未安装（等 lead 批准）、未改后端/AGENTS/协议、未 commit/push、无桌面输入、未改手机网络设置、未发生产业务消息、未读 backup 秘密。JDK21/Gradle 未抢占。
