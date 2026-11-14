# Issue 现状清单（2026-11-14，供重新出 issue 用）

- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`
- 核对基准：HEAD `33c53e3`（2026-11-14 10:36）。核对期间 lead 又提交了 `5f89fb3`
  （只改 `开发进度.md`，**零代码改动**，内容是「真机一条活 / takeover / P2P 锁屏 / 自动换路」的验收记录）。
  所以下文所有 `file:line` 仍以 `33c53e3` 为准，代码内容与当前 HEAD 一致。
- 核对方式：逐条读 issue 全文（body + 全部评论），再对每个「剩余项」**落到代码或实测**上复核。
  issue 自述可能过期，本清单以代码 / 运行态 / 提交为判据，冲突处写明。
- 本轮只读 + 只写本文件：未改 issue 状态、未发评论、未 `git add` / `commit` / `push`。
- 运行态基线（2026-11-14 10:46–11:06 实测）：
  - `DSH_PROFILE=superagent sh scripts/doctor.sh` → **exit 0**，`crew path looks healthy`
  - `GET /orchestrator/api/state` → 12 项 health 全 `ready`，`isolation: "none"`，`paused: false`，`load.running: 0`
  - `backend` 在 `git archive 33c53e3` 干净快照上复跑：`tsc --noEmit` 0 错、`vitest run` **107 文件 / 1851 例全绿**
    （工作区有在途改动，所以基线一律取干净快照）
  - `desktop` `go vet ./... && go test ./... -count=1` → **全绿**（246 个顶层 `Test` 函数 /
    308 条 `=== RUN` 含子测试；3 条按设计跳过：`TestAgainstTheLiveGateway`、
    `TestDesktopSessionShardingAgainstARealGateway`、`TestDesktopSessionAgainstTheLivePhoneSurface`）
  - `app` `JAVA_HOME=JDK21 ./gradlew testDebugUnitTest` → **362 例全绿**（0 fail / 0 error / 0 skip）
  - 注意：`backend/tests/` 与 `backend/src/` 有**其他 agent 的在途改动**（未提交），
    下文所有 `file:line` 一律指 **HEAD `33c53e3`** 的内容，不用工作区当前内容。

## 总览

| # | 标题 | 核对后的真实状态 | 可关 / 需保留 / 该拆 |
|---|---|---|---|
| 5 | 差距评估：离 Muse / Grok 级个人助手还差什么 | 9 条 gap：**1 条已闭环（4）、2 条已归档（2 / 8）、1 条半归档半闭环（1）、5 条部分完成（3 / 5 / 6 / 7 / 9）**；正文多处自述过期 | **需保留**（转为索引）+ 该拆 |
| 6 | [Review] 四维产品评审 | 第三批 4 项**全部有证据**；核对中新发现 1 个不在它范围内的真 bug（`doctor.sh` 多实例取错 profile） | **可关**（新 bug 另开一条） |
| 10 | Step 7 行动面扩展 | 5 项：类型底座✅、多会话✅（已由 #14 收口）、群组✅（后端+桌面）、真账号集成❌、重验◐ | **该拆**（真账号集成独立成一条） |
| 11 | Step 2 强制隔离 | 3 项**全未闭环**：agent 自由命令❌、隔离档真机活❌（none 档的活已通）、默认开启❌ | **需保留** + 该拆 |
| 12 | Step 4 一直在线 | 第 1 项**已归档**（用户决定）、第 2 项**已完成**、第 3 项随归档搁置 | **可关**（归档指针已留档） |
| 13 | 模型切换最后一层 | 3 项**全部有硬证据**：覆盖点已定位、已根治、真机 request 已走新路由 | **可关** |
| 14 | Step 7 多会话 | 兜底点✅、手机 LAN 门✅；**relay 门未走**、**桌面真 GUI 未点**（只到 httptest 级） | **需保留**（收窄为一条真机补验） |
| 15 | Step 0 四期收尾 | 7 项：**3 项已完成（2 / 5 / 7）、1 项半完成（1：takeover 通、记忆编辑未验）、3 项未做（3 / 4 / 6）**；混了「真机验收 / 外部配置 / 部署」三种性质 | **需保留** + **该拆** |
| 16 | 真机退化两条 | 第 1 条**已完成**（真机证据在评论）、第 2 条**当前无可复现故障** | **该拆**（第 1 条可关，第 2 条转专项） |

一句话：

- **可整条关掉 3 条**：#6、#12、#13（每条的所有剩余项都有证据或已归档）。
- **该拆后关一半 1 条**：#16（第 1 条可关，第 2 条转专项）。
- **需保留但收窄 2 条**：#14（只剩 relay 门 + 真 GUI 两格）、#15（保留记账，拆出 3 条）。
- **需重写 / 拆分 3 条**：#5（转索引 + 每条 gap 各自立 issue）、#10（4 项已完成，只留「真账号集成」并拆出去）、
  #11（3 项全未闭环，且第 1 项跨仓不可闭环 → 拆成「隔离档真机活」与「agent 自由命令隔离」两条）。

没有一条能整条原样保留——每条都混了已完成与未做的部分。

---

## 逐条

### #5 差距评估：离 Muse / Grok 级个人助手还差什么

`ready-for-human`。这是战略清单，9 条 gap 逐条对账：

| gap | issue 自述 | 核对后的状态 | 证据 |
|---|---|---|---|
| 1 一直在线 | 「`choose()` 没接线；手机不自动换路」 | **已归档 + 已完成**：托管不推进（用户决定）、换路两半都落地 | `docs/review/2026-11-14-hosting-options.md`（`33c53e3`）；`e160105` + `3e0b6ff`；`app/.../CrewClient.kt:226` `preferBetterEntry()`、`MainActivity.kt:190` 接进失败分支 |
| 2 推送只通三分之一 | 「手机收 pushSend / 通知展示不存在」 | **已归档（用户叫停）**：FCM / APNs 不接，保持缺口 | #5 评论《计划》2026-11-12「语音与消息推送直接停掉」 |
| 3 安全边界是约定 | 「worker 同 OS 用户，记忆互读」 | **部分完成**：审批闸已进执行路径；隔离有 `sandbox` 档但**默认 `none`**，agent 自由命令仍裸跑 | `backend/src/policy.ts:141` `.default('none')`；`backend/src/infra/environment.ts:197` `runIsolated`；`docs/adr/0004-worker-isolation-os-user.md:38-42` 已写明边界；实测 `/state` → `isolation: "none"` |
| 4 会静默卡死 | 「自愈还没做」 | **已完成**（issue 正文过期）：告警 + 有界自愈都落，`#8` 已关 | `6e330c1`（告警）、`45885d8`（`runSelfHeal`）、`fabc6a0`（五项收口） |
| 5 记忆能用但不可信 | 「Hub 上行没接」 | **部分完成**：客户端已接真实 HTTP；**中枢服务端与跨设备同步未做**，当前实测中枢地址为空 → 全走本机 | `backend/src/memory/hub-client.ts`（`/memory/search` + `/memory/consolidate` 客户端）、`80a58f5`；实测 `settings.memory.hub = ""` → `detect.ts` 走本机版 |
| 6 行动面太窄 | 「无真实集成；只有 main 会话」 | **部分完成**：四类 kind 底座已扩；多会话 S1–S4 全落地；**真账号集成未做** | `backend/src/app/connections.ts:26`（7 种 kind）；`2f623c1`…`99f2780`；实测 `settings.connections = { connections: [], readOnly: true }` |
| 7 主动性刚起步 | 「无收件箱 / 日历主动监听、晨报」 | **部分完成**：日报 / 跟进 / 常规任务已落；**收件箱 / 日历监听未做** | `backend/src/app/notices-out.ts:65` `dailyNotice`、`:79` `DAILY_HOUR=21`；`backend/src/app/routine-runner.ts:38` `dispatched` / `held`；`backend/src/sources/` 只有 github / team / mobile，无 mail / calendar 监听源；实测 `connections: []` |
| 8 单人单机 | 「无多用户」 | **已归档（明确不做）**：#6 的「明确不做」节裁定往团队共享工作台走要重写身份模型 | `docs/00-contract.md` §5 能力边界；#6「明确不做」 |
| 9 模型层单点 | 「无多模型 fallback」 | **部分完成**：`backup` 备选路由已落；**面板编辑 backup 的表单未做** | `backend/src/policy.ts:77` `RoleRouteSchema = …extend({ backup: RoleModelSchema.optional() })`；`69c6f0d`；`backend/src/client/locales.ts` 无 backup 相关键 |

