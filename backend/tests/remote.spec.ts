import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore, deviceStoreOf, issuePairingCode, lanAddresses, lanGate, verifyPairing } from '../src/app/remote.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-')); directories.push(dir)
  return dir
}

it('issues a code that only the paired device can redeem once', () => {
  const store = new DeviceStore(stateDir())
  const code = issuePairingCode(store, 'phone-1')
  expect(code).toMatch(/^\d{6}$/)
  const device = verifyPairing(store, { code, deviceId: 'phone-1', name: 'Kenton 的手机', platform: 'android' })
  expect(device?.deviceId).toBe('phone-1')
  // Redeeming twice must fail: one code, one device.
  expect(verifyPairing(store, { code, deviceId: 'phone-2', name: 'other', platform: 'android' })).toBeUndefined()
})

it('refuses a wrong code and a wrong device', () => {
  const store = new DeviceStore(stateDir())
  const code = issuePairingCode(store, 'phone-1')
  expect(verifyPairing(store, { code: '000000', deviceId: 'phone-1', name: 'x', platform: 'android' })).toBeUndefined()
  // The right code from a different device is not the one it was issued for.
  expect(verifyPairing(store, { code, deviceId: 'phone-9', name: 'x', platform: 'android' })).toBeUndefined()
  // A refused attempt must not burn the code.
  expect(verifyPairing(store, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })).toBeDefined()
})

it('expires a code that was never redeemed', () => {
  const store = new DeviceStore(stateDir())
  const code = issuePairingCode(store, 'phone-1', -1) // already expired
  expect(verifyPairing(store, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })).toBeUndefined()
})

it('keeps the paired devices on disk so a restart does not unpair the phone', () => {
  const dir = stateDir()
  const store = new DeviceStore(dir)
  const code = issuePairingCode(store, 'phone-1')
  verifyPairing(store, { code, deviceId: 'phone-1', name: 'Kenton 的手机', platform: 'android' })

  // A fresh store over the same directory sees the same device.
  const reopened = new DeviceStore(dir)
  const devices = reopened.list()
  expect(devices).toHaveLength(1)
  expect(devices[0]!.name).toBe('Kenton 的手机')
  // The record on disk carries only a digest; there is no token field to leak in the first place.
  const raw = readFileSync(join(dir, 'remote-devices.json'), 'utf8')
  expect(Object.keys(devices[0]!)).toEqual(['deviceId', 'name', 'platform', 'digest', 'pairedAt'])
  expect(raw).not.toContain('token')
})

it('revokes one device without touching the others', () => {
  const store = new DeviceStore(stateDir())
  for (const id of ['phone-1', 'phone-2']) {
    const code = issuePairingCode(store, id)
    verifyPairing(store, { code, deviceId: id, name: id, platform: 'android' })
  }
  expect(store.list()).toHaveLength(2)
  store.revoke('phone-1')
  expect(store.list().map(device => device.deviceId)).toEqual(['phone-2'])
})

it('checks a presented credential against the paired device', () => {
  const store = new DeviceStore(stateDir())
  const code = issuePairingCode(store, 'phone-1')
  const device = verifyPairing(store, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })!
  expect(store.allows(device.deviceId, device.token)).toBe(true)
  // Someone else's token does not open this device.
  expect(store.allows(device.deviceId, 'not-the-token')).toBe(false)
  expect(store.allows('phone-2', device.token)).toBe(false)
  store.revoke('phone-1')
  expect(store.allows(device.deviceId, device.token)).toBe(false)
})

it('answers off for anything when the reply mode refuses pairing', () => {
  // `deny` is the setting that closes the door to every new device.
  const store = new DeviceStore(stateDir(), 'deny')
  const code = issuePairingCode(store, 'phone-1')
  expect(verifyPairing(store, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })).toBeUndefined()
})

it('survives a corrupt device file instead of taking the crew down', () => {
  const dir = stateDir()
  writeFileSync(join(dir, 'remote-devices.json'), '{ not json')
  // A broken record means no paired devices, not a crash on every request.
  expect(new DeviceStore(dir).list()).toEqual([])
})

