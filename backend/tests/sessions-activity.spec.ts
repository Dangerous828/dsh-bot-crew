import { afterEach, expect, it } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

it('feeds the managed session activity cache from the existing native subscription without inspect polling', async () => {
  const h = host = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('activity1', 'fix the task'))
  const agent = h.agents.get(sessionId)! as unknown as { session: unknown }
  const base = Date.now() + 10
  const emit = (seq: number, type: string, data: Record<string, unknown> = {}) => h.ctx.emit('session/event', agent.session as never,
    { type, seq, time: base + seq, data: { turn: 1, step: 1, ...data } } as never)
  h.controller.inspect.mockClear()
  emit(1, 'turn/start'); emit(2, 'step/start')
  expect(h.runtime.sessions.activity(sessionId)).toMatchObject({ kind: 'model' })
  emit(3, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'private response' }] }, stream: [] })
  emit(4, 'tool/call', { callId: 'one', name: 'functions.read', arguments: '{"private":"argument"}' })
  emit(5, 'tool/call', { callId: 'two', name: 'functions.bash', arguments: '{}' })
  emit(6, 'tool/result', { message: { role: 'tool', toolCallId: 'two', content: [] } })
  expect(h.runtime.sessions.activity(sessionId)).toMatchObject({ kind: 'tool', label: '读取文件' })
  for (let index = 0; index < 20; index++) h.runtime.sessions.activity(sessionId)
  expect(h.controller.inspect).not.toHaveBeenCalled()
  emit(7, 'tool/result', { message: { role: 'tool', toolCallId: 'one', content: [] } })
  emit(8, 'step/end'); emit(9, 'turn/end', { reason: { kind: 'completed' } })
  expect(h.runtime.sessions.activity(sessionId)).toMatchObject({ kind: 'idle' })
  expect(JSON.stringify(h.runtime.sessions.activity(sessionId))).not.toContain('private')
})

it('does not present historical unfinished tools as running when the live agent is idle or missing', async () => {
  const h = host = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('activity2', 'fix another task'))
  const agent = h.agents.get(sessionId)! as unknown as { session: unknown; status: string }
  const base = Date.now() + 10
  h.ctx.emit('session/event', agent.session as never, { type: 'step/start', seq: 1, time: base, data: { turn: 1, step: 1 } } as never)
  h.ctx.emit('session/event', agent.session as never, { type: 'tool/call', seq: 2, time: base + 1, data: { turn: 1, step: 1, callId: 'orphan', name: 'functions.bash', arguments: '{}' } } as never)
  expect(h.runtime.sessions.activity(sessionId)?.kind).toBe('tool')
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  expect(h.runtime.sessions.activity(sessionId)?.kind).toBe('idle')
  agent.status = 'running'
  h.ctx.emit('agent/status', { agent, status: 'running' } as never)
  expect(h.runtime.sessions.activity(sessionId)?.kind).not.toBe('tool')
  h.ctx.emit('session/event', agent.session as never, { type: 'turn/start', seq: 3, time: base + 2, data: { turn: 2 } } as never)
  h.ctx.emit('session/event', agent.session as never, { type: 'step/start', seq: 4, time: base + 3, data: { turn: 2, step: 1 } } as never)
  expect(h.runtime.sessions.activity(sessionId)?.kind).toBe('model')
  h.agents.delete(sessionId)
  expect(h.runtime.sessions.activity(sessionId)?.kind).toBe('unknown')
})

it('releases the activity cache with its managed agent and leaves unrelated agents alone', async () => {
  const h = host = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('activity3', 'fix a third task'))
  const agent = h.agents.get(sessionId)! as unknown as { session: unknown }
  h.ctx.emit('session/event', agent.session as never, { type: 'step/start', seq: 1, time: Date.now() + 10, data: { turn: 1, step: 1 } } as never)
  expect(h.runtime.sessions.activity(sessionId)?.kind).toBe('model')
  await h.controller.create({ sessionId: 'unrelated-agent' })
  const unrelated = h.agents.get('unrelated-agent')! as unknown as { session: unknown }
  h.ctx.emit('session/event', unrelated.session as never, { type: 'step/start', seq: 1, time: Date.now(), data: { turn: 1, step: 1 } } as never)
  expect(h.runtime.sessions.activity('unrelated-agent')).toBeUndefined()
  h.ctx.emit('agent/disposed', { agent } as never)
  expect(h.runtime.sessions.activity(sessionId)).toBeUndefined()
})
