import { describe, expect, it } from 'vitest'
import { handoffBody, splitHandoff } from '../src/crew/handoff.ts'

describe('a worker handing work to a teammate', () => {
  it('takes the handoff line out of what the person reads', () => {
    const { text, handoffs } = splitHandoff('这句我写不了，得写手来。\n@handoff scribbler: 给「墨匣」写一句 slogan')
    expect(text).toBe('这句我写不了，得写手来。')
    expect(handoffs).toEqual([{ bot_id: 'scribbler', note: '给「墨匣」写一句 slogan' }])
  })

  it('needs the marker on a line of its own', () => {
    // A person may be discussing this feature; prose must survive untouched.
    const prose = '用法是写一行 @handoff scribbler 这样，但我只说说而已。'
    expect(splitHandoff(prose)).toEqual({ text: prose, handoffs: [] })
  })

  it('reads the bot name case-insensitively and without a note', () => {
    expect(splitHandoff('好，转给码农。\n@handoff CODER').handoffs).toEqual([{ bot_id: 'coder', note: '' }])
  })

  it('keeps an underscored bot id whole', () => {
    // BOT_ID 允许下划线，这里截断会把工作交给一个不存在的 `coder`。
    expect(splitHandoff('@handoff coder_1: 改这段').handoffs).toEqual([{ bot_id: 'coder_1', note: '改这段' }])
  })

  it('collects several handoffs and keeps the rest of the reply', () => {
    const { text, handoffs } = splitHandoff('拆两半。\n@handoff scribbler: 文案\n中间一句\n@handoff coder: 代码')
    expect(handoffs.map(h => h.bot_id)).toEqual(['scribbler', 'coder'])
    expect(text).toBe('拆两半。\n中间一句')
  })

  it('names an unknown bot without refusing, leaving the check to the caller', () => {
    // Whether the roster knows the id is the host decision; the splitter only reads what was written.
    expect(splitHandoff('@handoff ghost: 谁').handoffs).toEqual([{ bot_id: 'ghost', note: '谁' }])
  })

  it('returns an empty reply when the worker only asked for a handoff', () => {
    expect(splitHandoff('@handoff scribbler: 写').text).toBe('')
  })

  it('leaves a reply with no handoff exactly as it was', () => {
    const plain = '在桌面建了 crew-phone.txt，内容 hello。\n已核对。'
    expect(splitHandoff(plain)).toEqual({ text: plain, handoffs: [] })
  })

  it('does not mistake the marker inside a word', () => {
    expect(splitHandoff('see @handoffs here').handoffs).toEqual([])
  })
})

describe('what a handed-off ticket asks for', () => {
  it('passes the note the worker wrote', () => {
    expect(handoffBody({ bot_id: 'scribbler', note: '写一句 slogan' }, '原文')).toBe('写一句 slogan')
  })

  it('falls back to the original request when the worker named only the bot', () => {
    expect(handoffBody({ bot_id: 'coder', note: '' }, '跑一下测试')).toBe('跑一下测试')
  })
})
