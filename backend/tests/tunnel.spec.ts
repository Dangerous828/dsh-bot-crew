import { afterEach, expect, it, vi } from 'vitest'
import { createRelay, type Relay } from '../../relay/src/server.ts'
import { T } from '../../relay/src/relay-protocol.ts'

/**
 * 宿主隧道客户端。
 *
 * 这里用真的中转（relay/src/server.ts）当对端，而不是打桩一个假中转：隧道客户端最容易错的地方
 * 是「两边对同一帧的理解不一样」，打桩会把被测方的错误也一起打进去，两边一起错就永远测不出来。
 */
const running: { relay: Relay; extra: (() => void)[] }[] = []
afterEach(async () => {
  for (const entry of running.splice(0)) {
    for (const stop of entry.extra) { try { stop() } catch { /* ignore */ } }
    await entry.relay.close()
  }
})

/** 起一个中转，返回端口与关掉它的方法。 */
async function relay(): Promise<{ relay: Relay; port: number; stop: () => void; address: string }> {
  const relay = createRelay({ heartbeatIntervalMs: 60_000, pongTimeoutMs: 120_000 })
  const port = await relay.listen(0, '127.0.0.1')
  running.push({ relay, extra: [] })
  return { relay, port, stop: () => {}, address: `127.0.0.1:${port}` }
}

/** 一条「上游」的假响应：宿主隧道把中转发来的请求交给它。 */
function upstream(handler: (request: { method: string; url: string; headers: Record<string, string>; body: string }) => Promise<Response>) {
  const seen: { method: string; url: string; headers: Record<string, string>; body: string }[] = []
  return {
    seen,
    forward: async (request: { method: string; url: string; headers: Record<string, string>; body: string }) => {
      seen.push(request)
      return handler(request)
    },
  }
}

it('dials out, registers, and serves an HTTP request from the relay', async () => {
  // 这一条是整个隧道最小可用的定义：宿主主动连出去，中转把手机请求送进来，宿主的回答原路回去。
  const { port } = await relay()
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const answer = upstream(async request => Response.json({ path: request.url, method: request.method }))
  const tunnel = createTunnel({ relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'box-1', name: '我的电脑', forward: answer.forward })
  running[0]!.extra.push(() => { void tunnel.close() })
  await tunnel.start()
  expect(tunnel.state()).toBe('live')

  const response = await fetch(`http://127.0.0.1:${port}/i/box-1/api/mobile/timeline?x=1`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ path: '/api/mobile/timeline?x=1', method: 'GET' })
  expect(answer.seen).toHaveLength(1)
})

it('reports offline after close, and the relay stops routing to it', async () => {
  const { port } = await relay()
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const tunnel = createTunnel({ relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'box', forward: async () => Response.json({}) })
  running[0]!.extra.push(() => { void tunnel.close() })
  await tunnel.start()
  await tunnel.close()
  expect(tunnel.state()).toBe('closed')
  // 断开之后中转不该再往这条隧道上送请求。
  const refused = await fetch(`http://127.0.0.1:${port}/i/box/api/mobile/timeline`)
  expect(refused.status).toBe(404)
})

it('reconnects with backoff after the relay drops the connection', async () => {
  // 中转重启、公网抽风、NAT 超时 —— 这些是常态。不重连的话，人离开家之后第一次断就再也连不回来。
  let port = 0
  const first = createRelay({ heartbeatIntervalMs: 60_000, pongTimeoutMs: 120_000 })
  port = await first.listen(0, '127.0.0.1')
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const tunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'box', forward: async () => Response.json({ ok: true }),
    // 退避在这里必须很短：真实值是 1s 起，测试里等它三轮就太久了。
    backoff: { initialMs: 40, maxMs: 120, jitter: 0 },
  })
  running.push({ relay: first, extra: [() => { void tunnel.close() }] })
  await tunnel.start()
  expect(tunnel.state()).toBe('live')

  // 把中转关掉，再在同一个端口上起一个新的：这是「中转重启」在宿主看来最像的场景。
  await first.close()
  await new Promise(done => setTimeout(done, 120))
  expect(tunnel.state()).not.toBe('live')

  const restarted = createRelay({ heartbeatIntervalMs: 60_000, pongTimeoutMs: 120_000 })
  await restarted.listen(port, '127.0.0.1')
  running[0]!.relay = restarted
  await new Promise(done => setTimeout(done, 400))
  expect(tunnel.state()).toBe('live')
  const response = await fetch(`http://127.0.0.1:${port}/i/box/api/mobile/timeline`)
  expect(response.status).toBe(200)
})

