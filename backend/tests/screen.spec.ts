import { describe, expect, it } from 'vitest'
import { maskSecrets, screenOf, type ScreenEvent } from '../src/app/screen.ts'

const at = '2026-11-10T10:00:00.000Z'

describe('screenOf', () => {
  it('says why there is nothing to show instead of inventing a screen', () => {
    expect(screenOf({})).toMatchObject({ state: 'unavailable', reason: '没有指定是哪张工单' })
    expect(screenOf({ ticketId: 'tk1' })).toMatchObject({ state: 'unavailable', reason: '这张工单还没有可读的执行记录' })
    expect(screenOf({ ticketId: 'tk1', events: [{ type: 'unknown/type', time: at }] }))
      .toMatchObject({ state: 'unavailable', reason: '执行记录里没有可显示的内容' })
  })

  it('turns the session events into commands, output, speech and status', () => {
    const events: ScreenEvent[] = [
      { type: 'turn/start', time: at },
      { type: 'tool/call', time: at, data: { name: 'bash', arguments: { command: 'ls -la' } } },
      { type: 'tool/result', time: at, data: { message: { content: [{ type: 'text', text: 'total 0' }] } } },
      { type: 'assistant/message', time: at, data: { content: [{ type: 'text', text: '看完了' }] } },
      { type: 'turn/end', time: at },
    ]
    const view = screenOf({ ticketId: 'tk1', events, cwd: '/tmp/work' })
    expect(view).toMatchObject({ state: 'live', kind: 'terminal', ticket_id: 'tk1', live: true, cwd: '/tmp/work' })
    expect(view.lines?.map(line => line.kind)).toEqual(['status', 'command', 'output', 'said', 'status'])
    expect(view.lines?.[1]?.text).toBe('$ ls -la')
    expect(view.lines?.[2]?.text).toBe('total 0')
  })

  it('keeps only the last events asked for', () => {
    const events: ScreenEvent[] = Array.from({ length: 10 }, (_, index) => ({
      type: 'assistant/message', time: at, data: { text: `第 ${index} 句` },
    }))
    const view = screenOf({ ticketId: 'tk1', events, limit: 3 })
    expect(view.lines?.map(line => line.text)).toEqual(['第 7 句', '第 8 句', '第 9 句'])
  })

  it('masks credentials before they reach a phone', () => {
    expect(maskSecrets('API_KEY=sk-secret-value')).toBe('API_KEY=***')
    expect(maskSecrets('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer ***')
    expect(maskSecrets('GITHUB_TOKEN: ghp_123456')).toBe('GITHUB_TOKEN: ***')
    // 普通文本不动。
    expect(maskSecrets('普通输出 123')).toBe('普通输出 123')
  })

  it('reads a command out of arguments that arrive as a JSON string', () => {
    // 真实事件里 arguments 有时是一整段 JSON 字符串；原样 stringify 会把说明文字也算进命令行。
    const events: ScreenEvent[] = [{
      type: 'tool/call', time: at,
      data: { name: 'bash', arguments: '{"description":"Read README","command":"head -5 README.md"}' },
    }]
    expect(screenOf({ ticketId: 'tk1', events }).lines?.[0]?.text).toBe('$ head -5 README.md')
    // 解不出 command 时保留原文，不吞掉线索。
    expect(screenOf({ ticketId: 'tk1', events: [{ type: 'tool/call', time: at, data: { arguments: 'ls -la' } }] })
      .lines?.[0]?.text).toBe('$ ls -la')
  })

  it('caps one line instead of sending a whole build log', () => {
    const view = screenOf({ ticketId: 'tk1', events: [{
      type: 'tool/result', time: at, data: { message: { content: [{ type: 'text', text: 'x'.repeat(2000) }] } },
    }] })
    expect(view.lines?.[0]?.text.length).toBeLessThanOrEqual(501)
    expect(view.lines?.[0]?.text.endsWith('…')).toBe(true)
  })
})
