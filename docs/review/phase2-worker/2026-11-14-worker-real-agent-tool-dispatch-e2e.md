# #22 worker 工具隔离 —— 真实 DSH Agent → 真工具 dispatch 端到端验收（task-6）

日期：2026-11-14 · 负责人：wb2-worker-e2e（task-6，独立验收 task-3/task-5）

> 一句话结论：**已把「真 DSH agent loop → 真 `tools.execute` → 局部 scope 里的 `WorkerFileSystem` /
> `WorkerSearchSubprocess` / `WorkerSandboxProvider`」跑通**，不是模拟 ALS。同一份 worker preset
> 局部接线（isolate `{fs,sandbox}` / `{shell,sandbox}` / `{subprocess}` 三兄弟 scope），root/router
> 保持默认 provider 作对照；真 session（`agents.create` 建的真 SID）经 `permissionPresets.set` 取 mode。
> read/read_image/glob/grep/bash 五个工具都由**真 agent 驱动、真 dispatcher 执行**，confining 会话读不到
> `~/.ssh`（含工作区 symlink TOCTOU）、none 会话照读、并发不串权。默认 `none` 未翻；未碰生产。

本报告补的是 task-3/task-5 报告 §5 明确留的**端到端缺口**：那两份是「真服务边界 + 真 sandbox-exec +
忠实模拟 initiator」，不是真 agent 驱动；本轮把它补成真 AgentLoop 的端到端。

---

## 1. 接线：与 worker preset 相同的局部 scope（不是全局替换）

`backend/cordis.patch.yml` 的 worker preset 里，三组工具各自 isolate 自己的服务：
`fs` 组 `isolate:{fs,sandbox}`、`shell` 组 `isolate:{shell,sandbox}`、`file-search` 组 `isolate:{subprocess}`，
三兄弟互不嵌套（sandbox-exec 不能自我嵌套）。E2E 用**同一结构**在真 agent 的 `agentCtx` 上 `ctx.isolate(...)`
建同样三组，把本仓构建的 `worker-*` 模块与对应 tool 插件挂进去——这正是 preset composition 的机制
（`CreateAgentOptions.setup` 收到 `agentCtx`，凡经 `agentCtx` 注册的 scoped 服务/工具都在首次 prompt 装配前存在）。

- root：`ctx.fs` = 默认 `SandboxedFileSystem`、`ctx.sandbox` = 默认 `LocalSandboxProvider`（**router/root none 对照，保原 provider**）。
- worker `fs` 组：`WorkerFileSystem`(fs) + `WorkerSandboxProvider`(sandbox) + `tool-fs`；inner 经 `ctx.root.get('fs')` 取默认 `SandboxedFileSystem`。
- worker `shell` 组：`WorkerSandboxProvider`(sandbox) + `SandboxBashExecutor`(shell) + `tool-bash`。
- worker `file-search` 组：`WorkerSearchSubprocess`(subprocess) + `tool-fs-search`；inner 经 `ctx.root.get('subprocess')` 取默认 `SubprocessLocal`。
- 真 agent：`agents.create({sessionId: <真SID>, meta:{cwd}, agentOptions:{provider:'wb2stub',model:'wb2stub-1'}, setup})`；
  再用 `ctx.get('permissionPresets').set(agent.session, 'workspace-write'|'danger-full-access')` 把**真 session** 翻到对应 mode。
  于是 `WorkerFileSystem.effectiveMode()` 里的 `agents.currentInitiator().session → sandboxPolicy.resolve({session}).mode`
  拿到的是**这个真会话自己的 mode**（真 SID，不是 cwd 猜、不是模拟 ALS）。

LLM 用**确定性 ScriptedAdapter**（自写 `LlmAdapter` 子类，`ctx.llm.registerAdapter(['wb2stub'], …)`），按工具结果数量
脚本化依次发 read/read_image/glob/grep/bash 的 tool_call —— 所以「真 agent loop、真 dispatcher」但调用序列可复现，不依赖外部模型。

## 2. 证据（真 agent / 真工具 / 真 sandbox-exec，canary 全在临时 HOME）

