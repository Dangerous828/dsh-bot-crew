# task-11 —— 真实 worker 内部消息接线与审批验收（wb2-internal-live）

日期：2026-11-15（Asia/Shanghai，跨零点）· 角色：`wb2-internal-live`（子委派 task-11）· 范围：只本人 desktop/mobile 内部消息，不接外部平台/账号。

---

## 一句话结论（三态分离，别混为同一条生产链）

1. **prod registered/read（已完成、实证）**：superagent 用户 profile HMR 热注册 `@deepseek-ai/dsh-mcp-client`（serverName=messages，DB=**真实** `~/.dsh/state/superagent/mobileq.db`），生产宿主（PID 89699，**未重启**）真拉起了 `messages-mcp/server.ts` 子进程（PID 99678）；connections 已 `readOnly:true`、读写两列显式（读 3= list_channels/list_messages/get_message，写 1= send_message）。**只读 smoke**：4 个 `mcp__messages__*` 工具在真实 adapter 上下文可见，`list_channels/list_messages` 对真库读成功（main/work/team），**零写入**（prod replies 49 不变）。
2. **隔离 ticket-approved write（已完成、分两层证据，勿混）**：
   - **(2a) 真执行器会话端到端**（`tests/integrations/internal-messages-live-worker.spec.ts`）：**真 DSH Context**（App bundle 真实 dsh-agent-loop/dsh-tools/dsh-mcp-client 服务类）+ 真 ScriptedAdapter 驱动真 AgentLoop turn；真 dsh-mcp-client 以 **stdio 拉起真 messages-mcp/server.ts**（store=隔离 canary，4 个 mcp__messages__* 工具真注册）；真 tools.guard 委托**真 Runtime.guardConnection**（真 ticket）。断言：未批准→guard 拦、工具**不派发**、canary **零写**、pendingApproval(waiting)+attention；经**公开批准入口** runtime.receive(feishu 做吧)（=approvalReply）→approved→重跑 turn→**真 tools.execute→真 mcp-client→真 stdio adapter**→canary replies **+1** 且落库正文==真回话；同参数再调→授权已消费→拒、+0；经**公开拒绝入口** feishu(先别做)（→stopTicket）→零写。诚实边界：Runtime 侧用真 ticket 承载审批状态机；批准后**重新 agent.followup** 触发 worker 重跑（等价执行器批准后向同一 worker 重新交付）——批准入口/guard 判定/MCP 真执行都是真模块，仅“执行器重新投递”这一跳用 followup 模拟（本 spec 不启完整 superagent 的 DshExecutor）。
   - **(2b) 组件集成**（`tests/integrations/internal-messages-live-acceptance.spec.ts`，**准确定位见文件头**）：真 Runtime+真 store.tickets 直接调 private guardConnection 判定、直接改 pendingApproval.status 模拟批准效果、直接 exec mobileq CLI 落 canary。**它只证明 gate 状态机 + adapter 写路径正确，不是真 worker/真 MCP 派发**。
   - 两者均由 `backend/scripts/verify-internal-messages.sh` 全自动驱动并**双库前后只读计数**核对生产不变。**没有**在主库上做获批写，也未虚称。
3. **客户端 show（未在本轮证明）**：手机/桌面真正显示由手机 transport 成员（wb2-transport-fix 独占手机窗口）另行证明。本轮不偷换 JSON 存储、不自证客户端显示。

**关键教训落实**：live 写验收**必在 ticket-bound 执行器 worker 内、且指隔离 DB**（记忆 `dsh-live-write-test-must-be-ticket-bound`）。本轮所有审批证据都是隔离实例里的；生产只做了 registration + read-only smoke。顶层 headless 无 ticket 不吃 guard，**本轮未再用**该路径写任何库。

---

## 一、根治的两个输入/会话归属缺口（用户点名的 bug）

### 1.1 `send_message to=main` 被截成 `ain` 且落库的问题

