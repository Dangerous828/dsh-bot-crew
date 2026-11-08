/**
 * 消息面契约的表层类型。
 *
 * 只描述前后台之间线上跑的字节；状态主体在后台 Ticket。
 * 字段形状参照 BotHarness/DeepSeekBot (MIT) 的消息面表层，不含其 Assignment / Inbox 状态。
 */

export type BotRole = 'default' | 'member'

export interface BotCard {
  /** 稳定 id，[a-z0-9-]。被 Ticket 引用过之后不可复用。 */
  bot_id: string
  name: string
  /** 全表有且只有一个 default —— 大哥。 */
  role: BotRole
  persona?: string
  avatar?: string
  color?: string
  /** 记忆桥的 namespace，约定 bot/<bot_id>。 */
  memory_namespace: string
}

export interface BotDirectory {
  bots: BotCard[]
  default_bot_id: string
}

export interface Sender {
  id: string
  bot: boolean
}

/** POST /send */
export interface SendRequest {
  /** uuid v4；重试必须沿用同一个值。 */
  request_id: string
  conversation: string
  thread?: string
  sender: Sender
  /** @ 到的 bot_id；空数组表示无人点名。 */
  mentions: string[]
  text: string
  at: string
  url?: string
}

export type SendErrorCode =
  | 'bad_request' | 'unauthorized' | 'conflict' | 'too_large' | 'upstream' | 'unavailable'

export type SendResponse =
  | { ok: true; id: string; request_id: string }
  | { ok?: false; error: SendErrorCode }

export type ReplyKind = 'acknowledgement' | 'reply' | 'notice'

/** GET /timeline 的 item */
export interface TimelineItem {
  id: string
  role: 'bot' | 'user' | 'system'
  bot_id?: string
  text: string
  at: string
  request_id?: string
  kind?: ReplyKind
  /** 只读展示；前台不得据此维护自己的状态机。 */
  ticket_ref?: string
  /** 保留未知字段，客户端解析不得丢弃。 */
  [key: string]: unknown
}

export interface RuntimeStatus {
  runtime: 'off' | 'observe' | 'auto'
  mobile: 'on' | 'off'
  paused: boolean
}

export interface TimelineResponse {
  items: TimelineItem[]
  /** 后台 Ticket 的只读投影，后台给什么字段就展示什么。 */
  tasks: Array<Record<string, unknown>>
  status: RuntimeStatus
}

/** 适配层写给后台 Trigger 的 meta（呈现参数，不参与 Gate / Mandate）。 */
export interface TeamTriggerMeta {
  bot_id: string
  mentions: string[]
  unknown_mentions?: string[]
  conversation: string
  root: string
}

/** 确定性路由判定，不由模型决定。见 docs/00-contract.md §3。 */
export interface RouteDecision {
  bot_id: string
  addressed?: 'mention' | 'direct'
  unknown_mentions?: string[]
}

export function validateDirectory(dir: BotDirectory): void {
  const defaults = dir.bots.filter((b) => b.role === 'default')
  if (defaults.length !== 1) throw new Error('BotDirectory: exactly one default bot is required')
  if (defaults[0].bot_id !== dir.default_bot_id) throw new Error('BotDirectory: default_bot_id mismatch')
  const ids = new Set<string>()
  for (const b of dir.bots) {
    if (!/^[a-z0-9-]+$/.test(b.bot_id)) throw new Error(`BotDirectory: bad bot_id ${b.bot_id}`)
    if (ids.has(b.bot_id)) throw new Error(`BotDirectory: duplicate bot_id ${b.bot_id}`)
    ids.add(b.bot_id)
  }
}

/** 群聊无人 @ → 大哥；私聊无人 @ → 大哥 + direct。 */
export function routeBot(req: SendRequest, dir: BotDirectory, isDirect: boolean): RouteDecision {
  validateDirectory(dir)
  const known = new Set(dir.bots.map((b) => b.bot_id))
  const hits = req.mentions.filter((m) => known.has(m))
  if (hits.length > 0) {
    const unknown = req.mentions.filter((m) => !known.has(m))
    return { bot_id: hits[0], addressed: 'mention', ...(unknown.length ? { unknown_mentions: unknown } : {}) }
  }
  const unknown = req.mentions.length ? { unknown_mentions: req.mentions } : {}
  return {
    bot_id: dir.default_bot_id,
    addressed: isDirect ? 'direct' : 'mention',
    ...unknown,
  }
}
