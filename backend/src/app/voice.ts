/**
 * 语音输入：把一段录音转成文字。
 *
 * 认字这件事不在这里做 —— DSH 宿主已经有 `speechToText` 服务（本地 sensevoice，
 * 走 `sherpa-onnx`，不出本机）。这一份只做三件壳事：
 *
 * 1. **认出宿主到底有没有这项能力**。宿主没装语音插件、或者没有一个 provider 可用时，
 *    如实说「没有」，不假装录音按钮按了会出字。
 * 2. **把录音交给它**。宿主那一层收的是 WAV 字节（`audio/wav`），所以这里如实校验，
 *    不做「可能是 mp3 也试试」的猜测 —— 猜错时人家给的是乱码文字，比报错难查得多。
 * 3. **拦住过大与过长的录音**。一段十分钟的录音转出来的字没人读，还白占内存。
 *
 * 没有 `ctx` 的那条路（单测、以及宿主没装语音时）走 `unavailable`，
 * 界面据此把麦克风画成不可用，而不是按下去静默失败。
 */

/** 一段 WAV 最多多大：16kHz 单声道 16 位约 32KB/秒，8MB 够 4 分钟，远超一句话。 */
export const MAX_WAV_BYTES = 8 * 1024 * 1024

/** 一句话最多认多久。超了的录音不转 —— 转出来的东西没人会读完。 */
export const MAX_SECONDS = 120

/** 宿主 `speechToText` 服务的最小形状（只声明这里用得到的）。 */
export interface SpeechHost {
  snapshot?: () => { providers?: { id: string }[]; selection?: { providerId?: string; language?: string } }
  transcribe?: (spec: unknown, signal: AbortSignal) => Promise<{ text?: string } | string>
  resolve?: (request: { audio: Uint8Array; language?: string; providerId?: string }) => unknown
}

/** 识别结果。`available: false` 时 `reason` 是给人看的一句中文原因。 */
export type Transcript =
  | { available: true; text: string; language: string; provider: string; seconds?: number }
  | { available: false; reason: string }

/** 这段字节看起来是不是一个 WAV：`RIFF....WAVE`。 */
export function looksLikeWav(audio: Uint8Array): boolean {
  if (audio.length < 12) return false
  const text = (at: number, length: number): string => String.fromCharCode(...audio.subarray(at, at + length))
  return text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE'
}

/**
 * 从 WAV 头里读出时长（秒）。读不出来就返回 `undefined` —— 不按字节数估，
 * 采样率与位深不同，估出来的时长会差几倍。
 */
export function wavSeconds(audio: Uint8Array): number | undefined {
  if (!looksLikeWav(audio)) return undefined
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  let at = 12
  let byteRate = 0
  let dataBytes = 0
  while (at + 8 <= audio.length) {
    const id = String.fromCharCode(...audio.subarray(at, at + 4))
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ' && at + 8 + 16 <= audio.length) byteRate = view.getUint32(at + 16, true)
    if (id === 'data') { dataBytes = Math.min(size, audio.length - at - 8); break }
    at += 8 + size + (size % 2)
  }
  if (!byteRate || !dataBytes) return undefined
  return dataBytes / byteRate
}

/**
 * 把一段录音转成文字。
 *
 * 顺序是固定的：先看宿主有没有这项能力，再看录音本身合不合规，最后才真的转。
 * 反过来会让人为一段注定失败的录音白等十几秒。
 */
export async function transcribe(host: SpeechHost | undefined, audio: Uint8Array, signal: AbortSignal): Promise<Transcript> {
  const snapshot = host?.snapshot?.()
  const providers = snapshot?.providers ?? []
  const provider = snapshot?.selection?.providerId
  if (!host?.transcribe || !host.resolve || !provider || !providers.some(item => item.id === provider)) {
    return { available: false, reason: '这台后端没有可用的语音识别：宿主没有装语音插件，或者没有可用的识别提供方' }
  }
  if (!audio.length) return { available: false, reason: '没收到录音' }
  if (audio.length > MAX_WAV_BYTES) {
    return { available: false, reason: `录音太大（${Math.round(audio.length / 1024)} KB），一次最多 ${MAX_WAV_BYTES / 1024 / 1024} MB` }
  }
  if (!looksLikeWav(audio)) return { available: false, reason: '这段音频不是 WAV，识别器只收 WAV' }
  const seconds = wavSeconds(audio)
  if (seconds !== undefined && seconds > MAX_SECONDS) {
    return { available: false, reason: `录音 ${Math.round(seconds)} 秒，一次最多 ${MAX_SECONDS} 秒` }
  }
  let result: { text?: string } | string
  try {
    result = await host.transcribe(host.resolve({ audio, ...(snapshot?.selection?.language ? { language: snapshot.selection.language } : {}) }), signal)
  } catch (error) {
    return { available: false, reason: `识别没成功：${error instanceof Error ? error.message : String(error)}` }
  }
  const text = (typeof result === 'string' ? result : result?.text ?? '').trim()
  if (!text) return { available: false, reason: '没听出字来' }
  return { available: true, text, provider, language: snapshot?.selection?.language ?? 'auto', ...(seconds === undefined ? {} : { seconds }) }
}
