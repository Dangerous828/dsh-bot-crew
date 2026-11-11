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

export interface ScreenSnapshot {
  state: 'live' | 'unavailable'
  kind?: 'terminal'
  ticket_id?: string
  live?: boolean
  at?: string
  cwd?: string
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
    default:
      return undefined
  }
}

/**
 * 生成快照。没有票号、没有事件、或者事件里没有可显示的内容时，如实返回
 * `unavailable`，不编造「正在运行」。
 */
export function screenOf(input: ScreenInput): ScreenSnapshot {
  const ticketId = input.ticketId?.trim()
  if (!ticketId) return { state: 'unavailable', reason: '没有指定是哪张工单' }
  const events = input.events ?? []
  if (events.length === 0) {
    return { state: 'unavailable', ticket_id: ticketId, reason: '这张工单还没有可读的执行记录' }
  }
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 500))
  const lines = events
    .slice(-limit)
    .map(readEvent)
    .filter((item): item is ScreenLine => item !== undefined)
  if (lines.length === 0) {
    return { state: 'unavailable', ticket_id: ticketId, reason: '执行记录里没有可显示的内容' }
  }
  const last = lines[lines.length - 1]!
  return {
    state: 'live', kind: 'terminal', ticket_id: ticketId, live: true, at: last.at,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    lines,
  }
}