**判断**：正文「仍未动」那一句列了 7 项，其中一直在线、推送、多会话、模型 fallback 四项已经不成立。
**建议**：**需保留**，但转成「索引 / 追踪」性质——它自己不再是可以直接派活的一条，
每条剩余 gap 都该有独立 issue（见文末拆分）。不要在原 issue 里继续追加进展评论，
否则它会一直膨胀成第二份 `开发进度.md`。

### #6 [Review] 四维产品评审：契约债、resume 缺口、验收空白

`documentation` + `enhancement` + `ready-for-human`。issue 自述「只剩第三批」，核对结果**基本成立**：

**第三批（唯一能改变结论的一批）逐项**

| 项 | 核对后状态 | 证据 |
|---|---|---|
| 打包 `.app` 手点四入口 | **已完成**（TCC 麦克风文案一项按 #5 决策停掉） | `docs/PHASE_DESKTOP_COMPLETION.md:46-48`；`desktop/build/desktop-window.png`、`desktop-speak*.png`、`desktop-voice-result.png`、`desktop-microphone.png`（11-12 实测截图）。TCC 首次授权弹窗文案：`docs/review/2026-11-12-acceptance.md:34` 明写「语音两入口与 TCC 按 #5 计划停掉，保持已落代码不动」 |
| 侧栏拖到 180 / 140 / 100px、savebar、Split | **已完成** | `CREW_DEBUG` 动作 `sidebar.width 180/140/100` 精确落位（#6 正文第三批第 2 项已勾） |
| 真机装 APK | **已完成** | #15 第 5 项：新包已装，调试口 `capability: live`、`timeline.loaded: true`、`send` 后 48 条 |
| `pnpm typecheck && test && build` + `doctor.sh` 退出 0 | **typecheck / test 本轮实测全绿；`build` 本轮未跑（会重写运行中宿主加载的 `backend/lib/`）；doctor 退出 0 已达成但换了个前提** | `pnpm exec tsc --noEmit` → 0 错（在 `git archive 33c53e3` 的干净快照上复跑过，排除在途改动干扰）；`pnpm exec vitest run` → 107 文件 / **1851 例**（同一快照复跑）；`DSH_PROFILE=superagent sh scripts/doctor.sh` → **exit 0**。`build` 的最近一次成功记录见 `开发进度.md`「17:40 S1 整阶段」与「19:25 S2/S3 整阶段」两处（tsdown 构建完成），本轮按红线未重跑 |

