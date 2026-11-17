# 手机诊断上报 · 客户端协议独立 Review（r2 通过）

日期：2026-11-15（Asia/Shanghai）。执行：`wb-report-api-verify`（独立协议 review）。对象：`app/app/src/main/java/com/dsh/botcrew/` 的 `ClientDiag / DiagAck / DiagRingStore / DiagUploader / DiagRuntime / RoutePolicy / BootstrapGate` 及 `CrewClient / MainActivity / PairingStore` 接线。
边界：只读 review + 独立差分测试（固定文件，交 task13 统一 Gradle）；不改源码、不碰手机/ADB。

## 结论：r2 通过

最终门禁：debug / release 各 **575 全绿**（含本 review 新增 6 例差分 A–F）；**r2 版 `assembleRelease` 成功**（固实：构建 SHA `0eb388…` + device hash + debug/release 各 575 变体）。**r2 sha `0eb388…` 已同签覆盖安装**，覆盖/重启/跨网均**免重配**、`pairedAt` 不变。真机真实 Cell 走 PUBLIC **25 条 200**、日志到域名 `received`；manual IO 错误已解——见主证据图 [`r2-03-diag-manual.png`](r2-03-diag-manual.png)：屏幕明示**「已上报：发送 1，服务端确认 1，拒收隔离 0（保留供诊断）」**，即 manual 真实 **ACK=1**（构建标记 `cellular-20261115-r2`，记录 `GET /api/mobile/timeline →200 … receive·public`），非未知数。

### 已在真机 + 门禁验证的关键点
- **执行层真从 `ordered[0]` 起手**：`CrewClient.read()` 已删「按旧 current 旋转」(`begin=indexOf(current)`)，`for (step in ordered.indices) { entry = ordered[step] }`；`current` 只在成功后记最近成功供显示，不参与排序。修掉真机 r1「19 条全 200 但 routeKind 全 p2p」根因（旧逻辑把 PUBLIC-first 旋回死 P2P 先成功）。
- **中央 IO**：所有上传（manual/auto/flush/配好补传）都经 `uploadSingleFlight`＝`withContext(Dispatchers.IO){ mutex.withLock{ uploadOnce() } }`；`RealTransport.post` 自身再 `withContext(IO)` 兜底。manual 不再在 UI 主线程跑阻塞 `HttpURLConnection`（原会抛 `NetworkOnMainThreadException` 被伪装成网络失败）。
- **captureBuild 固化**：`BuildInfo`（由 `BuildConfig.CREW_BUILD_ID/VERSION_*` 启动灌入）在事件/崩溃构造期即取 `buildIdLabel()` 写入每条记录；body `build` 带 `版本(码)/构建标记`，服务端可对照真实 APK。
- **存储持久有界**：`DiagRingStore` 原子写 `tmp → fd.sync → Files.move(ATOMIC_MOVE, REPLACE_EXISTING)`（不先 delete、失败保原并抛），`append` 亦 `fd.sync`；ring 500 行/512KiB 有界；隔离集 `quarantine.jsonl` 持久有界（MAX_QUARANTINE 500/64KiB，ring 溢出 prune 无主项）。跨进程/重建仍生效。
- **legacy 身份兼容**：老配对记录 `serverCrew` 为空时 `serverCrew.ifBlank { crew }` 回退，bootstrap/rebind/上传入口均按此取 savedCrew；不重配对即可自愈公网入口，且 `BootstrapGate` 空 savedCrew/不符/空配置一律 0 请求 0 token。

## 一、协议/安全主链（已核通过）
- **ACK 仅 accepted**：`DiagAck.parse` 仅 2xx + content-type 含 json + 顶层 `ok===true`(严格布尔) 才 ACK；`acceptedIds/rejectedIds` 与 sentIds 取交集，只删 acked；redirect/SPA `200 text/html`/`ok:false`/非 JSON → nothingAcked 不删；不跟随 30x。
- **拒收隔离/部分 ACK**：`rejectedIds`、本地 oversize 进持久 quarantine（不删、后续批次跳过），普通新事件照传；断网/半批不误删未确认记录。
- **端点仅可信同 crew HTTPS**：`validEndpoint` 强制 HTTPS + 无 userinfo/query/hash；上传地址只取 `serverPublicBase / HTTPS fallback / diagBase(且 savedCrew==expectedCrew)`，空/非法 → 不 bind → 不发 token。
- **字段/边界/脱敏**：`ClientDiag` 白名单逐字对齐契约；`planBatches` event≤1KiB / crash≤16KiB / 批≤50 / body≤64KiB；`routeOf` 去 query/hash 且含 `%` 一律空（多重编码不记）；`sanitizeStack` 只留结构帧（message/URL/token/secret 行整条丢）；`wireExtra` 只 5 键 + 敏感值整条丢。
- **单飞/生命周期/开关**：`uploadMutex` 单飞、`loopJob` 单 Job 不叠加、`foreground` 只前台轮询、`enabled=false` 空操作、crash handler 只记一条且不联网。
- **网络可观测**：`updateNetwork` 记 wifi/cellular/….，`extra.networkKind` 入事件，切网变化记一条；cellular 可见。

## 二、差分测试（固定文件 `app/app/src/test/java/com/dsh/botcrew/DiagContractReviewTest.kt`，纯 JVM，交 task13 统跑）
只补 owner 现有测试差集、不镜像：
- **A** 传输异常 → `Outcome.skipReason=="post_failed"` 且 backoff>0、本地不删（owner FakeTransport.throwIt 未用，未覆盖）。
- **B** 429 → `skipReason=="backoff"`，与 A 可区分、不删。
- **C** 蜂窝 + public 已排首位 → `quickProbePublic==false`（lead 最终不变量：public first 不重复 preprobe）。
- **D**（真实 tmp 文件）新实例（重启/rebind）建 uploader：持久隔离项不再重投、普通新事件仍上报（「重启忘拒收」端到端缝）。
- **E**（真实 tmp 文件）隔离集 > MAX_QUARANTINE 落盘封顶=有界。
- **F**（真实 tmp 文件）ring 溢出 trim 时 prune 无主隔离项（ACK 删的必是未隔离 id，故隔离项只随 ring 淘汰消失、trim 正清）。

## 三、未由本 review 覆盖（归真机/task13）
- `DiagRuntime.uploadNow` 文案分支、`CrewClient` 真实 HTTP 超时 —— 真机/Gradle 已覆盖（见上「结论」真机证据）。
- 真机 cellular baseline 在 r2 同签安装后已闭环（真实 Cell PUBLIC 25 条 200）；后续多网/长时间稳定性由 task13 真机继续观察。
