# #24 最终构建与热发布（memory-sync 新 freeze）+ 生产独立核证 — wb-last-release

- 日期：2026-11-14
- 执行者：`wb-last-release`（WorkBuddy DS，lead 委派；仅发布/监视，不改 memory 源码、不代写、不碰用户真实 memory）
- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`
- 写范围：`backend/lib/`（构建产物）、本次 HMR 触发（profile patch 追加注释 + `touch lib/index.js`）、私有 settings 备份、本报告。未 `git add/commit/push/stash/checkout/restore/reset`、未改开发进度/HANDOFF/crew-watch、未抢焦点、未启动 `dsh-superagent start/restart/ensure_gateway`、无 pkill/killall/launchctl。

---

## 一、结论

memory-sync 新 freeze 已完成**最终构建 + HMR 热发布**并在生产生效，进程未重启；随后该构建服务于 wb-memory-sync 的 **09 真实生产产品入口闭环**并通过（我独立核证）。基线产物冻结、符号齐全、与冻结源码一致。

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 前置审查 GO | ✅ | wb-final-audit：117 files / 2073 tests / 0 fail（21:23:12），tsc 0，settle retired 阻断已修 |
| 构建时源未变 | ✅ | 合并 hash `cee199207878`（构建前后一致）；7 文件 SHA256 与 audit 对齐 |
| 构建 | ✅ | `pnpm build`(tsdown) EXIT=0，`lib/index.js` 823 kB |
| 新符号入 bundle | ✅ | retryPendingRetracts×3 / listRetractPending×3 / recordRetractPending×3 / retired×6 / digestsOf×5 / tombstoneByDigests×3 / rememberDigest×3 + settle 标记串 |
| HMR 生效 | ✅ | memory 短暂 `starting`→`ready`；日志 `hub reached`+`hub 鉴权就绪 via file`；HTTP 全程 200 |
| 进程未重启 | ✅ | 89697/89699 lstart 14:26:39、67367 lstart 18:31:04 全不变 |
| 生产健康 | ✅ | load.running=0/queued=0/paused=false；health.memory=ready；runtime=ready；watchdog=null |

**最终产物 hash（用于对照，非 git 提交）：**
- `backend/lib/index.js` sha256 = `e39f323c6cb232811c538fbdf1853e8897ba4e95c19e3fcc77e59ae8a8ce2983`
- lib 目录树 hash = `f39bdaae8341ccff744546a9001303823dd8cd6b45a6e58620b1ff664dca24b6`
- 冻结源（src+tests+scripts+docs 合并）sha256 = `cee19920787800e0dcce8f7a6b5be20d3651e6091f36f2c29aea6de94078d5cd`
- 触发：`~/.dsh/profiles/superagent/cordis.patch.yml` 末尾追加 `# release-backend-20261114-212512: [wb-last-release] final freeze rebuild …` + `touch backend/lib/index.js`（mtime 21:25:12）

---

## 二、发布步骤（实做）

1. 读 catalog/AGENTS/docs/07-hot-reload、product-ledger-seam/retract-contract 报告；确认 HMR 换代码路径 = `pnpm build` + profile 重组（`root: []` 不阻该路径，link 包目标纳入 profileRoots）。
2. 备份：私有 settings `~/.dsh/profiles/superagent/cordis.patch.yml`（pre-release / pre-reconcile 两份）与旧 `backend/lib` → `/tmp/wb-last-release-backup/`（不打印值）。
3. 收到 audit GO 后复核三条件：源 hash 未变（cee199207878）+ 生产 load.running=0 + 与 sync 造票窗口约定；满足后 `pnpm build`。
4. `touch lib/index.js`（mtime 变化即让 reconcile 比对到模块身份变化）+ 追加 release 注释触发一次重组。
5. 监视：memory `starting`→`ready`，HTTP 200；确认 PID 未变、新符号在 bundle、日志出现 apply 重挂。

---

## 三、生产独立核证（服务于 sync 09 真实链路，我只读+监视）

核证项（独立于 sync 自报）：
- PID 89697/89699（14:26:39）、67367（18:31:04）未变；mobilegw 仍 67367 旧进程（HMR 管不到插件外进程，与 memory 链无关）。
- `/state`：load.running=0 queued=0 paused=false；health.memory=ready、runtime=ready、watchdog=null。
- 设备表恢复原 3 台（crew-desktop / d021988751fd… / 66e74d226c1e），verify 设备 `wb-sync-verify09` 已撤销。
- 线上中枢 `jarvis.kentonnie.top/v1/health` 200，`memory_compat`/`memory_retract` 均 registered。
- 生产配置未动：hub `https://jarvis.kentonnie.top/v1` / timeoutMs 8000 / tokenEnv HUB_TOKEN / tokenFile `~/.config/hub-memory-mcp/env`；isolation 仍 none（未翻）。

**09 真实产品入口闭环（sync 跑、我核）：**
真配对出码（loopback 管理面）→ lan 43499 兑码得明文 token（正常产品流程，非哈希还原）→ `/api/mobile/send` 真 Runtime 生成记忆（toHub:false，裁定 C）→ `/api/mobile/memory` edit toHub:true → `author.publish` 真落 md → `dream_notify` 管道上行 NAS（该 sf live=1）→ win-desktop 物理 B recall 命中 → 生产 forget（disabled + bySourceFile + tombstone）→ 中枢该 sf live=0 → B 不再命中 → 下轮不复活 → 原 28 条私有 to_hub 全程 0。全程 200，无 source bug，无撤回失败告警。

---

## 四、清理口径（准确表述，按 lead 裁定）

- **作者 md 与临时设备已清**：`~/.dsh/memory/bot/lead/` 无 canary 文件；verify 设备已撤销，设备表恢复 3 台。
- **1 条 forgotten 测试账本 + 摘要留档**：`kv memory:entry:…canary-1794663005…`（state=forgotten / toHub=false / bot=lead）与 `kv memory:digests:<同名>`=`["5dcbd23ab5d3b012"]` 保留，作为「正常忘记」审计留档（lead 裁定：不做额外 DB 手删/全库 evict）。**不是 active 业务残留，不宣称 KV 零残留。**
- **远端无 live、pending=0**：该 sf 中枢 live=0（原 live 软删 + tombstone 占位）；`memory:retract-pending`=0；watchdog memory_retract 告警=0。
- **原 28 条私有未变**：未被分享（to_hub=true 计数 0），未回改。

---

## 五、边界与未做

- 未改 memory/detect/auth/hub/hub-client/port/settings 等 memory 源码；未代 sync 实施、未碰用户真实 memory、未改默认分享（false）。
- 未 `git` 任何写操作；未动开发进度/HANDOFF/crew-watch。
- mail-calendar（#23 Graph）按 lead 裁定 A：本任务期间只在 `/tmp`，未碰共享 backend，不并入 `e39f323c`；其后由 lead 单独 GO，不混称 2073 已验基线。
- 服务器端原子 tombstone 端点 `issue24health-20261114-211515` 已 registered；真实链路已在其上验通。

---

## 六、回滚面

- 私有 settings：`/tmp/wb-last-release-backup/cordis.patch.yml.pre-release-*`、`…pre-reconcile-*`。
- 旧构建：`/tmp/wb-last-release-backup/lib.pre`（如需回退，覆盖 `backend/lib` 后 touch + patch 注释再 reconcile）。
- 本次只对我追加的 release 注释负责；不撤其他人在 patch 中的改动。
