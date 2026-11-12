import { describe, expect, it } from 'vitest'
import { allowedTools, connectionsOf, judgeCall, KIND_NAME, natureOf, type ConnectionConfig } from '../src/app/connections.ts'

const mail = { kind: 'mail' as const, server: 'mail', readTools: ['list_messages', 'get_message'] }
const calendar = { kind: 'calendar' as const, server: 'cal', readTools: ['list_events'] }
const config: ConnectionConfig = { connections: [mail, calendar], readOnly: true }

describe('natureOf', () => {
  it('takes the configured read list as read', () => {
    expect(natureOf(mail, 'list_messages')).toBe('read')
  })

  it('treats everything else on a configured server as a write', () => {
    // 猜「读」猜错了会静默改掉东西；猜「写」猜错了只是多问一句。
    expect(natureOf(mail, 'send_message')).toBe('write')
    expect(natureOf(mail, 'delete_thread')).toBe('write')
  })

  it('falls back to the built-in read names when a connection lists none', () => {
    const bare = { kind: 'files' as const, server: 'fs', readTools: [] }
    expect(natureOf(bare, 'read_file')).toBe('read')
    expect(natureOf(bare, 'delete_file')).toBe('write')
  })

  it('honours an explicit write list', () => {
    const explicit = { kind: 'files' as const, server: 'fs', readTools: ['read_file'], writeTools: ['write_file'] }
    expect(natureOf(explicit, 'write_file')).toBe('write')
    // 写了 writeTools 之后，没列出来的既不是读也不是写 —— 按写处理，因为默认落到最谨慎的那一侧。
    expect(natureOf(explicit, 'chmod_everything')).toBe('write')
  })
})

describe('judgeCall', () => {
  it('lets a read through without asking', () => {
    expect(judgeCall(config, 'mail', 'list_messages')).toEqual({ action: 'allow', reason: '', kind: 'mail' })
  })

  it('stops a write for a person to approve', () => {
    const verdict = judgeCall(config, 'mail', 'send_message')
    expect(verdict.action).toBe('ask')
    // 要说清是拿哪一样做什么：一句「需要审批」不告诉人要批什么。
    expect(verdict.reason).toContain('邮箱')
    expect(verdict.reason).toContain('send_message')
  })

  it('refuses a server this crew never connected', () => {
    expect(judgeCall(config, 'random-server', 'do_something')).toMatchObject({ action: 'deny' })
  })

  it('allows writes only when readOnly was turned off on purpose', () => {
    expect(judgeCall({ ...config, readOnly: false }, 'mail', 'send_message').action).toBe('allow')
    // 写放行了，读仍然是读：两者不该因为一个开关而混在一起。
    expect(judgeCall({ ...config, readOnly: false }, 'mail', 'get_message').action).toBe('allow')
  })

  it('names each kind in the words the apps use', () => {
    expect(KIND_NAME.mail).toBe('邮箱')
    expect(KIND_NAME.calendar).toBe('日历')
    expect(KIND_NAME.files).toBe('文件')
  })

  it('treats an unknown tool on a connected server as a write', () => {
    // 认不出来的工具按最谨慎的一侧处理：只读模式下停下来问，而不是悄悄放行。
    const verdict = judgeCall(config, 'mail', 'brand_new_tool')
    expect(verdict.action).toBe('ask')
    expect(verdict.reason).toContain('brand_new_tool')
  })

  it('re-judges from the current config each call, never reusing a past approval', () => {
    // 先把只读关掉放行写，再用原配置判：不能因为上一次放行过就记住那个决定。
    expect(judgeCall({ ...config, readOnly: false }, 'mail', 'send_message').action).toBe('allow')
    expect(judgeCall(config, 'mail', 'send_message').action).toBe('ask')
    // 服务器从配置里移除（断连 / 撤销接入）后，同一工具立刻变 deny。
    const removed: ConnectionConfig = { connections: [calendar], readOnly: true }
    expect(judgeCall(removed, 'mail', 'send_message')).toMatchObject({ action: 'deny' })
  })
})

