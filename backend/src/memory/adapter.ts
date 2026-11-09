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

export interface MemoryRecord {
  /** 建议 bot-<botId>-<slug> */
  name: string
  /** 单行；多行 YAML 曾在桥接解析里丢过 */
  description: string
  body: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  status?: 'candidate' | 'verified'
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
  'name', 'description', 'type', 'status', 'importance',
  'dedupe_key', 'supersedes', 'evidence', 'created', 'updated', 'disabled',
] as const

function formatValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  const text = String(value)
  return /[:#\n"'{}[\]]/.test(text) ? JSON.stringify(text) : text
}

/** 按插件同款 frontmatter 渲染；拒绝多行 description 与空正文。 */
export function renderMarkdown(record: MemoryRecord): string {
  if (record.description.includes('\n')) throw new Error('description must be a single line')
  if (!record.body.trim()) throw new Error('body must not be empty')
  if (!record.dedupe_key) throw new Error('dedupe_key is required')
  const fields: Record<string, unknown> = {
    name: record.name,
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

/** 文件名：命名空间内的 slug，前缀 bot-<id>- 保证跨 namespace 也好认。 */
export function fileNameOf(botId: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error('name produces an empty slug')
  return botId ? `${slug}.md` : `${slug}.md`
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

/** 哪些记忆不应注入：disabled / disputed / superseded 一律不进 worker 上下文。 */
export function injectable(record: { status?: string; disabled?: boolean }): boolean {
  return record.disabled !== true && record.status !== 'disputed' && record.status !== 'superseded'
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
