# 统一发布门 + MCP 真实接线验证（task-9，wb2-release-final）

日期：2026-11-14 · 角色：`wb2-release-final`（lead 唯一 release/test/build/Android 窗口所有者）· claim task-9 rev2
范围：审 notice 持久化三文件 + 12 test；复用 2167 全量门；build（tsdown）+ exports 校验；superagent 内部消息 MCP 真实接线（不重启主进程）；真实验收读/写审批/拒后零写；Android 两变体 + 安装；更新 21/22/23 口径。

> 一句话：**质量门 2167 全绿 + tsc 0 + 真实 worker E2E 20/20 + MCP 在真实 host 上下文可见四个 `mcp__messages__*` 工具 + 读放行/写审批/拒后零写在真 Runtime 上通过**。生产 dsh(89697/89699) 与 mobilegw(67367) **未重启**（lstart 不变）。过程中一次 canary 写误入真实 DB，已**精确删除并核回基线**（详见 §7，是本轮最重要的诚实披露）。

---

## 0. 结论与阻断
- **发布门：无阻断（源码级）**。全量 `vitest run` = **125 files / 2167 passed / 0 failed**；`tsc --noEmit` = **0 错**；`tsdown build` = **成功**，所有 `exports` 目标 EXISTS（locale glob 的 en/zh 实在）。
- **notice 持久化三文件审：无阻断**。`PushOutbox` 现在盘为真相、内存只当 Cache：`keep`/`ack` 先 `load()`（读盘、滤过期并同步删盘）、改完先写盘成功再更新内存；写盘失败抛出、绝不先回 `queued`。Runtime 构造器内 `store` 就绪后 `pushOutbox = new PushOutbox({}, storeNoticeStore(store))`，依赖顺序显式，**不存在遗留的内存 Map 路径**；读它的 `pendingNotices/ackNotices/takePending` 全走同一个持久 outbox。TTL/CAP/同 kind 合并语义与旧口径一致，`notices.spec.ts` 未改。
- **MCP 真实接线：工具确实出现在真实 host 上下文**（`mcp__messages__list_channels/list_messages/get_message/send_message` 四件，真 agent live 列出）。不是「child 进程活 29s」当完成。
- **待 lead 决策的唯一非阻断点**：MCP profile 注册 hunk 是否现在落 `~/.dsh/profiles/superagent/cordis.patch.yml` 并靠 HMR 生效（默认 none、不重启主进程）。技术前提已全部验证可注册（§5）。

---

## 1. 质量门（唯一一次全量，release 窗口独占）
```
cd backend
node_modules/.bin/tsc -p tsconfig.json --noEmit     → 0 错（TSC_EXIT=0）
node_modules/.bin/vitest run                        → 125 files / 2167 passed / 0 failed
```
- 与 lead 口径 **2167** 完全吻合（上一批 2155 为 wb2-messages-review 旧数，本轮 untracked cohort 全计入后为 2167，未把 HEAD b2f305e 当 source freeze）。
- 未改任何源码即复用了 2167 完整输出（本成员未改 src）。

定向 notice 复核（只读复跑，不占全量）：
```
vitest run tests/notices-persistence.spec.ts tests/notices.spec.ts tests/crew-push.spec.ts \
           tests/notices-morning.spec.ts tests/crew-notices-out.spec.ts   → 5 files / 75 passed
vitest run tests/runtime.spec.ts -t "live MCP connection gate"            → 4 passed
```

---

## 2. build（tsdown）与 exports
`rm -rf lib && node_modules/.bin/tsdown` → exit 0。产物含 3 个 worker 入口 + `worker-fs-helper.mjs` + dts：
```
lib/index.js  lib/index.d.ts
lib/client.js lib/github-watch.js lib/feishu-watch.js lib/mobile-watch.js
lib/team-watch.js
lib/worker-sandbox.js lib/worker-fs.js lib/worker-search-subprocess.js lib/worker-fs-helper.mjs
```
exports 校验（逐条 existsSync）：`. / ./client / ./github-watch / ./feishu-watch / ./mobile / ./package.json / ./team / ./worker-sandbox / ./worker-fs / ./worker-fs-helper / ./worker-search-subprocess` **全部 EXISTS**；`./locale/*.json` 为 glob，`locale/en.json` + `locale/zh.json` 实在。`import('./lib/index.js')` OK（28 exports）。

