/**
 * 首次配对的尝试限速。
 *
 * 配对那一跳必须匿名可达（设备还没有凭据），凭据是一支 6 位码：100 万种、5 分钟。
 * 没有次数限制的话，谁都能在码的有效期里猜个够。局域网与中转隧道共用同一个实例，
 * 否则同一台机器可以在两条路上各拿一份额度。
 *
 * 桶按来源地址算。P2P 那条路（`p2p.ts` 起的 `tailcat serve`）是明文端口代理：隧道里来的每条
 * 连接都被接到本机 `127.0.0.1:<端口>`，所以局域网监听看到的每一台手机都是回环地址 ——
 * 经 P2P 配对的手机共用同一个桶，本机回环上的调用也在同一个桶里。这是有意选的「最严口径」，
 * 不按设备区分，理由：
 *
 *   - 这一跳匿名，手机上唯一能自报的身份是 deviceId，而它由客户端随手写。拿它当桶键等于给
 *     尝试者无限个桶，6 位码立刻变成可以逐桶穷举。
 *   - 隧道这一层也拿不到对端身份：端口代理只把连接接到回环，对端节点密钥只交给 `exec` 服务。
 *   - 共用一个桶只会更严：一次失败配对最多让下一台手机多等一个窗口（60 秒）。
 *   - 影响面只在 P2P 这一条路：局域网直连按各自网段计数，中转按 `x-forwarded-for` 计数，
 *     所以隧道上刷量堵不住「回到同一 Wi-Fi 下配对」这条退路。
 *   - 能连上这条路要先有 tc-addr（它内嵌 WireGuard 与路径发现公钥，本身就是凭据），
 *     共用该桶的人本来就是拿到过这个地址的人，不是公网上的任意来源。
 */

export const PAIRING_WINDOW_MS = 60_000
export const PAIRING_MAX_ATTEMPTS = 20

/** 把 IPv6 展开成 8 组。压缩写法（`::`）必须展开后再取前缀，否则 `fe80::1` 与 `fe80::2` 不会被聚合。 */
function expand6(value: string): string[] {
  if (!value.includes('::')) return value.split(':')
  const [head, tail] = value.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const missing = Math.max(0, 8 - left.length - right.length)
  return [...left, ...Array<string>(missing).fill('0'), ...right]
}

/** 回环在套接字上的各种写法：IPv4 的 127/8、IPv6 的 ::1，以及内嵌 IPv4 的映射形式。 */
function isLoopback(value: string): boolean {
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  return /^127\.\d+\.\d+\.\d+$/.test(value) || /^::ffff:127\.\d+\.\d+\.\d+$/i.test(value)
}

/**
 * 隧道与回环共用的桶名。它不是地址，所以不会和一个真实的网段 key 撞上。
 *
 * 折叠成一个桶而不是各算一个：回环在这套系统里不表示「哪台设备」，只表示「本机自己」。
 * 分成 127.0.0.0/24 和 ::/64 两个桶的话，同一个来源集合能拿到两份额度 —— 那是变松。
 */
const LOOPBACK = 'loopback'

/**
 * 按网段聚合，不按单个地址：同一台机器换一个地址（IPv6 /64 或加一个 alias）就能
 * 拿到一份新额度，那限速就只是让攻击者多做一步。
 */
export function pairingKey(address: string | undefined): string {
  // 链路本地地址可能带 %en0 这样的 zone，它不是地址的一部分。
  const value = (address || 'unknown').replace(/%.*$/, '')
  // 回环先判：隧道转发（tailcat）与本机代理都落在这里，IPv4/IPv6 两种写法必须进同一个桶。
  if (isLoopback(value)) return LOOPBACK
  const v4 = /^(\d+\.\d+\.\d+)\.\d+$/.exec(value)
  if (v4) return `${v4[1]}.0/24`
  // IPv4-mapped 的 IPv6 地址按它内嵌的 IPv4 聚合，不然每个端口都是新 key。
  const mapped = /^::ffff:(\d+\.\d+\.\d+)\.\d+$/i.exec(value)
  if (mapped) return `${mapped[1]}.0/24`
  if (value.includes(':')) return `${expand6(value).slice(0, 4).join(':')}::/64`
  return value
}

export interface PairingThrottleOptions {
  windowMs?: number
  maxAttempts?: number
}

/** 返回一个判定函数：这一次尝试放不放行。窗口一过自动重来。 */
export function createPairingThrottle(options: PairingThrottleOptions = {}): (address: string | undefined) => boolean {
  const windowMs = options.windowMs ?? PAIRING_WINDOW_MS
  const maxAttempts = options.maxAttempts ?? PAIRING_MAX_ATTEMPTS
  // 上限只是兜底：正常的来源数量是几台手机。到顶就丢掉最早的一批，内存不随访问者数量单调长。
  const maxKeys = 4096
  const attempts = new Map<string, { count: number; resetAt: number }>()
  return address => {
    const key = pairingKey(address)
    const now = Date.now()
    const entry = attempts.get(key)
    if (!entry || entry.resetAt <= now) {
      if (attempts.size >= maxKeys) {
        for (const [seen, record] of attempts) if (record.resetAt <= now) attempts.delete(seen)
        while (attempts.size >= maxKeys) attempts.delete(attempts.keys().next().value!)
      }
      attempts.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    entry.count += 1
    return entry.count <= maxAttempts
  }
}
