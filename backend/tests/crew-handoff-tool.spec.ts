/** The `orchestrator_handoff` tool a worker uses: who is offered it, and what a call passes on to the host. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import { Runtime } from '../src/app/runtime.ts'
import type { Tool } from '../src/app/tools/tool.ts'

type Roster = readonly { bot_id: string; name: string }[]

/**
 * A ticket as the tool sees it: it reads its own id and the bot its first channel already answers as, and reaches the rest
 * of the record only through the host.
 */
const ticket = (bot_id: string): Ticket => ({
  id: 'ticket-1',
  channels: [{ source: 'team', thread: 'team:ops', address: { conversation: 'ops', message: 'm1', bot_id } }],
} as unknown as Ticket)

/**
 * A host with the fields the tool definitions read while they are built. Everything else (the store, the engine, the
 * resources) is reached inside an `execute`, which these tests either do not call or reach through `handOffFor`.
 */
const host = (crew: Roster | undefined, handOffFor?: ExecutorToolsHost['handOffFor']): ExecutorToolsHost => ({
  crew, handOffFor, github: { deployment: { github: { login: 'agent-bot' } } },
} as unknown as ExecutorToolsHost)

const offered = (tools: Tool[]): string[] => tools.map(tool => tool.name)
const handoffFor = (tools: Tool[]): Tool | undefined => tools.find(tool => tool.name === 'orchestrator_handoff')

/** The `bot_id` enum a tool's schema carries, read where the model reads it. */
const botIds = (definition: Tool): string[] =>
  (definition.schema as unknown as { shape: { bot_id: { options: string[] } } }).shape.bot_id.options
const parses = (definition: Tool, value: unknown): boolean =>
  (definition.schema as unknown as { safeParse: (input: unknown) => { success: boolean } }).safeParse(value).success

const signal = () => new AbortController().signal
const SCRIBBLER = { bot_id: 'scribbler', name: '写手' }
const CODER = { bot_id: 'coder', name: '码农' }
const REVIEWER = { bot_id: 'reviewer', name: '审稿' }

describe('who the handoff tool is offered to', () => {
  it('is not offered when the host has no crew', () => {
    for (const crew of [undefined, []] as (Roster | undefined)[]) {
      const tools = executorTools(host(crew, () => true), ticket('scribbler'))
      expect(offered(tools)).not.toContain('orchestrator_handoff')
      // The rest of the worker's tools do not depend on a crew, so the absence is about the handoff alone.
      expect(offered(tools)).toContain('orchestrator_report')
    }
  })

  it('is not offered when a crew exists but the host cannot hand off', () => {
    // Without the host's routing the tool could do nothing, so offering it would be a way to say nothing.
    const tools = executorTools(host([SCRIBBLER, CODER], undefined), ticket('scribbler'))
    expect(offered(tools)).not.toContain('orchestrator_handoff')
  })

  it('is not offered to a bot that is the only one on its crew', () => {
    // Handing the work to itself would be a way to say nothing; the bot it is doing the work is not a target.
    for (const self of [SCRIBBLER, CODER]) {
      expect(offered(executorTools(host([self], () => true), ticket(self.bot_id)))).not.toContain('orchestrator_handoff')
    }
  })

  it('is offered otherwise, with only the other bots in its schema', () => {
    const tools = executorTools(host([SCRIBBLER, CODER, REVIEWER], () => true), ticket('scribbler'))
    const definition = handoffFor(tools)
    expect(definition).toBeDefined()
    expect(botIds(definition!)).toEqual(['coder', 'reviewer'])
    // The schema refuses the bot's own id and one no roster holds, so a call cannot name either.
    expect(parses(definition!, { bot_id: 'coder', text: '跑一下回归' })).toBe(true)
    expect(parses(definition!, { bot_id: 'scribbler', text: '跑一下回归' })).toBe(false)
    expect(parses(definition!, { bot_id: 'ghost', text: '跑一下回归' })).toBe(false)
  })
})

