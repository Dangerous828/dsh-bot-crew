/** Phone endpoints on DSH's authenticated Fetch carrier; queue admission remains owned by the mobile Source. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HttpHost } from './http.ts'
import { canRetry, ticketStage } from '../core/index.ts'
import { SettingsConflict } from './settings.ts'
import type { Settings } from '../policy.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { KV, record } from '../kv.ts'
import { agentTree, switchModel, workOf } from './work.ts'
import type { ScreenSnapshot } from './screen.ts'
import type { OutputsTicket, OutputsView } from './outputs.ts'
import type { RoutinesView } from './routines.ts'
import type { MemoryView } from './views/memory.ts'
import type { AuditRow } from './audit.ts'
import type { Spend } from './spend.ts'
import type { Transcript } from './voice.ts'
import type { Quota, ReplySpend } from './quota.ts'
import type { SpeakOutcome } from './speech.ts'
import type { MemoryLayer } from './memory-layer.ts'
import type { DeviceStore } from './remote.ts'
import { BOT_ID } from '../crew/directory.ts'

// Structural contract keeps compatibility with the bundle's alpha development
// peers; installed rc.2 Connection supplies this authenticated exact-route API.
interface FetchRegistry {
  register(route: { path: string; methods: ('GET' | 'POST')[]; requestBody: 'buffered';
    fetch(request: Request): Promise<Response> }): () => Promise<void>
}
/**
 * What the phone surface needs from the crew. `remote` is the device table: the phone redeems its pairing code
 * here rather than at the local-only management surface, because this is the one carrier it can already reach.
 */
type PhoneHost = Pick<HttpHost, 'ready' | 'machine' | 'store' | 'health' | 'models'> & { remote?: DeviceStore
  /** 「看它的屏幕」：宿主把工单的会话整理成快照；没有这项能力的假宿主可以不给。 */
  screen?: (ticketId: string) => Promise<ScreenSnapshot>
  /** 「产出」：把若干张工单交出来的文件合成一栏；宿主没接时路由如实说读不到。 */
  outputs?: (tickets: readonly OutputsTicket[]) => Promise<OutputsView>
  /** 「常规任务」：把 KV 里的那张定时账本合成一栏；宿主没接时路由如实说读不到。 */
  routines?: () => Promise<RoutinesView>
  /** 常规任务写侧：新增 / 修改 / 删除一条（契约 §5.5）。宿主没接时 POST 说 503。 */
  writeRoutine?: (action: 'create' | 'edit' | 'remove', input: { id?: string; title?: string; cycle?: string; bot_id?: string; enabled?: boolean }) =>
    { ok: boolean; record?: unknown; reason?: string }
  /** 记忆：读一栏；`forget` / `edit` 是主人亲手改账本。宿主没接时路由如实说读不到。 */
  memories?: (options: { bot?: string }) => Promise<MemoryView>
  /** 成本账：一张票用了哪个模型、花了多少 token；读不到会话时 `spend` 缺席（不是 0）。 */
  spend?: (ticketId: string) => Promise<Spend | undefined>
  /** 审计账：谁派的、谁判的、谁干的、花了多少，一票一行。 */
  audit?: (ticketId: string) => Promise<AuditRow | undefined>
  /** 逐条用量：每一步用的哪个模型、花了多少、上下文还剩多少。 */
  replySpends?: (ticketId: string) => Promise<{ replies: ReplySpend[]; quota: Quota; warning?: string } | undefined>
  /** 播报：把一句话念成 WAV。宿主没有播报能力时如实说，不假装念了。 */
  speak?: (text: string) => Promise<SpeakOutcome>
  /** 语音：把一段 WAV 转成文字。宿主没有识别能力时如实回 `available: false`。 */
  transcribe?: (audio: Uint8Array, signal: AbortSignal) => Promise<Transcript>
  forgetMemory?: (name: string) => boolean
  editMemory?: (name: string, patch: { description?: string; body?: string; importance?: number }) => boolean
  /** 插队：把排队中的话交给正在跑的 worker（下一步边界读）。 */
  steer?: (ticketId: string, requestId: string, text: string) => Promise<boolean>
  /** 一条模型路由支持哪些推理档位；不支持的宿主可以不给。 */
  efforts?: (provider: string, model: string) => Promise<{ efforts: { id: string; name: string; description?: string }[]; default?: string }>
  /** 工单控制：停下一张票，以及全局暂停。真实 Runtime 两个都有；测试里的假宿主可以只给需要的那个。 */
  engine?: Pick<HttpHost['engine'], 'stopTicket' | 'retryTicket'>
  settings?: Pick<HttpHost['settings'], 'pause' | 'save'> }
/**
 * 手机看得懂的那句人话。
 *
 * 这些错误会原样出现在中文界面上（桌面端把后端原文接在「队伍返回 N:」后面，
 * 手机端直接显示异常文本）。写成英文等于让主人去猜；每一条说清「发生了什么 +
 * 该怎么办」，不是「某个 status code 不对」。
 */
const PHONE_ERRORS: Readonly<Record<string, string>> = {
  'Bot already exists': '这个 id 已经有人用了，换一个',
  'bot_id is required': '没说要动哪一位',
  'No such bot': '队伍里没有这一位',
  'Invalid bot id': 'id 只能用英文小写字母、数字、下划线或短横线',
  'Invalid bot_id': 'id 只能用英文小写字母、数字、下划线或短横线',
  'name is required': '名字不能为空',
  'name is too long': '名字最多 100 个字',
  'persona is too long': '人设最多 2000 个字',
  'Invalid JSON': '请求格式不对',
  'Message too large': '这条消息太长了，拆成几句发',
  'Request too large': '请求太大',
  'model is required': '没说要换成哪个模型',
  'provider is required': '没说是哪一家的模型',
  'provider and model are required': '要同时给出 provider 和 model',
  'Model switching is unavailable': '这个后端没有接入换模型（缺模型目录）',
  'Model details are unavailable': '这个后端没有接入推理档位',
  'No such ticket': '找不到这张工单',
  'Ticket is not running': '这张工单已经不在跑了',
  'Steering is unavailable': '这个后端不支持插队',
  'Pause control is unavailable': '这个后端不支持暂停',
  'Resume control is unavailable': '这个后端不支持继续执行',
  'Resume control failed': '恢复执行没成功，请刷新状态后重试',
  'Session tree is unavailable': '这个后端读不到会话树',
  'Pairing is unavailable': '这个后端没有接入配对',
  'Pairing refused': '配对被拒绝了：码不对，或者已经过期',
  'Pairing request too large': '配对请求太大',
  'code and deviceId are required': '配对要同时给出码和设备号',
  'Mobile transport is not configured': '消息通道还没配好（缺 mobilegw.token）',
  'Mobile transport is temporarily unavailable; retry with the same request_id': '消息通道暂时读不到，过一会儿重试（重试请沿用同一个 request_id）',
  'Mobile request was rejected': '消息通道拒绝了这次请求',
  'no such message': '这句话已经不在队列里了',
  'request_id is required': '缺 request_id',
  'last_read_id is required': '缺 last_read_id：没说读到哪一条回话',
  'Read cursor is unavailable': '这个后端记不下已读位置',
}
/** 把一条错误换成人话；没有对应条目就原样交回，不吞掉后端的原因。 */
const say = (error: string): string => PHONE_ERRORS[error] ?? error
const response = (status: number, value: unknown) =>
  Response.json(status < 400 ? value
    : value && typeof value === 'object' && 'error' in value
      ? { ...value, error: say(String((value as { error: unknown }).error)) }
      : value,
  { status, headers: { 'cache-control': 'no-store' } })

/** 读一个 JSON 对象 body。解析失败、数组、null 都当作「没给」，调用方统一回 400。 */
function askedBody(body: string | undefined): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(body ?? '{}') as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

/**
 * 「认识多久」的出处：这个 Bot 最早那张工单的时间。
 *
 * 只从网关真正返回的工单里取 —— 没有工单就没有这个值，名片上那一行整个不出现。
 * 编一个「从某天起」比少一行更糟：那是拿假数据冒充记忆。
 */
function earliestTicketAt(data: Record<string, unknown>, botId: string): string {
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  let earliest = ''
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue
    const row = task as { bot_id?: unknown; created_at?: unknown }
    if (row.bot_id !== botId) continue
    const at = typeof row.created_at === 'string' ? row.created_at : ''
    if (at && (!earliest || at < earliest)) earliest = at
  }
  return earliest
}

