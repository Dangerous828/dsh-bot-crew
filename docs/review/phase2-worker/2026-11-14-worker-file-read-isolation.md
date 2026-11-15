# #22 补口：worker **文件工具读面**隔离（task-5）

日期：2026-11-14 · 负责人：wb2-worker-files（task-5，承接 task-3）

> 一句话结论：**worker 的 `read` / `read_image`（走 `ctx.fs`）与 `glob` / `grep`（走 `ctx.subprocess` 打包 ripgrep）
> 现在都能被内核级 seatbelt 挡在读面（写白名单 + 凭据读 deny）之内，且只按真实 per-session 上下文判权限；
> 默认 `none` 透传。仍有一个明确的、非本仓可控的验证缺口：完整 DSH 宿主里真 agent 驱动 → 真 `read` 工具的
> 端到端 dispatch（见 §5），本轮用真实服务边界 + 真实 fs-sandbox resolver + 真实 sandbox-exec 分层钉死各项，
> 端到端那一步留给宿主受控真机验收。**不称「worker 全工具已约束」——`read_image` 之外的附件/网络等另算。**

## 0. 定位（相对 task-3）

- task-3（`2026-11-14-worker-isolation-provider.md`）已实证：worker 的**自由 bash**（`ctx.shell` → `SandboxBashExecutor`）
  经 `WorkerSandboxProvider` 真隔离；并明确**读面未覆盖**：`ctx.fs` = `dsh-fs-sandbox` 只 fence 五个 mutation，读一律放行；
  `glob`/`grep` 走 `ctx.subprocess` 不经 `ctx.fs`。
- 本文补的就是这两个真实缺口，不再重复写同一份 concluder。

## 1. 实际文件模块接口（逐入口核证，读 DSH 安装源码，只读不改）

worker preset 的 fs 工具都在 **preset 根**（不在 shell 组），消费**全局** `ctx.fs` / `ctx.subprocess`：

| 工具 | 包 | 读路径 |
|---|---|---|
| `read` | `@deepseek-ai/dsh-tool-fs` | `ctx.fs.resolve → stat → readText/streamText` |
| `read_image` | 同上 | `ctx.fs.resolve → stat → readBytes` |
| `glob` / `grep` | `@deepseek-ai/dsh-tool-fs-search` | `ctx.subprocess.spawn`（打包 `@vscode/ripgrep`，注入 `subprocess`，**不注入 fs/sandbox**） |

无独立 `readDir` / `stat` / `ls` 工具；目录/元数据只经 `glob` 间接暴露。

`dsh-fs-sandbox`（`SandboxedFileSystem extends LocalFileSystem`）只 override `writeText/editText/patchText/deleteFile/moveFile`
做 per-call policy fence；抽象读方法（`resolve/stat/lstat/readText/streamText/readBytes/readByteRange/listDir`）**原样继承**，
且**不接收 `sandboxPolicy`**，tool 层也不给读解析 policy（只有 mutation 经 `FsSandboxController`）。源码原文：
"Reads pass through untouched: every mode permits reading." ⇒ worker read 工具照读 `~/.ssh`。

**关键可行性发现**：读路径虽然拿不到 `session` 参数，但 `ctx.get('agents').currentInitiator()` 走 **AsyncLocalStorage**，
能跨异步边界取到「发起这次读的 Agent」。DSH 的驱动在 `dsh-agent-loop/src/agent.ts:256`：
`this.loopCtx.agents.withInitiator(this, () => this.kick())` —— **整个 agent turn（LLM 流 → 工具 dispatch → ctx.fs 读）
都在 initiator 边界内**。于是读方法拿得到 `agent.session`，`ctx.sandboxPolicy.resolve({session}).mode` 给出**该会话自己**的 mode。
这条是本方案能「真 per-session」而不靠路径猜的根。

## 2. 实现（本仓，均在 `src/executor/`）

### 2.1 `worker-fs.ts` — `WorkerFileSystem`（`ctx.fs` 装饰器）

- `extends Service(ctx,'fs')`，构造时从 `ctx.root.get('fs')` 抓内层全局 fs（`SandboxedFileSystem`）做委托目标。
- **只覆盖读方法**：`stat/lstat/readText/streamText/readBytes/readByteRange/listDir`。confining 会话下把真实观察
  放进固定 helper 子进程执行；否则（显式 none）`super`/委托内层，行为与今天一致。写/patch/delete/move 原样委托内层
  （保留其 per-call policy fence）。
