import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLanServer } from '../src/app/lan-server.ts'
import { readRange, validate } from '../src/app/updates.ts'

/**
 * 这一片是**公开的**（手机上的旧版本丢了凭据也要能先装上新的），所以每一条测试都在问同一个问题：
 * 公开的那部分是否恰好只是「两个固定形状的包 + 一个指针」。
 */

let root: string
let stateDir: string

const bytes = new Uint8Array(4096).map((_, index) => index % 251)

function sha256Of(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** manifest 是我们自己的 CLI 写的，测试照它的契约照样出现，不掺别的字段。 */
function manifestBytes(overrides: Record<string, unknown> = {}): string {
  const value = {
    schemaVersion: 1, packageName: 'com.dsh.botcrew', versionCode: 7, versionName: '0.7.0',
    buildId: 'b7', minSdk: 26, sha256: sha256Of(bytes), size: bytes.length,
    signerSha256: 'a'.repeat(64), apkPath: `/updates/android/7/${sha256Of(bytes)}.apk`, notes: 'first OTA',
    ...overrides,
  }
  return JSON.stringify(value)
}

function publish(overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(root, '7'), { recursive: true })
  writeFileSync(join(root, '7', `${sha256Of(bytes)}.apk`), bytes)
  writeFileSync(join(root, 'manifest.json'), manifestBytes(overrides))
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'ota-state-'))
  root = join(stateDir, 'android-updates')
  mkdirSync(root, { recursive: true })
})

afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

const lan = async (options: { allows?: boolean } = {}) => {
  const server = createLanServer({
    devices: { allows: () => options.allows ?? false } as never,
    forward: async () => Response.json({ error: 'should not be forwarded' }, { status: 500 }),
    updatesRoot: root,
  })
  const port = await server.listen(0, '127.0.0.1')
  return { server, port, url: (path: string) => `http://127.0.0.1:${port}${path}` }
}

