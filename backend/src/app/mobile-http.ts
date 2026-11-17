/** Phone endpoints on DSH's authenticated Fetch carrier; queue admission remains owned by the mobile Source. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HttpHost } from './http.ts'
import { canRetry, latestAssignment, liveTicket, ticketStage, type Ticket } from '../core/index.ts'
import { SettingsConflict } from './settings.ts'
import { attentionForDisplay, legacyConnectionCard } from './approval.ts'
import type { Settings } from '../policy.ts'
import type { Decision } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { KV } from '../kv.ts'
import type { NoticeDelivery } from './push.ts'
import { agentTree, switchModel, workOf } from './work.ts'
import type { ScreenSnapshot } from './screen.ts'
import type { OutputsTicket, OutputsView } from './outputs.ts'
import type { RoutinesView } from './routines.ts'
import type { MemoryView } from './views/memory.ts'
import type { AuditRow } from './audit.ts'
import type { Spend } from './spend.ts'
import type { Transcript } from './voice.ts'
import type { Quota, QuotaSourceReading, ReplySpend } from './quota.ts'
import type { SpeakOutcome } from './speech.ts'
import type { MemoryLayer } from './memory-layer.ts'
import type { DeviceStore } from './remote.ts'
import { BOT_ID } from '../crew/directory.ts'
import { groupsOf, type GroupsView } from './groups.ts'
import { MAX_BODY_BYTES, parseBatch, type Diagnostics } from './diagnostics.ts'
import { crewFingerprint } from './discovery.ts'
import { publicEntry } from './public-entry.ts'
import type { Activity } from './activity.ts'
import { wireActivity } from './activity.ts'

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
  /**
   * 逐条用量：每一步用的哪个模型、花了多少、上下文还剩多少。
   *
   * `real` 是**真实额度源**（provider 的订阅窗口与余额），`real_line` 是它的一句话。
   * 两个额度分开报：`quota` 是上下文余量，`real` 是 provider 那边的账 —— 混成一个字段
   * 会让人拿「上下文还剩多少」当「这个月还能花多少」。
   */
  replySpends?: (ticketId: string) => Promise<{ replies: ReplySpend[]; quota: Quota; warning?: string; real?: QuotaSourceReading;
    real_line?: string } | undefined>
  /** 播报：把一句话念成 WAV。宿主没有播报能力时如实说，不假装念了。 */
  speak?: (text: string) => Promise<SpeakOutcome>
  /** 语音：把一段 WAV 转成文字。宿主没有识别能力时如实回 `available: false`。 */
  transcribe?: (audio: Uint8Array, signal: AbortSignal) => Promise<Transcript>
  forgetMemory?: (name: string) => boolean
  editMemory?: (name: string, patch: { description?: string; body?: string; importance?: number; toHub?: boolean }) => boolean
  /** 插队：把排队中的话交给正在跑的 worker（下一步边界读）。 */
  steer?: (ticketId: string, requestId: string, text: string) => Promise<boolean>
  /**
   * 审批答复（手机这条通道用现有 source 消息完成连接写审批，不必造第二个审批 UI）：
   * 把对 `ticket.attention` 选项的回答（`做吧`/`先别做`）交给与 feishu `approvalReply` 同一套状态机。
   * `attentionId` 是客户端看到的那张问题卡 id：与当前 `ticket.attention.id` 不符（旧卡批新请求）→ 宿主回 409 零变更。
   * `actor` 是入口验过的设备 principal（不信 body），只用于审计。
   * 认不出、票不匹配、不在等审批都如实回 `{ ok: false, reason }`，绝不猜、绝不动。
   */
  answer?: (ticketId: string, text: string, attentionId: string, actor: string | undefined) =>
    // `reply` 是普通 worker 待答（human_action / human_options）的答复，与审批同一入口。
    // 旧客户端只读 `ok`，多一个取值不影响它。
    { ok: true; answer: 'go' | 'stop' | 'revise' | 'reply' } | { ok: false; reason: string }
  /** 一条模型路由支持哪些推理档位；不支持的宿主可以不给。 */
  efforts?: (provider: string, model: string) => Promise<{ efforts: { id: string; name: string; description?: string }[]; default?: string }>
  /** 工单控制：停下一张票，以及全局暂停。真实 Runtime 两个都有；测试里的假宿主可以只给需要的那个。 */
  engine?: Pick<HttpHost['engine'], 'stopTicket' | 'retryTicket'>
  settings?: Pick<HttpHost['settings'], 'pause' | 'save'>
  /**
   * 设备接收链（#23）：GET peek 这台设备还欠哪些（不删），POST ack 已持久化的 id（只删点名的那几条），
   * POST 的 seen_ids 另记账（device-persisted，非人眼读过）。宿主没接时如实说读不到。
   */
  pendingNotices?: (deviceId: string) => NoticeDelivery[]
  ackNotices?: (deviceId: string, ids: readonly string[]) => number
  noticeSeen?: (deviceId: string) => string[]
  markNoticeSeen?: (deviceId: string, ids: readonly string[]) => string[]
  /** App 故障上报的落盘盒（有界 KV）。宿主没接时手机那条 POST 回 503。 */
  diagnostics?: Diagnostics
  /**
   * 轻量活动：只读一张票 worker 会话的原生事件投影（Root 的 `Runtime.activity`）。
   * 宿主没接时 `/activity` 回 501（客户端据此记 capability=unsupported，退回慢速时间线）。
   */
  activity?: (ticketId: string) => Promise<Activity | undefined>
}
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
  'Session registry is unavailable': '这个后端记不下会话名单',
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
  reason?: readonly { code?: string; values?: Record<string, unknown> }[] }[], now = Date.now(), windowMs = QUEUE_WINDOW_MS,
  sessionId = DEFAULT_SESSION_ID): { request_id: string; reason: string }[] {
  // Only team/mobile decisions from this session can point to a mobile queue row. Keep a marker for the newest
  // decision even when it isn't a decline, so an older ignore cannot reappear later in the newest-first list.
  const latest = new Map<string, { reason?: string; at: number }>()
  for (const decision of decisions) {
    const row = requestDecisionRow(decision.threadKey, sessionId)
    if (!row) continue
    const at = Date.parse(decision.at ?? '')
    if (!Number.isFinite(at)) continue
    const seen = latest.get(row)
    if (seen && at <= seen.at) continue
    const decline = decision.kind === 'ignore' && !decision.reason?.some(entry => entry.code === 'answeredDirectly')
    const said = decline ? decision.reason?.find(entry => typeof entry.values?.text === 'string')?.values?.text : undefined
    latest.set(row, { at, ...(decline ? { reason: typeof said === 'string' && said ? said : '这条被判定不需要动手' } : {}) })
  }
  const answered = new Set(items.filter(item => item.role === 'agent' && isFinalReply(item))
    .map(item => item.reply_to).filter((id): id is string => typeof id === 'string'))
  return items.flatMap(item => {
    if (item.role !== 'user' || typeof item.request_id !== 'string' || !item.request_id
      || (typeof item.id === 'string' && answered.has(item.id))) return []
    const at = Date.parse(item.at ?? '')
    if (!Number.isFinite(at) || now - at > windowMs) return []
    const row = typeof item.id === 'string' ? /^m(\d+)$/.exec(item.id)?.[1] : undefined
    const found = row ? latest.get(row) : undefined
    if (!found?.reason || found.at < at) return []
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
 * 工单号在这一侧是现成的：当前 team/mobile session 的 Thread key 指向队列行号，`ticketId` 就是那张票。
 * 所以这里只做一次对齐，不做推断：来源或会话不匹配、行号对不上、决定是被忽略的、票号为空，一律不补。
 * 补不上就让它缺着 —— 客户端据此如实说「这段改动没带工单号」/ 不画结果条，而不是拿别的票顶替。
 */
export function ticketRefs(items: TimelineItem[], decisions: readonly { kind?: string; at?: string; threadKey?: string;
  ticketId?: string }[], sessionId = DEFAULT_SESSION_ID): Map<string, string> {
  const byRow = new Map<string, { ticket: string; at: number }>()
  for (const decision of decisions) {
    const row = requestDecisionRow(decision.threadKey, sessionId)
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
    // 空串/纯空白不是「已有值」——老网关会把它写成 ''，那时结果条该照常补上真票号。
    if (!found || (typeof item.ticket_ref === 'string' && item.ticket_ref.trim().length > 0)) continue
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
  bots: { id: string; name: string; role: string; persona?: string; since?: string; session_id?: string }[]
  default_bot_id: string
} {
  const config = settings.sources?.team?.config
  const bots = Array.isArray(config?.bots) ? config.bots : []
  const roster = bots.flatMap(bot => {
    const row = bot as { bot_id?: unknown; name?: unknown; role?: unknown; persona?: unknown; session_id?: unknown }
    if (typeof row.bot_id !== 'string' || !row.bot_id) return []
    // The persona is what the chip can explain on a long press; it is presentation text, never authority.
    const persona = typeof row.persona === 'string' ? row.persona.trim() : ''
    // 「认识多久」要说得出出处。这个值只从真实工单里最早的那一张取，
    // 取不到就整个字段不出现 —— 名片上宁可少一行，也不编一个日期。
    const known = since(row.bot_id)
    // 归属会话透传给群组投影（契约 §10）。只影响分组，不参与路由与授权。
    const home = typeof row.session_id === 'string' && row.session_id ? row.session_id : ''
    return [{ id: row.bot_id, name: typeof row.name === 'string' ? row.name : row.bot_id,
      role: typeof row.role === 'string' ? row.role : 'member', ...(persona ? { persona } : {}),
      ...(known ? { since: known } : {}), ...(home ? { session_id: home } : {}) }]
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
 * 给已配对 timeline 的**可选只读** server 元数据（不新增路由、不放开 auth、旧 App 忽略即兼容）。
 *
 * 身份口径是「**同实例指纹**」，不是 crypto 证明：`crew` 与 mDNS TXT 同源，复用 discovery 的
 * `crewFingerprint(stateDir)`（不是临时 masterId / dsh session id），由服务端**实际计算**得到，
 * 绝不取自 request host 或 body 自报。`public_base` 复用 `publicEntry(stateDir)`，只接受**HTTPS、
 * 无 userinfo/query/fragment** 的域名；不合格或没有就是空串 —— 不擅自推 LAN/明文 URL。
 * 计算失败（读文件异常等）时整块返回 undefined：宁可不给，也不给半真。
 */
function serverIdentity(stateDir: string): { crew: string; public_base: string } | undefined {
  try {
    const crew = crewFingerprint(stateDir)
    const raw = publicEntry(stateDir)
    let publicBase = ''
    if (raw) {
      try {
        const url = new URL(raw)
        // 只认 HTTPS、无 userinfo/query/fragment —— 其余（含明文 http、带凭据/参数的 URL）一律视为不可信，给空串。
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
          // 保留校验后的**合法 base 子路径**（如 https://host/crew-prefix 不能退化成 https://host）；
          // 去尾斜杠；root 仍是 https://host。绝不改成另一地址。
          const path = url.pathname.replace(/\/+$/, '')
          publicBase = `${url.origin}${path}`
        }
      } catch { publicBase = '' }
    }
    return { crew, public_base: publicBase }
  } catch { return undefined }
}

/**
 * 会话字段（S1 契约第 1、2 节 + #14 第 2 项的 header 形态）。
 * query 优先、header 兜底；两者都给且不一致 -> 400 invalid_session，不许猜哪个算数。
 * relay / lan-server 原样透传 headers，phone-gate 只看凭据头，所以 header 能到这一层；
 * 转发到网关时除拼 query 外也把 header 透传下去，滚动升级中任一版对端都读得到。
 * `invalid_session` / `unsupported_session` 是契约钉死的错误码字面值（能力协商用），
 * 故意不进 PHONE_ERRORS：翻成中文，400 / 409 的码就对不上了。
 */
const DEFAULT_SESSION_ID = 'main'
/** header 形态的会话字段，与网关 SESSION_HEADER、桌面端 sessionHeader 同一字面值。 */
const SESSION_HEADER = 'x-crew-session'
/**
 * 已认证设备号的内部头：只由入口（lan-server/中转的 phoneGate 验过凭据之后，index 的 `ask`）注入。
 * 消息面**只认这个头**当「是哪台设备」，绝不读客户端随手带的 `x-crew-device` —— 后者任何调用者都能伪造。
 * 空串/缺席都当作「没有被认证的设备」：接收链一律拒，不猜。
 */
const PRINCIPAL_HEADER = 'x-crew-principal'
/** 从内部头取已认证设备号；形状不合格就当没有（不把畸形值送到 push 层）。 */
const principalOf = (request: Request): string | undefined => {
  const value = request.headers.get(PRINCIPAL_HEADER)?.trim()
  return value && /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(value) ? value : undefined
}
/** 会话名形状（S1 契约第 1 节）。消息面校验与 threadKey 共用这一段，改形状只改一处。 */
const SESSION_NAME = '[a-z0-9][a-z0-9-]{0,31}'
const SESSION_ID = new RegExp(`^${SESSION_NAME}$`)
const SESSION_API = 1
/** threadKey 形如 `team:<会话>:<队列行号>` / `mobile:<会话>:<队列行号>`（core 的 `${source}:${id}`）。 */
const SESSION_THREAD = new RegExp(`^(?:team|mobile):(${SESSION_NAME}):(\\d+)$`)
/** 只要带 `team:<会话>:` / `mobile:<会话>:` 前缀就属于那个会话；尾号未必是数字，别用窄正则放行。 */
const ANY_SESSION_THREAD = /^(?:team|mobile):[^:]+:/

/**
 * 「回话已读到哪」按会话分键。存在 Store 的 KV 里：不开新表、不给网关的 `replies` 表加
 * 阅读回执（契约 §5.6 明确说那上面不该有）。值和 `GET /timeline` 的回话 id 同源，都是网关给的 `r<n>`。
 * `main` 复用升级前那一个单键（键名只由 KV.mobile.readCursor 定义），老的无参调用仍读写原来那一份。
 */
const READ_CURSOR = KV.mobile.readCursor

/** 读某个会话的水位；宿主没接 KV（老版本或假宿主）时是「没报过」，不是 0 条。 */
function replyReadCursor(store: PhoneHost['store'], sessionId: string): string | undefined {
  const value = typeof store.get === 'function' ? store.get(READ_CURSOR(sessionId)) : undefined
  return typeof value === 'string' && value ? value : undefined
}

/** KV family 里登记过的会话；`main` 恒首位且不重复，读不到 KV 时只有它。 */
function sessionIds(store: PhoneHost['store']): string[] {
  const keys = typeof store.keys === 'function' ? store.keys(KV.mobile.sessions) : []
  const extra = keys.map(key => key.slice(KV.mobile.sessions.prefix.length))
    .filter(id => id !== DEFAULT_SESSION_ID && SESSION_ID.test(id))
  return [DEFAULT_SESSION_ID, ...Array.from(new Set(extra)).sort()]
}

/**
 * 本会话的决定（S1 契约第 4 节）：threadKey 前缀 `team:<session_id>:` / `mobile:<session_id>:`。
 * 认不出会话前缀的老形态只在 `main` 显示 —— 老调用才逐字不变；带别的会话前缀的一律排除，
 * 哪怕尾号不是数字（窄正则会把 `team:work:abc` 误当成老形态放回 main，那正是静默串线的口子）。
 */
function decisionsForSession<T extends { threadKey?: string }>(decisions: readonly T[], sessionId: string): T[] {
  const prefixes = [`team:${sessionId}:`, `mobile:${sessionId}:`]
  return decisions.filter(decision => {
    const key = decision.threadKey
    if (typeof key !== 'string' || !key) return false
    if (prefixes.some(prefix => key.startsWith(prefix))) return true
    return sessionId === DEFAULT_SESSION_ID && !ANY_SESSION_THREAD.test(key)
  })
}

/**
 * 明确属于**其他**会话的队列行号（threadKey 尾号）。网关按 `session_id` 分片返回 items 时这份是空的；
 * 万一上游给了混合时间线，这些行号就是把外会话条目剔出去的依据（`m<row>` 与 threadKey 尾号同源）。
 */
function otherSessionRows(decisions: readonly { threadKey?: string }[], sessionId: string): Set<string> {
  const rows = new Set<string>()
  for (const decision of decisions) {
    const match = typeof decision.threadKey === 'string' ? SESSION_THREAD.exec(decision.threadKey) : null
    if (match && match[1] !== sessionId) rows.add(match[2]!)
  }
  return rows
}

/** 时间线条目按队列行号归会话；没有行号可判的条目保留，绝不靠猜把它丢掉。 */
function itemsForSession(items: readonly TimelineItem[], otherRows: ReadonlySet<string>): TimelineItem[] {
  if (otherRows.size === 0) return items.slice()
  const rowOf = (value: unknown) => typeof value === 'string' ? /^m(\d+)$/.exec(value)?.[1] : undefined
  return items.filter(item => {
    const row = rowOf(item.id) ?? rowOf(item.reply_to)
    return !row || !otherRows.has(row)
  })
}

/** 工单按 `channels[].address.conversation` 归会话；任一 channel 命中即可，没标会话的老工单只在 `main` 显示。 */
function ticketsForSession<T extends { channels: readonly { address?: Record<string, string> }[] }>(tickets: readonly T[], sessionId: string): T[] {
  return tickets.filter(ticket => {
    const tagged = ticket.channels.some(channel => typeof channel.address?.conversation === 'string' && channel.address.conversation)
    if (!tagged) return sessionId === DEFAULT_SESSION_ID
    return ticket.channels.some(channel => channel.address?.conversation === sessionId)
  })
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
  // 会话名单：GET 列出、POST 登记。两条 exact route 都在宿主侧直接答，不转发到网关。
  sessions: { methods: ['GET', 'POST'] },
  // 设备接收链（#23）：GET 看欠哪些（peek，不删）、POST ack 已持久化的 id + 记 seen。都在宿主侧答。
  notices: { methods: ['GET', 'POST'] },
  // 审批答复：手机把「做吧/先别做」这类对 ticket.attention 选项的回答交给宿主，走与 feishu
  // `approvalReply` 同一套审批状态机（见 runtime.answerTicket）。宿主侧直答，不转发网关。
  answer: { methods: ['POST'] },
  // App 故障上报：POST 收一批（白名单/幂等/有界），GET 看自己那台的最近日志。宿主侧直答，不转发网关。
  diagnostics: { methods: ['GET', 'POST'] },
  // 轻量活动快照：按会话读「哪几条请求此刻在干什么」。宿主侧直答，不转发网关、不拉全量时间线。
  activity: { methods: ['GET'] },
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
    // session_id：query 优先、header 兜底（#14 第 2 项）。两者都给且不一致 -> 400
    // invalid_session，不许猜哪个算数；形状非法同样在这里挡住，不落到网关、不静默当 main。
    //
    // #14 字面写「header 未被识别时按缺省 main，不得报错」。按字面做会重新引入 C4 串线：
    // 老网关不读 header，客户端以为在 work 会话、消息却 200 写进 main，全程无报错 —— 契约
    // §9.5 / ADR 0007 判定的唯一危险组合。裁决：「按缺省 main」只对老调用（既无 query 也
    // 无 header）成立；新客户端发了 header 而对端不认，必须由下面的 409 能力位先验挡住
    // （桌面端则由能力位先验保证零发出），绝不降级成 200 静默落库。
    const askedSession = url.searchParams.get('session_id')
    const headerSession = incoming.headers.get(SESSION_HEADER)
    // 「显式会话」= 任一个载体出现（值合法与否不影响这一点）。它只依赖两个载体在不在，
    // 所以在会话校验之前就能算出来 —— 提前到这里，下面的 `reply()` 才能在**校验失败的 400**
    // 上也生效，`invalidSession()` 不必自己再手写一份 `session_api`。
    const explicitSession = askedSession !== null || headerSession !== null
    // 非法会话的 400 也带能力位（#14 第 3 处）：能力位口径是「显式会话请求的**所有**响应都带」，
    // 错误响应不是例外。这一层在回 400 时已经知道客户端声明的原值，没有任何「还不知道会话是谁」
    // 的借口 —— 网关那边的 400 刻意不带，是因为 `_send` 里 resolve 不出值就注入不了（且那个
    // 响应必须逐字是 {'error':'invalid_session'}），那是另一层的约束，不该被抄到这一层。
    //
    // 回显的原值只用于排障，**不表示后端采纳了它**：值本身就是非法的那一个，任何 2xx 才是
    // 「这次请求被服务了」。`session_api: 1` 说的是「本后端认得这套协议」，与这个 id 合不合法无关。
    // 老调用（两个载体都不带）不走这里，一条会话字段都不加，逐字保持老形状。
    // 能力位注入（#14 第 3 处）：与网关 `_send` 同构 —— **判据只有这一处**，本 handler 之后
    // 回的每一个响应都从 `reply()` 出去，所以「显式会话请求的所有响应都带 session_api」不再靠
    // 逐条分支记得补字段。早先只有 timeline 与转发成功分支带它，自己回的 400 / 503 全光着：
    // 客户端在同一段会话里发两次请求，一次带能力位、一次不带，就无从判断对端认不认得这套协议。
    //
    // 两条边界，都是刻意的：
    // - 老调用（两个载体都不带，`explicitSession === false`）一个字段都不加，逐字保持老形状。
    // - `unsupported_session` 不注入：那条错误的意思正是「对端未升级」，同一条响应里再说
    //   `session_api: 1` 自相矛盾。判据是**错误码字面值**而不是状态码 —— 状态码会随语义漂，
    //   错误码是契约钉死的。
    // `session_id` 不在这里补：正常响应由各分支自己算（timeline 以本次会话为准），非法值的 400
    // 要回显客户端声明的原值，那是 `invalidSession()` 的事。
    const reply = (status: number, value: unknown): Response =>
      explicitSession && !(value && typeof value === 'object'
        && (value as { error?: unknown }).error === 'unsupported_session')
        ? response(status, { ...(value as Record<string, unknown>), session_api: SESSION_API })
        : response(status, value)
    // 走 reply：能力位由那一处统一注入，这里只管回显声明的原值（仅排障，不表示后端采纳了它）。
    const invalidSession = (declared: string) =>
      reply(400, { error: 'invalid_session', session_id: declared })
    if (askedSession !== null && headerSession !== null && askedSession !== headerSession) {
      // 冲突时回显 query 那一侧（query 优先，与正常解析同一条口径）；另一个值原样不进响应体 ——
      // 把两个值都塞进去等于让客户端再猜一次「哪个算数」，而这条 400 的全部意思就是「不猜」。
      return invalidSession(askedSession)
    }
    // Headers.get 对「头存在但值为空」返回 ''（不是 null），与网关 get_all 一样视为显式非法值；
    // 多个同名头会被拼成带 ', ' 的值，同样过不了形状校验 —— 两种都不许猜。
    const declaredSession = askedSession ?? headerSession
    if (declaredSession !== null && !SESSION_ID.test(declaredSession)) return invalidSession(declaredSession)
    const sessionId = declaredSession ?? DEFAULT_SESSION_ID
    // 只有客户端真的带了 header 才透传，值用校验后的 sessionId（与 query 同一个值，绝不制造冲突）。
    const forwardHeader = headerSession !== null
    // 会话名单与登记都在宿主侧答，不经过网关；`sessions` 是唯一不转发的新增 operation。
    if (operation === 'sessions') {
      await runtime.ready
      if (incoming.method === 'GET') {
        return reply(200, { sessions: sessionIds(runtime.store), default_session_id: DEFAULT_SESSION_ID, session_api: SESSION_API })
      }
      const raw = await incoming.text()
      if (Buffer.byteLength(raw) > 8 * 1024) return reply(413, { error: 'Request too large' })
      const asked = askedBody(raw)
      const id = typeof asked?.id === 'string' ? asked.id : ''
      // 登记接口自己的 400 也带能力位：这个端点整体就是会话协议的产物，它的每个响应都该让客户端
      // 一眼看出「对端认得这套协议」，不该只有 200 才带。但**不回显 `session_id`**：body 里的
      // `id` 是「想登记哪个名字」的候选，不是本请求声明的会话；把它写成 `session_id` 等于宣称
      // 「这次请求属于那段会话」，而那段会话此刻可能并不存在。
      if (!SESSION_ID.test(id)) return reply(400, { error: 'invalid_session', session_api: SESSION_API })
      if (typeof runtime.store.set !== 'function') return reply(503, { error: 'Session registry is unavailable' })
      // 重复 id 幂等：写同一个键、回同一份名单，不报错。`main` 恒在首位，不必落键。
      if (id !== DEFAULT_SESSION_ID) runtime.store.set(KV.mobile.sessions(id), true)
      // 与 GET 同形：同一资源的两个 verb 都带 `default_session_id`（#14 第 1 处）。
      // 早先 POST 缺这个字段，客户端只能按「缺字段就回落 main」兜着 —— 那条兜底正是
      // 后端形状不一致逼出来的，不是客户端的选择。缺省会话是后端的事实，两个 verb 都该说。
      return reply(200, { id, sessions: sessionIds(runtime.store),
        default_session_id: DEFAULT_SESSION_ID, session_api: SESSION_API })
    }
    // App 故障上报（域名端接收）：宿主侧直接答，不转发网关。设备号只认入口验过凭据后注入的
    // 内部 principal 头，不信客户端 x-crew-device / body 里的自报 device。POST 收一批、GET 看自己那台的
    // 最近日志（不含他人设备的）。落盘白名单、幂等、有界都在 diagnostics.ts 里。
    if (operation === 'diagnostics') {
      await runtime.ready
      const deviceId = principalOf(incoming)
      if (!deviceId) return reply(401, { error: 'Not paired' })
      const box = runtime.diagnostics
      if (!box) return reply(503, { error: 'Diagnostics is unavailable' })
      if (incoming.method === 'GET') {
        const items = box.list({
          device: deviceId,
          session: url.searchParams.get('session') ?? undefined,
          since: url.searchParams.get('since') ?? undefined,
          errorsOnly: url.searchParams.get('errorsOnly') === '1',
          limit: Number(url.searchParams.get('limit')) || undefined,
        })
        return reply(200, { device: deviceId, rows: items.rows })
      }
      // POST：batch 上报。先限大小，再限流（429 带 Retry-After），再解析白名单。
      const raw = await incoming.text()
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return reply(413, { error: 'Request too large' })
      const rate = box.rateAllowed(deviceId)
      if (!rate.allowed) {
        return Response.json({ error: say('Too many diagnostic batches') }, {
          status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(rate.retryAfterSec) },
        })
      }
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { return reply(400, { error: 'Invalid JSON' }) }
      const batch = parseBatch(parsed)
      if (!batch.ok) return reply(400, { error: batch.error, rejectedIds: batch.rejected?.map(r => r.id).filter(Boolean) ?? [],
        reasonCodes: Array.from(new Set(batch.rejected?.map(r => r.reason) ?? [])) })
      const result = box.report(deviceId, batch.app, batch.build, batch.outcome)
      // 成功 ACK 严格 application/json + {ok:true, acceptedIds}（含幂等命中），只在报告 durable 落盘后发出。
      return reply(200, { ok: true, acceptedIds: result.acceptedIds, rejectedIds: result.rejectedIds, reasonCodes: result.reasonCodes })
    }
    // 设备接收链（#23）：宿主侧直接答，不转发网关。设备号只认入口验过凭据后注入的内部 principal 头，
    // 不信客户端 x-crew-device。GET=peek（不删），POST=ack（只删点名）+ 记 seen（device-persisted）。
    if (operation === 'notices') {
      await runtime.ready
      const deviceId = principalOf(incoming)
      // 没有被认证的设备：拒。既不跨设备取件，也不替它猜一个设备号。
      if (!deviceId) return reply(401, { error: 'Not paired' })
      if (incoming.method === 'GET') {
        const readNotices = runtime.pendingNotices?.bind(runtime)
        if (!readNotices) return reply(200, { items: [], counts: { pending: 0, seen: 0 }, state: 'unavailable', reason: '后端还没有接入设备接收链' })
        let items: NoticeDelivery[]
        try { items = readNotices(deviceId) } catch { items = [] }
        const seen = runtime.noticeSeen?.(deviceId)?.length ?? 0
        return reply(200, { device: deviceId, items, counts: { pending: items.length, seen } })
      }
      // POST：body { ack_ids?: string[], seen_ids?: string[] }。ack 只删点名、seen 幂等并入账本，两件都做。
      const raw = await incoming.text()
      if (Buffer.byteLength(raw) > 64 * 1024) return reply(413, { error: 'Request too large' })
      const asked = askedBody(raw)
      if (!asked) return reply(400, { error: 'Invalid JSON' })
      const ids = (value: unknown): string[] => Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 64).slice(0, 200)
        : []
      const ackIds = ids(asked.ack_ids)
      const seenIds = ids(asked.seen_ids)
      let removed = 0
      try { removed = runtime.ackNotices?.(deviceId, ackIds) ?? 0 } catch { removed = 0 }
      let seen: string[] = []
      try { seen = runtime.markNoticeSeen?.(deviceId, seenIds.length ? seenIds : ackIds) ?? [] } catch { seen = [] }
      return reply(200, { ok: true, device: deviceId, acked: removed, seen: seen.length })
    }
    // 轻量活动快照（契约「状态协议」）：按会话读「哪几条请求此刻在干什么」。
    // 不拉全量时间线：网关那边只读 `/meta`（id / request_id / read_at / 有没有最终答复），
    // 宿主这边只读「本会话活跃票 + 正在评估的线程」，活动来自 Sessions 的原生事件投影（不是末条日志）。
    if (operation === 'activity') {
      await runtime.ready
      if (!runtime.activity) {
        // 宿主没接活动投影：明说能力不在（客户端据此记 unsupported，退回慢速时间线），不编状态。
        return reply(501, { error: 'Activity is unavailable', code: 'activity_unsupported' })
      }
      let token: string
      try { token = (await readFile(join(runtime.machine.stateDir, 'mobilegw.token'), 'utf8')).trim() } catch { token = '' }
      if (!token) return reply(503, { error: 'Mobile transport is not configured' })
      // 活跃集合先行：本会话的活跃票（索引投影，不扫全表）与正在评估的线程。
      // 这两样决定要向网关点名要哪些行，老活跃任务才不会因为「不在最近 N 条里」而消失。
      let activeTickets: Ticket[] = []
      try {
        const rows = [...runtime.store.tickets.active(), ...runtime.store.tickets.open()]
        activeTickets = ticketsForSession(rows.filter((ticket, index) => rows.indexOf(ticket) === index), sessionId)
      } catch { activeTickets = [] }
      let activeThreads: { key?: string; ref?: { source?: string; id?: string }; evaluating?: { startedAt?: string; delivered?: string } }[] = []
      try { activeThreads = runtime.store.threads.active() } catch { activeThreads = [] }
      const evaluating = evaluatingRows(activeThreads, sessionId)
      // 要向网关点名的行：活跃票的队列行 + 正在评估的行。两处都是「当前还活着」的集合。
      const named = new Set<string>(evaluating.keys())
      for (const ticket of activeTickets) {
        const message = ticket.channels.find(channel => channel.source === 'team' || channel.source === 'mobile')?.address?.message
        if (typeof message === 'string' && /^\d+$/.test(message)) named.add(message)
      }
      // 与其它 operation 同一套会话转发：显式会话拼 query 并透传 header。老调用逐字不变（但这里要严格判会话）。
      const metaQuery = `session_id=${encodeURIComponent(sessionId)}${[...named].sort().map(row => `&row=${encodeURIComponent(row)}`).join('')}`
      const metaHeaders: Record<string, string> = { 'X-GW-Token': token }
      if (forwardHeader) metaHeaders[SESSION_HEADER] = sessionId
      let meta: unknown
      try {
        const upstream = await request(`${gateway}/meta?${metaQuery}`, { method: 'GET', headers: metaHeaders,
          signal: AbortSignal.any([incoming.signal, AbortSignal.timeout(10_000)]), redirect: 'error' })
        if (!upstream.ok) return reply(upstream.status === 404 ? 501 : 502, upstream.status === 404
          ? { error: 'Activity is unavailable', code: 'activity_unsupported' }
          : { error: 'Activity is temporarily unavailable' })
        meta = await upstream.json()
      } catch { return reply(502, { error: 'Activity is temporarily unavailable' }) }
      // 严格会话校验与 timeline 同口径：显式非 main 却没拿到能力位 = 对端未升级，会把这段会话
      // 当 main 读写 → 409 unsupported_session，绝不静默接受错会话；回来会话值对不上同样拒。
      const upstreamMeta = meta && typeof meta === 'object' ? meta as Record<string, unknown> : undefined
      if (explicitSession && sessionId !== DEFAULT_SESSION_ID && upstreamMeta?.session_api !== SESSION_API) {
        return reply(409, { error: 'unsupported_session' })
      }
      if (typeof upstreamMeta?.session_id === 'string' && upstreamMeta.session_id !== sessionId) {
        return reply(502, { error: 'Activity is temporarily unavailable', code: 'session_mismatch' })
      }
      if (!Array.isArray(upstreamMeta?.items)) {
        // 形状坏掉不能当成「活跃集合为空」：那会让客户端把还活着的 overlay 一起清掉。
        return reply(502, { error: 'Activity is temporarily unavailable', code: 'malformed_meta' })
      }
      const rows = upstreamMeta.items as MetaRow[]
      // 决定按行**精确查**（decision_thread 索引），不截「最近 200 条」：更早但仍活跃的任务不该消失。
      // 查到的原样喂给 withRequestStates，让它用自己的「最新有效决定」选择 —— 两处不允许出现两套口径。
      const looked: Decision[] = []
      for (const row of rows) {
        if (typeof row.id !== 'string') continue
        const number = /^m(\d+)$/.exec(row.id)?.[1]
        if (!number) continue
        for (const source of ['team', 'mobile'] as const) {
          try { looked.push(...runtime.store.decisions.byThread(`${source}:${sessionId}:${number}`)) } catch { /* 读不到就是没有 */ }
          if (sessionId === DEFAULT_SESSION_ID) {
            // main 还认历史的两段 key（`team:<row>`），与 requestDecisionRow 的兼容口径一致。
            try { looked.push(...runtime.store.decisions.byThread(`${source}:${number}`)) } catch { /* 旧形态读不到就是没有 */ }
          }
        }
      }
      const byRow = latestDecisions(looked, sessionId)
      // 决定引用的票可能已经结束（`active()` / `open()` 都不含它），但它的 `request_state` 仍要与
      // timeline 同源：按 id 精确补进来（一票一次 get，数量受 meta 行数约束），不靠 accept 兜底成
      // `accepted` —— 那会把「已完成」显示成「已接手」。
      const known = new Map(activeTickets.map(ticket => [ticket.id, ticket]))
      for (const decision of byRow.values()) {
        const id = decision.ticketId
        if (!id || known.has(id)) continue
        try { const found = runtime.store.tickets.get(id); if (found) known.set(id, found) } catch { /* 读不到就按缺票处理 */ }
      }
      const tickets = [...known.values()]
      const items = withRequestStates(activityItems(rows), tickets, looked, sessionId, new Set(evaluating.keys()))
      const ticketsById = known
      const at = new Date().toISOString()
      const out: ActivityItem[] = []
      for (const item of items) {
        if (item.role !== 'user' || typeof item.request_id !== 'string' || !item.request_id) continue
        const row = /^m(\d+)$/.exec(item.id ?? '')?.[1]
        const decision = row ? byRow.get(row) : undefined
        const ticket = decision?.ticketId ? ticketsById.get(decision.ticketId) : undefined
        let stage: string | undefined
        try { stage = ticket ? ticketStage(ticket).stage : undefined } catch { stage = undefined }
        const evaluation = row ? evaluating.get(row) : undefined
        let activity: Activity | undefined
        if (ticket) {
          let native: Activity | undefined
          // 读活动失败不该让这一条静默消失：如实说读不到，且不造时间。
          try { native = await runtime.activity(ticket.id) } catch { native = { kind: 'unknown', label: '执行状态读取失败' } }
          activity = wireActivity({ ...(stage ? { stage } : {}), ...(native ? { native } : {}) })
        } else if (evaluation) {
          activity = wireActivity({ evaluating: evaluation })
        }
        out.push({ request_id: item.request_id, request_state: item.request_state ?? 'unknown',
          ...(ticket ? { ticket_ref: ticket.id } : {}), ...(activity ? { activity } : {}) })
      }
      return reply(200, { session_id: sessionId, session_api: SESSION_API, state: 'live', at, items: out })
    }
    // A work or agent lookup without a ticket would ask the gateway to guess; refuse it here instead.
    const ticketId = url.searchParams.get('ticket') ?? ''
    if ('needsTicket' in OPERATIONS[operation] && !ticketId) return reply(400, { error: 'ticket is required' })
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
          return reply(400, { error: 'model is required' })
        }
        // 只放行这三个开关：provider 决定去哪儿，bot_id 决定给谁，reasoningEffort 决定档位。
        // 早先这里只留了 provider/model，导致「选推理档位」「指定成员模型」两个动作被静默丢掉。
        const botId = typeof value.bot_id === 'string' && value.bot_id.trim() ? value.bot_id.trim() : undefined
        const effort = typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim() ? value.reasoningEffort.trim() : undefined
        if (botId !== undefined && (botId.length > 64 || !BOT_ID.test(botId))) return reply(400, { error: 'Invalid bot_id' })
        if (effort !== undefined && effort.length > 64) return reply(400, { error: 'Invalid reasoningEffort' })
        body = JSON.stringify({ ...typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}, model: value.model,
          ...(botId ? { bot_id: botId } : {}), ...(effort ? { reasoningEffort: effort } : {}) })
      } catch { return reply(400, { error: 'Invalid JSON' }) }
    }
    if (operation === 'pair') {
      // 配对请求只有四个短字段，给一点余量就够；它不经过网关，所以大小由这里把。
      body = await incoming.text()
      if (Buffer.byteLength(body) > 8 * 1024) return reply(413, { error: 'Pairing request too large' })
    }
    if (operation === 'steer') body = await incoming.text()
    if (operation === 'answer') body = await incoming.text()
    if (operation === 'takeover' || operation === 'pause' || operation === 'resume' || operation === 'read' || (operation === 'bots' && incoming.method === 'POST') || (operation === 'routines' && incoming.method === 'POST')) {
      // 控制请求与花名册只带几个短字段，和配对请求同量级。
      body = await incoming.text()
      if (Buffer.byteLength(body) > 8 * 1024) return reply(413, { error: 'Request too large' })
    }
    // 重试是执行器上的动作，不经过网关转发，所以放在下面那条转发分支之前。
    if (operation === 'retry') {
      if (!runtime.store.tickets.get(ticketId)) return reply(404, { error: 'No such ticket' })
      if (!runtime.engine?.retryTicket) return reply(503, { error: 'Ticket control is unavailable' })
      try { runtime.engine.retryTicket(ticketId) } catch { return reply(409, { error: 'Ticket cannot be retried' }) }
      return reply(200, { ok: true, retried: true })
    }
    // 审批答复：把「做吧/先别做」交给宿主侧的审批状态机（与 feishu `approvalReply` 同源）。
    // 票号从 body 里显式点名（手机一条 timeline 能看到多张票，不能像 feishu 那样靠「唯一一个待答」）。
    if (operation === 'answer') {
      if (!runtime.answer) return reply(503, { error: 'Answering is unavailable' })
      const asked = askedBody(body)
      if (!asked) return reply(400, { error: 'Invalid JSON' })
      const id = typeof asked.ticket === 'string' ? asked.ticket.trim() : ''
      const said = typeof asked.text === 'string' ? asked.text.trim() : ''
      const attentionId = typeof asked.attention_id === 'string' ? asked.attention_id.trim()
        : typeof asked.attentionId === 'string' ? asked.attentionId.trim() : ''
      if (!id) return reply(400, { error: 'ticket is required' })
      if (!said) return reply(400, { error: 'text is required' })
      if (!attentionId) return reply(400, { error: 'attention_id is required' })
      // actor 只来自入口验过的内置 principal（index.ts 注入 x-crew-principal），绝不读 body 里的自报身份。
      const actor = principalOf(incoming)
      const result = runtime.answer(id, said, attentionId, actor)
      return result.ok ? reply(200, { ok: true, answer: result.answer, ticket: id, attention_id: attentionId })
        : reply(409, { error: result.reason })
    }
    if (operation === 'send') {
      body = await incoming.text()
      if (Buffer.byteLength(body) > 64 * 1024) return reply(413, { error: 'Message too large' })
      try {
        const value = JSON.parse(body) as Record<string, unknown> | null
        if (!value || Array.isArray(value) || typeof value.text !== 'string' || !value.text.trim()
          || typeof value.request_id !== 'string' || !value.request_id || value.request_id.length > 128) {
          return reply(400, { error: 'text and request_id are required' })
        }
        // The authenticated owner is the sender. No client-supplied policy identity crosses this boundary.
        const mentions = Array.isArray(value.mentions)
          ? value.mentions.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 10) : []
        // A mention only names who should answer; authorization stays with the owner identity above.
        body = JSON.stringify({ text: value.text, request_id: value.request_id, mentions })
      } catch { return reply(400, { error: 'Invalid JSON' }) }
    }
    if (operation === 'withdraw') {
      body = await incoming.text()
      if (Buffer.byteLength(body) > 8 * 1024) return reply(413, { error: 'Request too large' })
      const value = askedBody(body)
      const requestId = typeof value?.request_id === 'string' ? value.request_id : ''
      // 撤回只认 request_id，和 send 用同一个长度上限；其余字段一律丢掉，不替客户端猜。
      if (!requestId || requestId.length > 128) return reply(400, { error: 'request_id is required' })
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
          if (!write) return reply(503, { error: 'Routine editing is unavailable' })
          const raw = body
          let value: { action?: unknown; id?: unknown; title?: unknown; cycle?: unknown; bot_id?: unknown; enabled?: unknown }
          try { value = JSON.parse(raw ?? '') } catch { return reply(400, { error: 'Invalid JSON' }) }
          const action = value?.action
          if (action !== 'create' && action !== 'edit' && action !== 'remove') return reply(400, { error: 'action must be create, edit or remove' })
          const outcome = write(action, {
            ...(typeof value.id === 'string' ? { id: value.id } : {}),
            ...(typeof value.title === 'string' ? { title: value.title } : {}),
            ...(typeof value.cycle === 'string' ? { cycle: value.cycle } : {}),
            ...(typeof value.bot_id === 'string' ? { bot_id: value.bot_id } : {}),
            ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
          })
          if (!outcome.ok) return reply(400, { ok: false, reason: outcome.reason ?? 'write failed' })
          return reply(200, outcome.record ? { ok: true, record: outcome.record } : { ok: true })
        }
        // GET：KV 里那张定时账本。宿主没接这项能力时说「读不到」，不说「还没有常规任务」—— 那是在替队伍编一句话。
        const readRoutines = runtime.routines?.bind(runtime)
        if (!readRoutines) {
          return reply(200, { items: [], state: 'unavailable', counts: { enabled: 0, paused: 0 },
            runner: 'none', reason: '后端还没有接入常规任务' })
        }
        try {
          return reply(200, await readRoutines())
        } catch {
          return reply(200, { items: [], state: 'unavailable', counts: { enabled: 0, paused: 0 },
            runner: 'none', reason: '常规任务暂时读不出来' })
        }
      }
      if (operation === 'reply-spend') {
        const ticketId = url.searchParams.get('ticket')?.trim() ?? ''
        if (!ticketId) return reply(400, { error: 'ticket is required' })
        const read = runtime.replySpends?.bind(runtime)
        if (!read) return reply(200, { available: false, reason: '后端还没有接入逐条用量' })
        try {
          const value = await read(ticketId)
          return reply(200, value === undefined ? { available: false, reason: '这张票没有可读的用量记录' } : { available: true, ...value })
        } catch (error) {
          return reply(200, { available: false, reason: error instanceof Error ? error.message : '暂时读不出来' })
        }
      }
      if (operation === 'speak') {
        const speak = runtime.speak?.bind(runtime)
        if (!speak) return reply(200, { available: false, reason: '这台后端没有接入播报' })
        const raw = await incoming.text()
        if (Buffer.byteLength(raw) > 64 * 1024) return reply(413, { error: 'Request too large' })
        const asked = askedBody(raw)
        const text = typeof asked?.text === 'string' ? asked.text : ''
        if (!text.trim()) return reply(400, { error: 'text is required' })
        const outcome = await speak(text)
        if (outcome.status !== 'ok') {
          return reply(200, { available: false, status: outcome.status, reason: outcome.reason })
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
        if (!transcribeVoice) return reply(200, { available: false, reason: '后端还没有接入语音识别' })
        const raw = await incoming.arrayBuffer()
        try {
          return reply(200, await transcribeVoice(new Uint8Array(raw), incoming.signal))
        } catch (error) {
          return reply(200, { available: false, reason: error instanceof Error ? error.message : '识别没成功' })
        }
      }
      if (operation === 'spend' || operation === 'audit') {
        // 两张账都按票读。没有票号或宿主没接这项能力时如实说读不到，不回一个像样的假数。
        const ticketId = url.searchParams.get('ticket')?.trim() ?? ''
        if (!ticketId) return reply(400, { error: 'ticket is required' })
        const read = operation === 'spend' ? runtime.spend?.bind(runtime) : runtime.audit?.bind(runtime)
        if (!read) return reply(200, { available: false, reason: '后端还没有接入这一项' })
        try {
          const value = await (read as (id: string) => Promise<unknown>)(ticketId)
          return reply(200, value === undefined ? { available: false, reason: '这张票没有可读的记录' } : { available: true, [operation]: value })
        } catch (error) {
          return reply(200, { available: false, reason: error instanceof Error ? error.message : '暂时读不出来' })
        }
      }
      if (operation === 'memory') {
        // 记忆账本：GET 读一栏，POST 改一条（`action`: forget / edit）。
        const name = url.searchParams.get('bot')?.trim()
        if (incoming.method === 'GET') {
          const readMemory = runtime.memories?.bind(runtime)
          if (!readMemory) return reply(200, { items: [], state: 'unavailable', counts: { active: 0, forgotten: 0, superseded: 0 },
            reason: '后端还没有接入记忆' })
          try { return reply(200, await readMemory(name ? { bot: name } : {})) }
          catch { return reply(200, { items: [], state: 'unavailable', counts: { active: 0, forgotten: 0, superseded: 0 }, reason: '记忆账本暂时读不出来' }) }
        }
        const raw = await incoming.text()
        if (Buffer.byteLength(raw) > 32 * 1024) return reply(413, { error: 'Request too large' })
        let value: { action?: unknown; name?: unknown; description?: unknown; body?: unknown; importance?: unknown; toHub?: unknown }
        try { value = JSON.parse(raw) } catch { return reply(400, { error: 'Invalid JSON' }) }
        const target = typeof value?.name === 'string' ? value.name.trim() : ''
        if (!target) return reply(400, { error: 'name is required' })
        // 只认记忆账本那个前缀下的名字：这是主人改账本，不是任意改 KV。
        if (!target.startsWith('bot-')) return reply(400, { error: 'No such memory' })
        if (value.action === 'forget') {
          const forget = runtime.forgetMemory?.bind(runtime)
          if (!forget) return reply(200, { ok: false, reason: '后端还没有接入记忆' })
          return reply(200, { ok: forget(target), name: target })
        }
        if (value.action === 'edit') {
          const edit = runtime.editMemory?.bind(runtime)
          if (!edit) return reply(200, { ok: false, reason: '后端还没有接入记忆' })
          const patch: { description?: string; body?: string; importance?: number; toHub?: boolean } = {}
          if (typeof value.description === 'string') patch.description = value.description
          if (typeof value.body === 'string') patch.body = value.body
          if (typeof value.importance === 'number') patch.importance = value.importance
          // 裁定 C：显式分享开关只经此产品 edit 入口设置（默认 false，不自动分享）。
          if (typeof value.toHub === 'boolean') patch.toHub = value.toHub
          try { return reply(200, { ok: edit(target, patch), name: target }) }
          catch (error) { return reply(400, { error: error instanceof Error ? error.message : 'Invalid memory' }) }
        }
        return reply(400, { error: 'action must be forget or edit' })
      }
      if (operation === 'outputs') {
        // 「产出」：worker 真正写过的文件。宿主没接这项能力时如实说「读不到」，
        // 不说「没有产出」—— 那是在替队伍编一句话。
        // runtime.outputs 是实例方法，脱离 this 调会读不到 store，所以先 bind 再调。
        if (!runtime.outputs) {
          return reply(200, { items: [], state: 'unavailable', counts: { file: 0, image: 0 }, reason: '后端还没有接入产出' })
        }
        const readOutputs = runtime.outputs.bind(runtime)
        const wanted = ticketId ? [ticketId] : []
        if (ticketId && !runtime.store.tickets.get(ticketId)) return reply(404, { error: 'No such ticket' })
        // 不带票号时列最近的几张：产出是「交出来的东西」，不是全部历史。手机与队伍两条通道的票都算。
        const tickets = (wanted.length > 0 ? wanted.flatMap(id => runtime.store.tickets.get(id) ?? []) : runtime.store.tickets.list())
          .filter(ticket => ticket.channels.some(channel => channel.source === 'mobile' || channel.source === 'team'))
          .slice(0, 12)
        // 票存在、但它不走手机/队伍这两条通道：这不是「队伍还没有工单」，如实说它不在产出通道里。
        if (ticketId && tickets.length === 0) {
          return reply(200, { items: [], state: 'empty', counts: { file: 0, image: 0 }, ticket_id: ticketId,
            reason: '这张票不在产出通道里（只有手机与队伍工单有产出）' })
        }
        try {
          const view = await readOutputs(tickets.map(ticket => {
            const botId = ticketBot(ticket)
            return { id: ticket.id, title: ticket.title,
              ...(botId ? { bot_id: botId } : {}),
              ...(ticket.execution?.directory ? { cwd: ticket.execution.directory } : {}) }
          }))
          return reply(200, ticketId ? { ...view, ticket_id: ticketId } : view)
        } catch {
          return reply(200, { items: [], state: 'unavailable', counts: { file: 0, image: 0 },
            ...(ticketId ? { ticket_id: ticketId } : {}), reason: '产出暂时读不出来' })
        }
      }
      if (operation === 'steer') {
        if (!runtime.steer) return reply(503, { error: 'Steering is unavailable' })
        const asked = askedBody(body)
        if (!asked) return reply(400, { error: 'Invalid JSON' })
        const id = typeof asked.ticket === 'string' ? asked.ticket : ''
        const requestId = typeof asked.request_id === 'string' ? asked.request_id : ''
        if (!id) return reply(400, { error: 'ticket is required' })
        if (!requestId || requestId.length > 128) return reply(400, { error: 'request_id is required' })
        const ticket = runtime.store.tickets.get(id)
        if (!ticket || ticket.ended) return reply(409, { error: 'Ticket is not running' })
        const token = (await readFile(join(runtime.machine.stateDir, 'mobilegw.token'), 'utf8')).trim()
        if (!token) return reply(503, { error: 'Mobile transport is not configured' })
        // steer 在宿主侧直答，不走下面统一的那道 409 先验，但它内部要往网关写/认领消息。
        // 两条内部请求必须同样带会话字段并验能力位：否则 header 形态的非 main steer 会
        // 绕过先验、把消息静默按 main 落库（审查发现的真串线口子）。
        const steerQuery = explicitSession ? `?session_id=${encodeURIComponent(sessionId)}` : ''
        const steerHeaders: Record<string, string> = { 'X-GW-Token': token, 'Content-Type': 'application/json',
          ...(forwardHeader ? { [SESSION_HEADER]: sessionId } : {}) }
        const steerCapability = async (upstream: Response): Promise<Response | undefined> => {
          if (!explicitSession || sessionId === DEFAULT_SESSION_ID) return undefined
          const data = await upstream.clone().json().catch(() => undefined) as { session_api?: unknown } | undefined
          if (data?.session_api !== SESSION_API) return reply(409, { error: 'unsupported_session' })
          return undefined
        }
        const authored = typeof asked.text === 'string' ? asked.text.trim() : ''
        let text = ''
        if (authored) {
          // 发送即插队：消息以「已读」写进网关，路由不会再把它当新活接一遍。
          const sent = await request(`${gateway}/send${steerQuery}`, { method: 'POST',
            headers: steerHeaders,
            body: JSON.stringify({ text: authored, request_id: requestId, mentions: [], steer: true }),
            signal: AbortSignal.any([incoming.signal, AbortSignal.timeout(10_000)]), redirect: 'error' })
          if (!sent.ok) return reply(sent.status === 401 ? 503 : sent.status, { error: 'Mobile request was rejected' })
          const denied = await steerCapability(sent)
          if (denied) return denied
          text = authored
        } else {
          // 对已经在队列里的消息：先认领（标记读走）。成功才说明它还没被路由读过，不会送两遍。
          const claimed = await request(`${gateway}/claim${steerQuery}`, { method: 'POST',
            headers: steerHeaders,
            body: JSON.stringify({ request_id: requestId }),
            signal: AbortSignal.any([incoming.signal, AbortSignal.timeout(10_000)]), redirect: 'error' })
          if (!claimed.ok) {
            if (claimed.status === 404 || claimed.status === 409) {
              const refused = await claimed.json().catch(() => undefined) as { error?: unknown } | undefined
              return reply(claimed.status, { error: typeof refused?.error === 'string' ? refused.error : 'Steer refused' })
            }
            return reply(claimed.status === 401 ? 503 : claimed.status, { error: 'Mobile request was rejected' })
          }
          const message = await claimed.clone().json() as { text?: unknown }
          const denied = await steerCapability(claimed)
          if (denied) return denied
          text = typeof message.text === 'string' ? message.text : ''
        }
        if (!text) return reply(409, { error: 'no such message' })
        if (!await runtime.steer(id, requestId, text)) return reply(409, { error: 'Ticket is not running' })
        return reply(200, { ok: true, ticket: id, request_id: requestId })
      }
      if (operation === 'efforts') {
        if (!runtime.efforts) return reply(503, { error: 'Model details are unavailable' })
        const provider = url.searchParams.get('provider') ?? ''
        const model = url.searchParams.get('model') ?? ''
        if (!provider || !model) return reply(400, { error: 'provider and model are required' })
        try { return reply(200, await runtime.efforts(provider, model)) }
        catch (error) { return reply(400, { error: error instanceof Error ? error.message : 'Model is unavailable' }) }
      }
      if (operation === 'screen') {
        // 画面源是会话活动快照（命令/输出/回话），不是像素截帧：worker 不跑浏览器，但它在终端里
        // 做了什么，手机上应该看得见。宿主没接这项能力时如实说「没有」，不给一个永远转圈的画面。
        if (!runtime.screen) return reply(200, { state: 'unavailable', reason: '后端还没有接入画面源' })
        try { return reply(200, await runtime.screen(ticketId)) }
        catch { return reply(200, { state: 'unavailable', ticket_id: ticketId, reason: '这张工单的会话暂时读不出来' }) }
      }
      if (operation === 'takeover') {
        const asked = askedBody(body)
        if (!asked) return reply(400, { error: 'Invalid JSON' })
        const id = typeof asked.ticket === 'string' ? asked.ticket : ''
        if (!id) return reply(400, { error: 'ticket is required' })
        const ticket = runtime.store.tickets.get(id)
        if (!ticket) return reply(404, { error: 'No such ticket' })
        if (!runtime.engine) return reply(503, { error: 'Ticket control is unavailable' })
        // 已结束的票必须如实拒绝，不能回 stopped: true 假成功。
        // Tickets.stop() → end() 遇到 !liveTicket 是静默 return（票已经不在跑了，
        // 结束它是空操作），路由若无条件报成功，界面就会显示「已接手：这张票停下了」
        // —— 那是一句假话，而且调用方拿不到任何信号。所以这里先判票还活着。
        if (!liveTicket(ticket)) return reply(409, { error: 'Ticket is already ended' })
        try { runtime.engine.stopTicket(id) } catch { return reply(409, { error: 'Ticket cannot be stopped' }) }
        return reply(200, { ok: true, stopped: true })
      }
      if (operation === 'pause') {
        const asked = askedBody(body)
        if (!asked) return reply(400, { error: 'Invalid JSON' })
        const id = typeof asked.ticket === 'string' ? asked.ticket : ''
        // 给出了票号就得对得上：一张不存在的票不该让整台执行器停下来。
        if (id && !runtime.store.tickets.get(id)) return reply(404, { error: 'No such ticket' })
        if (!runtime.settings) return reply(503, { error: 'Pause control is unavailable' })
        await runtime.settings.pause(true, 'panel')
        // 目前只有执行器这一种暂停。如实写 scope，别让手机以为只停了这一张票。
        return reply(200, { ok: true, scope: 'executor' })
      }
      if (operation === 'resume') {
        if (!askedBody(body || '{}')) return reply(400, { error: 'Invalid JSON' })
        if (!runtime.settings?.pause) return reply(503, { error: 'Resume control is unavailable' })
        try { await runtime.settings.pause(false, 'panel') }
        catch { return reply(500, { error: 'Resume control failed' }) }
        return reply(200, { ok: true, resumed: true, scope: 'executor' })
      }
      if (operation === 'read') {
        // 「未读回话」原来没有，是因为后端从来收不到「主人看过哪条回话」这个输入
        // （契约 §5.6：网关只有人 → 队伍的 messages.read_at，反方向没有回执）。
        // 这条路由只补那一个输入：客户端报上它读到的最后一条回话 id，后端记一条会话级水位。
        // 不逐条改 replies 表、不发明阅读回执；数由 GET /timeline 按这份水位算（unreadRepliesOf）。
        const asked = askedBody(body)
        if (!asked) return reply(400, { error: 'Invalid JSON' })
        const lastReadId = typeof asked.last_read_id === 'string' ? asked.last_read_id.trim() : ''
        if (!lastReadId || lastReadId.length > 128) return reply(400, { error: 'last_read_id is required' })
        if (typeof runtime.store.set !== 'function') return reply(503, { error: 'Read cursor is unavailable' })
        // 按会话分键；老的无参调用落到 main 那一份（升级前的那个单键），已存过的水位不丢。
        runtime.store.set(READ_CURSOR(sessionId), lastReadId)
        return reply(200, { ok: true, last_read_id: lastReadId })
      }
      if (operation === 'bots') {
        const settings = runtime.store.settings()
        const config = (settings.sources?.team?.config ?? {}) as Record<string, unknown>
        const bots = Array.isArray(config.bots) ? config.bots as Record<string, unknown>[] : []
        if (incoming.method === 'GET') return reply(200, { bots: teamBotRows(bots) })
        // `action` 是这条请求要做的事。DSH 的 Connection 只放行 GET/POST，所以编辑与删除
        // 走 POST + action，而不是 PUT/DELETE —— 否则手机上根本没有这条路。
        const askedFor = askedBody(body)
        const action = typeof askedFor?.action === 'string' ? askedFor.action : ''
        // 撤一位。人走了，他的配置就该走；记忆留在磁盘上不动（那是历史，不是配置）。
        if (action === 'remove') {
          const asked = askedBody(body)
          const botId = typeof asked?.bot_id === 'string' ? asked.bot_id.trim() : ''
          if (!botId) return reply(400, { error: 'bot_id is required' })
          const gone = bots.find(bot => bot.bot_id === botId)
          if (!gone) return reply(404, { error: 'No such bot' })
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
        if (!asked) return reply(400, { error: 'Invalid JSON' })
        const botId = typeof asked.bot_id === 'string' ? asked.bot_id.trim() : ''
        if (!BOT_ID.test(botId)) return reply(400, { error: 'Invalid bot id' })
        const name = typeof asked.name === 'string' ? asked.name.trim() : ''
        if (!name) return reply(400, { error: 'name is required' })
        if (name.length > 100) return reply(400, { error: 'name is too long' })
        const persona = typeof asked.persona === 'string' ? asked.persona.trim() : ''
        if (persona.length > 2000) return reply(400, { error: 'persona is too long' })
        const existing = bots.find(bot => bot.bot_id === botId)
        // 改这位的人设 / 名字。bot_id 不改 —— 记忆命名空间挂在它上面，改了等于换人。
        if (action === 'edit') {
          if (!existing) return reply(404, { error: 'No such bot' })
          const next = bots.map(bot => bot.bot_id === botId
            ? { ...bot, name, ...(persona ? { persona } : { persona: '' }) } : bot)
          return saveTeamBots(runtime, settings, { ...config, bots: next })
        }
        if (existing) return reply(400, { error: 'Bot already exists' })
        const askedRole = asked.role === 'default' ? 'default' : 'member'
        const hasDefault = bots.some(bot => bot.role === 'default')
        if (askedRole === 'default' && hasDefault) {
          return reply(400, { error: 'The crew already has a default bot' })
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
        return reply(200, {
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
        if (!devices) return reply(503, { error: 'Pairing is unavailable' })
        const asked = askedBody(body)
        if (!asked) return reply(400, { error: 'Invalid JSON' })
        const { code, deviceId, name, platform } = asked
        if (typeof code !== 'string' || typeof deviceId !== 'string' || !code || !deviceId) {
          return reply(400, { error: 'code and deviceId are required' })
        }
        const credential = devices.redeem({ code, deviceId,
          name: typeof name === 'string' && name ? name : deviceId,
          platform: typeof platform === 'string' ? platform : 'unknown' })
        // 码错和设备不对在这里看起来一样：说清楚是哪一个只对尝试者有好处。
        return credential ? reply(200, credential) : reply(403, { error: 'Pairing refused' })
      }
      if (operation === 'model') {
        if (!body) return reply(400, { error: 'model is required' })
        const asked = JSON.parse(body) as { provider?: string; model: string; reasoningEffort?: string; bot_id?: string }
        // A provider has to be named for a real switch: a model name alone does not say where to reach it.
        // 只清成员路由（model 为空）不需要 provider。
        if (!(asked.bot_id && !asked.model.trim()) && (typeof asked.provider !== 'string' || !asked.provider.trim())) {
          return reply(400, { error: 'provider is required' })
        }
        // 指定成员时必须是花名册里存在的 bot_id；拼错的 id 会静默变成一条没人用的配置。
        if (asked.bot_id !== undefined) {
          const config = (runtime.store.settings().sources?.team?.config ?? {}) as { bots?: { bot_id?: string }[] }
          const bots = Array.isArray(config.bots) ? config.bots : []
          if (typeof asked.bot_id !== 'string' || !BOT_ID.test(asked.bot_id) || !bots.some(bot => bot.bot_id === asked.bot_id)) {
            return reply(400, { error: 'Unknown bot_id' })
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
        if (!runtime.settings?.save) return reply(503, { error: 'Model switching is unavailable' })
        try {
          await runtime.settings.save('executor', next.executor, runtime.store.blockRevision('executor'), 'panel')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // SettingsConflict 是空 extends Error，它的 name 仍是 'Error'，只能按类型判。
          return reply(error instanceof SettingsConflict ? 409 : 400, { error: message || 'Model unavailable' })
        }
        return reply(200, { ok: true, ...(asked.bot_id ? { bot_id: asked.bot_id, model: next.executor.botModels[asked.bot_id] } : { model: next.executor.model }) })
      }
      if (operation === 'work') {
        const work = workOf(runtime.store.tickets.get(ticketId))
        return work ? reply(200, work) : reply(404, { error: 'No such ticket' })
      }
      const agents = (runtime as unknown as { agents?: Parameters<typeof agentTree>[0] }).agents
      if (!agents) return reply(503, { error: 'Session tree is unavailable' })
      const ticket = runtime.store.tickets.get(ticketId)
      if (!ticket) return reply(404, { error: 'No such ticket' })
      // `ctx.agents` answers by id only, so the ids that may be subagents come from the sessions the store recorded.
      // `keys` takes the family itself, not a prefix string; the id is what follows the family's prefix.
      const known = runtime.store.keys?.(KV.sessions.prompts)?.map(name => name.slice(KV.sessions.prompts.prefix.length)) ?? []
      return reply(200, { ticket_id: ticketId, agents: agentTree(agents, ticketId, 8, known, ticket) })
    }
    try {
      await runtime.ready
      const token = (await readFile(join(runtime.machine.stateDir, 'mobilegw.token'), 'utf8')).trim()
      if (!token) return reply(503, { error: 'Mobile transport is not configured' })
      const query = ticketId ? `?ticket=${encodeURIComponent(ticketId)}` : ''
      // 只在显式带了会话字段时追加：老调用的转发 URL 逐字不变，网关自己缺省 main（S1 契约第 1 节）。
      // 有 ticket 时接 `&`，没有时接 `?`，两种形状都让网关从 url.search 取到同一个字段。
      // header-only 请求在这里「等价地转成 query」（只认 query 的 S1 网关也读得到），同时把
      // header 原样透传下去（认 header 的新网关也读得到）；两者值恒相同，网关不会判成冲突。
      const target = `${gateway}/${operation}${query}${explicitSession ? `${query ? '&' : '?'}session_id=${encodeURIComponent(sessionId)}` : ''}`
      const forwardedHeaders: Record<string, string> = { 'X-GW-Token': token, 'Content-Type': 'application/json' }
      if (forwardHeader) forwardedHeaders[SESSION_HEADER] = sessionId
      const upstream = await request(target, {
        method: incoming.method, headers: forwardedHeaders,
        ...(body ? { body } : {}), signal: AbortSignal.any([incoming.signal, AbortSignal.timeout(10_000)]), redirect: 'error',
      })
      if (!upstream.ok) {
        // 撤回失败要让人知道是「已回复」「已交给 worker」还是「没这条」：网关的这几条错误都是固定文案，
        // 原样带回状态码和文案；其余上游错误仍然只回笼统的一句话，避免泄露内部信息。
        if (operation === 'withdraw' && (upstream.status === 404 || upstream.status === 409)) {
          const refused = await upstream.json().catch(() => undefined) as { error?: unknown } | undefined
          return reply(upstream.status, { error: typeof refused?.error === 'string' ? refused.error : 'Withdraw refused' })
        }
        // Credentials and internal paths never appear in upstream error responses.
        return reply(upstream.status === 401 ? 503 : upstream.status,
          { error: upstream.status === 401 ? 'Mobile transport credential mismatch' : 'Mobile request was rejected' })
      }
      const data = await upstream.json() as Record<string, unknown>
      // 能力位（S1 契约第 2 节 + #14 第 2 项）：网关对显式声明了会话的**每个**响应都回显
      // session_api: 1（query 或 header 任一形态；老调用两者都不带 → 响应逐字不变）。
      // 所以对任何转发 operation，显式非 main 却没拿到 1，就是对端未升级、会把这段会话
      // 当 main 读写：直接 409，绝不静默回落。
      //
      // 这正是「老网关不认 header」的唯一兜底：#14 字面要求「header 未被识别时按缺省 main，
      // 不得报错」，按字面做会让新客户端在 work 发的话 200 写进 main（C4 串线）。这里必须
      // 报错。判据用的是**上游原始 data**，绝不能在下面注入兜底能力位之后再判，否则老网关
      // 会被自己补的字段伪装成已升级。桌面端另有一道能力位先验，先验没过就零发出。
      // 老调用与显式 main 不受影响（main 本来就是 main，老网关照常服务）。
      if (explicitSession && sessionId !== DEFAULT_SESSION_ID && data.session_api !== SESSION_API) {
        return reply(409, { error: 'unsupported_session' })
      }
      if (operation === 'timeline') {
        const settings = runtime.store.settings()
        const decisions = runtime.store.read?.recentDecisions?.(0, 200) ?? []
        // 会话过滤（S1 契约第 4 节）：宿主侧的决定、工单、时间线都先按 session_id 收窄，
        // 别把别的会话的数据算进这一格的 tasks / queued / declined / unread / unread_replies。
        // 老调用是 main，且老数据没有会话标记，所以这层过滤对它是恒等的 —— 内容其余部分逐字不变。
        const sessionDecisions = decisionsForSession(decisions, sessionId)
        const gatewayItems = Array.isArray(data.items) ? data.items as TimelineItem[] : []
        const sessionItems = itemsForSession(gatewayItems, otherSessionRows(decisions, sessionId))
        // 代码卡上「看看改完的样子」要知道看哪张票：网关只记「回哪条消息」，
        // 工单号在这一侧对齐一次再下发。对不上就让它缺着，客户端会如实说。
        const itemRefs = withTicketRefs(sessionItems, ticketRefs(sessionItems, sessionDecisions, sessionId))
        // The crew Source answers on the same queue as mobile, so its tickets belong on the phone too.
        // 群组只读投影（#10 第 4 项 / 契约 §10）用未按会话过滤、未截断的全量票：
        // 投影只数不写、不含工单对象；若传下面那份 `tickets`，别的会话的组会恒显示「0 张」
        // —— 那是向人显示错事实。读票失败也在这里兜住，让三态里的「读不到」真的可达，
        // 而不是被外层 catch 吞成 502（整个时间线失败比诚实说「读不到」更糟）。
        const crewTickets = ((): { rows: ReturnType<typeof runtime.store.tickets.list> } | { reason: string } => {
          try {
            return { rows: runtime.store.tickets.list().filter(ticket =>
              ticket.channels.some(channel => channel.source === 'mobile' || channel.source === 'team')) }
          } catch (error) {
            return { reason: `工单读不出来：${String(error)}` }
          }
        })()
        const sessionTickets = 'rows' in crewTickets ? ticketsForSession(crewTickets.rows, sessionId) : []
        const items = withRequestStates(itemRefs, sessionTickets, sessionDecisions, sessionId)
        const tickets = sessionTickets.slice(0, 30)
        // The phone names a Bot on send; the roster tells it who exists and who answers by default.
        const roster = crewRoster(runtime.store.settings(), bot => earliestTicketAt(data, bot))
        // sessions 恒含 main，所以「只有 main、无 bot、无票」是 live 而不是 empty：
        // main 组确实存在，只是暂时没有内容。
        const groups = ((): GroupsView => {
          try {
            if ('reason' in crewTickets) return { groups: [], state: 'unavailable', reason: crewTickets.reason }
            return groupsOf({ sessions: sessionIds(runtime.store), bots: roster.bots, tickets: crewTickets.rows })
          } catch (error) {
            return { groups: [], state: 'unavailable', reason: `群组投影读不出来：${String(error)}` }
          }
        })()
        // 可选只读 server 元数据：算一次复用；算不出（undefined）就整块不加，保持老响应逐字兼容。
        const serverMeta = serverIdentity(runtime.machine.stateDir)
        return reply(200, { ...data, ...roster,
          // 能力位（S1 契约第 2 节）：老调用也回显 session_id: "main"，内容其余部分逐字不变。
          // 放在 ...data 之后，以消息面算出的会话为准，不让上游的字段替客户端决定它在看哪一段。
          session_id: sessionId, session_api: SESSION_API,
          sessions: sessionIds(runtime.store), default_session_id: DEFAULT_SESSION_ID,
          groups,
          // 可选只读 server 元数据（同实例指纹 + 真实 HTTPS public_base）：只增不改，老 App 忽略即兼容；
          // 算不出就整块不出现（不编半真）。身份是「同实例指纹」非 crypto 证明。
          ...(serverMeta ? { server: serverMeta } : {}),
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
            ...(asking ? ((): Record<string, unknown> => {
              const card = ticket.attention!
              // 历史卡：问题正文是截断过的 `JSON.stringify(args)`，不能当主正文下发。它被投影成人读的一套，
              // 旧问题移进折叠的 details；**id 与选项 id 一字不改**，客户端答 `/answer` 时照旧能对上。
              const legacy = !card.presentation && ticket.pendingApproval?.kind === 'connection'
                ? legacyConnectionCard(card) : undefined
              // 剩下的无投影旧卡（例如重启后丢了 pendingApproval）：认得出工具形状才补人读正文，普通人话原样。
              const attention = legacy ?? attentionForDisplay(card)
              return { question: attention.question,
                // 问题卡 id：客户端答 `/answer` 时原样带回，防「旧卡批新请求」（见 §3）。
                attention_id: card.id,
                ...attention.options?.length ? { options: attention.options } : {},
                // 人读投影：待确认正文（完整换行）与折叠的脱敏细节。旧卡按同一形状给，缺正文就不给 preview。
                ...attention.presentation ? { approval: attention.presentation } : {} }
            })() : {}) }
        }),
        // `queued` 是网关当前确实可撤回的 request_id 集合：必须有消息 id、未撤回、无回复且 read_at 明确为空。
        // 集合完整性单独用 queued_state 表示；缺字段时不把 unknown 说成空队列。
        queued: queuedRequests(sessionItems),
        queued_state: queuedStateOf(sessionItems),
        // 「未读」：人发出去、队伍还没读走的有几条（契约 §5.6）。和 `queued` 读的是同一份时间线，
        // 但判据不同：`queued` 是「还没回复、还能撤回」，未读是「还没被读走」。一条消息可以先被读走
        // 再慢慢回，那时它已经不算未读了。
        unread: unreadOf(items),
        // 「未读回话」：队伍回了、主人还没看的有几条（契约 §5.6 新增的一格）。
        // 和 `unread` 方向相反、判据不同，两个数谁也不冒充谁；没报过水位就是 unknown，不是 0。
        unread_replies: unreadRepliesOf(items, replyReadCursor(runtime.store, sessionId)),
        // The messages read and left on purpose. Without these the phone cannot tell a thought in progress from
        // one that will never be answered.
        // Older hosts predate this read; a missing history leaves the list empty rather than failing the timeline.
        declined: declinedRequests(sessionItems, sessionDecisions, Date.now(), QUEUE_WINDOW_MS, sessionId),
        // 手机消息由已安装的那个 Source 承载：独立部署是 `mobile`，Bot 队伍里是 `team`。
        // 两个都不在时如实说 missing；兜底写 starting 会让人以为服务一直没起来。
        status: { runtime: runtime.health.runtime?.state ?? 'starting',
          mobile: (runtime.health.mobile ?? runtime.health.team)?.state ?? 'missing', paused: settings.paused } })
      }
      // `work` and `agents` are the gateway's own JSON; hand it back untouched so a new field it adds
      // reaches the phone without a change here.
      return reply(200, data)
    } catch {
      return reply(502, { error: 'Mobile transport is temporarily unavailable; retry with the same request_id' })
    }
  }
}

/**
 * 轻量活动端点的一条请求（契约「状态协议」）。
 *
 * `request_id` 恒为用户消息自己的 request_id（客户端的幂等键），不是 Trigger id、不是消息 id：
 * 客户端拿它把活动挂回那条消息。`request_state` 是收据（与任务活动正交），`ticket_ref` 是这张票。
 */
export interface ActivityItem {
  request_id: string
  request_state: RequestState
  ticket_ref?: string
  activity?: Activity
}

/**
 * 网关 `/meta` 的行：只有 id、request_id、读状态、有没有最终答复/别的出站。
 * 不含正文 —— 轻量端点不得为了活动去读消息与回话的全文。
 */
export interface MetaRow { id?: string; request_id?: string; read_at?: string; root?: boolean; answered?: boolean; acknowledged?: boolean }

/**
 * 把 `/meta` 行拼成 `withRequestStates` 认的最小条目。
 *
 * 只造它判据真正要用的两样：`id`（`m<N>`）与 `read_at`；再加一条合成的 agent 条目表示
 * 「这条已经被**最终答复**接住」。回执（acknowledged）**不**制造 agent 条目 —— 它不该终结状态。
 */
export function activityItems(rows: readonly MetaRow[]): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || !/^m\d+$/.test(row.id)) continue
    if (typeof row.request_id !== 'string' || !row.request_id) continue
    items.push({ id: row.id, role: 'user', request_id: row.request_id,
      ...(typeof row.read_at === 'string' ? { read_at: row.read_at } : {}) })
    if (row.answered) items.push({ id: `r:${row.id}`, role: 'agent', reply_to: row.id, reply_kind: 'reply' })
  }
  return items
}

