/**
 * 在局域网上自报家门，让手机不必手输地址。
 *
 * 手机与电脑换一次 Wi-Fi，地址就变一次；手输地址、重编 APK、重新配对，每一步都要人跟着走。
 * 这里把「这台机器上有个队伍」广播出去，手机用系统的 NSD 找到它，选一台连上就完事。
 *
 * 广播的内容刻意只有三样：服务实例名（认人的）、端口（连的）、一份 stateDir 指纹（同机多队伍时区分）。
 * 不放 token、不放设备凭据、不放任何能直接换到访问权的东西 —— mDNS 是不加密的组播，
 * 同一网段里谁都能收到。找到不等于能进，进去仍然要过配对。
 */
import { createSocket, type Socket } from 'node:dgram'
import { Bonjour, type Service } from 'bonjour-service'

/** 手机要发现的类型。改名等于让已经装好的 App 找不到服务，所以这是个协议常量。 */
export const SERVICE_TYPE = 'dsh-crew'

/** 广播里带的信息，与手机端 `CrewDiscovery` 解析的字段一一对应。 */
export interface CrewBeacon {
  /** 服务实例名：同一网段里可能有多台队伍，手机按它区分并让用户选。 */
  name: string
  port: number
  /** stateDir 的短指纹。同一个目录重启后不变，用来认「还是上次那台」。 */
  crew: string
}

/**
 * 把 stateDir 折成一段短指纹。
 *
 * 不直接广播路径：路径里常带用户名，mDNS 又没有加密，那等于把本机的目录结构顺带告诉整个网段。
 * 指纹只用来区分，不需要可逆。
 */
export function crewFingerprint(stateDir: string): string {
  let hash = 0
  for (const character of stateDir) hash = (hash * 31 + character.charCodeAt(0)) % 0xffff_ffff
  return hash.toString(36).padStart(7, '0')
}

export interface DiscoveryOptions {
  stateDir: string
  /** 服务实例名；缺省用主机名 + 指纹，同机多队伍也能一眼分开。 */
  name?: string
  /**
   * 出了门那条路的入口（例：`https://crew.example.top`），配了才写进 TXT。
   *
   * mDNS 只走同一网段，所以手机在别的网络里**发现不到**这条记录；但它在同一 Wi-Fi 下看见过一次，
   * 就可以把这一行记下来，之后换到任何网络都照着连。这是「不装任何客户端也能出门」的全部机关：
   * 发现一次，永久可用。没配就只广播局域网，和原来一字不差。
   */
  publicUrl?: string
  /**
   * 手机那条 P2P 路的地址（tailcat 的 tc-addr）。它是**后到的** —— 隧道进程起来才有，
   * 所以给取值器而不是值：每次广播现读，地址换了就跟着换。
   *
   * 和 `pub` 一起给，手机发现一次就把三条路都记住了：P2P 地址、公网入口、局域网地址。
   */
  p2pAddr?: () => string | undefined
  /** 广播失败时的去处。默认吞掉：mDNS 不可用（容器、无组播、端口被占）不该拖垮后端。 */
  onError?: (error: unknown) => void
  /**
   * 此刻到底有没有在广播。健康面板据此显示，不必去轮询。
   *
   * 只在**真的发出去**之后才报 true：publish 返回不代表广播成功，底层那条 send 是异步的。
   * 换端口、失效、重建、停止都会来一次。
   */
  onState?: (live: boolean, port: number | undefined) => void
}

export interface Discovery {
  /** 开始为 `port` 广播；重复调用同一端口是幂等的。`stop()` 之后再调无效。 */
  publish(port: number): void
  /** 停止广播。关得比发得快时不会留下一个还在应答的旧记录。 */
  stop(): Promise<void>
  /** 当前**已确认**在应答的端口；没有广播时为 undefined。测试与健康检查用。 */
  published(): number | undefined
}

/** 一个 Bonjour 实例连同它的一生。`dead` 之后它的任何回调都不许再动状态。 */
interface Session {
  instance: Bonjour
  /** 我们自己开的 socket：只有握着它，才接得住那条同步 throw（见 `ownSocket`）。 */
  socket: Socket
  dead: boolean
}

/**
 * 重播的封顶间隔。
 *
 * 网络什么时候回来没人通知我们（宿主睡眠醒来、拔插网线都不发事件），只能自己再试。
 * 封顶半分钟：恢复之后手机最多等这么久就能重新发现；不封顶则退避会一路涨到小时级。
 */
const RETRY_MAX_MS = 30_000

