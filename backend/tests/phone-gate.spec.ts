import { describe, expect, it } from 'vitest'
import { phoneGate, presentedDevice } from '../src/app/phone-gate.ts'
import { createPairingThrottle, pairingKey } from '../src/app/pairing-throttle.ts'

const devices = { allows: (deviceId: string, token: string): boolean => deviceId === 'phone-1' && token === 'secret' }

describe('phoneGate', () => {
  it('rejects anything outside the phone API', () => {
    const denied = phoneGate({ pathname: '/orchestrator/api/settings', method: 'GET', headers: {}, devices })
    expect(denied?.status).toBe(404)
  })

  it('lets the pairing POST through without a credential', () => {
    expect(phoneGate({ pathname: '/api/mobile/pair', method: 'POST', headers: {}, devices })).toBeUndefined()
  })

  it('still requires a credential for a GET on the pairing path', () => {
    expect(phoneGate({ pathname: '/api/mobile/pair', method: 'GET', headers: {}, devices })?.status).toBe(401)
  })

  it('rejects a request with no credential', () => {
    expect(phoneGate({ pathname: '/api/mobile/timeline', method: 'GET', headers: {}, devices })?.status).toBe(401)
  })

  it('rejects a wrong credential without saying which half was wrong', () => {
    const denied = phoneGate({
      pathname: '/api/mobile/timeline', method: 'GET', devices,
      headers: { 'x-crew-device': 'phone-1', 'x-crew-credential': 'nope' },
    })
    expect(denied?.status).toBe(401)
    expect(denied?.headers.get('content-type')).toBe('application/json')
  })

  it('accepts the paired device', () => {
    expect(phoneGate({
      pathname: '/api/mobile/timeline', method: 'GET', devices,
      headers: { 'x-crew-device': 'phone-1', 'x-crew-credential': 'secret' },
    })).toBeUndefined()
  })

  it('reads the credential headers when they arrive as arrays', () => {
    expect(presentedDevice({ 'x-crew-device': ['phone-1'], 'x-crew-credential': ['secret'] }))
      .toEqual({ deviceId: 'phone-1', token: 'secret' })
  })
})

describe('pairing throttle', () => {
  it('allows twenty attempts a minute and refuses the twenty-first', () => {
    const allowed = createPairingThrottle()
    for (let attempt = 0; attempt < 20; attempt += 1) expect(allowed('192.168.31.50')).toBe(true)
    expect(allowed('192.168.31.50')).toBe(false)
  })

  it('groups IPv4 by /24 so changing the host part buys nothing', () => {
    expect(pairingKey('192.168.31.50')).toBe('192.168.31.0/24')
    expect(pairingKey('192.168.31.51')).toBe('192.168.31.0/24')
  })

  it('groups IPv6 by /64 so rotating the interface id buys nothing', () => {
    expect(pairingKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(pairingKey('2001:db8:1:2:bbbb::2')).toBe('2001:db8:1:2::/64')
    // 压缩写法发生在高 64 位里时也必须聚合：fe80::1 与 fe80::2 是同一个 /64。
    expect(pairingKey('fe80::1')).toBe('fe80:0:0:0::/64')
    expect(pairingKey('fe80::2')).toBe('fe80:0:0:0::/64')
    // 链路本地地址的 zone 不是地址的一部分。
    expect(pairingKey('fe80::1%en0')).toBe('fe80:0:0:0::/64')
  })

  it('groups IPv4-mapped addresses by the IPv4 prefix they embed', () => {
    expect(pairingKey('::ffff:192.168.31.50')).toBe('192.168.31.0/24')
    expect(pairingKey('::ffff:192.168.31.51')).toBe('192.168.31.0/24')
  })
})
