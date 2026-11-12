/**
 * 对外连接：邮箱、日历、文件。
 *
 * 这三样走的是 DSH 宿主的 MCP 桥（`dsh-mcp-client`）—— 宿主把每个 MCP 服务器的工具注册成
 * `mcp__<server>__<tool>`，这台队伍要做的是**决定哪些能直接用、哪些得先问人**。
 *
 * 为什么要单独一层，而不是把 MCP 工具名直接写进 worker 白名单：
 *
 * 1. **读过的不算做事**。读邮件、看日历、列目录是「看」，看完不改任何东西；
 *    让它每一次都停下来问人，等于把助手变回一个需要全程盯着的表单。
 * 2. **写一定要过审批**。发邮件、改日程、删文件是不可逆的（邮件发出去收不回），
 *    这类工具一律走第 3 期那套审批：命中就写成 `attention` 停下来。
 * 3. **认不出来的按写处理**。新接一个 MCP 服务器时，我们看不清它是读还是写；
 *    猜错的方向必须是「多问一次」，不能是「悄悄发了邮件」。
 *
 * 这一层不连网络、不持有凭据：凭据在宿主的 MCP 配置里，这里只管**分类与放行规则**。
 */

/** 一类对外能力。 */
export type ConnectionKind = 'mail' | 'calendar' | 'files'

/** 一次工具调用的性质。`write` 一律要过审批。 */
export type ToolNature = 'read' | 'write'

/** 一条连接：一个 MCP 服务器提供的、属于某一类的工具。 */
export interface Connection {
  kind: ConnectionKind
  /** 宿主里的 MCP 服务器名（工具名前缀 `mcp__<server>__`）。 */
  server: string
  /** 这个服务器上哪些工具算「读」。没列出的一律按「写」处理。 */
  readTools: readonly string[]
  /** 这个服务器上哪些工具算「写」。留空时表示「除 readTools 之外的都是写」。 */
  writeTools?: readonly string[]
}

/** 一份连接配置。 */
export interface ConnectionConfig {
  connections: readonly Connection[]
  /**
   * 总开关：只读模式。
   *
   * 打开时**所有写操作都要审批**（这是默认）。关掉它等于允许不审批就写 ——
   * 只有明确知道自己在做什么时才该关（例如一个只往草稿箱里放的邮箱账号）。
   */
  readOnly: boolean
}

/** 三类在界面上的叫法。与手机、桌面共用同一套字。 */
export const KIND_NAME: Readonly<Record<ConnectionKind, string>> = {
  mail: '邮箱',
  calendar: '日历',
  files: '文件',
}

/** 内置的白名单：常见 MCP 服务器上哪些工具是读。 */
const DEFAULT_READ: Readonly<Record<string, readonly string[]>> = {
  // 常见命名：list/get/search/read 是读；send/create/update/delete/move 是写。
  mail: ['list_messages', 'get_message', 'search_messages', 'list_labels', 'list_threads', 'get_thread'],
  calendar: ['list_events', 'get_event', 'list_calendars', 'search_events'],
  files: ['list_directory', 'read_file', 'search_files', 'stat', 'list_files'],
}

/**
 * 按工具名判它是读还是写。
 *
 * 配置里明确列了的以配置为准；没列的看名字 —— 但**默认落到 `write`**。
 * 这条默认值是刻意的：猜「读」猜错了会静默改掉东西，猜「写」猜错了只是多问一句。
 */
export function natureOf(connection: Connection, tool: string): ToolNature {
  if (connection.readTools.includes(tool)) return 'read'
  if (connection.writeTools?.includes(tool)) return 'write'
  if (connection.writeTools && connection.writeTools.length > 0) return 'write'
  // 没配 readTools 时用内置白名单兜底。
  if (connection.readTools.length === 0 && (DEFAULT_READ[connection.kind] ?? []).includes(tool)) return 'read'
  return 'write'
}

/** 一次调用放不放行。 */
export interface ConnectionVerdict {
  /** `allow` 直接做；`ask` 停下来等人点头；`deny` 这一版完全不接。 */
  action: 'allow' | 'ask' | 'deny'
  /** 给人看的一句话。`ask` 时原样显示。 */
  reason: string
  kind?: ConnectionKind
}

/**
 * 判一次调用。
 *
 * `readOnly` 打开时（默认）写操作一律 `ask` —— 这就是路线图说的「读先上，写必须过审批」。
 * 关掉时写操作 `allow`，但**仍然会记一行日志**：不审批不等于不记账。
 *
 * 找不到归属的连接 `deny`：一个不知道属于哪一类的工具，不该被 worker 拿到。
 */
export function judgeCall(config: ConnectionConfig, server: string, tool: string): ConnectionVerdict {
  const connection = config.connections.find(item => item.server === server)
  if (!connection) return { action: 'deny', reason: `没有接入 ${server} 这个服务器` }
  const nature = natureOf(connection, tool)
  const kind = connection.kind
  if (nature === 'read') return { action: 'allow', reason: '', kind }
  if (config.readOnly) {
    return { action: 'ask', kind, reason: `要通过${KIND_NAME[kind]}做改动（${tool}），先问你一声` }
  }
  return { action: 'allow', kind, reason: '' }
}

/**
 * worker 能用哪些 MCP 工具名。
 *
 * 只放行「读」的那一批 + 需要审批的那一批（审批在调用的那一刻做，不在拿工具的那一刻做）——
 * 所以这里返回的是**这个服务器上所有属于这条连接的工具**。真正拦人的是 `judgeCall`，
 * 白名单只负责把不属于这三类的东西挡在门外。
 */
export function allowedTools(config: ConnectionConfig): string[] {
  const names: string[] = []
  for (const connection of config.connections) {
    // 没列工具的连接吃内置读白名单，与 natureOf 的分类一致；显式配过就以配置为准。
    const explicit = connection.readTools.length > 0 || (connection.writeTools?.length ?? 0) > 0
    const reads = explicit ? connection.readTools : DEFAULT_READ[connection.kind] ?? []
    const tools = [...reads, ...(connection.writeTools ?? [])]
    for (const tool of tools) names.push(`mcp__${connection.server}__${tool}`)
  }
  return names
}

/** 从配置里读一份 `ConnectionConfig`；坏条目跳过，不让一条坏配置拖垮整支队伍。 */
export function connectionsOf(raw: unknown): ConnectionConfig {
  const source = raw as { connections?: unknown; readOnly?: unknown } | undefined
  const connections: Connection[] = []
  if (Array.isArray(source?.connections)) {
    for (const item of source.connections) {
      const entry = item as { kind?: unknown; server?: unknown; readTools?: unknown; writeTools?: unknown }
      const kind = entry.kind
      if (kind !== 'mail' && kind !== 'calendar' && kind !== 'files') continue
      if (typeof entry.server !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(entry.server)) continue
      const list = (value: unknown): string[] => Array.isArray(value)
        ? value.filter(name => typeof name === 'string' && name.length > 0) as string[] : []
      connections.push({
        kind, server: entry.server, readTools: list(entry.readTools),
        ...(entry.writeTools === undefined ? {} : { writeTools: list(entry.writeTools) }),
      })
    }
  }
  // 默认就是只读：写操作要审批，除非有人明确关掉。
  return { connections, readOnly: source?.readOnly === false ? false : true }
}
