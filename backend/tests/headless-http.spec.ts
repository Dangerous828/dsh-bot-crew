import { expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHttp, type HttpHost } from '../src/app/http.ts'

function makeRuntime(stateDir: string) {
  return {
    machine: { stateDir, promptMaxChars: { get: () => 1000 }, admissionContextMaxPages: { get: () => 3 }, admissionContextTimeoutMs: { get: () => 1000 } },
    store: { settings: () => ({ executor: { maxWorkers: 4, isolation: 'none', prepare: '' }, paused: true }), tickets: { open: () => [] } },
    executor: { activeCount: () => 2 },
    configured: () => false,
    setupProblem: { code: 'providerUnset', detail: 'Provider setup required' },
    feishuProblem: null,
    deployment: undefined,
    masterId: 'master-test',
    health: { runtime: { state: 'paused', detail: '' }, worker: { state: 'ready', detail: '' } },
  } as unknown as HttpHost
}

function makeContext() {
  const context = { profileContext: { name: 'headless-health-test' }, logger: { error: vi.fn() }, get: () => undefined }
  Object.defineProperty(context, 'webServer', { get: () => { throw new Error('un-injected webServer property was read') } })
  return context
}

async function waitForDescriptor(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return JSON.parse(readFileSync(path, 'utf8')) as { port: number, profile: string, pid: number, stateDir: string } }
    catch { await new Promise<void>(resolve => setImmediate(resolve)) }
  }
  throw new Error('headless health descriptor was not created')
}

function listeningServers() {
  const handles = (process as unknown as { _getActiveHandles: () => Array<{ constructor?: { name?: string }, listening?: boolean }> })._getActiveHandles()
  return handles.filter(handle => handle.constructor?.name === 'Server' && handle.listening)
}

it('serves profile health, load and paused state on loopback and removes its descriptor', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-headless-health-'))
  const descriptorPath = join(stateDir, 'headless-health.json')
  const dispose = registerHttp(makeContext() as never, makeRuntime(stateDir))
  try {
    const descriptor = await waitForDescriptor(descriptorPath)
    expect(descriptor).toMatchObject({ profile: 'headless-health-test', pid: process.pid, stateDir: realpathSync(stateDir) })
    expect(statSync(descriptorPath).mode & 0o777).toBe(0o600)

    const base = `http://127.0.0.1:${descriptor.port}`
    const response = await fetch(`${base}/orchestrator/api/state`, {
      headers: { origin: base, 'x-orchestrator-request': '1' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      headless: { profile: descriptor.profile, pid: descriptor.pid, stateDir: descriptor.stateDir, port: descriptor.port },
      health: { runtime: { state: 'paused' }, worker: { state: 'ready' } },
      setup: { problem: { code: 'providerUnset' }, feishuProblem: null },
      load: { running: 2, queued: 0, maxWorkers: 4 },
      paused: true,
    })
    expect((await fetch(`${base}/`)).status).toBe(404)
    expect((await fetch(`${base}/orchestrator/api/tickets`)).status).toBe(404)
  } finally {
    dispose()
    expect(readdirSync(stateDir)).toEqual([])
    rmSync(stateDir, { recursive: true, force: true })
  }
})

it('cancels an immediate dispose before starting the loopback listener', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-headless-dispose-'))
  const descriptorPath = join(stateDir, 'headless-health.json')
  const listenersBefore = new Set(listeningServers())
  const dispose = registerHttp(makeContext() as never, makeRuntime(stateDir))
  dispose()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(() => readFileSync(descriptorPath)).toThrow()
  expect(readdirSync(stateDir)).toEqual([])
  expect(listeningServers().filter(server => !listenersBefore.has(server))).toEqual([])
  rmSync(stateDir, { recursive: true, force: true })
})
