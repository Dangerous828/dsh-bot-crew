# #22 worker 执行隔离：provider seam 实现与覆盖边界

日期：2026-11-14 · 负责人：wb2-worker（task-3）

> 本文只记录**本轮真正落地并经独立实例证明的**东西，以及**明确仍未覆盖**的东西。
> 一句话结论：**worker 的自由 bash 子进程现在可以真隔离（写白名单 + 凭据读 deny），
> 但 worker 的 read/write/patch 文件工具读面仍未覆盖 —— 不得称「worker 已完整隔离」。**

## 0. 一句话定位

- 覆盖：worker 会话里 agent 用 **bash 工具**跑的命令（`ctx.shell` → `SandboxBashExecutor`）。
- 未覆盖：worker 的 **read / write / patch 文件工具**（`ctx.fs` = `fs-sandbox`）。它只围栏**写**，读一律放行（见 §4）。
- 默认：`executor.isolation = 'none'`，**不静默翻**任何 worker。

## 1. 为什么必须换机制（不是改字段）

读 DSH 源码 + 真 canary 已证（详见 §3 证据）：

- worker 会话在 `backend/src/app/sessions.ts` 被 `permissionPresets.set(session,'danger-full-access')`；
- 这个 preset 写 `sandbox/mode=danger-full-access` 事件；`SandboxBashExecutor.execute()` 见到
  `danger-full-access` **直接 return，不 confine**（`@deepseek-ai/dsh-bash-sandbox`）。所以 worker bash 裸跑。
- 即便把字段翻成 `workspace-write`，DSH 自带 darwin 的 seatbelt profile 是
  `(allow default)(deny file-write*)(allow file-write* <writableRoots>)` —— **只限写，读全放行**。
  真 canary：该 profile 下 `wc -c < <临时HOME>/.ssh/id_ed25519` 读得到。这正是 ADR 0004 gap 3
  说的「静默假隔离」，与用户的担心一致：**同 OS 用户 + workspace-write 字段 ≠ 读隔离**。
- `sandbox-exec` 不能嵌套（`sandbox_apply: Operation not permitted`），无法在 DSH profile 外套一层。
- 但 `(deny file-read* (subpath <realpath>))` 在 `(allow default)` 下**确实生效**（canary：DENIED），
  前提是 realpath（`/tmp`→`/private/tmp`，本仓 `environment.ts: realSubpath()` 已解决同一问题）。

⇒ 唯一正确的、限读的缝在 **provider 层**：给 worker 的 shell 组换一个会 `deny file-read*` 的
`ctx.sandbox` 实现。DSH 的 `SandboxBashExecutor.inject=['subprocess','sandbox','sandboxPolicy']`，
真正执行时把每条命令交给 `ctx.sandbox.confine(argv,policy)`；换掉 `ctx.sandbox` 就换了 profile。

## 2. 实现（本仓）

### 2.1 新模块 `backend/src/executor/sandbox.ts` — `WorkerSandboxProvider`

- `extends Service(ctx,'sandbox')`（`@deepseek-ai/cordis`，已声明 peer；不变量 import 未声明的
  `@deepseek-ai/dsh-sandbox`，只用结构类型描述 `confine` 契约）。
- `confine(argv, policy)`：macOS 上用本仓 `sandboxArgv(writableRoots, sensitivePaths(home))` 造 profile，
  即 **写白名单 + 凭据读 deny**，复用 prepare 阶段同一份策略（`src/infra/environment.ts`）。
  `enforcement:'full'`、`denialSignatures:['operation not permitted']`、runner 失败规则与
  `dsh-sandbox-local` 的 seatbelt 方言一致。非 macOS 抛错 **fail closed**（不静默放行）。
- `sensitiveHome` 可注入，只为测试用临时 HOME 造 canary。

### 2.2 接线 `backend/cordis.patch.yml` — 只动 worker preset 的 shell 组

```yaml
- id: shell
  name: cordis:group
  group: true
  isolate:
    shell: true
    sandbox: true            # 只有这个组把 `sandbox` 隔离成自己的一份
  config:
    - id: worker-sandbox      # 挂 backend 的 WorkerSandboxProvider
      name: dsh-superagent/worker-sandbox
    - id: bash-sandbox
      name: '@deepseek-ai/dsh-bash-sandbox'
      ...
```

router / 主会话的 shell 组**不挂**、仍用全局 `sandbox`（DSH 自带）。同组内 `bash-sandbox` 的
`inject:['sandbox']` 因此解析到 `WorkerSandboxProvider`。

### 2.3 注册与构建（自身模块的必要 register）

- `backend/package.json` `exports` 增 `"./worker-sandbox": "./lib/worker-sandbox.js"`。
- `backend/tsdown.config.ts` 主 entry 增 `'worker-sandbox': 'src/executor/sandbox.ts'`。

### 2.4 启用开关 `backend/src/app/sessions.ts`

```ts
ctx.permissionPresets.set(result.agent.session,
  role === 'worker' && settings.executor.isolation === 'sandbox' ? 'workspace-write' : 'danger-full-access')
```

- **显式 opt-in**：只有 `executor.isolation==='sandbox'` 且是 worker，才翻到 confining 的
  `workspace-write`（这是让 `bash-sandbox` 真调 `confine()` 的前提）。默认 `none` 保持原样，
  不静默翻任何 worker；主会话（router）不受影响。
- 两处必须一起启用：只有 provider 挂上、才限读；只翻 mode 不挂 provider，worker 只剩 DSH 自带的
  「只限写」seatbelt，**反而更危险**（读得到凭据、写却被限，误以为隔离了）。所以开关与接线成对。

