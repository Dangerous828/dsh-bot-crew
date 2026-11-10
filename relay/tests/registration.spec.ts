import { afterEach, expect, it } from 'vitest'
import { createRelay, type Relay } from '../src/server.ts'
import { connectTunnel, T, type RelayClient } from './fixtures/tunnel-client.ts'

/** 每个测试一个中转，端口交给系统挑。 */
const running: { relay: Relay; clients: RelayClient[] }[] = []
afterEach(async () => {
  for (const entry of running.splice(0)) {
    for (const client of entry.clients) await client.close().catch(() => {})
    await entry.relay.close()
  }
})

async function relay(options: Parameters<typeof createRelay>[0] = {}): Promise<{ relay: Relay; port: number; url: string }> {
  const created = createRelay(options)
  const port = await created.listen(0, '127.0.0.1')
  const entry = { relay: created, clients: [] as RelayClient[] }
  running.push(entry)
  return { relay: created, port, url: `http://127.0.0.1:${port}` }
}

async function host(port: number, options: Omit<Parameters<typeof connectTunnel>[0], 'port'> = {}): Promise<RelayClient> {
  return connectTunnel({ port, ...options })
}

it('registers a host and tells it the tunnel is live', async () => {
  const { port, relay: server } = await relay()
  const client = await host(port)
  client.json(T.register, 0, { instanceId: 'box-1', name: '我的电脑' })
  // 回执必须在同一 id=0 上：宿主拿它当「注册完成、可以接请求了」的信号。
  const registered = await client.next(frame => frame.type === T.registered)
  expect(registered.id).toBe(0)
  expect(server.instances()).toContain('box-1')
})

it('rejects a connection that stays silent instead of holding a slot forever', async () => {
  // 公网暴露面上最便宜的攻击是「连上然后什么都不说」：不设注册超时，几万个空连接就能占满内存。
  const { port } = await relay({ registerTimeoutMs: 150 })
  const client = await host(port)
  // 服务端先道明原因（register-timeout），再断开。
  const refused = await client.next(frame => frame.type === T.wsError, 3_000)
  expect(String(refused.payload)).toMatch(/register-timeout/)
  // 也要真的断开，而不是留在表里。
  await client.closed
})

it('refuses a second live host claiming the same instance id', async () => {
  // 两个宿主同一个 id：后到的那个必须被拒。否则同一个局域网里两台机器配了同一个名字，
  // 手机就会随机落到其中一台 —— 比连不上更难查。
  const { port } = await relay()
  const first = await host(port)
  first.json(T.register, 0, { instanceId: 'same' })
  await first.next(frame => frame.type === T.registered)

  const second = await host(port)
  second.json(T.register, 0, { instanceId: 'same' })
  const refused = await second.next(frame => frame.type === T.wsError || frame.type === T.registered)
  expect(refused.type).toBe(T.wsError)
  expect(String(refused.payload)).toMatch(/already/i)
  // 先来的那条不能受影响。
  expect(first.frames.filter(frame => frame.type === T.registered)).toHaveLength(1)
})

it('lets a host take back its own id after reconnecting with the same secret', async () => {
  // 断网后宿主的旧连接常常还挂在服务端（TCP 半开）。宿主重连时若还要等旧连接超时，
  // 症状是「明明重连上了，手机还是连不上」，而且要等一分钟才自愈。
  //
  // 判据是**身份**不是先后：配了注册密钥时，只有出示同一把密钥的新连接才算同一台机器。
  const { port, relay: server } = await relay({ registerSecret: 'same-secret', pongTimeoutMs: 60_000 })
  const first = await host(port)
  first.json(T.register, 0, { instanceId: 'box', secret: 'same-secret' })
  await first.next(frame => frame.type === T.registered)

  const second = await host(port)
  second.json(T.register, 0, { instanceId: 'box', secret: 'same-secret' })
  expect((await second.next(frame => frame.type === T.wsError || frame.type === T.registered)).type).toBe(T.registered)
  // 旧的连接被关闭（不是静默留着）。
  await first.closed
  expect(server.instances()).toContain('box')
})

