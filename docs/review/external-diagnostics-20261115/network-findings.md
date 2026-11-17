# 出门后 APP 用不了 · 外网域名链路只读诊断

日期：2026-11-15（Asia/Shanghai）。执行：`wb-external-diagnose`（真实 WorkBuddy 成员，只读诊断）。
任务：task-9「定位离家后域名链路失联根因」。
**边界**：本轮**只读**。未重启 / 未部署 / 未编辑源码或配置 / 未 git / 未发业务消息审批 / 未改系统网络或 Mac 焦点。未读任何凭据内容（token 只在进程内取用，从不打印、不落证据）。
证据优先级：运行态 > 请求流 > 配置 > 文档。

---

## 一、结论速览

| 项 | 判定 | 证据 |
|---|---|---|
| 后端服务健康 | ✅ | `/orchestrator/api/state` health 13 项全 ready |
| 局域网链路 | ✅ | `127.0.0.1:43499/api/mobile/timeline` 带真凭据 200 / 15ms |
| 公网主域名链路（**仅 Mac 出站**） | ✅ 通（Mac 侧） | `https://crew.kentonnie.top/api/mobile/timeline` 带真凭据 **200**；**不代表手机蜂窝可用** |
| 中转兜底 | ❌ 断 | `/crew-relay/health` = `{"ok":true,"tunnels":0}` |
| 跨 NAT 打洞 | ⏳ 未验证 | #20 至今无异地 NAT 对端 |
| CF 挡 App | ❓ Mac 侧未复现，**蜂窝待测** | 1010 仅 Python-urllib；Java UA Mac 200。**不泛化排除** |
| **出门 APP 用不了 · 最可能（假设，未坐实）** | **手机存的是空/旧 `fallbackBase`（公网入口）** | App 选路 `fallbackBase` 来自配对时 mDNS `pub`；红米配于 2026-11-11；红米不在线，未读其 stored 真值 |
| 真机/蜂窝实测 | ❌ 未做 | 全部是 Mac 单机出站，不是蜂窝实测 |

**一句话**：服务与公网域名链路在 Mac 侧实测都是通的，所以「出门用不了」**不是**后端宕机或域名挂掉。**假设（未坐实）**：手机本地存的公网入口（`fallbackBase`）在配对那一刻为空或过期，出门后只剩不可达的 LAN 入口可试。**红米未在线、未读其 stored `fallbackBase` 真值，故这是高概率假设不是已确认根因**；待客户端新诊断页在保留配对的升级后记录实际 stored 真值再修。

---

## 二、实际域名与链路（从运行态 + 配置找到，无需用户再给）

### 2.1 域名来源（非猜测）

| 项 | 值 | 来源（运行态/配置） |
|---|---|---|
| 外网主域名 | `https://crew.kentonnie.top` | `~/.dsh/state/superagent/mobile-public-url`（内容）＋ `~/.cloudflared/crew-mobile.yml` |
| CF 隧道 | 名 `crew-mobile`，tunnel id `39802046-…` | `~/.cloudflared/crew-mobile.yml` |
| CF ingress | `crew.kentonnie.top → http://127.0.0.1:43499`，`httpHostHeader: 127.0.0.1:43499`，`keepAliveTimeout: 900s` | 同上 |
| 中转隧道 | `wss://jarvis.kentonnie.top/crew-relay/tunnel` | `~/.config/crew-desktop/relay.env`（仅取 key，值未打印） |
| P2P 地址 | `tcpGFwWCDQf-…`（tc-addr） | `~/.dsh/state/superagent/mobile-p2p-addr` |

### 2.2 三条路（代码实证，`CrewRoute.entries`）

```
手机 App ──① P2P(tailcat tc-addr)──┐
         ──② LAN(base) ───────────┼──► 43499
         ──③ 公网(fallbackBase) ──┘
```
- `PairedCrew(base, fallbackBase, p2pAddr, crew, session)`（`PairingClient.kt:116`）。
- 选路优先级：`proxyPort(P2P) → base(LAN) → fallbackBase(公网)`，`CrewRoute.entries()`。
- `fallbackBase` 只在**配对 / 重新发现**时，从 mDNS TXT 的 `pub` 抄下来（`CrewNearby.kt:117-125`：`fallbackBase = beacon.publicBase.ifEmpty { paired.fallbackBase }`）。
- mDNS TXT 四格：`{crew, port, pub, p2p}`（`discovery.ts`）；`pub` 来自 `public-entry.ts`（`CREW_PUBLIC_URL` 优先，否则 `<stateDir>/mobile-public-url`）。