/**
 * The messages the crew read and decided not to act on, with the reason it gave.
 *
 * A message the crew judges as small talk produces no Ticket and therefore no reply, so the conversation shows a
 * person talking to nobody. That is correct behaviour, but invisible: the phone cannot tell "still thinking" from
 * "never going to answer". This names the ones that were looked at and left, so the surface can say so.
 */
export function declinedRequests(items: TimelineItem[], decisions: readonly { kind?: string; at?: string; threadKey?: string;
  reason?: readonly { code?: string; values?: Record<string, unknown> }[] }[], now = Date.now(), windowMs = QUEUE_WINDOW_MS): {
  request_id: string; reason: string
}[] {
  // A Trigger's Thread key carries the queue row it came from (`team:main:6`), which is how a decision points back
  // at a message. Only the newest decision per thread counts: a follow-up can turn an earlier refusal into work.
  const latest = new Map<string, { reason: string; at: number }>()
  for (const decision of decisions) {
    if (typeof decision.threadKey !== 'string') continue
    const row = /:(\d+)$/.exec(decision.threadKey)?.[1]
    if (!row) continue
    const at = Date.parse(decision.at ?? '')
    if (!Number.isFinite(at)) continue
    const seen = latest.get(row)
    if (seen && at <= seen.at) continue
    // Anything other than a refusal is the crew taking the message, which supersedes an earlier refusal on the
    // same thread: the newest decision is the one that describes what happened.
    if (decision.kind !== 'ignore') { latest.delete(row); continue }
    const said = decision.reason?.find(entry => typeof entry.values?.text === 'string')?.values?.text
    latest.set(row, { reason: typeof said === 'string' && said ? said : '这条被判定不需要动手', at })
  }
  return items.flatMap(item => {
    if (item.role !== 'user' || typeof item.request_id !== 'string' || !item.request_id) return []
    const at = Date.parse(item.at ?? '')
    if (!Number.isFinite(at) || now - at > windowMs) return []
    const row = typeof item.id === 'string' ? /^m(\d+)$/.exec(item.id)?.[1] : undefined
    const found = row ? latest.get(row) : undefined
    // A decision older than the message describes a different one: the thread key is not enough on its own.
    if (!found || found.at < at) return []
    return [{ request_id: item.request_id, reason: found.reason }]
  })
}

/**
 * 给回话补上 `ticket_ref`：哪条回话是哪张票说的。
 *
 * 两个地方要用它，规则同一条：代码卡上的「看看改完的样子」要知道去看哪张票
 * （契约 §5），消息结果条要知道这段话的产出在哪张票里（契约 §5.4）。
 *
 * 网关写出的回话只记「挂在哪条消息下」（`reply_to: m6`），不记工单 —— 它本来就不该持有任务账。
 * 工单号在这一侧是现成的：最近的决定里，threadKey 的尾号就是队列行号，`ticketId` 就是那张票。
 * 所以这里只做一次对齐，不做推断：行号对不上、决定是被忽略的、票号为空，一律不补。
 * 补不上就让它缺着 —— 客户端据此如实说「这段改动没带工单号」/ 不画结果条，而不是拿别的票顶替。
 */
export function ticketRefs(items: TimelineItem[], decisions: readonly { kind?: string; at?: string; threadKey?: string;
  ticketId?: string }[]): Map<string, string> {
  const byRow = new Map<string, { ticket: string; at: number }>()
  for (const decision of decisions) {
    const row = typeof decision.threadKey === 'string' ? /:(\d+)$/.exec(decision.threadKey)?.[1] : undefined
    if (!row || typeof decision.ticketId !== 'string' || !decision.ticketId) continue
    // 被忽略的决定没有票；同一行上后来接受过，就以接受的那次为准（取最新一次带票的）。
    if (decision.kind === 'ignore') continue
    const at = Date.parse(decision.at ?? '')
    const seen = byRow.get(row)
    if (seen && (!Number.isFinite(at) || at <= seen.at)) continue
    byRow.set(row, { ticket: decision.ticketId, at: Number.isFinite(at) ? at : 0 })
  }
  const refs = new Map<string, string>()
  for (const item of items) {
    if (item.role !== 'agent') continue
    // 每一条回话都对一次：代码卡要它看改动，结果条要它找产出。
    // 对不上的仍然缺着 —— 这个字段是**来源**，不是猜出来的。
    const row = typeof item.reply_to === 'string' ? /^m(\d+)$/.exec(item.reply_to)?.[1] : undefined
    const found = row ? byRow.get(row) : undefined
    // 网关自己给了非空 ticket_ref 就以它为准：这里只补缺，不改写已有的值。
    // 空串不是「已有值」——老网关会把它写成 ''，那时结果条该照常补上真票号。
    if (!found || (typeof item.ticket_ref === 'string' && item.ticket_ref.length > 0)) continue
    if (typeof item.id === 'string' && item.id) refs.set(item.id, found.ticket)
  }
  return refs
}

/**
 * 把 `ticketRefs` 算出来的票号放回条目上。只补缺、不改写已有的值。
 *
 * 这一层以前只认带代码块的回话（那时只有代码卡要票号）。结果条接上之后，
 * 每条回话都可能被引用，所以不再按代码块过滤：过滤掉的后果是「有产出却永远不画结果条」。
 */
export function withTicketRefs(items: TimelineItem[], refs: Map<string, string>): TimelineItem[] {
  if (refs.size === 0) return items
  return items.map(item => {
    const ticket = typeof item.id === 'string' ? refs.get(item.id) : undefined
    if (!ticket) return item
    return { ...item, ticket_ref: ticket }
  })
}

/** 花名册接口的读法：只交出手机上要显示的三样，配置里坏掉的行跳过而不是让整份花名册报错。 */
function teamBotRows(bots: readonly Record<string, unknown>[]): { bot_id: string; name: string; role: string }[] {
  return bots.flatMap(bot => {
    const id = typeof bot.bot_id === 'string' ? bot.bot_id : ''
    if (!id) return []
    const name = typeof bot.name === 'string' && bot.name.trim() ? bot.name.trim() : id
    return [{ bot_id: id, name, role: typeof bot.role === 'string' ? bot.role : 'member' }]
  })
}

/**
 * 存一份队伍花名册，只改 `team` 的 config。
 *
 * 只改 config、不动 enabled：主人停用 team Source 之后，手机上改一个人不等于要把源悄悄打开。
 * 标明改的是哪个 block：block revision 跟着动，面板手里那份旧值再保存就会被 409 挡住，
 * 而不是静默把刚改的人覆盖掉。
 */
function saveTeamBots(host: Pick<HttpHost, 'store'>, settings: Settings, config: Record<string, unknown>): Response {
  const team = settings.sources?.team
  host.store.saveSettings({ ...settings, sources: { ...settings.sources,
    team: { ...(team ?? {}), enabled: team?.enabled ?? true, config } } },
  { source: 'panel', block: 'source:team', policyVersion: '', policyChanged: false, notified: [] })
  return response(200, { ok: true })
}

/**
 * 这张票是哪个 Bot 接的。
 *
 * 票本身不带 Bot 字段：署名在 Channel 的 address 里（team Source 收消息时写进去的）。
 * 手机要按 Bot 找「他手上那张还没结束的票」，所以这一跳得有一处读得出来。
 */
function ticketBot(ticket: { channels: readonly { address?: Record<string, string> }[] }): string {
  for (const channel of ticket.channels) {
    const id = channel.address?.bot_id
    if (typeof id === 'string' && id) return id
  }
  return ''
}

/** The Bot roster the phone offers as mention targets; unreadable settings fall back to no roster. */
function crewRoster(settings: Settings, since: (botId: string) => string = () => ''): {
  bots: { id: string; name: string; role: string; persona?: string; since?: string }[]
  default_bot_id: string
} {
  const config = settings.sources?.team?.config
  const bots = Array.isArray(config?.bots) ? config.bots : []
  const roster = bots.flatMap(bot => {
    const row = bot as { bot_id?: unknown; name?: unknown; role?: unknown; persona?: unknown }
    if (typeof row.bot_id !== 'string' || !row.bot_id) return []
    // The persona is what the chip can explain on a long press; it is presentation text, never authority.
    const persona = typeof row.persona === 'string' ? row.persona.trim() : ''
    // 「认识多久」要说得出出处。这个值只从真实工单里最早的那一张取，
    // 取不到就整个字段不出现 —— 名片上宁可少一行，也不编一个日期。
    const known = since(row.bot_id)
    return [{ id: row.bot_id, name: typeof row.name === 'string' ? row.name : row.bot_id,
      role: typeof row.role === 'string' ? row.role : 'member', ...(persona ? { persona } : {}),
      ...(known ? { since: known } : {}) }]
  })
  const fallback = roster.find(bot => bot.role === 'default')?.id ?? roster[0]?.id ?? ''
  const named = config?.default_bot_id
  return { bots: roster, default_bot_id: typeof named === 'string' && named ? named : fallback }
}

