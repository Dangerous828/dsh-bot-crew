// 产品 seam 本机集成验证：真 Store + 真 MemoryLedger + 真 AuthorMirror（模拟 runtime 接线）。
// 验证：settle→toHub:false 不落盘；edit(toHub:true)→落盘+记 digest；forget→disabled+撤远端(零行安全)。
// 不碰生产 stateDir/生产进程，用临时 tmp；撤回打真实中枢但用不存在 canary source=零行安全。
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../../backend/src/app/store.ts'
import { MemoryLedger } from '../../../backend/src/app/memory.ts'
import { AuthorMirror, pipelineContent, pipelineDigest } from '../../../backend/src/memory/author.ts'
import { makeHubRetraction } from '../../../backend/src/memory/hub-retraction.ts'
import { readHubToken } from '../../../backend/src/memory/auth.ts'

const state = mkdtempSync(join(tmpdir(), 'seam-store-'))
const root = mkdtempSync(join(tmpdir(), 'seam-root-'))
const store = new Store(join(state, 'orchestrator.sqlite'))
const ledger = new MemoryLedger(store)
const token = readHubToken({ env: 'HUB_TOKEN', file: '/Users/cpuser/.config/hub-memory-mcp/env' }).token
const boot = pipelineDigest('x') // dummy
const mirror = new AuthorMirror({
  root,
  retract: makeHubRetraction({ base: () => 'https://jarvis.kentonnie.top/v1', token: () => token, timeoutMs: () => 8000 }),
  digestsOf: name => ledger.digestsOf(name),
  rememberDigest: (name, digest) => ledger.rememberDigest(name, digest),
})
const BOT = 'coder'
const fact = { description: 'seam canary 不受控测试', body: '这是短寿命测试事实，可清理', type: 'feedback' as const, importance: 3, dedupe_key: 'seam-canary-' + Math.floor(Date.now() / 1000) }

// 1) settle → toHub:false（裁定C）→ publish 不落盘
const settled = ledger.settle({ bot_id: BOT, fact, origin: 'person:owner' })
console.log('[1] settle written=%d toHub=%s', settled.written.length, settled.written[0]?.toHub)
for (const e of settled.written) await mirror.publish(e)
const name = settled.written[0]!.name
const path = join(root, 'bot', BOT, `${name}.md`)
console.log('[1] md 存在=%s （应 false：toHub:false 不落盘）', existsSync(path))

// 2) 产品 edit 显式置 toHub:true → ledger.edit + author.publish 落盘 + 记 digest
ledger.edit(name, { toHub: true })
const entry = ledger.all().find(e => e.name === name)!
await mirror.publish(entry)
console.log('[2] edit toHub:true → md 存在=%s （应 true）', existsSync(path))
console.log('[2] digest 历史=%s', JSON.stringify(ledger.digestsOf(name)))
if (existsSync(path)) console.log('[2] md 内容前60:', readFileSync(path, 'utf8').slice(0, 60).replace(/\n/g, '\\n'))

// 3) forget → KV forgotten + md disabled + 撤远端（真端点，该 canary source 不在远端=零行安全）
const f = await mirror.forget(name, BOT, entry)
ledger.forget(name)
console.log('[3] forget disabled=%s tombstoned=%s retracted=%s retractError=%s', f.disabled, f.tombstoned, JSON.stringify(f.retracted), f.retractError ? String(f.retractError) : 'none')
console.log('[3] md disabled=%s', existsSync(path) && /^disabled: true$/m.test(readFileSync(path, 'utf8')))
store.close()
