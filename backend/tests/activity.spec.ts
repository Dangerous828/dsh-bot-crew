/**
 * 轻量活动端点 + kind 管线（task-15，契约「状态协议」）。
 *
 * 这里钉住的是**根因边界**，不是装修：
 *  1. `reply_kind` 缺省不再宣称 replied（P0-1：接手回执被显示成已回复）。
 *  2. `/activity` 的 `request_id` 恒为用户消息的 request_id，评估阶段没有票也能关联。
 *  3. 轻量端点与 timeline 的 `request_state` 同源同值（processing/person/finished 不打架）。
 *  4. 老活跃任务不因为「不在最近 N 条」而消失；后到的 ignore/stop 不会把它绑回旧 accept。
 *  5. 会话能力位/形状坏掉的应答不能当成「活跃集合为空」去清客户端 overlay。
 *  6. `activity` 只在同种活动时才携带原生的 label/时间。
 */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activityItems, evaluatingRows, isLegacyReply, latestDecisions, phoneHandler, withRequestStates,
  type MetaRow,
} from '../src/app/mobile-http.ts'
import { activityFrom, wireActivity } from '../src/app/activity.ts'
import type { HttpHost } from '../src/app/http.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const ticket = (over: Record<string, unknown> = {}) => ({
  id: 'tk1', title: '调间距', decisionId: 'd1', createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:01:00.000Z',
  channels: [{ source: 'team', thread: 'team:main:1', address: { conversation: 'main', message: '1', bot_id: 'lead' } }],
  assignments: [], inputs: [], undelivered: [], origin: { triggerId: 't1', triggerIds: ['t1'] }, ...over,
})

/** 一个只带活动端点所需读面的宿主；`activity` 可替换成抛错/缺席以测降级。 */
function host(options: {
  tickets?: unknown[]; threads?: unknown[]; decisions?: Record<string, unknown[]>
  activity?: (ticketId: string) => Promise<unknown>; withoutActivity?: boolean
} = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-activity-')); directories.push(stateDir)
  writeFileSync(join(stateDir, 'mobilegw.token'), 'server-only-test-token')
  const runtime: Record<string, unknown> = {
    ready: Promise.resolve(), machine: { stateDir },
    health: { runtime: { state: 'ready' }, mobile: { state: 'ready' } },
    store: {
      settings: () => ({ paused: false }),
      tickets: { active: () => options.tickets ?? [], open: () => options.tickets ?? [], list: () => options.tickets ?? [],
        get: (id: string) => (options.tickets ?? []).find(entry => (entry as { id: string }).id === id) },
      threads: { active: () => options.threads ?? [] },
      decisions: { byThread: (key: string) => options.decisions?.[key] ?? [] },
      read: { recentDecisions: () => [] },
      get: () => undefined, set: () => {}, keys: () => [],
    },
  }
  if (!options.withoutActivity) runtime.activity = options.activity ?? (async () => undefined)
  return { runtime: runtime as unknown as HttpHost, stateDir }
}

const metaResponse = (over: Record<string, unknown> = {}) => Response.json({ items: [], session_id: 'main', session_api: 1, ...over })

// ─────────────────────────────────────────────────────────────────────────────
// 1. kind 管线：只有显式 reply 才算最终答复
// ─────────────────────────────────────────────────────────────────────────────
it('只有显式 reply_kind=reply 才算最终答复，回执与通知都不终结消息', () => {
  const at = '2026-11-17T00:00:00.000Z'
  const states = (replyKind?: string) => withRequestStates([
    { id: 'm1', role: 'user', request_id: 'r1', read_at: at, at },
    { id: 'r2', role: 'agent', reply_to: 'm1', text: '收到', at, ...(replyKind ? { reply_kind: replyKind as never } : {}) },
  ], [], [], 'main')[0]!.request_state
  expect(states('acknowledgement')).not.toBe('replied')
  expect(states('notice')).not.toBe('replied')
  expect(states('reply')).toBe('replied')
})

