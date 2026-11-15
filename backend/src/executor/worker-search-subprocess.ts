/**
 * worker 文件搜索（`glob` / `grep`）的子进程读面隔离（#22 补口 / task-5，glob/grep 缺口）。
 *
 * 为什么需要它：`@deepseek-ai/dsh-tool-fs-search` 的 `glob` / `grep` 不是走 `ctx.fs`，而是
 * `ctx.subprocess.spawn()` 跑打包的 ripgrep（源码原文 "The spawn is unconfined (a plain
 * ctx.subprocess call)"，注入 `subprocess` 不注入 `fs`/`sandbox`）。所以 `WorkerFileSystem`
 * 管不到它——模型传一个敏感 root（`~/.ssh`）给 `grep`，ripgrep 就照读。本模块补这个缺口。
 *
 * 做法：worker preset 里给 file-search 单独一个 isolate 了 `subprocess` 的组，挂本 adapter 作为
 * 该组的 `ctx.subprocess`。它把 ripgrep 的 spawn **在同 shell/fs 用的同一份 seatbelt profile
 * 内**跑（`sandboxArgv(writableRoots, sensitivePaths(home))` 包一层 `sandbox-exec`），于是 rg 的
 * open 命中内核拒绝。**不包整个 shell subprocess、不嵌套 sandbox-exec**：shell 组与 file-search
 * 组是两个兄弟 scope，各自 isolate 自己的服务，互不嵌套（sandbox-exec 不能自我嵌套）。
 *
 * **默认 none 透传**：与 `WorkerFileSystem` 同一套判定——用 `ctx.get('agents').currentInitiator()`
 * 拿发起本次搜索的会话 mode（AsyncLocalStorage 跨异步继承），none 会话直接委托内层 subprocess
 * 不包沙箱；无 session 上下文时按目标 cwd 表兜底，仍定位不到且部署有 confining worker 则
 * fail-closed（拒绝在未隔离下跑搜索）。
 *
 * @module dsh-superagent/worker-search-subprocess
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { sandboxArgv, sandboxAvailable, sensitivePaths } from '../infra/environment.ts'

/** `ctx.sandboxPolicy` 的最小消费面。 */
interface SandboxPolicyLike { resolve(request?: { session?: unknown }): { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string } }

/** `ctx.subprocess.spawn` 的最小结构面（本 adapter 只转发 spawn）。 */
type SpawnSpec = {
  argv: readonly string[]
  cwd: string
  stdio: unknown
  graceMs: number
  signal?: AbortSignal | undefined
  env?: NodeJS.ProcessEnv | undefined
}
interface SubprocessInner {
  spawn(spec: SpawnSpec): unknown
}

export interface Config { readonly sensitiveHome?: string }

/** Worker 会话 `ctx.subprocess` 的 adapter：把 glob/grep 的 ripgrep spawn 包进同份 seatbelt profile（#22）。 */
export class WorkerSearchSubprocess extends Service {
  private readonly inner: SubprocessInner
  private readonly sensitiveHome: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'subprocess')
    const inner = ctx.root.get('subprocess') as SubprocessInner | undefined
    if (!inner) throw new Error('worker-search-subprocess: no inner ctx.subprocess to delegate to')
    this.inner = inner
    this.sensitiveHome = config.sensitiveHome ?? homedir()
  }

  /**
   * 转发一次 spawn。confining 会话下把 ripgrep 的 argv 包进 seatbelt（同 profile）；否则原样转发。
   * @param spec - 借用方（`spawnRipgrep`）给的原始 spawn 规格。
   * @returns 内层 subprocess 的 handle（原样透出）。
   */
  spawn(spec: SpawnSpec): unknown {
    const mode = this.effectiveMode(spec.cwd)
    if (mode === 'danger-full-access') return this.inner.spawn(spec)
    if (!sandboxAvailable()) {
      throw new Error('worker-search-subprocess: sandbox mode is active but no sandbox backend is usable on this host; '
        + 'refusing to run the search unconfined (glob/grep 只在 macOS 上隔离).')
    }
    // 写白名单 = 搜索工作目录（rg 只读、不写；给 cwd 让 profile 有合理 writable 根，读仍走 deny）。
    const writable = [spec.cwd]
    const wrapped = [...sandboxArgv(writable, this.sensitiveList()), ...spec.argv]
    return this.inner.spawn({ ...spec, argv: wrapped })
  }

  /**
   * 发起本次搜索的会话 mode：**只用 per-session**。缺会话上下文 ⇒ fail-closed（不凭 cwd 猜权限）。
   * @param _cwd - 仅供错误消息/未来扩展；判定不使用它（cwd 不是会话身份）。
   */
  private effectiveMode(_cwd: string): 'read-only' | 'workspace-write' | 'danger-full-access' {
    const session = this.currentSession()
    if (session === undefined) {
      throw new Error('worker-search-subprocess: no session context for this search (missing agent initiator); '
        + 'refusing to run ripgrep without a session (fail-closed)')
    }
    const policy = this.ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined
    if (!policy) throw new Error('worker-search-subprocess: no sandboxPolicy service to resolve search mode (fail-closed)')
    return policy.resolve({ session: session }).mode
  }

  /** 取发起本次搜索的 session（AsyncLocalStorage initiator）。 */
  private currentSession(): unknown {
    try {
      const agents = this.ctx.get('agents') as { currentInitiator?(): { session?: unknown } | undefined } | undefined
      return agents?.currentInitiator?.()?.session
    } catch {
      return undefined
    }
  }

  /** 敏感读 deny 名单（与 fs/helper 同一份 `sensitivePaths()`）。 */
  private sensitiveList(): string[] {
    return sensitivePaths(this.sensitiveHome)
  }
}

export const inject = [] as const
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(WorkerSearchSubprocess as never, config as never)
}
export default WorkerSearchSubprocess