`package.json` 的关键修复（wb2-worker-e2e 已做，本轮确认落地）：`./worker-fs-helper` 由 `.js` 改正为 **`.mjs`**（copy 产物确为 `.mjs`，旧值指向不存在的 `.js`）。

lib worker 产物 SHA 与 E2E 冻结一致：
```
ae99f257…b351f96cad  lib/worker-fs.js
d7a8eb8a…b9886f89    lib/worker-sandbox.js
409fcef0…00fabea     lib/worker-search-subprocess.js
57ef3889…3cf3b7ecc2  lib/worker-fs-helper.mjs
12fbd8c7…021c6d56    lib/index.js（本轮 build 产物）
```

---

## 3. 真实 worker E2E（20 断言，用本轮刚 build 的 lib 跑）
```
cd backend && sh tests/worker-runtime/run.sh   → RESULT: ALL PASS（20/20）
```
真 DSH agent loop → 真 `tools.execute` → 局部 scope 的 `WorkerFileSystem / WorkerSearchSubprocess / WorkerSandboxProvider`：
- root `ctx.fs` 仍默认 `SandboxedFileSystem`、root `ctx.sandbox` 仍默认 `LocalSandboxProvider`（router/root none 对照）；
- [A/workspace-write] read 工作区成功（正对照）；read `~/.ssh` 被拒；symlink→`~/.ssh` 被拒（内核 open-time deny，TOCTOU）；grep `~/.ssh` 被拒；bash `cat ~/.ssh` 被拒；bash 正常工作区成功；
- [B/none] read/grep/bash `~/.ssh` 照读（none 透传，不被 A 污染）；
- [C 并发] A(sandbox) 拒、B(none) 透传、双方工作区均 OK（per-session 不串）。

**默认 `none` 全程保留**；真实用户现有 worker 的 mode 未动。

---

## 4. worker preset 三个新组是否被真实 superagent 自动引用 —— **已确认：是**
关键接线事实（本轮实证，非猜测）：
- worker preset 定义在**本仓 bundle patch** `backend/cordis.patch.yml`（`id: dsh-superagent-worker-preset`，`plugins:` 内 `shell`/`fs`/`file-search` 三个组）。该 bundle 由 `~/.dsh/profiles/superagent/package.json` 的 `dsh.profile.bundles` 加载（`dsh-superagent: link:…/backend`）。
- `dsh --profile superagent --dump-config` **组合后**在 `id: dsh-superagent-worker` 下确实出现：
  - `shell` 组 `isolate: {shell:true, sandbox:true}` → 内含 `worker-sandbox`;
  - `fs` 组 `isolate: {fs:true, sandbox:true}` → 内含 `worker-fs-sandbox` + `worker-fs` + `tool-fs`;
  - `file-search` 组 `isolate: {subprocess:true}` → 内含 `worker-search-subprocess` + `tool-fs-search`。
- 结论：**bundle patch 的 preset 被 base 的 patch 层自动组合**，无需把相同 worker 组 hunk 合入 user profile patch；也没有覆盖其余配置或全局翻 sandbox。默认 `none` 只由 `sessions.ts` 在 `isolation==='sandbox'` 时对**该 worker 会话**翻 workspace-write，本项未翻。

---