**新发现的一个真 bug（`doctor.sh` 多实例下取错 profile）**

- 现象：**不设** `DSH_PROFILE` 直接跑 `sh scripts/doctor.sh` → **exit 1**，
  报 `phone ports cannot derive them: no stateDir for profile 'hot2'`，
  且 `profile` 行提示「the running crew is 'hot2'」。
  `DSH_PROFILE=desktop` 同样 exit 1（profile 行变成「`DSH_PROFILE=desktop`，but the running crew is `hot2`」，
  `phone ports` 仍推导不出）。**只有显式 `DSH_PROFILE=superagent` 才 exit 0。**
- 根因：`scripts/doctor.sh` 的 `running_profile()` 遍历 `pgrep -x node` 后 **`| head -1`**，
  只取第一个带 `--profile` 的进程。本机同时跑着两个 dsh：
  - pid **53567** `dsh --profile hot2`（无关实例）
  - pid **70723** `dsh --profile superagent`（真队伍，`tmux: dsh-superagent`，09:11 起）
  `head -1` 拿到 53567 → 推导出 `hot2` → 找不到该 profile 的 `cordis.patch.yml` → 端口全空 → 误报硬失败。
- 影响：`doctor.sh` 的退出码依赖「本机只跑一个 dsh」这个假设。多实例下它是**假故障**，
  而 #6 把「doctor 退出 0」当作收口判据之一 —— 判据本身不稳。
- 建议：这条**不要**塞回 #6（#6 是 2026-11-12 的评审快照，性质不同）。单开一条：
  让 `running_profile` 按「谁在监听 3082 / 谁的 stateDir 存在」选，而不是 `head -1`。

**建议**：**可关**。P0-1 契约四处、P0-2 `resume`、第三批 4 项全部有证据；
剩下的 `doctor.sh` 多实例 bug 单开新 issue。关闭时在评论里点名「#6 的第三批验收已并入 #15 完成，
不再单独跟踪」。

### #10 Step 7 行动面扩展：四类真实集成 + 多会话（gap 6 收口）

`enhancement` + `ready-for-agent`。5 项逐条：

| 项 | 状态 | 证据 |
|---|---|---|
| 1 四类集成的类型与审批底座 | **已完成**（issue 已勾） | `backend/src/app/connections.ts:26`：`'mail'｜'calendar'｜'files'｜'messages'｜'shopping'｜'payments'｜'tickets'`；`backend/src/policy.ts:110` 同 7 种；`032dab7` |
| 2 接一个真实集成并端到端走通 | **未开始** | 实测 `settings.connections = { connections: [], readOnly: true }` —— 一个都没配；需真账号 + 宿主挂 MCP，本机无法闭环 |
| 3 多会话 | **已完成**（由 #14 收口） | `2f623c1`（S1 协议）→ `8853337`（S2 手机）→ `4037c42`（S3 桌面）→ `67b4077`/`2874642`（S4）；`backend/src/app/mobile-http.ts:529` `operation === 'sessions'`、`:1319-1320` GET/POST 注册；真机 `["main","work"]` 已通 |
| 4 群组视图 | **已完成（后端 + 桌面；手机端刻意不做）** | `backend/src/app/groups.ts:116` `groupsOf`；`backend/src/app/mobile-http.ts:1111-1114` 三态投影；`desktop/ui.go:1205` 群组只读栏、`:1236` `groupsOfConversation`；契约 `docs/00-contract.md:1107` §10 明写「桌面端画，手机端不改（二选一）」 |
| 5 重验（隔离身份下仍工作 + 三端全绿） | **部分完成** | 三端全绿（本轮实测：backend 1851 例 / desktop 246 个 Test / app 362 例）；「隔离身份下仍工作」**没验**——`isolation` 仍是 `none`，见 #11 |

**判断**：issue 的「现状（2026-11-13）」节整段过期——它还写着「多会话/群组视图未做」，
而 4 片已在 11-13 23:10 全部落地。第 2 项与第 3/4 项是**完全不同性质的事**：
一个要真账号（外部条件），两个是纯工程（已完成）。混在一条里，`ready-for-agent` 这个标签会误导。
**建议**：**该拆**。
- 把第 2 项拆成新 issue「接一个真实集成并端到端走通」，标 `ready-for-human`（需真账号 + MCP 配置），
  保留「四类 kind 底座已就绪」作为前置说明。
- 第 3/4 项关掉（证据齐）。
- 第 5 项的重验并入新拆出的隔离真机活那条（#11 第 2 项），不重复派活。

### #11 Step 2 强制隔离：runAsWorker 已盖住，剩余 agent 自由命令、真机活与默认开启

无标签（应为 `ready-for-human`）。3 项**全未闭环**：

