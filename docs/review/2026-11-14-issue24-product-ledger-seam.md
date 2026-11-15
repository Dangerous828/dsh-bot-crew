# #24 产品账本自动上行 + 撤回 production seam（wb-memory-sync）

- 日期：2026-11-14
- 执行者：wb-memory-sync（WorkBuddy DS，lead 委派）
- 分支：`feat/four-blocks`（未 commit/push/stash）
- 裁定依据：lead 2026-11-14 裁定 C；wb-hub-retract 冻结协议 `docs/review/2026-11-14-issue24-retract-contract.md`
- 结论：**产品账本 → author md 落盘 → 既有 local_dream 管道上行 → 中枢** 这一 production seam 源码接线完成（**尚未部署，未在真实热部署 HTTP 入口验证**）；settle/edit/forget/supersede/evict 全生命周期同步 author md 与中枢撤回；撤回按 canonical `source_file` + 原子 tombstone，撤回失败可观察。**默认不分享**（裁定 C）。

---

## 一、拓扑（跨进程 + NAS，不是两物理客户端）

```
[A] 本 Mac 产品运行时（Runtime → MemoryLedger.settle → author.publish 落 md）
        │  ~/.dsh/memory/bot/<bot_id>/<name>.md  （DSH_HOME 推导，与 local_dream 监听根一致）
        ▼
   既有管道 launchd com.homeagent.dream（dsh_memory 直通源，不二次蒸馏）
        │  dedupe_key = sha256(utf8(content))[:16]；EMemoryOutbox HTTP POST /v1/memories
        ▼
[NAS] home-agent-hub / namespace dsh-memory/bot
        ▼
[B] 本 Mac 上第二个独立进程（新 pid、空 stateDir、本机账本 0 条）
        │  产品真实 HubProbe/HubHttp/HubMemory.recall
        ▼
    中枢 /v1/memory/search 命中
```
A、B 同一台 Mac，B 只是**跨进程**（不同 pid、空账本、走真实 HTTP 到 NAS 再回），不是两台物理设备。
（跨主机 B=win-desktop 的加强验证见 §七，可选。）

---

## 二、根因：settle 的 KV 账本 → author md 从未接线（#24 缺口）

只读实测（前 agent ds-sync24-max 诊断 + 本轮回核）：
- `MemoryLedger.settle()` 里 `toHub:false` 硬编码；`plan()`/`planWrite()` 在 `backend/src` **零调用点**。
- `forget` 只翻 KV `state='forgotten'`；`evict` 只 `delete` KV 行；都不碰 author md、不打中枢。
- `superseded` 只改 KV + 删旧 KV 键，不写旧 md 的 `status:superseded`。
- `hub-client.ts` 只有 search+consolidate，**无删除/撤回**；`HubMemory.forget/evict` 直接 fallback 本机。
- 生产 28 条 KV 全 `toHub:0`（lead:23 / coder:5），全 active。

⇒ 「忘了的还在中枢被召回」「账本记忆永不上行」两条缺口，本轮接线根治。

---

## 三、关键发现：远端 dedupe_key ≠ ledger 业务 dedupe_key（否则撤回全失效）

远端每行 stable key = `sha256(utf8(content))[:16]`（`local_dream._digest`），content 是**管道上传的渲染正文**
`# [dsh-auto-memory:<type>] <stem>[ — <desc>]\n\n<body>`。而 ledger `fact.dedupe_key` 是业务键（`person:xxx`）。
二者不同源——按业务键撤一条都删不到。

**实测对齐证明**（真实 md `bot-coder-use-pnpm-test.md`）：
```
本地 pipelineContent(entry) 复算 → sha256[:16] = 623bd5fb6702928a
远端该行 metadata.dedupe_key                    = 623bd5fb6702928a   ✓ 完全一致
```

⇒ canonical 撤回标识 = `namespace + metadata.source_file`（md 文件名，跨版本稳定），一网打尽该逻辑记忆**所有历史版本行**（同 source_file 多行不同 dedupe_key）。

---

## 四、实现