describe('allowedTools', () => {
  it('names the MCP tools this crew may reach', () => {
    expect(allowedTools(config)).toEqual(['mcp__mail__list_messages', 'mcp__mail__get_message', 'mcp__cal__list_events'])
  })

  it('keeps write tools reachable so the approval can happen at call time', () => {
    const withWrite = { connections: [{ ...mail, readTools: ['list_messages'], writeTools: ['send_message'] }], readOnly: true }
    expect(allowedTools(withWrite)).toContain('mcp__mail__send_message')
  })

  it('makes the built-in read names reachable on a bare connection', () => {
    // 只写 { kind, server } 的连接：natureOf 认这些工具为读、judgeCall 放行，放行层也得给得出工具名。
    const bare: ConnectionConfig = { connections: [{ kind: 'mail', server: 'mail', readTools: [] }], readOnly: true }
    expect(natureOf(bare.connections[0]!, 'list_messages')).toBe('read')
    expect(judgeCall(bare, 'mail', 'list_messages').action).toBe('allow')
    expect(allowedTools(bare)).toContain('mcp__mail__list_messages')
  })

  it('does not leak built-in reads into a connection that listed only writes', () => {
    // 显式配过工具就以配置为准：与 natureOf 一致，别把没声明的读工具塞给 worker。
    const writesOnly: ConnectionConfig = { connections: [{ kind: 'mail', server: 'mail', readTools: [], writeTools: ['send_message'] }], readOnly: true }
    expect(allowedTools(writesOnly)).toEqual(['mcp__mail__send_message'])
  })
})

describe('connectionsOf', () => {
  it('defaults to read-only: a write has to be approved', () => {
    const parsed = connectionsOf({ connections: [{ kind: 'mail', server: 'mail', readTools: ['list_messages'] }] })
    expect(parsed.readOnly).toBe(true)
    expect(parsed.connections).toHaveLength(1)
  })

  it('only goes writable when it is turned off explicitly', () => {
    expect(connectionsOf({ connections: [], readOnly: false }).readOnly).toBe(false)
    expect(connectionsOf({ connections: [], readOnly: 'yes' }).readOnly).toBe(true)
  })

  it('skips a bad entry instead of losing the whole configuration', () => {
    const parsed = connectionsOf({ connections: [
      { kind: 'mail', server: 'mail', readTools: ['list_messages'] },
      { kind: 'printer', server: 'p', readTools: [] },
      { kind: 'files', server: 'has spaces', readTools: [] },
      { kind: 'files', server: 'fs', readTools: ['read_file', 42] },
    ] })
    expect(parsed.connections.map(item => item.server)).toEqual(['mail', 'fs'])
    // 坏元素被丢掉，好元素保留：一条坏配置不该让整支队伍失去所有对外能力。
    expect(parsed.connections[1]!.readTools).toEqual(['read_file'])
  })

  it('reads an empty configuration as no connections at all', () => {
    expect(connectionsOf(undefined).connections).toEqual([])
    expect(connectionsOf({}).connections).toEqual([])
  })

  it('keeps a minimal { kind, server } declaration', () => {
    // schema 的 readTools 默认 []：这种条目合法，靠内置白名单分类与放行。
    expect(connectionsOf({ connections: [{ kind: 'calendar', server: 'cal' }] }).connections)
      .toEqual([{ kind: 'calendar', server: 'cal', readTools: [] }])
  })
})

// Step 7 行动面扩展：新增的真实集成 kind（消息/购物/支付/订票）走同一套「读先上、写必审批」，
// 尤其支付/购物这类绝不能裸跑——readOnly 打开时写操作必须 ask，关掉才 allow。
describe('action-surface kinds (messages / shopping / payments / tickets)', () => {
  const kinds = [
    { kind: 'messages' as const, server: 'im', read: 'list_channels', write: 'send_message' },
    { kind: 'shopping' as const, server: 'shop', read: 'search_products', write: 'place_order' },
    { kind: 'payments' as const, server: 'pay', read: 'get_balance', write: 'transfer' },
    { kind: 'tickets' as const, server: 'rail', read: 'search_fares', write: 'book_ticket' },
  ]
  for (const k of kinds) {
    it(`treats ${k.kind} reads as allow and writes as ask under readOnly`, () => {
      const cfg: ConnectionConfig = { connections: [{ kind: k.kind, server: k.server, readTools: [] }], readOnly: true }
      // 没显式配 readTools 时吃内置白名单：约定里的读工具放行。
      expect(judgeCall(cfg, k.server, k.read)).toMatchObject({ action: 'allow', kind: k.kind })
      // 写（下单/转账/发消息/订票）要审批。
      expect(judgeCall(cfg, k.server, k.write)).toMatchObject({ action: 'ask', kind: k.kind })
    })
  }

  it('names each new kind in KIND_NAME so the panel and phone show a word', () => {
    for (const k of kinds) expect(KIND_NAME[k.kind]).toBeTruthy()
  })

  it('reads the new kinds back from settings and skips unknown ones', () => {
    const parsed = connectionsOf({ readOnly: true, connections: [
      { kind: 'payments', server: 'pay', readTools: ['get_balance'] },
      { kind: 'bogus', server: 'x', readTools: [] },
    ] })
    expect(parsed.connections.map(c => c.kind)).toEqual(['payments'])
  })
})
