# 记忆中枢配置生命周期：复验 + 生产热部署独立报告

- 日期：2026-11-14（复验提交时间约 20:50–21:00）
- 工单：单任务接回 `ds-runtime-memory-max` 的 memory 配置生命周期源码，做复验＋生产热部署（不重写）
- 执行者：`wb-memory-config`
- 上游报告：`docs/review/2026-11-14-memory-config-lifecycle.md`（`ds-runtime-memory-max`，额度失败前已基本完成）
- 分支/状态：`feat/four-blocks` 工作树，**未 git add/commit/push/stash/checkout/restore/reset**
- 生产影响：**仅内存配置热部署**（build + cordis patch 触 recompose + 受控 hot PUT 后恢复原值）。未 restart/pkill/launchctl，未碰 mobilegw、未跑 ensure_gateway。

---

## 一、结论（先给结论）

上游报告的源码实现**属实且完整**，本轮复验通过，并已在生产**不重启进程**完成热部署与在线验收：

1. 源码现状核对：`HubProbe.retarget`（整套换 hub/timeout/token + 代数 generation 丢弃迟到旧响应）、端口现读 probe（`base/timeoutMs/token` 皆传函数）、`Settings.memoryChanged` 钩子 → `applyMemoryConfig`、`network down = error`、`default timeoutMs=8000`、`ensureSettled` 等待 ≤1000ms 上限 —— **与报告描述逐条一致**。
2. 质量门：`tsc --noEmit` exit 0；**全量 2038/2038 通过（114 文件）**；目标 memory 4 文件 73 例全绿。
3. 部署：`pnpm build`（tsdown）exit 0，产物 `lib/index.js` 由 `26a25843…` 变为 `303704fd…`；新产物含 `retarget`/`ensureSettled`/`memoryChanged`、`default(8e3)`。
4. 热上线：通过「bump `lib/index.js` mtime + cordis.patch 注释触 reconcile」使 dsh-hmr **evict 并重新 import** 链接包 `dsh-superagent`，**PID 89699 不变**（etime 持续增长，无重启）。
5. 在线判据（真实公网中枢 `https://jarvis.kentonnie.top/v1`）：
   - hot PUT 受控临时错 token（rev 5→6）→ health `starting`（**旧 build 不可能出现的四态之一**）→ `error`；
   - hot PUT 改回原引用（rev 6→7）→ `starting` → **`ready`**；
   - 全程无重启。配置值已**精确恢复原值**，`health.memory=ready`。
   - 旧 build 判别：旧 `hubHealthOf` 只有两维、无 `starting`、探测超时仍报 `ready`；出现 `starting` 本身即证明新代码在跑。

---

## 二、生产部署事实（精确 hash / 进程）

| 项 | 值 |
| --- | --- |
| git HEAD | `b2f305e616f52fd19ca75bae3960d669e8aaa823` |
| 旧 `lib/index.js` sha256（部署前） | `26a25843c3f66a6773d453d3c41ce9d3d5e39c844a3ecd71dedfce0ed299959a` |
| 新 `lib/index.js` sha256（部署后） | `303704fd7db2d0d43e175006b697bde42b536c5aed951a7370ebc34d7e0e3f55` |
| 新 lib mtime | 2026-11-14 20:58:30 |
| `cordis.patch.yml` sha256（触 recompose 后） | `36172240a7c9064a0005cca2daee63902c50c64dcd6c0c4257fd2061ed7a2c80` |
| 新产物 marker 计数 | `retarget|ensureSettled|memoryChanged` 出现 12 次；`default(8e3)` 存在 |

**源码侧 hash（我复验的写范围，未改一字逻辑，仅核对）**