脚本：`backend/tests/worker-runtime/real-agent-tool-dispatch.e2e.mjs`（+ `run.sh`）。跑法：

```bash
cd backend && node_modules/.bin/tsdown          # 构建 lib（含 worker-fs-helper.mjs copy）
sh tests/worker-runtime/run.sh                   # DSH 真包取 app bundle，Worker* 取 backend/lib
```

本轮实测（`RESULT: ALL PASS`，20 条断言全绿）：

| # | 断言 | 结果 |
|---|---|---|
| 1 | root `ctx.fs` 仍是默认 `SandboxedFileSystem`（router/root 对照） | PASS |
| 2 | root `ctx.sandbox` 仍是默认 `LocalSandboxProvider` | PASS |
| 3 | worker fs 组 `ctx.fs` = `WorkerFileSystem`（局部接线，非全局替换） | PASS |
| 4 | worker fs 组 `ctx.sandbox` = `WorkerSandboxProvider` | PASS |
| 5 | 五个工具都对模型可见（read/read_image/glob/grep/bash） | PASS |
| 6 | **[A/workspace-write] read 工作区成功**（正对照：沙箱确实起来，不是全拒） | PASS |
| 7 | **[A] read `~/.ssh/id_ed25519` 被拒**（负对照：`FS_SANDBOX_DENIED`，无 CANARY） | PASS |
| 8 | **[A] read 工作区 `evil-link → ~/.ssh` 被拒**（内核 open-time deny，非宿主预检，TOCTOU 换不掉） | PASS |
| 9 | [A] read_image 未因沙箱被拒（唯一“失败”是 stub 模型不声明 image input，属模型能力边界，非隔离） | PASS |
| 10 | [A] glob 工作区命中 `note.txt` | PASS |
| 11 | [A] grep `~/.ssh` 被拒（不泄 CANARY） | PASS |
| 12 | [A] bash `cat ~/.ssh` 被拒（`Operation not permitted`，无 CANARY） | PASS |
| 13 | [A] bash 正常工作区命令成功（正对照） | PASS |
| 14 | **[B/none] read `~/.ssh` 照读**（none 透传，不被 A 的 mode 污染，含 CANARY） | PASS |
| 15 | [B/none] grep `~/.ssh` 照搜（含 CANARY，none 不隔离） | PASS |
| 16 | [B/none] bash `cat ~/.ssh` 照读（含 CANARY） | PASS |
| 17 | **[C 并发] A(sandbox) 读 `~/.ssh` 被拒** | PASS |
| 18 | [C 并发] B(none) 读 `~/.ssh` 照读 | PASS |
| 19 | [C 并发] A 读工作区 OK | PASS |
| 20 | [C 并发] B 读工作区 OK | PASS |

**反向移除守卫**（证明这条 E2E 真能捕获坏守卫，不是恒绿）：把 `lib/worker-fs.js` 的 `confines()` 改成恒 `false`
（退化成全部透传）后重跑，`[A] read ~/.ssh 被拒` 与 `[A] symlink TOCTOU 被拒` 精确变红（`RESULT: SOME FAILED`）；
恢复后回到 `ALL PASS`。

**同时用最终产物 `backend/lib`（含 copy 进去的 `worker-fs-helper.mjs`）复跑通过**——证明发布的是「构建后 lib」不是 `/tmp` 临时产物。

## 3. 本轮发现并根治的真实接线/构建缺陷

1. **`package.json` 的 `./worker-fs-helper` 导出指向 `.js`，但 copy 产物是 `.mjs`**（`./lib/worker-fs-helper.js` MISSING）。
   运行期 `helperPath()` 用的是 `join(here,'worker-fs-helper.mjs')`（本就对），但声明的 exports 是坏的、会误导。
   已改成 `./lib/worker-fs-helper.mjs`（现 EXISTS）。只改导出路径，不涉运行语义。
2. **`WorkerSandboxProvider` / `WorkerSearchSubprocess` 两个类缺类级 JSDoc**（class-docs 门红）。各补一行 `/** … */`，
   纯注释、不动语义；`class-docs.spec` 转绿。
   （第 2 条是为全量质量门收口；wb2-messages-review 已知，等我 GO 后独占跑全量。）

