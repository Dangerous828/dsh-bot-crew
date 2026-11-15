# phase2-worker 读面隔离证据脚本

配合 `2026-11-14-worker-file-read-isolation.md`（task-5 / #22 补口）。

这些脚本在 **独立临时实例**（`/tmp`，symlink 到宿主 `dsh/node_modules`）里跑，加载本仓 `lib` 构建产物，
用真 `sandbox-exec` / 真 `@deepseek-ai/dsh-fs-sandbox` resolver / 真 `@deepseek-ai/dsh-subprocess-local`，
canary 全在**临时 HOME**（假 token）。不启动生产 dsh、不碰操作者真实凭据。

## 复现步骤

```bash
# 1) 构建本仓 executor 产物到临时目录（不污染共享 lib）
cd backend
cat > .wbfs-tsdown.config.ts <<'CFG'
import { defineConfig } from 'tsdown'
export default defineConfig([
  { entry: { 'worker-fs': 'src/executor/worker-fs.ts', 'worker-sandbox': 'src/executor/sandbox.ts',
             'worker-search-subprocess': 'src/executor/worker-search-subprocess.ts', environment: 'src/infra/environment.ts' },
    outDir: '/tmp/wbfs-build', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: false,
    clean: true, deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] },
    copy: [{ from: 'src/executor/worker-fs-helper.mjs' }] },
])
CFG
npx tsdown --config .wbfs-tsdown.config.ts

# 2) 搭独立实例，symlink 宿主 node_modules，拷脚本
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules"
mkdir -p /tmp/wbfs-real && cd /tmp/wbfs-real && ln -sfn "$DSH" node_modules
cp <repo>/docs/review/phase2-worker/proof-worker-fs-read.mjs .
cp <repo>/docs/review/phase2-worker/proof-worker-fs-per-session.mjs .
cp <repo>/docs/review/phase2-worker/proof-worker-search-confine.mjs .

# 3) 跑（真 sandbox-exec，macOS）
node proof-worker-fs-read.mjs          # 真 fs-sandbox resolver：工作区可读、~/.ssh 拒、symlink 拒
node proof-worker-fs-per-session.mjs   # 两 worker none/sandbox 交替+并发不串
node proof-worker-search-confine.mjs   # glob/grep 缺口：rg 在 profile 内跑，敏感 root 被拒
```

脚本里产物路径写死为 `/tmp/wbfs-build/worker-*.js`（与上面 outDir 一致）。

## 边界

`proof-worker-fs-per-session.mjs` 用 `AsyncLocalStorage` **忠实模拟** `agents.currentInitiator()` 边界（机制证据）。
真 `AgentRegistry.withInitiator/currentInitiator` 已单独核证返回同一 agent。

**端到端缺口已补（task-6）**：`backend/tests/worker-runtime/real-agent-tool-dispatch.e2e.mjs`
用真 `AgentLoop` + 真 `tools.execute` + 真 session（`agents.create` 的真 SID）+ 与 worker preset 相同的局部
isolate scope（`{fs,sandbox}` / `{shell,sandbox}` / `{subprocess}` 三兄弟），脚本化 `LlmAdapter` 驱动
read/read_image/glob/grep/bash 五个真工具，canary 全在临时 HOME。跑法见该目录 `run.sh`（先 `tsdown` 构建 lib）。
报告：`2026-11-14-worker-real-agent-tool-dispatch-e2e.md`。