### 2.3 运行态进程/端口（latency，2026-11-15 ~19:50）

| 组件 | pid | 监听 |
|---|---|---|
| dsh 后端（superagent profile） | 89699 | 192.168.31.127:3082、43499（多地址）、100.10.10.3:43499(EasyTier)、IPv6 多条、127.0.0.1:43499 |
| mobilegw | 67367 | 127.0.0.1:8788（launchd `com.cpuser.dsh-mobilegw`） |
| tailcat serve | 68145 | 43499（P2P data plane） |
| CF crew-mobile 隧道 | 25795 | launchd `com.cpuser.crew-mobile-tunnel` |
| CF ssh 隧道 | 80614 | 127.0.0.1:7022 |

> LAN 动态端口提示：43499 是当前 stateDir 推导出的值，**不要硬编码**（换 profile/目录就变）。既往 3082 需 `x-orchestrator-request:1`；8788 是 mobilegw health。

---

## 三、健康实测

### 3.1 后端 `/orchestrator/api/state`

`paused=False`，`load={running:0, queued:0, maxWorkers:3}`，health 13 项**全 ready**：
`runtime / relay / notice / memory / launch / delivery / assessment / reply / evals / models / p2p(direct tunnel at tcpGFwWCDQf-…) / github(0 notifications) / team(0 messages)`。

**服务本身不健康问题是排除项。**

### 3.2 各入口真实请求

| 请求 | 结果 |
|---|---|
| `127.0.0.1:43499/health` | 404（正常，只服务 `/api/mobile/*`） |
| `127.0.0.1:43499/api/mobile/timeline` 无凭据 | 401 `{"error":"Not paired"}`（围栏在） |
| `127.0.0.1:43499/api/mobile/timeline` 真凭据 | **200 / 15ms**（LAN 可用） |
| `https://crew.kentonnie.top/api/mobile/timeline` 无凭据 | 401（边缘 `cf-ray`、`server: cloudflare` 正常） |
| `https://crew.kentonnie.top/api/mobile/timeline` 真凭据 | **200**（公网域名链路在 Mac 出站侧可用） |
| `https://jarvis.kentonnie.top/crew-relay/health` | `{"ok":true,"uptimeMs":…,"tunnels":0}`（中转业务面 ✅，隧道 0 ❌） |

---

## 四、根因分析（疑点排序）

### 疑点①（最可能）手机存的是空/旧 `fallbackBase`

- App 出门只靠 `fallbackBase`（公网入口）。它**不是每次启动拉取的**，而是**配对那一刻**从 mDNS `pub` 抄下、之后只在「重新发现同一台」时按 `pub` 非空更新（`CrewNearby.kt:117-125`）。
- 用户红米设备 `d021988751fdd554`「Redmi 24117RK2CC」配对于 **2026-11-11T12:00:28Z**（管理面 `GET /orchestrator/api/remote/devices`）。
- **假设路径（代码可产生，未证实该机当时值）**：若配对时后端 `mobile-public-url` 尚未落定、或 mDNS 那一刻 `pub` 为空 → `fallbackBase` = 空串 → 出门后候选入口只剩 LAN（不可达）→ APP 连不上。这条与「在家正常、出门用不了」现象**相符**，但**未读取该机 pre-r1 当时的真实 prefs 值**，故不与「本机出门故障」划等号。
- **坐实门槛**：读该设备 App 本地存储里的 `fallbackBase` 真值。按 lead 决策，**不重配对、不清数据、不绕沙箱硬读私有 prefs**；由**客户端新诊断页**在「保留配对的升级」后记录实际 stored `fallbackBase` 真值，再据此修复。当前是 Mac 侧推断，未读设备数据。红米本轮不在 adb 在线（连的是 OPPO 55c86317），故无真机侧证据。

### 疑点②中转兜底 `tunnels:0`

- `crew-relay` 常驻（uptime 已十余万秒），但宿主侧没有一条活隧道注册上去（`tunnels:0`）。
- 依据 #20 文档与 HANDOFF：`CREW_RELAY_URLS` 历史上有过「后端进程未载入 relay.env → tunnels:0」的情形。当前 relay.env **文件存在**（`~/.config/crew-desktop/relay.env`，600），但后端是否已载入需看启动环境。
- 影响：即便公网 CF 主路可用，**relay 这条兜底是死的**。不是当前主因，是隐忧。

