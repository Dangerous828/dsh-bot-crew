/**
 * 中枢凭据：设置里只存**引用**，token 值只在请求那一刻从环境或凭据文件现读。
 *
 * 为什么不在设置里存值：`memory` 这一块会原样出现在 `GET /orchestrator/api/state`、
 * `GET settings` 与管理页表单里 —— 一个明文 token 落在那里，等于同时进了日志、截图、
 * 导出与 git diff。所以配置里只有「去哪儿取」：
 *
 * - `memory.tokenEnv`：环境变量名（例如 `HUB_TOKEN`）。
 * - `memory.tokenFile`：凭据文件绝对路径（应为 `0600`）。与 `tokenEnv` 同时给时
 *   按 `KEY=VALUE` 环境文件解析该键；只给文件时把整份内容当 token。
 *
 * 本模块只回答「现在能不能拿到 token、从哪儿来、有没有问题」，**不记录值**，
 * 也不把值放进任何错误消息或日志（`describe()` 只回引用，`redactToken()` 用于兜底）。
 */
import { readFileSync, statSync } from 'node:fs'

/** 凭据引用：两项都空 = 没配 token（请求不带 header）。 */
export interface HubTokenRef {
  /** 环境变量名；空串 = 不看进程环境。 */
  env?: string
  /** 凭据文件绝对路径；空串 = 不看文件。 */
  file?: string
}

/** token 从哪儿来。`none` = 一个引用都没配。 */
export type HubTokenSource = 'env' | 'file' | 'none'

export interface HubTokenRead {
  /** 读到的值；读不到就是空串（绝不返回半个值）。 */
  token: string
  source: HubTokenSource
  /**
   * 读到了/没读到但**有情况要说**（文件不可读、键不存在、权限过宽、值不像 token）。
   * 这是给人看的，不含 token 值本身。
   */
  problem?: string
}

/** 读进程环境；测试注入。 */
export type HubEnvRead = (name: string) => string | undefined
/** 读凭据文件；测试注入。返回文本与权限位（`mode & 0o777`）。 */
export type HubFileRead = (path: string) => { text: string; mode?: number }

export interface HubTokenIo {
  env?: HubEnvRead
  file?: HubFileRead
}

const readEnv: HubEnvRead = name => process.env[name]
const readFile: HubFileRead = path => {
  const stat = statSync(path)
  return { text: readFileSync(path, 'utf8'), mode: stat.mode & 0o777 }
}

/** 凭据文件的上限：超过这个大小多半是拿错了文件，不该把整份内容当 token。 */
const MAX_TOKEN_BYTES = 64 * 1024
/** token 的合理长度上限。真 token 远小于此；超了就是读错了东西。 */
const MAX_TOKEN_CHARS = 4096

/** 去掉包裹的引号与首尾空白；不做别的「清洗」（改过的 token 一定不是原 token）。 */
function clean(value: string): string {
  const trimmed = value.trim()
  const unquoted = /^(['"])(.*)\1$/s.exec(trimmed)
  return (unquoted?.[2] ?? trimmed).trim()
}

/**
 * 从 `KEY=VALUE` 形式的环境文件里取一个键。
 *
 * 认 `export KEY=VALUE`、`#` 注释、空行与成对引号；同一个键出现多次取第一条
 * （与 shell 里 `set -a; . file` 的实际效果一致）。
 */
export function envFileValue(text: string, key: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match || match[1] !== key) continue
    return clean(match[2] ?? '')
  }
  return undefined
}

/**
 * 现读一次凭据。顺序：进程环境 → 凭据文件。
 *
 * 环境优先是因为它不碰磁盘；文件优先会让人改了环境变量却没生效，更难查。
 */
export function readHubToken(ref: HubTokenRef, io: HubTokenIo = {}): HubTokenRead {
  const env = (io.env ?? readEnv)
  const file = (io.file ?? readFile)
  const name = (ref.env ?? '').trim()
  const path = (ref.file ?? '').trim()
  if (!name && !path) return { token: '', source: 'none' }

  if (name) {
    const value = clean(env(name) ?? '')
    if (value) return finish({ token: value, source: 'env' }, value)
  }

  if (!path) {
    return { token: '', source: 'none', problem: `环境变量 ${name} 未设置或为空` }
  }
  let text: string, mode: number | undefined
  try {
    ({ text, mode } = file(path))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error'
    return { token: '', source: 'none', problem: `凭据文件读不出来（${path}）：${code}` }
  }
  if (text.length > MAX_TOKEN_BYTES) {
    return { token: '', source: 'none', problem: `凭据文件过大（${path}，>${MAX_TOKEN_BYTES} 字节），不当 token 用` }
  }
  // 与 tokenEnv 同时给 = 环境文件：按 KEY=VALUE 取那一个键。
  const value = name ? envFileValue(text, name) : clean(text)
  if (value === undefined) {
    return { token: '', source: 'none', problem: `凭据文件里没有 ${name} 这个键（${path}）` }
  }
  if (!value) return { token: '', source: 'none', problem: `凭据文件里 ${name} 是空值（${path}）` }
  const read: HubTokenRead = { token: value, source: 'file' }
  if (mode !== undefined && (mode & 0o077) !== 0) {
    // 仍然用它（链路要能通），但把「别人也读得到」如实说出来。
    read.problem = `凭据文件权限过宽（${path}，${mode.toString(8)}）：建议 chmod 600`
  }
  return finish(read, value)
}

