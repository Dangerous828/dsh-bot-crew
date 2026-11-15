import { describe, expect, it } from 'vitest'
import {
  deliver, MAX_QUEUE_PER_DEVICE, PushOutbox,
  noticeId, pendingFor, seenLedgerPatch, type PushMessage,
} from '../src/app/push.ts'

// 真实设备号是手机报的 ANDROID_ID（16 位十六进制），不是带前缀的假值。
const DEVICE = 'd021988751fdd554'
const OTHER = '55c86317'
const msg = (over: Partial<PushMessage> = {}): PushMessage => ({
  deviceId: DEVICE, title: '有事', body: '队伍在等你', kind: 'followup', at: '2026-11-14T21:00:00.000Z', ...over,
})

describe('noticeId', () => {
  it('is stable for the same notice so a resend dedups', () => {
    expect(noticeId(msg())).toBe(noticeId(msg()))
  })
  it('differs across device, kind, body and time', () => {
    const base = noticeId(msg())
    expect(noticeId(msg({ deviceId: OTHER }))).not.toBe(base)
    expect(noticeId(msg({ kind: 'mail' }))).not.toBe(base)
    expect(noticeId(msg({ body: '别的事' }))).not.toBe(base)
    expect(noticeId(msg({ at: '2026-11-14T22:00:00.000Z' }))).not.toBe(base)
  })
  it('is a short lowercase hex key and does not leak the body', () => {
    expect(noticeId(msg())).toMatch(/^[0-9a-f]{16}$/)
    expect(noticeId(msg())).not.toContain('队伍')
  })
})

describe('pendingFor (peek) — never deletes on GET', () => {
  it('hands the device its queued notices but keeps them until ACK', () => {
    const outbox = new PushOutbox()
    deliver(msg(), { online: false, outbox })
    deliver(msg({ body: '第二件', kind: 'routine' }), { online: false, outbox })
    expect(pendingFor(DEVICE, outbox).items.map(item => item.body)).toEqual(['队伍在等你', '第二件'])
    // 关键：peek 之后**仍在队列**，重复 GET 拿到同一批（App 崩溃重试不丢件）。
    expect(outbox.depth(DEVICE)).toBe(2)
    expect(pendingFor(DEVICE, outbox).items.map(item => item.body)).toEqual(['队伍在等你', '第二件'])
  })

  it('carries a stable id equal to the enqueue-time id', () => {
    const outbox = new PushOutbox()
    deliver(msg(), { online: false, outbox })
    const [item] = pendingFor(DEVICE, outbox).items
    expect(item!.id).toBe(noticeId(msg()))
    // 再 peek 一次还是同一个 id。
    expect(pendingFor(DEVICE, outbox).items[0]!.id).toBe(item!.id)
  })

  it('never hands one device another device’s notices', () => {
    const outbox = new PushOutbox()
    deliver(msg(), { online: false, outbox })
    deliver(msg({ deviceId: OTHER, body: '别人的' }), { online: false, outbox })
    expect(pendingFor(OTHER, outbox).items.map(item => item.body)).toEqual(['别人的'])
    expect(pendingFor(DEVICE, outbox).items.map(item => item.body)).toEqual(['队伍在等你'])
  })

  it('is empty for a device that has nothing and does not touch others', () => {
    const outbox = new PushOutbox()
    deliver(msg(), { online: false, outbox })
    expect(pendingFor(OTHER, outbox).items).toEqual([])
    expect(outbox.depth(DEVICE)).toBe(1)
  })
})

describe('ack — removes only what the device persisted', () => {
  it('removes exactly the acked ids and leaves the rest', () => {
    const outbox = new PushOutbox()
    deliver(msg(), { online: false, outbox })
    deliver(msg({ body: '第二件', kind: 'routine' }), { online: false, outbox })
    const first = noticeId(msg())
    expect(outbox.ack(DEVICE, [first])).toBe(1)
    expect(pendingFor(DEVICE, outbox).items.map(item => item.body)).toEqual(['第二件'])
  })

  it('is idempotent: acking the same id twice removes once', () => {
    const outbox = new PushOutbox()
    deliver(msg(), { online: false, outbox })
    expect(outbox.ack(DEVICE, [noticeId(msg())])).toBe(1)
    expect(outbox.ack(DEVICE, [noticeId(msg())])).toBe(0)
    expect(pendingFor(DEVICE, outbox).items).toEqual([])
  })

  it('ignores unknown ids and never crosses devices', () => {
    const outbox = new PushOutbox()
    deliver(msg(), { online: false, outbox })
    expect(outbox.ack(OTHER, [noticeId(msg())])).toBe(0) // 别的设备 ACK 不动这条
    expect(outbox.depth(DEVICE)).toBe(1)
  })

  it('the full queued → peek → ack cycle ends empty', () => {
    const outbox = new PushOutbox()
    deliver(msg(), { online: false, outbox })
    const items = pendingFor(DEVICE, outbox).items
    outbox.ack(DEVICE, items.map(item => item.id))
    expect(pendingFor(DEVICE, outbox).items).toEqual([])
    expect(outbox.depth(DEVICE)).toBe(0)
  })
})

describe('seenLedgerPatch', () => {
  it('merges into an empty ledger', () => {
    expect(seenLedgerPatch(undefined, ['a', 'b'])).toEqual(['a', 'b'])
  })
  it('is idempotent: reporting the same ids twice changes nothing', () => {
    const once = seenLedgerPatch(undefined, ['a', 'b'])
    expect(seenLedgerPatch(once, ['a', 'b'])).toEqual(['a', 'b'])
    expect(seenLedgerPatch(seenLedgerPatch(once, []), [])).toEqual(['a', 'b'])
  })
  it('keeps order and appends only the new ids', () => {
    expect(seenLedgerPatch(['a', 'b'], ['c', 'a', 'd'])).toEqual(['a', 'b', 'c', 'd'])
  })
  it('drops non-string / empty ids instead of trusting the client', () => {
    expect(seenLedgerPatch([], ['a', '', 'b'] as string[])).toEqual(['a', 'b'])
  })
  it('caps the ledger so one device cannot grow it without bound', () => {
    const many = Array.from({ length: MAX_QUEUE_PER_DEVICE * 4 }, (_, index) => `id${index}`)
    const kept = seenLedgerPatch([], many)
    expect(kept.length).toBe(MAX_QUEUE_PER_DEVICE * 2)
    expect(kept.at(-1)).toBe(many.at(-1))
  })
})