```
24e5b7204f0d0e350129d322aa1110017bdb3ac7c9b7011cf61c499be7956a6e  src/memory/detect.ts
498d2edc841c0b763ab819321f78ef0807d224cc53acbf1e84468ac6a7846ebc  src/memory/auth.ts（新文件）
1c73ce7377fa635a429e911f3f25f94899346372bb52e3b22b16317b4747a9ec  src/memory/hub-client.ts
455f80c13310411986a043fa74752f2447fb98504b9a5dca084ec05f373a882e  src/memory/hub.ts
c39c5dbb9ee1bf7f3c6c008eb68e7f0e1fbf4d1886d80891de4c92ebb5d446dc  src/memory/port.ts
6149e737654dfd81a42a0ce55a1ce3f0b3537510a06f0d83076969eb95d60e5e  src/app/runtime.ts
a6c91a20a701d19636c4f09124266718ef85d47b8366b7dd43d3bb6ce6c9a856  src/app/settings.ts
a237ee3e05abdba8d8a51465b5ac47470af5cb2ec7b0ae988460c68c6acd1483  src/policy.ts
```

**进程稳定性（全程未 restart/pkill/launchctl）**

| PID | 角色 | 部署前 etime | 部署后 etime | 结论 |
| --- | --- | --- | --- | --- |
| 89697 | bash 启动壳 | 06:24:59 | 06:32:45 | 不变 |
| 89699 | dsh `--profile superagent` | 06:24:59 | 06:32:45 | **同一 PID，etime 累加，无重启** |
| 67367 | mobilegw | 02:20:34（启动 18:31:04） | 02:28:20 | **未触碰，launchd 未 kick** |

---

## 三、热部署机制（关键：为何「只 touch 注释」不够）

- dsh-hmr（`@deepseek-ai/dsh-hmr`）在 `dsh-base` 中以 `root: []` 启用：**只监听配置 patch 文件，不监听模块根目录**。配置 patch 变更 → `refresh()` → `reconcileProfile()`。
- `reconcileProfile` 用 `profileRoots()` 计算 watch 根，**包含 link: 链接包**（`node_modules/dsh-superagent -> ../../Code/dsh-bot-crew/backend`）。它会比较链接包下模块的 mtime，把「mtime 与上次记录不同」的模块判为 `stale` → `evict` → 重新 `import`。
- 因此：**仅追加注释（内容变、语义不变）不会触发模块重导入**；必须让 `lib/index.js` 的 mtime 相对 reconcile 基线发生变化。本轮做法：`touch backend/lib/index.js`（内容已是 20:53 build）+ patch 追加 release 注释 → 5 秒内触发 recompose 爆发（新的 `Service name is already in use` bonjour 重注册 + `[memory] hub 鉴权就绪` → `hub reached`），PID 不变。
- 语义层面的迟到旧响应/代数守卫、`starting` 四态等，均由源码保证，不依赖重启。

> 说明：本轮 `pnpm build`（20:53）之后的第一次纯注释 touch（20:54/20:56）未触发 recompose —— 因为彼时 reconcile 基线已把 20:53 的 mtime 记入。真正生效的是 20:58「bump mtime + patch touch」。这是本任务新发现的**操作要点**（见 §六 issue 1）。

---

## 四、在线验收（真实公网中枢 + state/health，无重启）

命令（同源管理头，`x-orchestrator-request: 1` + `host: 127.0.0.1:3082`）：

```bash
# 读基线
curl -s http://127.0.0.1:3082/orchestrator/api/settings -H 'host: 127.0.0.1:3082' -H 'x-orchestrator-request: 1'
curl -s http://127.0.0.1:3082/orchestrator/api/state    -H 'host: 127.0.0.1:3082' -H 'x-orchestrator-request: 1'
# hot PUT（memory 块，带 revision CAS）
curl -s -X PUT http://127.0.0.1:3082/orchestrator/api/settings/memory \
  -H 'host: 127.0.0.1:3082' -H 'x-orchestrator-request: 1' -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:3082' -d '{"value":{...},"revision":N}'
```

