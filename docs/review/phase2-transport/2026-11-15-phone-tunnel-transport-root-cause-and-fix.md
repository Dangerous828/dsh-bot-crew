# 手机隧道断流与接收失败静默：根因诊断 + 最小根治（task-10，wb2-transport-fix）

日期：2026-11-14/15 · 角色：`wb2-transport-fix`（lead 唯一手机/ADB/Android/native 窗口所有者）· claim task-10 rev1
范围：`app/app/src/**`（TailcatP2p / CrewUi / 新增 NoticesHealth + 3 个 test）与本文档。**backend 一字未动**（runtime/index/KV/push/messages 不动；`src/integrations/**` 与 integration 测试的近期改动是 wb2-internal-live 的，不是本成员）。手机 `55c86317` 独占，未读其他 app 个人数据，未 adb backup，未清数据/卸主 app/改 pairing。

> 一句话：前成员「等 P2P 稳定窗口再复测」被 lead 打回是对的 —— **静默吞错本身违反可观察要求，且根因不在外部网络**。本轮在受控条件下客观复现出两条真实连接生命周期缺陷（**半关闭被当整条关闭掐断在途请求**、**探测与业务共享 HTTP 连接池互相 disconnect**），各配一个能在 JVM 精确复现的变异测试（红→绿），并修掉 notices 轮询的静默吞错。真机（release 签名版）在**生产后端真链路**上跑通 peek→落地→ACK→pending 消失→seen 正确→UI 上屏，含 force-stop 期间排队+冷启动重连领取、重复拉不重显。

---

## 0. 结论与证据速览

| 项 | 结果 |
|---|---|
| 根因1：半关闭被当整条关闭 | 已定位 + 已修（`Tunnel` 拆双向收尾），变异测试抓得住 |
| 根因2：探测与业务共享连接池互相 disconnect | 已定位 + 已修（探测请求 `Connection: close` 不入池），变异测试抓得住 |
| 根因3：notices 轮询静默吞错 | 已修（`NoticesHealth` 可观察态 + UI 如实显示） |
| 真机端到端 ACK（生产后端真链路） | **通过**（3 次：debug在线 / debug离线上线 / release在线） |
| force-stop 期间排队 + 冷启动重连领 | **通过**（队列不丢、不假送达、重连领取并 ACK） |
| 重复拉不重显 | **通过**（本地按稳定 id 去重，prefs 只有 1 条） |
| 单测 | debug **425/425**、release **425/425**（原 417 + 新增 8），全绿 |
| 最终 release APK | sha256 `011d0634…3dfbf41c` = 设备 base.apk；firstInstallTime/权限/主配对不变；旧产物未覆盖 |
| 生产进程 | dsh89699 / mobilegw67367 / tailcat 43499 **全程未重启**（PID/lstart 不变） |

---

## 1. 诊断闭环（客观复现，先把 bug 钉死再动手）

### 1.1 复现条件（为什么前成员「等稳定窗口」等不到）
前成员把 `tc_conn_read 失败（status=2 TC_CLOSED）：use of closed network connection` 归因「既有 P2P 不稳定，等稳定窗口复测」。实测反证：**好网络下 bug 根本不出现**——本轮在手机好网下连抓 95s（4 个 probe 周期 + 每 6s notices/timeline），`closed network / 隧道读结束 / 本地读结束` 计数 **0**，probe 全 13–18ms 成功。稳定窗口里 bug 是被藏起来的，不是不存在。**这是连接生命周期缺陷，只在特定交错下触发，不是外部网络。**

### 1.2 哪条请求 close 谁的 handle —— 源码级定位（不是拿单行 log 定论）
手机把每个 APP 到 `127.0.0.1:<proxy>` 的本地 TCP 连接，在 `TailcatP2p.Proxy.session` 里 `nativeDial` 出一条 tailcat conn，交给 `Tunnel(socket, conn)` 双向搬字节：`down()`（隧道→本地）+ `up()`（本地→隧道）。**两个方向共享同一个 `conn` 句柄。**

- **根因1（主因，`Tunnel`）**：旧 `down()` 一旦读到服务端 FIN（`nativeRead` 返回 `<0`）就 `shutdown()` → `nativeClose(conn)`。但一条 TCP 被拆成两个方向，**服务端关写只代表「隧道→本地」这个方向结束，不代表「本地→隧道」在途的请求可以被打断**。HTTP keep-alive 场景下，`up()` 此刻可能正把客户端的下一个请求写进同一 `conn`；`down()` 的 `nativeClose` 会把它掐断 —— 新请求的 `nativeRead`/`nativeWrite` 就报 `use of closed network connection`。**现象是「隧道自己断了」，实际是本进程另一条线程（down）关了 up 正在用的句柄。** 这直接回答「哪条 close 谁的 handle」：**down 的收尾 close 了 up 的 handle。**

