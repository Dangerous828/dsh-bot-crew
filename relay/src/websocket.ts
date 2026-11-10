/**
 * 手写的 WebSocket 服务端。
 *
 * 为什么不用 `ws`：中转的全部需求就是「收 binary 帧、发 binary 帧、发 ping、回 close」这四样，
 * 而 `ws` 是一个几千行、带扩展协商与 permessage-deflate 的完整实现。中转是要长期跑在 NAS 上的
 * 公网暴露面，依赖越少，要跟着升级的东西越少；Docker 镜像里零依赖也意味着构建阶段没有供应链。
 *
 * 换来的代价是这段代码要自己把 RFC 6455 收齐：这里实现的是**服务端子集** ——
 * 只接受 binary/text 数据帧、ping/pong/close，拒绝分片（FIN=0）、拒绝带 RSV 位的扩展帧、
 * 拒绝超过上限的帧。宿主从不让一条隧道消息跨分片发送（见 tunnel.ts 的发送路径），
 * 所以「拒绝分片」不是砍功能，而是把一条不该出现的路径直接变成协议错误。
 *
 * 参考实现（tokio-tungstenite 手写 101）与 `ws` 库在这一点上一致：都不给隧道开扩展。
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** RFC 6455 的固定 GUID，用于算 Sec-WebSocket-Accept。 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 每个连接最多攒多少未发字节。超了说明对端不读，交给上层决定是丢帧还是断开。 */
const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

/** 一个已经握手的连接。上层只看到这一层，看不到 socket。 */
export interface WebSocketConnection {
  /** 发送一个 binary 消息。返回 false 表示没发出去（已断开或积压超限）。 */
  sendBinary(payload: Buffer): boolean
  /** 发送一个 text 消息。隧道只在握手后的错误说明里用它。 */
  sendText(text: string): boolean
  /** 主动关闭，带上 code 与 reason。 */
  close(code?: number, reason?: string): void
  /** 立刻掐断，不发 close 帧。心跳超时用这个 —— 对端已经死了，等握手只会多等一个超时。 */
  terminate(): void
  /** 还没发出去的字节数。上层据此做背压判定。 */
  readonly bufferedAmount: number
  readonly closed: boolean
}

export interface WebSocketServerOptions {
  /** 单帧载荷上限。超了按协议错误断开。 */
  maxFrameBytes?: number
  maxBufferedBytes?: number
  /** 连接上收到一条完整消息（不分片）时回调。 */
  onMessage?: (connection: WebSocketConnection, payload: Buffer, binary: boolean) => void
  onClose?: (connection: WebSocketConnection, code: number, reason: string) => void
  /** 协议错误。上层的回调通常会在这里 terminate。 */
  onError?: (connection: WebSocketConnection, error: Error) => void
}

/**
 * 算 Sec-WebSocket-Accept。
 * 规则是 `base64(sha1(key + GUID))`，没有别的花样 —— 但它算错的话握手会被浏览器/客户端直接判失败。
 */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** 把一帧写进 socket 的线上字节。服务端发出的帧不加掩码（RFC 6455 5.1）。 */
export function encodeMessage(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.allocUnsafe(2)
    header[0] = 0x80 | opcode
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.allocUnsafe(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    // 高 32 位写 0：一个 WS 消息超过 4GB 在隧道里没有意义，上层已经有 64MiB 的帧上限。
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(length, 6)
  }
  return Buffer.concat([header, payload])
}

/** 校验握手请求。返回拒绝理由，合规时返回 undefined。 */
export function handshakeProblem(request: IncomingMessage): string | undefined {
  if (request.method !== 'GET') return 'method not allowed'
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase()
  if (upgrade !== 'websocket') return 'not a websocket upgrade'
  const connection = String(request.headers.connection ?? '').toLowerCase()
  if (!connection.split(',').some(part => part.trim() === 'upgrade')) return 'missing upgrade connection'
  // Sec-WebSocket-Version 必须是 13。老客户端给 8，接进来只会两边都看不懂对方的帧。
  if (String(request.headers['sec-websocket-version'] ?? '') !== '13') return 'unsupported websocket version'
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string' || !key.trim()) return 'missing websocket key'
  return undefined
}