| 阶段 | memory revision | health.memory | 说明 |
| --- | --- | --- | --- |
| 基线（部署后、改前） | 5 | `ready`「中枢凭据来自凭据文件」 | 原配置：hub=`https://jarvis.kentonnie.top/v1` timeout=`8000` tokenEnv=`HUB_TOKEN` tokenFile=`/Users/cpuser/.config/hub-memory-mcp/env` |
| hot PUT 受控临时错 token（tokenFile→`/tmp/memcfg.*/wrong.env`） | 6 | `starting`「正在探测中枢」→ 2s 内 `error` | **`starting` 为四态新值，旧 build 不可能；证明新代码在跑**；无重启 |
| hot PUT 恢复原引用 | 7 | `starting` →（约 8s 公网探测）→ **`ready`** | 无重启；改对引用当场恢复 |

凭据只以**引用**操作：临时 fixture 为 0600 文件、值 `token-wrong-controlled-000000`（占位串，非真实 token）；**报告与日志不输出任何真实 token 值**。临时目录已 `rm -rf`。

**配置已恢复核对**：当前 `settings-version:99`（live）memory 值 = `{hub:…/v1, timeoutMs:8000, tokenEnv:HUB_TOKEN, tokenFile:/Users/cpuser/.config/hub-memory-mcp/env}`，与初始 rev5 **逐字段相同**。`settings-version:98` 是那次临时错 token PUT 的**历史快照行**（settings-version 追加式历史，非 live 指针；live 只认最新 99）。全库无残留 `/tmp/memcfg` 引用之外的有效配置（98 行是历史，不影响运行）。

---

## 五、测试与质量门（命令 + exit code）

```text
npx tsc --noEmit
  → exit 0，无输出

npx vitest run tests/crew-memory-lifecycle.spec.ts tests/crew-memory-detect.spec.ts \
               tests/crew-memory-hub-auth.spec.ts tests/crew-memory-hub-client.spec.ts
  → 4 files passed，73 tests passed，exit 0

npx vitest run --exclude 'tests/issue21-integration-readiness.spec.ts'
  → 114 files passed，2038 tests passed，exit 0，~30.7s

pnpm build (tsdown)
  → exit 0，17 files，lib/index.js hash 26a25843… → 303704fd…
```

> **关于全量里那 1 个失败**：直接 `npx vitest run` 会报 `tests/docs.spec.ts` 失败，原因是**另一个 owner 在 20:53（我的测试运行期间）新建了未跟踪文件 `tests/issue21-integration-readiness.spec.ts`，尚未登记进 `docs/007-architecture.md` 的 Tests 表**。这是他人任务的在飞产物，**不属本任务的 memory 缺陷，不在我的写范围**，故不修改 issue21 与 007 的无关行。排除该文件后全量 2038/2038 通过，恰好等于上游报告声称的 2038，反证其余全绿。

---

## 六、本任务新发现的 issue（按根因证据）

1. **[操作要点/文档缺口] 链接包热部署的正确触发 = 「bump 模块 mtime + patch 触 reconcile」，而非仅 build 或仅注释 touch。**
   根因：dsh-hmr 以 `root: []` 运行（只监听配置 patch，不监听模块根），模块替换依赖 `reconcileProfile` 的「链接包 mtime vs 基线」比较；`pnpm build` 若发生在某次 reconcile 之后、mtime 被记为基线，则后续纯注释 touch 不会重导入。建议在 `docs/006-deployment.md` 或 007 的部署段写明：热部署链接包需 `touch lib/index.js` 后再改 patch，或显式触发一次 reconcile。**本轮已按此实证生效**。

2. **[非本任务] `tests/docs.spec.ts` 因他人未跟踪测试文件在飞而红。** 归属 issue21/integration-readiness 的 owner：把 `tests/issue21-integration-readiness.spec.ts` 登记进 007 Tests 表即消除。本任务仅记录，不代改。

