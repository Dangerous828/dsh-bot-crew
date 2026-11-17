/**
 * 审批：这活做不做。
 *
 * 与 `eval.mode` 是两件事，别混：
 * - `eval.mode`（off / observe / auto）判的是**队伍接不接这条活** —— 接了之后照常做完；
 * - 这里的 `approval` 判的是**接了的活要不要先问一声** —— `ask` 时队伍先停下来等你点头。
 *
 * 三档，都只作用在「已接单」的工作上：
 *
 * | 档 | 意思 |
 * |---|---|
 * | `auto` | 自动做。只有明确写下的禁区（`blocked` 规则命中的）才会停下 |
 * | `ask`  | 需你点头。命中「要审批的」规则时先问，其余照 `auto` 做 |
 * | `off`  | 禁区。一律先问，不自动开工 |
 *
 * 为什么不是简单的「一刀切」：让人对每一件小事点头，他三天后就闭着眼点同意了 ——
 * 那比不问更糟。所以默认档是 `ask`：**只对真的要紧的那几类停下来**。
 */

import type { ApprovalPresentation } from '../core/model.ts'

/** 三种档位。`off` 这个名字沿用 eval 那套，意思是「不自动做」。 */
export type ApprovalMode = 'auto' | 'ask' | 'off'
/** 一次审批判定。 */
export interface ApprovalDecision {
  /** 要不要先问人。 */
  ask: boolean
  /** 为什么。`ask` 为 true 时这句会原样显示给人看。 */
  reason: string
  /** 是哪条规矩让它停下的；`off` 档下可能是 `mode`。 */
  because: 'mode' | 'rule' | 'budget' | 'none'
}

/** 判定需要知道的那些事实。都由调用方从已有数据里读出来，这里不自己查。 */
export interface ApprovalFacts {
  /** 当前档位。 */
  mode: ApprovalMode
  /** 命中的规则 id（来自评估）。 */
  rules: readonly string[]
  /** 那些规则里，哪几条被标成了「要审批」。 */
  sensitive: readonly string[]
  /** 这次活会不会写盘 / 调外部服务。读了不算。 */
  writes?: boolean
  /** 已经用掉的额度比例（0..1）；`undefined` 表示不知道。 */
  budgetUsed?: number
}

/** 超过这个比例就先问一句：快没钱了还闷头干活，是最难解释的一种。 */
export const BUDGET_ASK_RATIO = 0.9

/**
 * 判一次。
 *
 * 顺序是有意的：**档位 → 规则 → 额度**。前面的挡得住就不看后面的 ——
 * 反过来会让一句「额度快用完了」盖掉「这条规矩是禁区」，让人以为那只是钱的事。
 */
export function approvalOf(facts: ApprovalFacts): ApprovalDecision {
  if (facts.mode === 'off') {
    return { ask: true, because: 'mode', reason: '现在设的是「一律先问」：接了的活也要你点头才动' }
  }
  const hit = facts.rules.filter(rule => facts.sensitive.includes(rule))
  if (facts.mode === 'ask' && hit.length > 0) {
    return { ask: true, because: 'rule', reason: `这条撞上了要审批的规矩：${hit.join('、')}` }
  }
  if (facts.budgetUsed !== undefined && facts.budgetUsed >= BUDGET_ASK_RATIO) {
    return { ask: true, because: 'budget', reason: `额度已经用掉 ${Math.round(facts.budgetUsed * 100)}%，再干下去要先跟你说一声` }
  }
  return { ask: false, because: 'none', reason: '' }
}

/** A/B 面板上那两个按钮：从「选哪个」扩到「做不做」。 */
export interface ApprovalPrompt {
  question: string
  options: { id: string; label: string }[]
  /** 人读投影：动作、对象、待确认正文、折叠的脱敏细节。消费者缺它就只看 question。 */
  presentation?: ApprovalPresentation
}

export type ApprovalAnswer = 'go' | 'stop' | 'revise'

