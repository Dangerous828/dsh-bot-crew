/**
 * 中转服务端。
 *
 * 手机打 `https://relay.example.com/i/<instanceId>/api/mobile/...`，中转在内存里找到那个
 * instanceId 的隧道，把请求拆成帧推下去、把响应按块拉回来。
 *
 * 三条设计上的取舍写在这里，因为它们都不是显然的：
 *
 * 1. **中转不认识业务路径**。它只管 `instanceId` + 剩余路径，不校验 `/api/mobile/` 前缀，
 *    也不解析请求体。业务面的守卫在宿主那边（设备表在宿主的磁盘上，凭据摘要只在那里），
 *    中转只做网络层的事：路由、限流、大小上限、心跳。多一道业务白名单只会让「宿主换了
 *    前缀、中转没跟上」变成一次线上事故。
 *
 * 2. **凭据什么时候算「验过」**。中转发不了设备凭据（它没有设备表），所以它看的是宿主的
 *    回答：宿主对带凭据的请求回 401/403，中转记一次失败；同一个来源刷多了就自己挡。
 *    这条闸拦的是**暴力尝试**，不是「没配对的人」——后者本来就进不去，因为宿主会 401。
 *
 * 3. **流式是逐块转，不是攒齐再发**。HTTP 响应 `httpHead` 到了就先写头，`httpChunk` 到了
 *    就写块，手机侧看到的是流。占内存的是一个请求的待发队列上限，不是整个响应。
 *
 * 协议细节见 relay-protocol.ts 与 docs/PROTOCOL.md。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { T, encodeFrame, frameDecoder, jsonFrame, parseJson, type Frame } from './relay-protocol.ts'
import { upgradeToWebSocket, type WebSocketConnection } from './websocket.ts'

/**
 * instanceId 的形状。
 *
 * 它会进 URL 路径、路由表、日志。带 `/` 或空白的 id 能让路由二义（`/i/a b/x` 到底是谁的），
 * 长度也有限制 —— 一个 200 字符的 id 在日志里占一整行，在反代的请求行上限里也够呛。
 */
const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** 一个 HTTP 请求在路上时，中转这边记的账。 */
interface PendingRequest {
  response: ServerResponse
  /** 已经写过响应头。之后再收到 httpHead 就是重复，忽略。 */
  headSent: boolean
  /** 已经结束。httpEnd / httpError / 超时之后再来的帧一律丢。 */
  done: boolean
  /** 手机的连接断了或主动取消时置上。 */
  cancelled: boolean
  timer?: NodeJS.Timeout
  /** 宿主那边的请求 id。 */
  id: number
  /** 发起这个请求的来源地址。凭据被判错时要在它名下记一次。 */
  address: string
}

/** 一条已登记的隧道。 */
interface Tunnel {
  instanceId: string
  connection: WebSocketConnection
  name: string
  /** 每个隧道自己的请求 id 空间：两条隧道同时从 1 开始，必须分表。 */
  requests: Map<number, PendingRequest>
  nextId: number
  /** 上一次收到 pong 的时间。中转据此判死。 */
  lastPong: number
  heartbeat?: NodeJS.Timeout
  connectedAt: number
  /** 这个实例已经打开的并发出站 HTTP 条数；超上限拒掉，不让一台手机把 NAS 打满。 */
  inflight: number
}

export interface RelayOptions {
  /** 中转侧要的注册密钥。设了就要求宿主在 register 帧或握手头里带着它。 */
  registerSecret?: string
  /** 健康检查的详细视图（列出了谁的机器在线）要的令牌。不设则详情不对外。 */
  adminToken?: string
  /** 心跳间隔。与宿主 15s、判死 45s 的节奏对齐：中转这边判死更宽（60s），免得两边同时抖。 */
  heartbeatIntervalMs?: number
  /** 多久收不到 pong 就 terminate。宿主自己 45s 判死，先动的是它。 */
  pongTimeoutMs?: number
  /** 注册超时：连上了却不注册的连接不占位。 */
  registerTimeoutMs?: number
  /** 宿主多久不回响应头就算 504。 */
  responseTimeoutMs?: number
  /** 单帧载荷上限。 */
  maxFrameBytes?: number
  /** 一个手机请求体的上限。宿主那边也有自己的 256KiB 上限，这里先挡在公网侧。 */
  maxRequestBodyBytes?: number
  /** 一个实例同时在跑的请求上限。 */
  maxInflightPerInstance?: number
  /** 同一个来源地址在窗口内失败多少次之后开始挡。 */
  authFailureLimit?: number
  /** 失败计数的窗口。 */
  authFailureWindowMs?: number
  /** 被挡住了多久之后放行（滑动）。 */
  authBlockMs?: number
  /** 日志。默认什么都不打；部署时接上结构化日志。 */
  log?: (line: { level: 'info' | 'warn' | 'error'; message: string; detail?: Record<string, unknown> }) => void
}