/**
 * 本会话里**正在评估**的队列行号 → 评估的真实时间。
 *
 * `thread.evaluating` 是持久事实（`Evaluation.startedAt` / `delivered`），来自 thread 记录本身，
 * 不靠 Trigger id 猜。threadKey 形如 `team:<会话>:<行号>`（与 `SESSION_THREAD` 同一形状）；
 * 尾号不是数字、会话不匹配、或没有 evaluating 的一律不出现在结果里。
 */
export function evaluatingRows(threads: readonly { key?: string; ref?: { source?: string; id?: string }; evaluating?: { startedAt?: string; delivered?: string } }[],
  sessionId = DEFAULT_SESSION_ID): Map<string, { since?: string; at?: string }> {
  const found = new Map<string, { since?: string; at?: string }>()
  for (const thread of threads) {
    if (!thread.evaluating) continue
    const key = typeof thread.key === 'string' ? thread.key : thread.ref ? `${thread.ref.source}:${thread.ref.id}` : ''
    const row = requestDecisionRow(key, sessionId)
    if (!row) continue
    found.set(row, { ...(thread.evaluating.startedAt ? { since: thread.evaluating.startedAt } : {}),
      ...(thread.evaluating.delivered ?? thread.evaluating.startedAt
        ? { at: thread.evaluating.delivered ?? thread.evaluating.startedAt! } : {}) })
  }
  return found
}