### 4.1 裁定 C：默认不分享，显式 toHub 才上行
- `settle()` 保持 `toHub:false` 硬编码（**origin/type 不构成分享授权，person:owner 也不自动 true**）。
- 只有已认证操作者经产品 edit 入口（`mobile-http action:edit` 透传 `toHub` → `runtime.editMemory` → `ledger.edit`）显式置 `toHub:true`，`author.publish` 才落 md、才随管道上行。
- 既有 28 条 `toHub:false` **不回改**（publish 只对新 entry / 显式 edit 生效，绝不遍历旧行）。

### 4.2 新增模块
- `src/memory/author.ts` — `AuthorMirror`：publish（仅 toHub===true 且非敏感落盘，幂等、记 digest 历史）/ forget（tombstone + md disabled + 撤 live）/ supersede（status:superseded + 撤旧源）/ evict（真删 md + 撤源）/ edit（重写 + keepDigest 撤旧版本）；`pipelineContent`/`pipelineDigest` 精确复算管道 content 与 digest。
- `src/memory/hub-retraction.ts` — `makeHubRetraction`：`bySourceFile`（live 反查+逐条软删，分批有界、404 幂等、keepDigest 保留新版）+ `tombstoneByDigests`（原子占位）。
- 敏感粗筛复用产品 `screen.ts maskSecrets` 语义（**粗筛非完备 DLP**；不把「含路径/单词 token」一概 sensitive）。测试覆盖假密钥样式被拦、正常含路径不误伤。

### 4.3 撤回双保险（禁止只写 disabled 就宣称撤回成功）
1. **源端**：author md 打 `disabled:true` / `status:superseded` → `local_dream._iter_dsh_auto_memories` 直接 `continue`，永不上行。
2. **端**：按 `source_file` live 反查逐条 `DELETE /v1/memories/{id}`（软删、幂等）；并对已知 digest 调原子 `POST /v1/memory/retract-tombstone` 占位（挡未入库旧 pending / md 已删算不出的旧版本）。
- **不复活**：`uq_memories_namespace_dedupe_key` 唯一索引 partial 只看 dedupe_key 非空、**不排除 deleted_at** ⇒ 软删行仍占槽；同 content 重投 `ON CONFLICT DO NOTHING` → 返回 `{deduplicated:true, deleted:true}`，不新建 live。

### 4.4 digest 历史持久化（md 删了也能撤旧版本）
- 每次 `publish` 落盘时，把 `sha256(pipelineContent(entry))[:16]` 记进 KV 一族 `memory:digests:<name>`（**只 16hex，不存正文**）。
- forget/evict/supersede/toHub-false 时把该 source 全部 known digests 交原子 tombstone，覆盖 bySourceFile 反查不到的未入库 pending。

### 4.5 撤回失败可观察 + 可重试
- `noteMemoryRetractFailure` 写 `watchdogAlerts`（kind `memory_retract`，桌面右栏/管理面 `/state.alerts` 读）——**不向 UI 报「已忘」而远端仍 live**。
- 幂等重试：author.forget 天然幂等（tombstone 占槽、bySourceFile 零行无害）。

---

## 五、写范围与未碰
- **改**：`src/app/memory.ts`、`src/app/runtime.ts`（仅 4 处独立 hunk）、`src/app/prompts.ts`（memoryRoot export）、`src/app/mobile-http.ts`（edit 透传 toHub，lead 授权 3 行）、`src/kv.ts`（digests family）、`src/memory/author.ts`+`hub-retraction.ts`（新）、`docs/007-architecture.md`（模块表+Tests 表登记）、`tests/crew-memory-author.spec.ts`+`crew-memory-retraction.spec.ts`（新）、本报告。
- **未碰**：config owner 的 memory 生命周期段（applyMemoryConfig/retarget/Settings 钩子/detect/hub/hub-client/port/auth）、gateway、appAndroid、desktop、开发进度、HANDOFF、crew-watch。
- 未 build/HMR、未改生产 settings、未重启 dsh/mobilegw、未抢焦点、无 git add/commit/push/stash/checkout/restore/reset。

---

## 六、测试证据

