/**
 * 隧道协议 v2 的编解码。
 *
 * 每一帧走一个 WebSocket binary 消息：`[type: 1B][id: 4B 大端][length: 4B 大端][payload]`。
 * 数据通道的 payload 是原始字节（不 base64 —— base64 要多花三分之一带宽，还要两头各解一次）；
 * 控制消息是 UTF-8 JSON。心跳走应用层的 ping/pong 而不是 WS 原生 ping：经代理与负载均衡时
 * 中间设备可以吞掉原生 ping，应用层帧则一定被当成数据转发。
 *
 * 线格式的事实源在 AI-HUB 的 `dsh-mobile-plugin/lib/relay/protocol.js`。本文件是它的第二份实现，
 * 字节级对拍钉在 `tests/relay-protocol.spec.ts`。改帧编号必须三处一起改。
 *
 * 为什么把编解码单独成文件、不让 tunnel.ts 内联：中转服务端（`relay/`）要用同一套字节，
 * 而它不能 import 本仓 backend 的模块（它是独立部署的进程）。一份小的、纯 Buffer 的文件
 * 拷过去比让两个进程共享一个 package 便宜得多 —— 对拍测试就是防止两份漂移的那道闸。
 */

/** 帧类型。编号与参考实现逐一对齐，注释写明 payload 形状（给写中转的人看的）。 */
export const T = {
  register: 0x01, // id=0  JSON {instanceId, name?, version?, secret?, lanUrls?, lanCandidates?}
  registered: 0x02, // id=0  JSON {mirror?: boolean}
  updatePairing: 0x03, // id=0  保留编号；宿主不再发，中转不读
  httpRequest: 0x04, // id=N  JSON {method, path, headers}；body 随后以 httpBody 流式发送
  httpBody: 0x05, // id=N  raw bytes（空 payload = body 结束）
  httpHead: 0x06, // id=N  JSON {status, headers}
  httpChunk: 0x07, // id=N  raw bytes
  httpEnd: 0x08, // id=N  空
  httpError: 0x09, // id=N  JSON {message}
  wsUpgrade: 0x0a, // id=N  JSON {path, headers}
  wsOpen: 0x0b, // id=N  空
  wsError: 0x0c, // id=N  JSON {message}
  wsText: 0x0d, // id=N  raw bytes（上游 WS 文本帧）
  wsBinary: 0x0e, // id=N  raw bytes（上游 WS 二进制帧）
  wsClose: 0x0f, // id=N  2B 大端 close code + reason
  ping: 0x10, // id=0  空
  pong: 0x11, // id=0  空
  pairRequest: 0x12, // id=0  JSON {requestId, device:{...}}
  pairConfirm: 0x13, // id=0  JSON {requestId, approved, token?}
  httpCancel: 0x14, // id=N  空
  httpPause: 0x15, // id=N  空
  httpResume: 0x16, // id=N  空
  sync: 0x17, // id=0  JSON {kind, ...}
  revokeAll: 0x18, // id=0  JSON {at}
  revokeAllAck: 0x19, // id=0  JSON {ok, revoked}
  pushRegister: 0x1a, // id=0  JSON {deviceId, platform, token}
  pushSend: 0x1b, // id=0  JSON {deviceId, title, body, sessionId?, kind}
  migrate: 0x1c, // id=0  JSON {to, at}；to 空串 = 撤销
  // 宿主把用实例密钥（HK）加密过的历史 blob 推给中转，中转只存不解、没有 HK。
  // 我们这一层不发也不收它，但编号必须占住：这是上位机之间的公共约定，
  // 漏掉一个编号等于把后面追加的编号整体前移一位，症状是跨端联调时数据流进黑洞。
  blobPut: 0x1d, // id=0  JSON {scope, key, creds, cipher}
} as const

export type FrameType = (typeof T)[keyof typeof T]

/** 编号 → 名字。日志里印名字比印数字有用得多。 */
export const TYPE_NAME: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(T).map(([name, code]) => [code, name]))

export const HEADER_LEN = 9

/** 一帧通常这么大。超过它就该走 httpChunk 分片，而不是让一个 WS 消息变成几 MB。 */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024

/** 帧里能放的载荷。`null` / `undefined` 表示「没有载荷」，不是字符串 "null"。 */
export type FramePayload = Buffer | Uint8Array | string | object | null | undefined

