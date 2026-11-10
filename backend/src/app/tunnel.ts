/**
 * 宿主的出站隧道：主动连到中转，把中转带回来的请求交给消息面处理器。
 *
 * 为什么是「出站」：宿主可能在一个没有公网 IP、没有端口映射、手机也不在同一个 Wi-Fi 的
 * 地方。出站连接是唯一一条「不管 NAT 与防火墙怎么配都能建起来」的路 —— 代价是它对端必须
 * 有一个能被手机找到的地址，那就是中转。
 *
 * 与 `lan-server.ts` 的关系是并存，不是替代：同一个 Wi-Fi 下直连更快也更稳（少一跳、
 * 不受公网影响），所以局域网可达时走直连；出门之后直连不存在，隧道是唯一的路。
 * 谁先用由 relay-chain.ts 那条降级链决定。
 *
 * 协议细节见 `relay-protocol.ts`；本文件只负责「接起来、转发、断了重连」。
 */
import { T, decodeClosePayload, encodeClosePayload, encodeFrame, frameDecoder, jsonFrame, parseJson, type Frame } from './relay-protocol.ts'

/** 宿主发 ping 的节奏。与参考实现一致：15s 一拍，45s 三拍没回就自己判死。 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
/** 多久收不到 pong 判死。必须比中转的 60s 早，见下面 `reconnect` 的注释。 */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000

/** 退避参数。 */
export interface BackoffOptions {
  /** 第一次重连等待。 */
  initialMs: number
  /** 上限。到顶之后不再增长，但仍然重试 —— 一直退到「再也不连」等于放弃出门。 */
  maxMs: number
  /** 抖动比例（0..1）。多条隧道同时掉线时错开，不要一起撞同一个中转。 */
  jitter: number
}

const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1_000, maxMs: 60_000, jitter: 0.2 }

/**
 * 第 `attempt` 次重连该等多久。
 *
 * 指数退避而不是固定间隔：中转重启通常几秒，而网络彻底断了可能一整天。固定 5s 会在断一整天
 * 时产生一万七千次连接；固定 60s 会在中转重启时让人白等一分钟。取两者之长。
 *
 * 抖动是 ±jitter 比例。没有抖动的话，一次中转重启会让所有宿主在同一毫秒一起回来。
 */
export function backoffDelay(attempt: number, options: BackoffOptions = DEFAULT_BACKOFF): number {
  const step = Math.max(1, Math.floor(attempt))
  // 2^(step-1) 在 step 很大时会溢出成 Infinity；用 maxMs 兜住，先判再加。
  const raw = options.initialMs * 2 ** Math.min(step - 1, 30)
  const ceiling = Math.min(raw, options.maxMs)
  if (options.jitter <= 0) return ceiling
  const spread = ceiling * options.jitter
  return Math.max(1, Math.round(ceiling - spread + Math.random() * spread * 2))
}

/** 上游收到的一个请求。与 lan-server 的 forward 形状一致，两条路可以共用同一个处理器。 */
export interface TunnelRequest {
  method: string
  /** 路径加查询串，如 `/api/mobile/timeline?x=1`。 */
  url: string
  headers: Record<string, string>
  body: string
}

/** 谁能接住中转发来的请求。`signal` 在手机那边放弃时被推倒。 */
export type TunnelForward = (request: TunnelRequest, signal: AbortSignal) => Promise<Response> | Response

export interface TunnelOptions {
  /**
   * 一条或几条中转的隧道地址，如 `wss://relay.example.com/tunnel`。第一条是自建，其余是兜底。
   *
   * 为什么是一组而不是一条：中转最可能的死法是「那台机器或它所在的那条网挂了」。
   * 只有一条地址时，挂了就是挂了；给第二条地址（在另一个故障域）才有东西可退。
   * 轮转的顺序是固定的：连第 1 条失败 → 换第 2 条；第 2 条也失佰 → 回到第 1 条。
   * 不在运行时重新排序 —— 第 1 条只是暂时不通，它优先是有原因的（见 relay-chain.ts）。
   */
  relayUrl: string | string[]
  /** 这台宿主的 id。中转按它路由，所以必须稳定 —— 换一次手机就要重新找路。 */
  instanceId: string
  /** 给人看的名字，中转只做展示。 */
  name?: string
  /** 中转侧的注册密钥。走 register 帧而不是 URL，避免进反代日志。 */
  registerSecret?: string
  forward: TunnelForward
  /** 心跳与判死的节奏。 */
  heartbeat?: { intervalMs?: number; timeoutMs?: number }
  backoff?: Partial<BackoffOptions>
  /**
   * 每收/发一帧都回调一次（排障与测试用）。
   * `direction` 区分方向：只给收到的，会让「我到底发没发出去」这种问题查不到。
   */
  onFrame?: (frame: { type: number; id: number; direction: 'in' | 'out'; json: Record<string, unknown> }) => void
  /** 日志。 */
  onLog?: (line: string) => void
}

