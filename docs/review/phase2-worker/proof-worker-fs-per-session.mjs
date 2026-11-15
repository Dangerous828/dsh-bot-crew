/**
 * 真 per-session 证明（lead 硬要求 1+2）：
 * 两个 worker，一个 danger-full-access（none）、一个 workspace-write（sandbox），
 * 用 AsyncLocalStorage 忠实模拟 DSH agents.currentInitiator() 的 initiator 边界，
 * 交替 + 并发在读路径上各自解析自己的 mode：
 *  - sandbox worker 读工作区 OK、读 ~/.ssh 被内核拒；
 *  - none worker 读 ~/.ssh **照读**（不被 sandbox worker 的 mode 污染）；
 *  - 并发交替多次不串。
 * 同时验证 fs/helper 实际拿到的是 WorkerSandboxProvider（read-deny），不是 root 默认 provider。
 */
import { Context } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import WorkerSandboxProvider from '/tmp/wbfs-build/worker-sandbox.js'
import WorkerFileSystem from '/tmp/wbfs-build/worker-fs.js'

const log=(...a)=>console.log('[proof2]',...a); let failed=false
const check=(n,p,d='')=>{log(`${p?'PASS':'FAIL'} — ${n}${d?'  '+d:''}`); if(!p)failed=true}

const home=mkdtempSync(join(tmpdir(),'p2-home-'))
const wsA=mkdtempSync(join(tmpdir(),'p2-wsA-'))  // sandbox worker
const wsB=mkdtempSync(join(tmpdir(),'p2-wsB-'))  // none worker
mkdirSync(join(home,'.ssh')); writeFileSync(join(home,'.ssh','id_ed25519'),'CANARY-SSH-NOT-REAL\n')
writeFileSync(join(wsA,'a.txt'),'A-data\n'); writeFileSync(join(wsB,'b.txt'),'B-data\n')
symlinkSync(join(home,'.ssh','id_ed25519'), join(wsA,'evil-link'))

// 两个假 session，各自的 mode 由 sandboxPolicy.resolve({session}) 决定
const sesA = { id:'sesA', mode:'workspace-write' }
const sesB = { id:'sesB', mode:'danger-full-access' }
const override = new Map([[sesA,'workspace-write'],[sesB,'danger-full-access']])

class DefaultSandbox extends SandboxProvider{constructor(c){super(c,'sandbox');this.tag='default'} async confine(a){return{argv:[...a],enforcement:'full',denialSignatures:[],runnerFailureRules:[]}}}

const ctx=new Context()
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SubprocessLocal)
// sandboxPolicy：真 resolve({session}) 返回 session 的 mode + 该 session 的 workspaceRoot
await ctx.plugin(SandboxPolicyService,{mode:'danger-full-access',workspaceRoot:wsA})
await ctx.plugin(DefaultSandbox)
await ctx.plugin(SandboxedFileSystem,{cwd:wsA})
// 假 agents 服务：currentInitiator() 从 AsyncLocalStorage 取当前 session
const als = new AsyncLocalStorage()
ctx.provide('agents', { currentInitiator(){ const s=als.getStore(); return s? { session:s } : undefined } })
// 覆盖 sandboxPolicy.resolve 用真实 override 表（session -> mode/root）
const pol = ctx.get('sandboxPolicy')
const origResolve = pol.resolve.bind(pol)
pol.resolve = (req={}) => {
  if (req.session && override.has(req.session)) {
    return { mode: override.get(req.session), workspaceRoot: req.session===sesA?wsA:wsB, sessionId: req.session.id }
  }
  return origResolve(req)
}

// 组：isolate fs + sandbox；sandbox 挂 WorkerSandboxProvider（read-deny）
const group = ctx.isolate('fs').isolate('sandbox')
await group.plugin(WorkerSandboxProvider,{sensitiveHome:home})
await group.plugin(WorkerFileSystem,{sensitiveHome:home})
const wfs=group.get('fs')

// 验证 helper 拿到的是 WorkerSandboxProvider（read-deny），不是 root default
check('group sandbox = WorkerSandboxProvider（非 root default）', group.get('sandbox')?.constructor?.name==='WorkerSandboxProvider', group.get('sandbox')?.constructor?.name)

const readAs = (session, p) => als.run(session, async () => { const t=await wfs.resolve(p); return wfs.readText(t) })
const statAs = (session, p) => als.run(session, async () => { const t=await wfs.resolve(p); return wfs.stat(t) })

// 交替
{
  const a = await readAs(sesA, join(wsA,'a.txt'))
  check('A(sandbox) 读自己工作区 OK', a.includes('A-data'))
}
{
  const b = await readAs(sesB, join(wsB,'b.txt'))
  check('B(none) 读自己工作区 OK', b.includes('B-data'))
}
{
  try { await readAs(sesA, join(home,'.ssh','id_ed25519')); check('A(sandbox) 读 ~/.ssh 被拒', false, 'succeeded') }
  catch(e){ check('A(sandbox) 读 ~/.ssh 被拒', /FS_SANDBOX_DENIED/.test(e.code||''), e.code) }
}
{
  const b = await readAs(sesB, join(home,'.ssh','id_ed25519'))
  check('B(none) 读 ~/.ssh 照读（不被 A 的 sandbox mode 污染）', b.includes('CANARY-SSH'))
}
// symlink TOCTOU（sandbox worker）
{
  try { await readAs(sesA, join(wsA,'evil-link')); check('A(sandbox) 工作区 symlink→凭据 被拒', false, 'succeeded') }
  catch(e){ check('A(sandbox) 工作区 symlink→凭据 被拒', /FS_SANDBOX_DENIED/.test(e.code||''), e.code) }
}
{
  try { const s=await statAs(sesA, join(home,'.ssh','id_ed25519')); check('A(sandbox) stat ~/.ssh 被拒', false, JSON.stringify(s)) }
  catch(e){ check('A(sandbox) stat ~/.ssh 被拒', /FS_SANDBOX_DENIED/.test(e.code||''), e.code) }
}
// 并发交替：A 与 B 各读凭据 20 次交错，A 全拒、B 全读，不串
{
  let aDenied=0, bOk=0
  const tasks=[]
  for(let i=0;i<20;i++){
    tasks.push(readAs(sesA, join(home,'.ssh','id_ed25519')).then(()=>{}, e=>{ if(/FS_SANDBOX_DENIED/.test(e.code||'')) aDenied++ }))
    tasks.push(readAs(sesB, join(home,'.ssh','id_ed25519')).then(t=>{ if(t.includes('CANARY-SSH')) bOk++ }, ()=>{}))
  }
  await Promise.all(tasks)
  check('并发：A(sandbox) 20/20 被拒、B(none) 20/20 读通，不串模式', aDenied===20 && bOk===20, `aDenied=${aDenied} bOk=${bOk}`)
}

rmSync(home,{recursive:true,force:true}); rmSync(wsA,{recursive:true,force:true}); rmSync(wsB,{recursive:true,force:true})
log(failed?'SOME FAILED':'ALL PASS'); process.exit(failed?1:0)
