/**
 * 独立临时实例的 resolver 证明（#22）：不启动整个 crew backend，只搭最小 Cordis 应用，
 * 1) 在 root 放一个「默认」sandbox provider（记为 default）；
 * 2) 在一个 isolate 了 `sandbox` 的 group 里挂 backend 的 WorkerSandboxProvider + 真 SandboxBashExecutor；
 * 3) 断言 group 内 bash-sandbox 解析到 WorkerSandboxProvider（不是 default），root 仍是 default；
 * 4) 用 workspace-write 策略经 group 的 shell 真跑一条 bash：读临时 HOME 里的假凭据被拒、读/写工作区可用、越界写被拒。
 * 全 canary 在临时 HOME（假 token），realpath 由 sandboxArgv/sensitivePaths 处理。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import WorkerSandboxProvider from '/Users/cpuser/Code/dsh-bot-crew/backend/lib/worker-sandbox.js'

const log = (...a) => console.log('[proof]', ...a)
const fail = (m) => { console.error('[proof][FAIL]', m); process.exitCode = 1 }

const home = mkdtempSync(join(tmpdir(), 'proof-home-'))
const ws = mkdtempSync(join(tmpdir(), 'proof-ws-'))
const outside = mkdtempSync(join(tmpdir(), 'proof-out-'))
mkdirSync(join(home, '.ssh')); writeFileSync(join(home, '.ssh', 'id_ed25519'), 'CANARY-SSH-NOT-REAL\n')
mkdirSync(join(home, '.config')); writeFileSync(join(home, '.config', 'gh-hosts.yml'), 'CANARY-GH-NOT-REAL\n')
writeFileSync(join(ws, 'note.txt'), 'ws-data\n')

// 「默认」provider：只用来证明 isolate 生效（它存在，但 group 里不该被解析到）
class DefaultSandbox extends SandboxProvider {
  constructor(ctx) { super(ctx, 'sandbox'); this.tag = 'default' }
  async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] } }
}

const ctx = new Context()
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SubprocessLocal)
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: ws })
await ctx.plugin(DefaultSandbox)

// 隔离 group：sandbox 独立
const group = ctx.isolate('sandbox')
await group.plugin(WorkerSandboxProvider, { sensitiveHome: home })
await group.plugin(SandboxBashExecutor, { timeoutMs: 50000, maxTimeoutMs: 50000 })

const rootSandbox = ctx.get('sandbox')
const groupSandbox = group.get('sandbox')
log('root sandbox tag:', rootSandbox?.tag ?? rootSandbox?.constructor?.name)
log('group sandbox is WorkerSandboxProvider:', groupSandbox instanceof WorkerSandboxProvider)
if (rootSandbox instanceof WorkerSandboxProvider) fail('root 不应是 WorkerSandboxProvider（isolate 失效）')
if (!(groupSandbox instanceof WorkerSandboxProvider)) fail('group 没解析到 WorkerSandboxProvider')

// group 里的 shell 就是 SandboxBashExecutor（bash-sandbox 注入 group 的 sandbox）
const shell = group.get('shell')
log('group shell is SandboxBashExecutor:', shell instanceof SandboxBashExecutor)
if (!(shell instanceof SandboxBashExecutor)) fail('group shell 不是 SandboxBashExecutor')

const run = async (command) => {
  const spec = shell.resolve({ command, cwd: ws })
  const ex = await shell.execute(spec)
  const r = await ex.result()
  return { code: r.exitCode, out: (r.stdout?.text ?? '') + (r.stderr?.text ?? ''), sandbox: r.sandbox }
}

const cases = []
// 1) 读工作区：允许
{
  const r = await run(`cat '${join(ws,'note.txt')}'`)
  cases.push(['读工作区 note.txt', r.code === 0 && r.out.includes('ws-data'), r])
}
// 2) 写工作区：允许
{
  const r = await run(`echo ok > '${join(ws, 'out.txt')}'`)
  cases.push(['写工作区 out.txt', r.code === 0, r])
}
// 3) 读临时 HOME 里的假凭据：拒
{
  const r = await run(`cat '${join(home, '.ssh', 'id_ed25519')}'`)
  cases.push(['读 ~/.ssh/id_ed25519 被拒', r.code !== 0 && !r.out.includes('CANARY-'), r])
}
{
  const r = await run(`cat '${join(home, '.config', 'gh-hosts.yml')}'`)
  cases.push(['读 ~/.config/gh-hosts.yml 被拒', r.code !== 0 && !r.out.includes('CANARY-'), r])
}
// 4) 越界写：拒
{
  const r = await run(`echo x > '${join(outside, 'evil.txt')}'`)
  cases.push(['越界写被拒', r.code !== 0, r])
}

let ok = true
for (const [name, pass, r] of cases) {
  log(`${pass ? 'PASS' : 'FAIL'} — ${name}  (code=${r.code}, sandbox=${JSON.stringify(r.sandbox)})`)
  if (!pass) { ok = false; log('   out:', r.out.slice(0, 200)) }
}
rmSync(home, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true })
log(ok && !process.exitCode ? 'ALL PASS' : 'SOME FAILED')
process.exit(ok && !process.exitCode ? 0 : 1)
