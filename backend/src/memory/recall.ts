/**
 * recall：开口前只取相关的一小片记忆。
 *
 * 这里全是纯函数 —— 排序、打分、拼成注入片段，不碰数据库也不碰磁盘。
 * 存储（KV）在 `app/memory.ts`，渲染成 md 的格式在 `adapter.ts`。
 *
 * 为什么不用向量：记忆账本在几十到几千条的规模，一条记忆就是一句中文。
 * 中文没有空格可切，字符二元组足够认出「他喜欢先说结论」和「他说过先给结论」是同一件事，
 * 而不必在本机再拉一套 embedding 模型。召不回来最多是多说一句旧话，召回错了才是真的伤人。
 */
import type { MemoryRecord } from './adapter.ts'

/** 存进账本的一条：格式那层（`MemoryRecord`）+ 账本才关心的字段。 */
export interface MemoryEntry extends MemoryRecord {
  /** 这条记忆属于哪位 Bot；`bot/<botId>` 与落盘目录一致。 */
  bot_id: string
  /** 谁写的（人 / 某个 Bot / 宿主自己提炼）。 */
  origin?: string
  /** 宿主从哪一轮提炼出来的，用于回查。 */
  source?: { ticket_id?: string; session_id?: string; at?: string }
  /**
   * `active` 正常参与召回；`forgotten` 进了遗忘区（主人说忘掉、或末位淘汰前的候选）；
   * `superseded` 是被新条替代的旧条。
   *
   * `forgotten` / `superseded` 不参与召回与注入，但行先留着（能回查「它曾经这么以为」）。
   * 遗忘区里的条目超过 `FORGET_EVICT_MS` 且期间一次没被调起，才真正删行 —— 见 `evict()`。
   */
  state: 'active' | 'forgotten' | 'superseded'
  /** 进遗忘区的时间（秒）。末位淘汰以它为起点算 30 天。 */
  forgottenAt?: number
  /** 最近一次被召回为 worker 上下文的时间（秒）。遗忘区里被调起过就重新计时不淘汰。 */
  lastUsedAt?: number
}

/** 一条记忆能不能进 worker 的上下文。 */
export function usable(entry: Pick<MemoryEntry, 'state'>, extra: { disabled?: boolean } = {}): boolean {
  return entry.state === 'active' && extra.disabled !== true
}

/** 归一化：字母小写，只留汉字与字母数字（标点不参与打分，否则「，」会让两条不相干的记忆撞上）。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, '')
}

/**
 * 二元组指纹。
 *
 * 单个汉字太泛（「的」「我」满篇都是），整句又永远撞不上。两个字符一组是中文检索的老办法：
 * 「先给结论」→ 先给/给结/结论，与「先说结论」只差一组，仍然认得出来是一类事。
 * 只有 1 个字符的查询就退回那一个字。
 */
export function grams(text: string): string[] {
  const clean = normalize(text)
  if (clean.length <= 1) return clean ? [clean] : []
  const out: string[] = []
  for (let index = 0; index < clean.length - 1; index++) out.push(clean.slice(index, index + 2))
  return out
}

/** 一条记忆里参与检索的文字：标题 + 描述 + 正文。 */
function haystack(entry: MemoryEntry): string[] {
  return grams(`${entry.name} ${entry.description} ${entry.body}`)
}

/**
 * 意思上的相关度：查询的二元组有多少条命中。
 *
 * 用「命中数」而不是比值：查询短的时候比值会把一条只撞上一个词的记忆抬到 1.0。
 * 命中数会自然偏向覆盖得多的那条，这正是想要的。
 */
export function relevance(query: string, entry: MemoryEntry): number {
  const wanted = grams(query)
  if (!wanted.length) return 0
  const have = new Set(haystack(entry))
  let hits = 0
  for (const gram of new Set(wanted)) if (have.has(gram)) hits += 1
  return hits
}