describe('public upgrade surface', () => {
  // 升级这条路的整个意义就是「不需要凭据」，而消息面必须一字不让。
  it('serves updates without a credential while the message surface still answers 401', async () => {
    publish()
    const { server, url } = await lan()
    try {
      const manifest = await fetch(url('/updates/android/manifest.json'))
      expect(manifest.status).toBe(200)
      expect(manifest.headers.get('cache-control')).toBe('no-store')
      expect(await manifest.json()).toMatchObject({ versionCode: 7, packageName: 'com.dsh.botcrew' })

      expect((await fetch(url('/api/mobile/timeline'))).status).toBe(401)
      // 带错凭据也一样。
      expect((await fetch(url('/api/mobile/timeline'), { headers: { 'x-crew-device': 'a', 'x-crew-credential': 'b' } })).status).toBe(401)
    } finally { await server.close() }
  })

  // 元数据每次现读：指针缓存住，手机就永远看不到新版本。
  it('publishes the manifest exactly as the release CLI wrote it', async () => {
    publish()
    const { server, url } = await lan()
    try {
      const answer = await fetch(url('/updates/android/manifest.json'))
      expect(answer.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(await answer.text()).toBe(JSON.stringify(JSON.parse(manifestBytes())))
      // HEAD 只回头。
      const head = await fetch(url('/updates/android/manifest.json'), { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
    } finally { await server.close() }
  })

  // 一个 APK 能用三种方式取：整份、只要头、只要尾巴。下载器续传依赖后两种。
  it('serves one APK by GET, HEAD and a single byte range', async () => {
    publish()
    const { server, url } = await lan()
    const path = `/updates/android/7/${sha256Of(bytes)}.apk`
    try {
      const whole = await fetch(url(path))
      expect(whole.status).toBe(200)
      expect(whole.headers.get('content-type')).toBe('application/vnd.android.package-archive')
      expect(whole.headers.get('accept-ranges')).toBe('bytes')
      expect(whole.headers.get('content-length')).toBe(String(bytes.length))
      expect(whole.headers.get('cache-control')).toContain('immutable')
      expect(whole.headers.get('content-disposition')).toBe('attachment; filename="com.dsh.botcrew-7.apk"')
      expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes)

      const head = await fetch(url(path), { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-length')).toBe(String(bytes.length))
      expect(new Uint8Array(await head.arrayBuffer())).toEqual(new Uint8Array())

      const part = await fetch(url(path), { headers: { range: 'bytes=100-199' } })
      expect(part.status).toBe(206)
      expect(part.headers.get('content-range')).toBe(`bytes 100-199/${bytes.length}`)
      expect(part.headers.get('content-length')).toBe('100')
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(100, 200))

      // 开放尾巴（下载器不知道还剩多少时用）与越界。
      const tail = await fetch(url(path), { headers: { range: 'bytes=4000-' } })
      expect(tail.status).toBe(206)
      expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(4000))
      const beyond = await fetch(url(path), { headers: { range: `bytes=${bytes.length}-` } })
      expect(beyond.status).toBe(416)
      expect(beyond.headers.get('content-range')).toBe(`bytes */${bytes.length}`)
    } finally { await server.close() }
  })

  it('keeps the latest pointer and old immutable packages both readable after a release moves on', async () => {
    publish()
    const { server, url } = await lan()
    const oldPath = `/updates/android/7/${sha256Of(bytes)}.apk`
    try {
      const first = await fetch(url('/updates/android/latest.apk'), { redirect: 'manual' })
      expect(first.status).toBe(302)
      expect(first.headers.get('location')).toBe(oldPath)
      expect(first.headers.get('cache-control')).toBe('no-store')

      // 新版本：新目录、新 manifest，旧包原地不动。
      const fresh = new Uint8Array(2048).fill(9)
      mkdirSync(join(root, '8'), { recursive: true })
      writeFileSync(join(root, '8', `${sha256Of(fresh)}.apk`), fresh)
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        ...JSON.parse(manifestBytes()), versionCode: 8, versionName: '0.8.0', sha256: sha256Of(fresh),
        size: fresh.length, apkPath: `/updates/android/8/${sha256Of(fresh)}.apk`,
      }))

      const moved = await fetch(url('/updates/android/latest.apk'), { redirect: 'manual' })
      expect(moved.headers.get('location')).toBe(`/updates/android/8/${sha256Of(fresh)}.apk`)
      // 旧包仍按原 URL 可取：已经下了半份的手机不该在发版中途被打断。
      expect(new Uint8Array(await (await fetch(url(oldPath))).arrayBuffer())).toEqual(bytes)
      expect((await fetch(url(oldPath), { headers: { range: 'bytes=0-15' } })).status).toBe(206)
    } finally { await server.close() }
  })

  // 目录地址给人用：点开就能下到东西，不做一个新网页。
  it('redirects the directory to the latest package', async () => {
    publish()
    const { server, url } = await lan()
    try {
      for (const path of ['/updates/android/', '/updates/android']) {
        const answer = await fetch(url(path), { redirect: 'manual' })
        expect(answer.status).toBe(302)
        expect(answer.headers.get('location')).toBe('/updates/android/latest.apk')
      }
    } finally { await server.close() }
  })
})

