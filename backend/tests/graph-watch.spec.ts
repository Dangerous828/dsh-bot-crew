/**
 * 收件箱 / 日历监听运行时接线的工程单测（issue #23 第 1、2 项）。
 *
 * 这里跑的是 `runMailRound` / `runCalendarRound` / `todayEvents` + 真 `MicrosoftGraphPort`
 * 打一个**本地假 Graph server**。验证的是「拉 → 判 → 推 → 落账 → health」整条链路，
 * 包括去重跨轮、游标前进、401 与网络失败分开报、推送失败不记账、日历变更/取消/临期。
 *
 * **不是真接入**：没有真邮箱、没有真设备送达。这是工程单测。#23 的收口线
 * （真实邮箱与日历各触发一次提醒 + 晨报真出一份）仍未达成。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configsFromEnv, runMailRound, runCalendarRound, todayEvents, type GraphWatchConfig, type GraphWatchDeps, type GraphWatchStore,
} from '../src/app/graph-watch.ts'
import { MicrosoftGraphPort } from '../src/app/graph.ts'
import { KV } from '../src/kv.ts'
import type { Notice } from '../src/app/notices-out.ts'

let server: Server | undefined
afterEach(async () => { if (server) await new Promise<void>(r => server!.close(() => r())); server = undefined })

/** 内存 store：键是字符串（KV Key 就是 string）。 */
function memStore(seed: Record<string, unknown> = {}): GraphWatchStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...seed }
  return { data, get: key => data[key as string] as never, set: (key, value) => { if (value === undefined) delete data[key as string]; else data[key as string] = value } }
}

