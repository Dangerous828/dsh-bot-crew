// A 链（真实产品代码 + 真实 pipeline）：独立 tmp stateDir 生成 canary → 产品 settle/edit(toHub:true)/publish
// → 落真实 ~/.dsh/memory/bot/<bot>/（local_dream 监听根）→ ~/.home-agent-bridge/dream_notify.sh 触发既有管道上行。
// 不碰生产 stateDir/进程；不手工 curl 到 Hub。canary 可清理，不碰用户记忆。
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../../../backend/src/app/store.ts'
import { MemoryLedger } from '../../../backend/src/app/memory.ts'
import { AuthorMirror, pipelineContent, pipelineDigest } from '../../../backend/src/memory/author.ts'
import { makeHubRetraction } from '../../../backend/src/memory/hub-retraction.ts'
import { readHubToken } from '../../../backend/src/memory/auth.ts'

const MARK = process.env.CHAIN_MARK || String(Math.floor(Date.now() / 1000))
const BOT = process.env.CHAIN_BOT || 'coder'
const ROOT = '/Users/cpuser/.dsh/memory' // local_dream dsh_memory 监听根
const PHASE = process.env.CHAIN_PHASE || 'write'

const state = mkdtempSync(join(tmpdir(), 'chain-a-'))
const store = new Store(join(state, 'orchestrator.sqlite'))
const ledger = new MemoryLedger(store)
const token = readHubToken({ env: 'HUB_TOKEN', file: '/Users/cpuser/.config/hub-memory-mcp/env' }).token
const mirror = new AuthorMirror({
  root: ROOT,
  retract: makeHubRetraction({ base: () => 'https://jarvis.kentonnie.top/v1', token: () => token, timeoutMs: () => 8000 }),
  digestsOf: name => ledger.digestsOf(name), rememberDigest: (name, d) => ledger.rememberDigest(name, d),
})
const fact = {
  description: `真实链 canary ${MARK}：A 产品账本→NAS pipeline→B win-desktop recall`,
  body: `受控测试事实 ${MARK}，验证 #24 真实产品入口上行与撤回闭环。可清理，不入用户事实。`,
  type: 'reference' as const, importance: 1, dedupe_key: `chain-canary-${MARK}`,
}
const name = `bot-${BOT}-chain-canary-${MARK}`

if (PHASE === 'write') {
  // 1) 产品 settle → toHub:false（裁定C）→ publish 不落盘
  const settled = ledger.settle({ bot_id: BOT, fact, origin: 'host:chain-canary' })
  for (const e of settled.written) await mirror.publish(e)
  console.log('[A] settle toHub=%s 落盘(应false)=%s', settled.written[0]?.toHub, existsSync(join(ROOT, 'bot', BOT, `${name}.md`)))
  // 2) 真实产品 edit 置 toHub:true（模拟认证操作者经 edit 入口）→ publish 落盘 + 记 digest
  ledger.edit(name, { toHub: true })
  const entry = ledger.all().find(e => e.name === name)!
  const r = await mirror.publish(entry)
  console.log('[A] edit toHub:true 落盘=%s path存在=%s digest=%s', r.written, existsSync(join(ROOT, 'bot', BOT, `${name}.md`)), JSON.stringify(ledger.digestsOf(name)))
  console.log('[A] pipelineContent dk=%s', pipelineDigest(pipelineContent(entry)))
  // 3) 触发既有管道（管道自己的入口，不是 curl）
  try { execFileSync(process.env.HOME + '/.home-agent-bridge/dream_notify.sh', ['dsh-memory', 'compact', 'chain-canary-' + MARK], { stdio: 'inherit' }) } catch (e) { console.log('[A] dream_notify err', String(e)) }
  console.log('[A] MARK=%s name=%s', MARK, name)
}
if (PHASE === 'forget') {
  const entry = ledger.all().find(e => e.name === name) ?? { name, bot_id: BOT, dedupe_key: `chain-canary-${MARK}`, body: '', description: '', type: 'reference', importance: 1, toHub: true, created: 0, updated: 0, state: 'active' }
  // 注意：forget 用真实账本 entry（若独立 stateDir 无该 entry，仍可凭 name+digest 历史撤——此处需在同一 stateDir 复跑或直传）
  console.log('[A] forget 说明：需在同一 stateDir 或由 runtime 触发；本脚本单独 forget 见 08')
}
store.close()
