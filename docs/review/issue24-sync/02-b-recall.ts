// B 侧完整证据：真实 HubProbe/HubHttp/HubMemory（pickMemoryPort），本机账本为空，跨进程召回 + 巩固。
import { HubProbe, LocalMemory, pickMemoryPort } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/memory/detect.ts'
import { readHubToken } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/memory/auth.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/app/store.ts'

const BASE = process.env.SYNC24_BASE || 'https://jarvis.kentonnie.top/v1'
const ENV_FILE = '/Users/cpuser/.config/hub-memory-mcp/env'
const BOT = process.env.SYNC24_BOT || 'coder'
const QUERY = process.env.SYNC24_QUERY!
const TIMEOUT = Number(process.env.SYNC24_TIMEOUT || 8000)
const PHASE = process.env.SYNC24_PHASE || 'before'

const tok = readHubToken({ env: 'HUB_TOKEN', file: ENV_FILE })
const stateDir = mkdtempSync(join(tmpdir(), `sync24-b-${PHASE}-`))
const store = new Store(join(stateDir, 'orchestrator.sqlite'))
const local = new LocalMemory({ store, bots: () => [BOT] })
console.log(`[B:${PHASE}] process pid=${process.pid} stateDir=${stateDir}`)
console.log(`[B:${PHASE}] 本机账本条目数 = ${local.all().length}  (${local.all().length === 0 ? '本机源为空' : '本机有源'})`)
const probe = new HubProbe({ hub: BASE, timeoutMs: TIMEOUT, token: { env: 'HUB_TOKEN', file: ENV_FILE }, log: l => console.log('  ' + l) })
console.log(`[B:${PHASE}] probe /health = ${await probe.refresh()} | auth=${probe.authState().state} | source=${probe.authState().source}`)
const port = pickMemoryPort(local, probe)
const ticket = { id: `sync24-b-${PHASE}`, title: 'B 侧召回', decisionId: 'd', mandate: { kind: 'act' },
  channels: [{ source: 'team', address: { bot_id: BOT } }], assignments: [], inputs: [], undelivered: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  origin: { triggerId: 't', triggerIds: ['t'] } } as never
const text = await port.recall(ticket, QUERY)
const HIT = text.includes(process.env.SYNC24_MARK || 'sync24-probe')
console.log(`[B:${PHASE}] recall chars=${text.length} 探针命中=${HIT}`)
console.log(text.split('\n').slice(0, 4).join('\n'))
const plan = await port.consolidate({ since: Math.floor(Date.now() / 1000) - 3600 })
console.log(`[B:${PHASE}] consolidate = ${JSON.stringify(plan)}`)
console.log(`[B:${PHASE}] 本机账本条目数(巩固后) = ${local.all().length}`)
console.log(`[B:${PHASE}] token 值是否出现在本次输出 = ${text.includes(tok.token) ? 'YES(泄漏!)' : 'NO'}`)
