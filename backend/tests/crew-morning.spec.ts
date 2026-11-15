/**
 * 晨报的运行时接线（issue #23 第 3 项）。
 *
 * 这里测的是**真运行时**，不是 `notices-out.ts` 的纯函数：接线的洞全在「谁在什么时候
 * 调它、说过的账记在哪」这一层。上一轮 `morningNotice` / `morningDue` 写好了却没接进 tick，
 * 于是晨报一次也没发过 —— 纯函数单测全绿也照样是死代码。
 *
 * 时钟靠给 `runMorning` / `runDaily` 传 `now` 控制（它们都收这个参数），
 * 所以不依赖跑测试时的真实时刻。
 */
import { afterEach, expect, it, vi } from 'vitest'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'
import { DAILY_HOUR, MORNING_HOUR } from '../src/app/notices-out.ts'
import { TICK_MS } from '../src/app/routine-runner.ts'
import { Runtime } from '../src/app/runtime.ts'
import { KV } from '../src/kv.ts'
import type { Ticket } from '../src/core/index.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

/** 本地某天的某个钟点。用本地构造器，避免测试机时区把「早上八点」算成别的钟点。 */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute)

/** 接上推送，收走这条运行时真发出去的每一条。 */
function pusher(host: Host) {
  const sent: { title: string; body: string; kind: string }[] = []
  ;(host.runtime as unknown as { remote?: unknown }).remote = { list: () => [{ deviceId: 'dev_1' }] }
  host.runtime.attachPusher(message => { sent.push({ title: message.title, body: message.body, kind: message.kind ?? '' }); return true })
  return sent
}

/**
 * 一张「等主人处理」的票：挂在等人回答那一步，是晨报「待处理」与跟进提醒的共同来源。
 *
 * 从一张真票派生而不是手搓：票的形状由 `Ticket` 定，手搓的票会缺 `mandate` 之类字段，
 * 于是测出来的失败是夹具的问题、不是接线的问题。
 */
async function waitingTicket(host: Host, title: string, updatedAt: string, id = '1'): Promise<Ticket> {
  const base = host.runtime.store.tickets.list()[0] ?? (await host.acceptedTicket(feishu(id, `@bot ${title}`))).ticket
  const waiting: Ticket = {
    ...base, id: `t-${title}`, title, updatedAt,
    attention: { id: `attention-${title}`, question: '按哪版来？' },
    assignments: [], inputs: [], undelivered: [], ended: undefined,
  }
  host.runtime.store.tickets.save(waiting)
  return waiting
}

it('sends the morning report once in the morning window, and never again that day', async () => {
  // 昨天日报报完了（水位在昨晚 21:00），今早的窗口从那一刻接上 —— 昨夜 22:00 那件正好在窗口里。
  h = await startRuntime(store => { store.set(KV.notices.reported, at(13, DAILY_HOUR).toISOString()) })
  const sent = pusher(h)
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  // 昨夜办完一件：把结束时刻挪到昨天日报之后、今早之前。
  const finished = { ...h.runtime.store.tickets.get(ticket.id)!, ended: { at: at(13, 22).toISOString(), by: 'executor' as const, outcome: 'completed' as const } }
  h.runtime.store.tickets.save(finished)

  const notice = await h.runtime.runMorning(at(14, MORNING_HOUR))
  expect(notice?.title).toBe('11 月 14 日 早报')
  // 日历那栏没有接入源，正文如实说读不到 —— 不冒充「今天没会」（设计系统 §六）。
  expect(notice?.body.split('\n')).toEqual(['自 11 月 13 日 21:00 起 办完 1 件', '今日日程读不到（还没有接入日历）'])
  expect(sent).toEqual([{ title: '11 月 14 日 早报', body: '自 11 月 13 日 21:00 起 办完 1 件\n今日日程读不到（还没有接入日历）', kind: 'morning' }])
  // 同一天再走一遍（下一个 tick）不再说。
  expect(await h.runtime.runMorning(at(14, MORNING_HOUR + 1))).toBeUndefined()
  expect(sent).toHaveLength(1)
})

