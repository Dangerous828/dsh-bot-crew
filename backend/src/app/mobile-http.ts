/** Phone endpoints on DSH's authenticated Fetch carrier; queue admission remains owned by the mobile Source. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HttpHost } from './http.ts'
import { ticketStage } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { KV } from '../kv.ts'
import { agentTree, switchModel, workOf } from './work.ts'
import type { DeviceStore } from './remote.ts'

// Structural contract keeps compatibility with the bundle's alpha development
// peers; installed rc.2 Connection supplies this authenticated exact-route API.
interface FetchRegistry {
  register(route: { path: string; methods: ('GET' | 'POST')[]; requestBody: 'buffered';
    fetch(request: Request): Promise<Response> }): () => Promise<void>
}
/**
 * What the phone surface needs from the crew. `remote` is the device table: the phone redeems its pairing code
 * here rather than at the local-only management surface, because this is the one carrier it can already reach.
 */
type PhoneHost = Pick<HttpHost, 'ready' | 'machine' | 'store' | 'health' | 'models'> & { remote?: DeviceStore }
const response = (status: number, value: unknown) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

/**
 * 「认识多久」的出处：这个 Bot 最早那张工单的时间。
 *
 * 只从网关真正返回的工单里取 —— 没有工单就没有这个值，名片上那一行整个不出现。
 * 编一个「从某天起」比少一行更糟：那是拿假数据冒充记忆。
 */
function earliestTicketAt(data: Record<string, unknown>, botId: string): string {
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  let earliest = ''
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue
    const row = task as { bot_id?: unknown; created_at?: unknown }
    if (row.bot_id !== botId) continue
    const at = typeof row.created_at === 'string' ? row.created_at : ''
    if (at && (!earliest || at < earliest)) earliest = at
  }
  return earliest
}

/**
 * The messages the crew read and decided not to act on, with the reason it gave.
 *
 * A message the crew judges as small talk produces no Ticket and therefore no reply, so the conversation shows a
 * person talking to nobody. That is correct behaviour, but invisible: the phone cannot tell "still thinking" from
 * "never going to answer". This names the ones that were looked at and left, so the surface can say so.
 */
export function declinedRequests(items: TimelineItem[], decisions: readonly { kind?: string; at?: string; threadKey?: string;
  reason?: readonly { code?: string; values?: Record<string, unknown> }[] }[], now = Date.now(), windowMs = QUEUE_WINDOW_MS): {
  request_id: string; reason: string
}[] {
  // A Trigger's Thread key carries the queue row it came from (`team:main:6`), which is how a decision points back
  // at a message. Only the newest decision per thread counts: a follow-up can turn an earlier refusal into work.
  const latest = new Map<string, { reason: string; at: number }>()
  for (const decision of decisions) {
    if (typeof decision.threadKey !== 'string') continue
    const row = /:(\d+)$/.exec(decision.threadKey)?.[1]
    if (!row) continue
    const at = Date.parse(decision.at ?? '')
    if (!Number.isFinite(at)) continue
    const seen = latest.get(row)
    if (seen && at <= seen.at) continue
    // Anything other than a refusal is the crew taking the message, which supersedes an earlier refusal on the
    // same thread: the newest decision is the one that describes what happened.
    if (decision.kind !== 'ignore') { latest.delete(row); continue }
    const said = decision.reason?.find(entry => typeof entry.values?.text === 'string')?.values?.text
    latest.set(row, { reason: typeof said === 'string' && said ? said : '这条被判定不需要动手', at })
  }
  return items.flatMap(item => {
    if (item.role !== 'user' || typeof item.request_id !== 'string' || !item.request_id) return []
    const at = Date.parse(item.at ?? '')
    if (!Number.isFinite(at) || now - at > windowMs) return []
    const row = typeof item.id === 'string' ? /^m(\d+)$/.exec(item.id)?.[1] : undefined
    const found = row ? latest.get(row) : undefined
    // A decision older than the message describes a different one: the thread key is not enough on its own.
    if (!found || found.at < at) return []
    return [{ request_id: item.request_id, reason: found.reason }]
  })
}