## 5. superagent 内部消息 MCP 真实接线（不重启主进程）
### 5.1 注册 hunk（只 superagent，不 desktop）
技术前提全部验证：
- `dsh --profile superagent --dump-config` 当前**无** `dsh-mcp-client`（global `~/.dsh/cordis.patch.yml` 有 `mcp-figma` 说明 schema 可用）。
- 用 `--patch /tmp/mcp_messages_overlay.yml` 组合一个 `@deepseek-ai/dsh-mcp-client serverName:messages stdio` 行 → dump 干净包含该行（`rc=0`，无报错），**证明可以注册进 superagent**。
- `env` 仅 `MESSAGES_MCP_DB=/Users/cpuser/.dsh/state/superagent/mobileq.db`（已核对真库存在）+ `MESSAGES_MCP_CLI=<abs>/backend/tools/mobileq`（绝对引用）。不双重拼 stateDir。
- 图真实接线注意：live 主进程跑的是 **npm CLI dsh@0.2.1-rc.2**（`~/.nvm/…/bin/dsh`），不是 App 的 0.2.2 —— 对端插件一律用 CLI 自带 0.2.1 版（App 的 0.2.2 插件会因版本不兼容被 disable）。这条是真实踩坑，见 §7。

### 5.2 live 验证：四个工具在真实 host 上下文可见（真 agent）
在隔离 `DSH_HOME` 里起一个**真实** superagent 变体（bundles: base+headless+superagent），DB 指向真库只读用于列工具：
- 子进程确起：`…/messages-mcp/server.ts`（child of dsh host）；
- 真 agent（WorkBuddy 模型）被问「列出所有 mcp__ 开头的工具」，**live 返回**：
  `mcp__messages__get_message / list_channels / list_messages / send_message` —— 四件齐全。
- 这是「真实 worker 上下文可见」的证据，不是「childprocess 活 29s 当完成」。

### 5.3 读放行 / 写审批 / 拒后零写（真 Runtime，ticket-bound）
`guardConnection`（runtime.ts:861）是 ticket-bound worker 的唯一写闸：`mcp__*` 非 WORK_TOOLS → `guardConnection`；内部 `judgeCall` 读 `allow`、写 `ask` 生成审批签名，批准后**只消费一次同参数调用**，改参数重问。
- 直接对 `judgeCall(connections[server=messages])`：
  `list_messages→allow`、`send_message→ask`、未列名工具→deny。
- 真 Runtime + 真 Store + 真 ticket 上的 gate 单测（`runtime.spec.ts > live MCP connection gate`，4 条）**verbose 复跑全绿**：读 allow；写 held 且 attention 不含 secret；批准后同参数**执行一次**、再调又 ask；改参数重问；改配置吊销。
- live headless agent 读路径实测：真 agent 调 `mcp__messages__list_messages`+`list_channels`，返回真数据（main/work/team、3 条），**零写入**（canary `replies` 不变）。

---

## 6. 记忆 #24 等旧功能与隔离 E2E 复核
- 隔离 E2E：§3 20/20（本轮刚 build 的 lib）。
- 记忆旧功能未回归：全量 2167 含 `crew-memory-author / hub-auth / lifecycle / retraction` 等 untracked 新测，全绿。
- #21/#23 按用户新口径（只处理 desktop/mobile 内部消息、不接外部账号）验真；外部 Graph 保持**未启用**（`runGraphWatch` 未配凭据→`paused`、零外部请求），FCM/语音/系统推送继续停。

---

## 7. ⚠️ 过程中的真实事故与我做过的事（诚实披露，必须留档）
**事件**：在隔离 `DSH_HOME` 里起 live headless agent 测「写是否被 held」时，我误用**一个非 ticket-bound 的顶层 headless 会话**调 `mcp__messages__send_message`。`workOnly`/`guardConnection` 只绑定在**执行器 worker 会话**（有 ticket）上；顶层 headless 会话没有 ticket，故 guard 未介入，适配器把一条 `CANARY-RELEASE-PROBE-A` 写进了 **真实 `mobileq.db`**（`id=54, rkey=canary-release-A, to_msg='ain'(agent 误填 to=main), bot_id=None`）。

