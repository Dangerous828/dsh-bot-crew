/** Mobile source kind: reads a local message queue (`tools/mobileq`) and turns its messages into Triggers. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV, record, type Key } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

const SOURCE = 'mobile'
const CURSOR: Key<number> = record<number>('mobile-cursor')

/**
 * 多会话 seam（S1 文档契约 + S4 落地，见 `docs/adr/0007-multi-session-seam.md`、`docs/00-contract.md` §9）：
 *
 * - `conversation` 是队列 `mobileq.db` 的列 / 领域词；线上消息面以 query 参数 `session_id`
 *   与它一一映射，缺省 `main`。网关/消息面按 `session_id` 分片后，这里读到的
 *   `message.conversation` 已是那次请求选中的会话，不再是单一常量。
 * - S4 起，**会话准入的唯一真源是 S1 的 `KV.mobile.sessions` 注册名单**（family 前缀只由 kv.ts 定义），
 *   `ConfigSchema.conversations` 只保留作向后兼容的手配清单，两者叠加。未登记会话的消息
 *   原样留在队列里（可按 `timeline?session_id=X` 读回），不生成 Trigger、不派单，但会留下
 *   明确的可观测记录（`conversation_not_listed` + 计数 KV + health detail），绝不静默吞掉。
 * - `masterId` 与 DSH 上游不动（ADR 0007）。
 */
const ConfigSchema = z.object({
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(2).max(3600).default(5),
}).strict()
export type MobileConfig = z.infer<typeof ConfigSchema>

/**
 * S4 Source 准入机制（issue #14 第 3 项 / #10 第 4 项）。
 *
 * `kind.ts:100` 的 `scope?(input: { meta }, config)` 与 `channel.allowed(address, config)` 签名里
 * 没有 context / store，`registry.ts:131` 也只把 `meta` 与 `config` 传进来。因此名单由
 * `pollQueue()`（拿得到 `SourceContext.state.keys`）在生成 Trigger 时算一次，以**快照**形式
 * 写进 `Trigger.meta` 与 `Trigger.channel.address`，两个判定点只读这份随 Trigger 走的快照：
 * 不改 kind.ts / registry.ts 签名，不用全局可变状态，登记后下一次 poll 重读 KV 即生效。
 *
 * `main` 是缺省会话：S1 读侧恒补首位、不落键，它的准入仍由手配清单负责；只有真正登记过的
 * 非 main 会话才由注册名单放行。
 */
const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
/** `Trigger.meta` / `Trigger.channel.address` 上携带「生成时注册名单快照」的字段名。 */
export const SESSION_ROSTER = 'registeredSessions'
/** 未登记消息被本 Source 拒收的累计次数（Source 私有 KV；可观测，不是全局可变状态）。 */
export const UNLISTED: Key<number> = record<number>('mobile-unlisted')

/** 从 `KV.mobile.sessions` 读出 S1 注册名单。每次 poll 重读，所以登记后无需配置变更或重启。 */
export function sessionRoster(state: Pick<SourceContext['state'], 'keys'>): string[] {
  const keys = typeof state.keys === 'function' ? state.keys(KV.mobile.sessions) : []
  const extra = keys
    .map(name => name.slice(KV.mobile.sessions.prefix.length))
    .filter(id => id !== 'main' && SESSION_ID.test(id))
  return [...new Set(extra)].sort()
}

/** 读出注入的名单快照：`meta` 里是数组，`channel.address` 里是 JSON 字符串；读不到一律当空名单。 */
export function rosterOf(value: unknown): string[] {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown } catch { return [] }
  }
  return Array.isArray(parsed)
    ? [...new Set(parsed.filter((id): id is string => typeof id === 'string' && SESSION_ID.test(id)))].sort()
    : []
}

/** 会话是否入册：手配清单（向后兼容）**或** S1 注册名单。去掉 `roster.includes` 这一支，断言 4 立刻变红。 */
export function isAdmitted(conversations: readonly { id: string }[], conversation: unknown, roster: readonly string[]): boolean {
  return typeof conversation === 'string'
    && (conversations.some(item => item.id === conversation) || roster.includes(conversation))
}

