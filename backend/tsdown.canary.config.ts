import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: { launcher: 'scripts/canary-launcher.ts' },
  outDir: '.canary-build', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: false, clean: false,
  deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] },
})