/** 起一个假 Graph server，按 pathname 分支回 JSON。 */
async function fakeGraph(handler: (url: URL) => { status?: number; body: unknown }): Promise<string> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const { status = 200, body } = handler(url)
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1.0`
}

const graphMail = (over: Record<string, unknown> = {}) => ({
  id: 'm1', internetMessageId: '<M1@example.com>', subject: '这版你定哪版？',
  from: { emailAddress: { name: '林一', address: 'lin@example.com' } },
  toRecipients: [{ emailAddress: { address: 'me@example.com' } }], ccRecipients: [],
  receivedDateTime: '2026-11-14T09:12:00Z', isRead: false, categories: [], ...over,
})
const graphEvent = (over: Record<string, unknown> = {}) => ({
  id: 'evt-1', subject: '周会',
  start: { dateTime: '2026-11-14T09:30:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-14T10:00:00.0000000', timeZone: 'UTC' },
  isAllDay: false, isCancelled: false, attendees: [{ emailAddress: { address: 'lin@example.com' } }], ...over,
})

const config = { token: { tokenEnv: 'GRAPH_TOKEN' }, user: 'me' }
const tokenEnv = (): NodeJS.ProcessEnv => ({ GRAPH_TOKEN: 'eyJ.live' } as NodeJS.ProcessEnv)

/** 端口工厂：真 MicrosoftGraphPort 打假 server；token 用注入的假环境。 */
const portTo = (base: string) => (cfg: GraphWatchConfig) =>
  new MicrosoftGraphPort({ token: cfg.token, user: cfg.user, base, io: { env: name => tokenEnv()[name] } })

function deps(store: GraphWatchStore, base: string, now: Date, pushed: Notice[] = []): GraphWatchDeps {
  return { store, port: portTo(base), now: () => now, push: n => { pushed.push(n); return true } }
}

describe('runMailRound — 拉→判→推→落账', () => {
  it('pushes a decision mail, records the dedup key and advances the cursor', async () => {
    const base = await fakeGraph(() => ({ body: { value: [graphMail()] } }))
    const store = memStore()
    const pushed: Notice[] = []
    const now = new Date('2026-11-14T09:20:00Z')
    const round = await runMailRound(deps(store, base, now, pushed), config)
    expect(round.health.state).toBe('ready')
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatchObject({ kind: 'mail' })
    expect(store.get(KV.mail.seen as never)).toContain('m1@example.com')
    expect(store.get(KV.mail.since as never)).toBe('2026-11-14T09:12:00Z')
  })

  it('does not push the same mail twice across rounds (dedup persists)', async () => {
    const base = await fakeGraph(() => ({ body: { value: [graphMail()] } }))
    const store = memStore()
    const pushed: Notice[] = []
    const now = new Date('2026-11-14T09:20:00Z')
    await runMailRound(deps(store, base, now, pushed), config)
    const second = await runMailRound(deps(store, base, now, pushed), config)
    expect(pushed).toHaveLength(1) // 第二轮同一封不再推
    expect(second.health.state).toBe('ready')
  })

  it('reports off when no credential reference is configured', async () => {
    const round = await runMailRound(deps(memStore(), 'http://127.0.0.1:9', new Date()), undefined)
    expect(round.health.state).toBe('off')
  })

  it('separates a 401 (auth) from a network failure', async () => {
    const base401 = await fakeGraph(() => ({ status: 401, body: { error: {} } }))
    const denied = await runMailRound(deps(memStore(), base401, new Date('2026-11-14T09:20:00Z')), config)
    expect(denied.health.state).toBe('error')
    expect(denied.health.detail).toContain('Mail.Read')
    // 网络不通：另一个端口
    const offline = await runMailRound(deps(memStore(), 'http://127.0.0.1:1', new Date('2026-11-14T09:20:00Z')), config)
    expect(offline.health.state).toBe('error')
    expect(offline.health.detail).toContain('读收件箱失败')
  })

  it('does not record the key when pushing throws (retries next round)', async () => {
    const base = await fakeGraph(() => ({ body: { value: [graphMail()] } }))
    const store = memStore()
    const now = new Date('2026-11-14T09:20:00Z')
    const boom: GraphWatchDeps = { store, port: portTo(base), now: () => now, push: () => { throw new Error('no device') } }
    const round = await runMailRound(boom, config)
    expect(round.health.state).toBe('error')
    expect(store.get(KV.mail.seen as never)).toBeUndefined()
  })
})

describe('runCalendarRound — 临期 / 变更 / 取消', () => {
  it('reminds for an event that starts within the soon window', async () => {
    const base = await fakeGraph(() => ({ body: { value: [graphEvent()] } }))
    const store = memStore()
    const pushed: Notice[] = []
    const now = new Date('2026-11-14T09:20:00Z') // 09:30 的会，10 分钟内
    const round = await runCalendarRound(deps(store, base, now, pushed), config)
    expect(round.health.state).toBe('ready')
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatchObject({ kind: 'calendar' })
    expect(store.get(KV.calendar.known as never)).toMatchObject({ 'evt-1': expect.any(String) })
  })

  it('says nothing for the same soon event on the next round (told)', async () => {
    const base = await fakeGraph(() => ({ body: { value: [graphEvent()] } }))
    const store = memStore()
    const pushed: Notice[] = []
    const now = new Date('2026-11-14T09:20:00Z')
    await runCalendarRound(deps(store, base, now, pushed), config)
    await runCalendarRound(deps(store, base, now, pushed), config)
    expect(pushed).toHaveLength(1)
  })

  it('reports a change when the time moved, but only for a known event', async () => {
    // 先认识一场（09:30），再把它改到 14:00（不再是 soon，也不是取消，是变更）。
    const store = memStore()
    const first = await fakeGraph(() => ({ body: { value: [] } }))
    await runCalendarRound(deps(store, first, new Date('2026-11-14T09:00:00Z')), config)
    // 手动放上指纹（模拟上一轮见过 09:30 的会）。
    const known = store.get(KV.calendar.known as never) as Record<string, string>
    store.set(KV.calendar.known as never, { ...known, 'evt-1': '周会|2026-11-14T09:30:00.000Z|2026-11-14T10:00:00.000Z|live' })
    const moved = await fakeGraph(() => ({ body: { value: [graphEvent({ start: { dateTime: '2026-11-14T14:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-14T14:30:00.0000000', timeZone: 'UTC' } })] } }))
    const pushed: Notice[] = []
    const round = await runCalendarRound(deps(store, moved, new Date('2026-11-14T09:00:00Z'), pushed), config)
    expect(round.health.state).toBe('ready')
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.title).toContain('改了')
  })

  it('says nothing about a cancellation it never saw scheduled', async () => {
    const base = await fakeGraph(() => ({ body: { value: [graphEvent({ isCancelled: true })] } }))
    const pushed: Notice[] = []
    await runCalendarRound(deps(memStore(), base, new Date('2026-11-14T09:00:00Z'), pushed), config)
    expect(pushed).toHaveLength(0)
  })
})

describe('todayEvents — 早报「今日日程」', () => {
  it('reads the day window and sorts all-day first', async () => {
    const base = await fakeGraph(() => ({ body: { value: [
      graphEvent({ id: 'b', subject: '下午会', start: { dateTime: '2026-11-14T15:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-14T16:00:00.0000000', timeZone: 'UTC' } }),
      graphEvent({ id: 'a', subject: '全天', isAllDay: true }),
    ] } }))
    const out = await todayEvents({ store: memStore(), port: portTo(base), push: () => true },
      config, new Date('2026-11-14T00:00:00Z'), new Date('2026-11-15T00:00:00Z'))
    expect(out?.events.map(e => e.title)).toEqual(['全天', '下午会'])
  })

  it('returns undefined when no calendar is configured', async () => {
    expect(await todayEvents({ store: memStore(), port: portTo('x'), push: () => true }, undefined,
      new Date(), new Date())).toBeUndefined()
  })
})

describe('configsFromEnv', () => {
  it('enables both from GRAPH_TOKEN and honours per-source off switches', () => {
    const both = configsFromEnv({ GRAPH_TOKEN: 't' } as NodeJS.ProcessEnv)
    expect(both.mail?.user).toBe('me')
    expect(both.calendar?.user).toBe('me')
    const mailOff = configsFromEnv({ GRAPH_TOKEN: 't', DSH_MAIL_OFF: '1' } as NodeJS.ProcessEnv)
    expect(mailOff.mail).toBeUndefined()
    expect(mailOff.calendar).toBeDefined()
  })

  it('enables nothing without a credential reference', () => {
    expect(configsFromEnv({} as NodeJS.ProcessEnv)).toEqual({})
  })
})
