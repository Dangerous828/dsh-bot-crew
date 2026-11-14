/**
 * 收件箱的「要不要提醒」判定（issue #23 第 1 项）。
 *
 * 这一份是**纯判定**：没有 IO、不碰 IMAP、不认识凭据。真实邮箱接进来时，
 * 只需要有人实现 `MailPort.fetch()`（一次拉取一段窗口内的信），判定与去重都在这里。
 *
 * 为什么先写判定而不是先接邮箱：issue 的原话是「不许全量轰炸」。一个能把每封新邮件
 * 都弹到手机上的监听器，比没有监听器更糟 —— 人两天就会关掉通知，然后连该看的那封
 * 也一起错过。所以先把「什么算值得打断人」定下来，接账号只是换掉 `fetch` 的实现。
 *
 * 判定顺序是有讲究的：**噪声 → 已处理 → 与我的关系 → 急迫度**。
 * 先排除 newsletter 与自动回复，再排除我回过或只是被抄送的，最后才在剩下的信里
 * 挑「有时限 > 要决策 > 直接找我」。前两类是「不值得说」，后三类是「值得说，
 * 按急迫度排序」，混在一起判就会出现「促销邮件因为标题里有『截止』被当成急事」。
 */
import type { Notice } from './notices-out.ts'

/** 判定用的邮件形状。字段名按 IMAP / Gmail / 各家 MCP 都能给的公共子集挑。 */
export interface MailMessage {
  /** 邮件的 Message-ID。去重的唯一依据；缺了会退回「发件人+主题+时间」的合成键。 */
  messageId: string
  /** 原始 `From` 头，允许 `名字 <地址>` 形态。 */
  from: string
  subject: string
  /** 收信时间，ISO 字符串。 */
  receivedAt: string
  /** 全部收件人（To + Cc）。 */
  to: readonly string[]
  /**
   * 我是否在 To 里（而不是只在 Cc 里）。
   * 不给时按「只有一个收件人」推断 —— 群发到一串人的信不该按「直接找我」处理。
   */
  directTo?: boolean
  /** 未读。已读的信不弹窗：人已经打开过了，再弹一次是重复。
   *  （已读未回的信仍然值得看，那归晨报的「待处理」，不归实时提醒。） */
  unread?: boolean
  /** 我是否已经回过这封信。回过就不再提醒 —— 提醒一条已经办完的事是在占人时间。 */
  replied?: boolean
  /** `List-Id` / `List-Unsubscribe` 之类，有值即邮件列表。 */
  listId?: string
  /** 服务端标签，用于识别 Gmail 的 `CATEGORY_*` 这类批量分类。 */
  labels?: readonly string[]
  /** `Auto-Submitted` 头，自动回复是 `auto-replied`。 */
  autoSubmitted?: string
  /** `Precedence` 头，群发是 `bulk` / `list` / `junk`。 */
  precedence?: string
}

/** 判定结论。`reason` 是给人看的解释，也是单测的断言点 —— 只回布尔值的话，
 *  「为什么不提醒」在排障时只能靠猜。 */
export interface MailVerdict {
  notify: boolean
  reason: 'duplicate' | 'list' | 'automated' | 'newsletter' | 'replied' | 'read' | 'not-direct'
    | 'deadline' | 'decision' | 'direct'
}

/**
 * 多新才算「现在就该说」。
 *
 * 超过这个窗口的信不再逐封弹窗：开机补拉一整夜的信时，逐封提醒就是轰炸。
 * 它们进晨报的「待处理」，人在早上一次看完。
 */
export const MAIL_FRESH_MS = 3600_000

/** 自动发信人的本地部分。这些地址背后没有人等我回话。 */
const AUTOMATED = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|bounces?|mailer-daemon|postmaster|alerts?|newsletter|marketing|digest|updates?|bot|automated)([+._@-]|$)/i

/** 有时限：这类词一出现，人需要现在就决定要不要放下手上的事。 */
const DEADLINE = /(今天|今晚|明早|明天前|下班前|截止|过期|最后期限|尽快|马上|立刻|asap|eod|deadline|by (today|tomorrow|eod)|expires?)/i

/** 要我决策：出现这些词说明对面在等我表态，而不是在给我通报。 */
const DECISION = /(哪[版个条种]|你(来)?定|要不要|行不行|可以吗|能不能|是否|确认一下|帮我选|定一下|decide|confirm|approve|which one|shall we|can you)/i

/** 把 `名字 <地址>` 里的地址取出来；取不到就原样返回，判定只用到本地部分与域名。 */
export function addressOf(from: string): string {
  const angled = /<([^>]+)>/.exec(from)
  return (angled?.[1] ?? from).trim().toLowerCase()
}

/** 这封信是不是群发到一串人（而不是单独写给我）。 */
function direct(mail: MailMessage): boolean {
  if (mail.directTo !== undefined) return mail.directTo
  return mail.to.length === 1
}

/**
 * 去重键：同一条邮件只提醒一次。
 *
 * Message-ID 在不同来源回显时大小写与尖括号会变（IMAP 原样、MCP 有时剥掉括号），
 * 所以先归一化再比；缺 Message-ID 时退回「发件人 + 主题 + 收信时间」——
 * 三样都相同的两封信，在人的感受里就是同一封。
 */
