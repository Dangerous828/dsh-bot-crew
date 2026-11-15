# 收尾审计账（审计历史，非用户交付文档）· 2026-11-14

> **本文件是审计历史留档**：逐项核对轨迹、订正记录、旧口径对比都只作内部审计用途，不面向用户交付。
> 用户交付状态见 `docs/review/2026-11-14-final-closeout.md`（简洁版）。本文件保留历史不删。

- 日期：2026-11-14 21:40 CST（`date '+%Z'` = CST / `+0800`，Asia/Shanghai）
- 角色：`wb-final-ledger`（lead 委派，单任务：收尾账准备与状态核对 + 文档侧；lead 仅调度）
- **性质：持续更新，直到 owner 真正结束——不是"最终已收口"、不假称全部关单。**
- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`，HEAD `b2f305e`
- 写范围（本任务实际改的）：
  1. `开发进度.md` —— §二 现状头（21:44 CST 版）
  2. 本文件 `docs/review/2026-11-14-closeout-audit-ledger.md`（审计历史留档；用户交付版同步为简洁 `2026-11-14-final-closeout.md`）
  3. `backend/docs/02-memory-bridge.md` —— 分流表「已验结论/默认分享」+ API runbook 的最小更新
  4. `docs/00-contract.md` —— §9.4 #15 第 3 项由「未做/移交」订正为「已由 #19 覆盖」
  5. `docs/review/2026-11-14-issue23-graph-engineering-report.md` —— 追加 §七 health 口径勘误（不抹历史）
- **未做 / 未碰**：任何源码、`docs/007-architecture.md`、`08-memory-hub.md`、`HANDOFF.md`、
  `scripts/crew-watch/`、任何 `git add/commit/push/stash/checkout/restore/reset`、
  不 build、不改生产配置、不重启任何进程、不读任何个人 secret / PIN / token 字节、不轮换 token。

> 一句话口径：**不做"全部关单"的结论。** 下面把每条 issue 分成五类真实状态写清：
> ①已测试源码（单测/集成绿，未部署）②已部署包（进了生产 `backend/lib` 或打好签名包）
> ③真实设备/宿主证据（真机真点击）④fixture / 隔离台架证据 ⑤外部条件阻塞（缺真实输入，不能关）。
> 逐条分账后给「外部解锁清单」和「可交付 artifact 路径」。

---

## 零、计数与"不是全部关单"（同一份 gh 返回自动计数，不手填）

执行命令（**一次调用、同一份返回、机器计数，脚本不手填；`date` 实际时区**）：

```
$ date '+%Y-%m-%dT%H:%M:%S%z'                 → 2026-11-14T21:44:30+0800（关 #15 之后重取）
$ gh issue list --state all --limit 200 --json number,state
  → 脚本 Counter：TOTAL 32 ；CLOSED 26 ；OPEN 6
  CLOSED(26)：#4 #6 #7 #8 #9 #11 #12 #13 #14 #15 #16 #17 #18 #19 #24 #25 #26 #27 #28 #29 #30 #31 #32 #33 #34 #35
  OPEN(6)   ：#5 #10 #20 #21 #22 #23
```

> **订正记录**：
> - 更早时点记作"25 条 / 10 OPEN / 15 CLOSED"已不成立（当时口径 + 漏算）。
> - 21:01 版记作"32 条 / 20 CLOSED / 12 OPEN"也已不成立。
> - 21:40 版一度记作"32 条 / 25 CLOSED / 7 OPEN"（那个快照**取自关闭 #15 之前**，不能冒充最终）。
>   **本段以关闭 #15 之后重取的 21:44:30 gh 快照为当前：32 条 / 26 CLOSED / 6 OPEN**（`#15` 已入 CLOSED）。
> - 6 OPEN 里 #5 / #10 是收窄追踪单，其余 **#20 / #21 / #22 / #23 是真未决**（缺外部输入/真机）。
> - **6 OPEN 里没有一条是"做完了只是忘了关"**：要么缺一份真实外部输入、要么缺一次真机/真账号验证、
>   要么是收窄追踪单。**强行关掉会制造假绿。**

---

## 一、逐条分类账

### A. 已关闭且证据充分（真机/真宿主/真实产品入口，不翻）

