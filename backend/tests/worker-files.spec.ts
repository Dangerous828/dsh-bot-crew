/**
 * #22 补口 / task-5：worker 文件工具读面隔离的 canary。
 *
 * 证明 `WorkerFileSystem`（worker preset 里挂的 `ctx.fs` 装饰器）**真约束** worker 的读，且
 * **只按真实 per-session 上下文**判权限（cwd 不是会话身份）：
 *  - 正对照：confining 会话读得到自己的工作区、stat 得到（沙箱确实起来了，不是全拒）；
 *  - 负对照：confining 会话读不到临时 HOME 里的凭据（`.ssh` / `.config`），stat 也被拒；
 *  - **TOCTOU 关键**：工作区内建 `evil-link -> ~/.ssh/id_ed25519`，读该 symlink 仍被内核拒
 *    （宿主 realpath 预检会放行/被 race，open-time deny 不会）；
 *  - **per-session 不串**：两个会话一个 sandbox 一个 none，交替 + 并发读同一凭据各按自己
 *    mode（sandbox 拒、none 读），证明权限来自会话而非路径；
 *  - **缺会话上下文 fail-closed**：无 initiator 时拒绝，抛明确错误，绝不静默放行。
 *
 * 每条都真跑 `sandbox-exec`（经真 `WorkerSandboxProvider.confine()` 造 argv）+ 真 helper 子进程；
 * canary 全在**临时 HOME**（假 token）。`agents.currentInitiator()` 用 `AsyncLocalStorage` 忠实
 * 模拟 DSH 的 initiator 边界（机制证据；端到端真 agent 驱动见 docs/review/phase2-worker 报告）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkerSandboxProvider } from '../src/executor/sandbox.ts'
import { WorkerFileSystem } from '../src/executor/worker-fs.ts'
import { sandboxAvailable } from '../src/infra/environment.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const fresh = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }

/** 极薄 `subprocess` 桩：照搬 collected→readFrom 语义，真跑子进程。 */
function fakeSubprocess(): { spawn(spec: { argv: readonly string[]; cwd: string; stdio: { stdin: { data: string }; stdout: { maxBytes: number }; stderr: { maxBytes: number } }; graceMs: number; env?: NodeJS.ProcessEnv }): { done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>; collected: { stdout: { readFrom(n: number): { text: string } }; stderr: { readFrom(n: number): { text: string } } } } } {
  return {
    spawn(spec) {
      const [cmd, ...args] = spec.argv
      const child = spawn(cmd!, args, { cwd: spec.cwd, env: spec.env ?? (process.env as Record<string, string>) })
      let out = ''; let err = ''
      child.stdout.on('data', (c) => { out += String(c) })
      child.stderr.on('data', (c) => { err += String(c) })
      child.stdin.write(spec.stdio.stdin.data); child.stdin.end()
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      return { done, collected: { stdout: { readFrom: () => ({ text: out }) }, stderr: { readFrom: () => ({ text: err }) } } }
    },
  }
}

interface SessionPolicy { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string }

/**
 * 组最小 ctx：root 假 fs + subprocess + sandboxPolicy + agents(ALS initiator)；
 * isolate fs+sandbox 组里挂真 WorkerSandboxProvider + 真 WorkerFileSystem。
 * `sessions` 是 session→policy 表；`runAs(session, fn)` 建立 initiator 边界。
 * `withAgents=false` 时不给 agents 服务，用来测缺会话 fail-closed。
 */
