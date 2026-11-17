# task-10 客户端实现报告（诊断上报 + 蜂窝换路自愈）— r2 完成

日期：2026-11-15（Asia/Shanghai）。执行成员：`wb-apk-diagnostics`（客户端 owner，只源码/单测；设备/安装/网络切换由 `wb-drawer-verify` 独占）。
**状态：r2 已闭环（源码冻结，不再改/不再构建/不再碰手机）。** 最终 r2 设备+服务端闭环由 lead/task13 验收通过：
- debug/release 各 **575 测试全绿**；已装包 sha `0eb388…`。
- 覆盖升级 / 强停重开 / 两轮 WiFi↔Cell 均**免配对**，`server.pairedAt=14:02:48.425Z` 恒定（证明升级不丢身份）。
- 真实 Cell 下 PUBLIC 路由 **25 条业务全 200**，手机日志到域名 `crew.kentonnie.top`，manual IO 错已消除。
- 本成员自检前置：target 8 类 **89/0 绿**（见 §四）；最终 575/variant 与真实 Cell 25 条为独立验收证据（引用，非本成员自跑）。

> 边界：**历史「基线起始凭据缺失」原因证据不足以下结论**（不把重新配对当修复），详见 §二·0e；新旧 schema 等价但不断言「从未配对」。
根因依据：`docs/review/ux-sidebar-20261115/2026-11-15-redmi-apk-diagnostics-design.md` §六；真实契约 `docs/00-contract.md` §5.9；`docs/review/external-diagnostics-20261115/api-verification.md`；baseline `docs/review/cellular-20261115/device-baseline.md`。

> 本报告只呈现当前实现。规划性的 §6.5/§6.6 已由本批实现取代，见 §三。

---

## 一、新增 / 改动文件（scope 内）

**新增纯逻辑（JVM 可单测）**
- `app/.../ClientDiag.kt` —— 事件模型、白名单序列化、route 去 query/hash、脱敏断言、切批、崩溃 stack 只留结构帧；`BuildInfo`（版本/构建标记）。
- `app/.../DiagAck.kt` —— ACK 判定（2xx + JSON + `ok===true` + acceptedIds/rejectedIds 命中才算）+ 有界指数退避（含服务端 Retry-After）。
- `app/.../RoutePolicy.kt` —— 换路策略纯函数：healthy sticky / 失败冷却 / 短 LAN 快速切域名 / 网络切换清证据。
- `app/.../BootstrapGate.kt` —— bootstrap 准入纯函数：空 savedCrew / 预期不符 / 配置空 / 已有 fallback → **0 请求**；仅 savedCrew 非空且 ==expected 且域名非空才放行。
- `app/.../DiagRingStore.kt` —— 有界环形本地落盘（≤500 条 / ≤512KiB，FIFO 丢最老，原子重写）。
- `app/.../DiagUploader.kt` —— 批量补传编排（Transport 可注入），真 ACK 才删本地、429/5xx 退避、断网留本地、非递归。

**Android 装配**
- `app/.../DiagRuntime.kt` —— 记录点、uncaught handler（进程单例，chain 原 handler，只落盘不联网）、前后台、网络回调、上报循环、开关、导出脱敏断言。
- `app/.../DiagPage.kt` —— 诊断页覆盖层：查看/复制/导出/手动补传/清理/开关 + 构建标记显示。

**最小侵入改**
- `CrewClient.kt` —— `read()` 接入 RoutePolicy（起手顺序/短超时/快速探公网）；健康证据 map + netGen；`diagSink` 埋点；`bootstrapPublic(candidate, savedCrew)`（server.crew 精确比对）+ `trustedPublicBase(entry, savedCrew)`（非空旧 fallback 也更新）；`attachPairing/onNetworkChanged`。
- `CrewWire.kt` —— `Conversation.server: ServerMeta?`，`parseTimeline` 读顶层可选 `server:{crew, public_base}`（缺块=null，旧后端兼容）。
- `PairingClient.kt` —— `PairedCrew` 加 `serverCrew / serverPublicBase`（存服务端自报身份）。
- `PairingStore.kt` —— `PairingRecord` 持久化 serverCrew/serverPublicBase；新增 `probeReadState()` + `probeState()`（missing/loaded/parse_error 三态，不把损坏伪装成未配对）。
- `PairingScreen.kt` —— 首次 pair 成功后立即拉 timeline 登记 `server.crew/public_base`（new-pair 初始可信身份），失败不报错。
- `MainActivity.kt` —— 初始化 DiagRuntime（BuildInfo 灌版本/构建标记）、装崩溃 handler、上报循环、启动配置快照、网络回调、生命周期、diagSink、bindUploader（**配好即立即补传**）、bootstrap/trusted 自愈。
- `CrewUi.kt` —— 侧栏「工具 · 诊断」项 + DiagPage overlay（不新增顶部常驻排）；会话变化同步 diag.currentSession。
- `build.gradle.kts` —— `CREW_PUBLIC_BASE / CREW_EXPECTED_CREW / CREW_DIAG_BASE / CREW_BUILD_ID`（后两者与 bootstrap 两项默认空/local）。

