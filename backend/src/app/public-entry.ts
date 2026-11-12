/**
 * 「出了门往哪走」：手机在别的网络里该连的那个入口。
 *
 * 局域网那条路（`lan-server.ts`）出了家门就不存在，mDNS 也只走同一网段。可手机一旦在同一个
 * Wi-Fi 下发现过这台电脑，就至少能记住一个**任何网络都通**的地址 —— 前提是电脑告诉它那个地址
 * 是什么。这个文件负责把那个地址从哪里读出来。
 *
 * 两个来源，环境变量优先：
 *
 *   1. `CREW_PUBLIC_URL` —— 部署时就说定的场合（容器、compose、launchd 的 EnvironmentVariables）。
 *   2. `<stateDir>/mobile-public-url` —— 一行文本。给不想动 profile 配置的场合：写一行文件、
 *      重启后端，字号比改 cordis 补丁小得多，也不必把对外地址写进 repo。
 *
 * 两个都没有就是没有：只广播局域网，行为和加这个功能之前一字不差。不是错误 —— 不是每台机器
 * 都要出门。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 状态目录里那个文件的名字。写一行就够，多了不读。 */
export const PUBLIC_ENTRY_FILE = 'mobile-public-url'

/**
 * 把一行字整理成一个能直接拼 URL 的入口。
 *
 * 人最常写的是 `crew.kentonnie.top` 这种不带协议的形式（配对屏上也要认这一种），所以这里补
 * `https://` —— 出门在公网上，明文比什么都糟。末尾斜杠去掉：拼路径时 `/` + `/api/...` 会变成
 * 双斜杠，某些反代会当成不同路由。
 */
export function normalizeEntry(said: string): string | undefined {
  const trimmed = said.trim()
  if (!trimmed) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * 读出这台机器的公网入口，读不到就是 `undefined`。
 *
 * 文件读失败（不存在、没权限、目录不是目录）一律当作没配：这条路是加出来的捷径，
 * 它坏了不该拖住后端启动，也不该让局域网那条路跟着报错。
 */
export function publicEntry(stateDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.CREW_PUBLIC_URL
  if (typeof fromEnv === 'string') {
    const normalized = normalizeEntry(fromEnv)
    if (normalized) return normalized
  }
  try {
    const first = readFileSync(join(stateDir, PUBLIC_ENTRY_FILE), 'utf8').split(/\r?\n/)[0] ?? ''
    return normalizeEntry(first)
  } catch {
    return undefined
  }
}
