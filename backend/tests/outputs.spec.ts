import { describe, expect, it, vi } from 'vitest'
import { countOutputs, outputsOf, outputsView, type OutputEvent } from '../src/app/outputs.ts'

const at = (minute: number) => `2026-11-11T10:${String(minute).padStart(2, '0')}:00.000Z`
const ticket = { id: 'tk1', title: '调开登录页间距', bot_id: 'coder', cwd: '/work/tk1' }

const wrote = (path: string, minute: number, tool = 'write'): OutputEvent =>
  ({ type: 'tool/call', time: at(minute), data: { name: tool, arguments: { file_path: path } } })

describe('outputsOf', () => {
  it('lists the files a worker wrote, newest first, one row per path', () => {
    const items = outputsOf(ticket, [
      wrote('src/login.tsx', 1), wrote('shots/375.png', 3), wrote('src/login.tsx', 5, 'edit'),
    ])
    expect(items.map(item => item.path)).toEqual(['src/login.tsx', 'shots/375.png'])
    // 同一个文件写了两次是一条产出，写了几次写在 writes 里。
    expect(items[0]).toMatchObject({ writes: 2, at: at(5), kind: 'file', title: 'login.tsx',
      id: 'tk1|src/login.tsx', ticket_id: 'tk1', bot_id: 'coder', cwd: '/work/tk1' })
    expect(items[1]).toMatchObject({ kind: 'image', title: '375.png', writes: 1 })
  })

  it('counts images apart from other files, which is what the result bar says', () => {
    const items = outputsOf(ticket, [wrote('a.ts', 1), wrote('b.png', 2), wrote('c.jpg', 3)])
    expect(countOutputs(items)).toEqual({ file: 1, image: 2 })
    expect(countOutputs([])).toEqual({ file: 0, image: 0 })
  })

  it('reads arguments that arrive as a JSON string, and the other names for a path', () => {
    const events: OutputEvent[] = [
      { type: 'tool/call', time: at(1), data: { name: 'write', arguments: '{"file_path":"a/b/c.md"}' } },
      { type: 'tool/call', time: at(2), data: { name: 'edit', arguments: { path: 'd.txt' } } },
    ]
    expect(outputsOf(ticket, events).map(item => item.path).sort()).toEqual(['a/b/c.md', 'd.txt'])
  })

  it('does not count reads, commands or unnamed tools as output', () => {
    // bash 里写的东西会话上看不出来是哪次写的哪个文件；不猜，也就不列。
    const events: OutputEvent[] = [
      { type: 'tool/call', time: at(1), data: { name: 'read', arguments: { path: 'a.ts' } } },
      { type: 'tool/call', time: at(2), data: { name: 'bash', arguments: { command: 'echo hi > a.ts' } } },
      { type: 'tool/call', time: at(3), data: { name: 'write', arguments: { content: 'no path' } } },
      { type: 'assistant/message', time: at(4), data: { text: '改完了' } },
    ]
    expect(outputsOf(ticket, events)).toEqual([])
  })

  it('drops the bot and cwd rather than sending empty strings', () => {
    const bare = outputsOf({ id: 'tk2', title: '无名' }, [wrote('x.ts', 1)])
    expect(bare[0]).not.toHaveProperty('bot_id')
    expect(bare[0]).not.toHaveProperty('cwd')
  })
})

describe('outputsView', () => {
  it('says live when there is something to show', async () => {
    const view = await outputsView([ticket], async () => [wrote('src/login.tsx', 1)])
    expect(view).toMatchObject({ state: 'live', counts: { file: 1, image: 0 } })
    expect(view.items).toHaveLength(1)
  })

  it('says empty only when the records were readable and hold no file change', async () => {
    // 「读得到、确实没有」和「读不到」是两句话，这一栏的分寸全在这条上。
    expect(await outputsView([ticket], async () => [])).toMatchObject({ state: 'empty', items: [] })
    expect(await outputsView([], async () => [])).toMatchObject({ state: 'empty', items: [] })
    const view = await outputsView([], async () => [])
    expect(view.reason).toContain('还没有工单')
  })

  it('says unavailable when every ticket could not be read', async () => {
    const view = await outputsView([ticket], async () => { throw new Error('no session') })
    expect(view).toMatchObject({ state: 'unavailable', items: [], counts: { file: 0, image: 0 } })
    expect(view.reason).toContain('读不出来')
  })

  it('keeps one unreadable ticket from sinking the rest, and says which part is missing', async () => {
    const read = vi.fn(async (id: string) => {
      if (id === 'tk2') throw new Error('recycled')
      return [wrote('a.ts', 1)]
    })
    const view = await outputsView([ticket, { id: 'tk2', title: '另一张' }], read)
    expect(view.state).toBe('live')
    expect(view.items).toHaveLength(1)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('caps the list rather than sending the whole workspace', async () => {
    const events = Array.from({ length: 100 }, (_, index) => wrote(`f${index}.ts`, index % 60))
    const view = await outputsView([ticket], async () => events, 10)
    expect(view.items).toHaveLength(10)
  })
})