describe('refusals', () => {
  it('answers 404 for missing packages and unpublished releases', async () => {
    const { server, url } = await lan()
    try {
      expect((await fetch(url('/updates/android/manifest.json'))).status).toBe(404)
      expect((await fetch(url('/updates/android/latest.apk'), { redirect: 'manual' })).status).toBe(404)
    } finally { await server.close() }
    publish()
    const second = await lan()
    try {
      // 目录里没有这个 code，或 sha 对不上，都是「没有」。
      expect((await fetch(second.url(`/updates/android/9/${'b'.repeat(64)}.apk`))).status).toBe(404)
      expect((await fetch(second.url(`/updates/android/7/${'b'.repeat(64)}.apk`))).status).toBe(404)
    } finally { await second.server.close() }
  })

  // 不自造路由：不认识的写法一律不接，也不把本地路径或原因说出来。
  it('refuses traversal, encoding tricks and every non-APK path without leaking details', async () => {
    publish()
    const { server, url } = await lan()
    try {
      const hostile = [
        '/updates/android/7/..%2f..%2fmanifest.json',
        '/updates/android/../../etc/passwd',
        '/updates/android/7/%2e%2e%2f%2e%2e%2fstate.db',
        `/updates/android/7/${sha256Of(bytes)}.apk.exe`,
        `/updates/android/7/${sha256Of(bytes)}`,
        `/updates/android/7/sub/${sha256Of(bytes)}.apk`,
        `/updates/android/-7/${sha256Of(bytes)}.apk`,
        `/updates/android/007/${sha256Of(bytes)}.apk`,
        `/updates/android//${sha256Of(bytes)}.apk`,
        '/updates/android/manifest.json.bak',
        '/updates/android/state.db',
        '/updates/android/7/',
      ]
      for (const path of hostile) {
        const answer = await fetch(url(path))
        expect([404, 400], `${path} → ${answer.status}`).toContain(answer.status)
        // 回应里不许出现本机目录名，也不许出现「为什么」。
        const said = await answer.text()
        expect(said).not.toContain(root)
        expect(said).not.toContain('android-updates/')
      }
      // 前缀之外仍然走老规矩：这些路径连凭据都不给进。
      expect((await fetch(url('/etc/passwd'))).status).toBe(404)
    } finally { await server.close() }
  })

  it('refuses methods other than GET and HEAD', async () => {
    publish()
    const { server, url } = await lan()
    try {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
        const answer = await fetch(url('/updates/android/manifest.json'), { method, ...(method === 'POST' || method === 'PUT' || method === 'PATCH' ? { body: '{}' } : {}) })
        expect(answer.status).toBe(405)
        expect(answer.headers.get('allow')).toBe('GET, HEAD')
      }
      const apk = await fetch(url(`/updates/android/7/${sha256Of(bytes)}.apk`), { method: 'POST', body: '{}' })
      expect(apk.status).toBe(405)
    } finally { await server.close() }
  })

  // 发布目录里被塞了一个指向外面的符号链接：这条公开进口不能把它带出去。
  it('does not follow a symlink that leaves the release directory', async () => {
    mkdirSync(join(root, '7'), { recursive: true })
    const secret = join(stateDir, 'state.db')
    writeFileSync(secret, 'credentials')
    const name = join(root, '7', `${'c'.repeat(64)}.apk`)
    symlinkSync(secret, name)
    writeFileSync(join(root, 'manifest.json'), manifestBytes({ sha256: 'c'.repeat(64), apkPath: `/updates/android/7/${'c'.repeat(64)}.apk` }))
    const { server, url } = await lan()
    try {
      expect((await fetch(url(`/updates/android/7/${'c'.repeat(64)}.apk`))).status).toBe(404)
      // 指针指向一个取不到的包：不发这份 manifest，否则手机拿着一个下不动的地址。
      expect((await fetch(url('/updates/android/manifest.json'))).status).toBe(503)
      expect((await fetch(url('/updates/android/latest.apk'), { redirect: 'manual' })).status).toBe(503)
    } finally { await server.close() }
  })

  // manifest 是外面写进来的文件：字段不合契约时不能把它原样发给手机。
  it('refuses a manifest that does not match the contract, and never echoes a hostile apkPath', async () => {
    publish({ apkPath: '/updates/android/7/../../../../etc/passwd' })
    const first = await lan()
    try {
      const answer = await fetch(first.url('/updates/android/manifest.json'))
      expect(answer.status).toBe(503)
      expect(await answer.text()).not.toContain('/etc/passwd')
    } finally { await first.server.close() }
    // 写坏的 JSON 与错包名同样拒绝。
    for (const broken of ['{ not json', manifestBytes({ packageName: 'com.example.other' }), manifestBytes({ sha256: 'XYZ' })]) {
      writeFileSync(join(root, 'manifest.json'), broken)
      const next = await lan()
      try {
        expect((await fetch(next.url('/updates/android/manifest.json'))).status).toBe(503)
        expect((await fetch(next.url('/updates/android/latest.apk'), { redirect: 'manual' })).status).toBe(503)
      } finally { await next.server.close() }
    }
  })

  // 用原始字节发请求：fetch 会自己把 `..` 规范化掉，那样测到的就不是服务端的判定了。
  it('refuses a percent-encoded traversal that arrives unnormalised', async () => {
    publish()
    const { server, port } = await lan()
    const send = (path: string): Promise<string> => new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path }, answer => {
        let said = ''
        answer.setEncoding('utf8')
        answer.on('data', chunk => { said += chunk })
        answer.on('end', () => resolve(`${answer.statusCode} ${said}`))
      })
      request.on('error', reject)
      request.end()
    })
    try {
      for (const path of ['/updates/android/7/..%2f..%2f..%2fmanifest.json', '/updates/android/%2e%2e%2fmanifest.json', '/updates/android/7/..%5c..%5cstate.db']) {
        const answer = await send(path)
        expect(answer.startsWith('404'), `${path} → ${answer.slice(0, 20)}`).toBe(true)
        expect(answer).not.toContain(root)
      }
      // 正常地址照旧能取。
      expect((await send('/updates/android/manifest.json')).startsWith('200')).toBe(true)
    } finally { await server.close() }
  })

  // 下载中途断开是日常（换网、锁屏、取消）。它不该留下未捕获异常，也不该影响下一条请求。
  it('survives a download that is cut off in the middle', async () => {
    publish()
    const { server, port, url } = await lan()
    try {
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port, path: `/updates/android/7/${sha256Of(bytes)}.apk` }, answer => {
          answer.once('data', () => { request.destroy(); resolve() })
          answer.on('error', () => resolve())
        })
        request.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve(); else reject(error) })
        request.end()
      })
      // 断开之后这条路照旧。
      expect((await fetch(url('/updates/android/manifest.json'))).status).toBe(200)
      expect(new Uint8Array(await (await fetch(url(`/updates/android/7/${sha256Of(bytes)}.apk`))).arrayBuffer())).toEqual(bytes)
    } finally { await server.close() }
  })
})

