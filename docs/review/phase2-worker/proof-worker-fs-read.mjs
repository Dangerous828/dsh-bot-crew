/**
 * 真 fs-sandbox resolver 读面证明（#22 补口 / task-5）：走真实 fs 服务 resolver，不手搓 sandbox-exec。
 * 挂真 dsh-fs-sandbox(根 ctx.fs) + dsh-sandbox-policy + dsh-subprocess-local + 默认 SandboxProvider，
 * 在 isolate 了 fs+sandbox 的组里挂 WorkerSandboxProvider(作 sandbox) + WorkerFileSystem(作 fs)，
 * 经 group.get('fs') 的 readText/stat/listDir 真读。会话 mode 由 AsyncLocalStorage initiator 提供。
 * 验证：工作区可读、凭据被内核拒(FS_SANDBOX_DENIED)、工作区内 symlink 指向凭据也被拒。全 canary 在临时 HOME。
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

const log=(...a)=>console.log('[proof]',...a); let failed=false
const check=(n,p,d='')=>{log(`${p?'PASS':'FAIL'} — ${n}${d?'  '+d:''}`); if(!p)failed=true}
const home=mkdtempSync(join(tmpdir(),'wbfs-home-')); const ws=mkdtempSync(join(tmpdir(),'wbfs-ws-'))
mkdirSync(join(home,'.ssh')); writeFileSync(join(home,'.ssh','id_ed25519'),'CANARY-SSH-NOT-REAL\n')
mkdirSync(join(home,'.config')); writeFileSync(join(home,'.config','gh-hosts.yml'),'CANARY-GH-NOT-REAL\n')
writeFileSync(join(ws,'note.txt'),'ws-data\n'); symlinkSync(join(home,'.ssh','id_ed25519'), join(ws,'evil-link'))

const als=new AsyncLocalStorage(); const ses={id:'S'}
class D extends SandboxProvider{constructor(c){super(c,'sandbox')} async confine(a){return{argv:[...a],enforcement:'full',denialSignatures:[],runnerFailureRules:[]}}}
const ctx=new Context(); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(SubprocessLocal)
await ctx.plugin(SandboxPolicyService,{mode:'danger-full-access',workspaceRoot:ws})
await ctx.plugin(D); await ctx.plugin(SandboxedFileSystem,{cwd:ws})
ctx.provide('agents',{currentInitiator(){const s=als.getStore(); return s?{session:s}:undefined}})
const pol=ctx.get('sandboxPolicy'); const orig=pol.resolve.bind(pol)
pol.resolve=(req={})=> req.session? {mode:'workspace-write',workspaceRoot:ws}:orig(req)
const group=ctx.isolate('fs').isolate('sandbox')
await group.plugin(WorkerSandboxProvider,{sensitiveHome:home}); await group.plugin(WorkerFileSystem,{sensitiveHome:home})
check('root fs 仍 SandboxedFileSystem', ctx.get('fs')?.constructor?.name==='SandboxedFileSystem')
check('group fs = WorkerFileSystem', group.get('fs')?.constructor?.name==='WorkerFileSystem')
check('group sandbox = WorkerSandboxProvider', group.get('sandbox')?.constructor?.name==='WorkerSandboxProvider')
const wfs=group.get('fs')
const readAs=(p)=>als.run(ses, async()=>{const t=await wfs.resolve(p); return wfs.readText(t)})
const statAs=(p)=>als.run(ses, async()=>{const t=await wfs.resolve(p); return wfs.stat(t)})
try{ const o=await readAs(join(ws,'note.txt')); check('读工作区成功', o.includes('ws-data')) }catch(e){ check('读工作区成功', false, e.message) }
try{ await readAs(join(home,'.ssh','id_ed25519')); check('读 ~/.ssh 被拒', false, 'succeeded') }catch(e){ check('读 ~/.ssh 被拒', /FS_SANDBOX_DENIED/.test(e.code||''), e.code) }
try{ await statAs(join(home,'.ssh','id_ed25519')); check('stat ~/.ssh 被拒', false, 'succeeded') }catch(e){ check('stat ~/.ssh 被拒', /FS_SANDBOX_DENIED/.test(e.code||''), e.code) }
try{ await readAs(join(ws,'evil-link')); check('symlink→凭据 被拒(TOCTOU)', false, 'succeeded') }catch(e){ check('symlink→凭据 被拒(TOCTOU)', /FS_SANDBOX_DENIED/.test(e.code||''), e.code) }
try{ const s=await statAs(join(ws,'note.txt')); check('stat 工作区成功', s?.type==='file', JSON.stringify(s)) }catch(e){ check('stat 工作区成功', false, e.message) }
rmSync(home,{recursive:true,force:true}); rmSync(ws,{recursive:true,force:true})
log(failed?'SOME FAILED':'ALL PASS'); process.exit(failed?1:0)