| # | 状态 | 证据等级 | 关键证据 |
|---|---|---|---|
| **#18** | CLOSED | 真实设备 + 真实 relay 边缘 | relay 门不带凭据 `401`，带真实设备凭据 `200 {"sessions":["main","work"],session_api:1}`；真 GUI `open -g` 零桌面输入切会话。 |
| **#14** | CLOSED | 收口项 1 早结清；项 2 relay 门由 #18 补 | 见 `docs/review/2026-11-14-ledger-closeout.md` §二 |
| **#25** | CLOSED | 已部署包（基线）+ 真票 | `backend/lib/client.js` 含 `backupLabel` 命中 4；真票 `b50ed30f` 走备选 provider，改动回滚 SHA-256 复原。 |
| **#28** | CLOSED | 已部署包 + 浏览器 + **缺字段是 fixture** | `backend/lib/client.js` 含 `isolation.unknown` 命中 2；生产三态 headless Chromium 看到；缺字段态是隔离 fixture。 |
| **#17** | CLOSED | 真实 `sandbox-exec` | 六个已枚举凭据路径 `DENIED(EPERM)`；口径收窄为"验 prepare 阶段凭据读不到 + 记录 worker 侧未覆盖"。 |
| **#26** | CLOSED | **已部署 + 生产 24 canary** | 生产同构 `sandboxArgv` 24/24 DENIED、0 readable、0 泄露；`backend/lib/index.js` 含 `sensitivePaths` 命中 3。残余边界（表外 secret/软链/worker 侧/非 macOS）见 ADR 0004，属范围外。 |
| **#27** | CLOSED | 源码 + r2 签名包 + 真进程 | 主线程判据三条探针；真进程无焦点启动 `messages:3`/`unread:1`，4 次采样 `Finder` 在前零抢焦点；`go vet` 0 / 281 PASS / `-race` 0。r2 包含此修复。 |
| **#29** | CLOSED | 真实设备 | 冷启动 pid 13130 + 重建 4 次全部 `state.dump ok=True paired=True way=p2p`。 |
| **#19** | CLOSED | 真实设备双向 | 统一 APK sha256 `108372fd…e109628`（debug 包）；LAN/RELAY 两门 resume 200；①②④项通过；③按钮方向 `pausePress` 修复后真机 `paused False→True→False` 双向。**四项逐项真机证据**（①LAN+RELAY恢复 ②无凭据/坏凭据 401 ③暂停真恢复 ④takeover 已停票 resume 后仍 stopped 不复活、失败路径 409）。 |
| **#35** | CLOSED | 源码 + r2 签名包 | 三条生命周期缺陷 F1/F2/F3 修；r2 `codesign --verify` exit 0。 |
| **#24** | CLOSED | **真实产品入口 + 真双物理客户端** | 见 §一-A-24 与 `issue24-product-ledger-seam.md` §九。 |
| **#31** | CLOSED | app 源码 + 真机复验 + 变异 | 陈旧条目**待复核不删**（删行只听 `onServiceLost`，点它先 TCP `reachable()` 复核）；真机 passed；抓并修一个真机单位 bug（毫秒喂 `age()`）。 |
| **#32** | CLOSED | app 源码 + 真机复验 + 变异 | `AddressField` 无 `copy`、旁路编译期写不出；真机"手改不被抢"passed。 |
| **#33** | CLOSED | app 源码 + JVM 产品代码台架 | `probe()` 整轮墙钟 `budgetMs`（默认 20s）+ 守护线程 + 到点 `disconnect()`；慢滴 800ms/字节 81.64s→1.56s，生产默认 20s→20.09s；**真机慢滴未测（边界如实标，JVM 侧为证据边界）**。 |
| **#34** | CLOSED | app 源码 + 真机复验 + 变异 | 判据落独立 `crew-permission` 文件（非 `rememberSaveable`）；真机"重进不再弹"passed。 |
| **#15** | CLOSED | **收窄追踪单，逐项核完** | 七项逐条证据+边界见 §一-D-15；第 3 项远程恢复 4 项联调**由 #19 覆盖且已逐项真机证据**（含失败路径 401/409、不复活）。收口线"第 3 项做完即可关"成立。 |

#### #24 记忆中枢 — 真实产品入口闭环（关键收口）

