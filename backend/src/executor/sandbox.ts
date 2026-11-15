/**
 * 覆盖 worker 会话自由命令的隔离 provider（#22）。
 *
 * 为什么需要它：DSH 自带的 `dsh-sandbox-local`（darwin = seatbelt）的 profile 只做
 * `(deny file-write*)` + 放行工作区写，**读是 `(allow default)` 全放行**。于是把 worker 的
 * permission preset 从 `danger-full-access` 翻到 `workspace-write` 也只限写、挡不住
 * `cat ~/.ssh/id_ed25519`——正是 ADR 0004 gap 3 描述的、本轮 canary 复现的静默假隔离。
 * `sandbox-exec` 不能嵌套，所以没法在 DSH profile 外再套一层；只能在 provider 这一层给出
 * 带 `deny file-read*` 的 profile。
 *
 * 本模块提供 `ctx.sandbox` 的 backend 版实现：confine() 返回本仓 `sandboxArgv()` 造的 profile
 * （写白名单 + 凭据读 deny），复用 prepare 阶段已在用的同一套策略，不新造一份。
 *
 * 只在 worker preset 的 shell 组里通过 `isolate: { sandbox: true }` 挂载，router / 主会话与本仓
 * 自己的 `runAsWorker`（走 `subprocess.spawn`，不经过 ctx.sandbox）都不受影响。非 macOS 上
 * 没有 `sandbox-exec`，confine() 抛错 fail closed —— 不静默放行（拒绝以未隔离冒充已隔离）。
 *
 * 这里不 import `@deepseek-ai/dsh-sandbox`：它不是本仓声明的依赖（backend 只装 permission-presets
 * / agent / session 等 peer）。provider 在运行期只被 `dsh-bash-sandbox` 以 `ctx.sandbox.confine(argv,
 * policy, signal)` duck-type 调用，用结构类型描述契约即可；`Service` 基类来自已声明的 `@deepseek-ai/cordis`。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { sandboxArgv, sandboxAvailable, sensitivePaths } from '../infra/environment.ts'

/** confining 模式（provider 只在非 danger-full-access 时被调用，故不含它）。 */
export type ConfinedMode = 'read-only' | 'workspace-write'
/** 本次执行的 file-effect 策略：`dsh-sandbox` 里 `SandboxPolicy` 的消费面。 */
export interface SandboxPolicy {
  mode: ConfinedMode
  workspaceRoot: string
  additionalWritableRoots?: readonly string[]
  sessionId?: string
}
/** `dsh-sandbox` 里 `ConfinedArgv` 的消费面：包好的 argv + enforcement + 拒绝方言 + runner 失败规则。 */
export interface ConfinedArgv {
  argv: string[]
  enforcement: 'full' | 'partial'
  denialSignatures: readonly string[]
  runnerFailureRules: readonly { fatalSignatures: readonly string[]; allowedExitCodes?: readonly number[]; informationalLines?: readonly string[] }[]
}

/** config：只有测试用的敏感 HOME 覆盖，无其它可调项。 */
export interface Config { readonly sensitiveHome?: string }

/** Worker 会话 `ctx.sandbox` 的 backend：`confine()` 造写白名单 + 凭据读 deny 的 seatbelt profile（#22）。 */
export class WorkerSandboxProvider extends Service {
  private readonly sensitiveHome: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sandbox')
    // 敏感路径按「载体类别枚举」的名单来自 environment.ts 的 sensitivePaths()，与 prepare 阶段同一份；
    // 可注入 HOME 只为测试能在临时 HOME 造 canary，不碰操作者真实凭据。
    this.sensitiveHome = config.sensitiveHome ?? homedir()
  }

  /**
   * 把 argv 包进本仓 profile 的 `sandbox-exec`。
   *
   * 写白名单 = 这次执行的工作区（`policy.workspaceRoot`）+ 显式附加目录；读 deny = `sensitivePaths()`。
   * 策略的 mode 已由调用方（bash-sandbox）保证是 confining 模式：`danger-full-access` 在 bash-sandbox
   * 里根本不进 confine()。非 macOS 抛错 fail closed（没有 `sandbox-exec` 就没有任何隔离）。
   * @param argv 调用方本要 spawn 的 argv（`['bash','-c',command]`）。
   * @param policy 本次执行的 file-effect 策略。
   * @returns 包好的 argv + enforcement（seatbelt 按构造 full）+ 拒绝方言 + runner 失败规则。
   */
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    if (!sandboxAvailable()) {
      throw new Error(`sandbox mode "${policy.mode}" is requested but no sandbox backend is usable on this host; `
        + 'refusing to run the command unconfined (isolation=sandbox 只在 macOS 上可用).')
    }
    const writable = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])]
    return {
      argv: [...sandboxArgv(writable, sensitivePaths(this.sensitiveHome)), ...argv],
      // seatbelt 按构造对承诺的 file effect 全约束。
      enforcement: 'full',
      denialSignatures: ['operation not permitted'],
      // 与 dsh-sandbox-local 的 seatbelt runner 失败方言一致。
      runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: '] }],
    }
  }
}

export const inject = [] as const
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(WorkerSandboxProvider as never, config as never)
}
export default WorkerSandboxProvider
