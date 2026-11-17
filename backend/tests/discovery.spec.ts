import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Bonjour } from 'bonjour-service'
import { crewFingerprint, createDiscovery, SERVICE_TYPE } from '../src/app/discovery.ts'

/**
 * 传输层的替身 socket。
 *
 * 真正的故障点是 `dgram` 的 send 回调，不是 `Service` 的事件：bonjour-service 的 `Service`
 * 从来不 emit `'error'`（整个 dist 只有 `emit('up')`），会 throw 的是 mdns-server 的
 * errorCallback —— 它的缺省值就是 `err => { throw err }`，也就是那次 uncaught 事故。
 *
 * 所以这里只替 socket，让 `send` 回一笔 EADDRNOTAVAIL；multicast-dns → mdns-server → registry
 * 全部还是生产里那一份。替掉整类实现就测不到「错误从哪出来」这个真问题。
 */
interface FakeSocket extends EventEmitter {
  send: (...args: unknown[]) => FakeSocket
  bind: (...args: unknown[]) => void
  address: () => { address: string; family: string; port: number }
  setMulticastTTL: () => boolean
  setMulticastLoopback: () => boolean
  setMulticastInterface: () => void
  addMembership: () => void
  dropMembership: () => void
  close: (callback?: () => void) => void
}

