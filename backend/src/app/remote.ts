/**
 * 设备配对：手机要连回这台电脑，得先证明它是主人配过的那台。
 *
 * 这里只管凭据，不管网络。隧道由 Connection 层负责（经内网主动往外出），局域网直连由 Host 监听地址决定；
 * 这一层回答的是「这台设备配过没、还能不能用」，那是两种连法都要过的一道门。
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { IncomingMessage } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 配对码的有效期。够人念一遍，又长不过一个走开的空档。 */
export const PAIRING_TTL_MS = 5 * 60_000

/** 谁能配对：凭码放行，或一律拒绝。 */
export type PairingPolicy = 'code' | 'deny'

/** 一台配过的设备。凭据本身不进这条记录，只留它的摘要。 */
export interface PairedDevice {
  deviceId: string
  name: string
  platform: string
  /** 凭据的 SHA-256，会话校验只比对摘要。 */
  digest: string
  pairedAt: string
}

/** 配对成功时交回给手机的那一份：凭据明文只在这里出现一次。 */
export interface PairedCredential extends PairedDevice {
  token: string
}

interface PendingCode { code: string; deviceId: string; expiresAt: number }

const digestOf = (token: string): string => createHash('sha256').update(token).digest('hex')

/**
 * 配对码与设备记录。落盘一次，重启后手机不用重新配。
 * 文件坏了就当没有设备：宁可靠重新配对恢复，也不要让每一次请求都抛异常。
 */
export class DeviceStore {
  private readonly file: string
  /** 策略：改了要换实例，所以它读得到。 */
  readonly policy: PairingPolicy
  private devices: PairedDevice[]
  private pending = new Map<string, PendingCode>()

  constructor(stateDir: string, policy: PairingPolicy = 'code') {
    this.file = join(stateDir, 'remote-devices.json')
    this.policy = policy
    this.devices = this.read()
  }

  private read(): PairedDevice[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      // 摘要也必须是字符串：一条缺 digest 的记录会让 allows() 里的 Buffer.from(undefined) 抛错，
      // 而那个异常没有人接，会把整个进程带走。设备表坏了就当没配过，宁可重配。
      return Array.isArray(parsed) ? parsed.filter((entry): entry is PairedDevice =>
        !!entry && typeof entry === 'object' && typeof (entry as PairedDevice).deviceId === 'string'
        && typeof (entry as PairedDevice).digest === 'string') : []
    } catch { return [] }
  }

  private write(): void {
    // 先写临时文件再改名，半截写入不会把设备表弄坏。
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(this.devices, null, 2))
    renameSync(temporary, this.file)
  }

  list(): PairedDevice[] { return this.devices.map(device => ({ ...device })) }

  /** 这台设备凭这个凭据能不能进。摘要比对用定时安全比较，别让长度差泄漏出信息。 */
  allows(deviceId: string, token: string): boolean {
    const device = this.devices.find(entry => entry.deviceId === deviceId)
    if (!device || !token) return false
    const presented = Buffer.from(digestOf(token))
    const stored = Buffer.from(device.digest)
    return presented.length === stored.length && timingSafeEqual(presented, stored)
  }

  /** 撤销一台。撤销之后它手上的凭据立刻作废。 */
  revoke(deviceId: string): void {
    const before = this.devices.length
    this.devices = this.devices.filter(device => device.deviceId !== deviceId)
    if (this.devices.length !== before) this.write()
  }

  /** 一次撤掉全部：手机丢了要能一把断干净。 */
  revokeAll(): void {
    this.devices = []
    this.write()
  }

  /** 发一个码给指定设备。每台设备只保留最新的一个，发新码时清掉已经过期的。 */
  issue(deviceId: string, ttlMs = PAIRING_TTL_MS): string {
    // 不清的话，重新生成多少次就留多少条：进程不重启就永远不回收。
    const now = Date.now()
    for (const [key, entry] of this.pending) if (entry.expiresAt < now) this.pending.delete(key)
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.pending.set(deviceId, { code, deviceId, expiresAt: now + ttlMs })
    return code
  }

  /**
   * 用码换凭据。码对、设备对、没过期、策略允许，四样都成立才算配好。
   *
   * 设备 id 为空的码是「认领式」的：电脑生码时并不知道手机会自报什么名字，所以谁先拿码来换就归谁。
   * 换了就作废，第二台设备不能再拿同一个码进来。
   */
  redeem(input: { code: string; deviceId: string; name: string; platform: string }): PairedCredential | undefined {
    if (this.policy === 'deny') return undefined
    const claimable = this.pending.get('')
    const own = this.pending.get(input.deviceId)
    const pending = own ?? (claimable && claimable.code === input.code ? claimable : undefined)
    if (!pending || pending.expiresAt < Date.now()) return undefined
    // 比对失败不烧码：打错一次键盘不该让人重新生成。
    const presented = Buffer.from(input.code), expected = Buffer.from(pending.code)
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined
    // 只销毁真正被兑换的那一支。另一支可能属于另一台设备（比如同时发了一支认领码），
    // 无条件清空会把还等着被兑换的码一起作废。
    if (own && own.code === pending.code) this.pending.delete(input.deviceId)
    if (claimable && claimable.code === pending.code) this.pending.delete('')

    const token = randomBytes(32).toString('base64url')
    const device: PairedDevice = {
      deviceId: input.deviceId, name: input.name, platform: input.platform,
      digest: digestOf(token), pairedAt: new Date().toISOString(),
    }
    // 同一台设备重新配对是替换，不是多一条。
    this.devices = [...this.devices.filter(entry => entry.deviceId !== input.deviceId), device]
    this.write()
    return { ...device, token }
  }
}

