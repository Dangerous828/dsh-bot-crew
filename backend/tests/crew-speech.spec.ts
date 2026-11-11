import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE, MAX_SPEECH_CHARS, secondsOf, silentWav, speak, speakable, type SpeakHost } from '../src/app/speech.ts'

/**
 * 一个假的宿主：不跑子进程，只把该写的文件写出来。
 *
 * 临时目录用真的（`mkdtemp`）：真实现里 `say` 是往那个目录写文件的，
 * 假宿主也必须真的能写，否则测的是一个不存在的路径。
 */
function fakeHost(overrides: Partial<SpeakHost> = {}): SpeakHost & { spoken: string[]; cleaned: string[] } {
  const spoken: string[] = []
  const cleaned: string[] = []
  return {
    spoken, cleaned,
    hasVoice: async () => true,
    say: async (text) => { spoken.push(text) },
    toWav: async (_input, output) => {
      // 3200 字节数据 = 0.1 秒（16000 Hz 单声道 16 位）。
      const bytes = new Uint8Array(44 + 3200)
      bytes.set(silentWav())
      new DataView(bytes.buffer).setUint32(40, 3200, true)
      await writeFile(output, bytes)
    },
    tempDir: () => mkdtemp(join(tmpdir(), 'crew-speech-test-')),
    clean: async path => { cleaned.push(path) },
    ...overrides,
  }
}

describe('speakable', () => {
  it('drops code so nobody has to listen to it', () => {
    expect(speakable('看这里：\n```js\nconst a = 1\n```\n完了')).toBe('看这里：\n\n完了')
  })

  it('drops a bare URL, which would be read out character by character', () => {
    expect(speakable('见 https://example.com/a?b=c 那份')).toBe('见  那份')
  })

  it('keeps the words of a link and drops the target', () => {
    expect(speakable('看[那份说明](https://x.com/y)吧')).toBe('看那份说明吧')
  })

  it('strips heading and emphasis marks but keeps the words', () => {
    expect(speakable('## 今天\n**办完**三件')).toBe('今天\n办完三件')
  })

  it('turns table bars into pauses', () => {
    expect(speakable('a | b | c')).toBe('a，b，c')
  })
})

describe('speak', () => {
  it('says it and hands back audio', async () => {
    const host = fakeHost()
    const result = await speak(host, '办完三件')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.audio.length).toBeGreaterThan(44)
    expect(host.spoken).toEqual(['办完三件'])
    // 临时目录必须收掉：每说一句就留一个目录，一天就堆满了。
    expect(host.cleaned).toHaveLength(1)
    expect(host.cleaned[0]).toContain('crew-speech-test-')
  })

  it('says "no such voice" instead of letting say fail with something unreadable', async () => {
    const result = await speak(fakeHost({ hasVoice: async () => false }), '你好')
    expect(result).toMatchObject({ status: 'unavailable' })
    if (result.status === 'unavailable') expect(result.reason).toContain('没有')
  })

  it('refuses to read out nothing', async () => {
    expect(await speak(fakeHost(), '```\nonly code\n```')).toMatchObject({ status: 'unavailable' })
  })

  it('clips a very long text and admits it clipped', async () => {
    const host = fakeHost()
    const result = await speak(host, '字'.repeat(MAX_SPEECH_CHARS + 100))
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.truncated).toBe(true)
    expect([...host.spoken[0]!].length).toBe(MAX_SPEECH_CHARS)
  })

  it('carries the converter error back instead of a vague failure', async () => {
    const result = await speak(fakeHost({ toWav: async () => { throw new Error('afconvert exited 1: bad format') } }), '你好')
    expect(result).toMatchObject({ status: 'failed' })
    if (result.status === 'failed') expect(result.reason).toContain('afconvert')
  })

  it('cleans up even when it failed', async () => {
    const host = fakeHost({ say: async () => { throw new Error('say exited 1') } })
    await speak(host, '你好')
    expect(host.cleaned).toHaveLength(1)
  })

  it('uses the mainland Chinese voice by default', () => {
    expect(DEFAULT_VOICE).toBe('Tingting')
  })
})

describe('secondsOf', () => {
  it('reads the length off the header', () => {
    // 16000 Hz、单声道、16 位 → 每秒 32000 字节；64000 字节 = 2 秒。
    const wav = new Uint8Array(44 + 64_000)
    wav.set(silentWav())
    const view = new DataView(wav.buffer)
    view.setUint32(40, 64_000, true)
    expect(secondsOf(wav)).toBeCloseTo(2, 5)
  })

  it('says zero rather than guessing on a file it cannot read', () => {
    expect(secondsOf(new Uint8Array(10))).toBe(0)
    expect(secondsOf(new TextEncoder().encode('not a wav at all, just text'))).toBe(0)
  })
})

describe('silentWav', () => {
  it('is a valid header with no sound in it', () => {
    const wav = silentWav()
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(wav.length).toBe(44)
    expect(secondsOf(wav)).toBe(0)
  })
})
