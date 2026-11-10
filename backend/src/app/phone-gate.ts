/**
 * 手机消息面的门。
 *
 * 两条入口（局域网直连、中转隧道）通向同一个处理器，所以「这条路只接消息面」与
 * 「配过的那台手机才能进」这两条判定必须共用一份。写在隧道那一侧、只判路径前缀是
 * 不够的：中转发来的请求没人验凭据，公网上知道 instanceId 的人就能直接读时间线。
 */

/** 设备表里这一条做什么用：它只回答「这枚凭据是不是这台设备的」。 */
export interface DeviceGate {
  allows(deviceId: string, token: string): boolean
}

export interface PhoneGateInput {
  pathname: string
  method: string
  headers: Record<string, string | string[] | undefined>
  devices: DeviceGate
}

/** 手机出示的凭据与设备号。取不到就是没有，不给默认值。 */
export function presentedDevice(headers: Record<string, string | string[] | undefined>): { deviceId: string; token: string } | undefined {
  const device = headers['x-crew-device']
  const token = headers['x-crew-credential']
  const deviceId = Array.isArray(device) ? device[0] : device
  const credential = Array.isArray(token) ? token[0] : token
  if (typeof deviceId !== 'string' || !deviceId.trim()) return undefined
  if (typeof credential !== 'string' || !credential.trim()) return undefined
  return { deviceId: deviceId.trim(), token: credential.trim() }
}

const reply = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } })

/**
 * 拒绝了就返回那个 Response，放行返回 undefined。
 *
 * 首次配对是个死锁：这台设备还没有凭据，而这条路又要求凭据。所以只有「交一支码」这一跳放行，
 * 码本身就是它的凭据（6 位、5 分钟、兑换即作废，配对策略为 deny 时一律拒绝）。
 * 限速由调用方按来源地址做（见 pairing-throttle.ts）。
 */
export function phoneGate(input: PhoneGateInput): Response | undefined {
  if (!input.pathname.startsWith('/api/mobile/')) return reply(404, 'Not found')
  const pairing = input.pathname === '/api/mobile/pair' && input.method === 'POST'
  if (pairing) return undefined
  const said = presentedDevice(input.headers)
  // 验不过就说 401，不区分「设备不对」和「凭据不对」：那是在帮尝试者筛选。
  if (!said || !input.devices.allows(said.deviceId, said.token)) return reply(401, 'Not paired')
  return undefined
}