/** 新鲜度：越近越靠前，一个月后基本拉平 —— 旧事实不该因为够久就永远排第一。 */
export function freshness(entry: Pick<MemoryEntry, 'updated'>, now = Date.now() / 1000): number {
  // 两端都用秒：`MemoryRecord.updated` 是秒（插件 frontmatter 的惯例），macOS 的 `Date.now()` 是毫秒。
  // 混着减会得到负七八位数的「年龄」，被 clamp 成 0 之后所有记忆都恒等新鲜 —— 打分里那一项就白算了。
  const ageSeconds = now - entry.updated
  if (!Number.isFinite(ageSeconds) || ageSeconds <= 0) return 1
  const days = ageSeconds / 86_400
  return 1 / (1 + days / 30)
}

/** 权重：相关度为主，新鲜度为辅；`importance`（1..5）只是同分时的次序。 */
export function score(query: string, entry: MemoryEntry, now = Date.now() / 1000): number {
  const relevant = relevance(query, entry)
  if (relevant <= 0) return 0
  const weight = (entry.importance ?? 4) / 5
  return relevant * (1 + freshness(entry, now) * 0.5) * (0.8 + weight * 0.4)
}

export interface RecallOptions {
  /** 只从这些 Bot 的命名空间里取；空数组表示全队。 */
  bots?: readonly string[]
  /** 取几条。默认 5。 */
  topK?: number
  /** 注入片段最多多少字。默认 1200 —— 比一次重放整段历史便宜两个数量级。 */
  maxChars?: number
  now?: number
}

export interface Recalled {
  entry: MemoryEntry
  score: number
}

/** 排序后的候选：只留 `state: active` 且真的相关（score > 0）的。 */
export function rank(entries: readonly MemoryEntry[], query: string, options: RecallOptions = {}): Recalled[] {
  const { bots, now = Date.now() / 1000 } = options
  const allowed = bots && bots.length ? new Set(bots) : undefined
  const ranked: Recalled[] = []
  for (const entry of entries) {
    if (!usable(entry)) continue
    if (allowed && !allowed.has(entry.bot_id)) continue
    const value = score(query, entry, now)
    if (value <= 0) continue
    ranked.push({ entry, score: value })
  }
  // 同分按更新时间新→旧；再同分按名字，保证两次召回的顺序一模一样（测试与日志才对得上）。
  ranked.sort((left, right) => right.score - left.score
    || right.entry.updated - left.entry.updated
    || left.entry.name.localeCompare(right.entry.name))
  return ranked
}

/** 一条记忆在注入片段里占的那几行。正文只取第一段：这一段是给 worker 看的提示，不是让人读的文档。 */
export function line(entry: MemoryEntry): string {
  const first = entry.body.split(/\n\s*\n/)[0]?.trim() ?? ''
  const brief = first.length > 160 ? `${first.slice(0, 160)}…` : first
  const who = entry.bot_id ? ` [${entry.bot_id}]` : ''
  return `- ${entry.description}${who}：${brief}`
}

/**
 * 拼成注入片段；放不下的整条丢掉，不截半句 —— 半句话比没有更误导。
 *
 * 返回的条目与片段一一对应，调用方据此记日志（取出了哪几条、占了多少字）。
 */
export function compose(recalled: readonly Recalled[], maxChars: number): { text: string; taken: MemoryEntry[]; chars: number } {
  const taken: MemoryEntry[] = []
  const lines: string[] = []
  let chars = 0
  for (const { entry } of recalled) {
    const candidate = line(entry)
    // 每行都按「换行 + 这一行」算，最后再减去一个换行。
    // 按字符数（code point）算，不是 String.length（UTF-16 单元）：中文一个字在两种数法下一样，
    // 但表情与生僻字会差一倍，预算就用不准。
    const cost = [...candidate].length + 1
    // 第一行不该被 +1 卡掉（0 + 38 + 1 > 38）；后面每行确实要占那个换行。
    if (lines.length ? chars + cost > maxChars : chars + cost - 1 > maxChars) continue
    lines.push(candidate)
    taken.push(entry)
    chars += cost
  }
  if (!taken.length) return { text: '', taken, chars: 0 }
  return { text: lines.join('\n'), taken, chars: chars - 1 }
}

/** 包在 worker 输入外面那两句话：说清这是队伍记得的事，不是这次的要求。 */
export function injectText(composed: { text: string }): string {
  if (!composed.text) return ''
  return `队伍记得这些（不是这次的要求，只用来补上下文；与本次请求冲突时以本次请求为准）：\n${composed.text}`
}
