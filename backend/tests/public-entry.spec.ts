import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PUBLIC_ENTRY_FILE, normalizeEntry, publicEntry } from '../src/app/public-entry.ts'

// 手机出门那条路只有在「电脑说出自己的公网地址」时才存在。这个文件只做两件事：
// 把一行字整理成能拼 URL 的形式，以及决定从哪儿读那一行字。两种错都会让手机在外面连不上：
// 写成明文（`http://`）、或末尾留着斜杠拼出双斜杠。所以先钉这两条。

it('adds https to a bare host, because that line travels over the public internet', () => {
  // 人最常写的形式。补明文协议等于把凭据放在裸奔的通道上，所以缺协议一律按 https。
  expect(normalizeEntry('crew.kentonnie.top')).toBe('https://crew.kentonnie.top')
  expect(normalizeEntry('  crew.kentonnie.top  ')).toBe('https://crew.kentonnie.top')
  // 已经带了协议就照抄，别改成一个连不上的人造地址。
  expect(normalizeEntry('http://192.168.1.5:43499')).toBe('http://192.168.1.5:43499')
  expect(normalizeEntry('https://crew.kentonnie.top/')).toBe('https://crew.kentonnie.top')
  // 空行等于没配。
  expect(normalizeEntry('   ')).toBeUndefined()
})

it('reads the environment first and falls back to the state directory file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-public-'))
  try {
    writeFileSync(join(dir, PUBLIC_ENTRY_FILE), 'file.example.top\nsecond line is ignored\n')

    // 环境变量优先：部署时写死的那份比盘上残留的那份更可信。
    expect(publicEntry(dir, { CREW_PUBLIC_URL: 'env.example.top' } as NodeJS.ProcessEnv))
      .toBe('https://env.example.top')
    // 没设环境变量就读文件，且只读第一行。
    expect(publicEntry(dir, {} as NodeJS.ProcessEnv)).toBe('https://file.example.top')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('says nothing when neither source is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-public-empty-'))
  try {
    // 不是错误：没配就是只有局域网这条路，别的功能一点不受影响。
    expect(publicEntry(dir, {} as NodeJS.ProcessEnv)).toBeUndefined()
    // 目录根本不存在也一样，不许抛。
    expect(publicEntry(join(dir, 'nope'), {} as NodeJS.ProcessEnv)).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
