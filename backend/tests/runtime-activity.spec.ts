import { afterEach, expect, it } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import type { TicketOutcome } from '../src/core/index.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

it('serves current lifecycle state to both phone activity and workspace screen, without inferring from the last assistant line', async () => {
  const h = host = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('activity11', 'fix the runtime'))
  const agent = h.agents.get(sessionId)! as unknown as { session: unknown }
  const base = Date.now() + 100
  h.ctx.emit('session/event', agent.session as never, { seq: 1, time: base, type: 'step/start', data: { turn: 1, step: 1 } } as never)
  h.ctx.emit('session/event', agent.session as never, { seq: 2, time: base + 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'read', name: 'functions.read', arguments: '{}' } } as never)
  expect(await h.runtime.activity(ticket.id)).toMatchObject({ kind: 'tool', label: '读取文件' })
  h.controller.inspect.mockResolvedValue({ events: [{ type: 'assistant/message', time: base - 5000,
    data: { message: { content: [{ type: 'text', text: '历史记录' }] } } }] as never[] })
  const screen = await h.runtime.screen(ticket.id)
  expect(screen.activity).toBe('running')
  expect(screen.at).toBe(new Date(base + 1).toISOString())
  expect(screen.lines?.some(line => line.text === '历史记录')).toBe(true)
})

it('keeps an unknown current phase unknown even if a historical assistant message is readable', async () => {
  const h = host = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('activity12', 'fix another runtime'))
  h.controller.inspect.mockResolvedValue({ events: [{ type: 'assistant/message', time: Date.now() - 5000, data: { text: '历史回话' } }] as never[] })
  const screen = await h.runtime.screen(ticket.id)
  expect(screen.lines?.[0]?.text).toBe('历史回话')
  expect(screen.activity).toBeUndefined()
})

it.each([['completed', '已完成'], ['merged', '已完成'], ['stopped', '已停止'], ['dropped', '已结束'], ['closed', '已结束']] as const)(
  'projects terminal outcome %s without claiming every ended ticket completed', async (outcome, label) => {
    const h = host = await startRuntime()
    const { ticket } = await h.acceptedTicket(feishu('activity13', 'fix terminal labels'))
    ticket.ended = { at: new Date().toISOString(), by: 'human', outcome: outcome as TicketOutcome }
    h.runtime.store.tickets.save(ticket)
    expect(await h.runtime.activity(ticket.id)).toMatchObject({ kind: 'ended', label })
  })

it('separates a question for the person from current model work', async () => {
  const h = host = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('activity14', 'ask the owner'))
  ticket.attention = { id: 'question', question: '确认这次操作？' }
  h.runtime.store.tickets.save(ticket)
  expect(await h.runtime.activity(ticket.id)).toMatchObject({ kind: 'waiting_for_person', label: '等你决定' })
})