**单测（7 类全绿）**：`ClientDiagTest`、`DiagAckTest`、`RoutePolicyTest`、`PairingRecordProbeTest`、`BootstrapGateTest`、`DiagUploaderTest`、`DiagRingStoreFileTest`（真实文件）。targeted **74/0**。全量 app 单测（早前一轮）547/0 无回归。

---

## 二·0b、最终落盘 2 处根因收口（lead 装前复审）

A) **DiagRingStore 原子写不再丢队列**：旧 `rewriteLocked` 是「tmp.writeText → file.delete → tmp.renameTo（忽略结果）」，kill/rename 失败会把未 ACK 整个队列删没。改为 `FileOutputStream(tmp).fd.sync()` 落盘 → `Files.move(tmp, file, ATOMIC_MOVE, REPLACE_EXISTING)`，**绝不先删原文件**；失败清 tmp、显式抛 `IOException`（诊断可见）、原队列仍在。`append/appendAll` 返回前 `fd.sync()` 保证 durable（crash breadcrumbs 先落盘再 chain 原 handler）。新增 `internal constructor(File dir)` 供真实文件单测（另保留 Context 委托）。`DiagRingStoreFileTest`（真实临时文件，9 例）验证：跨实例重开读到、部分 ACK 重写保未删、无残留 tmp、有界、clear、原子写成功原文件正确。

B) **quarantine 持久化（跨进程/重建不丢、不无界）**：旧隔离集是 `ConcurrentHashMap` 内存 set，bindUploader 重建/App 重启即忘、毒记录重发；且 ring 淘汰后不清会无界。改为持久到 `diag/quarantine.jsonl`（sidecar），`DiagUploader.Store` 加 `quarantinedIds()/addQuarantine()`，Uploader 从 store 读（非内存 set）、拒收/超限时 `addQuarantine(id,reason)`。sidecar 与 ring 统一封顶（500 条/64KiB），ring trim 时 `pruneQuarantineToRing` 清理已不存在于 ring 的 id（不留无主项）。诊断页显示「隔离 N 条」（`DiagRuntime.quarantinedCount()`）。测试：跨「新 Uploader + 同 FileStore」隔离仍跳过拒收、正常新行可传、隔离项不进 wire、不再重发（MemStore 与真实 File 双验证）。

---

## 二·0c、执行层真根因（r2 最小修）

真机 r1 打通：蜂窝业务 19 条全 200，但 `routeKind` 全 p2p，与新策略 PUBLIC-first 不符。lead 定位**执行层根因**：
`CrewClient.read()` 里 `begin = ordered.indexOf(current)` + `for step in ordered.indices { ordered[(begin+step)%size] }`
—— 把 policy 已排好（PUBLIC 在 plan.order[0]）的序列**按旧 current 旋转回旧 P2P**，等于撤销 policy 排序，死旧 current 仍可先阻塞。

**最小修**：真实 attempt 从 `ordered[0]` 起，不再按 current 旋转（`val entry = ordered[step]`）；`current` 仅记最近成功那条（显示/诊断），不再隐式覆盖 plan。既有 explicit promote/probe 行为保留，成功后正确 `noteSuccess` 喂 health 由 planner 排序。

**执行 seam 测试**（`CrewClientExecutionTest`，注入 `attemptSpy`/`attemptOverride` 记录真实 attempt 顺序）：
- `currentP2P_thenCellular_firstAttemptIsPublic_notRotatedToP2P`：current=P2P → 切 cellular（清健康）+ P2P/LAN 黑洞、PUBLIC 通 → 首个真实 attempt **是 PUBLIC 且只试 PUBLIC**（旧旋转逻辑下会失败，真根因回归锁）。
- `healthySticky_executionOrderHonorsPlan`：WiFi 下 P2P 健康 sticky → 执行从 P2P 起（端到端）。
- `failedEntryCooldown_executionSkipsToNextHealthy`：P2P 连续失败进冷却 → 执行先非 P2P。

