/**
 * prepare 沙箱的凭据 deny 覆盖（#26）。
 *
 * 这里的每一条都真跑 `sandbox-exec`，canary 全部造在临时 HOME 里（假 token），**不读操作者的
 * 真实凭据、不读真实 shell 历史**。断言只看「被拒 / 可读」与 exit 码，不看内容。
 *
 * 正对照（workspace 正常读写）与负对照（每个凭据载体被拒）成对存在：只有负对照没有正对照，
 * 「全被拒」和「沙箱根本没起来」分不开。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepareVariables, runIsolated, sandboxAvailable, sandboxArgv, sensitivePaths, verifyDirectory, workerGitConfig, writeEnvironment }
  from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'
import { realSubprocess } from './fixtures/subprocess.ts'

vi.setConfig({ testTimeout: 60_000 })
const signal = new AbortController().signal
/** 假 HOME：里面每个凭据载体放一行 canary 文本。 */
const canaryHome = (): string => mkdtempSync(join(tmpdir(), 'creds-home-'))
const token = (name: string): string => `CANARY-${name}-NOT-A-REAL-TOKEN`

/** 跑一条已经包好 sandbox-exec 的 argv，返回退出码与合并输出（成功失败都返回）。 */
async function run(subprocess: ReturnType<typeof realSubprocess>, argv: string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; text: string }> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, env,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  return { code: exitCode, text: `${handle.collected.stdout?.readFrom(0).text ?? ''}${handle.collected.stderr?.readFrom(0).text ?? ''}` }
}

/**
 * 用 prepare 那份 profile（`sandboxArgv([execDir], sensitivePaths(home))`）包一条 argv 真跑一次，
 * 返回退出码与 stderr。不抛错：断言要看的是「被拒的原因」和 exit 码本身。
 */