it('measures backoff as a doubling with a ceiling, not a fixed interval', async () => {
  const { backoffDelay } = await import('../src/app/tunnel.ts')
  // 纯函数单独测：真实重连里要观察到「翻倍」得等几十秒。
  // 关掉抖动才谈得上单调 —— 抖动本来就会让相邻两次一上一下。
  const steady = { initialMs: 1_000, maxMs: 30_000, jitter: 0 }
  expect([1, 2, 3, 4, 5, 6, 7, 8].map(attempt => backoffDelay(attempt, steady)))
    .toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])

  // 有抖动时：在同一档位内浮动 ±jitter，且永不越过上限（上限本身也带抖动）。
  const jittered = { initialMs: 1_000, maxMs: 30_000, jitter: 0.2 }
  for (let round = 0; round < 50; round += 1) {
    const first = backoffDelay(1, jittered)
    expect(first).toBeGreaterThanOrEqual(800)
    expect(first).toBeLessThanOrEqual(1_200)
    expect(backoffDelay(20, jittered)).toBeLessThanOrEqual(36_000)
    expect(backoffDelay(20, jittered)).toBeGreaterThanOrEqual(24_000)
  }
  // 抖动真的在变：50 次一个值都不重复才叫抖动。
  expect(new Set(Array.from({ length: 50 }, () => backoffDelay(2, jittered))).size).toBeGreaterThan(10)
})

it('sends a register frame carrying the instance id and the secret', async () => {
  // 中转侧的密钥校验依赖这个字段。宿主把密钥放帧里（而不是 URL 上），免得进反代日志。
  const { port } = await relay()
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const seenRegistrations: Record<string, unknown>[] = []
  const tunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'box', registerSecret: 'the-secret',
    forward: async () => Response.json({}), onFrame: frame => { if (frame.type === T.register && frame.direction === 'out') seenRegistrations.push(frame.json) },
  })
  running[0]!.extra.push(() => { void tunnel.close() })
  await tunnel.start()
  expect(seenRegistrations[0]).toMatchObject({ instanceId: 'box', secret: 'the-secret' })
})

it('answers a relay heartbeat with pong so the relay does not terminate it', async () => {
  // 中转 60s 收不到 pong 就 terminate。宿主必须应答，否则一条看起来健康的隧道会被判死。
  // 中转的 ping 是 15s 一拍，测试里等不起，所以用一台「发 ping、等 pong」的假中转直接看。
  const fake = await pingingRelay(40)
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const pongs: number[] = []
  const tunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${fake.port}/tunnel`, instanceId: 'box', forward: async () => Response.json({}),
    heartbeat: { intervalMs: 10_000, timeoutMs: 60_000 },
    onFrame: frame => { if (frame.type === T.pong && frame.direction === 'out') pongs.push(frame.id) },
  })
  running.push({ relay: createRelay(), extra: [() => { void tunnel.close() }] })
  await tunnel.start()
  // 两拍 ping 之后应当收到两个 pong。
  await new Promise(done => setTimeout(done, 200))
  expect(pongs.length).toBeGreaterThanOrEqual(2)
  expect(tunnel.state()).toBe('live')
  await fake.close()
})

it('drops itself when the relay stops answering pings', async () => {
  // 对端已经死了但 TCP 还在（NAT 静默丢弃）：宿主不能一直以为自己连着，
  // 否则手机每个请求都要等一个已经不在的隧道。
  const { createTunnel } = await import('../src/app/tunnel.ts')
  // 一个只会握手、从不回 pong 的假中转：直接对着 WS 层写。
  const fake = await silentRelay()
  const tunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${fake.port}/tunnel`, instanceId: 'box', forward: async () => Response.json({}),
    heartbeat: { intervalMs: 40, timeoutMs: 120 },
    backoff: { initialMs: 10_000, maxMs: 10_000, jitter: 0 },
  })
  running.push({ relay: createRelay(), extra: [() => { void tunnel.close() }] })
  await tunnel.start()
  expect(tunnel.state()).toBe('live')
  // 超时之后自己断开，而且进入重连等待（state 不再是 live）。
  await new Promise(done => setTimeout(done, 500))
  expect(tunnel.state()).not.toBe('live')
  await fake.close()
})

it('forwards a streamed response back chunk by chunk', async () => {
  const { port } = await relay()
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const tunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'box',
    // 上游回的是一段读得出来的流：中转必须边收边发。
    forward: async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('one;'))
        await new Promise(done => setTimeout(done, 100))
        controller.enqueue(new TextEncoder().encode('two;'))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/plain' } }),
  })
  running[0]!.extra.push(() => { void tunnel.close() })
  await tunnel.start()
  const response = await fetch(`http://127.0.0.1:${port}/i/box/api/mobile/timeline`)
  expect(await response.text()).toBe('one;two;')
})

