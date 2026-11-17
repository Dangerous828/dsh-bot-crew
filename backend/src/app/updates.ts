/**
 * 手机装新版本的那条路：`/updates/android/`。
 *
 * 手机走的那条监听（43499，cloudflared 直连它）平时只服务「验过设备凭据的消息面」。
 * 但升级这件事本身有一道先有鸡还是先有蛋：手机上的旧版本要能装上新的，就得先下到包；
 * 而包能不能下，不该取决于那个旧版本还记不记得自己的配对凭据（重装、换机、清数据都丢了）。
 * 所以这里是**唯一**一片不带凭据的区域，范围被文件系统契约钉死：
 *
 *   分发根 = <stateDir>/android-updates
 *   指针   = root/manifest.json（发布 CLI 原子写，是唯一的 latest）
 *   包     = root/<versionCode>/<sha256>.apk（不可变：内容由文件名自证）
 *
 * 路径形状既然固定，就不需要 decode，也不需要「先拼路径再防穿越」：正则只认一种写法，
 * 不认识的写法一律 404。读文件之前再把 realpath 与根对齐，堵掉发布目录里被塞进符号链接的可能。
 * 这条路发的包不含凭据（由发布 CLI 保证），所以公开它是安全的；凭据仍在 App 里。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

/** 这条路占的路径前缀。lan-server 拿它决定「这条请求归不归 updates 管」。 */
export const UPDATE_PREFIX = '/updates/android'

/** 只发我们自己的 App。manifest 说别的包名就当作没发布。 */
const PACKAGE = 'com.dsh.botcrew'
const HEX64 = /^[0-9a-f]{64}$/
/** versionCode 的可接受区间：1 到 Android 允许的上限（CLI 也只发这个区间）。 */
const VERSION_CODE_MIN = 1
const VERSION_CODE_MAX = 2_100_000_000
/** manifest 是我们自己的 CLI 写的一行 JSON；超过这个尺寸只可能是放错了文件。 */
const MANIFEST_MAX = 64 * 1024
/** 不可变内容：同一个 URL 永远是同一串字节，缓存越久越好。 */
const IMMUTABLE = 'public, max-age=31536000, immutable'

export interface UpdateManifest {
  schemaVersion: 1
  packageName: string
  versionCode: number
  versionName: string
  buildId: string
  minSdk: number
  sha256: string
  size: number
  signerSha256: string
  apkPath: string
  notes?: string
}

type ManifestRead =
  | { kind: 'ok'; value: UpdateManifest }
  /** 还没发布过：对手机来说是「没有新版本」，不是错误。 */
  | { kind: 'missing' }
  /** 有人在往发布目录里写错东西：这是服务端的问题，得让它显形。 */
  | { kind: 'broken' }

/**
 * 认领并回答一条 `/updates/android` 请求。
 *
 * 调用方只在路径确实落在这片前缀里时才交过来；这个函数自己不再往外抛：
 * 流读到一半断连、发布目录没了、manifest 被写坏，都只变成一条回应。
 */
export async function serveAndroidUpdate(request: IncomingMessage, response: ServerResponse, root: string): Promise<void> {
  try {
    await route(request, response, root)
  } catch {
    // 意外的细节里有本机路径，不能直出。头发完之后的失败只能切断连接。
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'Update distribution failed' }))
    } else response.destroy()
  }
}

async function route(request: IncomingMessage, response: ServerResponse, root: string): Promise<void> {
  const method = request.method ?? 'GET'
  // 只有取。升级不需要往这条路上推任何东西。
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }
  // 不 decode：合法的三种形状里没有需要解码的字符，而解码只会让 `%2e%2e%2f` 变成另一个名字。
  const path = (request.url ?? '/').split('?')[0] ?? '/'
  if (path === UPDATE_PREFIX || path === `${UPDATE_PREFIX}/`) {
    // 浏览器里手输这个目录时给一个确定能下到东西的地址。
    redirect(response, `${UPDATE_PREFIX}/latest.apk`)
    return
  }
  if (path === `${UPDATE_PREFIX}/manifest.json`) {
    await sendManifest(request, response, root)
    return
  }
  if (path === `${UPDATE_PREFIX}/latest.apk`) {
    await sendLatest(response, root)
    return
  }
  // 位数放宽到 10（CLI 能发到 2_100_000_000），但值仍走与 manifest 同一区间 ——
  // 否则 manifest 认的版本号在 URL 上取不到。
  const apk = /^\/updates\/android\/(\d{1,10})\/([0-9a-f]{64})\.apk$/.exec(path)
  const code = apk ? Number(apk[1]) : 0
  // 前导零也是另一种写法：`007` 与 `7` 不该是两个地址。
  if (!apk || String(code) !== apk[1] || code < VERSION_CODE_MIN || code > VERSION_CODE_MAX) {
    notFound(response)
    return
  }
  await sendApk(request, response, method, root, code, apk[2]!)
}