/** 值的形态自检：含空白/换行的东西不是 token，宁可报问题也不用它。 */
function finish(read: HubTokenRead, value: string): HubTokenRead {
  if (value.length > MAX_TOKEN_CHARS) return { ...read, token: '', problem: `读到的值过长（${value.length} 字符），不像 token` }
  if (/\s/.test(value)) return { ...read, token: '', problem: '读到的值里含空白/换行，不像 token' }
  return read
}

/** 给人看的来源说明（引用，不含值）：`env:HUB_TOKEN` / `file:/path#HUB_TOKEN`。 */
export function describeToken(read: HubTokenRead): string {
  const ref = read.source === 'env' ? 'env' : read.source === 'file' ? 'file' : 'none'
  return ref
}

/** 兜底脱敏：任何要落日志/错误消息的文本，先把 token 值替换掉。 */
export function redactToken(text: string, token: string): string {
  if (!token) return text
  return text.split(token).join('***')
}

/** 中枢鉴权的四态。`anonymous` = 配了地址但一个凭据引用都没有。 */
export type HubAuthState = 'unconfigured' | 'anonymous' | 'ok' | 'rejected'

export interface HubAuthSnapshot {
  state: HubAuthState
  /** 凭据来源（`env` / `file` / `none`），不含值。 */
  source: HubTokenSource
  /** 最近一次被拒的 HTTP 状态码。 */
  status?: number
  /** 如实说明为什么不可用：文件读不到、键缺失、权限过宽、被中枢拒绝。 */
  problem?: string
}

export interface HubAuthOptions extends HubTokenIo {
  /** 日志；只在状态**变化**时写一行，避免每次召回都刷。 */
  log?: (line: string) => void
  /** 日志里用来指代中枢的标签（基址，不是凭据）；`retarget` 会跟着换。 */
  label?: string
  /** 状态变化回调（面板/health 面据此刷新）。 */
  onChange?: (snapshot: HubAuthSnapshot) => void
}

/**
 * 把鉴权状态翻成 health 面的一行（`/state.health.memory`）。
 *
 * 只报**真实结论**，五种情况分开说：
 * - 没配中枢 → `ready`「全在本机」（这不是故障）；
 * - 配了但还没探过 → `starting`「正在探测」（**不报 error**：刚启动就挂个假故障，
 *   overview 的 problems 每次开机都会亮一条）；
 * - 探测不通 → `error`「中枢不可达」（这一条以前是缺的：探测超时降级本机后
 *   health 仍写 `ready`，于是「hub 配了但记忆全本机」在健康面上完全看不见）；
 * - 配了地址、一个凭据引用都没有 → `paused`「请求不带 X-Hub-Token」（免鉴权中枢也能用，
 *   所以不报 error；真被拒会转成下面那种）；
 * - 被中枢拒绝（401/403）→ `error`「hub 未启用、记忆走本机」，这是要人动手的。
 *
 * 可达性与鉴权是**两个维度**，两个都得说：被拒优先（那是有明确动作的凭据问题），
 * 其次不可达（网络/地址/超时）。
 *
 * @param reachable - 探测结论：`'up'` / `'down'` / 省略或 `'unknown'` 表示还没探过。
 */
export function hubHealthOf(hub: string, snapshot: HubAuthSnapshot,
  reachable: 'up' | 'down' | 'unknown' = 'unknown'): { state: 'ready' | 'paused' | 'error' | 'starting'; detail: string } {
  if (!hub) return { state: 'ready', detail: '没有中枢：记忆全在本机' }
  if (snapshot.state === 'rejected') {
    return { state: 'error', detail: `中枢拒绝凭据 (${snapshot.status ?? '?'})：hub 未启用，记忆走本机；检查 memory.tokenEnv / memory.tokenFile`
      + `${snapshot.problem ? `（${snapshot.problem}）` : ''}` }
  }
  if (reachable === 'down') {
    return { state: 'error', detail: `中枢不可达（${hub}）：探测 /health 失败或超时，记忆走本机；检查网络与 memory.hub、memory.timeoutMs` }
  }
  if (reachable === 'unknown') {
    return { state: 'starting', detail: `正在探测中枢（${hub}）` }
  }
  if (snapshot.state === 'anonymous') {
    return { state: 'paused', detail: 'hub 已配置但没有凭据引用（memory.tokenEnv / memory.tokenFile 都为空）：请求不带 X-Hub-Token' }
  }
  return { state: snapshot.problem ? 'paused' : 'ready',
    detail: `中枢凭据来自${snapshot.source === 'env' ? '环境变量' : snapshot.source === 'file' ? '凭据文件' : '未配置'}`
      + `${snapshot.problem ? `（${snapshot.problem}）` : ''}` }
}

