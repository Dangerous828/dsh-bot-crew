# 面板隔离行：档位与实际生效状态一致展示（2026-11-14）

**缺陷**：[#28](https://github.com/Dangerous828/dsh-bot-crew/issues/28)（Part of #17）
**结论**：`/state` 早已返回 `isolationActive`，面板只读 `isolation` —— 信息到 API 就断了。本轮把这一行改成「档位 + 三态生效状态」，缺字段显示未知，不当 `false`。四条行为测试 + 六次反向验证 + 真 DOM 渲染证据齐全。

**验收打回后修正（同日）**：首版档位文案 `平台沙箱 · 仅 worker 执行面` 与 #17 / #22 的事实相反 —— 沙箱只作用 prepare 阶段，worker **未覆盖**。已改为 `平台沙箱 · 仅 prepare 阶段`，并让三态 hint 都显式写明「worker 未覆盖」。`none` 判据、三态分支逻辑与色调均未变。

未 build、未 HMR、未重启服务、未改 settings、未 commit。

---

## 一、缺陷本身

| 事实 | 证据 |
| --- | --- |
| 生产 `/state` 有 `isolationActive` | `GET /state` 顶层 keys = `[health, isolation, isolationActive, load, masterId, paused, setup, watchdog]`，实测 `isolation: none` / `isolationActive: false` |
| 改前客户端不消费它 | `backend/src/client/execution.tsx:37` 只有 `t(\`isolation.${state.isolation}\`)`，`data-state` 二分 `none` / 其他 |
| 测试基建生产了字段但没人读 | `backend/tests/fixtures/panel-server.ts:163` 算出了值，全仓无断言 |
| 后果 | `isolation=sandbox` + `prepare=''` 显示成沙箱档（首版措辞还把 worker 说成覆盖范围），实际一行都没进沙箱（`backend/src/executor/dsh.ts:291` 的 `if (command)` 跳过 `runIsolated`；实测 worker 读 `~/.ssh/id_ed25519` 拿到 419 字节） |
| 反向误导 | 早于 `2364d40` 的宿主（如生产 89699 的旧构建）不返回该键；把缺失读成 `false` 会把「老宿主」说成「配了没生效」 |

## 二、改了什么（4 个文件，+95 / −19）

### `backend/src/client/execution.tsx`

新增 `isolationStatus()`，把「档位」与「生效状态」拆开：

| 输入 | 文案 | `data-state` | 提示要点 |
| --- | --- | --- | --- |
| `isolation: none` | `未隔离 · 沿用本机账号` | `warning` | 沿用本机账号，读得到你的凭据 |
| `sandbox` + `isolationActive: true` | `平台沙箱 · 仅 prepare 阶段 · prepare 已生效` | `ongoing` | 只覆盖 prepare 阶段；**worker 未覆盖**，会话里的命令由 DSH 宿主直接起、不带沙箱（#17 / #22） |
| `sandbox` + `isolationActive: false` | `… · 未生效` | `error` | 点明 `prepare` 为空；worker 本来就未覆盖，此时等于完全没隔离 |
| `sandbox` + 字段缺失 | `… · 生效状态未知` | `warning` | 点明宿主没返回、可能早于 `2364d40`；worker 无论如何都未覆盖 |

`none` 档不挂后缀：它本身就是完整结论，加「生效状态」只会让人以为还有一层。

读取用 `(state as { isolationActive?: boolean }).isolationActive` 而非直接用类型声明 —— `http.ts` 是宿主的承诺，不是客户端对输入的保证；面板会连到老宿主。`undefined` 与 `false` 走不同分支，这是本轮的核心。

**档位措辞的边界口径（2026-11-14 验收打回后修正）**：沙箱只作用 **prepare 阶段**（`dsh.ts:291` 的 `runIsolated`，全仓唯一调用点）；agent 在会话里跑的命令由 DSH subprocess provider 起，被 `sessions.ts:169` 钉死 `danger-full-access`，**worker 未覆盖**。旧措辞「仅 worker 执行面」把未覆盖的 worker 说成覆盖范围，是方向性事实错误 —— 已改为「仅 prepare 阶段」，并让三态的 hint 都显式写明 worker 未覆盖。

### `backend/src/client/locales.ts`

新增 6 个键（中英成对，`locales.spec` 的占位符一致性用例通过）：`isolation.active` / `isolation.inactive` / `isolation.unknown` / `isolationNoneHint` / `isolationInactiveHint` / `isolationUnknownHint`。原 `isolationHint` 保留给「已生效」态。

`isolation.sandbox` 与三个 hint 的措辞按上面的边界口径重写；`isolation.none`、三态分支逻辑与色调均未动。

### `backend/tests/fixtures/panel-server.ts`

加 `stateOmit?: string[]`：`stateView()` 返回前删掉列出的键。没有它就只能测正常响应，测不出「缺字段被读成 `false`」——而生产正跑着这样的老宿主。

### `backend/tests/panel-execution.spec.tsx`

四条行为测试，测的是渲染出来的 DOM 文本、色调与 tooltip 的 `aria-label`，不碰内部函数：

1. `none` → 整行文本等于 `zh['isolation.none']`（严格相等，钉住「不挂后缀」）、`warning`、提示含「本机账号」。
2. `sandbox` + 非空 prepare → 含「prepare 已生效」、`ongoing`；档位行必须含「prepare 阶段」；提示必须含「prepare 阶段」与「worker 未覆盖」。
3. `sandbox` + 空 prepare → 含「未生效」且**不含**「prepare 已生效」、`error`、提示含「prepare 为空」。
4. 宿主不返回 `isolationActive` → 含「生效状态未知」、既非 active 也非 inactive、提示含「宿主没返回」；同一响应下 `none` 仍严格等于完整结论（不被拖成未知）。

**worker 覆盖守卫**：`expectNoWorkerCoveredClaim()` 在 2 / 3 / 4 三态都断言档位行与 hint 不含 `仅 worker 执行面`、`worker 执行面`、`worker commands only`。这组断言直接对应本次验收打回的原句，防止措辞回退。

## 三、验证

### 测试

```
$ cd backend && npx vitest run tests/panel-execution.spec.tsx
      Tests  16 passed (16)          EXIT=0

$ npx vitest run tests/locales.spec.ts tests/styles.spec.ts tests/panel-execution.spec.tsx
 Test Files  3 passed (3)
      Tests  24 passed (24)          EXIT=0
```

全量（文案修正后重跑，`crew-morning.spec.ts` 已被其 owner 登记进 007 表）：

```
$ npx vitest run
 Test Files  112 passed (112)
      Tests  1959 passed (1959)      EXIT=0
```

早前一次全量曾有 1 例失败（`docs.spec.ts` 报 `tests/crew-morning.spec.ts` 未登记 007 表），那是他人未提交工作、与本轮无因果；该登记已由 owner 补上，现全绿。

`npx tsc --noEmit` 对本次 4 个文件零报错；全仓仅 `tests/crew-morning.spec.ts` 两处错误（同上，非本轮）。

### 反向验证（三次，逐条确认红）

| 去掉/改坏什么 | 结果 |
| --- | --- |
| 删掉 `active === undefined` 分支 | 用例 4 红（15 passed / 1 failed） |
| 忽略 `isolationActive`、恒 `active = true`（回到只读 `isolation` 的旧行为） | 用例 3、4 红（14 / 2） |
| `active ?? false`（把缺字段读成 `false`，最常见的错误实现） | 用例 4 红（15 / 1） |

每次验证后从备份还原，`diff` 确认字节一致，重跑 16/16 绿。

**文案修正后追加三次反向验证**（针对验收打回的那条）：

| 改坏什么 | 结果 |
| --- | --- |
| 档位措辞退回 `仅 worker 执行面` | 用例 2、3、4 红（13 / 3） |
| `isolationHint` 退回旧句「只隔离 worker 执行面」 | 用例 2 红（15 / 1） |
| 保留「prepare 阶段」但删掉显式「worker 未覆盖」 | 用例 2 红（15 / 1） |

每次还原后 `diff` 确认字节一致，24/24 绿。

### 实际组件渲染验证（非断言，打印真 DOM）

用真 React + jsdom 挂载 `ExecutionStatus`，四种状态各取一次 `.dt-status-line` 里隔离行的 `textContent`、`data-state`、tooltip `aria-label`（文案修正后重采）：

```
[A none]              row="隔离 未隔离 · 沿用本机账号"                       tone=warning
[B sandbox+prepare]   row="隔离 平台沙箱 · 仅 prepare 阶段 · prepare 已生效"  tone=ongoing
[C sandbox+empty]     row="隔离 平台沙箱 · 仅 prepare 阶段 · 未生效"          tone=error
[D host omits field]  row="隔离 平台沙箱 · 仅 prepare 阶段 · 生效状态未知"    tone=warning
```

B 的 hint：`沙箱只覆盖 prepare 阶段；worker 未覆盖 —— agent 在会话里跑的命令由 DSH 宿主直接起、不带沙箱，仍读得到你的凭据。接真账号前先确认这条边界。`
C 的 hint：`…worker 本来就未覆盖，此时等于完全没隔离，仍读得到凭据。填上 prepare 才会生效。`
D 的 hint：`…配了 sandbox 也不代表 prepare 真进了沙箱，按未知处理；worker 无论如何都未覆盖。`

英文：`Platform sandbox · prepare stage only · prepare in effect` / `The sandbox covers the prepare stage only; the worker is not covered — commands an agent runs in its session start from the DSH host without a sandbox and can still read your credentials.`

临时脚本已删（`tests/zz-render-evidence.spec.tsx`、`tests/zz-copy-evidence.spec.tsx`），`git status` 无残留。

### 生产侧只读核对

```
$ curl -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/state
top keys: [health, isolation, isolationActive, load, masterId, paused, setup, watchdog]
isolation: none | isolationActive: False
```

API 侧字段确实在，缺的只有客户端消费。生产 `lib/client.js` 里搜不到新键（`grep -c` → 0），**符合「不 build 不上线」的约束**：面板要看到新行，需统一验收构建后再走 HMR。

## 四、边界（明确没做）

- **没翻默认**：`policy.ts` 的 `isolation` 仍 `.default('none')`。前置是 #22。
- **没动 worker 预设 / 宿主**：`http.ts`、`runtime.ts`、`policy.ts`、`environment.ts`、`executor/dsh.ts`、`app/`、`desktop/` 全未触碰。
- **没做 UI 重设计**：只改现有那一行的文本、色调与 tooltip，无新组件、无新布局、无 Figma。
- **没 build / 没 HMR / 没重启 / 没改 settings / 没 commit**。
- **没关 #22**（worker 侧隔离仍归它）；本轮的 #28 只收口「面板读不读这个字段」。
- **未 drop `stash@{0}`**：按指示冻结，事故证据由审计保管。

## 五、同类误导登记（不在本轮写范围，未改）

`backend/src/policy.ts:145` 的 schema 注释仍写「worker 执行面的隔离档」—— 与本次打回同一类措辞（把未覆盖的 worker 当覆盖范围）。该文件在 ds-prepare-max 的独占写范围内，本轮不碰，仅在此登记，待其收口时一并订正。

## 六、残余风险

1. **面板要真正看到新行，必须先 build。** 生产 `lib/client.js` 还是旧构建，本轮刻意不动；统一验收构建时这一行才可见。
2. **`isolationActive` 只覆盖 prepare 阶段。** 即使显示「prepare 已生效」，worker 会话里的自由命令仍裸跑（`sessions.ts:169` 钉死 `danger-full-access`）。文案已如实写明「worker 未覆盖」，但这是机制边界，不是文案能补的 —— 根治归 #22。
3. **`stateOmit` 是测试专用开关。** 若将来有人把它接进生产 fixture 路径需重新审视；当前只在 `tests/fixtures/` 内。
