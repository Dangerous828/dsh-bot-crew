// 归属核验：用产品 HubHttp 分别按 coder / scribbler / lead 过滤，看探针落在谁名下。
import { HubHttp } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/memory/hub-client.ts'
import { readHubToken } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/memory/auth.ts'
const BASE = 'https://jarvis.kentonnie.top/v1'
const ENV_FILE = '/Users/cpuser/.config/hub-memory-mcp/env'
const tok = readHubToken({ env: 'HUB_TOKEN', file: ENV_FILE })
const hub = new HubHttp({ base: BASE, timeoutMs: 15000, token: () => tok.token })
const MARK = process.env.SYNC24_MARK!
for (const bot of ['coder', 'scribbler', 'lead']) {
  const entries = await hub.search({ query: '短寿命探针 author 记忆上行', bots: [bot], limit: 6 })
  const hit = entries.filter(e => e.name.includes(MARK))
  console.log(`bots=[${bot}] entries=${entries.length} 探针命中=${hit.length}`)
  for (const e of entries) console.log(`   - bot=${e.bot_id} name=${e.name} type=${e.type} created=${e.created} updated=${e.updated}`)
}
console.log('token 出现在任何输出 = NO (只按引用读取，未打印)')
