/**
 * 测试用的隧道客户端。
 *
 * 它刻意不复用 backend 的隧道实现：那个实现是**被测对象之一**，拿它去测中转等于自证。
 * 这里是一份最小的、只看协议的客户端 —— 直接对着 socket 发帧，能精确构造
 * 「注册了但不回心跳」「发一个 4GB 的帧头」这类畸形输入。
 */
import { connect, type Socket } from 'node:net'
import { acceptKey } from '../../src/websocket.ts'
import { T, encodeFrame, frameDecoder, jsonFrame, type Frame } from '../../src/relay-protocol.ts'

export interface RelayClient {
  /** 已收到的帧。测试直接对它做断言。 */
  readonly frames: Frame[]
  /** 等到满足条件的一帧（超时抛错）。 */
  next(predicate: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>
  /** 发一个原始字节块。用于构造畸形帧。 */
  raw(bytes: Buffer): void
  send(type: number, id: number, payload?: Buffer | string | object | null): void
  json(type: number, id: number, body: object): void
  close(): Promise<void>
  /** 服务端断开时 resolve。 */
  readonly closed: Promise<void>
}

export interface ConnectOptions {
  port: number
  /** 隧道路径，默认 /tunnel。 */
  path?: string
  host?: string
  /** 额外的握手头（注册密钥走 Authorization）。 */
  headers?: Record<string, string>
}

const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

/**
 * 把一段载荷包成客户端数据帧。
 *
 * 客户端发的每一帧都必须加掩码（RFC 6455 5.1）。中转按协议拒绝未加掩码的帧 ——
 * 这里手工加，而不是依赖某个库，正因为这个 fixture 要能精确控制线上字节。
 * `raw()` 走的是另一条路：它故意不加掩码，用来构造畸形输入。
 */
function clientFrame(payload: Buffer, opcode = 0x2): Buffer {
  const key = Buffer.from([0x37, 0xfa, 0x21, 0x3d])
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(length, 6)
  }
  const body = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) body[index] = payload[index]! ^ key[index & 3]!
  return Buffer.concat([header, key, body])
}

/** 连上中转的 /tunnel 并完成 WS 握手。握手被拒时 reject，message 是状态行。 */
export function connectTunnel(options: ConnectOptions): Promise<RelayClient> {
  return new Promise((resolve, reject) => {
    const host = options.host ?? '127.0.0.1'
    const socket: Socket = connect(options.port, host)
    const frames: Frame[] = []
    const waiters: { predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = []
    let settled = false
    let resolveClosed: () => void = () => {}
    const closed = new Promise<void>(done => { resolveClosed = done })

    const client: RelayClient = {
      frames,
      next(predicate, timeoutMs = 4_000) {
        const existing = frames.find(predicate)
        if (existing) return Promise.resolve(existing)
        return new Promise<Frame>((done, fail) => {
          const timer = setTimeout(() => fail(new Error(`timed out waiting for a frame; got [${frames.map(frame => frame.type).join(',')}]`)), timeoutMs)
          waiters.push({ predicate, resolve: frame => { clearTimeout(timer); done(frame) } })
        })
      },
      // raw 是「绕过 WS 层的裸字节」，用于构造畸形输入；它不会被加掩码，因为它本来就故意不合规。
      raw(bytes) { socket.write(bytes) },
      send(type, id, payload) { socket.write(clientFrame(encodeFrame(type, id, payload ?? null))) },
      json(type, id, body) { socket.write(clientFrame(jsonFrame(type, id, body))) },
      close() {
        return new Promise<void>(done => {
          if (socket.destroyed) return done()
          socket.once('close', () => done())
          socket.destroy()
        })
      },
      closed,
    }

    socket.on('connect', () => {
      socket.write([
        `GET ${options.path ?? '/tunnel'} HTTP/1.1`,
        `Host: ${host}:${options.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${KEY}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(options.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ].join('\r\n'))
    })

    let head = Buffer.alloc(0)
    let upgraded = false
    // WS 层与隧道层分开：socket 上的是 WS 帧，WS 帧的载荷才是隧道帧。
    const push = frameDecoder((frame: Frame) => {
      frames.push(frame)
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index]!
        if (!waiter.predicate(frame)) continue
        waiters.splice(index, 1)
        waiter.resolve(frame)
      }
    })

    const wsReader = wsFrameReader(payload => push(payload))
    socket.on('data', chunk => {
      if (upgraded) { wsReader(chunk); return }
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      const text = head.subarray(0, end).toString('latin1')
      const status = text.split('\r\n')[0] ?? ''
      if (!/ 101 /.test(status)) {
        if (!settled) { settled = true; reject(new Error(status)) }
        socket.destroy()
        return
      }
      // 回执里必须给出正确的 Sec-WebSocket-Accept；算错的话真实客户端会判握手失败。
      const accept = text.split('\r\n')
        .find(line => line.toLowerCase().startsWith('sec-websocket-accept:'))?.split(':')[1]?.trim()
      if (accept !== acceptKey(KEY)) {
        if (!settled) { settled = true; reject(new Error(`bad Sec-WebSocket-Accept: ${accept}`)) }
        socket.destroy()
        return
      }
      upgraded = true
      settled = true
      resolve(client)
      const rest = head.subarray(end + 4)
      if (rest.length) wsReader(rest)
    })
    socket.on('error', error => { if (!settled) { settled = true; reject(error) } })
    socket.on('close', () => { resolveClosed() })
  })
}

/**
 * 拆服务端发来的 WS 帧。
 *
 * 这是 fixture 里唯一「不属于协议本身」的一层：中转的 socket 上跑的是 RFC 6455，隧道帧是它的载荷。
 * 不拆这一层，frameDecoder 会把 WS 头（0x82、长度）当成隧道头读，症状是所有帧都解不出来。
 * 客户端只收服务端帧，所以没有掩码要处理。
 */
function wsFrameReader(onMessage: (payload: Buffer) => void): (chunk: Buffer) => void {
  let buffer: Buffer = Buffer.alloc(0)
  return chunk => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk)
    while (buffer.length >= 2) {
      const opcode = buffer[0]! & 0x0f
      let length = buffer[1]! & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = buffer.readUInt32BE(6)
        offset = 10
      }
      if (buffer.length < offset + length) return
      const payload = buffer.subarray(offset, offset + length)
      buffer = buffer.subarray(offset + length)
      // close/ping/pong 交给测试自己关心（fixture 不主动发 ping），数据帧走协议解码器。
      if (opcode === 0x1 || opcode === 0x2) onMessage(payload)
    }
  }
}

export { T, encodeFrame, jsonFrame }
