/**
 * S4-a：Source 准入机制（issue #14 第 3 项 / #10 第 4 项）。
 *
 * 四条断言各自的可跑证据：
 *  1. 落队列 —— 独立临时 mobilegw（独立 DSH_HOME / MOBILEGW_STATE / 随机端口），未登记
 *     会话 POST /send 后直接查临时 mobileq.db 的那一行。
 *  2. 可读 —— 同一临时网关 `GET /timeline?session_id=<未登记>` 读回且不串进 main；
 *     消息面 /api/mobile/timeline 另验 200 / session_id 回显 / 转发 URL（items 内容以网关层
 *     断言为准：消息面还会按会话过滤 items，见 S1 契约 §4）。
 *  3. 不派单 —— pollQueue 不生成 Trigger、不 receive；scope() 明确给出
 *     `conversation_not_listed`；计数 KV + health detail 可观测；真 Engine 落
 *     `filtered` disposition 且零 Ticket。
 *  4. 注册即生效 —— 真 `POST /api/mobile/sessions` 写 KV 后，同一个 SourceContext
 *     （不改 config、不重启）下一次 poll 立刻放行，scope()/channel.allowed 都通。
 *
 * 全程不碰生产 db / token，不重启任何运行中服务：临时网关由本文件自己 spawn、自己 kill，
 * 目录由 mkdtempSync 起、afterAll 清掉。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KV } from '../src/kv.ts'
import {
  mobileKind, mobileTrigger, pollQueue as pollMobile, pollDetail, pollReport, isAdmitted, rosterOf,
  sessionRoster, withRoster, SESSION_ROSTER, UNLISTED as MOBILE_UNLISTED,
} from '../src/sources/mobile.ts'
import { teamKind, pollQueue as pollTeam, UNLISTED as TEAM_UNLISTED } from '../src/sources/team.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Engine, MemoryRepositories, type Trigger } from '../src/core/index.ts'
import { phoneHandler } from '../src/app/mobile-http.ts'

const UNREG = 's4-unreg'
const RID = 's4-admission-unreg'
const TEXT = 'unregistered-session-message'
const TMP_STATE = '/tmp/s4-admission-fixture'
const MOBILE_CONFIG = { conversations: [], pollSeconds: 5 }
const TEAM_CONFIG = {
  default_bot_id: 'lead',
  bots: [{ bot_id: 'lead', name: '大哥', role: 'default' as const, memory_namespace: 'bot/lead' }],
  conversations: [],
  pollSeconds: 5,
}

type Item = { id: number; conversation: string; text: string; at: string;
  sender: { id: string; bot: boolean }; mentions_me: boolean; mentions?: string[] }
const msg = (conversation: string, id = 1, text = 'hello'): Item => ({
  id, conversation, text, at: '2026-11-13T12:00:00.000Z',
  sender: { id: 'owner', bot: false }, mentions_me: true, mentions: [],
})

/** 内存 KV + 队列替身，形状与 SourceContext 一致；两个 Source 共用同一份 KV 账。 */
function fixture(options: { items: Item[]; sessions?: string[]; config?: unknown; team?: boolean }) {
  const kv = new Map<string, unknown>()
  for (const id of options.sessions ?? []) kv.set(KV.mobile.sessions(id), true)
  const received: Trigger[] = []
  const reports: { entry: string; detail: string }[] = []
  let items = options.items
  const run = vi.fn(async () => JSON.stringify({ me: 'agent', items, next: items.length }))
  const config = (options.config ?? (options.team ? TEAM_CONFIG : MOBILE_CONFIG)) as never
  const state = {
    get: (key: string) => kv.get(key),
    set: (key: string, value: unknown) => { if (value === undefined) kv.delete(key); else kv.set(key, value) },
    keys: (family: { prefix: string }) => [...kv.keys()].filter(key => key.startsWith(family.prefix)),
  }
  const ctx = {
    state,
    config: () => config,
    commands: { withSignal: () => ({ run }) },
    receive: async (trigger: Trigger) => { received.push(trigger); return 'stored' as const },
    report: (entry: string, health: { detail: string }) => { reports.push({ entry, detail: health.detail }) },
    threads: { describe: vi.fn() },
    deployment: { stateDir: TMP_STATE },
    ready: Promise.resolve(),
  } as never
  return {
    ctx, state, kv, received, reports, config,
    roster: () => sessionRoster(state as never),
    setItems: (next: Item[]) => { items = next },
    register: (id: string) => { kv.set(KV.mobile.sessions(id), true) },
  }
}

