/**
 * Bot 目录：全表有且只有一个 default（大哥），其余为成员。
 * Bot 是身份与呈现，不是 Agent，不持有任务状态。
 */

export type BotRole = 'default' | 'member'

export interface BotCard {
  bot_id: string
  name: string
  role: BotRole
  persona?: string
  avatar?: string
  color?: string
  memory_namespace: string
}

export interface BotDirectory {
  bots: BotCard[]
  default_bot_id: string
}

export const BOT_ID = /^[a-z0-9-]+$/

export function validateDirectory(dir: BotDirectory): void {
  if (!Array.isArray(dir.bots) || dir.bots.length === 0) {
    throw new Error('BotDirectory: at least one bot is required')
  }
  // 先校验每个条目自身的形状，再校验角色基数：一个坏条目应先报它自己坏。
  const seen = new Set<string>()
  for (const bot of dir.bots) {
    if (!BOT_ID.test(bot.bot_id)) throw new Error(`BotDirectory: bad bot_id ${bot.bot_id}`)
    if (seen.has(bot.bot_id)) throw new Error(`BotDirectory: duplicate bot_id ${bot.bot_id}`)
    seen.add(bot.bot_id)
    if (bot.memory_namespace !== namespaceOf(bot.bot_id)) {
      throw new Error(`BotDirectory: ${bot.bot_id} must use memory_namespace ${namespaceOf(bot.bot_id)}`)
    }
  }
  const defaults = dir.bots.filter(b => b.role === 'default')
  if (defaults.length !== 1) {
    throw new Error(`BotDirectory: exactly one default bot is required, found ${defaults.length}`)
  }
  if (!dir.bots.some(b => b.bot_id === dir.default_bot_id)) {
    throw new Error(`BotDirectory: default_bot_id ${dir.default_bot_id} names no bot`)
  }
  const soleDefault = defaults[0]
  if (!soleDefault) throw new Error('BotDirectory: exactly one default bot is required')
  if (soleDefault.bot_id !== dir.default_bot_id) {
    throw new Error('BotDirectory: the default bot and default_bot_id disagree')
  }
}

/** 记忆命名空间约定，与 dsh-auto-memory 的落盘目录一一对应。 */
export function namespaceOf(botId: string): string {
  return `bot/${botId}`
}

export function defaultBot(dir: BotDirectory): BotCard {
  const bot = dir.bots.find(b => b.role === 'default')
  if (!bot) throw new Error('BotDirectory: no default bot')
  return bot
}
