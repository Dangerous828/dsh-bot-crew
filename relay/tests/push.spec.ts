import { afterEach, expect, it } from 'vitest'
import { createRelay, type Relay } from '../src/server.ts'
import { connectTunnel, T, type RelayClient } from './fixtures/tunnel-client.ts'

/**
 * 推送：中转是唯一知道「这台手机此刻在不在线」的地方（它挂着隧道），
 * 所以投递判定只能在这里做。这一组钉住四件事：
 * 登记、在线直送、离线攒着、连上来时补发。
 */
const running: { relay: Relay; clients: RelayClient[] }[] = []
afterEach(async () => {
  for (const entry of running.splice(0)) {
    for (const client of entry.clients) await client.close().catch(() => {})
    await entry.relay.close()
  }
})

async function relay(): Promise<{ port: number }> {
  const created = createRelay({})
  const port = await created.listen(0, '127.0.0.1')
  running.push({ relay: created, clients: [] })
  return { port }
}

async function host(port: number, instanceId = 'box-1'): Promise<RelayClient> {
  const client = await connectTunnel({ port })
  running.at(-1)!.clients.push(client)
  client.json(T.register, 0, { instanceId, name: '我的电脑' })
  await client.next(frame => frame.type === T.registered)
  return client
}

const DEVICE = 'dev_abc123'

it('hands a push to a device that has registered itself', async () => {
  const { port } = await relay()
  const box = await host(port)
  box.json(T.pushRegister, 0, { deviceId: DEVICE, platform: 'android', token: 't' })
  // 登记与投递都在同一条隧道上，顺序由中转保证。
  box.json(T.pushSend, 0, { deviceId: DEVICE, title: '有事等你', body: '「修卡顿」在等你回答', kind: 'followup' })
  const delivered = await box.next(frame => frame.type === T.pushSend)
  const payload = JSON.parse(String(delivered.payload))
  expect(payload).toMatchObject({ deviceId: DEVICE, title: '有事等你', body: '「修卡顿」在等你回答', kind: 'followup' })
})

it('keeps a push for a device that is not attached, then flushes it on register', async () => {
  const { port } = await relay()
  const box = await host(port)
  // 设备还没登记就说要发：中转攒着，不假装送到。
  box.json(T.pushSend, 0, { deviceId: DEVICE, title: '日报', body: '办完 3 件', kind: 'daily' })
  // 等一小会儿确保中转处理完了再登记。
  await new Promise(resolve => setTimeout(resolve, 80))
  box.json(T.pushRegister, 0, { deviceId: DEVICE, platform: 'android', token: 't' })
  const flushed = await box.next(frame => frame.type === T.pushSend)
  expect(JSON.parse(String(flushed.payload))).toMatchObject({ body: '办完 3 件', kind: 'daily' })
})

it('keeps only the newest push of one kind while a device is away', async () => {
  const { port } = await relay()
  const box = await host(port)
  for (const body of ['第一次', '第二次', '第三次']) {
    box.json(T.pushSend, 0, { deviceId: DEVICE, title: '有事', body, kind: 'followup' })
  }
  await new Promise(resolve => setTimeout(resolve, 80))
  box.json(T.pushRegister, 0, { deviceId: DEVICE, platform: 'android', token: 't' })
  const flushed = await box.next(frame => frame.type === T.pushSend)
  expect(JSON.parse(String(flushed.payload)).body).toBe('第三次')
})

it('ignores a push with a malformed device id or an empty body', async () => {
  const { port } = await relay()
  const box = await host(port)
  box.json(T.pushRegister, 0, { deviceId: 'not-a-device', platform: 'android', token: 't' })
  box.json(T.pushSend, 0, { deviceId: DEVICE, title: 'x', body: '   ' })
  box.json(T.pushSend, 0, { deviceId: 'bad', title: 'x', body: '真的有事' })
  // 合法的这一条应当照常送到（前面两条被丢掉，连接没断）。
  box.json(T.pushRegister, 0, { deviceId: DEVICE, platform: 'android', token: 't' })
  box.json(T.pushSend, 0, { deviceId: DEVICE, title: '正常', body: '真的有事' })
  const delivered = await box.next(frame => frame.type === T.pushSend && String(frame.payload).includes('真的有事'))
  expect(JSON.parse(String(delivered.payload)).deviceId).toBe(DEVICE)
})
