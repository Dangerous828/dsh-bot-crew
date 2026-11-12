# 第 3/4 期审批与对外连接实现核验

- 核验时间：2026-11-12 14:44–14:56（Asia/Shanghai）
- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`
- 角色：独立子代理（审批 / 对外连接专项）
- 可写范围：`backend/src/app/approval.ts`、`backend/src/app/connections.ts`、`backend/tests/crew-approval.spec.ts`、`backend/tests/crew-connections.spec.ts`，以及本报告。其余只读。

## 一、结论

1. 模块内确认并修复 **1 处明确缺陷**：`allowedTools` 放行层与 `natureOf` / `judgeCall` 分类、判定层不一致（§三，有红→绿证据）。
2. 审批三档、邮箱/日历/文件连接声明、读写工具分类、未知工具/断连、规则变化与授权复用边界的**模块行为**，全部经模拟用例核验，与代码声明一致（§四）。
3. 发现 **4 项接线缺口**，全部落在 `runtime.ts` / `sessions.ts` / `policy.ts` / `core` / 契约层。按分工要求只报告、不跨 scope 写，交 Lead 处理（§五）。
4. 全程只跑模拟套件：未调用真实邮箱/日历/文件 MCP，未改宿主配置、运行态配置或数据库，未启停任何服务，未做 git 提交/push/checkout/reset，未触碰手机 adb、推送链、`backend/lib`、`backend/src/memory/settle.ts`、`backend/tests/zz-durable.spec.ts`、进度文档、设计稿截图、`scripts/crew-watch`。

## 二、修改文件

| 文件 | 改动 |
|---|---|
| `backend/src/app/connections.ts` | `allowedTools` 增加内置读白名单兜底（+4 −1 行），无接口变化 |
| `backend/tests/crew-connections.spec.ts` | +5 例（其中 1 例为缺陷回归） |
| `backend/tests/crew-approval.spec.ts` | +3 例（规则变化、授权复用、三个选项 label） |
| `docs/PHASE_APPROVAL_CONNECTIONS_CHECK.md` | 本报告（新建） |

`backend/src/app/approval.ts` **未改**：`approvalOf` 判定顺序、`approvalPrompt` 三选项、`readAnswer` 回答解析经核验无需改动；为它补的是验证边界的用例，不是修 bug。

## 三、修复的缺陷

### 现象

一条只声明 `{ kind, server }` 的连接是合法配置：`ConnectionsConfigSchema` 的 `readTools` 默认 `[]`、`writeTools` 可选（`backend/src/policy.ts:105-113`）。对这条连接：

- `natureOf` 把 `list_messages` 判为 `read`（未列工具时吃内置白名单，`connections.ts:74`）；
- `judgeCall` 判 `allow`（`connections.ts:100`）；
- `allowedTools` 却返回 `[]` —— 改动前它只枚举显式列出的 `readTools` / `writeTools`。

后果：`backend/src/app/sessions.ts:318` 从 `allowedTools` 拿不到 `mcp__mail__list_messages`，worker 拿不到这个工具。分类与判定都承诺「读直接放行」，放行层却给不出工具名，内置白名单兜底在真实发放路径上落空。

### 复现（红）

加入回归用例后实跑：

```
FAIL  tests/crew-connections.spec.ts > allowedTools > makes the built-in read names reachable on a bare connection
AssertionError: expected [] to include 'mcp__mail__list_messages'
 ❯ tests/crew-connections.spec.ts:78:32