it('says nothing before eight and nothing after the daily report takes over', async () => {
  h = await startRuntime()
  const sent = pusher(h)
  await waitingTicket(h, '修卡顿', at(14, 7).toISOString())
  expect(await h.runtime.runMorning(at(14, MORNING_HOUR - 1))).toBeUndefined()
  expect(await h.runtime.runMorning(at(14, DAILY_HOUR))).toBeUndefined()
  expect(sent).toEqual([])
})

it('keeps the morning silent on a quiet night, and does not re-ask on every tick', async () => {
  h = await startRuntime()
  const sent = pusher(h)
  expect(await h.runtime.runMorning(at(14, MORNING_HOUR))).toBeUndefined()
  expect(sent).toEqual([])
  // 说过的日子照样记下：否则这一拍之后每一拍都会重新算一遍（现在算出来是空，但接上日历后就不是了）。
  expect(h.runtime.store.get(KV.notices.morning)?.day).toBe('2026-11-14')
})

it('lists what waits on the person, with the same key the daily report uses so neither says it twice', async () => {
  h = await startRuntime()
  const sent = pusher(h)
  const waiting = await waitingTicket(h, '修卡顿', at(14, 7, 30).toISOString())
  const notice = await h.runtime.runMorning(at(14, MORNING_HOUR))
  expect(notice?.body).toContain('待处理 「修卡顿」在等你回答')
  // 说过的键落在库里（`KV.notices.morning.spoken`），日报读的是同一本。
  expect(h.runtime.store.get(KV.notices.morning)?.spoken).toEqual([`ticket:${waiting.id}`])
  // 日报读同一本账：「N 件等你」仍如实说积压，但同一条明细不再点名一遍。
  const daily = await h.runtime.runDaily(at(14, DAILY_HOUR))
  expect(daily?.body).toContain('1 件等你')
  expect(daily?.body).not.toContain('修卡顿')
  expect(sent.map(item => item.kind)).toEqual(['morning', 'daily'])
})

it('counts the daily report from the moment the morning went out, so the same work is not counted twice', async () => {
  h = await startRuntime()
  pusher(h)
  // **两张不同的票**，而且夜那张故意落在**今天凌晨三点** —— 这是唯一能区分两种窗口的位置：
  // 它既在早报的「昨夜」窗口里（昨天 21:00 之后），又在「今天零点」之后。
  // 若日报退回按今天零点起算，这张会被两份报告各数一次（办完 2 件）；按早报发出时刻起算就只有 1 件。
  const night = (await h.acceptedTicket(feishu('1', '@bot 夜里的活'))).ticket
  const today = (await h.acceptedTicket(feishu('3', '@bot 白天的活'))).ticket
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(night.id)!, ended: { at: at(14, 3).toISOString(), by: 'executor', outcome: 'completed' } })
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(today.id)!, ended: { at: at(14, 10).toISOString(), by: 'executor', outcome: 'completed' } })
  const morning = await h.runtime.runMorning(at(14, MORNING_HOUR))
  expect(morning?.body).toContain('办完 1 件')
  // 日报的窗口从早报发出那一刻接上：只数白天那一件。若退回「今天零点」，两件都会被数进来。
  const daily = await h.runtime.runDaily(at(14, DAILY_HOUR))
  expect(daily?.body).toContain('办完 1 件')
  expect(daily?.body).not.toContain('办完 2 件')
})

it('says the calendar is unreadable rather than pretending there are no meetings', async () => {
  h = await startRuntime()
  pusher(h)
  // 只有待处理、没有昨夜动态时，日历那一栏在正文里如实写「读不到」，不冒充「今天没会」。
  await waitingTicket(h, '修卡顿', at(14, 7).toISOString())
  const notice = await h.runtime.runMorning(at(14, MORNING_HOUR))
  expect(notice?.body.split('\n')).toEqual(['今日日程读不到（还没有接入日历）', '待处理 「修卡顿」在等你回答'])
})