- **权限判定只按真实 per-session**：`effectiveMode()` = `currentInitiator().session` → `sandboxPolicy.resolve({session}).mode`。
  **拿不到会话 ⇒ fail-closed 抛 `FS_SANDBOX_DENIED`（明确「缺会话上下文」）**，绝不凭 cwd 猜（cwd 不是会话身份，
  同 cwd 两个 worker 不同 mode 会串权）。这只影响 worker-fs 自己的读面；root / router 走全局 fs-sandbox，不受影响。
- 隔离子进程用的 profile 由 `ctx.sandbox.confine([node, helper], policy)` 造；该 `ctx.sandbox` 在 worker preset 的
  **fs 组内 isolate 并挂的是同一 `WorkerSandboxProvider`**（写白名单 + `sensitivePaths()` 读 deny），与 shell 组同一份策略。

### 2.2 `worker-fs-helper.mjs` — 固定 helper（纯 JS，tsdown `copy` 进 `lib/`）

- 按 **stdin 的 JSON** 对绝对路径做一次观察（readText/readBytes/readByteRange/stat/lstat/listDir）；**路径不进 argv、不拼 shell**
  （不进 ps/history，无注入面）。
- 内核拒绝（EPERM/EACCES）→ exit 3，**不输出任何文件内容**；不存在 → exit 4；其它 → exit 5（stderr 只回错误码）。
- 兼容源码期（`src/executor/` 直接跑）与构建期（`lib/`）：`helperPath()` 取同目录 `worker-fs-helper.mjs`。

### 2.3 `worker-search-subprocess.ts` — `WorkerSearchSubprocess`（`ctx.subprocess` adapter）

- `extends Service(ctx,'subprocess')`，构造抓内层 `ctx.root.get('subprocess')`。
- `spawn(spec)`：confining 会话下把 ripgrep 的 argv 包进 `sandboxArgv([cwd], sensitivePaths(home))` 再交给内层
  subprocess 跑（rg 打开敏感文件命中内核拒绝）；none 会话原样转发。**不包整个 shell subprocess、不嵌套 sandbox-exec**：
  shell 组 / fs 组 / file-search 组是三个兄弟 scope，各自 isolate 自己的服务。
- 同样只按 per-session 判 mode、缺会话 fail-closed、默认 none 透传。

### 2.4 接线 `cordis.patch.yml`（只动 worker preset，router 不受影响）

- worker preset 增一个 `fs` 组：`isolate: { fs: true, sandbox: true }`，挂 `worker-sandbox`(WorkerSandboxProvider)
  + `worker-fs`(WorkerFileSystem) + `tool-fs`。原根上的 `tool-fs` 移进此组。
- worker preset 增一个 `file-search` 组：`isolate: { subprocess: true }`，挂 `worker-search-subprocess` + `tool-fs-search`。
  原根上的 `tool-fs-search` 移进此组。
- `package.json` exports + `tsdown.config.ts` entries/copy 注册 `worker-fs` / `worker-search-subprocess` /（helper 走 copy）。

### 2.5 未改 `sessions.ts`（按 lead 裁定 (b)）

不新增 cwd→mode 登记。per-session 已由 `currentInitiator()` 真取到，无需登记兜底；缺会话一律 fail-closed。
task-3 的 `sessions.ts` 保持原样，未动其稳定字段。

## 3. 证据（真 `sandbox-exec` / 真 `fs-sandbox` resolver / 假 HOME canary）

> 同目录三个可复现脚本（在 `/tmp` 独立实例跑，symlink 到宿主 `dsh/node_modules`，加载本仓 `lib` 构建产物）：
> `proof-worker-fs-read.mjs`、`proof-worker-fs-per-session.mjs`、`proof-worker-search-confine.mjs`。
> 全 canary 在**临时 HOME**（假 token），不碰操作者真实凭据。

### 3.1 真 fs-sandbox resolver + 真 sandbox-exec（`proof-worker-fs-read.mjs`，ALL PASS）

挂真 `SandboxedFileSystem`（root `ctx.fs`）+ `SandboxPolicyService` + `SubprocessLocal` + 默认 `SandboxProvider`，
在 isolate `fs`+`sandbox` 组里挂真 `WorkerSandboxProvider` + 真 `WorkerFileSystem`，经 `group.get('fs')` 的
`readText/stat` 真读：

| 用例 | 结果 |
|---|---|
| root `ctx.fs` 仍是 `SandboxedFileSystem`（router 不受影响） | PASS |
| group `fs` = `WorkerFileSystem` / group `sandbox` = `WorkerSandboxProvider` | PASS |
| 未登记/显式 none：读工作区透传成功 | PASS |
| confining：读工作区 / stat 工作区成功 | PASS |
| confining：读 `~/.ssh/id_ed25519` **被内核拒** `FS_SANDBOX_DENIED` | PASS |
| confining：stat `~/.ssh/id_ed25519` **被拒** | PASS |
| **confining：工作区内 `evil-link → ~/.ssh/id_ed25519` 读该 symlink 被拒** | PASS |

