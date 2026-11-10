import { afterEach, expect, it } from 'vitest'
import { createRelay, type Relay } from '../src/server.ts'
import { connectTunnel, T, type RelayClient } from './fixtures/tunnel-client.ts'
import { parseJson } from '../src/relay-protocol.ts'
import type { Frame } from '../src/relay-protocol.ts'

const running: { relay: Relay; clients: RelayClient[] }[] = []
afterEach(async () => {
  for (const entry of running.splice(0)) {
    for (const client of entry.clients) await client.close().catch(() => {})
    await entry.relay.close()
  }
})

/** 起一个中转 + 一条已注册的宿主隧道，返回手机上该打的地址。 */
async function paired(instanceId = 'box'): Promise<{ relay: Relay; port: number; host: RelayClient; base: string }> {
  const relay = createRelay({ heartbeatIntervalMs: 60_000, pongTimeoutMs: 120_000 })
  const port = await relay.listen(0, '127.0.0.1')
  const clients: RelayClient[] = []
  running.push({ relay, clients })
  const host = await connectTunnel({ port })
  clients.push(host)
  host.json(T.register, 0, { instanceId })
  await host.next(frame => frame.type === T.registered)
  return { relay, port, host, base: `http://127.0.0.1:${port}/i/${instanceId}` }
}

/**
 * 宿主收到 httpRequest 后按协议回一段固定响应。
 * 返回一个可以被测试断言「宿主看到了什么」的 Promise。
 */
function answerWith(host: RelayClient, reply: { status?: number; headers?: Record<string, string>; body?: string; chunks?: string[] }) {
  const seen: { method?: string; path?: string; headers?: Record<string, string> } = {}
  const request = host.next(frame => frame.type === T.httpRequest)
  const responded = request.then(async frame => {
    seen.method = parseJson(frame.payload).method as string
    seen.path = parseJson(frame.payload).path as string
    seen.headers = parseJson(frame.payload).headers as Record<string, string>
    host.json(T.httpHead, frame.id, { status: reply.status ?? 200, headers: { 'content-type': 'application/json', ...reply.headers } })
    // body 分片走 httpChunk，结束用一个空 httpBody 以外的 httpEnd。
    for (const chunk of reply.chunks ?? (reply.body ? [reply.body] : [])) host.send(T.httpChunk, frame.id, Buffer.from(chunk))
    host.send(T.httpEnd, frame.id, null)
    return frame
  })
  return { seen, request, responded }
}

it('routes a phone request to the host registered under that instance id', async () => {
  const { host, base } = await paired('box')
  const { seen, responded } = answerWith(host, { body: '{"items":[]}' })
  const answer = await fetch(`${base}/api/mobile/timeline`)
  expect(answer.status).toBe(200)
  expect(await answer.text()).toBe('{"items":[]}')
  await responded
  expect(seen.path).toBe('/api/mobile/timeline')
  expect(seen.method).toBe('GET')
})

it('carries the request body upstream so a POST arrives whole', async () => {
  const { host, base } = await paired()
  const received: string[] = []
  // 按帧序收：httpRequest 之后紧跟 httpBody*，最后是一个空 httpBody 表示结束。
  // 轮询帧表而不是用 next() 链起来 —— next() 只看「已经收到的」，边收边等会漏。
  const pump = setInterval(() => {
    for (const frame of host.frames) {
      if (frame.type !== T.httpBody) continue
      if (frame.payload.length === 0) continue
      received.push(frame.payload.toString('utf8'))
    }
    const request = host.frames.find(frame => frame.type === T.httpRequest)
    if (request && !host.frames.some(frame => frame.type === T.httpEnd || frame.type === T.httpHead)) {
      host.json(T.httpHead, request.id, { status: 200, headers: {} })
      host.send(T.httpEnd, request.id, null)
    }
  }, 5)
  const answer = await fetch(`${base}/api/mobile/send`, { method: 'POST', body: '{"text":"你好"}' })
  clearInterval(pump)
  expect(answer.status).toBe(200)
  expect(received.join('')).toBe('{"text":"你好"}')
})

it('streams the response back chunk by chunk instead of buffering it', async () => {
  // 长流（SSE、大列表）在手机上要边收边显示。中转若等宿主把正文发完再一次性回，
  // 症状是「点了没反应，几秒后突然全出来」。
  const { host, base } = await paired()
  const arrivals: string[] = []
  const request = host.next(frame => frame.type === T.httpRequest)
  void request.then(frame => {
    host.json(T.httpHead, frame.id, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    // 第一片先到，隔一会儿再发第二片与结束。
    host.send(T.httpChunk, frame.id, Buffer.from('data: one\n\n'))
    setTimeout(() => {
      host.send(T.httpChunk, frame.id, Buffer.from('data: two\n\n'))
      host.send(T.httpEnd, frame.id, null)
    }, 120)
  })
  const answer = await fetch(`${base}/api/mobile/timeline`)
  const reader = answer.body!.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    arrivals.push(decoder.decode(value, { stream: true }))
  }
  expect(arrivals.join('')).toBe('data: one\n\ndata: two\n\n')
  // 关键：第一片必须在第二片之前就被手机收到，而不是最后一起到。
  expect(arrivals.length).toBeGreaterThan(1)
})

