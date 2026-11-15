// Full E2E: real DSH AgentLoop turn -> real tools.execute -> per-session worker isolation.
// Real DSH service classes; deterministic scripted LlmAdapter (no external model). Canaries in temp HOME.
//
// Local scopes mirror the worker preset in backend/cordis.patch.yml:
//  - root keeps the DEFAULT fs/sandbox/subprocess (router/root none control).
//  - a "worker" scope isolates {fs,sandbox} (WorkerFileSystem + WorkerSandboxProvider) and
//    {subprocess} (WorkerSearchSubprocess), and mounts tool-fs / tool-fs-search inside it,
//    while tool-bash/shell live in a sibling {shell,sandbox} scope — exactly the preset layout.
// Resolve DSH real packages from the installed app bundle (env DSH_NODE_MODULES overrides),
// and the Worker* modules from this repo's build (env WBFS_BUILD overrides).
// Run with the bundled node so ESM resolution + sandbox-exec match production:
//   DSH_NODE_MODULES="/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules" \
//   WBFS_BUILD=/tmp/wbfs-build node backend/tests/worker-runtime/real-agent-tool-dispatch.e2e.mjs
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH = process.env.DSH_NODE_MODULES ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules'
const WBFS = process.env.WBFS_BUILD ?? '/tmp/wbfs-build'
const imp = (name) => import(new URL(`./${name}`, `file://${join(DSH, '@deepseek-ai')}/`).href)
const dsh = async (name) => import(join(DSH, '@deepseek-ai', name, 'lib', 'index.js'))
// app lib files are ESM with their own resolution base; import by absolute file URL.
const M = {}
for (const [k, name] of Object.entries({
  cordis: 'cordis', projections: 'dsh-session-projection', subprocess: 'dsh-subprocess-local',
  fsSandbox: 'dsh-fs-sandbox', sandboxLocal: 'dsh-sandbox-local', sandboxPolicy: 'dsh-sandbox-policy',
  session: 'dsh-session', systemPrompt: 'dsh-system-prompt', tools: 'dsh-tools', llm: 'dsh-llm',
  agent: 'dsh-agent', agentLoop: 'dsh-agent-loop', permissionPresets: 'dsh-permission-presets',
  approval: 'dsh-user-approval', attachLocal: 'dsh-attachment-local', bashSandbox: 'dsh-bash-sandbox',
  shellEnv: 'dsh-shell-env', workingDir: 'dsh-working-directory', toolFs: 'dsh-tool-fs',
  toolBash: 'dsh-tool-bash', toolFsSearch: 'dsh-tool-fs-search', nativeExec: 'dsh-tool-executor-native',
})) M[k] = await dsh(name)
const { apply: jsonlPersistence } = await dsh('dsh-session-persistence-jsonl')

const { Context } = M.cordis
const SessionProjections = M.projections.default
const SubprocessLocal = M.subprocess.default
const SandboxedFileSystem = M.fsSandbox.default
const LocalSandbox = M.sandboxLocal.default
const SandboxPolicyService = M.sandboxPolicy.default
const SessionStore = M.session.default
const SystemPrompt = M.systemPrompt.default
const ToolsService = M.tools.default
const nativeExecutorMod = M.nativeExec
const LlmRuntime = M.llm.default
const { LlmAdapter, createUserMessage } = M.llm
const AgentRegistry = M.agent.default
const AgentLoop = M.agentLoop.default
const PermissionPresetService = M.permissionPresets.default
const ApprovalService = M.approval.default
const LocalAttachmentStore = M.attachLocal.default
const SandboxBashExecutor = M.bashSandbox.default
const shellEnvMod = M.shellEnv
const WorkingDirectory = M.workingDir.default
const toolFsPlugin = M.toolFs
const toolBashPlugin = M.toolBash
const toolFsSearchPlugin = M.toolFsSearch

const { default: WorkerSandboxProvider } = await import(join(WBFS, 'worker-sandbox.js'))
const { default: WorkerFileSystem } = await import(join(WBFS, 'worker-fs.js'))
const { default: WorkerSearchSubprocess } = await import(join(WBFS, 'worker-search-subprocess.js'))