/** 把「生成时的注册名单」快照写进 Trigger，供 `scope()` 与 `channel.allowed` 判定。 */
export function withRoster(trigger: Trigger, roster: readonly string[]): Trigger {
  const sessions = [...new Set(roster)].sort()
  return {
    ...trigger,
    meta: { ...trigger.meta, [SESSION_ROSTER]: sessions },
    ...(trigger.channel ? { channel: { ...trigger.channel,
      address: { ...trigger.channel.address, [SESSION_ROSTER]: JSON.stringify(sessions) } } } : {}),
  }
}

/** health detail 里的可观测记录：拒收条数与会话名，把 `conversation_not_listed` 摆到台面上。 */
export function pollDetail(read: number, unreadable: number, refused: number, refusedSessions: readonly string[]): string {
  const base = `${read} messages, ${unreadable} unreadable`
  return refused > 0
    ? `${base}, ${refused} conversation_not_listed: ${[...new Set(refusedSessions)].sort().join(', ')}`
    : base
}

/**
 * 一轮 poll 之后要报给 health 的那一条（`watch` 唯一的 ready 上报点）。
 *
 * 抽成导出函数是为了让它能被测试直接钉住：审查证明，只在纯函数 `pollDetail` 上断言时，
 * 把 `watch` 里的这处调用换回旧字符串，全部用例仍然绿 —— 「可观测」就没有机制保障了。
 * 现在测试断言的是这个函数本身，`watch` 只能调它。
 */
export function pollReport(read: number, unreadable: number, refused: number, refusedSessions: readonly string[]): { state: 'ready'; detail: string; at: string } {
  return { state: 'ready', detail: pollDetail(read, unreadable, refused, refusedSessions), at: new Date().toISOString() }
}

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
  // S4：名单 = 手配清单（向后兼容）+ Trigger 里随行的 S1 注册名单快照。
  scope({ meta }, config) {
    const conv = config.conversations.find(item => item.id === meta.conversation)
    if (conv) return { listened: true, observed: conv.listen === 'all', row: conv.id }
    if (isAdmitted([], meta.conversation, rosterOf(meta[SESSION_ROSTER]))) {
      // 注册会话按「仅 @」处理：不主动观察未点名的消息，也不占 Policy 表的手配行。
      return { listened: true, observed: false }
    }
    return { listened: false, reason: 'conversation_not_listed' }
  },
  channel: {
    // 回话目标同样合并注册名单，否则登记会话派单成功、回话却被 channelIgnored 丢掉。
    allowed: (address, config) => isAdmitted(config.conversations, address.conversation, rosterOf(address[SESSION_ROSTER])),
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
        const { read, unreadable, refused, refusedSessions } = await pollQueue(ctx, signal)
        failures = 0
        ctx.report('mobile', pollReport(read, unreadable, refused, refusedSessions))
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
export async function pollQueue(ctx: SourceContext, signal: AbortSignal): Promise<{
  read: number; unreadable: number; refused: number; refusedSessions: string[]
}> {
  const after = ctx.state.get(CURSOR) ?? 0
  const output = await ctx.commands.withSignal(signal).run('mobileq', ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  const config = ctx.config<MobileConfig>(SOURCE)
  // 每次 poll 重读 S1 注册名单：登记会话不用改 Source 配置、不用重启。
  const roster = sessionRoster(ctx.state)
  let unreadable = 0, refused = 0
  const refusedSessions: string[] = []
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The mobile Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    if (!isAdmitted(config?.conversations ?? [], message.data.conversation, roster)) {
      // 未登记会话：不生成 Trigger、不派单；消息原样留在队列里，可按 session_id 读回。
      // 计数与会话名落到 KV / health detail，绝不「什么都没发生」。
      refused++
      refusedSessions.push(message.data.conversation)
      ctx.state.set(UNLISTED, (ctx.state.get(UNLISTED) ?? 0) + 1)
      continue
    }
    const trigger = mobileTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(withRoster(trigger, roster))
    const conversation = { label: { zh: '对话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation } })
  }
  ctx.state.set(CURSOR, Number(page.next))
  return { read: page.items.length, unreadable, refused, refusedSessions }
}