### 单测（落盘 backend/tests，相对 import）
- `crew-memory-author.spec.ts`（16）：裁定 C 门控 / 既有私有 toHub=false 不上传 / 敏感粗筛（假密钥拦、含路径不误伤）/ 幂等 / forget 双保险按 source_file + tombstone 顺序 + conflicts 可观察 / supersede / evict / edit keepDigest 保留新版 / true→false 撤远端 / apply 全生命周期。
- `crew-memory-retraction.spec.ts`（9）：live 反查逐条软删 / 404 幂等 / 5xx 抛错 / 分批上界 / 零行无害 / keepDigest 保留新版 / tombstoneByDigests 不传正文 + 409 conflicts 抛错 + existing_live 不擅删。

### 真实链路实测（公网 CF→Caddy→uvicorn→PG，canary/零行无害）
- `bySourceFile` 对不存在 sf：`{ok:true,deleted:0,matched:0}`，不碰真行。
- 已软删 canary live 反查=0（live-only 正确）。
- `pipelineDigest` 与远端 16hex 精确对齐（§三）。
- （tombstone 真实闭环待 wb-hub-retract 端点 deployed 后联调；本地 fake 单测覆盖请求/响应 shape。）

### 全量
```
tsc --noEmit            → clean
vitest run（含 issue21） → 117 files / 2069 tests 全绿
```

### 未做/后续（真实测试票）
「产品入口 settle 生成测试事实(false) → 认证 edit 置 toHub:true → author 自然上行 → NAS 管道 → B 空账本 recall 命中 → 产品 forget/retract → B 不再召回 → 下轮不复活」这条完整产品链，需**新 release 上线 + wb-hub-retract 端点 deployed** 后跑真测试票（见 §八）。不手工 curl 冒充上行；只碰 canary crew 记忆，不碰用户 memory。

---

## 七、拓扑边界（精确，不冒充双物理设备）
主验证是 A（本 Mac 产品账本）→ NAS 管道 → B（本 Mac 第二独立进程，空账本）。这是**跨进程 + NAS**，不是两物理客户端。
副验证（可选，lead 授权）：B 用 win-desktop（#20 已验证在线，canonical SSH `win-desktop`/`win-desktop-cf`）新进程/空 state 跑 recall，凭据只经加密 SSH stdin/受控引用，不写值、不复制个人记忆、只传本 task 无敏感 canary。若 win-desktop 缺 Node/宿主依赖，记录后回退 Mac-B 跨进程，不冒充双设备。

---

## 八、残余/阻塞
1. **服务端原子 tombstone 端点**（wb-hub-retract 在建）：本段 `tombstoneByDigests` 已按冻结 shape Typed 实现 + fake 单测；端点上 canary 通过后联调真实链路。
2. **新 release**：runtime.ts 已改，需 config owner 定部署窗口后新 release 生效；生效后跑真测试票链。
3. **迁移边界**：当前 pending 队列实测 0 文件，无需回填用户历史；「从未入库且 md 已删/内容不可读」的旧 pending 算不出 digest → 覆盖不了（协议 §10.2 已认），有 digest 历史的版本可 tombstone。
4. **docs/02 分流表**：本轮裁定 C（显式 toHub 才分享）与 docs/02 表「已关单结论上 Hub」不同——按 lead 要求**在 ADR/报告明确本轮裁定**，不悄改 docs/02；如需订正由文档 owner 最小改。

---

## 九、真实产品入口闭环实证（2026-11-14 21:29–21:32，新 release e39f323c 上线后）

**拓扑**：A=本 Mac 生产 DSH 运行时 → 既有 local_dream pipeline → NAS 中枢（dsh-memory/bot）→ B=**win-desktop 物理独立设备**（Windows 11，另一台，产品 HubHttp 代码）。这是**真双物理客户端**（A Mac、B win-desktop），非同机跨进程。