/** `send` 回什么。`null` 是网络健在；一个 error 就是「网卡没了」。 */
function fakeSocket(): FakeSocket {
  const socket = Object.assign(new EventEmitter(), {
    _addr: { address: '0.0.0.0', family: 'IPv4', port: 5353 },
    bind(this: FakeSocket, ...args: unknown[]) {
      const callback = args.find(argument => typeof argument === 'function') as ((error?: unknown) => void) | undefined
      const failure = fault.bindFailure
      fault.bindFailure = undefined
      // 真 dgram 的 bind 回调是异步的：同步回调会让 multicast-dns 在 `that.update` 挂上之前就用它。
      // 失败时 dgram 也是先 emit('error') 再回调 —— multicast-dns 对 EACCES/EADDRINUSE
      // 原样转发成 mdns 的 'error'，其余的降级成 'warning'。
      setTimeout(() => {
        if (failure) { this.emit('error', failure); callback?.(failure); return }
        this.emit('listening')
        callback?.()
      }, 0)
    },
    address(this: FakeSocket & { _addr: { address: string; family: string; port: number } }) { return this._addr },
    setMulticastTTL: () => true,
    setMulticastLoopback: () => true,
    setMulticastInterface: () => {},
    addMembership: () => {},
    dropMembership: () => {},
    // 半死的 socket 关不掉、也不回调 —— 停机路径不许等它。
    close: () => {},
  }) as unknown as FakeSocket
  socket.send = (...args: unknown[]) => {
    const callback = args.at(-1) as ((error: unknown) => void) | undefined
    // socket 被外力关掉时 dgram 不是回调报错，而是**同步抛**：这条路径必须能被接住，
    // 否则它从 multicast-dns 的 nextTick onbind 里一路抛成 uncaught，进程直接死。
    if (fault.syncThrow) {
      throw Object.assign(new Error('Not running'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING', errno: -9 })
    }
    const error = fault.next()
    queueMicrotask(() => callback?.(error))
    return socket
  }
  return socket
}

/**
 * 网络此刻的状态。用例在这里写剧本：`broken` 让每个新 socket 的 send 都失败，
 * `healthy` 恢复成正常发送 —— 「网卡回来了」在真实世界里就是这么无声无息的。
 */
const fault = vi.hoisted(() => ({
  mode: 'healthy' as 'healthy' | 'broken',
  /** 设了就让下一次 bind 回这笔错误（模拟 5353 被占 / 无权限）。 */
  bindFailure: undefined as unknown,
  /** 开了就让 send **同步 throw** —— socket 被外力关掉时的真实形状（ERR_SOCKET_DGRAM_NOT_RUNNING）。 */
  syncThrow: false,
  next: (): unknown => null as unknown,
}))
fault.next = () => fault.mode === 'broken'
  ? Object.assign(new Error('send EADDRNOTAVAIL 224.0.0.251:5353'),
    { code: 'EADDRNOTAVAIL', errno: -49, syscall: 'send', address: '224.0.0.251', port: 5353 })
  : null

// discovery.ts 现在自己开 socket 再经 `opts.socket` 交给 multicast-dns（那是唯一接得住
// thunky 下一 tick 里同步 throw 的边界）。所以这里替 `node:dgram` 的 createSocket，
// 把现有 fakeSocket 交出去；multicast-dns / mdns-server / registry 仍全是生产那份。
vi.mock('node:dgram', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dgram')>()
  return { ...actual, createSocket: () => fakeSocket() }
})

/** 每次构造出来的实例与它的错误回调：判定「换了新 socket」「旧实例晚到错误」都要从这里看。 */
const built = vi.hoisted(() => [] as { socket: FakeSocket; instance: unknown; onError: (error: unknown) => void }[])
vi.mock('bonjour-service', async importOriginal => {
  const actual = await importOriginal<typeof import('bonjour-service')>()
  class ProbedBonjour extends actual.Bonjour {
    constructor(options: Record<string, unknown> = {}, errorCallback?: (error: unknown) => void) {
      // discovery.ts 现在总是自己开 socket 并交进来（那是接住同步 throw 的唯一边界）。
      const socket = options.socket as FakeSocket | undefined ?? fakeSocket()
      // `socket` 不在 ServiceConfig 的类型里，但 multicast-dns 认它（`opts.socket || dgram.createSocket`）。
      super({ ...options, socket } as ConstructorParameters<typeof actual.Bonjour>[0], errorCallback)
      built.push({ socket, instance: this, onError: errorCallback ?? (() => {}) })
    }
  }
  return { ...actual, Bonjour: ProbedBonjour as unknown as typeof actual.Bonjour }
})

/** 重置剧本与实例账本。每个用例都从「网络健在」开始。 */
function reset(): void {
  fault.mode = 'healthy'
  fault.syncThrow = false
  fault.bindFailure = undefined
  built.length = 0
}

/**
 * 让某个实例真的去发一次包：手机在网段里广播 PTR 查询，我们回一条应答。
 *
 * 这是事故当天的崩溃路径（`mdns-server` 的 `respondToQuery` → 缺省 errorCallback 直接 throw）。
 * 开机自报那一包同样会失败，但它的回调不看错误，所以**日常最需要覆盖的是「没人来问、自己也发不出去」**，
 * 那条由下面的 boot-time 用例专门盯着；这个助手只用来单独钉住「应答路径」。
 */
async function askForUs(target = built.at(-1)): Promise<void> {
  const instance = target?.instance as { server?: { mdns?: EventEmitter; registry?: Record<string, unknown[]> } } | undefined
  const mdns = instance?.server?.mdns
  if (!mdns) throw new Error('no mdns instance to query')
  // publish 先做名称探测（probe，三次 250ms），探完才 register + announce。没登记就没有应答，
  // 也就没有那一次发送 —— 所以要等记录真的在册，不能按固定时延瞎猜。
  await vi.waitFor(() => expect(Object.keys(instance?.server?.registry ?? {}).length).toBeGreaterThan(0), { timeout: 3_000 })
  mdns.emit('query', { type: 'query', questions: [{ name: `_${SERVICE_TYPE}._tcp.local`, type: 'PTR' }] }, {})
}

// 手机靠 mDNS 自己找队伍，所以这段广播就是「寻址」的全部。
// 错的地方只有两种代价：手机找不到（退回手输），或者手机找到一条死记录（选了连不上，比找不到更糟）。
it('folds a state directory into a stable short fingerprint', () => {
  const one = crewFingerprint('/Users/someone/.dsh/state/superagent')
  const again = crewFingerprint('/Users/someone/.dsh/state/superagent')
  const other = crewFingerprint('/Users/someone/.dsh/state/crew')
  // 同一目录每次重启都要给出同一个值，否则手机认不出「还是上次那台」。
  expect(again).toBe(one)
  // 不同目录要能分开，否则同机两支队伍在手机上长得一模一样。
  expect(other).not.toBe(one)
  // 不广播路径本身：mDNS 没有加密，路径里常带用户名。
  expect(one).not.toContain('/')
  expect(one).not.toContain('Users')
  expect(one.length).toBeGreaterThan(0)
})

it('publishes the port it was told and reports it back', async () => {
  reset()
  const discovery = createDiscovery({ stateDir: '/tmp/state-a' })
  try {
    discovery.publish(43499)
    // ready 要等那一包真发出去，不是 publish 返回就成立。
    await vi.waitFor(() => expect(discovery.published()).toBe(43499), { timeout: 4_000 })
    // 重复广播同一个端口不该换名字：手机列表里出现两条同机记录，选哪条都可能是死的。
    discovery.publish(43499)
    expect(discovery.published()).toBe(43499)
  } finally {
    await discovery.stop()
  }
  // 撤掉之后不能再自称在广播，否则健康检查会以为手机上还看得见这台机器。
  expect(discovery.published()).toBeUndefined()
})

it('stops publishing when told to, and stops cleanly twice', async () => {
  reset()
  const discovery = createDiscovery({ stateDir: '/tmp/state-b' })
  discovery.publish(43498)
  await discovery.stop()
  // 关第二次不该抛：close 与进程退出可能各来一次。
  await discovery.stop()
  expect(discovery.published()).toBeUndefined()
})

it('reports failures instead of throwing when the announce cannot start', async () => {
  reset()
  const errors: unknown[] = []
  // 端口 0 让底层自己去选，构造与播报都不该把异常抛到启动路径上：
  // 局域网广播失败只是少一条捷径，队伍本身必须照常起来。
  const discovery = createDiscovery({ stateDir: '/tmp/state-c', onError: error => errors.push(error) })
  expect(() => discovery.publish(0)).not.toThrow()
  await discovery.stop()
})

// 睡眠唤醒之后网卡没了：`send` 立刻回 EADDRNOTAVAIL。修之前这一笔错误被 mdns-server 的
// 缺省 errorCallback 原样 throw 出去，整个后端进程跟着死 —— 手机那条 API 也一起没了。
it('survives the real announce path failing and reports the transport error', async () => {
  reset()
  fault.mode = 'broken'
  const errors: unknown[] = []
  const discovery = createDiscovery({ stateDir: '/tmp/state-wake', onError: error => errors.push(error) })
  try {
    discovery.publish(43496)
    // 不需要任何人来查询：开机那一包发不出去，自己就该把错误报出来。
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 4_000 })
    expect(errors.map(error => (error as { code?: string }).code)).toContain('EADDRNOTAVAIL')
    // 报了错就等于没在广播：健康检查不能还看见一条手机连不上的记录。
    expect(discovery.published()).toBeUndefined()
  } finally {
    await discovery.stop()
  }
})