/**
 * 中枢鉴权状态机：读凭据、记住「被拒过」、把状态变化说清楚。
 *
 * 关键一条：**探测通过 ≠ 中枢可用**。`/v1/health` 是免鉴权的，401 只会出现在
 * 真正调 `/memory/*` 的时候。所以「被拒」必须是一个能被观察到的独立状态，
 * 而不是在 catch 里静默降级、日志上还留着「hub reached」。
 */
export class HubAuth {
  private cached?: HubTokenRead
  private state: HubAuthState = 'unconfigured'
  private status?: number
  private problem?: string
  private announced = ''

  constructor(private ref: HubTokenRef, private readonly options: HubAuthOptions = {}) {}

  /**
   * 换掉凭据引用（配置热生效用）。
   *
   * 为什么要有它：`ref` 在构造期被捕获，设置里改了 `tokenEnv` / `tokenFile` 之后
   * `refresh()` 重读的仍是**旧引用**，于是「设置改了、行为不变」，非得重启。
   * 换引用必须同时作废读到的值与「被拒」结论，否则新引用会沿用旧结论。
   */
  retarget(ref: HubTokenRef, label?: string): void {
    this.ref = ref
    if (label !== undefined) this.options.label = label
    this.cached = undefined
    this.status = undefined
    this.problem = undefined
    this.announced = ''
    this.refresh()
  }

  /** 现读（或读缓存）一次凭据。 */
  read(): HubTokenRead {
    if (!this.cached) this.cached = readHubToken(this.ref, this.options)
    return this.cached
  }

  /** 请求要用的 token；空串 = 不带 header。 */
  token(): string {
    return this.read().token
  }

  /** 重新读一次凭据，并清掉「被拒」—— 换对了 token 就能在下一个 TTL 自动恢复，不用重启。 */
  refresh(): HubTokenRead {
    this.cached = readHubToken(this.ref, this.options)
    const read = this.cached
    if (this.state === 'rejected') { this.state = 'ok'; this.status = undefined }
    this.problem = read.problem
    // 没读到值就是 `anonymous`：不带 header 发出去，让中枢自己说认不认（免鉴权的开发中枢也能用）。
    this.state = read.token ? 'ok' : 'anonymous'
    this.announce()
    return read
  }

  /** 中枢拒绝了请求（401/403）。之后 `usable()` 为 false，直到下一次 `refresh()`。 */
  reject(status: number, detail?: string): void {
    this.status = status
    this.state = 'rejected'
    this.problem = detail
    this.announce()
  }

  /** 一次请求成功：把「被拒」清掉（同一 TTL 内不再重复报同一件事）。 */
  accept(): void {
    if (this.state === 'ok') return
    this.state = 'ok'
    this.status = undefined
    this.problem = undefined
    this.announce()
  }

  snapshot(): HubAuthSnapshot {
    const read = this.read()
    return { state: this.state, source: read.source,
      ...this.status === undefined ? {} : { status: this.status },
      ...this.problem === undefined ? {} : { problem: this.problem } }
  }

  /** 现在能不能拿它干活：只有「被拒」才确定不能用；`anonymous` 可能能用（免鉴权的开发中枢），试了才知道。 */
  usable(): boolean { return this.state !== 'rejected' }

  /** 状态变化才写日志；同样一句话不重复刷。 */
  private announce(): void {
    const label = this.options.label ? ` (${this.options.label})` : ''
    const read = this.cached ?? this.read()
    const line = this.state === 'rejected'
      ? `[memory] hub 鉴权被拒 (${this.status ?? '?'})${label} — 中枢不接受 memory.tokenEnv/memory.tokenFile 的凭据；hub 未启用，记忆走本机`
      : this.state === 'ok'
        ? `[memory] hub 鉴权就绪 via ${read.source}${read.problem ? `（${read.problem}）` : ''}${label}`
        : `[memory] hub 配了地址但没有任何 token 引用（memory.tokenEnv / memory.tokenFile）${label} — 请求不带 X-Hub-Token；需要鉴权的中枢会回 401`
    if (line !== this.announced) {
      this.announced = line
      this.options.log?.(line)
    }
    this.options.onChange?.(this.snapshot())
  }
}