- **拓扑**：A=本 Mac 生产 DSH 运行时 → 既有 `local_dream` pipeline → NAS 中枢（`dsh-memory/bot`）→
  B=**win-desktop 物理独立设备**（Windows，产品 `HubHttp` 代码）。**真双物理客户端**（A Mac / B win-desktop），
  不是同机跨进程。
- **入口**：真实产品流程（非 tmp Ledger / 非手写 DB / 非伪造凭据）：
  管理面 loopback 出码 → lan `/api/mobile/pair` 兑码换明文 token → 真 `POST /api/mobile/send`
  （human trigger）→ 生产 `Runtime.memory.hear → ledger.settle` → 真 `POST /api/mobile/memory {action:edit,toHub:true}`
  → `runtime.editMemory → ledger.edit → author.publish` 真落 author md → 真 pipeline `dream_notify` 上行 NAS
  → B(win-desktop) `HubHttp.search` 命中 → 真 `forget`（md `disabled` + bySourceFile 撤 + 原子 tombstone）
  → 中枢该 sf **live=0** → B 再 recall **entries=0** → 下轮**不复活**。
- **裁定 C（默认不分享）**：`settle()` 保持 `toHub:false`；**origin/type 不构成分享授权，person:owner 也不自动 true**；
  只有已认证操作者经产品 edit 显式置 `toHub:true` 才上行。**既有 28 条私有 `toHub:false` 不回改**（to_hub=true 数=0）。
- **清理口径（不全清泛化）**：canary **md 已删**、临时 verify 设备撤销恢复**原 3 台**；**保留 1 条
  `state=forgotten/toHub=false` 的 canary 账本行 + digest 作审计留档**（forgotten 不上行、管道跳过、远端 live=0），
  不手删 DB/prune。`memory:retract-pending`=0、watchdog `memory_retract` 告警=0。
- **口径准确**：A 记忆来自真实 `memory.hear`（origin person:owner，type feedback），非 test-ticket close 链；
  B 用产品 `HubHttp.search` 真实检索核心（win 未装 `@deepseek-ai`/`zod`，未加载完整 `HostMemory` 全链，**如实标，不冒充全 HostMemory**）。
- **上线 hash**：`backend/lib/index.js` `e39f323c6cb2…`（21:25:12，`retarget`/`ensureSettled` 命中 6/4）；
  生产未重启（HMR）。`08-full-chain.ts` 为补充证据，不单独关单。
  （**当前 lib 已追加 Graph 批次为 `2ade8753…`，见 §二；`e39f323c` 是 #24 收口时点的历史 hash。**）

### B. OPEN 中的真未决 —— 卡在外部条件/真机（不能写成完成）

| # | 状态 | 已达成的部分 | 缺的外部输入（解锁条件） | 证据 |
|---|---|---|---|---|
| **#20** 跨 NAT 打洞 | OPEN | 第 2 项 `probe()` 缺陷已验并单独修（#33 已关：墙钟硬截止 + JVM 产品代码台架）；同 LAN 隧道 120/120 | **缺一台与 Mac 不同 NAT 出口的对端**。唯一候选 `win-laptop` 三路（`192.168.0.109:22` / `10.10.10.1:22` / `win.kentonnie.top:22`）当前全超时；手机蜂窝当前 `mobile_data=0`/`OUT_OF_SERVICE`/无 IPv4（只读核对，未开数据、未查套餐）。120/120 是同 LAN，不能当跨 NAT | `…issue20-weaknet-nat.md`、`…issue20-phone-cellular-precheck.md` |
| **#23** 晨报 + Graph | OPEN | 晨报代码路径通；**Graph 第 1、2 项代码侧稳定并已上线 lib**（119 files/2110 green、新 37 tests，独立 review/HMR 完成，lib hash `2ade8753`）；**未配置未启用，`/state` 无 mail/calendar 健康条目（缺席 None，零外部请求，非 error、非 live）** | **真实只读 Graph token（Mail.Read+Calendars.Read）+ 真机在线接收窗口**。`pushNotice.queued ≠ 送达`；面板可配表单属新 settings 设计须另立 brief | `…issue23-morning-report.md`、`…issue23-graph-engineering-report.md`（含勘误）、`…issue23-graph-independent-review-release.md` |
| **#21** 真实集成 | OPEN | 底座 7 kind + 26 例绿测；只读探针 115/2044 全绿；**前置已合格交付**（服务器/凭据引用/connection/审批四连输入清单） | **外部缺 host tool**：DSH 只注册 `dsh-sessions / hub_memory / magpie-image / tavily`，**无 messages/shopping MCP 服务器**。属外部输入，不再等 wb-integration21 | `…issue21-integration-prep.md` |
| **#22** worker 隔离 | OPEN | prepare 阶段 deny 真生效；worker 侧两阶段对照实测（prepare 拒/worker 读到内容） | **向 DSH 提 provider 级 uid/gid 或外包沙箱**（依赖 DSH provider）；默认 `isolation=none` 不翻 | 开发进度边界 2；ADR 0004 |

