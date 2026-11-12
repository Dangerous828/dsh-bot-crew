import { defineConfig } from 'vitest/config'

/**
 * 手工验证脚本的独立配置。
 *
 * 与主配置分开，是为了让「要外网、要密钥」的脚本永远不进 `pnpm test` ——
 * 主配置的 include 只收 `tests/**\/*.spec.{ts,tsx}`，这里只收 `scripts/manual/`。
 * 跑法：`./node_modules/.bin/vitest run --config vitest.manual.config.ts`
 */
export default defineConfig({ test: { include: ['scripts/manual/**/*.test.ts'] } })