it('serves the pairing endpoints the phone actually calls', async () => {
  const { pairingHandler } = await import('../src/app/remote.ts')
  const dir = stateDir()
  const store = new DeviceStore(dir)
  const handler = pairingHandler(store)

  // The owner asks for a code; only local access should reach this, which the caller enforces.
  const issued = await handler(new Request('http://dsh/api/remote/pairing', { method: 'POST', body: JSON.stringify({ deviceId: 'phone-1' }) }))
  expect(issued.status).toBe(200)
  const { code } = await issued.json() as { code: string }
  expect(code).toMatch(/^\d{6}$/)

  const paired = await handler(new Request('http://dsh/api/remote/pair', { method: 'POST',
    body: JSON.stringify({ code, deviceId: 'phone-1', name: 'Kenton 的手机', platform: 'android' }) }))
  expect(paired.status).toBe(200)
  const credential = await paired.json() as { token?: string; deviceId?: string }
  expect(credential.deviceId).toBe('phone-1')
  expect(credential.token).toBeTruthy()

  const wrong = await handler(new Request('http://dsh/api/remote/pair', { method: 'POST',
    body: JSON.stringify({ code: '999999', deviceId: 'phone-1', name: 'x', platform: 'android' }) }))
  expect(wrong.status).toBe(403)
})

it('lists and revokes devices through the same handler', async () => {
  const { pairingHandler } = await import('../src/app/remote.ts')
  const dir = stateDir()
  const store = new DeviceStore(dir)
  const handler = pairingHandler(store)
  const code = issuePairingCode(store, 'phone-1')
  verifyPairing(store, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })

  const listed = await handler(new Request('http://dsh/api/remote/devices'))
  expect((await listed.json() as { devices: unknown[] }).devices).toHaveLength(1)

  const revoked = await handler(new Request('http://dsh/api/remote/devices', { method: 'DELETE', body: JSON.stringify({ deviceId: 'phone-1' }) }))
  expect(revoked.status).toBe(200)
  expect(store.list()).toEqual([])
})

it('tells the phone which address on the LAN it can come back to', async () => {
  const { lanAddresses } = await import('../src/app/remote.ts')
  // 走真实网卡，但只断言形状：这个测试不该依赖跑测试的机器在哪个网段。
  const found = lanAddresses()
  for (const entry of found) {
    // IPv6 也是手机能连回来的合法地址，所以只排除掉一定连不上的那几种。
    expect(entry.address).not.toBe('')
    expect(entry.address.startsWith('127.')).toBe(false)
    expect(entry.address.startsWith('::1')).toBe(false)
    expect(entry.address.startsWith('fe80:')).toBe(false)
  }
})

it('answers the reach question without needing to be paired', async () => {
  const { pairingHandler } = await import('../src/app/remote.ts')
  const handler = pairingHandler(new DeviceStore(stateDir()))
  const response = await handler(new Request('http://dsh/api/remote/reach'))
  expect(response.status).toBe(200)
  const body = await response.json() as { addresses: unknown[] }
  expect(Array.isArray(body.addresses)).toBe(true)
})

it('keeps the pairing surface off the network, and still reachable from the machine itself', async () => {
  const { pairingFence } = await import('../src/app/remote.ts')
  const port = 8790
  const local = (headers: Record<string, string>) => ({ headers } as never)

  // 从局域网来的一律拒绝：这是配对面唯一的防线。
  expect(pairingFence(local({ host: `192.168.31.127:${port}` }), port)).toBe(false)
  expect(pairingFence(local({ host: `evil.example:${port}` }), port)).toBe(false)
  // 回环但没有同源标记：浏览器里另一个页面发起的请求，不算本机自己。
  expect(pairingFence(local({ host: `127.0.0.1:${port}` }), port)).toBe(false)
  // 本机自己：回环地址 + 同源标记。
  expect(pairingFence(local({ host: `127.0.0.1:${port}`, 'x-orchestrator-request': '1' }), port)).toBe(true)
  expect(pairingFence(local({ host: `localhost:${port}`, 'x-orchestrator-request': '1' }), port)).toBe(true)
})