/** The Bot roster the phone offers as mention targets; unreadable settings fall back to no roster. */
function crewRoster(settings: Settings, since: (botId: string) => string = () => ''): {
  bots: { id: string; name: string; role: string; persona?: string; since?: string }[]
  default_bot_id: string
} {
  const config = settings.sources?.team?.config
  const bots = Array.isArray(config?.bots) ? config.bots : []
  const roster = bots.flatMap(bot => {
    const row = bot as { bot_id?: unknown; name?: unknown; role?: unknown; persona?: unknown }
    if (typeof row.bot_id !== 'string' || !row.bot_id) return []
    // The persona is what the chip can explain on a long press; it is presentation text, never authority.
    const persona = typeof row.persona === 'string' ? row.persona.trim() : ''
    // 「认识多久」要说得出出处。这个值只从真实工单里最早的那一张取，
    // 取不到就整个字段不出现 —— 名片上宁可少一行，也不编一个日期。
    const known = since(row.bot_id)
    return [{ id: row.bot_id, name: typeof row.name === 'string' ? row.name : row.bot_id,
      role: typeof row.role === 'string' ? row.role : 'member', ...(persona ? { persona } : {}),
      ...(known ? { since: known } : {}) }]
  })
  const fallback = roster.find(bot => bot.role === 'default')?.id ?? roster[0]?.id ?? ''
  const named = config?.default_bot_id
  return { bots: roster, default_bot_id: typeof named === 'string' && named ? named : fallback }
}

/**
 * The gateway port a state directory owns. Same rule as `scripts/dsh-superagent`'s `state_dir_identity`:
 * the default state directory keeps 8788, every other one derives its own port from the path.
 *
 * They have to agree. The script starts the gateway and the handler has to find it; a profile that keeps its
 * own `stateDir` (a second crew on the same machine) would otherwise forward to the first crew's gateway and
 * come back 401, which reads as a credential problem but is a port mismatch.
 */
function gatewayPortFor(stateDir: string | undefined): string | undefined {
  if (!stateDir) return undefined
  const resolve = (value: string): string => value.replace(/\/+$/, '')
  if (resolve(stateDir) === resolve(`${homedir()}/.dsh/state/superagent`)) return '8788'
  let digest = 0
  for (const character of resolve(stateDir)) digest = (digest + character.charCodeAt(0)) % 100
  return String(18800 + digest)
}

/** The gateway the message surface forwards to; a profile that keeps its own gateway overrides it by environment. */
function gatewayOrigin(stateDir?: string): string {
  const host = process.env.MOBILEGW_HOST?.trim() || '127.0.0.1'
  const port = process.env.MOBILEGW_PORT?.trim() || gatewayPortFor(stateDir) || '8788'
  return `${process.env.MOBILEGW_SECURE === '1' ? 'https' : 'http'}://${host}:${port}`
}

/** Which operations exist, how they are called, and whether they need a query the surface checks itself. */
const OPERATIONS = {
  timeline: { method: 'GET' }, send: { method: 'POST' },
  work: { method: 'GET', needsTicket: true }, agents: { method: 'GET', needsTicket: true },
  // 桌面左栏要能「切模型」，切之前得先知道有哪些可选：一次读回 provider、模型和此刻在用的是哪个。
  models: { method: 'GET' },
  model: { method: 'POST' },
  // 手机提交配对码也走这条路：Connection 已经验过来源，这是它唯一到得了的入口。
  pair: { method: 'POST' },
} as const
type Operation = keyof typeof OPERATIONS