- **根因2（加剧，probe↔业务共享池）**：`TailcatP2p.request()`（探测用）与 `CrewClient.attempt()`（业务用）都打 `127.0.0.1:<同一个 proxy 端口>`。`HttpURLConnection` 的全局 `KeepAliveCache` **按 host:port 分桶**，于是探测与业务落进同一个桶、可能复用同一条物理连接。探测超时那句 `connection.disconnect()` 会关掉这条池化连接 —— 若业务请求正好在复用它，业务侧就读到 closed；反之业务每请求一次的 `disconnect()` 也能关掉探测刚抓到、正在读的连接。**谁 close 谁全凭调度。**

- **`read 遇 EOF 前响应已完整？`** 修复后**保证完整**：`down()` 现在是「把服务端所有字节写完 + flush 之后**才** `shutdownOutput()`」，客户端读到 EOF 时正文已经全部到达、`Content-Length` 已满足，不会读到半截。

### 1.3 最小复现路径（把 bug 变成可重跑的测试，而不是一次性现场）
- `TailcatTunnelTest.aServerFinMustNotAbortAnInFlightRequestOnTheSameConnection`：用假 `TunnelConn` 精确造「服务端先 FIN、客户端随后在同连接发下一个请求」。**变异验证**：把 `down()` 改回「读到 EOF 就 `nativeClose(conn)`」→ 用例**红**（line 131：「down 读到 EOF 后 up 仍必须能写进隧道」，收到 0 字节/抛 closed）；恢复修复 → 绿。**坐实根因1。**
- `TailcatProbeIsolationTest.probeAndBusinessNeverShareAPhysicalConnection`：真 socket 起「隧道那头」模拟 server，**并发**跑 `TailcatP2p.probe` 与业务式 GET 6×6 轮；断言零失败且探测命中 latency 的连接都带 `Connection: close`。**变异验证**：去掉探测请求的 `Connection: close` → 用例**红**（`latencyConnHeaders` 不含 close）。**坐实根因2。**

---

## 2. 最小根治（改根因，不打补丁；transport 接口/错误状态最小改，不新开大 UI/不加 FCM/OS 通知/保活/语音）

### 2.1 `TailcatP2p.kt` —— 半关闭语义 + 探测不入池
- 新增 `internal interface TunnelConn`（read/write/closeWrite/close）+ `NativeTunnelConn(handle)` 真实现：把 `Tunnel` 从 native 解耦，半关闭并发语义可在 JVM 用假连接精确测（真实现仍走同 JNI，行为一字不变）。
- `Tunnel` 重写收尾：
  - `down()` 读到 EOF → **只** `socket.shutdownOutput()`（本地半关闭，客户端因此读到 EOF），**不碰 conn**；`downFinished=true` 后调 `maybeShutdown()`。
  - `up()` 读到本地 EOF → `closeWrite()`（告诉远端请求结束），再 `lingerOrWaitForDown()` 宽限等 down 收完。
  - `maybeShutdown()`：**只有 downFinished 且 upFinished 都为真**才 `socket.close()+conn.close()`（`done` CAS 保证一次）。down 先结束、up 仍在写时**绝不提前 close conn** —— 这正是根因1。
  - `close()`（代理收摊/配对重建）两个方向都置结束再释放，接口保留。
- `request()`（probe）：请求头加 `Connection: close` + `useCaches=false`，且**成功也 `disconnect()`** —— 探测一次性，绝不进共享池，既不占也不关业务连接。整轮 20s 预算/到点 disconnect 打断 read/回收读线程（原 #20 修复）原样保留。
- 保留：`probeBudget()` 纯函数、`PROBE_BUDGET_MS=20_000`、地址 field 不被发现流抢（`CrewClient.replaceEntries` 保留 local proxy）、退避 `CrewRoute.retryDelay`。

