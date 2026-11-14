import { describe, expect, it } from 'vitest'
import {
  MAIL_FRESH_MS, judgeMail, mailDedupKey, scanInbox, type MailMessage, type MailPort,
} from '../src/app/inbox.ts'

/** 一封「同事直接写给我、等我回话」的信。各例只在它上面改一处，好看出是哪一条规则在起作用。 */
const mail = (over: Partial<MailMessage> = {}): MailMessage => ({
  messageId: '<CAF-0001@example.com>',
  from: '林一 <lin@example.com>',
  subject: '这版文案你定哪版？',
  receivedAt: '2026-11-14T09:12:00.000Z',
  to: ['me@example.com'],
  directTo: true,
  unread: true,
  ...over,
})

describe('judgeMail — 只提醒「直接找我 / 要我决策 / 有时限」', () => {
  it('reminds for a colleague asking me to decide', () => {
    expect(judgeMail(mail())).toEqual({ notify: true, reason: 'decision' })
  })

  it('reminds for a plain direct letter even without decision or deadline words', () => {
    // 「直接找我」本身就是理由：人都点到你名下了，不该由助手替他判断重不重要。
    expect(judgeMail(mail({ subject: '周末那家店叫什么来着' })))
      .toEqual({ notify: true, reason: 'direct' })
  })

  it('stays quiet for a mailing list and for bulk labels', () => {
    expect(judgeMail(mail({ from: '少数派 <newsletter@sspai.com>', subject: '本周精选 12 篇',
      listId: '<weekly.sspai.com>' }))).toEqual({ notify: false, reason: 'list' })
    expect(judgeMail(mail({ subject: '新品上架', labels: ['CATEGORY_PROMOTIONS'] })))
      .toEqual({ notify: false, reason: 'newsletter' })
  })

  it('stays quiet for automated senders, auto-replies and bulk precedence', () => {
    expect(judgeMail(mail({ from: 'GitHub <notifications@github.com>', subject: '有人 @ 了你' })))
      .toEqual({ notify: false, reason: 'automated' })
    expect(judgeMail(mail({ from: 'no-reply@shop.example', subject: '你的订单已发货' })))
      .toEqual({ notify: false, reason: 'automated' })
    expect(judgeMail(mail({ autoSubmitted: 'auto-replied' }))).toEqual({ notify: false, reason: 'automated' })
    expect(judgeMail(mail({ precedence: 'bulk' }))).toEqual({ notify: false, reason: 'automated' })
  })

  it('stays quiet once I have replied, even if the subject still asks for a decision', () => {
    expect(judgeMail(mail({ replied: true }))).toEqual({ notify: false, reason: 'replied' })
  })

  it('stays quiet when I am only on the cc list', () => {
    // 抄送是「给你留个底」，不是「等你动手」。
    expect(judgeMail(mail({ directTo: false, to: ['team@example.com', 'me@example.com'] })))
      .toEqual({ notify: false, reason: 'not-direct' })
  })

  it('treats a single-recipient letter as direct when the caller does not say', () => {
    const { directTo: _drop, ...rest } = mail({ subject: '帮我看眼这个' })
    expect(judgeMail(rest)).toEqual({ notify: true, reason: 'direct' })
    expect(judgeMail({ ...rest, to: ['a@example.com', 'b@example.com'] }))
      .toEqual({ notify: false, reason: 'not-direct' })
  })

  it('calls out a deadline before a plain decision', () => {
    // 两条都命中时说更急的那条：措辞决定人要不要现在放下手上的事。
    expect(judgeMail(mail({ subject: '今天下班前给我这版可以吗' })))
      .toEqual({ notify: true, reason: 'deadline' })
  })
})

