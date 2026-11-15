/**
 * glob/grep 缺口证明：WorkerSearchSubprocess 把 ripgrep spawn 包进同 seatbelt profile。
 * 经真 @vscode/ripgrep 二进制，用 ctx.subprocess 语义（薄 spawn 桩），在 confining 会话下：
 *  - 搜工作区命中；
 *  - 搜 ~/.ssh（模型传敏感 root）命中被内核拒（不泄内容）；
 *  - none 会话（无登记 / danger-full）照搜（不隔离，与今天一致）。
 */
import { Context } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WorkerSearchSubprocess from '/tmp/wbfs-build/worker-search-subprocess.js'

const log=(...a)=>console.log('[proof-s]',...a); let failed=false
const check=(n,p,d='')=>{log(`${p?'PASS':'FAIL'} — ${n}${d?'  '+d:''}`); if(!p)failed=true}
const rg = process.env.RG || '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'

const home=mkdtempSync(join(tmpdir(),'ps-home-')); const ws=mkdtempSync(join(tmpdir(),'ps-ws-'))
mkdirSync(join(home,'.ssh')); writeFileSync(join(home,'.ssh','id_ed25519'),'CANARY-SECRET-TOKEN-XYZ\n')
writeFileSync(join(ws,'a.txt'),'HELLO-WORKSPACE\n')

// 薄 spawn 桩：模拟 ctx.subprocess.spawn（真跑 argv，收 collected readFrom）
function fakeSub(){return { spawn(spec){
  const [cmd,...args]=spec.argv
  const child=spawn(cmd,args,{cwd:spec.cwd,env:spec.env??process.env})
  let out='',err=''; child.stdout.on('data',c=>out+=String(c)); child.stderr.on('data',c=>err+=String(c))
  const data = spec.stdio?.stdin && typeof spec.stdio.stdin==='object' && 'data' in spec.stdio.stdin ? spec.stdio.stdin.data : undefined
  if(data!==undefined){ child.stdin.write(data); child.stdin.end() } else child.stdin.end()
  const done=new Promise(r=>child.on('close',(code,signal)=>r({exitCode:code,signal})))
  return { done, collected:{ stdout:{readFrom:()=>({text:out})}, stderr:{readFrom:()=>({text:err})} } }
}}}

const als=new AsyncLocalStorage()
const sesSandbox={id:'A'}, sesNone={id:'B'}
const override=new Map([[sesSandbox,'workspace-write'],[sesNone,'danger-full-access']])
const ctx=new Context()
const inner=fakeSub()
ctx.provide('subprocess', inner)
ctx.provide('agents',{currentInitiator(){const s=als.getStore(); return s?{session:s}:undefined}})
ctx.provide('sandboxPolicy',{resolve(req={}){ if(req.session&&override.has(req.session)) return {mode:override.get(req.session),workspaceRoot:ws}; return {mode:'danger-full-access',workspaceRoot:process.cwd()} }})
// 组：isolate subprocess 挂 WorkerSearchSubprocess
const group=ctx.isolate('subprocess')
await group.plugin(WorkerSearchSubprocess,{sensitiveHome:home})
const sp=group.get('subprocess')

async function search(session, target, pattern){
  return als.run(session, async()=>{
    const h=sp.spawn({ argv:[rg,'--no-config','--no-messages',pattern,target], cwd:ws, stdio:{stdin:{data:''},stdout:{maxBytes:1e6},stderr:{maxBytes:1e5}}, graceMs:10000, env:{PATH:'/usr/bin:/bin',HOME:home} })
    const o=await h.done; const so=h.collected.stdout.readFrom(0).text; const se=h.collected.stderr.readFrom(0).text
    return { code:o.exitCode, out:so, err:se }
  })
}

// sandbox 会话搜工作区：命中
{

  const r=await search(sesSandbox, ws, 'HELLO')
  check('sandbox 搜工作区命中', r.code===0 && r.out.includes('HELLO-WORKSPACE'), `code=${r.code} out=${JSON.stringify(r.out.slice(0,40))}`)
}
// sandbox 会话搜 ~/.ssh：被内核拒，不泄内容
{
  const r=await search(sesSandbox, join(home,'.ssh'), 'CANARY')
  check('sandbox 搜 ~/.ssh 被拒（不泄 CANARY）', !r.out.includes('CANARY'), `code=${r.code} out=${JSON.stringify(r.out.slice(0,60))} err=${r.err.slice(0,60)}`)
}
// none 会话搜 ~/.ssh：照搜（含 CANARY），不隔离
{
  const r=await search(sesNone, join(home,'.ssh'), 'CANARY')
  check('none 会话搜 ~/.ssh 照搜（含 CANARY，不隔离）', r.out.includes('CANARY'), `code=${r.code} out=${JSON.stringify(r.out.slice(0,50))}`)
}


rmSync(home,{recursive:true,force:true}); rmSync(ws,{recursive:true,force:true})
log(failed?'SOME FAILED':'ALL PASS'); process.exit(failed?1:0)