3. **[留面板 owner，同上游 §七.3] `src/client/locales.ts` 的 `memoryHubTimeoutHint` 仍写「几秒内降级本机」，未提 8000 与实测依据。** 该文件当前工作树含 isolation（#17/#22）与 memory hub token 文案的**混合改动**（来自多人，非本任务作者）。我**未触碰** `client/`，仅记录：memory hub 的 tokenEnv/tokenFile 文案已存在于该文件（面板 owner 已补），timeout hint 待其顺带更新。

4. **[同上游 §七.1] `health.memory` 四态扩到 `starting`**：消费方若硬编码三态需跟随。overview `problems` 只收 `error`，不会因 `starting` 多假故障。在线验收里已实测 `starting` 正常出现并被前端 state 接口原样返回，无异常。

---

## 七、写范围与禁止项自检

| 约束 | 状态 | 证据 |
| --- | --- | --- |
| 只做复验 + 部署，不重写源码 | ✅ | 源码 hash 见 §二；本轮**未改任何 src 逻辑** |
| 写范围仅 memory 生命周期必要修复（上游已写）+ 本独立报告 | ✅ | 新增本报告；未碰 app/、desktop/、client/、progress、HANDOFF、crew-watch |
| 不碰 gateway script owner（wb-gateway）源码 | ✅ | 未改 `backend/tools/gateway_*` |
| 不运行未验完的生产启动脚本 / ensure_gateway / restart / pkill / launchctl | ✅ | 全程只 build + patch 注释 + hot PUT；89699/89697/67367 PID 不变 |
| 保持 dsh 89697/89699、mobilegw 67367 进程不变 | ✅ | etime 累加、lstart 不变 |
| 真实 hot PUT 只改受控临时 hub/token/timeout，验后恢复原值 | ✅ | rev5→6→7，值逐字段等价；临时 fixture 已删 |
| 凭据只引用不输出值 | ✅ | 报告/命令只见引用与占位错串 |
| 不碰个人记忆、不做真实合并批删 | ✅ | 只 PUT memory 配置块；无 consolidate 批删；未删/改记忆条目 |
| 不打坏生产已验证 hub + token 引用 + timeout 8000 | ✅ | 恢复后与原配置一致，`health.memory=ready` |
| 不整体关 #24（真实产品上行 seam 另任务未验） | ✅ | 未动 seam；未关 issue |
| 禁 git add/commit/push/stash/checkout/restore/reset | ✅ | 全程未执行任何 git 写操作 |
| 子委派仅 WorkBuddy DS 且 catalog 匹配 | ✅ | 本轮无子委派（depth 0） |

> `src/client/locales.ts` 的工作树改动（isolation + memory token 文案）来自他人任务的在飞产物，**非本任务作者**，已按写范围隔离未触碰。

---

## 八、给下游（wb-memory-sync）的冻结窗口约定（已完成）

- 冻结范围：全 `backend/src` + `backend/tests` + 007 文档，在我 build/HMR（本报告 §二–四）完成前冻结；sync 在 `/tmp` 起草。
- 我的编辑与 sync 的 seam（`runtime.ts` L548-551 settle/forget、L1490+ watchCompaction、`app/memory.ts`）**不同 hunk**；我完成 build+HMR 后即发 GO 释放 `runtime.ts`，它再落自己的 hunk，各自 typecheck/test，不整文件覆盖我段。
- **本报告完成时刻起，build/HMR 窗口关闭，runtime.ts 交还 wb-memory-sync。**

---

## 九、残余风险

### 追加（同日 21:07–21:13）：合并 release —— 含 wb-memory-sync 的 author/retraction seam

wb-memory-sync 落盘其接线后，我 review + 质量门 + 打包 + 热部署了**合并 release**。