export interface Frame {
  type: number
  id: number
  payload: Buffer
}

/**
 * 编一帧。
 *
 * JSON 分支把 JSON.stringify 的结果直接写进最终 Buffer，不经中间字符串→Buffer 的一次复制：
 * 这条路径在每个控制帧上都会走，而控制帧的数量与请求数同阶。
 *
 * id 用 `>>> 0` 归一：负数与大整数在这里变成合法的 uint32，而不是在 writeUInt32BE 那里抛错。
 * 隧道 id 是单调递增的计数器，不会真到 4G，但上游传进来的 id（比如迁移登记）可能是任何值。
 */
export function encodeFrame(type: number, id: number, payload: FramePayload): Buffer {
  let body: Buffer | undefined
  let text: string | undefined
  if (Buffer.isBuffer(payload)) body = payload
  else if (payload instanceof Uint8Array) body = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  else if (typeof payload === 'string') text = payload
  else if (payload !== undefined && payload !== null) text = JSON.stringify(payload)
  const bodyLength = body ? body.length : text === undefined ? 0 : Buffer.byteLength(text, 'utf8')
  const frame = Buffer.allocUnsafe(HEADER_LEN + bodyLength)
  frame.writeUInt8(type & 0xff, 0)
  frame.writeUInt32BE(id >>> 0, 1)
  frame.writeUInt32BE(bodyLength, 5)
  if (body) body.copy(frame, HEADER_LEN)
  else if (text !== undefined && bodyLength) frame.write(text, HEADER_LEN, bodyLength, 'utf8')
  return frame
}

/** JSON 控制帧的编法。与 `encodeFrame(type, id, obj)` 同义，只为了读的时候一眼看出这是控制帧。 */
export function jsonFrame(type: number, id: number, body: object): Buffer {
  return encodeFrame(type, id, JSON.stringify(body))
}

export interface DecoderOptions {
  /** 单帧载荷上限。超了当场报错并清空缓冲。 */
  maxFrameBytes?: number
  /** 超限或坏帧时回调。调用方通常在这里终止连接 —— 一个声称 4GB 的帧不该先把 4GB 攒下来。 */
  onError?: (error: Error) => void
}

/**
 * 流式解码器。
 *
 * 为什么不是「一条 WebSocket 消息 = 一帧」：send 一个大 Buffer 时 TCP 层会分片，ws 库虽然会把
 * 它重组成一个 message，但中转与宿主之间还可能夹着别的实现（手机的 Kotlin 客户端、将来的 Go 版），
 * 那些不保证这个性质。所以按字节流拼，读够一帧就交出去，剩下的留到下个 chunk。
 *
 * 返回 `false` 表示这之后解码器已经作废（坏帧），调用方应断开。
 */
export function frameDecoder(
  onFrame: (frame: Frame) => void,
  options: DecoderOptions = {},
): (chunk: Buffer | Uint8Array) => boolean {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  const onError = options.onError ?? (() => {})
  // 显式标成 Buffer（= Buffer<ArrayBufferLike>）：下面会拿子切回填它，而 Node 的类型把
  // Buffer<ArrayBuffer> 与 Buffer<ArrayBufferLike> 分成了两个不互通的类型。
  let buffer: Buffer = Buffer.alloc(0)
  return function push(chunk) {
    const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

    // 单个 chunk 就超限：直接拒，一次 concat 都不做。
    if (bytes.length > maxFrameBytes + HEADER_LEN) {
      onError(new Error('frame too large'))
      buffer = Buffer.alloc(0)
      return false
    }
    if (buffer.length + bytes.length > maxFrameBytes + HEADER_LEN) {
      onError(new Error('frame too large'))
      buffer = Buffer.alloc(0)
      return false
    }
    buffer = buffer.length ? Buffer.concat([buffer, bytes]) : Buffer.from(bytes)
    while (buffer.length >= HEADER_LEN) {
      const type = buffer.readUInt8(0)
      const id = buffer.readUInt32BE(1)
      const length = buffer.readUInt32BE(5)
      // 长度一读出来就判：头里写 4GB 的帧必须当场废掉，不能等载荷到齐。
      if (length > maxFrameBytes) {
        onError(new Error('frame too large'))
        buffer = Buffer.alloc(0)
        return false
      }
      if (buffer.length < HEADER_LEN + length) break
      const payload = buffer.subarray(HEADER_LEN, HEADER_LEN + length)
      buffer = buffer.subarray(HEADER_LEN + length)
      onFrame({ type, id, payload })
    }
    return true
  }
}