export interface Relay {
  /** 开始监听。返回真实端口（传 0 时由系统挑）。 */
  listen(port: number, host: string): Promise<number>
  close(): Promise<void>
  /** 当前登记着的 instanceId。测试与运维用。 */
  instances(): string[]
  /** 某条隧道的状态。没有就返回 undefined。 */
  status(instanceId: string): { instanceId: string; name: string; connectedAt: number; inflight: number; lastPong: number } | undefined
}

/** 32 字节恒比。长度不同直接 false，不抛 —— timingSafeEqual 长度不等会抛。 */
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 从请求里取出凭据：优先 Authorization: Bearer，其次 X-Crew-Credential。 */
function bearerOf(request: IncomingMessage): string {
  const header = String(request.headers.authorization ?? '')
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match) return match[1]!.trim()
  const direct = request.headers['x-crew-credential']
  return typeof direct === 'string' ? direct.trim() : ''
}

/**
 * 一个来源的失败计数。滑动窗口 + 封禁期。
 *
 * 用「来源地址」而不是「设备号」来记：设备号是攻击者随手填的，换一个就绕过计数；
 * 地址虽然可能被 NAT 共享，但被误伤的是「同住一个 NAT 的邻居」，不是自己。
 */
interface Strike { failures: number[]; blockedUntil: number }