/**
 * 需要点头时，问什么。
 *
 * 三个选项而不是两个：只给「做 / 不做」时，人想「换个做法」只能拒绝再重说一遍。
 * `revise` 让队伍停在原地等一句新要求，不用把活重新派一遍。
 *
 * 这里的 stop 是**停止整项任务**，文案必须说清这个后果（与一次外部写动的取消不是一回事，见 `connectionPrompt`）。
 */
export function approvalPrompt(title: string, decision: ApprovalDecision): ApprovalPrompt {
  return {
    question: `${decision.reason}。要「${title}」吗？`,
    options: [
      { id: 'go', label: '开始做' },
      { id: 'stop', label: '停止这项任务' },
      { id: 'revise', label: '修改要求' },
    ],
    presentation: { kind: 'task', action: '开始这项任务', target: title },
  }
}

/**
 * 一次外部写动要点头时，问什么。
 *
 * 与任务审批分开两件事：这里的 stop 只**取消这一次调用**，票继续活着（worker 换别的做法或收尾），
 * 所以按钮文案必须自己说出这个区别 —— 人只从「先别做」看不出整张票会被结束。
 * 问题正文只说人话；待确认的正文进 `preview`（保留真实换行），工具名与参数进折叠的 `details`。
 */
export function connectionPrompt(given: Omit<ApprovalPresentation, 'kind'> & { reason?: string }): ApprovalPrompt {
  const presentation: ApprovalPresentation = { kind: 'connection', ...given }
  const action = given.action ?? '做一次改动'
  const target = given.target ? `给「${given.target}」` : ''
  const reason = given.reason ? `${given.reason}。` : ''
  return {
    question: `${reason}要${action}${target}吗？`,
    options: [
      { id: 'go', label: '确认执行这一次' },
      { id: 'stop', label: '取消这一次（任务继续）' },
      { id: 'revise', label: '修改内容' },
    ],
    presentation,
  }
}

/**
 * 一个人**逐字写下**的答复对应哪个选项；只有明确说法才算，其余返回 undefined。
 *
 * 按钮文案改过，人还会照着老词打字（「做吧」「先别做」「换个做法」）。这里只认整套词，
 * 不做模糊匹配：随手一句「随便」不算任何选项，审批入口照旧如实拒绝，不拿它去停一张票。
 */
export function legacyAnswerId(text: string): ApprovalAnswer | undefined {
  const said = text.trim()
  if (/^(做吧|做|同意|可以|开始|开始做|好|确认|确认执行这一次|go|yes|ok)$/i.test(said)) return 'go'
  if (/^(先别做|别做|不要|取消|停止这一次|stop|no|cancel)$/i.test(said)) return 'stop'
  if (/^(换个做法|改一下|换个方式|修改要求|修改内容|revise|change)$/i.test(said)) return 'revise'
  return undefined
}

/**
 * 人的回答怎么读。认不出的回答按「先别做」处理 —— 宁可不动，也不要猜他要什么。
 *
 * 以旧卡的三个词为准，新文案也认得；服务端真正的分派走 `answerOf`（按 option.id），不靠这里的词表。
 */
export function readAnswer(text: string): ApprovalAnswer { return legacyAnswerId(text) ?? 'stop' }

/**
 * 客户端点头/取消/改内容时，服务端怎么解读这个选项。
 *
 * 按 `option.id` 分派（客户端原样回传它看到的那个 id），只在老卡没有 id 时回退到词表 ——
 * 这样改文案不会改行为，旧票（持久化的老 options）也照样能答。
 */
export function answerOf(option: { id: string; label: string } | undefined): ApprovalAnswer {
  const id = option?.id?.trim().toLowerCase()
  if (id === 'go' || id === 'stop' || id === 'revise') return id
  return option ? readAnswer(option.label) : 'revise'
}

/** 只按字段名脱敏；正文一个字符都不改（不反转义、不替换反斜杠、不截断）。 */
const SECRET_FIELD = /token|password|credential|authorization|secret|api_?key|cookie/i