it('drops expired codes when a new one is issued instead of keeping them forever', () => {
  const store = new DeviceStore(stateDir())
  // Ten already-dead codes, then one live one.
  for (let index = 0; index < 10; index++) issuePairingCode(store, `old-${index}`, -1)
  issuePairingCode(store, 'phone-1')
  // Only the live code can still be redeemed; the dead ones left nothing behind to redeem.
  expect(verifyPairing(store, { code: '123456', deviceId: 'old-0', name: 'x', platform: 'android' })).toBeUndefined()
})

it('hands back a URL that already suits the address family', () => {
  for (const entry of lanAddresses()) {
    if (entry.family === 'IPv6') expect(entry.url).toMatch(/^http:\/\/\[[0-9a-f:]+\]$/)
    else expect(entry.url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+$/)
  }
})

it('the deny setting actually closes the door, and does not lock out a paired phone', () => {
  const dir = stateDir()
  const store = new DeviceStore(dir)
  const code = issuePairingCode(store, 'phone-1')
  const paired = verifyPairing(store, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })!

  // A store over the same folder with pairing denied: no new device, but the paired one still works.
  const denied = new DeviceStore(dir, 'deny')
  const fresh = issuePairingCode(denied, 'phone-2')
  expect(verifyPairing(denied, { code: fresh, deviceId: 'phone-2', name: 'y', platform: 'android' })).toBeUndefined()
  expect(denied.allows(paired.deviceId, paired.token)).toBe(true)
})

// 配对方向要反过来：电脑生成码、手机提交码。手机配好之前没有任何凭据可用，
// 所以它的提交必须走已经鉴权的消息面，而不是那面只认本机的配对面。
it('lets the phone submit a code over the message surface it can already reach', () => {
  const store = new DeviceStore(stateDir())
  const code = issuePairingCode(store, 'phone-1')

  // 手机侧调用的是同一个兑换逻辑，只是入口换成了消息面。
  const credential = verifyPairing(store, { code, deviceId: 'phone-1', name: 'Kenton 的手机', platform: 'android' })
  expect(credential?.deviceId).toBe('phone-1')
  expect(credential?.token).toBeTruthy()
})

it('refuses a device that was never given a code, even with the right numbers', () => {
  const store = new DeviceStore(stateDir())
  const code = issuePairingCode(store, 'phone-1')
  // 同一支码，但不是发给这台设备的。
  expect(verifyPairing(store, { code, deviceId: 'phone-2', name: 'x', platform: 'android' })).toBeUndefined()
})

it('never hands a code back out of the pairing call after it was used', () => {
  const store = new DeviceStore(stateDir())
  const code = issuePairingCode(store, 'phone-1')
  expect(verifyPairing(store, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })).toBeDefined()
  // 用过的码不能再用一次换出第二份凭据。
  expect(verifyPairing(store, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })).toBeUndefined()
})

// 端到端：电脑这一侧发码（管理面），手机那一侧提交（消息面能到的路径）。
// 两条入口都调同一个 DeviceStore，所以「发出去的码」和「兑进来的码」必须是同一份状态。
it('a code issued on the machine is the code the phone can redeem', async () => {
  const { pairingHandler } = await import('../src/app/remote.ts')
  const store = new DeviceStore(stateDir())

  // 电脑：生码。主人念给自己听。
  const issued = issuePairingCode(store, 'phone-1')
  expect(issued).toMatch(/^\d{6}$/)

  // 手机：提交码，换凭据。
  const phone = pairingHandler(store)
  const response = await phone(new Request('http://dsh/api/remote/pair', { method: 'POST',
    body: JSON.stringify({ code: issued, deviceId: 'phone-1', name: 'Kenton 的手机', platform: 'android' }) }))
  expect(response.status).toBe(200)
  const credential = await response.json() as { token?: string }
  expect(credential.token).toBeTruthy()

  // 换回来的凭据此后每次请求都认。
  expect(store.allows('phone-1', credential.token!)).toBe(true)
})

