// 第 4 层证据：中枢只出计划（dryRun），真实持久化只落本机账本。
import { HubProbe, LocalMemory, pickMemoryPort } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/memory/detect.ts'
import { RuleDistiller } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/memory/distill.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/app/store.ts'

const BASE = 'https://jarvis.kentonnie.top/v1'
const ENV_FILE = '/Users/cpuser/.config/hub-memory-mcp/env'
const stateDir = mkdtempSync(join(tmpdir(), 'sync24-consol-'))
const store = new Store(join(stateDir, 'orchestrator.sqlite'))
const distiller = new RuleDistiller()
const now = Math.floor(Date.now() / 1000)
// episodic：本机真实原料（这里给一条「定下来的规矩」，走产品自己的规则提炼器）
const local = new LocalMemory({
  store, bots: () => ['coder'],
  distill: (text, at) => distiller.distill(text, at),
  episodic: () => [{ text: '记住：验收时先跑 pnpm test，再动别的。', at: now - 60 }],
})
const probe = new HubProbe({ hub: BASE, timeoutMs: 8000, token: { env: 'HUB_TOKEN', file: ENV_FILE }, log: l => console.log('  ' + l) })
await probe.refresh()
const port = pickMemoryPort(local, probe)
console.log('本机账本(前) =', local.all().length)
const result = await port.consolidate({ since: now - 3600 })
console.log('consolidate 返回 =', JSON.stringify(result))
const all = local.all()
console.log('本机账本(后) =', all.length, '→', all.map(e => `${e.name}|bot=${e.bot_id}|state=${e.state}`).join(' , '))
console.log('判读: facts/merged/superseded 只报本机真写的；hubPlan.dryRun =', result.hubPlan?.dryRun, '（服务端没写库）')
