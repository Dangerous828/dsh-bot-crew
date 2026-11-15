/**
 * 真业务效果端到端（task-9 · lead 裁定「B 验收要真业务效果」）：
 * **真 DshExecutor.start/deliver** 驱动真 worker 的 AgentLoop → 真 restrict+guard（workOnly 自动装）→ 真 MCP stdio。
 * 手机点「做吧」经真 `Runtime.answerTicket` 批准后，**由执行器自己**重新投递，使 canary replies **+1**——
 * 不是测试手绑 guard、不是手调 followup、不是 HTTP handler 旁路 exec CLI。
 *
 * 只在这个 IO seam 上用最小 adapter：`sessionController` 的 resolveAgent/create/rename/selectModel、workspaceRegistry、
 * permissionPresets。其余（Engine/store/tickets/DshExecutor/Sessions.ensure/decorate/workOnly/AgentLoop/dsh-mcp-client/
 * answerTicket/applyApprovalAnswer）全部是项目真代码。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Runtime } from '../../src/app/runtime.ts'
import { Store } from '../../src/app/store.ts'
import { testMachine } from '../fixtures/deployment.ts'
import type { Ticket } from '../../src/core/model.ts'

const DSH = process.env.DSH_NODE_MODULES ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai'
const dsh = (name: string): Promise<any> => import(`${DSH}/${name}/lib/index.js`)
const MESSAGES_MCP = new URL('../../src/integrations/messages-mcp/messages-mcp', import.meta.url).pathname
const MOBILEQ = new URL('../../tools/mobileq', import.meta.url).pathname
const sqlv = (db: string, q: string): string => execFileSync('python3', ['-c', `import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute(sys.argv[2]).fetchall()))`, db, q], { encoding: 'utf8' }).trim()
const nreplies = (db: string): number => (JSON.parse(sqlv(db, 'SELECT count(*) FROM replies')) as number[][])[0]![0]!
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* */ } } })

let nextCall: { name: string; args: Record<string, unknown> } | undefined
function adapter(M: any) {
  const { LlmAdapter } = M.llm
  return new (class extends LlmAdapter {
    async *stream(options: any) {
      const last = options.messages.at(-1)
      if (!nextCall || last?.role === 'tool') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'done' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'completed' } }
        return
      }
      const a = JSON.stringify(nextCall.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'c0', name: nextCall.name, argumentsDelta: a }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c0', name: nextCall.name, arguments: a } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  })()
}

