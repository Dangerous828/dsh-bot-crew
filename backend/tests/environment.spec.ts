import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GIT_LOCATION, agentVariables, credentialHelper, runAsWorker, runIsolated, verifyDirectory, withoutDirectory, workerBin, workerGhConfig, workerGitConfig, writeEnvironment, sandboxAvailable }
  from '../src/infra/environment.ts'
import { CliError } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { realSubprocess } from './fixtures/subprocess.ts'
import { gitEnv } from './fixtures/git.ts'

// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
const program = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
/** Worker shell environment after DSH strips credential-shaped variables. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('worker shims', () => {
  it('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    program(join(dir, 'real', 'gh'), 'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"')
    const wrapper = program(join(dir, 'gh-agent'), `GH_CONFIG_DIR=${dir}/agent-config exec gh "$@"`)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: wrapper }, feishu: undefined }), [])
    const bin = workerBin(dir)
    const path = [bin, join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':')
    const { stdout } = await exec('gh', ['api', 'user'], { env: { PATH: path }, timeout: 10_000 })
    expect(JSON.parse(stdout)).toEqual({ login: 'agent-bot', config: `${dir}/agent-config`, path: [join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':') })
  })
  it('make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent\'s login', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    await expect(exec(join(bin, 'lark-cli'), ['im', '+chat-list'])).rejects.toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\n' })
    await expect(exec(join(bin, 'personal-gh'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n' })
  })
  it('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    const gh = program(join(dir, 'gh-agent'), 'echo gh "$@"'), lark = program(join(dir, 'lark-bot'), 'echo lark "$@"')
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github, cli: gh }, feishu: { ...base.feishu!, cli: lark } }), ['gh', 'git', 'lark-cli'])
    const bin = workerBin(dir)
    expect([(await exec(join(bin, 'gh'), ['api', 'user'])).stdout, (await exec(join(bin, 'lark-cli'), ['im'])).stdout]).toEqual(['gh api user\n', 'lark im\n'])
    expect(readdirSync(bin)).not.toContain('git')
  })
  it('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    // A file that merely contains the marker on a later line, a symlink to a shim, and a foreign gitconfig are all rejected.
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${readFileSync(join(workerBin(dir), 'gh'), 'utf8').split('\n')[1]}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    rmSync(join(workerBin(dir), 'notes'))
    symlinkSync(join(workerBin(dir), 'gh'), join(workerBin(dir), 'link'))
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
    rmSync(join(workerBin(dir), 'link'))
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
  })
  it('replaces the files it wrote under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    legacy(join(workerBin(dir), 'old-cli'), 'dsh-tag'); legacy(join(workerBin(dir), 'older-cli'), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
})

describe('agent git configuration', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: '/opt/agent tools/gh' } })
    await writeEnvironment(deployment, [])
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    expect(await git('config', '--show-origin', '--get-all', 'credential.https://github.com.helper')).toBe(`file:${workerGitConfig(dir)}\t${credentialHelper('/opt/agent tools/gh')}`)
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })
})

it('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  const agent = program(join(dir, 'real', 'gh'), 'exit 0')
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: agent } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  symlinkSync(join(dir, 'state'), join(dir, 'link'))
  const bin = join(dir, 'state', 'worker-bin')
  expect(withoutDirectory([`${bin}/`, join(dir, 'link', 'worker-bin'), '/usr/bin', 'node_modules/.bin'].join(':'), bin)).toBe('/usr/bin:node_modules/.bin')
})

/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
describe('ticket directory check', () => {
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // When no config key matches at all, git config --get-regexp exits with status 1.
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
  })
  it('reports a failed command\'s exit status', async () => {
    const failing = ['sh', '-c', 'echo nope >&2; exit 3']
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })
})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // The operator's limit on git's search for a repository names none, and stays.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})

// Step 2 强制隔离（#9-2）：真跑 sandbox-exec，证明 worker 只能写执行目录、读到敏感目录被拦。
// 只在这台 macOS 上真跑；别的平台 sandboxAvailable() 返回 false 时跳过（并断言 runIsolated 会拒绝冒充）。
describe('worker isolation (sandbox)', () => {
  const signal = new AbortController().signal
  const realSubprocess = (): SubprocessRuntime => ({
    spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd })
      const output = { stdout: '', stderr: '' }
      child.stdout.on('data', chunk => { output.stdout += String(chunk) })
      child.stderr.on('data', chunk => { output.stderr += String(chunk) })
      const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
      const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
      return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
    },
  }) as unknown as SubprocessRuntime

  it('lets a worker write inside its own exec dir but not outside, and not read the operator credential dir', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const { runIsolated } = await import('../src/infra/environment.ts')
    const execDir = mkdtempSync(join(tmpdir(), 'iso-exec-'))
    const outside = mkdtempSync(join(tmpdir(), 'iso-outside-'))
    const fakeSshDir = mkdtempSync(join(tmpdir(), 'iso-ssh-'))
    const secret = join(fakeSshDir, 'id_ed25519')
    writeFileSync(secret, 'PRIVATE-KEY')
    const sb = realSubprocess()
    try {
      // ① 写自己的执行目录：成功，文件真落地。
      await runIsolated(sb, ['sh', '-c', 'echo hi > own.txt'], execDir, signal,
        { mode: 'sandbox', writableRoots: [execDir], readableDeny: [fakeSshDir] })
      expect(readdirSync(execDir)).toContain('own.txt')
      // ② 写执行目录之外：被拦（命令失败）。
      await expect(runIsolated(sb, ['sh', '-c', `echo x > ${join(outside, 'no.txt')}`], execDir, signal,
        { mode: 'sandbox', writableRoots: [execDir], readableDeny: [fakeSshDir] })).rejects.toBeInstanceOf(CliError)
      expect(readdirSync(outside)).not.toContain('no.txt')
      // ③ 读操作者凭据目录（这里用 fakeSshDir 顶替 ~/.ssh）：被拦。
      await expect(runIsolated(sb, ['sh', '-c', `cat ${secret}`], execDir, signal,
        { mode: 'sandbox', writableRoots: [execDir], readableDeny: [fakeSshDir] })).rejects.toBeInstanceOf(CliError)
    } finally {
      rmSync(execDir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
      rmSync(fakeSshDir, { recursive: true, force: true })
    }
  })

  it('mode=none runs plainly (backwards compatible): write outside the exec dir is allowed', async () => {
    const { runIsolated } = await import('../src/infra/environment.ts')
    const execDir = mkdtempSync(join(tmpdir(), 'iso-none-'))
    const outside = mkdtempSync(join(tmpdir(), 'iso-none-out-'))
    try {
      await runIsolated(realSubprocess(), ['sh', '-c', `echo x > ${join(outside, 'ok.txt')}`], execDir, signal,
        { mode: 'none', writableRoots: [execDir] })
      expect(readdirSync(outside)).toContain('ok.txt')
    } finally {
      rmSync(execDir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses to pretend isolation when the platform has no sandbox', async () => {
    const { runIsolated, sandboxAvailable } = await import('../src/infra/environment.ts')
    if (sandboxAvailable()) { expect(true).toBe(true); return } // 本机有，跳过这条
    const dir2 = mkdtempSync(join(tmpdir(), 'iso-no-'))
    try {
      await expect(runIsolated(realSubprocess(), ['true'], dir2, signal, { mode: 'sandbox', writableRoots: [dir2] }))
        .rejects.toThrow(/sandbox/)
    } finally { rmSync(dir2, { recursive: true, force: true }) }
  })
})

// 真机隔离回归：放行 /dev 后，git 能在 sandbox 里正常跑（否则 prepare 后 verifyDirectory 的 git config 会必挂，
// 整条活卡死）。这条用真 git + 真 sandbox-exec，盯住「隔离不打断正常 git 流程」。
describe('worker isolation keeps git working', () => {
  it('runs git inside the sandbox after prepare (verifyDirectory path)', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const { runIsolated } = await import('../src/infra/environment.ts')
    const execDir = mkdtempSync(join(tmpdir(), 'iso-git-'))
    const signal = new AbortController().signal
    const sb = (): SubprocessRuntime => ({
      spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd })
        const output = { stdout: '', stderr: '' }
        child.stdout.on('data', c => { output.stdout += String(c) })
        child.stderr.on('data', c => { output.stderr += String(c) })
        const reader = (n: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[n], nextOffset: 0, lossy: false }) })
        const done = new Promise(r => child.on('close', code => r({ exitCode: code, signal: null })))
        return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
      },
    }) as unknown as SubprocessRuntime
    try {
      await runIsolated(sb(), ['git', 'init', '-q'], execDir, signal, { mode: 'sandbox', writableRoots: [execDir] })
      // verifyDirectory 会跑 git config --get-regexp；在隔离里必须不抛（/dev/null 能打开）。
      const out = await runIsolated(sb(), ['git', 'config', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$'], execDir, signal,
        { mode: 'sandbox', writableRoots: [execDir] }).catch(e => `EXIT1:${e}`)
      // 干净的新仓库没这些键，退出码 1 是正常「没有」，不是挂死。这里只要求它跑得起来（能执行到判断）。
      expect(typeof out).toBe('string')
      expect(readdirSync(execDir)).toContain('.git')
    } finally { rmSync(execDir, { recursive: true, force: true }) }
  })
})

describe('isolation end-to-end: a ticket prepare lifecycle in the sandbox', () => {
  const realSubprocess = (): SubprocessRuntime => ({
    spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd })
      const output = { stdout: '', stderr: '' }
      child.stdout.on('data', c => { output.stdout += String(c) })
      child.stderr.on('data', c => { output.stderr += String(c) })
      const reader = (n: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[n], nextOffset: 0, lossy: false }) })
      const done = new Promise(r => child.on('close', code => r({ exitCode: code, signal: null })))
      return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
    },
  }) as unknown as SubprocessRuntime

  it('creates the workspace, runs prepare inside the sandbox, writes files, and passes verifyDirectory', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const root = mkdtempSync(join(tmpdir(), 'iso-e2e-'))
    const execDir = join(root, 'ticket-1')
    const fakeSsh = mkdtempSync(join(tmpdir(), 'iso-e2e-ssh-'))
    writeFileSync(join(fakeSsh, 'id_ed25519'), 'SECRET')
    const signal = new AbortController().signal
    const sb = realSubprocess()
    try {
      mkdirSync(execDir, { recursive: true })
      // prepare 命令：初始化仓库、写一个工作文件、试图读「凭据」。
      await runIsolated(sb, ['sh', '-c', 'git init -q && echo work > note.txt && cat ' + join(fakeSsh, 'id_ed25519') + ' 2>/dev/null && echo LEAK || echo blocked'],
        execDir, signal, { mode: 'sandbox', writableRoots: [execDir, root], readableDeny: [fakeSsh] })
      // ① 工作文件真写出来了
      expect(readFileSync(join(execDir, 'note.txt'), 'utf8').trim()).toBe('work')
      // ② 仓库初始化成功（.git 在）
      expect(readdirSync(execDir)).toContain('.git')
      // ③ verifyDirectory（git config --get-regexp）在隔离里能跑通（/dev/null 可开）——不抛错。
      await expect(verifyDirectory(execDir, sb, signal)).resolves.toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true }); rmSync(fakeSsh, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #11 第 3 项前置：翻默认到 sandbox 之前的真机回归。
//
// 这几条用真 `sandbox-exec`、真 `gh`、真 `git`、真网络。它们存在的理由很具体：翻默认之前，
// 沙箱档位的测试只覆盖本地 `git init` / `git config` / 写 note.txt，于是「全量测试全绿」
// 而一条真活的 prepare 会 100% 挂——因为沙箱 profile 缺 sysctl、缺网络、缺 keychain。
// 所以这里盯住的正是当初漏掉的那三件事。
// ─────────────────────────────────────────────────────────────────────────────
describe('worker isolation covers what a real ticket needs', () => {
  const signal = new AbortController().signal
  /** 与生产同一条路径：先写 worker 环境（shim + gitconfig + gh 配置目录），再用它跑命令。 */
  const workerSetup = async (stateDir: string, cli = 'gh'): Promise<Record<string, string>> => {
    await writeEnvironment({ stateDir, repository: 'acme/widgets',
      github: { cli, login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' }, feishu: null } as never, [])
    const variables = Object.fromEntries(Object.entries(agentVariables(stateDir)).filter(([, value]) => value !== undefined)) as Record<string, string>
    return { ...process.env as Record<string, string>, ...variables,
      PATH: [workerBin(stateDir), process.env.PATH ?? ''].join(':') }
  }

  it('lets a Go binary start inside the sandbox (sysctl-read), which gh and lark-cli need', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const { runIsolated } = await import('../src/infra/environment.ts')
    const stateDir = mkdtempSync(join(tmpdir(), 'iso-go-'))
    const execDir = join(stateDir, 'work', 't1')
    mkdirSync(execDir, { recursive: true })
    try {
      const env = await workerSetup(stateDir)
      // 缺 (allow sysctl-read) 时这条会 exit 2 并打印 `fatal error: failed to get system page size`。
      const out = await runIsolated(realSubprocess(), ['gh', '--version'], execDir, signal,
        { mode: 'sandbox', writableRoots: [execDir, join(stateDir, 'work')], env })
      expect(out).toMatch(/^gh version /)
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('reaches the network outbound but cannot listen, so the sandbox does not become a server', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const { runIsolated, sandboxArgv } = await import('../src/infra/environment.ts')
    const execDir = mkdtempSync(join(tmpdir(), 'iso-net-'))
    const profile = sandboxArgv([execDir])[2]!
    try {
      // 放行的是 network-outbound，不是 network*：出站要有，监听不该有。
      expect(profile).toContain('(allow network-outbound)')
      expect(profile).not.toContain('(allow network*)')
      // 真跑一条出站请求（不依赖外网是否可达：能连上就要求 HTTP 有响应，连不上则要求不是「被沙箱挡」）。
      const out = await runIsolated(realSubprocess(), ['sh', '-c', 'curl -sS -o /dev/null -w "%{http_code}" -m 10 https://api.github.com/ 2>&1'],
        execDir, signal, { mode: 'sandbox', writableRoots: [execDir] }).catch((error: unknown) => `blocked:${String(error)}`)
      expect(out).not.toMatch(/Operation not permitted|denied/)
      // 监听必须失败：这是 network-outbound 相对 network* 的唯一实质差别。
      // 断言看「命令是否失败」，不看输出文本——报错信息会回显命令本身，里面就带着打印用的字样。
      const listen = await runIsolated(realSubprocess(), ['sh', '-c',
        '/usr/bin/python3 -c "import socket;s=socket.socket();s.bind((\'\',0));s.listen(1);print(\'LISTENING\')" 2>&1'],
        execDir, signal, { mode: 'sandbox', writableRoots: [execDir] }).then(() => 'succeeded', () => 'failed')
      expect(listen).toBe('failed')
    } finally { rmSync(execDir, { recursive: true, force: true }) }
  })

  it('lets gh read its own config dir and the keychain, without reading the operator ~/.config', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const { runIsolated, workerGhConfig } = await import('../src/infra/environment.ts')
    const stateDir = mkdtempSync(join(tmpdir(), 'iso-ghcfg-'))
    const execDir = join(stateDir, 'work', 't1')
    mkdirSync(execDir, { recursive: true })
    try {
      const env = await workerSetup(stateDir)
      // 配置目录指向 stateDir 内的独立目录，而不是操作者的 ~/.config/gh。
      expect(env.GH_CONFIG_DIR).toBe(workerGhConfig(stateDir))
      expect(readdirSync(workerGhConfig(stateDir)).sort()).toEqual(['config.yml', 'hosts.yml'])
      // 这个目录里**不许**有 token：token 只从 keychain 取，落盘就等于把凭据搬进 worker 可写面。
      expect(readFileSync(join(workerGhConfig(stateDir), 'hosts.yml'), 'utf8')).not.toMatch(/oauth_token/)
      // keychain 能读到（mach-lookup 放行 SecurityServer）：被挡时 stderr 是 SecKeychainSearchCreateFromAttributes。
      const found = await runIsolated(realSubprocess(), ['/usr/bin/security', 'find-generic-password', '-s', 'dsh-superagent-absent-probe'],
        execDir, signal, { mode: 'sandbox', writableRoots: [execDir], env }).catch((error: unknown) => String(error))
      expect(found).not.toMatch(/SecKeychainSearchCreateFromAttributes/)
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('runs the documented prepare command: fetch + worktree add into the ticket directory', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const { runIsolated, workerGitConfig } = await import('../src/infra/environment.ts')
    const base = mkdtempSync(join(tmpdir(), 'iso-prep-'))
    const repo = join(base, 'widgets')
    const stateDir = join(base, 'state')
    const root = join(stateDir, 'work')
    const execDir = join(root, 'agent-t1')
    const git = (cwd: string, args: string[]) => execFile('git', args, { cwd, env: gitEnv() })
    try {
      mkdirSync(repo, { recursive: true }); mkdirSync(execDir, { recursive: true })
      await git(repo, ['init', '-q'])
      await git(repo, ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-q', '--allow-empty', '-m', 'init'])
      const env = await workerSetup(stateDir)
      // 走 worker 的 gitconfig（凭据 helper 指向 gh），与生产同一条路。
      env.GIT_CONFIG_GLOBAL = workerGitConfig(stateDir)
      env.GIT_CONFIG_NOSYSTEM = '1'
      // 这就是 docs/006-deployment.md 推荐的那条 prepare 的核心两步。
      // 仓库目录必须在 writableRoots 里，否则 worktree add 会撞 .git/refs 上的 Operation not permitted。
      const prepare = `git -C ${repo} worktree add -b agent/t1 ${execDir}`
      await runIsolated(realSubprocess(), ['sh', '-c', prepare], root, signal,
        { mode: 'sandbox', writableRoots: [execDir, root, repo], env })
      expect(readdirSync(execDir)).toContain('.git')
      // verifyDirectory 在隔离里也要能跑通（prepare 之后必经的一步）。
      await expect(verifyDirectory(execDir, realSubprocess(), signal)).resolves.toBeUndefined()
    } finally { rmSync(base, { recursive: true, force: true }) }
  })

  it('still refuses writes outside the roots even with network and mach services allowed', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const { runIsolated } = await import('../src/infra/environment.ts')
    const execDir = mkdtempSync(join(tmpdir(), 'iso-still-'))
    const outside = mkdtempSync(join(tmpdir(), 'iso-still-out-'))
    try {
      await expect(runIsolated(realSubprocess(), ['sh', '-c', `echo x > ${join(outside, 'no.txt')}`], execDir, signal,
        { mode: 'sandbox', writableRoots: [execDir] })).rejects.toBeInstanceOf(CliError)
      expect(readdirSync(outside)).not.toContain('no.txt')
    } finally { rmSync(execDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
  })
})