**入口**：真实产品流程，非 tmp Ledger、非手写 DB、非伪造凭据：
- 管理面 loopback 出码（`/orchestrator/api/remote/pairing`）→ lan 43499 `/api/mobile/pair` 兑码换明文 token（真配对，非哈希还原）。
- 生成记忆走真 `POST /api/mobile/send`（human trigger）→ 生产 `Runtime.memory.hear → ledger.settle`。
- 分享走真 `POST /api/mobile/memory {action:edit,toHub:true}` → `runtime.editMemory → ledger.edit → author.publish`。
- 撤回走真 `POST /api/mobile/memory {action:forget}` → `runtime.forgetMemory → author.forget（disabled + bySourceFile 撤 + 原子 tombstone）`。

**逐条实测证据**：
| # | 判定 | 证据 |
|---|---|---|
| ① 兑码 | 200 | loopback 出码 `{code}` → lan pair 200 `{deviceId,token(明文,仅内存)}` |
| ② 生产 Runtime 生成记忆 | to_hub=false | `send` 200；账本 28→29；新条 person:owner active **to_hub:false**（裁定 C） |
| ③ 生产 edit 置 toHub | 200 + md 落盘 | `edit{toHub:true}` 200；KV to_hub:true；**author.publish 真落 md**（lead 目录新建，无 disabled） |
| ④ 真 pipeline 上行 | 中枢 live=1 | `dream_notify` queued `#5dcbd23ab5d3b012`；NAS 该 sf live 行 id ed8721ec dk 同 |
| ⑤ B(win-desktop) recall | 命中 | `HubHttp.search({bots:['lead']})` entries=1 正是该条，MARK=true，token 未泄漏（独立 pid） |
| ⑥ 生产 forget | disabled + live=0 | forget 200；md disabled:true；中枢该 sf 2 行全 deleted（live 软删 + tombstone 占位）；KV forgotten |
| ⑦ 撤回无失败 | pending=0 / 无告警 | `memory:retract-pending`=0；watchdog memory_retract 告警=0 |
| ⑧ 不复活 | live=0 / B 不命中 | 再触发管道 live 仍 0；B 再 recall entries=0 |
| ⑨ 原 28 条不分享 | to_hub=true 数=0 | 账本 28 条 active 全 to_hub:false；临时 verify 设备撤销恢复原 3 台；canary **md 已删**；**保留 1 条 state=forgotten/toHub:false 的 canary 账本 + digest 作审计留档**（不手删 DB/prune，避免保护语义丢失）；retract-pending=0 |

**结论**：#24「产品账本自动上行 + 撤回」的真实产品入口闭环成立。生产未重启（HMR），全程经真实认证 API，未伪造凭据、未改默认分享。

**口径准确性（按 lead 最终裁定，不用「全清/全零残留」泛化）**：
- A 的 canary 记忆来源是**真实 `memory.hear`（origin person:owner，type feedback）**，经真 `POST /api/mobile/send` human trigger 触发 → 生产 `Runtime.memory.hear → ledger.settle`。**不是** test-ticket close 链（它是人说的规矩，不是票结论）；send 同时派生的一张 worker 票的 close 结论记忆（bot-lead-ticket-228a19ed, to_hub:0）已作为测试副作用清除，不入举证链。
- B 是**产品 HubHttp.search（真实检索核心）**，与 HubMemory.recall 的中枢分支同一代码；因 win-desktop 未装 `@deepseek-ai`/`zod`，未加载完整 HostMemory 全链（如实标，不冒充）。
- **清理留档**：canary 的 md 已删、临时 verify 设备已撤销回原 3 台；**保留 1 条 state=forgotten/toHost:false 的 canary 账本行 + digest 历史作审计**（forgotten 态不上行、管道跳过、远端 live=0），不手删 DB、不 pruned 保护语义。用户 28 条私有记忆 active/toHub:false 全程不变、不分享。

**08 vs 09 口径**：`08-full-chain.ts` 是「产品库 + 真实管道跨设备集成」补充证据（tmp Ledger + 手动 Mirror，绕生产 API），**不单独关单**；09（本文 §九）才是生产产品入口主线。

**复跑**：08 见 `docs/review/issue24-sync/08-full-chain.ts`；09 步骤命令见本报 §九 与 last-release 交接（出码/兑码/send/edit/forget 五条 curl + B `wb-b/b-run.ts`）。