/**
 * The gateway port a state directory owns. Same rule as `scripts/dsh-superagent`'s `state_dir_identity`:
 * the default state directory keeps 8788, every other one derives its own port from the path.
 *
 * They have to agree. The script starts the gateway and the handler has to find it; a profile that keeps its
 * own `stateDir` (a second crew on the same machine) would otherwise forward to the first crew's gateway and
 * come back 401, which reads as a credential problem but is a port mismatch.
 */
function gatewayPortFor(stateDir: string | undefined): string | undefined {
  if (!stateDir) return undefined
  const resolve = (value: string): string => value.replace(/\/+$/, '')
  if (resolve(stateDir) === resolve(`${homedir()}/.dsh/state/superagent`)) return '8788'
  let digest = 0
  for (const character of resolve(stateDir)) digest = (digest + character.charCodeAt(0)) % 100
  return String(18800 + digest)
}

/** The gateway the message surface forwards to; a profile that keeps its own gateway overrides it by environment. */
function gatewayOrigin(stateDir?: string): string {
  const host = process.env.MOBILEGW_HOST?.trim() || '127.0.0.1'
  const port = process.env.MOBILEGW_PORT?.trim() || gatewayPortFor(stateDir) || '8788'
  return `${process.env.MOBILEGW_SECURE === '1' ? 'https' : 'http'}://${host}:${port}`
}

/**
 * 「回话已读到哪」的会话级水位。存在 Store 的 KV 里：不开新表、不给网关的 `replies` 表加
 * 阅读回执（契约 §5.6 明确说那上面不该有）。值和 `GET /timeline` 的回话 id 同源，都是网关给的 `r<n>`。
 */
const READ_CURSOR = record<string>('mobile-read-cursor')

/** 读水位；宿主没接 KV（老版本或假宿主）时是「没报过」，不是 0 条。 */
function replyReadCursor(store: PhoneHost['store']): string | undefined {
  const value = typeof store.get === 'function' ? store.get(READ_CURSOR) : undefined
  return typeof value === 'string' && value ? value : undefined
}

/** Which operations exist, how they are called, and whether they need a query the surface checks itself. */
const OPERATIONS = {
  timeline: { methods: ['GET'] }, send: { methods: ['POST'] },
  // 排队中的消息撤回：只按 request_id 指认，网关自己判定是否还来得及。
  withdraw: { methods: ['POST'] },
  // 回话已读到哪：客户端上报它在时间线上读到的最后一条回话，后端记一条会话级水位。
  // 这是契约 §5.6 原来缺的那个输入；有了它，`GET /timeline` 才多得出「未读回话」这一格。
  read: { methods: ['POST'] },
  work: { methods: ['GET'], needsTicket: true }, agents: { methods: ['GET'], needsTicket: true },
  // 「产出」：队伍交出来的文件。不带 `?ticket=` 时列最近几张票的产出，带就只看那一张。
  outputs: { methods: ['GET'] },
  // 「常规任务」：定时要做的事的账本。这一轮只读，不改账。
  routines: { methods: ['GET', 'POST'] },
  // 记忆：主人能看、能改、能忘。忘掉只翻状态，不删行。
  memory: { methods: ['GET', 'POST'] },
  // 钱与账：一张票花了多少、这条链谁派的谁判的谁干的。都是只读。
  spend: { methods: ['GET'], needsTicket: true },
  audit: { methods: ['GET'], needsTicket: true },
  // 语音输入：body 是原始 WAV 字节，回一段文字。识别失败时说清是哪一种失败。
  voice: { methods: ['POST'] },
  // 逐条用量：每一步用的谁、多少，「它刚才那一下」问的就是这个。
  'reply-spend': { methods: ['GET'], needsTicket: true },
  // 播报：念一句话，回 WAV。走 POST 是因为正文是要念的字。
  speak: { methods: ['POST'] },
  // 桌面左栏要能「切模型」，切之前得先知道有哪些可选：一次读回 provider、模型和此刻在用的是哪个。
  models: { methods: ['GET'] },
  // 选了模型之后才知道它支持哪些推理档位：按 provider/model 现查。
  efforts: { methods: ['GET'] },
  model: { methods: ['POST'] },
  // 插队：把排队消息直接交给正在跑的 worker，而不是等轮询顺序。
  steer: { methods: ['POST'] },
  // 手机提交配对码也走这条路：Connection 已经验过来源，这是它唯一到得了的入口。
  pair: { methods: ['POST'] },
  // 手机工作区三个控件：看画面、接手、停一下。
  screen: { methods: ['GET'] },
  takeover: { methods: ['POST'] },
  // 失败/卡住的票再跑一次。手机面只到得了这里：管理面的 retry 要求本机同源，手机不满足。
  retry: { methods: ['POST'], needsTicket: true },
  pause: { methods: ['POST'] },
  resume: { methods: ['POST'] },
  // 花名册的读写：空态「加第一位 Bot」与手机上要显示的名字。
  bots: { methods: ['GET', 'POST'] },
} as const
type Operation = keyof typeof OPERATIONS

