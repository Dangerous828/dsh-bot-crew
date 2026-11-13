/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { phoneHandler, registerMobileHttp } from './app/mobile-http.ts'
import { deviceStoreOf } from './app/remote.ts'
import { bindCandidates, createLanServer, lanPort } from './app/lan-server.ts'
import { createDiscovery } from './app/discovery.ts'
import { publicEntry } from './app/public-entry.ts'
import { createP2p } from './app/p2p.ts'
import { createTunnel } from './app/tunnel.ts'
import { phoneGate } from './app/phone-gate.ts'
import { createPairingThrottle } from './app/pairing-throttle.ts'
import { createChain, parseRelayCandidates, type RelayTarget } from './app/relay-chain.ts'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  // 手机提交配对码走消息面，所以设备表要挂到 runtime 上，两条路读同一份。
  // 策略读不到就用默认值：一份设置不该挡住整个插件启动。
  const pairing = (() => {
    try { return (runtime.store.settings() as { remote?: { pairing?: 'code' | 'deny' } }).remote?.pairing ?? 'code' }
    catch { return 'code' as const }
  })()
  const devices = deviceStoreOf(machine.stateDir, pairing)
  const phone = Object.assign(runtime, { remote: devices })
  // 两条入口共用一个限速实例：分开数等于给同一台机器双倍额度。
  const pairingThrottle = createPairingThrottle()
  registerMobileHttp(ctx, phone)

  // 手机那条独立的路。Connection 认的是进程启动的 launch token（给浏览器换 cookie 用的），
  // 长期带着凭据的手机没有位置，所以这里自己开一个口，用队伍签发的设备凭据验。
  // 验不过时 phoneHandler 不会看到任何东西。
  // 建一次就够：它是个纯函数，每个请求重建只是白读一遍环境。
  const answer = phoneHandler(phone)
  // 两条路（局域网直连、中转隧道）通向的是同一个处理器，所以请求的拼法只写一份：
  // 「`http://dsh` + 路径」只是为了给 Request 一个合法的绝对 URL，处理器只读 pathname。
  // 隧道那边还要把取消信号传下去（手机放弃了要能停掉宿主这边的活），所以它单独传一个 signal。
  // 两条入口的 headers 形状不同（LAN 是 IncomingMessage['headers']，隧道是 Record<string,string>），
  // 这里只把会话头透传下去：凭据头归各自入口的 phoneGate，逐跳头更不该进重建的 Request。
  // 不带这一句，phoneHandler 读不到 x-crew-session，header 形态的会话会静默退回 main。
  const sessionHeader = (headers?: Record<string, string | string[] | undefined>): Record<string, string> => {
    const raw = headers?.['x-crew-session']
    // 同名多值不许猜第一个（网关 get_all 的口径）：拼成一个肯定过不了形状校验的值，
    // 交给消息面回 400 invalid_session，绝不静默按 main 落库。
    // 空串也必须原样带下去：消息面的口径是「头存在但值为空 = 显式非法 → 400」，
    // 这里若把空串丢掉，请求就变成「没带会话」并被 200 落进 main —— 那正是 C4 静默串线。
    const value = Array.isArray(raw) ? raw.join(', ') : raw
    return typeof value === 'string' ? { 'x-crew-session': value } : {}
  }
  const ask = (request: { method: string; url: string; headers?: Record<string, string | string[] | undefined> }, body: string | Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<Response> =>
    answer(new Request(`http://dsh${request.url}`, {
      method: request.method,
      headers: sessionHeader(request.headers),
      ...(body.length ? { body } : {}),
      ...(signal ? { signal } : {}),
    }))
  // 手机换一次网就要重输一次地址，是这套东西最容易卡住人的地方。这里把队伍广播出去，
  // 手机用系统 NSD 就能自己找到它。广播失败只是少一条捷径，手输地址照旧可用。
  /** tailcat 起来之后才有地址，所以广播取的是这个变量而不是一个定值。 */
  let p2pAddr: string | undefined
  const discovery = createDiscovery({
    stateDir: machine.stateDir,
    name: process.env.CREW_DISCOVERY_NAME?.trim() || undefined,
    publicUrl: publicEntry(machine.stateDir),
    p2pAddr: () => p2pAddr,
    onError: error => ctx.logger.warn('mDNS announce failed: %s', String(error)),
  })
  const lan = createLanServer({
    devices,
    pairingAllowed: pairingThrottle,
    // 凭据已经验过了，直接交给消息面处理器：它不依赖 Connection，所以这条路上 Connection 那一关不参与。
    forward: request => ask(request, request.body),
  })
  ctx.effect(() => async () => { await lan.close(); await discovery.stop() })
  // 起不来不该挡住整个插件：局域网连不上只是少一条路，本机功能照常。
  // 网卡名要带上：虚拟网卡（utun / docker 之类）不能优先，否则局域网里的手机连不到。
  // 所有可达地址都绑上，因为只绑一块会漏掉别的网络（本机与模拟器走的是回环）。
  const candidates = bindCandidates(Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).map(item => ({ address: item.address, family: item.family, internal: item.internal, name }))))
  // 手机那条 P2P 路：tailcat serve 把手机要访问的端口暴露进 WireGuard 隧道 ——
  // magicsock 打洞成功就走直连，打不通自动落到 DERP，两条都是 UDP，比 HTTP 中转少一跳。
  // 二进制不在就当作这台机器没有这条通道：局域网与中转照旧，别的功能一点不受影响。
  const phonePort = lanPort(machine.stateDir)
  const p2pHealth = runtime.claimHealth('p2p', { state: 'starting', detail: 'Waiting for the phone listener' })
  const p2p = createP2p({
    binary: fileURLToPath(new URL('../tools/tailcat', import.meta.url)),
    port: phonePort,
    onAddr: addr => {
      p2pAddr = addr
      // 落盘只有一个用处：后端刚重启、tailcat 还没喷出新地址的那几秒，手机仍然拿得到上次
      // 那个地址（地址由密钥决定，所以旧地址依然有效），不必被降级到中转。
      try { writeFileSync(join(machine.stateDir, 'mobile-p2p-addr'), `${addr}\n`) }
      catch (error) { ctx.logger.warn('could not record the p2p address: %s', String(error)) }
      // 地址变了就让广播跟着变：手机在任何一个网络下看见一次就够了。
      discovery.publish(phonePort)
    },
    onState: (state, detail) => p2pHealth.set({ state, detail, at: new Date().toISOString() }),
    logger: message => ctx.logger.info('%s', message),
  })
  ctx.effect(() => async () => { await p2p.stop() })
  // 无条件起：这条通道的失败模式（二进制缺、NAT 打不通）和监听绑不上是两件事，把它们串成
  // 先后条件后，监听那边一次抖动就会让打洞能力整轮缺失。监听没起来时上面的 then 会把健康项
  // 标红，那才是要人看的那一格。
  p2p.start()

  lan.listenAll(lanPort(machine.stateDir), candidates)
    .then(bound => {
      if (bound.length === 0) {
        ctx.logger.warn('phone listener found no address to bind')
        // 隧道暴露的是那个端口：监听没起来时起隧道，等于公布一个没人听的地址，
        // 而 tailcat 自身会健康地报 ready —— 那是最难查的一种「看起来都好」。
        p2pHealth.set({ state: 'error', detail: 'No phone listener to expose', at: new Date().toISOString() })
        return
      }
      const port = lanPort(machine.stateDir)
      // 真的绑上了才广播：没绑上就广播，手机找到的会是一个拒绝连接的地址。
      discovery.publish(port)
      ctx.logger.info('phone reachable at %s', bound.map(host => `http://${host}:${port}`).join(' , '))
    })
    .catch((error: unknown) => { ctx.logger.warn('phone listener did not start: %s', String(error)) })

  // 出门之后那条路：宿主主动连中转，手机从中转进来。和局域网并存 —— 同一个 Wi-Fi 下直连更快，
  // 所以这里不抢直连的位置，只是多开一条出口。没配中转地址就什么都不做：不是每台机器都需要出门。
  const relays = parseRelayCandidates(process.env.CREW_RELAY_URLS)
  if (relays.length === 0) {
    ctx.logger.info('no relay configured; the phone can only reach this machine on the LAN')
  } else {
    // 降级链：把备选中转按 relay-chain 的 choose() 排一次序，先连此刻探得通、代价最低的那条，
    // 再把它放进隧道地址数组的第一位 —— 隧道内部仍按数组顺序轮转，丢了就换下一条。
    // 这样「先试哪条」有唯一答案（lan 不在这一步，出站隧道只用 relay/fallback 两档），
    // 而不是把配置里的顺序当顺序。
    const orderedRelays = await orderRelays(relays)
    const tunnel = createTunnel({
      // 排好序的地址一起交给隧道：第一条不通时它自己换下一条（见 tunnel.ts 的 cursor）。
      // 只交出第一条的话，兜底就只是配置里的两行字。
      relayUrl: orderedRelays.map(relay => relay.url),
      instanceId: process.env.CREW_RELAY_INSTANCE?.trim() || instanceIdFor(machine.stateDir),
      name: process.env.CREW_RELAY_NAME?.trim() || undefined,
      // 注册密钥走帧，不走 URL：URL 会进反代的 access log。
      registerSecret: process.env.CREW_RELAY_SECRET?.trim() || undefined,
      // 中转发来的 path 由手机决定，所以这条路自己要挡两道：只服务消息面，而且要验设备凭据。
      // 只判路径前缀是不够的 —— 中转不持有设备表，它把请求原样转过来，公网上知道 instanceId
      // 的人就能直接读时间线。凭据这道门必须在这里，和局域网那条路是同一份判定。
      // 判的是 `new Request` 规范化**之后**的路径：`/api/mobile/../../orchestrator/...`
      // 按原始前缀看是合规的，规范化之后才露出真面目。
      forward: (request, signal) => {
        const { pathname } = new URL(`http://dsh${request.url}`)
        const pairing = pathname === '/api/mobile/pair' && request.method === 'POST'
        if (pairing) {
          // 中转已经按来源地址限过一次，但那条链路上的地址来自请求头；宿主自己再数一遍，
          // 两边用同一套窗口，不依赖中转是否被换掉。
          const address = request.headers['x-forwarded-for'] ?? request.headers['x-real-ip']
          if (!pairingThrottle(typeof address === 'string' ? address.split(',').at(-1)?.trim() : undefined)) {
            return new Response(JSON.stringify({ error: 'Too many pairing attempts' }), { status: 429, headers: { 'content-type': 'application/json' } })
          }
        }
        const denied = phoneGate({ pathname, method: request.method, headers: request.headers, devices })
        if (denied) return denied
        return ask(request, request.rawBody ?? request.body, signal)
      },
      onLog: line => ctx.logger.info('%s', line),
    })
    ctx.effect(() => async () => { await tunnel.close() })
    // 通知改走这条隧道：中转认得这条连接，也知道手机在不在线，留件与补发都在它那边做。
    // 放这儿而不是 Runtime 里，是因为 Runtime 先构造、隧道后建 —— 反过来就是循环依赖。
    runtime.attachPusher(message => tunnel.push(message))
    ctx.effect(() => () => { runtime.attachPusher(undefined) })
    // 起不来不该挡住整个插件：局域网那条路还在，本机功能照常。隧道会自己退避重连。
    void tunnel.start().catch((error: unknown) => { ctx.logger.warn('relay tunnel did not start: %s', String(error)) })
    if (relays.length > 1) ctx.logger.info('relay fallbacks configured: %d', relays.length - 1)
  }
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
/**
 * 把中转地址交给 relay-chain 排序，返回「此刻探得通、代价最低的那条」排在最前的列表。
 *
 * 探测用一次 WebSocket 握手，超时就当不通 —— 与隧道的判死是同一套语义，不另发明。
 * 全部不通时退回原顺序：一条都没探通不代表它们都不存在（可能只是探得太早），
 * 让隧道自己按退避去连，比在这里判死更合理。
 */