// 发布 CLI 能发到 2_100_000_000（10 位）。路由必须认同一个区间，否则 manifest 认的版本号
// 在 URL 上取不到 —— 那是两条各自成立的规则合起来出的一条死路。
describe('versionCode boundaries', () => {
  const boundary = 2_100_000_000
  const publishAt = (code: number): { path: string } => {
    mkdirSync(join(root, String(code)), { recursive: true })
    writeFileSync(join(root, String(code), `${sha256Of(bytes)}.apk`), bytes)
    writeFileSync(join(root, 'manifest.json'), manifestBytes({
      versionCode: code, apkPath: `/updates/android/${code}/${sha256Of(bytes)}.apk`,
    }))
    return { path: `/updates/android/${code}/${sha256Of(bytes)}.apk` }
  }

  it('serves the highest version the release CLI can publish, and 1', async () => {
    for (const code of [1, boundary]) {
      const { path } = publishAt(code)
      const { server, url } = await lan()
      try {
        expect(await (await fetch(url('/updates/android/manifest.json'))).json()).toMatchObject({ versionCode: code, apkPath: path })
        const apk = await fetch(url(path))
        expect(apk.status, `code ${code}`).toBe(200)
        expect(new Uint8Array(await apk.arrayBuffer())).toEqual(bytes)
        // 同一个包在 latest 指针上也是它。
        const latest = await fetch(url('/updates/android/latest.apk'), { redirect: 'manual' })
        expect(latest.headers.get('location')).toBe(path)
        expect((await fetch(url(path), { headers: { range: 'bytes=0-15' } })).status).toBe(206)
      } finally { await server.close() }
    }
  })

  it('refuses a code one past the ceiling, zero, negatives and 11 digits', async () => {
    const { path } = publishAt(boundary)
    const { server, url } = await lan()
    const beyond = path.replace(`/${boundary}/`, `/${boundary + 1}/`)
    try {
      expect((await fetch(url(beyond))).status).toBe(404)
      expect((await fetch(url(`/updates/android/0/${sha256Of(bytes)}.apk`))).status).toBe(404)
      expect((await fetch(url(`/updates/android/-1/${sha256Of(bytes)}.apk`))).status).toBe(404)
      expect((await fetch(url(`/updates/android/02100000000/${sha256Of(bytes)}.apk`))).status).toBe(404)
      expect((await fetch(url(`/updates/android/99999999999/${sha256Of(bytes)}.apk`))).status).toBe(404)
      // 上界内的那个照旧能取。
      expect((await fetch(url(path))).status).toBe(200)
    } finally { await server.close() }
  })

  it('refuses a manifest whose versionCode is outside the same interval', async () => {
    publishAt(boundary)
    const base = JSON.parse(manifestBytes())
    for (const code of [0, -1, boundary + 1, 9_007_199_254_740_991]) {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        ...base, versionCode: code, apkPath: `/updates/android/${code}/${sha256Of(bytes)}.apk`,
      }))
      const { server, url } = await lan()
      try {
        expect((await fetch(url('/updates/android/manifest.json'))).status, `code ${code}`).toBe(503)
      } finally { await server.close() }
    }
  })
})