**我立刻做的处置**：
1. 精确 `DELETE FROM replies WHERE id=54 AND rkey='canary-release-A' AND text='CANARY-RELEASE-PROBE-A' AND to_msg='ain'` → 删 1 行；`replies` 回到 **49**、`max id` 回到 **52**、`PRAGMA integrity_check = ok`、`%CANARY-RELEASE%` 命中 **0**。
2. 复核对 `%CANARY%` 全表命中 **4** 行，全部是**此前既有的合法**行（id 33/34/51/52，`bot_id='lead'`，时间 17:42/21:30 早于本会话），**无一条**是我 probe 写入（`canary-release-A / CANARY-RELEASE-PROBE / ADAPTER-DIRECT / DIRECT-TEST` 命中均 0）。
3. 适配器本身无 bug：用 `MESSAGES_MCP_DB=<canary>` 直接跑 wrapper `send_message` 只写 canary，真库不动 —— 证明确实是**我的测试会用错了会话层**，而非适配器/DB 路径错。

**根因与教训（写入本报告，作为机制而非约定）**：
- 「写必须过审批」这条保证的生效前提是**在 ticket-bound 执行器 worker 里**发生；顶层/无 ticket 会话不享有这条 guard，这是既有设计（worker-only fence）。任何 live 写验收**必须**在执行器 worker（有 ticket）里做，或用单元 harness 的 ticket-bound 路径。
- 真机 live 验收默认应指向**隔离 DB 副本**；本次误连真库的原因是 headless 会话的 MCP 子进程读的是 host 注入的 `MESSAGES_MCP_DB`（当时 host 已指真库列工具用）。后续 live 写验收必须显式把 host 的 `MESSAGES_MCP_DB` 指到 canary 副本，并**写后立即核对两个 DB 的计数**再下结论。
- 已如实记录，不伪称「测试全程未碰真库」。

---

## 8. 生产进程与网络约束（全程遵守）
- 主 dsh `89697/89699` lstart=`Sat Nov 14 14:26:39 2026`、mobilegw `67367` lstart=`Sat Nov 14 18:31:04 2026` —— **全程未变**（收尾复核同值）。
- 未运行 `backend/scripts/dsh-superagent start/restart/ensure_gateway`；未 `pkill/killall/launchctl`；未改主配对/Hub 个人 memory；未 git add/commit/push/stash/checkout/restore/reset。
- 未开真实 SIM/新云服务；未读/输出用户消息正文或 secret（本报告只列计数与受控 canary 标识）。
- 未改 `/Applications` 运行 bundle；未还原用户 host 全局 danger-full patch。
- 唯一“触碰真库”的偏差已在 §7 完整披露并复原。

---

## 9. Android（debug 已过；release 变体待本轮验证）
- 前置：Android 417 debug 已过（前序成员）。本轮作为唯一 ADB 窗口所有者，release 变体单测 + 签名安装与 hash 见下（若执行则记录于本文件附录）。
- 约束：不卸载清数据；`adb install -r` 保留主配对/firstInstallTime/权限/地址；正式最终 APK 落 `docs/review/final-android/deliver/dsh-botcrew-internal-final-<时刻>.apk`；新旧两 APK 均保留，不覆盖原 `dsh-botcrew-final-2056.apk`。

---

## 10. 给 lead 的决策点（非阻断）
1. **是否现在落 superagent MCP 注册 hunk** + panel `connections`（readOnly:true，读写两列显式）+ touch 触发 HMR（不重启主进程）。技术前提已全绿（§5）。
2. **live 写验收是否在真机执行器 worker 里做**（需先配一个来源产生 ticket；或接受 §5.3 的 ticket-bound 单测 + live 读为充分证据）。若做，必须指 canary DB 副本并写后双库核对（§7 教训）。
3. Android release 变体是否本轮执行安装（占用唯一 ADB 窗口）。

