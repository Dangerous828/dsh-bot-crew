/**
 * 记忆账本的存储：KV 里一族键，一条记忆一行。
 *
 * 为什么不是新开一张 SQLite 表：记忆要跟着 stateDir 走（换机器、备份、拷给别的 profile 都在一处），
 * 而 KV 已经是「随 stateDir 一起搬」的东西。条目量在几千条以内，全量扫出来打分也只要几毫秒，
 * 上索引反而是给还没出现的问题付成本。
 *
 * 与 `src/core/memory.ts` 的 `MemoryRepositories` 无关：那是工单/裁决的领域仓库，这里是队伍的长期记忆。
 */
import { KV } from '../kv.ts'
import type { Store } from '../app/store.ts'
import type { Fact } from '../memory/settle.ts'
import { planWrite, renderMarkdown, type MemoryRecord } from '../memory/adapter.ts'
import type { MemoryEntry } from '../memory/recall.ts'

/** 一条记忆落成 `MemoryEntry` 时共用的时间基准（秒）。 */
const seconds = (): number => Math.floor(Date.now() / 1000)

export interface SettleInput {
  bot_id: string
  fact: Fact
  /** 谁写的：`person:<id>` / `ticket:<id>` / `host`。 */
  origin: string
  /** 从哪一轮提炼出来的，用于回查。 */
  source?: MemoryEntry['source']
}

export interface SettleResult {
  /** 这次调用真正落盘的条目；同一 dedupe_key 且内容未变时为空。 */
  written: MemoryEntry[]
  /** 被这次写入替代掉的旧条目名（`supersedes`）。 */
  superseded: string[]
}

/**
 * 记忆账本。
 *
 * 三件事：按 `dedupe_key` 查重（同一件事说两遍只留一条）、按 Bot 分命名空间、以及
 * 「忘掉」只翻状态不删行 —— 删掉就查不出「它曾经这么以为了」。
 */
export class MemoryLedger {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'delete' | 'atomic'>) {}

  /** 全部条目，新的在前；读不出来的那一条跳过，不让整本账读崩。 */
  all(): MemoryEntry[] {
    const entries: MemoryEntry[] = []
    for (const name of this.store.keys(KV.memory.entry)) {
      const entry = this.store.get(name as Parameters<typeof this.store.get>[0])
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry as unknown as MemoryEntry)
    }
    return entries.sort((left, right) => right.updated - left.updated)
  }

  /** 某位 Bot 的命名空间。 */
  ofBot(botId: string): MemoryEntry[] {
    return this.all().filter(entry => entry.bot_id === botId)
  }

  /**
   * 按 dedupe_key 找**这位 Bot 的**现有条目。
   *
   * 不能跨命名空间找：两位 Bot 都会记「主人要求先说结论」这类事，去重键天生会撞。
   * 跨着找的话，writer 记一条就把 lead 的那条当成同一件事给顶掉了 —— 记忆是按人分的。
   */
  byDedupeKey(botId: string, key: string): MemoryEntry | undefined {
    return this.all().find(entry => entry.bot_id === botId && entry.dedupe_key === key)
  }

  /**
   * 落一条事实。
   *
   * 三种情况：
   * - 没有同键的：新建；
   * - 有同键且正文一样：什么都不做（重试安全，账本不会因为同一条规矩说两遍就变长）；
   * - 有同键但正文变了：写新条，旧条标 `superseded`（不做硬删，见 adapter 的 TODO 第 4 条）。
   */
  settle(input: SettleInput): SettleResult {
    const { bot_id, fact, origin, source } = input
    const now = seconds()
    const existing = this.byDedupeKey(bot_id, fact.dedupe_key)
    const name = `bot-${bot_id}-${slug(fact.dedupe_key)}`
    if (existing && existing.name === name && existing.body === fact.body && existing.state === 'active') {
      return { written: [], superseded: [] }
    }
    const entry: MemoryEntry = {
      name,
      description: fact.description,
      body: fact.body,
      type: fact.type,
      status: 'candidate',
      importance: fact.importance,
      // 本地一条都不上 Hub：上行走用户已有的 local_dream dsh_memory 直通源，不在这一层二次蒸馏。
      toHub: false,
      dedupe_key: fact.dedupe_key,
      ...(existing && existing.name !== name ? { supersedes: existing.name } : {}),
      created: existing?.created ?? now,
      updated: now,
      bot_id,
      origin,
      ...(source ? { source } : {}),
      state: 'active',
    }
    const superseded: string[] = []
    this.store.atomic(() => {
      if (existing && existing.state === 'active' && existing.name !== name) {
        this.store.set(KV.memory.entry(existing.name), { ...existing, state: 'superseded', updated: now })
        superseded.push(existing.name)
      }
      this.store.set(KV.memory.entry(name), entry)
      // 同一 dedupe_key 换了 slug 的情况：旧键所指的名字要一并收掉，否则会留下两条 active。
      if (existing && existing.name !== name) this.store.delete(KV.memory.entry(existing.name))
    })
    return { written: [entry], superseded }
  }

  /** 主人说「忘掉这条」：翻状态，不删行。 */
  forget(name: string): boolean {
    const raw = this.store.get(KV.memory.entry(name) as Parameters<typeof this.store.get>[0])
    if (!raw || typeof raw !== 'object') return false
    this.store.set(KV.memory.entry(name), { ...(raw as MemoryEntry), state: 'forgotten', updated: seconds() })
    return true
  }

  /** 主人改了一条记忆的正文或描述。 */
  edit(name: string, patch: { description?: string; body?: string; importance?: number }): boolean {
    const raw = this.store.get(KV.memory.entry(name) as Parameters<typeof this.store.get>[0])
    if (!raw || typeof raw !== 'object') return false
    const entry = raw as MemoryEntry
    // 校验放在「用默认值兜底」之前：显式传了空串 / 多行，是调用方的错，不能悄悄拿旧值顶过去。
    if (patch.description !== undefined) {
      if (!patch.description.trim()) throw new Error('body must not be empty')
      if (patch.description.includes('\n')) throw new Error('description must be a single line')
    }
    if (patch.body !== undefined && !patch.body.trim()) throw new Error('body must not be empty')
    const description = patch.description?.trim() || entry.description
    const body = patch.body?.trim() || entry.body
    this.store.set(KV.memory.entry(name), { ...entry, description, body, updated: seconds(),
      ...(patch.importance === undefined ? {} : { importance: patch.importance }) })
    return true
  }

  /** 落成本地 md 的计划；`rootDir` 由运行时按 stateDir 给。 */
  plan(rootDir: string, entry: MemoryEntry): { path: string; content: string } {
    const record: MemoryRecord = { ...entry }
    return planWrite(rootDir, entry.bot_id, record)
  }

  /** 渲染成插件格式的 md；宿主不落盘时（测试、或 stateDir 不可写）也能给出要写的内容。 */
  render(entry: MemoryEntry): string {
    return renderMarkdown(entry)
  }
}

/** dedupe_key 转文件名的一部分：只留字母数字与短横线，别让「/」把路径带歪。 */
function slug(key: string): string {
  const cleaned = key.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'memory'
}
