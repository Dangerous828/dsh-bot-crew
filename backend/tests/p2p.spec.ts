import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createP2p, parseAddr, savedAddr } from '../src/app/p2p.ts'

// 手机那条 P2P 路只有一个对外可见的产物：一个 tc-addr。它同时是地址与凭据（内嵌公钥，
// 默认还带预共享密钥），所以这一层的错只有两种代价：手机上出现一条连不上的记录，
// 或者一台本来能直连的机器被无声降级到中转。下面钉的都是这两种。

const REAL_LINE = '# 🐈 Server listening with new address: tcpGFwWCDQf-oX6qlVXTmtpBA2ZyVLmqKMur7JEZIXYZXhuXM3BGFrWCCDu1YZnpWMVsxo3MsyvKttPPYruMRuLpfE_1QPaoSvcWFxWCACEkVJgQ5T0f231oipQ3f7U8FWFrb_Ts0a0nA8kaB6iGFpIA'

it('pulls the tc-addr out of the line tailcat prints', () => {
  expect(parseAddr(REAL_LINE)).toMatch(/^tcp[A-Za-z0-9_-]+$/)
  // 用 --key=default 时文案变了，地址一模一样地还要认得出来 —— 这正是我们线上的形态。
  expect(parseAddr(`# 🐈 Server listening with saved key "default": ${parseAddr(REAL_LINE)}`))
    .toBe(parseAddr(REAL_LINE))
  // 前面那行「选了哪个 DERP region」不是地址，不许当成地址广播出去。
  expect(parseAddr('# Selected bootstrap relay region 304, Tokyo')).toBeUndefined()
  // 太短的不收：宁可报「没有直连隧道」，也不要让手机拿到一个连不上的字符串。
  expect(parseAddr('new address: tcp123')).toBeUndefined()
  expect(parseAddr('')).toBeUndefined()
})

it('remembers the last address for the gap right after a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-p2p-'))
  try {
    const addr = parseAddr(REAL_LINE)!
    const read = (path: string): string | undefined => {
      if (!path.endsWith('mobile-p2p-addr')) return undefined
      return `${addr}\n`
    }
    expect(savedAddr(dir, read)).toBe(addr)
    // 文件里是垃圾（被人手改过、写了一半）就当没有：旧地址比没有地址更糟。
    expect(savedAddr(dir, () => 'not-an-address')).toBeUndefined()
    expect(savedAddr(dir, () => undefined)).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('runs the helper, reports its address, and says so when it dies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-p2p-run-'))
  const fake = join(dir, 'fake-tailcat')
  // 替身按 tailcat 的真实输出说话，然后立刻退出 —— 正好一次走完「拿到地址」与「进程没了」。
  const addr = parseAddr(REAL_LINE)!
  writeFileSync(fake, [
    '#!/bin/sh',
    "echo '# Selected bootstrap relay region 304, Tokyo'",
    `echo '# 🐈 Server listening with new address: ${addr}'`,
    'exit 0',
  ].join('\n') + '\n')
  chmodSync(fake, 0o755)

  const addresses: string[] = []
  const states: string[] = []
  const p2p = createP2p({
    binary: fake,
    port: 43499,
    onAddr: addr => addresses.push(addr),
    onState: (state, detail) => states.push(`${state}:${detail}`),
  })
  try {
    p2p.start()
    // 等条件成立，不等钟表：全量并发跑的时候固定等一小段会不够，这条用例就变成了随机红。
    await vi.waitFor(() => { expect(addresses).toHaveLength(1) }, { timeout: 10_000 })
    // 进程退出后地址作废：留着它，手机就会连一个没人听的地方。
    await vi.waitFor(() => { expect(states.some(entry => entry.startsWith('error:'))).toBe(true) }, { timeout: 10_000 })
  } finally {
    await p2p.stop()
    rmSync(dir, { recursive: true, force: true })
  }

  expect(addresses[0]).toMatch(/^tcp/)
  expect(p2p.addr()).toBeUndefined()
})

it('treats a missing helper as "this machine has no direct tunnel", not as a crash', async () => {
  const states: string[] = []
  const p2p = createP2p({
    binary: join(tmpdir(), 'definitely-not-here', 'tailcat'),
    port: 43499,
    onState: (_state, detail) => states.push(detail),
  })
  p2p.start()
  // 报一次原因就够，不抛：局域网与中转那条路不该被这条路的缺失拖住。
  await vi.waitFor(() => { expect(states.length).toBeGreaterThan(0) }, { timeout: 10_000 })
  await p2p.stop()
  expect(p2p.addr()).toBeUndefined()
})
