import { networkInterfaces } from 'node:os'
import { expect, it } from 'vitest'
import { bindAddress, bindCandidates, createLanServer, lanPort } from '../src/app/lan-server.ts'

const blank = () => ({ allows: () => true, list: () => [], cfg: undefined }) as never

// 手机连的那条路是一个独立监听：它不经过 Connection，所以凭据校验必须自己做。
// 这是 AI-HUB 的做法（lib/relay/lan-proxy.js），也是 Connection 那套 launch-token 体系之外唯一的选择。
it('answers only requests carrying a credential the crew issued', async () => {
  const seen: string[] = []
  const server = createLanServer({
    devices: { allows: (deviceId: string, token: string) => token === 'good' && deviceId === 'phone-1' } as never,
    forward: async (request) => {
      seen.push(request.url)
      return Response.json({ ok: true })
    },
  })
  const port = await server.listen(0, '127.0.0.1')
  try {
    const url = `http://127.0.0.1:${port}/api/mobile/timeline`
    // 没有凭据、凭据错了，都进不去，而且不给出去哪儿错了的线索。
    const attempts: Record<string, string>[] = [{}, { 'x-crew-device': 'phone-1', 'x-crew-credential': 'bad' }]
    for (const headers of attempts) {
      const refused = await fetch(url, { headers })
      expect(refused.status).toBe(401)
    }
    expect(seen).toEqual([])

    const allowed = await fetch(url, { headers: { 'x-crew-device': 'phone-1', 'x-crew-credential': 'good' } })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ ok: true })
    // 验过之后才转发，转发的是同一条路径。
    expect(seen).toEqual(['/api/mobile/timeline'])
  } finally {
    await server.close()
  }
})

// 首次配对时这台设备还没有凭据可出示。放行的只有「交一支码」这一跳，别的路径仍然要凭据，
// 否则整条局域网消息面就对着没有凭据的人敞开了。
it('lets a code be redeemed without a credential, and nothing else through', async () => {
  const seen: string[] = []
  const server = createLanServer({
    devices: { allows: () => false } as never,
    forward: async (request) => { seen.push(`${request.method} ${request.url}`); return Response.json({ ok: true }) },
  })
  const port = await server.listen(0, '127.0.0.1')
  try {
    const base = `http://127.0.0.1:${port}/api/mobile`
    // 兑换不需要凭据：码就是这一跳的凭据。
    const paired = await fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456', deviceId: 'crew-desktop' }) })
    expect(paired.status).toBe(200)
    expect(seen).toEqual(['POST /api/mobile/pair'])
    // 同一台设备读时间线仍然进不去。
    const refused = await fetch(`${base}/timeline`)
    expect(refused.status).toBe(401)
    // GET 不算兑换：只有 POST 那一下放行。
    const wrongMethod = await fetch(`${base}/pair`)
    expect(wrongMethod.status).toBe(401)
    expect(seen).toHaveLength(1)
  } finally {
    await server.close()
  }
})

// 放行「交一支码」之后，6 位码就是这条路上唯一的凭据。按来源地址限速，
// 否则局域网里一台机器可以在几分钟内把它穷举完。
it('rate-limits pairing attempts from one address', async () => {
  let forwarded = 0
  const server = createLanServer({
    devices: { allows: () => false } as never,
    forward: async () => { forwarded += 1; return Response.json({ ok: true }) },
  })
  const port = await server.listen(0, '127.0.0.1')
  try {
    const url = `http://127.0.0.1:${port}/api/mobile/pair`
    const statuses: number[] = []
    for (let attempt = 0; attempt < 25; attempt++) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      statuses.push(response.status)
    }
    // 前 20 次照常走到处理器，之后一律 429。
    expect(statuses.slice(0, 20).every(status => status === 200)).toBe(true)
    expect(statuses.slice(20).every(status => status === 429)).toBe(true)
    expect(forwarded).toBe(20)
  } finally {
    await server.close()
  }
})

it('reports a port the OS picked so the caller can advertise it', async () => {
  const server = createLanServer({ devices: blank(), forward: async () => Response.json({}) })
  const port = await server.listen(0, '127.0.0.1')
  expect(port).toBeGreaterThan(0)
  await server.close()
})

