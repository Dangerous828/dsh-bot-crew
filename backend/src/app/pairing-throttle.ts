/**
 * 首次配对的尝试限速。
 *
 * 配对那一跳必须匿名可达（设备还没有凭据），凭据是一支 6 位码：100 万种、5 分钟。
 * 没有次数限制的话，谁都能在码的有效期里猜个够。局域网与中转隧道共用同一个实例，
 * 否则同一台机器可以在两条路上各拿一份额度。
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

/**
 * 按网段聚合，不按单个地址：同一台机器换一个地址（IPv6 /64 或加一个 alias）就能
 * 拿到一份新额度，那限速就只是让攻击者多做一步。
 */
export function pairingKey(address: string | undefined): string {
  // 链路本地地址可能带 %en0 这样的 zone，它不是地址的一部分。
  const value = (address || 'unknown').replace(/%.*$/, '')
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