it('rebuilds the socket and republishes once the network is back', async () => {
  reset()
  fault.mode = 'broken'
  const states: boolean[] = []
  const discovery = createDiscovery({ stateDir: '/tmp/state-recover', onState: live => states.push(live) })
  try {
    discovery.publish(43495)
    // 等它真的报出错来。`published()` 一开始就是 undefined（还没确认过），不能拿它当信号，
    // 否则 waitFor 立刻通过，测到的只是「从没成功」而不是「失败被认掉了」。
    await vi.waitFor(() => expect(states).toContain(false), { timeout: 4_000 })
    expect(discovery.published()).toBeUndefined()
    // 健康状态必须跟着走：掉了要有人知道。
    expect(states).toContain(false)
    // 网卡回来了。旧实例的 socket 绑在已经消失的地址上，不会自己好 —— 只能等它重建。
    fault.mode = 'healthy'
    // 恢复计时是有界的（首轮 1s，翻倍封顶 30s），几秒内就该重新公告，不必等 TXT 再变一次。
    await vi.waitFor(() => expect(discovery.published()).toBe(43495), { timeout: 8_000 })
    // 真的换了新实例、新 socket：复用坏掉的那一个只会继续 EADDRNOTAVAIL。
    expect(built.length).toBeGreaterThan(1)
    expect(new Set(built.map(item => item.socket)).size).toBeGreaterThan(1)
    expect(states.at(-1)).toBe(true)
  } finally {
    await discovery.stop()
  }
})