// 绑定地址必须是具体的一块网卡，不能是 0.0.0.0：dsh-host-webserver 的 Config 在加载时
// 就拒绝未指定地址（那等于把端口开到所有网卡上）。所以从这套机器的地址里挑一个。
it('picks one concrete IPv4 to bind, never a wildcard', () => {
  const chosen = bindAddress([
    { address: '127.0.0.1', family: 'IPv4' },
    { address: '192.168.31.127', family: 'IPv4' },
    { address: '2409:8a55::1', family: 'IPv6' },
  ])
  expect(chosen).toBe('192.168.31.127')

  // 只有回环时就绑回环：退到本机可用，而不是开成 0.0.0.0。
  expect(bindAddress([{ address: '127.0.0.1', family: 'IPv4' }])).toBe('127.0.0.1')
  expect(bindAddress([])).toBe('127.0.0.1')
})

it('never returns 0.0.0.0 or :: no matter what it is given', () => {
  for (const wildcard of ['0.0.0.0', '::', '::0']) {
    expect(bindAddress([{ address: wildcard, family: 'IPv4' }])).not.toBe(wildcard)
  }
})

it('derives a stable port from the state directory so a restart keeps the same one', () => {
  const first = lanPort('/Users/someone/.dsh/state/superagent')
  // 同一个目录永远同一个端口：重启之后手机不用改地址。
  expect(lanPort('/Users/someone/.dsh/state/superagent')).toBe(first)
  // 不同目录不同端口，两台机器不会撞。
  expect(lanPort('/Users/someone/.dsh/state/other')).not.toBe(first)
  expect(first).toBeGreaterThan(1024)
  expect(first).toBeLessThan(65536)
})

// 接进插件生命周期：启动时拉起，停止时关掉。不关的话端口会一直被占着，
// 下次启动撞端口失败。
it('starts with the crew and is gone after it stops', async () => {
  const server = createLanServer({ devices: blank(), forward: async () => Response.json({ ok: true }) })
  const port = await server.listen(0, '127.0.0.1')
  expect(port).toBeGreaterThan(0)
  await server.close()

  // 关掉之后同一个端口应该能立刻被重新绑上，说明连接没被漏着。
  const again = createLanServer({ devices: blank(), forward: async () => Response.json({ ok: true }) })
  await again.listen(port, '127.0.0.1')
  await again.close()
})

it('closes twice without complaining', async () => {
  const server = createLanServer({ devices: blank(), forward: async () => Response.json({ ok: true }) })
  await server.listen(0, '127.0.0.1')
  await server.close()
  // 插件停止可能走两条路都调一次；第二次不该抛。
  await expect(server.close()).resolves.toBeUndefined()
})

