import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createRelay, type Relay, type RelayOptions } from '../../relay/src/server.ts'
import { optionsFromEnv } from '../../relay/src/main.ts'
import { createTunnel, type Tunnel } from '../src/app/tunnel.ts'
import { MAX_WAV_BYTES, wavSeconds } from '../src/app/voice.ts'

const running: { relay: Relay; tunnel: Tunnel }[] = []
afterEach(async () => {
  for (const entry of running.splice(0)) {
    await entry.tunnel.close()
    await entry.relay.close()
  }
})

async function carrier(options: RelayOptions = {}) {
  const relay = createRelay({ ...options, heartbeatIntervalMs: 60_000, pongTimeoutMs: 120_000 })
  const port = await relay.listen(0, '127.0.0.1')
  const forward = vi.fn((request: Parameters<Parameters<typeof createTunnel>[0]['forward']>[0]) => {
    // Same Request body selection as the backend entry point; GET must remain bodyless.
    const body = request.rawBody ?? request.body
    const incoming = new Request(`http://dsh${request.url}`, {
      method: request.method,
      ...(body.length ? { body } : {}),
    })
    return new Response(incoming.body)
  })
  const tunnel = createTunnel({ relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'voice-box', forward })
  running.push({ relay, tunnel })
  await tunnel.start()
  expect(tunnel.state()).toBe('live')
  return { base: `http://127.0.0.1:${port}/i/voice-box`, forward }
}

/** PCM16 mono at 16kHz, with deliberately non-UTF8 sample bytes. No microphone or recognizer. */
function wav(seconds: number): Uint8Array<ArrayBuffer> {
  const dataBytes = Math.round(seconds * 16_000) * 2
  const audio = Buffer.alloc(44 + dataBytes, 0xff)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(16_000, 24)
  audio.writeUInt32LE(32_000, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(dataBytes, 40)
  return new Uint8Array(audio)
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

it.each([0.01, 120])('carries a %s-second WAV through real HTTP + relay + tunnel without UTF8 damage', async seconds => {
  // Exercise optionsFromEnv too: an absent administrator cap must preserve media defaults.
  const { base, forward } = await carrier(optionsFromEnv({}))
  const audio = wav(seconds)
  expect(wavSeconds(audio)).toBe(seconds)
  expect(audio.length).toBeLessThan(MAX_WAV_BYTES)
  const response = await fetch(`${base}/api/mobile/voice`, {
    method: 'POST', headers: { 'content-type': 'audio/wav; codecs=1' }, body: audio,
  })
  expect(response.status).toBe(200)
  const received = new Uint8Array(await response.arrayBuffer())
  expect(received.length).toBe(audio.length)
  expect(digest(received)).toBe(digest(audio))
  expect(digest(forward.mock.calls[0]![0].rawBody!)).toBe(digest(audio))
})

it('keeps JSON strings and empty GET requests compatible', async () => {
  const { base, forward } = await carrier()
  const text = '{"text":"你好"}'
  const response = await fetch(`${base}/api/mobile/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: text,
  })
  expect(await response.text()).toBe(text)
  expect(forward.mock.calls[0]![0].body).toBe(text)
  const empty = await fetch(`${base}/api/mobile/timeline`)
  expect(empty.status).toBe(200)
  expect(await empty.text()).toBe('')
})

it('still rejects ordinary JSON above 256KiB even on the voice URL', async () => {
  const { base, forward } = await carrier(optionsFromEnv({}))
  const response = await fetch(`${base}/api/mobile/voice`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(256 * 1024 + 1),
  })
  expect(response.status).toBe(413)
  expect(forward).not.toHaveBeenCalled()
})

it.each([
  { maxRequestBodyBytes: 256 * 1024 },
  optionsFromEnv({ RELAY_MAX_BODY_BYTES: String(256 * 1024) }),
])('honors an explicit administrator cap for WAV (%j)', async options => {
  const { base, forward } = await carrier(options)
  const response = await fetch(`${base}/api/mobile/voice`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav(10),
  })
  expect(response.status).toBe(413)
  expect(forward).not.toHaveBeenCalled()
})

it('rejects WAV above the 8MiB media cap before forwarding', async () => {
  const { base, forward } = await carrier()
  const response = await fetch(`${base}/api/mobile/voice`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(MAX_WAV_BYTES + 1),
  })
  expect(response.status).toBe(413)
  expect(forward).not.toHaveBeenCalled()
})