export function phoneHandler(runtime: PhoneHost, gateway = gatewayOrigin(runtime.machine.stateDir), request = fetch) {
  return async (incoming: Request): Promise<Response> => {
    const url = new URL(incoming.url)
    const name = url.pathname.split('/').at(-1) as Operation | undefined
    const operation = name && name in OPERATIONS ? name : undefined
    if (!operation || !(OPERATIONS[operation].methods as readonly string[]).includes(incoming.method)) {
      return response(404, { error: 'Unknown operation' })
    }
    // A work or agent lookup without a ticket would ask the gateway to guess; refuse it here instead.
    const ticketId = url.searchParams.get('ticket') ?? ''
    if ('needsTicket' in OPERATIONS[operation] && !ticketId) return response(400, { error: 'ticket is required' })
    let body: string | undefined
    if (operation === 'model') {
      body = await incoming.text()
      try {
        const value = JSON.parse(body) as Record<string, unknown> | null
        // The provider is optional (one provider is the norm); the model is not.
        // 成员可以提交空 model，表示「跟随全员」；全场默认必须写一个模型。
        const clearing = value && !Array.isArray(value) && typeof value.model === 'string' && !value.model.trim()
          && typeof value.bot_id === 'string' && value.bot_id.trim() !== ''
        if (!value || Array.isArray(value) || typeof value.model !== 'string' || (!value.model.trim() && !clearing) || value.model.length > 200) {
          return response(400, { error: 'model is required' })
        }
        // 只放行这三个开关：provider 决定去哪儿，bot_id 决定给谁，reasoningEffort 决定档位。
        // 早先这里只留了 provider/model，导致「选推理档位」「指定成员模型」两个动作被静默丢掉。
        const botId = typeof value.bot_id === 'string' && value.bot_id.trim() ? value.bot_id.trim() : undefined
        const effort = typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim() ? value.reasoningEffort.trim() : undefined
        if (botId !== undefined && (botId.length > 64 || !BOT_ID.test(botId))) return response(400, { error: 'Invalid bot_id' })
        if (effort !== undefined && effort.length > 64) return response(400, { error: 'Invalid reasoningEffort' })
        body = JSON.stringify({ ...typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}, model: value.model,
          ...(botId ? { bot_id: botId } : {}), ...(effort ? { reasoningEffort: effort } : {}) })
      } catch { return response(400, { error: 'Invalid JSON' }) }
    }
    if (operation === 'pair') {
      // 配对请求只有四个短字段，给一点余量就够；它不经过网关，所以大小由这里把。
      body = await incoming.text()
      if (Buffer.byteLength(body) > 8 * 1024) return response(413, { error: 'Pairing request too large' })
    }
    if (operation === 'steer') body = await incoming.text()
    if (operation === 'takeover' || operation === 'pause' || operation === 'resume' || operation === 'read' || (operation === 'bots' && incoming.method === 'POST') || (operation === 'routines' && incoming.method === 'POST')) {
      // 控制请求与花名册只带几个短字段，和配对请求同量级。
      body = await incoming.text()
      if (Buffer.byteLength(body) > 8 * 1024) return response(413, { error: 'Request too large' })
    }
    // 重试是执行器上的动作，不经过网关转发，所以放在下面那条转发分支之前。
    if (operation === 'retry') {
      if (!runtime.store.tickets.get(ticketId)) return response(404, { error: 'No such ticket' })
      if (!runtime.engine?.retryTicket) return response(503, { error: 'Ticket control is unavailable' })
      try { runtime.engine.retryTicket(ticketId) } catch { return response(409, { error: 'Ticket cannot be retried' }) }
      return response(200, { ok: true, retried: true })
    }
    if (operation === 'send') {
      body = await incoming.text()
      if (Buffer.byteLength(body) > 64 * 1024) return response(413, { error: 'Message too large' })
      try {
        const value = JSON.parse(body) as Record<string, unknown> | null
        if (!value || Array.isArray(value) || typeof value.text !== 'string' || !value.text.trim()
          || typeof value.request_id !== 'string' || !value.request_id || value.request_id.length > 128) {
          return response(400, { error: 'text and request_id are required' })
        }
        // The authenticated owner is the sender. No client-supplied policy identity crosses this boundary.
        const mentions = Array.isArray(value.mentions)
          ? value.mentions.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 10) : []
        // A mention only names who should answer; authorization stays with the owner identity above.
        body = JSON.stringify({ text: value.text, request_id: value.request_id, mentions })
      } catch { return response(400, { error: 'Invalid JSON' }) }
    }
    if (operation === 'withdraw') {
      body = await incoming.text()
      if (Buffer.byteLength(body) > 8 * 1024) return response(413, { error: 'Request too large' })
      const value = askedBody(body)
      const requestId = typeof value?.request_id === 'string' ? value.request_id : ''
      // 撤回只认 request_id，和 send 用同一个长度上限；其余字段一律丢掉，不替客户端猜。
      if (!requestId || requestId.length > 128) return response(400, { error: 'request_id is required' })
      body = JSON.stringify({ request_id: requestId })
    }
    // The three work routes read the store and the live session tree, which the gateway does not hold. They answer
    // here, after the same Connection-owned authentication that guards every other route.
    if (operation === 'work' || operation === 'agents' || operation === 'models' || operation === 'model' || operation === 'pair'
      || operation === 'screen' || operation === 'takeover' || operation === 'pause' || operation === 'resume' || operation === 'bots' || operation === 'efforts'
      || operation === 'steer' || operation === 'outputs' || operation === 'routines' || operation === 'memory' || operation === 'read'
      || operation === 'spend' || operation === 'audit' || operation === 'voice' || operation === 'reply-spend' || operation === 'speak') {
      await runtime.ready
      if (operation === 'routines') {
        // 「常规任务」：GET 读账本，POST 新增/修改/删除一条（契约 §5.5 已开写接口）。
        if (incoming.method === 'POST') {
          const write = runtime.writeRoutine?.bind(runtime)
          if (!write) return response(503, { error: 'Routine editing is unavailable' })
          const raw = body
          let value: { action?: unknown; id?: unknown; title?: unknown; cycle?: unknown; bot_id?: unknown; enabled?: unknown }
          try { value = JSON.parse(raw ?? '') } catch { return response(400, { error: 'Invalid JSON' }) }
          const action = value?.action
          if (action !== 'create' && action !== 'edit' && action !== 'remove') return response(400, { error: 'action must be create, edit or remove' })
          const outcome = write(action, {
            ...(typeof value.id === 'string' ? { id: value.id } : {}),
            ...(typeof value.title === 'string' ? { title: value.title } : {}),
            ...(typeof value.cycle === 'string' ? { cycle: value.cycle } : {}),
            ...(typeof value.bot_id === 'string' ? { bot_id: value.bot_id } : {}),
            ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
          })
          if (!outcome.ok) return response(400, { ok: false, reason: outcome.reason ?? 'write failed' })
          return response(200, outcome.record ? { ok: true, record: outcome.record } : { ok: true })
        }
        // GET：KV 里那张定时账本。宿主没接这项能力时说「读不到」，不说「还没有常规任务」—— 那是在替队伍编一句话。
        const readRoutines = runtime.routines?.bind(runtime)
        if (!readRoutines) {
          return response(200, { items: [], state: 'unavailable', counts: { enabled: 0, paused: 0 },
            runner: 'none', reason: '后端还没有接入常规任务' })
        }
        try {
          return response(200, await readRoutines())
        } catch {
          return response(200, { items: [], state: 'unavailable', counts: { enabled: 0, paused: 0 },
            runner: 'none', reason: '常规任务暂时读不出来' })
        }
      }
      if (operation === 'reply-spend') {
        const ticketId = url.searchParams.get('ticket')?.trim() ?? ''
        if (!ticketId) return response(400, { error: 'ticket is required' })
        const read = runtime.replySpends?.bind(runtime)
        if (!read) return response(200, { available: false, reason: '后端还没有接入逐条用量' })
        try {
          const value = await read(ticketId)
          return response(200, value === undefined ? { available: false, reason: '这张票没有可读的用量记录' } : { available: true, ...value })
        } catch (error) {
          return response(200, { available: false, reason: error instanceof Error ? error.message : '暂时读不出来' })
        }
      }
      if (operation === 'speak') {
        const speak = runtime.speak?.bind(runtime)
        if (!speak) return response(200, { available: false, reason: '这台后端没有接入播报' })
        const raw = await incoming.text()
        if (Buffer.byteLength(raw) > 64 * 1024) return response(413, { error: 'Request too large' })
        const asked = askedBody(raw)
        const text = typeof asked?.text === 'string' ? asked.text : ''
        if (!text.trim()) return response(400, { error: 'text is required' })
        const outcome = await speak(text)
        if (outcome.status !== 'ok') {
          return response(200, { available: false, status: outcome.status, reason: outcome.reason })
        }
        // 二进制回包：`audio/wav`。手机直接写进播放器。
        // 长度与「有没有截断」放进响应头：手机不必解析 WAV 头就能显示这两件事。
        return new Response(new Blob([outcome.audio], { type: 'audio/wav' }), {
          status: 200,
          headers: {
            'cache-control': 'no-store',
            'content-type': 'audio/wav',
            'x-speech-seconds': outcome.seconds.toFixed(2),
            'x-speech-truncated': outcome.truncated ? '1' : '0',
          },
        })
      }
      if (operation === 'voice') {
        // 语音输入：body 就是录音本身（不是 JSON、不是 base64 —— 多一层编码就多一次出错的机会）。
        const transcribeVoice = runtime.transcribe?.bind(runtime)
        if (!transcribeVoice) return response(200, { available: false, reason: '后端还没有接入语音识别' })
        const raw = await incoming.arrayBuffer()
        try {
          return response(200, await transcribeVoice(new Uint8Array(raw), incoming.signal))
        } catch (error) {
          return response(200, { available: false, reason: error instanceof Error ? error.message : '识别没成功' })
        }
      }
      if (operation === 'spend' || operation === 'audit') {
        // 两张账都按票读。没有票号或宿主没接这项能力时如实说读不到，不回一个像样的假数。
        const ticketId = url.searchParams.get('ticket')?.trim() ?? ''
        if (!ticketId) return response(400, { error: 'ticket is required' })
        const read = operation === 'spend' ? runtime.spend?.bind(runtime) : runtime.audit?.bind(runtime)
        if (!read) return response(200, { available: false, reason: '后端还没有接入这一项' })
        try {
          const value = await (read as (id: string) => Promise<unknown>)(ticketId)
          return response(200, value === undefined ? { available: false, reason: '这张票没有可读的记录' } : { available: true, [operation]: value })
        } catch (error) {
          return response(200, { available: false, reason: error instanceof Error ? error.message : '暂时读不出来' })
        }
      }
      if (operation === 'memory') {
        // 记忆账本：GET 读一栏，POST 改一条（`action`: forget / edit）。
        const name = url.searchParams.get('bot')?.trim()
        if (incoming.method === 'GET') {
          const readMemory = runtime.memories?.bind(runtime)
          if (!readMemory) return response(200, { items: [], state: 'unavailable', counts: { active: 0, forgotten: 0, superseded: 0 },
            reason: '后端还没有接入记忆' })
          try { return response(200, await readMemory(name ? { bot: name } : {})) }
          catch { return response(200, { items: [], state: 'unavailable', counts: { active: 0, forgotten: 0, superseded: 0 }, reason: '记忆账本暂时读不出来' }) }
        }
        const raw = await incoming.text()
        if (Buffer.byteLength(raw) > 32 * 1024) return response(413, { error: 'Request too large' })
        let value: { action?: unknown; name?: unknown; description?: unknown; body?: unknown; importance?: unknown }
        try { value = JSON.parse(raw) } catch { return response(400, { error: 'Invalid JSON' }) }
        const target = typeof value?.name === 'string' ? value.name.trim() : ''
        if (!target) return response(400, { error: 'name is required' })
        // 只认记忆账本那个前缀下的名字：这是主人改账本，不是任意改 KV。
        if (!target.startsWith('bot-')) return response(400, { error: 'No such memory' })
        if (value.action === 'forget') {
          const forget = runtime.forgetMemory?.bind(runtime)
          if (!forget) return response(200, { ok: false, reason: '后端还没有接入记忆' })
          return response(200, { ok: forget(target), name: target })
        }
        if (value.action === 'edit') {
          const edit = runtime.editMemory?.bind(runtime)
          if (!edit) return response(200, { ok: false, reason: '后端还没有接入记忆' })
          const patch: { description?: string; body?: string; importance?: number } = {}
          if (typeof value.description === 'string') patch.description = value.description
          if (typeof value.body === 'string') patch.body = value.body
          if (typeof value.importance === 'number') patch.importance = value.importance
          try { return response(200, { ok: edit(target, patch), name: target }) }
          catch (error) { return response(400, { error: error instanceof Error ? error.message : 'Invalid memory' }) }
        }
        return response(400, { error: 'action must be forget or edit' })
      }
      if (operation === 'outputs') {
        // 「产出」：worker 真正写过的文件。宿主没接这项能力时如实说「读不到」，
        // 不说「没有产出」—— 那是在替队伍编一句话。
        // runtime.outputs 是实例方法，脱离 this 调会读不到 store，所以先 bind 再调。
        if (!runtime.outputs) {
          return response(200, { items: [], state: 'unavailable', counts: { file: 0, image: 0 }, reason: '后端还没有接入产出' })
        }
        const readOutputs = runtime.outputs.bind(runtime)
        const wanted = ticketId ? [ticketId] : []
        if (ticketId && !runtime.store.tickets.get(ticketId)) return response(404, { error: 'No such ticket' })
        // 不带票号时列最近的几张：产出是「交出来的东西」，不是全部历史。手机与队伍两条通道的票都算。
        const tickets = (wanted.length > 0 ? wanted.flatMap(id => runtime.store.tickets.get(id) ?? []) : runtime.store.tickets.list())
          .filter(ticket => ticket.channels.some(channel => channel.source === 'mobile' || channel.source === 'team'))
          .slice(0, 12)
        // 票存在、但它不走手机/队伍这两条通道：这不是「队伍还没有工单」，如实说它不在产出通道里。
        if (ticketId && tickets.length === 0) {
          return response(200, { items: [], state: 'empty', counts: { file: 0, image: 0 }, ticket_id: ticketId,
            reason: '这张票不在产出通道里（只有手机与队伍工单有产出）' })
        }
        try {
          const view = await readOutputs(tickets.map(ticket => {
            const botId = ticketBot(ticket)
            return { id: ticket.id, title: ticket.title,
              ...(botId ? { bot_id: botId } : {}),
              ...(ticket.execution?.directory ? { cwd: ticket.execution.directory } : {}) }
          }))
          return response(200, ticketId ? { ...view, ticket_id: ticketId } : view)
        } catch {
          return response(200, { items: [], state: 'unavailable', counts: { file: 0, image: 0 },
            ...(ticketId ? { ticket_id: ticketId } : {}), reason: '产出暂时读不出来' })
        }
      }
      if (operation === 'steer') {
        if (!runtime.steer) return response(503, { error: 'Steering is unavailable' })
        const asked = askedBody(body)
        if (!asked) return response(400, { error: 'Invalid JSON' })
        const id = typeof asked.ticket === 'string' ? asked.ticket : ''
        const requestId = typeof asked.request_id === 'string' ? asked.request_id : ''
        if (!id) return response(400, { error: 'ticket is required' })
        if (!requestId || requestId.length > 128) return response(400, { error: 'request_id is required' })
        const ticket = runtime.store.tickets.get(id)
        if (!ticket || ticket.ended) return response(409, { error: 'Ticket is not running' })
        const token = (await readFile(join(runtime.machine.stateDir, 'mobilegw.token'), 'utf8')).trim()
        if (!token) return response(503, { error: 'Mobile transport is not configured' })
        const authored = typeof asked.text === 'string' ? asked.text.trim() : ''
        let text = ''
        if (authored) {
          // 发送即插队：消息以「已读」写进网关，路由不会再把它当新活接一遍。
          const sent = await request(`${gateway}/send`, { method: 'POST',
            headers: { 'X-GW-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: authored, request_id: requestId, mentions: [], steer: true }),
            signal: AbortSignal.any([incoming.signal, AbortSignal.timeout(10_000)]), redirect: 'error' })
          if (!sent.ok) return response(sent.status === 401 ? 503 : sent.status, { error: 'Mobile request was rejected' })
          text = authored
        } else {
          // 对已经在队列里的消息：先认领（标记读走）。成功才说明它还没被路由读过，不会送两遍。
          const claimed = await request(`${gateway}/claim`, { method: 'POST',
            headers: { 'X-GW-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ request_id: requestId }),
            signal: AbortSignal.any([incoming.signal, AbortSignal.timeout(10_000)]), redirect: 'error' })
          if (!claimed.ok) {
            if (claimed.status === 404 || claimed.status === 409) {
              const refused = await claimed.json().catch(() => undefined) as { error?: unknown } | undefined
              return response(claimed.status, { error: typeof refused?.error === 'string' ? refused.error : 'Steer refused' })
            }
            return response(claimed.status === 401 ? 503 : claimed.status, { error: 'Mobile request was rejected' })
          }
          const message = await claimed.json() as { text?: unknown }
          text = typeof message.text === 'string' ? message.text : ''
        }
        if (!text) return response(409, { error: 'no such message' })
        if (!await runtime.steer(id, requestId, text)) return response(409, { error: 'Ticket is not running' })
        return response(200, { ok: true, ticket: id, request_id: requestId })
      }
      if (operation === 'efforts') {
        if (!runtime.efforts) return response(503, { error: 'Model details are unavailable' })
        const provider = url.searchParams.get('provider') ?? ''
        const model = url.searchParams.get('model') ?? ''
        if (!provider || !model) return response(400, { error: 'provider and model are required' })
        try { return response(200, await runtime.efforts(provider, model)) }
        catch (error) { return response(400, { error: error instanceof Error ? error.message : 'Model is unavailable' }) }
      }
      if (operation === 'screen') {
        // 画面源是会话活动快照（命令/输出/回话），不是像素截帧：worker 不跑浏览器，但它在终端里
        // 做了什么，手机上应该看得见。宿主没接这项能力时如实说「没有」，不给一个永远转圈的画面。
        if (!runtime.screen) return response(200, { state: 'unavailable', reason: '后端还没有接入画面源' })
        try { return response(200, await runtime.screen(ticketId)) }
        catch { return response(200, { state: 'unavailable', ticket_id: ticketId, reason: '这张工单的会话暂时读不出来' }) }
      }
      if (operation === 'takeover') {
        const asked = askedBody(body)
        if (!asked) return response(400, { error: 'Invalid JSON' })
        const id = typeof asked.ticket === 'string' ? asked.ticket : ''
        if (!id) return response(400, { error: 'ticket is required' })
        if (!runtime.store.tickets.get(id)) return response(404, { error: 'No such ticket' })
        if (!runtime.engine) return response(503, { error: 'Ticket control is unavailable' })
        try { runtime.engine.stopTicket(id) } catch { return response(409, { error: 'Ticket cannot be stopped' }) }
        return response(200, { ok: true, stopped: true })
      }
      if (operation === 'pause') {
        const asked = askedBody(body)
        if (!asked) return response(400, { error: 'Invalid JSON' })
        const id = typeof asked.ticket === 'string' ? asked.ticket : ''
        // 给出了票号就得对得上：一张不存在的票不该让整台执行器停下来。
        if (id && !runtime.store.tickets.get(id)) return response(404, { error: 'No such ticket' })
        if (!runtime.settings) return response(503, { error: 'Pause control is unavailable' })
        await runtime.settings.pause(true, 'panel')
        // 目前只有执行器这一种暂停。如实写 scope，别让手机以为只停了这一张票。
        return response(200, { ok: true, scope: 'executor' })
      }
      if (operation === 'resume') {
        if (!askedBody(body || '{}')) return response(400, { error: 'Invalid JSON' })
        if (!runtime.settings?.pause) return response(503, { error: 'Resume control is unavailable' })
        try { await runtime.settings.pause(false, 'panel') }
        catch { return response(500, { error: 'Resume control failed' }) }
        return response(200, { ok: true, resumed: true, scope: 'executor' })
      }
      if (operation === 'read') {
        // 「未读回话」原来没有，是因为后端从来收不到「主人看过哪条回话」这个输入
        // （契约 §5.6：网关只有人 → 队伍的 messages.read_at，反方向没有回执）。
        // 这条路由只补那一个输入：客户端报上它读到的最后一条回话 id，后端记一条会话级水位。
        // 不逐条改 replies 表、不发明阅读回执；数由 GET /timeline 按这份水位算（unreadRepliesOf）。
        const asked = askedBody(body)
        if (!asked) return response(400, { error: 'Invalid JSON' })
        const lastReadId = typeof asked.last_read_id === 'string' ? asked.last_read_id.trim() : ''
        if (!lastReadId || lastReadId.length > 128) return response(400, { error: 'last_read_id is required' })
        if (typeof runtime.store.set !== 'function') return response(503, { error: 'Read cursor is unavailable' })
        runtime.store.set(READ_CURSOR, lastReadId)
        return response(200, { ok: true, last_read_id: lastReadId })
      }
      if (operation === 'bots') {
        const settings = runtime.store.settings()
        const config = (settings.sources?.team?.config ?? {}) as Record<string, unknown>
        const bots = Array.isArray(config.bots) ? config.bots as Record<string, unknown>[] : []
        if (incoming.method === 'GET') return response(200, { bots: teamBotRows(bots) })
        // `action` 是这条请求要做的事。DSH 的 Connection 只放行 GET/POST，所以编辑与删除
        // 走 POST + action，而不是 PUT/DELETE —— 否则手机上根本没有这条路。
        const askedFor = askedBody(body)
        const action = typeof askedFor?.action === 'string' ? askedFor.action : ''
        // 撤一位。人走了，他的配置就该走；记忆留在磁盘上不动（那是历史，不是配置）。
        if (action === 'remove') {
          const asked = askedBody(body)
          const botId = typeof asked?.bot_id === 'string' ? asked.bot_id.trim() : ''
          if (!botId) return response(400, { error: 'bot_id is required' })
          const gone = bots.find(bot => bot.bot_id === botId)
          if (!gone) return response(404, { error: 'No such bot' })
          const next = bots.filter(bot => bot.bot_id !== botId)
          // 目录要求恰好一个 default：撤掉的若是它，下一位顶上；撤空了就没有 default。
          const wasDefault = gone.role === 'default' || config.default_bot_id === botId
          const promoted = wasDefault && next.length > 0 ? { ...next[0], role: 'default' } : undefined
          const finalBots: Record<string, unknown>[] = promoted ? [promoted, ...next.slice(1)] : next
          const defaultId = finalBots.find(bot => bot.role === 'default')?.bot_id as string | undefined
          return saveTeamBots(runtime, settings, { ...config, bots: finalBots,
            ...(defaultId ? { default_bot_id: defaultId } : { default_bot_id: '' }) })
        }
        const asked = askedBody(body)
        if (!asked) return response(400, { error: 'Invalid JSON' })
        const botId = typeof asked.bot_id === 'string' ? asked.bot_id.trim() : ''
        if (!BOT_ID.test(botId)) return response(400, { error: 'Invalid bot id' })
        const name = typeof asked.name === 'string' ? asked.name.trim() : ''
        if (!name) return response(400, { error: 'name is required' })
        if (name.length > 100) return response(400, { error: 'name is too long' })
        const persona = typeof asked.persona === 'string' ? asked.persona.trim() : ''
        if (persona.length > 2000) return response(400, { error: 'persona is too long' })
        const existing = bots.find(bot => bot.bot_id === botId)
        // 改这位的人设 / 名字。bot_id 不改 —— 记忆命名空间挂在它上面，改了等于换人。
        if (action === 'edit') {
          if (!existing) return response(404, { error: 'No such bot' })
          const next = bots.map(bot => bot.bot_id === botId
            ? { ...bot, name, ...(persona ? { persona } : { persona: '' }) } : bot)
          return saveTeamBots(runtime, settings, { ...config, bots: next })
        }
        if (existing) return response(400, { error: 'Bot already exists' })
        const askedRole = asked.role === 'default' ? 'default' : 'member'
        const hasDefault = bots.some(bot => bot.role === 'default')
        if (askedRole === 'default' && hasDefault) {
          return response(400, { error: 'The crew already has a default bot' })
        }
        // 目录要求恰好一个 default。队里没有就由这一位顶上：空队的第一位，或者配置已经坏了
        // （有 Bot 没 default）时，加一位就能自愈 —— 只看「是不是空队」会留下永远读不回来的配置。
        const role = hasDefault ? askedRole : 'default'
        const next = [...bots, { bot_id: botId, name, role, ...(persona ? { persona } : {}), memory_namespace: `bot/${botId}` }]
        const defaultId = typeof config.default_bot_id === 'string' && config.default_bot_id ? config.default_bot_id : botId
        return saveTeamBots(runtime, settings, { ...config, bots: next, default_bot_id: role === 'default' ? botId : defaultId })
      }
      if (operation === 'models') {
        // 只给能真跑的那些：把 `models` 原样交出去，界面就得自己去分辨哪一组根本连不上。
        const catalog = await runtime.models()
        const settings = runtime.store.settings()
        const current = settings.executor.model
        return response(200, {
          ...current ? { current } : {},
          // 每位成员的模型：界面上要能显示「这一位现在用的是什么」。
          bot_models: settings.executor.botModels ?? {},
          providers: catalog.groups.map(group => ({ id: group.id, name: group.name,
            models: group.models.map(model => ({ id: model.id, name: model.name,
              ...typeof model.description === 'string' && model.description ? { description: model.description } : {} })) })),
          // 读不出来的 provider 也交回去：人得知道「这家挂了」，而不是以为它本来就没有模型。
          failures: catalog.failures.map(failure => ({ id: failure.id, name: failure.name })),
        })
      }
      if (operation === 'pair') {
        const devices = (runtime as unknown as { remote?: DeviceStore }).remote
        if (!devices) return response(503, { error: 'Pairing is unavailable' })
        const asked = askedBody(body)
        if (!asked) return response(400, { error: 'Invalid JSON' })
        const { code, deviceId, name, platform } = asked
        if (typeof code !== 'string' || typeof deviceId !== 'string' || !code || !deviceId) {
          return response(400, { error: 'code and deviceId are required' })
        }
        const credential = devices.redeem({ code, deviceId,
          name: typeof name === 'string' && name ? name : deviceId,
          platform: typeof platform === 'string' ? platform : 'unknown' })
        // 码错和设备不对在这里看起来一样：说清楚是哪一个只对尝试者有好处。
        return credential ? response(200, credential) : response(403, { error: 'Pairing refused' })
      }
      if (operation === 'model') {
        if (!body) return response(400, { error: 'model is required' })
        const asked = JSON.parse(body) as { provider?: string; model: string; reasoningEffort?: string; bot_id?: string }
        // A provider has to be named for a real switch: a model name alone does not say where to reach it.
        // 只清成员路由（model 为空）不需要 provider。
        if (!(asked.bot_id && !asked.model.trim()) && (typeof asked.provider !== 'string' || !asked.provider.trim())) {
          return response(400, { error: 'provider is required' })
        }
        // 指定成员时必须是花名册里存在的 bot_id；拼错的 id 会静默变成一条没人用的配置。
        if (asked.bot_id !== undefined) {
          const config = (runtime.store.settings().sources?.team?.config ?? {}) as { bots?: { bot_id?: string }[] }
          const bots = Array.isArray(config.bots) ? config.bots : []
          if (typeof asked.bot_id !== 'string' || !BOT_ID.test(asked.bot_id) || !bots.some(bot => bot.bot_id === asked.bot_id)) {
            return response(400, { error: 'Unknown bot_id' })
          }
        }
        const current = runtime.store.settings()
        const next = asked.bot_id && !asked.model.trim()
          // 清掉这位成员的单独路由，回到全场默认。
          ? { ...current, executor: { ...current.executor,
            botModels: Object.fromEntries(Object.entries(current.executor.botModels ?? {}).filter(([id]) => id !== asked.bot_id)) } }
          : switchModel(current, { provider: asked.provider ?? '', model: asked.model, reasoningEffort: asked.reasoningEffort, ...(asked.bot_id ? { bot_id: asked.bot_id } : {}) })
        // 走 Settings.save，而不是直接写 store：它会先 resolveRoleModel 验一遍这条路由。
        // 直接落盘的话，一个不存在的 provider/model 会被每个新工单在 initializeRoleModel 里
        // 撞到，launch 全部记 failed，直到面板改回来。
        if (!runtime.settings?.save) return response(503, { error: 'Model switching is unavailable' })
        try {
          await runtime.settings.save('executor', next.executor, runtime.store.blockRevision('executor'), 'panel')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // SettingsConflict 是空 extends Error，它的 name 仍是 'Error'，只能按类型判。
          return response(error instanceof SettingsConflict ? 409 : 400, { error: message || 'Model unavailable' })
        }
        return response(200, { ok: true, ...(asked.bot_id ? { bot_id: asked.bot_id, model: next.executor.botModels[asked.bot_id] } : { model: next.executor.model }) })
      }
      if (operation === 'work') return response(200, workOf(runtime.store.tickets.get(ticketId)) ?? response(404, { error: 'No such ticket' }))
      const agents = (runtime as unknown as { agents?: Parameters<typeof agentTree>[0] }).agents
      if (!agents) return response(503, { error: 'Session tree is unavailable' })
      // `ctx.agents` answers by id only, so the ids that may be subagents come from the sessions the store recorded.
      // `keys` takes the family itself, not a prefix string; the id is what follows the family's prefix.
      const known = runtime.store.keys?.(KV.sessions.prompts)?.map(name => name.slice(KV.sessions.prompts.prefix.length)) ?? []
      return response(200, { ticket_id: ticketId, agents: agentTree(agents, ticketId, 8, known) })
    }
    try {
      await runtime.ready
      const token = (await readFile(join(runtime.machine.stateDir, 'mobilegw.token'), 'utf8')).trim()
      if (!token) return response(503, { error: 'Mobile transport is not configured' })
      const target = ticketId ? `${gateway}/${operation}?ticket=${encodeURIComponent(ticketId)}` : `${gateway}/${operation}`
      const upstream = await request(target, {
        method: incoming.method, headers: { 'X-GW-Token': token, 'Content-Type': 'application/json' },
        ...(body ? { body } : {}), signal: AbortSignal.any([incoming.signal, AbortSignal.timeout(10_000)]), redirect: 'error',
      })
      if (!upstream.ok) {
        // 撤回失败要让人知道是「已回复」「已交给 worker」还是「没这条」：网关的这几条错误都是固定文案，
        // 原样带回状态码和文案；其余上游错误仍然只回笼统的一句话，避免泄露内部信息。
        if (operation === 'withdraw' && (upstream.status === 404 || upstream.status === 409)) {
          const refused = await upstream.json().catch(() => undefined) as { error?: unknown } | undefined
          return response(upstream.status, { error: typeof refused?.error === 'string' ? refused.error : 'Withdraw refused' })
        }
        // Credentials and internal paths never appear in upstream error responses.
        return response(upstream.status === 401 ? 503 : upstream.status,
          { error: upstream.status === 401 ? 'Mobile transport credential mismatch' : 'Mobile request was rejected' })
      }
      const data = await upstream.json() as Record<string, unknown>
      if (operation === 'timeline') {
        const settings = runtime.store.settings()
        const decisions = runtime.store.read?.recentDecisions?.(0, 200) ?? []
        const gatewayItems = Array.isArray(data.items) ? data.items as TimelineItem[] : []
        // 代码卡上「看看改完的样子」要知道看哪张票：网关只记「回哪条消息」，
        // 工单号在这一侧对齐一次再下发。对不上就让它缺着，客户端会如实说。
        const items = withTicketRefs(gatewayItems, ticketRefs(gatewayItems, decisions))
        // The crew Source answers on the same queue as mobile, so its tickets belong on the phone too.
        const tickets = runtime.store.tickets.list().filter(ticket => ticket.channels.some(channel => channel.source === 'mobile' || channel.source === 'team')).slice(0, 30)
        // The phone names a Bot on send; the roster tells it who exists and who answers by default.
        const roster = crewRoster(runtime.store.settings(), bot => earliestTicketAt(data, bot))
        return response(200, { ...data, ...roster,
          // 消息面原样带回，只把代码卡缺的票号补齐（见 ticketRefs）：其余字段一格不改。
          items,
          tasks: tickets.map(ticket => {
          // One early ticket whose shape the stage machine cannot read must not take the whole conversation down
          // with it: it still belongs on the phone, it just cannot say which stage it is in.
          let stage: { stage?: string; action?: string } = {}
          try { stage = ticketStage(ticket) } catch { stage = {} }
          // 同一张读不懂的票也不该把整个时间线（以及对话）带下去。
          let retryable = false
          try { retryable = canRetry(ticket) } catch { retryable = false }
          const botId = ticketBot(ticket)
          // 只在下发「等你答一个问题」时带上那句问题与它的备选答案：delivery / review / blocked / failed
          // 也是等人，但等的不是一个能二选一的问题，编一组选项出来就是假按钮。
          const asking = stage.stage === 'person' && stage.action === 'answer' && ticket.attention
          // 计划的计数：worker 自己写的待办清单里有几步、走完几步（见 work.ts 的 planOf）。
          // 没有待办清单就没有分母 —— 这两个字段整个不出现，客户端据此不画进度条，
          // 而不是拿已发生的条数当分母画一根永远 100% 的假条。
          const plan = ticket.plan && ticket.plan.total > 0
            ? { total_steps: ticket.plan.total, steps_done: Math.min(ticket.plan.done, ticket.plan.total) }
            : {}
          return { id: ticket.id, title: ticket.title,
            // `state` 是给人看的词（终态用 outcome，进行中用 stage）；放哪个页签、能不能重试
            // 由下面两个布尔决定，客户端不再自己解释词表。
            state: ticket.ended?.outcome ?? stage.stage ?? 'unknown', worker_session_id: workerSessionId(ticket.id),
            ...(botId ? { bot_id: botId } : {}),
            open: !ticket.ended,
            retryable,
            // Lets the phone place a task in the conversation by time and say whether it waits for the owner.
            created_at: ticket.createdAt, updated_at: ticket.updatedAt,
            ...plan,
            ...(stage.stage === 'person' && stage.action ? { needs_person: stage.action } : {}),
            // 问题和选项成对下发，见 docs/00-contract §5：没有 options 就是只有一个自写框。
            ...(asking ? { question: ticket.attention!.question,
              ...ticket.attention!.options?.length ? { options: ticket.attention!.options } : {} } : {}) }
        }),
        // A message the crew has not answered yet is still queued: it was accepted, but no reply hangs off it.
        // Withdrawing it means the crew has not read it, which is what the phone needs to offer.
        queued: queuedRequests(Array.isArray(data.items) ? data.items as TimelineItem[] : []),
        // 「未读」：人发出去、队伍还没读走的有几条（契约 §5.6）。和 `queued` 读的是同一份时间线，
        // 但判据不同：`queued` 是「还没回复、还能撤回」，未读是「还没被读走」。一条消息可以先被读走
        // 再慢慢回，那时它已经不算未读了。
        unread: unreadOf(items),
        // 「未读回话」：队伍回了、主人还没看的有几条（契约 §5.6 新增的一格）。
        // 和 `unread` 方向相反、判据不同，两个数谁也不冒充谁；没报过水位就是 unknown，不是 0。
        unread_replies: unreadRepliesOf(items, replyReadCursor(runtime.store)),
        // The messages read and left on purpose. Without these the phone cannot tell a thought in progress from
        // one that will never be answered.
        // Older hosts predate this read; a missing history leaves the list empty rather than failing the timeline.
        declined: declinedRequests(Array.isArray(data.items) ? data.items as TimelineItem[] : [],
          decisions),
        // 手机消息由已安装的那个 Source 承载：独立部署是 `mobile`，Bot 队伍里是 `team`。
        // 两个都不在时如实说 missing；兜底写 starting 会让人以为服务一直没起来。
        status: { runtime: runtime.health.runtime?.state ?? 'starting',
          mobile: (runtime.health.mobile ?? runtime.health.team)?.state ?? 'missing', paused: settings.paused } })
      }
      // `work` and `agents` are the gateway's own JSON; hand it back untouched so a new field it adds
      // reaches the phone without a change here.
      return response(200, data)
    } catch {
      return response(502, { error: 'Mobile transport is temporarily unavailable; retry with the same request_id' })
    }
  }
}