it('历史行缺 kind 时保留「类型未知」：不宣称已回复，但仍是可读的回话', () => {
  const at = '2026-11-17T00:00:00.000Z'
  const item = { id: 'r9', role: 'agent' as const, reply_to: 'm1', text: '早年的回话', at }
  expect(isLegacyReply(item)).toBe(true)
  const projected = withRequestStates([{ id: 'm1', role: 'user', request_id: 'r1', read_at: at, at }, item], [], [], 'main')
  expect(projected.map(entry => entry.request_state)[0]).not.toBe('replied')
  // 正文仍在：不宣称已答复不等于把历史回话藏起来。
  expect(projected.find(entry => entry.id === 'r9')?.text).toBe('早年的回话')
})

it('evaluating 由持久事实给出：队伍读走、还没决定、线程正在评估', () => {
  const at = '2026-11-17T00:00:00.000Z'
  const items = [
    { id: 'm1', role: 'user' as const, request_id: 'eval', read_at: at, at },
    { id: 'm2', role: 'user' as const, request_id: 'unread', read_at: '', at },
  ]
  const states = withRequestStates(items, [], [], 'main', new Set(['1']))
  expect(states.map(item => item.request_state)).toEqual(['evaluating', 'queued'])
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 轻量快照：request_id 关联 + request_state 与 timeline 一致
// ─────────────────────────────────────────────────────────────────────────────
it('用 meta 行的 request_id 关联，评估阶段没有票也给出 evaluating', async () => {
  const { runtime } = host({ threads: [{ key: 'team:main:3', evaluating: { startedAt: '2026-11-17T00:00:00.000Z' } }] })
  const upstream = vi.fn(async () => metaResponse({ items: [
    { id: 'm3', request_id: 'client-uuid-3', read_at: '2026-11-17T00:00:01.000Z' },
  ] }))
  const response = await phoneHandler(runtime, 'http://gw', upstream as never)(new Request('http://dsh/api/mobile/activity'))
  expect(response.status).toBe(200)
  const body = await response.json() as { session_id: string; session_api: number; state: string; at: string
    items: { request_id: string; request_state: string; ticket_ref?: string; activity?: { kind: string } }[] }
  expect(body.session_id).toBe('main')
  expect(body.session_api).toBe(1)
  expect(body.state).toBe('live')
  expect(Number.isFinite(Date.parse(body.at))).toBe(true)
  expect(body.items).toHaveLength(1)
  // 关联键是客户端自己的 request_id，不是 Trigger id、不是 m3。
  expect(body.items[0]!.request_id).toBe('client-uuid-3')
  expect(body.items[0]!.request_state).toBe('evaluating')
  expect(body.items[0]!.ticket_ref).toBeUndefined()
  expect(body.items[0]!.activity?.kind).toBe('evaluating')
})

it('活跃票的 request_state 与 timeline 同源：processing / person / finished 都不写成 accepted', async () => {
  const running = ticket({ id: 'tk-run', assignments: [{ id: 'a1', state: 'running', createdAt: '2026-11-17T00:00:00.000Z',
    report: { state: 'progress', summary: 'doing', at: '2026-11-17T00:01:00.000Z' } }] })
  const person = ticket({ id: 'tk-person', attention: { id: 'q1', question: '确认一下' } })
  const ended = ticket({ id: 'tk-done', ended: { at: '2026-11-17T00:02:00.000Z', by: 'executor', outcome: 'completed' } })
  const { runtime } = host({
    tickets: [running, person, ended],
    activity: async (id: string) => id === 'tk-run' ? { kind: 'tool', label: '读取文件', at: '2026-11-17T00:01:30.000Z' } : undefined,
    decisions: {
      'team:main:1': [{ kind: 'accept', at: '2026-11-17T00:00:01.000Z', threadKey: 'team:main:1', ticketId: 'tk-run' }],
      'team:main:2': [{ kind: 'accept', at: '2026-11-17T00:00:01.000Z', threadKey: 'team:main:2', ticketId: 'tk-person' }],
      'team:main:3': [{ kind: 'accept', at: '2026-11-17T00:00:01.000Z', threadKey: 'team:main:3', ticketId: 'tk-done' }],
    },
  })
  const upstream = vi.fn(async () => metaResponse({ items: [
    { id: 'm1', request_id: 'r-run', read_at: '2026-11-17T00:00:01.000Z' },
    { id: 'm2', request_id: 'r-person', read_at: '2026-11-17T00:00:01.000Z' },
    { id: 'm3', request_id: 'r-done', read_at: '2026-11-17T00:00:01.000Z' },
  ] }))
  const body = await (await phoneHandler(runtime, 'http://gw', upstream as never)(new Request('http://dsh/api/mobile/activity'))).json() as
    { items: { request_id: string; request_state: string; ticket_ref?: string; activity?: { kind: string; label?: string } }[] }
  const byId = new Map(body.items.map(item => [item.request_id, item]))
  expect(byId.get('r-run')?.request_state).toBe('processing')
  expect(byId.get('r-run')?.ticket_ref).toBe('tk-run')
  expect(byId.get('r-run')?.activity?.kind).toBe('tool')
  expect(byId.get('r-person')?.request_state).toBe('waiting_for_person')
  expect(byId.get('r-person')?.activity?.kind).toBe('waiting_for_person')
  expect(byId.get('r-done')?.request_state).toBe('finished')
  expect(byId.get('r-done')?.activity?.kind).toBe('ended')
})

it('已结束的票不在 active/open 里，也按 id 补进来：不会把 finished 写成 accepted', async () => {
  // 一张跑完就结束的票：`active()` 与 `open()` 都不含它，只有决定里还留着它的 id。
  const ended = ticket({ id: 'tk-ended', ended: { at: '2026-11-17T00:02:00.000Z', by: 'executor', outcome: 'completed' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: '2026-11-17T00:00:00.000Z' }] })
  const { runtime } = host({
    tickets: [],
    decisions: { 'team:main:4': [{ kind: 'accept', at: '2026-11-17T00:00:01.000Z', threadKey: 'team:main:4', ticketId: 'tk-ended' }] },
  })
  // get 由 host 的 `tickets.get` 提供：集合为空，但按 id 仍查得到。
  ;(runtime as unknown as { store: { tickets: { get: (id: string) => unknown } } }).store.tickets.get =
    (id: string) => (id === 'tk-ended' ? ended : undefined)
  const upstream = vi.fn(async () => metaResponse({ items: [
    { id: 'm4', request_id: 'r-ended', read_at: '2026-11-17T00:00:01.000Z' },
  ] }))
  const body = await (await phoneHandler(runtime, 'http://gw', upstream as never)(new Request('http://dsh/api/mobile/activity'))).json() as
    { items: { request_id: string; request_state: string; ticket_ref?: string; activity?: { kind: string } }[] }
  expect(body.items[0]!.request_state).toBe('finished')
  expect(body.items[0]!.ticket_ref).toBe('tk-ended')
  expect(body.items[0]!.activity?.kind).toBe('ended')
})

it('网关应答坏掉时不冒充「活跃集合为空」：502 + code，客户端因此不清 overlay', async () => {
  const { runtime } = host()
  const cases: [string, Response, number, string | undefined][] = [
    ['no code on 502', new Response('{}', { status: 502 }), 502, undefined],
    ['malformed items', Response.json({ items: 'nope', session_id: 'main', session_api: 1 }), 502, 'malformed_meta'],
  ]
  for (const [, upstreamResponse, status, code] of cases) {
    const upstream = vi.fn(async () => upstreamResponse.clone())
    const response = await phoneHandler(runtime, 'http://gw', upstream as never)(new Request('http://dsh/api/mobile/activity'))
    expect(response.status).toBe(status)
    expect((await response.json() as { code?: string }).code).toBe(code)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 会话能力位：显式非 main 会话的老网关不能被静默接受
// ─────────────────────────────────────────────────────────────────────────────
it('显式非 main 会话而网关没有能力位 → 409 unsupported_session，不返回任何活跃集合', async () => {
  const { runtime } = host()
  const upstream = vi.fn(async () => Response.json({ items: [], session_id: 'work' }))
  const response = await phoneHandler(runtime, 'http://gw', upstream as never)(new Request('http://dsh/api/mobile/activity?session_id=work'))
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'unsupported_session' })
})

it('网关回的 session_id 与请求不一致 → 502 session_mismatch，绝不接受错会话', async () => {
  const { runtime } = host()
  const upstream = vi.fn(async () => Response.json({ items: [], session_id: 'main', session_api: 1 }))
  const response = await phoneHandler(runtime, 'http://gw', upstream as never)(new Request('http://dsh/api/mobile/activity?session_id=work'))
  expect(response.status).toBe(502)
  expect((await response.json() as { code?: string }).code).toBe('session_mismatch')
})

it('宿主没接活动投影 → 501 activity_unsupported（客户端据此退回慢速时间线）', async () => {
  const { runtime } = host({ withoutActivity: true })
  const upstream = vi.fn() as unknown as typeof fetch
  const response = await phoneHandler(runtime, 'http://gw', upstream)(new Request('http://dsh/api/mobile/activity'))
  expect(response.status).toBe(501)
  expect(await response.json()).toEqual({ error: 'Activity is unavailable', code: 'activity_unsupported' })
  expect(upstream).not.toHaveBeenCalled()
})

it('老网关没有 /meta → 也是 501 activity_unsupported，而不是 200 空集合', async () => {
  const { runtime } = host()
  const upstream = vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 }))
  const response = await phoneHandler(runtime, 'http://gw', upstream as never)(new Request('http://dsh/api/mobile/activity'))
  expect(response.status).toBe(501)
  expect((await response.json() as { code?: string }).code).toBe('activity_unsupported')
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 老活跃任务不被窗口截断；后到的决定不绑回旧票
// ─────────────────────────────────────────────────────────────────────────────
it('活跃票的队列行会被点名要，老任务不会因为不在最近 N 条里而消失', async () => {
  const old = ticket({ id: 'tk-old', channels: [{ source: 'team', thread: 'team:main:7', address: { conversation: 'main', message: '7' } }] })
  const { runtime } = host({ tickets: [old],
    decisions: { 'team:main:7': [{ kind: 'accept', at: '2026-11-17T00:00:01.000Z', threadKey: 'team:main:7', ticketId: 'tk-old' }] } })
  let asked = ''
  const upstream = vi.fn(async (url: string) => {
    asked = url
    return metaResponse({ items: [{ id: 'm7', request_id: 'r-old', read_at: '2026-11-17T00:00:01.000Z' }] })
  })
  const body = await (await phoneHandler(runtime, 'http://gw', upstream as never)(new Request('http://dsh/api/mobile/activity'))).json() as
    { items: { request_id: string; ticket_ref?: string }[] }
  expect(asked).toContain('row=7')
  expect(body.items.map(item => item.request_id)).toEqual(['r-old'])
  expect(body.items[0]!.ticket_ref).toBe('tk-old')
})

it('同一行后来的 ignore 不会被旧 accept 顶掉：最新决定说了算', () => {
  const index = latestDecisions([
    { kind: 'accept', at: '2026-11-17T00:00:01.000Z', threadKey: 'team:main:5', ticketId: 'tk-old' },
    { kind: 'ignore', at: '2026-11-17T00:05:00.000Z', threadKey: 'team:main:5' },
  ], 'main')
  expect(index.get('5')?.kind).toBe('ignore')
  expect(index.get('5')?.ticketId).toBeUndefined()
  expect(index.get('5')!.at).toBe(Date.parse('2026-11-17T00:05:00.000Z'))
})

it('更旧的决定（时间早于新的一条）不会覆盖新的一条', () => {
  const index = latestDecisions([
    { kind: 'ignore', at: '2026-11-17T00:05:00.000Z', threadKey: 'mobile:main:9' },
    { kind: 'accept', at: '2026-11-17T00:00:01.000Z', threadKey: 'mobile:main:9', ticketId: 'tk-early' },
  ], 'main')
  expect(index.get('9')?.kind).toBe('ignore')
})

it('别人的会话的行号不进本会话的评估集合', () => {
  const rows = evaluatingRows([
    { key: 'team:main:1', evaluating: { startedAt: '2026-11-17T00:00:00.000Z' } },
    { key: 'team:work:2', evaluating: { startedAt: '2026-11-17T00:00:00.000Z' } },
    { key: 'team:main:abc', evaluating: { startedAt: '2026-11-17T00:00:00.000Z' } },
  ], 'main')
  expect([...rows.keys()]).toEqual(['1'])
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. activity 合成：只有同种活动才携带原生的 label/时间
// ─────────────────────────────────────────────────────────────────────────────
it('阶段改写 kind 时不携带别种活动的 label 与起点', () => {
  const model = { kind: 'model' as const, label: '模型处理中', since: '2026-11-17T00:00:00.000Z', at: '2026-11-17T00:00:05.000Z' }
  const person = wireActivity({ stage: 'person', native: model })
  expect(person?.kind).toBe('waiting_for_person')
  expect(person?.label).toBeUndefined()
  expect(person?.since).toBeUndefined()
  // 同种活动才保留人话与时间。
  const ended = wireActivity({ stage: 'ended', native: { kind: 'ended', label: '已完成', at: '2026-11-17T00:09:00.000Z' } })
  expect(ended).toEqual({ kind: 'ended', label: '已完成', at: '2026-11-17T00:09:00.000Z' })
})

it('评估阶段不携带工具/模型的 label', () => {
  const evaluation = wireActivity({ evaluating: { since: '2026-11-17T00:00:00.000Z' },
    native: { kind: 'tool', label: '读取文件', since: '2026-11-17T00:00:01.000Z' } })
  expect(evaluation).toEqual({ kind: 'evaluating', since: '2026-11-17T00:00:00.000Z', at: '2026-11-17T00:00:00.000Z' })
})

it('读活动出错给 unknown + 一句人话，且不造时间；tracker 缺席仍是不给', () => {
  const failing = { snapshot: () => { throw new Error('boom') } }
  expect(activityFrom(failing as never)).toEqual({ kind: 'unknown', label: '执行状态读取失败' })
  expect(activityFrom(undefined)).toBeUndefined()
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. meta 行 → 最小时间线条目
// ─────────────────────────────────────────────────────────────────────────────
it('meta 行只在有最终答复时合成 agent 条目：回执不终结状态', () => {
  const rows: MetaRow[] = [
    { id: 'm1', request_id: 'a', read_at: '2026-11-17T00:00:01.000Z', answered: true, acknowledged: true },
    { id: 'm2', request_id: 'b', read_at: '2026-11-17T00:00:01.000Z', answered: false, acknowledged: true },
    { id: 'm3', request_id: 'c', read_at: '2026-11-17T00:00:01.000Z' },
    { id: 'nope', request_id: 'x' },
    { id: 'm4' },
  ]
  const items = activityItems(rows)
  expect(items.filter(item => item.role === 'agent').map(item => item.reply_to)).toEqual(['m1'])
  expect(items.filter(item => item.role === 'user').map(item => item.id)).toEqual(['m1', 'm2', 'm3'])
})
