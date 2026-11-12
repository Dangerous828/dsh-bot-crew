/**
 * 手机那条 P2P 路：电脑侧起一个 tailcat server，把手机要连的端口暴露进 WireGuard 隧道。
 *
 * 为什么是 tailcat 而不是我们自己写打洞：它是 Tailscale 官方的 data-plane-only 复刻
 * （"Tailscale without Tailscale"）—— magicsock 负责 NAT 穿透、WireGuard 负责端到端加密、
 * DERP 只在打不通时当中继。手机端因此既不用装 VPN 客户端，我们也不用把打洞、重传、加密、
 * userspace TCP 栈各写一遍。
 *
 * 与另外两条路的分工（三条都是并存的，不是替代）：
 *
 *   p2p    同一台机器、出了门、NAT 允许打洞 → 直连 UDP，延迟最低（实测同机 1.37ms）
 *   lan    同一个 Wi-Fi → 直连更快更稳，少一跳
 *   relay  打洞失败（对称 NAT / 无 UDP）→ 走中转，见 `relay-chain.ts` 与 CF 隧道
 *
 * 地址必须固定：`--key=default` 让 tailcat 用保存的密钥，同一台机器每次重启都得到同一个
 * tc-addr。手机在任何一个网络下看见过一次这个地址就够了 —— 不必每次重连都重新分发。
 *
 * 不复用 `mobilegw` 那套 launchd 托管，是因为这个进程的地址要发布出去：它的 stdout 就是
 * 「我现在在哪」，由后端自己拉起、自己读、自己重连，状态才有一份唯一真相。
 */
import { spawn, type ChildProcess } from 'node:child_process'

/**
 * tc-addr 的形状：`tcp` 开头，后面是很长的一串 base64url（内嵌 WireGuard 与路径发现公钥）。
 *
 * 不按「监听」那句话去匹配，是因为同一件事有两种文案，且都打在 **stderr**：
 *
 *   # 🐈 Server listening with new address: tcp…      （临时密钥）
 *   # 🐈 Server listening with saved key "default": tcp…  （--key=default，我们要的那条）
 *
 * 只认形状，两种说法都收；长度下限挡住日志里偶然出现的短 `tcp…` 字样。
 */
const ADDR_PATTERN = /\b(tcp[A-Za-z0-9_-]{40,})/

/**
 * 从 stdout 的一行里取出 tc-addr，取不到就是 undefined。
 *
 * tc-addr 本身既是地址也是凭据（内嵌 WireGuard 公钥与路径发现公钥，默认还带预共享密钥），
 * 所以这里只做「像不像」的形状校验，不做语义解析 —— 语义归 tailcat 自己。
 */
export function parseAddr(line: string): string | undefined {
  return ADDR_PATTERN.exec(line)?.[1]
}

/** 重连退避：起不来别把机器打满，但也不许放弃（放弃等于这条路上永远不再有 P2P）。 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

export interface P2pOptions {
  /** tailcat 可执行文件。不存在就当作这台机器没有这条通道，其余功能一点不受影响。 */
  binary: string
  /** 要暴露进隧道的本地端口（手机要访问的那个）。 */
  port: number
  /** 保存的密钥名；固定地址靠它。 */
  keyName?: string
  /** 地址变了（首次拿到、或换了网络后重新协商）就报一次。 */
  onAddr?: (addr: string) => void
  /** 起不来、或者中途掉了的原因。调用方负责翻译成人话记进健康项。 */
  /** 与健康项同一套词汇：起不来或掉线都是 error，不是第三种状态。 */
  onState?: (state: 'ready' | 'error', detail: string) => void
  logger?: (message: string) => void
}

export interface P2p {
  /** 开始盯着这条通道（幂等）。 */
  start(): void
  stop(): Promise<void>
  /** 当前可用的 tc-addr；还没起来时为 undefined。 */
  addr(): string | undefined
}