/** How long a sent message may still be withdrawn. Past this the crew has picked it up and withdrawing it lies. */
export const QUEUE_WINDOW_MS = 90_000

/** The parts of a gateway timeline entry this module reads. */
export interface TimelineItem { id?: string; role?: string; request_id?: string; reply_to?: string; text?: string; at?: string; bot_id?: string
  /**
   * 队伍读走这条消息的时刻；空串是「还没读走」，**字段缺席是「这份时间线说不清」**。
   * 只有人的消息带它（网关 `messages.read_at`），回话没有这个字段 —— 队伍没有「读没读自己的话」这回事。
   */
  read_at?: string
  /** 被撤回的消息本就不上时间线；万一上游给了，也不算未读。 */
  withdrawn?: boolean
  /** 这条回话带的改动代码（契约 §5「代码卡」）；字段名 `code` 与 `diff` 同形，两个都认。 */
  code?: unknown; diff?: unknown
  /** 这段改动属于哪张工单；只读引用，前台不得据此维护任务账。 */
  ticket_ref?: string }

/** 「未读」的两种说法。`unknown` 是「网关没报告读走状态」，与「确实是 0 条」不是一件事。 */
export interface UnreadView {
  /** 条数；`state` 是 `unknown` 时是 null。客户端只认这个数，不自己拿消息列表数。 */
  count: number | null
  state: 'live' | 'unknown'
  /** `state` 不是 live 时说清为什么，一句给人看的中文。 */
  reason?: string
}

