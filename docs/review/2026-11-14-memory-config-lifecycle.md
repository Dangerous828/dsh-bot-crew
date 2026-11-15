# 记忆中枢配置的生命周期：热生效与健康误报根治

- 日期：2026-11-14
- 工单：单任务修生产验收发现的 memory 配置生命周期根因
- 执行者：`ds-runtime-memory-max`
- 分支：`feat/four-blocks`（未 commit / 未 push / 未 stash）
- 生产影响：**零**。未改生产 settings、未 HMR、未 build、未重启 dsh / mobilegw、未热部署。

---

## 一、结论

两个缺陷都出在**同一处设计**上：`memory` 配置在 `Runtime` 构造期被**快照**进 `HubProbe`
与 `HubHttp`，之后设置保存只改数据库，不换引用。因此：

1. 改 hub 地址 / 凭据引用 / 超时后，**行为不变**，必须等一次整进程重组（或重启）才生效。
2. 默认 `timeoutMs=1500` 小于公网 `/health` 实测 0.88–1.86s，探测超时 → 静默降级本机；
   而 `hubHealthOf()` 只看鉴权状态、不看可达性，于是 **health 仍写 `ready`** ——
   「hub 配了、记忆全本机」在健康面上完全看不见。

修法：把配置变成**活引用**（`HubProbe.retarget` 换整套 probe 引用 + 端口现读 probe），
并把可达性提升为健康面的第一等维度；默认超时按实测数据定为 8000ms。

---

## 二、根因与修法（逐条）

### 缺陷 1：设置保存后不生效

| | 修前 | 修后 |
| --- | --- | --- |
| `HubProbe` 的 hub / timeout / 凭据引用 | 构造期捕获，永不更换 | `retarget()` 换整套，`config` 是唯一真相 |
| `HubHttp` 的 base / timeout | 构造期捕获 | 传函数，每次请求现读 probe |
| `Settings.save('memory')` | 只 `merge` + `guard` | 追加 `memoryChanged()` 钩子 → `applyMemoryConfig()` |
| 换配置后的旧探测 | 会覆盖新配置结论 | 配置代数（`generation`）丢弃迟到结果 |

**为什么不是「只换一个对象」**：探测、检索、鉴权、health 是四个读数。只换
`HubHttp.base` 会让「探测打旧中枢、检索打新中枢、health 是第三份」—— 状态分裂，
事后无法判断哪个是真的。所以 `retarget` 一次换齐，且端口不再持有任何快照。

### 缺陷 2：探测超时后 health 仍 ready

`hubHealthOf(hub, snapshot)` 原来只有两个维度（配没配 / 凭据状态），**没有可达性**。
新增第三维 `ReachState = 'up' | 'down' | 'unknown'`：

| 情况 | 修前 | 修后 |
| --- | --- | --- |
| 没配中枢 | `ready`「全在本机」 | 不变（这不是故障） |
| 配了、还没探过 | `ready`（假成功） | `starting`「正在探测」（不挂假故障） |
| 探测不通 / 超时 | **`ready`（误报）** | **`error`「中枢不可达」** → 进 overview `problems` |
| 无凭据引用 | `paused` | 不变 |
| 凭据被拒 401/403 | `error` | 不变（优先级最高，有明确动作） |

### 缺陷 3：默认超时与公网现实不符

```diff
- timeoutMs: z.number().int().min(200).max(10_000).default(1500),
+ timeoutMs: z.number().int().min(200).max(10_000).default(8_000),
```

**依据**（不是拍的）：
- 生产中枢 `GET /v1/health` 走公网实测 **0.877s / 1.861s / 1.410s**
  （`docs/review/2026-11-14-release-backend-integration.md` §八·偏差 1）。
- 1500ms **小于实测最慢值 1.861s**，所以「偶尔超时」是常态，不是边缘情况。
- 取 8000ms：覆盖实测最慢值的 **4.3 倍**，给公网抖动与中枢冷启动留余量；
  召回在 worker 上工路径上是同步等待，超时再大就是把「hub 慢」变成「开工慢」。