## 3. 证据（独立临时 DSH 实例，真 resolver + 真执行）

不启动整个 crew backend，只搭最小 Cordis 应用（`/tmp` 独立实例；脚本见 `tests` 同源思路）：

1. root 挂一个 `DefaultSandbox`（tag=default）、`SessionProjectionRegistry`、`SandboxPolicyService`、
   `SubprocessLocal`；
2. `group = ctx.isolate('sandbox')`，在 group 内 `plugin(WorkerSandboxProvider)` + `plugin(SandboxBashExecutor)`；
3. 断言：`group.get('sandbox') instanceof WorkerSandboxProvider === true`、`root.get('sandbox')` 仍是 default、
   `group.get('shell') instanceof SandboxBashExecutor === true`；
4. 经 **group 的 shell**（即 worker 用的那条 `ctx.shell`）在 `workspace-write` 下真跑命令。

实测输出（真 `sandbox-exec`，canary 全在临时 HOME，假 token）：

| 用例 | 结果 | result.sandbox |
|---|---|---|
| 读工作区 `note.txt` | PASS（code 0） | mode=workspace-write, denied=false, enforcement=full |
| 写工作区 `out.txt` | PASS（code 0） | 同上 |
| 读 `<HOME>/.ssh/id_ed25519` | PASS（**被拒**，无 CANARY 输出） | denied=true |
| 读 `<HOME>/.config/gh-hosts.yml` | PASS（**被拒**） | denied=true |
| 越界写 `<outside>/evil.txt` | PASS（**被拒**） | denied=true |

结论：**resolver 真的把 worker 自由 bash 导进了新 provider**，不是「直接调用自制 sandbox-exec」。
读写越界都按预期被内核挡下，`denial` 事实由 `bash-sandbox` 正常上报（`denied:true`）。

回归：`backend/tests/worker-isolation.spec.ts`（4 条，真 `sandbox-exec` + 临时 HOME）钉住
「读工作区/写工作区/凭据读被拒/越界写被拒」；撤掉 read-deny 后凭据读用例精确变红（已验证）。

## 4. 覆盖边界（必须如实读）

| 面 | 状态 | 依据 |
|---|---|---|
| worker **bash 工具**跑的每条命令 | **已覆盖**（写白名单 + 凭据读 deny，内核 Seatbelt） | `WorkerSandboxProvider` 挂进 worker shell 组，§3 实测 |
| worker **read 文件工具**（读取 `~/.ssh` 等） | **未覆盖**：读一律放行 | `fs-sandbox`：`Readds pass through untouched: every mode permits reading`；它 `inject:['sandboxPolicy']`，**不经过** `ctx.sandbox`，且只围栏 write/edit/patch/delete/move |
| worker **write/patch 文件工具** | 部分覆盖：按 `sandboxPolicy` 在**进程内**containment 围栏写（非内核边界） | 同上，`checkedTarget` 只查 mutation |
| 网络出站 | **不按目标过滤**（Seatbelt 只能按 socket 方向） | ADR 0004「网络」节 |
| environment（env 变量） | 不含凭据：`agentVariables`/`prepareVariables` 已剥 token、指向 worker 自有 gh/git 配置 | `src/infra/environment.ts` |

**所以：** worker 的 read 工具仍能读到 `~/.ssh/id_ed25519`（因为它走 `ctx.fs` 的读路径，没有 read fence）。
本轮**不能**称「worker 已完整隔离」，只能称「worker 的自由 bash 子进程已隔离」。

## 5. 后续可核条目（不在本轮范围）

1. **【上游 / 跨仓】`fs-sandbox` 读面**：要让 worker 的 read 工具也读不到凭据，需要
   `@deepseek-ai/dsh-fs-sandbox` 给 read 加 per-call deny（消费 `sensitivePaths()` 一类的 deny 列表），
   或有一个「read 也走 `ctx.sandbox`」的 fs backend。接口建议：`SandboxExecutionPolicy` 增
   `readableDeny?: readonly string[]`，`SandboxedFileSystem.readText/readDir/stat` 落 `checkedTarget` 式 deny。
   最小 patch 方案可在独立源码副本验证，不写 `/Applications` 运行 bundle。
2. **【上游】seatbelt profile 一等公民**：给 `dsh-sandbox-local` 的 `seatbeltProfileArgs` 原生支持 read-deny，
   backend 就不用自带 provider。这是「根治」，provider 是「外包一层」的当前可行解。
3. **【本仓】启用验证**：默认仍是 `none`；要翻 `sandbox` 需真机一条活 + 三端测试 + doctor.sh
   （与 ADR 0004「为什么不翻默认」一致）。本轮**未翻默认**。
4. **【本仓】baseline**：`workspace-write` preset 带 `approval:ask`，只在「越界后想升级」时触发审批；
   正常执行不 ask。若真机发现 worker 被审批卡住，改用一个 approval=never 的专用 confining preset（本仓可做）。

## 6. 未触碰的边界

- 未改 `/Applications` 运行 bundle；未改 `dsh-base` 全局 patch（用户此前把全局默认从
  `workspace-write` 放宽到 `danger-full-access` 的改动**原样保留**）；未重启 dsh / mobilegw。
- 未改 `runtime` / `KV` / `index.ts` / `mobile-http` / `push`（wb2-receive 独占）。
- 未改共享 `runtime/policy/KV`（#23 接收）。