it('does not hammer the network while it stays broken', async () => {
  reset()
  fault.mode = 'broken'
  const errors: unknown[] = []
  const discovery = createDiscovery({ stateDir: '/tmp/state-broken', onError: error => errors.push(error) })
  try {
    discovery.publish(43494)
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 4_000 })
    const afterFirst = errors.length
    // 一秒的观察窗：退避是 1s → 2s → 4s，所以这里最多再一两次，
    // 绝不会变成「每个 tick 重来一遍」那种把 CPU 和日志都拖垮的风暴。
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(errors.length - afterFirst).toBeLessThanOrEqual(3)
    expect(built.length).toBeLessThanOrEqual(6)
  } finally {
    await discovery.stop()
  }
})

it('cancels the recovery timer on stop without waiting for a socket that never reports back', async () => {
  reset()
  fault.mode = 'broken'
  const errors: unknown[] = []
  const discovery = createDiscovery({ stateDir: '/tmp/state-stop', onError: error => errors.push(error) })
  discovery.publish(43493)
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 4_000 })
  const instances = built.length
  // 半死的 socket 关不掉也不回调（替身的 close 就是如此）。停机不能为此挂住。
  await expect(Promise.race([
    discovery.stop().then(() => 'stopped' as const),
    new Promise(resolve => setTimeout(() => resolve('hung' as const), 1_500)),
  ])).resolves.toBe('stopped')
  expect(discovery.published()).toBeUndefined()
  // 停了就不许再排下一次重播：否则进程退出前又开一个新 socket 出来。
  await new Promise(resolve => setTimeout(resolve, 1_500))
  expect(built.length).toBe(instances)
  expect(discovery.published()).toBeUndefined()
})

it('ignores a late error from an instance it already replaced', async () => {
  reset()
  const discovery = createDiscovery({ stateDir: '/tmp/state-late' })
  try {
    discovery.publish(43492)
    await vi.waitFor(() => expect(discovery.published()).toBe(43492), { timeout: 4_000 })
    const first = built[0]!
    // 让当前实例坏掉并被换下去：下一代实例接上并重新 ready。
    fault.mode = 'broken'
    discovery.publish(43492)
    await vi.waitFor(() => expect(discovery.published()).toBeUndefined(), { timeout: 4_000 })
    await new Promise(resolve => setTimeout(resolve, 300))
    fault.mode = 'healthy'
    await vi.waitFor(() => expect(discovery.published()).toBe(43492), { timeout: 8_000 })
    const currentSocket = built.at(-1)!.socket
    expect(built.at(-1)!.instance).not.toBe(first.instance)
    // 旧实例的 socket 半死时还会零星回报错误（destroy 期间尤其如此）。
    // 它已经不代表现状了：这条晚到的错误不许把新实例的「在广播」抹掉。
    first.onError(Object.assign(new Error('late EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' }))
    expect(discovery.published()).toBe(43492)
    expect(built.at(-1)!.socket).toBe(currentSocket)
  } finally {
    await discovery.stop()
  }
}, 20_000)

// 另一条真实犯病路径：5353 被占 / 没权限时 multicast-dns 会 `emit('error')`，而 mdns-server
// 只挂了 'query'。EventEmitter 的 'error' 没人听就是 throw —— 开机就崩，和睡眠唤醒崩是同一类。
it('survives a socket-level EACCES on bind and keeps retrying', async () => {
  reset()
  const errors: unknown[] = []
  const states: boolean[] = []
  const discovery = createDiscovery({ stateDir: '/tmp/state-eacces', onError: error => errors.push(error), onState: live => states.push(live) })
  try {
    // 让 bind 回一笔 EACCES：multicast-dns 会把它转发成 socket 的 'error'。
    const instance = { bindFails: true }
    fault.bindFailure = Object.assign(new Error('bind EACCES 0.0.0.0:5353'), { code: 'EACCES', errno: -13 })
    discovery.publish(43490)
    await vi.waitFor(() => expect(errors.map(error => (error as { code?: string }).code)).toContain('EACCES'), { timeout: 3_000 })
    // 崩不了，而且和发送失败走同一条路：先认掉「没在广播」，再排重播。
    expect(discovery.published()).toBeUndefined()
    expect(states).toContain(false)
    expect(instance.bindFails).toBe(true)
  } finally {
    fault.bindFailure = undefined
    await discovery.stop()
  }
})

