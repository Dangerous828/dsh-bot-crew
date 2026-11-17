/**
 * `Setup` 的陈旧 problem（task-15 收尾的现场根因）。
 *
 * 现场症状：`/orchestrator/api/state` 同时给出 `runtime: ready` 与 `setup.problem.code:
 * agentCliSignedOut`，于是 `github` / `team` 两个 Source 永远 `paused` —— 它们读
 * `context.problem` 决定要不要轮询，而那个 problem 在 setup 早已成功之后还留着。
 *
 * 这里钉住三件事：
 *  1. `run()` **完全**成功（含 worker 环境写入与校验）后清 `problem`；失败仍记录，成功不清半路。
 *  2. `feishuProblem` 在 `resolveFeishuBot` 真正返回之后才清：正常禁用（不配 CLI）也算正常返回；
 *     探测仍在进行时不许提前清掉旧错误。
 *  3. `check()` 只在 `problem` 与 `feishuProblem` 都空时才算全健康，否则仍允许重跑。
 *
 * 不碰真实 CLI、不碰真实网络、不碰身份配置：`resolveDeployment` / `resolveFeishuBot` /
 * `writeEnvironment` / `verifyEnvironment` 全部替身，被测的是 `Setup` 自己的状态机。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupError } from '../src/setup.ts'
import type { Deployment, Machine } from '../src/deployment.ts'
import type { Settings } from '../src/policy.ts'

const resolveDeployment = vi.fn()
const resolveFeishuBot = vi.fn()
const writeEnvironment = vi.fn()
const verifyEnvironment = vi.fn()

vi.mock('../src/deployment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/deployment.ts')>(),
  resolveDeployment: (...args: unknown[]) => resolveDeployment(...args),
  resolveFeishuBot: (...args: unknown[]) => resolveFeishuBot(...args),
}))
vi.mock('../src/infra/environment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/infra/environment.ts')>(),
  writeEnvironment: (...args: unknown[]) => writeEnvironment(...args),
  verifyEnvironment: (...args: unknown[]) => verifyEnvironment(...args),
}))

const { Setup } = await import('../src/app/setup.ts')

let dir = ''
const machine = (): Machine => ({ stateDir: join(dir, 'state') }) as unknown as Machine
const deployment = (over: Partial<Deployment> = {}): Deployment => ({ ...machine(),
  repository: 'acme/widgets', github: { cli: '/bin/gh', login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' }, ...over })
/** 只带 `Setup` 真正用到的那几样：subprocess（probe 只构造、不执行）、logger、lifetime、restart。 */
function setup(): { instance: InstanceType<typeof Setup>; restarted: () => number } {
  let restarts = 0
  const host = {
    context: { subprocess: {}, logger: { warn: () => undefined, info: () => undefined } },
    machine: machine(),
    lifetime: new AbortController().signal,
    restart: () => { restarts += 1 },
  }
  return { instance: new Setup(host as never), restarted: () => restarts }
}
/** 只填 setup 看得懂的三个块：GitHub 源是否启用、它的配置、Feishu 的配置。 */
const settings = (over: { github?: boolean; feishu?: Record<string, unknown> } = {}): Settings => ({
  sources: {
    github: { enabled: over.github ?? true, config: { repository: 'acme/widgets', cli: '/bin/gh' } },
    feishu: { enabled: true, config: over.feishu ?? {} },
  },
  executor: { blockedCommands: [] },
}) as unknown as Settings
const signedOut = () => new SetupError('agentCliSignedOut', { output: 'dial tcp 20.205.243.168:443: i/o timeout' })
/** `check()` 把重启推到下一个宏任务（好让当前 HTTP/tool 调用先拿到响应），断言前得等它落地。 */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const noBot = () => new SetupError('feishuNoBot', {})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'setup-'))
  resolveDeployment.mockReset(); resolveFeishuBot.mockReset()
  writeEnvironment.mockReset().mockResolvedValue(undefined)
  verifyEnvironment.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('a problem recorded by a failed run', () => {
  it('is cleared once a later run on the same instance fully succeeds', async () => {
    const { instance } = setup()
    resolveDeployment.mockRejectedValueOnce(signedOut())
    expect(await instance.run(settings())).toBe(false)
    expect(instance.problem?.code).toBe('agentCliSignedOut')
    expect(instance.configured()).toBe(false)

    // 瞬时断连过去了：同一个实例再跑一次。这正是现场那条路径（Runtime 每 5 秒重试一次）。
    resolveDeployment.mockResolvedValueOnce(deployment())
    resolveFeishuBot.mockResolvedValueOnce(undefined)
    expect(await instance.run(settings())).toBe(true)
    expect(instance.problem).toBeUndefined()
    expect(instance.configured()).toBe(true)
  })

  it('is not cleared when the retry fails again, and keeps the newest reason', async () => {
    const { instance } = setup()
    resolveDeployment.mockRejectedValueOnce(signedOut())
    await instance.run(settings())
    resolveDeployment.mockRejectedValueOnce(new SetupError('repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }))
    expect(await instance.run(settings())).toBe(false)
    expect(instance.problem?.code).toBe('repositoryReadOnly')
  })

  it('survives a run that dies after the probes, because only a full success clears it', async () => {
    const { instance } = setup()
    resolveDeployment.mockRejectedValueOnce(signedOut())
    await instance.run(settings())
    // 探针都通过了，但 worker 环境写入失败：这不是「完全成功」，旧 problem 不该被清掉。
    resolveDeployment.mockResolvedValueOnce(deployment())
    resolveFeishuBot.mockResolvedValueOnce(undefined)
    writeEnvironment.mockRejectedValueOnce(new Error('disk full'))
    expect(await instance.run(settings())).toBe(false)
    expect(instance.problem?.code).toBe('environmentFailed')
    expect(instance.configured()).toBe(false)
  })
})

describe('feishuProblem', () => {
  it('is cleared when the bot resolves on a later run', async () => {
    const { instance } = setup()
    resolveDeployment.mockResolvedValue(deployment())
    resolveFeishuBot.mockRejectedValueOnce(noBot())
    await instance.run(settings({ feishu: { cli: 'lark-cli' } }))
    expect(instance.feishuProblem?.code).toBe('feishuNoBot')
    // Feishu 不阻塞 setup：GitHub 那份仍然是好的。
    expect(instance.configured()).toBe(true)

    resolveFeishuBot.mockResolvedValueOnce({ cli: '/bin/lark-cli', appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot', name: 'Bot' })
    expect(await instance.run(settings({ feishu: { cli: 'lark-cli' } }))).toBe(true)
    expect(instance.feishuProblem).toBeUndefined()
  })

  it('is cleared when the Feishu Source is normally disabled, which is a normal return, not a failure', async () => {
    const { instance } = setup()
    resolveDeployment.mockResolvedValue(deployment())
    resolveFeishuBot.mockRejectedValueOnce(noBot())
    await instance.run(settings({ feishu: { cli: 'lark-cli' } }))
    expect(instance.feishuProblem).toBeDefined()
    // 不配 cli → resolveFeishuBot 正常返回 undefined（部署里就没有 Feishu 这一档）。
    resolveFeishuBot.mockResolvedValueOnce(undefined)
    expect(await instance.run(settings({ feishu: {} }))).toBe(true)
    expect(instance.feishuProblem).toBeUndefined()
  })

  it('is not cleared before the probe returns, so a still-failing bot is never shown as recovered', async () => {
    const { instance } = setup()
    resolveDeployment.mockResolvedValue(deployment())
    resolveFeishuBot.mockRejectedValueOnce(noBot())
    await instance.run(settings({ feishu: { cli: 'lark-cli' } }))
    let release!: () => void
    resolveFeishuBot.mockImplementationOnce(() => new Promise((_resolve, reject) => { release = () => reject(noBot()) }))
    const pending = instance.run(settings({ feishu: { cli: 'lark-cli' } }))
    // 探测还没回来：旧的错误必须仍然在，不能提前松口。
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(instance.feishuProblem?.code).toBe('feishuNoBot')
    release()
    expect(await pending).toBe(true)
    expect(instance.feishuProblem?.code).toBe('feishuNoBot')
  })
})

describe('check()', () => {
  it('refuses a restart only when setup is entirely healthy', async () => {
    const { instance, restarted } = setup()
    resolveDeployment.mockRejectedValueOnce(signedOut())
    await instance.run(settings())
    expect(() => instance.check()).not.toThrow()
    await settle()
    expect(restarted()).toBe(1)
  })

  it('still re-runs when a resolved deployment carries a stale problem', async () => {
    const { instance, restarted } = setup()
    // 现场那个状态：deployment 已经解析出来，但 problem 还在。
    instance.problem = signedOut().problem
    resolveDeployment.mockResolvedValueOnce(deployment())
    // `configured()` 只认 resolved，所以这里刻意用一次成功 run 把它变成「已配置」。
    resolveFeishuBot.mockResolvedValueOnce(undefined)
    await instance.run(settings())
    instance.problem = signedOut().problem
    expect(instance.configured()).toBe(true)
    expect(() => instance.check()).not.toThrow()
    await settle()
    expect(restarted()).toBe(1)
  })

  it('still re-runs when only the Feishu bot is broken', async () => {
    const { instance, restarted } = setup()
    resolveDeployment.mockResolvedValueOnce(deployment())
    resolveFeishuBot.mockRejectedValueOnce(noBot())
    await instance.run(settings({ feishu: { cli: 'lark-cli' } }))
    expect(instance.problem).toBeUndefined()
    expect(instance.feishuProblem?.code).toBe('feishuNoBot')
    expect(() => instance.check()).not.toThrow()
    await settle()
    expect(restarted()).toBe(1)
  })

  it('refuses a restart once a resolved deployment has no problem and no feishuProblem', async () => {
    const { instance } = setup()
    resolveDeployment.mockResolvedValueOnce(deployment())
    resolveFeishuBot.mockResolvedValueOnce(undefined)
    await instance.run(settings())
    expect(instance.configured()).toBe(true)
    expect(() => instance.check()).toThrowError(/Setup is complete/)
  })
})