// manifest 是公开进口要读的第一个文件。用符号链接把它指到分发根之外，等于让这条路去读
// 本机任意一份 JSON —— APK 那侧早有这道判定，指针这侧不能少。
describe('the pointer itself', () => {
  it('refuses a manifest symlinked out of the release directory', async () => {
    publish()
    const outside = join(stateDir, 'elsewhere.json')
    writeFileSync(outside, manifestBytes())
    rmSync(join(root, 'manifest.json'))
    symlinkSync(outside, join(root, 'manifest.json'))
    const { server, url } = await lan()
    try {
      expect((await fetch(url('/updates/android/manifest.json'))).status).toBe(503)
      expect((await fetch(url('/updates/android/latest.apk'), { redirect: 'manual' })).status).toBe(503)
      // 包本身仍在分发根里，照旧可取 —— 挡的是指针，不是包。
      expect((await fetch(url(`/updates/android/7/${sha256Of(bytes)}.apk`))).status).toBe(200)
    } finally { await server.close() }
  })

  // 发布坏在半路（APK 没写成功、写了别的字节）时，发出去的 manifest 就是一条死指针。
  it('refuses a manifest whose package is missing or whose size does not match', async () => {
    publish({ size: bytes.length + 1 })
    const first = await lan()
    try {
      expect((await fetch(first.url('/updates/android/manifest.json'))).status).toBe(503)
    } finally { await first.server.close() }

    // 声明的大小与实际字节不符：App 下完做 hash 校验也会失败，服务端先挡掉。
    publish()
    writeFileSync(join(root, '7', `${sha256Of(bytes)}.apk`), bytes.slice(0, 100))
    const second = await lan()
    try {
      expect((await fetch(second.url('/updates/android/manifest.json'))).status).toBe(503)
      // 包本身能被取到（内容自证），只是这份 manifest 不认它。
      expect((await fetch(second.url(`/updates/android/7/${sha256Of(bytes)}.apk`))).status).toBe(200)
    } finally { await second.server.close() }

    // 包还没写（只有 manifest）：同样是 503，不是一份指向 404 的指针。
    rmSync(join(root, '7'), { recursive: true, force: true })
    const third = await lan()
    try {
      expect((await fetch(third.url('/updates/android/manifest.json'))).status).toBe(503)
      expect((await fetch(third.url('/updates/android/latest.apk'), { redirect: 'manual' })).status).toBe(503)
    } finally { await third.server.close() }
  })
})

