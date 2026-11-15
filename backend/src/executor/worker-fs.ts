/**
 * worker 专用文件工具读面隔离（#22 补口 / task-5）。
 *
 * 为什么需要它：task-3 把 worker 的**自由 bash** 子进程隔离好了（`WorkerSandboxProvider`
 * 给 shell 组换了一个会 `(deny file-read*)` 的 seatbelt profile）。但 worker 的**内置文件
 * 工具**（`read` / `read_image`）走的是全局 `ctx.fs` = DSH 自带的 `dsh-fs-sandbox`：它
 * `extends LocalFileSystem`，只 fence 五个 mutation（write/edit/patch/delete/move），
 * **读方法（resolve/stat/lstat/readText/streamText/readBytes/readByteRange/listDir）原样
 * 继承、读一律放行**（源码原文 "Reads pass through untouched: every mode permits reading."）。
 * 于是 worker 即便被翻成 `workspace-write`，`read ~/.ssh/id_ed25519` 仍读得到。
 *
 * 本模块提供 worker 专用 `ctx.fs` 装饰器：**只覆盖读方法**，把真正的文件系统观察放进一个
 * 已隔离子进程执行（固定 Node helper，JSON stdin/stdout，path 不拼 shell），由
 * `ctx.sandbox.confine()`（同 shell 组的 `WorkerSandboxProvider`）套上**同一份** seatbelt
 * profile（写白名单 + 凭据读 deny）。写/patch/delete/move 全部原样委托给内层 fs，保留
 * 既有 per-call policy fence。命内核拒绝即抛 `FS_SANDBOX_DENIED`。
 *
 * 为什么不在宿主做 realpath/containment 预检：那是「查完再读」两段，symlink 在中间被换掉
 * （TOCTOU）或 symlink 指向敏感文件时，预检要么 fail-open 要么被 race。实测（/tmp 独立
 * canary）：工作区内建 `evil-link -> ~/.ssh/id_ed25519`，宿主预检看到「在工作区内」放行，
 * 但把 open 放进 sandbox-exec 里执行则 **EPERM** —— 内核在 open-time 拒绝，换不掉。
 *
 * **默认 none 透传**：`ctx.sandboxPolicy.resolve()` 的有效 mode 是 `danger-full-access`
 * 时（默认档，worker 未被 `executor.isolation==='sandbox'` 翻），读方法直接 `super`/委托
 * 内层，与今天完全一致；只有 worker 翻成 confining mode 才走隔离子进程。复用 task-3 同一
 * opt-in，不新增开关。
 *
 * 覆盖边界（如实，不夸大）：本装饰器只管走 `ctx.fs` 读的入口（`read` / `read_image`）。
 * worker 的 `glob` / `grep` 走 `ctx.subprocess.spawn`（打包 ripgrep，注入 `subprocess` 不
 * 注入 `fs`），**不经过本装饰器**，本轮不覆盖（要堵需 subprocess 层 sandbox seam，属上游）。
 *
 * 结构类型不 import `@deepseek-ai/dsh-fs*` / `dsh-sandbox*`：它们不是本仓声明的依赖（与
 * `sandbox.ts` 同样的处理）。provider 在运行期只被本装饰器以 duck-type 调用；`Service`
 * 基类来自已声明的 `@deepseek-ai/cordis`。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** 有效 mode（与 `dsh-sandbox` 的 `SandboxMode` 消费面一致，含透传档）。 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
/** worker 文件读面用的有效 mode（同 SandboxMode）。 */
type WorkerFsMode = SandboxMode

/** `dsh-sandbox` 里 `SandboxExecutionPolicy` 的消费面：本装饰器只读 mode / workspaceRoot。 */
export interface FilePolicy {
  mode: SandboxMode
  workspaceRoot: string
  additionalWritableRoots?: readonly string[]
  sessionId?: string
}

