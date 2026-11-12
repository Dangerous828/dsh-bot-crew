import { describe, expect, it } from 'vitest'
import { approvalOf, approvalPrompt, BUDGET_ASK_RATIO, readAnswer } from '../src/app/approval.ts'

const facts = (over: Record<string, unknown> = {}) => ({ mode: 'ask' as const, rules: [], sensitive: [], ...over })

describe('approvalOf', () => {
  it('asks for everything when the mode is off', () => {
    expect(approvalOf(facts({ mode: 'off' }))).toMatchObject({ ask: true, because: 'mode' })
  })

  it('auto does the work unless a rule says otherwise', () => {
    // auto 档下即使撞上「要审批」的规矩也照做：档位的意思就是「不用问」。
    expect(approvalOf(facts({ mode: 'auto', rules: ['r1'], sensitive: ['r1'] }))).toEqual({ ask: false, because: 'none', reason: '' })
  })

  it('ask stops only on the rules marked sensitive', () => {
    expect(approvalOf(facts({ rules: ['r1'], sensitive: ['r1'] }))).toMatchObject({ ask: true, because: 'rule' })
    expect(approvalOf(facts({ rules: ['r1'], sensitive: [] })).ask).toBe(false)
    expect(approvalOf(facts({ rules: [], sensitive: ['r1'] })).ask).toBe(false)
  })

  it('names the rules that stopped it, so the question is not a mystery', () => {
    const decision = approvalOf(facts({ rules: ['touches-prod', 'money', 'docs'], sensitive: ['touches-prod', 'money'] }))
    expect(decision.reason).toContain('touches-prod')
    expect(decision.reason).toContain('money')
    expect(decision.reason).not.toContain('docs')
  })

  it('asks before spending the last of the budget', () => {
    expect(approvalOf(facts({ budgetUsed: BUDGET_ASK_RATIO }))).toMatchObject({ ask: true, because: 'budget' })
    expect(approvalOf(facts({ budgetUsed: 0.5 })).ask).toBe(false)
    // 不知道额度就不拿这个理由拦人。
    expect(approvalOf(facts({ budgetUsed: undefined })).ask).toBe(false)
  })

  it('checks mode before rule before budget, so a real stop is never buried under a cost warning', () => {
    // 同时有禁区和额度告急时，说的是禁区那件事：反过来说会让人以为是钱的事。
    const decision = approvalOf(facts({ mode: 'off', rules: ['r1'], sensitive: ['r1'], budgetUsed: 1 }))
    expect(decision.because).toBe('mode')
  })

  it('follows a rule change: flipping a sensitive mark changes the verdict', () => {
    // 规则集合没变，只是把 r1 标成「要审批」：判定必须跟着变，不能沿用旧结论。
    expect(approvalOf(facts({ rules: ['r1'], sensitive: [] })).ask).toBe(false)
    expect(approvalOf(facts({ rules: ['r1'], sensitive: ['r1'] }))).toMatchObject({ ask: true, because: 'rule' })
    expect(approvalOf(facts({ rules: [], sensitive: ['r1'] })).ask).toBe(false)
  })

  it('never reuses a past approval: every call is judged from its own facts', () => {
    // 先按 auto 放行，再切到一律先问：判定不记住上一次的「不用问」。
    expect(approvalOf(facts({ mode: 'auto' })).ask).toBe(false)
    expect(approvalOf(facts({ mode: 'off' })).ask).toBe(true)
    expect(approvalOf(facts({ mode: 'auto' })).ask).toBe(false)
  })
})

describe('approvalPrompt', () => {
  it('offers three answers so "change the approach" is not "say no and start over"', () => {
    const prompt = approvalPrompt('修卡顿', { ask: true, because: 'rule', reason: '这条撞上了要审批的规矩：touches-prod' })
    expect(prompt.question).toContain('touches-prod')
    expect(prompt.question).toContain('修卡顿')
    expect(prompt.options.map(option => option.id)).toEqual(['go', 'stop', 'revise'])
  })
})

describe('readAnswer', () => {
  it('reads a clear yes, a change of course, and everything else as no', () => {
    for (const yes of ['做吧', '同意', '可以', 'go', 'OK', ' 开始 ']) expect(readAnswer(yes)).toBe('go')
    for (const revise of ['换个做法', '改一下', 'revise']) expect(readAnswer(revise)).toBe('revise')
    // 认不出的回答一律不动：宁可停着，也不要猜他要什么。
    for (const no of ['', '随便', '嗯……', '再说']) expect(readAnswer(no)).toBe('stop')
  })

  it('reads the exact labels the prompt offers (a tap sends the label)', () => {
    expect(readAnswer('做吧')).toBe('go')
    expect(readAnswer('先别做')).toBe('stop')
    expect(readAnswer('换个做法')).toBe('revise')
  })
})