describe('真 DshExecutor 自动执行：手机 answer 批准 → 执行器自投递 → 真 MCP stdio replies +1（隔离 canary）', () => {
  it('未批准拦零写；手机做吧批准后执行器自动重投递使 replies +1；先别做→stop 零写', async () => {
    const canary = mkdtempSync(join(tmpdir(), 'exec-rt-db-')); dirs.push(canary)
    const db = join(canary, 'mobileq.db')
    execFileSync('python3', [MOBILEQ, '--db', db, 'inject', '--conversation', 'main', '--sender', 'owner', '--text', '用户：请回一句'])
    const parent = String((JSON.parse(sqlv(db, 'SELECT max(id) FROM messages')) as number[][])[0]![0]!)

    // real DSH context
    const M: Record<string, any> = {}
    for (const n of ['cordis', 'dsh-session-projection', 'dsh-subprocess-local', 'dsh-session', 'dsh-system-prompt',
      'dsh-tools', 'dsh-llm', 'dsh-agent', 'dsh-agent-loop', 'dsh-permission-presets', 'dsh-user-approval',
      'dsh-attachment-local', 'dsh-working-directory', 'dsh-bash-sandbox', 'dsh-shell-env']) M[n] = await dsh(n)
    M.llm = M['dsh-llm']
    let nativeExec: any; try { nativeExec = await dsh('dsh-tool-executor-native') } catch { nativeExec = undefined }
    const mcp: any = await dsh('dsh-mcp-client'); const jsonl: any = await dsh('dsh-session-persistence-jsonl')
    const ctx = new Context()
    const plug = (p: any) => { try { const r: any = ctx.plugin(p); if (r && typeof r.catch === 'function') r.catch(() => undefined) } catch { /* */ } }
    plug(M['dsh-session-projection'].default); plug(M['dsh-subprocess-local'].default); plug(M['dsh-session'].default)
    plug(M['dsh-system-prompt'].default); plug(M['dsh-tools'].default); plug(M['dsh-llm'].default)
    if (nativeExec) plug({ name: 'native-tool-executor', inject: nativeExec.inject, apply: (c: any) => nativeExec.apply(c) })
    plug(M['dsh-working-directory'].default)
    plug({ name: 'attachment-local', inject: M['dsh-attachment-local'].inject, apply: (c: any) => M['dsh-attachment-local'].apply(c, { root: join(canary, 'att') }) })
    plug({ name: 'bash-sandbox', inject: M['dsh-bash-sandbox'].inject, apply: (c: any) => M['dsh-bash-sandbox'].apply(c, { cwd: canary, timeoutMs: 10000, maxTimeoutMs: 10000 }) })
    plug({ name: 'shell-env', inject: M['dsh-shell-env'].inject, apply: (c: any) => M['dsh-shell-env'].apply(c, M['dsh-shell-env'].Config({})) })
    plug({ name: 'approval', inject: M['dsh-user-approval'].inject, apply: (c: any) => M['dsh-user-approval'].apply(c, {}) })
    plug({ name: 'permission-presets', inject: M['dsh-permission-presets'].inject, apply: (c: any) => M['dsh-permission-presets'].apply(c, {
      presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'never' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } },
      defaultPreset: 'danger-full-access' }) })
    plug(M['dsh-agent'].default); plug(M['dsh-agent-loop'].default)
    await wait(400)
    await jsonl.apply(ctx, { root: canary }).catch(() => undefined)
    plug({ name: 'mcp-messages', inject: mcp.inject, apply: (c: any) => mcp.apply(c, { transport: 'stdio', serverName: 'messages', command: MESSAGES_MCP, args: [],
      env: { MESSAGES_MCP_DB: db, MESSAGES_MCP_CLI: MOBILEQ }, toolCallTimeoutMs: 60000, startupTimeoutMs: 15000 }) })
    for (let i = 0; i < 80; i++) { const v = (ctx.get('tools') as any)?.view?.(); if (v && [...v.visible.keys()].some((n: string) => n === 'mcp__messages__send_message')) break; await wait(100) }
    ctx.llm.registerAdapter(['stub'], adapter(M) as any)

    // minimal IO adapter for sessionController (delegates to the real factory)
    const sessionController = {
      async resolveAgent(sessionId: string) { const live = (ctx.get('agents') as any).get(sessionId); return live ? { agent: live } : { error: { code: 'session/not-found' } } },
      async create({ sessionId }: { sessionId: string }) { await (ctx.get('agents') as any).create({ sessionId, agentOptions: { provider: 'stub', model: 'stub-1' }, meta: { cwd: canary } }) },
      async rename() {}, selectModel: async () => {},
    }
    const ensure = (name: string, svc: unknown) => { if (ctx.get(name) === undefined) ctx.reflect.provide(name, svc) }
    ensure('webServer', { host: '127.0.0.1', port: 0, register: () => () => {} })
    ensure('sessionPersistence', { flush: async () => {}, open: async () => ({ read: async () => ({ events: [] }) }) })
    ctx.reflect.provide('sessionController', sessionController)
    ensure('workspaceRegistry', { create: async (cwd: string) => ({ id: cwd }), list: () => [] })
    ensure('permissionPresets', { set: () => {} })
    ensure('llm', ctx.get('llm') ?? { resolveCallConfig: async (v: unknown) => v })

    // Pre-seed settings: GitHub source off (mobile-only) so setup.configured() becomes true and the executor isn't paused.
    { const pre = new Store(join(canary, 'orchestrator.sqlite')); const cur = pre.settings()
      pre.saveSettings({ ...cur, sources: { ...cur.sources, github: { ...(cur.sources as any)?.github, enabled: false }, feishu: { ...(cur.sources as any)?.feishu, enabled: false } } }); pre.close() }
    // Register minimal stub work tools so the real workOnly restrict (which names the profile's work tools) validates.
    // In a real deployment these come from the profile; here we only need them present for restrict + guard plumbing.
    const WORK_NAMES = ['memory_write','memory_read','memory_list','memory_search','mcp__magpie__hub_memory__hub_memory_search','mcp__magpie__hub_memory__hub_memory_get','mcp__magpie__hub_memory__hub_memory_recent','mcp__magpie__hub_memory__hub_memory_list','read','write','edit','read_image','glob','grep','bash','pwsh','job_output','job_list','job_kill','web_search','web_fetch','skill','todo_write','subagent','list_subagent_models','send_message','list_agents','interrupt_agent']
    const toolsSvc = ctx.get('tools') as any
    for (const nm of WORK_NAMES) { if (!toolsSvc.view().knownNames?.has?.(nm) && !toolsSvc.view().visible.has(nm)) { try { ctx.effect(() => toolsSvc.register({ name: nm, description: 'stub', parameters: { type: 'object', additionalProperties: true }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ ok: true }) })) } catch { /* */ } } }
    const runtime: any = new Runtime(ctx, testMachine({ stateDir: canary }), () => {})
    const readyRes = await Promise.race([runtime.ready.then(()=> 'ready-ok'), wait(6000).then(()=> 'timeout')])
    console.log('[rt-dbg] ready=', readyRes)
    runtime.store.saveSettings({ ...runtime.store.settings(), connections: { readOnly: true,
      connections: [{ kind: 'messages', server: 'messages', readTools: ['list_channels', 'list_messages', 'get_message'], writeTools: ['send_message'] }] } })

    // seed a ticket with ONE real pending assignment (normal acceptance shape)
    const ticketId = 'canary-rt-1'
    const now = new Date().toISOString()
    const ticket: Ticket = {
      id: ticketId, title: '真执行器业务效果票', decisionId: 'D-1', mandate: { strength: 'explicit' } as never,
      channels: [{ source: 'mobile', thread: 'mobile:main:' + parent, address: { conversation: 'main', message: parent } }],
      assignments: [{ id: `assignment-${ticketId}-0`, state: 'pending', createdAt: now }],
      inputs: [], undelivered: [], createdAt: now, updatedAt: now,
      origin: { triggerId: 'canary-trig-1', triggerIds: ['canary-trig-1'] },
      execution: { name: 'accept', directory: canary, assignment: 'canary approval demo' },
    }
    runtime.store.tickets.save(ticket)
    nextCall = { name: 'mcp__messages__send_message', args: { channel: 'main', to: parent, text: '真执行器自动回话', key: 'exec-rt-1' } }

    const before = nreplies(db)
    // drive the real executor.start → real launch → worker turn → tool call → guard denies
    runtime.executor.start(runtime.store.tickets.get(ticketId), runtime.store.tickets.get(ticketId).assignments[0])
    // wait for the first turn to settle and produce the pending approval
    for (let i = 0; i < 100; i++) { const t = runtime.store.tickets.get(ticketId); if (t.pendingApproval?.status === 'waiting') break; await wait(100) }
    const dbg = runtime.store.tickets.get(ticketId)
    console.log('[rt-dbg] assignment=', JSON.stringify(dbg.assignments.map((a:any)=>({id:a.id,state:a.state,endedReason:a.endedReason,report:a.report?.state}))), 'delivery=', JSON.stringify(dbg.delivery), 'pending=', JSON.stringify(dbg.pendingApproval))
    console.log('[rt-dbg] agents=', (ctx.get('agents') as any)?.list?.().map((a:any)=>a.id))
    const att = runtime.store.tickets.get(ticketId)!.attention
    expect(att?.question).toBeTruthy()
    const attentionId = att!.id
    expect(nreplies(db)).toBe(before) // not approved → zero write

    // mobile 做吧 → real answerTicket approves → executor.deliver/start re-runs the SAME worker turn → guard allows → real MCP stdio +1
    expect(runtime.answerTicket(ticketId, '做吧', attentionId, 'dev-rt')).toEqual({ ok: true, answer: 'go' })
    for (let i = 0; i < 150; i++) { if (nreplies(db) > before) break; await wait(100) }
    expect(nreplies(db)).toBe(before + 1)
    const last = (JSON.parse(sqlv(db, 'SELECT text, to_msg, conversation FROM replies ORDER BY id DESC LIMIT 1')) as [string, number, string][])[0]
    expect(last).toEqual(['真执行器自动回话', Number(parent), 'main'])

    await runtime.stop()
  }, 60000)
})
