import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { T, decodeClosePayload, decodeFrame, encodeClosePayload, encodeFrame, frameDecoder, HEADER_LEN, jsonFrame, parseJson, truncateUtf8 } from '../src/app/relay-protocol.ts'

/**
 * 协议层对拍。
 *
 * 线格式只有一个事实源：AI-HUB 插件包里那份自包含副本（`dsh-mobile-plugin/lib/relay/protocol.js`）。
 * 中转服务端在 `relay/` 里另有一份，宿主的这一份是第二份，将来 app 里还会有第三份。
 * 只要有人偷偷改了帧编号或字节序，「自己测自己」永远测不出来 —— 所以这里把参考实现直接
 * 装进来，两边各编一遍、再互相解一遍。
 *
 * 参考包能 import 的前提：protocol.js 不 require `ws`，是纯 Buffer 运算。
 */
// 参考实现装在哪台机器上不一样（DSH profile 路径）。找不到就跳过对拍 ——
// 但要在报告里说出来，别让「跳过」看起来像「通过」。
const referencePath = [
  `${process.env.HOME}/.dsh/profiles/desktop/node_modules/dsh-mobile-plugin/lib/relay/protocol.js`,
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-mobile-plugin/lib/relay/protocol.js`,
].find(candidate => existsSync(candidate))

const reference = (referencePath ? createRequire(import.meta.url)(referencePath) : undefined) as {
  T: Record<string, number>
  HEADER_LEN: number
  encodeFrame(type: number, id: number, payload: unknown): Buffer
  jsonFrame(type: number, id: number, body: object): Buffer
  createFrameDecoder(onFrame: (frame: { type: number; id: number; payload: Buffer }) => void, options?: object): (chunk: Buffer) => boolean | void
  parseJson(buffer: Buffer): unknown
  truncateUtf8(text: string, maxBytes: number): Buffer
  encodeClosePayload(code: number, reason: string): Buffer
  decodeClosePayload(payload: Buffer): { code: number; raw: number; validCode: boolean; reason: string }
}

// 没有参考实现时整组跳过：那是「没验」，不是「验过了」。
describe.skipIf(!referencePath)('frame type table', () => {
  // 28 个编号是上位机（手机、桌面、dsh-mobile 插件）共同的约定。少一个、挪一位，
  // 症状都是「隧道建起来了但数据流进黑洞」，而且只在跨端联调时才看得到。
  it('agrees with the reference on every frame code, including ones we never send', () => {
    expect(Object.keys(T).sort()).toEqual(Object.keys(reference.T).sort())
    for (const [name, code] of Object.entries(reference.T)) expect(T[name as keyof typeof T], name).toBe(code)
  })

  it('keeps the documented header length', () => {
    expect(HEADER_LEN).toBe(9)
    expect(HEADER_LEN).toBe(reference.HEADER_LEN)
  })

  it('numbers the frames the phone actually rides on as the design says', () => {
    // 写死一份抽查：协议表整体对拍能过，但有人把两个名字对调时，抽查能说出是「哪一对」错了。
    expect(T).toMatchObject({ register: 0x01, registered: 0x02, httpRequest: 0x04, httpChunk: 0x07, httpEnd: 0x08, wsText: 0x0d, ping: 0x10, pong: 0x11, httpCancel: 0x14, migrate: 0x1c })
  })
})

describe.skipIf(!referencePath)('encoding', () => {
  const SAMPLE_IDS = [0, 1, 255, 256, 65_535, 0x0102_0304, 0xffff_fffe]

  it('produces byte-identical frames to the reference for binary, text and JSON payloads', () => {
    const payloads: (Buffer | string | object | null)[] = [
      Buffer.alloc(0),
      Buffer.from([0x00, 0xff, 0x0a, 0x0d]),
      '你好，队伍',
      '',
      { method: 'GET', path: '/api/mobile/timeline', headers: { accept: 'application/json' } },
      {},
    ]
    for (const type of Object.values(T)) {
      for (const id of SAMPLE_IDS) {
        for (const payload of payloads) {
          expect(encodeFrame(type, id, payload), `${type}/${id}`).toEqual(reference.encodeFrame(type, id, payload))
        }
      }
    }
  })

  it('passes JSON frames through the reference helper too', () => {
    expect(jsonFrame(T.register, 0, { instanceId: 'box', name: '队伍' })).toEqual(reference.jsonFrame(T.register, 0, { instanceId: 'box', name: '队伍' }))
  })

  it('writes a big-endian header so other languages can read it', () => {
    const frame = encodeFrame(T.httpRequest, 0x0102_0304, Buffer.from('hi'))
    expect([...frame.subarray(0, HEADER_LEN)]).toEqual([0x04, 0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x02])
    expect(frame.subarray(HEADER_LEN).toString()).toBe('hi')
  })

  it('measures length in bytes, not characters', () => {
    // 「中」是 3 个字节、1 个字符。按字符写长度会让对端一直等一个永远也凑不满的帧。
    const frame = encodeFrame(T.wsText, 1, '中')
    expect(frame.readUInt32BE(5)).toBe(3)
    expect(frame.length).toBe(HEADER_LEN + 3)
  })

  it('treats a null payload as empty rather than the text "null"', () => {
    expect(encodeFrame(T.ping, 0, null)).toEqual(reference.encodeFrame(T.ping, 0, null))
    expect(encodeFrame(T.ping, 0, undefined)).toEqual(reference.encodeFrame(T.ping, 0, undefined))
  })
})

describe.skipIf(!referencePath)('decoding', () => {
  it('reads every frame the reference writes', () => {
    const frames: { type: number; id: number; payload: Buffer }[] = []
    const push = frameDecoder(frame => frames.push(frame))
    for (const type of Object.values(T)) for (const id of [0, 7, 0xffff_ffff]) push(encodeFrame(type, id, { hello: '世界' }))
    expect(frames).toHaveLength(Object.values(T).length * 3)
    for (const frame of frames) expect(parseJson(frame.payload)).toEqual({ hello: '世界' })
  })

  it('reassembles a frame split across chunks, as TCP may deliver it', () => {
    const whole = encodeFrame(T.httpRequest, 42, { path: '/api/mobile/send' })
    const frames: { id: number; payload: Buffer }[] = []
    const push = frameDecoder(frame => frames.push({ id: frame.id, payload: frame.payload }))
    // 一个字节一个字节地喂：最坏情况。任何按「一次 message = 一帧」的写法都会在这里挂。
    for (const byte of whole) push(Buffer.from([byte]))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.id).toBe(42)
  })

  it('splits several frames delivered in one chunk', () => {
    const frames: number[] = []
    const push = frameDecoder(frame => frames.push(frame.id))
    push(Buffer.concat([encodeFrame(T.ping, 0, null), encodeFrame(T.pong, 0, null), encodeFrame(T.httpEnd, 9, null)]))
    expect(frames).toEqual([0, 0, 9])
  })

  it('survives the same byte stream as the reference decoder', () => {
    const seed = Buffer.from('对拍：这是一条很长的中文载荷，用来逼出跨 chunk 的边界。'.repeat(3))
    const stream = Buffer.concat([encodeFrame(T.wsText, 1, seed), encodeFrame(T.ping, 0, null), encodeFrame(T.httpEnd, 2, Buffer.alloc(0))])
    const ours: string[] = []
    const theirs: string[] = []
    frameDecoder(frame => ours.push(`${frame.type}:${frame.id}:${frame.payload.toString('hex')}`))(stream)
    reference.createFrameDecoder(frame => theirs.push(`${frame.type}:${frame.id}:${frame.payload.toString('hex')}`))(stream)
    expect(ours).toEqual(theirs)
    expect(ours).toHaveLength(3)
  })

  it('refuses a frame that claims more bytes than the cap instead of buffering it', () => {
    let failure: Error | undefined
    const push = frameDecoder(() => {}, { maxFrameBytes: 16, onError: error => { failure = error } })
    const oversized = encodeFrame(T.wsBinary, 1, Buffer.alloc(64))
    push(oversized)
    expect(failure).toBeDefined()
    // 头里的长度就超了，必须当场拒；不能先把 64 字节攒下来再看。
    expect(failure?.message).toMatch(/too large/)
  })

  it('refuses an oversized length field before any payload arrives', () => {
    let failure: Error | undefined
    const push = frameDecoder(() => {}, { maxFrameBytes: 1024, onError: error => { failure = error } })
    // 一个只带头的帧，声称 4GB：这是最省事的「让中转先分配 4GB 内存」攻击。
    const header = encodeFrame(T.wsBinary, 1, Buffer.alloc(0))
    header.writeUInt32BE(0xffff_fff0, 5)
    push(header)
    expect(failure?.message).toMatch(/too large/)
  })
})

describe.skipIf(!referencePath)('close codes', () => {
  it('matches the reference on what may appear on the wire', () => {
    // 1005/1006/1015 是「本地产生、不得上网」的值；ws 库见到它们会直接抛错。
    for (const code of [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1011, 1015, 2999, 3000, 4999, 5000, 0, -1, 1000.5]) {
      expect(encodeClosePayload(code, 'bye'), String(code)).toEqual(reference.encodeClosePayload(code, 'bye'))
    }
  })

  it('round-trips a code and a reason, and refuses to split a UTF-8 code point', () => {
    const payload = encodeClosePayload(4001, '会话已结束')
    expect(reference.decodeClosePayload(payload)).toEqual(decodeClosePayload(payload))
    expect(decodeClosePayload(payload)).toMatchObject({ code: 4001, reason: '会话已结束' })

    // 123 字节是上限（控制帧 125 字节减 2 字节 code）。硬截断会把最后一个汉字切成半截，
    // 变成非法 UTF-8，对端 ws 库据此判协议错误。
    const long = encodeClosePayload(1000, '一'.repeat(100))
    expect(long.length - 2).toBeLessThanOrEqual(123)
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(long.subarray(2))).not.toThrow()
    expect(long).toEqual(reference.encodeClosePayload(1000, '一'.repeat(100)))
  })

  it('decodes a missing or truncated payload as a normal close', () => {
    expect(decodeClosePayload(Buffer.alloc(0))).toEqual(reference.decodeClosePayload(Buffer.alloc(0)))
    expect(decodeClosePayload(Buffer.from([0x03])).code).toBe(1000)
    // 线上原始值是 1006：不可用，交出去必须是 1000，但原始值要留着给日志。
    expect(decodeClosePayload(Buffer.from([0x03, 0xee]))).toMatchObject({ code: 1000, raw: 1006, validCode: false })
  })

  it('truncates by bytes the same way the reference does', () => {
    const text = '重新连接中，请稍候'.repeat(20)
    expect(truncateUtf8(text, 40)).toEqual(reference.truncateUtf8(text, 40))
  })
})

describe.skipIf(!referencePath)('parseJson', () => {
  it('answers an empty object for anything it cannot parse, never throws', () => {
    // 控制帧解析失败只该降级成「没说」，不该让整条隧道因为一个坏帧断开。
    for (const bad of ['{', '', 'null', 'nope']) expect(parseJson(Buffer.from(bad)), bad).toEqual({})
  })

  // 有意偏离参考实现的一处，写下来免得以后有人「修」成一样。
  // 参考版是 `return JSON.parse(...)`：报文是合法 JSON 但不是对象时（`"x"`、`5`），它把标量原样交出去，
  // 而每个调用点紧接着就做 `msg.path` / `msg.headers` —— 在公网中转上，任何人发一个 payload 为 `5`
  // 的帧就能让它抛 TypeError。这里统一降级成空对象：控制帧的形状是「一个对象」，不是「任何 JSON」。
  it('refuses a scalar where every caller expects an object, unlike the reference', () => {
    expect(reference.parseJson(Buffer.from('"x"'))).toBe('x')
    expect(parseJson(Buffer.from('"x"'))).toEqual({})
    for (const scalar of ['5', 'true', '[1,2]']) expect(parseJson(Buffer.from(scalar)), scalar).toEqual({})
  })
})

describe.skipIf(!referencePath)('decodeFrame', () => {
  it('reports "need more" instead of guessing on a truncated frame', () => {
    const whole = encodeFrame(T.httpHead, 3, { status: 200 })
    expect(decodeFrame(whole.subarray(0, 5))).toEqual({ need: true })
    expect(decodeFrame(whole.subarray(0, whole.length - 1))).toEqual({ need: true })
    const decoded = decodeFrame(whole)
    expect(decoded).toMatchObject({ need: false })
    if ('frame' in decoded) expect(parseJson(decoded.frame.payload)).toEqual({ status: 200 })
  })
})
