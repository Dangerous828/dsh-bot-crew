/**
 * 记忆读写适配层。
 *
 * 不 fork dsh-auto-memory，不内置 Hub 地址或凭据。只做两件事：
 *   1. 把稳定事实按插件 1.3.0 的 frontmatter 格式渲染成本地 md，交给现成上行链路；
 *   2. 提供 recall 的形状，注入结果只是 worker 的输入片段。
 *
 * 分流规则见 docs/02-memory-bridge.md：Bot 碎碎念留本地，只有 owner 偏好 / 决策 /
 * 已关单结论上 Hub。
 */

export interface MemoryEvidence {
  quote: string
  source: string
}

/**
 * 插件 frontmatter 里出现过的 status。`candidate` 与 `verified` 照常注入；
 * `disabled` / `disputed` / `superseded` 一律不注入，见 injectable()。
 *
 * 这里必须能把后两个表示出来，否则 injectable() 里那两个分支永远走不到，
 * 一写「已作废」就只能删文件——而 docs/02 明确不做 hard delete。
 */
export type MemoryStatus = 'candidate' | 'verified' | 'disputed' | 'superseded'

export interface MemoryRecord {
  /** 建议 bot-<botId>-<slug> */
  name: string
  /** 单行标题。docs/02 实测落盘的文件里就有 `title:`，不渲染等于丢字段。 */
  title?: string
  /** 单行；多行 YAML 曾在桥接解析里丢过 */
  description: string
  body: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  status?: MemoryStatus
  importance?: number
  /** 是否允许上行到中枢 Hub */
  toHub: boolean
  dedupe_key: string
  supersedes?: string
  evidence?: MemoryEvidence
  created: number
  updated: number
}

export interface WriteTarget {
  /** 形如 <rootDir>/bot/lead/bot-lead-<slug>.md；不写死本机绝对路径。 */
  path: string
  content: string
}

/** 与插件同款的字段顺序；顺序稳定便于 diff。 */
const FRONTMATTER_KEYS = [
  'name', 'title', 'description', 'type', 'status', 'importance',
  'dedupe_key', 'supersedes', 'evidence', 'created', 'updated', 'disabled',
] as const

/**
 * YAML 1.1/1.2 会把这几个裸词解析成布尔或空值：`description: yes` 读回来是 `true`，
 * `description: null` 读回来是 null。字段静默变形，比报错更难查，所以一律加引号。
 */
const YAML_RESERVED = /^(?:y|yes|n|no|true|false|on|off|null|~)$/i

/** 长得像数字的字符串（`123` / `1.0` / `0x10` 等）同样会被解析成数字。 */
const NUMERIC_LIKE = /^[-+]?(?:\d[\d_]*\.?\d*(?:e[-+]?\d+)?|\d+:\d+)$/i

function formatValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  const text = String(value)
  // 会破坏 YAML 标量的：冒号、注释符、引号、流式括起来的符号、块指示符、`@` 与 `` ` `` 这两个保留首字符。
  // 行尾空格会让解析器把它当成续行的开头，也要引起来。
  const unsafe = /[:#\n"'{}[\]&*!|>%@`]/.test(text)
  return unsafe || YAML_RESERVED.test(text) || NUMERIC_LIKE.test(text) || text !== text.trimEnd()
    ? JSON.stringify(text)
    : text
}

/** 按插件同款 frontmatter 渲染；拒绝多行 description 与空正文。 */
export function renderMarkdown(record: MemoryRecord): string {
  if (record.description.includes('\n')) throw new Error('description must be a single line')
  if (record.title !== undefined && record.title.includes('\n')) throw new Error('title must be a single line')
  if (!record.body.trim()) throw new Error('body must not be empty')
  if (!record.dedupe_key) throw new Error('dedupe_key is required')
  const fields: Record<string, unknown> = {
    name: record.name,
    ...(record.title ? { title: record.title } : {}),
    description: record.description,
    type: record.type,
    status: record.status ?? 'candidate',
    importance: record.importance ?? 4,
    dedupe_key: record.dedupe_key,
    created: record.created,
    updated: record.updated,
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
    ...(record.evidence ? { evidence: record.evidence } : {}),
  }
  const lines = FRONTMATTER_KEYS
    .filter(key => fields[key] !== undefined)
    .map(key => `${key}: ${formatValue(fields[key])}`)
  return `---\n${lines.join('\n')}\n---\n\n${record.body.trim()}\n`
}

/** 记忆命名空间与落盘目录一一对应：bot/<botId> → <rootDir>/bot/<botId>/。 */
export function namespaceOf(botId: string): string {
  return `bot/${botId}`
}

/** 文件名：命名空间内的 slug，前缀 bot-<id>- 由 planWrite 保证，所以跨 namespace 也好认。 */
export function fileNameOf(_botId: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error('name produces an empty slug')
  return `${slug}.md`
}

export function targetPathOf(rootDir: string, botId: string, name: string): string {
  const dir = `${rootDir.replace(/\/+$/, '')}/${namespaceOf(botId)}`
  return `${dir}/${fileNameOf(botId, name)}`
}

/** 只在关单 / settled 时调用的落盘计划；真正的写入由宿主完成（原子写、查重）。 */
export function planWrite(rootDir: string, botId: string, record: MemoryRecord): WriteTarget {
  if (!record.name.startsWith(`bot-${botId}-`)) {
    throw new Error(`name must start with bot-${botId}- so the owning bot is visible outside its namespace`)
  }
  return { path: targetPathOf(rootDir, botId, record.name), content: renderMarkdown(record) }
}

/**
 * 哪些记忆不应注入：disabled / disputed / superseded 一律不进 worker 上下文。
 *
 * `disabled` 既可能是 frontmatter 里的布尔字段，也可能是 status 的取值，两种都认。
 */
export function injectable(record: { status?: string; disabled?: boolean }): boolean {
  if (record.disabled === true) return false
  const status = record.status
  return status !== 'disabled' && status !== 'disputed' && status !== 'superseded'
}

/** 单 Bot 每日上 Hub 的配额判断，防写爆中枢。 */
export function underDailyBudget(usedToday: number, limit: number): boolean {
  return usedToday < limit
}

export const DEFAULT_DAILY_HUB_LIMIT = 20

export const TODO = [
  'settle：原子写 + dedupe_key 查重（宿主实现）',
  'recall：本地 namespace 优先，Hub 注入受 maxChars 预算约束（宿主实现）',
  'Hub 上行走用户已有 local_dream dsh_memory 直通源，不二次蒸馏',
  '纠错写新条 + supersedes，不做 hard delete',
] as const