it('still reports the day after a restart: the ledger is in the database, not in the process', async () => {
  h = await startRuntime()
  const sent = pusher(h)
  await waitingTicket(h, '修卡顿', at(14, 7).toISOString())
  expect(await h.runtime.runMorning(at(14, MORNING_HOUR))).not.toBeUndefined()
  expect(sent).toHaveLength(1)
  // 同一个状态目录上重起一台运行时：早报不该再发一遍。
  const directory = h.directory
  await h.runtime.stop()
  const restarted = await startRuntime(store => { store.set(KV.notices.morning, { day: '2026-11-14', spoken: [] }) })
  try {
    expect(directory).toBeTruthy()
    expect(await restarted.runtime.runMorning(at(14, MORNING_HOUR + 2))).toBeUndefined()
  } finally { await restarted.stop() }
})

it('counts the routines it really dispatched across a restart', async () => {
  // `countRoutine()` 的日计数用的是真实 `new Date()`（业务语义不改：到点派单按墙钟记当天）。
  // 所以这里只把 `Date` 钉到 at(14,9) 那一刻（2026-11-14 09:00 +08:00），让「当天」与断言一致；
  // 不 fake setInterval/setTimeout，避免接管 startRuntime 的异步计时器造成死等。finally 恢复。
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(at(14, 9))
  try {
    h = await startRuntime()
    pusher(h)
    h.runtime.store.set(KV.routines.task('standup'), { id: 'standup', title: '每天站会', cycle: 'daily', bot_id: 'lead', enabled: true,
      created_at: at(13, 9).toISOString(), last_run: at(13, 9).toISOString() })
    const dispatched = await h.runtime.runRoutines(at(14, 9).getTime())
    expect(dispatched.dispatched).toEqual(['standup'])
    expect(h.runtime.store.get(KV.notices.routines)).toEqual({ day: '2026-11-14', count: 1 })
    // 重启后计数器不归零：日报里那个数仍是当天的数。
    await h.runtime.stop()
    const restarted = await startRuntime(store => { store.set(KV.notices.routines, { day: '2026-11-14', count: 1 }) })
    try {
      expect(restarted.runtime.store.get(KV.notices.routines)).toEqual({ day: '2026-11-14', count: 1 })
    } finally { await restarted.stop() }
    h = undefined
  } finally {
    vi.useRealTimers()
  }
})

it('is wired into the minute tick: the report that was never sent because nothing called it', async () => {
  // 这一条是回归守卫。上一轮 `morningNotice` / `morningDue` 都写好了，但 `startRoutines` 里
  // 没有 `runMorning`，于是晨报一次也没发过 —— 纯函数单测全绿，功能是死的。
  // 所以这里不直接调 `runMorning`，而是让调度器自己走一拍。
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const called: string[] = []
  const morning = vi.spyOn(Runtime.prototype, 'runMorning').mockImplementation(async () => { called.push('morning'); return undefined })
  const daily = vi.spyOn(Runtime.prototype, 'runDaily').mockImplementation(async () => { called.push('daily'); return undefined })
  try {
    h = await startRuntime()
    called.length = 0
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(called).toContain('morning')
    // 顺序也要对：早报在日报之前，两份报告的窗口才接得上。
    expect(called.indexOf('morning')).toBeLessThan(called.indexOf('daily'))
  } finally {
    morning.mockRestore(); daily.mockRestore(); vi.useRealTimers()
  }
})

