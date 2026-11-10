/**
 * 真机往返验收：对着一台**已经部署好**的中转跑一次
 *   register → registered → (手机) GET /i/<instanceId>/... → httpRequest → httpHead → httpChunk → httpEnd → 手机拿到响应。
 *
 * 与 smoke.sh 的分工：smoke.sh 只看中转自己的门面（/health、401、404、/tunnel 拒普通 HTTP），
 * 它证明不了「帧能从一端走到另一端」。这个脚本自己扮演宿主，所以它跑通就等于隧道通了。
 *
 * 用法：
 *   node scripts/roundtrip.mjs http://127.0.0.1:18800 <注册密钥>
 *   node scripts/roundtrip.mjs http://192.168.31.152:18800 "$CREW_RELAY_SECRET"
 *
 * 只用 Node 内置模块，不装依赖 —— 部署机上不该为了跑一次验收再装一套包。
 * 它走的是和中转同一份 ws 帧规则：WS 帧里装隧道帧，隧道帧头 [type 1B][id 4B BE][len 4B BE]。
 */
import { connect } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:18800').replace(/\/$/, '')
const SECRET = process.argv[3] ?? process.env.CREW_RELAY_SECRET ?? ''
const INSTANCE = process.env.CREW_ROUNDTRIP_INSTANCE ?? `smoke-${Date.now().toString(36)}`
const PATH = '/api/mobile/timeline?probe=1'
const BODY = JSON.stringify({ ok: true, via: 'relay', instance: INSTANCE })

/** 隧道帧类型（与 relay/src/relay-protocol.ts 的 T 一致，只取这里用到的几个）。 */
const T = { register: 0x01, registered: 0x02, httpRequest: 0x04, httpBody: 0x05, httpHead: 0x06, httpChunk: 0x07, httpEnd: 0x08, wsError: 0x0c, ping: 0x10, pong: 0x11 }

function encode(type, id, payload) {
  const body = payload == null ? Buffer.alloc(0)
    : Buffer.isBuffer(payload) ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  const head = Buffer.alloc(9)
  head.writeUInt8(type & 0xff, 0)
  head.writeUInt32BE(id >>> 0, 1)
  head.writeUInt32BE(body.length, 5)
  return Buffer.concat([head, body])
}

/**
 * 拆服务端发来的 WS 帧（服务端帧不加掩码），把载荷交给隧道解码器。
 * 两层不能混：socket 上是 RFC 6455，隧道帧是它的载荷。直接按隧道头读会把 0x82（FIN+binary）当成帧类型。
 */
function wsReader(onMessage) {
  let buf = Buffer.alloc(0)
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk)
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f
      let len = buf[1] & 0x7f
      let offset = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4 }
      else if (len === 127) {
        if (buf.length < 10) return
        // 这里不可能出现合法的 >4GiB 帧；只读低 32 位，保持全是 Number（readBigUInt64BE 会返回 BigInt）。
        len = buf.readUInt32BE(6) || 0x7fffffff
        offset = 10
      }
      if (buf.length < offset + len) return
      const payload = buf.subarray(offset, offset + len)
      buf = buf.subarray(offset + len)
      if (opcode === 0x1 || opcode === 0x2) onMessage(payload)
    }
  }
}

/** 流式解码隧道帧：一个 WS 消息里可能有多帧，一帧也可能跨多个消息。 */
function decoder(onFrame) {
  let buf = Buffer.alloc(0)
  return chunk => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 9) {
      const type = buf.readUInt8(0)
      const id = buf.readUInt32BE(1)
      const len = buf.readUInt32BE(5)
      if (buf.length < 9 + len) return
      const payload = buf.subarray(9, 9 + len)
      buf = buf.subarray(9 + len)
      onFrame({ type, id, payload })
    }
  }
}

/** 客户端帧必须加掩码（RFC 6455 5.1），中转会拒未加掩码的帧。 */
function wsFrame(payload, opcode = 0x2) {
  const mask = randomBytes(4)
  const len = payload.length
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
    : len < 65536 ? (() => { const b = Buffer.alloc(4); b[0] = 0x80 | opcode; b[1] = 0x80 | 126; b.writeUInt16BE(len, 2); return b })()
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 0x80 | 127; b.writeUInt32BE(0, 2); b.writeUInt32BE(len, 6); return b })()
  const body = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 1) body[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, body])
}

function fail(message) {
  console.error(`roundtrip: FAIL  ${message}`)
  process.exit(1)
}

