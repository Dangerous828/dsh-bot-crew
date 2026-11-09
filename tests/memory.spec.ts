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

  it('quotes values YAML would otherwise retype', () => {
    // 裸 `yes` 读回来是布尔 true，裸 `123` 是数字，行尾空格会被当成续行；都得引起来。
    expect(renderMarkdown({ ...record, description: 'yes' })).toContain('description: "yes"')
    expect(renderMarkdown({ ...record, description: '123' })).toContain('description: "123"')
    expect(renderMarkdown({ ...record, description: 'null' })).toContain('description: "null"')
    expect(renderMarkdown({ ...record, description: 'a ' })).toContain('description: "a "')
    expect(renderMarkdown({ ...record, description: '@at' })).toContain('description: "@at"')
    // 普通中文短句保持裸写，别把每行都变成引号噪音。
    expect(renderMarkdown({ ...record, description: '中文描述' })).toContain('description: 中文描述')
  })

  it('renders the optional title line, in plugin field order', () => {
    const text = renderMarkdown({ ...record, title: '基调: 克制' })
    // ASCII 冒号要引号；全角「：」不是 YAML 的键分隔符，保持裸写。
    expect(text).toContain('title: "基调: 克制"')
    expect(renderMarkdown({ ...record, title: '文案基调：克制' })).toContain('title: 文案基调：克制')
    expect(text.indexOf('name:')).toBeLessThan(text.indexOf('title:'))
    expect(text.indexOf('title:')).toBeLessThan(text.indexOf('description:'))
    expect(renderMarkdown(record)).not.toContain('title:')
    expect(() => renderMarkdown({ ...record, title: 'a\nb' })).toThrow(/title must be a single line/)
  })

  it('can express the statuses the injection rule rejects', () => {
    // 类型上必须写得出 disputed / superseded，否则 injectable 的那两个分支永远走不到。
    const text = renderMarkdown({ ...record, status: 'superseded' })
    expect(text).toContain('status: superseded')
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
    expect(injectable({ status: 'verified' })).toBe(true)
    expect(injectable({ disabled: true })).toBe(false)
    expect(injectable({ status: 'disabled' })).toBe(false)
    expect(injectable({ status: 'disputed' })).toBe(false)
    expect(injectable({ status: 'superseded' })).toBe(false)
  })

  it('enforces a daily hub budget', () => {
    expect(underDailyBudget(0, DEFAULT_DAILY_HUB_LIMIT)).toBe(true)
    expect(underDailyBudget(DEFAULT_DAILY_HUB_LIMIT, DEFAULT_DAILY_HUB_LIMIT)).toBe(false)
  })
})