| 项 | 状态 | 证据 |
|---|---|---|
| 1 agent 自由命令的隔离 | **未开始（依赖上游）** | `docs/adr/0004-worker-isolation-os-user.md:38-42` 自陈「worker 在 agent 会话里实际跑的每一条命令由 DSH 的 subprocess provider 起，不在本仓 `runAsWorker` 这条缝上」；`backend/src/executor/dsh.ts:287`（HEAD）**全仓唯一** `runIsolated` 调用点（`grep -rn runIsolated backend/src` 只此一处）；`@deepseek-ai/dsh-subprocess-local/lib/index.js` 里按 `uid` / `gid` / `sandbox` 三个关键字 grep，只命中 `foregroundPgid`，**provider 层没有 uid/gid 支持** |
| 2 真机一条活 | **◐ 要拆开看**：`none` 档下的真机活**已通**；`sandbox` 档下的真机活**没做** | 已通：ticket `4514e272a4c6b33083f67b24d6e488b3`（10:46–10:47）与 `20ec7f99…`（10:50）全流程跑完、`ended.by: executor`、worker 报告与产出对得上；但当时 `isolation: "none"`（实测 `/state`），**隔离开着跑一条活这一格没打勾** |
| 3 默认开启 | **未开始**（前置未满足） | `backend/src/policy.ts:141` 仍是 `.default('none')`；实测 `/state` → `isolation: "none"`。第 3 项前半（档位可见）已完成：`backend/src/app/http.ts:116` 暴露 `isolation`、`backend/src/client/execution.tsx:36-38` 面板显示 + `InfoTip` |

**判断**：issue 自述「真机一条活需重启窗口」这半句已经过期——重启窗口在 09:11 用掉了，
但那次跑的是 `none` 档。第 1 项与第 2/3 项是两种完全不同的东西：一个**本仓不可闭环**（要 DSH 上游改），
两个**本仓可闭环但要真机窗口**。混在一条里，收口线「三项全部验收通过之前 Step 2 不能算彻底完成」
永远不可能被满足（第 1 项取决于别人）。
**建议**：**需保留 + 该拆**。
- 新 issue A：「隔离档（`sandbox`）下跑一条真机活，通过后翻默认」——含第 2、3 项，
  可执行，本仓 + 一次重启窗口即可闭环。前置：`prepare` 在 sandbox 下要能写仓库目录
  （工作区已有在途改动：`backend/src/policy.ts` 加 `repositories`、`backend/src/executor/dsh.ts:293`
  把 `settings.repositories` 并进 `writableRoots`、`workerGhConfig` 给 prepare 一个自己的 gh 配置目录）。
- 新 issue B：「agent 自由命令的隔离：向 DSH 提 provider 级 uid/gid 或外包沙箱」——标 `ready-for-human`，
  明写「本仓不可闭环，取决于上游」。原 #11 关掉，两条新 issue 承接。

### #12 Step 4 一直在线：choose() 已接线，剩余常驻托管

无标签。3 项：

| 项 | 状态 | 证据 |
|---|---|---|
| 1 常驻托管 | **已归档（用户决定不推进）** | `docs/review/2026-11-14-hosting-options.md`（`05d8129` 分析 + `33c53e3` 归档决策）：三方案 A Mac+launchd / B NAS 常驻 / C 云主机；用户 2026-11-14 决定「以 Mac 为终端」。实测佐证：`tmux ls` → `dsh-superagent: 1 windows (created Sat Nov 14 09:10:58)`；`ps -o ppid -p 70723` → PPID 70722（tmux 侧），**不是 launchd** |
| 2 手机端自动换路 | **已完成** | `e160105`（`preferBetterEntry()`，`app/.../CrewClient.kt:226`）+ `3e0b6ff`（接进探测循环失败分支，`MainActivity.kt:190`）；`CrewClientFailureTest` 11 → 14 例；反向验证：改成空操作 → 用例红 |
| 3 重验（托管切换后看门狗与睡眠恢复） | **不适用**（随第 1 项归档） | 看门狗与三端当前全绿（`backend` 1851 例、`app` 362 例、`desktop` 246 个 Test、`doctor.sh` exit 0） |

**判断**：这条 issue 的唯一硬门槛（第 1 项）已被用户主动放弃，第 2 项完成，第 3 项随第 1 项失去对象。
issue 正文里「收口线：第 1 项是硬门槛」现在指向一个**永远不会满足也不会再尝试**的条件。
**建议**：**可关**。关单时保留两条事实：
1. 「Mac 睡了 / 断网 = 助手不在线」**仍然成立**，是已知且被接受的取舍，不是已解决——
   这句必须写进关闭评论，否则以后会有人把「#12 已关」读成「一直在线做完了」。
2. 归档指针留在 `docs/review/2026-11-14-hosting-options.md`，将来重开时从文末三个问题接着答
   （stateDir 怎么迁 / worker 在哪跑 / 手机要不要重配）。

### #13 模型切换最后一层：selectModel 已写入，实际 request 仍用旧 provider

无标签。3 项**全部有硬证据**：

| 项 | 状态 | 证据 |
|---|---|---|
| 1 定位覆盖点 | **已完成** | `docs/adr/0006-model-selection-request-source.md`：模型来源是**单链**，`selectModel` → `picked`（`projectionState.pending`）→ `assembled`（`system-prompt/assemble` 快照）→ `agent/request` waterfall 覆盖 provider/model。不存在独立的「preset 覆盖点」；`selectModel` 写 selection 但 `picked` 没置上时，`current` 回落到落盘的 `request/header`（指向死 provider） |
| 2 根治 | **已完成**（生产代码本就正确，本次补的是钉死它的证据） | `backend/src/app/role-models.ts:92-94`：纠正走 `ctx.sessionController.selectModel`，注释写明「不能只 append 一条 selection」；`c570867` |
| 3 真机验收：一条真实 request 的 provider/model 必须是新路由 | **已完成（本轮补到硬证据）** | 主 Session `orchestrator-bbbb4bafe8b5e5afe49748149f93df3d` 的 `session.v4.jsonl.zstd`：**110 条 `assistant/message` 全部 `provider=magpie` / `model=workbuddy/deepseek-v4.1-flash-500k`**；`request/header` 三条（11-13 07:56 / 11-13 08:03 / **11-14 09:12**）的 `config` 均为 `magpie / workbuddy/deepseek-v4.1-flash-500k`；09:11 重启后 09:12–10:50 的 turn 25–31 全部走这条路由 |