/** 出站类型，与 `core/ports.ts` 的 `OutboundMessage.kind` 同名同域。 */
export type ReplyKind = 'acknowledgement' | 'reply' | 'notice'

/**
 * 这条回话能不能当「最终答复」。
 *
 * 只有**明确标了 `reply`** 的才算。历史行没有 kind → 不猜：一条 `acknowledgement` / `notice`
 * 与一条答复在没有类型时长得一模一样，按「大概是答复」处理正是 P0-1 的根因（接手回执被显示成
 * 已回复）。这类条目仍原样出现在时间线上（正文照常可读），只是不把消息收据推向 `replied`。
 * 存量行由部署期按 `outbox.id` == `replies.rkey` 精确补齐；补不上的继续表示「类型未知」。
 */
function isFinalReply(item: TimelineItem): boolean {
  return item.reply_kind === 'reply'
}

/** 类型未知的历史回话（本列出现之前写的，或写入方没标）：正文可读，但不宣称已答复。 */
export function isLegacyReply(item: TimelineItem): boolean {
  return item.role === 'agent' && item.reply_kind === undefined
}

/** How long a sent message may still be withdrawn. Past this the crew has picked it up and withdrawing it lies. */
export const QUEUE_WINDOW_MS = 90_000

/** The parts of a gateway timeline entry this module reads. */
export type RequestState = 'accepted' | 'queued' | 'evaluating' | 'waiting' | 'processing' | 'waiting_for_person' | 'replied' | 'finished' | 'declined' | 'unknown'