- **根因**：`backend/src/integrations/messages-mcp/server.ts` 之前 `const to = requireString(args,'to').replace(/^m/, '')` —— 任何以 `m` 开头的字符串都被削掉首字母。`to='main'`（会话名，不是消息 id）→ `'ain'` 落 `replies.to_msg`；`mobileq reply` 的 `reply_target` 又 `try:int(value) except: return value`（盲收任意串），于是脏值入库、服务端回 `ok:true`。旧测试只用 `to:'1'`/`'m${id}'`，**从没喂过 `main`**，故漏检。
- **修复（server.ts）**：新增 `messageRef()`，只接受 `m<N>` 或纯数字 `N`（N 为正整数、无前导零），**只**剥 `m` 前缀且其后必须纯数字；`r<N>`/`main`/`work`/负数/0/前导零/非数字 → 参数错误（isError，零写）。schema 加 `pattern: '^m?[1-9][0-9]*$'` 与准确 description。
- **修复（mobileq `cmd_reply`/`reply_target`）**：形状校验 + **父消息必须存在于本 conversation**（`SELECT id,withdrawn_at FROM messages WHERE id=? AND conversation=?`）：
  - 非法/foreign/不存在 → `ValueError` → 退出码 2，零写；
  - 目标是已撤回消息 → `GoneTarget` → 退出码 **410**（保留 `sendTeam` 既有 `code===410 → 'gone'` 语义，不误判成 round 失败）。
  - 恢复了被删掉的「父消息归属」保障，并把「to 是入站消息 id」变成**机制**（schema pattern + 运行时 + CLI 三层同口径）。

### 1.2 会话面纪律不变
- 只写 `replies`，**不写 `messages`**（不产 Trigger、无 worker 自循环）—— spec 继续钉住（写后 `messages` 只多 seed 的真实父消息，不是写路径产生的）。
- `rkey` SHA-256 内容派生 / 显式 `replayed` 标记 / 精确 `get`-by-id（`m\d+`/`r\d+`，会话过滤，不受 500 窗口影响）/ limit 上限 500 / 正文 64KB 传输上限 —— 全部**保持不变**（回归覆盖）。

---

## 二、机械验收脚本 `backend/scripts/verify-internal-messages.sh`（ALL GREEN）

逐步（每步都有可核断言，任一失败非 0 退出）：

1. **造独占临时 canary DB**（不是生产副本）：`mktemp -d` 下新建 `canary-mobileq.db`，`mobileq inject` 一条真实入站父消息。
2. **解析最终 resolved MCP env**：用真实 `dsh --profile superagent --dump-config --patch <overlay>`（overlay 的 mcp-messages `env.MESSAGES_MCP_DB` 指 canary）解析出**宿主会注入给子进程的最终 `MESSAGES_MCP_DB` 值** → `realpath` 断言 == canary realpath；再 `stat` 比对 **canary dev:inode ≠ 生产库 dev:inode**（证明独立文件、非生产副本）。本轮实测：prod `16777231:205078136` vs canary `16777231:216250028`。
3. **生产库前后只读快照**（只读打开）：`replies/messages/maxreply`。
4. **跑 ticket-bound 真审批 spec**（见 §三），并让批准写直接落**本脚本这份 canary**（`MESSAGES_ACCEPT_DB` 传入）；机械核 canary `replies` **净 +1**、`messages` 只多 seed 父消息 +1。
5. **生产库后置只读快照**：`replies/messages/maxreply` 三者**一字不变**（本轮 49/68/52 → 49/68/52）。

> 脚本全程只读打开生产库；不重启、不写生产、不写运行 App bundle、不读/打印任何凭据值。

---

## 三、ticket-bound 真审批 spec `tests/integrations/internal-messages-live-acceptance.spec.ts`

真 `Runtime`（隔离 stateDir）+ 真 `store.tickets`（真 ticket，非顶层 headless）+ 真 `runtime.guardConnection`（写闸只绑执行器 worker 会话）。adapter 真 stdio 子进程，store=隔离 canary。断言（对应任务口径）：

