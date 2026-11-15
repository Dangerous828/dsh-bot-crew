/**
 * #21 就绪度探针（独立审查用，不改任何共享/生产路径）。
 *
 * 这个测试不模拟「假集成」：它把 `sessions.ts:workOnly` 里那条真实闸门原样拿出来验——
 *   1. `allowedTools(connections)` 只根据**设置里的 connections** 生成候选工具名；
 *   2. worker 真正能拿到的，是 `候选 ∩ 宿主真的注册过的 MCP 工具`（`agent.ctx.tools.get(name)`）；
 *   3. 调用那一刻再过 `judgeCall`：读 allow、写（readOnly）ask。
 *
 * 只要第 2 步的交集为空，配置写得再全也拿不到一个真工具——这正是当前 #21 的堵点：
 * WorkBuddy DS 宿主上实际注册的 MCP 服务器只有 dsh-sessions / hub_memory / magpie-image / tavily，
 * **没有 messages / shopping 服务器**。所以底座（分类/放行/审批）绿了也不等于端到端走通。
 *
 * 结论口径：本文件在「宿主有真 messages/shopping 工具」时会给出可走通的判定（正向即集成就绪的证据），
 * 在当前「宿主无这些工具」时给出 blocked + 唯一外部输入清单。测试本身恒绿，因为它断言的是**判定逻辑正确**，
 * 不是「集成已完成」。
 *
 * 审查附带发现的真实约束（不是本测试臆造，是 `allowedTools` 的实际行为）：
 *   只写 `{ kind, server }`（readTools 留空）的连接，`allowedTools` 只会产出**内置读白名单**那批工具；
 *   写工具（send_message / place_order …）**不会**自动出现，必须在 connections 条目里显式写进 `writeTools`。
 *   换言之，#21 要做「真写一次」，配置里必须显式声明写工具，否则连候选都生成不出来。
 */
import { describe, expect, it } from 'vitest'
import { allowedTools, connectionsOf, judgeCall, type ConnectionConfig } from '../src/app/connections.ts'

/**
 * 复刻 `sessions.ts:320` 的过滤：`[...WORK_TOOLS, ...configured].filter(n => host.tools.get(n))`。
 * 这里只关心 connection 那部分，故直接对 `allowedTools` 结果按宿主工具表过滤。
 */
function reachableTools(config: ConnectionConfig, hostTools: ReadonlySet<string>): string[] {
  return allowedTools(config).filter(name => hostTools.has(name))
}

/** 当前 WorkBuddy DS 宿主实际注册的 MCP 工具（来自 magpie find_tools 的真实清单；无 messages/shopping）。 */
const LIVE_HOST_TOOLS: ReadonlySet<string> = new Set([
  'mcp__dsh-sessions__dsh_sessions_search', 'mcp__dsh-sessions__dsh_sessions_list',
  'mcp__dsh-sessions__dsh_sessions_events', 'mcp__dsh-sessions__dsh_sessions_read',
  'mcp__dsh-sessions__dsh_sessions_trace', 'mcp__dsh-sessions__dsh_sessions_stats',
  'mcp__magpie__hub_memory__hub_memory_search', 'mcp__magpie__hub_memory__hub_memory_get',
  'mcp__magpie__hub_memory__hub_memory_recent', 'mcp__magpie__hub_memory__hub_memory_list',
  'mcp__magpie-image__generate_image', 'mcp__magpie-image__generate_video', 'mcp__magpie-image__generation_result',
  'mcp__tavily__tavily_search', 'mcp__tavily__tavily_extract', 'mcp__tavily__tavily_crawl',
  'mcp__tavily__tavily_map', 'mcp__tavily__tavily_research',
])

/** 当前 settings.connections 实测值（#10/#21 复核：一个都没配）。 */
const LIVE_SETTINGS_CONNECTIONS = { connections: [] as unknown[], readOnly: true }

