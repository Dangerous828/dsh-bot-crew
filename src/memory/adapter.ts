/**
 * 阶段 3 骨架：记忆读写适配层。
 *
 * 不 fork dsh-auto-memory，不内置 Hub 地址或凭据。
 * 只做两件事：
 *   1. 把稳定事实按插件 1.3.0 的 frontmatter 格式写成本地 md（现成上行链路照旧搬运）；
 *   2. 提供 recall(bot_id, query) 的读取口，注入结果只是 worker 的输入片段。
 *
 * 分流规则见 docs/02-memory-bridge.md：Bot 碎碎念留本地，只有 owner 偏好 / 决策 /
 * 已关单结论上 Hub。
 */

export interface MemoryRecord {
  /** 建议 bot-<bot_id>-<slug> */
  name: string
  /** 单行，多行 YAML 曾在桥接解析里丢过 */
  description: string
  body: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  status?: 'candidate' | 'verified'
  importance?: number
  /** 是否允许上行到中枢 Hub */
  toHub: boolean
  dedupe_key: string
  supersedes?: string
  evidence?: { quote: string; source: string }
  created: number
  updated: number
}

export interface WriteTarget {
  /** 例：$DSH_HOME/memory/bot/lead/xxx.md。不写死本机绝对路径。 */
  path: string
  content: string
}

const FRONTMATTER_KEYS = [
  'name', 'description', 'type', 'status', 'importance',
  'dedupe_key', 'supersedes', 'evidence', 'created', 'updated', 'disabled',
] as const

/** 按插件同款 frontmatter 渲染；不写 secret，不接受多行 description。 */
export function renderMarkdown(rec: MemoryRecord): string {
  if (rec.description.includes('\n')) throw new Error('description must be a single line')
  const fm: Record<string, unknown> = {
    name: rec.name,
    description: rec.description,
    type: rec.type,
    status: rec.status ?? 'candidate',
    importance: rec.importance ?? 4,
    dedupe_key: rec.dedupe_key,
    created: rec.created,
    updated: rec.updated,
    ...(rec.supersedes ? { supersedes: rec.supersedes } : {}),
    ...(rec.evidence ? { evidence: rec.evidence } : {}),
  }
  // 只用宿主已解析的 YAML 库序列化；此处返回可解析的朴素形式
  const lines = FRONTMATTER_KEYS.filter((k) => fm[k] !== undefined)
    .map((k) => `${k}: ${formatValue(fm[k])}`)
  return `---\n${lines.join('\n')}\n---\n\n${rec.body.trim()}\n`
}

function formatValue(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'object') return JSON.stringify(v)
  const s = String(v)
  return /[:#\n"']/.test(s) ? JSON.stringify(s) : s
}

export interface MemoryBridgeOptions {
  /** $DSH_HOME/memory 根目录，由宿主注入 */
  rootDir: string
  /** 单 Bot 每日允许上 Hub 的条数上限，防写爆 */
  dailyHubLimit?: number
}

export interface MemoryBridge {
  /** 只在 Ticket settled / 关闭时调用；同 dedupe_key 幂等 */
  settle(botId: string, rec: MemoryRecord): Promise<WriteTarget>
  /** 先查 bot/<bot_id> 本地，再查 Hub（由宿主注入实现），结果只作为 worker 输入片段 */
  recall(botId: string, query: string, maxChars?: number): Promise<string[]>
}

/** 命名空间约定：Bot 本地与 Hub 全局分开，避免第三个真源。 */
export function namespaceOf(botId: string): string {
  return `bot/${botId}`
}

export const TODO = [
  'settle：拼路径 + 原子写 + dedupe_key 查重；toHub=true 才交给宿主上行实现',
  'recall：本地 namespace 优先，Hub 注入块受 maxChars 预算约束',
  'Hub 上行走用户已有 local_dream dsh_memory 直通源，不二次蒸馏',
  '纠错写新条 + supersedes，不做 hard delete',
  'disabled / disputed / superseded 不注入',
  '只在关单时写，避免半截事实；每日上 Hub 条数上限',
] as const