const HOME = mkdtempSync(join(tmpdir(), 'e2e-home-'))
const WS = mkdtempSync(join(tmpdir(), 'e2e-ws-'))
const STATE = mkdtempSync(join(tmpdir(), 'e2e-state-'))
mkdirSync(join(HOME, '.ssh'))
writeFileSync(join(HOME, '.ssh', 'id_ed25519'), 'CANARY-SSH-NOT-REAL\n')
writeFileSync(join(WS, 'note.txt'), 'WORKSPACE-OK\n')
writeFileSync(join(WS, 'pixel.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'))
symlinkSync(join(HOME, '.ssh', 'id_ed25519'), join(WS, 'evil-link'))

const log = (...a) => console.log('[e2e]', ...a)
let failed = false
const check = (name, pass, detail = '') => { log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? '  ' + detail : ''}`); if (!pass) failed = true }

// —— scripted deterministic LLM adapter ——
const SCRIPT = [
  { name: 'read',       args: () => ({ file_path: join(WS, 'note.txt') }),             tag: 'read-ws' },
  { name: 'read',       args: () => ({ file_path: join(HOME, '.ssh', 'id_ed25519') }), tag: 'read-ssh' },
  { name: 'read',       args: () => ({ file_path: join(WS, 'evil-link') }),            tag: 'read-symlink-ssh' },
  { name: 'read_image', args: () => ({ file_path: join(WS, 'pixel.png') }),            tag: 'read-image-ws' },
  { name: 'glob',       args: () => ({ pattern: '**/*.txt', path: WS }),               tag: 'glob-ws' },
  { name: 'grep',       args: () => ({ pattern: 'CANARY', path: join(HOME, '.ssh') }), tag: 'grep-ssh' },
  { name: 'bash',       args: () => ({ command: `cat ${JSON.stringify(join(HOME, '.ssh', 'id_ed25519'))}`, description: 'read ssh key' }), tag: 'bash-ssh' },
  { name: 'bash',       args: () => ({ command: 'echo hi-from-bash', description: 'echo test' }),                tag: 'bash-ok' },
]
class ScriptedAdapter extends LlmAdapter {
  async * stream(options) {
    const n = options.messages.filter(m => m.role === 'tool').length
    const step = SCRIPT[n]
    if (!step) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'completed' } }
      return
    }
    const id = `call-${n}`
    const args = JSON.stringify(step.args())
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

const fibers = []
const plug = (label, p) => { try { fibers.push(p()) } catch (e) { log('plugin-fail', label, e?.message || e); throw e } }
const plugObj = (label, obj) => plug(label, () => ctx.plugin(obj))

const ctx = new Context()

// —— root plane (default providers == router/root none control) ——
plug('projections', () => ctx.plugin(SessionProjections))
plug('subprocess', () => ctx.plugin(SubprocessLocal))
plug('sandboxPolicy', () => ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: WS }))
plug('sandbox', () => ctx.plugin(LocalSandbox, {}))
plug('fs', () => ctx.plugin(SandboxedFileSystem, { cwd: WS }))
plug('sessions', () => ctx.plugin(SessionStore))
plug('systemPrompt', () => ctx.plugin(SystemPrompt))
plug('tools', () => ctx.plugin(ToolsService))
plug('llm', () => ctx.plugin(LlmRuntime))
plug('toolExecutor', () => ctx.plugin({ name:'native-tool-executor', inject: nativeExecutorMod.inject, apply:(c)=>nativeExecutorMod.apply(c) }))
plug('rootShellEnv', () => ctx.plugin({ name:'root-shell-env', inject: shellEnvMod.inject, apply:(c)=>shellEnvMod.apply(c, shellEnvMod.Config({})) }))
plug('rootShell', () => ctx.plugin(SandboxBashExecutor, { cwd: WS, timeoutMs: 10000, maxTimeoutMs: 10000 }))
plug('workingDirectory', () => ctx.plugin(WorkingDirectory))
plug('approval', () => ctx.plugin(ApprovalService, {}))
plug('permissions', () => ctx.plugin(PermissionPresetService, { presets: {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'never' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
}, defaultPreset: 'workspace-write' }))
plug('agents', () => ctx.plugin(AgentRegistry))
plug('agentLoop', () => ctx.plugin(AgentLoop))
await jsonlPersistence(ctx, { root: STATE })
for (const [i,f] of fibers.entries()) { try { await f } catch(e){ log('fiber-err', i, e?.message||e) } }
await ctx.fiber.await()

const rootFsName = ctx.get('fs')?.constructor?.name
const rootSbName = ctx.get('sandbox')?.constructor?.name
check('root fs 保持默认 SandboxedFileSystem（router/root none 对照）', rootFsName === 'SandboxedFileSystem', rootFsName)
check('root sandbox 保持默认 LocalSandboxProvider（router/root none 对照）', rootSbName === 'LocalSandboxProvider', rootSbName)


// —— worker scope built per-agent in setup (mirrors preset composition) ——
const agents = ctx.get('agents')
log('agentLoop=', !!ctx.get('agentLoop'))
ctx.llm.registerAdapter(['wb2stub'], new ScriptedAdapter())

function buildWorkerSetup(scopes) {
  return async (agentCtx, agent) => {
    const extra = []
    const fsScope = agentCtx.isolate('fs').isolate('sandbox')
    const shellScope = agentCtx.isolate('shell').isolate('sandbox')
    const searchScope = agentCtx.isolate('subprocess')
    scopes.fsScope = fsScope
    // fs scope: WorkerFileSystem + WorkerSandboxProvider + tool-fs
    fsScope.plugin(WorkerSandboxProvider, { sensitiveHome: HOME })
    fsScope.plugin(WorkerFileSystem, { sensitiveHome: HOME })
    fsScope.plugin(LocalAttachmentStore, { root: join(STATE, "attachments-scope") })
    fsScope.plugin({ name: 'tool-fs', inject: toolFsPlugin.inject, apply: (c) => toolFsPlugin.apply(c, toolFsPlugin.Config({ write: false, edit: false, read: true, readImage: true, applyPatch: false })) })
    // shell scope: WorkerSandboxProvider + SandboxBashExecutor + tool-bash (+shell-env)
    shellScope.plugin(WorkerSandboxProvider, { sensitiveHome: HOME })
    shellScope.plugin({ name: 'shell-env', inject: shellEnvMod.inject, apply: (c) => shellEnvMod.apply(c, shellEnvMod.Config({})) })
    shellScope.plugin(SandboxBashExecutor, { cwd: WS, timeoutMs: 10000, maxTimeoutMs: 10000 })
    shellScope.plugin({ name: 'tool-bash', inject: toolBashPlugin.inject, apply: (c) => toolBashPlugin.apply(c, toolBashPlugin.Config({})) })
    // search scope: WorkerSearchSubprocess + tool-fs-search
    searchScope.plugin(WorkerSearchSubprocess, { sensitiveHome: HOME })
    searchScope.plugin({ name: 'tool-fs-search', inject: toolFsSearchPlugin.inject, apply: (c) => toolFsSearchPlugin.apply(c, toolFsSearchPlugin.Config({ sampleOverCapGlobResults: false })) })
    try { await fsScope } catch(e){ log('SCOPE-ERR fs', e?.message||e) }
    try { await shellScope } catch(e){ log('SCOPE-ERR shell', e?.message||e) }
    try { await searchScope } catch(e){ log('SCOPE-ERR search', e?.message||e) }
    for (const f of extra) { try { await f } catch(e){ log('SCOPE-ERR extra', e?.message||e) } }
    log('tools in agentCtx:', JSON.stringify((agentCtx.get('tools')?.view?.({scope: undefined})?.knownNames) ?? 'n/a'))
  }
}

let __sid=0
async function runScenario(label, preset) {
  const sessionId = `session-${label}-${++__sid}`
  const scopes = {}
  const handle = await agents.create({
    sessionId, meta: { cwd: WS }, agentOptions: { provider: 'wb2stub', model: 'wb2stub-1' },
    setup: buildWorkerSetup(scopes),
  })
  const agent = handle.agent
  ctx.get('permissionPresets').set(agent.session, preset)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const evs = agent.session.snapshotEvents()
  const tools = evs.filter(e => e.type === 'tool/result').map(e => ({ seq: e.seq, data: e.data }))
  return { tools, scopes, agent }
}

function cleanup(){ for(const d of [HOME,WS,STATE]) try{ rmSync(d,{recursive:true,force:true}) }catch{} }
// ---------- analysis helpers ----------
const tagByCall = SCRIPT.map((x,i)=>({call:`call-${i}`, tag:x.tag}))
const tagMap = Object.fromEntries(tagByCall.map(x=>[x.call, x.tag]))
function byTag(tools){ const o={}; for(const t of tools){ const id=t.data?.message?.toolCallId; o[tagMap[id]]=t } return o }
const txt = (t) => JSON.stringify(t?.data?.message?.content ?? '')
const isErr = (t) => t?.data?.message?.isError === true

function assertConfining(tools, label){
  const b = byTag(tools)
  log(`--- ${label}: per-tool ---`)
  for (const [tag,t] of Object.entries(b)) log(`  ${tag}: isError=${isErr(t)} :: ${txt(t).slice(0,140)}`)
  check(`[${label}] read 工作区成功（正对照）`, !!b['read-ws'] && !isErr(b['read-ws']) && /WORKSPACE-OK/.test(txt(b['read-ws'])))
  check(`[${label}] read ~/.ssh 被拒（负对照）`, !!b['read-ssh'] && isErr(b['read-ssh']) && !/CANARY-SSH/.test(txt(b['read-ssh'])))
  check(`[${label}] read 工作区 symlink→~/.ssh 被拒（TOCTOU）`, !!b['read-symlink-ssh'] && isErr(b['read-symlink-ssh']) && !/CANARY-SSH/.test(txt(b['read-symlink-ssh'])))
  check(`[${label}] read_image 未因沙箱被拒（模型能力边界除外）`, !!b['read-image-ws'] && !/denied under the worker file sandbox/.test(txt(b['read-image-ws'])))
  check(`[${label}] glob 工作区命中`, !!b['glob-ws'] && /note\.txt/.test(txt(b['glob-ws'])))
  check(`[${label}] grep ~/.ssh 被拒（不泄 CANARY）`, !!b['grep-ssh'] && !/CANARY-SSH/.test(txt(b['grep-ssh'])))
  check(`[${label}] bash cat ~/.ssh 被拒（不泄 CANARY）`, !!b['bash-ssh'] && !/CANARY-SSH/.test(txt(b['bash-ssh'])))
  check(`[${label}] bash 正常工作区命令成功（正对照）`, !!b['bash-ok'] && /hi-from-bash/.test(txt(b['bash-ok'])))
}

log('=== scenario A: workspace-write (confining) ===')
const r1 = await runScenario('sandbox', 'workspace-write')
check('worker fs scope fs = WorkerFileSystem（局部接线）', r1.scopes.fsScope?.get('fs')?.constructor?.name === 'WorkerFileSystem')
check('worker fs scope sandbox = WorkerSandboxProvider', r1.scopes.fsScope?.get('sandbox')?.constructor?.name === 'WorkerSandboxProvider')
const hdr1 = r1.agent.session.snapshotEvents().find(e=>e.type==='request/header')
check('五个工具都对模型可见（read/read_image/glob/grep/bash）', ['read','read_image','glob','grep','bash'].every(n=>(hdr1?.data?.header?.tools||[]).some(t=>t.name===n)), JSON.stringify((hdr1?.data?.header?.tools||[]).map(t=>t.name)))
assertConfining(r1.tools, 'A/workspace-write')

log('=== scenario B: danger-full-access (none 对照，session 真 SID) ===')
const r2 = await runScenario('none', 'danger-full-access')
// In none mode, the SAME worker scope still exists but session mode none → reads pass through.
const b2 = byTag(r2.tools)
check('[B/none] read ~/.ssh 照读（none 透传，不被 A 的 mode 污染）', !!b2['read-ssh'] && /CANARY-SSH/.test(txt(b2['read-ssh'])))
check('[B/none] grep ~/.ssh 照搜（含 CANARY，none 不隔离）', !!b2['grep-ssh'] && /CANARY-SSH/.test(txt(b2['grep-ssh'])))
check('[B/none] bash cat ~/.ssh 照读（含 CANARY）', !!b2['bash-ssh'] && /CANARY-SSH/.test(txt(b2['bash-ssh'])))

log('=== scenario C: per-session 并发不串（A sandbox + B none 同时跑） ===')
const [ca, cb] = await Promise.all([runScenario('sandbox', 'workspace-write'), runScenario('none', 'danger-full-access')])
const cba = byTag(ca.tools), cbb = byTag(cb.tools)
check('[C] 并发 A(sandbox) 读 ~/.ssh 被拒', !!cba['read-ssh'] && !/CANARY-SSH/.test(txt(cba['read-ssh'])))
check('[C] 并发 B(none) 读 ~/.ssh 照读', !!cbb['read-ssh'] && /CANARY-SSH/.test(txt(cbb['read-ssh'])))
check('[C] 并发 A 读工作区 OK', !!cba['read-ws'] && /WORKSPACE-OK/.test(txt(cba['read-ws'])))
check('[C] 并发 B 读工作区 OK', !!cbb['read-ws'] && /WORKSPACE-OK/.test(txt(cbb['read-ws'])))

cleanup()
log('RESULT:', failed ? 'SOME FAILED' : 'ALL PASS')
process.exit(failed ? 1 : 0)