（r2 构建标记 `cellular-20261115-r2`，pub/expected 不变；已配对 ID/token 保持，不再首次 pair，同签覆盖保配对。）

---

## 二·0e、身份持久化只读审计（"为何掉配对页/凭据是否丢"——不把重配当修复）

用户追问「为什么这么难匹配、还要重新配对，不是说好自动寻址」。lead controlling steer：查清手机凭据为何 missing，**不当重配是修复**。以下为**源码/git 可证事实**，不含猜测。

### 可证事实（源码 + git 历史）

1. **prefs 文件与键名全程稳定，无迁移丢身份风险**：`crew-pairing`（`PairingRecord.PAIRING_PREFS`）与键 `deviceId/token/base/fallbackBase/p2pAddr/crew/session` 从最早的 `dc76379` 到当前 HEAD **逐字未变**（git 历史逐个 commit 核对）。新增 `serverCrew/serverPublicBase` 是**纯增量**：`PairingRecord.read` 对缺失键 `?: ""` 缺省，旧记录无损读出（见下方单测 `legacyRecordWithoutServerFields_readsLosslessly`）。
2. **save 保留身份**：当前 `save()` 是 `edit().clear()` 再按 `writeForSave` 全字段重写；`writeForSave = write(全字段) + session(取盘上现值)`，**覆盖全部已存键**，clear 不会丢任何键；device/token/crew 原样写回，改 route（fallback）不触身份。`PairingStore.clear()` 只在用户显式「forget」(`onForget`) 时调，非自动。
3. **deviceId 来源全程一致**：`deviceId()` = `Settings.Secure.ANDROID_ID`（= SSAID），自 `dc76379` 起未变。
4. **无异常吞错把已配对读成未配对**：`load()` → `stored()` → `PairingRecord.read`，只有 device/token/base 任一 `as? String` 为 null 才返回 null；现另有 `probeReadState()` 区分 `missing/loaded/parse_error`（不把损坏伪装成未配对）。
5. **`com.dsh.mobile` 不是本仓**：本仓 applicationId=`com.dsh.botcrew`；`com.dsh.mobile`(v0.5.37) 是**另一个 App**（不同代码库/包名）。两者是红米上两个独立包。

### 由此得出的事实性结论（不猜；字面 schema 已核等价）

**已用基线旧 APK 反编译核实（`botcrew-Redmi-old-31e96-pre-r1.apk`，sha `31e96…`，cert `ad0e448…`=同当前包，versionName 0.1.0(1)，包名 com.dsh.botcrew）**：其 `PairingStore`/`PairingRecord` 与当前**字面 schema 完全一致**：
- prefs 文件名 `crew-pairing`（同）；键 `deviceId/token/base/fallbackBase/p2pAddr/crew/session`（同集合；当前仅多 `serverCrew/serverPublicBase`，旧缺、`read` 缺键 `?:""`）。
- `read()` 解析条件逐字等价：`get(deviceId)/get(token)/get(base)` 任一为 null → 返回 null；其余 `?: ""`。
- `save()` 也是 `edit().clear()` 后 `writeForSave` 全字段重写 + session（同当前）。
- **旧包 `BuildConfig.CREW_DEVICE=""`、`CREW_CREDENTIAL=""`**（空）→ `load()` 无内置凭据回落，只能靠 `stored()` 真配对或返回 null（进配对页）。

**因此（严格按证据）**：
- **未找到「升级抹掉已存凭据」的路径**：prefs 名/键/parse 条件/save 逻辑新旧字面一致，无 rename、无静默清、clear 仅显式 forget。
- **历史「基线停配对页 / 起始凭据缺失」的原因，证据不足以下结论**——不能断言「从未配对成功」。可能来源（均无进一步证据）：从未完成配对 / 用户显式 forget / Android 清 app 数据 / 更早或不同签名包的安装历史。
- **服务端既有 Redmi 条目的 deviceId 归属**：两包**异签**（BotCrew `ad0e448…` vs com.dsh.mobile `878a115…`，设备侧已实测）→ SSAID 不同，**排除同签 SSAID 共享假设**；该条目由哪个包发起 pair，源码不能强断，需设备/服务端对照（见下）。
- 不把重新配对当修复；r2 保证新 token 存真实 prefs、同签覆盖不清 appdata、重启/切网自动连（见单测）。

### 需 verify 员设备侧补证（我不碰设备，列清单）
1. 两包已实测异签（已给：BotCrew `ad0e448…` / com.dsh.mobile `878a115…`）→ SSAID 不共享，成立。
2. 服务端 `GET /orchestrator/api/remote/devices` 的 Redmi 条目 deviceId 对照 `com.dsh.botcrew` 现读 ANDROID_ID + prefs 是否有 device/token；据此判该条目由哪个包发起。
3. 首次真实 pair 只由 com.dsh.botcrew 发起 → 确认落盘 prefs → force-stop 重开验证自动连（不重配）。