/** `dsh-sandbox` 里 `ConfinedArgv` 的消费面（与 `WorkerSandboxProvider.confine` 返回一致）。 */
interface ConfinedArgv {
  argv: string[]
  enforcement: 'full' | 'partial'
  denialSignatures: readonly string[]
  runnerFailureRules: readonly { fatalSignatures: readonly string[] }[]
}

/** `ctx.sandbox` 的最小消费面：只要 `confine`（shell 组挂的是 `WorkerSandboxProvider`）。 */
interface SandboxLike {
  confine(argv: readonly string[], policy: FilePolicy, signal?: AbortSignal): Promise<ConfinedArgv>
}

/** `ctx.sandboxPolicy` 的最小消费面。 */
interface SandboxPolicyLike {
  resolve(request?: { session?: unknown; mode?: SandboxMode }): FilePolicy
}

/** 一个不透明 target（`FsTarget` 的结构面）。 */
interface FsTarget { targetKey: unknown; displayPath: string }
/** `stat` 结果（`FsInfo` 结构面）。 */
interface FsInfo { version: unknown; type: 'file' | 'directory' | 'other'; size?: number }
/** `lstat` 结果（`FsPathInfo` 结构面）。 */
interface FsPathInfo { version: unknown; type: 'file' | 'directory' | 'symlink' | 'other'; size?: number }
/** 目录项（`FsDirEntry` 结构面）。 */
interface FsDirEntry { name: string; type: 'file' | 'directory' | 'other'; target: FsTarget; version?: unknown; size?: number }

/** 内层 fs（全局 `SandboxedFileSystem`）的结构面：本装饰器要委托的全部方法。 */
interface InnerFs {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  processPath(target: FsTarget): string
  sandboxMode?: SandboxMode
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  writeText(target: FsTarget, ...rest: unknown[]): Promise<unknown>
  editText(target: FsTarget, ...rest: unknown[]): Promise<unknown>
  patchText(target: FsTarget, ...rest: unknown[]): Promise<unknown>
  deleteFile(target: FsTarget, ...rest: unknown[]): Promise<unknown>
  moveFile(source: FsTarget, destination: FsTarget, ...rest: unknown[]): Promise<unknown>
  watch(target: FsTarget, ...rest: unknown[]): Promise<unknown>
  fileUrl(target: FsTarget): string
  contains(parent: FsTarget, child: FsTarget): boolean
  processPathFromHostPath(hostPath: string): string | undefined
}

/** `ctx.subprocess` 的最小消费面（只用到 `spawn` + `collected`）。 */
interface SubprocessLike {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: { data: string }; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
    graceMs: number
    signal?: AbortSignal
    env?: NodeJS.ProcessEnv
  }): {
    done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
    collected?: {
      stdout?: { readFrom(fromByte: number): { text: string } }
      stderr?: { readFrom(fromByte: number): { text: string } }
    }
  }
}

/** `runHelper` 的结构化结果（判别联合，按 `kind` 收窄）。 */
type HelperResult =
  | { kind: 'text'; text: string }
  | { kind: 'base64'; base64: string }
  | { kind: 'stat'; type: 'file' | 'directory' | 'other'; size?: number; mtimeMs?: number }
  | { kind: 'lstat'; type: 'file' | 'directory' | 'symlink' | 'other'; size?: number; mtimeMs?: number }
  | { kind: 'list'; entries: { name: string; type: 'file' | 'directory' | 'other' }[] }
  | { kind: 'absent' }

/** config：只有测试用的敏感 HOME 覆盖与子进程超时，无其它可调项。 */
export interface Config {
  /** 敏感 HOME（测试造 canary 用）；默认操作者真实 HOME。 */
  readonly sensitiveHome?: string
  /** 单次 helper 子进程的 grace（毫秒）；默认 10s。 */
  readonly graceMs?: number
}

/** helper 的退出码：命中 kernel 拒绝（EPERM/EACCES）时用它区分「被拒」与「不存在/其它错」。 */
const DENIED_EXIT = 3
/** helper 的退出码：目标不存在（让上层复现 `undefined`/`FS_NOT_FOUND` 语义）。 */
const ABSENT_EXIT = 4

