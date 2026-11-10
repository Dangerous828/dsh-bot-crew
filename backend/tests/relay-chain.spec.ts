import { afterEach, expect, it } from 'vitest'
import {
  createChain, lanReachable, parseRelayCandidates, type RelayRoute, type RelayTarget,
} from '../src/app/relay-chain.ts'

/**
 * 降级链。
 *
 * 需求原话是「relay 的中转再做一个作为兜底」，我按「当自建中转不可达时还有另一条路能连上」
 * 来理解并实现：**三条路，按代价从低到高排**，不是「两条一模一样的隧道」。
 * 理由写在 relay-chain.ts 文件头，这里只钉行为。
 */

const running: (() => Promise<void>)[] = []
afterEach(async () => { for (const stop of running.splice(0)) await stop() })

/** 一条假的路径：它记下被问过几次，按预设回答「通不通」。 */
function route(name: string, reachable: () => Promise<boolean> | boolean, kind: RelayRoute['kind'] = 'relay'): RelayRoute & { probes: number } {
  let probes = 0
  return {
    name,
    kind,
    get probes() { return probes },
    async reachable() { probes += 1; return reachable() },
  }
}

it('orders the routes by cost: LAN first, then the self-hosted relay, then whatever is left', async () => {
  // 顺序不是随便排的：局域网最近（同一台路由器下、零公网依赖），自建中转次之（自己的机器、
  // 自己的带宽），兜底最后（别人的基础设施、最慢、最不可控）。降级链的价值就在这个顺序。
  const chain = createChain({
    routes: [
      { name: 'lan', kind: 'lan', reachable: async () => true },
      { name: 'relay.self', kind: 'relay', reachable: async () => true },
      { name: 'relay.fallback', kind: 'fallback', reachable: async () => true },
    ],
  })
  const chosen = await chain.choose()
  expect(chosen?.name).toBe('lan')
})

it('falls through to the self-hosted relay when the LAN is out of reach', async () => {
  const chain = createChain({
    routes: [
      { name: 'lan', kind: 'lan', reachable: async () => false },
      { name: 'relay.self', kind: 'relay', reachable: async () => true },
      { name: 'relay.fallback', kind: 'fallback', reachable: async () => true },
    ],
  })
  expect((await chain.choose())?.name).toBe('relay.self')
})

it('falls through to the backup relay when the self-hosted one is down', async () => {
  // 这正是「兜底」要覆盖的场景：NAS 挂了、家里断网了、Cloudflare 那一段抽了。
  const chain = createChain({
    routes: [
      { name: 'lan', kind: 'lan', reachable: async () => false },
      { name: 'relay.self', kind: 'relay', reachable: async () => false },
      { name: 'relay.fallback', kind: 'fallback', reachable: async () => true },
    ],
  })
  expect((await chain.choose())?.name).toBe('relay.fallback')
})

it('answers nothing when every route is out', async () => {
  const chain = createChain({
    routes: [
      { name: 'lan', kind: 'lan', reachable: async () => false },
      { name: 'relay.self', kind: 'relay', reachable: async () => false },
    ],
  })
  // 一条都不通时返回 undefined，而不是抛错：没有路是「此刻的处境」，不是程序错误。
  expect(await chain.choose()).toBeUndefined()
})

it('does not let a hanging probe hold the whole chain', async () => {
  // 公网上最常见的故障不是「连接被拒」而是「连上了但不回」：SYN 超时、DNS 卡住。
  // 一个卡死的探测若不设超时，整条降级链就永远停在第一档。
  const chain = createChain({
    routes: [
      { name: 'lan', kind: 'lan', reachable: () => new Promise<boolean>(() => {}) },
      { name: 'relay.self', kind: 'relay', reachable: async () => true },
    ],
    probeTimeoutMs: 80,
  })
  const started = Date.now()
  expect((await chain.choose())?.name).toBe('relay.self')
  expect(Date.now() - started).toBeLessThan(2_000)
})

it('remembers the chosen route and does not walk the ladder again', async () => {
  // 每次请求都从最便宜的那条重新探起，等于给每个请求加一次「局域网不通」的超时。
  // 选定之后只复查那一条；只有它不通了，才回到阶梯的顶上。
  const lan = route('lan', () => false)
  const self = route('relay.self', () => true)
  const chain = createChain({ routes: [lan, self] })
  await chain.choose()
  expect(lan.probes).toBe(1)
  expect(self.probes).toBe(1)

  await chain.choose()
  // 第二次：仍然是那条，而且没有再探过局域网（那条已经被证明不通）。
  expect(lan.probes).toBe(1)
  expect(self.probes).toBe(2)

  // 记为不通之后，下次从头上重新探。
  chain.invalidate('relay.self')
  await chain.choose()
  expect(lan.probes).toBe(2)
  expect(self.probes).toBe(3)
})