export function issuePairingCode(store: DeviceStore, deviceId: string, ttlMs?: number): string {
  return store.issue(deviceId, ttlMs)
}

export function verifyPairing(store: DeviceStore, input: { code: string; deviceId: string; name: string; platform: string }): PairedCredential | undefined {
  return store.redeem(input)
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 读 JSON 请求体；坏 JSON 直接当空对象，交给后面的字段校验报错。 */
async function fields(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await request.text()) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

/**
 * 配对面的门槛：只认本机自己发起的请求。
 *
 * 手机还没配好时没有 Connection 凭据可用，所以这一步必须能匿名到达，也就必须有一道自己的门：
 * 回环 Host（不是局域网地址）加上同源标记（不是浏览器里别的页面）。局域网里谁都能连的话，
 * 任何人都能给这台机器配一台设备。
 */
export function pairingFence(request: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = request.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return request.headers['x-orchestrator-request'] === '1'
}

/**
 * 配对面。它不是 Connection 路由，所以只管字段与凭据本身；谁能到达由 `pairingFence` 在注册处拦。
 */
export function pairingHandler(store: DeviceStore) {
  return async (incoming: Request): Promise<Response> => {
    const path = new URL(incoming.url).pathname
    if (path.endsWith('/api/remote/pairing') && incoming.method === 'POST') {
      const body = await fields(incoming)
      if (typeof body.deviceId !== 'string' || !body.deviceId) return reply(400, { error: 'deviceId is required' })
      return reply(200, { code: issuePairingCode(store, body.deviceId) })
    }
    if (path.endsWith('/api/remote/pair') && incoming.method === 'POST') {
      const body = await fields(incoming)
      const { code, deviceId, name, platform } = body
      if (typeof code !== 'string' || typeof deviceId !== 'string' || !code || !deviceId) {
        return reply(400, { error: 'code and deviceId are required' })
      }
      const credential = verifyPairing(store, {
        code, deviceId,
        name: typeof name === 'string' && name ? name : deviceId,
        platform: typeof platform === 'string' ? platform : 'unknown',
      })
      // A wrong code and a wrong device look the same from outside: saying which was wrong helps only an attacker.
      return credential ? reply(200, credential) : reply(403, { error: 'Pairing refused' })
    }
    // 手机拿码之前先问一句「我该连哪里」，省得主人去翻 IP。
    if (path.endsWith('/api/remote/reach') && incoming.method === 'GET') {
      return reply(200, { addresses: lanAddresses(), note: 'Same network: one of these. Elsewhere: use the tunnel.' })
    }
    if (path.endsWith('/api/remote/devices') && incoming.method === 'GET') {
      return reply(200, { devices: store.list().map(({ digest: _digest, ...rest }) => rest) })
    }
    if (path.endsWith('/api/remote/devices') && incoming.method === 'DELETE') {
      const body = await fields(incoming)
      if (body.all === true) { store.revokeAll(); return reply(200, { ok: true }) }
      if (typeof body.deviceId !== 'string' || !body.deviceId) return reply(400, { error: 'deviceId is required' })
      store.revoke(body.deviceId)
      return reply(200, { ok: true })
    }
    return reply(404, { error: 'Unknown operation' })
  }
}

/**
 * 这台机器在局域网上的地址。手机连回电脑要么走隧道，要么同一个 Wi-Fi 直接连，后者就得知道地址。
 * 回环不算：那是手机自己。
 */
export function lanAddresses(): { address: string; family: string; url: string }[] {
  const found: { address: string; family: string; url: string }[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.address.startsWith('127.') || entry.address.startsWith('fe80:')) continue
      // IPv6 拼进 URL 必须带方括号，裸地址会让调用方解析失败。
      const host = entry.family === 'IPv6' ? `[${entry.address}]` : entry.address
      found.push({ address: entry.address, family: entry.family, url: `http://${host}` })
    }
  }
  return found
}

/**
 * 一台机器只有一份设备表。
 *
 * 管理面（电脑出码）和消息面（手机兑码）必须看到同一份状态，否则电脑发的码手机永远兑不了。
 * 按 stateDir 记住实例：同一个目录拿到的永远是同一个对象。
 */
const deviceStores = new Map<string, DeviceStore>()

export function deviceStoreOf(stateDir: string, policy?: PairingPolicy): DeviceStore {
  const existing = deviceStores.get(stateDir)
  // 策略变了要换实例；没变就复用，码才留得住。
  if (existing && (policy === undefined || existing.policy === policy)) return existing
  const store = new DeviceStore(stateDir, policy)
  deviceStores.set(stateDir, store)
  return store
}

/**
 * 手机带着凭据从局域网进来时的门。
 *
 * 和 `pairingFence` 是两回事：那道门守的是「能不能配」，只认本机；
 * 这道门守的是「配过的那台手机能不能进来」，认的是凭据本身，所以局域网可达。
 * 路由注册在配对面之外（见 `registerHttp`），否则会被 `pairingFence` 挡死。
 */
export function lanGate(store: DeviceStore, deviceId: string, token: string): boolean {
  return store.allows(deviceId, token)
}
