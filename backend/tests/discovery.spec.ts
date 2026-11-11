import { expect, it, vi } from 'vitest'
import type { Bonjour, Service } from 'bonjour-service'
import { crewFingerprint, createDiscovery, SERVICE_TYPE } from '../src/app/discovery.ts'

/** 替身广播记录：把 `error` 监听器收下来，好在用例里照着剧本触发一次异步错误。 */
interface RecordedService {
  on(name: string, handler: (error: unknown) => void): RecordedService
  stop(callback: () => void): void
  emit(name: string, error: unknown): void
}

/**
 * 广播成功之后底层才出错（组播被系统收走、socket 关掉）这条路真 mDNS 不会照着剧本演，
 * 所以只在这一条用例里把 Bonjour 换成替身；其余用例照旧走真实现。
 */
const stub = vi.hoisted(() => ({ service: undefined as RecordedService | undefined }))
vi.mock('bonjour-service', async importOriginal => {
  const actual = await importOriginal<typeof import('bonjour-service')>()
  // 替身只在用例塞了 service 时出镜，其余时候原样转给真 Bonjour——同一个文件里的用例还得照旧播真记录。
  class StubbedBonjour {
    private real: Bonjour | undefined
    publish(options: Parameters<Bonjour['publish']>[0]): Service {
      // 结构足够按 discovery.ts 的用法扮演一条记录，不必真起 socket。
      if (stub.service) return stub.service as unknown as Service
      this.real ??= new actual.Bonjour()
      return this.real.publish(options)
    }
    destroy(): void { this.real?.destroy() }
  }
  return { ...actual, Bonjour: StubbedBonjour as unknown as typeof actual.Bonjour }
})

/** 造一条替身记录：`emit('error', …)` 等价于底层广播自己报错。 */
function recordedService(): RecordedService {
  const handlers = new Map<string, (error: unknown) => void>()
  const service: RecordedService = {
    on: (name, handler) => { handlers.set(name, handler); return service },
    stop: callback => callback(),
    emit: (name, error) => handlers.get(name)?.(error),
  }
  return service
}

// 手机靠 mDNS 自己找队伍，所以这段广播就是「寻址」的全部。
// 错的地方只有两种代价：手机找不到（退回手输），或者手机找到一条死记录（选了连不上，比找不到更糟）。
it('folds a state directory into a stable short fingerprint', () => {
  const one = crewFingerprint('/Users/someone/.dsh/state/superagent')
  const again = crewFingerprint('/Users/someone/.dsh/state/superagent')
  const other = crewFingerprint('/Users/someone/.dsh/state/crew')
  // 同一目录每次重启都要给出同一个值，否则手机认不出「还是上次那台」。
  expect(again).toBe(one)
  // 不同目录要能分开，否则同机两支队伍在手机上长得一模一样。
  expect(other).not.toBe(one)
  // 不广播路径本身：mDNS 没有加密，路径里常带用户名。
  expect(one).not.toContain('/')
  expect(one).not.toContain('Users')
  expect(one.length).toBeGreaterThan(0)
})

it('publishes the port it was told and reports it back', async () => {
  const discovery = createDiscovery({ stateDir: '/tmp/state-a' })
  try {
    discovery.publish(43499)
    expect(discovery.published()).toBe(43499)
    // 重复广播同一个端口不该换名字：手机列表里出现两条同机记录，选哪条都可能是死的。
    discovery.publish(43499)
    expect(discovery.published()).toBe(43499)
  } finally {
    await discovery.stop()
  }
  // 撤掉之后不能再自称在广播，否则健康检查会以为手机上还看得见这台机器。
  expect(discovery.published()).toBeUndefined()
})

it('stops publishing when told to, and stops cleanly twice', async () => {
  const discovery = createDiscovery({ stateDir: '/tmp/state-b' })
  discovery.publish(43498)
  await discovery.stop()
  // 关第二次不该抛：close 与进程退出可能各来一次。
  await discovery.stop()
  expect(discovery.published()).toBeUndefined()
})

it('reports failures instead of throwing when the announce cannot start', async () => {
  const errors: unknown[] = []
  // 端口 0 让底层自己去选，构造与播报都不该把异常抛到启动路径上：
  // 局域网广播失败只是少一条捷径，队伍本身必须照常起来。
  const discovery = createDiscovery({ stateDir: '/tmp/state-c', onError: error => errors.push(error) })
  expect(() => discovery.publish(0)).not.toThrow()
  await discovery.stop()
})

it('stops claiming to broadcast once the announce fails asynchronously', async () => {
  const errors: unknown[] = []
  const service = recordedService()
  stub.service = service
  const discovery = createDiscovery({ stateDir: '/tmp/state-d', onError: error => errors.push(error) })
  try {
    discovery.publish(43497)
    expect(discovery.published()).toBe(43497)
    // 广播起来之后底层才报错（socket 被收走、组播没了）：这条记录已经不会应答了。
    const lost = new Error('multicast socket closed')
    service.emit('error', lost)
    // 还留着 current，健康检查就会以为手机上还看得见这台机器 —— 那是「找到了连不上」。
    expect(discovery.published()).toBeUndefined()
    expect(errors).toContain(lost)
  } finally {
    stub.service = undefined
    await discovery.stop()
  }
  expect(discovery.published()).toBeUndefined()
})

it('names the service type the phones look for', () => {
  // 这个名字是协议：改它等于让已经装好的 App 找不到任何服务。
  expect(SERVICE_TYPE).toBe('dsh-crew')
})
