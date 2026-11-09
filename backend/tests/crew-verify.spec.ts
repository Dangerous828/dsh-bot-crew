import { describe, expect, it } from 'vitest'
import { directoryOf, teamKind, teamTrigger, type TeamConfig } from '../src/sources/team.ts'

const config: TeamConfig = {
  default_bot_id: 'lead',
  bots: [
    { bot_id: 'lead', name: '大哥', role: 'default', persona: '简练，先应一声', memory_namespace: 'bot/lead' },
    { bot_id: 'scribbler', name: '写手', role: 'member', persona: '文风克制', memory_namespace: 'bot/scribbler' },
  ],
  conversations: [
    { id: 'ops', listen: 'mentions', direct: false },
    { id: 'dm-lead', listen: 'all', direct: true },
  ],
  pollSeconds: 5,
}

const base = { conversation: 'ops', at: '2026-11-08T23:00:00+0800', text: 'hi', sender: { id: 'u-1', bot: false }, mentions_me: false }
const trigger = (over: Record<string, unknown>) => teamTrigger({ ...base, ...over } as never, 'agent', config)

describe('the crew roster', () => {
  it('accepts one default and its members', () => {
    expect(directoryOf(config).bots.find(b => b.role === 'default')?.name).toBe('大哥')
  })

  it('refuses two defaults', () => {
    expect(() => directoryOf({ ...config, bots: [config.bots[0]!, { ...config.bots[1]!, role: 'default' }] }))
      .toThrow(/exactly one default/)
  })
})

describe('mention routing', () => {
  it('routes a member mention to that member, and signs the reply with it', () => {
    const t = trigger({ id: '1', mentions: ['scribbler'] })!
    expect(t.meta.bot_id).toBe('scribbler')
    expect(t.addressed).toBe('mention')
    expect(t.channel?.address.bot_id).toBe('scribbler')
  })

  it('routes to the default bot when nobody in the group is mentioned', () => {
    const t = trigger({ id: '3', mentions: [] })!
    expect(t.meta.bot_id).toBe('lead')
    expect(t.addressed).toBe('mention')
  })

  it('marks a direct conversation to the default bot as direct', () => {
    const t = trigger({ id: '5', conversation: 'dm-lead', mentions: [] })!
    expect(t.meta.bot_id).toBe('lead')
    expect(t.addressed).toBe('direct')
  })

  it('records an unknown mention and still answers as the default bot', () => {
    const t = trigger({ id: '4', mentions: ['ghost'] })!
    expect(t.meta.bot_id).toBe('lead')
    expect(t.meta.unknown_mentions).toEqual(['ghost'])
  })

  it('drops the agent own echo', () => {
    expect(trigger({ id: '6', mentions: ['lead'], sender: { id: 'agent', bot: true } })).toBeUndefined()
  })

  it('keeps the thread on the conversation and the message', () => {
    expect(trigger({ id: '7', mentions: [] })!.threads[0]!.id).toBe('ops:7')
    expect(trigger({ id: '8', mentions: [], thread: '3' })!.threads[0]!.id).toBe('ops:3')
  })
})

describe('what a worker is told about its bot', () => {
  it('names the bot, its persona and its memory namespace', () => {
    const values = teamKind.environment!.values({ config, trigger: trigger({ id: '1', mentions: ['scribbler'] }) } as never)
    expect(values.DSH_SUPERAGENT_CREW_BOT).toBe('scribbler')
    expect(values.DSH_SUPERAGENT_CREW_PERSONA).toBe('文风克制')
    expect(values.DSH_SUPERAGENT_CREW_MEMORY).toBe('bot/scribbler')
    expect(values.DSH_SUPERAGENT_CREW_CONVERSATION).toBe('ops')
  })

  it('says nothing about a bot for a ticket from another Source', () => {
    const other = { ...trigger({ id: '9', mentions: [] })!, source: 'github' }
    const values = teamKind.environment!.values({ config, trigger: other } as never)
    expect(values.DSH_SUPERAGENT_CREW_BOT).toBe('')
    expect(values.DSH_SUPERAGENT_CREW_MEMORY).toBe('')
  })
})

describe('the rest of the crew', () => {
  it('tells a bot who its teammates are, and never lists itself', () => {
    const values = teamKind.environment!.values({ config, trigger: trigger({ id: '1', mentions: ['scribbler'] }) } as never)
    expect(values.DSH_SUPERAGENT_CREW_TEAM).toBe('lead=大哥')
  })

  it('lists the whole crew for the default bot', () => {
    const values = teamKind.environment!.values({ config, trigger: trigger({ id: '2', mentions: [] }) } as never)
    expect(values.DSH_SUPERAGENT_CREW_TEAM).toBe('scribbler=写手')
  })

  it('says nothing about a crew for a ticket from another Source', () => {
    const other = { ...trigger({ id: '9', mentions: [] })!, source: 'github' }
    expect(teamKind.environment!.values({ config, trigger: other } as never).DSH_SUPERAGENT_CREW_TEAM).toBe('')
  })
})