describe('judgeMail — 同一条邮件不提醒两次', () => {
  it('refuses a message id it has already reminded about', () => {
    const seen = new Set([mailDedupKey(mail())])
    expect(judgeMail(mail(), id => seen.has(id))).toEqual({ notify: false, reason: 'duplicate' })
  })

  it('treats message ids differing only in case or angle brackets as the same letter', () => {
    // IMAP 与 MCP 两个来源回显的写法不一样，不能因此各提醒一次。
    expect(mailDedupKey(mail({ messageId: '  <CAF-0001@Example.com> ' }))).toBe(mailDedupKey(mail()))
  })

  it('falls back to a stable key when the letter carries no message id', () => {
    const bare = mail({ messageId: '' })
    expect(mailDedupKey(bare)).toBe(mailDedupKey({ ...bare }))
    expect(mailDedupKey(bare)).toContain('lin@example.com')
  })
})

describe('scanInbox — Source 骨架（真实接入点是一个 fetch）', () => {
  const port = (mails: readonly MailMessage[]): MailPort => ({ fetch: async () => mails })

  it('turns only the letters worth telling into notices, and remembers those as seen', async () => {
    const scan = await scanInbox(port([
      mail({ messageId: '<a@x>', subject: '这版你定哪版' }),
      mail({ messageId: '<b@x>', from: 'newsletter@sspai.com', listId: '<l.sspai>' }),
      mail({ messageId: '<c@x>', replied: true }),
    ]), { since: '2026-11-14T00:00:00.000Z', seen: [], now: new Date('2026-11-14T09:20:00.000Z') })
    expect(scan.notices.map(notice => notice.kind)).toEqual(['mail'])
    expect(scan.notices[0]?.title).toContain('你定哪版')
    // 只有真提醒过的那封进账（键按 mailDedupKey 归一化后存）：不提醒的不用记，记了反而让账本变长。
    expect(scan.seen).toEqual(['a@x'])
  })

  it('does not remind twice across two scans of the same window', async () => {
    const mails = [mail({ messageId: '<d@x>' })]
    const now = new Date('2026-11-14T09:20:00.000Z')
    const first = await scanInbox(port(mails), { since: '2026-11-14T00:00:00.000Z', seen: [], now })
    const second = await scanInbox(port(mails), { since: '2026-11-14T00:00:00.000Z', seen: first.seen, now })
    expect(first.notices).toHaveLength(1)
    expect(second.notices).toEqual([])
    expect(second.seen).toEqual(first.seen)
  })

  it('advances the cursor to the newest arrival so the next poll starts where this one ended', async () => {
    const scan = await scanInbox(port([
      mail({ messageId: '<e@x>', receivedAt: '2026-11-14T09:12:00.000Z' }),
      mail({ messageId: '<f@x>', receivedAt: '2026-11-14T09:40:00.000Z', replied: true }),
    ]), { since: '2026-11-14T00:00:00.000Z', seen: [], now: new Date('2026-11-14T09:45:00.000Z') })
    expect(scan.cursor).toBe('2026-11-14T09:40:00.000Z')
  })

  it('keeps the cursor put when the window was empty', async () => {
    const scan = await scanInbox(port([]), { since: '2026-11-14T00:00:00.000Z', seen: [] })
    expect(scan).toMatchObject({ notices: [], seen: [], cursor: '2026-11-14T00:00:00.000Z' })
  })

  it('leaves an old unread letter to the morning report instead of pushing it', async () => {
    // 开机补拉一整夜的信时，逐封弹窗就是轰炸。过期的只进晨报「待处理」。
    const scan = await scanInbox(port([mail({ messageId: '<g@x>', receivedAt: '2026-11-14T02:00:00.000Z' })]),
      { since: '2026-11-14T00:00:00.000Z', seen: [], now: new Date('2026-11-14T09:20:00.000Z') })
    expect(scan.notices).toEqual([])
    expect(scan.seen).toEqual([])
    expect(scan.stale.map(message => message.messageId)).toEqual(['<g@x>'])
  })
})

describe('MAIL_FRESH_MS', () => {
  it('is a short window, not a second inbox', () => {
    expect(MAIL_FRESH_MS).toBeGreaterThan(0)
    expect(MAIL_FRESH_MS).toBeLessThanOrEqual(3600_000)
  })
})