describe('#21 端到端就绪度判定', () => {
  it('当前真实状态：即使把 messages/shopping 配进 connections，宿主未注册也拿不到任何真工具 → blocked', () => {
    // 假设有人在面板里把两类都配全（最乐观的配置，写工具也显式声明）。
    const configured = connectionsOf({
      readOnly: true,
      connections: [
        { kind: 'messages', server: 'im', readTools: ['list_channels', 'get_message'], writeTools: ['send_message'] },
        { kind: 'shopping', server: 'shop', readTools: ['search_products'], writeTools: ['place_order'] },
      ],
    })
    // 候选工具名是生成了的……
    expect(allowedTools(configured)).toContain('mcp__im__send_message')
    expect(allowedTools(configured)).toContain('mcp__shop__place_order')
    // ……但宿主没注册，交集为空：worker 一个也拿不到。集成不可能走通。
    expect(reachableTools(configured, LIVE_HOST_TOOLS)).toEqual([])
  })

  it('真实约束：只写 {kind,server} 未声明 writeTools 时，写工具根本不是候选（真写一次会落空）', () => {
    const bare = connectionsOf({ readOnly: true, connections: [{ kind: 'messages', server: 'im', readTools: [] }] })
    // 内置读白名单给了读工具，但没给写工具。
    expect(allowedTools(bare)).toContain('mcp__im__list_channels')
    expect(allowedTools(bare)).not.toContain('mcp__im__send_message')
  })

  it('真实约束：一旦显式声明任一工具，内置读白名单整批失效——读也必须显式列出', () => {
    // 只声明了写工具、没声明读工具：结果只剩写工具，读工具（list_channels）反而丢了。
    const writeOnly = connectionsOf({ readOnly: true, connections: [{ kind: 'messages', server: 'im', readTools: [], writeTools: ['send_message'] }] })
    expect(allowedTools(writeOnly)).toEqual(['mcp__im__send_message'])
    expect(allowedTools(writeOnly)).not.toContain('mcp__im__list_channels')
  })

  it('当前真实状态：官方 connections 为空，两个方向都没候选', () => {
    const live = connectionsOf(LIVE_SETTINGS_CONNECTIONS)
    expect(live.connections).toEqual([])
    expect(allowedTools(live)).toEqual([])
    expect(reachableTools(live, LIVE_HOST_TOOLS)).toEqual([])
  })

  it('正向：一旦宿主真的挂了 messages 服务器，读放行、写需审批，端到端即可走通', () => {
    // 这是「外部输入到位后」的期望行为——给出可走的判定，作为验收对照。
    const hostTools: ReadonlySet<string> = new Set([
      'mcp__im__list_channels', 'mcp__im__send_message', 'mcp__im__get_message',
    ])
    const configured = connectionsOf({
      readOnly: true,
      connections: [{ kind: 'messages', server: 'im', readTools: ['list_channels', 'get_message'], writeTools: ['send_message'] }],
    })
    const reachable = reachableTools(configured, hostTools)
    // 读 + 写两个工具都在可及集合里（写要靠审批放行，所以白名单也得给得出它）。
    expect(reachable).toContain('mcp__im__list_channels')
    expect(reachable).toContain('mcp__im__send_message')
    // 读直接放行：
    expect(judgeCall(configured, 'im', 'list_channels')).toMatchObject({ action: 'allow', kind: 'messages' })
    // 写必须停下问人：
    expect(judgeCall(configured, 'im', 'send_message')).toMatchObject({ action: 'ask', kind: 'messages' })
  })

  it('正向：shopping 同理——search 放行，place_order 需审批', () => {
    const hostTools: ReadonlySet<string> = new Set(['mcp__shop__search_products', 'mcp__shop__place_order'])
    const configured = connectionsOf({
      readOnly: true,
      connections: [{ kind: 'shopping', server: 'shop', readTools: ['search_products'], writeTools: ['place_order'] }],
    })
    expect(reachableTools(configured, hostTools)).toEqual(
      expect.arrayContaining(['mcp__shop__search_products', 'mcp__shop__place_order']),
    )
    expect(judgeCall(configured, 'shop', 'search_products').action).toBe('allow')
    expect(judgeCall(configured, 'shop', 'place_order').action).toBe('ask')
  })
})