it('runs the whole production path: the real minute tick sends a real morning notice to the push outlet', async () => {
  // 端到端走真路径：真的 setInterval 调度器 → 真的 runMorning → 真的 morningNotice → 真的 pushNotice
  // → 推送出口。中间一处都不替身（只把推送出口换成收集器，免得真往手机上发）。
  // 时钟也换成假的：把「现在」拨到早上八点，调度器那一拍才落在早报窗口里。
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: at(14, MORNING_HOUR) })
  try {
    h = await startRuntime(store => {
      // 昨晚日报报完了（水位在 21:00）；昨夜 22:00 办完那件落在它的窗口里，早报才有内容可说
      // （否则三段全空、正确地不发）。
      store.set(KV.notices.reported, at(13, DAILY_HOUR).toISOString())
    })
    const sent = pusher(h)
    const base = h.runtime.store.tickets.list()[0]
    if (base) {
      h.runtime.store.tickets.save({ ...base, ended: { at: at(13, 22).toISOString(), by: 'executor', outcome: 'completed' } })
    } else {
      // 没有现成工单时直接用账本造一条：这条用例只关心推送是否真到，不关心票从哪来。
      const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
      h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, ended: { at: at(13, 22).toISOString(), by: 'executor', outcome: 'completed' } })
    }
    // 调度器的第一拍故意晚一个周期；推进一个 TICK_MS，让它自己走。
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const morning = sent.filter(item => item.kind === 'morning')
    expect(morning).toHaveLength(1)
    expect(morning[0]!.title).toBe('11 月 14 日 早报')
    expect(morning[0]!.body).toContain('办完 1 件')
    expect(morning[0]!.body).toContain('今日日程读不到')
    // 窗口起于昨晚 21:00（水位），抬头如实写那一刻，不写「昨夜」。
    expect(morning[0]!.body).toContain('自 11 月 13 日 21:00 起')
  } finally { vi.useRealTimers() }
})

/**
 * 进程整夜不在线：08-21 的窗口一分钟都没跑过。
 *
 * 这时「昨夜」按现算会落在 [昨天 21:00, 现在)，但**那段时间进程不在线，日报也没跑**，
 * 所以昨天 21:00–24:00 结束的票既没进早报（没跑）、也不会进日报（日报从今天零点起算）。
 * 修法不是把下界往前挪一格（`max(今天零点, 昨晚21点)` 仍然漏掉 21:00–24:00 之外更早的停机段），
 * 而是以**持久化的已覆盖水位**为准：下一次真跑到的报表，窗口从上次报完那一刻接上。
 */
it('covers the window it was offline for, instead of dropping everything before midnight', async () => {
  h = await startRuntime()
  const sent = pusher(h)
  // 上次报表跑到昨天 08:00 的早报（那天日报也没跑成）。之后进程整夜不在线，直到今天 08:00。
  h.runtime.store.set(KV.notices.reported, at(13, MORNING_HOUR).toISOString())
  // 昨夜 22:00 办完一件（既不在早报的「昨天21点起」里，也不在日报的「今天零点起」里 —— 它落在
  // 昨晚 21:00–24:00，正是旧公式两份都不数的位置）。
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 夜里的活'))
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, ended: { at: at(13, 22).toISOString(), by: 'executor', outcome: 'completed' } })
  const notice = await h.runtime.runMorning(at(14, MORNING_HOUR))
  // 它必须在早报里出现：这段停机窗口没人报过，下一次真跑到的报表就得把它补上。
  expect(notice?.body).toContain('办完 1 件')
  expect(sent.filter(item => item.kind === 'morning')).toHaveLength(1)
  // 报过之后水位前进到这一刻，同一段不会被下一份报表再数一遍。
  expect(h.runtime.store.get(KV.notices.reported)).toBe(at(14, MORNING_HOUR).toISOString())
})

/**
 * 反向：没有水位线时（第一次启动）不能凭空补报很久以前的历史。
 *
 * 这条与上一条是一对：`reported` 缺失说明「这台机器从没报过」，此时窗口下界只能是今天零点 ——
 * 不是「有史以来」。否则第一次启动会把库里所有结束过的票都算进昨夜。
 */
