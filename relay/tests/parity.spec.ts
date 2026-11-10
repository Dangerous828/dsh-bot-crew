import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

/**
 * 两份协议层必须逐字节一样。
 *
 * 中转与宿主是两个部署单元，协议文件是拷过去的（见 sync-protocol.sh）。拷过去就一定会漂移：
 * 有人只改了 backend 那份，测试全绿（两边各自都自洽），线上才发现帧编号对不上。
 * 所以这里直接读两个文件比字节，红的时候脚本已经写好了怎么修。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

it('keeps the relay copy of the protocol byte-identical to the host copy', () => {
  const host = readFileSync(join(root, 'backend', 'src', 'app', 'relay-protocol.ts'))
  const relay = readFileSync(join(root, 'relay', 'src', 'relay-protocol.ts'))
  if (!host.equals(relay)) {
    // 把第一处不同的位置说出来，省得人靠肉眼 diff。
    const limit = Math.min(host.length, relay.length)
    let at = 0
    while (at < limit && host[at] === relay[at]) at += 1
    const line = host.subarray(0, at).toString('utf8').split('\n').length
    throw new Error(`协议两份不一致，第一处差异在第 ${line} 字节附近。改完 backend 的后跑：sh relay/sync-protocol.sh`)
  }
  expect(relay.equals(host)).toBe(true)
})
