// A 侧：用产品自己的 adapter + 账本语义产生一条短寿命 author 记忆，落到 pipeline 监听的目录。
// 只走产品代码路径（MemoryLedger.settle / adapter.planWrite），不手搓 frontmatter。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryLedger } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/app/memory.ts'
import { planWrite } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/memory/adapter.ts'
import { Store } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/app/store.ts'

const MARK = process.env.SYNC24_MARK!
const BOT = process.env.SYNC24_BOT || 'coder'
const AUTHOR_ROOT = '/Users/cpuser/.dsh/memory'   // local_dream.sources.dsh_memory.root
const stateDir = mkdtempSync(join(tmpdir(), 'sync24-store-'))
const store = new Store(join(stateDir, 'orchestrator.sqlite'))
const ledger = new MemoryLedger(store)

const fact = {
  description: `短寿命探针 ${MARK}：验证 author 记忆经既有管道上行到中枢`,
  body: `这是一条**短寿命测试事实**，标记 ${MARK}，用于验证 dsh-bot-crew #24 的真实上行闭环。`
    + `\n\n- 归属 Bot：${BOT}（现有合法 bot_id，未新建）。`
    + `\n- 写入方：产品 adapter 渲染，落盘到 local_dream 的 dsh_memory 源监听目录。`
    + `\n- 清理：验证完按 forget/软删清理，不进用户真实事实。`,
  type: 'reference' as const,
  importance: 1,
  dedupe_key: `sync24-probe-${MARK}`,
}

const settled = ledger.settle({ bot_id: BOT, fact, origin: 'host:sync24-probe' })
console.log('LEDGER written =', settled.written.length, 'name =', settled.written[0]?.name,
  'bot_id =', settled.written[0]?.bot_id, 'state =', settled.written[0]?.state)
const entry = settled.written[0]!
const plan = planWrite(AUTHOR_ROOT, entry.bot_id, entry as never)
mkdirSync(join(AUTHOR_ROOT, 'bot', BOT), { recursive: true })
writeFileSync(plan.path, plan.content, { mode: 0o600 })
console.log('AUTHOR path =', plan.path)
console.log('--- content ---')
console.log(readFileSync(plan.path, 'utf8'))
