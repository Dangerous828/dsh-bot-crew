import { describe, expect, it } from 'vitest'
import { defaultBot, namespaceOf, routeBot, threadOf, validateDirectory } from '../src/contract/types.ts'
import type { BotCard, BotDirectory } from '../src/contract/types.ts'

const lead: BotCard = { bot_id: 'lead', name: '大哥', role: 'default', memory_namespace: 'bot/lead' }
const scribbler: BotCard = { bot_id: 'scribbler', name: '写手', role: 'member', memory_namespace: 'bot/scribbler' }

const dir: BotDirectory = { default_bot_id: 'lead', bots: [lead, scribbler] }

describe('validateDirectory', () => {
  it('accepts one default and members', () => {
    expect(() => validateDirectory(dir)).not.toThrow()
    expect(defaultBot(dir).bot_id).toBe('lead')
  })

  it('rejects zero or two defaults', () => {
    expect(() => validateDirectory({ ...dir, bots: [{ ...lead, role: 'member' }] })).toThrow(/exactly one default/)
    expect(() => validateDirectory({ ...dir, bots: [lead, { ...scribbler, role: 'default' }] })).toThrow(/exactly one default/)
  })

  it('rejects a default_bot_id that names no bot', () => {
    expect(() => validateDirectory({ ...dir, default_bot_id: 'nobody' })).toThrow(/names no bot/)
  })

  it('rejects duplicate and malformed ids', () => {
    expect(() => validateDirectory({ ...dir, bots: [lead, lead] })).toThrow(/duplicate/)
    expect(() => validateDirectory({ ...dir, bots: [lead, { ...scribbler, bot_id: 'Bad_ID' }] })).toThrow(/bad bot_id/)
  })

  it('rejects a namespace that does not follow the convention', () => {
    expect(() => validateDirectory({ ...dir, bots: [lead, { ...scribbler, memory_namespace: 'other' }] })).toThrow(/memory_namespace/)
    expect(namespaceOf('lead')).toBe('bot/lead')
  })
})

describe('routeBot', () => {
  it('routes to the first known mention', () => {
    expect(routeBot({ mentions: ['scribbler', 'lead'], conversation: 'g1' }, dir, false))
      .toEqual({ bot_id: 'scribbler', addressed: 'mention' })
  })

  it('falls back to the default bot when nobody is mentioned in a group', () => {
    expect(routeBot({ mentions: [], conversation: 'g1' }, dir, false))
      .toEqual({ bot_id: 'lead', addressed: 'mention' })
  })

  it('marks a direct message to the default bot as direct', () => {
    expect(routeBot({ mentions: [], conversation: 'dm' }, dir, true))
      .toEqual({ bot_id: 'lead', addressed: 'direct' })
  })

  it('keeps unknown mentions for the record and still routes to the default bot', () => {
    expect(routeBot({ mentions: ['ghost'], conversation: 'g1' }, dir, false))
      .toEqual({ bot_id: 'lead', addressed: 'mention', unknown_mentions: ['ghost'] })
  })

  it('routes a known mention and records the unknown ones alongside it', () => {
    expect(routeBot({ mentions: ['ghost', 'scribbler'], conversation: 'g1' }, dir, false))
      .toEqual({ bot_id: 'scribbler', addressed: 'mention', unknown_mentions: ['ghost'] })
  })
})

describe('threadOf', () => {
  it('uses the thread when present and the message otherwise', () => {
    expect(threadOf('g1', 't-9', 'm-1')).toBe('g1:t-9')
    expect(threadOf('g1', undefined, 'm-1')).toBe('g1:m-1')
  })
})
