import { describe, expect, it } from 'vitest'
import { NativeActivityTracker, nativeActivityOf, type NativeActivityEvent } from '../src/app/native-activity.ts'

const start = Date.parse('2026-11-17T00:00:00Z')
const event = (seq: number, type: string, data: Record<string, unknown> = {}): NativeActivityEvent => ({ seq, time: start + seq * 100, type, data: { turn: 1, step: 1, ...data } })
const call = (seq: number, id: string, name = 'functions.read', extra = {}) => event(seq, 'tool/call', { callId: id, name, arguments: '{"file_path":"PRIVATE_ARGUMENT"}', ...extra })
const result = (seq: number, id: string, extra = {}) => event(seq, 'tool/result', { message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'PRIVATE_RESULT' }] }, ...extra })

describe('native Session activity, using SDK callId / message.toolCallId and epoch-millisecond time', () => {
  it('starts model only from a step boundary; assistant settlement does not imply another model call', () => {
    const tracker = new NativeActivityTracker()
    expect(tracker.snapshot()).toBeUndefined()
    tracker.observe(event(1, 'turn/start'))
    expect(tracker.snapshot()?.kind).toBe('unknown')
    tracker.observe(event(2, 'step/start'))
    expect(tracker.snapshot()).toMatchObject({ kind: 'model', since: new Date(start + 200).toISOString() })
    tracker.observe(event(3, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }] }, stream: [] }))
    expect(tracker.snapshot()?.kind).toBe('unknown')
    expect(JSON.stringify(tracker.snapshot())).not.toContain('PRIVATE_REASONING')
  })

  it('keeps parallel tools active until each real tool result arrives', () => {
    const tracker = new NativeActivityTracker()
    tracker.replay([event(1, 'turn/start'), event(2, 'step/start'), event(3, 'assistant/message'), call(4, 'a'), call(5, 'b', 'functions.bash')])
    expect(tracker.snapshot()).toMatchObject({ kind: 'tool', label: '并行执行工具' })
    tracker.observe(result(6, 'b'))
    expect(tracker.snapshot()).toMatchObject({ kind: 'tool', label: '读取文件', since: new Date(start + 400).toISOString() })
    tracker.observe(result(7, 'a'))
    expect(tracker.snapshot()?.kind).toBe('unknown')
    tracker.observe(event(8, 'step/end'))
    expect(tracker.snapshot()?.kind).toBe('idle')
    tracker.observe(event(9, 'step/start', { step: 2 }))
    expect(tracker.snapshot()?.kind).toBe('model')
  })

  it('ignores a delayed result from another step even when its call id was reused', () => {
    const tracker = new NativeActivityTracker()
    tracker.replay([event(1, 'step/start'), call(2, 'same'), event(3, 'step/end'), event(4, 'step/start', { step: 2 }), call(5, 'same', 'functions.edit', { step: 2 })])
    tracker.observe(result(6, 'same', { step: 1 }))
    expect(tracker.snapshot()).toMatchObject({ kind: 'tool', label: '修改文件' })
    tracker.observe(result(7, 'same', { step: 2 }))
    expect(tracker.snapshot()?.kind).not.toBe('tool')
  })

  it('does not revive a closed turn from delayed calls, and accepts an actual new turn', () => {
    const tracker = new NativeActivityTracker()
    tracker.replay([event(1, 'turn/start'), event(2, 'step/start'), call(3, 'a'), event(8, 'turn/end', { reason: { kind: 'interrupted' } })])
    tracker.observe(call(4, 'late'))
    tracker.observe(call(9, 'late-new-seq'))
    expect(tracker.snapshot()?.kind).toBe('idle')
    tracker.observe(event(10, 'turn/start', { turn: 2 }))
    tracker.observe(event(11, 'step/start', { turn: 2 }))
    expect(tracker.snapshot()?.kind).toBe('model')
  })

  it('keeps a truncated history closer closed instead of reviving that same turn', () => {
    const tracker = new NativeActivityTracker()
    tracker.observe(event(8, 'turn/end', { reason: { kind: 'interrupted' } }))
    tracker.observe(event(9, 'step/start'))
    expect(tracker.snapshot()?.kind).toBe('idle')
  })

  it('tracks backoff and recovery without making the reply or attempt body public', () => {
    const tracker = new NativeActivityTracker()
    tracker.replay([event(1, 'step/start'), event(2, 'llm/retry', { error: { message: 'PRIVATE_PROVIDER_ERROR' } })])
    expect(tracker.snapshot()).toMatchObject({ kind: 'retrying', since: new Date(start + 200).toISOString() })
    tracker.observe(event(3, 'llm/retry-started'))
    expect(tracker.snapshot()?.kind).toBe('retrying')
    tracker.observe(event(4, 'assistant/message', { message: { content: [{ text: 'PRIVATE_REASONING' }] } }))
    expect(tracker.snapshot()?.kind).not.toBe('retrying')
    expect(JSON.stringify(tracker.snapshot())).not.toMatch(/PRIVATE/)
  })

  it('replays by sequence, excludes another assignment, and preserves the supplied raw log', () => {
    const events = [event(8, 'turn/end', { reason: { kind: 'completed' } }), call(3, 'a'), event(2, 'step/start')]
    const before = JSON.stringify(events)
    expect(nativeActivityOf(events)?.kind).toBe('idle')
    expect(nativeActivityOf(events, { since: new Date(start + 900).toISOString() })).toBeUndefined()
    expect(JSON.stringify(events)).toBe(before)
  })

  it('retains long-running tool evidence without inventing an age-based completion', () => {
    const tracker = new NativeActivityTracker()
    tracker.replay([event(1, 'step/start'), call(2, 'long', 'mcp__h3__h3_generate_video')])
    expect(tracker.snapshot()).toMatchObject({ kind: 'tool', label: '生成视频', at: new Date(start + 200).toISOString() })
  })

  it('never copies raw tool names, arguments, result text or unknown event data into status', () => {
    const tracker = new NativeActivityTracker()
    tracker.replay([event(1, 'step/start'), call(2, 'a', 'PRIVATE_MALFORMED_<script>'), event(3, 'unknown/type', { secret: 'PRIVATE_UNKNOWN' })])
    expect(tracker.snapshot()).toMatchObject({ kind: 'tool', label: '执行工具' })
    expect(JSON.stringify(tracker.snapshot())).not.toMatch(/PRIVATE|script|arguments/)
  })
})
