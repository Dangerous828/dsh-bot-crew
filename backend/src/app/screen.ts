/**
 * 「看它的屏幕」：把一张工单的 worker 会话整理成可读的活动快照。
 *
 * 这不是截图。worker 干的是终端与文件活，不跑浏览器；真正有信息量的是它刚刚
 * 执行了什么命令、输出了什么、说了什么。宿主已经有这些事件（session 事件流），
 * 这里只做「取最近 N 条、归类、截断、掩码」——纯函数，不碰网络、不碰磁盘。
 *
 * 未来若接真实像素画面（CUA 或浏览器），是另一个 kind，不影响这份契约：
 * `state: 'live' | 'unavailable'` 与 `reason` 保持不变。
 */

export type ScreenLineKind = 'command' | 'output' | 'said' | 'status'

export interface ScreenLine {
  at: string
  kind: ScreenLineKind
  text: string
}

/**
 * 它此刻在干什么，写成手机顶上那一行。
 *
 * 这一格只由「工单阶段 + 最后一条活动」推出来，不猜：
 * - `waiting` / `idle` / `ended` 来自阶段机（它在等人 / 手上空着 / 这张票结束了）；
 * - 在干活时再看最后一条可显示的活动是命令、输出还是回话。
 */
export type ScreenActivity = 'running' | 'thinking' | 'waiting' | 'idle' | 'ended'

export interface ScreenSnapshot {
  state: 'live' | 'unavailable'
  /** `terminal` 是终端活动快照；像素画面若将来接，是另一种 kind（见 docs/00-contract.md §5.1）。 */
  kind?: 'terminal'
  ticket_id?: string
  live?: boolean
  /** 最后一条活动的时间。 */
  at?: string
  /** 这一轮开工的时间（这次作业开始跑的钟点）；没有在跑的作业就不给。 */
  since?: string
  cwd?: string
  /** 工单阶段，原词来自 core 的阶段机：working / person / idle / ended。 */
  stage?: string
  /** 它此刻在干什么。手机顶上那一行照这个词写，不自己编。 */
  activity?: ScreenActivity
  /** 有多少条事件没有变成行（认不出的类型，或超出了条数上限）。缺席表示一条都没丢。 */
  hidden?: number
  lines?: ScreenLine[]
  reason?: string
}

/** 会话事件的形状（与 @deepseek-ai/dsh-session 一致，但只读我们认得的字段）。 */
export interface ScreenEvent {
  type: string
  time?: string
  data?: unknown
}

export interface ScreenInput {
  ticketId?: string
  events?: readonly ScreenEvent[]
  cwd?: string
  /** 票号存在与否。给了 false 就说「队伍里没有这张工单」，而不是拿「没有记录」糊过去。 */
  known?: boolean
  /** 工单阶段与这次作业的开工时间，由 Runtime 从票上读；纯函数不碰 store。 */
  stage?: string
  since?: string
  /** 最多回多少条，默认 120。 */
  limit?: number
}

const MAX_LINE_CHARS = 500
const DEFAULT_LIMIT = 120

/** 把事件里的文本块取出来：字符串、{text}、{content:[{type:'text',text}]} 都认。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  const content = record.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.flatMap(block => {
      if (!block || typeof block !== 'object') return []
      const item = block as Record<string, unknown>
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
    }).join('\n')
  }
  if (typeof record.message === 'object') return textOf(record.message)
  return ''
}

/**
 * 掩码：命令与输出里经常带凭据。宁可过度掩码，也不要把 token 送到手机上。
 * 覆盖 KEY=value / TOKEN: value / Bearer xxx。
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*)\S+/gi, '$1***')
}

function line(kind: ScreenLineKind, at: string, text: string): ScreenLine | undefined {
  const cleaned = maskSecrets(text).replace(/\s+$/g, '')
  if (!cleaned.trim()) return undefined
  return { at, kind, text: cleaned.length > MAX_LINE_CHARS ? `${cleaned.slice(0, MAX_LINE_CHARS)}…` : cleaned }
}

/**
 * 从 tool/call 的 arguments 里取命令行。arguments 有两种形状：已解析的对象，
 * 或一整段 JSON 字符串。后者直接 JSON.stringify 出来会把 `{"description":…}`
 * 原样送到手机上，读起来像乱码；先解一次，拿不到 command 再退回原文。
 */
function commandOf(value: unknown): string {
  const fromObject = (item: unknown): string => item && typeof item === 'object' && typeof (item as Record<string, unknown>).command === 'string'
    ? String((item as Record<string, unknown>).command) : ''
  const direct = fromObject(value)
  if (direct) return direct
  if (typeof value !== 'string') return value === undefined ? '' : JSON.stringify(value)
  try { return fromObject(JSON.parse(value)) || value } catch { return value }
}