it('passes the request body through to the upstream handler', async () => {
  const { port } = await relay()
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const { seen, forward } = upstream(async request => Response.json({ got: request.body }))
  const tunnel = createTunnel({ relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'box', forward })
  running[0]!.extra.push(() => { void tunnel.close() })
  await tunnel.start()
  const response = await fetch(`http://127.0.0.1:${port}/i/box/api/mobile/send`, { method: 'POST', body: '{"text":"你好"}' })
  expect(await response.json()).toEqual({ got: '{"text":"你好"}' })
  expect(seen[0]!.method).toBe('POST')
})

it('reports an upstream failure as an error the phone can see', async () => {
  const { port } = await relay()
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const tunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'box',
    // 上游抛错不能把隧道弄断，也不能把手机挂在等待上。
    forward: async () => { throw new Error('internal detail with a path /secret') },
  })
  running[0]!.extra.push(() => { void tunnel.close() })
  await tunnel.start()
  const response = await fetch(`http://127.0.0.1:${port}/i/box/api/mobile/timeline`)
  expect(response.status).toBe(502)
  const text = await response.text()
  // 内部细节不能漏给手机（里面可能有本机路径）。
  expect(text).not.toContain('/secret')
})

it('survives an upstream handler that throws synchronously', async () => {
  const { port } = await relay()
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const tunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'box',
    forward: (() => { throw new Error('sync explosion') }) as never,
  })
  running[0]!.extra.push(() => { void tunnel.close() })
  await tunnel.start()
  expect((await fetch(`http://127.0.0.1:${port}/i/box/api/mobile/timeline`)).status).toBe(502)
  // 之后还能正常服务别的请求。
  expect(tunnel.state()).toBe('live')
})

it('tells the upstream handler to stop when the phone goes away', async () => {
  // 手机退出了但宿主还在跑一个已经没人要的请求：不传取消，长任务会把宿主拖住。
  // 宿主的 forward 收一个 signal，中转发来 httpCancel 时它被 abort。
  const { port } = await relay()
  const { createTunnel } = await import('../src/app/tunnel.ts')
  let aborted = false
  let released: () => void = () => {}
  const finished = new Promise<void>(done => { released = done })
  const tunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'box',
    forward: async (_request, signal) => new Promise<Response>((_resolve, reject) => {
      // 一个不会自己结束的上游：只有取消能把它的 body 流放掉。
      signal.addEventListener('abort', () => { aborted = true; released(); reject(new Error('aborted')) }, { once: true })
    }),
  })
  running[0]!.extra.push(() => { void tunnel.close() })
  await tunnel.start()
  const controller = new AbortController()
  const pending = fetch(`http://127.0.0.1:${port}/i/box/api/mobile/timeline`, { signal: controller.signal }).catch(() => 'aborted')
  await new Promise(done => setTimeout(done, 150))
  controller.abort()
  await pending
  // 中转发 httpCancel；宿主收到后把上游的 signal 推倒。
  await Promise.race([finished, new Promise(done => setTimeout(done, 2_000))])
  expect(aborted).toBe(true)
})

it('never re-sends a frame id it has already used', async () => {
  // 隧道 id 是「同一时刻只有一个请求用它」。重连之后从 1 重新开始没问题（中转那边是新连接），
  // 但同一条连接上绝不能复用 —— 否则两个请求会抢同一个响应通道。
  const { port } = await relay()
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const ids: number[] = []
  const tunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'box', forward: async () => Response.json({}),
    onFrame: frame => { if (frame.type === T.httpRequest && frame.direction === 'in') ids.push(frame.id) },
  })
  running[0]!.extra.push(() => { void tunnel.close() })
  await tunnel.start()
  // 并发三个：三个不同的 id。
  void fetch(`http://127.0.0.1:${port}/i/box/a`)
  await fetch(`http://127.0.0.1:${port}/i/box/b`)
  await fetch(`http://127.0.0.1:${port}/i/box/c`)
  await new Promise(done => setTimeout(done, 100))
  expect(ids.length).toBe(3)
  expect(new Set(ids).size).toBe(3)
})

/**
 * 一台会按节奏发 ping 的假中转，用来验证宿主回不回 pong。
 * 真的中转也是 15s 一拍 —— 测试里等不起。
 */