it('does not dig up ancient history on a first start with no ledger at all', async () => {
  h = await startRuntime()
  pusher(h)
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 很久以前的活'))
  // 十天前结束的票：第一次启动时不该被当成「昨夜」。
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, ended: { at: at(4, 12).toISOString(), by: 'executor', outcome: 'completed' } })
  expect(await h.runtime.runMorning(at(14, MORNING_HOUR))).toBeUndefined()
})

/**
 * 跨日：昨天早报报过、今天再报时，窗口从昨天那次报完接上，不重不漏。
 *
 * 这是水位线的正向语义 —— 它既覆盖「整夜不在线」，也不让「连续两天都在线」时数两遍。
 */
it('picks up where the last report left off across a day boundary', async () => {
  h = await startRuntime()
  pusher(h)
  // 昨天 08:00 的早报报完了（水位在那里）。
  h.runtime.store.set(KV.notices.reported, at(13, MORNING_HOUR).toISOString())
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 昨天的活'))
  // 昨天 09:00 办完 —— 在水位之后，今天必须报出来。
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, ended: { at: at(13, 9).toISOString(), by: 'executor', outcome: 'completed' } })
  const notice = await h.runtime.runMorning(at(14, MORNING_HOUR))
  expect(notice?.body).toContain('办完 1 件')
})

/**
 * 重启：水位线落在库里，进程重起不会把已经报过的窗口再报一遍。
 */
it('keeps the covered watermark across a restart', async () => {
  h = await startRuntime()
  pusher(h)
  h.runtime.store.set(KV.notices.reported, at(13, MORNING_HOUR).toISOString())
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 夜里的活'))
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, ended: { at: at(13, 22).toISOString(), by: 'executor', outcome: 'completed' } })
  expect(await h.runtime.runMorning(at(14, MORNING_HOUR))).not.toBeUndefined()
  await h.runtime.stop()
  const restarted = await startRuntime(store => { store.set(KV.notices.reported, at(14, MORNING_HOUR).toISOString()) })
  try {
    expect(await restarted.runtime.runMorning(at(14, MORNING_HOUR + 2))).toBeUndefined()
  } finally { await restarted.stop() }
  h = undefined
})

/**
 * 进程从昨晚到现在完全不在线：早报那一整段（08–21）一分钟都没跑过，直到今晚 21:00 才第一次跑。
 *
 * 这是任务里那条最要命的场景 —— 昨夜 21:00–24:00 结束的票既不在早报里（没跑），
 * 也不在日报里（日报从今天零点起算）。按水位线，日报的窗口从上次报完那一刻接上，
 * 于是这段被补进日报，而不是凭空消失。
 */
it('covers the night in the daily report when the morning never ran at all', async () => {
  h = await startRuntime()
  const sent = pusher(h)
  // 上次报表停在昨天 08:00 的早报；昨天日报与今天早报都没跑（进程整夜不在线）。
  h.runtime.store.set(KV.notices.reported, at(13, MORNING_HOUR).toISOString())
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 夜里的活'))
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, ended: { at: at(13, 22).toISOString(), by: 'executor', outcome: 'completed' } })
  // 今晚 21:00 第一次跑日报：昨夜那件必须在里面（按「今天零点」起算就会漏掉）。
  const daily = await h.runtime.runDaily(at(14, DAILY_HOUR))
  expect(daily?.body).toContain('办完 1 件')
  expect(sent.filter(item => item.kind === 'daily')).toHaveLength(1)
})

/**
 * 早报自己也要推进水位：它报过的那一段，下一份报表不能再数一遍。
 *
 * 反向对照 —— 只有日报推进水位时，第二天早报会从「昨天日报那一刻」重算，
 * 把昨天早报已经说过的昨夜那段再说一遍。
 */