/** 正文类字段：第一个有值的按原样进 `preview`，它就是人要被问的那段内容。 */
const TEXT_FIELDS = ['text', 'body', 'content', 'message', 'note', 'description'] as const

/** 一个字段值给人看的样子：字符串原样（换行照旧），其余走 JSON —— 只对值本身，不做全文替换。 */
function shown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * 一次外部写动的人读投影：动作、对象、待确认正文、脱敏后的其余参数。
 *
 * 之前这里是把 `JSON.stringify(args).slice(0, 500)` 拼进问题的：序列化把换行变成字面 `\n`，
 * 截断把消息切在半句上，人看到的是一段工具协议而不是「要发什么」。现在正文走类型化的 `text` 字段
 * **完整**保留（preview 宁可长，也不能让人批准一段自己没看全的内容），其余参数进折叠的 details。
 */
export function presentCall(input: {
  /** 这类连接的人话名字，如「消息」。 */
  kindName: string
  tool: string
  args: unknown
  /** 本票来源会话；同会话写动就直说「当前对话」，别让人去猜 main/m82 是哪。 */
  conversation?: string
}): Omit<ApprovalPresentation, 'kind'> {
  const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args)
    ? input.args as Record<string, unknown> : undefined
  const previewField = TEXT_FIELDS.find(field => typeof args?.[field] === 'string' && args[field] !== '')
  const preview = previewField ? String(args![previewField]) : undefined
  const channel = typeof args?.channel === 'string' ? args.channel : undefined
  const to = typeof args?.to === 'string' ? args.to : undefined
  const target = channel
    ? channel === input.conversation ? '当前对话' : `会话 ${channel}`
    : undefined
  const details = args
    ? ['工具：' + input.tool, ...Object.entries(args)
      .filter(([field]) => field !== previewField)
      .map(([field, value]) => `${field}：${SECRET_FIELD.test(field) ? '[已隐藏]' : shown(value)}`)].join('\n')
    : `工具：${input.tool}`
  const action = input.tool === 'send_message' ? '发送这条消息' : `用${input.kindName}做这次改动（${input.tool}）`
  return {
    action,
    ...(target ? { target } : {}),
    ...(preview ? { preview } : {}),
    details,
  }
}

/**
 * 旧卡的只读投影：把已经存下来的 `ticket.attention`（问题卡）翻成人读的那一套。
 *
 * 历史卡的问题正文是 `JSON.stringify(args).slice(0, 500)` 拼出来的 —— 换行变成字面 `\n`，
 * 长消息被切断。这不能再当主正文显示，但它记录的是**当时到底批了什么**，所以不丢：整段移进折叠的
 * `details`，并标明它是否被截断。
 *
 * 正文若能从这段 JSON 里**完整**取出来（有 `text` 字段且没被切在半句上），就当 `preview` 给；
 * 取不全就**不捏造**：没有 `preview`，`details` 里写明内容不全，`hint` 让人选「修改内容」重新确认一次。
 */
export function legacyConnectionCard(attention: { question: string; options?: readonly { id: string; label: string }[] },
  context: { kindName?: string } = {}): ApprovalPrompt {
  const raw = attention.question
  const mined = mineCall(raw)
  // 三个 id 照旧映射到新文案：服务端本来就按 id 分派，改的只是人看到的那几个字。
  const options = (attention.options?.length ? attention.options : [{ id: 'go', label: '做吧' }, { id: 'stop', label: '先别做' }, { id: 'revise', label: '换个做法' }])
    .map(option => ({ id: option.id, label: CONNECTION_LABELS[option.id] ?? option.label }))
  const action = mined?.tool === 'send_message' ? '发送这条消息'
    : mined?.tool ? `用${context.kindName ?? '外部连接'}做这次改动（${mined.tool}）` : '做一次外部改动'
  const target = mined?.target
  const details = [
    mined?.tool ? `工具：${mined.tool}` : undefined,
    ...mined?.others.map(field => `${field.name}：${SECRET_FIELD.test(field.name) ? '[已隐藏]' : field.value}`) ?? [],
    '',
    mined?.complete ? '这条审批原样记录：' : '这张卡当时记录的内容不完整（旧版把参数截断过），下面只是原始片段：',
    raw,
    ...mined?.complete ? [] : ['', '要根据这段片段直接确认，请选「修改内容」让我重新问一次。'],
  ].filter(line => line !== undefined).join('\n')
  return {
    question: target ? `要${action}给「${target}」吗？` : `要${action}吗？`,
    options,
    presentation: { kind: 'connection', action, ...(target ? { target } : {}),
      ...(mined?.complete && mined.preview ? { preview: mined.preview } : {}), details },
  }
}