## 4. 覆盖与边界（如实，不夸大）

**已端到端覆盖（真 agent → 真 dispatcher）：**
- worker `read`（`ctx.fs` 读）：confining 会话内核拒敏感读、none 透传、per-session 不串——**端到端已证**。
- worker `read_image`（`ctx.fs.readBytes`）：走同一隔离分支；本轮受 stub 模型不声明 image input 限制，只证到「未因沙箱被拒」，
  真 image 解码到模型这一跳属模型能力，不在隔离覆盖面内。
- worker `glob` / `grep`（ripgrep，经 `WorkerSearchSubprocess` 在同份 profile 内跑）：confining 拒敏感 root、none 照搜——**端到端已证**。
- worker `bash`（`ctx.shell` → `SandboxBashExecutor` → `WorkerSandboxProvider.confine`）：confining 拒敏感读、none 照读——**端到端已证**。
- 缺会话上下文 fail-closed、默认 none 透传：源码行为 + 单元测试（`worker-files.spec.ts` / `worker-isolation.spec.ts` 13/13）覆盖。

**仍不覆盖 / 非本仓可控：**
- `read_image` 真正的「图片字节进模型」需 image-capable 模型；本轮 stub 不声明，只验到隔离层放行。换成真 WorkBuddy image 模型
  可补这一跳，但不属隔离证明必需。
- worker `write/edit/patch/delete/move`：仍按 task-3 结论走 `fs-sandbox` 的**进程内** per-call policy fence（非内核边界），本轮未改。
- 网络出站不按目标过滤（Seatbelt 仅按 socket 方向，ADR 0004）。Windows 无 sandbox-exec：`WorkerSandboxProvider.confine`
  与 `WorkerSearchSubprocess` fail-closed，`WorkerFileSystem` 亦在无 `ctx.sandbox` 时 fail-closed（跨平台不静默放行，源码已保证）。
- 本 E2E 用独立 Cordis 装配（真 DSH 服务类 + 真 preset 同级 scope），不是 Electron desktop host；能力上等价于 preset composition，
  但未点生产 `dsh --profile` 全量宿主（避免触碰生产实例）。**#22 生产侧显式 canary 是否必要由 lead 决定**。

## 5. 未触碰的边界

- 未改 `/Applications` 运行 bundle；未改 `dsh-base` 全局 patch（用户 danger-full 全局默认原样）；未重启生产 dsh(89699)/mobilegw(67367)/tailcat(80750)。
- 未翻默认 `none`；未在真实 `~/.ssh` 建 canary（canary 全在临时 HOME，假 token）；未读真实凭据内容/长度。
- 未 git add/commit/push；未跑全量（唯一 full gate owner 是 wb2-messages-review）；临时产物在 `/tmp`，跑完 `cleanup()` 自删。

## 6. 交付物 SHA256（供对照）

```
e1824226735d0f550cfc9a5ad8fc021237f238d928469abf149bfc582d858b26  src/executor/sandbox.ts
8b6e6570037275e2aa71523645c677de2a830fa02b1af06f3c282caf2f877fa4  src/executor/worker-fs.ts
35983e69dc0dc50222db7d24fe36f4b3b6ab90a7083ac01fcad93f76b5db20f1  src/executor/worker-search-subprocess.ts
57ef388988fa60563d7dcbb902390cb87c13f8dfab4cdb410037283cf3b7ecc2  src/executor/worker-fs-helper.mjs
ae99f2570e18a17ab0f772d19f598f2169999587f94ebd1a9e27f0b351f96cad  lib/worker-fs.js
d7a8eb8af533c2f0d89d9121c8ae69dfbe452a524ae8e1e8681de745b9886f89  lib/worker-sandbox.js
409fcef0c2ab553cc14b515a84cae69c61c371c879069daf3441f388c00fabea  lib/worker-search-subprocess.js
41c01b00b9854489197881facd05660f868f419f2b2f8564460ad780593d53e9  tests/worker-runtime/real-agent-tool-dispatch.e2e.mjs
```