---

## 二·0d、执行层第二缝：手动补传 IO 漏（r2 同批）
真机发现：诊断页手动补传永远 post_failed，后台 auto 成功。根因：`DiagRuntime.uploadNow` 直接在 UI（`rememberCoroutineScope` Main）上调 `u.uploadOnce()`，而 `RealTransport.post` 是 blocking `HttpURLConnection` 无 `withContext(IO)` → `NetworkOnMainThreadException` 被 catch 伪装成网络异常。

**最小修（模块级保证 UI 安全，不要求每个 caller 记住 IO）**：
- `uploadSingleFlight()` 整体 `withContext(Dispatchers.IO) { mutex.withLock { uploadOnce() } }` —— 所有入口（manual/auto/flush/网络恢复）只走这一个中央入口；`uploadNow` 不再自己拿 mutex/直接 uploadOnce。
- `RealTransport.post` 自身也 `withContext(Dispatchers.IO)`（模块级兜底）。
- 失败日志只记**异常类名**（`logUploadFailure`/`ClientDiag.errOf`），不记 message/headers/token/URL；上传不经 `DiagClient` 记录点，不递归上报。
- 手动文案抽纯函数 `DiagUploader.describe(outcome)`：ACK 成功显示「已上报 发送/确认 N」、无待传说「都已上报」、仅 429 叫「限流」、post_failed 说「网络异常」。

**边界测试**：`upload_runsOnIoThread_notCallerThread`（withContext(IO) 驱动，blocking transport 不在调用线程跑）+ describe 5 例。

---

## 二·0、lead 复核后修正（4 项真实必修 + 前台节奏）

1. **DiagUploader 只删 acceptedIds**：删除逻辑改为只 `removeIds(result.ackedIds)`；`rejectedIds` 与本地超限行**不删**，进进程内 `quarantine` 集合，后续批次自动跳过（毒记录不无限重试、不静默丢报告），保留供诊断页查看导出。测试覆盖：部分 ACK 只删对应、reject 保留且后续正常事件仍能传、离线保队列、HTML/redirect/ok:false/空 accepted 绝不删、超大行保留跳过。
2. **去 DEFAULT_BASE 硬编码域名**：`DiagUploader` 不再有默认 crew 域名；`DiagRuntime.bindUploader(deviceId,credential,baseUrl)` 要求合法 HTTPS，非法/空→ unbind、不上报、不发 token。新增纯函数 `UploadEndpoint.decide`：上传入口只取 ①同 crew 的 `serverPublicBase` ②HTTPS `fallbackBase` ③注入 `DIAG_BASE` 且 savedCrew==expected 精确匹配；全部经 `validEndpoint`（HTTPS、无 userinfo/query/hash）校验。**端点校验在 Transport 之前**。
3. **单飞 + 单 Job**：所有触发上传的入口（周期/网络恢复/手动/配好补传）经同一 `Mutex` 单飞；上报循环是进程唯一 `Job`（重复 start 先 cancel 旧 Job，Activity 重建不叠循环）；前台才周期轮询，后台只做「生命周期最后一批 + 回前台/下次启动补传」，不造保活 service。
4. **RoutePolicy 蜂窝首请求不先撞死 P2P/LAN**：`plan()` 增加 `networkKind` 输入；`CELLULAR` 且可信公网存在时把 PUBLIC 排 **order[0] 直接起手**，其余非公网入口用短 connect（3s）——首次跨网（健康证据被网络切换清空）不再先耗 P2P/LAN 的 15s。按 lead/独立 review 口径：cellular **不**置 quickProbePublic（公网即起手，不再冗余探一趟）；quickProbe 只留给「起手是 LAN/UNKNOWN 且不健康」。不改业务 readTimeout(20s)，不误伤长请求/真实写幂等。测试覆盖 WiFi 成功→切 cellular 清健康→首请求顺序与 timeout。
5. **前台节奏**：`UPLOAD_INTERVAL_MS` 60s→**10s**（约 6 轮/min，低于后端每 device 30 批/min，尊重 Retry-After）；不再称 60s 为「实时」。
6. **uploadNow 文案准确**：先分 `skipReason`——`post_failed`（DNS/连接/超时，网络异常）→「暂未成功（网络异常），记录已保留，N 秒后重试」；仅 `backoff`(429) →「服务端限流」；不再把断网/蜂窝不通谎报成限流。
7. **DiagAck 注释修正**：Result 头注释改为「rejected 保留 quarantine，仅 acked 删」，消除「rejected 也删」的误导。