export function mailDedupKey(mail: Pick<MailMessage, 'messageId' | 'from' | 'subject' | 'receivedAt'>): string {
  const id = mail.messageId.trim().toLowerCase().replace(/^</, '').replace(/>$/, '')
  if (id) return id
  return `${addressOf(mail.from)}|${mail.subject.trim().toLowerCase()}|${mail.receivedAt}`
}

/**
 * 一封邮件该不该提醒。
 *
 * `seen` 传「已经提醒过的去重键」判定器；不传就只判规则、不判重复。
 */
export function judgeMail(mail: MailMessage, seen: (key: string) => boolean = () => false): MailVerdict {
  if (seen(mailDedupKey(mail))) return { notify: false, reason: 'duplicate' }
  // 噪声先排除：后面几条判断的是「该不该说」，而这几类根本不在「要说」的集合里。
  if (mail.listId) return { notify: false, reason: 'list' }
  if (mail.autoSubmitted && mail.autoSubmitted.toLowerCase() !== 'no') return { notify: false, reason: 'automated' }
  if (mail.precedence && /^(bulk|list|junk)$/i.test(mail.precedence)) return { notify: false, reason: 'automated' }
  if (AUTOMATED.test(addressOf(mail.from))) return { notify: false, reason: 'automated' }
  if ((mail.labels ?? []).some(label => /^(CATEGORY_PROMOTIONS|CATEGORY_SOCIAL|CATEGORY_FORUMS|SPAM|TRASH)$/i.test(label))) {
    return { notify: false, reason: 'newsletter' }
  }
  // 已处理过的不再打扰：回过的信是办完的事，读过的信至少已经到过眼前。
  if (mail.replied) return { notify: false, reason: 'replied' }
  if (mail.unread === false) return { notify: false, reason: 'read' }
  // 抄送是「给你留个底」，不是「等你动手」。
  if (!direct(mail)) return { notify: false, reason: 'not-direct' }
  // 到这里才轮到急迫度：同一封信可能既有时限词又要我决策，说更急的那条。
  if (DEADLINE.test(mail.subject)) return { notify: true, reason: 'deadline' }
  if (DECISION.test(mail.subject)) return { notify: true, reason: 'decision' }
  return { notify: true, reason: 'direct' }
}

/**
 * 真实邮箱的接入点。实现它的人只需要一次「拉取 since 之后收到的信」——
 * 用 IMAP 的 `SINCE`、Gmail 的 `q=after:`、或某个 MCP 的 list 都行，判定不关心。
 */
export interface MailPort {
  fetch(since: string, signal?: AbortSignal): Promise<readonly MailMessage[]>
}

export interface InboxState {
  /** 上次拉到哪里（ISO 时间）。首次监听用「现在」。 */
  since: string
  /** 已经提醒过的去重键。 */
  seen: readonly string[]
  now?: Date
}

export interface InboxScan {
  /** 该弹的通知，一封一条。 */
  notices: Notice[]
  /** 更新后的去重账本（只记真提醒过的）。 */
  seen: string[]
  /** 下一次拉取的起点：本窗口内最新的一封。 */
  cursor: string
  /** 值得提醒但已经过了新鲜窗口的信 —— 交给晨报的「待处理」，不弹窗。 */
  stale: MailMessage[]
}

/** 去重账本的上限。一千封信足够覆盖「同一条提醒两次」的实际风险，又不会无限长。 */
const SEEN_LIMIT = 1000

/** 提醒的标题与正文：先说谁写的、什么事，再说为什么打断你。 */
function mailNotice(mail: MailMessage, reason: MailVerdict['reason']): Notice {
  const who = mail.from.replace(/<[^>]*>/, '').trim() || addressOf(mail.from)
  const why = reason === 'deadline' ? '有时限' : reason === 'decision' ? '等你定' : '直接找你'
  return {
    title: `${who} 来信：${mail.subject}`.slice(0, 80),
    body: `${why} · ${mail.receivedAt.slice(0, 16).replace('T', ' ')}`,
    kind: 'mail',
  }
}

/**
 * 扫一遍收件箱窗口。判定、去重、游标三件事都在这里收口，
 * 于是接真实邮箱时不会出现「判定改了一套、去重又写了一套」的分叉。
 */
export async function scanInbox(port: MailPort, state: InboxState): Promise<InboxScan> {
  const now = state.now ?? new Date()
  const mails = await port.fetch(state.since)
  const seen = new Set(state.seen)
  const fresh: string[] = []
  const notices: Notice[] = []
  const stale: MailMessage[] = []
  let cursor = state.since
  for (const mail of mails) {
    if (Date.parse(mail.receivedAt) > Date.parse(cursor)) cursor = mail.receivedAt
    const verdict = judgeMail(mail, key => seen.has(key))
    if (!verdict.notify) continue
    if (now.getTime() - Date.parse(mail.receivedAt) > MAIL_FRESH_MS) { stale.push(mail); continue }
    const key = mailDedupKey(mail)
    seen.add(key)
    fresh.push(key)
    notices.push(mailNotice(mail, verdict.reason))
  }
  // 只把新记的接在旧的后面：账本要保持「先提醒的在前」的顺序，方便排查。
  const merged = [...state.seen, ...fresh].slice(-SEEN_LIMIT)
  return { notices, seen: merged, cursor, stale }
}
