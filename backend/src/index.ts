/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { phoneHandler, registerMobileHttp } from './app/mobile-http.ts'
import { deviceStoreOf } from './app/remote.ts'
import { bindCandidates, createLanServer, lanPort } from './app/lan-server.ts'
import { createDiscovery } from './app/discovery.ts'
import { publicEntry } from './app/public-entry.ts'
import { createTunnel } from './app/tunnel.ts'
import { phoneGate } from './app/phone-gate.ts'
import { createPairingThrottle } from './app/pairing-throttle.ts'
import { parseRelayCandidates } from './app/relay-chain.ts'
import { createHash } from 'node:crypto'
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
  const ask = (request: { method: string; url: string }, body: string, signal?: AbortSignal): Promise<Response> =>
    answer(new Request(`http://dsh${request.url}`, {
      method: request.method,
      ...(body ? { body } : {}),
      ...(signal ? { signal } : {}),
    }))
  // 手机换一次网就要重输一次地址，是这套东西最容易卡住人的地方。这里把队伍广播出去，
  // 手机用系统 NSD 就能自己找到它。广播失败只是少一条捷径，手输地址照旧可用。
  const discovery = createDiscovery({
    stateDir: machine.stateDir,
    name: process.env.CREW_DISCOVERY_NAME?.trim() || undefined,
    publicUrl: publicEntry(machine.stateDir),
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
  lan.listenAll(lanPort(machine.stateDir), candidates)
    .then(bound => {
      if (bound.length === 0) { ctx.logger.warn('phone listener found no address to bind'); return }
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
    const tunnel = createTunnel({
      // 全部地址一起交给隧道：第一条不通时它自己换下一条（见 tunnel.ts 的 cursor）。
      // 只交出第一条的话，兜底就只是配置里的两行字。
      relayUrl: relays.map(relay => relay.url),
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
        return ask(request, request.body, signal)
      },
      onLog: line => ctx.logger.info('%s', line),
    })
    ctx.effect(() => async () => { await tunnel.close() })
    // 起不来不该挡住整个插件：局域网那条路还在，本机功能照常。隧道会自己退避重连。
    void tunnel.start().catch((error: unknown) => { ctx.logger.warn('relay tunnel did not start: %s', String(error)) })
    if (relays.length > 1) ctx.logger.info('relay fallbacks configured: %d', relays.length - 1)
  }
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
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