async function sendManifest(request: IncomingMessage, response: ServerResponse, root: string): Promise<void> {
  const read = await readManifest(root)
  if (read.kind === 'missing') return missing(response, 'No release published')
  if (read.kind === 'broken') return unavailable(response)
  const body = JSON.stringify(read.value)
  // 指针必须每次现读：缓存住它，手机就会一直看到旧版本。
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  if (request.method === 'HEAD') response.end()
  else response.end(body)
}

/** 浏览器首次启用升级时的稳定入口：它自己不含版本号，所以每次都要现读指针。 */
async function sendLatest(response: ServerResponse, root: string): Promise<void> {
  const read = await readManifest(root)
  if (read.kind === 'missing') return missing(response, 'No release published')
  if (read.kind === 'broken') return unavailable(response)
  redirect(response, read.value.apkPath)
}

/**
 * 一个发布包里那个 APK 的真实路径与大小；解析不了就是 `undefined`。
 *
 * 缺失、断链、读不了、越出分发根（发布目录里被塞进来的符号链接），对外一律「没有」——
 * 不区分原因，那是在帮人探目录。manifest 那一侧用同一份判定来挡坏指针。
 */
async function locateApk(root: string, code: number, sha: string): Promise<{ file: string; size: number } | undefined> {
  const relative = join(String(code), `${sha}.apk`)
  try {
    // realpath 与根对齐：符号链接不能把这条公开进口带到目录之外。
    const realRoot = await realpath(root)
    const real = await realpath(join(root, relative))
    if (real !== join(realRoot, relative)) return undefined
    const info = await stat(real)
    if (!info.isFile() || info.size <= 0) return undefined
    return { file: real, size: info.size }
  } catch {
    return undefined
  }
}

