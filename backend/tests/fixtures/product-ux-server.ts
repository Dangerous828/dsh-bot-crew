/** Isolated Android acceptance carrier: real phoneHandler + Store + mobilegw, synthetic events only. */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Store } from '../../src/app/store.ts'
import { phoneHandler } from '../../src/app/mobile-http.ts'
import { phoneGate } from '../../src/app/phone-gate.ts'
import { KV } from '../../src/kv.ts'
import { key, ticketStage, type Decision, type Ticket, type Trigger } from '../../src/core/index.ts'
import { screenOf, type ScreenEvent, type ScreenSnapshot } from '../../src/app/screen.ts'
import { NativeActivityTracker, type NativeActivity, type NativeActivityEvent } from '../../src/app/native-activity.ts'

const port = Number(process.env.PRODUCT_FIXTURE_PORT ?? 18888)
const gatewayPort = Number(process.env.PRODUCT_FIXTURE_GATEWAY_PORT ?? 18889)
if (![port, gatewayPort].every(p => Number.isInteger(p) && p > 1024 && ![8788, 43499, 64333].includes(p)) || port === gatewayPort) throw Error('Isolated fixture ports required')
const root = resolve(import.meta.dirname, '../..')
const stateDir = realpathSync(process.env.PRODUCT_FIXTURE_STATE ?? mkdtempSync(join(tmpdir(), 'botcrew-product-')))
if (!stateDir.startsWith(join(realpathSync(tmpdir()), 'botcrew-product-'))) throw Error('Fixture state must remain under its owned temporary prefix')
const marker = join(stateDir, '.product-fixture')
if (process.env.PRODUCT_FIXTURE_STATE && !existsSync(marker)) throw Error('Existing fixture state needs its ownership marker')
writeFileSync(marker, 'Synthetic product acceptance data only\n')
const device = 'product-fixture-device', credential = 'fixture-only-not-a-production-credential'
writeFileSync(join(stateDir, 'mobilegw.token'), 'fixture-gateway-only')
writeFileSync(join(stateDir, 'remote-devices.json'), JSON.stringify([{ deviceId: device, name: 'Isolated Android', platform: 'android', digest: createHash('sha256').update(credential).digest('hex'), pairedAt: new Date().toISOString() }]))
const gateway = spawn(process.env.PRODUCT_FIXTURE_PYTHON ?? '/usr/bin/python3', [join(root, 'tools/mobilegw')], { env: { ...process.env, MOBILEGW_STATE: stateDir, MOBILEGW_PORT: String(gatewayPort), MOBILEGW_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] })
gateway.stdout.on('data', chunk => process.stdout.write(chunk))
gateway.stderr.on('data', chunk => process.stderr.write(chunk))
process.on('exit', () => gateway.kill('SIGTERM'))
const store = new Store(join(stateDir, 'orchestrator.sqlite'))
store.saveSettings({ ...store.settings(), sources: { team: { enabled: true, config: { bots: [{ bot_id: 'lead', name: '大哥', role: 'default', memory_namespace: 'bot/lead' }, { bot_id: 'coder', name: '码农', role: 'member', session_id: 'work', memory_namespace: 'bot/coder' }], default_bot_id: 'lead' } } } })
store.set(KV.mobile.sessions('work'), true)
let failBefore = false, uncertain = false, disconnected = false, responseDelayMs = 0
let lastSend: { requestId?: string; session_id?: string; text?: string } | undefined
const events: { at: string; method: string; path: string; status: number; requestId?: string }[] = []
const nativeEvents = new Map<string, NativeActivityEvent[]>()
const trackers = new Map<string, NativeActivityTracker>()
const phases = new Map<string, { turn: number; step: number; calls: string[]; open: boolean }>()
function emitNative(id: string, type: string, data: Record<string, unknown>) {
  const events = nativeEvents.get(id) ?? []
  const event = { seq: events.length + 1, time: Date.now(), type, data }
  events.push(event); nativeEvents.set(id, events)
  const tracker = trackers.get(id) ?? new NativeActivityTracker()
  tracker.observe(event); trackers.set(id, tracker)
}
function phase(ticket: Ticket, kind: string) {
  const id = `worker-${ticket.id}`, state = phases.get(id) ?? { turn: 0, step: 1, calls: [], open: false }
  const emit = (type: string, fields: Record<string, unknown> = {}) => emitNative(id, type, { turn: state.turn, step: state.step, ...fields })
  const settleCalls = () => { for (const callId of state.calls) emit('tool/result', { message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'Synthetic result' }] } }); state.calls = [] }
  if (kind === 'model' || !state.open) {
    if (state.open) { settleCalls(); emit('step/end'); emit('turn/end', { reason: { kind: 'completed' } }) }
    state.turn++; state.step = 1; state.open = true; emit('turn/start'); emit('step/start')
  }
  if (kind === 'tool') {
    emit('assistant/message', { message: { role: 'assistant', content: [] }, stream: [] })
    const callId = `fixture-call-${nativeEvents.get(id)?.length ?? 0}`; state.calls.push(callId)
    emit('tool/call', { callId, name: 'functions.read', arguments: '{"file_path":"fixture.txt"}' })
  }
  if (kind === 'retrying') { settleCalls(); emit('step/end'); state.step++; emit('step/start'); emit('llm/retry', { attempt: 1 }) }
  if (kind === 'idle' || kind === 'ended') { settleCalls(); emit('step/end'); emit('turn/end', { reason: { kind: 'completed' } }); state.open = false }
  if (kind === 'ended') { ticket.ended = { at: now(), by: 'executor', outcome: 'completed' }; for (const assignment of ticket.assignments) assignment.state = 'ended'; ticket.updatedAt = now(); store.tickets.save(ticket) }
  phases.set(id, state)
}
const now = () => new Date().toISOString()
const cli = (...args: string[]) => execFileSync(process.env.PRODUCT_FIXTURE_PYTHON ?? '/usr/bin/python3', [join(root, 'tools/mobileq'), '--db', join(stateDir, 'mobileq.db'), ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: stateDir } }).trim()
const runtime = {
  ready: Promise.resolve(), machine: { stateDir }, store,
  health: { runtime: { state: 'ready' }, team: { state: 'ready' } },
  pendingNotices: () => [], ackNotices: () => 0, noticeSeen: () => [], markNoticeSeen: () => [],
  agents: { get: () => undefined },
  activity: async (id: string): Promise<NativeActivity | undefined> => {
    const ticket = store.tickets.get(id)
    if (!ticket) return undefined
    if (ticket.ended) return { kind: 'ended', at: ticket.ended.at, label: ticket.ended.outcome === 'stopped' ? '已停止' : '已完成' }
    if (ticketStage(ticket).stage === 'person') return { kind: 'waiting_for_person', at: ticket.updatedAt, label: '等你决定' }
    return trackers.get(`worker-${id}`)?.snapshot({ since: ticket.assignments.at(-1)?.startedAt })
  },
  // The UI carrier records a choice and settles its synthetic card; production approval/worker delivery has separate Runtime integration tests.
  answer: (id: string, text: string, attentionId: string) => {
    const ticket = store.tickets.get(id)
    if (!ticket || ticket.attention?.id !== attentionId || ticket.ended) return { ok: false, reason: '这张问题卡已经过期' }
    const option = ticket.attention.options?.find(option => option.id === text || option.label === text)
    if (!option) return { ok: false, reason: '请使用当前问题卡的选项' }
    delete ticket.attention; delete ticket.pendingApproval; ticket.updatedAt = now(); store.tickets.save(ticket)
    return { ok: true, answer: option.id }
  },
  settings: { pause: async (paused: boolean) => { store.saveSettings({ ...store.settings(), paused }); return { paused } } },
  engine: { stopTicket: (id: string) => { const t = store.tickets.get(id); if (t) { t.ended = { at: now(), by: 'human', outcome: 'stopped' }; store.tickets.save(t) } }, retryTicket: () => {} },
  screen: async (id: string): Promise<ScreenSnapshot> => {
    const t = store.tickets.get(id)
    const screen = screenOf({ known: !!t, ticketId: id, stage: t ? ticketStage(t).stage : undefined, events: (nativeEvents.get(`worker-${id}`) ?? []) as ScreenEvent[], since: t?.assignments.at(-1)?.startedAt })
    const activity = await runtime.activity(id)
    screen.activity = activity?.kind === 'model' ? 'thinking' : activity?.kind === 'tool' ? 'running' : activity?.kind === 'retrying' || activity?.kind === 'waiting_for_person' ? 'waiting' : activity?.kind === 'ended' ? 'ended' : activity?.kind === 'idle' ? 'idle' : undefined
    return screen
  },
}
const handler = phoneHandler(runtime as never, `http://127.0.0.1:${gatewayPort}`)
function seedTicket(messageId: number, session = 'main', suffix = ''): Ticket {
  const id = `fixture-ticket-${messageId}${suffix}`, triggerId = key('team', String(messageId)), threadKey = `team:${session}:${messageId}`, at = now()
  const botId = session === 'work' ? 'coder' : 'lead'
  const channel = { source: 'team', thread: threadKey, address: { conversation: session, message: String(messageId), bot_id: botId } }
  const trigger: Trigger = { id: triggerId, source: 'team', threads: [{ source: 'team', id: `${session}:${messageId}` }], actor: { source: 'team', id: 'owner' }, human: true, addressed: 'direct', text: 'synthetic acceptance request', at, channel, meta: { conversation: session, messageId: String(messageId), root: String(messageId), bot_id: botId, mentions: [] } }
  store.triggers.save(trigger)
  store.threads.save({ key: threadKey, ref: trigger.threads[0]!, createdAt: at, subscriptions: [id], correlated: [], pending: [], meta: {} })
  const decision: Decision = { id: `decision-${id}`, evalId: `eval-${id}`, policyVersion: 'fixture', strength: 'explicit', kind: 'accept', threadKey, triggerIds: [triggerId], ticketId: id, at, reason: [] }
  store.decisions.save(decision)
  const ticket: Ticket = { id, title: `验收任务${suffix}`, decisionId: decision.id, mandate: { strength: 'explicit', policyVersion: 'fixture', basis: { via: 'addressed', addressed: 'direct', source: 'team' }, actor: trigger.actor, scope: '' }, channels: [channel], assignments: [{ id: `assignment-${id}`, state: 'running', createdAt: at, startedAt: at }], inputs: [{ id: `input-${id}`, kind: 'trigger', triggerId, human: true, at, readAt: at }], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId, triggerIds: [triggerId] }, execution: { name: 'fixture', directory: stateDir, assignment: 'synthetic' } }
  store.tickets.save(ticket)
  return ticket
}
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks), url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname === '/__fixture') {
      const command = body.length ? JSON.parse(body.toString()) : {}
      if (command.action === 'online') { disconnected = false; failBefore = false; uncertain = false; responseDelayMs = 0 }
      if (command.action === 'delay') { const delay = Number(command.ms); if (!Number.isFinite(delay) || delay < 0 || delay > 30000) throw Error('Fixture delay must be 0..30000ms'); responseDelayMs = delay }
      if (command.action === 'fail-before') failBefore = true
      if (command.action === 'uncertain') uncertain = true
      if (command.action === 'disconnected') disconnected = true
      if (command.action === 'ticket') seedTicket(Number(command.messageId), command.session ?? 'main')
      if (command.action === 'phase') {
        const id = `fixture-ticket-${Number(command.messageId)}`
        const ticket = store.tickets.get(id) ?? seedTicket(Number(command.messageId), command.session ?? 'main')
        cli('pull', '--json')
        if (command.phase === 'evaluating') {
          store.db.prepare('DELETE FROM ticket WHERE id=?').run(ticket.id)
          store.db.prepare('DELETE FROM decision WHERE id=?').run(ticket.decisionId)
          const trigger = store.triggers.get(ticket.origin.triggerId)!, thread = store.threads.get(trigger.channel!.thread)!
          thread.subscriptions = []
          thread.evaluating = { id: `eval-${ticket.id}`, threadKey: thread.key, triggerIds: [trigger.id], primary: trigger.id, strength: 'explicit', actor: trigger.actor, basis: ticket.mandate.basis, policyVersion: 'fixture', startedAt: now(), delivered: now(), deadline: new Date(Date.now() + 600000).toISOString() }
          store.threads.save(thread)
        } else phase(ticket, String(command.phase))
      }
      if (command.action === 'two-approvals') {
        for (const suffix of ['-a', '-b']) {
          const t = seedTicket(Number(command.messageId), command.session ?? 'main', suffix)
          t.pendingApproval = { kind: 'connection', status: 'waiting', signature: `fixture${suffix}` }
          t.attention = { id: `attention${suffix}`, question: '将进度汇报发送到发布频道？', options: [{ id: 'go', label: '发送汇报' }, { id: 'stop', label: '取消此次发送' }, { id: 'revise', label: '修改内容' }], presentation: { kind: 'connection', action: '发送消息', target: '发布频道', preview: '第一行进度汇报\n路径片段保持 %2F。\n第二行是待确认项。\n\n'+ '可读的消息预览。'.repeat(25), details: 'synthetic send_message, no real credentials' } } as never
          store.tickets.save(t)
        }
      }
      if (command.action === 'reply' || command.action === 'ack') cli('reply', '--conversation', command.session ?? 'main', '--to', `m${Number(command.messageId)}`, '--key', `fixture-${command.action}-${Date.now()}`, '--text', command.action === 'ack' ? '接手了，正在处理。' : '验收回复：任务已完成。', '--bot', 'lead', '--kind', command.action === 'ack' ? 'acknowledgement' : 'reply')
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ stateDir, port, gatewayPort, device, credential, controls: { failBefore, uncertain, disconnected, responseDelayMs }, lastSend, events, tickets: store.tickets.list().map(t => ({ id: t.id, ended: t.ended, question: t.attention?.question })), nativeEvents: Object.fromEntries(nativeEvents) })); return
    }
    // Isolated acceptance only: the real /api/mobile/pair route needs a DeviceStore this carrier
    // does not mount. Let the app finish its normal pairing screen against 127.0.0.1 by handing
    // back the carrier's own synthetic credential; phoneGate below still validates every later call.
    if (url.pathname === '/api/mobile/pair' && req.method === 'POST') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ deviceId: device, token: credential }))
      return
    }
    const failure = phoneGate({ pathname: url.pathname, method: req.method ?? 'GET', headers: req.headers, devices: { allows: (id, token) => id === device && token === credential } })
    const incomingHeaders = new Headers(); for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') incomingHeaders.set(name, value)
    incomingHeaders.set('x-crew-principal', device)
    const sending = url.pathname === '/api/mobile/send'
    if (sending && body.length) { const content = JSON.parse(body.toString()); lastSend = { requestId: content.request_id, session_id: content.session_id, text: content.text } }
    let response: Response
    if (failure) response = failure
    else if (disconnected || sending && failBefore) response = Response.json({ error: 'Synthetic disconnected acceptance network' }, { status: 503 })
    else {
      response = await handler(new Request(url, { method: req.method, headers: incomingHeaders, ...(body.length ? { body } : {}) }))
      if (sending && uncertain && response.ok) { disconnected = true; response = Response.json({ error: 'Synthetic lost send receipt' }, { status: 503 }) }
    }
    if (sending && responseDelayMs) await new Promise(resolve => setTimeout(resolve, responseDelayMs))
    events.push({ at: now(), method: req.method ?? 'GET', path: url.pathname+url.search, status: response.status, ...(sending && body.length ? { requestId: JSON.parse(body.toString()).request_id } : {}) })
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })) }
})
server.listen(port, '127.0.0.1', () => { console.log(JSON.stringify({ fixture: true, port, gatewayPort, stateDir })); if (process.env.PRODUCT_FIXTURE_METADATA) writeFileSync(process.env.PRODUCT_FIXTURE_METADATA, JSON.stringify({ port, gatewayPort, stateDir, device, credential })+'\n') })
let closing = false
function close() { if (closing) return; closing = true; gateway.kill('SIGTERM'); server.close(() => { store.db.close(); process.exit(0) }); setTimeout(() => process.exit(0), 2000).unref() }
process.on('SIGTERM', close); process.on('SIGINT', close)
gateway.on('exit', code => { if (!closing) { console.error(`isolated gateway exited ${code}`); close() } })
