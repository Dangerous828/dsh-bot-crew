// #24 完整真实链编排（Mac 本机跑）：
// A(本 Mac 产品代码) settle(false)→edit(toHub:true) publish 到真实 ~/.dsh/memory → 真 pipeline 上行 NAS
//  → B(win-desktop 独立物理设备, 产品 HubHttp) recall 命中
//  → A 产品 forget(disabled+bySourceFile撤+tombstone占位) → B 再 recall 不命中 + 管道再触发不复活
// 不碰生产 stateDir/进程；canary 可清理；不手工 curl 到 Hub 冒充上行。
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
const ROOT = '/Users/cpuser/.dsh/memory'
const WIN = process.env.CHAIN_WIN || 'win-desktop-cf'
const TOKEN = readHubToken({ env: 'HUB_TOKEN', file: '/Users/cpuser/.config/hub-memory-mcp/env' }).token
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const state = mkdtempSync(join(tmpdir(), 'chain-full-'))
const store = new Store(join(state, 'orchestrator.sqlite'))
const ledger = new MemoryLedger(store)
const mirror = new AuthorMirror({ root: ROOT,
  retract: makeHubRetraction({ base: () => 'https://jarvis.kentonnie.top/v1', token: () => TOKEN, timeoutMs: () => 8000 }),
  digestsOf: n => ledger.digestsOf(n), rememberDigest: (n, d) => ledger.rememberDigest(n, d) })
const name = `bot-${BOT}-chain-canary-${MARK}`
const mdPath = join(ROOT, 'bot', BOT, `${name}.md`)
async function hubLiveOfSf(sf: string): Promise<number> {
  const r = await fetch('https://jarvis.kentonnie.top/v1/memories/search', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-token': TOKEN },
    body: JSON.stringify({ namespace: 'dsh-memory/bot', query: '', limit: 100, metadata_filter: { source_file: sf } }) })
  const rows = await r.json() as any[]
  return Array.isArray(rows) ? rows.filter(x => !x.deleted_at).length : 0
}
const fact = { description: `真实链 canary ${MARK}`, body: `testfact canary ${MARK} 受控测试事实，验证真实产品入口上行与撤回。可清理。`,
  type: 'reference' as const, importance: 1, dedupe_key: `chain-canary-${MARK}` }

function bRecall(tag: string): { hit: boolean; out: string } {
  const out = execFileSync('ssh', ['-o', 'ConnectTimeout=20', WIN,
    `cd C:/Users/xc/wb-b && set WB_BOT=${BOT}&& set WB_QUERY=testfact canary ${MARK}&& set WB_MARK=${MARK}&& node --experimental-transform-types b-run.ts`],
    { input: TOKEN + '\n', encoding: 'utf8' }).toString()
  const hit = out.includes('MARK命中=true')
  console.log(`[B:${tag}] 命中=${hit}\n` + out.split('\n').filter(l => /\[B\]/.test(l)).join('\n'))
  return { hit, out }
}

async function main() {
  console.log('=== MARK=%s name=%s ===', MARK, name)
  // 1) A: settle(false) → publish 不落盘
  const settled = ledger.settle({ bot_id: BOT, fact, origin: 'host:chain' })
  for (const e of settled.written) await mirror.publish(e)
  console.log('[A] settle toHub=%s md存在(应false)=%s', settled.written[0]?.toHub, existsSync(mdPath))
  // 2) A: 真实产品 edit 置 toHub:true → publish 落盘 + 记 digest
  ledger.edit(name, { toHub: true })
  const entry = ledger.all().find(e => e.name === name)!
  await mirror.publish(entry)
  console.log('[A] edit toHub:true md存在=%s digest=%s', existsSync(mdPath), JSON.stringify(ledger.digestsOf(name)))
  // 3) 触发既有管道（真 pipeline，不 curl）
  try { execFileSync(process.env.HOME + '/.home-agent-bridge/dream_notify.sh', ['dsh-memory', 'compact', 'chain-' + MARK], { stdio: 'inherit' }) } catch (e) { console.log('[A] dream_notify err', String(e)) }
  // 轮询等中枢出现该 canary 的 live 行（最多 40s）
  let live = 0
  for (let i = 0; i < 20; i++) { live = await hubLiveOfSf(`${name}.md`); if (live > 0) break; await sleep(2000) }
  console.log('[A] 中枢 live 行数=%d（pipeline flushed 判据）', live)
  // 4) B(win) recall 命中
  const before = bRecall('before')
  // 5) A: 产品 forget（disabled + bySourceFile 撤 + tombstone 占位）
  const f = await mirror.forget(name, BOT, entry); ledger.forget(name)
  console.log('[A] forget disabled=%s tombstoned=%s retracted=%s retractError=%s', f.disabled, f.tombstoned, JSON.stringify(f.retracted), f.retractError ? String(f.retractError) : 'none')
  // 6) 再触发管道一轮，确认 disabled 不再上行、不复活
  try { execFileSync(process.env.HOME + '/.home-agent-bridge/dream_notify.sh', ['dsh-memory', 'compact', 'chain-' + MARK + '-b'], { stdio: 'inherit' }) } catch {}
  await sleep(4000)
  const afterLive = await hubLiveOfSf(`${name}.md`)
  console.log('[A] forget 后中枢 live 行数=%d（应0）', afterLive)
  const after = bRecall('after')
  console.log('\n=== 结论 before命中=%s after命中=%s （期望 true→false）===', before.hit, after.hit)
  store.close()
  if (!before.hit) { console.log('!! before 未命中，检查 pipeline/TIMEOUT'); process.exit(2) }
  if (after.hit) { console.log('!! after 仍命中，撤回未生效'); process.exit(3) }
  console.log('PASS')
}
void main()
