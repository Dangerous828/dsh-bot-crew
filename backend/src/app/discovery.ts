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
}

export interface Discovery {
  /** 开始为 `port` 广播；重复调用同一端口是幂等的。 */
  publish(port: number): void
  /** 停止广播。关得比发得快时不会留下一个还在应答的旧记录。 */
  stop(): Promise<void>
  /** 当前广播的端口；没有广播时为 undefined。测试与健康检查用。 */
  published(): number | undefined
}

export function createDiscovery(options: DiscoveryOptions): Discovery {
  const { stateDir, onError, publicUrl } = options
  const crew = crewFingerprint(stateDir)
  const name = options.name ?? `dsh-crew-${crew}`
  let bonjour: Bonjour | undefined
  let service: Service | undefined
  let current: number | undefined
  /** 上一次广播时写进去的那条公网入口。它变了也得重播，否则手机永远拿着旧的地址出门。 */
  let currentPublic: string | undefined
  /** 上一次广播时写进去的 tc-addr，同样为了「变了就重播」。 */
  let currentP2p: string | undefined

  /**
   * 广播出错时的统一去处。底层异步报错（组播被系统收走、socket 关了）之后，这条记录已经不会再应答：
   * current 不跟着清掉，published() 就还自称在广播，健康检查会以为手机上看得见这台机器。
   * `from` 是出错的那条记录：换端口时停掉的旧记录也可能晚到一笔错误，那不该抹掉正在播的新记录。
   */
  const fail = (error: unknown, from?: Service): void => {
    if (!from || from === service) current = undefined
    onError?.(error)
  }

  return {
    publish(port) {
      const p2p = options.p2pAddr?.()
      if (current === port && currentPublic === publicUrl && currentP2p === p2p) return
      // 换端口就先撤掉旧的：同一个名字广播两次会让手机看到两条记录，选哪条都可能是死的。
      if (service) {
        const previous = service
        service = undefined
        try { previous.stop(() => {}) } catch { /* 停不掉也不影响新记录 */ }
      }
      current = port
      currentPublic = publicUrl
      currentP2p = p2p
      try {
        bonjour ??= new Bonjour()
        service = bonjour.publish({
          name, type: SERVICE_TYPE, port, protocol: 'tcp',
          // pub 是「出了门往哪走」。它和 port 一起给，所以手机发现一次就把两条路都记住了。
          txt: { crew, port: String(port), ...(publicUrl ? { pub: publicUrl } : {}), ...(p2p ? { p2p } : {}) },
        })
        const announced = service
        announced.on('error', error => fail(error, announced))
      } catch (error) {
        // fail 里已经把 current 清掉了：构造或播报当场失败，同样等于没在广播。
        fail(error)
      }
    },
    async stop() {
      current = undefined
      currentPublic = undefined
      currentP2p = undefined
      const published = service
      service = undefined
      if (published) {
        await new Promise<void>(resolve => {
          try { published.stop(() => resolve()) } catch { resolve() }
        })
      }
      const own = bonjour
      bonjour = undefined
      if (own) {
        try { own.destroy() } catch (error) { fail(error) }
      }
    },
    published: () => current,
  }
}