async function makeWorkerFs(
  home: string,
  sessions: Map<object, SessionPolicy>,
  opts: { withAgents?: boolean } = {},
): Promise<{ groupFs: WorkerFileSystem; runAs: <T>(session: object, fn: () => Promise<T>) => Promise<T> }> {
  const als = new AsyncLocalStorage<object>()
  const ctx = new Context()
  const subprocess = fakeSubprocess()
  const rootFs = {
    resolve: async (p: string) => ({ targetKey: p, displayPath: p }),
    processPath: (t: { targetKey: unknown }) => String(t.targetKey),
    processPathFromHostPath: (h: string) => h, fileUrl: (t: { targetKey: unknown }) => String(t.targetKey), contains: () => false,
    stat: async () => { throw new Error('root fs should not be used') }, lstat: async () => { throw new Error('root fs should not be used') },
    readText: async (t: { targetKey: unknown }) => readFileSync(String(t.targetKey), 'utf8'),
    streamText: async () => { throw new Error('root fs should not be used') },
    readBytes: async () => { throw new Error('root fs should not be used') }, readByteRange: async () => { throw new Error('root fs should not be used') },
    listDir: async () => { throw new Error('root fs should not be used') },
    writeText: async () => ({}), editText: async () => ({}), patchText: async () => ({}), deleteFile: async () => ({}), moveFile: async () => ({}), watch: async () => ({}),
  }
  await ctx.plugin({ name: 'root-fs', apply: (c: Context) => { c.provide('fs', rootFs) } })
  await ctx.plugin({ name: 'root-subprocess', apply: (c: Context) => { c.provide('subprocess', subprocess) } })
  await ctx.plugin({
    name: 'root-policy',
    apply: (c: Context) => {
      c.provide('sandboxPolicy', {
        resolve: (req?: { session?: object }) => {
          const s = req?.session
          const hit = s !== undefined ? sessions.get(s) : undefined
          return hit !== undefined ? { mode: hit.mode, workspaceRoot: hit.workspaceRoot } : { mode: 'danger-full-access' as const, workspaceRoot: process.cwd() }
        },
      })
    },
  })
  if (opts.withAgents !== false) {
    await ctx.plugin({ name: 'root-agents', apply: (c: Context) => { c.provide('agents', { currentInitiator: () => { const s = als.getStore(); return s === undefined ? undefined : { session: s } } }) } })
  }
  const group = ctx.isolate('fs').isolate('sandbox')
  await group.plugin(WorkerSandboxProvider, { sensitiveHome: home })
  await group.plugin(WorkerFileSystem, { sensitiveHome: home })
  return { groupFs: group.get('fs') as WorkerFileSystem, runAs: (session, fn) => als.run(session, fn) }
}

const describeIfMac = sandboxAvailable() ? describe : describe.skip
const sandboxSession = { id: 'A' }
const noneSession = { id: 'B' }