it('answers 404 when no host is registered under that instance id', async () => {
  const { base } = await paired('box')
  const answer = await fetch(`http://127.0.0.1:${new URL(base).port}/i/nobody/api/mobile/timeline`)
  expect(answer.status).toBe(404)
  const body = await answer.json() as { error: string }
  expect(body.error).toMatch(/unknown|offline/i)
})

it('answers 404 for an instance whose tunnel has gone away', async () => {
  const { host, base } = await paired()
  await host.close()
  await new Promise(done => setTimeout(done, 100))
  const answer = await fetch(`${base}/api/mobile/timeline`)
  expect(answer.status).toBe(404)
})

it('answers 502 when the host errors the request rather than hanging', async () => {
  const { host, base } = await paired()
  const request = host.next(frame => frame.type === T.httpRequest)
  void request.then(frame => host.json(T.httpError, frame.id, { message: 'upstream down' }))
  const answer = await fetch(`${base}/api/mobile/timeline`)
  expect(answer.status).toBe(502)
})

it('gives up on a host that never answers, instead of holding the phone open', async () => {
  // 宿主活着但卡死（比如 worker 卡在一个不返回的调用里）：手机的请求必须有上限。
  const relay = createRelay({ responseTimeoutMs: 200, heartbeatIntervalMs: 60_000, pongTimeoutMs: 120_000 })
  const port = await relay.listen(0, '127.0.0.1')
  const clients: RelayClient[] = []
  running.push({ relay, clients })
  const host = await connectTunnel({ port })
  clients.push(host)
  host.json(T.register, 0, { instanceId: 'slow' })
  await host.next(frame => frame.type === T.registered)
  const answer = await fetch(`http://127.0.0.1:${port}/i/slow/api/mobile/timeline`)
  expect(answer.status).toBe(504)
})

it('tells the host to stop working when the phone goes away', async () => {
  // 手机退出了但宿主还在跑一个已经没人要的请求。取消要传下去，否则长任务会把宿主拖住。
  const { host, base } = await paired()
  const request = host.next(frame => frame.type === T.httpRequest)
  void request.then(frame => {
    // 不回响应，等取消。
    return frame
  })
  const controller = new AbortController()
  const pending = fetch(`${base}/api/mobile/timeline`, { signal: controller.signal }).catch(() => 'aborted')
  await request
  controller.abort()
  await pending
  const cancel = await host.next(frame => frame.type === T.httpCancel, 2_000)
  expect(cancel.id).toBeGreaterThan(0)
})

it('does not leak one instance request into another', async () => {
  // 两条隧道并存时，id 空间各自从 1 开始，必须按隧道分表，不能撞。
  const relay = createRelay({ heartbeatIntervalMs: 60_000, pongTimeoutMs: 120_000 })
  const port = await relay.listen(0, '127.0.0.1')
  const clients: RelayClient[] = []
  running.push({ relay, clients })
  const one = await connectTunnel({ port }); clients.push(one)
  one.json(T.register, 0, { instanceId: 'one' })
  await one.next(frame => frame.type === T.registered)
  const two = await connectTunnel({ port }); clients.push(two)
  two.json(T.register, 0, { instanceId: 'two' })
  await two.next(frame => frame.type === T.registered)

  const first = answerWith(one, { body: 'from-one' })
  const second = answerWith(two, { body: 'from-two' })
  const [a, b] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/i/one/api/mobile/timeline`).then(response => response.text()),
    fetch(`http://127.0.0.1:${port}/i/two/api/mobile/timeline`).then(response => response.text()),
  ])
  expect(a).toBe('from-one')
  expect(b).toBe('from-two')
  await Promise.all([first.responded, second.responded])
})

