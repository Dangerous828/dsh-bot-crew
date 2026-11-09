/**
 * 确定性路由：消息该由哪个 Bot 露面。规则见 docs/00-contract.md §3，不由模型决定。
 */
import type { BotDirectory } from './directory.ts'
import { validateDirectory } from './directory.ts'

export interface RouteInput {
  /** @ 到的 bot_id，可为空。 */
  mentions: string[]
  /** 群聊 / 私聊 / IM 会话的稳定标识。 */
  conversation: string
  thread?: string
}

export interface RouteDecision {
  bot_id: string
  /** 省略表示 Bot 自己发的消息，不算在跟它说话。 */
  addressed?: 'mention' | 'direct'
  unknown_mentions?: string[]
}

export function routeBot(input: RouteInput, dir: BotDirectory, isDirect: boolean): RouteDecision {
  validateDirectory(dir)
  const known = new Set(dir.bots.map(b => b.bot_id))
  const hits = input.mentions.filter(m => known.has(m))
  const unknown = input.mentions.filter(m => !known.has(m))
  const unknownPart = unknown.length > 0 ? { unknown_mentions: unknown } : {}
  const first = hits[0]
  if (first !== undefined) {
    return { bot_id: first, addressed: 'mention', ...unknownPart }
  }
  // 无人点名：大哥默认接话。私聊记 direct，群聊记 mention。
  return { bot_id: dir.default_bot_id, addressed: isDirect ? 'direct' : 'mention', ...unknownPart }
}

/** 一条消息的稳定话题串 id：有 thread 用 thread，否则退化为消息自身。 */
export function threadOf(conversation: string, thread: string | undefined, messageId: string): string {
  return `${conversation}:${thread ?? messageId}`
}