export function createDiscovery(options: DiscoveryOptions): Discovery {
  const { stateDir, onError, publicUrl, onState } = options
  const crew = crewFingerprint(stateDir)
  const name = options.name ?? `dsh-crew-${crew}`
  let session: Session | undefined
  let service: Service | undefined
  /** 已确认在应答的端口；发送真成功之后才写（`published()` 读它）。 */
  let live: number | undefined
  /** 想要的端口。传输层坏掉之后这一份意图还在，恢复时照它重播。 */
  let wanted: number | undefined
  /** 上一次广播时写进去的那条公网入口。它变了也得重播，否则手机永远拿着旧的地址出门。 */
  let currentPublic: string | undefined
  /** 上一次广播时写进去的 tc-addr，同样为了「变了就重播」。 */
  let currentP2p: string | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  /** 下一次重播等多久；确认成功就归零，好让再坏一次时又从短间隔起。 */
  let wait = 0
  let stopped = false

  /** 拆掉一个实例。不等待回调：socket 半死时 `close` 可能永远不回，停机路径不能被它挂住。 */
  function discard(target: Session | undefined): void {
    if (!target || target.dead) return
    target.dead = true
    // 只用 destroy：`service.stop()` 要回一条 TTL=0 的包，而包里正是此刻发不出去的那条。
    // destroy 会顺带关掉我们交给它的那个 socket。
    try { target.instance.destroy(() => {}) } catch (error) { onError?.(error) }
  }

  /** 排一次有界重播。退避翻倍封顶，且不保活进程：坏掉的网卡不该拖着后端不退出。 */
  function schedule(): void {
    if (stopped || retry || wanted === undefined) return
    wait = Math.min(wait ? wait * 2 : 1_000, RETRY_MAX_MS)
    const timer = setTimeout(() => {
      retry = undefined
      if (stopped || wanted === undefined) return
      // 退避不在这里归零：publish 返回只说明记录登记上了，发送成没成要等 'up'。
      announce(wanted)
    }, wait)
    retry = timer
    timer.unref?.()
  }

  /**
   * 真播出去了：这才是「在广播」。健康面板与 published() 都只认这一个信号。
   *
   * 用库自己的 `Service` `'up'`——它在公告那一包发成功之后才发（registry.js:101-106）。
   * 不看「哪个 respond 成功了」：撤旧记录的 TTL=0 包、应答别人查询的包也会成功，那都不代表
   * 「我这条新记录播出去了」。
   *
   * 三道守卫缺一不可：报上来的必须是**当前实例**的**当前记录**，且还没停 —— 旧实例（已换下去、
   * 或已被 fail 作废）就算库硬发一个 'up'，也只能被忽略。
   */
  function confirm(owner: Session, up: Service): void {
    if (stopped || owner !== session || up !== service) return
    const port = wanted
    if (port === undefined) return
    live = port
    // 成功了就从短间隔重新起算：下一次真坏掉时该等 1s，不是上一轮退避到的半分钟。
    wait = 0
    if (retry) { clearTimeout(retry); retry = undefined }
    onState?.(true, port)
  }

  /**
   * 传输层坏了的统一去处。睡眠唤醒后网卡消失，`send` 立刻回 EADDRNOTAVAIL；socket 被外力关掉
   * 会**同步**抛 ERR_SOCKET_DGRAM_NOT_RUNNING；5353 被占则是 bind 期 EACCES。
   * 这几种之后这个实例**不会自己好** —— 它的 socket 还绑在已经不存在的地址上 —— 只能拆掉重开。
   *
   * `from` 是报错的那一份。已经废掉的实例（包括被我们换下去的旧实例）迟到的错误一律不再动状态，
   * 否则一笔晚到的 EADDRNOTAVAIL 就能把新实例的「在广播」抹掉。
   */
  function fail(error: unknown, from?: Session): void {
    if (from?.dead) return
    onError?.(error)
    if (from && from !== session) { from.dead = true; return }
    live = undefined
    service = undefined
    const broken = session
    session = undefined
    discard(broken)
    onState?.(false, wanted)
    schedule()
  }

  /**
   * 自己开 socket，并经 `opts.socket` 交给 multicast-dns。
   *
   * 为什么非要自己握着它：真正那条同步 throw 长在 `multicast-dns` 的 `onbind` 里，而 `onbind` 是
   * thunky 在**之后的 tick** 才调的。外面再包一层 `mdns.send` 的 try/catch 根本不在那个栈上，
   * 接不到 —— 事情会一路抛出 nextTick，变成 uncaught，进程直接死。只有把 `socket.send` 本身换掉，
   * 才能在那个 tick 里就地把它转成一次普通失败。
   *
   * 回调里的异步错误也在这里接：上游 `registry.announce` / `registry.probe` 的回调**不判错误**
   * （`function () {}` 那种），所以「开机起就发不出去」在高层完全静默 —— 没人来查询就永远假健康、
   * 永不重试。我们在这层把结果转出来，同时**原样调上游 cb**，它们的合同不变。
   *
   * 唯一例外是同步 throw：这时上游 cb 还没被调用，我们补调一次带错的 cb，让库自己按错误收尾，
   * 但**绝不把异常再抛出去** —— 一次网络故障只能导致重建，不能导致进程退出。
   */
  function ownSocket(owner: () => Session | undefined): Socket {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    const raw = socket.send.bind(socket)
    socket.send = ((...args: unknown[]) => {
      const index = args.findLastIndex(argument => typeof argument === 'function')
      const upstream = index >= 0 ? args[index] as ((...inner: unknown[]) => void) : undefined
      if (upstream) {
        args[index] = (error?: unknown, ...rest: unknown[]) => {
          // 先让实例作废，再把错误交给上游：上游不看错误、照样 emit('up')，顺序反了就会
          // 先点亮健康再被作废，面板闪一下 ready。
          if (error) { const from = owner(); if (from) fail(error, from) }
          upstream(error, ...rest)
        }
      }
      try {
        return (raw as (...inner: unknown[]) => Socket)(...args)
      } catch (error) {
        const from = owner()
        if (from) fail(error, from)
        // 补一次带错的回调：multicast-dns 以为这一包发出去了，才不会继续挂在自己的状态机上，
        // 而它的回调链（registry / probe）照常收到错误。补完就返回，不 rethrow。
        upstream?.(error)
        return socket
      }
    }) as Socket['send']
    return socket
  }

  function announce(port: number): void {
    const p2p = options.p2pAddr?.()
    // 同一份意图重说一遍不该换记录：手机列表里出现两条同机记录，选哪条都可能是死的。
    if (service && wanted === port && currentPublic === publicUrl && currentP2p === p2p) return
    wanted = port
    currentPublic = publicUrl
    currentP2p = p2p
    // 换端口或换 TXT 就先撤掉旧的记录：同一个名字广播两次会让手机看到两条。
    // 这段空窗里手机什么都找不到，所以健康必须跟着说「不在了」，不能留着上一次的 ready。
    if (service) {
      const previous = service
      service = undefined
      live = undefined
      onState?.(false, port)
      try { previous.stop(() => {}) } catch (error) { onError?.(error) }
    }
    try {
      if (!session) {
        // owner 用取值函数：socket 的回调晚于这次构造，直接捕获当下变量会认错实例。
        const created: Session = { instance: undefined as unknown as Bonjour, socket: undefined as unknown as Socket, dead: false }
        created.socket = ownSocket(() => created)
        try {
          // `socket` 不在 ServiceConfig 的类型里，但 multicast-dns 认它
          // （`opts.socket || dgram.createSocket(...)`）—— 这是公开支持的注入点。
          const opts = { socket: created.socket } as ConstructorParameters<typeof Bonjour>[0]
          created.instance = new Bonjour(opts, (error: unknown) => fail(error, created))
        } catch (error) {
          // Bonjour 没接住这份 socket：自己关掉，别漏一个 fd。
          try { created.socket.close() } catch { /* 关不掉也只能算了 */ }
          throw error
        }
        const sends = created.instance as unknown as { server: { mdns: { on(event: 'error', handler: (error: unknown) => void): void } } }
        // socket 级 EACCES/EADDRINUSE 不经过 errorCallback，而是 mdns 的 'error' 事件；
        // `Service` 也从不 emit 'error'（整个库只有 emit('up')）。不接这个，崩溃照旧。
        sends.server.mdns.on('error', (error: unknown) => fail(error, created))
        session = created
      }
      service = session.instance.publish({
        name, type: SERVICE_TYPE, port, protocol: 'tcp',
        // pub 是「出了门往哪走」。它和 port 一起给，所以手机发现一次就把两条路都记住了。
        txt: { crew, port: String(port), ...(publicUrl ? { pub: publicUrl } : {}), ...(p2p ? { p2p } : {}) },
      })
      // 捕获**这一次**公告的 Session：`session` 是活的变量，晚一点读到它的可能是下一代实例。
      const owner = session
      const announced = service
      announced.once('up', () => confirm(owner, announced))
    } catch (error) {
      // 构造或播报当场失败，同样等于没在广播。睡眠唤醒后最常见的失败就在这里，照排重播。
      fail(error)
    }
  }

  return {
    publish(port) {
      // 关掉之后再叫就是叫一个已经不存在的东西：不许复活实例、不许把 published 写回去。
      if (stopped) return
      announce(port)
    },
    async stop() {
      stopped = true
      wanted = undefined
      if (retry) { clearTimeout(retry); retry = undefined }
      // 先把「在广播」的自述清掉再关 socket：关的过程里底层还会报错，那不该让 published() 回魂。
      live = undefined
      currentPublic = undefined
      currentP2p = undefined
      const published = service
      service = undefined
      if (published) {
        // 撤公告要回一条 TTL=0 的包，而 socket 半死时它的回调可能永远不来。
        // 停机不能为此挂住，所以只等一小会儿，剩下交给后面的 destroy。
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 250)
          timer.unref?.()
          const settle = (): void => { clearTimeout(timer); resolve() }
          try { published.stop(settle) } catch { settle() }
        })
      }
      const own = session
      session = undefined
      discard(own)
      onState?.(false, undefined)
    },
    published: () => live,
  }
}