---

## 二、对齐 lead/后端冻结口径（逐条）

- **身份规则**：仅 `savedCrew(serverCrew 或 crew) === server.crew` 精确相等 + HTTPS(TLS) + `session_api` 结构合法，才更新持久入口；采纳 `server.public_base`（有效 HTTPS，含合法子路径）优先，否则候选本身。空 savedCrew **拒绝**任意 bootstrap 200；首次身份只从既有可信配置地址或 new-pair 登记。用户已发布 `server.crew=0kvcc5t / public_base=https://crew.kentonnie.top`，客户端直接可用。
- **不把 200/ready/session_api 当身份**：session_api 只作协议形状辅助，身份只认 crew 精确相等。
- **启动快照可观测**：prefs 三态 `prefs_missing / prefs_loaded / prefs_parse_error`（errorClass 不带 message）；parse_error 保留原始 prefs、不自动覆盖；detail 与 hostname 只进本地 logcat/诊断页。
- **上报只白名单字段**：不把 host/paired 布尔塞 extra（服务端丢未知键）；host 只本地显示 hostname（不含 userinfo/query）；不加 event/phase 编码后门。
- **build 标记**：`-PcrewBuildId=cellular-20261115-r1` → `BuildConfig.CREW_BUILD_ID`，`body.build=0.1.0(1)/cellular-20261115-r1`，诊断页显示；generic 默认 local，不动 versionName/versionCode，不引 git 自动 commit。
- **权限**：仅用现有 `INTERNET + ACCESS_NETWORK_STATE`（ConnectivityManager 判连接种类），无 READ_LOGS/IMSI/号码等新权限，无旁路后台 service。
- **开关语义**：关 = 不收集、不自动上传；已有记录保留、可手动清理（DiagPage 文案写明）。
- **不递归**：上传走独立 `RealTransport`（HttpURLConnection），不经 `CrewClient.read()`/`diagSink`，故上传请求不进环形、不自我循环上报。

---

## 三、根因修复（换路，非打补丁）

- 旧：`read()` 串行从 current 起手，死 LAN 每请求 connect 阻塞 15s 才落域名；`retryDelay` 只护探测循环。
- 新：`RoutePolicy.plan` 算起手——健康入口 sticky 排前；失败冷却期入口排后；已知健康公网时对死 LAN 用短档 `3s`；起手是死 LAN 且有公网则先 `quickProbePublic`（3s）探通即走。业务 readTimeout(20s) **不降**（不误伤 long-running 读/真实写幂等）；只对非健康 LAN/冷却入口用短**connect**超时。

---

## 四、已验证（本成员自检，非最终门禁/真机）

- `:app:compileDebugKotlin` exit 0；`:app:assembleDebug` BUILD SUCCESSFUL。
- targeted 6 测试类 **64/0 绿**：ClientDiag 12 / DiagAck 10 / RoutePolicy 12 / PairingRecordProbe 6 / BootstrapGate 10 / DiagUploader 14。
- 全量 app 单测（早前一轮）547/0 绿（含既有 DrawerNavigation/ConnectionStatus/Recipient/Approval 等无回归）。
- manifest 未改（无新权限）。
- 注：最终 testDebug/testRelease/assembleRelease（带既定 3 prop）+ 差分 DiagContractReviewTest 由 task13 独占执行。

---

## 五、留给独立验证 / 联调（未做，需真机）

- 未 pair → 首次 pair（登记 server 身份）→ 关 WiFi 蜂窝 → 读取 timeline → 诊断落到环形 → 经 `https://crew.kentonnie.top/api/mobile/diagnostics` 上传直通 的真实走查（`wb-drawer-verify` 执行）。
- 换路在蜂窝下不再每请求 15s（真实时延对比）。
- 同签覆盖红米（`ad0e4480…af7eb`，保 firstInstallTime/配对）由验证员最后执行。
- 全量门禁（含既有 472/checkpoint + 本批）由独立成员跑；本成员只跑 targeted。
- 未 commit/push（等 lead）。

**风险/边界**：uploader 编排的真 HTTP 交互（ACK 删本地/429 退避/断网补传）已在纯逻辑层覆盖（DiagAck + planBatches + uploadOnce 编排），但端到端需真域名联调确认；`server` 字段依赖后端已发布版，旧后端缺失时客户端跳过自愈不报错。