- **上界仍是 10s**（schema `.max(10_000)` 未动）：这个预算有天花板，不是「越大越好」。
- 生产已按 8000 配置（release 报告 §9.1），所以**新默认值与现网配置一致**，
  不会因为这次改动让生产行为漂移。

---

## 三、有界等待：为什么召回不会被 8s 拖住

`HubMemory.recall()` 每次调用会 `await ensureSettled()`。这看起来像「把 8s 超时搬到开工路径」，
实际不是：

- `ensureSettled()` **只等已经在飞的那次探测**；没有在飞的探测立刻返回 → 稳态零成本。
- 「已经在飞」只出现在两种时刻：进程刚启动、配置刚保存。这两种情况下探测**本来就已经发出去了**
  （构造器与 `retarget` 各起一次单飞），等的是同一个 Promise，**不额外打一次网络**。
- 再压一个 **1000ms** 上限：中枢被黑洞（丢包不拒连）时，刚启动的第一次召回不该陪等 8 秒。
  超预算就按当前结论走（降级本机），探测仍在后台跑完并更新 health。
  一次调用受影响，不是永久状态。

证据：`tests/crew-memory-lifecycle.spec.ts` 的「中枢被黑洞…召回不被探测拖住」用例，
断言 `recall` 在 2s 内返回（实测 <1.1s），而 `timeoutMs=8000`。

---

## 四、禁止项自检

| 约束 | 状态 | 证据 |
| --- | --- | --- |
| 不打坏生产已验证的 hub + token 引用 + timeout 8000 | ✅ | 未触碰生产 settings；默认值改为 8000 与现配置一致 |
| 配置变更热生效（整套重建，不只改一个对象） | ✅ | `retarget` 换 hub/timeout/token 三件；端口现读 |
| 正确清理旧 TTL / inflight | ✅ | `last/at/inflight` 全部复位；代数丢弃迟到结果 |
| 网络不可达 / 认证失败各有可观察 health 原因 | ✅ | `error`「中枢不可达」vs `error`「拒绝凭据」，措辞与动作分开 |
| local fallback 可用也要区分 hub 不可用 | ✅ | 降级仍走本机，但 health 是 `error` 而不是 `ready` |
| 不日志刷屏 / 不每请求多探测 | ✅ | 单飞 + TTL；日志只在结论变化时写；用例断言 3 次召回只 1 次 `/health` |
| 超时有上界预算，不无限扩大 | ✅ | `.max(10_000)` 保留；默认 8000 有实测依据 |
| 单测用虚拟时钟，避免 8s 每例等待 | ✅ | 全部注入假 fetch + 显式 `refresh(now)`；整套 114 文件 33s |
| 先读真正代码不凭描述补丁 | ✅ | 读了 port/hub/detect/auth/hub-client/local/memory-layer/settings/policy/runtime 与 007/08 |
| 反向回退构造捕获要红 | ✅ | 见 §六 变异测试 |

### 写范围

**只改了**：`src/app/runtime.ts`（memory 生命周期段 + Settings host 一个字段）、
`src/app/settings.ts`（`memoryChanged` 钩子）、`src/memory/{detect,auth,hub-client,hub}.ts`、
`src/policy.ts`（`timeoutMs` 默认值）、`tests/{crew-memory-lifecycle,crew-memory-detect,
crew-memory-hub-auth,policy}.spec.ts`、`docs/{007-architecture,08-memory-hub}.md`、本报告。

**没碰**：晨报其余段、`prepare`、`client/`（曾改 `locales.ts` 一行，已按写范围回退）、
`app/`、`desktop/`、进度、`HANDOFF*`、`crew-watch`。
`runtime.ts` 的 `memories()` / `forgetMemory()` / `editMemory()`（约 L513-519）与
`watchCompaction()` 的 settle 段（约 L1476）**一行未改** —— 那两处属
`ds-memory-sync-seam-max`，已互相通报边界。

---

## 五、测试证据

### 新增 `tests/crew-memory-lifecycle.spec.ts`（10 例，全部走真 `Runtime` + 假中枢）

