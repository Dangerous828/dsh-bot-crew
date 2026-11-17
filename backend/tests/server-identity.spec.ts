/**
 * 已配对 timeline 顶层的可选只读 server 元数据（同实例指纹 + 真实 HTTPS public_base）。
 * 目标：身份与 mDNS TXT 同源、只增不改（老 App 兼容）、空/坏 public 给空串不编 LAN、gate 仍 401。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { phoneHandler } from '../src/app/mobile-http.ts'
import { crewFingerprint } from '../src/app/discovery.ts'
import { publicEntry } from '../src/app/public-entry.ts'
import type { HttpHost } from '../src/app/http.ts'

const directories: string[] = []
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }) })

function hostWith(stateDir: string): HttpHost {
  directories.push(stateDir)
  writeFileSync(join(stateDir, 'mobilegw.token'), 'server-only-test-token')
  return { ready: Promise.resolve(), machine: { stateDir }, health: { runtime: { state: 'ready' }, mobile: { state: 'ready' } },
    store: { settings: () => ({ paused: false }), tickets: { list: () => [] } } } as unknown as HttpHost
}
const upstream = (() => Response.json({ items: [], sessions: ['main'], default_session_id: 'main' })) as unknown as typeof fetch
const timeline = (host: HttpHost) => phoneHandler(host, undefined, upstream)(new Request('http://dsh/api/mobile/timeline'))
const type = { pathname: '/api/mobile/timeline', method: 'GET', devices: { allows: (d: string, t: string) => d === 'dev-a' && t === 'good' } }

describe('timeline server metadata (optional, read-only, same-source identity)', () => {
  it('carries server.crew equal to the mDNS TXT fingerprint (same source, server-computed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-id-')); directories.push(dir)
    const body = await (await timeline(hostWith(dir))).json() as { server?: { crew: string; public_base: string } }
    expect(body.server).toBeDefined()
    // 与 discovery 的 crewFingerprint(stateDir) 逐字相同（同一实现、同源），不是临时 masterId/session id。
    expect(body.server!.crew).toBe(crewFingerprint(dir))
    expect(body.server!.crew).toMatch(/^[0-9a-z]{7}$/)
  })

  it('public_base comes from publicEntry (real HTTPS domain) when configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-id-')); directories.push(dir)
    writeFileSync(join(dir, 'mobile-public-url'), 'https://crew.kentonnie.top\n')
    const body = await (await timeline(hostWith(dir))).json() as { server?: { public_base: string } }
    expect(body.server!.public_base).toBe('https://crew.kentonnie.top')
    // 与 publicEntry 现有计算一致（同源）。
    expect(body.server!.public_base).toBe(publicEntry(dir))
  })

  it('empty public entry yields empty public_base — never invents a LAN/plaintext URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-id-')); directories.push(dir)
    // 没有 mobile-public-url 文件，也没有 CREW_PUBLIC_URL
    const body = await (await timeline(hostWith(dir))).json() as { server?: { public_base: string } }
    expect(body.server!.public_base).toBe('')
  })

  it('rejects non-HTTPS / credentialed / query-bearing public_base to empty (no plaintext, no userinfo)', async () => {
    for (const bad of ['http://crew.example.test', 'https://u:p@crew.example.test', 'https://crew.example.test/path?token=x']) {
      const dir = mkdtempSync(join(tmpdir(), 'srv-id-')); directories.push(dir)
      writeFileSync(join(dir, 'mobile-public-url'), bad + '\n')
      const body = await (await timeline(hostWith(dir))).json() as { server?: { public_base: string } }
      // 原样 publicEntry 可能是非法的，但 serverIdentity 只放行 https + 无 userinfo/query/fragment，其余给空。
      expect(body.server!.public_base).toBe('')
    }
  })

  it('public_base preserves a legitimate base subpath (prefix) without degrading to host root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-id-')); directories.push(dir)
    writeFileSync(join(dir, 'mobile-public-url'), 'https://crew.kentonnie.top/crew-prefix/\n')
    const body = await (await timeline(hostWith(dir))).json() as { server?: { public_base: string } }
    // 保留合法子路径、去尾斜杠；不退化成 https://crew.kentonnie.top（那会指向错误换路）。
    expect(body.server!.public_base).toBe('https://crew.kentonnie.top/crew-prefix')
  })

  it('public_base root stays https://host (no trailing slash) and never becomes another address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-id-')); directories.push(dir)
    writeFileSync(join(dir, 'mobile-public-url'), 'https://crew.kentonnie.top/\n')
    const body = await (await timeline(hostWith(dir))).json() as { server?: { public_base: string } }
    expect(body.server!.public_base).toBe('https://crew.kentonnie.top')
  })

  it('old-client compatibility: server field is additive; timeline still returns all existing keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-id-')); directories.push(dir)
    const body = await (await timeline(hostWith(dir))).json() as Record<string, unknown>
    // 既有键仍在（老 App 忽略 server 即兼容）。
    for (const key of ['items', 'sessions', 'session_id', 'default_session_id', 'session_api', 'tasks', 'groups']) {
      expect(body).toHaveProperty(key)
    }
    expect(body).toHaveProperty('server')
  })

  it('auth gate unchanged: anonymous request still 401 (server field does not open auth)', async () => {
    const { phoneGate } = await import('../src/app/phone-gate.ts')
    const denied = phoneGate({ ...type, headers: {} })
    expect(denied?.status).toBe(401)
    // 带真凭据放行（undefined）。字段只增在已配对响应里，不改变门。
    const ok = phoneGate({ ...type, headers: { 'x-crew-device': 'dev-a', 'x-crew-credential': 'good' } })
    expect(ok).toBeUndefined()
  })
})
