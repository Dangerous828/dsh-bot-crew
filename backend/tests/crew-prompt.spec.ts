import { describe, expect, it } from 'vitest'
import { composePrompt, crewSection, defaultPrompts } from '../src/app/prompts.ts'
import type { Variable } from '../src/app/execution-environment.ts'

const vars: Variable[] = [
  { key: 'DSH_SUPERAGENT_CREW_BOT', value: 'scribbler', description: { zh: '', en: '' }, owner: 'team' },
  { key: 'DSH_SUPERAGENT_CREW_PERSONA', value: '文风克制', description: { zh: '', en: '' }, owner: 'team' },
  { key: 'DSH_SUPERAGENT_CREW_MEMORY', value: 'bot/scribbler', description: { zh: '', en: '' }, owner: 'team' },
  { key: 'DSH_SUPERAGENT_CREW_CONVERSATION', value: 'ops', description: { zh: '', en: '' }, owner: 'team' },
]

describe('the bot a worker answers as', () => {
  it('names the bot, its persona and its memory, and says it grants nothing', () => {
    const text = crewSection(vars)
    expect(text).toContain('You answer as **scribbler** in conversation ops')
    expect(text).toContain('文风克制')
    // The namespace plus the directory it lives in, so the worker can actually reach the files.
    expect(text).toContain('/memory/bot/scribbler`')
    expect(text).toContain('one Markdown file per fact')
    expect(text).toContain('`bot-scribbler-`')
    expect(text).toContain('presentation, not authority')
    expect(text).toContain('decide what you may do')
  })

  it('adds nothing to a ticket that did not come from the crew', () => {
    expect(crewSection(undefined)).toBe('')
    expect(crewSection([])).toBe('')
    expect(crewSection([{ ...vars[0]!, value: '' }])).toBe('')
  })

  it('keeps the section out of a prompt without a crew', () => {
    const plain = composePrompt(defaultPrompts(), 'worker')
    expect(plain).not.toContain('## Bot you are')
    const crewed = composePrompt(defaultPrompts(), 'worker', undefined, undefined, crewSection(vars))
    expect(crewed).toContain('## Bot you are')
    // 其余内容逐字节不变，只在后面多一节。
    expect(crewed.replace('\n\n' + crewSection(vars), '')).toBe(plain)
  })
})

describe('the rest of the crew in the prompt', () => {
  it('names the teammates and says their work and memory are not this bot own', () => {
    const withTeam = crewSection([...vars, { key: 'DSH_SUPERAGENT_CREW_TEAM', value: 'scribbler=写手, coder=码农',
      description: { zh: '', en: '' }, owner: 'team' }])
    expect(withTeam).toContain('The rest of the crew is scribbler=写手, coder=码农')
    expect(withTeam).toContain('Stay out of their memory directories')
    // The prompt must not claim an isolation the runtime does not enforce.
    expect(withTeam).toContain('nothing stops you reading them')
    // A worker has no way to hand a ticket over, so the prompt must not imply it can.
    // The person must never see the marker line, so the prompt says the host strips it.
    // The tool is the handover; a note in prose alone leaves the work undone.
    expect(withTeam).toContain('without calling the tool means nobody does it')
    expect(withTeam).toContain('call it with the bot id and what they')
    // Work that is plainly a teammate's is sent there, not silently taken over.
    expect(withTeam).toContain('a piece of writing to a writer')
    expect(withTeam).toContain('orchestrator_handoff')
    // A bot that does take on a teammate's kind of work must not let it pass for that teammate's.
    expect(withTeam).toContain('open by saying you are not the one who usually does this')
  })

  it('says nothing about teammates when the crew has none', () => {
    expect(crewSection(vars)).not.toContain('The rest of the crew')
  })
})

describe('the memory a worker is pointed at', () => {
  it('gives a directory it can open, not just a name', () => {
    const text = crewSection(vars)
    const path = text.match(/`([^`]*\/memory\/bot\/scribbler)`/)?.[1] ?? ''
    expect(path).toMatch(/\.dsh\/memory\/bot\/scribbler$/)
    expect(path.startsWith('/')).toBe(true)
  })

  it('says what does not belong in it', () => {
    const text = crewSection(vars)
    expect(text).toContain('transient chatter')
    expect(text).toContain('asked you to forget')
  })
})
