/**
 * team SourceKind（可放进宿主的完整版）。
 *
 * 与 mobile Source 同构：读同一个 `mobileq` 队列，但按 **mentions** 做确定性路由，
 * 把目标 bot_id 写进 meta 与 channel.address，用于回话署名与 worker 的 persona/记忆注入。
 *
 * 放进宿主 checkout 的步骤：
 *   1. 复制本文件到 dsh-superagent/src/sources/team.ts；
 *   2. 复制 src/contract/{directory,route}.ts 到 dsh-superagent/src/crew/；
 *   3. 在 cordis.patch.yml 的 insert 里加 `- id: dsh-superagent-team / name: dsh-superagent/team`；
 *   4. 用 `mobileq inject --mention <bot>` 灌消息即可验证。
 *
 * 授权仍归后台：meta.bot_id 只影响呈现与记忆注入，不参与 Gate / Mandate。
 */

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { record, type Key } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks, SourceKind } from './kind.ts'
import { defaultBot, validateDirectory, type BotDirectory } from '../crew/directory.ts'
import { routeBot, threadOf } from '../crew/route.ts'

const SOURCE = 'team'
const CURSOR: Key<number> = record<number>('team-cursor')

const BotSchema = z.object({
  bot_id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  role: z.enum(['default', 'member']),
  persona: z.string().optional(),
  memory_namespace: z.string(),
}).strict()

const ConfigSchema = z.object({
  bots: z.array(BotSchema).default([]),
  default_bot_id: z.string().regex(/^[a-z0-9-]+$/).default('lead'),
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
    direct: z.boolean().default(false),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(2).max(3600).default(5),
}).strict()
export type TeamConfig = z.infer<typeof ConfigSchema>

const MessageSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(v => String(v)),
  conversation: z.string().min(1),
  thread: z.union([z.string(), z.number()]).optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }),
  mentions_me: z.boolean().default(false),
  mentions: z.array(z.string()).default([]),
  text: z.string(),
  at: z.string(),
  url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>

const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.union([z.number(), z.string()]) })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })

/** 把存进配置的 bots 还原成目录；不合规时抛错，让健康态报出来而不是静默降级。 */
export function directoryOf(config: TeamConfig): BotDirectory {
  const dir: BotDirectory = {
    default_bot_id: config.default_bot_id,
    bots: config.bots.map(bot => ({
      bot_id: bot.bot_id,
      name: bot.name,
      role: bot.role,
      ...(bot.persona ? { persona: bot.persona } : {}),
      memory_namespace: bot.memory_namespace,
    })),
  }
  validateDirectory(dir)
  return dir
}

/** 一条队列消息的 Trigger；Bot 自己的回声不产生 Trigger。 */
export function teamTrigger(message: QueueMessage, me: string, config: TeamConfig): Trigger | undefined {
  if (message.sender.id === me) return undefined
  const dir = directoryOf(config)
  const conversation = config.conversations.find(item => item.id === message.conversation)
  const route = routeBot({ mentions: message.mentions, conversation: message.conversation }, dir, conversation?.direct ?? false)
  const thread = threadOf(message.conversation, message.thread === undefined ? undefined : String(message.thread), message.id)
  return {
    id: key(SOURCE, message.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: message.sender.id },
    human: !message.sender.bot,
    ...(route.addressed ? { addressed: route.addressed } : {}),
    at: message.at,
    text: message.text,
    channel: {
      source: SOURCE,
      thread: `${SOURCE}:${thread}`,
      address: {
        conversation: message.conversation,
        message: message.id,
        bot_id: route.bot_id,
        ...(message.url ? { url: message.url } : {}),
      },
    },
    ...(message.url ? { url: message.url } : {}),
    meta: {
      conversation: message.conversation,
      messageId: message.id,
      root: message.thread ?? message.id,
      bot_id: route.bot_id,
      mentions: message.mentions,
      ...(route.unknown_mentions ? { unknown_mentions: route.unknown_mentions } : {}),
    },
  }
}

/** The gateway's own default when the deployment names no port. */
const DEFAULT_GW_PORT = '8788'
/** An https gateway on 443 needs no port in an origin. */
const OMITTED_GW_PORT = '443'

/**
 * The gateway origin as the panel should reach it. The bind address and port come from the DSH
 * gateway settings, never a fixed host; a wildcard bind cannot be dialled from a browser, and the
 * gateway is on this machine, so 127.0.0.1 answers for it.
 */