### 2.2 `NoticesHealth.kt`（新增）+ `CrewUi.kt` —— notices 不静默
- 纯数据 `NoticesHealth(consecutiveFailures,lastError,everSucceeded)`：`onSuccess/onFailure/line()`，成功清零、失败累加、文案「推送获取失败，正在重连（第 N 次）· <原因>」只在失败态出现。
- `CrewUi` 轮询：`catch (CancellationException) throw`；`catch (Exception)` 不再 `catch(_){}`，改为 `noticesHealth = onFailure(...)` + `Log.w("CrewNotices",...)`；成功则 `onSuccess()`；顶部在 route 行下多一行如实提示（失败即现、成功即隐，不新增页面）。**UI 不再保持「隧道已连接」假绿盖住「一条推送都没拿到」。**

### 2.3 重连 / 有界 timeout / LAN-relay 回退（既有 + 本轮不破坏）
`CrewClient.read()` 已按 P2P→LAN→PUBLIC 顺序逐条试、失败换路、`CrewHttpStatus` 不误记地址失效、`preferBetterEntry` 恢复后切回；`MainActivity` probe 循环 `retryDelay` 1/2/4/8/16/30s 退避、`repeatOnLifecycle` 仅前台。本轮修复让「P2P 连接被对向误关」不再发生，回退到 LAN/relay 只在真·连不上时触发，不再因假断流频繁降级。有界：probe 20s 整轮预算、`CrewClient` connect 15s/read 20s、`DIAL_TIMEOUT_MS 20s`、`LINGER` 有界。

---

## 3. 测试证据（TDD 红→绿 + 变异验证；原 417 不退）

### 3.1 单测
```
./gradlew :app:testDebugUnitTest   → 425/425 绿（52 文件）
./gradlew :app:testReleaseUnitTest → 425/425 绿
```
基线 417（前序 debug/release 一致）+ 新增 8：
- `TailcatTunnelTest`（2）：半关闭不掐断在途请求；客户端半关闭后 down 仍搬完响应。
- `TailcatProbeIsolationTest`（1）：探测+业务并发零失败、探测连接不带 keep-alive。
- `NoticesHealthTest`（5）：失败累加/成功清零/文案只在失败态/空原因兜底。

### 3.2 变异验证（证明测试真能抓 bug，而不是同义反复）
- 撤 `Tunnel` 半关闭 → `aServerFinMustNotAbortAnInFlightRequestOnTheSameConnection` **红**（line 131，写进隧道 0 字节）。
- 撤探测 `Connection: close` → `probeAndBusinessNeverShareAPhysicalConnection` **红**（latency 连接头不是 close）。
两处恢复后全绿。

## 4. 真机端到端（release 签名版 · 生产后端真链路 · 证据可复核）

**链路**：手机 `127.0.0.1:proxy` → tailcat 隧道 → `tailcat serve 43499`（pid 75595）→ **DSH superagent 89699 的 43499**（即 backend `mobile-http` notices 路由）→ 生产 Store `~/.dsh/state/superagent/orchestrator.sqlite` 的 KV `notice-pending:<deviceId>`。设备 deviceId `66e74d226c1e38fa`（配对完好：session=work、base=192.168.31.127:43499、p2pAddr 在）。

> 注入仅"精确本任务 record"：向生产 KV `notice-pending:66e74d226c1e38fa` 写受控 canary（`kind:internal`，正文标注诊断来源），验证后精确删除并核回基线（`notice-*` 键清零、`PRAGMA integrity_check=ok`）。canary id 全部用 `sha256(deviceId\0kind\0title\0body\0at)[:16]`，只我自有标识，未碰真实业务数据。

| 步骤 | 证据 |
|---|---|
| ①在线 peek→落地→ACK | 注入 `a05e16d8f88ed7d6` → 手机 ≤12s 轮询 → `notice-pending` 键**消失**、`notice-seen` 出现该 id；UI 截图 `e2e-ack-ui.png`「有事记得看一下 · 1」+ 正文 |
| ②重复拉不重显 | 再等 12s，`notice-pending` 仍空（不重投）、设备 prefs 中该 id 计数 **1**（不重显） |
| ③force-stop 排队 + 冷启动领取 | force-stop 后注入 `b5acecf31512f180` → 10s 仍 `queued`（**不假送达**）→ 冷启动重连 → pending 消失、seen 增该 id；UI「· 2」两 banner（`e2e-offline-pickup.png`） |
| ④release 版复跑 | 换 release 签名 APK 后注入 `b034940cc512f22c` → pending 消失 + seen 有该 id（`e2e-release-ack-ui.png`） |
| ⑤多 GET 无句柄互 close | 好网 95s：probe4 周期 + notices/timeline 每 6s，`closed/隧道读结束/本地读结束` 计数 **0**；并发正确性由 `TailcatProbeIsolationTest` 钉死 |