### C. 追踪单 —— 保持 OPEN，不作完成

| # | 说明 |
|---|---|
| **#15** | Step 0 七项，**已逐项核完并关闭**（见 D）。 |
| **#10** | Step 7 行动面扩展。5 项里 3 项完成，剩 #21（真账号）与 #22（worker 隔离）。**追踪 #21/#22**。 |
| **#5** | 差距评估战略清单。9 条 gap 全部指向 #19（已关）/#20/#21/#22/#23/#24（已关）/#26（已关）等。**索引单**，真实未决为 #20/#21/#22/#23。 |

### D. #15 逐项核对（按全部原条款，逐项引用新证据）

| # | 项 | 状态 | 证据（引用） | 边界 |
|---|---|---|---|---|
| 1 | 桌面 takeover + 记忆编辑 | ✅ | 记忆编辑 `33dd955` KV 真写入 + 杀进程重启后仍在 + 已回滚；**takeover 按钮走真实产品处理器**（`docs/review/2026-11-14-desktop-gui-remaining-acceptance.md` §五）：mygo `act{press}` → 真实产品 `OnClick` → `POST /api/mobile/takeover` → 两张真票 `5846d4f0`/`eb555457` 均 `stopped`/`open=false`、20s 复查不复活（**不是接口级，非 fixture 假成功**） | 按钮本身已真点验过；仍未覆盖的是「常规 `Regular` 启动不聚焦/不抢焦点」（产品起法会抢焦点，属残 UI 面，见 §四） |
| 2 | 手机花名册 / 48dp / 暂停→继续 | ✅ | 花名册 3 个逐字一致；`uiautomator` bounds 16/16≥48dp；暂停期间 3 条消息顺序 1→2→3 恢复成功（`8ad3f4f`） | 无 |
| 3 | 远程恢复 4 项联调 | ✅（由 #19 覆盖） | **#19 CLOSED**：①LAN+RELAY resume 200 ②无凭据/坏凭据/坏设备全部 401 ③按钮真恢复 `paused False→True→False` ④takeover 已停票 resume 后仍 stopped（409 + 20s 复查 open=0，不复活） | #19 原条款"四项逐项真机证据"The上述全满足 |
| 4 | 运行中 profile 加载新构建 | ✅ | `331371d` 临时 `DSH_HOME` 5轮 5/5、2.19–2.69s、PID 不变、状态不丢、坏构建恢复；替代 restart 停机 3.1s | 生产 70723 只读，没在生产真做；账户设置触发 `ctx.fiber.restart()` 不加载新构建（已记） |
| 5 | 真机 APK 安装 | ✅ | 新包已装，调试口 `capability: live`/`timeline.loaded: true`/send 后 48 条 | 无 |
| 6 | 真实额度数据源 | ✅（前提纠正） | `6c12766` 全仓无 mock；修 3 真 bug（`contextWindow` 读错字段致余量从不显示、余量漏 `cacheRead/cacheWrite`、桌面展开任意票 panic）；接本机 magpie `GET /v1/magpie/quotas`，源头 33 raw ↔ 后端 66 windows 逐字相等，5/5 对上 | **金额按设计留空**（单价/账单不在本机，`LlmAdapter` 无 billing 方法）；实为"真实用量源"非"计费源" |
| 7 | relay 重新部署 | ✅ | 00:05 `uptimeMs` 73.5h→24.5s、tunnels 0→1；`6b7ab31` NAS compose `RELAY_MAX_BODY_BYTES` 把语音上限压到 256KB，删行重建后 500KB WAV 从 413 变 200 | 无 |