async function sandboxed(execDir: string, home: string, argv: string[]): Promise<{ code: number | null; stderr: string }> {
  const handle = realSubprocess().spawn({ argv: [...sandboxArgv([execDir], sensitivePaths(home)), ...argv], cwd: execDir, graceMs: 2000, signal,
    env: { ...process.env as Record<string, string>, HOME: home },
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  return { code: exitCode, stderr: handle.collected.stderr?.readFrom(0).text ?? '' }
}

/**
 * 读一条路径，返回 `verdict + exit 码`。判定只看退出码与 stderr 的拒绝原因，
 * **不读文件内容、不打印大小**（canary 是假 token，同样不打印）。
 */
async function probe(execDir: string, home: string, path: string): Promise<{ verdict: 'denied' | 'readable' | 'absent'; code: number | null }> {
  const { code, stderr } = await sandboxed(execDir, home, ['/bin/cat', path])
  if (code === 0) return { verdict: 'readable', code }
  // 被沙箱拒 → EPERM（exit 1）；路径真不存在 → ENOENT（exit 1）。两者 exit 码相同，靠 stderr 区分。
  return { verdict: /No such file or directory/.test(stderr) ? 'absent' : 'denied', code }
}

describe('prepare 沙箱的凭据 deny 覆盖', () => {
  it('正对照：workspace 里正常读写，且带空格的路径可用（沙箱确实起来了）', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const home = canaryHome()
    const execDir = mkdtempSync(join(tmpdir(), 'creds-exec-'))
    const spaced = join(execDir, 'dir with space')
    try {
      mkdirSync(spaced, { recursive: true })
      const out = await runIsolated(realSubprocess(),
        ['sh', '-c', `printf 'work' > "${join(spaced, 'note.txt')}" && cat "${join(spaced, 'note.txt')}"`],
        execDir, signal, { mode: 'sandbox', writableRoots: [execDir], readableDeny: sensitivePaths(home), env: { ...process.env as Record<string, string>, HOME: home } })
      expect(out).toBe('work')
      expect(readFileSync(join(spaced, 'note.txt'), 'utf8')).toBe('work')
    } finally { rmSync(execDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })

  it('负对照：按载体类别枚举的每一个凭据路径都被拒（exit 非 0 / Operation not permitted）', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const home = canaryHome()
    const execDir = mkdtempSync(join(tmpdir(), 'creds-exec-'))
    // 造 canary：文件与目录两种形态都要覆盖（`.ssh` 是目录，`.git-credentials` 是文件）。
    const files: Record<string, string> = {
      '.git-credentials': token('git-credentials'),
      '.gitconfig': '[credential]\n\thelper = store\n',
      '.netrc': `machine github.com password ${token('netrc')}`,
      '.npmrc': `//registry.npmjs.org/:_authToken=${token('npmrc')}`,
      '.yarnrc': `_authToken "${token('yarnrc')}"`,
      '.yarnrc.yml': `npmAuthToken: ${token('yarnrc-yml')}`,
      '.pypirc': `password = ${token('pypirc')}`,
      '.vault-token': token('vault-token'),
      // `.cargo` 下两个文件各是一条名单项（旧格式 `credentials`、新格式 `credentials.toml`），
      // 目录→文件名映射只能表达一层，所以两条都直接列在这里。
      '.cargo/credentials': token('cargo-legacy'),
      '.cargo/credentials.toml': token('cargo-toml'),
      '.zsh_history': ': 1700000000:0;export GH_TOKEN=' + token('zsh'),
      '.bash_history': `export GH_TOKEN=${token('bash')}`,
    }
    const dirs: Record<string, string> = {
      '.ssh': 'id_ed25519', '.gnupg': 'secring.gpg', '.aws': 'credentials',
      '.kube': 'config', '.docker': 'config.json', '.config/gh': 'hosts.yml', '.config/gcloud': 'credentials.db',
      // `.azure` 下两个文件分别造：`msal_token_cache.json` 是 #26 正文点名的 refresh token 落盘处。
      '.azure': 'azureProfile.json', '.azure/msal': 'msal_token_cache.json',
      // issue #26 正文点名的旧版 npm 落盘位置（子目录形态，和 `.npmrc` 分开造）。
      '.npm': '_authToken',
      '.gem': 'credentials', '.m2': 'settings.xml', '.password-store': 'github.gpg',
      '.zsh_sessions': 'session.history',
    }
    try {
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(dirname(join(home, name)), { recursive: true })
        writeFileSync(join(home, name), body)
      }
      for (const [name, file] of Object.entries(dirs)) {
        mkdirSync(join(home, name), { recursive: true })
        writeFileSync(join(home, name, file), token(name))
      }
      const paths = [...Object.keys(files), ...Object.entries(dirs).map(([name, file]) => join(name, file))]
        .map(name => join(home, name))
      // 名单与 canary 必须双向对齐（canary 可以造在名单路径之下，如 `.zsh_sessions/session.history`）：
      // ① 名单里每一条都至少有一个 canary 落在它上面或其下 —— 防止「加了 deny 路径但没人测」；
      // ② 每个 canary 都落在某条名单路径之下 —— 防止 canary 造到名单外、测了个没被 deny 的东西。
      // 这条防的是「文档写 24 条、代码里 26 条、测试只覆盖 20 条」这类漂移。
      const listed = sensitivePaths(home)
      const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`)
      for (const root of listed) expect(paths.some(path => under(path, root)), `no canary for ${root}`).toBe(true)
      for (const path of paths) expect(listed.some(root => under(path, root)), `canary outside the list: ${path}`).toBe(true)
      const results = await Promise.all(paths.map(path => probe(execDir, home, path)))
      // 逐个报「路径 → verdict + exit 码」，别只给一句「有一个失败了」。
      // exit 码固定为 1（EPERM 与 ENOENT 都是 1，所以 verdict 由 stderr 区分）。
      expect(paths.map((path, index) => [path.replace(home, '~'), results[index]!.verdict, results[index]!.code]))
        .toEqual(paths.map(path => [path.replace(home, '~'), 'denied', 1]))
    } finally { rmSync(execDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })

  it('名单外的普通文件仍可读（deny 是定向的，不是把整个 HOME 关掉）', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const home = canaryHome()
    const execDir = mkdtempSync(join(tmpdir(), 'creds-exec-'))
    try {
      writeFileSync(join(home, 'notes.txt'), 'ORDINARY')
      const ordinary = await probe(execDir, home, join(home, 'notes.txt'))
      expect(ordinary.verdict).toBe('readable')
      expect(ordinary.code).toBe(0)
    } finally { rmSync(execDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })

  it('不存在的路径也进 profile：祖先 realpath 解析后才是内核匹配的形态（符号链接前缀会让 deny 静默失效）', () => {
    // `/var` 在 macOS 上是指向 `/private/var` 的符号链接；不解析前缀，deny 写进去也匹配不上。
    const profile = sandboxArgv([], ['/var/tmp/dsh-canary-absent/.kube/config'])[2]!
    expect(profile).toContain('(deny file-read* (subpath "/private/var/tmp/dsh-canary-absent/.kube/config"))')
    // 尚不存在的路径不许让 profile 校验失败：整条 argv 仍可执行。
    expect(profile).toContain('(deny default)')
  })

  it('profile 造好时还不存在的凭据文件，之后建出来仍读不到（符号链接前缀不许让 deny 静默失效）', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    // tmpdir 在 macOS 上是 `/var/folders/...`，内核看到的是 `/private/var/folders/...`。
    // 凭据文件常常「现在还没有」，而 profile 是一次性造好的：路径必须先解析掉符号链接前缀，
    // 否则 deny 在整段沙箱生命周期里都匹配不上（实测 deny 写 `/var/...` 时读成功）。
    const home = canaryHome()
    const execDir = mkdtempSync(join(tmpdir(), 'creds-exec-'))
    const npmrc = join(home, '.npmrc')
    try {
      expect(existsSync(npmrc)).toBe(false)
      // 关键：profile 只造这一次，此时 .npmrc 还不存在。
      const argv = [...sandboxArgv([execDir, home], sensitivePaths(home)), 'sh', '-c', `printf 'CANARY=1' > ${npmrc}; cat ${npmrc}`]
      const outcome = await run(realSubprocess(), argv, execDir, { ...process.env as Record<string, string>, HOME: home })
      expect(existsSync(npmrc)).toBe(true)
      expect(outcome.text).toMatch(/Operation not permitted/)
      expect(outcome.code).toBe(1)
    } finally { rmSync(execDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })

  it('带空格的凭据路径照样被拒', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const home = mkdtempSync(join(tmpdir(), 'creds home space '))
    const execDir = mkdtempSync(join(tmpdir(), 'creds-exec-'))
    try {
      writeFileSync(join(home, '.git-credentials'), token('spaced'))
      // 走同一个 sensitivePaths 形态：把带空格的 HOME 交给它。
      const result = await probe(execDir, home, join(home, '.git-credentials'))
      expect(result.verdict).toBe('denied')
      expect(result.code).toBe(1)
    } finally { rmSync(execDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })
})

describe('prepare 的真实执行路径：凭据被拒的同时 git 仍然工作', () => {
  it('跑 prepareVariables + sensitivePaths 后，git init / config 成功，而 ~/.gitconfig 读不到', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const base = mkdtempSync(join(tmpdir(), 'prep-e2e-'))
    const home = join(base, 'home')
    const stateDir = join(base, 'state')
    const execDir = join(stateDir, 'work', 'agent-t1')
    try {
      mkdirSync(home, { recursive: true })
      mkdirSync(execDir, { recursive: true })
      // 假 HOME 里的 ~/.gitconfig 带一个会泄凭据的 helper：它必须读不到。
      writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = store --file=${token('helper')}\n`)
      await writeEnvironment(testDeployment({ stateDir }), [])
      const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, ...prepareVariables(stateDir) }
      // 与 prepare 调用点同一组参数：writableRoots 含执行目录与其父，readableDeny 是 sensitivePaths()。
      const run = (argv: string[]): Promise<string> => runIsolated(realSubprocess(), argv, execDir, signal,
        { mode: 'sandbox', writableRoots: [execDir, join(stateDir, 'work')], readableDeny: sensitivePaths(home), env })
      // ① git 在没有 ~/.gitconfig 的情况下也能初始化并读配置（靠 GIT_CONFIG_GLOBAL 指到 stateDir 那份）。
      expect(env.GIT_CONFIG_GLOBAL).toBe(workerGitConfig(stateDir))
      await run(['git', 'init', '-q'])
      expect(readFileSync(join(execDir, '.git', 'HEAD'), 'utf8')).toContain('ref: refs/heads/')
      expect((await run(['git', 'config', '--get', 'user.useConfigOnly'])).trim()).toBe('true')
      // ② 同一次运行里，操作者的 ~/.gitconfig 读不到。
      await expect(run(['/bin/cat', join(home, '.gitconfig')])).rejects.toThrow(/Operation not permitted/)
    } finally { rmSync(base, { recursive: true, force: true }) }
  })

  it('推荐的 prepare（worktree add）在完整 deny 名单下仍成功，同一条命令里凭据读不到', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    const base = mkdtempSync(join(tmpdir(), 'prep-worktree-'))
    const home = join(base, 'home')
    const repo = join(base, 'widgets')
    const stateDir = join(base, 'state')
    const root = join(stateDir, 'work')
    const execDir = join(root, 'agent-t1')
    try {
      mkdirSync(home, { recursive: true }); mkdirSync(repo, { recursive: true }); mkdirSync(execDir, { recursive: true })
      // 假 HOME 里放一份「会泄凭据」的 git 配置：credential helper 指向一个假 token 文件。
      writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = store --file=${join(home, '.git-credentials')}\n`)
      writeFileSync(join(home, '.git-credentials'), `https://canary:${token('wt')}@github.com\n`)
      const git = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
        execFile('git', args, { cwd: repo, env: gitEnv() }, (error, stdout) => error ? reject(error) : resolve(String(stdout)))
      })
      await git(['init', '-q'])
      await git(['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-q', '--allow-empty', '-m', 'init'])
      await writeEnvironment(testDeployment({ stateDir }), [])
      const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, ...prepareVariables(stateDir) }
      // 与 prepare 调用点同一组参数：writableRoots 含执行目录、其父与仓库；readableDeny 是 sensitivePaths(home)。
      const run = (command: string): Promise<string> => runIsolated(realSubprocess(), ['sh', '-c', command], root, signal,
        { mode: 'sandbox', writableRoots: [execDir, root, repo], readableDeny: sensitivePaths(home), env })
      // ① 推荐的那条 prepare 的核心两步：在完整 deny 名单下必须成功。
      await run(`git -C ${repo} worktree add -b agent/t1 ${execDir}`)
      expect(readdirSync(execDir)).toContain('.git')
      // ② 同一条 prepare 里探凭据：读不到（deny 生效，不是被别的原因挡住）。
      const probeOut = await run(`cat ${join(home, '.git-credentials')} 2>&1; echo "rc=$?"`).catch((error: unknown) => String(error))
      expect(probeOut).toMatch(/Operation not permitted|rc=1/)
      expect(probeOut).not.toContain(token('wt'))
      // ③ prepare 之后必经的 verifyDirectory 也要能跑通。
      await expect(verifyDirectory(execDir, realSubprocess(), signal)).resolves.toBeUndefined()
    } finally { rmSync(base, { recursive: true, force: true }) }
  })

  it('prepare 的调用点真的用了这张名单与这组变量（不是只导出了函数没人用）', async () => {
    const { readFileSync: read } = await import('node:fs')
    const source = read(new URL('../src/executor/dsh.ts', import.meta.url), 'utf8')
    const body = source.slice(source.indexOf('private async prepareDirectory('), source.indexOf('private async launchQueued('))
    // 只钉接线，不钉实现细节：名单来自 sensitivePaths()、git 全局配置来自 prepareVariables()。
    // 这条存在的理由很具体——「schema 里有字段、profile 里没路径」这类静默已经发生过一次。
    expect(body).toContain('readableDeny: sensitivePaths()')
    expect(body).toContain('prepareVariables(this.host.machine.stateDir)')
    expect(body).not.toContain('workerSensitivePaths')
  })

  it('`.gitconfig` 的替换方案有直接证据：deny 原文件会让 git 挂，注入 GIT_CONFIG_GLOBAL 后恢复', async () => {
    if (!sandboxAvailable()) { expect(true).toBe(true); return }
    // 这条是 issue #26 收口线第 2 项「.gitconfig 的替换方案有测试证据」的正面证明：
    // 同一个 profile（deny ~/.gitconfig），只差 GIT_CONFIG_GLOBAL，行为从 128 变成 0。
    const base = mkdtempSync(join(tmpdir(), 'gitconfig-swap-'))
    const home = join(base, 'home')
    const stateDir = join(base, 'state')
    const repo = join(base, 'repo')
    const execDir = join(stateDir, 'work', 'agent-t1')
    try {
      mkdirSync(home, { recursive: true }); mkdirSync(repo, { recursive: true }); mkdirSync(execDir, { recursive: true })
      // 假 HOME 的 ~/.gitconfig 带一个「读不到就说明 deny 生效」的 helper。
      writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = store --file=${join(home, '.git-credentials')}\n`)
      await writeEnvironment(testDeployment({ stateDir }), [])
      // 先把 repo 初始化成真仓库（在沙箱外做，避免把「仓库不存在」的 128 和「配置读不到」的 128 混在一起）。
      await new Promise<void>((resolve, reject) => execFile('git', ['init', '-q'], { cwd: repo, env: gitEnv() }, error => error ? reject(error) : resolve()))
      const without: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
      const with_ = { ...without, ...prepareVariables(stateDir) }
      const runGit = (env: Record<string, string>): Promise<{ code: number | null; text: string }> =>
        run(realSubprocess(), [...sandboxArgv([execDir, repo], sensitivePaths(home)), 'git', '-C', repo, 'status', '--porcelain'], execDir, env)
      // ① 不注入 GIT_CONFIG_GLOBAL：git 读不到 ~/.gitconfig，直接挂（exit 128）。
      const broken = await runGit(without)
      expect(broken.code).not.toBe(0)
      expect(broken.text).toMatch(/Operation not permitted|unable to access/)
      // ② 注入后：同一条命令成功，且用的是 stateDir 里那份**生成**的配置。
      expect(with_.GIT_CONFIG_GLOBAL).toBe(workerGitConfig(stateDir))
      const working = await runGit(with_)
      expect(working.code).toBe(0)
      // ③ 那份配置是生成物，不含任何 token（凭据仍走 keychain）。
      expect(readFileSync(workerGitConfig(stateDir), 'utf8')).not.toMatch(/oauth_token|ghp_|password/i)
    } finally { rmSync(base, { recursive: true, force: true }) }
  })

  it('名单里没有 stateDir 自己的 worker 配置，所以 git 的凭据 helper 仍可用', () => {
    const stateDir = '/tmp/dsh-superagent-creds-state'
    const listed = sensitivePaths('/Users/someone')
    // worker 自己的 gitconfig / gh 配置是「本仓写出去又必须能读」的，不能被 deny 掉。
    expect(listed).not.toContain(workerGitConfig(stateDir))
    expect(listed.some(path => path.startsWith(stateDir))).toBe(false)
  })
})
