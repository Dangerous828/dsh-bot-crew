/**
 * 阶段 2 骨架：team SourceKind。
 *
 * 不是可直接运行的完整实现：这里只固定「消息 → Trigger」的翻译与确定性路由形状，
 * 真正落盘 / 轮询 / Channel.send 需要接到宿主 checkout 内，复用 tools/mobileq 的队列与
 * mobile-http.ts 的 timeline/send。参考 src/sources/mobile.ts。
 *
 * 宿主接入步骤（在 dsh-superagent checkout 内）：
 *   1. 把本文件复制到 src/sources/team.ts；
 *   2. 在 cordis.patch.yml 的 insert 里加一条 dsh-superagent-team；
 *   3. 用 SourceKind 的 receive / channel / policy / threadContext 补齐队列读取与回写；
 *   4. Bot 目录作为 Source 配置（或 Policy 的 Source part）保存，启动时 validateDirectory。
 *
 * 授权仍归后台：meta.bot_id 只影响呈现与记忆注入，不参与 Gate / Mandate。
 */

import type { OutboundMessage, Trigger } from '@dsh-bot-crew/host-types' // 占位：接宿主时换成 '../core/index.ts'
import type { BotDirectory, SendRequest, TeamTriggerMeta } from '../contract/types.ts'
import { routeBot } from '../contract/types.ts'

export const SOURCE = 'team'

/** 幂等键：同一条消息只产生一个 Trigger。 */
export function teamTriggerId(messageId: string): string {
  return `${SOURCE}:${messageId}`
}

/** 对话内的话题串 id，退化为消息自身。 */
export function teamThread(conversation: string, thread: string | undefined, messageId: string): string {
  return `${conversation}:${thread ?? messageId}`
}

export interface TeamMessage extends Omit<SendRequest, 'request_id'> {
  id: string
}

/**
 * 纯翻译函数：一条前台消息 → 一个后台 Trigger。
 * 不发网络、不读队列、不写状态；可单测。
 */
export function toTrigger(
  message: TeamMessage,
  dir: BotDirectory,
  opts: { me: string; isDirect: boolean },
): Trigger | undefined {
  // 自己的回声不产生 Trigger（与 mobile.ts 一致）
  if (message.sender.id === opts.me) return undefined

  const route = routeBot(message as SendRequest, dir, opts.isDirect)
  const thread = teamThread(message.conversation, message.thread, message.id)
  const channelThread = `${SOURCE}:${thread}`
  const meta: TeamTriggerMeta = {
    bot_id: route.bot_id,
    mentions: message.mentions,
    ...(route.unknown_mentions ? { unknown_mentions: route.unknown_mentions } : {}),
    conversation: message.conversation,
    root: message.thread ?? message.id,
  }

  return {
    id: teamTriggerId(message.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: message.sender.id },
    human: !message.sender.bot,
    ...(route.addressed ? { addressed: route.addressed } : {}),
    ...(message.sender.bot ? { addressed: undefined } : {}),
    at: message.at,
    text: message.text,
    channel: {
      source: SOURCE,
      thread: channelThread,
      address: {
        conversation: message.conversation,
        message: message.id,
        bot_id: route.bot_id, // Outbox 回写时的署名
      },
    },
    ...(message.url ? { url: message.url } : {}),
    meta,
  } as Trigger
}

/**
 * SourceChannel.send 的形状（幂等、返回 gone 表示会话不再可回）。
 * 实现时直接复用现有 mobileq / mobile-http 的出站写入，不新开一套消息总线。
 */
export type TeamChannelSend = (message: OutboundMessage) => Promise<'sent' | 'gone'>

/** 待实现清单，接宿主时逐项勾掉。 */
export const TODO = [
  'ConfigSchema：conversations[].id / listen / pollSeconds，bots 目录或 Policy part 引用',
  'SourcePolicyPart：allowed 名单 + admission rows（群 / 私聊分别可配）',
  'poll：从队列按 cursor 拉消息，按 id 去重，落 read position（重启不重放）',
  'channel.send：按 message.id 幂等回写；会话消失返回 gone',
  'threadContext.read：给 Eval 提供同话题上下文（含 Bot 之间引用）',
  'worker 注入：按 meta.bot_id 带 persona / memory_namespace / 工具集 / 署名',
  'observe 默认：先只记 would accept，人工看过再切 auto',
] as const
