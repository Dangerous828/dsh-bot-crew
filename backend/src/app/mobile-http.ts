/** Phone endpoints on DSH's authenticated Fetch carrier; queue admission remains owned by the mobile Source. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HttpHost } from './http.ts'
import { ticketStage } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import { workerSessionId } from '../executor/dsh.ts'

// Structural contract keeps compatibility with the bundle's alpha development
// peers; installed rc.2 Connection supplies this authenticated exact-route API.
interface FetchRegistry {
  register(route: { path: string; methods: ('GET' | 'POST')[]; requestBody: 'buffered';
    fetch(request: Request): Promise<Response> }): () => Promise<void>
}
type PhoneHost = Pick<HttpHost, 'ready' | 'machine' | 'store' | 'health'>
const response = (status: number, value: unknown) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

/** The Bot roster the phone offers as mention targets; unreadable settings fall back to no roster. */
function crewRoster(settings: Settings): { bots: { id: string; name: string; role: string; persona?: string }[]; default_bot_id: string } {
  const config = settings.sources?.team?.config
  const bots = Array.isArray(config?.bots) ? config.bots : []
  const roster = bots.flatMap(bot => {
    const row = bot as { bot_id?: unknown; name?: unknown; role?: unknown; persona?: unknown }
    if (typeof row.bot_id !== 'string' || !row.bot_id) return []
    // The persona is what the chip can explain on a long press; it is presentation text, never authority.
    const persona = typeof row.persona === 'string' ? row.persona.trim() : ''
    return [{ id: row.bot_id, name: typeof row.name === 'string' ? row.name : row.bot_id,
      role: typeof row.role === 'string' ? row.role : 'member', ...(persona ? { persona } : {}) }]
  })
  const fallback = roster.find(bot => bot.role === 'default')?.id ?? roster[0]?.id ?? ''
  const named = config?.default_bot_id
  return { bots: roster, default_bot_id: typeof named === 'string' && named ? named : fallback }
}

/** The gateway the message surface forwards to; a profile that keeps its own gateway overrides it by environment. */
function gatewayOrigin(): string {
  const host = process.env.MOBILEGW_HOST?.trim() || '127.0.0.1'
  const port = process.env.MOBILEGW_PORT?.trim() || '8788'
  return `${process.env.MOBILEGW_SECURE === '1' ? 'https' : 'http'}://${host}:${port}`
}

export function phoneHandler(runtime: PhoneHost, gateway = gatewayOrigin(), request = fetch) {
  return async (incoming: Request): Promise<Response> => {
    const path = new URL(incoming.url).pathname
    const operation = path.endsWith('/timeline') ? 'timeline' : path.endsWith('/send') ? 'send' : undefined
    if (!operation || incoming.method !== (operation === 'send' ? 'POST' : 'GET')) return response(404, { error: 'Unknown operation' })
    let body: string | undefined
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
    try {
      await runtime.ready
      const token = (await readFile(join(runtime.machine.stateDir, 'mobilegw.token'), 'utf8')).trim()
      if (!token) return response(503, { error: 'Mobile transport is not configured' })
      const upstream = await request(`${gateway}/${operation}`, {
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
        const roster = crewRoster(runtime.store.settings())
        return response(200, { ...data, ...roster,
          tasks: tickets.map(ticket => {
          const stage = ticketStage(ticket)
          return { id: ticket.id, title: ticket.title,
            state: ticket.ended?.outcome ?? stage.stage, worker_session_id: workerSessionId(ticket.id),
            // Lets the phone place a task in the conversation by time and say whether it waits for the owner.
            created_at: ticket.createdAt, updated_at: ticket.updatedAt,
            ...(stage.stage === 'person' ? { needs_person: stage.action } : {}) }
        }), 
        status: { runtime: runtime.health.runtime?.state ?? 'starting', mobile: runtime.health.mobile?.state ?? 'starting', paused: settings.paused } })
      }
      return response(200, data)
    } catch {
      return response(502, { error: 'Mobile transport is temporarily unavailable; retry with the same request_id' })
    }
  }
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
    ]
    child.effect(() => async () => { await Promise.all(disposers.map(dispose => dispose())) })
  })
}