/**
 * 把一个 HTTP upgrade 请求变成 WebSocket 连接。
 * 握手成功后返回连接对象；失败时返回 undefined（并且已经写过拒绝响应）。
 */
export function upgradeToWebSocket(request: IncomingMessage, socket: Duplex, options: WebSocketServerOptions = {}): WebSocketConnection | undefined {
  const problem = handshakeProblem(request)
  if (problem) {
    // 400 而不是 426：升级请求本身就不像话，别让对端以为换个版本就能过。
    socket.end(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    return undefined
  }
  const key = String(request.headers['sec-websocket-key'])
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    // 明确不提任何子协议与扩展：permessage-deflate 一旦协商成功，两边的帧格式就都变了，
    // 而隧道的帧本身已经在协议层做了分片（httpChunk），再压一层只多两个 bug 面。
    '',
    '',
  ].join('\r\n'))

  // 与 relay-protocol 的上限一致：一个帧不需要 64MB，声明大了只会拖垮单线程。
  const maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
  let buffer: Buffer = Buffer.alloc(0)
  let closed = false
  let closeSent = false
  let fragmented = false
  /** onClose 只通知一次。close()/terminate() 与 socket 的 'close' 事件是两个来源。 */
  let notified = false
  const notify = (code: number, reason: string): void => {
    if (notified) return
    notified = true
    options.onClose?.(connection, code, reason)
  }

  const connection: WebSocketConnection = {
    get closed() { return closed || socket.destroyed },
    get bufferedAmount() { return socket.writableLength },
    sendBinary(payload) { return write(OPCODE.binary, payload) },
    sendText(text) { return write(OPCODE.text, Buffer.from(text, 'utf8')) },
    close(code = 1000, reason = '') {
      if (connection.closed) return
      if (!closeSent) {
        closeSent = true
        // close 帧也要带掩码吗？服务端发的不用。这里直接写。
        socket.write(encodeMessage(OPCODE.close, closePayload(code, reason)))
      }
      closed = true
      // 给对端一点时间读到 close 帧再拆。立刻 destroy 会让对端只看到 1006。
      socket.end()
      setTimeout(() => { if (!socket.destroyed) socket.destroy() }, 2_000).unref()
      notify(code, reason)
    },
    terminate() {
      if (closed) return
      closed = true
      socket.destroy()
      notify(1006, 'terminated')
    },
  }

  function write(opcode: number, payload: Buffer): boolean {
    if (connection.closed) return false
    // 积压超限时不写：对端不读的时候继续写只会把服务端内存吃掉。
    if (socket.writableLength > maxBufferedBytes) return false
    try { socket.write(encodeMessage(opcode, payload)); return true }
    catch { return false }
  }

  function fail(reason: string): void {
    options.onError?.(connection, new Error(reason))
    connection.close(1002, reason)
  }

  socket.on('data', (chunk: Buffer) => {
    if (closed) return
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk)
    // 一个 chunk 里可能夹着多帧（客户端连续 send），也可能只有半帧。
    while (buffer.length >= 2) {
      const first = buffer[0]!
      const second = buffer[1]!
      const fin = (first & 0x80) !== 0
      const rsv = first & 0x70
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2

      // RSV：没协商扩展就不该有值。有值说明对端以为压过了，继续读只会解出错字。
      if (rsv !== 0) return fail('reserved bits set without negotiation')
      // 客户端发的帧必须带掩码（RFC 6455 5.1）。不带是代理或手写客户端漏了。
      if (!masked) return fail('client frame not masked')

      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const high = buffer.readUInt32BE(2)
        // 超过 4GB 的帧在一台随时可能爆内存的中转上等于攻击，不看载荷内容就拒。
        if (high !== 0) return fail('frame too large')
        length = buffer.readUInt32BE(6)
        offset = 10
      }
      if (length > maxFrameBytes) return fail('frame too large')
      // 控制帧必须 ≤125 字节且不分片（RFC 6455 5.5）。
      if (opcode >= 0x8 && (!fin || length > 125)) return fail('invalid control frame')

      if (buffer.length < offset + 4 + length) return
      const mask = buffer.subarray(offset, offset + 4)
      offset += 4
      const payload = Buffer.allocUnsafe(length)
      for (let index = 0; index < length; index += 1) payload[index] = buffer[offset + index]! ^ mask[index & 3]!
      buffer = buffer.subarray(offset + length)

      if (opcode === OPCODE.close) {
        const raw = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        if (!closeSent) {
          closeSent = true
          socket.write(encodeMessage(OPCODE.close, payload.subarray(0, 2)))
        }
        closed = true
        socket.end()
        options.onClose?.(connection, raw, reason)
        return
      }
      if (opcode === OPCODE.ping) { write(OPCODE.pong, payload); continue }
      if (opcode === OPCODE.pong) continue
      if (opcode === OPCODE.continuation) {
        // 分片：我们只在上面拒绝过控制帧分片，数据帧选择直接拒。
        fragmented = false
        return fail('fragmented message not supported')
      }
      if (opcode !== OPCODE.text && opcode !== OPCODE.binary) return fail(`unknown opcode ${opcode}`)
      if (!fin) { fragmented = true; return fail('fragmented message not supported') }
      if (fragmented) return fail('fragmented message not supported')
      options.onMessage?.(connection, payload, opcode === OPCODE.binary)
    }
  })

  socket.on('error', () => {
    // 对端 RST 是常态（手机关网、NAT 超时）。这里**不改 closed**：error 之后 Node 一定还会发
    // 'close'，而清理只应该在那一个地方做一次。早在这里置 closed，close 事件就会以为
    // 「已经关过了」而跳过回调，症状是隧道在服务端的登记永远删不掉。
  })
  socket.on('end', () => {
    // 对端发完 FIN 了：隧道已经死了，不管它有没有按规矩发 close 帧。
    // 为什么不能只等 'close'：对端 destroy()（手机断网、App 被杀、进程退出）时，服务端这边
    // 只收到 'end'，'close' 要等我们自己把写端也关掉才来 —— 实测就是这样。只等 'close'
    // 的症状是「隧道在服务端的登记永远删不掉」，手机每个请求都打到一条没人接的隧道上。
    if (!closed) { closed = true; notify(1006, 'peer closed') }
    socket.end()
  })
  socket.on('close', () => {
    // 兜底：对端直接断开（没发 close 帧）时走这里。notify 保证 onClose 总共只触发一次。
    const wasClean = closed
    closed = true
    notify(wasClean ? 1000 : 1006, wasClean ? 'closed' : 'socket closed')
  })
  // Nagle 关掉：隧道的帧普遍是小而密的（心跳、httpHead），攒包只会让延迟变长。
  // 入参声明成 Duplex（http 的 upgrade 回调就是这么给的），而 setNoDelay 在 net.Socket 上。
  ;(socket as Duplex & { setNoDelay?(on: boolean): unknown }).setNoDelay?.(true)
  return connection
}

/** 编一个 close 帧载荷：2B code + reason。reason 超长时按字节安全截断。 */
function closePayload(code: number, reason: string): Buffer {
  const valid = Number.isInteger(code) && code >= 1000 && code <= 4999
  const body = Buffer.from(reason, 'utf8').subarray(0, 123)
  const head = Buffer.allocUnsafe(2)
  head.writeUInt16BE(valid ? code : 1000, 0)
  return Buffer.concat([head, body])
}