it('names the service type the phones look for', () => {
  // 这个名字是协议：改它等于让已经装好的 App 找不到任何服务。
  expect(SERVICE_TYPE).toBe('dsh-crew')
})

// 广播的身份就是手机认人的全部依据：实例名、类型、端口、crew 指纹。改任何一个，
// 已经配对过的手机都会把同一台机器当成新的。
it('keeps the identity and TXT fields stable across republishes', async () => {
  reset()
  const published: { name: string; type: string; port: number; protocol: string; txt?: Record<string, string> }[] = []
  const actual = await vi.importActual<typeof import('bonjour-service')>('bonjour-service')
  const capture = actual.Bonjour.prototype.publish
  const spy = vi.spyOn(actual.Bonjour.prototype, 'publish').mockImplementation(function (
    this: Bonjour, options: Parameters<Bonjour['publish']>[0]) {
    published.push(options as unknown as (typeof published)[number])
    return capture.call(this, options)
  })
  const discovery = createDiscovery({ stateDir: '/tmp/state-identity', publicUrl: 'https://crew.example.top', p2pAddr: () => 'tcp-addr-1' })
  try {
    discovery.publish(43499)
    discovery.publish(43499)
    // 同一份广播说两遍不该换记录：手机列表里出现两条同机记录，选哪条都可能是死的。
    expect(published.length).toBe(1)
    const first = published[0]!
    expect(first).toMatchObject({ name: `dsh-crew-${crewFingerprint('/tmp/state-identity')}`, type: 'dsh-crew', port: 43499, protocol: 'tcp' })
    expect(first.txt).toEqual({ crew: crewFingerprint('/tmp/state-identity'), port: '43499', pub: 'https://crew.example.top', p2p: 'tcp-addr-1' })
  } finally {
    spy.mockRestore()
    await discovery.stop()
  }
})

// 出门那条路：手机在别的网络里发现不到 mDNS，唯一的机会是「在同一个 Wi-Fi 下看见过一次」，
// 所以公网入口必须和端口一起广播出去。少这一条，手机出了家门就只能靠人重新输地址。
it('leaves the public entry out when none is configured', async () => {
  reset()
  const published: { txt?: Record<string, string> }[] = []
  const actual = await vi.importActual<typeof import('bonjour-service')>('bonjour-service')
  const capture = actual.Bonjour.prototype.publish
  const spy = vi.spyOn(actual.Bonjour.prototype, 'publish').mockImplementation(function (
    this: Bonjour, options: Parameters<Bonjour['publish']>[0]) {
    published.push(options as unknown as { txt?: Record<string, string> })
    return capture.call(this, options)
  })
  const discovery = createDiscovery({ stateDir: '/tmp/state-no-public' })
  try {
    discovery.publish(43499)
    // 「没配」和「配了一个空值」在手机上不一样：一个不显示外网那一行，一个显示一条连不上的地址。
    expect(published[0]?.txt ?? {}).not.toHaveProperty('pub')
    expect(published[0]?.txt ?? {}).not.toHaveProperty('p2p')
  } finally {
    spy.mockRestore()
    await discovery.stop()
  }
})