## 11. 真实 source SHA256（本轮快照；非 HEAD b2f305e）
```
5f6c4852…3a23e79  src/app/push.ts
dbc06c18…ecd41bc8  src/app/runtime.ts
6a4a2fc1…109cb45139 src/kv.ts
c70c9cabd1…7ad0d8ba5 src/app/mobile-http.ts
ed0484ea…09b70d719 src/app/sessions.ts
d6e37d2d…64c6b52b6536 src/app/connections.ts
e44149b5…2198a269cd src/integrations/messages-mcp/server.ts   (= review freeze)
5a3a62d0…c45df67ea src/integrations/messages-mcp/messages-mcp  (= review freeze)
d2752dbd…f83defbb1 tools/mobileq                                (= review freeze)
66c5257e…95736b649 tests/notices-persistence.spec.ts
cac72250…76ebe2b78f tests/integrations/messages-mcp.spec.ts     (= review freeze)
bf04caea…80856ec3 cordis.patch.yml（含三 worker 组）
bea4d6cc…a1153901 package.json（exports 补 4 项，helper 改 .mjs）
```
untracked cohort（本轮计入 2167，非 HEAD）：`src/integrations/**`、`src/app/{graph,graph-watch,memory/{auth,author,hub-retraction}}.ts`、`src/executor/{sandbox,worker-fs,worker-fs-helper.mjs,worker-search-subprocess}.ts`、对应 `tests/**`、`tests/worker-runtime/**`。

---

## 附录 A：Android 两变体 + 安装（本轮执行）

环境要点：系统默认 `java` = **JDK 25**，会让 Kotlin/Gradle 报 `IllegalArgumentException: 25`（JavaVersion.parse 不支持 25）。改用 **JDK 21**（`/opt/homebrew/Cellar/openjdk@21/…`），`JAVA_HOME` 指向它后正常。

### A.1 单测（debug + release 两变体）
```
./gradlew testDebugUnitTest testReleaseUnitTest   → BUILD SUCCESSFUL
debug:   49 test files / 417 tests / 0 fail / 0 err / 0 skip
release: 49 test files / 417 tests / 0 fail / 0 err / 0 skip
```
与前序 417 debug 参考一致；release 变体同样 417 全绿。

### A.2 构建 + 签名
```
./gradlew assembleDebug assembleRelease           → BUILD SUCCESSFUL
debug:   app-debug.apk            sha256 0c9391c6…520bf9
release: app-release-unsigned.apk sha256 26cfcb3f…37e1aea
```
release 无项目签名配置 → 用**与设备现有安装同一把 debug key**（`CN=Android Debug`, SHA-1 `2D:DF:…:95:55`，与设备 `29b26ea2` 证书一致）签名：
```
app-release-signed.apk  sha256 ff3b4624a0db93f65bee2fe344910971cf97757b287b4f0b92e603eaaef40952
```
（说明：本仓历史「final」APK `dsh-botcrew-final-2056.apk` 也是 debug key 签名，故 release 变体沿用 debug key 才能 `install -r` 保留数据。）

### A.3 安装（保配对）
`adb install -r app-release-signed.apk` → Success。
- `firstInstallTime=2026-11-11 22:27:11` **未变**（install -r 不清数据）；`lastUpdateTime` 更新为 23:34:08。
- 设备 `base.apk` 拉回 sha256 = **ff3b4624…f40952** = 我签的 release APK（内容一致）。
- 权限保留（INTERNET/ACCESS_NETWORK_STATE/CHANGE_WIFI_MULTICAST_STATE/NEARBY_WIFI_DEVICES granted=true）。
- 启动后 UI（截图）：顶部「现在走：隧道已连接」，会话 main/work，我的队伍（大哥/写手/码农）——**配对与功能保持**。
- 说明：release 变体 `debuggable=false`，故 `run-as` 不可用（无法直接 cat shared_prefs）；配对保留由 `firstInstallTime` 不变 + 同证书 + `install -r` 语义 + 运行态 UI 证明，不以读 prefs 为准。

### A.4 交付物
- 落盘：`docs/review/final-android/deliver/dsh-botcrew-internal-final-20261114-233456.apk`（sha256 `ff3b4624…f40952`，= 设备 base.apk）。
- 历史 `dsh-botcrew-final-2056.apk` **保留未覆盖**。两件并存。

---