/**
 * 一次解一帧，给测试与非流式调用点用。
 *
 * 返回 `{ need: true }` 表示字节不够；`{ frame, used }` 表示解出的一帧与它占掉的字节数。
 * 与 `frameDecoder` 共用同一套判定，免得两处边界（恰好等于上限、差了 1 字节）各判各的。
 */
export function decodeFrame(bytes: Buffer, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): { need: true } | { need: false; frame: Frame; used: number } {
  if (bytes.length < HEADER_LEN) return { need: true }
  const type = bytes.readUInt8(0)
  const id = bytes.readUInt32BE(1)
  const length = bytes.readUInt32BE(5)
  if (length > maxFrameBytes) throw new Error('frame too large')
  if (bytes.length < HEADER_LEN + length) return { need: true }
  return { need: false, frame: { type, id, payload: bytes.subarray(HEADER_LEN, HEADER_LEN + length) }, used: HEADER_LEN + length }
}

/** 解析控制帧载荷。坏 JSON 一律当空对象：一个坏帧不该把整条隧道弄断。 */
export function parseJson(payload: Buffer | Uint8Array): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(payload).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** WS 关闭帧的 reason 上限：控制帧 125 字节，减 2 字节 code。 */
export const MAX_CLOSE_REASON_BYTES = 123

// 1005（无状态码）、1006（异常关闭）、1015（TLS 握手失败）是本地产生的值，出现在线上是协议错误；
// 1004 语义不明。ws 库见到这四个会直接抛，所以编码时要换成 1000，解码时要如实标出不合法。
const RESERVED_CLOSE_CODES = [1004, 1005, 1006, 1015]

export function validCloseCode(code: number): boolean {
  return Number.isInteger(code) && code >= 1000 && code <= 4999 && !RESERVED_CLOSE_CODES.includes(code)
}

/**
 * 按字节截断 UTF-8，且不切断码点。
 *
 * 直接 `Buffer.subarray(0, 123)` 会把一个汉字劈成两半，产出非法 UTF-8；对端的 ws 库据此
 * 判定协议错误并直接断连 —— 症状是「关连接的时候两边都报错」，而且只在中文 reason 够长时出现。
 */
export function truncateUtf8(text: string, maxBytes: number): Buffer {
  const bytes = Buffer.from(text, 'utf8')
  let end = Math.min(maxBytes, bytes.length)
  while (end > 0) {
    const last = bytes[end - 1]!
    if ((last & 0x80) === 0) return bytes.subarray(0, end)
    let start = end - 1
    while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start -= 1
    const lead = bytes[start]!
    const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
    if (start + width <= end) return bytes.subarray(0, end)
    end = start
  }
  return Buffer.alloc(0)
}

/** 编 wsClose 载荷：2B 大端 code + 不切断码点的 reason。 */
export function encodeClosePayload(code: number, reason?: string | Buffer | null): Buffer {
  const safe = validCloseCode(code) ? code : 1000
  return Buffer.concat([Buffer.from([(safe >> 8) & 0xff, safe & 0xff]), truncateUtf8(String(reason ?? ''), MAX_CLOSE_REASON_BYTES)])
}

export interface CloseInfo {
  /** 可以直接交给 WebSocket.close() 的值。 */
  code: number
  /** 线上原值。日志要的是它 —— 1006 本身不能发，但「它是 1006」说明对面是异常断开。 */
  raw: number
  validCode: boolean
  reason: string
}

export function decodeClosePayload(payload: Buffer | Uint8Array): CloseInfo {
  const bytes = Buffer.from(payload)
  const raw = bytes.length >= 2 ? bytes.readUInt16BE(0) : 1000
  const ok = validCloseCode(raw)
  const reason = bytes.length > 2 ? truncateUtf8(bytes.subarray(2).toString('utf8'), MAX_CLOSE_REASON_BYTES).toString('utf8') : ''
  return { code: ok ? raw : 1000, raw, validCode: ok, reason }
}
