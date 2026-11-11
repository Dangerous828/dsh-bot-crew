import { describe, expect, it } from 'vitest'
import { looksLikeWav, MAX_SECONDS, MAX_WAV_BYTES, transcribe, wavSeconds, type SpeechHost } from '../src/app/voice.ts'

/** 造一段最小的 WAV：44 字节头 + `seconds` 秒的静音。 */
function wav(seconds: number, sampleRate = 16_000, channels = 1, bits = 16): Uint8Array {
  const byteRate = sampleRate * channels * bits / 8
  const data = new Uint8Array(Math.round(byteRate * seconds))
  const buffer = new ArrayBuffer(44 + data.length)
  const view = new DataView(buffer)
  const write = (at: number, text: string): void => {
    for (let index = 0; index < text.length; index++) view.setUint8(at + index, text.charCodeAt(index))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + data.length, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, channels * bits / 8, true)
  view.setUint16(34, bits, true)
  write(36, 'data')
  view.setUint32(40, data.length, true)
  return new Uint8Array(buffer)
}

const host = (over: Partial<SpeechHost> = {}): SpeechHost => ({
  snapshot: () => ({ providers: [{ id: 'sensevoice' }], selection: { providerId: 'sensevoice', language: 'zh' } }),
  resolve: (request: unknown) => request,
  transcribe: async () => ({ text: '把卡顿修掉' }),
  ...over,
})

describe('looksLikeWav', () => {
  it('accepts real WAV and refuses everything else', () => {
    expect(looksLikeWav(wav(0.1))).toBe(true)
    expect(looksLikeWav(new Uint8Array([0x49, 0x44, 0x33, 0x04]))).toBe(false) // mp3 的 ID3 头
    expect(looksLikeWav(new TextEncoder().encode('not audio at all'))).toBe(false)
  })
})

describe('wavSeconds', () => {
  it('reads the duration from the header instead of guessing from bytes', () => {
    expect(wavSeconds(wav(2))).toBeCloseTo(2, 2)
    // 同样是 2 秒，采样率翻倍字节数就翻倍：按字节估会错一倍。
    expect(wavSeconds(wav(2, 44_100, 2))).toBeCloseTo(2, 2)
  })

  it('says nothing when the header is unreadable', () => {
    expect(wavSeconds(new Uint8Array(4))).toBeUndefined()
  })
})

describe('transcribe', () => {
  it('returns the text the recognizer produced, with its provider and language', async () => {
    const result = await transcribe(host(), wav(1), new AbortController().signal)
    expect(result).toMatchObject({ available: true, text: '把卡顿修掉', provider: 'sensevoice', language: 'zh' })
  })

  it('says there is no recognizer when the host has none', async () => {
    for (const none of [undefined, {}, { snapshot: () => ({ providers: [] }) },
      { snapshot: () => ({ providers: [{ id: 'a' }], selection: { providerId: 'b' } }) }]) {
      const result = await transcribe(none as SpeechHost | undefined, wav(1), new AbortController().signal)
      expect(result.available).toBe(false)
      if (!result.available) expect(result.reason).toContain('语音识别')
    }
  })

  it('refuses a recording that is not WAV before spending time on it', async () => {
    let called = false
    const result = await transcribe(host({ transcribe: async () => { called = true; return { text: 'x' } } }),
      new TextEncoder().encode('some mp3 bytes here'), new AbortController().signal)
    expect(result).toMatchObject({ available: false })
    expect(called).toBe(false)
  })

  it('refuses empty, oversized and over-long recordings', async () => {
    expect(await transcribe(host(), new Uint8Array(), new AbortController().signal)).toMatchObject({ available: false })
    const huge = wav(1)
    const oversized = new Uint8Array(MAX_WAV_BYTES + 1)
    oversized.set(huge.subarray(0, 12))
    expect(await transcribe(host(), oversized, new AbortController().signal)).toMatchObject({ available: false })
    const long = await transcribe(host(), wav(MAX_SECONDS + 5), new AbortController().signal)
    expect(long).toMatchObject({ available: false })
    if (!long.available) expect(long.reason).toContain(String(MAX_SECONDS))
  })

  it('reports a recognizer failure as a failure, not as empty speech', async () => {
    const result = await transcribe(host({ transcribe: async () => { throw new Error('模型没加载') } }), wav(1), new AbortController().signal)
    expect(result).toMatchObject({ available: false })
    if (!result.available) expect(result.reason).toContain('模型没加载')
  })

  it('keeps "heard nothing" apart from "could not run"', async () => {
    const result = await transcribe(host({ transcribe: async () => ({ text: '   ' }) }), wav(1), new AbortController().signal)
    expect(result).toMatchObject({ available: false, reason: '没听出字来' })
  })
})