| 用例 | 守的是什么 |
| --- | --- |
| 默认超时 8000（且 60s 被 schema 拒） | 缺陷 3 |
| 换 hub 地址后**立刻**按新地址检索 | 缺陷 1（生产真实顺序：保存→召回，不等显式 refresh） |
| 换超时后新预算立刻生效 | 缺陷 1 |
| 换凭据引用后立刻生效：错 token `error` → 改对当场 `ready` | 缺陷 1 + 缺陷 2 |
| 旧探测迟到的结果不覆盖新配置 | 代数守卫 |
| 没配中枢：`ready`「全在本机」、不打网络、召回空串不报错 | 未配置本地模式 |
| 中枢不可达 → `error`「不可达」；恢复后自动回 `ready` | 缺陷 2 + 恢复 |
| 同一 TTL 内 3 次召回只 1 次 `/health` | 不每请求多探测 |
| 黑洞探测：召回 2s 内返回（`timeoutMs=8000`） | 有界等待 |
| 内容相同的重复保存不再探测 | 不因保存动作加压 |

### 新增 `tests/crew-memory-detect.spec.ts` 6 例（`retarget` 单元级）

换地址整套引用一起换、换配置丢弃缓存结论、只换凭据也重探、换配置作废「被拒」、
空 hub 不探测、代数丢弃迟到结果（且不写日志）。

### 全量回归

```
Test Files  114 passed (114)
     Tests  2038 passed (2038)
Duration  33.89s
tsc --noEmit  →  clean
```

---

## 六、变异测试（证明测试真能红）

| 注入的缺陷 | 结果 |
| --- | --- |
| 把 `base: () => probe.base()` 退回 `base: probe.base()`（构造期捕获） | **4 例红**（换地址 / 换凭据 / 不可达 / 单飞计数） |
| 删掉 `if (generation !== this.generation) return this.last` | **1 例红**（旧探测覆盖新配置） |

两次注入都已恢复原状并复跑全绿。

---

## 七、残余风险与后续

1. **`health.memory` 新增 `starting` 状态**：`/state.health.memory` 的取值域从
   `ready|paused|error` 扩到四态。消费方（面板/桌面/手机）按 `state !== 'ready'` 判断时
   会在启动瞬间看到 `starting`。已核对 overview 的 `problems` 只收 `error`，
   所以**不会**因此多出一条假故障；但如果某处硬编码了三态枚举，需要跟着扩。
   → 建议 release 时在面板侧顺手确认一次渲染。
2. **超时默认值变更会影响新部署**：老存档里已有 `timeoutMs` 的实例不受影响（schema 保留原值）；
   只有从未配过 memory 块的实例会从 1500 变 8000。这正是想要的，但值得在 release note 里写一句。
3. **面板提示文案未同步**：`src/client/locales.ts` 的 `memoryHubTimeoutHint` 仍写「几秒内降级本机」，
   没提 8000 与实测依据。`client/` 不在本工单写范围，**留给出面板的 owner**。
4. **`memoryChanged` 是可选钩子**：其它 `Settings` 构造点（测试替身）不传也能工作，
   但那种宿主上 `memory` 块保存**不会**热生效。当前 `src/` 只有 `runtime.ts` 一处构造，已接上。
5. **未做生产验证**：按约束，生产仍跑旧 bundle。新行为要等后续 release 上线后，
   用「改 timeout 不重启 → health 立刻变化」和「改错 token → `error`，改对 → `ready`」
   这两条可观察判据验收。

---

## 八、复现命令

```bash
cd backend

# 新回归（10 例，含生产真实顺序：保存 → 立刻召回）
npx vitest run tests/crew-memory-lifecycle.spec.ts

# retarget 单元级（6 例）
npx vitest run tests/crew-memory-detect.spec.ts

# 全量
npx vitest run && npx tsc --noEmit
```

反向验证（会红，验完请复原）：

```bash
# 构造期捕获回归 → 4 例红
sed -i '' 's/base: () => probe.base(), timeoutMs: () => probe.timeoutMs()/base: probe.base(), timeoutMs: probe.timeoutMs()/' src/memory/detect.ts
npx vitest run tests/crew-memory-lifecycle.spec.ts
```