> #15 收口线本身（08:58 评论收窄）明写：「本 issue 保留为 Step 0 的记账单，第 3 项做完即可关」。
> 第 3 项由 #19 逐项真机证据（含失败路径）覆盖，故按原条款可关，非凭伞单关系强关。

---

## 二、部署 / 构建 / 设备 三态核对（客观判据）

**生产部署态（读 `backend/lib` 内容，不 build）—— 21:40 CST 实测**

| 探针 | 命中 | 含义 | 结论 |
|---|---|---|---|
| `grep -c sensitivePaths backend/lib/index.js` | 3 | #26 名单在 | 已部署 |
| `grep -c runMorning backend/lib/index.js` | 2 | #23 tick 接线在 | 已部署 |
| `grep -c isolation.unknown backend/lib/client.js` | 2 | #28 三态在 | 已部署 |
| `grep -c backupLabel backend/lib/client.js` | 4 | #25 表单在 | 已部署 |
| `grep -c retarget backend/lib/index.js` | 6 | memory 配置热修复在 | 已部署 |
| `grep -c ensureSettled backend/lib/index.js` | 4 | memory 配置热修复在 | 已部署 |
| `grep -c runGraphWatch backend/lib/index.js` | **2** | Graph 已进 lib | **Graph 已上线**（wb-graph-review-release 独立 build/HMR） |
| `grep -c MicrosoftGraphPort backend/lib/index.js` | **2** | Graph 已进 lib | **Graph 已上线** |
| `grep -c graphHealthOf backend/lib/index.js` | 3 | Graph health 在 | 已上线 |
| `grep -c readGraphToken backend/lib/index.js` | 2 | Graph token 独立引用在 | 已上线 |

`backend/lib/index.js` sha256 `2ade8753165c3a01f7320634ea8be382f8dd72951726b94d7fec02633fec6af7`（857,847 B，mtime 21:37:48）。
这是 **Graph 批次（在 memory `e39f323c` 之上追加 Graph）** 的产物：memory 的 `retarget`/`ensureSettled`（6/4）仍在、
`#24` 不退；Graph 从共享 stable（119 files/2110 全量独立复现）build 进来、**零源码改动**（仅构建产物 + append
自有 patch 注释），memory 历史未并入/未改写。生产 PID 89699/89697（14:26:39）、mobilegw 67367（18:31:04）**全程未重启**，
HMR 是 chokidar watch patch→热 recompose（lsof 实证 `fd 19r cordis.patch.yml` 持开）。

> **#23 口径 should-fix（wb-graph-review-release 实测，不阻塞，但须如实写）**：
> **#23 口径勘误（wb-graph-review-release 实测 + lead 裁定，只改文档不改源码/HMR）**：
> Graph **未配置时零外部请求，`/state` 里 mail/calendar 是「缺席（None）」**——即**未配置未启用（无 mail/calendar 健康条目）**，
> **不写「paused 可见」**。层次：**pure `graphHealthOf` 单测仍返回 `paused`（保留该单测）**，但 **Runtime 层未配凭据时
> 不创建该条目 → `/state` 不出现（缺席）**；**配置后错误 health 才进入可见**（如 401/403 → `error`）。
> 已在 `…issue23-graph-engineering-report.md` 追加勘误，不抹历史报告。不阻塞 #23 未关闭。核心 `memory = ready`。

**memory 配置生命周期热修复生产验收（wb-memory-config）—— 已完成**
hot PUT 受控临时错 token（rev 5→6）→ health `starting`→`error`；改回原引用（rev 6→7）→ `starting`→`ready`；
全程无重启，`health.memory=ready`。旧 build 只能报两维、无 `starting`，出现 `starting` 即证新码在跑。
（注：旧 lib `26a25843…` → config 批次 lib `303704fd…` → memory-sync 批次 `e39f323c` → 当前 Graph 批次 `2ade8753`；
config 批次的验收结论已被后续 memory-sync / Graph 批次 cover，lib 为 gitignore 不落 git。）

**桌面签名包（最终 r2，不是 r1）**

