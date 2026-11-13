import { describe, expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { groupsOf, MAIN_GROUP, type GroupBot, type GroupSession, type GroupTicket, type GroupsInput } from '../src/app/groups.ts'

// 群组只读投影（契约 §3）。测试只从 groupsOf 这个公开入口进去，不看内部实现：
// 分组归属、三态判据、只读边界各有独立的证据。

// 编译期证据：lead 在 timeline 里要粘贴的三种现成来源 —— runtime.store.tickets.list()
// 是 Ticket[]、crewRoster().bots 是花名册行、sessionIds() 是 string[] —— 必须能不改造地
// 喂给 groupsOf，否则合并时 typecheck 会红。任何一条不成立，下面三个 const 就编译不过。
type TicketListFits = Ticket[] extends NonNullable<GroupsInput['tickets']> ? true : false
type RosterBotsFits = { id: string; name: string; role: string }[] extends NonNullable<GroupsInput['bots']> ? true : false
type SessionIdsFits = string[] extends NonNullable<GroupsInput['sessions']> ? true : false
const ticketListFits: TicketListFits = true
const rosterBotsFits: RosterBotsFits = true
const sessionIdsFits: SessionIdsFits = true

const bot = (id: string, session_id?: string, group?: string): GroupBot =>
  ({ id, ...(session_id ? { session_id } : {}), ...(group ? { group } : {}) })
const ticket = (id: string, session_id?: string): GroupTicket => ({ id, ...(session_id ? { session_id } : {}) })
const session = (id: string, group?: string, title?: string): GroupSession =>
  ({ id, ...(group ? { group } : {}), ...(title ? { title } : {}) })

describe('groupsOf — 按会话归属分组', () => {
  it('把声明同一 group 的会话合进一组，未声明的会话自成一组，main 恒在首位', () => {
    const view = groupsOf({
      sessions: ['main', session('work', 'dev', '开发线'), session('triage', 'dev'), 'solo'],
      bots: [], tickets: [],
    })
    expect(view.state).toBe('live')
    expect(view).not.toHaveProperty('reason') // reason 只在非 live 时出现
    expect(view.groups.map(group => group.id)).toEqual([MAIN_GROUP, 'dev', 'solo'])
    expect(view.groups[0]).toMatchObject({ id: 'main', title: 'main', sessions: ['main'] })
    expect(view.groups[1]).toMatchObject({ id: 'dev', title: '开发线', sessions: ['work', 'triage'] })
    expect(view.groups[2]).toMatchObject({ id: 'solo', title: 'solo', sessions: ['solo'] })
  })

  it('bot 按归属会话归组，不按 bot 自己的 id 猜', () => {
    const view = groupsOf({
      sessions: ['main', session('work', 'dev'), session('triage', 'dev')],
      bots: [bot('coder', 'work'), bot('writer', 'triage'), bot('scribbler', 'main')],
      tickets: [],
    })
    const dev = view.groups.find(group => group.id === 'dev')
    const main = view.groups.find(group => group.id === MAIN_GROUP)
    expect(dev?.bots).toEqual(['coder', 'writer'])
    expect(main?.bots).toEqual(['scribbler'])
  })

  it('工单按归属会话数进 ticket_count，只数不写', () => {
    const view = groupsOf({
      sessions: ['main', session('work', 'dev')],
      bots: [],
      tickets: [ticket('t1', 'work'), ticket('t2', 'work'), ticket('t3', 'main'), ticket('t4')],
    })
    expect(view.groups.find(group => group.id === 'dev')?.ticket_count).toBe(2)
    expect(view.groups.find(group => group.id === MAIN_GROUP)?.ticket_count).toBe(2)
    // 只读：输出里只有个数，没有任何工单对象、没有新账可写。
    expect(JSON.stringify(view)).not.toContain('"t1"')
    expect(Object.keys(view.groups[0]!)).toEqual(['id', 'title', 'sessions', 'bots', 'ticket_count'])
  })

  it('认 conversation 与 channels[].address.conversation 两种老形态归属', () => {
    const view = groupsOf({
      sessions: ['main', session('work', 'dev')],
      bots: [],
      tickets: [
        { id: 'a', conversation: 'work' },
        { id: 'b', channels: [{ address: { conversation: 'work' } }] },
        { id: 'c', channels: [{ address: {} }] },
      ],
    })
    expect(view.groups.find(group => group.id === 'dev')?.ticket_count).toBe(2)
    expect(view.groups.find(group => group.id === MAIN_GROUP)?.ticket_count).toBe(1)
  })

  it('无归属、以及指向名单外会话的，一律落 main，绝不凭空造一个组', () => {
    const view = groupsOf({
      sessions: ['main'],
      bots: [bot('loose'), bot('ghost', 'not-in-list'), bot('claimed', 'not-in-list', 'invented')],
      tickets: [ticket('t1', 'not-in-list'), { id: 't2', group: 'invented' }],
    })
    expect(view.groups.map(group => group.id)).toEqual([MAIN_GROUP])
    expect(view.groups[0]).toMatchObject({ bots: ['loose', 'ghost', 'claimed'], ticket_count: 2 })
  })

  it('显式 group 只在已知组上生效，会话归属优先于它', () => {
    const view = groupsOf({
      sessions: ['main', session('work', 'dev'), session('ops', 'ops')],
      bots: [bot('coder', 'work', 'ops'), bot('floating', '', 'ops')],
      tickets: [],
    })
    expect(view.groups.find(group => group.id === 'dev')?.bots).toEqual(['coder'])
    expect(view.groups.find(group => group.id === 'ops')?.bots).toEqual(['floating'])
  })

  it('重复的会话 / bot / 工单 id 各算一次，坏行跳过', () => {
    const view = groupsOf({
      sessions: ['main', 'main', session('work', 'dev'), session('work', 'dev'), { id: '' }],
      bots: [bot('a', 'work'), bot('a', 'work'), { id: '' }],
      tickets: [ticket('t1', 'work'), ticket('t1', 'work'), { id: '' }],
    })
    expect(view.state).toBe('live')
    expect(view.groups.find(group => group.id === 'dev')).toMatchObject({
      sessions: ['work'], bots: ['a'], ticket_count: 1,
    })
    expect(view.groups.find(group => group.id === MAIN_GROUP)?.sessions).toEqual(['main'])
  })

  it('是纯函数：不改输入、同样输入同样输出', () => {
    const input = {
      sessions: Object.freeze(['main', Object.freeze(session('work', 'dev'))]),
      bots: Object.freeze([Object.freeze(bot('coder', 'work'))]),
      tickets: Object.freeze([Object.freeze(ticket('t1', 'work'))]),
    }
    const first = groupsOf(input)
    const second = groupsOf(input)
    expect(second).toEqual(first)
    expect(input.sessions).toEqual(['main', session('work', 'dev')])
    expect(input.bots).toEqual([bot('coder', 'work')])
    // 每次都给新数组：调用方改自己的投影不会污染下一次。
    first.groups[0]!.bots.push('intruder')
    expect(groupsOf(input).groups[0]!.bots).toEqual([])
  })
})

describe('groupsOf — 接入形状', () => {
  it('timeline 现成的三个源能直接喂进来，不用改造', () => {
    expect([ticketListFits, rosterBotsFits, sessionIdsFits]).toEqual([true, true, true])
    // 真实 Ticket 的一行：channels[].address.conversation 就是归属会话。
    const rows = [{ id: 't1', channels: [
      { source: 'team', thread: 'team:work:1', address: { conversation: 'work', bot_id: 'coder' } },
    ] }]
    const rosterRows = [{ id: 'coder', name: '码农', role: 'member' }]
    const view = groupsOf({
      sessions: ['main', session('work', 'dev')],
      bots: rosterRows,
      tickets: rows,
    })
    expect(view.state).toBe('live')
    expect(view.groups.find(group => group.id === 'dev')?.ticket_count).toBe(1)
    // 花名册行不带 session_id：无归属落 main，不猜它属于哪一段。
    expect(view.groups.find(group => group.id === MAIN_GROUP)?.bots).toEqual(['coder'])
  })
})

describe('groupsOf — 三态诚实', () => {
  it('三个源都读到、确实全空，才说 empty', () => {
    const view = groupsOf({ sessions: [], bots: [], tickets: [] })
    expect(view.state).toBe('empty')
    expect(view.groups).toEqual([])
    expect(view.reason).toContain('读得到')
    expect(view.reason).not.toContain('读不到')
  })

  it('任一源整份缺席就是 unavailable，绝不把读不到当空', () => {
    const cases = [
      { name: 'sessions 缺席', input: { bots: [], tickets: [] } },
      { name: 'bots 缺席', input: { sessions: [], tickets: [] } },
      { name: 'tickets 缺席', input: { sessions: [], bots: [] } },
      { name: 'null 也不是空数组', input: { sessions: null, bots: [], tickets: [] } },
      { name: '全缺席', input: {} },
    ] as const
    for (const { name, input } of cases) {
      const view = groupsOf(input)
      expect(view.state, name).toBe('unavailable')
      expect(view.groups, name).toEqual([])
      expect(view.groups.length, name).toBe(0) // 不是「有 0 组」，是读不到
      expect(view.reason, name).toContain('读不到')
      expect(view.reason, name).not.toContain('读得到')
    }
  })

  it('上游明说读不到时，即使其它两个源是空数组也不许落成 empty', () => {
    const view = groupsOf({ sessions: [], bots: [], tickets: [], unavailableReason: 'Store 暂时读不出来' })
    expect(view.state).toBe('unavailable')
    expect(view.reason).toBe('Store 暂时读不出来')
  })

  it('有数据就说 live，哪怕只有一个源有内容', () => {
    expect(groupsOf({ sessions: ['main'], bots: [], tickets: [] }).state).toBe('live')
    expect(groupsOf({ sessions: [], bots: [bot('a')], tickets: [] }).state).toBe('live')
    expect(groupsOf({ sessions: [], bots: [], tickets: [ticket('t1')] }).state).toBe('live')
  })

  it('只有一个源有内容时，其余成员仍落 main，组里如实写 0', () => {
    const view = groupsOf({ sessions: [], bots: [bot('a')], tickets: [] })
    expect(view.groups).toHaveLength(1)
    expect(view.groups[0]).toMatchObject({ id: MAIN_GROUP, bots: ['a'], sessions: [], ticket_count: 0 })
  })
})