export async function orderRelays(relays: readonly RelayTarget[], probe: { reachable: (url: string) => Promise<boolean> } = { reachable: url => providerReachable(url) }): Promise<RelayTarget[]> {
  // 一条（或零条）：没什么可排的，原样返回 —— 也避免为单条地址白做一次握手。
  if (relays.length <= 1) return [...relays]
  const routes = relays.map(relay => ({
    name: relay.name, kind: (relay.name === 'relay.self' ? 'relay' : 'fallback') as 'relay' | 'fallback',
    reachable: () => probe.reachable(relay.url),
  }))
  const chosen = await createChain({ routes, probeTimeoutMs: 2_000 }).choose()
  if (!chosen) return [...relays]
  // 按下标定位选中的那条：fallback 可能有多条同名，按名字过滤会把它们全提到最前。
  // 名字唯一时 name 就够用；万一重名，chain 也只会选到其中一条，取第一个匹配即可。
  const index = relays.findIndex(relay => relay.name === chosen.name)
  if (index <= 0) return [...relays]
  return [relays[index]!, ...relays.filter((_, i) => i !== index)]
}

/** 一次 WebSocket 握手判断中转此刻通不通；握手成功即关闭，不留连接。 */
function providerReachable(url: string, timeoutMs = 2_000): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false
    const done = (value: boolean): void => { if (settled) return; settled = true; try { socket.close() } catch { /* 关不掉就算了 */ } resolve(value) }
    let socket: WebSocket
    try { socket = new WebSocket(url) } catch { resolve(false); return }
    const timer = setTimeout(() => done(false), timeoutMs)
    timer.unref?.()
    socket.addEventListener('open', () => { clearTimeout(timer); done(true) })
    socket.addEventListener('error', () => { clearTimeout(timer); done(false) })
    socket.addEventListener('close', () => { clearTimeout(timer); done(false) })
  })
}

/**
 * 没显式给 instanceId 时的默认值：由状态目录算出来。
 *
 * 同一个目录永远同一个 id —— 手机记住的就是这个，换一次它就要重新找路。用状态目录而不是
 * 主机名，是因为一台机器上可能跑两个 crew（两个 profile），它们该是两个不同的 id。
 * 取摘要的前 16 位十六进制：够区分，又短到能放进 URL 路径。
 */
export function instanceIdFor(stateDir: string): string {
  return `crew-${createHash('sha256').update(stateDir).digest('hex').slice(0, 16)}`
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
