import { describe, expect, it } from 'vitest'
import { answerOf, approvalOf, approvalPrompt, BUDGET_ASK_RATIO, connectionPrompt, legacyAnswerId, legacyConnectionCard, presentCall, readAnswer } from '../src/app/approval.ts'

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

describe('presentCall: 人读投影，不是序列化参数', () => {
  it('keeps the real line breaks of the text being confirmed, and never truncates it', () => {
    const body = '第一行\n第二行 带反斜杠 \\n 字面量和 *星号*\n' + '长内容'.repeat(400)
    const view = presentCall({ kindName: '消息', tool: 'send_message', args: { channel: 'main', to: 'm82', text: body }, conversation: 'main' })
    expect(view.preview).toBe(body)
    // 不做全局反转义、不替换反斜杠：正文一个字符都不改。
    expect(view.preview).toContain('\\n')
    expect(view.preview).toContain('*星号*')
    expect(view.preview).not.toContain('\\n主')
    expect(view.action).toBe('发送这条消息')
    expect(view.target).toBe('当前对话')
  })

  it('redacts secret-looking fields by name and keeps the rest readable in details', () => {
    const view = presentCall({ kindName: '消息', tool: 'send_message',
      args: { channel: 'work', to: 'm1', text: '你好', token: 'hidden-secret', api_key: 'k-1' } })
    expect(view.target).toBe('会话 work')
    expect(view.details).toContain('to：m1')  // 其余参数在
    expect(view.details).not.toContain('hidden-secret')
    expect(view.details).not.toContain('k-1')
    expect(view.details).toContain('[已隐藏]')
    // 正文不进 details（它就是 preview）。
    expect(view.details).not.toContain('text：')
  })

  it('asks in plain words and gives each button its own consequence', () => {
    const prompt = connectionPrompt({ ...presentCall({ kindName: '消息', tool: 'send_message', args: { channel: 'main', to: 'm82', text: '好' }, conversation: 'main' }) })
    // 问题里没有工具协议、没有 JSON、没有字面换行转义。
    expect(prompt.question).not.toContain('mcp__')
    expect(prompt.question).not.toContain('{')
    expect(prompt.question).not.toContain('\\n')
    expect(prompt.question).toBe('要发送这条消息给「当前对话」吗？')
    expect(prompt.presentation).toMatchObject({ kind: 'connection', preview: '好' })
    const labels = Object.fromEntries(prompt.options.map(option => [option.id, option.label]))
    // 取消这一次 ≠ 停整票：文案自己说出区别。
    expect(labels.stop).toContain('这一次')
    expect(labels.stop).toContain('任务继续')
    expect(labels.go).toContain('确认')
    expect(labels.revise).toContain('修改')
  })
})

describe('answerOf: 服务端按 option.id 解读，不靠中文文案', () => {
  it('dispatches on the id the client sends back', () => {
    expect(answerOf({ id: 'go', label: '确认执行这一次' })).toBe('go')
    expect(answerOf({ id: 'stop', label: '取消这一次（任务继续）' })).toBe('stop')
    expect(answerOf({ id: 'revise', label: '修改内容' })).toBe('revise')
    // 文案改了，行为不变。
    expect(answerOf({ id: 'go', label: '随便什么新文案' })).toBe('go')
  })

  it('falls back to the label words for a card persisted before ids were read', () => {
    expect(answerOf({ id: '', label: '做吧' })).toBe('go')
    expect(answerOf({ id: '', label: '先别做' })).toBe('stop')
    expect(answerOf({ id: '', label: '换个做法' })).toBe('revise')
  })

  it('reads no card as revise, never as an approval', () => {
    expect(answerOf(undefined)).toBe('revise')
  })
})

describe('legacyAnswerId: 只认整套词，不做模糊匹配', () => {
  it('recognizes the old wording a person types by hand', () => {
    expect(legacyAnswerId('做吧')).toBe('go')
    expect(legacyAnswerId('先别做')).toBe('stop')
    expect(legacyAnswerId('换个做法')).toBe('revise')
  })

  it('refuses to read anything else as a decision', () => {
    for (const vague of ['', '随便', '嗯……', '再说', '好吧你看着办']) expect(legacyAnswerId(vague)).toBeUndefined()
  })
})

describe('legacyConnectionCard: 旧卡投影成人读的一套，不捏造正文', () => {
  const oldCard = (question: string, options?: { id: string; label: string }[]) => ({ question, ...(options ? { options } : {}) })

  it('keeps the ids, maps the old button words to the new ones, and moves the old question into details', () => {
    const raw = 'send_message({"channel":"发布","to":"m82","text":"第一行\\n第二行"})'
    const view = legacyConnectionCard(oldCard(raw, [{ id: 'go', label: '做吧' }, { id: 'stop', label: '先别做' }, { id: 'revise', label: '换个做法' }]))
    // 服务端本来就按 id 分派，投影只改人看到的字。
    expect(view.options.map(option => option.id)).toEqual(['go', 'stop', 'revise'])
    expect(view.options.map(option => option.label)).toEqual(['确认执行这一次', '取消这一次（任务继续）', '修改内容'])
    // 旧 JSON 不在主正文里；它在折叠的 details 中，且标明是原样记录。
    expect(view.question).not.toContain('{')
    expect(view.question).not.toContain('mcp__')
    expect(view.presentation!.details).toContain(raw)
    expect(view.presentation!.details).toContain('原样记录')
    // 这段 JSON 是完整的：正文能原样取出，真实换行保留（不是字面反斜杠 n）。
    expect(view.presentation!.preview).toBe('第一行\n第二行')
  })

  it('refuses to invent a preview when the stored text was cut off, and points at revise', () => {
    const cut = 'send_message({"channel":"main","to":"m82","text":"' + '很长的正文'.repeat(200)
    const view = legacyConnectionCard(oldCard(cut))
    // 判不准就是判不准：不给 preview，不拿半句话当「他要发的正文」。
    expect(view.presentation!.preview).toBeUndefined()
    expect(view.presentation!.details).toContain('内容不完整')
    expect(view.presentation!.details).toContain(cut.slice(-12))
    expect(view.presentation!.details).toContain('修改内容')
  })

  it('projects a card that is not recoverable at all into plain words without guessing', () => {
    const view = legacyConnectionCard(oldCard('要看这条消息吗？（旧版没记录参数）'))
    expect(view.question).toContain('要')
    expect(view.presentation).toMatchObject({ kind: 'connection' })
    expect(view.presentation!.preview).toBeUndefined()
    // 原话仍在，作为折叠内容保留 —— 不丢证据，也不冒充正文。
    expect(view.presentation!.details).toContain('旧版没记录参数')
  })
})