// 插件停得比 listen 快时（启动即失败、热重载），close 必须在 listen 落地之后也生效，
// 否则会留下一个没人管的监听，端口永远占着。
it('closes a listener even when close arrives before listen finishes', async () => {
  const server = createLanServer({ devices: blank(), forward: async () => Response.json({}) })
  const opening = server.listen(0, '127.0.0.1')
  await server.close()
  const port = await opening
  expect(port).toBeGreaterThan(0)
  // 无论谁先谁后，最终都不该还在听。
  await expect(fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-crew-device': 'a', 'x-crew-credential': 'b' } }))
    .rejects.toThrow()
})

// 这台机器上有 EasyTier 的虚拟网卡（utun4 / 10.10.10.3）。绑到它上面，手机在局域网里连不到，
// 而且症状是「明明在同一个 Wi-Fi 却说连不上」，很难查。所以虚拟网卡要排到真网卡之后。
it('prefers a real interface over a virtual one', () => {
  const chosen = bindAddress([
    { address: '127.0.0.1', family: 'IPv4', internal: true, name: 'lo0' },
    { address: '10.10.10.3', family: 'IPv4', internal: false, name: 'utun4' },
    { address: '192.168.31.127', family: 'IPv4', internal: false, name: 'en0' },
  ])
  expect(chosen).toBe('192.168.31.127')
})

it('still gives an address when only a virtual interface is online', () => {
  // 只剩隧道在网络里时也要能绑：那是唯一能用的路，不该退回回环。
  expect(bindAddress([
    { address: '127.0.0.1', family: 'IPv4', internal: true, name: 'lo0' },
    { address: '10.10.10.3', family: 'IPv4', internal: false, name: 'utun4' },
  ])).toBe('10.10.10.3')
})

it('never picks an internal interface while a routable one exists', () => {
  expect(bindAddress([
    { address: '127.0.0.1', family: 'IPv4', internal: true, name: 'lo0' },
    { address: '169.254.1.1', family: 'IPv4', internal: false, name: 'en9' },
  ])).toBe('169.254.1.1')
})

// 这条路只服务手机消息面。别的路径不接，免得将来消息面长出别的接口时被这条自动放出去。
it('refuses paths outside the phone surface even with a good credential', async () => {
  const seen: string[] = []
  const server = createLanServer({
    devices: { allows: () => true } as never,
    forward: async request => { seen.push(request.url); return Response.json({ ok: true }) },
  })
  const port = await server.listen(0, '127.0.0.1')
  try {
    const headers = { 'x-crew-device': 'phone-1', 'x-crew-credential': 'good' }
    for (const path of ['/api/tickets', '/orchestrator/api/settings', '/']) {
      expect((await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status).toBe(404)
    }
    // 一条都没转出去。
    expect(seen).toEqual([])
    // 正常路径照常。
    expect((await fetch(`http://127.0.0.1:${port}/api/mobile/timeline`, { headers })).status).toBe(200)
    expect(seen).toEqual(['/api/mobile/timeline'])
  } finally {
    await server.close()
  }
})

// 只绑一块网卡会漏掉别的网络。实测症状：绑了 192.168.31.127 之后，
// 模拟器走 10.0.2.2（映射到宿主机）连不上，本机 127.0.0.1 也连不上。
// 所以要么绑多块，要么每种地址都能走。
it('a candidate list names every address the phone could reach', () => {
  const list = bindCandidates([
    { address: '127.0.0.1', family: 'IPv4', internal: true, name: 'lo0' },
    { address: '10.10.10.3', family: 'IPv4', internal: false, name: 'utun4' },
    { address: '192.168.31.127', family: 'IPv4', internal: false, name: 'en0' },
  ])
  // 局域网那块要排在最前：手机最可能用它。
  expect(list[0]).toBe('192.168.31.127')
  // 回环要留着：本机与模拟器（10.0.2.2 → 宿主机）走的是它。
  expect(list).toContain('127.0.0.1')
  // 通配地址永远不在里面。
  expect(list).not.toContain('0.0.0.0')
})

// 手机走局域网，本机与模拟器走回环。只绑一块会漏掉另一方，所以一个实例要能包下多个地址。
it('listens on several addresses at once with one server', async () => {
  const server = createLanServer({ devices: blank(), forward: async () => Response.json({ ok: true }) })
  const port = 45677
  // 用本机真实存在的两个地址：回环与局域网。127.0.0.2 在 macOS 的 lo0 上默认不响应。
  const lan = Object.values(networkInterfaces()).flat()
    .find(item => item && item.family === 'IPv4' && !item.internal)?.address
  const hosts = lan ? ['127.0.0.1', lan] : ['127.0.0.1']
  const bound = await server.listenAll(port, hosts)
  expect(bound.length).toBe(hosts.length)
  try {
    const headers = { 'x-crew-device': 'a', 'x-crew-credential': 'b' }
    for (const address of hosts) {
      const answered = await fetch(`http://${address}:${port}/api/mobile/timeline`, { headers })
      expect(answered.status).toBe(200)
    }
  } finally {
    await server.close()
  }
})

// 其中一个地址绑不上（端口被别的程序占了、网卡刚掉线）时，其余地址照常工作。
it('keeps the addresses it could bind when one fails', async () => {
  const server = createLanServer({ devices: blank(), forward: async () => Response.json({ ok: true }) })
  try {
    const bound = await server.listenAll(45678, ['127.0.0.1', '203.0.113.9'])
    // 保留能绑上的那个，坏掉的跳过。
    expect(bound).toContain('127.0.0.1')
  } finally {
    await server.close()
  }
})