三张截图：`docs/review/phase2-transport/{e2e-ack-ui.png, e2e-offline-pickup.png, e2e-release-ack-ui.png}`。

## 5. 最终 APK（release 签名，保配对/权限/firstInstallTime，旧产物不覆盖）

- 构建：`assembleRelease` → unsigned sha `e71a42b0…`（JDK21；JDK25 会因 JavaVersion 解析失败）。
- 签名：**与设备同历史 debug key**（`CN=Android Debug`，证书 SHA-1 `2D:DF:…:95:55`，与设备 `29b26ea2` 一致）。
- 最终：`docs/review/final-android/deliver/dsh-botcrew-internal-final-20261115-0010-transport.apk`
  sha256 **`011d0634167281b77f6fad6e7d16dfd0660e371539a7b377610b5be67dfbf41c`**。
- 设备核对：`base.apk` 拉回 sha256 = 同上（一致）；`firstInstallTime=2026-11-11 22:27:11` 不变；`flags` 无 DEBUGGABLE（release/debuggable=false）；INTERNET/ACCESS_NETWORK_STATE/CHANGE_WIFI_MULTICAST_STATE/NEARBY_WIFI_DEVICES 全 granted；启动后 UI 显示隧道已连接+session=work+队伍（配对保留）。
- 旧产物 `dsh-botcrew-final-2056.apk`、`dsh-botcrew-internal-final-20261114-233456.apk` **保留未覆盖**。
- 说明：release debuggable=false 不能 `run-as`；清本地 canary 时用 debug overlay 清 prefs 后再 `install -r` release（首装时间/配对不变），**未因认证导出任何 prefs 日志**；配对保留由 firstInstallTime+同证书+install -r+运行态 UI 证明。

## 6. 源码冻结（本轮快照）
```
f81ba46c…c1bd912  app/app/src/main/java/com/dsh/botcrew/TailcatP2p.kt
e6ce21fe…68eebf199 app/app/src/main/java/com/dsh/botcrew/CrewUi.kt
1a3234a5…7f17f39f app/app/src/main/java/com/dsh/botcrew/NoticesHealth.kt
f41a84b9…dad59587 app/app/src/test/java/com/dsh/botcrew/TailcatTunnelTest.kt
f577b740…ac6beecc app/app/src/test/java/com/dsh/botcrew/TailcatProbeIsolationTest.kt
572cd422…b85da1f707 app/app/src/test/java/com/dsh/botcrew/NoticesHealthTest.kt
```

## 7. 纪律与未做
- 未改 backend 任何源码（runtime/index/KV/push/messages/integrations 全不碰；近期 `src/integrations/**` 改动是 wb2-internal-live 的）。
- 未重启 dsh89699/mobilegw67367/tailcat43499（PID/lstart 全程不变）；未 start/restart/ensure_gateway、未 pkill/killall/launchctl、未改全局网络/开 SIM/改路由。
- 未 adb backup、未清数据/卸主 app/改 pairing；未读其他 app 个人数据；未抢 mac 焦点；手机操作前均确认前台是本项目 app（一度 `com.android.backupconfirm`/`recvtest` 前台，已 BACK/拉起主包纠正，未截他 app 屏）。
- 未 git add/commit/push/stash/checkout/restore/reset；未动进度/HANDOFF/crew-watch。
- 生产注入只精确 `notice-pending:66e74d226c1e38fa` 的受控 canary 并事后精确删净（含 seen 账本我自有 id），基线：无 `notice-*` 键、integrity ok。
- 不恢复 FCM/语音/系统通知/保活/新大 UI。

## 8. 剩余条件（精确说明，不以「等窗口」结束）
- 根因1/2/3 均已在本轮定位+修复+测试+真机端到端验证，**不依赖任何外部稳定窗口**。
- 唯一未在本轮覆盖的场景：极端弱网（限速/丢包重传）下 probe 20s 整轮预算内的行为 —— 这是 #20 第2项已有的墙钟收口（本轮未改动该部分逻辑，原 5 例仍绿）；弱网**不影响本 bug 的修复**（本 bug 是连接生命周期，与带宽无关）。
- #20 第1项（真实跨 NAT 打洞成功率）仍是既有外部阻塞（缺不同 NAT 出口对端），与本次手机传输修复无关，不并入本结论。