### 疑点③跨 NAT 打洞（#20 第 1 项，未验证）

- P2P 出门能否直连**至今无异地 NAT 对端实测**。既往实测 120/120 是**同 NAT LAN 直连**（`tailcat` 自己把对端报成 `192.168.31.175`），不算打洞证据。
- 不阻塞「出门能用」，因为公网 CF 主路仍可承载；但它意味着出门后的 P2P 加速是「可能不生效」的。

### 排除与未定论（分开写，不泛化）

- **CF error 1010 —— 当前 Mac 侧未复现挡 App，蜂窝侧待测、不下定论**：Mac 出站实测仅 `Python-urllib` UA 被 403/1010；`Java/okhttp/Android-WebView` UA 全 200（App 用 `HttpURLConnection`，`CrewClient.kt` 未显式设 UA，走 Java 默认，Mac 出站公网 200）。**这只说明 Mac 单机、Java 默认 UA、Mac 当前网络路径下 CF 未拦，不等于真实手机蜂窝/异网下不会被 CF 或 DNS/IPv6 路径问题挡住**；手机蜂窝待实测，此项不下定论。
- **后端宕机/域名失效**：均否（运行态实证）。

---

## 五、证据边界（务必对齐）

- **全部为 Mac 单机出站实测**。不代表红米手机在蜂窝/异网下能用。
- **设备身份更正（adb `devices` 实测）**：当前 adb 连着的是 `55c86317` = **OPPO PEDM00**（Android 14），**不是红米**（红米 24117RK2CC 未知 serial，当前未连接/未授权 adb）。故「读红米 `fallbackBase` 实际值」本轮**未能做**（红米不在线）。
- 连着的 OPPO 处于**锁屏/充电**状态、App 非前台，读 UI 只能拿到锁屏文本，**未读取其 route 状态**（不打扰、不点亮、不绕过）。OPPO 也非本次报告的样机。
- 设备 `com.dsh.botcrew` flags=`0x0`（**非 debuggable**）→ 按红线**不做沙箱绕过取私人数据**，只走公开 adb getprop / 已公开 App 界面。
- 「Mac 能 curl 通公网域名」**≠**「红米蜂窝能用」。真机复现必须看 App 里 `fallbackBase` 实际值与 App 侧连接日志。
- 未碰手机、未做 adb 操作、未读设备本地数据。

---

## 六、最小修复路径（交 lead 决策，本轮未执行）

**A. 重新配对 / 重新发现同一台（最小、可逆，推荐先验）**
- 动作：手机侧对该机器重新配对一次（或触发一次 mDNS 重新发现同一台）。
- 机理：只要后端此刻广播的 `pub=https://crew.kentonnie.top` 非空，`CrewNearby.kt:117-125` 会刷新 `fallbackBase`/`p2pAddr`/`base` 三格。
- 影响面：仅该设备本地存储；**零服务端变更**；完全可逆。
- 验证判据：配对后手机出门（切蜂窝）能拉到 timeline。

**B. 若要救活 relay 兜底（运行态修复，需 lead 决策）**
- 现象：`tunnels:0`。
- 路由：确认后端启动环境是否载入 `relay.env`（`CREW_RELAY_URLS`/`CREW_RELAY_SECRET`/`CREW_RELAY_INSTANCE`）。`models.ts` 之外的 `backend/scripts/dsh-superagent` 启动前应 `set -a; . relay.env`。
- 代价：需重启后端载入（~3s 不可用，`Runtime.stop()` 会跑，在跑 assignment 标 hostRestarted 重排队；票/消息/设置不丢）。
- **属运行态修复，交 lead 决策，本轮不动**。

**C. 跨 NAT 打洞（#20 第 1 项）**
- 缺一台不同 NAT 出口对端（唯一现成候选 win-laptop 当前三路不可达）。不是修 bug，是补实测条件；不阻塞主路。

---

## 七、「域名那边加一个 log 的输入 / 实时监听 APK 所有信息」——现有能力核对

用户新请求涉及两件事，分开说清：