**自动化回归**：`backend/tests/role-models.spec.ts` 17 个 `it()`，含「老会话 + 落盘 header 指向 `deepseek-account` + 过时 selection →
`initializeRoleModel` 纠正后 `selectModel` 被调用，且 `assemble()` 之后真实 `request()` 返回新 provider/model」。
两层反向验证（退回 `append` → 2 例红；只让 fixture 不置 `picked` → 新例单独红）。

**判断**：issue 收口线是「第 3 项验收通过之前不能算完」，第 3 项现在有**运行态直接证据**，
不是「selection 写对了」而是「真实 request 走对了」。
**建议**：**可关**。关单评论里贴上面那三行数字（110 条消息的 provider/model、三条 request/header、
09:11 重启后仍成立），这比「测过了」有力得多。

### #14 Step 7 多会话：S4 已落地，剩余三处兜底点对账与真机切会话补验

无标签。2 项：

| 项 | 状态 | 证据 |
|---|---|---|
| 1 三处客户端兜底点逐项对账 | **已完成** | `d0bec28`（三处逐项结论）+ `660bd6d`（判据收紧成零例外）。逐项：① `POST /sessions` 缺 `default_session_id` → **修掉**，`backend/src/app/mobile-http.ts:550` 与 GET `:532` 同形；② 会话条目无 `name` → **裁决不提供**，写进契约 `docs/00-contract.md:874`「`sessions[]` 的条目就是 id 字符串」；③ 非法 id 的 400 不带能力位 → **修掉**，`:542` `reply(400, { error: 'invalid_session', session_api: SESSION_API })`，网关层仍刻意不带（契约已写为什么那一层例外）。测试 1846 → 1851 例 |
| 2 真机切会话补验（经 relay 与 lan-server **两道门**各切一次 + 桌面 GUI 同理） | **◐ 手机端只走了一道门；桌面端只到测试级** | 见下 |

**第 2 项拆开看**

- **手机端 / LAN 门：已完成。** `8b2c436` + `4adcf2d` 记录：经 LAN 门 `POST /api/mobile/sessions`
  新建 `work`（响应带 `default_session_id`）、`session.reload` 拿到 `["main","work"]`、切到 work 发一条、
  队列侧 `main` 37 条 / `work` 1 条互不串、`cached: ["main","work"]`。
  本轮实测佐证：`mobileq.db` → `main|43`、`work|1`。
- **手机端 / relay 门：未做。** issue 原文要求「经 relay 与 lan-server **两道门**各切一次」，
  上面所有证据都写着「经 LAN 门」。`grep -rn "relay" 开发进度.md` 里没有一条切会话记录走 relay。
  契约 `docs/00-contract.md:960` 的 `TODO(gw, 2026-11-13)` 仍逐字挂着「APK 切会话经 relay 与 lan-server 两道门」。
- **桌面端：只到 httptest / 临时网关级，真 GUI 未点。**
  另一个 agent 的在途产物 `docs/PHASE_DESKTOP_SESSION_CHECK.md`（未提交）与 `desktop/session_gui_test.go`（7 个 Test）：
  A 层 `httptest` 假队伍 + 整扇窗（列 / 建 / 切 / 发 / 缓存互不串，断言真发出去的 URL、头、body）、
  B 层独立临时 `mobilegw` + 真 `mobileq.db`、C 层本机真消息面**只读**。
  同时该文档自陈一个硬事实，本轮已独立复核：**桌面调试口里没有任何 session 动作**
  —— `grep -c session desktop/debug.go` → **0**；`bus.register` 26 处、唯一动作名 24 个
  （`nav.*` 那处是循环展开成 7 条，另加 `pauseAll`，合计 31 条），逐字是
  `actions.list / adopt / answer / backend.tab / memory.forget / memory.reload / mode.set /
  model.open / model.reload / model.scope / model.switch / nav.backend / nav.board / nav.memory /
  nav.models / nav.outputs / nav.routines / nav.selectBot / pauseAll / preview / refresh /
  routines.reload / screen.fullscreen / screen.look / send / sidebar.toggle / sidebar.width /
  state.dump / steer / withdraw / work.open`。
  所以「按调试口驱动真 GUI 切会话」这条路不存在，只能靠测试级证据 + 人眼点一次。运行中的 GUI 是 11-13 02:44 起的 pid 12335，
  二进制也是 11-13 02:44 的，而 `desktop/ui.go` / `client.go` 是 11-13 23:38 改的
  —— **跑着的窗口比源码旧 21 小时**，S3/S4 的会话 UI 它根本没有。

**判断**：issue 收口线「三处兜底点逐项有结论 + 真机切会话两道门证据齐」，前一半已满足，后一半满足一半。
**建议**：**需保留**，但收窄成一条可执行的真机补验：
「relay 门切会话 + 重新打包 `.app` 后真 GUI 点一次切会话」。
不要重写整条 issue——S1–S4 与兜底点的历史都在里面，重写会丢掉「header 最终裁决」那段的理由链。

### #15 Step 0 四期收尾：真机验收五项与未接两件，必须一次清完

无标签。7 项：