describeIfMac('WorkerFileSystem（#22 worker 文件读面隔离 canary）', () => {
  it('正对照：confining 会话读得到工作区、stat 得到（沙箱确实起来了，不是全拒）', async () => {
    const home = fresh('wbf-home-'); const ws = fresh('wbf-ws-')
    writeFileSync(join(ws, 'note.txt'), 'ws-data\n')
    const { groupFs, runAs } = await makeWorkerFs(home, new Map([[sandboxSession, { mode: 'workspace-write', workspaceRoot: ws }]]))
    await runAs(sandboxSession, async () => {
      const t = await groupFs.resolve(join(ws, 'note.txt'))
      await expect(groupFs.readText(t)).resolves.toContain('ws-data')
      expect((await groupFs.stat(t))?.type).toBe('file')
    })
  })

  it('负对照：confining 会话读 ~/.ssh 里的假凭据被拒（FS_SANDBOX_DENIED）', async () => {
    const home = fresh('wbf-home-'); const ws = fresh('wbf-ws-')
    mkdirSync(join(home, '.ssh')); writeFileSync(join(home, '.ssh', 'id_ed25519'), 'CANARY-SSH-NOT-REAL\n')
    const { groupFs, runAs } = await makeWorkerFs(home, new Map([[sandboxSession, { mode: 'workspace-write', workspaceRoot: ws }]]))
    await runAs(sandboxSession, async () => {
      const t = await groupFs.resolve(join(home, '.ssh', 'id_ed25519'))
      await expect(groupFs.readText(t)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    })
  })

  it('负对照：confining 会话 stat ~/.config 里的凭据被拒', async () => {
    const home = fresh('wbf-home-'); const ws = fresh('wbf-ws-')
    mkdirSync(join(home, '.config')); writeFileSync(join(home, '.config', 'gh-hosts.yml'), 'CANARY-GH-NOT-REAL\n')
    const { groupFs, runAs } = await makeWorkerFs(home, new Map([[sandboxSession, { mode: 'workspace-write', workspaceRoot: ws }]]))
    await runAs(sandboxSession, async () => {
      const t = await groupFs.resolve(join(home, '.config', 'gh-hosts.yml'))
      await expect(groupFs.stat(t)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    })
  })

  it('TOCTOU 关键：工作区内 symlink 指向凭据，confining 下读该 symlink 仍被拒（open-time deny）', async () => {
    const home = fresh('wbf-home-'); const ws = fresh('wbf-ws-')
    mkdirSync(join(home, '.ssh')); writeFileSync(join(home, '.ssh', 'id_ed25519'), 'CANARY-SSH-NOT-REAL\n')
    symlinkSync(join(home, '.ssh', 'id_ed25519'), join(ws, 'evil-link'))
    const { groupFs, runAs } = await makeWorkerFs(home, new Map([[sandboxSession, { mode: 'workspace-write', workspaceRoot: ws }]]))
    await runAs(sandboxSession, async () => {
      const t = await groupFs.resolve(join(ws, 'evil-link'))
      await expect(groupFs.readText(t)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    })
  })

  it('per-session：两会话一个 sandbox 一个 none，交替读同一凭据——各按自己 mode，不串', async () => {
    const home = fresh('wbf-home-'); const wsA = fresh('wbf-wsA-'); const wsB = fresh('wbf-wsB-')
    mkdirSync(join(home, '.ssh')); writeFileSync(join(home, '.ssh', 'id_ed25519'), 'CANARY-SSH-NOT-REAL\n')
    const sessions = new Map<object, SessionPolicy>([
      [sandboxSession, { mode: 'workspace-write', workspaceRoot: wsA }],
      [noneSession, { mode: 'danger-full-access', workspaceRoot: wsB }],
    ])
    const { groupFs, runAs } = await makeWorkerFs(home, sessions)
    await runAs(sandboxSession, async () => {
      const t = await groupFs.resolve(join(home, '.ssh', 'id_ed25519'))
      await expect(groupFs.readText(t)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    })
    await runAs(noneSession, async () => {
      const t = await groupFs.resolve(join(home, '.ssh', 'id_ed25519'))
      await expect(groupFs.readText(t)).resolves.toContain('CANARY-SSH')
    })
  })

  it('per-session 并发：sandbox/none 交错各读凭据 15 次，全拒/全读、不串模式', async () => {
    const home = fresh('wbf-home-'); const wsA = fresh('wbf-wsA-'); const wsB = fresh('wbf-wsB-')
    mkdirSync(join(home, '.ssh')); writeFileSync(join(home, '.ssh', 'id_ed25519'), 'CANARY-SSH-NOT-REAL\n')
    const sessions = new Map<object, SessionPolicy>([
      [sandboxSession, { mode: 'workspace-write', workspaceRoot: wsA }],
      [noneSession, { mode: 'danger-full-access', workspaceRoot: wsB }],
    ])
    const { groupFs, runAs } = await makeWorkerFs(home, sessions)
    let denied = 0; let ok = 0
    const tasks: Promise<void>[] = []
    for (let i = 0; i < 15; i += 1) {
      tasks.push(runAs(sandboxSession, async () => {
        const t = await groupFs.resolve(join(home, '.ssh', 'id_ed25519'))
        try { await groupFs.readText(t) } catch (e) { if ((e as { code?: string }).code === 'FS_SANDBOX_DENIED') denied += 1 }
      }))
      tasks.push(runAs(noneSession, async () => {
        const t = await groupFs.resolve(join(home, '.ssh', 'id_ed25519'))
        const out = await groupFs.readText(t); if (out.includes('CANARY-SSH')) ok += 1
      }))
    }
    await Promise.all(tasks)
    expect(denied).toBe(15); expect(ok).toBe(15)
  })

  it('fail-closed：缺会话上下文（无 agents/initiator）时拒绝，抛明确错误，绝不静默放行', async () => {
    const home = fresh('wbf-home-'); const ws = fresh('wbf-ws-')
    mkdirSync(join(home, '.ssh')); writeFileSync(join(home, '.ssh', 'id_ed25519'), 'CANARY-SSH-NOT-REAL\n')
    writeFileSync(join(ws, 'note.txt'), 'ws-data\n')
    // withAgents:false → 无 initiator 边界；即便读工作区也应 fail-closed（不凭路径猜）
    const { groupFs } = await makeWorkerFs(home, new Map(), { withAgents: false })
    const t = await groupFs.resolve(join(ws, 'note.txt'))
    await expect(groupFs.readText(t)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })
})
