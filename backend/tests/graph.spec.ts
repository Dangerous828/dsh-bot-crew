/**
 * Microsoft Graph 只读端口的工程单测（issue #23 第 1、2 项的真实接入点）。
 *
 * **这里没有真接入任何账号**：起一个本地假 Graph HTTP server，喂它几封/几场会的手搓
 * JSON，验证端口把 Graph 形状正确翻成 `MailMessage` / `CalendarEvent`、窗口与 `$filter`
 * 拼对、401/403 与网络失败如实抛、token 只从引用现读且不外泄。
 *
 * 这是**工程单测**，不等于「真邮箱/真日历各触发一次提醒」——那句要真账号 + 真设备送达，
 * 本条（#23）的收口线仍未达成。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GRAPH_BASE, GraphError, MicrosoftGraphPort, eventOf, isGraphAuthError, mailOf,
  envFileValue, normalizeGraphDateTime, readGraphToken, redactToken, sameOrigin, redactLocation,
} from '../src/app/graph.ts'
import { judgeMail } from '../src/app/inbox.ts'
import { judgeEvent } from '../src/app/calendar.ts'

let server: Server | undefined
afterEach(async () => { if (server) await new Promise<void>(r => server!.close(() => r())); server = undefined })

/** 起一个假 Graph server：按 path 命中 handler，回 JSON。返回 base 与收到的请求记录。 */
async function fakeGraph(routes: (url: URL) => { status?: number; body: unknown; location?: string }): Promise<{
  base: string; requests: { url: URL; authorization?: string }[]
}> {
  const requests: { url: URL; authorization?: string }[] = []
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ url, authorization: req.headers.authorization as string | undefined })
    const { status = 200, body, location } = routes(url)
    res.writeHead(status, { 'content-type': 'application/json', ...location ? { location } : {} }).end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1.0`
  return { base, requests }
}

/** 一封 Graph message 的最小形状。 */
const graphMail = (over: Record<string, unknown> = {}) => ({
  id: 'AAMk-1',
  internetMessageId: '<CAF-1@example.com>',
  subject: '这版文案你定哪版？',
  from: { emailAddress: { name: '林一', address: 'lin@example.com' } },
  toRecipients: [{ emailAddress: { name: '我', address: 'me@example.com' } }],
  ccRecipients: [],
  receivedDateTime: '2026-11-14T09:12:00Z',
  isRead: false,
  categories: [],
  ...over,
})

/** 一场 Graph event 的最小形状。 */
const graphEvent = (over: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  subject: '周会',
  start: { dateTime: '2026-11-14T09:30:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-14T10:00:00.0000000', timeZone: 'UTC' },
  isAllDay: false,
  isCancelled: false,
  attendees: [{ emailAddress: { address: 'lin@example.com' } }],
  ...over,
})

const ref = { tokenEnv: 'GRAPH_TOKEN' }
const env = (map: Record<string, string>) => (name: string) => map[name]

describe('readGraphToken — 只从引用现读，绝不返回值进说明', () => {
  it('reads the token from the named environment variable', () => {
    expect(readGraphToken(ref, { env: env({ GRAPH_TOKEN: 'eyJ.secret' }) }))
      .toEqual({ token: 'eyJ.secret', source: 'env' })
  })

  it('reports which reference is empty without echoing a value', () => {
    expect(readGraphToken({ tokenEnv: 'GRAPH_TOKEN' }, { env: env({}) }))
      .toMatchObject({ token: '', source: 'none', problem: expect.stringContaining('GRAPH_TOKEN') })
    expect(readGraphToken({})).toEqual({ token: '', source: 'none' })
  })

  it('reads a 0600 credential file, and a KEY=VALUE env-file when both are set', () => {
    const file = (text: string, mode = 0o600) => () => ({ text, mode })
    expect(readGraphToken({ tokenFile: '/t' }, { file: file('  "eyJ.from-file"  \n') }))
      .toMatchObject({ token: 'eyJ.from-file', source: 'file' })
    expect(readGraphToken({ tokenEnv: 'GRAPH_TOKEN', tokenFile: '/t' },
      { file: file('GRAPH_TOKEN=eyJ.from-envfile\n') })).toMatchObject({ token: 'eyJ.from-envfile', source: 'file' })
  })

  it('flags over-wide permissions but still returns the token', () => {
    const read = readGraphToken({ tokenFile: '/t' }, { file: () => ({ text: 'tok', mode: 0o644 }) })
    expect(read.token).toBe('tok')
    expect(read.problem).toContain('权限过宽')
  })

  it('treats a value with whitespace as not a token', () => {
    expect(readGraphToken(ref, { env: env({ GRAPH_TOKEN: 'a b' }) }))
      .toMatchObject({ token: '', problem: expect.stringContaining('空白') })
  })

  it('parses an exported env-file key', () => {
    expect(envFileValue('export GRAPH_TOKEN=abc\nOTHER=1', 'GRAPH_TOKEN')).toBe('abc')
    expect(envFileValue('# c\nGRAPH_TOKEN=first\nGRAPH_TOKEN=second', 'GRAPH_TOKEN')).toBe('first')
  })
})

describe('mailOf / eventOf — Graph 形状 → 判定层形状', () => {
  it('maps a Graph message to a MailMessage that the judge admits', () => {
    const mail = mailOf(graphMail())!
    expect(mail).toMatchObject({
      messageId: '<CAF-1@example.com>', from: '林一 <lin@example.com>', subject: '这版文案你定哪版？',
      receivedAt: '2026-11-14T09:12:00Z', directTo: true, unread: true,
    })
    expect(mail.to).toEqual(['me@example.com'])
    // 判定层直接吃形状：同事问「你定」应命中 decision。
    expect(judgeMail(mail)).toEqual({ notify: true, reason: 'decision' })
  })

  it('marks a message with only cc recipients as not direct, so the judge stays quiet', () => {
    const mail = mailOf(graphMail({ toRecipients: [], ccRecipients: [{ emailAddress: { address: 'me@example.com' } }], subject: 'FYI' }))!
    expect(mail.directTo).toBe(false)
    expect(judgeMail(mail)).toEqual({ notify: false, reason: 'not-direct' })
  })

  it('skips a message with no id or no received time', () => {
    expect(mailOf(graphMail({ internetMessageId: undefined, id: undefined }))).toBeUndefined()
    expect(mailOf(graphMail({ receivedDateTime: undefined }))).toBeUndefined()
  })

  it('maps a Graph event to a CalendarEvent that the judge times correctly', () => {
    const event = eventOf(graphEvent())!
    expect(event).toMatchObject({ id: 'evt-1', title: '周会', startsAt: '2026-11-14T09:30:00.000Z', endsAt: '2026-11-14T10:00:00.000Z' })
    // 09:22 时看 09:30 的会：十五分钟内 → soon。
    expect(judgeEvent({ event }, new Date('2026-11-14T09:22:00Z'))).toMatchObject({ notify: true, when: 'soon' })
  })

  it('carries the all-day and cancelled flags through', () => {
    expect(eventOf(graphEvent({ isAllDay: true }))).toMatchObject({ allDay: true })
    expect(eventOf(graphEvent({ isCancelled: true }))).toMatchObject({ cancelled: true })
  })

  it('normalizes Graph 7-digit fractional seconds without an offset', () => {
    expect(normalizeGraphDateTime('2026-11-14T09:30:00.0000000')).toBe('2026-11-14T09:30:00.000Z')
    expect(normalizeGraphDateTime('2026-11-14T09:30:00+08:00')).toBe('2026-11-14T01:30:00.000Z')
  })
})

describe('MicrosoftGraphPort.fetchMail — 真 HTTP，假 server', () => {
  it('GETs /me/messages with the $filter window, a Bearer token, and maps the page', async () => {
    const graph = await fakeGraph(() => ({ body: { value: [graphMail()] } }))
    const port = new MicrosoftGraphPort({ token: ref, base: graph.base, io: { env: env({ GRAPH_TOKEN: 'eyJ.live' }) } })
    const mails = await port.mail.fetch('2026-11-14T00:00:00Z')
    expect(mails).toHaveLength(1)
    expect(mails[0]).toMatchObject({ messageId: '<CAF-1@example.com>' })

    const seen = graph.requests[0]!
    expect(seen.url.pathname).toBe('/v1.0/me/messages')
    expect(seen.authorization).toBe('Bearer eyJ.live')
    expect(seen.url.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-11-14T00:00:00.000Z')
    expect(seen.url.searchParams.get('$orderby')).toBe('receivedDateTime asc')
  })

  it('uses users/{upn} when a specific mailbox is configured', async () => {
    const graph = await fakeGraph(() => ({ body: { value: [] } }))
    const port = new MicrosoftGraphPort({ token: ref, base: graph.base, user: 'boss@contoso.com', io: { env: env({ GRAPH_TOKEN: 't' }) } })
    await port.mail.fetch('2026-11-14T00:00:00Z')
    expect(graph.requests[0]!.url.pathname).toBe('/v1.0/users/boss%40contoso.com/messages')
  })

  it('raises GraphError on a 401 and stays a recognised auth error', async () => {
    const graph = await fakeGraph(() => ({ status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } }))
    const port = new MicrosoftGraphPort({ token: ref, base: graph.base, io: { env: env({ GRAPH_TOKEN: 'bad' }) } })
    const error = await port.mail.fetch('2026-11-14T00:00:00Z').catch(e => e)
    expect(error).toBeInstanceOf(GraphError)
    expect((error as GraphError).status).toBe(401)
    expect(isGraphAuthError(error)).toBe(true)
  })

  it('raises without leaking the token when it cannot read one', async () => {
    const port = new MicrosoftGraphPort({ token: ref, io: { env: env({}) }, base: 'http://127.0.0.1:9' })
    const error = await port.mail.fetch('2026-11-14T00:00:00Z').catch(e => e)
    expect(error).toBeInstanceOf(GraphError)
    expect(isGraphAuthError(error)).toBe(false)
  })

  it('redactToken removes the token value from any text', () => {
    expect(redactToken('Bearer eyJ.live rejected', 'eyJ.live')).toBe('Bearer *** rejected')
  })
})

describe('MicrosoftGraphPort.fetchEvents — 真 HTTP，假 server', () => {
  it('GETs /me/calendarView with the startDateTime/endDateTime window and maps events', async () => {
    const graph = await fakeGraph(() => ({ body: { value: [graphEvent()] } }))
    const port = new MicrosoftGraphPort({ token: ref, base: graph.base, io: { env: env({ GRAPH_TOKEN: 'eyJ.live' }) } })
    const events = await port.calendar.fetch('2026-11-14T00:00:00Z', '2026-11-16T00:00:00Z')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: 'evt-1', startsAt: '2026-11-14T09:30:00.000Z' })

    const seen = graph.requests[0]!
    expect(seen.url.pathname).toBe('/v1.0/me/calendarView')
    expect(seen.url.searchParams.get('startDateTime')).toBe('2026-11-14T00:00:00.000Z')
    expect(seen.url.searchParams.get('endDateTime')).toBe('2026-11-16T00:00:00.000Z')
  })

  it('treats a non-auth network failure as a plain GraphError', async () => {
    // 指到一个没人听的端口：连接被拒。
    const port = new MicrosoftGraphPort({ token: ref, base: 'http://127.0.0.1:1', io: { env: env({ GRAPH_TOKEN: 't' }) } })
    const error = await port.calendar.fetch('2026-11-14T00:00:00Z', '2026-11-16T00:00:00Z').catch(e => e)
    expect(error).toBeInstanceOf(GraphError)
    expect(isGraphAuthError(error)).toBe(false)
  })

  it('defaults the base to the global Graph v1.0 endpoint', () => {
    expect(DEFAULT_GRAPH_BASE).toBe('https://graph.microsoft.com/v1.0')
  })
})

describe('越权约束（负对照）', () => {
  it('NEVER falls back to a Hub token: an empty Graph ref makes no request at all', async () => {
    // 正对照：GRAPH_TOKEN 给了，要发请求。
    const graph = await fakeGraph(() => ({ body: { value: [] } }))
    const ok = new MicrosoftGraphPort({ token: { tokenEnv: 'GRAPH_TOKEN' }, base: graph.base, io: { env: env({ GRAPH_TOKEN: 'g' }) } })
    await ok.mail.fetch('2026-11-14T00:00:00Z')
    expect(graph.requests).toHaveLength(1)
    // 负对照：只给了 HUB_TOKEN / hub tokenFile，Graph 引用为空 → 一个请求都不该发。
    const denied = await fakeGraph(() => ({ body: { value: [] } }))
    const port = new MicrosoftGraphPort({ token: {}, base: denied.base,
      io: { env: env({ HUB_TOKEN: 'admin-hub-token' }) } })
    const error = await port.mail.fetch('2026-11-14T00:00:00Z').catch(e => e)
    expect(error).toBeInstanceOf(GraphError)
    expect(denied.requests).toHaveLength(0) // 绝不把 Hub token 送去 Graph
    // 且错误消息里没有 hub token 值。
    expect(String((error as Error).message)).not.toContain('admin-hub-token')
  })

  it('refuses a non-official base when no transport is injected (production)', () => {
    expect(() => new MicrosoftGraphPort({ token: ref, base: 'https://evil.example/v1.0', io: { env: env({ GRAPH_TOKEN: 't' }) } }))
      .toThrow(/拒绝非官方 Graph 基址/)
  })

  it('refuses to follow a redirect to another origin, and never sends the token there', async () => {
    const graph = await fakeGraph(() => ({ status: 302, location: 'https://evil.example/steal', body: {} }))
    const port = new MicrosoftGraphPort({ token: ref, base: graph.base, io: { env: env({ GRAPH_TOKEN: 'secret-token' }) } })
    const error = await port.mail.fetch('2026-11-14T00:00:00Z').catch(e => e)
    expect(error).toBeInstanceOf(GraphError)
    expect(String((error as Error).message)).toContain('非同一 origin')
    // 只打了本体一次；没有第二次把 token 带去 evil。
    expect(graph.requests).toHaveLength(1)
    expect(String((error as Error).message)).not.toContain('secret-token')
  })

  it('sameOrigin accepts same host, redactLocation strips the query', () => {
    expect(sameOrigin('https://graph.microsoft.com/v1.0', 'https://graph.microsoft.com/v1.0/me')).toBe(true)
    expect(sameOrigin('https://graph.microsoft.com/v1.0', 'https://evil.example/x')).toBe(false)
    expect(sameOrigin('https://graph.microsoft.com/v1.0', '/relative')).toBe(true)
    expect(redactLocation('https://evil.example/a?code=SECRET')).toBe('https://evil.example/a')
  })
})