export function createP2p(options: P2pOptions): P2p {
  const { binary, port, keyName = 'default', onAddr, onState, logger } = options
  const say = logger ?? (() => {})
  let child: ChildProcess | undefined
  let current: string | undefined
  let attempts = 0
  /** 这一次子进程是什么时候拉起来的。用来看它「活了多久」，决定退避要不要归零。 */
  let spawnedAt = 0
  let timer: NodeJS.Timeout | undefined
  let stopping = false

  const schedule = (): void => {
    if (stopping || timer) return
    // 到顶后不增长，但仍然重试：一直退到「再也不连」等于放弃出门。
    const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0]!
    attempts += 1
    timer = setTimeout(() => {
      timer = undefined
      spawnOnce()
    }, wait)
    timer.unref?.()
  }

  const spawnOnce = (): void => {
    if (stopping || child) return
    let started: ChildProcess
    try {
      started = spawn(binary, ['serve', `--key=${keyName}`, String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // 地址由密钥决定，工作目录无所谓；但给一个稳定的 cwd，避免相对路径的 DERP map 缓存落到 random 位置。
        cwd: process.env.HOME,
      })
    } catch (error) {
      onState?.('error', `tailcat did not start: ${String(error)}`)
      schedule()
      return
    }
    child = started
    spawnedAt = Date.now()

    const seen = (text: string): void => {
      for (const line of text.split(/\r?\n/)) {
        const addr = parseAddr(line)
        if (addr && addr !== current) {
          current = addr
          // 注意这里**不**把 attempts 归零：喷出地址不等于起来了。一个「喷完地址立刻死」的
          // 二进制如果每次都归零，就会永远 1s 重拉一次 30MB 进程。归零放到「活够久」那边。
          onState?.('ready', `direct tunnel at ${addr.slice(0, 12)}…`)
          onAddr?.(addr)
        }
      }
    }
    started.stdout?.setEncoding('utf8')
    started.stderr?.setEncoding('utf8')
    started.stdout?.on('data', seen)
    // 地址其实打在 stderr 上（stdout 留给数据面），所以两路都扫 —— 换一个 tailcat 版本把
    // 那行挪回 stdout 时，这里不用跟着改。
    started.stderr?.on('data', (text: string) => {
      const before = current
      seen(text)
      // 没有地址时把进度话当线索说一次（选 DERP region 之类），有地址之后不再刷屏。
      if (!current && !before) say(`tailcat: ${text.trim().split(/\r?\n/)[0] ?? ''}`)
    })

    started.on('error', (error: Error) => {
      // 二进制不存在/不可执行都到这里：这条通道没有，但后端照常运行。
      onState?.('error', `tailcat could not run: ${error.message}`)
    })
    started.on('exit', (code, signal) => {
      child = undefined
      // 活过一分钟才算「起稳了」，下一个故障从头退避；否则继续往后压。判据跟着进程寿命走，
      // 不跟着「有没有喷出地址」走 —— 后者会让崩溃循环停在最小间隔上。
      if (Date.now() - spawnedAt > 60_000) attempts = 0
      // 进程没了，地址也就不再成立：留着旧地址会让手机连一个没人听的地方。
      if (current) {
        current = undefined
        onState?.('error', `tailcat exited (${signal ?? code ?? 'unknown'})`)
      }
      schedule()
    })
  }

  return {
    start() {
      stopping = false
      spawnOnce()
    },
    async stop() {
      stopping = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      const running = child
      child = undefined
      current = undefined
      if (!running) return
      running.kill('SIGTERM')
      // 给它一点时间体面退出；退出事件里已经不会再 schedule（stopping 为真）。
      await new Promise<void>(resolve => {
        const done = (): void => resolve()
        running.once('exit', done)
        setTimeout(done, 2_000).unref?.()
      })
    },
    addr: () => current,
  }
}

/**
 * 读 `<stateDir>/mobile-p2p-addr`：上一次成功拿到的地址。
 *
 * 存在的意义只有一个 —— 后端重启后、tailcat 还没喷出新地址的那几秒里，手机仍然拿得到
 * 一个「上次是对的」地址，而不是被降级到中转。地址由密钥决定，所以旧地址在新进程起来后
 * 依然有效；真正换过密钥时 tailcat 会喷新地址，广播随之更新。
 */
export function savedAddr(stateDir: string, read: (path: string) => string | undefined): string | undefined {
  const text = read(`${stateDir}/mobile-p2p-addr`)?.split(/\r?\n/)[0]?.trim()
  return text && parseAddr(`new address: ${text}`) ? text : undefined
}
