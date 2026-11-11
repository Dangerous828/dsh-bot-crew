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
})

describe('allowedTools', () => {
  it('names the MCP tools this crew may reach', () => {
    expect(allowedTools(config)).toEqual(['mcp__mail__list_messages', 'mcp__mail__get_message', 'mcp__cal__list_events'])
  })

  it('keeps write tools reachable so the approval can happen at call time', () => {
    const withWrite = { connections: [{ ...mail, readTools: ['list_messages'], writeTools: ['send_message'] }], readOnly: true }
    expect(allowedTools(withWrite)).toContain('mcp__mail__send_message')
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
})