export function gatewayOrigin(gateway: { host?: string; port?: string; secure?: boolean }): string {
  const host = gateway.host?.trim().toLowerCase() ?? ''
  const reachable = host && host !== '0.0.0.0' && host !== '::' && host !== '[::]' ? host : '127.0.0.1'
  const port = gateway.port?.trim() ?? DEFAULT_GW_PORT
  return `${gateway.secure ? 'https' : 'http'}://${reachable}${port && port !== OMITTED_GW_PORT ? `:${port}` : ''}`
}

/**
 * The crew queue address has no URL of its own, so the link opens the gateway instead: a browser only
 * accepts an authenticated send from the gateway's own host, and that host serves the phone screen at
 * `/`. The conversation is passed along for a gateway that learns to open a specific one.
 */
export function teamLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const label = { zh: `Bot 队伍对话 ${address.conversation}`, en: `Bot crew conversation ${address.conversation}` }
  // Anything that arrived with its own URL (a phone or web note) keeps it; only queue-only messages fall back.
  if (address.url) return { url: address.url, label }
  const conversation = address.conversation ?? ''
  return { url: `${gatewayOrigin(links.gateway ?? {})}/?conversation=${encodeURIComponent(conversation)}`, label }
}

export const teamKind: SourceKind<TeamConfig> = {
  kind: SOURCE,
  title: { zh: 'Bot 队伍', en: 'Bot crew' },
  description: {
    zh: '读本地消息队列（tools/mobileq），按 @ 把消息路由给先应声的那个 Bot；没人点名时由默认的「大哥」接话。',
    en: 'Reads the local message queue (tools/mobileq) and routes each message by mention; the default bot answers when nobody is named.',
  },
  schema: ConfigSchema,
  fields: [
    { key: 'bots', type: 'rows', label: { zh: 'Bot 名单', en: 'Bots' }, columns: [
      { key: 'bot_id', type: 'text', label: { zh: 'id', en: 'id' }, pattern: '[a-z0-9-]+' },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' } },
      { key: 'role', type: 'select', label: { zh: '角色', en: 'Role' }, options: [
        { value: 'default', label: { zh: '大哥（默认接话，全表只能一个）', en: 'Default (answers when nobody is named; exactly one)' } },
        { value: 'member', label: { zh: '成员', en: 'Member' } }] },
      { key: 'persona', type: 'text', label: { zh: '人格', en: 'Persona' }, optional: true },
      { key: 'memory_namespace', type: 'text', label: { zh: '记忆命名空间', en: 'Memory namespace' }, pattern: 'bot/[a-z0-9-]+' },
    ] },
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z0-9-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @ 与点名', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      { key: 'direct', type: 'select', label: { zh: '类型', en: 'Kind' }, options: [
        { value: 'false', label: { zh: '群聊', en: 'Group' } }, { value: 'true', label: { zh: '私聊', en: 'Direct' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['team'],
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    // 名单里成员被 @ 也算听见；名单里没有的人 @ 谁都不算。
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendTeam,
    link: teamLink,
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('mobileq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({
        id: item.id,
        from: item.sender.id,
        at: item.at,
        text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}),
        ...(item.url ? { url: item.url } : {}),
      }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
  repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? key(SOURCE, trigger.meta.parentId) : undefined,
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
        .default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在对话里 @ 某个 Bot。', en: 'Someone on the list mentions a bot in a conversation.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return {
        id: conversation.id,
        label: conversation.id,
        note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all },
      }
    }),
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_CREW_BOT', description: {
        zh: '这次工单由哪个 Bot 露面；用于选人格与记忆命名空间',
        en: 'The bot whose face this ticket carries; selects the persona and memory namespace' } },
      { key: 'DSH_SUPERAGENT_CREW_PERSONA', description: {
        zh: '这个 Bot 的人格描述；工单不是从 Bot 队伍来的时为空',
        en: 'This bot persona; empty when the ticket did not come from the bot crew' } },
      { key: 'DSH_SUPERAGENT_CREW_MEMORY', description: {
        zh: '这个 Bot 的记忆命名空间，形如 bot/<id>',
        en: 'This bot memory namespace, such as bot/<id>' } },
      { key: 'DSH_SUPERAGENT_CREW_CONVERSATION', description: {
        zh: '工单来源的对话；工单不是从这个来源来的时为空',
        en: 'The conversation that started the ticket; empty when the ticket did not come from this Source' } },
      { key: 'DSH_SUPERAGENT_CREW_TEAM', description: {
        zh: '同队其他 Bot 的 id 与名字，形如 id=名字，逗号分隔；用来知道能找谁',
        en: 'The other bots in the crew as id=name pairs, comma separated, so this bot knows whom it may hand work to' } },
    ],
    values: ({ config, trigger }) => {
      if (trigger?.source !== SOURCE) {
        return { DSH_SUPERAGENT_CREW_BOT: '', DSH_SUPERAGENT_CREW_PERSONA: '', DSH_SUPERAGENT_CREW_MEMORY: '',
          DSH_SUPERAGENT_CREW_CONVERSATION: '', DSH_SUPERAGENT_CREW_TEAM: '' }
      }
      const botId = String(trigger.meta.bot_id ?? '')
      let persona = ''
      try {
        persona = defaultBot(directoryOf(config)).persona ?? ''
        const named = config.bots.find(bot => bot.bot_id === botId)
        if (named) persona = named.persona ?? ''
      } catch { persona = '' }
      // Who else is on the crew, so a bot can name a teammate instead of answering outside its own remit.
      const team = (config.bots ?? [])
        .filter(bot => bot.bot_id !== botId)
        .map(bot => `${bot.bot_id}=${bot.name}`)
        .join(', ')
      return {
        DSH_SUPERAGENT_CREW_BOT: botId,
        DSH_SUPERAGENT_CREW_PERSONA: persona,
        DSH_SUPERAGENT_CREW_MEMORY: botId ? `bot/${botId}` : '',
        DSH_SUPERAGENT_CREW_CONVERSATION: String(trigger.meta.conversation ?? ''),
        DSH_SUPERAGENT_CREW_TEAM: team,
      }
    },
  },
}