| 项 | 状态 | 证据 |
|---|---|---|
| 1 桌面端 takeover 全流程 + 记忆编辑重启后还在 | **◐ takeover 已通、记忆编辑未验** | takeover：`开发进度.md` 的 `[x] 真机一条活跑通 + takeover 全流程`（`5f89fb3` 新增，11-14 10:46–10:51）—— 先跑一条 25 秒的活（ticket `4514e272`，worker 报告与产出逐字对得上：`takeover-test.txt` 5 字节 hello），再用一条长活验接手：接手前 `assignment: running` → `POST /api/mobile/takeover` 回 `{"ok":true,"stopped":true}` → 接手后 `ended.by: human` / `outcome: stopped`（验证了 `cf8dd59` 那个假成功修复）。记忆编辑「重启后还在」：**无任何记录**，`grep -rn "记忆编辑" 开发进度.md` 只命中「未做」那一行（`[ ] 桌面端 takeover + 记忆编辑重启后还在`） |
| 2 手机端花名册 / 48dp / 暂停 → 继续 | **已完成** | 花名册 3 个与后端逐字一致；48dp `uiautomator` 真实 bounds **16/16** 达标；暂停 → 继续：`POST /api/mobile/pause` → `paused: True` → 暂停期间 3 条消息 200 且 id 41/42/43 都在 → `resume` → 顺序 1→2→3；完整链路已查实（Trigger `main:41/42/43` → Eval → 判官按内容 `ignore`，是正确裁决不是故障，见 `8ad3f4f` 纠正误判） |
| 3 远程恢复 4 项联调（含失败路径） | **未开始** | `docs/PHASE_REMOTE_RESUME.md` 末节「剩余验收」四项原样挂着；`开发进度.md:455` 仍是 `[ ]`。需真账号 + 失败路径演练 |
| 4 运行中 profile 加载新构建 | **未做**（只验了前置） | 前置已验（`node -e import(...)` 验 `name: dsh-superagent` / `apply` 是函数 / 11 个 inject 依赖）；本体要重启 dsh，会打断当前服务 |
| 5 真机 APK 安装 | **已完成** | 新包已装，调试口 `capability: live` / `timeline.loaded: true` / `send` 后 48 条 |
| 6 真实额度数据源 | **未开始（外部配置）** | `backend/src/app/quota.ts:8` 自陈「额度在这里只有一个诚实的含义：上下文余量」；「余额不算：单价与套餐由 provider 决定，不在这台机器上」。接真实计费源属外部配置 |
| 7 relay 重新部署 | **已完成（含尾巴）** | 11-14 00:05 `uptimeMs` 从 264620629（73.5h）降到 24568；`tunnels` 0 → 1。尾巴 `c610b3b`（语音媒体上限被 NAS compose 压到 256KiB）已由 `6b7ab31` 收口：删掉 compose 那行 + 重建容器，**同一份 500KB WAV 从 413 变 200** |

**复核第 1 项时发现的两点（不影响结论，但影响怎么复核）**

1. 那条活的产出文件现在**已不在** `~/.dsh/state/superagent/work/takeover-test.txt`（`ls` 与 `find` 均无）。
   可复核的耐久证据是 worker session
   `~/.dsh/sessions/--Users-cpuser-.dsh-state-superagent-work--/worker-4514e272a4c6b33083f67b24d6e488b3/session.v4.jsonl.zstd`
   里的 `tool/result`：`-rw------- 1 cpuser staff 5 Nov 14 10:46 takeover-test.txt` + `hello`。
   「文件真的在」这句现在只能靠这条日志复核，不能靠 `ls`。
2. 文件落在 **execution root**（`work/`），不是该票自己的 `work/create-takeover-test-file-4514e272a4c6/`（那个目录是空的）。
   这是 `backend/src/executor/dsh.ts:119-125` 写明的设计：worker Session 住在 execution root，
   而**显式票的 assignment 不带「你的目录在哪」那句**（注释原话：an explicit ticket's message is the request
   itself with no assignment beside it）。不是 bug，但以后验「产出落在哪」要按这个事实读，
   否则会误判成「worker 没在票目录里干活」。

**判断**：7 项里 **3 项已完成**（第 2、5、7）、**1 项半完成**（第 1：takeover 通了、记忆编辑「重启后还在」没验）、**3 项未做**（第 3、4、6）。但更根本的问题是**这条 issue 混了三种性质**：
- 真机动作（第 1 项记忆编辑、第 3 项远程恢复、第 4 项热加载）—— 要设备 / 重启窗口 / 人工
- 外部配置（第 6 项额度源）—— 要 provider 暴露用量，可能要钱
- 部署（第 7 项）—— 已完成，且过程记录比 issue 本身更细

收口线写着「以上 7 项全部有真机证据之前，Step 0 不算完成，`feat/four-blocks` 不具备合 main 的条件」——
把「接真实额度数据源」这种外部配置项和「点一次记忆编辑」绑在同一个合入闸门上，不合理。
**建议**：**需保留 + 该拆**。
- 保留 #15 作为 Step 0 的记账单（已完成那 3 项与半完成那 1 项的证据都在里面，别丢）。
- 拆出 3 条：远程恢复联调、运行中热加载、真实额度数据源（后者标 `ready-for-human` 且明写「外部配置，可能不推进」）。
- 记忆编辑「重启后还在」并进桌面真 GUI 那条（#14 拆出的补验），因为两者都要开 GUI 窗口，同一次做掉。

### #16 真机退化两条：配对 LAN 地址失效绕公网、Tailcat 打洞间歇超时

无标签。2 条：

**第 1 条：配对记录里的 LAN 地址失效 → 已完成**