export function phoneHandler(runtime: PhoneHost, gateway = gatewayOrigin(runtime.machine.stateDir), request = fetch) {
  return async (incoming: Request): Promise<Response> => {
    const url = new URL(incoming.url)
    const name = url.pathname.split('/').at(-1) as Operation | undefined
    const operation = name && name in OPERATIONS ? name : undefined
    if (!operation || incoming.method !== OPERATIONS[operation].method) return response(404, { error: 'Unknown operation' })
    // A work or agent lookup without a ticket would ask the gateway to guess; refuse it here instead.
    const ticketId = url.searchParams.get('ticket') ?? ''
    if ('needsTicket' in OPERATIONS[operation] && !ticketId) return response(400, { error: 'ticket is required' })
    let body: string | undefined
    if (operation === 'model') {
      body = await incoming.text()
      try {
        const value = JSON.parse(body) as Record<string, unknown> | null
        // The provider is optional (one provider is the norm); the model is not.
        if (!value || Array.isArray(value) || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200) {
          return response(400, { error: 'model is required' })
        }
        body = JSON.stringify({ ...typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}, model: value.model })
      } catch { return response(400, { error: 'Invalid JSON' }) }
    }
    if (operation === 'pair') {
      // 配对请求只有四个短字段，给一点余量就够；它不经过网关，所以大小由这里把。
      body = await incoming.text()
      if (Buffer.byteLength(body) > 8 * 1024) return response(413, { error: 'Pairing request too large' })
    }
    if (operation === 'send') {
      body = await incoming.text()
      if (Buffer.byteLength(body) > 64 * 1024) return response(413, { error: 'Message too large' })
      try {
        const value = JSON.parse(body) as Record<string, unknown> | null
        if (!value || Array.isArray(value) || typeof value.text !== 'string' || !value.text.trim()
          || typeof value.request_id !== 'string' || !value.request_id || value.request_id.length > 128) {
          return response(400, { error: 'text and request_id are required' })
        }
        // The authenticated owner is the sender. No client-supplied policy identity crosses this boundary.
        const mentions = Array.isArray(value.mentions)
          ? value.mentions.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 10) : []
        // A mention only names who should answer; authorization stays with the owner identity above.
        body = JSON.stringify({ text: value.text, request_id: value.request_id, mentions })
      } catch { return response(400, { error: 'Invalid JSON' }) }
    }
    // The three work routes read the store and the live session tree, which the gateway does not hold. They answer
    // here, after the same Connection-owned authentication that guards every other route.
    if (operation === 'work' || operation === 'agents' || operation === 'models' || operation === 'model' || operation === 'pair') {
      await runtime.ready
      if (operation === 'models') {
        // 只给能真跑的那些：把 `models` 原样交出去，界面就得自己去分辨哪一组根本连不上。
        const catalog = await runtime.models()
        const current = runtime.store.settings().executor.model
        return response(200, {
          ...current ? { current } : {},
          providers: catalog.groups.map(group => ({ id: group.id, name: group.name,
            models: group.models.map(model => ({ id: model.id, name: model.name,
              ...typeof model.description === 'string' && model.description ? { description: model.description } : {} })) })),
          // 读不出来的 provider 也交回去：人得知道「这家挂了」，而不是以为它本来就没有模型。
          failures: catalog.failures.map(failure => ({ id: failure.id, name: failure.name })),
        })
      }
      if (operation === 'pair') {
        const devices = (runtime as unknown as { remote?: DeviceStore }).remote
        if (!devices) return response(503, { error: 'Pairing is unavailable' })
        let asked: Record<string, unknown>
        try { asked = JSON.parse(body ?? '{}') as Record<string, unknown> } catch { return response(400, { error: 'Invalid JSON' }) }
        const { code, deviceId, name, platform } = asked
        if (typeof code !== 'string' || typeof deviceId !== 'string' || !code || !deviceId) {
          return response(400, { error: 'code and deviceId are required' })
        }
        const credential = devices.redeem({ code, deviceId,
          name: typeof name === 'string' && name ? name : deviceId,
          platform: typeof platform === 'string' ? platform : 'unknown' })
        // 码错和设备不对在这里看起来一样：说清楚是哪一个只对尝试者有好处。
        return credential ? response(200, credential) : response(403, { error: 'Pairing refused' })
      }
      if (operation === 'model') {
        if (!body) return response(400, { error: 'model is required' })
        const asked = JSON.parse(body) as { provider?: string; model: string; reasoningEffort?: string }
        // A provider has to be named: a model name alone does not say where to reach it.
        if (typeof asked.provider !== 'string' || !asked.provider.trim()) return response(400, { error: 'provider is required' })
        const next = switchModel(runtime.store.settings(), { provider: asked.provider, model: asked.model, reasoningEffort: asked.reasoningEffort })
        runtime.store.saveSettings(next)
        return response(200, { ok: true, model: next.executor.model })
      }
      if (operation === 'work') return response(200, workOf(runtime.store.tickets.get(ticketId)) ?? response(404, { error: 'No such ticket' }))
      const agents = (runtime as unknown as { agents?: Parameters<typeof agentTree>[0] }).agents
      if (!agents) return response(503, { error: 'Session tree is unavailable' })
      // `ctx.agents` answers by id only, so the ids that may be subagents come from the sessions the store recorded.
      // `keys` takes the family itself, not a prefix string; the id is what follows the family's prefix.
      const known = runtime.store.keys?.(KV.sessions.prompts)?.map(name => name.slice(KV.sessions.prompts.prefix.length)) ?? []
      return response(200, { ticket_id: ticketId, agents: agentTree(agents, ticketId, 8, known) })
    }
    try {
      await runtime.ready
      const token = (await readFile(join(runtime.machine.stateDir, 'mobilegw.token'), 'utf8')).trim()
      if (!token) return response(503, { error: 'Mobile transport is not configured' })
      const target = ticketId ? `${gateway}/${operation}?ticket=${encodeURIComponent(ticketId)}` : `${gateway}/${operation}`
      const upstream = await request(target, {
        method: incoming.method, headers: { 'X-GW-Token': token, 'Content-Type': 'application/json' },
        ...(body ? { body } : {}), signal: AbortSignal.any([incoming.signal, AbortSignal.timeout(10_000)]), redirect: 'error',
      })
      if (!upstream.ok) {
        // Credentials and internal paths never appear in upstream error responses.
        return response(upstream.status === 401 ? 503 : upstream.status,
          { error: upstream.status === 401 ? 'Mobile transport credential mismatch' : 'Mobile request was rejected' })
      }
      const data = await upstream.json() as Record<string, unknown>
      if (operation === 'timeline') {
        const settings = runtime.store.settings()
        // The crew Source answers on the same queue as mobile, so its tickets belong on the phone too.
        const tickets = runtime.store.tickets.list().filter(ticket => ticket.channels.some(channel => channel.source === 'mobile' || channel.source === 'team')).slice(0, 30)
        // The phone names a Bot on send; the roster tells it who exists and who answers by default.
        const roster = crewRoster(runtime.store.settings(), bot => earliestTicketAt(data, bot))
        return response(200, { ...data, ...roster,
          tasks: tickets.map(ticket => {
          // One early ticket whose shape the stage machine cannot read must not take the whole conversation down
          // with it: it still belongs on the phone, it just cannot say which stage it is in.
          let stage: { stage?: string; action?: string } = {}
          try { stage = ticketStage(ticket) } catch { stage = {} }
          return { id: ticket.id, title: ticket.title,
            state: ticket.ended?.outcome ?? stage.stage ?? 'unknown', worker_session_id: workerSessionId(ticket.id),
            // Lets the phone place a task in the conversation by time and say whether it waits for the owner.
            created_at: ticket.createdAt, updated_at: ticket.updatedAt,
            ...(stage.stage === 'person' && stage.action ? { needs_person: stage.action } : {}) }
        }),
        // A message the crew has not answered yet is still queued: it was accepted, but no reply hangs off it.
        // Withdrawing it means the crew has not read it, which is what the phone needs to offer.
        queued: queuedRequests(Array.isArray(data.items) ? data.items as TimelineItem[] : []),
        // The messages read and left on purpose. Without these the phone cannot tell a thought in progress from
        // one that will never be answered.
        // Older hosts predate this read; a missing history leaves the list empty rather than failing the timeline.
        declined: declinedRequests(Array.isArray(data.items) ? data.items as TimelineItem[] : [],
          runtime.store.read?.recentDecisions?.(0, 200) ?? []),
        status: { runtime: runtime.health.runtime?.state ?? 'starting', mobile: runtime.health.mobile?.state ?? 'starting', paused: settings.paused } })
      }
      // `work` and `agents` are the gateway's own JSON; hand it back untouched so a new field it adds
      // reaches the phone without a change here.
      return response(200, data)
    } catch {
      return response(502, { error: 'Mobile transport is temporarily unavailable; retry with the same request_id' })
    }
  }
}