it('refuses a request body larger than the configured cap', async () => {
  // 中转是公网暴露面：不设上限，一个 2GB 的 POST 就能把 NAS 的内存吃掉。
  const relay = createRelay({ maxRequestBodyBytes: 1024, heartbeatIntervalMs: 60_000, pongTimeoutMs: 120_000 })
  const port = await relay.listen(0, '127.0.0.1')
  const clients: RelayClient[] = []
  running.push({ relay, clients })
  const host = await connectTunnel({ port }); clients.push(host)
  host.json(T.register, 0, { instanceId: 'box' })
  await host.next(frame => frame.type === T.registered)

  const answer = await fetch(`http://127.0.0.1:${port}/i/box/api/mobile/send`, { method: 'POST', body: 'x'.repeat(4096) })
  expect(answer.status).toBe(413)
  // 超限的请求不该被送上去。
  expect(host.frames.some(frame => frame.type === T.httpRequest)).toBe(false)
})

it('passes the device credential headers through untouched', async () => {
  // 凭据校验在宿主那边（设备表在宿主的磁盘上）。中转必须原样转发这两个头，
  // 但它自己**不**验 —— 验不了，凭据摘要只在宿主手里。
  const { host, base } = await paired()
  const { seen, responded } = answerWith(host, { body: '{}' })
  await fetch(`${base}/api/mobile/timeline`, { headers: { 'x-crew-device': 'phone-1', 'x-crew-credential': 'token-abc' } })
  await responded
  expect(seen.headers?.['x-crew-device']).toBe('phone-1')
  expect(seen.headers?.['x-crew-credential']).toBe('token-abc')
})

it('counts repeated failed authentications from one address and stops serving it', async () => {
  // 公网暴露面上要有一道闸：同一个 IP 拿着错凭据狂刷时，中转不能陪着它一直打到宿主。
  // 中转验不了设备凭据（设备表在宿主那边），它看的是**宿主的回答**：401/403 就是一次失败。
  const relay = createRelay({ authFailureLimit: 3, heartbeatIntervalMs: 60_000, pongTimeoutMs: 120_000 })
  const port = await relay.listen(0, '127.0.0.1')
  const clients: RelayClient[] = []
  running.push({ relay, clients })
  const host = await connectTunnel({ port }); clients.push(host)
  host.json(T.register, 0, { instanceId: 'box' })
  await host.next(frame => frame.type === T.registered)

  // 宿主把每个请求都判 401（凭据不对），并且只回一次 —— 按 id 记已经回过的。
  const answered = new Set<number>()
  const pump = setInterval(() => {
    for (const frame of host.frames) {
      if (frame.type !== T.httpRequest || answered.has(frame.id)) continue
      answered.add(frame.id)
      host.json(T.httpHead, frame.id, { status: 401, headers: {} })
      host.send(T.httpEnd, frame.id, null)
    }
  }, 5)

  const statuses: number[] = []
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const answer = await fetch(`http://127.0.0.1:${port}/i/box/api/mobile/timeline`, { headers: { 'x-crew-credential': 'wrong' } })
    statuses.push(answer.status)
  }
  clearInterval(pump)
  // 头三次是真 401（宿主判的），封禁期开始之后由中转自己挡成 429。
  expect(statuses.slice(0, 3)).toEqual([401, 401, 401])
  expect(statuses.at(-1)).toBe(429)
})

it('keys the auth strike on the proxy-appended hop, not the client-supplied leftmost one', async () => {
  // 客户端可以把最左段写成任意值。按最左段计数，每请求都是「新地址」，封禁永远不生效。
  const relay = createRelay({ authFailureLimit: 3, heartbeatIntervalMs: 60_000, pongTimeoutMs: 120_000 })
  const port = await relay.listen(0, '127.0.0.1')
  const clients: RelayClient[] = []
  running.push({ relay, clients })
  const host = await connectTunnel({ port }); clients.push(host)
  host.json(T.register, 0, { instanceId: 'box' })
  await host.next(frame => frame.type === T.registered)
  const answered = new Set<number>()
  const pump = setInterval(() => {
    for (const frame of host.frames) {
      if (frame.type !== T.httpRequest || answered.has(frame.id)) continue
      answered.add(frame.id)
      host.json(T.httpHead, frame.id, { status: 401, headers: {} })
      host.send(T.httpEnd, frame.id, null)
    }
  }, 5)

  const statuses: number[] = []
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const answer = await fetch(`http://127.0.0.1:${port}/i/box/api/mobile/timeline`, {
      headers: { 'x-crew-credential': 'wrong', 'x-forwarded-for': `10.0.0.${attempt}, 203.0.113.7` },
    })
    statuses.push(answer.status)
  }
  clearInterval(pump)
  expect(statuses.slice(0, 3)).toEqual([401, 401, 401])
  expect(statuses.at(-1)).toBe(429)
})

it('serves a probe endpoint the reverse proxy can point at', async () => {
  const { base } = await paired()
  const answer = await fetch(new URL('/health', base))
  expect(answer.status).toBe(200)
  const body = await answer.json() as { ok: boolean; tunnels: number }
  expect(body.ok).toBe(true)
  expect(body.tunnels).toBe(1)
})