| 判据 | 证据 |
|---|---|
| 能自更新 | `6d34d08` + `f1ab5e5` + `fdd3e59`。真机实测（issue 评论 2026-11-14 01:02）：`base` 从 `http://192.168.113.134:43499`（死地址）→ `http://192.168.31.127:43499`（Mac 当前真实 IP）；`crew` 从**不存在** → `0kvcc5t`；`entries` 变成 `127.0.0.1:38363`（本地代理）+ `192.168.31.127:43499` + 公网；`state.dump` → `way=p2p` / `route=隧道已连接（14ms）` |
| 根因 | 不是 mDNS 没广播（`dns-sd` 确认一直在发），是**认不出身份**：`crew` 是后加字段，老配对记录没有 → `paired.crew` 空串 → `CrewNearby.refresh()` 直接 `return null` → 自更新永不触发。补的第二判据：隧道地址 `tc-addr` 内嵌本机密钥，两台机器不可能撞上 |
| 代码 | `app/.../CrewNearby.kt:103-117`（双判据认人）；`app/.../CrewLanHealth.kt:69` `judge()` 双证据（连续失败数 + 跨网段）；`:95` `sentence()`、`:111` `routeLine()` 说人话（走公网且判定失效时整句「局域网地址已失效（电脑可能换过 IP），现在走公网中转」） |
| 测试 | issue 评论记「app 314 → 355 例（+41）」；**当前 HEAD 实测 362 例**（其中 `ProbeBudgetTest` 4 例来自 `d0a0668`，其余 3 例来自其后的提交）；7 轮反向验证（判定恒返 OK → 7 例红、失败不计数 → 5 例红、401/404 也算失败 → 1 例红、回旧指纹判据 → 1 例红、`routeLine` 原样返回 → 2 例红、`probeEntry` 空操作 → 5 例红、`refresh` 不补指纹 → 2 例红） |

**注意：issue 正文那句「同网段仍绕公网」已被实测推翻**（评论 2026-11-14 01:02）：
当时实际走的是 **P2P 本地代理 14–23ms**，不是公网；死地址是被 P2P 挡在后面的第三选择。
三条路实测：LAN 11–83ms / P2P 14–23ms / 公网 820–1082ms / 死地址 curl 31.4 秒超时。
真实问题是「死地址一直留着 + 自更新永不触发 + 界面不说人话」，三者都已修。

**第 2 条：Tailcat 打洞间歇超时 → 当前无可复现故障**

| 项 | 实测 |
|---|---|
| 解锁、app 前台，连续 20 次重探 | **20/20 成功**，稳态 14–18ms |
| 同一状态自然观察 5 分钟 | **0 次失败**，零重试日志 |
| 锁屏 40 秒 | `p2p: true`、10ms、`entries` 三条齐；锁屏期间发消息后端队列真的收到（id 44） |
| 之前那次 5% | 偶发，且当时叠加「进程刚被 `adb install -r` 重装」的干扰变量（已更正误判） |

副产品：`d0a0668` 修了 `probe()` 预算耗尽传 `readTimeout=0`（Java 里 = 无限等待）的坑，
抽成纯函数 `probeBudget()` + 4 例边界测试。**但这是防御性改动，不是在修已复现的故障**
（提交信息如实写了：解锁态看不出与改前差别，锁屏态探测循环根本不跑，无法验证）。

**判断**：第 1 条所有判据满足（自更新 + 真机证据 + 测试），第 2 条「间歇」两个字没法用当前网络证伪或证实。
issue 收口线「两条都有真机数字证据之前不关」——第 1 条数字齐了，第 2 条的数字是「20/20、5 分钟零失败」，
这**是**数字，但它证明的是「当前测不出来」而不是「已修好」。
**建议**：**该拆**。
- 第 1 条：**可关**（在评论里点名「绕公网」描述已被推翻，真实问题是死地址 + 自更新 + 说人话，三者已修）。
- 第 2 条：转成新 issue「弱网 / 跨 NAT 条件下 Tailcat 打洞成功率专项」，
  明写「当前网络 20/20，本机拿不到可信失败率；要拿到得在弱网 / 跨 NAT 下测」。
  原 #16 关掉，别让「间歇」两个字永远挂着当一条永远无法收口的 issue。

---

## 建议的新 issue 拆分

按「是否阻塞合 main」分三级。每条给标题 + 一句话范围。

### P0 · 阻塞合 main（真机 / 重启窗口，一次窗口可清多条）

1. **隔离档（`sandbox`）下跑一条真机活，通过后翻默认**
   在 `isolation=sandbox` 下走完整一条活（prepare + worker 执行 + 回话），确认凭据读不到、流程不被打断；
   通过后把 `executor.isolation` 默认从 `none` 翻到 `sandbox`，并复跑三端全量。
   承接 #11 第 2、3 项。前置：`prepare` 在 sandbox 下要能写仓库目录（工作区已有在途改动）。

2. **relay 门切会话 + 桌面真 GUI 切会话补验**
   手机经 **relay 门**（不是只 LAN 门）切一次会话、发一条、确认落对；重新打包 `.app`（当前跑的窗口比源码旧 21 小时）
   后真 GUI 点一次切会话、发一条、切回、确认两段 timeline 互不串。
   承接 #14 第 2 项未走完的那半 + #15 第 1 项的记忆编辑「重启后还在」（同一次开窗口做掉）。