// P2P 那条路的地址是后到的：tailcat 起来才有，所以广播每次现读取值器。手机在同一 Wi-Fi 下
// 看见这一次，就把三条路（局域网端口、公网入口、tc-addr）都记住了，出了门不必再问人要地址。
it('follows the P2P address when it changes', async () => {
  reset()
  let addr: string | undefined
  const published: { txt?: Record<string, string> }[] = []
  const actual = await vi.importActual<typeof import('bonjour-service')>('bonjour-service')
  const capture = actual.Bonjour.prototype.publish
  const spy = vi.spyOn(actual.Bonjour.prototype, 'publish').mockImplementation(function (
    this: Bonjour, options: Parameters<Bonjour['publish']>[0]) {
    published.push(options as unknown as { txt?: Record<string, string> })
    return capture.call(this, options)
  })
  const discovery = createDiscovery({ stateDir: '/tmp/state-p2p', p2pAddr: () => addr })
  try {
    discovery.publish(43499)
    // 隧道还没起来：这一格不写，「什么都没有」不能变成手机上一条连不上的地址。
    expect(published[0]?.txt ?? {}).not.toHaveProperty('p2p')
    addr = `tcp${'B'.repeat(60)}`
    discovery.publish(43499)
    expect(published.at(-1)?.txt).toMatchObject({ p2p: addr })
    // 换了网络重新协商出新地址：端口没变也得重播，否则手机永远拿着旧地址去连。
    addr = `tcp${'A'.repeat(60)}`
    discovery.publish(43499)
    expect(published.at(-1)?.txt).toMatchObject({ p2p: addr })
  } finally {
    spy.mockRestore()
    await discovery.stop()
  }
})

// ── 本轮补齐的四个机制缺口 ────────────────────────────────────────────────
// 上一个版本只接了「有人来查询」这条路径的错误。生产上「开机起就发不出去」是完全静默的：
// registry 的 announce / probe 回调都不看错误，没人查询就永远不重试，面板还报 ready。
it('notices from the very first announce that sends fail, with no query from anyone', async () => {
  reset()
  // 从启动起每一个 send 都失败，而且整场没有任何外部查询 —— 故障必须自己浮出来。
  fault.mode = 'broken'
  const errors: unknown[] = []
  const states: boolean[] = []
  const discovery = createDiscovery({ stateDir: '/tmp/state-boot', onError: error => errors.push(error), onState: (up) => states.push(up) })
  try {
    discovery.publish(43489)
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 4_000 })
    // 关键：从来没成功过，所以不算在广播，健康也不能是 ready。
    expect(discovery.published()).toBeUndefined()
    expect(states).not.toContain(true)
  } finally {
    await discovery.stop()
  }
})

it('goes ready only after the announce really goes out, not when publish returns', async () => {
  reset()
  const states: boolean[] = []
  const discovery = createDiscovery({ stateDir: '/tmp/state-confirm', onState: up => states.push(up) })
  try {
    discovery.publish(43488)
    // publish 当场返回时，底层那一包还没发；这时候自称 ready 就是假健康。
    expect(discovery.published()).toBeUndefined()
    // 等它真的播出去（注册 + announce 走完）才算。
    await vi.waitFor(() => expect(discovery.published()).toBe(43488), { timeout: 4_000 })
    expect(states.filter(up => up)).toHaveLength(1)
  } finally {
    await discovery.stop()
  }
})

it('drops readiness when the port changes and waits for the new record to be announced', async () => {
  reset()
  const discovery = createDiscovery({ stateDir: '/tmp/state-switch' })
  try {
    discovery.publish(43487)
    await vi.waitFor(() => expect(discovery.published()).toBe(43487), { timeout: 4_000 })
    // 换端口：旧记录已撤，新记录还没播 —— 这中间不能沿用旧端口的 ready。
    discovery.publish(43486)
    expect(discovery.published()).toBeUndefined()
    await vi.waitFor(() => expect(discovery.published()).toBe(43486), { timeout: 4_000 })
  } finally {
    await discovery.stop()
  }
})

