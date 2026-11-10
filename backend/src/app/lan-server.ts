import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * 手机走的那条路。
 *
 * 为什么不复用 Connection：它认的是 DSH 进程启动时发的 launch token（用 URL 换签名 cookie），
 * 那是给浏览器设计的，没有给「长期携带凭据的手机」留位置。实测它的 /api 传输对任何非浏览器
 * 请求都回 `invalid or missing bearer token`。
 *
 * 所以这里开一个独立监听，用队伍自己签发的设备凭据验，验过再转发。
 * 做法与 dsh-mobile-plugin 的 lib/relay/lan-proxy.js 一致。
 */

/** 设备表里这一条做什么用：它只回答「这枚凭据是不是这台设备的」。 */
export interface LanDevices {
  allows(deviceId: string, token: string): boolean
}

export interface LanServerOptions {
  devices: LanDevices
  /** 凭据验过之后把请求交给谁；返回值原样写回手机。 */
  forward(request: { method: string; url: string; headers: IncomingMessage['headers']; body: string }): Promise<Response>
}

export interface LanServer {
  listen(port: number, host: string): Promise<number>
  /** 一次绑多个地址：手机走局域网，本机与模拟器走回环，两边都要能用。返回真的绑上的那些。 */
  listenAll(port: number, hosts: string[]): Promise<string[]>
  close(): Promise<void>
}

const MAX_BODY_BYTES = 256 * 1024

/** 手机出示的凭据与设备号。取不到就是没有，不给默认值。 */
function presented(headers: IncomingMessage['headers']): { deviceId: string; token: string } | undefined {
  const device = headers['x-crew-device']
  const token = headers['x-crew-credential']
  const deviceId = Array.isArray(device) ? device[0] : device
  const credential = Array.isArray(token) ? token[0] : token
  if (typeof deviceId !== 'string' || !deviceId.trim()) return undefined
  if (typeof credential !== 'string' || !credential.trim()) return undefined
  return { deviceId: deviceId.trim(), token: credential.trim() }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Buffer)
    size += bytes.length
    // 超了就断开，不把内存吃掉。
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createLanServer(options: LanServerOptions): LanServer {
  const { devices, forward } = options
  // 一个地址一个监听：每个地址有独立的句柄与 socket 集合。
  const servers = new Map<string, Server>()
  const socketsFor = new Map<Server, Set<import('node:net').Socket>>()
  let server: Server | undefined
  let sockets = new Set<import('node:net').Socket>()
  // 关得比听得快时（启动即失败、热重载），把「关」记下来，等 listen 落地再执行。
  let closing: Promise<void> | undefined
  let pending: Promise<void> | undefined

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // 这条路只服务手机消息面。别的路径一律不接：将来消息面若长了非手机用途的接口，
    // 这里不会因为它们存在就自动放出去。
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    if (!path.startsWith('/api/mobile/')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    const said = presented(request.headers)
    // 验不过就说 401，不区分「设备不对」和「凭据不对」：那是在帮尝试者筛选。
    if (!said || !devices.allows(said.deviceId, said.token)) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Not paired' }))
      return
    }
    let body: string
    try {
      body = await readBody(request)
    } catch {
      response.writeHead(413, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Request too large' }))
      return
    }
    try {
      const answered = await forward({ method: request.method ?? 'GET', url: request.url ?? '/', headers: request.headers, body })
      const headers: Record<string, string> = { 'cache-control': 'no-store' }
      const type = answered.headers.get('content-type')
      if (type) headers['content-type'] = type
      response.writeHead(answered.status, headers)
      response.end(Buffer.from(await answered.arrayBuffer()))
    } catch {
      // 转发出错不能把细节漏给手机：里面可能有本机路径和内部错误。
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Crew unavailable' }))
    }
  }

  const closeServer = async (): Promise<void> => {
    // listen 还在路上就先等它落地，否则会漏掉一个监听。
    if (pending) await pending.catch(() => {})
    const running = [...servers.values()]
    servers.clear()
    if (server) { running.push(server); server = undefined }
    await Promise.all(running.map(async item => {
      // 先把挂着的连接掐掉，否则 close 会一直等它们自己结束。
      for (const socket of socketsFor.get(item) ?? []) socket.destroy()
      socketsFor.delete(item)
      await new Promise<void>(resolve => item.close(() => resolve()))
    }))
    sockets = new Set()
  }

  return {
    async listen(port, host) {
      if (server) return port
      if (closing) {
        // 已经被要求关了：开完立刻关，不留一个没人管的监听。
        await closeServer()
        return 0
      }
      server = createServer((request, response) => { void handle(request, response) })
      server.on('connection', socket => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      pending = new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(port, host, () => { server!.off('error', reject); resolve() })
      })
      await pending
      pending = undefined
      const address = server.address()
      return typeof address === 'object' && address ? address.port : port
    },
    async listenAll(port, hosts) {
      const bound: string[] = []
      for (const host of hosts) {
        const own = createServer((request, response) => { void handle(request, response) })
        const sockets = new Set<import('node:net').Socket>()
        own.on('connection', socket => {
          sockets.add(socket)
          socket.on('close', () => sockets.delete(socket))
        })
        try {
          await new Promise<void>((resolve, reject) => {
            own.once('error', reject)
            own.listen(port, host, () => { own.off('error', reject); resolve() })
          })
        } catch {
          // 一个地址绑不上不该让别的地址也起不来：网卡掉线、端口被占都是可能的。
          own.close()
          continue
        }
        servers.set(host, own)
        socketsFor.set(own, sockets)
        bound.push(host)
      }
      return bound
    },
    async close() {
      closing = closeServer()
      await closing
    },
  }
}