/**
 * 人发出去、队伍还没读走的有几条（契约 §5.6）。
 *
 * 唯一来源是网关队列已有的 `messages.read_at`：`pull` 与插队的 `claim` 都会写它。
 * 不新开表、不另存一份状态。三条规矩，都是宁可空着也不造假：
 * - 一条人的消息缺 `read_at` 字段，整份算 `unknown`。能判的和判不了的不混在一起数。
 * - 只数 `role === 'user'`：Bot 的回话有没有被主人看过，后端根本没有这份回执，
 *   拿它当「未读」就是在编。这个缺口写在契约 §5.6 里，不在这里补一个假数。
 * - 被撤回的不算：它没到过队伍手上。
 */
export function unreadOf(items: readonly TimelineItem[]): UnreadView {
  const people = items.filter(item => item.role === 'user' && !item.withdrawn)
  if (people.some(item => typeof item.read_at !== 'string')) {
    return { count: null, state: 'unknown', reason: '这条消息通道还没报告哪些话被读走了，算不出未读' }
  }
  return { count: people.filter(item => !item.read_at).length, state: 'live' }
}

/**
 * 队伍回了、主人还没看的有几条（契约 §5.6 的第二个数）。
 *
 * 和 `unreadOf` 是方向相反的两件事：那边数「人发出去、队伍还没读走」，靠网关 `messages.read_at`；
 * 这边数「队伍回话、主人还没看到」，唯一的输入是客户端通过 `POST /api/mobile/read` 报上来的
 * 已读水位 `last_read_id`。沿用 `UnreadView` 的三态口径，三条规矩都与 `unreadOf` 对齐：
 * - 没报过水位、或水位那条在这份时间线里找不到 → `unknown`，`count` 是 null。
 *   算不出来就别画徽标，绝不把「不知道」写成 0 条。
 * - 只数 `role === 'agent'` 的回话；人的消息和撤回都不算。
 * - 按时间线给的顺序判，不按 `at` 比时间：两端照同一份顺序，才不会因时钟差一秒画出不同的数。
 *   水位本身是读到的那条回话，所以它之后新来的回话才是「还没看」的。
 */