### 7.1 后端 log 采集路由：**目前不存在**
- `/api/mobile/*` 已注册 **28 条** exact route（`mobile-http.ts:1378-1422`），**无任何 log / telemetry / report / ingest 入口**。
- 全仓 `backend/src` 搜 `logSink|log_ingest|/api/mobile/log|telemetry` **零命中**。
- 要新增需**改源码**：`POST /api/mobile/log`（设备凭据围栏下）→ 落盘（如 `<stateDir>/crew-logs/<device>.log`）→ 一个只读查看入口（管理面或本地 tail）。**不在本轮只读授权内，需 lead 立项写 scope。**

### 7.2 现有「能看到 App 侧」的能力（可直接用，无需改码）
| 通道 | 位置 | 能看什么 |
|---|---|---|
| CF 隧道日志 | `~/Library/Logs/crew-mobile-tunnel.log` / `.err.log` | 边缘→origin 失败（如 `dial tcp 127.0.0.1:43499: connection refused`）、隧道注册、CF 版本告警 |
| mobilegw 日志 | `backend/.artifacts/mobilegw.log` | 端口占用（`Errno 48`）等；**注意**：现日志尾部有历史 `Address already in use`（launchd 与脚本曾抢 8788） |
| 后端 artifact | `backend/.artifacts/dsh-superagent-superagent-*.log` | 后端运行日志 |
| 健康面 | `GET /orchestrator/api/state`（需 `x-orchestrator-request:1`） | 13 项部件健康 |
| 设备表 | `GET /orchestrator/api/remote/devices` | 已配对设备（无 digest/token） |

> **「实时监听 APK 所有信息」没有现成通道**——App 端没有上传日志的能力，后端没有接收端。要「实时」还需 App 侧加埋点 + 上报 + 后端接收/查看，属跨端新功能，需 separate scope。

---

## 八、附带观察（不阻塞，供参考）

- mobilegw 日志尾部有 `OSError: [Errno 48] Address already in use`（历史，launchd `com.cpuser.dsh-mobilegw` 与某脚本曾抢 8788）。当前 8788 由 pid 67367 正常服务，`/health` = `{"ok": true}`，**现无影响**，但同类抢端口隐患值得留意。
- CF 隧道版本 `2026.9.1` 落后（日志建议升级 2026.11.0）。不影响连通，非本次根因。
- 后端 health 里 `team/github` 的 `at` 时间新（11-15），其余多停在 11-14，属「无变化即不刷新」的正常缓存，不是故障。

---

## 八点五、后端当前真实广播（mDNS TXT）· 供客户端自动同步公网入口

**这是「不重配对、靠本次 APK 自愈旧/空公网入口」的落点。** 直接抓了当前运行的 beacon：

```
dsh-crew-0kvcc5t._dsh-crew._tcp.local. @ KentonMacBook-Air-5847.local.:43499 (interface 11)
crew=0kvcc5t port=43499
pub=https://crew.kentonnie.top
p2p=tcpGFwWCDQf-oX6qlVXTmtpBA2ZyVLmqKMur7JEZIXYZXhuXM3BGFrWCCDu1YZnpWMVsxo3MsyvKttPPYruMRuLpfE_1QPaoSvcWFxWCACEkVJgQ5T0f231oipQ3f7U8FWFrb_Ts0a0nA8kaB6iGFpGQEw
```

**结论（运行态实证）**：
- 后端**此刻确实在广播非空 `pub=https://crew.kentonnie.top`**，TXT 四格齐全（`crew/port/pub/p2p`）。
- 来源：`public-entry.ts` 读 `<stateDir>/mobile-public-url`（值 `https://crew.kentonnie.top`）；进程 pid 89699 环境**无** `CREW_PUBLIC_URL` 覆盖，走文件值。
- `discovery.ts:109`：`txt: { crew, port, ...(publicUrl ? { pub } : {}), ...(p2p ? { p2p } : {}) }` —— pub 非空才写。今天写进去了。

**对客户端 owner 的可执行落点**：
- `CrewNearby.kt:117-125` 已有「重新发现同一台时 `fallbackBase = beacon.publicBase.ifEmpty { paired.fallbackBase }`」的逻辑。**只要本次 APK 能触发一次对同一台（`crew=0kvcc5t`）的 mDNS 重新发现**，就会把 `fallbackBase` 自动补成 `https://crew.kentonnie.top`，无需重新配对、不清数据、保留配对身份。
- 前提：手机与 Mac 需同时在**同一 Wi-Fi**（mDNS 只在本链路广播）完成一次发现；之后出门即可用公网入口。
- 需注意的盲区：若当前 App 只在「配对页/附近列表」才做发现、进主界面后不再刷新，则「不重配对自愈」需要在客户端加一条「启动/前台恢复时对已知 `crew` 指纹静默再发现并 merge 三元组」的路径。这一点归客户端 owner 设计。

