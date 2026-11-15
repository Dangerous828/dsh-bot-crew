/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { PromptVersion } from './app/prompts.ts'
import type { RoutineRecord } from './app/routines.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id') },
  /**
   * Crew: how many messages have passed onto a ticket from a crew mate. Counted per ticket so a chain of bots talking to
   * each other ends, whichever side each turn comes from.
   */
  crew: { hop: family<number, [ticket: string]>('crew-hop:') },
  /**
   * 「常规任务」的账本：一条任务一个键。值就是账本里那一行（`RoutineRecord`），
   * 不含 `next_run` / `overdue` —— 那两个是读的时候按周期算出来的，不落盘，免得时间在库里走样。
   */
  routines: { task: family<RoutineRecord, [id: string]>('routines:task:') },
  /**
   * 记忆账本：一条记忆一个键，键是记忆名（`bot-<botId>-<slug>`）。
   * 与工单、会话都分开 —— 工单结束、会话归档，记忆还在。
   */
  memory: {
    entry: family<import('./memory/recall.ts').MemoryEntry, [name: string]>('memory:entry:'),
    /**
     * 每条记忆落 author md 时、管道会上传的远端 `dedupe_key` 历史（`sha256(pipelineContent)[:16]`）。
     * **只存 16hex，不存正文**：md 被删/内容不可读时，撤回仍能凭历史键向中枢原子占位（retract-tombstone），
     * 不依赖当前正文复算。一族一键，键同记忆名。
     */
    digests: family<string[], [name: string]>('memory:digests:'),
    /**
     * 撤回未完成的持久队列：撤回失败（中枢不可达/端点未就绪…）的记忆记在这里，
     * 下轮重试直到成功或用户再次 forget。键是记忆名，值是 `{ botId, digests, at, attempts, lastError }`。
     * 落 KV 而非进程内存：重启不该丢掉「远端还没撤干净」这条待办。
     */
    retractPending: family<import('./app/memory.ts').RetractPending, [name: string]>('memory:retract-pending:'),
  },
  /**
   * 跟进：每张票上一次提醒过的是哪种「没下文」（`kind:action`）。
   * 有值就说明提醒过；票有了新动静才清掉 —— 同一件事不该隔一会儿再问一遍。
   */
  followup: { reminded: family<string, [ticket: string]>('followup:reminded:') },
  /**
   * 收件箱 / 日历监听（issue #23）的账本，落库不落进程：重启不重报、游标不归零。
   *
   * - `mail.since`：收件箱拉到哪（ISO 时刻）；下一次从这里（减回看）接着拉。
   * - `mail.seen`：提醒过的去重键（`mailDedupKey`），有上限，防止同一封信提醒两次。
   * - `calendar.known`：每场会上轮指纹，用来判「改了 / 取消了」。
   * - `calendar.told`：每场会已经说过的类别键，一轮只说最急的一条。
   * 四个键分开：收件箱与日历是两条独立的监听，互不覆盖。
   */
  mail: { since: record<string>('mail-since'), seen: record<string[]>('mail-seen') },
  calendar: { known: record<Record<string, string>>('calendar-known'), told: record<Record<string, string[]>>('calendar-told') },
  /**
   * 设备接收链（#23）的已读账本，**按设备分键**、落库不落进程：进程重建后不重报。
   *
   * `notice.seen` 记的是「这台设备已经把哪些推送**落进它的本地存储**」（device-persisted），
   * 不是「人眼读过」。真实人眼阅读另证，不靠这个字段冒充。值是稳定 notice id 的有界列表，
   * 只增新 id、按上限裁旧段（见 `push.ts` 的 `seenLedgerPatch`）。additive，不动既有 families。
   *
   * `notice.pending` 是**待发留件的持久化桶**：设备 ACK 之前，尚未送达的通知按设备分键落在库里，
   * 不只在进程内存。backend HMR / 实例重建后靠这一族读回、不丢件（见 `push.ts` 的 `NoticeStore`
   * 与 `PushOutbox` 的磁盘口径）。值是这台设备的整桶待发件（稳定 id + 到期时刻 + 载荷）；每桶一键。
   * 只对新链以后入队的件生效 —— 更早那些只活在旧进程内存里的件没有来源，不在此列，也不假装恢复。
   */
  notice: { seen: family<string[], [deviceId: string]>('notice-seen:'),
    pending: family<import('./app/push.ts').Queued[], [deviceId: string]>('notice-pending:') },
  /**
   * 两份报告「今天说过了」的账，落在库里而不是进程里：重启不该让同一天再报一遍。
   *
   * 四个键而不是一个：它们**互相不能覆盖**。挤在一条记录里时，白天每派一次常规任务
   * 就会把「今天日报说过了」那一位一起写掉，于是当晚的日报被自己压掉 —— 这正是
   * 「一个字段装两件事」的老坑。
   *
   * - `daily`：日报说过的本地日。
   * - `morning`：早报说过的本地日，以及当天说过的「待处理」键
   *   （`onceToday` 那本账，`morningNotice` 原样交回，日报读同一本）。
   * - `routines`：当天真派出去的常规任务次数。以前是进程里的计数器，重启归零，
   *   于是重启后的日报会说「到点派了 1 次」而实际派了 5 次。
   * - `reported`：**报表已经统计到的那一刻**，两份报告共用的一条水位线。不能按「今天零点」
   *   或「昨晚 21 点」现算 —— 进程整夜不在线时那两段都没跑过，现算会把停机窗口整段丢掉。
   *   它只在报表真跑过一拍时前进，于是下一次报表的窗口天然覆盖「上次报完之后的一切」。
   */
  notices: {
    daily: record<string>('notices-daily'),
    morning: record<{ day: string; spoken: string[] }>('notices-morning'),
    routines: record<{ day: string; count: number }>('notices-routines'),
    reported: record<string>('notices-reported'),
  },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID).
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
  /**
   * 消息面（手机）按会话分的账（S1 契约第 4 节）。名单一条一个键，`main` 恒在读侧补在首位、不落键。
   * 「回话已读到哪」按会话分键：`main` 复用升级前的单键 `mobile-read-cursor`，
   * 这样老的无参调用仍读写原来那一份、已经存过的水位不丢；其余会话各占一个 `mobile-read-cursor:<id>`。
   */
  mobile: { sessions: family<true, [id: string]>('mobile-session:'),
    readCursor: family<string, [session: string]>('mobile-read-cursor', session => session === 'main' ? '' : `:${session}`) },
}