it('does not repeat the night the morning already covered, when only the morning ran that day', async () => {
  h = await startRuntime(store => { store.set(KV.notices.reported, at(13, DAILY_HOUR).toISOString()) })
  pusher(h)
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 夜里的活'))
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, ended: { at: at(13, 22).toISOString(), by: 'executor', outcome: 'completed' } })
  // 14 日早报报了昨夜那件；14 日日报没跑成（进程当晚不在线）。
  expect(await h.runtime.runMorning(at(14, MORNING_HOUR))).not.toBeUndefined()
  // 15 日早报：水位已在 14 日 08:00，没有新事，就不该再说一遍「昨夜办完 1 件」。
  expect(await h.runtime.runMorning(at(15, MORNING_HOUR))).toBeUndefined()
})

/**
 * 安静的早晨：什么都不发，但水位照样前进。
 *
 * 不前进的话，今晚日报的窗口会从更早开始 —— 这一段确实没有票，数不会错，但窗口会一天天变宽，
 * 变成「上一次有内容的那天」。水位是「报表已经统计到哪」的事实，不是「哪天发过」。
 */
it('moves the watermark on a quiet morning too, even though nothing was sent', async () => {
  h = await startRuntime(store => { store.set(KV.notices.reported, at(13, DAILY_HOUR).toISOString()) })
  pusher(h)
  expect(await h.runtime.runMorning(at(14, MORNING_HOUR))).toBeUndefined()
  expect(h.runtime.store.get(KV.notices.reported)).toBe(at(14, MORNING_HOUR).toISOString())
})

/**
 * 停机跨多天：水位停在三天前，第一份报告会把那几天的活一起统计进来。
 *
 * 数是真的，但**时间范围也必须是真的** —— 说「昨夜办完 3 件」是误报：人按「昨夜」去理解就错了。
 * 抬头要写出真实起点。
 */
it('names the real window instead of calling a multi-day backlog 昨夜', async () => {
  h = await startRuntime()
  pusher(h)
  // 水位停在 12 日 08:00 的早报；之后进程一直不在线，直到 14 日 08:00。
  h.runtime.store.set(KV.notices.reported, at(12, MORNING_HOUR).toISOString())
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 停机期间的活'))
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, ended: { at: at(13, 15).toISOString(), by: 'executor', outcome: 'completed' } })
  const notice = await h.runtime.runMorning(at(14, MORNING_HOUR))
  // 13 日 15:00 那件在窗口里，但窗口起于 12 日 08:00 —— 不能叫「昨夜」。
  expect(notice?.body).toContain('办完 1 件')
  expect(notice?.body).toContain('自 11 月 12 日 08:00 起')
  expect(notice?.body).not.toContain('昨夜')
})

/**
 * 首次启动（没有水位线）：从今天零点起算，抬头说「今日」。
 *
 * 与上一条是一对：同是「补一段没报过的窗口」，但这里的窗口就在今天之内，说「今日」才对；
 * 也不该因为「没有水位」就退回「上次汇报以来」—— `reportedFrom` 给了今天零点这个明确下界。
 */
it('says 今日 on a first start, because its window really does start at midnight', async () => {
  h = await startRuntime()
  pusher(h)
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 今天凌晨的活'))
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, ended: { at: at(14, 2).toISOString(), by: 'executor', outcome: 'completed' } })
  const notice = await h.runtime.runMorning(at(14, MORNING_HOUR))
  expect(notice?.body.split('\n')[0]).toBe('今日 办完 1 件')
})

/**
 * 跨日：昨天早报报过（水位在昨天 08:00），今天再报 —— 窗口从昨天 08:00 起，如实写出那一天。
 */
it('names the day the window started when the last report was yesterday', async () => {
  h = await startRuntime()
  pusher(h)
  h.runtime.store.set(KV.notices.reported, at(13, MORNING_HOUR).toISOString())
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 昨天的活'))
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, ended: { at: at(13, 20).toISOString(), by: 'executor', outcome: 'completed' } })
  const notice = await h.runtime.runMorning(at(14, MORNING_HOUR))
  expect(notice?.body.split('\n')[0]).toBe('自 11 月 13 日 08:00 起 办完 1 件')
})