it('re-probes from the top after the chosen route fails', async () => {
  // 兜底路径本身出问题后，宿主可能已经回到局域网里了。从最便宜的那条重新试，而不是直接跳到第三档。
  let lanUp = false
  const chain = createChain({
    routes: [
      { name: 'lan', kind: 'lan', reachable: async () => lanUp },
      { name: 'relay.self', kind: 'relay', reachable: async () => false },
      { name: 'relay.fallback', kind: 'fallback', reachable: async () => true },
    ],
  })
  expect((await chain.choose())?.name).toBe('relay.fallback')
  lanUp = true
  // 兜底挂了：从头上再试一遍。
  expect((await chain.choose({ refresh: true }))?.name).toBe('lan')
})

it('keeps probing the next route when one throws instead of swallowing the chain', async () => {
  // 探测函数自己出错（DNS 解析抛、TLS 证书抛）与「返回 false」是同一件事：这条路现在不通。
  const chain = createChain({
    routes: [
      { name: 'lan', kind: 'lan', reachable: () => { throw new Error('dns exploded') } },
      { name: 'relay.self', kind: 'relay', reachable: async () => true },
    ],
  })
  expect((await chain.choose())?.name).toBe('relay.self')
})

it('treats a LAN target as reachable only when something answers it fast', async () => {
  // 局域网探测是一次真实的 HTTP 请求：能连上就说明手机走过去是通的。
  // 判据是「有响应」，不是「200」—— 消息面在没配对时本来就回 401。
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => { response.writeHead(401); response.end() })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(typeof address === 'object' && address ? address.port : 0)
  }))
  running.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) }))
  expect(await lanReachable(`http://127.0.0.1:${port}/api/mobile/timeline`, 1_000)).toBe(true)
  // 关掉的端口：连不上。
  server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
  expect(await lanReachable(`http://127.0.0.1:${port}/api/mobile/timeline`, 500)).toBe(false)
})

it('reads a relay list from the environment without inventing one', () => {
  // 部署时最省事的写法是一个逗号分隔的列表。空值必须当成「没配」，不是「配了一条空地址」。
  expect(parseRelayCandidates('wss://a.example/tunnel, wss://b.example/tunnel')).toEqual([
    { name: 'relay.self', url: 'wss://a.example/tunnel' },
    { name: 'relay.fallback', url: 'wss://b.example/tunnel' },
  ])
  expect(parseRelayCandidates('')).toEqual([])
  expect(parseRelayCandidates('   ')).toEqual([])
  expect(parseRelayCandidates(undefined)).toEqual([])
  // 只配了一条：那就是自建那一条，没有兜底。
  expect(parseRelayCandidates('wss://only.example/tunnel')).toEqual([{ name: 'relay.self', url: 'wss://only.example/tunnel' }])
})

it('names the second and later relays as fallbacks so logs say which one was used', () => {
  const parsed = parseRelayCandidates('wss://a.example/tunnel,wss://b.example/tunnel,wss://c.example/tunnel')
  expect(parsed.map(entry => entry.name)).toEqual(['relay.self', 'relay.fallback', 'relay.fallback'])
  // 两条兜底要有可区分的名字，否则日志里分不清是哪一条在扛。
  expect(new Set(parsed.map(entry => entry.url)).size).toBe(3)
})

it('rejects relay urls that are not websocket urls', () => {
  // 一个 http:// 的地址在 WebSocket 构造时才会报错，那时候已经晚了 —— 部署时打错一个协议头，
  // 症状是「隧道一直重连，日志里看不出为什么」。这里当场剔掉，并保留合法的那些。
  expect(parseRelayCandidates('http://a.example/tunnel')).toEqual([])
  expect(parseRelayCandidates('not a url,wss://ok.example/tunnel')).toEqual([{ name: 'relay.self', url: 'wss://ok.example/tunnel' }])
})

it('exposes the whole ladder for the panel to show', async () => {
  const chain = createChain({
    routes: [
      { name: 'lan', kind: 'lan', reachable: async () => false },
      { name: 'relay.self', kind: 'relay', reachable: async () => true },
    ],
  })
  // status 不自己选路（选路有副作用：会钉住一条）。先 choose，再问状态。
  await chain.choose()
  const state = await chain.status()
  expect(state.active).toBe('relay.self')
  // 每一档都要能说出「它在不在、是不是当前用的那条」，否则排障时只能猜。
  expect(state.routes.map(entry => ({ name: entry.name, kind: entry.kind, reachable: entry.reachable, active: entry.active })))
    .toEqual([
      { name: 'lan', kind: 'lan', reachable: false, active: false },
      { name: 'relay.self', kind: 'relay', reachable: true, active: true },
    ])
})

export type { RelayTarget }
