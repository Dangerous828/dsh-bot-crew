// 配对屏验收用的「第二行」：一个可控、可用的局域网服务测试实例。
// 它发布**真实**的 mDNS 记录（_dsh-crew._tcp），名字带 fixture- 前缀、TXT 里 crew=fixture0001，
// 与真实队伍（dsh-crew-0kvcc5t / crew=0kvcc5t）在界面上就能分辨。
// 它只实现契约里首次配对那一跳 POST /api/mobile/pair，不伪造任何产品数据。
import { createServer } from 'node:http'
import { Bonjour } from '/Users/cpuser/Code/dsh-bot-crew/backend/node_modules/bonjour-service/dist/index.js'

const PORT = Number(process.env.FIXTURE_PORT || 43991)
const NAME = process.env.FIXTURE_NAME || 'fixture-pairing-audit'
const CREW = process.env.FIXTURE_CREW || 'fixture0001'
const CODE = process.env.FIXTURE_CODE || ''

const hits = []
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(Buffer.from(c))
  const body = Buffer.concat(chunks).toString('utf8')
  hits.push({ at: new Date().toISOString(), method: req.method, url: req.url, body })
  const send = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  if (req.url === '/__fixture/hits') return send(200, { hits })
  if (req.url === '/api/mobile/pair' && req.method === 'POST') {
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}
    if (!parsed.deviceId) return send(400, { error: 'deviceId is required' })
    if (String(parsed.code) !== String(CODE)) return send(403, { error: 'Pairing refused' })
    return send(200, { deviceId: parsed.deviceId, token: 'fixture-token-not-a-real-credential',
      name: parsed.name || parsed.deviceId, platform: parsed.platform || 'android',
      pairedAt: new Date().toISOString(), fixture: true })
  }
  if (req.url?.startsWith('/api/mobile/')) return send(200, { fixture: true, note: 'fixture 服务，仅用于配对屏路径验收' })
  return send(404, { error: 'fixture only' })
})

server.listen(PORT, '0.0.0.0', () => {
  const bonjour = new Bonjour()
  const service = bonjour.publish({
    name: NAME, type: 'dsh-crew', port: PORT, protocol: 'tcp',
    txt: { crew: CREW, port: String(PORT), fixture: 'pairing-audit' },
  })
  service.on('error', e => console.log('MDNS_ERROR', e?.message))
  console.log(JSON.stringify({ ready: true, pid: process.pid, name: NAME, crew: CREW, port: PORT }))
  const stop = () => { try { service.stop(() => {}) } catch {} ; try { bonjour.destroy() } catch {} ; server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500) }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
})