/** How long a sent message may still be withdrawn. Past this the crew has picked it up and withdrawing it lies. */
export const QUEUE_WINDOW_MS = 90_000

/** The parts of a gateway timeline entry this module reads. */
export interface TimelineItem { id?: string; role?: string; request_id?: string; reply_to?: string; text?: string; at?: string; bot_id?: string }

/**
 * The request ids the crew has not answered yet. A reply hangs under the message it answers, so a sent message with
 * no reply on it is the one still queued. Unreadable entries are skipped rather than failing the whole timeline.
 */
export function queuedRequests(items: TimelineItem[], now = Date.now(), windowMs = QUEUE_WINDOW_MS): string[] {
  // A reply names the message it answers, so the answered set holds the ids replies hang UNDER, not the reply ids.
  const answered = new Set(items.filter(item => item.role === 'agent').map(item => item.reply_to).filter(Boolean))
  return items
    .filter(item => item.role === 'user' && typeof item.request_id === 'string' && item.request_id && !answered.has(item.id))
    // A message the crew is already working on has no reply yet either, so age is what tells the two apart.
    // Past the window the crew has plainly picked it up; offering a withdraw there would be a button that does nothing.
    .filter(item => {
      const at = Date.parse(item.at ?? '')
      return Number.isNaN(at) || now - at <= windowMs
    })
    .map(item => item.request_id as string)
}

export function registerMobileHttp(ctx: Context, runtime: PhoneHost): void {
  // Connection's Fetch dispatcher checks Host/Origin, signed credentials and owner
  // principal for BOTH direct and relay carriers, before calling these handlers.
  ctx.inject(['connection'], child => {
    const connection = child.get('connection') as { fetch?: FetchRegistry } | undefined
    if (!connection?.fetch) { child.logger.warn('Mobile API requires DSH Connection Fetch support'); return }
    const handler = phoneHandler(runtime)
    const disposers = [
      connection.fetch.register({ path: '/api/mobile/timeline', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/send', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/work', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/agents', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/models', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/model', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/pair', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
    ]
    child.effect(() => async () => { await Promise.all(disposers.map(dispose => dispose())) })
  })
}