/** 新卡的三个按钮文案，按 id 索引；旧卡投影也用它，人看到的字才一致。 */
const CONNECTION_LABELS: Readonly<Record<string, string>> = {
  go: '确认执行这一次', stop: '取消这一次（任务继续）', revise: '修改内容',
}

/**
 * 从旧卡那段字符串里尽量取出「当时批的是什么」。
 *
 * 只在能**确定**的时候说 `complete`：JSON 解析得开、有 `text` 字段、且原文没有被截断的痕迹
 * （长度不足旧的 500 上限，或原文本来就短）。判不准就是判不准 —— 宁可让人重问一次，
 * 也不拿半句话去当「他要发的正文」。
 */
/** 把序列化留下的字面 `\n` 还原成真换行：只影响这两个字符，不动别的字节。 */
function escapedBackslashes(text: string): string { return text.replace(/\\n/g, '\n') }

function mineCall(raw: string): { tool?: string; target?: string; preview?: string; complete: boolean
  others: { name: string; value: string }[] } | undefined {
  const start = raw.indexOf('{')
  if (start < 0) return undefined
  // 只取 JSON 本体：旧问题可能是 `工具名({...})`，也可能就是 `{...}`。
  const end = raw.lastIndexOf('}')
  const body = end > start ? raw.slice(start, end + 1) : raw.slice(start)
  // 旧格式里有字面 `\n`（序列化留下的），解析前换回真换行只影响这两个字符，不改别的。
  const attempt = (text: string): Record<string, unknown> | undefined => {
    try { const parsed = JSON.parse(text); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined } catch { return undefined }
  }
  const parsed = attempt(body) ?? attempt(body.replace(/\\n/g, '\n')) ?? attempt(escapedBackslashes(body))
  const tool = /([A-Za-z0-9_]+)\s*\(/.exec(raw)?.[1]
  if (!parsed) return tool ? { tool, complete: false, others: [] } : undefined
  const channel = typeof parsed.channel === 'string' ? parsed.channel : undefined
  const previewField = TEXT_FIELDS.find(field => typeof parsed[field] === 'string' && parsed[field] !== '')
  const preview = previewField ? String(parsed[previewField]) : undefined
  // 截断判据：解析成功但结尾不像一个完整字符串（旧格式以 `}` 收尾；被切的原串一定不以它结尾）。
  // 旧格式是一整段 `JSON.stringify` 的结果，末尾一定是 `}`；被 `slice(0, 500)` 切过的不会。
  // 解析得开只说明这一段还成句，不足以证明它就是全部，所以两条都要看。
  const truncated = !body.trimEnd().endsWith('}') || (preview === undefined && body.length >= 499)
  return {
    ...(tool ? { tool } : {}),
    ...(channel ? { target: channel === 'current' ? '当前对话' : channel } : {}),
    ...(preview && !truncated ? { preview } : {}),
    complete: !truncated && preview !== undefined,
    others: Object.entries(parsed).filter(([name]) => name !== previewField && name !== 'channel')
      .map(([name, value]) => ({ name, value: shown(value) })),
  }
}