export interface TimelineItem { id?: string; role?: string; request_id?: string; request_state?: RequestState; reply_to?: string; text?: string; at?: string; bot_id?: string
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
  ticket_ref?: string
  /**
   * 这条回话的出站类型（网关 `replies.kind`）。`acknowledgement` / `notice` **不是**最终答复；
   * 字段缺席 = 本列出现之前写的历史行，按老行为当作答复（不猜、不改写历史）。
   */
  reply_kind?: ReplyKind
  /** 这条人的消息所属请求此刻在干什么（易失，见 activity.ts）；已结束/说不出来就缺席。 */
  activity?: Activity }

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

/** Whether the gateway supplied enough read evidence to treat `queued` as a complete withdrawable set. */
export function queuedStateOf(items: readonly TimelineItem[]): 'live' | 'unknown' {
  const requests = items.filter(item => item.role === 'user' && typeof item.request_id === 'string' && item.request_id && !item.withdrawn)
  return requests.some(item => typeof item.id !== 'string' || !item.id || typeof item.read_at !== 'string') ? 'unknown' : 'live'
}

/**
 * The request ids the gateway currently permits withdrawing: it reports read_at as empty, the message is present and
 * unwithdrawn, and no reply points back to it. Message age is not evidence of whether the queue consumed it.
 */