/** 通配地址。绑它等于把端口开到所有网卡上，Config 和这里都拒绝。 */
const WILDCARDS = new Set(['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0'])

/**
 * 挑一块具体的网卡来绑。
 *
 * 优先 IPv4：手机输地址时不必打方括号。没有 IPv4 就退到回环 ——
 * 退到本机仍然可用，而绑通配是把这个口暴露给所有网络，两者不是一回事。
 */
export interface InterfaceAddress {
  address: string
  family: string
  /** Node 的 internal 标记：回环与系统保留接口。 */
  internal?: boolean
  /** 网卡名，用来认出隧道与虚拟机网卡。 */
  name?: string
}

/** 隧道、VPN、容器的网卡名。绑到它们上面，局域网里的手机连不到。 */
const VIRTUAL = /^(utun|tun|tap|ppp|bridge|vmnet|vboxnet|docker|veth|lo)/i

/**
 * 挑一块具体的网卡来绑。
 *
 * 排序：真网卡的 IPv4 → 隧道/虚拟网卡的 IPv4 → 其他 → 回环。
 * 回环排最后是因为绑它等于只在自己机器上可达；虚拟网卡排在真网卡之后，是因为
 * 绑到 EasyTier 的 utun4 上会出现「明明在同一个 Wi-Fi 却说连不上」，很难查。
 * 什么时候都不返回通配地址：那等于把端口开到所有网卡上。
 */
export function bindAddress(addresses: InterfaceAddress[]): string {
  const usable = addresses.filter(item => !WILDCARDS.has(item.address))
  const routable = usable.filter(item => !isLoopback(item.address) && !item.internal)
  const rank = (item: InterfaceAddress): number => {
    const virtual = item.name ? VIRTUAL.test(item.name) : false
    if (item.family === 'IPv4' && !virtual) return 0
    if (item.family === 'IPv4') return 1
    if (!virtual) return 2
    return 3
  }
  const best = [...routable].sort((left, right) => rank(left) - rank(right))[0]
  return best?.address ?? usable[0]?.address ?? '127.0.0.1'
}

/**
 * 手机可能用到的那些地址，按可能性排序。
 *
 * 只绑一块网卡会漏掉别的网络：绑了局域网地址之后，本机和模拟器（10.0.2.2 映射到宿主机）
 * 都连不上。所以调用方应该把这几个都绑上，而不是挑一个。
 */
export function bindCandidates(addresses: InterfaceAddress[]): string[] {
  const usable = addresses.filter(item => !WILDCARDS.has(item.address))
  const routable = usable.filter(item => !isLoopback(item.address) && !item.internal)
  const rank = (item: InterfaceAddress): number => {
    const virtual = item.name ? VIRTUAL.test(item.name) : false
    if (item.family === 'IPv4' && !virtual) return 0
    if (item.family === 'IPv4') return 1
    if (!virtual) return 2
    return 3
  }
  const ordered = [...routable].sort((left, right) => rank(left) - rank(right)).map(item => item.address)
  // 回环补在最后：本机与模拟器走它，手机不会用，但它必须可达。
  const loopback = usable.filter(item => isLoopback(item.address)).map(item => item.address)
  return [...new Set([...ordered, ...loopback])]
}

/** 127/8 与 ::1 都算回环。 */
function isLoopback(address: string): boolean {
  return address.startsWith('127.') || address === '::1'
}

/**
 * 端口由状态目录决定：同一个目录永远是同一个口，重启之后手机不用改地址；
 * 不同机器的不同目录不会撞。
 */
export function lanPort(stateDir: string): number {
  let sum = 0
  for (const character of stateDir) sum = (sum * 31 + character.charCodeAt(0)) % 100_000
  // 20000 起，避开常见的服务端口段。
  return 20_000 + (sum % 40_000)
}