```
$ ls desktop/build/release-20261114-r2/
  Bot-Crew-desktop-release-20261114-r2.zip   (10,442,268 B)
  Bot Crew.app/  (Contents/MacOS/desktop  mtime 19:05)
$ shasum -a 256 Bot-Crew-desktop-release-20261114-r2.zip        → 6532659d…f564c
$ shasum -a 256 "Bot Crew.app/Contents/MacOS/desktop"           → f132d7fff…d54bc1
$ codesign --verify --deep --strict "Bot Crew.app"               → exit 0
```
r2 包含 #27 #35 生命周期修复。**未覆盖 bin 里不含**（单文件 .app 形态）。

**手机最终 APK（统一包）**

```
$ shasum -a 256 docs/review/final-android/deliver/dsh-botcrew-final-2056.apk
  → 6e16ae2d041e3e1f616b6bc3c742b4e6f0e58f1ca57cb986f8d9ae88a5fe6755   (16,421,767 B)
$ testDebugUnitTest / testReleaseUnitTest  → 410 / 410 全绿
```
含 pausePress 方向 / 进程级 debugport / TailcatP2p 硬 20s deadline / 配对 fix（#31/32/34）/ 复核文案单位修复。
主包 `install -r` 一次装成、OPPO 未拦；主配对资产 `crew-pairing.xml` sha256 一字未变。

**生产进程**

```
$ ps -p 89699 -o pid,lstart  →  89699  Sat Nov 14 14:26:39 2026  (node … --profile superagent)
$ ps -p 89697 -o pid,lstart  →  89697  Sat Nov 14 14:26:39 2026  (bash -c 父壳)
$ ps -p 67367 -o pid,lstart  →  67367  Sat Nov 14 18:31:04 2026  (mobilegw，launchd 拉起)
```
HMR 上线不重启宿主，父子 PID 与 lstart 全程未变。**本轮未发任何信号。**

**Git**

```
HEAD = b2f305e ；本地 origin/feat/four-blocks tracking ref 停在旧处（离线无法重跑 git ls-remote；
  不以远端 HEAD 作比较，tracking ref 可能旧 ahead 假象）
git status -sb → 130 dirty/untracked（51 files changed，+3420/−372）
git stash list → stash@{0}: WIP on feat/four-blocks: b2f305e …（冻结，勿 pop/drop）
git diff --cached → 空
```
**用户名下未授权 commit / push**，本轮所有改动只落在工作树；不删除/暂存他人文件。

---

## 三、事故与并行工作状态（只记录，不进最终交付口径正文）

- **ds23 全树 stash 事故**：已恢复并经 owner 核验。`stash@{0}`（`b2f305e` 基线）**冻结，勿 pop/drop**。
- **mobilegw 两次意外重启**（18:29:49 / 18:31:04）：两次都是 `pkill -f "backend/tools/mobilegw"` 路径子串
  误杀生产网关 `41418→65972→67367`；归因**本树任务**（`ds-network20-max`）。现 `67367` 由 launchd 拉起，
  `127.0.0.1:8788`，健康 13/13 ready。取证见 `docs/review/incident/2026-11-14-mobilegw-restart-incident.md`。
- **网关日志脱敏**：已 0600、等长替换、count 0、不改 inode/size；`wb-gateway` 30 isolation + 29 transport 通过；
  **maintenance token 未轮换**（旧进程不热读，维护窗口内，不需设备重配）。**本轮禁止跑 `ensure_gateway`**。
- **Trae Max 额度**：19:30 QUOTA 中断；用户 20:49 明确改 **WorkBuddy DS 500k**。
- **Graph 批次（#23 第 1、2 项，mail-calendar）**：**独立 Graph 批次**（在 memory `e39f323c` 之上追加，不是 2073 的延续）。
  代码侧共享 stable：**119 files / 2110 tests 全绿、tsc 0、新增 37 tests**。**独立 review/build/HMR 已完成**（wb-graph-review-release）：
  `backend/lib/index.js` 现为 `2ade8753…`（mtime 21:37:48），`runGraphWatch`/`MicrosoftGraphPort`/`graphHealthOf`/`readGraphToken`
  命中 2/2/3/2（均>0），memory `retarget`/`ensureSettled` 6/4 仍在、#24 不退；零源码改动、仅构建产物 + append patch 注释；
  独立负对照 7/7 绿。**文档口径勘误（只改文档，不改源码/HMR）**：Graph **未配置未启用，`/state` 无 mail/calendar
  健康条目（缺席 None）**——pure `graphHealthOf` 单测仍返回 `paused`（保留），Runtime 层未配凭据不建条目故 `/state` 不出现；
  **配置后错误 health 才进入可见**。已在 engineering-report 追加勘误，不抹历史报告；不阻塞 #23 收口。