export function queuedRequests(items: readonly TimelineItem[]): string[] {
  // 回执也一样占住「已被队伍接住」：一条已经回执过的消息不该还能撤回（撤回会与真实执行对不上）。
  const answered = new Set(items.filter(item => item.role === 'agent')
    .map(item => item.reply_to).filter((id): id is string => typeof id === 'string'))
  return [...new Set(items
    .filter(item => item.role === 'user' && typeof item.id === 'string' && item.id
      && typeof item.request_id === 'string' && item.request_id && item.read_at === ''
      && item.withdrawn !== true && !answered.has(item.id))
    .map(item => item.request_id!))]
}

/** Resolve only a team/mobile queue thread from this session; main also accepts the historic two-part key. */
function requestDecisionRow(key: string | undefined, sessionId: string): string | undefined {
  if (!key) return undefined
  const current = SESSION_THREAD.exec(key)
  if (current) return current[1] === sessionId ? current[2] : undefined
  if (sessionId !== DEFAULT_SESSION_ID) return undefined
  return /^(?:team|mobile):(\d+)$/.exec(key)?.[1]
}

/** Project each app request from its reply, the decision that reached its ticket, and the ticket's live stage. */
/**
 * 每一行队列消息的**最新有效决定**。
 *
 * 时间线条目与轻量活动端点共用这一份选择：两处都取「同一行上时间最靠后的那条决定」，
 * 不允许一边拿 accept、一边拿后来盖过它的 ignore/stop（那会把活跃票挂到已经作废的决定上）。
 */