- **review（与我的生命周期段不打架 ✅）**：AuthorMirror 插在 `new MemoryLayer(...)` 之后、`new Settings({memoryChanged})` 之前；我的 applyMemoryConfig/retarget/memoryChanged 段一字未动（hash 确认）。makeHubRetraction 用 `()=>memoryProbe.base()/token()/timeoutMs()` 现读闭包，口径与原 port 一致，热生效随 retarget 自动跟随。AuthorMirror 构造无副作用；publish 只在 settle 且 toHub===true（sync 裁定 C 令 settle 硬编码 false）→ recall/settle 热路径零新增网络；forget/edit 撤回失败全 catch→watchdog，非致命。
- **质量门**：tsc exit0；全量 **117 files / 2069 tests 全绿**（含 issue21，已登记 007）；build exit0。
- **部署**：lib/index.js `303704fd…` → **`b73123c2…`**（含 retarget×6 + AuthorMirror×3 + makeHubRetraction/tombstone×7 + default(8e3)）；`touch lib/index.js` + cordis.patch 注释触 recompose，**PID 89697/89699（14:26:39 启动）/67367（18:31:04 启动）lstart 不变，无 restart**。
- **在线现象（重要，非回归）**：recompose 当刻公网中枢 `GET /v1/health` 出现真实 TTFB 抖动（connect 0.19s，但 TTFB 3–8s 偶发 >8s 超时），新代码**如实**报 `error 中枢不可达`——这正是本修复的目的（旧 build 会谎报 ready）。实测：真实改配置（timeout 8000→8001）触 `retarget`→新 probe→`hub reached`→**health 立即 ready**，证明代码正确、热生效链路完好。
- **发现的行为边界（by design，记录）**：探针只在 `retarget`（真值变更）或记忆操作 `ensureFresh/ensureSettled` 时重探；**内容相同的重复保存是 no-op、不重探**（revision 不变，与新测试「内容相同不重复探测」一致）。因此 idle 服务上若上次探测恰逢瞬时超时，会停在 stale `error` 直到下一次记忆操作或真值变更——不是缺陷，但**运维需知**：健康面 `error` 可能是「上次探测时的瞬时抖动未被后续操作刷新」。
- **配置终态**：timeout 已从调试用 8001 恢复 **8000**；live settings `settings-version:103` memory 值 = 原值（hub `/v1` / 8000 / tokenEnv HUB_TOKEN / tokenFile hub-memory-mcp/env）；`health.memory=ready`；PID 不变。
- **未验证（如实）**：真实 forget/retract 链路需服务端 tombstone 端点上线；当前 `wb-hub-retract` 端点仍在 canary，`tombstoneByDigests` 命中 404/5xx 会 catch 成 retractError（非致命 watchdog 告警），**不得当作「成功撤回」**。真实上行/撤回端到端另任务验。
- **产物与 tip 的分叉（重要，供最终 QA）**：我部署的冻结产物 `lib/index.js=b73123c2…` 构建自 21:08 时源码（runtime.ts 当时 `cbc5b40e`）。**其后 21:13:45 wb-memory-sync 又追加编辑 runtime.ts**（tip 现 `116592bb`：新增 `retryPendingRetracts()` 周期重试 + seam 扩写，+2 hunk），**不在我的冻结构建内**。按 lead「不双重部署、冻结产物」指令，我**未重建/未重部署**；sync 的 21:13 最新编辑属后续 release，由 lead 最终总 QA 处理。核查：sync 全部新增均在**我的 memory 配置段（L257-346）之外**，我段 hash `7fc4d2ab…` 稳定未被动。

1. 当前 live 的 `settings-version` 因多次 hot PUT 追加到 103（历史含受控错 token / 调试 timeout 快照行）；live 值 = 原值。若要求「settings 历史也零痕迹」，需另行 scheme，但 live 配置正确、health ready，不影响运行。
2. 热部署靠 touch 触发 recompose，属**该 profile 的既定机制**；未来若把 dsh-hmr `root` 从 `[]` 改为包含模块根，则可自动监听 `lib` 变化（但那是宿主配置变更，需单独评估）。
3. 真实产品上行 / 合并 seam（#24 剩余）不在本任务，未验证，未关闭。