/** 一条事件最多产生一行；认不出的类型直接跳过。 */
function readEvent(event: ScreenEvent): ScreenLine | undefined {
  const at = typeof event.time === 'string' ? event.time : new Date().toISOString()
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
  switch (event.type) {
    case 'tool/call': {
      const name = typeof data.name === 'string' ? data.name : 'tool'
      const command = commandOf(data.arguments)
      return line('command', at, command ? `$ ${command}` : `$ ${name}`)
    }
    case 'tool/result': {
      const message = textOf(data.message) || textOf(data.output) || textOf(data.error)
      return line('output', at, message)
    }
    case 'assistant/message':
      return line('said', at, textOf(data))
    case 'turn/start':
      return line('status', at, '开始一轮')
    case 'turn/end':
      return line('status', at, '这一轮结束')
    case 'working-directory/change': {
      const cwd = typeof data.cwd === 'string' ? data.cwd : typeof data.directory === 'string' ? data.directory : ''
      return cwd ? line('status', at, `工作目录：${cwd}`) : undefined
    }
    case 'command/run': {
      const command = typeof data.command === 'string' ? data.command : ''
      return command ? line('command', at, `$ ${command}`) : undefined
    }
    case 'command/done': {
      const code = typeof data.exitCode === 'number' ? data.exitCode : undefined
      return line('status', at, code === undefined ? '命令结束' : `命令结束（退出码 ${code}）`)
    }
    case 'job/registered': {
      const id = typeof data.id === 'string' ? data.id : ''
      return line('status', at, id ? `后台任务 ${id} 开始` : '后台任务开始')
    }
    case 'todo/write':
      return line('status', at, '更新待办')
    // 一步的开始与预算重试：手机上「它还在往前走」和「它在等模型额度」是两回事，都要能看出来。
    case 'step/start': {
      const step = typeof data.step === 'number' ? data.step : undefined
      return line('status', at, step === undefined ? '开始一步' : `开始第 ${step} 步`)
    }
    case 'llm/retry': {
      const provider = typeof data.provider === 'string' ? data.provider : ''
      const retry = typeof data.retry === 'number' ? data.retry : undefined
      const where = provider ? `（${provider}）` : ''
      return line('status', at, retry === undefined ? `模型额度不够，正在重试${where}` : `模型额度不够，第 ${retry} 次重试${where}`)
    }
    default:
      return undefined
  }
}

/**
 * 它此刻在干什么：阶段机给的大方向 + 最后一条活动给出的细节。
 *
 * 阶段说「在等人 / 空着 / 结束了」时，最后一条活动是什么都不改变这件事 —— 那是最该说的。
 * 只有阶段是 working（或没给阶段）时才看最后一行：命令与输出是「在跑」，回话是「在想」。
 * 什么都推不出来就返回 undefined，让调用方整行不写，而不是写一个「未知」。
 */
function activityOf(stage: string | undefined, last: ScreenLine | undefined): ScreenActivity | undefined {
  if (stage === 'ended') return 'ended'
  if (stage === 'person') return 'waiting'
  if (stage === 'idle') return 'idle'
  if (!last) return stage === 'working' ? 'thinking' : undefined
  if (last.kind === 'command' || last.kind === 'output') return 'running'
  if (last.kind === 'said') return 'thinking'
  // 只剩 status 一类：说了「轮次开始/结束」但没说在做什么。没有阶段就不硬猜。
  return stage === 'working' ? 'thinking' : undefined
}

/**
 * 生成快照。没有票号、票不存在、没有事件、或者事件里没有可显示的内容时，如实返回
 * `unavailable`，不编造「正在运行」。
 *
 * 有内容时不止给行，还给三样让手机能画成「实景」而不是一串日志：
 * `stage` / `activity`（它此刻在干什么）、`since`（这次作业几点开工）、
 * `hidden`（有多少条没变成行，省略即一条没丢）。
 */
export function screenOf(input: ScreenInput): ScreenSnapshot {
  const ticketId = input.ticketId?.trim()
  if (!ticketId) return { state: 'unavailable', reason: '没有指定是哪张工单' }
  if (input.known === false) return { state: 'unavailable', ticket_id: ticketId, reason: '队伍里没有这张工单' }
  const events = input.events ?? []
  const stage = input.stage?.trim() || undefined
  const shared = { ticket_id: ticketId, ...(stage ? { stage } : {}), ...(input.since ? { since: input.since } : {}) }
  if (events.length === 0) {
    return { state: 'unavailable', ...shared, reason: '这张工单还没有可读的执行记录' }
  }
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 500))
  const considered = events.slice(-limit)
  const lines = considered
    .map(readEvent)
    .filter((item): item is ScreenLine => item !== undefined)
  if (lines.length === 0) {
    return { state: 'unavailable', ...shared, reason: '执行记录里没有可显示的内容' }
  }
  const last = lines[lines.length - 1]!
  const activity = activityOf(stage, last)
  // 被丢掉的 = 超出上限没看的 + 看了但认不出的。省略即没丢，客户端据此决定要不要写一句「另有 N 条」。
  const hidden = events.length - lines.length
  return {
    state: 'live', kind: 'terminal', ...shared, live: true, at: last.at,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(activity ? { activity } : {}),
    ...(hidden > 0 ? { hidden } : {}),
    lines,
  }
}