it('answers ping with pong so the host knows the tunnel is alive', async () => {
  const { port } = await relay()
  const client = await host(port)
  client.json(T.register, 0, { instanceId: 'box' })
  await client.next(frame => frame.type === T.registered)
  client.send(T.ping, 0, null)
  const pong = await client.next(frame => frame.type === T.pong)
  expect(pong.id).toBe(0)
})

it('terminates a host that stops answering pings', async () => {
  // 中转 60s 收不到 pong 就 terminate。这里调短，验证「不回 pong 会被踢」这条路径存在。
  const { port } = await relay({ heartbeatIntervalMs: 60, pongTimeoutMs: 120 })
  const client = await host(port)
  client.json(T.register, 0, { instanceId: 'box' })
  await client.next(frame => frame.type === T.registered)
  // 不回 pong：心跳超时后连接应当自己断掉。
  await client.closed
})

it('keeps a host alive that keeps answering pings', async () => {
  const { port } = await relay({ heartbeatIntervalMs: 40, pongTimeoutMs: 400 })
  const client = await host(port)
  client.json(T.register, 0, { instanceId: 'box' })
  await client.next(frame => frame.type === T.registered)
  // 老实回 pong 的人不该被踢。
  for (let round = 0; round < 4; round += 1) {
    await client.next(frame => frame.type === T.ping, 2_000)
    client.send(T.pong, 0, null)
    await new Promise(done => setTimeout(done, 45))
  }
  expect(client.frames.some(frame => frame.type === T.wsError)).toBe(false)
})

it('forgets an instance when its tunnel closes', async () => {
  const { port, relay: server } = await relay()
  const client = await host(port)
  client.json(T.register, 0, { instanceId: 'box' })
  await client.next(frame => frame.type === T.registered)
  expect(server.instances()).toContain('box')
  await client.close()
  // 断开之后要真的从表里消失：一个「还登记着但没人接」的 id 会让手机每个请求都等到超时。
  await new Promise(done => setTimeout(done, 100))
  expect(server.instances()).not.toContain('box')
})

it('demands the register secret when one is configured', async () => {
  const { port } = await relay({ registerSecret: 'correct-horse' })
  const forged = await host(port)
  forged.json(T.register, 0, { instanceId: 'box', secret: 'wrong' })
  const refused = await forged.next(frame => frame.type === T.wsError || frame.type === T.registered)
  expect(refused.type).toBe(T.wsError)

  const honest = await host(port)
  honest.json(T.register, 0, { instanceId: 'box', secret: 'correct-horse' })
  expect((await honest.next(frame => frame.type === T.wsError || frame.type === T.registered)).type).toBe(T.registered)
})

it('accepts the register secret in the handshake header too', async () => {
  // 密钥放 URL 查询串里会进反代日志。放 Authorization 头能避开这一点，也更符合「凭据不出现在 URL」。
  const { port } = await relay({ registerSecret: 'correct-horse' })
  const client = await host(port, { headers: { authorization: 'Bearer correct-horse' } })
  client.json(T.register, 0, { instanceId: 'box' })
  expect((await client.next(frame => frame.type === T.wsError || frame.type === T.registered)).type).toBe(T.registered)
})

it('rejects an instance id that is not a plausible identifier', async () => {
  // instanceId 会进路由表、进日志、进 URL。一个带 `/` 或空白的 id 能让路由二义。
  const { port } = await relay()
  for (const instanceId of ['', 'has space', 'a/b', 'x'.repeat(200), '../etc']) {
    const client = await host(port)
    client.json(T.register, 0, { instanceId })
    const refused = await client.next(frame => frame.type === T.wsError || frame.type === T.registered)
    expect(refused.type, instanceId).toBe(T.wsError)
  }
})