**对后端 owner 的可执行落点**：
- 确认 `pub`/`p2p` 在 TXT 里的键名与客户端解析一致（当前键名就是 `pub` / `p2p`）。
- 若考虑更稳的自愈：可评估在 `/api/mobile/pair` 或新增一个轻量 `GET /api/mobile/route`（设备凭据围栏下）返回当前 `{pub, p2p, port}`，供已配对客户端定期对齐——这属新 endpoint，需立项，不在本轮。

---

## 八点六、HTTP 403/1010 与 origin 401 的区别（日志判读口径，勿当 App 原因）

排查「出门连不上」时，日志里要区分**云边 403**与**origin 401**，二者含义完全不同：

| 现象 | HTTP | body | 来源 | 含义 |
|---|---|---|---|---|
| 云边拦截 | **403** | `error code: 1010` | **Cloudflare 边缘**（未到 origin） | CF 的 bot/UA/指纹策略挡在边缘。**Mac 出站实测仅 `Python-urllib` UA 触发**；App 的 `HttpURLConnection`（Java 默认 UA）在 Mac 出站实测公网 **200** —— 仅此而已，蜂窝/异网待测 |
| origin 未配对 | **401** | `{"error":"Not paired"}` | **crew origin**（43499，围栏） | 请求已到后端，只是缺/错设备凭据 —— 这是**正常围栏**，说明链路通、只是没登录 |
| origin 可达 | **200** | timeline JSON | crew origin | 全链路通 |

**判据**：看到 `error code: 1010` = CF 边缘挡（改 UA/走 CF 策略，非业务）；看到 `Not paired`/401 = 已到 origin、链路没问题。
「Mac curl 时偶发 403」是 **Mac 单机出站 + Python UA** 的现象，**不能泛化为排除真实手机问题**：真实手机蜂窝/异网下的 CF、DNS、IPv6 路径均未测，不下结论。

---

## 九、处置方向（按 lead 已发决策，本报告不主张额外动作）

1. **不重配对、不清数据、保留配对身份**：靠客户端新诊断页在「保留配对的升级」后**记录实际 stored `fallbackBase` 真值**，再据此修复旧/空公网入口（客户端 owner 设计落点见 §八点五）。
2. **不绕沙箱硬读私有 prefs**：App 私有数据不经反调试/沙箱绕过读取。本轮只做公开 adb getprop / 已公开界面只读。
3. **不为 relay `tunnels:0` 重启健康服务**：当前主域名通，relay 兜底死记为隐忧，不动生产。
4. **不把「高概率空/旧 fallback」当已确认根因**：它是 Mac 侧高概率假设；蜂窝侧 DNS/IPv6/CF 路径均未测，坐实靠客户端诊断页真值记录。
5. **「APK 日志上报 + 后端接收/查看」**：属跨端新功能，需另行立项写 scope（后端收 + App 埋点上报），不在本轮。

---

## 汽车参考（只读）· ZSpaceCarPlayer 崩溃上报契约（供 BotCrew 故障上报设计借鉴）

> 只读来源：`/Users/cpuser/Code/kTool/ZSpaceCarPlayer`（Java/Android 4.3 车机播放器，`com.ktools.zspacecarplayer.crash` 包 + `scripts/crash_reports.py`）。**未改动该仓任何文件**，未查真实个人报告正文、未调车机 API、未部署 NAS。以下为**机制契约**，不含任何真实 token / 聊天内容 / 个人数据。

### 一、客户端上报链路（`CrashMonitor` + `CrashUploader` + `CrashReportStore`）

