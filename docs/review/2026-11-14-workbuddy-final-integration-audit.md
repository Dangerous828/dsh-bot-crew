# 单任务最终独立集成审查 / 质量门（wb-final-audit）

- 日期：2026-11-14
- 执行者：`wb-final-audit`（WorkBuddy DS，lead 委派；本任务只做独立审查 + 质量门，不实施源码）
- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`，HEAD `b2f305e`
- 写范围：**仅本文件**。未 `git add/commit/push/stash/checkout/restore/reset`、未 `git clean`、
  未改任何源码 / 开发进度 / HANDOFF / crew-watch；未 `dsh-superagent start/restart/ensure_gateway`；
  未 adb 输入、未抢焦点、未杀未知 pid。定向探针一律 `/tmp` 独立副本，不污染共享 `tests/`。
- 复核对象：**当前工作树源码**（含全部 untracked，无 exclude），不是生产已部署 bundle。

---

## 零、结论先说（随 sync 新 freeze 更新）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| backend typecheck | ✅ | `npx tsc --noEmit` EXIT=0 |
| backend 全量（sync 新 freeze 权威） | ✅ | **`117 files / 2073 tests 0 fail`**（21:23:12 共享树独占一次，含所有 untracked 无 exclude，无 `_repro`）；快照内同结果 2073（21:22:34） |
| desktop vet / test / race | ✅ | `go vet` EXIT=0；`go test -count=1` ok；`go test -race` ok（6.90s，0 race） |
| gateway 隔离 | ✅ | `tools/test_gateway_isolation.py` **30 passed** |
| phone APK | ✅ | `dsh-botcrew-final-2056.apk` sha256 `6e16ae2d…fe6755`；debug 410 / release 410（wb-phone 报） |
| **settle 覆盖共享旧正文不撤** | ✅ **已被 sync 修复** | lead 裁定的阻断；sync 加 `SettleResult.retired` + recordRetractPending 持久兜底 + runtime 消费 retired 撤 canonical；定向测试绿；全量 2073 含其新增 3 测 |
| desktop 交付物 | ✅ **r2 正确产物** | r2 二进制 sha256 `f132d7ff…d54bc1`、zip `6532659d…f564c`、codesign valid、19:05 构建 ≥ 19:04 源码（见 §六 r2 核验） |
| config retarget 旧 response 不覆盖新 URL/token | ✅ | detect.ts generation 代数丢弃 + memory-lifecycle「旧探测迟到不覆盖」测试 |
| 失败撤回健康可观察 + 持久重试 | ✅ | `watchdogAlerts` + KV `memory:retract-pending:*` + `retryPendingRetracts`（真实调用点） |
| 进程未动 | ✅ | 89697/89699 lstart 14:26:39；67367 lstart 18:31:04；8788 仅 67367 LISTEN |

> **全量口径**：sync 新 freeze 后权威全量为 **2073** 例（117 files，0 fail，21:23:12 共享树独占一次）。
> 相对旧 2069：+1 测试断言字段变更（`existing_live`→`soft_deleted`）+3 sync 为 settle-retired 修复新增的定向测。

---

## 一、四 owner stable / 构建锁确认（逐个 send_message 往返）

| owner | 自报 | 我核实 |
| --- | --- | --- |
| wb-phone（Android final） | 源码冻结、无变异、无 gradle/connectedAndroidTest 在跑、不做 adb 输入 | APK sha256 `6e16ae2d…fe6755` 与设备 base 一致；`pgrep -fl vitest` 清；设备保持不操作 |
| wb-memory-config（2069 build + HMR） | 源码 stable、不占 build | detect.ts/auth.ts 锚点在；**并主动报产物漂移**：已部署 `b73123c2…`(21:08) ≠ tip（sync 21:13 追加） |
| wb-memory-sync（ledger 作者/撤回） | 源码冻结、无 vitest/tsc、2070 全绿 | 承认 21:15/21:16 的 vitest 是其验证跑（已结束）；现冻结 |
| wb-hub-retract（server 原子 deleted 占位 + health） | 已上线、无联调 | 线上镜像 `home-agent-hub:issue24health-20261114-211515`；`/v1/health` 含 `memory_retract:registered` |

---

## 二、AuthorMirror 整 mutation 生命周期（重点）

审查文件：`backend/src/memory/author.ts`、`hub-retraction.ts`、`auth.ts`；
接线：`backend/src/app/runtime.ts`（`memoryAuthor` 构造/`forgetMemory`/`editMemory`/
`noteMemoryRetractFailure`/`retryPendingRetracts`/settle 发布）、`memory.ts`（ledger）、
`mobile-http.ts`（edit 透传 toHub）。

### 逐条对齐任务要求

1. **settle 默认 false**：`memory.ts` `settle()` 的 `toHub: false` **硬编码未动**（裁定 C）；
   `runtime.ts:1588` ticket-compaction 的 settle 出的 entry 也默认 false → `publish` 不落盘。
   `publish` 只在 `entry.toHub === true` 且非敏感时写 md。✅
2. **认证 mobile edit 显式 toHub=true**：`mobile-http.ts:758` `if (typeof value.toHub === 'boolean') patch.toHub = value.toHub`
   透传到 `runtime.editMemory → ledger.edit` → `memoryAuthor.edit`。✅
3. **旧 28 条不分享**：`publish` 只对「新 settle 的 entry」或「显式 edit」生效，**不遍历旧 KV 行回改**。✅
4. **edit/forget/false/supersede/evict 远端旧版本撤回**：
   - `forget`：先 `tombstoneByDigests`（原子占位，挡未入库旧 pending）→ md 打 `disabled:true` →
     `bySourceFile` live 反查逐条软删。✅
   - `publish`(toHub true→false)：删 md + `bySourceFile`（带 keepDigest 时保留新版）。✅
   - `edit`：`publish(entry,{keepDigest:newDigest})` 重写 md + 撤旧版本 live 行（保留新 digest）。✅
   - `supersede`/`evict`：md `status:superseded`/真删 + `bySourceFile` 全撤。
     注：`apply()` 的 supersede/evict 分支在生产不直接调用（`memoryAuthor.supersede` 无生产调用点，
     `memoryAuthor.evict` 由 `retryPendingRetracts` 与 settle-retired 消费用，见 §三）；settle 就地覆盖
     曾共享条目的缺口已由 sync 修复（retired → `author.evict` 撤旧 canonical）。详细见 §三。
5. **publish 前持久 digest 历史**：`author.ts:108` `rememberDigest(name, pipelineDigest(pipelineContent(entry)))`
   → KV `memory:digests:*`（只 16hex、不存正文）。✅
6. **原子 deleted 占位不上传原文**：`tombstoneByDigests` 打 `POST /v1/memory/retract-tombstone`，
   body 只有 `{namespace, source_file, known_digests, reason}`，**无 content、无 POST-live-再-DELETE**。✅
7. **namespace / source_file / 内容摘要**：`AUTHOR_NAMESPACE='dsh-memory/bot'`、
   `sourceFileOf(name)=`${name}.md``、`pipelineContent/pipelineDigest` 与管道
   `_iter_dsh_auto_memories` 逐字对齐（实测 coder use-pnpm-test → 623bd5fb6702928a）。✅
8. **分页 <=100 收敛上界**：`bySourceFile` live 反查 `limit:100`、每轮删本批再查直到 live=0，
   `MAX_ROUNDS=20`（≤2000 版本）上界，避免死循环。✅
9. **keepDigest**：`bySourceFile({keepDigest})` 跳过 `digestOf(row)===keepDigest` 的行（保留新版）。✅
10. **失败 Runtime health + 持久 retry（不只内存/return error）**：
    `noteMemoryRetractFailure` → `watchdogAlerts`（`/state.alerts` 读）+ KV `memory:retract-pending:*`（持久）；
    `retryPendingRetracts` 在 `ticket.ended`(runtime.ts:406-409/1630) 真实调用，成功 `clearRetractPending`。
    `crew-memory-author.spec.ts` 有「新 Store 同库仍读得到 pending」= 跨重启持久证据。✅
11. **旧 pending 不复活的已知/未知边界**：已知 digest 由 tombstone 占槽吸收（线上实测
    `deduplicated:true, deleted:true`，live=0）；**未知（md 已删、内容不可读、算不出 digest）的旧 pending
    当前无自动保证**——协议 §10.2 已如实认这条边界，不假称覆盖。✅（如实）

---

## 三、settle 就地覆盖「已共享」条目不撤旧正文（lead 裁定阻断）——**已由 sync 修复**

**原缺口文件/行**：`backend/src/app/memory.ts` `settle()` L118-128（就地覆盖分支）。

**机制**：`slug(dedupe_key)` 确定性 → 同 `dedupe_key` 必同 `name` → supersede 分支
`existing.name !== name`（L120）不可达 → 走 L124 直接覆盖：`superseded=[]`、不记新 digest、
不触发撤回。触发链：认证 edit 置 toHub:true 上行 → 后 ticket-compaction 同键换 body 覆盖 →
写回 toHub:false 且旧正文远端行仍 live。

**修复（sync，SHA-256 指纹已对齐）**：
- `memory.ts` `SettleResult` 新增 `retired:{name,botId}[]`（L52）。当 `existing.name===name &&
  existing.body!==fact.body && existing.toHub===true` 时标旧 canonical 需撤（L108-109）；
  新 entry `toHub` 恒 false（不把旧 optin 延伸到 worker 新内容）；**并就地
  `recordRetractPending` 持久兜底**（L112-115，覆盖 hear/close 等所有 settle 路径）；
  相同 body no-op 保留现 explicit share、不 retired。
- `runtime.ts` watchCompaction settle 段消费 `settled.retired`（L1609-1610）→
  `author.evict(old.name, old.botId)` 撤该条 canonical 全历史（不因 current.toHub=false 跳过）。
- 定向：sync 7 文件 72 测全绿（含「share 旧→settle 同 key 新→新 false 且 retired 标旧 + recordRetractPending」
  「相同 body no-op 保 share」「旧从未 share 不 retired」）；全量 2073 通过。

**结论**：**原真实阻断已闭环**。当前 freeze 无该缺口。

**我的 freeze 指纹（SHA-256 前 12，与 sync 复核一致）**：
`memory 72d0f370c52c / runtime 1226810e2929 / mobile-http 3d425422d449 / prompts 0c2ea1f9817e /
kv 0667283b0ea0 / author abc182a5707c / hub-retraction cde89959af97`。
（注：sync 初报的 12hex 是 `shasum` 默认 **SHA-1** 前缀，与 SHA-256 必然不同；按 SHA-256 复核 7 个全对齐。）

**复现脚本（不共享，供 sync 参考）**：`/tmp/repro-inplace-overwrite.spec.ts`。
> **自我检讨**：此探针最初被我误放进共享 `backend/tests/_repro-*.spec.ts`，属不当；已全部 `rm` 净，
> `git status` 无残留，21:19/21:23 全量未计入。后续一律 `/tmp` 独立副本。

### 三附、全量首轮 2 个「失败」是快照缺 relay/，非真失败（如实留痕）
首次在 backend-only 快照跑时 `tunnel.spec.ts` / `voice-carrier.spec.ts` 报
`Cannot find module '../../relay/src/server.ts'`——因 `/tmp` 快照只拷了 backend 未拷兄弟 `relay/`。
补齐 `relay/` 后重跑全绿（2073）。这是**快照拷贝范围不全**，不是源码缺陷，也不抹除：如实记此。
正确质量门在**共享树**跑一次得同样 2073 全绿，无 `_repro` 污染。

---

## 四、config retarget：旧 response 不覆盖新 URL/token

- `detect.ts` `retarget()` → `this.generation += 1`；`probeOnce(now, generation)` 结尾
  `if (generation !== this.generation) return this.last` —— 迟到旧探测带旧代数直接丢弃，不写 last / 不播 onReachChange。
- `auth.ts` `retarget()` 清 `cached/status/problem/announced` 并 `refresh()`，作废旧「被拒」结论。
- 测试：`crew-memory-lifecycle.spec.ts`「旧探测迟到的结果不覆盖新配置」（旧 502 迟到后 health 仍 ready、
  `memoryProbe.base()===HUB_B`）+ `crew-memory-detect.spec.ts` 代数丢弃。✅

---

## 五、手机：deadline disconnect 真回收 / Pairing asked 跨重启

- `TailcatP2p.request()`：整步墙钟上限 `deadlineNanos`；到点 `connection.disconnect()` 关**真实连接** →
  阻塞 read 抛出 → 读线程退出（否则留永读线程 + 永传字节连接）。`TailcatProbeDeadlineTest` 5 条：
  慢滴(hang/drip)不越预算、慢但在预算内仍算通、快回照常探通。✅
- `PairingScreenStateTest`：`asked` 落盘语义 + `CrewNearby.shouldAsk(sdk,permitted,asked)` 跨重启
  （asked=true 不再问）。✅
- **边界（如实）**：慢滴是 JVM 真实台架（20.09s）+ 回收，**未在真 Android 设备跑慢滴**（wb-phone/lead 均认）。
  不把它说成「真机慢滴完整」。

---

## 六、网关 launchd 启动参数 / 台架不误杀

- `gateway_binding.py` `binding_problem(port,state)`：端口是声明非缺省；8788+生产状态=唯一合法（生产本身），
  8788+别的目录拒绝起。「先杀占端口的进程」那条路径被机制化掉。
- `test_gateway_isolation.py` **30 passed**：缺端口拒绝、占生产端口拒绝、ownership record（PID/端口/状态三元）、
  token 热轮换无需重启、bad 文件不锁死已配对设备、启动行不含凭据值。
- `mobilegw` 未提交改动（79+/4-）含 `current_token()` 热读 + `check_binding()`；**注意**：脚本 mtime 19:28
  晚于生产网关于 18:31 启动 → **运行中网关是旧代码**（token 热轮换要等下次合法重启/release 生效）。
  生产 8788 仅 67367 LISTEN，无 stray。
- **launchd 参数核对**：`com.cpuser.dsh-mobilegw.plist` ProgramArguments=`/usr/bin/python3`，
  env `MOBILEGW_PORT=8788 MOBILEGW_HOST=127.0.0.1 MOBILEGW_CONV=main`，与生产一致。本任务未 touch 该 plist
  （未 `launchctl`，未 kickstart）。

### 六附、desktop r2 产物核验（正确路径，非 r1）

最终桌面交付是 **r2**：`desktop/build/release-20261114-r2/`（r1 `release-20261114/` 建于 18:37，**弃用**）。

| 项 | 值 | 核对 |
| --- | --- | --- |
| r2 二进制 `Contents/MacOS/desktop` | sha256 `f132d7fff2792f3dce92225bd923680d46ee692188ebfa3d36a6f548c3d54bc1` | ✅ 与 lead 报一致 |
| r2 zip | sha256 `6532659ddae7bdae0218c6bb51576f1a2be0f0076390b4fb118452c7652f564c` | ✅ 与 lead 报一致 |
| codesign | `codesign --verify` → valid on disk / satisfies DR | ✅ |
| 时序 | r2 构建 19:05:33 ≥ 源码 debug.go 19:03:49 / ui.go 19:04:19 | ✅ 含 F1/F2/F3 修复 |
| 源冻结 | 报告 §6 记冻结树 `a13fc956…db475`；单文件 main.go 8c5ab118…、mainthread.go 7a4e29cc… 与实测一致 | ✅ |

> **订正（自我纠错）**：我最初误查 r1（`release-20261114/`，18:37）并据此判「产物过期」，是**看错路径**。
> r2 才是最终交付，已含修复、签名有效、hash 与 lead 报一致。另：`strings` 未命中 `admitListener`
> 不能单独证明缺实现（内联/裁符号），不作证据。r2 无需重建。

---

## 七、进程核实（不臆测外部代理）

| PID | 角色 | lstart | 结论 |
| --- | --- | --- | --- |
| 89697 | dsh 父壳 (bash -c nohup dsh) | Sat Nov 14 14:26:39 | 原值未变 |
| 89699 | dsh 主 node（PPID 89697） | Sat Nov 14 14:26:39 | 原值未变 |
| 67367 | mobilegw（8788 LISTEN） | Sat Nov 14 18:31:04 | 原值未变 |
| 23375 | `tailcat serve --key=default 43499`，**PPID 89699** | Sat Nov 14 21:10:02 | 主 node 的**子进程** fork；86560 已消失 |

**订正**：「86560→23375 是 dsh 自身重启」不成立。**主 node 89699 lstart 未动**；23375 是 89699 在 21:10
fork 的子 tailcat 进程（旧子 86560 消失、重新 fork）。插件 HMR 子 tailcat 重建与主进程 restart 是两件事，
不能混为一谈。

> 反复起的 `npx vitest run`（PID 34750/37806/46806/50160…）cwd=`…/backend`，父 54111=DSH desktop-host；
> 经与 sync 对账，是 sync 的 21:15/21:16 验证跑 + 其他 actor。**不臆测为未知外部代理**；现 `pgrep vitest` 全空。

---

## 八、真实完成 / 进行 / 外部条件（不伪造收口）

### 真实完成
- backend / desktop / gateway 质量门（当前 tip）如上绿。
- AuthorMirror 主路径（publish/forget/edit/toHub-false/publish 前 digest/原子占位/分页/keepDigest/持久重试）审查通过。
- config retarget 代数丢弃、手机 deadline 回收与 asked 跨重启、网关隔离与 launchd 参数均核对通过。

### 进行（无源码级未决）
- 无。settle 阻断已闭环；desktop r2 产物已核验；backend/desktop/gateway 全绿。
- **待做（不属源码质量门，属 release 动作）**：新 release 一次完成部署（旧 `b73123c2` 不含
  retryPendingRetracts/retired），随后 sync 跑真 A/Windows-B 端到端链。

### 外部条件（不要求伪造账号收口）
- **#20 跨 NAT win-laptop offline**：需 win-laptop 在线，当前不可达。
- **#21 真 MCP 缺**：真实 MCP 账号/服务缺失，不能用伪造账号冒充收口。
- **#22 host 身份隔离**：隔离身份下的 worker 面验证依赖真实 host 身份环境。
- **#23 真实 mail/calendar + 设备接收端**：真实账号与设备接收端暂停，代码侧已就绪，端到端未通。

---

## 九、当前未经 committed 的风险（交 lead，user 未授权 git 提交不自动 commit）

- HEAD 仍 `b2f305e`；工作树有大量未提交改动（backend/app/desktop/docs 等）+ 新增 untracked 源文件
  （`memory/auth.ts`/`author.ts`/`hub-retraction.ts`、多个 `*.spec.ts`、`desktop/mainthread.go` 等）。
- `git diff --cached` 空、stash `stash@{0}` 冻结未动（多人中间态，pop 会覆盖，处置权交 lead）。
- 生产 `backend/lib/` 是 `b73123c2…`(21:08，`index.js` mtime 21:09:57) 构建，**不含** sync 21:13 追加的
  `retryPendingRetracts` 接线，也不含 settled.retired——需新 release 一次完成部署（**新 release actor 等本结论再 build/HMR**）。
- desktop 交付为 **r2**（正确路径 `desktop/build/release-20261114-r2/`）：zip `6532659d…f564c`、
  二进制 `f132d7ff…d54bc1`、codesign valid、19:05 构建 ≥ 19:04 源码。**r1（`release-20261114/`，18:37）
  是弃用产物**，不作为交付。
