/**
 * 隔离 canary 后端（真机 /answer 验收用）。**不碰生产**：独立 stateDir（临时）、独立端口、独立 mobilegw。
 *
 * 起的东西：
 *   - 一个全新临时目录 <base>/state（mobileq.db / mobilegw.token / orchestrator.sqlite 全在里面，非真库副本）；
 *   - 一个真 DSH Context + 真 `Runtime`（真 store/sessions/executor，手机面用真 `phoneHandler`）；
 *   - 预置：mobileq.db 里一条真实 inbound + 一张真 ticket，并**真的调用 Runtime.guardConnection** 产出一张
 *     connection 写审批（ticket.pendingApproval(waiting)+attention{做吧/先别做/换个做法}）；
 *   - 一个独立 mobilegw（MOBILEGW_STATE + MOBILEGW_PORT）；
 *   - 一个 HTTP server 把 `/api/mobile/*` 交给真 phoneHandler（timeline/answer/pair 等），LAN + 127.0.0.1 监听新端口。
 *
 * 全部写落 canary。进程退出只精确清自己这份临时目录（不看别的）。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { statSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { Runtime } from '../src/app/runtime.ts'
import { testMachine } from '../tests/fixtures/deployment.ts'
import { phoneHandler } from '../src/app/mobile-http.ts'
import { deviceStoreOf } from '../src/app/remote.ts'
import { phoneGate, presentedDevice } from '../src/app/phone-gate.ts'

const DSH = process.env.DSH_NODE_MODULES ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai'
const dsh = (name: string): Promise<any> => import(`${DSH}/${name}/lib/index.js`)
const MOBILEQ = new URL('../tools/mobileq', import.meta.url).pathname
const MESSAGES_MCP = new URL('../src/integrations/messages-mcp/messages-mcp', import.meta.url).pathname

const BACKEND_PORT = Number(process.env.CANARY_BACKEND_PORT ?? 8799)
const GW_PORT = Number(process.env.CANARY_GW_PORT ?? 8798)
const base = mkdtempSync(join(tmpdir(), 'canary-answer-'))
const stateDir = join(base, 'state')
const db = join(stateDir, 'mobileq.db')

/** Fail (do NOT kill anyone) if a TCP port is already in use — a reused port could be someone else's process. */
function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', (e: any) => reject(new Error(`port ${port} is already in use (${e.code}); refusing to start — pick a free CANARY_*_PORT (never kill an unknown PID)`)))
    srv.once('listening', () => srv.close(() => resolve()))
    srv.listen(port, '0.0.0.0')
  })
}

const sql = (q: string) => JSON.parse(execFileSync('python3', ['-c',
  'import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute(sys.argv[2]).fetchall()))', db, q], { encoding: 'utf8' }).trim())

