/** The `orchestrator_message` tool a worker uses to note something to a crew mate already on a job: who is offered it, and
 * what the host does with the note. No backend: the tool host and the `Runtime` method are reached on their own. */
import { describe, expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import { Runtime } from '../src/app/runtime.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { KV } from '../src/kv.ts'
import type { Tool } from '../src/app/tools/tool.ts'

type Roster = readonly { bot_id: string; name: string }[]

/** A ticket as the tool sees it: its id, and the bot its first channel already answers as. */
const ticket = (bot_id: string, id = 'ticket-1'): Ticket => ({
  id,
  channels: [{ source: 'team', thread: 'team:ops', address: { conversation: 'ops', message: 'm1', bot_id } }],
} as unknown as Ticket)

/** A ticket a bot is working: its newest assignment runs, which is what makes it a target. */
const working = (bot_id: string, id: string): Ticket => ({ ...ticket(bot_id, id), assignments: [{ id: `a-${id}`, state: 'running', createdAt: '' }] })

const host = (crew: Roster | undefined, messageTeammate?: ExecutorToolsHost['messageTeammate']): ExecutorToolsHost => ({
  crew, messageTeammate, github: { deployment: { github: { login: 'agent-bot' } } },
} as unknown as ExecutorToolsHost)

const named = (tools: Tool[], name: string): Tool | undefined => tools.find(tool => tool.name === name)
const offered = (tools: Tool[]): string[] => tools.map(tool => tool.name)
/** The `bot_id` enum the schema carries, read where the model reads it. */
const botIds = (definition: Tool): string[] =>
  (definition.schema as unknown as { shape: { bot_id: { options: string[] } } }).shape.bot_id.options
const parses = (definition: Tool, value: unknown): boolean =>
  (definition.schema as unknown as { safeParse: (input: unknown) => { success: boolean } }).safeParse(value).success

const signal = () => new AbortController().signal
const SCRIBBLER = { bot_id: 'scribbler', name: '写手' }
const CODER = { bot_id: 'coder', name: '码农' }
const REVIEWER = { bot_id: 'reviewer', name: '审稿' }

describe('who the message tool is offered to', () => {
  it('is not offered when the host has no crew', () => {
    for (const crew of [undefined, []] as (Roster | undefined)[]) {
      const tools = executorTools(host(crew, async () => ({ delivered: true })), ticket('scribbler'))
      expect(offered(tools)).not.toContain('orchestrator_message')
      // The rest of the worker's tools do not depend on a crew, so the absence is about the note alone.
      expect(offered(tools)).toContain('orchestrator_report')
    }
  })

  it('is not offered to a bot that is the only one on its crew', () => {
    // Writing to itself is a way to say nothing, so the bot doing the work is not a target.
    for (const self of [SCRIBBLER, CODER]) {
      expect(offered(executorTools(host([self], async () => ({ delivered: true })), ticket(self.bot_id)))).not.toContain('orchestrator_message')
    }
  })

  it('is offered otherwise, with only the other bots in its schema', () => {
    const tools = executorTools(host([SCRIBBLER, CODER, REVIEWER], async () => ({ delivered: true })), ticket('scribbler'))
    const definition = named(tools, 'orchestrator_message')
    expect(definition).toBeDefined()
    expect(botIds(definition!)).toEqual(['coder', 'reviewer'])
    // Its own id and an id no roster holds are both refused, so a call cannot name either.
    expect(parses(definition!, { bot_id: 'coder', text: '接口已经改了，按新的写' })).toBe(true)
    expect(parses(definition!, { bot_id: 'scribbler', text: '接口已经改了，按新的写' })).toBe(false)
    expect(parses(definition!, { bot_id: 'ghost', text: '接口已经改了，按新的写' })).toBe(false)
    // A note is a sentence, not a document, and an empty one is worth nothing.
    expect(parses(definition!, { bot_id: 'coder', text: '   ' })).toBe(false)
    expect(parses(definition!, { bot_id: 'coder', text: 'x'.repeat(1501) })).toBe(false)
  })
})

describe('what a note passes to the host', () => {
  it('passes the ticket, the recipient and the text, and reports what the host made of it', async () => {
    const calls: { ticket: Ticket; bot_id: string; text: string }[] = []
    const current = ticket('scribbler')
    const tools = executorTools(host([SCRIBBLER, CODER], async (item, bot_id, text) => {
      calls.push({ ticket: item, bot_id, text })
      return { delivered: true }
    }), current)
    expect(await named(tools, 'orchestrator_message')!.execute({ bot_id: 'coder', text: '接口已经改了，按新的写' }, signal()))
      .toEqual({ delivered: true, bot_id: 'coder' })
    expect(calls).toHaveLength(1)
    // The note is written from the ticket it belongs to: the host reads the sender's bot off that ticket's channel.
    expect(calls[0]!.ticket).toBe(current)
    expect(calls[0]!.bot_id).toBe('coder')
    expect(calls[0]!.text).toBe('接口已经改了，按新的写')
  })

  it('reports a refusal as the host states it, so the worker knows nothing arrived', async () => {
    for (const reason of ['no_live_ticket', 'hop_limit']) {
      const tools = executorTools(host([SCRIBBLER, CODER], async () => ({ delivered: false, reason })), ticket('scribbler'))
      expect(await named(tools, 'orchestrator_message')!.execute({ bot_id: 'coder', text: '再看一眼' }, signal()))
        .toEqual({ delivered: false, reason, bot_id: 'coder' })
    }
  })
})

/**
 * `Runtime.messageTeammate` on the prototype, with the collaborators it reads: a store holding the tickets and the note
 * counts, and a `Sessions.prompt` that records instead of delivering. Nothing else of the Runtime is built.
 */
describe('where a note goes', () => {
  interface Note { sessionId: string; requestId: string; text: string; mode: string }
  const runtime = (tickets: Ticket[], hops: Record<string, number> = {}) => {
    const notes: Note[] = []
    const kv = new Map<string, number>(Object.entries(hops).map(([id, value]) => [KV.crew.hop(id), value]))
    const self = {
      store: {
        // Newest first, as the Store lists them.
        tickets: { list: () => [...tickets] },
        get: (name: string) => kv.get(name),
        set: (name: string, value: number) => { kv.set(name, value) },
      },
      sessions: { prompt: async (sessionId: string, requestId: string, text: string, mode: string) => {
        notes.push({ sessionId, requestId, text, mode })
      } },
    }
    const call = (from: Ticket, bot_id: string, text: string) => Runtime.prototype.messageTeammate.call(self as never, from, bot_id, text)
    return { notes, kv, call }
  }

  it('reaches the running ticket of the named bot, through the worker Session that ticket owns', async () => {
    const target = working('coder', 'ticket-coder')
    const { call, notes } = runtime([target, ticket('scribbler', 'ticket-1')])
    expect(await call(ticket('scribbler'), 'coder', '接口已经改了，按新的写')).toEqual({ delivered: true })
    expect(notes).toHaveLength(1)
    // The recipient's Session, not the sender's: the note lands in the work it is about.
    expect(notes[0]!.sessionId).toBe(workerSessionId('ticket-coder'))
    expect(notes[0]!.mode).toBe('steer')
    expect(notes[0]!.text).toContain('接口已经改了，按新的写')
    // Who wrote it and how far the thread has gone travel with the note, so the reader can answer rather than relay on.
    expect(notes[0]!.text).toContain('from scribbler')
    expect(notes[0]!.text).toContain('hop 1')
  })

  it('names the bot its own ticket belongs to as the sender, not a bot that happens to be configured', async () => {
    const { call, notes } = runtime([working('coder', 'ticket-coder')])
    await call(ticket('reviewer'), 'coder', '这条我核对过了')
    expect(notes[0]!.text).toContain('from reviewer')
  })

  it('delivers the same note once, when the same call is retried', async () => {
    const { call, notes } = runtime([working('coder', 'ticket-coder')])
    await call(ticket('scribbler'), 'coder', '同一个说法')
    await call(ticket('scribbler'), 'coder', '同一个说法')
    // The request id is the sender, the recipient and the words: the delivery layer drops the second one, so a retry at
    // any level is not a second note.
    expect(notes[1]!.requestId).toBe(notes[0]!.requestId)
    // Wording it differently is a different note, which is exactly what a corrected follow-up is.
    await call(ticket('scribbler'), 'coder', '换一个说法')
    expect(notes[2]!.requestId).not.toBe(notes[0]!.requestId)
  })

  it('takes the newest of several running tickets, so the note follows the work that is current', async () => {
    // Both are live and running; the list is newest first, which is the one the bot is on now.
    const { call, notes } = runtime([working('coder', 'ticket-new'), working('coder', 'ticket-old')])
    await call(ticket('scribbler'), 'coder', '按新的那版改')
    expect(notes[0]!.sessionId).toBe(workerSessionId('ticket-new'))
  })

  it('does not deliver to a ticket that ended or one that is not running', async () => {
    const ended = { ...working('coder', 'ticket-ended'), ended: { at: '', by: 'executor', outcome: 'completed' } } as Ticket
    const idle = { ...ticket('coder', 'ticket-idle'), assignments: [{ id: 'a', state: 'pending', createdAt: '' }] } as Ticket
    const { call, notes } = runtime([ended, idle])
    expect(await call(ticket('scribbler'), 'coder', '在吗')).toEqual({ delivered: false, reason: 'no_live_ticket' })
    expect(notes).toHaveLength(0)
  })

  it('refuses once the receiving ticket has carried its share of the conversation', async () => {
    // Both sides deep in a chain: the next note would only be answered, and answered again.
    const { call, notes, kv } = runtime([working('coder', 'ticket-coder')], { 'ticket-coder': 3 })
    expect(await call({ ...ticket('scribbler'), id: 'ticket-1' } as Ticket, 'coder', '还有一句')).toEqual({ delivered: false, reason: 'hop_limit' })
    expect(notes).toHaveLength(0)
    // Nothing was counted, so a refused note does not draw the two closer to the limit either.
    expect(kv.get(KV.crew.hop('ticket-coder'))).toBe(3)
  })

  it('counts each note against the ticket that receives it, so the chain ends on both sides', async () => {
    const { call, kv } = runtime([working('coder', 'ticket-coder')])
    await call(ticket('scribbler', 'ticket-1'), 'coder', '第一句')
    expect(kv.get(KV.crew.hop('ticket-coder'))).toBe(1)
    // The sender's own count is untouched: it is the ticket being written to that is one hop further along.
    expect(kv.get(KV.crew.hop('ticket-1'))).toBeUndefined()
  })

  it('refuses a bot with no running ticket instead of throwing', async () => {
    const idle = { ...ticket('coder', 'ticket-idle'), assignments: [] } as Ticket
    const { call } = runtime([idle])
    await expect(call(ticket('scribbler'), 'coder', '在吗')).resolves.toEqual({ delivered: false, reason: 'no_live_ticket' })
  })
})