export function unreadRepliesOf(items: readonly TimelineItem[], lastReadId: string | undefined): UnreadView {
  if (!lastReadId) {
    return { count: null, state: 'unknown', reason: '还没有报过读到哪一条回话，算不出未读回话' }
  }
  const anchor = items.findIndex(item => item.id === lastReadId)
  if (anchor < 0) {
    return { count: null, state: 'unknown', reason: '报上来的那条回话不在这份时间线里，算不出未读回话' }
  }
  return { count: items.slice(anchor + 1).filter(item => item.role === 'agent').length, state: 'live' }
}

/**
 * The request ids the crew has not answered yet. A reply hangs under the message it answers, so a sent message with
 * no reply on it is the one still queued. Unreadable entries are skipped rather than failing the whole timeline.
 */
export function queuedRequests(items: TimelineItem[], now = Date.now(), windowMs = QUEUE_WINDOW_MS): string[] {
  // A reply names the message it answers, so the answered set holds the ids replies hang UNDER, not the reply ids.
  const answered = new Set(items.filter(item => item.role === 'agent').map(item => item.reply_to).filter(Boolean))
  return items
    .filter(item => item.role === 'user' && typeof item.request_id === 'string' && item.request_id && !answered.has(item.id))
    // A message the crew is already working on has no reply yet either, so age is what tells the two apart.
    // Past the window the crew has plainly picked it up; offering a withdraw there would be a button that does nothing.
    .filter(item => {
      const at = Date.parse(item.at ?? '')
      return Number.isNaN(at) || now - at <= windowMs
    })
    .map(item => item.request_id as string)
}