export function latestDecisions(decisions: readonly {
  kind?: string; at?: string; threadKey?: string; ticketId?: string; reason?: readonly { code?: string }[]
}[], sessionId = DEFAULT_SESSION_ID): Map<string, { kind?: string; at: number; ticketId?: string; answeredDirectly?: boolean }> {
  const byRow = new Map<string, { kind?: string; at: number; ticketId?: string; answeredDirectly?: boolean }>()
  for (const decision of decisions) {
    const row = requestDecisionRow(decision.threadKey, sessionId)
    const at = Date.parse(decision.at ?? '')
    if (!row || !Number.isFinite(at) || (byRow.get(row)?.at ?? -Infinity) >= at) continue
    byRow.set(row, { kind: decision.kind, at, ...(decision.ticketId ? { ticketId: decision.ticketId } : {}),
      ...(decision.reason?.some(reason => reason.code === 'answeredDirectly') ? { answeredDirectly: true } : {}) })
  }
  return byRow
}

export function withRequestStates<T extends Ticket>(items: readonly TimelineItem[], tickets: readonly T[], decisions: readonly {
  kind?: string; at?: string; threadKey?: string; ticketId?: string; reason?: readonly { code?: string }[]
}[], sessionId = DEFAULT_SESSION_ID, evaluating: ReadonlySet<string> = new Set()): TimelineItem[] {
  // 只有**最终答复**才算答过：一句回执（acknowledgement）或通知（notice）不终结这条消息的状态，
  // 否则「收到」会被显示成「已回复」，中间那段执行活动永远没有展示窗口（P0-1）。
  const replies = new Set(items.filter(item => item.role === 'agent' && isFinalReply(item))
    .map(item => item.reply_to).filter((id): id is string => typeof id === 'string'))
  const byRow = latestDecisions(decisions, sessionId)
  const byTicket = new Map(tickets.map(ticket => [ticket.id, ticket]))
  return items.map(item => {
    if (item.role !== 'user' || typeof item.request_id !== 'string' || !item.request_id) return item
    if (item.withdrawn) return { ...item, request_state: 'declined' }
    if (typeof item.id !== 'string' || !item.id) return { ...item, request_state: 'unknown' }
    if (replies.has(item.id)) return { ...item, request_state: 'replied' }
    const row = /^m(\d+)$/.exec(item.id)?.[1]
    const decision = row ? byRow.get(row) : undefined
    const messageAt = Date.parse(item.at ?? '')
    const currentDecision = decision && (!Number.isFinite(messageAt) || decision.at >= messageAt) ? decision : undefined
    if (currentDecision?.kind === 'ignore') return { ...item, request_state: currentDecision.answeredDirectly ? 'waiting' : 'declined' }
    if (currentDecision?.kind === 'stop') return { ...item, request_state: 'finished' }
    const ticket = currentDecision?.ticketId ? byTicket.get(currentDecision.ticketId) : undefined
    if (ticket) return { ...item, request_state: requestStateForTicket(ticket) }
    if (currentDecision?.kind === 'accept' || currentDecision?.kind === 'reopen') return { ...item, request_state: 'accepted' }
    if (typeof item.read_at !== 'string') return { ...item, request_state: 'unknown' }
    // 队伍读走了、还没形成决定，而线程正在评估：这是真实可达的 `evaluating`，不是编出来的词。
    if (item.read_at && row && evaluating.has(row)) return { ...item, request_state: 'evaluating' }
    return { ...item, request_state: item.read_at ? 'unknown' : 'queued' }
  })
}

