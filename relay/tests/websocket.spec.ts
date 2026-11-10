import { createServer, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { acceptKey, encodeMessage, handshakeProblem, upgradeToWebSocket, type WebSocketConnection } from '../src/websocket.ts'
import type { IncomingMessage } from 'node:http'

/** 一套「起个服务、把 upgrade 交给 websocket.ts、记下连接」的脚手架。 */
const running: (() => Promise<void>)[] = []
/** 测试里开过的客户端 socket：不掐掉的话 server.close() 会一直等它们自己结束。 */
const sockets: Socket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const stop of running.splice(0)) await stop()
})

async function serve(options: Parameters<typeof upgradeToWebSocket>[2] = {}): Promise<{ port: number; connections: WebSocketConnection[]; messages: Buffer[] }> {
  const server: Server = createServer()
  const connections: WebSocketConnection[] = []
  const messages: Buffer[] = []
  server.on('upgrade', (request, socket) => {
    const connection = upgradeToWebSocket(request, socket, {
      ...options,
      onMessage: (connection, payload) => { messages.push(payload); options.onMessage?.(connection, payload, true) },
    })
    if (connection) connections.push(connection)
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(typeof address === 'object' && address ? address.port : 0)
  }))
  running.push(() => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) }))
  return { port, connections, messages }
}

/** 裸客户端：自己拼握手与帧，这样能构造 `ws` 库不肯发的畸形输入。 */
function rawConnect(port: number): Promise<{ socket: Socket; status: string; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.on('connect', () => {
      socket.write([
        'GET /tunnel HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'))
    })
    let head = Buffer.alloc(0)
    const settle = () => {
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onData)
      resolve({ socket, status: head.subarray(0, end).toString(), head: head.subarray(end + 4) })
    }
    const onData = (chunk: Buffer) => { head = Buffer.concat([head, chunk]); settle() }
    socket.on('data', onData)
    socket.on('error', reject)
    sockets.push(socket)
  })
}

/** 客户端帧必须加掩码。 */
function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const length = payload.length
  let header: Buffer
  if (length < 126) { header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | length]) }
  else { header = Buffer.alloc(4); header[0] = (fin ? 0x80 : 0) | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(length, 2) }
  const body = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) body[index] = payload[index]! ^ mask[index & 3]!
  return Buffer.concat([header, mask, body])
}

it('computes the accept key the way RFC 6455 says', () => {
  // 这是 RFC 6455 §1.3 里的示例值。算错的话所有浏览器与客户端都会拒绝握手。
  expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

it('completes a handshake and exchanges payloads both ways', async () => {
  const { port, messages, connections } = await serve()
  const { socket, status } = await rawConnect(port)
  expect(status).toContain('101')
  socket.write(maskedFrame(0x2, Buffer.from('hello tunnel')))
  await new Promise(done => setTimeout(done, 60))
  expect(messages.map(item => item.toString())).toEqual(['hello tunnel'])
  // 服务端回的是不含掩码的帧（RFC 6455 5.1：服务端不得加掩码）。
  connections[0]!.sendBinary(Buffer.from('back'))
  socket.destroy()
})

it('spells out why a bad upgrade was refused, and refuses it', async () => {
  const request = (headers: Record<string, string | undefined>, method = 'GET') => ({ method, headers }) as unknown as IncomingMessage
  expect(handshakeProblem(request({ upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'x' }))).toBeUndefined()
  expect(handshakeProblem(request({ upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '8', 'sec-websocket-key': 'x' }))).toMatch(/version/)
  expect(handshakeProblem(request({ upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13' }))).toMatch(/key/)
  expect(handshakeProblem(request({ upgrade: 'h2c', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'x' }))).toMatch(/websocket/)
  expect(handshakeProblem(request({ upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'x' }, 'POST'))).toMatch(/method/)
})

it('answers a ping frame with a pong', async () => {
  const { port, messages } = await serve()
  const { socket } = await rawConnect(port)
  const answered: Buffer[] = []
  socket.on('data', (chunk: Buffer) => answered.push(chunk))
  socket.write(maskedFrame(0x9, Buffer.from('p')))
  await new Promise(done => setTimeout(done, 60))
  // 服务端的 pong：opcode 0xA，无掩码，载荷原样回。
  expect(answered.some(frame => frame.length >= 3 && frame[0] === 0x8a && frame[2] === 0x70)).toBe(true)
  // ping 是控制帧，不该当数据交给上层。
  expect(messages).toHaveLength(0)
  socket.destroy()
})

it('sends a large payload with the 64-bit length form', () => {
  const payload = Buffer.alloc(70_000, 7)
  const frame = encodeMessage(0x2, payload)
  expect(frame[1]).toBe(127)
  expect(frame.readUInt32BE(2)).toBe(0)
  expect(frame.readUInt32BE(6)).toBe(70_000)
  expect(frame.length).toBe(10 + 70_000)
})

it('uses the 16-bit length form in the middle range', () => {
  const frame = encodeMessage(0x2, Buffer.alloc(600))
  expect(frame[1]).toBe(126)
  expect(frame.readUInt16BE(2)).toBe(600)
})

it('closes with the code it was given so the peer can tell why', async () => {
  const { port, connections } = await serve()
  const { socket } = await rawConnect(port)
  await new Promise(done => setTimeout(done, 30))
  const received: Buffer[] = []
  socket.on('data', (chunk: Buffer) => received.push(chunk))
  connections[0]!.close(4001, '会话结束')
  await new Promise(done => setTimeout(done, 80))
  const close = received.map(item => Buffer.from(item)).find(item => item[0] === 0x88)
  expect(close).toBeDefined()
  expect(close!.readUInt16BE(2)).toBe(4001)
  socket.destroy()
})

it('refuses an unmasked client frame instead of reading the mask off the payload', async () => {
  const { port } = await serve()
  const { socket } = await rawConnect(port)
  const closed = new Promise<void>(resolve => socket.on('close', () => resolve()))
  // 无掩码的帧：payload 前 4 字节会被当成掩码读，整个解出来是垃圾。必须判协议错误。
  socket.write(Buffer.from([0x82, 0x03, 0x61, 0x62, 0x63]))
  await closed
})

it('refuses a fragmented message instead of mixing it into the next one', async () => {
  const { port, messages } = await serve()
  const { socket } = await rawConnect(port)
  const closed = new Promise<void>(resolve => socket.on('close', () => resolve()))
  socket.write(maskedFrame(0x2, Buffer.from('first half'), false))
  await closed
  expect(messages).toHaveLength(0)
})

it('refuses a frame larger than the cap before buffering it', async () => {
  const { port } = await serve({ maxFrameBytes: 64 })
  const { socket } = await rawConnect(port)
  const closed = new Promise<void>(resolve => socket.on('close', () => resolve()))
  // 只发头：声称 1MB。
  const header = Buffer.from([0x82, 0x80 | 126, 0x10, 0x00])
  socket.write(header)
  await closed
})

it('refuses reserved bits set by a peer that thinks it negotiated compression', async () => {
  const { port } = await serve()
  const { socket } = await rawConnect(port)
  const closed = new Promise<void>(resolve => socket.on('close', () => resolve()))
  const frame = maskedFrame(0x2, Buffer.from('x'))
  frame[0] = frame[0]! | 0x40 // RSV1
  socket.write(frame)
  await closed
})
