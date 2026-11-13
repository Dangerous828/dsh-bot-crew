/** Mobile source kind: reads a local message queue (`tools/mobileq`) and turns its messages into Triggers. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { record, type Key } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

const SOURCE = 'mobile'
const CURSOR: Key<number> = record<number>('mobile-cursor')

/**
 * 多会话 seam 的文档契约（S1，见 `docs/adr/0007-multi-session-seam.md`、`docs/00-contract.md` §9）：
 *
 * - `conversation` 是队列 `mobileq.db` 的列 / 领域词；线上消息面以 query 参数 `session_id`
 *   与它一一映射，缺省 `main`。网关/消息面按 `session_id` 分片后，这里读到的
 *   `message.conversation` 已是那次请求选中的会话，不再是单一常量。
 * - 下面这份 `conversations` 名单是 **Source 准入** 的允许清单，不是会话名单：
 *   `scope()` 与 `channel.allowed` 据此判断一条消息的 conversation 是否登记在册。
 * - **S1 不改这里的准入判定**：本阶段只落文档契约。「未登记会话不静默丢消息」——
 *   不在这层丢消息，也不把未知会话静默改写成 `main`；消息按其 conversation 原样入队、
 *   可在 `timeline?session_id=X` 读到，派单与否仍由既有名单判据决定。
 * - 让 `conversations` 跟随会话注册名单、给未登记会话一个明确的准入结果，是 **S4** 的范围
 *   （隔离不变量收口）。在 S4 之前，本文件的 `scope()` / `channel.allowed` 保持不动，
 *   `masterId` 与 DSH 上游也不动（ADR 0007）。
 */
const ConfigSchema = z.object({
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(2).max(3600).default(5),
}).strict()
export type MobileConfig = z.infer<typeof ConfigSchema>

const MessageSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(v => String(v)),
  conversation: z.string().min(1),
  thread: z.union([z.string(), z.number()]).optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }),
  mentions_me: z.boolean().default(false),
  text: z.string(),
  at: z.string(),
  url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>

const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.union([z.number(), z.string()]) })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })

/** The Trigger of one queue message; the agent's own messages produce none. */
export function mobileTrigger(message: QueueMessage, me: string): Trigger | undefined {
  if (message.sender.id === me) return undefined
  const thread = `${message.conversation}:${message.thread ?? message.id}`
  return {
    id: key(SOURCE, message.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at,
    text: message.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`,
      address: { conversation: message.conversation, message: message.id, ...(message.url ? { url: message.url } : {}) } },
    ...(message.url ? { url: message.url } : {}),
    meta: { conversation: message.conversation, messageId: message.id, root: message.thread ?? message.id },
  }
}

export const mobileKind: SourceKind<MobileConfig> = {
  kind: SOURCE,
  title: { zh: '手机', en: 'Mobile' },
  description: { zh: '接收来自手机消息队列的消息。', en: 'Receives messages from the mobile message queue.' },
  schema: ConfigSchema,
  fields: [
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z0-9-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['mobile'],
  // 准入判定：S1 保持不动，会话名单收口留给 S4（说明见上方 ConfigSchema 注释、ADR 0007）。
  scope({ meta }, config) {
    const conv = config.conversations.find(item => item.id === meta.conversation)
    if (!conv) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conv.listen === 'all', row: conv.id }
  },
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendMobile,
    link: address => ({ url: address.url ?? '', label: { zh: `手机对话 ${address.conversation}`, en: `Mobile conversation ${address.conversation}` } }),
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('mobileq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
  repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? key(SOURCE, trigger.meta.parentId) : undefined,
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在消息里 @ 智能体。', en: 'Someone on the list mentions the agent in a message.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conv => {
      const all = conv.listen === 'all'
      return { id: conv.id, label: conv.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_MOBILE_CONVERSATION', description: {
      zh: '接下工单的手机对话；工单不是从这个来源来的时为空',
      en: 'The mobile conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_MOBILE_CONVERSATION: trigger?.source === SOURCE ? String(trigger.meta.conversation ?? '') : '' }),
  },
}

export async function sendMobile(host: { commands: SourceContext['commands'] }, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to } = message.channel.address
  if (!conversation || !to) throw new Error('Missing mobile reply target')
  try {
    await host.commands.run('mobileq', ['reply', '--conversation', conversation, '--to', to, '--key', message.id, '--text', message.text])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}

export const name = 'dsh-superagent-mobile'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(mobileKind), 'mobile: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, mobileKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('mobile', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Until setup resolves accounts the Source reads nothing.
  if (!ctx.configured()) { ctx.report('mobile', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<MobileConfig>(SOURCE)
    if (!config) ctx.report('mobile', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollQueue(ctx, signal)
        failures = 0
        ctx.report('mobile', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        if (!signal.aborted && failures >= 3) {
          ctx.report('mobile', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 5) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** Read the queue after the cursor, take in each message, then move the cursor past them. */
export async function pollQueue(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(CURSOR) ?? 0
  const output = await ctx.commands.withSignal(signal).run('mobileq', ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The mobile Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const trigger = mobileTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '对话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation } })
  }
  ctx.state.set(CURSOR, Number(page.next))
  return { read: page.items.length, unreadable }
}