const url = new URL(BASE)
const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
const key = randomBytes(16).toString('base64')
const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')

const socket = connect({ host: url.hostname, port })
let head = Buffer.alloc(0)
let upgraded = false

/** 手机的请求在注册完成后发；用 promise 串起来，避免时序猜谜。 */
let phoneResult
const phone = new Promise((resolve, reject) => { phoneResult = { resolve, reject } })

const tunnelDecoder = decoder(frame => {
  if (process.env.CREW_ROUNDTRIP_DEBUG) console.error(`dbg   frame type=0x${frame.type.toString(16)} id=${frame.id} len=${frame.payload.length}`)
  if (frame.type === T.registered) {
    // 注册完成 → 手机那一侧开始打。响应回来就在 onFrame 里收。
    console.log(`phone-> GET ${BASE}/i/${INSTANCE}${PATH}`)
    fetch(`${BASE}/i/${INSTANCE}${PATH}`, { headers: { 'x-crew-device': 'roundtrip' } })
      .then(async response => phoneResult.resolve({ status: response.status, body: await response.text() }))
      .catch(phoneResult.reject)
    return
  }
  if (frame.type === T.ping) { socket.write(wsFrame(encode(T.pong, 0, null))); return }
  if (frame.type === T.wsError) fail(`中转拒绝：${frame.payload.toString()}`)
  if (frame.type === T.httpRequest) {
    const request = JSON.parse(frame.payload.toString())
    console.log(`host<-  httpRequest id=${frame.id} ${request.method} ${request.path}`)
    // 回一段长度能装满一个 httpChunk 的响应，证明分片也能走。
    const chunks = [BODY.slice(0, 10), BODY.slice(10)]
    socket.write(wsFrame(encode(T.httpHead, frame.id, { status: 200, headers: { 'content-type': 'application/json', 'x-via': 'crew-roundtrip' } })))
    for (const chunk of chunks) socket.write(wsFrame(encode(T.httpChunk, frame.id, chunk)))
    socket.write(wsFrame(encode(T.httpEnd, frame.id, null)))
    console.log(`host->  httpHead 200 + ${chunks.length} × httpChunk + httpEnd`)
  }
})
const push = wsReader(payload => tunnelDecoder(payload))

const timer = setTimeout(() => fail('15s 内没有完成往返（注册或响应卡住了）'), 15_000)

socket.on('connect', () => {
  socket.write([
    `GET /tunnel HTTP/1.1`,
    `Host: ${url.hostname}:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...(SECRET ? [`Authorization: Bearer ${SECRET}`] : []),
    '', '',
  ].join('\r\n'))
})

socket.on('data', chunk => {
  if (upgraded) { push(chunk); return }
  head = Buffer.concat([head, chunk])
  const end = head.indexOf('\r\n\r\n')
  if (end < 0) return
  const text = head.subarray(0, end).toString('latin1')
  console.log(`host<-  ${text.split('\r\n')[0]}`)
  if (!/ 101 /.test(text.split('\r\n')[0] ?? '')) fail(`握手被拒：${text.split('\r\n')[0]}`)
  if (!text.includes(accept)) fail('Sec-WebSocket-Accept 不对')
  upgraded = true
  // 监听器必须在解掉握手残留**之前**挂上：同一批 data 里可能已经跟着 registered 帧，
  // 之前写在握手块里的 socket.on('data') 会一直跟着后面的数据走，而第二个监听器永远收不到。
  socket.on('data', chunk => push(chunk))
  console.log(`host    WS 101 已升级  ${BASE}/tunnel`)
  socket.write(wsFrame(encode(T.register, 0, { instanceId: INSTANCE, name: 'roundtrip-probe', secret: SECRET })))
  console.log(`host->  register instanceId=${INSTANCE}`)
  const rest = head.subarray(end + 4)
  if (rest.length) push(rest)
})

socket.on('error', error => fail(`socket 错误：${error.message}`))

phone.then(result => {
  clearTimeout(timer)
  console.log(`phone<- HTTP ${result.status}  ${result.body}`)
  if (result.status !== 200) fail(`手机侧状态码 ${result.status}`)
  if (result.body !== BODY) fail(`手机侧正文与宿主发的对不上：${result.body}`)
  console.log(`roundtrip: 通过  register → httpRequest → httpHead/chunk/end → 手机 200`)
  socket.destroy()
  process.exit(0)
}).catch(error => fail(`手机侧请求失败：${error.message}`))