it('answers a health check with what it is holding', async () => {
  const { port, url } = await relay()
  const client = await host(port)
  client.json(T.register, 0, { instanceId: 'box' })
  await client.next(frame => frame.type === T.registered)

  const answer = await fetch(`${url}/health`)
  expect(answer.status).toBe(200)
  // 公开视图只回答「活着、挂着几条隧道」，不列 id（见下一条测试）。
  const body = await answer.json() as { ok: boolean; tunnels: number; uptimeMs: number }
  expect(body.ok).toBe(true)
  expect(body.tunnels).toBe(1)
  expect(body.uptimeMs).toBeGreaterThanOrEqual(0)
})

it('does not list instance ids on the bare health path without going through the checks', async () => {
  // 健康检查是公开的（给反代和探活用），所以它不能泄露谁的机器在线。
  const { port, url } = await relay()
  const client = await host(port)
  client.json(T.register, 0, { instanceId: 'secret-box-name' })
  await client.next(frame => frame.type === T.registered)

  const publicAnswer = await fetch(`${url}/health`)
  const text = await publicAnswer.text()
  expect(text).not.toContain('secret-box-name')
})

it('shows instance ids only to a caller holding the admin token', async () => {
  const { port, url } = await relay({ adminToken: 'admin-secret' })
  const client = await host(port)
  client.json(T.register, 0, { instanceId: 'secret-box-name' })
  await client.next(frame => frame.type === T.registered)

  const refused = await fetch(`${url}/health?detail=1`)
  expect(refused.status).toBe(401)
  const allowed = await fetch(`${url}/health?detail=1`, { headers: { authorization: 'Bearer admin-secret' } })
  expect(allowed.status).toBe(200)
  const body = await allowed.json() as { instances: { instanceId: string }[] }
  expect(body.instances.map(entry => entry.instanceId)).toContain('secret-box-name')
})

it('survives a client that sends garbage instead of frames', async () => {
  const { port } = await relay()
  const client = await host(port)
  // 完全不是 WS 帧的字节。服务端必须断开这条连接而不是把字节当帧解。
  client.raw(Buffer.from('this is not a websocket frame at all'))
  await client.closed
})

it('rejects a frame whose header claims 4GB instead of allocating it', async () => {
  const { port } = await relay({ maxFrameBytes: 1024 })
  const client = await host(port)
  client.json(T.register, 0, { instanceId: 'box' })
  await client.next(frame => frame.type === T.registered)
  // 一个只带头的畸形帧，length 字段写 0xFFFFFFF0。服务端不该为它分配内存。
  const header = Buffer.alloc(14)
  header[0] = 0x82 // binary, FIN
  header[1] = 0x80 | 127 // masked, 64-bit length
  header.writeUInt32BE(0xffff_fff0, 2)
  header.writeUInt32BE(0xffff_fff0, 6)
  header.writeUInt32BE(0xffff_ffff, 10)
  client.raw(header)
  await client.closed
})

it('rejects a plain HTTP request on the tunnel path', async () => {
  const { url } = await relay()
  const answer = await fetch(`${url}/tunnel`)
  // 不是升级请求：直接拒，不给任何页面。
  expect(answer.status).toBeGreaterThanOrEqual(400)
})

it('closes twice without complaining', async () => {
  const created = createRelay()
  await created.listen(0, '127.0.0.1')
  await created.close()
  await expect(created.close()).resolves.toBeUndefined()
})

it('rejects registration payloads that are not JSON objects', async () => {
  const { port } = await relay()
  const client = await host(port)
  // 控制帧形状是对象；一个标量 payload 不该让服务端抛错。
  client.send(T.register, 0, '"just a string"')
  const refused = await client.next(frame => frame.type === T.wsError || frame.type === T.registered)
  expect(refused.type).toBe(T.wsError)
})