async function main() {
  // ── preflight (fail closed, never kill an unknown PID) ──
  await assertPortFree(BACKEND_PORT)
  await assertPortFree(GW_PORT)
  // fresh canary state dir
  execFileSync('mkdir', ['-p', stateDir])
  writeFileSync(join(stateDir, 'mobilegw.token'), randomBytes(24).toString('base64url'))
  // seed real inbound
  execFileSync('python3', [MOBILEQ, '--db', db, 'inject', '--conversation', 'main', '--sender', 'owner', '--text', 'canary：请回一句'])
  const parent = String((sql('SELECT max(id) FROM messages') as number[][])[0]![0]!)
  // ── 机械核：canary DB 的 dev:inode 必须 ≠ 生产库（证明独立文件、非生产副本）──
  { const PROD = join(process.env.HOME ?? '', '.dsh/state/superagent/mobileq.db')
    const cs = statSync(db), ps = (() => { try { return statSync(PROD) } catch { return undefined } })()
    if (ps && cs.dev === ps.dev && cs.ino === ps.ino) throw new Error(`refusing: canary DB is the production file (same dev:inode) — ${db}`)
    console.log('[canary] db dev:inode', cs.dev + ':' + cs.ino, 'prod', ps ? ps.dev + ':' + ps.ino : '(absent)') }

  // ── real DSH context + Runtime ──
  const M: Record<string, any> = {}
  for (const n of ['cordis', 'dsh-session-projection', 'dsh-subprocess-local', 'dsh-session', 'dsh-system-prompt',
    'dsh-tools', 'dsh-llm', 'dsh-agent', 'dsh-agent-loop', 'dsh-permission-presets', 'dsh-user-approval',
    'dsh-attachment-local', 'dsh-working-directory', 'dsh-bash-sandbox', 'dsh-shell-env']) M[n] = await dsh(n)
  let nativeExec: any; try { nativeExec = await dsh('dsh-tool-executor-native') } catch { nativeExec = undefined }
  const mcp: any = await dsh('dsh-mcp-client'); const jsonl: any = await dsh('dsh-session-persistence-jsonl')
  const ctx = new Context()
  const plug = (p: any) => { try { const r: any = ctx.plugin(p); if (r && typeof r.catch === 'function') r.catch(() => undefined) } catch { /* */ } }
  plug(M['dsh-session-projection'].default); plug(M['dsh-subprocess-local'].default); plug(M['dsh-session'].default)
  plug(M['dsh-system-prompt'].default); plug(M['dsh-tools'].default); plug(M['dsh-llm'].default)
  if (nativeExec) plug({ name: 'native-tool-executor', inject: nativeExec.inject, apply: (c: any) => nativeExec.apply(c) })
  plug(M['dsh-working-directory'].default)
  plug({ name: 'attachment-local', inject: M['dsh-attachment-local'].inject, apply: (c: any) => M['dsh-attachment-local'].apply(c, { root: join(stateDir, 'att') }) })
  plug({ name: 'bash-sandbox', inject: M['dsh-bash-sandbox'].inject, apply: (c: any) => M['dsh-bash-sandbox'].apply(c, { cwd: stateDir, timeoutMs: 10000, maxTimeoutMs: 10000 }) })
  plug({ name: 'shell-env', inject: M['dsh-shell-env'].inject, apply: (c: any) => M['dsh-shell-env'].apply(c, M['dsh-shell-env'].Config({})) })
  plug({ name: 'approval', inject: M['dsh-user-approval'].inject, apply: (c: any) => M['dsh-user-approval'].apply(c, {}) })
  plug({ name: 'permission-presets', inject: M['dsh-permission-presets'].inject, apply: (c: any) => M['dsh-permission-presets'].apply(c, {
    presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'never' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } },
    defaultPreset: 'danger-full-access' }) })
  plug(M['dsh-agent'].default); plug(M['dsh-agent-loop'].default)
  await new Promise(r => setTimeout(r, 400))
  await jsonl.apply(ctx, { root: stateDir }).catch(() => undefined)
  plug({ name: 'mcp-messages', inject: mcp.inject, apply: (c: any) => mcp.apply(c, { transport: 'stdio', serverName: 'messages', command: MESSAGES_MCP, args: [],
    env: { MESSAGES_MCP_DB: db, MESSAGES_MCP_CLI: MOBILEQ }, toolCallTimeoutMs: 60000, startupTimeoutMs: 15000 }) })
  for (let i = 0; i < 80; i++) {
    const v = (ctx.get('tools') as any)?.view?.()
    if (v && [...v.visible.keys()].some((n: string) => n === 'mcp__messages__send_message')) break
    await new Promise(r => setTimeout(r, 100))
  }

  // minimal services Runtime reads at construction (same set as the probe that resolved ready-ok)
  // 只补真插件没提供的服务（agents/llm/sessionPersistence/permissionPresets 由真 dsh 插件提供，别重复 provide）。
  const ensure = (name: string, svc: unknown) => { if (ctx.get(name) === undefined) ctx.reflect.provide(name, svc) }
  ensure('webServer', { host: '127.0.0.1', port: 0, register: () => () => {} })
  ensure('sessionPersistence', { flush: async () => {}, open: async () => ({ read: async () => ({ events: [] }) }) })
  ensure('llm', { resolveCallConfig: async (v: unknown) => v })
  // real sessionController IO adapter (delegates to the real agents factory / AgentLoop)
  ctx.reflect.provide('sessionController', {
    async resolveAgent(sessionId: string) { const live = (ctx.get('agents') as any).get(sessionId); return live ? { agent: live } : { error: { code: 'session/not-found' } } },
    async create({ sessionId }: { sessionId: string }) { await (ctx.get('agents') as any).create({ sessionId, agentOptions: { provider: 'stub', model: 'stub-1' }, meta: { cwd: stateDir } }) },
    async rename() {}, selectModel: async () => {},
  })
  ensure('workspaceRegistry', { create: async (cwd: string) => ({ id: cwd }), list: () => [] })
  ensure('permissionPresets', { set: () => {} })
  // scripted deterministic model: emits the CURRENT nextCall once per fresh turn (last message not a tool result).
  let nextCall: { name: string; args: Record<string, unknown> } | undefined
  { const { LlmAdapter } = M['dsh-llm']
    ctx.llm.registerAdapter(['stub'], new (class extends LlmAdapter {
      async *stream(options: any) {
        const last = options.messages.at(-1)
        if (!nextCall || last?.role === 'tool') {
          yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'done' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }; yield { type: 'finish', reason: { kind: 'completed' } }; return
        }
        const a = JSON.stringify(nextCall.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: 'c0', name: nextCall.name, argumentsDelta: a }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c0', name: nextCall.name, arguments: a } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    })() as any) }
  // register minimal stub work tools so the real workOnly restrict validates (real deployment supplies these from the profile)
  { const toolsSvc = ctx.get('tools') as any
    const WORK = ['memory_write','memory_read','memory_list','memory_search','mcp__magpie__hub_memory__hub_memory_search','mcp__magpie__hub_memory__hub_memory_get','mcp__magpie__hub_memory__hub_memory_recent','mcp__magpie__hub_memory__hub_memory_list','read','write','edit','read_image','glob','grep','bash','pwsh','job_output','job_list','job_kill','web_search','web_fetch','skill','todo_write','subagent','list_subagent_models','send_message','list_agents','interrupt_agent']
    for (const nm of WORK) { if (!toolsSvc.view().visible.has(nm) && !(toolsSvc.view().knownNames?.has?.(nm))) { try { ctx.effect(() => toolsSvc.register({ name: nm, description: 'stub', parameters: { type: 'object', additionalProperties: true }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ ok: true }) })) } catch { /* */ } } } }
  // pre-seed settings: github/feishu off (mobile-only) so setup.configured() is true and the executor is not paused.
  { const { Store } = await import('../src/app/store.ts'); const pre = new Store(join(stateDir, 'orchestrator.sqlite')); const cur = pre.settings()
    pre.saveSettings({ ...cur, sources: { ...cur.sources, github: { ...(cur.sources as any)?.github, enabled: false }, feishu: { ...(cur.sources as any)?.feishu, enabled: false } } }); pre.close() }
  const devices = deviceStoreOf(stateDir, 'code')
  const runtime: any = new Runtime(ctx, testMachine({ stateDir }), () => {})
  // attach device store so /pair works (same as index.ts)
  ;(runtime as any).remote = devices
  ;(runtime as any).answer = (tid: string, text: string, attentionId: string, actor: string | undefined) =>
    (runtime as any).answerTicket(tid, text, attentionId, actor)
  await Promise.race([runtime.ready, new Promise(r => setTimeout(r, 3000))])

  // seed settings: messages connection read3/write1
  runtime.store.saveSettings({ ...runtime.store.settings(), connections: { readOnly: true,
    connections: [{ kind: 'messages', server: 'messages', readTools: ['list_channels', 'list_messages', 'get_message'], writeTools: ['send_message'] }] } })

  // Seed a ticket with ONE real pending assignment, then drive the REAL DshExecutor.start so a real worker runs the
  // turn → hits the real workOnly guard → guardConnection produces a genuine connection write approval (waiting).
  // Phone 做吧 → answerTicket approves → executor auto re-delivers → real MCP stdio replies +1 (real business effect).
  let ticketSeq = 0
  const seedTicket = async () => {
    const id = 'canary-answer-' + (++ticketSeq)
    const now = new Date().toISOString()
    runtime.store.tickets.save({
      id, title: 'canary 审批验收票 ' + id, decisionId: 'canary-D-' + id, mandate: { strength: 'explicit' },
      channels: [{ source: 'mobile', thread: 'mobile:main:' + parent, address: { conversation: 'main', message: parent } }],
      assignments: [{ id: 'assignment-' + id + '-0', state: 'pending', createdAt: now }],
      inputs: [], undelivered: [], createdAt: now, updatedAt: now,
      origin: { triggerId: 'canary-trig-' + id, triggerIds: ['canary-trig-' + id] },
      execution: { name: 'accept', directory: stateDir, assignment: 'canary approval demo ' + id },
    })
    nextCall = { name: 'mcp__messages__send_message', args: { channel: 'main', to: parent, text: 'canary 批准后回话 ' + id, key: 'canary-reply-' + id } }
    runtime.executor.start(runtime.store.tickets.get(id), runtime.store.tickets.get(id).assignments[0])
    let attn: any
    for (let i = 0; i < 120; i++) { const t = runtime.store.tickets.get(id); if (t.pendingApproval?.status === 'waiting' && t.attention) { attn = t.attention; break } await new Promise(r => setTimeout(r, 100)) }
    if (!attn) throw new Error('executor did not raise a pending approval for ' + id)
    return { ticket: id, attention_id: attn.id, options: (attn.options ?? []).map((o: any) => o.label), question: attn.question,
      old_attention_id_for_409: 'attention-connection-' + id + '-OLD-STALE-SIGNATURE', inbound_parent: parent,
      note: 'phone 做吧 → 真执行器自动重投递 → 真 MCP stdio replies +1；先别做 → stop 零写（每票一次性）。' }
  }
  const firstTicket = await seedTicket()
  const ticketId = firstTicket.ticket
  const attentionId = firstTicket.attention_id
  const options = firstTicket.options
  const oldAttentionId = firstTicket.old_attention_id_for_409

  // start canary mobilegw
  const gw = spawn('python3', [new URL('../tools/mobilegw', import.meta.url).pathname], {
    env: { ...process.env, MOBILEGW_STATE: stateDir, MOBILEGW_PORT: String(GW_PORT), MOBILEGW_HOST: '127.0.0.1', DSH_HOME: base },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  await new Promise(r => setTimeout(r, 800))

  // serve phoneHandler on LAN + 127.0.0.1
  const gatewayUrl = `http://127.0.0.1:${GW_PORT}`
  const handler = phoneHandler(runtime, gatewayUrl)
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const bodyBuf = Buffer.concat(chunks)
    // 本机 control：重造一张新待批票（真 guardConnection 产出）。仅本机用，dev-only。
    const u = new URL(`http://dsh${req.url ?? '/'}`)
    if (u.pathname === '/_canary/new-ticket') {
      try { const t = await seedTicket(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(t)); return }
      catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); return }
    }
    if (u.pathname === '/_canary/new-code') {
      try { const code = devices.issue('', 10 * 60 * 1000)
        // 写回 canary-info.json 的 pairing_code（wb3-device-verify 读文件，不打印码）
        let info: any = {}; try { info = JSON.parse(readFileSync(join(base, 'canary-info.json'), 'utf8')) } catch { /* */ }
        info.pairing_code = code; info.pairing_issued_at = new Date().toISOString()
        writeFileSync(join(base, 'canary-info.json'), JSON.stringify(info, null, 2))
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, pairing_code_updated: true, info_path: join(base, 'canary-info.json') })); return
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); return }
    }
    if (u.pathname === '/_canary/state') {
      const rows = runtime.store.tickets.list().filter((t: any) => t.id.startsWith('canary-answer-')).map((t: any) => ({ ticket: t.id, ended: !!t.ended, pendingApproval: t.pendingApproval ?? null, attention_id: t.attention?.id ?? null }))
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(rows)); return
    }
    // ── 与真实部署同源的认证/principal 注入（照 index.ts 的 phoneGate + presentedDevice + ask）──
    // 1) 先过 phoneGate：非 /pair 的 /api/mobile/* 必须出示已配对凭据，否则 401「Not paired」。
    const gate = phoneGate({ pathname: u.pathname, method: req.method ?? 'GET', headers: req.headers as any, devices })
    if (gate) { const b = Buffer.from(await gate.arrayBuffer()); res.writeHead(gate.status, Object.fromEntries(gate.headers)); res.end(b); return }
    // 2) principal 只来自验过的 presentedDevice；重建请求头：**剔掉客户端自带的 x-crew-principal**（防伪造），
    //    保留会话头，仅在验过时注入内部 x-crew-principal。绝不把客户端 x-crew-device 当身份。
    const headers: Record<string, string> = {}
    { const raw = req.headers['x-crew-session']; const v = Array.isArray(raw) ? raw.join(', ') : raw; if (typeof v === 'string') headers['x-crew-session'] = v }
    const principal = presentedDevice(req.headers as any)?.deviceId
    if (principal) headers['x-crew-principal'] = principal
    const url = `http://dsh${req.url}`
    const request = new Request(url, { method: req.method, headers, body: req.method === 'GET' ? undefined : bodyBuf })
    try {
      const resp = await handler(request)
      const buf = Buffer.from(await resp.arrayBuffer())
      res.writeHead(resp.status, Object.fromEntries(resp.headers))
      res.end(buf)
    } catch (e) { res.writeHead(500); res.end('{"error":"canary handler threw: ' + String(e).slice(0, 120) + '"}') }
  })
  // 优先小米 Wi-Fi 网段（192.168.31.x），跳过 utun/easytier/docker 虚拟网卡，真机才连得到。
  const ifaces = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).map(i => ({ name, ...i })))
    .filter(i => i.family === 'IPv4' && !i.internal && i.address)
  const pick = ifaces.find(i => /^192\.168\.31\./.test(i.address)) || ifaces.find(i => /^(192\.168\.|10\.|172\.)/.test(i.address) && !/^(10\.10\.10\.|198\.18\.)/.test(i.address)) || ifaces[0]
  const lanIp = pick?.address ?? '127.0.0.1'
  const lanName = pick?.name ?? '?'
  server.listen(BACKEND_PORT, '0.0.0.0', () => {
    const pairingCode = devices.issue('', 10 * 60 * 1000)
    const info = {
      ok: true, base127: `http://127.0.0.1:${BACKEND_PORT}`, baseLan: `http://${lanIp}:${BACKEND_PORT}`, lanIp, lanIface: lanName,
      backendPort: BACKEND_PORT, gateway: gatewayUrl, stateDir, mobileqDb: db,
      ticket: ticketId, attention_id: attentionId, options, old_attention_id_for_409: oldAttentionId,
      pairing_code: pairingCode, inbound_parent: parent,
      note: 'canary 独立实例：独立 stateDir/端口/mobilegw，只写本 canary，不碰生产。配对码 10 分钟有效（deviceId="" 认领式）。',
    }
    writeFileSync(join(base, 'canary-info.json'), JSON.stringify(info, null, 2))
    console.log('\n===CANARY_READY===\n' + JSON.stringify(info, null, 2) + '\n===/CANARY_READY===\n')
  })

  const shutdown = async () => {
    try { gw.kill('SIGTERM') } catch { /* */ }
    try { server.close() } catch { /* */ }
    try { await runtime.stop() } catch { /* */ }
    try { rmSync(base, { recursive: true, force: true }) } catch { /* */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
}

main().catch(e => { console.error('CANARY FAILED:', e); process.exit(1) })