function requestStateForTicket(ticket: Ticket): RequestState {
  if (ticket.ended) return 'finished'
  try {
    const stage = ticketStage(ticket)
    if (stage.stage === 'person') return 'waiting_for_person'
    if (stage.stage === 'ended') return 'finished'
    if (stage.stage === 'idle') return 'waiting'
    const assignment = latestAssignment(ticket)
    if (!assignment) return 'accepted'
    if (assignment.state === 'pending') return 'queued'
    if (assignment.state === 'ended') return 'waiting'
    if (assignment.report?.state === 'waiting') return 'waiting'
    if (assignment.report?.state === 'ready' || assignment.report?.state === 'blocked' || assignment.report?.state === 'failed') {
      return 'waiting_for_person'
    }
    if (assignment.idleAt && (!assignment.deliveredAt || assignment.deliveredAt <= assignment.idleAt)) return 'waiting'
    return assignment.state === 'running' ? 'processing' : 'unknown'
  } catch {
    return 'unknown'
  }
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
      // 会话名单：两条 exact route（GET 列出 / POST 登记），都指向同一个处理器，由 incoming.method 区分。
      // 宿主侧直接答，不转发到网关。
      connection.fetch.register({ path: '/api/mobile/sessions', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/sessions', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      // 设备接收链（#23）：GET peek 还欠哪些、POST ack 已持久化 + 记 seen。宿主侧直接答，不转发网关。
      connection.fetch.register({ path: '/api/mobile/notices', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/notices', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      // 审批答复：把「做吧/先别做」交给与 feishu `approvalReply` 同源的审批状态机。宿主侧直答，不转发网关。
      connection.fetch.register({ path: '/api/mobile/answer', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      // App 故障上报：POST 收一批、GET 看自己那台。两条 exact route，宿主侧直接答，不转发网关。
      connection.fetch.register({ path: '/api/mobile/diagnostics', methods: ['GET'], requestBody: 'buffered', fetch: handler }),
      connection.fetch.register({ path: '/api/mobile/diagnostics', methods: ['POST'], requestBody: 'buffered', fetch: handler }),
    ]
    child.effect(() => async () => { await Promise.all(disposers.map(dispose => dispose())) })
  })
}