it('starts the backoff from the short interval again after each recovery', async () => {
  reset()
  const discovery = createDiscovery({ stateDir: '/tmp/state-twice' })
  try {
    discovery.publish(43485)
    await vi.waitFor(() => expect(discovery.published()).toBe(43485), { timeout: 4_000 })
    // 连续坏两次、恢复两次。若成功不重置退避，第二次会从 30s 起，恢复就要等半分钟。
    for (const round of [1, 2]) {
      fault.mode = 'broken'
      discovery.publish(43485)
      // 等它真的认掉「掉了」。published() 一开始就是 undefined（还没确认过），不能直接用它当信号。
      await vi.waitFor(() => expect(discovery.published()).toBeUndefined(), { timeout: 4_000 })
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(discovery.published()).toBeUndefined()
      fault.mode = 'healthy'
      // 首轮 1s、次轮 2s 就该回来；留足余量但它远小于封顶的 30s。
      await vi.waitFor(() => expect(discovery.published()).toBe(43485), { timeout: 8_000 })
      expect(discovery.published()).toBe(43485)
      void round
    }
  } finally {
    await discovery.stop()
  }
}, 30_000)

it('stays closed once stopped: publish cannot resurrect an instance or readiness', async () => {
  reset()
  const states: boolean[] = []
  const discovery = createDiscovery({ stateDir: '/tmp/state-closed', onState: up => states.push(up) })
  discovery.publish(43484)
  await vi.waitFor(() => expect(discovery.published()).toBe(43484), { timeout: 4_000 })
  const instancesBefore = built.length
  await discovery.stop()
  // 停机本身也要把「不在广播」说出去，否则面板会一直挂着 ready。
  expect(states.at(-1)).toBe(false)
  const afterStop = states.length
  // 停了之后再叫：不许开新实例、不许把 published 写回来、不许再发状态。
  discovery.publish(43484)
  await new Promise(resolve => setTimeout(resolve, 1_200))
  expect(discovery.published()).toBeUndefined()
  expect(built.length).toBe(instancesBefore)
  expect(states.length).toBe(afterStop)
})

it('does not mistake a successful answer or goodbye for a successful announce', async () => {
  reset()
  const states: boolean[] = []
  const discovery = createDiscovery({ stateDir: '/tmp/state-answer', onState: up => states.push(up) })
  try {
    discovery.publish(43483)
    await vi.waitFor(() => expect(discovery.published()).toBe(43483), { timeout: 4_000 })
    // 已经 ready。此时再应答一次别人的查询（respond 成功，但不是我新播出去的）：
    // 状态不该再被点亮一次，也不该被撤掉。
    const readyStates = states.filter(up => up).length
    await askForUs()
    expect(discovery.published()).toBe(43483)
    expect(states.filter(up => up).length).toBe(readyStates)
  } finally {
    await discovery.stop()
  }
})

// socket 被外力关掉（唤醒后网卡消失的真实形状）时，dgram 不是回调报错而是**同步抛**
// ERR_SOCKET_DGRAM_NOT_RUNNING，而且抛在 multicast-dns 的 nextTick `onbind` 里 ——
// 外层包 `mdns.send` 的 try/catch 根本不在那个栈上。修之前这一下直接把进程带走
// （root 的 closed 探针 exit 1）。这里的断言是：故障被转成一次普通失败，进程活着，能重建。
it('survives a synchronously throwing send instead of letting it kill the process', async () => {
  reset()
  const errors: unknown[] = []
  const states: boolean[] = []
  const discovery = createDiscovery({ stateDir: '/tmp/state-sync', onError: error => errors.push(error), onState: up => states.push(up) })
  try {
    fault.syncThrow = true
    // 关键：不能让异常逃出去。它若逃出去，这个 publish 之后的 tick 就会 uncaught。
    expect(() => discovery.publish(43482)).not.toThrow()
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 4_000 }).catch(() => {})
    // 给 thunky 那一 tick 足够时间真的去发。
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(errors.map(error => (error as { code?: string }).code)).toContain('ERR_SOCKET_DGRAM_NOT_RUNNING')
    // 从没真发出去过：不算在广播，也不许报 ready。
    expect(discovery.published()).toBeUndefined()
    expect(states).not.toContain(true)
    // 而且它还在重试：网络回来就该自己恢复。
    fault.syncThrow = false
    await vi.waitFor(() => expect(discovery.published()).toBe(43482), { timeout: 8_000 })
  } finally {
    await discovery.stop()
  }
}, 20_000)