export function registerMobileHttp(ctx: Context, runtime: PhoneHost): void {
  // Connection's Fetch dispatcher checks Host/Origin, signed credentials and owner
  // principal for BOTH direct and relay carriers, before calling these handlers.
  ctx.inject(['connection'], child => {
    const connection = child.get('connection') as { fetch?: FetchRegistry } | undefined
    if (!connection?.fetch) { child.logger.warn('Mobile API requires DSH Connection Fetch support'); return }
    const handler = phoneHandler(runtime)
    const disposers = [
      connection.fetch.register({ path: '/api/mobile/timeline', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/send', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      // 撤回还没被读走/回复的消息；能不能撤由网关判定，冲突原样回 409。
      connection.fetch.register({ path: '/api/mobile/withdraw', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      // 回话已读水位：客户端读到哪一条，后端记下来，timeline 才能给出「未读回话」这一格。
      connection.fetch.register({ path: '/api/mobile/read', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/work', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/agents', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/models', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/efforts', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/model', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/pair', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      // 手机工作区：会话活动快照、接手、暂停与继续执行。
      connection.fetch.register({ path: '/api/mobile/screen', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      // 产出：队伍交出来的文件（worker 写过的那些）。和 screen 一样是宿主侧纯读，不经过网关。
      connection.fetch.register({ path: '/api/mobile/outputs', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      // 常规任务：主人写下的定时账本（契约 §5.5）。这一轮只读，不能在这里改账。
      connection.fetch.register({ path: '/api/mobile/routines', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handler }),
      // 记忆：主人的长期账本。GET 读一栏，POST 改一条（forget / edit）。
      connection.fetch.register({ path: '/api/mobile/memory', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handler }),
      // 成本与审计：一张票花了多少、这条链谁派的谁判的谁干的。只读。
      connection.fetch.register({ path: '/api/mobile/spend', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/audit', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      // 语音输入：body 是原始 WAV。识别失败时说清是哪一种失败。
      connection.fetch.register({ path: '/api/mobile/voice', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      // 逐条用量：这张票每一步用的谁、多少、上下文还剩多少。
      connection.fetch.register({ path: '/api/mobile/reply-spend', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      // 播报：念一句话，回 WAV。
      connection.fetch.register({ path: '/api/mobile/speak', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/takeover', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/retry', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/steer', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/pause', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/resume', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      // 花名册：GET 读，POST 加一位。
      connection.fetch.register({ path: '/api/mobile/bots', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handler }),
    ]
    child.effect(() => async () => { await Promise.all(disposers.map(dispose => dispose())) })
  })
}
