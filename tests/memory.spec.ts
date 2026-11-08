import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DAILY_HUB_LIMIT, fileNameOf, injectable, namespaceOf, planWrite, renderMarkdown,
  targetPathOf, underDailyBudget, type MemoryRecord,
} from '../src/memory/adapter.ts'

const record: MemoryRecord = {
  name: 'bot-lead-weekly-log-review',
  description: '大哥每周五看一次日志并给出一句结论',
  body: '他习惯先看一眼 error 数量，再决定要不要展开。',
  type: 'project',
  dedupe_key: 'lead-weekly-log',
  toHub: false,
  created: 1794000000,
  updated: 1794000000,
}

describe('renderMarkdown', () => {
  it('renders the plugin frontmatter and body', () => {
    const text = renderMarkdown(record)
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('name: bot-lead-weekly-log-review')
    expect(text).toContain('status: candidate')
    expect(text).toContain('importance: 4')
    expect(text.endsWith('展开。\n')).toBe(true)
  })

  it('quotes values that would break plain YAML', () => {
    const text = renderMarkdown({ ...record, description: 'a: b # c' })
    expect(text).toContain('description: "a: b # c"')
  })

  it('rejects multi-line descriptions, empty bodies and missing dedupe keys', () => {
    expect(() => renderMarkdown({ ...record, description: 'a\nb' })).toThrow(/single line/)
    expect(() => renderMarkdown({ ...record, body: '   ' })).toThrow(/must not be empty/)
    expect(() => renderMarkdown({ ...record, dedupe_key: '' })).toThrow(/dedupe_key/)
  })

  it('omits absent optional fields', () => {
    const text = renderMarkdown(record)
    expect(text).not.toContain('supersedes')
    expect(text).not.toContain('evidence')
  })
})

describe('paths', () => {
  it('nests a bot namespace under the memory root', () => {
    expect(namespaceOf('lead')).toBe('bot/lead')
    expect(targetPathOf('/mem', 'lead', 'bot-lead-x')).toBe('/mem/bot/lead/bot-lead-x.md')
    expect(targetPathOf('/mem/', 'lead', 'bot-lead-x')).toBe('/mem/bot/lead/bot-lead-x.md')
  })

  it('slugs the file name', () => {
    expect(fileNameOf('lead', 'Bot Lead X')).toBe('bot-lead-x.md')
    expect(() => fileNameOf('lead', '///')).toThrow(/empty slug/)
  })

  it('refuses a name that hides the owning bot', () => {
    expect(() => planWrite('/mem', 'lead', { ...record, name: 'weekly-log' }))
      .toThrow(/must start with bot-lead-/)
    expect(planWrite('/mem', 'lead', record).path).toBe('/mem/bot/lead/bot-lead-weekly-log-review.md')
  })
})

describe('injection rules', () => {
  it('skips disabled, disputed and superseded records only', () => {
    expect(injectable({})).toBe(true)
    expect(injectable({ status: 'candidate' })).toBe(true)
    expect(injectable({ disabled: true })).toBe(false)
    expect(injectable({ status: 'disputed' })).toBe(false)
    expect(injectable({ status: 'superseded' })).toBe(false)
  })

  it('enforces a daily hub budget', () => {
    expect(underDailyBudget(0, DEFAULT_DAILY_HUB_LIMIT)).toBe(true)
    expect(underDailyBudget(DEFAULT_DAILY_HUB_LIMIT, DEFAULT_DAILY_HUB_LIMIT)).toBe(false)
  })
})