3. **`doctor.sh` 多 dsh 实例下 profile 探测取错实例**
   `running_profile()` 的 `| head -1` 在本机两个 dsh（`hot2` 53567 / `superagent` 70723）下会挑错，
   导致 `doctor.sh` 无参跑 exit 1 的假故障。改成按「谁在监听 3082 / 谁的 stateDir 存在」选。
   承接 #6 剩下的那一格。

### P1 · M1 剩余（可独立排期）

4. **远程恢复 4 项联调（含失败路径）**
   按 `docs/PHASE_REMOTE_RESUME.md` 末节四项逐条走：真实设备凭据经 LAN 与中转调用恢复、未配对 401、
   手机暂停后按钮切继续并以 `status.paused:false` 校验、对 takeover 已停的票 resume 后仍为 stopped、
   通知/连接失败时客户端如实报失败。承接 #15 第 3 项。

5. **运行中 profile 加载新构建**
   不重启 dsh 进程加载新构建，走通且状态不丢。前置已验（产物可加载、11 个 inject 依赖齐）。承接 #15 第 4 项。

6. **弱网 / 跨 NAT 条件下 Tailcat 打洞成功率专项**
   当前网络 20/20、5 分钟零失败、锁屏连接保持；要拿到可信失败率得在弱网 / 跨 NAT 下测，
   顺带验 `probeBudget()`（`d0a0668`）在真实超时下的行为。承接 #16 第 2 条。

### P2 · 长尾 / 需外部条件（明确可长期挂着）

7. **接一个真实集成并端到端走通（`messages` 或 `shopping`）**
   配真实 MCP 服务器 + 真账号，worker 真读一次、写一次（写触发审批、批准后真执行）。
   四类 kind 底座与审批口径已就绪（`connections.ts:26`、`policy.ts:110`），当前 `connections: []`。
   承接 #10 第 2 项。**需真账号 + 宿主挂 MCP，属部署侧前置。**

8. **agent 自由命令的隔离：向 DSH 提 provider 级 uid/gid 或外包沙箱**
   当前 `runIsolated` 全仓只有一个调用点（`executor/dsh.ts:287`），agent 会话里每条命令由 DSH
   subprocess provider 起，本仓关不住。要么上游支持 provider 层身份切换，要么在 provider 外包一层。
   **本仓不可闭环，取决于上游。** 承接 #11 第 1 项。

9. **真实额度数据源**
   `quota.ts:8` 现在只报「上下文余量」这一种算得出来的额度；接真实计费源让面板数字与源头对得上。
   承接 #15 第 6 项。**外部配置，provider 是否暴露用量不确定，可能不推进。**

10. **主动性：收件箱 / 日历监听 + 晨报**
    日报（`notices-out.ts:65`，`DAILY_HOUR=21`）、跟进、常规任务已落；缺收件箱 / 日历主动监听。
    当前 `connections: []`、`sources` 里无 mail / calendar 监听源。承接 #5 gap 7。

11. **记忆中枢服务端 `/memory/*` 与跨设备同步**
    客户端已接真实 HTTP（`hub-client.ts`），中枢地址当前为空（`settings.memory.hub = ""`）→ 全走本机。
    剩下的是中枢服务端实现 `POST /memory/search` 与 `/memory/consolidate`（在 Hub 仓库，不在本仓）+ 跨设备同步实测。
    承接 #5 gap 5。**跨仓，本仓不可闭环。**

12. **面板 UI 编辑 `backup` 路由的表单**
    `policy.ts:77` 已支持 `backup` 备选路由、运行时已生效（`69c6f0d`），但面板没有编辑它的表单，
    `locales.ts` 无相关键。承接 #5 gap 9 的尾巴。小改动。

### 已归档、不再出 issue（写清楚，避免重新冒出来）

- **常驻托管（NAS / 云）**：用户 2026-11-14 决定不推进，以 Mac 为终端。留档
  `docs/review/2026-11-14-hosting-options.md`，重开时从文末三个问题接着答。
- **App 推送接收链（FCM / APNs）**：用户已明确叫停，保持缺口说明，不派开发任务。
- **多用户 / 团队共享工作台**：#6「明确不做」——缺的是身份模型（设备凭据 → 成员凭据），不是功能。
- **群组视图的手机端**：契约 §10 明写「桌面端画，手机端不改（二选一）」，这是裁决不是欠账。

---

## 附：本轮核对发现的三处「issue 自述与事实不符」

留给重写 issue 的人，避免照着过期文字派活：

1. **#5「仍未动」列了 7 项**，其中一直在线（第 2 项换路已完成）、推送（已归档）、多会话（S1–S4 已落地）、
   模型 fallback（`69c6f0d` 已落）四项已经不成立。
2. **#10「现状（2026-11-13）」整段过期**：还写着「多会话/群组视图未做」，而 4 片在 11-13 23:10 全部落地
   （`67b4077` / `2874642` / `63d1676` / `99f2780`）。
3. **#16 正文「同网段仍绕公网」被实测推翻**：当时实际走 P2P（14–23ms），不是公网；
   死地址是被 P2P 挡在后面的第三选择。真实问题是「死地址一直留着 + 自更新永不触发 + 界面不说人话」。

另有一条不是「不符」而是**判据本身不稳**：`doctor.sh` 的 `running_profile()` 用 `| head -1`，
多 dsh 实例下会挑错实例（本轮实测：无参跑 → 报 `profile 'hot2'`、`phone ports` 无法推导 → exit 1）。
#6 与 #15 都把「`doctor.sh` 退出 0」当收口判据，这条得先修，判据才可信。