export function createRelay(options: RelayOptions = {}): Relay {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000
  const pongTimeoutMs = options.pongTimeoutMs ?? 60_000
  const registerTimeoutMs = options.registerTimeoutMs ?? 10_000
  const responseTimeoutMs = options.responseTimeoutMs ?? 120_000
  const maxFrameBytes = options.maxFrameBytes ?? 64 * 1024 * 1024
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 256 * 1024
  const maxInflightPerInstance = options.maxInflightPerInstance ?? 64
  const authFailureLimit = options.authFailureLimit ?? 20
  const authFailureWindowMs = options.authFailureWindowMs ?? 60_000
  const authBlockMs = options.authBlockMs ?? 60_000
  const log = options.log ?? (() => {})
  const startedAt = Date.now()

  /** instanceId → 隧道。只有一条：同一个 id 后来者会把旧的那条顶掉。 */
  const tunnels = new Map<string, Tunnel>()
  /** 来源地址 → 失败记录。定期清理，不然它会随访问者的数量单调长。 */
  const strikes = new Map<string, Strike>()

  let server: Server | undefined
  let closing = false
  let pendingListen: Promise<void> | undefined
  const sweeper = setInterval(cleanStrikes, 60_000)
  sweeper.unref()

  // ── 限流 ───────────────────────────────────────────────────────────
  function cleanStrikes(): void {
    const now = Date.now()
    for (const [address, strike] of strikes) {
      strike.failures = strike.failures.filter(at => now - at < authFailureWindowMs)
      if (strike.failures.length === 0 && strike.blockedUntil < now) strikes.delete(address)
    }
  }

  function blocked(address: string): boolean {
    const strike = strikes.get(address)
    if (!strike) return false
    if (strike.blockedUntil > Date.now()) return true
    return false
  }

  function recordFailure(address: string): void {
    const now = Date.now()
    const strike = strikes.get(address) ?? { failures: [], blockedUntil: 0 }
    strike.failures = strike.failures.filter(at => now - at < authFailureWindowMs)
    strike.failures.push(now)
    if (strike.failures.length >= authFailureLimit) {
      strike.blockedUntil = now + authBlockMs
      // 只留最近的一批：封禁期间的失败不再累加成无限期封禁（否则正常用户被误封后永远解不开）。
      strike.failures = []
      log({ level: 'warn', message: 'address blocked after repeated failed authentication', detail: { address } })
    }
    strikes.set(address, strike)
  }

  /** 来源地址。反代后面用 X-Forwarded-For 的最左段 —— 那是原始客户端。 */
  function sourceOf(request: IncomingMessage): string {
    const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()
    return forwarded || request.socket.remoteAddress || 'unknown'
  }

  // ── 隧道生命周期 ───────────────────────────────────────────────────
  function dropTunnel(tunnel: Tunnel, reason: string): void {
    // 结束所有在途请求：手机不能挂着一个永远不来的响应。
    for (const [, pending] of tunnel.requests) {
      if (pending.done) continue
      pending.done = true
      if (pending.timer) clearTimeout(pending.timer)
      if (!pending.headSent) writeJson(pending.response, 502, { error: 'Host disconnected' })
      else pending.response.end()
    }
    tunnel.requests.clear()
    if (tunnel.heartbeat) clearInterval(tunnel.heartbeat)
    // 只删自己：新的连接可能已经顶掉了这个 id，别把新的那条删了。
    if (tunnels.get(tunnel.instanceId) === tunnel) tunnels.delete(tunnel.instanceId)
    log({ level: 'info', message: 'tunnel closed', detail: { instanceId: tunnel.instanceId, reason } })
  }

  function startHeartbeat(tunnel: Tunnel): void {
    tunnel.heartbeat = setInterval(() => {
      if (tunnel.connection.closed) { dropTunnel(tunnel, 'connection lost'); return }
      if (Date.now() - tunnel.lastPong > pongTimeoutMs) {
        // 对端已经死了，等挥手只会多等一个超时。
        log({ level: 'warn', message: 'pong timeout, terminating tunnel', detail: { instanceId: tunnel.instanceId } })
        dropTunnel(tunnel, 'pong timeout')
        tunnel.connection.terminate()
        return
      }
      tunnel.connection.sendBinary(encodeFrame(T.ping, 0, null))
    }, heartbeatIntervalMs)
    tunnel.heartbeat.unref?.()
  }

  function register(connection: WebSocketConnection, payload: Buffer, handshakeSecret: string, address: string): void {
    const message = parseJson(payload)
    const instanceId = typeof message.instanceId === 'string' ? message.instanceId : ''
    // 调用方（onUpgrade）已经校验过形状；这里再判一次是因为 register 是独立的一步，
    // 将来若有人从别处调用它，不该能绕过校验往路由表里塞一个带 `/` 的 id。
    if (!INSTANCE_ID.test(instanceId)) {
      connection.sendBinary(jsonFrame(T.wsError, 0, { code: 'bad-instance', message: 'instanceId must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}' }))
      connection.close(4000, 'bad instance')
      return
    }
    if (!offeredSecretMatches(message, handshakeSecret)) {
      log({ level: 'warn', message: 'register refused: bad secret', detail: { instanceId, address } })
      connection.sendBinary(jsonFrame(T.wsError, 0, { code: 'bad-secret', message: 'register secret is missing or wrong' }))
      connection.close(4001, 'bad secret')
      return
    }

    const existing = tunnels.get(instanceId)
    if (existing && existing.connection !== connection) {
      // 同一个 id 已经有活的隧道。什么情况下允许「接管」而不是「拒绝」？
      //
      // 断网重连时，旧连接常常还挂在服务端（TCP 半开：对面已经不在了，我们这边还没超时）。
      // 这时如果拒绝新连接，症状是「明明重连上了，手机还是连不上」，而且要等心跳超时（60s）才自愈。
      //
      // 判据是**身份**，不是先后：配了注册密钥时，只有出示同一把密钥的新连接才算同一台机器；
      // 没配密钥就没有身份可言，只能按「先来的算」，否则任何人都能用别人的 instanceId 把自己顶进去。
      if (options.registerSecret) {
        log({ level: 'info', message: 'taking over an existing tunnel', detail: { instanceId } })
      } else {
        connection.sendBinary(jsonFrame(T.wsError, 0, { code: 'instance-online', message: 'another tunnel is already registered for this instanceId' }))
        connection.close(4002, 'instance online')
        return
      }
      dropTunnel(existing, 'replaced by a new connection')
      // 顶掉旧的那条：它的在途请求已经被 dropTunnel 结束，连接也要断开，
      // 否则旧宿主会以为隧道还在，一直往一个没有请求的通道上发心跳。
      existing.connection.close(1000, 'replaced')
    }

    const tunnel: Tunnel = {
      instanceId,
      connection,
      name: typeof message.name === 'string' ? message.name.slice(0, 200) : '',
      requests: new Map(),
      nextId: 1,
      lastPong: Date.now(),
      connectedAt: Date.now(),
      inflight: 0,
    }
    tunnels.set(instanceId, tunnel)
    startHeartbeat(tunnel)
    // 回执：宿主收到它才算「注册完成」。mirror 字段保持与参考实现一致（本中转不存镜像）。
    connection.sendBinary(jsonFrame(T.registered, 0, { mirror: false }))
    log({ level: 'info', message: 'tunnel registered', detail: { instanceId, name: tunnel.name, address } })
  }

  function offeredSecretMatches(message: Record<string, unknown>, handshakeSecret: string): boolean {
    if (!options.registerSecret) return true
    const offered = (typeof message.secret === 'string' && message.secret) || handshakeSecret
    return !!offered && safeEqual(offered, options.registerSecret)
  }

  // ── 帧分发 ─────────────────────────────────────────────────────────
  function handleFrame(tunnel: Tunnel, frame: Frame): void {
    switch (frame.type) {
      case T.ping:
        tunnel.connection.sendBinary(encodeFrame(T.pong, 0, null))
        return
      case T.pong:
        tunnel.lastPong = Date.now()
        return
      case T.register:
        // 已经注册过的连接上再报一次注册是「更新名片」：参考实现是幂等的。这里接受但不重建隧道。
        return
      case T.httpHead: {
        const pending = tunnel.requests.get(frame.id)
        if (!pending || pending.done || pending.headSent) return
        const head = parseJson(frame.payload)
        const status = typeof head.status === 'number' && Number.isInteger(head.status) && head.status >= 100 && head.status <= 599 ? head.status : 502
        const headers = headerPairs(head.headers)
        pending.headSent = true
        // 宿主对带凭据的请求回 401/403，就是「这次凭据不对」。中转自己验不了设备凭据
        // （设备表在宿主那边），所以它只能靠宿主的回答计数 —— 但这就是暴力尝试在网线上的样子。
        // 不在这里记，公网上就没有任何东西在数「同一个地址试了多少次」。
        if (status === 401 || status === 403) recordFailure(pending.address)
        pending.response.writeHead(status, headers)
        // 头到了就撤掉「等头」的超时：之后是流式的，慢是正常的（SSE 可以挂很久）。
        if (pending.timer) { clearTimeout(pending.timer); pending.timer = undefined }
        return
      }
      case T.httpChunk: {
        const pending = tunnel.requests.get(frame.id)
        if (!pending || pending.done || !pending.headSent || pending.response.writableEnded) return
        // 手机读得慢时 write 会返回 false，但我们不等 drain：待发队列按字节封顶，
        // 超了就断开这个请求，而不是无限缓存（见 finish 的封顶判定）。
        pending.response.write(frame.payload)
        return
      }
      case T.httpEnd: {
        const pending = tunnel.requests.get(frame.id)
        if (!pending || pending.done) return
        pending.done = true
        if (pending.timer) clearTimeout(pending.timer)
        tunnel.requests.delete(frame.id)
        tunnel.inflight = Math.max(0, tunnel.inflight - 1)
        if (!pending.headSent) pending.response.writeHead(502, { 'content-type': 'application/json' })
        if (!pending.response.writableEnded) pending.response.end()
        return
      }
      case T.httpError: {
        const pending = tunnel.requests.get(frame.id)
        if (!pending || pending.done) return
        const message = parseJson(frame.payload).message
        pending.done = true
        if (pending.timer) clearTimeout(pending.timer)
        tunnel.requests.delete(frame.id)
        tunnel.inflight = Math.max(0, tunnel.inflight - 1)
        // 已经是 200 的流里出了错：不能改状态码了，只能结束连接让手机知道流断了。
        if (pending.headSent) { pending.response.end(); return }
        writeJson(pending.response, 502, { error: typeof message === 'string' ? 'Host reported an error' : 'Host reported an error' })
        return
      }
      default:
        // 中转不认识这个帧（例如 wsUpgrade，本轮不支持 WS 隧道）。宿主不该发，
        // 发了也只是丢掉 —— 断开整条隧道对别的请求伤害更大。
        return
    }
  }

  /** 只放行安全的响应头：逐跳头与 Content-Length 不能原样转发（正文长度由分块编码决定）。 */
  function headerPairs(raw: unknown): Record<string, string> {
    if (!raw || typeof raw !== 'object') return {}
    const pairs: Record<string, string> = {}
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      const lower = name.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      if (typeof value === 'string') pairs[name] = value
      else if (Array.isArray(value)) pairs[name] = value.filter(item => typeof item === 'string').join(', ')
      else if (typeof value === 'number') pairs[name] = String(value)
    }
    return pairs
  }

  // ── 手机这一条路 ───────────────────────────────────────────────────
  async function servePhone(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://relay.invalid')
    const address = sourceOf(request)

    if (url.pathname === '/health' || url.pathname === '/healthz') {
      serveHealth(url, request, response)
      return
    }

    const route = /^\/i\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!route) { writeJson(response, 404, { error: 'Not found' }); return }
    // 不解码就比对：instanceId 的字符集里本来就没有需要百分号编码的东西，所以「编码过的 id」
    // 一定是伪造的（`a%2Fb` 解出来是 `a/b`，而路由已经按字面的 `/` 切过了 —— 解码与切段用的是
    // 两套事实，那正是路径穿越的入口）。这里不匹配就 404，不做任何解码尝试。
    const instanceId = route[1]!
    const rest = route[2] ?? '/'
    if (!INSTANCE_ID.test(instanceId) || rest === '/') { writeJson(response, 404, { error: 'Not found' }); return }

    if (blocked(address)) {
      // 429 而不是 403：这是「你太快了」，不是「你不配」。
      writeJson(response, 429, { error: 'Too many failed attempts' }, { 'retry-after': String(Math.ceil(authBlockMs / 1000)) })
      return
    }

    const tunnel = tunnels.get(instanceId)
    if (!tunnel || tunnel.connection.closed) {
      writeJson(response, 404, { error: 'Unknown instance or host offline' })
      return
    }
    if (tunnel.inflight >= maxInflightPerInstance) {
      writeJson(response, 429, { error: 'Too many requests in flight' }, { 'retry-after': '1' })
      return
    }

    // 请求体：先读，边读边判上限。超了当场回 413，一个字节都不往隧道里送。
    let body: Buffer
    try {
      body = await readBody(request, maxRequestBodyBytes)
    } catch {
      writeJson(response, 413, { error: 'Request too large' })
      return
    }

    const id = tunnel.nextId++
    const pending: PendingRequest = { response, headSent: false, done: false, cancelled: false, id, address }
    tunnel.requests.set(id, pending)
    tunnel.inflight += 1

    // 手机走了：告诉宿主别干了。长任务（读盘、跑 worker）不给取消会一直占着宿主。
    const cancel = (): void => {
      if (pending.done) return
      pending.cancelled = true
      pending.done = true
      if (pending.timer) clearTimeout(pending.timer)
      tunnel.requests.delete(id)
      tunnel.inflight = Math.max(0, tunnel.inflight - 1)
      tunnel.connection.sendBinary(encodeFrame(T.httpCancel, id, null))
    }
    response.on('close', () => { if (!response.writableEnded) cancel() })

    // 请求头原样往下送，只去掉逐跳头（Connection、Upgrade 这些只对这一段连接有意义）。
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue
      if (typeof value === 'string') headers[name] = value
      else if (Array.isArray(value)) headers[name] = value.join(', ')
    }
    // 手机的真实地址带给宿主：宿主要靠它做自己的限流与日志，而到了宿主那里所有连接都是 127.0.0.1。
    headers['x-forwarded-for'] = address
    headers['x-relay-instance'] = instanceId

    const path = rest + url.search
    tunnel.connection.sendBinary(jsonFrame(T.httpRequest, id, { method: request.method ?? 'GET', path, headers }))
    // 正文按 64KiB 分块：一个 WS 消息塞 256KiB 会让宿主那边的解码缓冲一次吃下一整块。
    for (let offset = 0; offset < body.length; offset += BODY_CHUNK_BYTES) {
      tunnel.connection.sendBinary(encodeFrame(T.httpBody, id, body.subarray(offset, offset + BODY_CHUNK_BYTES)))
    }
    tunnel.connection.sendBinary(encodeFrame(T.httpBody, id, Buffer.alloc(0)))

    // 宿主迟迟不给响应头：回 504 并取消。给了头之后就不再计时（长流是正常的）。
    pending.timer = setTimeout(() => {
      if (pending.done || pending.headSent) return
      cancel()
      if (!response.headersSent) writeJson(response, 504, { error: 'Host did not answer in time' })
      else response.end()
    }, responseTimeoutMs)
    pending.timer.unref?.()
  }

  function serveHealth(url: URL, request: IncomingMessage, response: ServerResponse): void {
    const base = { ok: true, uptimeMs: Date.now() - startedAt, tunnels: tunnels.size }
    // 详细视图列出谁的机器在线。那是「谁在家、什么时候在家」的信息，不能公开。
    if (url.searchParams.get('detail') !== '1') { writeJson(response, 200, base); return }
    if (!options.adminToken) { writeJson(response, 401, { error: 'Detail view is not configured' }); return }
    const offered = bearerOf(request)
    if (!offered || !safeEqual(offered, options.adminToken)) { writeJson(response, 401, { error: 'Unauthorized' }); return }
    writeJson(response, 200, {
      ...base,
      instances: [...tunnels.values()].map(tunnel => ({
        instanceId: tunnel.instanceId, name: tunnel.name, connectedAt: tunnel.connectedAt, inflight: tunnel.inflight,
      })),
      blocked: [...strikes.entries()].filter(([, strike]) => strike.blockedUntil > Date.now()).map(([address]) => address).length,
    })
  }

  // ── 装配 ───────────────────────────────────────────────────────────
  /**
   * 新隧道的握手与登记。
   *
   * 两条不变量：注册帧之前只接受 register（否则就是协议错误）；登记成功之后这条连接才进路由表。
   * 解码器是每条连接一个 —— 放进模块作用域会被并发连接互相踩。
   */
  function onUpgrade(request: IncomingMessage, socket: Duplex): void {
    const url = new URL(request.url ?? '/', 'http://relay.invalid')
    if (url.pathname !== '/tunnel') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const address = sourceOf(request)
    if (blocked(address)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const handshakeSecret = bearerOf(request)
    let instance = ''
    let registered = false
    let registrationTimer: NodeJS.Timeout | undefined

    // 先声明再赋值：回调里会用到 connection，而 upgradeToWebSocket 还没返回。
    let connection: WebSocketConnection
    const pipeline = frameDecoder(frame => {
      if (!registered) {
        if (frame.type !== T.register) {
          connection.sendBinary(jsonFrame(T.wsError, 0, { code: 'not-registered', message: 'send a register frame first' }))
          connection.close(4004, 'not registered')
          return
        }
        const declared = parseJson(frame.payload).instanceId
        instance = typeof declared === 'string' ? declared : ''
        register(connection, frame.payload, handshakeSecret, address)
        // register 只在真的建立并登记了这条连接时才成功；被拒时它已经关掉了连接。
        const tunnel = tunnels.get(instance)
        if (tunnel && tunnel.connection === connection) {
          registered = true
          if (registrationTimer) { clearTimeout(registrationTimer); registrationTimer = undefined }
        }
        return
      }
      const tunnel = tunnels.get(instance)
      // 隧道已经被顶掉或关掉了：这条连接上的帧一律丢，不能串到新隧道里。
      if (!tunnel || tunnel.connection !== connection) return
      handleFrame(tunnel, frame)
    }, {
      maxFrameBytes,
      onError: error => {
        log({ level: 'warn', message: 'protocol error on tunnel', detail: { instance, error: error.message } })
        connection.close(1002, 'protocol error')
      },
    })

    const opened = upgradeToWebSocket(request, socket, {
      maxFrameBytes,
      onMessage: (_current, payload) => { pipeline(payload) },
      onClose: () => {
        if (registrationTimer) { clearTimeout(registrationTimer); registrationTimer = undefined }
        const tunnel = tunnels.get(instance)
        if (tunnel && tunnel.connection === connection) dropTunnel(tunnel, 'host closed')
      },
    })
    if (!opened) return
    connection = opened

    // 连上了却不注册：不占位。公网暴露面上最便宜的攻击就是「连上然后什么都不说」。
    registrationTimer = setTimeout(() => {
      if (registered) return
      connection.sendBinary(jsonFrame(T.wsError, 0, { code: 'register-timeout', message: 'no register frame within the deadline' }))
      connection.close(4003, 'register timeout')
    }, registerTimeoutMs)
    registrationTimer.unref?.()
  }

  function writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (response.headersSent) { response.end(); return }
    const text = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers })
    response.end(text)
  }

  return {
    async listen(port, host) {
      if (server) return port
      if (closing) return 0
      const created = createServer((request, response) => {
        servePhone(request, response).catch(error => {
          log({ level: 'error', message: 'request failed', detail: { error: String(error) } })
          if (!response.headersSent) writeJson(response, 500, { error: 'Internal error' })
          else response.end()
        })
      })
      created.on('upgrade', onUpgrade)
      // 长连接会被 node 默认的两分钟 requestTimeout 掐掉：SSE 与慢客户端都会踩到。
      created.requestTimeout = 0
      created.headersTimeout = 30_000
      created.keepAliveTimeout = 65_000
      server = created
      pendingListen = new Promise<void>((resolve, reject) => {
        created.once('error', reject)
        created.listen(port, host, () => { created.off('error', reject); resolve() })
      })
      await pendingListen
      pendingListen = undefined
      const address = created.address()
      return typeof address === 'object' && address ? address.port : port
    },
    async close() {
      closing = true
      if (pendingListen) await pendingListen.catch(() => {})
      clearInterval(sweeper)
      for (const tunnel of [...tunnels.values()]) {
        dropTunnel(tunnel, 'relay shutting down')
        tunnel.connection.close(1001, 'relay shutting down')
      }
      tunnels.clear()
      const running = server
      server = undefined
      if (!running) return
      // 先把挂着的连接掐掉，否则 close 会一直等它们自己结束（升级上来的是长连接，永远不会自己结束）。
      running.closeAllConnections()
      await new Promise<void>(resolve => running.close(() => resolve()))
    },
    instances() { return [...tunnels.keys()] },
    status(instanceId) {
      const tunnel = tunnels.get(instanceId)
      if (!tunnel) return undefined
      return { instanceId: tunnel.instanceId, name: tunnel.name, connectedAt: tunnel.connectedAt, inflight: tunnel.inflight, lastPong: tunnel.lastPong }
    },
  }

  function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // Fast path：声明的长度就超了，一个字节都不读。
      const declared = Number(request.headers['content-length'] ?? 0)
      if (Number.isFinite(declared) && declared > limit) { request.resume(); reject(new Error('body too large')); return }
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) {
          // 超了就停止接收：继续读只会把内存吃掉，而手机那边早就不该发这么多了。
          request.destroy()
          reject(new Error('body too large'))
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', reject)
    })
  }
}

/** 逐跳头：只对这一段连接有意义，转发过去会让「下一跳」误解这段连接的状态。 */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'])

/** 请求体分块的粒度。 */
const BODY_CHUNK_BYTES = 64 * 1024