---

## 四、外部解锁清单（把这些补齐，对应 issue 才能真关）

| 需要的外部输入 | 解锁 issue | 具体到可执行 |
|---|---|---|
| 一台**不同 NAT 出口**的对端（非同一路由器） | #20 第 1 项 | 确认 `win-laptop` 网络窗口，或提供另一台不同公网出口的机器；另需手机蜂窝数据开通（`mobile_data=1` + 数据注册 IN_SERVICE） |
| **真实只读 Graph token**（Mail.Read + Calendars.Read）+ **真机在线接收窗口** | #23 | `GRAPH_TOKEN`/`GRAPH_TOKEN_FILE`（值不落库、不回退 Hub token）；`pushNotice` 推一条真弹出才算送达；面板可配表单属新 settings 设计须另立 brief |
| **真实 MCP 服务器**（messages 或 shopping）+ 凭据引用 | #21 | 宿主注册成 `mcp__<server>__<tool>`；`readTools`+`writeTools` 两列写全 + connection + 审批四连 |
| **DSH provider 级隔离能力** | #22 / 翻默认 isolation | DSH 侧给 provider 级 uid/gid 或外包沙箱；worker 会话不再钉死 `danger-full-access` |
| 真 GUI 人眼（双徽标、群组栏、takeover 按钮） | 残 UI 面（契约 §9.4/§10） | headless 截图之外的一次真窗口确认 |