async function pingingRelay(intervalMs: number): Promise<{ port: number; close: () => Promise<void> }> {
  const { createServer } = await import('node:http')
  const { upgradeToWebSocket } = await import('../../relay/src/websocket.ts')
  const { encodeFrame, jsonFrame, frameDecoder, T: codes } = await import('../../relay/src/relay-protocol.ts')
  const server = createServer()
  const sockets: import('node:stream').Duplex[] = []
  const timers: NodeJS.Timeout[] = []
  server.on('upgrade', (request, socket) => {
    sockets.push(socket)
    const connection = upgradeToWebSocket(request, socket, {
      onMessage: (_current, payload) => {
        frameDecoder(frame => {
          if (frame.type === codes.register) connection?.sendBinary(jsonFrame(codes.registered, 0, {}))
        })(payload)
      },
    })
    if (connection) {
      const timer = setInterval(() => connection.sendBinary(encodeFrame(codes.ping, 0, null)), intervalMs)
      timers.push(timer)
    }
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(typeof address === 'object' && address ? address.port : 0)
  }))
  return {
    port,
    close: () => new Promise<void>(resolve => {
      for (const timer of timers) clearInterval(timer)
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

/**
 * 一个只握手、只回 registered、从不回 pong 的假中转。
 * 用来看宿主在「对端静默」时的行为 —— 真的中转不会这样。
 */
async function silentRelay(): Promise<{ port: number; close: () => Promise<void> }> {
  const { createServer } = await import('node:http')
  const { upgradeToWebSocket } = await import('../../relay/src/websocket.ts')
  const { jsonFrame, frameDecoder } = await import('../../relay/src/relay-protocol.ts')
  const server = createServer()
  const sockets: import('node:stream').Duplex[] = []
  server.on('upgrade', (request, socket) => {
    sockets.push(socket)
    const connection = upgradeToWebSocket(request, socket, {
      onMessage: (_connection, payload) => {
        // ping 一概不回：这就是「对端静默」。
        frameDecoder(frame => {
          if (frame.type === T.register) connection?.sendBinary(jsonFrame(T.registered, 0, {}))
        })(payload)
      },
    })
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(typeof address === 'object' && address ? address.port : 0)
  }))
  return {
    port,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

it('moves to the next relay when the first one does not answer', async () => {
  // 兜底的全部意义：自建中转挂了（NAS 关机、家里断网），还有另一条能连上。
  // 拿一个没人监听的端口当「挂了的自建中转」。
  const first = await relay()
  const deadPort = first.port
  await first.relay.close() // 端口立刻空出来，但地址变成「连不上」

  const second = await relay()
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const tunnel = createTunnel({
    relayUrl: [`ws://127.0.0.1:${deadPort}/tunnel`, `ws://127.0.0.1:${second.port}/tunnel`],
    instanceId: 'box',
    forward: async () => Response.json({ from: tunnel.relayUrl() }),
    backoff: { initialMs: 20, maxMs: 60, jitter: 0 },
  })
  running.push({ relay: second.relay, extra: [() => { void tunnel.close() }] })
  await tunnel.start()
  await vi.waitFor(() => { expect(tunnel.state()).toBe('live') }, { timeout: 4_000 })
  // 现在用的是第二条，而且请求能通到它。
  expect(tunnel.relayUrl()).toBe(`ws://127.0.0.1:${second.port}/tunnel`)
  const response = await fetch(`http://127.0.0.1:${second.port}/i/box/api/mobile/timeline`)
  expect(await response.json()).toEqual({ from: `ws://127.0.0.1:${second.port}/tunnel` })
})

it('goes back to the first relay after trying every address', async () => {
  // 第 1 条只是「暂时」不通时不该被永久放弃：轮一遍之后要回到它。
  const { createTunnel } = await import('../src/app/tunnel.ts')
  const tried: string[] = []
  const tunnel = createTunnel({
    relayUrl: ['ws://127.0.0.1:1/tunnel', 'ws://127.0.0.1:2/tunnel'],
    instanceId: 'box',
    forward: async () => Response.json({}),
    backoff: { initialMs: 10, maxMs: 20, jitter: 0 },
    onLog: line => { const match = /moving to (\S+)/.exec(line); if (match) tried.push(match[1]!) },
  })
  running.push({ relay: createRelay(), extra: [() => { void tunnel.close() }] })
  await tunnel.start()
  // 两条都连不上，两轮之后应该已经轮转过至少三次。
  await vi.waitFor(() => { expect(tried.length).toBeGreaterThanOrEqual(3) }, { timeout: 4_000 })
  // 顺序是 2 → 1 → 2：不是随机，也不是一直卡在第二条。
  expect(tried.slice(0, 3)).toEqual(['ws://127.0.0.1:2/tunnel', 'ws://127.0.0.1:1/tunnel', 'ws://127.0.0.1:2/tunnel'])
})

it('refuses to be built without any relay address', async () => {
  // 空列表是配置错误（不是「此刻连不上」）。让它当场抛，而不是安静地什么都不做。
  const { createTunnel } = await import('../src/app/tunnel.ts')
  expect(() => createTunnel({ relayUrl: [], instanceId: 'box', forward: async () => Response.json({}) }))
    .toThrow(/at least one relay url/)
})
