# issue #23 Graph 只读接入：独立 review + release 报告（wb-graph-review-release）

- 时间：2026-11-14 21:40+
- 角色：独立 reviewer/releaser（非 Graph owner）。仅做审查 + 构建产物 + 本报告；**不改源码/进度/HANDOFF/crew-watch，不 git add/commit/push/stash/checkout/restore/reset**。
- 范围裁定：lead GO「Graph 独立批次落盘 stable 后 review/build/HMR」。

## 零、结论先行（严格口径）

- **工程侧就绪**：只读 Graph 端口 + 运行时接线源码/fixture 已实现，构建成功，符号进 `lib/index.js`；独立负对照全绿。
- **真实源未验**：本机**未配置任何 Graph 凭据**，**没有真实邮箱/日历事件**，**没有真实设备送达证据**。`src/app/graph.ts` 是「真实只读 HTTP 端口 + 本地假 Graph server 单测」，**不是真实账号的 live 请求**。因此**不勾选原 issue 「真实接入 Mail/日历」两项**。
- **#23 仍 OPEN**：外部输入缺（一份 Graph 只读 token + 真机在线窗口）。报告措辞 = **「端口/运行接线工程就绪，真实源未验」**。

## 一、代码事实独立核实（非照抄 owner 报告）

| 项 | 核实方法 | 结果 |
|---|---|---|
| 119 files / 2110 tests | `npx vitest run`（全量、无 exclude、含所有 untracked） | **119 passed / 2110 passed**，独立复现 |
| tsc 0 错 | `npx tsc --noEmit` | **exit 0** |
| 37 Graph 例（24+13）独立跑 | `vitest run tests/graph*.spec.ts` | **37 passed** |
| runtime 接线 ≤20 行 | 读 `src/app/runtime.ts`：2 import + `graphHealthOf`(L113) + `runGraphWatch`(L1003) + tick(L1706) | 符合；未触 memory retired/retract/sharing hunk |
| KV 两族 additive | `git diff src/kv.ts`：新增 `mail`/`calendar`，未改既有 families（含 `memory.retractPending`） | additive-only |
| docs-007 登记 | grep 两表 | L376/377 模块、L489/490 测试均在 |
| 我的写范围 | `git status`：本会话**零** src/test/doc 改动；lib/ 为 gitignore 构建产物 | 符合「只构建产物 + 报告」 |

## 二、独立负对照（我自己写的探针，不复用 owner 24+13，7/7 绿）

直接打真实 `src/app/graph.ts` / `graph-watch.ts`：

1. **绝不回退 Hub token**：只给 `HUB_TOKEN` → Graph **0 请求**，错误不含 hub 值 ✓
2. **固定官方 origin**：非官方 base 构造即拒；`isLoopback` 边界（127.9/::1/localhost 真；10.0.0.1 假；ftp 假）✓
3. **不跟随跨 origin redirect 泄 Bearer**：302→evil 只打本体 **1** 次，无第二次，错误不含 token，含「非同一 origin」✓
4. **401 分离 + 不泄 token + `$select` 不含 body/正文**：status=401、isGraphAuthError、错误无 token、`$select` 无 body/content ✓
5. **未配零请求前提**：`configsFromEnv({})` = `{}`、whitespace-only `GRAPH_TOKEN` = `{}`、仅 `GRAPH_TOKEN_FILE` 也启用 ✓
6. 官方 base 常量正确 ✓

## 三、release 动作（HMR，不重启）

- `pnpm build`：exit 0，17 ESM + client.js，graph 符号折入 `lib/index.js`。
- `touch lib/index.js` + append **自有** release comment 到 `~/.dsh/profiles/superagent/cordis.patch.yml`（append-only，未覆盖他人注释）。
- HMR 机制核实：`@deepseek-ai/dsh-hmr` 用 chokidar 精确 watch patch 文件；**lsof 实证 PID 89699 `fd 19r cordis.patch.yml` 持开 + KQUEUE**，patch change → 热 recompose，**进程不重启**。
- **进程未重启实证**：`ps lstart`：89697/89699 = 14:26:39（不变），67367 = 18:31:04（不变）。

## 四、生产状态（release 后实测）

```
lib/index.js  sha256 = 2ade8753165c3a01f7320634ea8be382f8dd72951726b94d7fec02633fec6af7
lib mtime     = 2026-11-14 21:37:48
symbol hits   : runGraphWatch 2, MicrosoftGraphPort 2, graphHealthOf 3, readGraphToken 2
/state.health : memory=ready（detail: 中枢凭据来自凭据文件）, mail=None, calendar=None
load          : running 0, queued 0, maxWorkers 3
remote/devices: 3（crew-desktop + Redmi + OPPO）
```

- **memory 仍 ready**，私有 `toHub` 默认 false、不按 origin/type 自动分享（`memory.ts` L191 核实），28 私有不分享不变。
- **#24 不退**：本次零源码改动，memory e39f323c/2073 历史不并入、不改写（lib/ 为 gitignore，不落 git）。
- **Graph 无真账号**：未设 `GRAPH_TOKEN`/`GRAPH_TOKEN_FILE`，未 call 任何外部真实读取；`pushNotice` 的 queued 不叫送达。

## 五、发现（1 条 should-fix：报告口径，非阻塞）

1. **「未配 → paused，面板可见」与实测不符**（`src/app/runtime.ts` L1005-1013 vs L1026-1027）
   - **现象**：`graphHealth` 懒建（`private graphHealth?`），未配凭据时 `runGraphWatch` 走 `if(!mail&&!calendar)` 分支里 `this.graphHealth?.mail.set(...)` —— `graphHealth` 为 `undefined`，`?.` 短路，**paused 条目从不创建**。实测 `/state.health` 里 mail/calendar = **None（缺席）**，不是 `paused`。
   - **影响**：功能无碍（未配就零请求、健康地「不存在」）；但 owner 报告 §二.6「未配 → paused（面板可见）」**夸大了可观测性**。代码注释 L1026 自己写的是「懒建：没配凭据时不占用面板条目」——与报告矛盾。
   - **建议**：报告改口径为「未配凭据 → /state 不出现该条目（零请求、非 error）」；若要真 paused 可见，需在 `runGraphWatch` 首行先 `graphHealth ??= {claim mail, claim calendar}` 再判空（小改，但属 owner 源码，我不代改）。

## 六、验收边界（不越权）

- 本报告**不**宣称任何「真实 Mail/Calendar 各触发一次」「晨报真出一份」「真机推送弹出」——这些需真实 Graph token + 真机在线窗口，属外部输入。
- 「本地假 Graph server 单测全绿」≠「真实账号 live 请求成功」。119/2110 是工程测试。
- 生产**不配置 GRAPH 账号/token**（缺外部真实账号），保 disabled/零请求。
- #20/#21/#22 保外部，#24 不重开，#23 保 OPEN。

## 七、可交付状态

- **工程前置：就绪**（源码 + fixture + 构建产物 + HMR 发布已落，进程未重启，memory 健康、私有不分享、设备表 3、pending 0）。
- **剩余唯一外部输入**：一份 Graph 只读 token（`Mail.Read`+`Calendars.Read`）+ 真机在线窗口。齐备后再跑真实触发并在 #23 收口。
- **#23：OPEN。**

---

审查依据：`ponytail-review`（正确/安全/负载/测试/精简）+ `dsh-cpuser-ops`（HMR/profile patch 不重启工艺、优先读源码不逆向猜测）。