## 附录 B：生产 HMR 部署（不重启主进程）与真实端到端边界

**授权前提满足**：源码 freeze、无阻断、生产 load=0（overview executor running 0 / queued 0）。

**部署动作（可回滚）**：
1. 备份 profile（0600）：`~/.dsh/profiles/superagent/cordis.patch.yml.bak-release9-20261114-233712`，sha `10937633…1d153b`。
2. `touch backend/lib/index.js`（bump mtime，绕过「纯注释不触发模块重导入」的坑——见 memory-config-lifecycle 已实证要点）。
3. profile patch 末尾 append 本成员 release 注释。
4. 观察 recompose（**PID 不变**）：restore log 5s 内出现 `[memory] hub 鉴权就绪` + bonjour 重注册噪声 + `[memory] hub reached`，约 30s 后稳定不再刷。**未重启**。
5. 部署后 overview：`problems: []`, executor 0/0；三进程 lstart 全不变（89697/89699=14:26:39、67367=18:31:04）。
- 回滚：删 append 注释 + 从 `.bak-release9-*` 复原 profile 即回退（HMR 再 recompose，不重启）。
- 部署后 profile sha：`6a422b8c…c2d8f6b`。

**部署后源码是否真在跑**：deployed `lib/index.js` 含新符号（`api/mobile/notices`/`pendingNotices`/`principalOf`/`markNoticeSeen` 均 PRESENT）。recompose 已把链接包重新导入（bonjour 重注册是重载证据，PID 不变）。

**真实端到端「生产通知→手机 UI/持久/ACK」的边界（如实）**：
- 我向生产 outbox 的 `notice-pending:<phone>` 注入受控 canary notice，让手机前台轮询 `/api/mobile/notices`→落盘→`reportSeen`。**结果：手机未 ACK（pending 一直 PRESENT）。**
- 根因（设备侧 logcat 实证）：`CrewTailcat: tc_conn_read 失败（status=2）：use of closed network connection` —— **P2P(tailcat) 隧道连接反复被关闭**，`client.notices()` 抛异常被静默 catch，轮询这一支根本没跑通。这是**既有网络/P2P 不稳定**，不是 notices 代码缺陷。
- 另：我先前一次 `adb backup` 残留的系统备份确认弹窗（`com.android.backupconfirm`）一度占前台，压住了 app 轮询；已 BACK 关掉并 refocus app。
- 结论：**手机通知「真实消费 + ACK」在本次窗口内因 P2P 隧道不稳未取得**。已验证的是：手机装的是新 APK、pairing 保留、UI 在线；apps 侧 poll→merge(commit)→reportSeen 代码路径存在且有 12 单测 + 226 相关测试覆盖；服务端 notices route 已在部署 lib 中。**真正的手机消费 ACK 仍待 P2P 稳定窗口复测**（不伪称已通过）。
- 全程所有注入的 canary notice 已从生产 `orchestrator.sqlite` 的 kv（`notice-*`）**清除干净**（无残留）；`mobileq.db` 侧 49 replies / max 52 / 0 canary / integrity ok（§7 的唯一一次误写也已复原）。

## 附录 C：给 lead 的最终待办
1. **手机通知消费+ACK** 的最终确认，需一次 P2P(tailcat) 隧道稳定窗口（当前 `tc_conn_read closed` 反复）。到那时：注入受控 notice → 观察 `notice-pending` 变 GONE 且 `notice-seen` 出现该 id → 截图手机「有事记得看一下」。可作为 #23 收口最后一跳。
2. **MCP 注册 hunk** 仍未落 profile（本轮只在隔离探针验证可注册 + live agent 可见四工具 + guard 单测）。若要真机 worker 获批写，需落 hunk（superagent）+ panel connections，然后一次执行器 worker 内 live 写验收（必须指 canary DB 副本，写后双库核对，§7 教训）。
3. `~/.dsh/cordis.patch.yml` 顶层已有一处对 mcp-client schema 的用法（figma），注册 messages 用同 schema，叠加即可。