- 读 `mcp__messages__list_messages` → `guardConnection` 返回 `undefined`（放行），不产生 `pendingApproval`；
- 写 `mcp__messages__send_message` **未批准** → 返回「等你点头」+ `ticket.pendingApproval={kind:'connection',status:'waiting',signature}` + `attention` 产生；**DB 零新增**（未批准绝不调 adapter）；
- 人工**批准同一次**（同 signature，`status:'approved'`）→ 再次过闸放行 → **真调用** adapter → `replies` **+1**；
- 同参数**再调** → 授权一次性已消费 → **重问**，+0；
- **改参数**（换正文）→ 即便刚批准也签名变 → 重问，+0；
- **拒绝**（保持 waiting）→ 永不放行，+0。

---

## 四、stage0：真实生产 CLI 版本兼容（不升级/不重启）

| 事实 | 实测 |
|---|---|
| 生产主 CLI 实际版本 | **dsh@0.2.1-rc.2**（`~/.nvm/.../lib/node_modules/@deepseek-ai/dsh`，PID 89699 用的就是它） |
| /Applications App SDK | 0.2.2-rc.2（**不**拿来给 CLI 用；App 的插件会因版本不兼容被 disable） |
| `@deepseek-ai/dsh-mcp-client` 在真实 CLI 树里 | **PRESENT**（`.../dsh/node_modules/@deepseek-ai/dsh-mcp-client`） |
| `AgentRegistry.currentInitiator()` | 在 `dsh-agent/lib/types/index.js:83` 存在 |
| `filePlugins`（profile 插件加载） | 在 `dsh-app-boot/lib` 存在 |
| backend peerDependencies | `@deepseek-ai/dsh-* : ^0.2.1-alpha.2` → 与 0.2.1-rc.2 **兼容** |

结论：**真实 CLI 0.2.1-rc.2 支持本接线所需能力，不需升级生产 CLI、不需重启、未用 App SDK 的插件**去替代旧生产 ABI。

### 4.1 深度兼容核（不是只靠 App 0.2.2 E2E 断言）

- **CLI 0.2.1 现场探针**（直接 import CLI 0.2.1 树的包）：`dsh-tools` 导出内建 `TOOL_RUNTIME_SCHEDULER`（真工具派发内建于 dsh-tools，0.2.1 **无**独立 `dsh-tool-executor-native` 包也不需要）；`dsh-agent` 用 `AsyncLocalStorage` 且暴露 `currentInitiator()`；`tools.guard()`/`tools.restrict()` 在场；`currentInitiator()` 在 initiator 边界外返回 `undefined` 不抛。→ **全 PASS**。
- **真 worker e2e 双引擎**：`internal-messages-live-worker.spec.ts` 用 `DSH_NODE_MODULES` 指 **CLI 0.2.1** 树（`bash`/`shell-env`/`attachment-local`/`subprocess-local`/`session-persistence-jsonl` 均在；仅 `dsh-tool-executor-native` 缺→自动跳过并依赖 dsh-tools 内建 scheduler）**同样 1 passed**；默认指 App 0.2.2 也 1 passed。→ 证明「真 AgentLoop + 真 dsh-mcp-client stdio + 真 tools.guard + 公开批准」在**生产实际版本 0.2.1** 上成立，非「假 App 0.2.2 E2E」。
- backend peerDependencies `^0.2.1-alpha.2` 与 0.2.1-rc.2 兼容；`filePlugins`/`readProfilePlugins`/`reconcileProfilePlugins` 在 0.2.1 `dsh-app-boot` 存在（profile 插件加载）。

---

## 五、注册（HMR，不重启主进程）

- 备份：`~/.dsh/profiles/superagent/cordis.patch.yml.bak-msgmcp-20261115-000432`（**0600**），pre-reg sha `6a422b8c…2d8f6b`。
- 追加 hunk：`- insert: - id: mcp-messages  @deepseek-ai/dsh-mcp-client, serverName: messages, transport: stdio, command=<messages-mcp 入口>, env.MESSAGES_MCP_DB=真实库, env.MESSAGES_MCP_CLI=<mobileq>`；`--dump-config` 组合干净包含该条。post-reg sha `694d14fe…c6619`。
- `touch backend/lib/index.js` 触发 recompose（HMR），**PID 89699 lstart 不变**（Sat Nov 14 14:26:39），`GET overview problems: []`、executor 0/0。
- connections：`PUT settings/connections`（`{value:{readOnly:true, connections:[messages 读3写1]}, revision:0}`）→ `saved:true, revision:1`；已有 connections 读后合并（原为空），未覆盖其它设置块。
- 生效实证：`pgrep -P 89699` 出现真子进程 `99678 …/integrations/messages-mcp/server.ts`（生产宿主真的拉起了 MCP 子进程，非隔离 child 冒充）。
- **回滚**：删该 insert 段 + 从 `.bak-msgmcp-*` 复原 profile；connection 用 PUT 回 `{connections:[],readOnly:true}, revision:1`；HMR 再 recompose，不重启。