**contract 剩余 TODO 状态（`docs/00-contract.md`，`grep -n 'TODO(' 捞取；按后续真机/GUI 报告精确分层，不新增 scope）**

> **已完成的部分（附引用，别仍一概当「没做」）**：
> - **配对屏四条路径已过**（`docs/review/2026-11-14-pairing-screen-four-paths.md`）：①干净安装弹系统权限框 ②拒绝权限后手输地址仍配对 ③同网段多台选第二行 ④手改地址不被发现流抢，四路全 **passed**。方法为**同源码只改一行 applicationId 的隔离测试包**（`com.dsh.botcrew.pairingfixture`），第二行来自**真实发布 mDNS 的 fixture 服务**（`fixture-pairing-*`，明确标 fixture、非「真第二台电脑」），配对成功不碰主包 `66e74d226c1e38fa`。
> - **桌面 takeover 按钮走真实产品处理器**（`docs/review/2026-11-14-desktop-gui-remaining-acceptance.md` §五）：mygo `act press` → 真实产品 `OnClick` → 两真票 `5846d4f0`/`eb555457` 停止不复活。**不是接口级。**
> - **双徽标同屏**、**群组栏三态**：同一真窗口**自渲染像素**已看过（`04-fixture-dual-badges-live.png` / `05`–`07-crop-groups-*.png`），**是 fixture 真窗口像素，非 OS 系统屏幕截图**。

| TODO 条目 | 状态 | 仍未覆盖的（保 OPEN，真机人眼面） |
|---|---|---|
| `TODO(gw, 2026-11-14)` §9.4 真机验收剩余 | **部分完成** | 仅剩：①**生产现场两徽标「自然同时 >0」的系统屏幕（OS screencapture）截图**——现有是 fixture 真窗口自渲染，生产侧两枚只分别出现、同时刻不可控；②**非 fixture 群组栏的真机可见屏幕采集**（现为 fixture 三态窗口自渲染）。**配对屏四验已过，不再挂「三验未做」。** |
| `TODO(desktop, 2026-11-14)` 桌面 GUI 真点「接手 →」 | **已完成** | 无（按钮已真点、真票真停，见上引用）。剩余同 `TODO(gw)` 的 OS 屏幕采集边界。 |
| 常规 `Regular` 启动不抢焦点 | OPEN | 产品 `main.go` 用默认 `Regular`+`NewWindow` 会 `activateIgnoringOtherApps`；验收包用 `accessory`+`ShowInactive` 是**测试构建差异**，未改产品起法、未声称产品不抢焦点。**按原要求确需真机聚焦验收才保留。** |
| §9.4 第二个 conversation 真派单 `/state` + 归档守卫 | ✅ 已验 | `2026-11-14-work-conversation-ticket-acceptance.md`，39 断言全 PASS |
| #15 第 3 项 远程恢复 4 项联调 | ✅ 已由 #19 覆盖 | contract 原「未做/移交」已订正为本条；四项逐项真机证据含失败路径 |

> **口径红线**：已完成的功能验收如实引用并标 fixture 标签；保 OPEN 的**只剩真正需要 OS 系统屏幕证据 / 生产自然同屏 / 常规启动聚焦**这几条，**不泛称「全没做」、不把窗口自渲染叫 OS 截图、不抹 fixture 标签、不新增额外 scope**。
---

## 五、可交付 artifact 路径（本轮在磁盘上、可复核）

- 本审计账：`docs/review/2026-11-14-closeout-audit-ledger.md`；用户交付版：`docs/review/2026-11-14-final-closeout.md`
- 进度唯一事实源：`开发进度.md`（§二 现状头已是 21:40 CST 收尾账版）
- **桌面最终 r2（不是 r1）**：
  [`desktop/build/release-20261114-r2/Bot-Crew-desktop-release-20261114-r2.zip`](../desktop/build/release-20261114-r2/Bot-Crew-desktop-release-20261114-r2.zip)
  （sha256 `6532659d…f564c`）及
  `desktop/build/release-20261114-r2/Bot Crew.app`（binary `f132d7fff…d54bc1`，`codesign --verify` exit 0）
- **手机最终 APK**：
  [`docs/review/final-android/deliver/dsh-botcrew-final-2056.apk`](final-android/deliver/dsh-botcrew-final-2056.apk)
  （sha256 `6e16ae2d…fe6755`，16,421,767 B，已装、主配对指纹不变）
- 生产后端：`backend/lib/`（当前 `index.js` sha256 `2ade8753…`，mtime 21:37:48；含 memory-sync 批次 + Graph 批次；Graph 未配凭据时 mail/calendar `/state` 缺席）
- 关键分报告（按 issue）：`docs/review/2026-11-14-issue*.md`、`…desktop-*.md`、`…memory-config-lifecycle*.md`、
  `…issue23-graph-engineering-report.md`、`docs/review/incident/2026-11-14-mobilegw-restart-incident.md`

---

## 六、我核对了什么 / 还在等谁（持续更新）

**我（wb-final-ledger）已核对**：同一份 `gh issue list --state all`（关 #15 后重取，32 条，自动计数 **26 CLOSED / 6 OPEN**）；
`date` 实际时区 CST；HEAD / tracking ref / stash / 工作树 stat；`backend/lib` 部署判据（含 Graph 两符号已>0）；
r2 包 zip+binary sha256 与 codesign；手机最终 APK sha256；生产进程三 PID + lstart；
#24 §九、#31/32/33/34、#15 全部条款与评论、#19 四项逐项证据、#20 蜂窝预检、#23 Graph 工程报告、memory 配置生命周期验收报告。

**仍在推、需其落地后才改口径的 owner**：

- `wb-graph-review-release`：**已完成**。#23 Graph 批次独立 build/HMR 上线（lib `2ade8753…`），符号在 lib、
  memory 未覆盖、负对照 7/7。**Graph 未配置未启用，`/state` 无 mail/calendar 健康条目（缺席 None）、零外部请求**；
  pure `graphHealthOf` 单测仍返回 `paused`（保留）、Runtime 层缺席，配置后错误 health 才可见；核心 memory `ready`。
  文档口径勘误已记入 engineering-report，不阻塞。
- **#20/#21/#22/#23** 真未决，缺外部输入（见 §四），**不 claim 全完**。

> 上述 owner 未落地时，对应 issue 一律标"进行中 / 外部阻塞"，**不 claim 全完**；本文件持续更新，直到 owner 真正结束。