symlink 那条是选**子进程 open-time deny** 而非宿主 realpath/containment 预检的决定性理由：路径在工作区内、宿主预检要么
fail-open 要么被 TOCTOU 换掉；把 open 放进 `sandbox-exec` 里由内核在 open-time 拒绝，换不掉。

### 3.2 真 per-session 两 worker 交替 + 并发（`proof-worker-fs-per-session.mjs`，ALL PASS）

用 `AsyncLocalStorage` 忠实模拟 `agents.currentInitiator()` 边界、真 `sandboxPolicy.resolve({session})` 给 mode：

- A(workspace-write) 读工作区 OK；读 `~/.ssh` 被拒；A 工作区 symlink→凭据 被拒；A stat `~/.ssh` 被拒。
- B(danger-full-access / none) 读 `~/.ssh` **照读（含 CANARY）**——不被 A 的 sandbox mode 污染。
- **并发 20×20 交错：A 20/20 被拒、B 20/20 读通，aDenied=20 bOk=20，不串模式。**

### 3.3 glob/grep 缺口（`proof-worker-search-confine.mjs`，ALL PASS，真 `@vscode/ripgrep`）

- sandbox 会话搜工作区 → 命中；
- sandbox 会话搜 `~/.ssh`（模型传敏感 root）→ **rg 被内核拒（exit 2），不泄 CANARY**；
- none 会话搜 `~/.ssh` → 照搜（含 CANARY，不隔离）。

### 3.4 仓库内回归（`backend/tests/worker-files.spec.ts`，7/7 绿；与 task-3 的 `worker-isolation.spec.ts` 5/5 同跑 12/12）

含：正/负对照、symlink TOCTOU、per-session 交替、per-session 并发 15×15、**缺会话上下文 fail-closed**。
**反向移除守卫**：把 `confines()` 分支退化成恒透传（或删 per-session 判定），「读 `~/.ssh` 被拒」用例精确变红。

## 4. 覆盖边界（如实，逐入口）

| 入口 | 状态 | 依据 |
|---|---|---|
| worker `read`（`ctx.fs` 读） | **已覆盖**（confining 会话内核拒敏感读；none 透传） | §2.1 + §3.1 |
| worker `read_image`（`ctx.fs.readBytes`） | **已覆盖**（同上，走 readBytes 隔离分支） | §2.1 |
| worker `glob` / `grep`（ripgrep） | **已覆盖**（同 profile 内跑 rg） | §2.3 + §3.3 |
| worker `write/edit/patch/delete/move` | 维持 task-3：进程内 policy fence（非内核边界） | 继承 `fs-sandbox` |
| 缺会话上下文的读 | **fail-closed 拒绝**（明确报错，不静默放行） | §2.1 |
| 默认 `none` | 透传，与今天一致；未翻任何默认 | §2.1 |

## 5. 明确的剩余验证缺口（不含糊）

**per-session 机制证据是「忠实模拟 initiator + 真服务边界 + 真 sandbox-exec」，不是完整 DSH 宿主里的真 agent 驱动端到端。**
已单独核证：真 `AgentRegistry`（不是测试自建 ALS）的 `withInitiator(fakeAgent, () => currentInitiator())` 返回同一 agent
（服务真实沿用其内部 `AsyncLocalStorage`）；代码证据 `agent.ts:256` 真驱动把整个 turn 包在该边界内。但要跑通
**真 agent → 真 `read` 工具 dispatch**，需要 DSH 的 preset/session 运行时（`createScope` + preset registry 决定工具的
scoped 注册与 `tools.execute` 的 scope 解析），这不是独立 harness 能廉价复刻的，属**宿主受控真机验收**项。建议：
在 root 统一全量 build/HMR 后，用本项目受控真实 worker（`isolation=sandbox` + 真 ticket）跑一条「worker 读 `~/.ssh` 被拒、
读自己工作区成功」的真机活，替换本节的模拟边界。**在此之前不称「端到端已证」。**

## 6. 未触碰的边界

- 未改 `/Applications` 运行 bundle；未改 `dsh-base` 全局 patch（用户 danger-full 全局默认原样保留）；未重启生产 dsh / mobilegw。
- 未改 `sessions.ts`（按 lead 裁定 (b)）；未改 receiver 独占的 `index/runtime/KV/mobile-http/push` / Android。
- 未翻默认 `none`；未 git add/commit/push；未抢焦点；未读真实个人凭据（canary 全假 token、临时 HOME）。
- 临时实例全在 `/tmp`，未在共享 `backend/tests` 写临时 repro；证据脚本落在本 review 目录可复现。