describe('range parsing', () => {
  it('reads single ranges, ignores what it cannot honour and rejects what is behind the file', () => {
    expect(readRange(undefined, 100)).toBeUndefined()
    expect(readRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(readRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(readRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    // 尾段比文件长：整份。
    expect(readRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
    // 结束越界：夹到文件尾（RFC 9110 允许），不是错误。
    expect(readRange('bytes=95-1000', 100)).toEqual({ start: 95, end: 99 })
    expect(readRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(readRange('bytes=20-10', 100)).toBe('unsatisfiable')
    expect(readRange('bytes=-0', 100)).toBe('unsatisfiable')
    // 多区间与怪异语法一律回整份：猜一个区间比给全份更容易出错。
    expect(readRange('bytes=0-9,20-29', 100)).toBeUndefined()
    expect(readRange('items=0-9', 100)).toBeUndefined()
    expect(readRange('bytes=abc-def', 100)).toBeUndefined()
  })
})

describe('manifest validation', () => {
  const good = (): Record<string, unknown> => JSON.parse(manifestBytes())

  it('accepts the contract and re-derives apkPath instead of echoing it', () => {
    const value = validate(good())
    expect(value?.apkPath).toBe(`/updates/android/7/${sha256Of(bytes)}.apk`)
    // 认得的字段按自己的顺序重拼；多塞的字段不进输出。
    const sneaky = { ...good(), statePath: '/Users/someone/.dsh/state/secret' }
    expect(Object.keys(validate(sneaky)!)).not.toContain('statePath')
  })

  it('rejects every field that the phone would have to trust blindly', () => {
    const rejects: unknown[] = [
      { ...good(), schemaVersion: 2 },
      { ...good(), packageName: 'com.example.other' },
      { ...good(), versionCode: 0 },
      { ...good(), versionCode: 7.5 },
      { ...good(), versionCode: '7' },
      { ...good(), size: 0 },
      { ...good(), sha256: 'A'.repeat(64) },
      { ...good(), sha256: sha256Of(bytes).slice(0, 63) },
      { ...good(), signerSha256: 'nope' },
      { ...good(), versionName: '' },
      { ...good(), buildId: 12 },
      { ...good(), minSdk: 20 },
      { ...good(), apkPath: `/updates/android/8/${sha256Of(bytes)}.apk` },
      { ...good(), apkPath: `/updates/android/7/${'b'.repeat(64)}.apk` },
      { ...good(), apkPath: '/manifest.json' },
      [],
      null,
      'manifest',
    ]
    for (const said of rejects) expect(validate(said), JSON.stringify(said).slice(0, 80)).toBeUndefined()
    // notes 只是展示用：写坏了就丢掉它，不能因此让整次发布失效（那等于谁都升不了级）。
    const long = validate({ ...good(), notes: 'x'.repeat(2_001) })
    expect(long).toBeDefined()
    expect(long?.notes).toBeUndefined()
  })
})

// 不给 updatesRoot 就没有这片区域：老行为一字不变（这是 NoWeb 之外唯一一条对外面的口子）。
describe('without a release directory', () => {
  it('keeps the whole listener on the credential-only surface', async () => {
    const server = createLanServer({ devices: { allows: () => true } as never, forward: async () => Response.json({ ok: true }) })
    const port = await server.listen(0, '127.0.0.1')
    try {
      expect((await fetch(`http://127.0.0.1:${port}/updates/android/manifest.json`)).status).toBe(404)
      const allowed = await fetch(`http://127.0.0.1:${port}/api/mobile/timeline`, { headers: { 'x-crew-device': 'a', 'x-crew-credential': 'b' } })
      expect(allowed.status).toBe(200)
    } finally { await server.close() }
  })
})

// 两个监听地址（局域网 + 回环）共用同一份处理，这条新区域也要在两边都在。
describe('every bound address', () => {
  it('serves the same update surface on each listener', async () => {
    publish()
    const server = createLanServer({ devices: { allows: () => false } as never, forward: async () => Response.json({}), updatesRoot: root })
    try {
      const bound = await server.listenAll(45679, ['127.0.0.1'])
      expect(bound).toEqual(['127.0.0.1'])
      const answer = await fetch(`http://127.0.0.1:45679/updates/android/manifest.json`)
      expect(answer.status).toBe(200)
      expect((await fetch(`http://127.0.0.1:45679/api/mobile/timeline`)).status).toBe(401)
    } finally { await server.close() }
  })
})