/**
 * The queue this Source reads. `mobileq` defaults to one machine state directory, which is right until two crews run on
 * one machine: then the second backend would poll the first one's queue. Passing the database the deployment names keeps
 * each crew on its own.
 */
function queueFile(deployment: { stateDir: string }): string[] {
  return ['--db', join(deployment.stateDir, 'mobileq.db')]
}

export async function sendTeam(host: Pick<SourceContext, 'commands' | 'deployment'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to, bot_id } = message.channel.address
  if (!conversation || !to) throw new Error('Missing team reply target')
  try {
    // Sign the reply with the Bot that answered, so the phone can show who spoke.
    // The outbox hands a Channel only `commands` (see `SourceChannel.send`), so `deployment` arrives undefined here
    // even though the type says otherwise. Fall back to the CLI's own default rather than read through it: a reply
    // must not fail because the deployment was not threaded down to this path.
    const target = host.deployment ? queueFile(host.deployment) : []
    await host.commands.run('mobileq', ['reply', '--conversation', conversation, '--to', to, '--key', message.id, '--text', message.text,
      ...target, ...(typeof bot_id === 'string' && bot_id ? ['--bot', bot_id] : [])])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}

export const name = 'dsh-superagent-team'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(teamKind), 'team: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, teamKind)
    const controller = new AbortController()
    // DSH 遇到未处理的 rejection 会结束进程，所以逃出循环的错误要变成 Source 的健康态。
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('team', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('team', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<TeamConfig>(SOURCE)
    if (!config) ctx.report('team', health('paused', 'sourceOff'))
    else if (config.bots.length === 0) ctx.report('team', { state: 'paused', detail: 'No bots configured' })
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollQueue(ctx, signal)
        failures = 0
        ctx.report('team', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        if (!signal.aborted && failures >= 3) {
          ctx.report('team', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 5) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** 读过游标之后的消息，逐条收进 Engine，然后把游标推过去。 */
export async function pollQueue(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(CURSOR) ?? 0
  const output = await ctx.commands.withSignal(signal).run('mobileq', ['pull', '--after', String(after), '--json',
      ...queueFile(ctx.deployment)])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The team Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const config = ctx.config<TeamConfig>(SOURCE)
    if (!config) break
    let trigger: Trigger | undefined
    try {
      trigger = teamTrigger(message.data, page.me, config)
    } catch (error) {
      // 名单配错不该拖住整个来源：记成不可读，其余照常。
      unreadable++
      continue
    }
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '对话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation } })
  }
  ctx.state.set(CURSOR, Number(page.next))
  return { read: page.items.length, unreadable }
}
