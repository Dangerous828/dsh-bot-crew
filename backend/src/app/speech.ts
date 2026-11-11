/**
 * 播报：把一句话读成声音。
 *
 * 为什么用系统 `say` 而不是接一个云端 TTS：这台队伍的语音识别走的是宿主的本机
 * `speechToText`（`sherpa-onnx`），播报也该是本机的 —— 同一套前提：
 * **不出本机、不传凭据、不按字数计费**。macOS 自带中文声音，`say -o out.aiff` 就能出音频。
 *
 * 三条约束写在这里，因为它们都是踩过才知道的：
 *
 * 1. **输出不是 WAV**。`say -o` 写的是 AIFF（大端 PCM），手机端的播放器认 WAV 更稳，
 *    所以中间用 `afconvert` 转一道。少了这一步，手机拿到的是一个「打不开的文件」。
 * 2. **必须限长**。播报一句日报是合理的，把整篇日志读出来不是。超长截断并说明，
 *    不静默读完 20 分钟。
 * 3. **失败要分开说**。没有 `say`（非 macOS）、没有那个声音、转换失败——
 *    三件事的处置完全不同，不能统一回一句「播报不可用」。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一次播报最多这么长（字）。念 600 字大约两分钟，已经够长了。 */
export const MAX_SPEECH_CHARS = 600

/** 念出来最多这么长（秒）。`say` 自己也会按字数走，这只是兜底。 */
export const MAX_SPEECH_SECONDS = 120

/** 播报结果。四档分开，因为处置不同。 */
export type SpeakOutcome =
  | { status: 'ok'; audio: Uint8Array<ArrayBuffer>; seconds: number; truncated: boolean }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string }

/** 宿主提供的播报能力。测试可以塞一个假的进来。与语音识别的 `SpeechHost` 不是同一个东西。 */
export interface SpeakHost {
  /** 系统里有没有这个声音。 */
  hasVoice(voice: string): Promise<boolean>
  /** 把文字念成一个 AIFF 文件。 */
  say(text: string, voice: string, outPath: string): Promise<void>
  /** AIFF → WAV。 */
  toWav(input: string, output: string): Promise<void>
  /** 建一个临时目录。 */
  tempDir(): Promise<string>
  /** 收走临时目录。 */
  clean(path: string): Promise<void>
}

/** 默认的播报声音：大陆中文。改设置里的 `voice` 可以换。 */
export const DEFAULT_VOICE = 'Tingting'

/**
 * 把一段字整理成能念的样子。
 *
 * 念出来和看着不一样：Markdown 的星号会被念成「星号」，URL 会被一字一顿念完，
 * 代码块更是灾难。所以先把这些拆掉，只留要说的那几句。
 */