/**
 * worker 专用 fs 装饰器：读方法进隔离子进程，其余委托内层 fs。
 *
 * 注册为 `ctx.fs`（在 worker preset 的 isolate `fs` 组里，只影响该组，router/主会话全局
 * fs-sandbox 不动）。构造时从 `ctx.root.get('fs')` 抓内层 fs 做委托目标。
 */
export class WorkerFileSystem extends Service {
  private readonly inner: InnerFs
  private readonly sensitiveHome: string
  private readonly graceMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'fs')
    const inner = ctx.root.get('fs') as InnerFs | undefined
    if (!inner) throw new Error('worker-fs: no inner ctx.fs to delegate to (must mount below the global fs provider)')
    this.inner = inner
    // 敏感 HOME：默认真实 HOME；测试注入临时 HOME 造 canary。
    this.sensitiveHome = config.sensitiveHome ?? homedir()
    this.graceMs = config.graceMs ?? 10_000
  }

  // —— 纯路径操作：直接委托内层（不涉及敏感内容读取）——

  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return this.inner.resolve(path, opts)
  }

  processPath(target: FsTarget): string {
    return this.inner.processPath(target)
  }

  processPathFromHostPath(hostPath: string): string | undefined {
    return this.inner.processPathFromHostPath(hostPath)
  }

  fileUrl(target: FsTarget): string {
    return this.inner.fileUrl(target)
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    return this.inner.contains(parent, child)
  }

  // —— 写 / mutation：原样委托内层（保留既有 per-call policy fence）——

  writeText(target: FsTarget, ...rest: unknown[]): Promise<unknown> {
    return this.inner.writeText(target, ...rest)
  }

  editText(target: FsTarget, ...rest: unknown[]): Promise<unknown> {
    return this.inner.editText(target, ...rest)
  }

  patchText(target: FsTarget, ...rest: unknown[]): Promise<unknown> {
    return this.inner.patchText(target, ...rest)
  }

  deleteFile(target: FsTarget, ...rest: unknown[]): Promise<unknown> {
    return this.inner.deleteFile(target, ...rest)
  }

  moveFile(source: FsTarget, destination: FsTarget, ...rest: unknown[]): Promise<unknown> {
    return this.inner.moveFile(source, destination, ...rest)
  }

  watch(target: FsTarget, ...rest: unknown[]): Promise<unknown> {
    return this.inner.watch(target, ...rest)
  }

  // —— 读方法：confining mode 下走隔离子进程，否则透传内层 ——

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (!this.confines(target)) return this.inner.stat(target, signal)
    // confine 下整个观察都在隔离子进程完成，不再回内层 stat（避免在宿主上「补一下」重新暴露读面）。
    const r = await this.runHelper('stat', this.hostPath(target), signal)
    if (r.kind === 'absent') return undefined
    if (r.kind !== 'stat') throw new Error('worker-fs: unexpected helper result for stat')
    return { version: versionFrom(r.mtimeMs, r.size), type: r.type, ...r.size === undefined ? {} : { size: r.size } }
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const target = await this.inner.resolve(path, opts)
    if (!this.confines(target)) return this.inner.lstat(path, opts, signal)
    const r = await this.runHelper('lstat', this.hostPath(target), signal)
    if (r.kind === 'absent') return undefined
    if (r.kind !== 'lstat') throw new Error('worker-fs: unexpected helper result for lstat')
    return { version: versionFrom(r.mtimeMs, r.size), type: r.type, ...r.size === undefined ? {} : { size: r.size } }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    if (!this.confines(target)) return this.inner.readText(target, signal)
    const r = await this.runHelper('readText', this.hostPath(target), signal)
    if (r.kind === 'absent') throw deniedOrAbsent(target, 'not found', 'FS_NOT_FOUND')
    if (r.kind !== 'text') throw new Error('worker-fs: unexpected helper result for readText')
    return r.text
  }

  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (!this.confines(target)) return this.inner.streamText(target, signal)
    // 复用 readText 的隔离读，再包成单块 iterable（大文件本仓 worker 读工具会走 readText 分支；
    // 这里保证隔离语义一致，不引入流式 helper 复杂度）。
    const text = await this.readText(target, signal)
    return (async function* () { yield text })()
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (!this.confines(target)) return this.inner.readBytes(target, signal, maxBytes)
    const r = await this.runHelper('readBytes', this.hostPath(target), signal)
    if (r.kind === 'absent') throw deniedOrAbsent(target, 'not found', 'FS_NOT_FOUND')
    if (r.kind !== 'base64') throw new Error('worker-fs: unexpected helper result for readBytes')
    const bytes = Buffer.from(r.base64, 'base64')
    if (bytes.length > maxBytes) throw new Error(`cannot read "${target.displayPath}": image exceeds ${maxBytes} bytes`)
    return new Uint8Array(bytes)
  }

  async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    if (!this.confines(target)) return this.inner.readByteRange(target, range, signal)
    const r = await this.runHelper('readByteRange', this.hostPath(target), signal, range)
    if (r.kind === 'absent') throw deniedOrAbsent(target, 'not found', 'FS_NOT_FOUND')
    if (r.kind !== 'base64') throw new Error('worker-fs: unexpected helper result for readByteRange')
    return new Uint8Array(Buffer.from(r.base64, 'base64'))
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    if (!this.confines(target)) return this.inner.listDir(target, signal)
    const r = await this.runHelper('listDir', this.hostPath(target), signal)
    if (r.kind === 'absent') return []
    if (r.kind !== 'list') throw new Error('worker-fs: unexpected helper result for listDir')
    // helper 只取 name/type；target 由内层 resolve 补（路径解析不需要敏感读）。
    const out: FsDirEntry[] = []
    for (const entry of r.entries) {
      const childPath = join(this.hostPath(target), entry.name)
      const child = await this.inner.resolve(childPath)
      out.push({ name: entry.name, type: entry.type, target: child })
    }
    return out
  }

  // —— 内部 ——

  /**
   * 解析「这次读属于哪个 session 的有效 mode」——**只用真实 per-session 上下文**：
   * `ctx.get('agents').currentInitiator()` 走 `AsyncLocalStorage`，能跨异步边界拿到「发起这次
   * 读的 Agent」——read 工具在 agent 的驱动链里调用 `ctx.fs.readText`，initiator 边界继承下来，
   * 于是我们拿得到 `agent.session`，再用 `ctx.sandboxPolicy.resolve({session}).mode` 取**该会话
   * 自己**的 mode。两个 worker 一个 none 一个 sandbox 交替/并发，各读各的 mode，不串。
   *
   * **拿不到 session 不凭路径猜**（cwd 不是会话身份，同 cwd 两 worker 不同 mode 会串权）：
   * 直接 **fail-closed**，抛明确的「缺会话上下文」错误。这只影响 worker-fs 自己的读面——
   * root / router 走全局 fs-sandbox，不受影响。
   * @returns 该读归属会话的 mode。
   * @throws `FS_SANDBOX_DENIED`（缺会话上下文）——绝不在定位不到时放行。
   */
  private effectiveMode(target: FsTarget): WorkerFsMode {
    const session = this.currentSession()
    if (session === undefined) {
      throw deniedOrAbsent(target, 'no session context for this read (missing agent initiator); '
        + 'refusing to read through the worker file sandbox without a session (fail-closed)', 'FS_SANDBOX_DENIED')
    }
    const policy = this.ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined
    if (!policy) {
      throw deniedOrAbsent(target, 'no sandboxPolicy service available to resolve this read mode (fail-closed)', 'FS_SANDBOX_DENIED')
    }
    return policy.resolve({ session }).mode
  }

  /** 取发起本次读的 Agent 的 session（`AsyncLocalStorage` initiator）；不可用返回 undefined。 */
  private currentSession(): unknown {
    try {
      const agents = this.ctx.get('agents') as { currentInitiator?(): { session?: unknown } | undefined } | undefined
      return agents?.currentInitiator?.()?.session
    } catch {
      return undefined
    }
  }

  /**
   * 目标是否需要 confine：confining = read-only / workspace-write 的会话读要进隔离子进程；
   * danger-full-access（显式 none）会话按原策略透传内层。缺会话 ⇒ `effectiveMode` 抛 fail-closed。
   */
  private confines(target: FsTarget): boolean {
    const mode = this.effectiveMode(target)
    return mode === 'read-only' || mode === 'workspace-write'
  }

  /**
   * 从 target 拿宿主绝对路径（`processPath` = `String(targetKey)`）。
   */
  private hostPath(target: FsTarget): string {
    return this.inner.processPath(target)
  }

  /**
   * 一次 confine 用的策略：**只按会话**——mode 取该读归属会话的有效 mode，write 白名单根取该会话的
   * workspaceRoot（worker 自己的工作目录）。`confines()` 已保证此时会话存在（否则已 fail-closed）。
   * `WorkerSandboxProvider.confine` 不按 mode 分支、总按「写白名单 + 凭据读 deny」造 profile，mode 仅作语义标注。
   */
  private resolvePolicy(hostPath: string): FilePolicy {
    const session = this.currentSession()
    const policyService = this.ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined
    if (session === undefined || !policyService) {
      // confines() 已先跑过 effectiveMode()（同样条件会抛 fail-closed）；到这里属竞态兜底，仍 fail-closed。
      throw deniedOrAbsent({ displayPath: hostPath } as FsTarget, 'no session context to build the confine policy (fail-closed)', 'FS_SANDBOX_DENIED')
    }
    const resolved = policyService.resolve({ session })
    return { mode: resolved.mode === 'danger-full-access' ? 'workspace-write' : resolved.mode, workspaceRoot: resolved.workspaceRoot }
  }

  /**
   * 把一次文件系统观察放进隔离子进程执行：固定 Node helper + JSON stdin，path 不拼 shell，
   * 由 `ctx.sandbox.confine()`（同 shell 组的 WorkerSandboxProvider）套上 seatbelt profile
   * （写白名单 = workspaceRoot，读 deny = `sensitivePaths()`），子进程内 open 命中内核拒绝
   * 即 `DENIED_EXIT`，映射成 `FS_SANDBOX_DENIED`。
   */
  private async runHelper(
    op: 'stat' | 'lstat' | 'readText' | 'readBytes' | 'readByteRange' | 'listDir',
    hostPath: string,
    signal?: AbortSignal,
    range?: { offset: number; length: number },
  ): Promise<HelperResult> {
    const sandbox = this.ctx.get('sandbox') as SandboxLike | undefined
    if (!sandbox) throw new Error('worker-fs: ctx.sandbox is unavailable; refusing to read through an unconfined path')
    const policy = this.resolvePolicy(hostPath)
    const helper = helperPath()
    // 请求体（含目标绝对路径）走 stdin 的 JSON，绝不上 argv、绝不拼 shell——路径不进命令行，
    // 不会被 ps/history 看到，也无注入面。helper 只认 argv 里的固定 op 白名单之外的 stdin。
    const request = JSON.stringify({ op, path: hostPath, ...range ? { offset: range.offset, length: range.length } : {} })
    // 把 [node, helper] 交给 confine 包裹：得到的 argv = [sandbox-exec, -p, profile, node, helper]。
    const confined = await sandbox.confine([process.execPath, helper], policy, signal)
    const subprocess = this.ctx.get('subprocess') as SubprocessLike | undefined
    if (!subprocess) throw new Error('worker-fs: ctx.subprocess is unavailable')
    const handle = subprocess.spawn({
      argv: confined.argv,
      cwd: this.spawnCwd(policy.workspaceRoot),
      stdio: {
        stdin: { data: request },
        stdout: { maxBytes: 8 * 1024 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: this.graceMs,
      ...signal === undefined ? {} : { signal },
      // helper 不需要任何继承环境；给一份最小 env 即可。
      env: { PATH: '/usr/bin:/bin', HOME: this.sensitiveHome },
    })
    const outcome = await handle.done
    const stdout = handle.collected?.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected?.stderr?.readFrom(0).text ?? ''
    if (outcome.exitCode === DENIED_EXIT || (outcome.exitCode !== 0 && /EPERM|EACCES|Operation not permitted/.test(stderr))) {
      throw deniedOrAbsent({ displayPath: hostPath } as FsTarget, 'file access denied under the worker file sandbox', 'FS_SANDBOX_DENIED')
    }
    if (outcome.exitCode === ABSENT_EXIT) return { kind: 'absent' }
    if (outcome.exitCode !== 0) throw new Error(`worker-fs helper failed (exit ${String(outcome.exitCode)}): ${stderr.trim().slice(0, 200)}`)
    return parseHelper(stdout)
  }

  /** spawn 的 cwd 必须是存在的真实目录；workspaceRoot 不存在时退到 HOME（helper 只用绝对 path）。 */
  private spawnCwd(workspaceRoot: string): string {
    return existsSync(workspaceRoot) ? workspaceRoot : this.sensitiveHome
  }
}

/** helper 主脚本的绝对路径（构建 `lib/worker-fs-helper.mjs` 或源码 `src/executor/worker-fs-helper.mjs`，与 `worker-fs.*` 同目录）。 */
function helperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // 构建后本模块在 lib/，helper 是同一轮 tsdown 的另一个 entry → lib/worker-fs-helper.js。
  return join(here, 'worker-fs-helper.mjs')
}

