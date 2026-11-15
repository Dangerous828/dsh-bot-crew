/**
 * #22 worker 执行隔离的 canary：证明 backend 的 `WorkerSandboxProvider` 真的约束 worker 自由命令。
 *
 * 每一条都真跑 `sandbox-exec`（经 provider.confine() 造出的 argv），canary 全在**临时 HOME**里
 * （假 token），不碰操作者真实凭据、不读真实 shell 历史。断言分三面（任务要求的验收线）：
 *  - 读不到临时 HOME 里的凭据载体（`.ssh` / `.config` / `.aws` …）；
 *  - 读得到自己的工作区；
 *  - 写限在工作区、越界写被拒。
 * 正对照（工作区可读写）与负对照（凭据读被拒）成对出现：只有负对照，「全被拒」和「沙箱没起来」分不开。
 */
import { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkerSandboxProvider } from '../src/executor/sandbox.ts'
import { sandboxAvailable } from '../src/infra/environment.ts'

const HOME = (): string => mkdtempSync(join(tmpdir(), 'wbx-home-'))
const WS = (): string => mkdtempSync(join(tmpdir(), 'wbx-ws-'))
const OUTSIDE = (): string => mkdtempSync(join(tmpdir(), 'wbx-out-'))

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const fresh = (make: () => string): string => { const dir = make(); cleanups.push(dir); return dir }

/** 起一个 ctx 并挂上 provider（sensitiveHome 指向临时 HOME）。 */
const provider = async (home: string): Promise<WorkerSandboxProvider> => {
  const ctx = new Context()
  const instance = new WorkerSandboxProvider(ctx, { sensitiveHome: home })
  return instance
}

/** 用 provider.confine() 包一层，真跑一条 argv，返回退出码与合并输出。 */
async function runConfined(p: WorkerSandboxProvider, argv: string[], cwd: string, home: string, extraWritable: string[] = []): Promise<{ code: number | null; text: string }> {
  const confined = await p.confine(argv, { mode: 'workspace-write', workspaceRoot: cwd, additionalWritableRoots: extraWritable })
  return new Promise(resolve => {
    const child = spawn(confined.argv[0]!, confined.argv.slice(1), { cwd, env: { ...process.env as Record<string, string>, HOME: home } })
    let text = ''
    child.stdout.on('data', chunk => { text += String(chunk) })
    child.stderr.on('data', chunk => { text += String(chunk) })
    child.on('close', code => resolve({ code, text }))
  })
}

const describeIfMac = sandboxAvailable() ? describe : describe.skip

describeIfMac('WorkerSandboxProvider（#22 worker 执行隔离 canary）', () => {
  it('正对照：能读到自己工作区、能在工作区写（沙箱确实起来了，不是全拒）', async () => {
    const home = fresh(HOME); const ws = fresh(WS)
    writeFileSync(join(ws, 'note.txt'), 'worker-data\n')
    const p = await provider(home)
    const read = await runConfined(p, ['/bin/cat', join(ws, 'note.txt')], ws, home)
    expect(read.code).toBe(0)
    expect(read.text).toContain('worker-data')
    const write = await runConfined(p, ['/bin/sh', '-c', `echo ok > '${join(ws, 'out.txt')}'`], ws, home)
    expect(write.code).toBe(0)
  })

  it('负对照：读不到临时 HOME 里的凭据载体（.ssh/.config/.aws/.gitconfig）', async () => {
    const home = fresh(HOME); const ws = fresh(WS)
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(join(home, '.config'), { recursive: true })
    mkdirSync(join(home, '.aws'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'CANARY-SSH-NOT-A-REAL-KEY\n')
    writeFileSync(join(home, '.config', 'gh-hosts.yml'), 'CANARY-GH-NOT-A-REAL-TOKEN\n')
    writeFileSync(join(home, '.aws', 'credentials'), 'CANARY-AWS-NOT-A-REAL-KEY\n')
    writeFileSync(join(home, '.gitconfig'), 'CANARY-GITCONFIG\n')
    const p = await provider(home)
    for (const path of ['.ssh/id_ed25519', '.config/gh-hosts.yml', '.aws/credentials', '.gitconfig']) {
      const r = await runConfined(p, ['/bin/cat', join(home, path)], ws, home)
      // 被拒 = 非 0 退出，且不是「文件不存在」（canary 确实存在）。
      expect(r.code, `${path} 应当被拒但退出了 0`).not.toBe(0)
      expect(r.text, `${path} 被拒但输出疑似泄露 canary`).not.toContain('CANARY-')
    }
  })

  it('负对照：越界写被拒（工作区外不可写）', async () => {
    const home = fresh(HOME); const ws = fresh(WS); const outside = fresh(OUTSIDE)
    const p = await provider(home)
    const r = await runConfined(p, ['/bin/sh', '-c', `echo x > '${join(outside, 'evil.txt')}'`], ws, home)
    expect(r.code).not.toBe(0)
  })

  it('附加可写目录：显式列进 additionalWritableRoots 的目录可以写', async () => {
    const home = fresh(HOME); const ws = fresh(WS); const extra = fresh(OUTSIDE)
    const p = await provider(home)
    const r = await runConfined(p, ['/bin/sh', '-c', `echo x > '${join(extra, 'ok.txt')}'`], ws, home, [extra])
    expect(r.code).toBe(0)
  })

  it('结构：confine() 产出的 argv 带 `deny file-read*`（钉住限读契约，不是只限写）', async () => {
    const home = fresh(HOME); const ws = fresh(WS)
    const p = await provider(home)
    const confined = await p.confine(['/bin/sh', '-c', 'true'], { mode: 'workspace-write', workspaceRoot: ws })
    expect(confined.argv[0]).toBe('/usr/bin/sandbox-exec')
    const profile = confined.argv[confined.argv.indexOf('-p') + 1]!
    // DSH 自带 seatbelt profile 只有 (deny file-write*)，没有 read-deny；我们的 provider 必须补上。
    expect(profile).toContain('(deny file-read*')
    expect(confined.enforcement).toBe('full')
  })
})
