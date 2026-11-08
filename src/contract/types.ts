/**
 * 消息面契约的表层类型。
 *
 * 只描述前后台之间线上跑的字节；状态主体在后台 Ticket。
 * 字段形状参照 BotHarness/DeepSeekBot (MIT) 的消息面表层，不含其 Assignment / Inbox 状态字段。
 */
import type { BotCard, BotDirectory } from '../crew/directory.ts'

export type { BotCard, BotDirectory, BotRole } from '../crew/directory.ts'
export { BOT_ID, defaultBot, namespaceOf, validateDirectory } from '../crew/directory.ts'
export type { RouteDecision, RouteInput } from '../crew/route.ts'
export { routeBot, threadOf } from '../crew/route.ts'

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
  messageId: string
  root: string
}

/** 供界面直接用的 Bot 名单（只读投影）。 */
export function botCards(dir: BotDirectory): BotCard[] {
  return dir.bots.map(({ bot_id, name, role, persona, avatar, color, memory_namespace }) => ({
    bot_id, name, role,
    ...(persona ? { persona } : {}),
    ...(avatar ? { avatar } : {}),
    ...(color ? { color } : {}),
    memory_namespace,
  }))
}