/** 消息面用的假宿主：KV 是同一个 Map，登记动作由真 phoneHandler 落进去。 */
function phoneHost(kv: Map<string, unknown>, stateDir: string) {
  return { ready: Promise.resolve(), machine: { stateDir },
    health: { runtime: { state: 'ready' }, mobile: { state: 'ready' } }, models: () => [],
    store: {
      settings: () => ({ paused: false }),
      tickets: { list: () => [] },
      read: { recentDecisions: () => [] },
      get: (key: string) => kv.get(key),
      set: (key: string, value: unknown) => { kv.set(key, value) },
      keys: (target: string | { prefix: string }) => [...kv.keys()]
        .filter(key => key.startsWith(typeof target === 'string' ? target : target.prefix)),
    } } as never
}

// ─────────────────────────────────────────────────────────────────────────────
// 断言 1 / 2：独立临时网关的传输层证据
// ─────────────────────────────────────────────────────────────────────────────
const GATEWAY = fileURLToPath(new URL('../tools/mobilegw', import.meta.url))
let gateway: ChildProcess | undefined
let stateDir = ''
let origin = ''
let token = ''

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitHealth(child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${origin}/health`)).ok) return } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`mobilegw exited early (${child.exitCode})`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('mobilegw /health timeout')
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 's4-admission-'))
  const state = join(stateDir, 'state', 'superagent')
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  gateway = spawn('python3', [GATEWAY], {
    env: { ...process.env, DSH_HOME: stateDir, MOBILEGW_STATE: state, MOBILEGW_HOST: '127.0.0.1',
      MOBILEGW_PORT: String(port), MOBILEGW_CONV: 'main', PYTHONUNBUFFERED: '1' },
    stdio: 'ignore',
  })
  await waitHealth(gateway)
  token = readFileSync(join(state, 'mobilegw.token'), 'utf8').trim()
  // phoneHandler 从 machine.stateDir 根读 token；放一份到临时目录根，替身上游才有凭据可读。
  writeFileSync(join(stateDir, 'mobilegw.token'), token)
}, 30_000)

afterAll(() => {
  gateway?.kill('SIGTERM')
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

const DB_CHECK = [
  'import json, sqlite3, sys',
  'c = sqlite3.connect(sys.argv[1])',
  "rows = c.execute('SELECT conversation, text, read_at, withdrawn_at FROM messages WHERE request_id=?', (sys.argv[2],)).fetchall()",
  "print(json.dumps([{'conversation': r[0], 'text': r[1], 'read_at': r[2], 'withdrawn_at': r[3]} for r in rows]))",
].join('\n')

describe('断言 1 / 2：未登记会话落队列且可读', () => {
  it('落队列：未登记 /send 的消息以原 conversation 进临时 mobileq.db，不凭空消失', async () => {
    const send = await fetch(`${origin}/send?session_id=${UNREG}`, {
      method: 'POST', headers: { 'X-GW-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: TEXT, request_id: RID }),
    })
    expect(send.status).toBe(200)
    const db = join(stateDir, 'state', 'superagent', 'mobileq.db')
    const rows = JSON.parse(execFileSync('python3', ['-c', DB_CHECK, db, RID], { encoding: 'utf8' })) as
      { conversation: string; text: string; withdrawn_at: string | null }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.conversation).toBe(UNREG)
    expect(rows[0]!.text).toBe(TEXT)
    expect(rows[0]!.withdrawn_at).toBeFalsy()
  })

  it('可读：timeline?session_id=<未登记> 读回该消息，且不串进 main', async () => {
    const seen = await fetch(`${origin}/timeline?session_id=${UNREG}`, { headers: { 'X-GW-Token': token } })
    expect(seen.status).toBe(200)
    const body = await seen.json() as { items: { request_id?: string; text?: string }[] }
    const found = body.items.filter(item => item.request_id === RID)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toBe(TEXT)

    const main = await fetch(`${origin}/timeline`, { headers: { 'X-GW-Token': token } })
    const mainBody = await main.json() as { items: { request_id?: string }[] }
    expect(mainBody.items.some(item => item.request_id === RID)).toBe(false)
  })

  it('消息面 /api/mobile/timeline 把未登记会话的 items 原样带回来', async () => {
    // 契约 §2 断言 2 的本体在网关层（上一条用例），但消息面这一层也得钉住：
    // S1 §4 的 items 过滤只在「有外会话 decision 的行号」时才剔（itemsForSession），
    // 未登记会话没有 decision，所以它的条目必须原样出现在 items 里 —— 不凭空消失。
    const real = await fetch(`${origin}/timeline?session_id=${UNREG}`, { headers: { 'X-GW-Token': token } })
    const data = await real.json() as Record<string, unknown>
    const upstream = vi.fn(async () => Response.json({ ...data, session_api: 1 }))
    const handler = phoneHandler(phoneHost(new Map(), stateDir), 'http://gw', upstream as never)
    const result = await handler(new Request(`http://dsh/api/mobile/timeline?session_id=${UNREG}`))
    expect(result.status).toBe(200)
    const body = await result.json() as { session_id: string; items: { request_id?: string; text?: string }[] }
    expect(body.session_id).toBe(UNREG)
    // 本体：那条消息真的被读回来了，不是空数组。
    expect(body.items.filter(item => item.request_id === RID).map(item => item.text)).toEqual([TEXT])
    expect(upstream).toHaveBeenCalledWith(`http://gw/timeline?session_id=${UNREG}`,
      expect.objectContaining({ method: 'GET' }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 3：不派单 + 可观测的 conversation_not_listed
// ─────────────────────────────────────────────────────────────────────────────
describe('断言 3：未登记会话不派单，且拒绝是可观测的', () => {
  it('mobile：不生成 Trigger / Ticket，计数 KV 与 health detail 都记下 conversation_not_listed', async () => {
    const f = fixture({ items: [msg(UNREG)] })
    const result = await pollMobile(f.ctx, new AbortController().signal)
    expect(result.refused).toBe(1)
    expect(result.refusedSessions).toEqual([UNREG])
    expect(f.received).toHaveLength(0)                       // 不产生 Trigger
    expect(f.kv.get(MOBILE_UNLISTED)).toBe(1)                // 计数 KV：可观测
    expect(pollDetail(result.read, result.unreadable, result.refused, result.refusedSessions))
      .toContain('conversation_not_listed: s4-unreg')       // health detail：可观测
    // 关键：watch() 上报的是 pollReport 的产物，不是它自己拼的字符串。
    // 只断言 pollDetail 的话，把 watch 里那处调用换回旧字符串仍会全绿 —— 守门就落空了。
    const report = pollReport(result.read, result.unreadable, result.refused, result.refusedSessions)
    expect(report.state).toBe('ready')
    expect(report.detail).toContain('conversation_not_listed: s4-unreg')
    expect(Date.parse(report.at)).not.toBeNaN()
    expect(mobileKind.scope!({ meta: { conversation: UNREG, [SESSION_ROSTER]: [] } }, MOBILE_CONFIG))
      .toEqual({ listened: false, reason: 'conversation_not_listed' })
    expect(mobileKind.channel!.allowed!({ conversation: UNREG }, MOBILE_CONFIG)).toBe(false)
  })

  it('team：同一套准入，拒收计数落在自己的 KV 键上', async () => {
    const f = fixture({ items: [msg(UNREG)], team: true })
    const result = await pollTeam(f.ctx, new AbortController().signal)
    expect(result.refused).toBe(1)
    expect(f.received).toHaveLength(0)
    expect(f.kv.get(TEAM_UNLISTED)).toBe(1)
    expect(f.kv.get(MOBILE_UNLISTED)).toBeUndefined()
    expect(teamKind.scope!({ meta: { conversation: UNREG, [SESSION_ROSTER]: [] } }, TEAM_CONFIG))
      .toEqual({ listened: false, reason: 'conversation_not_listed' })
    expect(teamKind.channel!.allowed!({ conversation: UNREG }, TEAM_CONFIG)).toBe(false)
  })

  it('真 Engine：这类 Trigger 只留 filtered disposition，零 Ticket', () => {
    const repo = new MemoryRepositories()
    const settings = SettingsSchema.parse({ sources: { mobile: { enabled: true, config: { conversations: [] } } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(mobileKind)
    const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources),
      assessor: { request: vi.fn() },
      executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
    const trigger = mobileTrigger(msg(UNREG) as never, 'agent')!
    expect(engine.receive(trigger)).toBe('filtered')
    // Intake 把 scope 的 reason 落成持久化 disposition —— 不是「什么都没发生」。
    expect(repo.triggers.disposition(trigger.id)?.filtered).toMatchObject({ code: 'conversation_not_listed' })
    expect(repo.tickets.list()).toHaveLength(0)
    expect(sources.scope({ source: 'mobile', meta: trigger.meta }))
      .toEqual({ listened: false, reason: 'conversation_not_listed' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 4：注册即生效（反向验证：去掉 isAdmitted 的 roster 分支即变红）
// ─────────────────────────────────────────────────────────────────────────────
describe('断言 4：注册即生效', () => {
  it('mobile：POST /api/mobile/sessions 后，同一个 SourceContext 下一次 poll 立刻可派单', async () => {
    const f = fixture({ items: [msg('work')] })
    const before = await pollMobile(f.ctx, new AbortController().signal)
    expect(before.refused).toBe(1)
    expect(f.received).toHaveLength(0)

    // 真消息面登记：不改 Source 配置、不重启、不重建 ctx。
    const handler = phoneHandler(phoneHost(f.kv, stateDir), 'http://gw', vi.fn() as never)
    const registered = await handler(new Request('http://dsh/api/mobile/sessions',
      { method: 'POST', body: JSON.stringify({ id: 'work' }) }))
    expect(registered.status).toBe(200)
    expect(f.kv.get(KV.mobile.sessions('work'))).toBe(true)
    expect(f.roster()).toContain('work')

    f.setItems([msg('work', 2, 'after-registration')])
    const after = await pollMobile(f.ctx, new AbortController().signal)
    expect(after.refused).toBe(0)
    expect(f.received).toHaveLength(1)
    const trigger = f.received[0]!
    expect(trigger.meta.conversation).toBe('work')
    expect(mobileKind.scope!({ meta: trigger.meta }, f.config)).toMatchObject({ listened: true })
    expect(mobileKind.channel!.allowed!(trigger.channel!.address, f.config)).toBe(true)
    // registry.ts:131 的原签名调用路径也通，无需改 kind.ts。
    const settings = SettingsSchema.parse({ sources: { mobile: { enabled: true, config: { conversations: [] } } } })
    const registry = new SourceRegistry(() => settings)
    registry.register(mobileKind)
    expect(registry.scope({ source: 'mobile', meta: trigger.meta })).toMatchObject({ listened: true })
    expect(registry.channelAllowed({ source: 'mobile', address: trigger.channel!.address })).toBe(true)
  })

  it('team：注册名单同样立刻生效，且注入的名单快照进 meta 与 channel.address', async () => {
    const f = fixture({ items: [msg('work')], sessions: ['work'], team: true })
    const result = await pollTeam(f.ctx, new AbortController().signal)
    expect(result.refused).toBe(0)
    expect(f.received).toHaveLength(1)
    const trigger = f.received[0]!
    expect(trigger.meta[SESSION_ROSTER]).toEqual(['work'])
    expect(rosterOf(trigger.channel!.address[SESSION_ROSTER])).toEqual(['work'])
    expect(teamKind.scope!({ meta: trigger.meta }, f.config)).toMatchObject({ listened: true })
    expect(teamKind.channel!.allowed!(trigger.channel!.address, f.config)).toBe(true)
  })

  it('手配清单向后兼容：老配置里列过的会话照旧放行，与注册名单叠加', () => {
    const config = { conversations: [{ id: 'legacy', listen: 'all' as const }], pollSeconds: 5 }
    expect(mobileKind.scope!({ meta: { conversation: 'legacy', [SESSION_ROSTER]: [] } }, config))
      .toEqual({ listened: true, observed: true, row: 'legacy' })
    expect(mobileKind.channel!.allowed!({ conversation: 'legacy' }, config)).toBe(true)
    expect(isAdmitted(config.conversations, 'legacy', [])).toBe(true)
    expect(isAdmitted([], 'work', [])).toBe(false)
    expect(isAdmitted([], 'work', ['work'])).toBe(true)
  })

  it('名单快照随 Trigger 走：rosterOf 同时认 meta 数组与 address JSON 字符串', () => {
    const base = mobileTrigger(msg('work') as never, 'agent')!
    const injected = withRoster(base, ['work', 'main'])
    expect(rosterOf(injected.meta[SESSION_ROSTER])).toEqual(['main', 'work'])
    expect(rosterOf(injected.channel!.address[SESSION_ROSTER])).toEqual(['main', 'work'])
    expect(rosterOf(undefined)).toEqual([])
    expect(rosterOf('{bad json')).toEqual([])
    expect(mobileKind.scope!({ meta: injected.meta }, MOBILE_CONFIG)).toMatchObject({ listened: true })
  })

  it('真 Store：S1 写入的注册键能被 SourceContext.state.keys 列出并立刻放行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's4-store-'))
    const store = new Store(join(dir, 'db.sqlite'))
    try {
      // 与 POST /api/mobile/sessions 同一套写侧：真 Store 的 kv 表，不是内存替身。
      store.set(KV.mobile.sessions('work'), true)
      const state = {
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => { if (value === undefined) store.delete(key); else store.set(key, value) },
        keys: (family: { prefix: string }) => store.keys(family.prefix),
      }
      expect(sessionRoster(state as never)).toEqual(['work'])
      const received: Trigger[] = []
      const run = vi.fn(async () => JSON.stringify({ me: 'agent', items: [msg('work')], next: 1 }))
      const ctx = { state, config: () => MOBILE_CONFIG, commands: { withSignal: () => ({ run }) },
        receive: async (trigger: Trigger) => { received.push(trigger); return 'stored' as const },
        report: vi.fn(), threads: { describe: vi.fn() }, deployment: { stateDir: dir }, ready: Promise.resolve() } as never
      const result = await pollMobile(ctx, new AbortController().signal)
      expect(result.refused).toBe(0)
      expect(received).toHaveLength(1)
      expect(mobileKind.scope!({ meta: received[0]!.meta }, MOBILE_CONFIG)).toMatchObject({ listened: true })
      expect(store.get(MOBILE_UNLISTED)).toBeUndefined()
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