describe('what a handoff call passes to the host', () => {
  it('passes the bot id, the text and the ticket the worker is on', async () => {
    const calls: { ticket: Ticket; bot_id: string; text: string }[] = []
    const current = ticket('scribbler')
    const tools = executorTools(host([SCRIBBLER, CODER], (item, bot_id, text) => {
      calls.push({ ticket: item, bot_id, text })
      return true
    }), current)
    await handoffFor(tools)!.execute({ bot_id: 'coder', text: '把「墨匣」的回归跑一遍' }, signal())
    expect(calls).toHaveLength(1)
    // The ticket it hands off is the one the tools were built for: the host derives the origin, the channel and the
    // acting person from it, so passing another one would file the work under the wrong ticket.
    expect(calls[0]!.ticket).toBe(current)
    expect(calls[0]!.bot_id).toBe('coder')
    expect(calls[0]!.text).toBe('把「墨匣」的回归跑一遍')
  })

  it('reports what the host did with it', async () => {
    for (const opened of [true, false]) {
      const tools = executorTools(host([SCRIBBLER, CODER], () => opened), ticket('scribbler'))
      // `handed_off` is the host's own answer: false when the roster turned out not to hold the id, and the worker must
      // not read that as work on its way.
      expect(await handoffFor(tools)!.execute({ bot_id: 'coder', text: '修一下' }, signal()))
        .toEqual({ handed_off: opened, bot_id: 'coder' })
    }
  })
})

/**
 * `Runtime.handOff` itself, reached on the prototype with the two collaborators it reads: the settings that hold the
 * roster, and an Engine that records the trigger instead of scheduling it. Nothing else of the Runtime is built.
 */
describe('the trigger a handoff gives the Engine', () => {
  // `handOff` reports what the Engine said on the console; the tests assert on the trigger instead.
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })
  const bots = [{ bot_id: 'lead' }, { bot_id: 'scribbler' }, { bot_id: 'coder' }]
  type From = Parameters<Runtime['handOff']>[0]
  const runtime = (botsInRoster: { bot_id: string }[] = bots) => {
    const received: Record<string, unknown>[] = []
    const self = {
      store: {
        settings: () => ({ sources: { team: { config: { bots: botsInRoster } } } }),
        // The handoff reaches back to the person's own message through the origin ticket's trigger.
        triggers: { get: (id: string) => (id === 'origin-trigger' ? { id, meta: { messageId: 'm-person' } } : undefined) },
      },
      engine: { receive: (trigger: Record<string, unknown>) => { received.push(trigger); return 'stored' } },
    }
    const handOff = Runtime.prototype.handOff
    return { received, call: (from: From, bot_id: string, text: string, origin?: Ticket) =>
      handOff.call(self as never, from, bot_id, text, origin) }
  }
  const from: From = { id: 'reply-1', channel: { source: 'team', thread: 'team:ops', address: { conversation: 'ops', message: 'm1', bot_id: 'lead' } } }
  const origin = { id: 'ticket-1', mandate: { actor: { source: 'team', id: 'alice' } } } as unknown as Ticket

  it('arrives as a person\'s own request in the acting person\'s name, not the bot\'s', () => {
    // The engine ignores a trigger that is not human (`not_human`), and Policy refuses an invented actor (`not_a_member`).
    const { call, received } = runtime()
    expect(call(from, 'coder', '跑一下回归', origin)).toBe(true)
    expect(received[0]).toMatchObject({ human: true, actor: { source: 'team', id: 'alice' }, text: '跑一下回归', source: 'team' })
    expect(received[0]!.meta).toMatchObject({ bot_id: 'coder', handoff_from: 'lead', handoff_of: 'reply-1' })
  })

  it('opens its own thread and message, so intake cannot merge it into the ticket it came from', () => {
    const { call, received } = runtime()
    call(from, 'coder', '跑一下回归', origin)
    call(from, 'scribbler', '写一句 slogan', origin)
    const [first, second] = received as { id: string; threads: { id: string }[]; channel: { address: Record<string, string> } }[]
    // Each handoff is its own turn with its own recipient: sharing either would attach the work to the ticket the
    // reply already belongs to, where it would be signed by the bot that answered first.
    expect(first!.threads[0]!.id).not.toBe('team:ops')
    expect(first!.threads[0]!.id).not.toBe(second!.threads[0]!.id)
    expect(first!.id).not.toBe(second!.id)
    expect(first!.channel.address).toMatchObject({ conversation: 'ops', bot_id: 'coder' })
    expect(first!.threads[0]!.id).toContain('handoff-reply-1-coder')
  })

  it('drops an id the roster does not hold instead of filing work under it', () => {
    const { call, received } = runtime()
    expect(call(from, 'ghost', '谁来做', origin)).toBe(false)
    expect(received).toHaveLength(0)
  })
})