- **采集**：Java 未捕获异常 / native 崩溃 / 异常退出 / 主线程卡死（>6s 看门狗）四类；报告含 `stackTrace`、`threadDump`、`logcat`（`-b crash` 跨重启保留）、`breadcrumbs`、`diagLog`、堆快照、设备/版本/播放上下文。
- **落盘**：崩溃时**同步 fsync 写**到本地 `crash_reports/<kind>-<reportId>.json`；目录封顶 `MAX_FILES=20`，超限删最旧。`reportId = hex(nowMillis) + "-" + hex(rand16)`（**客户端本地生成、非服务端下发**）。
- **补传（本地失败保留重试）**：崩溃期不异步；**上传统一放到下次启动** `uploadPending()`，按写入时间**从旧到新逐份**；任一份失败即 `break`（端点挂了不必继续打），**报告留本地**。
- **退避**：失败 `BACKOFF_BASE_MS=1h`，按 `streak` 指数翻倍封顶 `BACKOFF_MAX_MS=24h`；成功清退避。`PREF_NEXT_ATTEMPT_AT`/`PREF_FAILURE_STREAK` 落 prefs。
- **手动上报**：`uploadDiagnosticsNow(source)` 当场 POST、不退避、无本地文件可删；`diagLog` 先按 64KB 预算裁**尾部**（`clampDiagLog`，整行边界不劈半行）。
- **端点**：`BuildConfig.CRASH_ENDPOINT`（build.gradle 由 local.properties 注入），运行时可 `setEndpoint` 覆盖。形状 `https://<host>/crash`（POST，body=报告 JSON）。

### 二、ACK 判定（**最关键、最值得照搬**）`CrashUploader.isIngestAck`

- **只有「HTTP 2xx + `Content-Type` 含 `application/json` + body 有键位置的 `"ok"` 字段」才算收件成功**，才允许删本地报告。
- 铁律（真实事故教训）：
  1. **绝不跟随 301/302**（`followRedirects=false`/`followSslRedirects=false`）——反代把 `http→https` 301，OkHttp 跟随会把 POST 降级成 GET，静态兜底页对 GET 回 `200 text/html`，于是「上传成功、删本地、云端一份没收到」。3xx 一律判失败留本地。
  2. **2xx 但 `text/html`（SPA/静态兜底页）= 失败**，不能当收件成功。
  3. `"ok"` 必须在**键位置**（正则 `"ok"\s*:`），`{"status":"ok"}` 这类业务状态不算收件 ack。
- 服务端 ack 体形如 `{"ok":true,"id":"r-1"}` / `{"ok":true,"stored":"/data/crash/r-1.json"}`（只读 256 字符判定，省车机流量）。

### 三、服务端落盘/读取契约（`scripts/crash_reports.py` 只读印证）

- **存储**：实车走 NAS 落盘 `<mapping>/Jarvis/data/crash-reports/crash-YYYYMMDD.jsonl`（**按天分文件**，每行一条）。
- **每行外层字段**：`received_at`、`source_ip`、`report`。
  - **`report` 可能是 JSON 字符串、也可能已是 dict** —— 读取端必须 `if isinstance(report,str): json.loads(report)` 分支，不能直接当 dict。
- **去重**：**按 `report.reportId` 去重**（重复投递真实存在，按行统计会虚高）。
- **`diagLog` 跨天全量**：`diagLog` 是跨天累积全量时间线（`MM-dd HH:mm:ss.SSS` 行首），**按日统计必须先按行首 `MM-DD` 切片到目标日期**，否则历史数据污染当天。
- 读取端有 `redact()`（`api_key=…` → `[REDACTED]`）；客户端侧 `CrashReport.redact()` 更全（`api_key/access_token/x-emby-token/x-mediabrowser-token` 查询串/URL 编码/请求头三形态 + 登录 `"Pw"` 密码字段）——**凭据在客户端序列化前就抹掉，报告出门前已脱敏**。

### 四、给 BotCrew 的可复用建议（不照搬 token / 聊天内容）

1. **不能只看 HTTP 状态码**（用户明确要求）：必须复用「2xx + JSON + 键位 `ok`」三重 ack 判定；3xx/HTML 200 一律判失败、留本地等补传 —— 否则崩溃现场静默丢光。
2. **reportId 客户端本地生成**、服务端按 `reportId` 去重；接受重复投递。
3. **本地失败补传 + 指数退避（1h→24h 封顶）+ 启动重试 + 目录封顶淘汰最旧**，崩溃期只同步落盘不异步。
4. **脱敏在客户端序列化前做**（token/密码/查询串），报告出门前已无凭据。
5. **服务端按天 JSONL 落盘**（`received_at / source_ip / report`），`report` 兼容 string/dict，读取端按 `reportId` 去重、`diagLog` 按行日期切片。
6. **ack 必须可被客户端验证为「真收下」**，给一个稳定的 `{"ok":true}` JSON 契约端点。