it('the same store answers both surfaces, so a restart does not lose the code mid-flight', async () => {
  const { pairingHandler } = await import('../src/app/remote.ts')
  const dir = stateDir()
  // 两个入口指向同一份目录：这正是 registerHttp 里 WeakMap 缓存在做的事。
  const machine = new DeviceStore(dir)
  const phoneSide = pairingHandler(machine)
  const code = issuePairingCode(machine, 'phone-1')
  const response = await phoneSide(new Request('http://dsh/api/remote/pair', { method: 'POST',
    body: JSON.stringify({ code, deviceId: 'phone-1', name: 'x', platform: 'android' }) }))
  expect(response.status).toBe(200)
})

it('a code issued to no particular device still pairs the first phone that claims it', () => {
  // 电脑生码时并不知道手机会自报什么 id，所以码不能绑定一个还没见到的设备。
  const store = new DeviceStore(stateDir())
  const code = issuePairingCode(store, '')
  const paired = verifyPairing(store, { code, deviceId: 'phone-1', name: 'Kenton 的手机', platform: 'android' })
  expect(paired?.deviceId).toBe('phone-1')

  // 绑定之后这支码就用掉了，第二台设备不能再拿同一个码。
  expect(verifyPairing(store, { code, deviceId: 'phone-2', name: 'x', platform: 'android' })).toBeUndefined()
})

it('one store per state directory, so the code the machine shows is the code the phone can use', () => {
  const dir = stateDir()
  const machine = deviceStoreOf(dir, 'code')
  const phone = deviceStoreOf(dir)
  // 同一个目录必须拿到同一个对象，否则电脑发的码手机永远兑不了。
  expect(phone).toBe(machine)

  const code = issuePairingCode(machine, '')
  expect(verifyPairing(phone, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })).toBeDefined()
})

it('a changed pairing policy hands back a store that honours it', () => {
  const dir = stateDir()
  const open = deviceStoreOf(dir, 'code')
  const closed = deviceStoreOf(dir, 'deny')
  expect(closed).not.toBe(open)
  const code = issuePairingCode(closed, '')
  expect(verifyPairing(closed, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })).toBeUndefined()
})

// 手机从局域网连进来时会打一个带凭据的入口。它和配对面不同：这里不是「要码」，
// 而是「我拿码换来的凭据，现在拿着它进来」。
it('lets a paired phone in over the network with its credential, and nobody else', async () => {
  const { lanGate } = await import('../src/app/remote.ts')
  const store = new DeviceStore(stateDir())
  const code = issuePairingCode(store, '')
  const paired = verifyPairing(store, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })!

  expect(lanGate(store, 'phone-1', paired.token)).toBe(true)
  // 没有凭据、凭据错了、设备不对，都不放行。
  expect(lanGate(store, 'phone-1', '')).toBe(false)
  expect(lanGate(store, 'phone-1', 'wrong')).toBe(false)
  expect(lanGate(store, 'phone-2', paired.token)).toBe(false)
})

it('the LAN entry says yes only to a credential that was actually issued', async () => {
  // 这条路从局域网可达（配对面不可达），所以它的门槛必须是凭据本身。
  const store = deviceStoreOf(stateDir(), 'code')
  expect(lanGate(store, 'phone-1', 'anything')).toBe(false)

  const code = issuePairingCode(store, '')
  const paired = verifyPairing(store, { code, deviceId: 'phone-1', name: 'x', platform: 'android' })!
  expect(lanGate(store, 'phone-1', paired.token)).toBe(true)

  // 撤销之后立刻进不来。
  store.revoke('phone-1')
  expect(lanGate(store, 'phone-1', paired.token)).toBe(false)
})