/** 结构化 `FS_SANDBOX_DENIED`（与 DSH 的 denial marker 语义一致：工具层会渲染成 `[sandbox: …]`）。 */
function deniedOrAbsent(target: FsTarget, message: string, code: string): Error {
  const error = new Error(`cannot read "${target.displayPath}": ${message}`)
  ;(error as Error & { code?: string }).code = code
  return error
}

/** 从隔离 helper 给的 mtime/size 造一个稳定 version 串（供下游 stale 守卫；读语义只需稳定即可）。 */
function versionFrom(mtimeMs: number | undefined, size: number | undefined): string {
  return `wbfs:${String(mtimeMs ?? 0)}:${String(size ?? 0)}`
}

/** 解析 helper 的 JSON 输出。 */
function parseHelper(stdout: string): ReturnType<WorkerFileSystem['runHelper']> extends Promise<infer T> ? T : never {
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  const op = parsed['op']
  switch (op) {
    case 'text': return { kind: 'text', text: String(parsed['text'] ?? '') } as never
    case 'base64': return { kind: 'base64', base64: String(parsed['base64'] ?? '') } as never
    case 'stat': return { kind: 'stat', type: parsed['type'] as 'file', ...parsed['size'] === undefined ? {} : { size: Number(parsed['size']) }, ...parsed['mtimeMs'] === undefined ? {} : { mtimeMs: Number(parsed['mtimeMs']) } } as never
    case 'lstat': return { kind: 'lstat', type: parsed['type'] as 'file', ...parsed['size'] === undefined ? {} : { size: Number(parsed['size']) }, ...parsed['mtimeMs'] === undefined ? {} : { mtimeMs: Number(parsed['mtimeMs']) } } as never
    case 'list': return { kind: 'list', entries: (parsed['entries'] as never[] ?? []) } as never
    default: throw new Error(`worker-fs helper returned unknown op "${String(op)}"`)
  }
}

export const inject = [] as const
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(WorkerFileSystem as never, config as never)
}
export default WorkerFileSystem