```

这条用例同时钉住三件事：`natureOf` 判 `read`、`judgeCall` 判 `allow`、`allowedTools` 必须给得出名字。前两条原本就通过，只有第三条红——缺陷被最小化到放行层一处。

### 修法

`allowedTools` 在「未显式列出任何工具」时改用 `DEFAULT_READ[kind]`，判断条件与 `natureOf` 的兜底顺序对齐：显式配过 `readTools` 或非空 `writeTools` 就以配置为准。4 行改动，无接口变化，现有 15 例断言不变。

配套加了一条反面用例：只配 `writeTools: ['send_message']` 的连接，`allowedTools` 只返回这一个工具，不把内置读工具泄漏给 worker。

## 四、调用者追踪与行为核验

### 4.1 实际跑过的验证（模拟用例，非推断）

| 核验项 | 用例 | 结果 |
|---|---|---|
| 审批三档 | `off` 一律问；`auto` 撞敏感规则也照做；`ask` 只停在敏感规则上 | 通过 |
| 判定顺序 | 档位 → 规则 → 额度，禁区不被额度告急盖掉 | 通过 |
| 额度边界 | 0.9 触发、0.5 不触发、`undefined` 不拦、1 仍先报 mode | 通过 |
| 三个选项 / 回答解析 | `go`/`stop`/`revise`；三个选项 label 都能读；认不出一律 `stop` | 通过 |
| 连接声明 | `connectionsOf` 默认只读、`readOnly` 只在显式 `false` 时关、坏条目跳过、最小声明保留 | 通过 |
| 读写分类 | 配置的读列表算读；其余落写；没配时吃内置白名单；显式 `writeTools` 优先 | 通过 |
| 未知工具 / 断连 | 未接入的 server → `deny`；已接入 server 上的陌生工具 → 按写 → 只读下 `ask`；移除 server 后立刻 `deny` | 通过（后两条为本轮新增） |
| 规则变化 | 同一批规则只翻转 `sensitive` 标记，判定跟着变；规则从命中集合移除后不再拦 | 通过（本轮新增） |
| 授权复用 | `approvalOf` / `judgeCall` 都是纯函数：先放行再切回只读（或先 `auto` 再 `off`），下一次判定不带上一次结论 | 通过（本轮新增） |
| 放行层一致性 | 最小声明的连接能拿到内置读工具；只配写工具的连接不泄漏读工具 | 通过（本轮新增，含缺陷回归） |

### 4.2 静态追踪（读代码得到，未在运行态复现）

审批判定调用链：
`core/tickets.ts:49`（`prepareTicket` 钩子）← `runtime.ts:227`（`prepareWithApproval(executor.prepare(...))`）← `runtime.ts:485-514`。`prepareWithApproval` 读 `settings().approval.mode` 与 `settings().policy.rules[].sensitive`，要问时把 `mandate.strength` 降为 `inferred` 并写 `ticket.attention`（三个选项），再推一条 `kind: 'approval'` 通知。配置声明在 `policy.ts:94-98`（`ApprovalConfigSchema`）与 `policy.ts:144`（默认值 `ask`）。

对外连接调用链：
- 工具发放：`sessions.ts:313-323` 的 `workOnly`，`configured = allowedTools(connectionsOf(settings().connections))`，再 `.filter(name => agent.ctx.tools.get(name, parent))` 只留宿主真注册了的工具。声明在 `policy.ts:105-113`、`policy.ts:145`。
- 调用判定：`runtime.ts:553-561` 的 `judgeConnection` → `judgeCall(connectionsOf(raw), server, tool)`；读配置出错时保守返回 `ask`。`runtime.ts:564-566` 的 `connectionAskText` 拼给人看的一句话。

选项呈现：`mobile-http.ts:836,855-856` 只在 `stage.action === 'answer'` 且 `ticket.attention` 存在时下发 `question` / `options`。`docs/00-contract.md:198-205` 规定选项是呈现，回答走 `POST /send` 带选中 `label`，网关不解析选项，没有单独的「选选项」路由。

授权复用边界：`policy.ts:165-167` 的 `policyVersion` 只哈希 `rules` / `eval.mode` / `policy.sources`；`policy.ts:202-223` 的 `policyEffects` 与 `policy.ts:272-299` 的 `revalidate` 只检查规则与 `eval.mode`。审批判定本身在建票时一次性完成。

## 五、接线缺口（报 Lead，未跨 scope 写）

以下四项都落在本次只读范围，按分工要求交 Lead 处理。§五各项的后果是**静态调用图推断**，没有在宿主运行态复现。

### 5.1 `judgeCall` 没有生效的调用者

全仓检索 `judgeConnection` / `connectionAskText` / `judgeCall`，除 `runtime.ts:553` 的定义、`runtime.ts:40` 的 import 与两个 spec 外，**没有任何调用点**。因此 `connections.ts` 的「写必须过审批」（`judgeCall` 返回 `ask`）没有在 worker 调用 MCP 工具的那一刻被执行。同时 `sessions.ts:318` 会把 `writeTools` 也放进白名单（用例 `keeps write tools reachable so the approval can happen at call time` 明确期望如此，注释说审批在调用那一刻做），而那一刻的判定没有接线 —— 推断结果是写工具进了白名单却没有运行时拦截。这是 `runtime.ts` / `sessions.ts` / `index.ts` 的接线，未改。

### 5.2 `readAnswer` 未接线，三选项没有专门处理器

`readAnswer` 全仓只有 `approval.ts:94` 的定义与 `crew-approval.spec.ts` 的用例，生产代码不引用。`approvalPrompt` 生成的 `go` / `stop` / `revise` 三个选项经 `prepareWithApproval` 写成普通 `ticket.attention`；按 `docs/00-contract.md:203-205`，人点按钮只是发一条带 label 的普通消息，重新走 eval/gate。`approval.ts` 注释里 `revise`「让队伍停在原地等一句新要求」的意图没有对应处理。契约把选项定义为呈现，所以这与契约一致，但与模块注释的意图不一致；属产品语义与接线，交 Lead 判断。

### 5.3 `approval.askWhenBudgetUsed` 声明了但未接线

`policy.ts:94-98` 的 `ApprovalConfigSchema` 有 `askWhenBudgetUsed`（默认 0.9），`runtime.ts:489` 也把它读进了 `config` 的类型，但 `runtime.ts:490-494` 调 `approvalOf` 时只传 `mode` / `rules` / `sensitive`，**没有传 `budgetUsed`**；`approval.ts:48` 的阈值是硬编码 `BUDGET_ASK_RATIO = 0.9`。推断结果：`approvalOf` 的额度分支在生产路径上是死代码，改这个配置项不生效。接线在 `runtime.ts`，阈值可配涉及 `approval.ts` 接口，两者都不在本次可写组合内，未改。

### 5.4 配置变化不触发已开工单重新判定

`policyVersion` 不含 `approval` 与 `connections`，`revalidate` 也不检查这两块；审批只在 `prepareTicket` 判一次。推断结果：`approval.mode`、`rules[].sensitive`、`connections.readOnly` 变化后，已开工单不重新审批、不重新判定，旧授权沿用。工具白名单因 `workOnly` 每次读 `settings()`，新绑定的 session 会拿到新配置，但已下发的审批决定不会收回。属 `policy.ts` / `core` 层，未改。

### 5.5 供 Lead 一并判断的两处边界

- **断连 / 未知工具的真实落点**：`judgeCall` 不感知宿主是否注册了工具；「MCP 服务器没连上就不给工具」实际由 `sessions.ts:319` 的 `tools.get` 过滤承担。已接入 server 上的陌生工具被 `natureOf` 判为写、`judgeCall` 判 `ask`，但 `allowedTools` 不给它名字，worker 拿不到 —— 这两条防线在真实路径上并不汇合（同 §5.1）。
- **`auto` 档与额度分支**：`approvalOf` 的额度分支在 `auto` 档也会触发，而 `approval.ts` 顶部表格写 `auto`「自动做」。当前 `budgetUsed` 从未传入，属潜在语义分歧，本轮按「不为找问题改代码」处理，未改；待 §5.3 接线时一并定夺。

### 5.6 并发改动提示

核验期间共享工作区里他人正在改 `backend/src/app/runtime.ts`、`backend/src/app/spend.ts`、`backend/tests/runtime.spec.ts`、`backend/tests/crew-spend.spec.ts`、`backend/docs/007-architecture.md`，另有 `docs/FOUR_PHASE_COORDINATION.md`、`scripts/crew-watch/` 等未跟踪文件。我的四个目标文件在编辑前 `git diff` 为空，全程未触碰他人文件。本报告引用的 `docs/007-architecture.md:364/366` 行号是读取时的位置。

## 六、实际跑过的命令与结果

工作目录均为 `backend/`。

| # | 命令 | 结果 |
|---|---|---|
| 1 | `./node_modules/.bin/vitest run tests/crew-approval.spec.ts tests/crew-connections.spec.ts` | 基线：2 文件 / 23 例全过 |
| 2 | `./node_modules/.bin/vitest run tests/crew-connections.spec.ts`（加回归用例后） | 1 红 / 15 过，红在 `expected [] to include 'mcp__mail__list_messages'` |
| 3 | 同 #2（修 `allowedTools` 后） | 16 例全过 |
| 4 | `./node_modules/.bin/vitest run tests/crew-approval.spec.ts tests/crew-connections.spec.ts tests/policy.spec.ts` | 3 文件 / 359 例全过（审批 11 + 连接 20 + policy 328） |
| 5 | `./node_modules/.bin/vitest run tests/runtime.spec.ts` | 100 例全过（覆盖 `sessions.workOnly` 的 `allowedTools` 消费路径） |
| 6 | `./node_modules/.bin/vitest run` | **完整模拟套件 98 文件 / 1687 例全过**，0 失败 |
| 7 | `./node_modules/.bin/tsc --noEmit` | 我方三个改动文件 0 报错；全仓 2 处 `TS2352` 位于他人正在改的 `tests/runtime.spec.ts:1908,1921`，未触碰 |

`pnpm` / `vitest` 均用仓库已装依赖，未执行 `pnpm install`、未改依赖、未做全仓格式化。

## 七、未验证项

1. **`backend/lib` 未重建**：本次只改 `src/`，而插件运行态加载的是 `lib/`（`HANDOFF-NEXT.md` §五有此约束）。`backend/lib` 在禁写范围内，需 Lead 在部署前执行 `./node_modules/.bin/tsdown`；在此之前运行态不会体现本轮 `allowedTools` 修复。
2. **真机与真实外部服务**：未接真邮箱 / 日历 / 文件 MCP，未验宿主 `tools.get` 的真实注册与断连表现，未验手机 / 桌面三选项呈现与「听播报」等真机链路。用户已停止推送链，本轮未开发、未验证推送。
3. **§五全部接线后果**为静态调用图推断，未在宿主运行态复现；因 `judgeConnection` 无调用者，模拟套件里没有能触发该路径的用例。
4. 全仓类型检查的 2 处错误来自他人并发改动，未 fix，也不属于本专项；若 Lead 要全仓 `pnpm check`，需先与改动方对齐。
5. 未跑桌面 `go test`、手机 `./gradlew test`、Python 传输测试 —— 不在本专项范围，且按要求由另一 session 负责真机 / 业务实测。