async function sendApk(request: IncomingMessage, response: ServerResponse, method: string, root: string, code: number, sha: string): Promise<void> {
  const located = await locateApk(root, code, sha)
  if (!located) return notFound(response)
  const { file, size } = located
  const range = readRange(request.headers.range, size)
  if (range === 'unsatisfiable') {
    response.writeHead(416, {
      'content-range': `bytes */${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store',
      'content-type': 'application/vnd.android.package-archive',
    })
    response.end()
    return
  }
  const headers: Record<string, string> = {
    'content-type': 'application/vnd.android.package-archive',
    'cache-control': IMMUTABLE,
    'accept-ranges': 'bytes',
    'content-length': String(range ? range.end - range.start + 1 : size),
    // 文件名由 code 与 sha 组成，都是校验过的字符：不会往头里注入任何东西。
    'content-disposition': `attachment; filename="${PACKAGE}-${code}.apk"`,
  }
  if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`
  response.writeHead(range ? 206 : 200, headers)
  if (method === 'HEAD') {
    response.end()
    return
  }
  // 断连是下载器的日常（换网络、锁屏、取消）：pipeline 会把源关掉并拒掉这个 promise，
  // 这里只把回应收掉，绝不让它变成未捕获异常。
  const source = range ? createReadStream(file, { start: range.start, end: range.end }) : createReadStream(file)
  await pipeline(source, response).catch(() => { response.destroy() })
}

type ByteRange = { start: number; end: number }

/**
 * 单区间 Range。下载器续传靠它。
 *
 * 多区间或语法不合 → 忽略（RFC 9110 允许），回整份，比猜一个区间安全。
 * 起点越过文件尾 → 416，让下载器知道该重新取整份。
 */
export function readRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined {
  if (!header) return undefined
  const said = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim())
  if (!said) return undefined
  const from = said[1] ?? ''
  const to = said[2] ?? ''
  if (from === '' && to === '') return undefined
  if (from === '') {
    // `bytes=-500`：最后 500 字节。0 是要不到任何字节的。
    const length = Number(to)
    if (length === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(from)
  if (start >= size) return 'unsatisfiable'
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

async function readManifest(root: string): Promise<ManifestRead> {
  // 指针本身也要与分发根对齐：拿一个符号链接把 manifest 指到根外，等于让这条公开进口
  // 去读本机任意一份 JSON。APK 那一侧早有这道判定，指针这一侧不能少。
  let file: string
  try {
    const realRoot = await realpath(root)
    const real = await realpath(join(root, 'manifest.json'))
    if (real !== join(realRoot, 'manifest.json')) return { kind: 'broken' }
    file = real
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    return { kind: 'broken' }
  }
  let said: unknown
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MANIFEST_MAX) return { kind: 'broken' }
    said = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // 读到了但不是合法 JSON：发布写坏了。
    return { kind: 'broken' }
  }
  const value = validate(said)
  if (!value) return { kind: 'broken' }
  // 指针必须真的指到一个能下的包，且大小与声明一致。发布 CLI 先写 APK 再改 manifest，
  // 所以这里对不上就只有一个解释：发布坏了。发出去等于让手机拿着一个下不动的指针。
  const apk = await locateApk(root, value.versionCode, value.sha256)
  if (!apk || apk.size !== value.size) return { kind: 'broken' }
  return { kind: 'ok', value }
}

/**
 * 逐字段校验，并把认得的字段**重新拼一遍**再发出去。
 *
 * 重新拼的意义不只是挡脏数据：manifest 是外部写进来的文件，原样转发等于让写它的人顺手
 * 决定发给手机的每一个字节（多塞一个看着像本地路径的字段，读的人就会当它可信）。
 * `apkPath` 尤其不能照抄 —— 它必须是 versionCode 与 sha256 拼出来的那一个，否则这个指针
 * 就能把用户带去读任意文件。
 */
export function validate(said: unknown): UpdateManifest | undefined {
  if (!said || typeof said !== 'object' || Array.isArray(said)) return undefined
  const item = said as Record<string, unknown>
  const text = (name: string): string | undefined => {
    const value = item[name]
    return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined
  }
  const integer = (name: string, least: number, most = Number.MAX_SAFE_INTEGER): number | undefined => {
    const value = item[name]
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= least && value <= most ? value : undefined
  }
  const versionCode = integer('versionCode', VERSION_CODE_MIN, VERSION_CODE_MAX)
  const size = integer('size', 1)
  const minSdk = integer('minSdk', 21)
  const versionName = text('versionName')
  const buildId = text('buildId')
  const sha256 = typeof item.sha256 === 'string' && HEX64.test(item.sha256) ? item.sha256 : undefined
  const signerSha256 = typeof item.signerSha256 === 'string' && HEX64.test(item.signerSha256) ? item.signerSha256 : undefined
  if (item.schemaVersion !== 1 || item.packageName !== PACKAGE) return undefined
  if (versionCode === undefined || size === undefined || minSdk === undefined) return undefined
  if (!versionName || !buildId || !sha256 || !signerSha256) return undefined
  const apkPath = `${UPDATE_PREFIX}/${versionCode}/${sha256}.apk`
  if (item.apkPath !== apkPath) return undefined
  const notes = typeof item.notes === 'string' && item.notes.length > 0 && item.notes.length <= 2_000 ? item.notes : undefined
  return { schemaVersion: 1, packageName: PACKAGE, versionCode, versionName, buildId, minSdk, sha256, size, signerSha256, apkPath, ...(notes ? { notes } : {}) }
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, 'cache-control': 'no-store', 'content-length': '0' })
  response.end()
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ error: 'Not found' }))
}

/** 还没发布过。手机看到它就该安静地什么都不做。 */
function missing(response: ServerResponse, error: string): void {
  response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ error }))
}

/** 发布目录里有东西但不合契约。客户端重试没用，得有人看服务端。 */
function unavailable(response: ServerResponse): void {
  response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60' })
  response.end(JSON.stringify({ error: 'Update metadata unavailable' }))
}