it('forwards the host response status and headers', async () => {
  const { host, base } = await paired()
  answerWith(host, { status: 429, headers: { 'retry-after': '5', 'content-type': 'text/plain' }, body: 'slow down' })
  const answer = await fetch(`${base}/api/mobile/timeline`)
  expect(answer.status).toBe(429)
  expect(answer.headers.get('retry-after')).toBe('5')
  expect(await answer.text()).toBe('slow down')
})

it('keeps the query string when routing', async () => {
  const { host, base } = await paired()
  const { seen, responded } = answerWith(host, { body: '{}' })
  await fetch(`${base}/api/mobile/work?ticket=t-42&x=1`)
  await responded
  expect(seen.path).toBe('/api/mobile/work?ticket=t-42&x=1')
})

it('does not route a path that escapes the instance prefix', async () => {
  const { port } = await paired()
  for (const path of ['/i/box', '/i/box/', '/tunnel/', '/', '/i//api/mobile/timeline']) {
    const answer = await fetch(`http://127.0.0.1:${port}${path}`)
    expect(answer.status, path).toBe(404)
  }
})

it('drops a request whose host vanished mid-response without hanging', async () => {
  const { host, base } = await paired()
  const request = host.next(frame => frame.type === T.httpRequest)
  void request.then(frame => {
    host.json(T.httpHead, frame.id, { status: 200, headers: { 'content-type': 'text/plain' } })
    host.send(T.httpChunk, frame.id, Buffer.from('partial'))
    // 不发 httpEnd，直接断隧道。
    host.close()
  })
  // 手机上要么是截断的流、要么是 502；关键是不能一直挂着。
  const result = await Promise.race([
    fetch(`${base}/api/mobile/timeline`).then(response => response.status, () => 502),
    new Promise<number>(resolve => setTimeout(() => resolve(-1), 3_000)),
  ])
  expect(result).not.toBe(-1)
})

it('does not reuse a request id across two in-flight requests', async () => {
  const { host, base } = await paired()
  const ids: number[] = []
  const watch = setInterval(() => {
    for (const frame of host.frames) if (frame.type === T.httpRequest && !ids.includes(frame.id)) {
      ids.push(frame.id)
      host.json(T.httpHead, frame.id, { status: 200, headers: {} })
      host.send(T.httpEnd, frame.id, null)
    }
  }, 5)
  await Promise.all([
    fetch(`${base}/api/mobile/timeline`), fetch(`${base}/api/mobile/timeline`), fetch(`${base}/api/mobile/timeline`),
  ])
  clearInterval(watch)
  expect(new Set(ids).size).toBe(3)
})

it('wraps up frames it cannot parse rather than throwing out of the socket handler', async () => {
  const { host, base } = await paired()
  // 宿主发一个坏 id 的 httpChunk：中转应当忽略它，之后的正常请求仍然能用。
  host.send(T.httpChunk, 999, Buffer.from('orphan'))
  const { responded } = answerWith(host, { body: 'still works' })
  const answer = await fetch(`${base}/api/mobile/timeline`)
  expect(await answer.text()).toBe('still works')
  await responded
})

export type { Frame }

it('does not decode a percent-encoded instance id into a different route', async () => {
  // 路由是按字面的 `/` 切段的，如果再把 id 解码一次，两套事实就会对不上：
  // `/i/a%2F..%2Fb/x` 的 id 段是 `a%2F..%2Fb`，解码之后是 `a/../b` —— 一个不存在的路径却能让
  // 校验与查找作用在不同字符串上。instanceId 的字符集里本来就没有需要编码的字符，
  // 所以「编码过的 id」一定是伪造的。
  const { port } = await paired('box')
  for (const path of ['/i/box%2Fapi/api/mobile/timeline', '/i/a%2F..%2Fb/api/mobile/timeline', '/i/%62ox/api/mobile/timeline']) {
    const answer = await fetch(`http://127.0.0.1:${port}${path}`)
    expect(answer.status, path).toBe(404)
  }
})

it('answers 404 rather than crashing on a malformed percent escape', async () => {
  // `decodeURIComponent('%E0%A4%A')` 抛 URIError。在最热的那个请求路径上抛，
  // 如果在处理函数外面，就是一条未捕获的 rejection —— 公网上谁都能用它打一次。
  const { port } = await paired('box')
  const answer = await fetch(`http://127.0.0.1:${port}/i/%E0%A4%A/api/mobile/timeline`)
  expect(answer.status).toBe(404)
  // 服务还活着：后续的正常路由仍然可用。
  expect((await fetch(`http://127.0.0.1:${port}/i/nobody/api/mobile/timeline`)).status).toBe(404)
})
