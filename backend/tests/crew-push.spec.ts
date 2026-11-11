import { describe, expect, it } from 'vitest'
import { deliver, DEVICE_ID, MAX_QUEUE_PER_DEVICE, PushOutbox, QUEUE_TTL_MS } from '../src/app/push.ts'

const DEVICE = 'dev_abc123'
const message = (over: Record<string, unknown> = {}) => ({ deviceId: DEVICE, title: '有事', body: '队伍在等你', ...over })

describe('PushOutbox', () => {
  it('keeps what it was given and hands it back once', () => {
    const box = new PushOutbox()
    expect(box.keep(message())).toBe(1)
    expect(box.take(DEVICE)).toHaveLength(1)
    // 取走之后就没有了：补发只发生一次，不然同一条会一直弹。
    expect(box.take(DEVICE)).toHaveLength(0)
  })

  it('drops a message after its day is up', () => {
    let now = 1_000
    const box = new PushOutbox({ now: () => now })
    box.keep(message())
    now += QUEUE_TTL_MS + 1
    expect(box.take(DEVICE)).toHaveLength(0)
    expect(box.depth(DEVICE)).toBe(0)
  })

  it('caps the box and keeps the newest', () => {
    const box = new PushOutbox({ cap: 3 })
    for (let index = 0; index < 6; index++) box.keep(message({ body: `第 ${index} 条` }))
    const kept = box.take(DEVICE).map(item => item.body)
    expect(kept).toEqual(['第 3 条', '第 4 条', '第 5 条'])
  })

  it('keeps only the newest of one kind', () => {
    // 十条「有未读」不如一条。同一 kind 只留最后那条。
    const box = new PushOutbox()
    box.keep(message({ kind: 'followup', body: '第一次' }))
    box.keep(message({ kind: 'followup', body: '第二次' }))
    box.keep(message({ kind: 'routine', body: '别的事' }))
    const kept = box.take(DEVICE).map(item => item.body)
    expect(kept).toEqual(['第二次', '别的事'])
  })

  it('keeps devices apart', () => {
    const box = new PushOutbox()
    box.keep(message())
    box.keep(message({ deviceId: 'dev_other1' }))
    expect(box.depth(DEVICE)).toBe(1)
    expect(box.take('dev_other1')).toHaveLength(1)
  })
})

describe('deliver', () => {
  it('hands it straight to a device that is online', () => {
    const outbox = new PushOutbox()
    expect(deliver(message(), { online: true, outbox })).toEqual({ status: 'delivered', deviceId: DEVICE })
    // 在线送达的不留件：它已经收到了。
    expect(outbox.depth(DEVICE)).toBe(0)
  })

  it('queues for a device that is away, and says so instead of claiming delivery', () => {
    const outbox = new PushOutbox()
    const outcome = deliver(message(), { online: false, outbox })
    expect(outcome).toMatchObject({ status: 'queued', depth: 1 })
    expect(outbox.depth(DEVICE)).toBe(1)
  })

  it('uses the system push when one is wired up', () => {
    const outbox = new PushOutbox()
    const outcome = deliver(message(), { online: false, outbox, push: () => true })
    expect(outcome).toEqual({ status: 'delivered', deviceId: DEVICE })
  })

  it('still queues when the system push did not take it', () => {
    const outbox = new PushOutbox()
    const outcome = deliver(message(), { online: false, outbox, push: () => false })
    expect(outcome).toMatchObject({ status: 'queued' })
  })

  it('refuses a bad device id and an empty body', () => {
    const outbox = new PushOutbox()
    expect(deliver(message({ deviceId: 'nope' }), { online: true, outbox })).toMatchObject({ status: 'rejected' })
    expect(deliver(message({ body: '   ' }), { online: true, outbox })).toMatchObject({ status: 'rejected' })
    expect(DEVICE_ID.test('dev_abc123')).toBe(true)
    expect(DEVICE_ID.test('dev_abc1234567890123456789012345678901234567890')).toBe(false)
  })

  it('honours the per-device cap through deliver as well', () => {
    const outbox = new PushOutbox()
    for (let index = 0; index < MAX_QUEUE_PER_DEVICE + 5; index++) deliver(message({ body: `第 ${index} 条` }), { online: false, outbox })
    expect(outbox.depth(DEVICE)).toBe(MAX_QUEUE_PER_DEVICE)
  })
})