---

## 六、质量门（backend 唯一 owner，本轮独占一次）

```
cd backend
node_modules/.bin/tsc -p tsconfig.json --noEmit   → TSC_EXIT=0（0 错）
node_modules/.bin/vitest run                       → 127 files / 2171 passed / 0 failed
```

- 相比 release § 的 2167：本轮 +4 = messages-mcp.spec 加「to 输入契约」用例 + 新增 `internal-messages-live-acceptance.spec.ts`（组件集成 2 例）+ 新增 `internal-messages-live-worker.spec.ts`（真执行器会话端到端 1 例）。
- 处理了 `tests/crew-morning.spec.ts` 的**日期翻转 flake**（lead 授权 target scope）：该测试 `countRoutine()` 用真实 `new Date()` 记「当天」，硬编码 `day:'2026-11-14'`，跨零点到 11-15 即红。修法：`vi.useFakeTimers({toFake:['Date']})` + `vi.setSystemTime(at(14,9))`（2026-11-14 09:00 +08:00）钉住，`finally: vi.useRealTimers()`；**不** fake setInterval/setTimeout（不接管 startRuntime 异步计时器），**不**把 day 改成今天（否则明天再坏），**不**削「跨重建真实派发计数」断言，**不改**业务 `runRoutines` 语义。

---

## 七、真实源码 SHA256（本任务改动，供对照）

```
backend/src/integrations/messages-mcp/server.ts   （messageRef + schema pattern + send_message 调用点）
backend/tools/mobileq                              （reply_target 形状+父消息归属校验；GoneTarget→410）
backend/tests/integrations/messages-mcp.spec.ts    （真实 parent fixture + to 输入契约新增用例）
backend/tests/integrations/internal-messages-e2e.spec.ts（真实 parent fixture：lastMessageId）
backend/tests/integrations/internal-messages-live-acceptance.spec.ts（新增，组件集成：gate 计数状态机+adapter 写路径）
backend/tests/integrations/internal-messages-live-worker.spec.ts（新增，真 AgentLoop+dsh-mcp-client stdio+tools.guard+公开批准/拒绝端到端）
backend/tests/crew-morning.spec.ts                 （fake Date 钉 2026-11-14，修日期翻转 flake）
backend/scripts/verify-internal-messages.sh        （新增，机械验收）
backend/docs/007-architecture.md                   （登记新 spec）
```

运行时 SHA 以实际 `shasum -a256` 为准（见交付命令回执）。

---

## 八、边界与未做（如实）

- **未**在主库做任何获批写；生产只做了 registration + read-only smoke；prod `mobileq.db` 全程 replies 49 / max 52 / messages 68 / 0 canary / integrity ok。
- **未**重启生产 dsh/mobilegw、**未** pkill/killall/launchctl、**未** git add/commit/push/stash/checkout/restore/reset、**未**改运行 App bundle、**未**还原宿主全局 danger-full patch、**未**读凭据值（figma token 等不打印）。
- **未**操作手机（手机窗口归 wb2-transport-fix，本轮未抢）。
- 客户端真正显示（手机/桌面 UI 出现该回话）**未在本轮证明**，需 transport 成员在隧道稳定窗口做；不与「隔离获批写」混为一谈。
- HMR recompose 后若面板需人工点按确认 MCP 工具出现在某具体 worker 会话里，属运行态观察，本报告以「生产宿主真拉起子进程 + 只读 smoke 四工具可见/真库读成功」为 registered/read 的证据。