/** 隧道的状态。`live` 之外的状态都意味着「这一刻手机走隧道会失败」。 */
export type TunnelState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed'

export interface Tunnel {
  /** 连上去并注册。注册失败也会按退避继续重试 —— 第一次连不上是常态（人可能还没出门）。 */
  start(): Promise<void>
  close(): Promise<void>
  state(): TunnelState
  /** 当前连的是哪一条地址（降级链用它记录最后成功的那条）。 */
  relayUrl(): string
}

/** 一个在途的上游请求。 */
interface Inflight {
  controller: AbortController
  /** 请求体还在收，body 还没结束。 */
  bodyDone: boolean
  chunks: Buffer[]
}

/**
 * 一条隧道。
 *
 * 状态机很小：idle → connecting → live → (reconnecting → connecting …) → closed。
 * 只有 `live` 时中转才认这条连接；其余时候手机的请求会拿到 404/502。
 */
export function createTunnel(options: TunnelOptions): Tunnel {
  const heartbeatInterval = options.heartbeat?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const heartbeatTimeout = options.heartbeat?.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  const backoffOptions: BackoffOptions = { ...DEFAULT_BACKOFF, ...options.backoff }
  const log = options.onLog ?? (() => {})

  let state: TunnelState = 'idle'
  let socket: WebSocket | undefined
  let attempt = 0
  /** 当前用第几条地址。失败一次推进一条，轮一遍之后回到第 0 条。 */
  let cursor = 0
  const addresses = (Array.isArray(options.relayUrl) ? options.relayUrl : [options.relayUrl]).filter(Boolean)
  if (addresses.length === 0) throw new Error('a tunnel needs at least one relay url')
  let retryTimer: NodeJS.Timeout | undefined
  let heartbeatTimer: NodeJS.Timeout | undefined
  let lastPong = 0
  /** 每个在途请求的账。id 由宿主分配：同一时刻一个 id 只对应一个请求。 */
  const inflight = new Map<number, Inflight>()
  /** 请求元信息按 id 暂存：httpRequest 带元信息，body 随后分段到，两者要拼在一起才交给上游。 */
  const pendingMeta = new Map<number, Record<string, unknown>>()
  let nextId = 1
  /** 关掉之后不再重连。 */
  let stopped = false
  /** 这一次连接等到「注册成功」或「失败」的 resolver。start() 要靠它才不是在撒谎。 */
  let settle: ((reached: boolean) => void) | undefined
  /** 注册失败的次数：用来区分「网络不好」和「配置错了」。前者退避，后者也退避但记日志。 */
  let lastError = ''

  function setState(next: TunnelState): void {
    if (state === next) return
    state = next
    log(`tunnel ${options.instanceId}: ${next}`)
  }

  /**
   * 把一帧发出去。
   *
   * Node 里 `Buffer` 的泛型是 `Buffer<ArrayBufferLike>`，而全局 `WebSocket.send` 收的
   * `BufferSource` 要求 `ArrayBufferView<ArrayBuffer>` —— 两者运行时完全一样，只是 Node 的
   * 类型把 SharedArrayBuffer 的情况也算了进去。所以这里统一转成 `Uint8Array` 再交出去。
   */
  function post(frame: Buffer): void {
    const open = socket
    if (!open || open.readyState !== 1) return
    try { open.send(new Uint8Array(frame)) }
    catch (error) { log(`tunnel ${options.instanceId}: send failed: ${String(error)}`) }
  }

  /** 发一帧。没连上就丢掉：隧道断了之后在途请求本来就该失败（由清理清理掉）。 */
  function send(type: number, id: number, payload?: Buffer | string | object | null): void {
    if (!socket || socket.readyState !== 1) return
    options.onFrame?.({
      type, id, direction: 'out',
      json: payload && typeof payload === 'object' && !Buffer.isBuffer(payload) ? payload as Record<string, unknown> : {},
    })
    post(encodeFrame(type, id, payload ?? null))
  }

  function sendJson(type: number, id: number, body: Record<string, unknown>): void {
    if (!socket || socket.readyState !== 1) return
    options.onFrame?.({ type, id, direction: 'out', json: body })
    post(jsonFrame(type, id, body))
  }

  function registrationPayload(): Record<string, unknown> {
    return {
      instanceId: options.instanceId,
      // 名字只是展示；密钥是身份。两者都不带配对码 —— 那玩意不该离开宿主。
      ...(options.name ? { name: options.name } : {}),
      ...(options.registerSecret ? { secret: options.registerSecret } : {}),
    }
  }

  // ── 连接与重连 ─────────────────────────────────────────────────────
  async function connect(): Promise<void> {
    if (stopped) return
    setState(state === 'idle' ? 'connecting' : 'reconnecting')
    const opened = new WebSocket(addresses[cursor % addresses.length]!)
    socket = opened
    opened.binaryType = 'arraybuffer'

    const decoder = frameDecoder(frame => handleFrame(frame), {
      // 中转发来的帧照单全收；上限与中转侧一致。
      onError: error => { log(`tunnel ${options.instanceId}: bad frame: ${error.message}`) },
    })

    opened.addEventListener('message', event => {
      const data = event.data
      if (data instanceof ArrayBuffer) decoder(Buffer.from(data))
      else if (typeof data === 'string') decoder(Buffer.from(data, 'utf8'))
      else if (Buffer.isBuffer(data)) decoder(data)
    })
    opened.addEventListener('open', () => {
      lastPong = Date.now()
      sendJson(T.register, 0, registrationPayload())
      startHeartbeat()
    })
    opened.addEventListener('error', event => {
      // 浏览器的 `error` 事件没有细节。这里只记一笔，真正的处理在 close 里统一做。
      lastError = describeError(event)
      log(`tunnel ${options.instanceId}: socket error: ${lastError}`)
    })
    opened.addEventListener('close', event => {
      stopHeartbeat()
      // 断开时的清理：所有在途请求都在一条已经没人接的路上等，必须立刻失败。
      for (const [id, entry] of inflight) {
        entry.controller.abort(new Error('tunnel closed'))
        inflight.delete(id)
      }
      if (socket === opened) socket = undefined
      // 第一次连接失败要如实报告给 start()；之后的失败只是重连循环的一部分。
      settle?.(false)
      settle = undefined
      if (stopped) { setState('closed'); return }
      // 换下一条地址再退避重连。`attempt` 只用来算等待时间，不受换地址影响 ——
      // 「刚换了一条地址」不等于「该从头快速重试」：新地址大概率也是同一个原因不通。
      if (addresses.length > 1) {
        const previous = addresses[cursor % addresses.length]!
        cursor = (cursor + 1) % addresses.length
        log(`tunnel ${options.instanceId}: moving to ${addresses[cursor]!} (previous ${previous} did not answer)`)
      }
      attempt += 1
      scheduleReconnect()
    })
  }

  function scheduleReconnect(): void {
    if (stopped || retryTimer) return
    setState('reconnecting')
    const delay = backoffDelay(attempt, backoffOptions)
    log(`tunnel ${options.instanceId}: reconnecting in ${delay}ms (attempt ${attempt})`)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void connect()
    }, delay)
    // 这个计时器不该让进程为了它而活着。
    retryTimer.unref?.()
  }

  // ── 心跳 ───────────────────────────────────────────────────────────
  /**
   * 宿主自己先判死，而不是等中转踢。
   *
   * 反过来（等中转 60s terminate）会让宿主在这段时间里仍然显示「已连接」，而手机的请求
   * 每一个都要等中转的超时才见到失败。自己 45s 判死，重连就早 15s 开始。
   */
  function startHeartbeat(): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (!socket || socket.readyState !== 1) return
      if (Date.now() - lastPong > heartbeatTimeout) {
        log(`tunnel ${options.instanceId}: heartbeat timeout, dropping`)
        const dead = socket
        socket = undefined
        try { dead.close() } catch { /* ignore */ }
        // close 事件里会走重连；但如果 close 事件没来（半死状态），这里也要推一把。
        if (!retryTimer) { attempt += 1; scheduleReconnect() }
        return
      }
      send(T.ping, 0, null)
    }, heartbeatInterval)
    heartbeatTimer.unref?.()
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined }
  }

  // ── 帧分发 ─────────────────────────────────────────────────────────
  function handleFrame(frame: Frame): void {
    const { type, id, payload } = frame
    options.onFrame?.({ type, id, direction: 'in', json: parseJson(payload) })
    switch (type) {
      case T.registered: {
        attempt = 0
        setState('live')
        settle?.(true)
        settle = undefined
        return
      }
      case T.ping:
        send(T.pong, 0, null)
        return
      case T.pong:
        lastPong = Date.now()
        return
      case T.httpRequest: {
        // 元信息先到，body 随后分段到。两样都齐了才交给上游。
        const meta = parseJson(payload)
        pendingMeta.set(id, meta)
        beginRequest(id)
        return
      }
      case T.httpBody: {
        const entry = inflight.get(id)
        if (!entry || entry.bodyDone) return
        if (payload.length === 0) { entry.bodyDone = true; void dispatch(id, entry); return }
        entry.chunks.push(Buffer.from(payload))
        return
      }
      case T.httpCancel: {
        // 手机那边不要了：把上游也放掉。
        const entry = inflight.get(id)
        if (entry) { entry.controller.abort(new Error('cancelled by client')); inflight.delete(id) }
        return
      }
      case T.wsError:
        // id=0 的是中转在断开前给的一句话（注册被拒之类）。只记日志：重连由 close 驱动。
        if (id === 0) log(`tunnel ${options.instanceId}: relay said: ${JSON.stringify(parseJson(payload))}`)
        return
      default:
        // 不认识的帧（比如 wsUpgrade，本轮不支持 WS 隧道）丢掉，不弄断隧道。
        return
    }
  }

  /**
   * 收下请求的开头，等 body 结束（或第一个空 httpBody）再交给上游。
   *
   * 没有 body 的请求（GET）中转也会立刻发一个空 httpBody，所以这里不必自己判断「该不该等」——
   * 等就对了。这也是为什么状态放在 inflight 里而不是放在栈上：httpRequest 与 httpBody 是
   * 两条独立的帧，中间可能夹着别的请求。
   */
  function beginRequest(id: number): void {
    inflight.set(id, { controller: new AbortController(), bodyDone: false, chunks: [] })
  }

  /** 把收齐的请求交给上游，并把响应拆成帧发回去。 */
  async function dispatch(id: number, entry: Inflight): Promise<void> {
    const meta = pendingMeta.get(id)
    if (!meta) { inflight.delete(id); return }
    const url = typeof meta.path === 'string' ? meta.path : '/'
    const method = typeof meta.method === 'string' ? meta.method : 'GET'
    const headers: Record<string, string> = {}
    if (meta.headers && typeof meta.headers === 'object' && !Array.isArray(meta.headers)) {
      for (const [name, value] of Object.entries(meta.headers as Record<string, unknown>)) {
        if (typeof value === 'string') headers[name] = value
      }
    }
    const body = Buffer.concat(entry.chunks).toString('utf8')
    try {
      const answered = await options.forward({ method, url, headers, body }, entry.controller.signal)
      await relay(answered, id, entry.controller.signal)
    } catch (error) {
      // 上游的错误细节不能漏到手机上：里面可能有本机路径。而且隧道本身要活着。
      if (entry.controller.signal.aborted) { sendJson(T.httpError, id, { message: 'cancelled' }); return }
      log(`tunnel ${options.instanceId}: upstream failed: ${String(error)}`)
      sendJson(T.httpError, id, { message: 'upstream failed' })
    } finally {
      inflight.delete(id)
      pendingMeta.delete(id)
    }
  }

  /** 把上游的 Response 拆成 httpHead + httpChunk* + httpEnd。 */
  async function relay(answered: Response, id: number, signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = {}
    answered.headers.forEach((value, name) => { headers[name] = value })
    sendJson(T.httpHead, id, { status: answered.status, headers })
    if (!answered.body) { send(T.httpEnd, id, null); return }
    const reader = answered.body.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (signal.aborted) { try { await reader.cancel() } catch { /* ignore */ } break }
        if (value && value.length) send(T.httpChunk, id, Buffer.from(value))
      }
    } finally {
      if (signal.aborted) { try { await reader.cancel() } catch { /* ignore */ } }
      else send(T.httpEnd, id, null)
    }
  }


  return {
    async start() {
      stopped = false
      attempt = 0
      // 等「注册成功」或「第一次失败」：一个立刻返回的 start() 会让调用方以为隧道已经能用了，
      // 而实际上这时候手机的请求会拿到 404。连不上不抛异常 —— 第一次连不上是常态，
      // 退避重连已经排上了；调用方看 state() 就知道。
      const reached = new Promise<boolean>(resolve => { settle = resolve })
      void connect()
      await reached
    },
    async close() {
      stopped = true
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined }
      stopHeartbeat()
      const open = socket
      socket = undefined
      for (const [id, entry] of inflight) {
        entry.controller.abort(new Error('tunnel closed'))
        inflight.delete(id)
      }
      pendingMeta.clear()
      if (open) {
        try { open.close(1000, 'closed by host') } catch { /* ignore */ }
      }
      setState('closed')
    },
    state() { return state },
    relayUrl() { return addresses[cursor % addresses.length]! },
  }
}

/** 从浏览器风格的 error 事件里捞一点能看的字。 */
function describeError(event: Event): string {
  const candidate = event as unknown as { message?: string; error?: { message?: string } }
  return candidate.message ?? candidate.error?.message ?? 'socket error'
}

export { DEFAULT_BACKOFF, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_TIMEOUT_MS, decodeClosePayload, encodeClosePayload }