export function speakable(text: string): string {
  return text
    // 代码块整块丢掉：念 `const a = 1` 对听的人没有任何用。
    .replace(/```[\s\S]*?```/g, '')
    // 行内代码也丢，但留一个字的位置，免得两句粘在一起。
    .replace(/`[^`]*`/g, '')
    // 链接只留标题。
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 裸 URL 全丢：念出来是几十秒的噪音。
    .replace(/https?:\/\/\S+/g, '')
    // 标题与强调的符号去掉，字留下。
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    // 表格的竖线换成停顿。
    .replace(/\s*\|\s*/g, '，')
    // 多个空行并成一个。
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 念一遍。
 *
 * 顺序是刻意的：先看有没有这个声音（没有就说没有，不要交给 `say` 去报一个难懂的错），
 * 再限长，最后才真跑子进程。子进程失败时把 stderr 带回来 —— 那才是能定位问题的话。
 */
export async function speak(host: SpeakHost, text: string, voice = DEFAULT_VOICE,
  signal?: AbortSignal): Promise<SpeakOutcome> {
  const clean = speakable(text)
  if (!clean) return { status: 'unavailable', reason: '这句话里没有可念的内容' }
  if (!await host.hasVoice(voice)) {
    return { status: 'unavailable', reason: `这台机器上没有「${voice}」这个声音` }
  }
  const truncated = [...clean].length > MAX_SPEECH_CHARS
  const spoken = truncated ? [...clean].slice(0, MAX_SPEECH_CHARS).join('') : clean
  const dir = await host.tempDir()
  try {
    const aiff = join(dir, 'speech.aiff')
    const wav = join(dir, 'speech.wav')
    await host.say(spoken, voice, aiff)
    await host.toWav(aiff, wav)
    const audio = await readFile(wav)
    if (audio.length === 0) return { status: 'failed', reason: '念出来是空的' }
    // 拷进一个新的 ArrayBuffer：`readFile` 给的是共享池里的视图，直接包成 Blob 类型对不上。
    const bytes = new Uint8Array(audio.byteLength)
    bytes.set(audio)
    return { status: 'ok', audio: bytes, seconds: secondsOf(bytes), truncated }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    await host.clean(dir).catch(() => {})
  }
}

/**
 * WAV 有多长（秒）。数头里的字节数，不解码 —— 这里只为了回一个长度给界面。
 * 读不出来就当 0：长度只是展示用，不该因为它让整次播报失败。
 */
export function secondsOf(wav: Uint8Array): number {
  // RIFF 头：44 字节，之后是 PCM 数据。找 `data` 块更稳。
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  for (let at = 12; at + 8 <= wav.length; at++) {
    const tag = String.fromCharCode(wav[at]!, wav[at + 1]!, wav[at + 2]!, wav[at + 3]!)
    if (tag !== 'data') continue
    const size = view.getUint32(at + 4, true)
    // `fmt ` 块在 `data` 之前：再往前找一次采样率与位深。
    const fmt = findFmt(wav)
    if (!fmt) return 0
    const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bits / 8)
    return bytesPerSecond > 0 ? size / bytesPerSecond : 0
  }
  return 0
}

function findFmt(wav: Uint8Array): { sampleRate: number; channels: number; bits: number } | undefined {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  for (let at = 12; at + 8 <= wav.length; at++) {
    const tag = String.fromCharCode(wav[at]!, wav[at + 1]!, wav[at + 2]!, wav[at + 3]!)
    if (tag !== 'fmt ') continue
    if (at + 24 > wav.length) return undefined
    const channels = view.getUint16(at + 10, true)
    const sampleRate = view.getUint32(at + 12, true)
    const bits = view.getUint16(at + 22, true)
    return channels > 0 && sampleRate > 0 && bits > 0 ? { sampleRate, channels, bits } : undefined
  }
  return undefined
}

/** 真跑子进程的实现。macOS 上才有 `say` / `afconvert`。 */
export function systemSpeakHost(): SpeakHost {
  const run = (command: string, args: string[]): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => reject(new Error(`${command}: ${error.message}`)))
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)))
  })
  return {
    async hasVoice(voice) {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn('say', ['-v', voice, ''], { stdio: 'ignore' })
          child.on('error', reject)
          child.on('close', code => code === 0 ? resolve() : reject(new Error('no voice')))
        })
        return true
      } catch { return false }
    },
    say: (text, voice, outPath) => run('say', ['-v', voice, '-o', outPath, text]),
    toWav: (input, output) => run('afconvert', ['-f', 'WAVE', '-d', 'LEI16', input, output]),
    tempDir: () => mkdtemp(join(tmpdir(), 'crew-speech-')),
    clean: path => rm(path, { recursive: true, force: true }),
  }
}

/** 写一份静音 WAV。宿主完全没有播报能力时用它顶上，界面据此说「这台机器念不出来」。 */
export function silentWav(): Uint8Array {
  const bytes = new Uint8Array(44)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i) }
  ascii(0, 'RIFF'); view.setUint32(4, 36, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, 0, true)
  return bytes
}
