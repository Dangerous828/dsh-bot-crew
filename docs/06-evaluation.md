# 06 · 评估

日期：2026-11-09　评估对象：本仓库 `main` @ `29de969` + 本次修复

> 本文件是一次独立评估的结论，不是设计文档。
> 评审范围**只包括本仓库**。宿主（`dsh-superagent`）与手机端（Kotlin）在另外的 checkout 里，
> 本次无法验证，见 §5。

## 0. 一句话结论

**设计文档的质量明显高于工程防护的水平。**

核心判断全部站得住：一本账、确定性路由、授权与呈现分离、默认少打扰。
缺的不是想法，是把文档里的声明变成**自动化检查**——现在很多「已验证」只写在 md 里，
换台机器、隔一周就没有东西替你守住。

| 维度 | 评分 | 依据 |
| --- | --- | --- |
| 架构判断 | **A** | 三条硬约束互相支撑，没有哪条是为了好看加的（§1） |
| 文档诚实度 | **A** | 记录了推翻自己的过程，也写了做不到的事（§2） |
| 纯逻辑实现 | **A-** | 677 行里核心路由/目录很干净；有几个静默失败点（§3） |
| 可复现性 | **C** | 无 CI、无 lockfile、`team.ts` 不可检查、`tsc` 原本跑不通（§4 A） |
| 安全姿态 | **D** | 裸跑 + `blockedCommands: []`，文档说了危险但配置全开（§4 C1） |

## 1. 值得肯定的设计判断

这几条我认为是对的，并且理由是**约束下推出来的**，不是偏好：

| 判断 | 为什么成立 |
| --- | --- |
| Bot = Source 实例 + persona 注入，不 fork 内核 | 两套状态主体必然打架。`team.ts` 与宿主 `mobile.ts` 同构，接进去不改 Engine 一行 |
| 路由确定性，不由模型决定 | `routeBot()` 是纯函数，@ → 第一个已知 id，无人 @ → 大哥。模型不参与「谁接话」，所以路由可测、可复现 |
| 授权与呈现分离 | `meta.bot_id` 只选人格/记忆/署名，不进 Gate。这条挡住了「换个 Bot 就绕过 Policy」的整类问题 |
| 「大哥默认接话」而非「被叫才开口」 | 反面方案要人多打一个 `@` 才说得上话。用 `obs­erve` + 署名 + 点芯片换人兜住话痨，代价是已知的 |
| 记忆按 namespace 落盘、禁止 hard delete | 一条事实一个 md，纠错写新条 + `supersedes`。这让文件系统本身可审计 |

`docs/01` 那张「为什么不合并内核」的表是整个仓库最有价值的一页：
它逐条说明了后台与 Tobs 的**互斥点**（状态主体、授权、会话拓扑、事件层次），
而不是笼统地说「我们的更好」。这种写法让后来的分歧有地方吵。

## 2. 文档最值得保留的部分：失败记录

比代码值钱。这些是实测才知道、写不进设计稿的东西：

1. **模型配错不报错，Eval 永远卡在 `evaluating`**（`docs/04`）。症状是消息进来了、游标走了、`evalId` 有了，
   但既不超时也不产出决策。静默失败最贵，这条记录省掉后来者几小时。
2. **角色边界是软约束，提示词劝不住**。试了三个版本的提示词，第三个版本模型「以为自己替写手说话」，
   结论落到「不靠劝，靠署名 + 人换人」。而且明确了要做 AI 自主转派得让 worker 能发新工单，是本版之外的方向性改动。
3. **记忆隔离是约定不是强制**。引用了宿主源码注释（`Provides default-path guardrails rather than an
   OS-level security boundary`），并列了三种强制隔离方案的代价。没有假装有隔离。
4. **保留被推翻的结论**。「模拟器连不上」→ 其实是自己漏填端口。多数人会删掉这段。

## 3. 本次评估修掉的问题

已提交为 `fix:` 一笔，全部附测试。修前修后都跑过 `npm run typecheck && npm test`。

| # | 问题 | 影响 | 验证 |
| --- | --- | --- | --- |
| 1 | `tsconfig` 声明 `types: ["node"]`，但 `package.json` 没有 `@types/node` | 新 clone 上 `npm run typecheck` 直接 `error TS2688`，**exit 2**。而 README 与 `docs/04` 都写着「tsc 0 错」 | 修后 0 错 |
| 2 | `MemoryRecord` 无 `title` 字段，`renderMarkdown` 不渲染它 | `docs/02` 里实测落盘的文件第一行就是 `title:`——**文档演示过的格式，代码产不出来** | 新增字段 + 顺序测试 |
| 3 | `status` 类型只有 `candidate \| verified`，而 `injectable()` 在检查 `disputed`/`superseded` | 那两个分支**永远走不到**。配上「不做 hard delete」的约定，等于作废一条记忆时没有合法写法 | 补 `MemoryStatus` |
| 4 | `formatValue` 只给含 `:#` 的值加引号 | `description: yes` 读回来是布尔 `true`，`description: 123` 是数字，行尾空格会被当成续行开头。**字段静默变形** | 保留词/数字样式/行尾空格一律加引号 |
| 5 | `team.ts` 的 `BotSchema` 是 `.strict()` 且无 `avatar`/`color` | 契约 §2 两个字段都在。往 settings 写进去，整份名录被判成不可读 | schema 收下并透传 |
| 6 | README 源码表误粘在「两条命令」的代码块之后，脱离表格 | 渲染成一段孤立文本 | 并回「目录」表 |
| 7 | `fileNameOf(botId, name)` 的 `botId` 完全没用（原实现 `botId ? x : x`） | 恒等分支，读代码的人会以为它做前缀校验 | 改名 `_botId` 并注明由 `planWrite` 保证 |

## 4. 仍然存在的问题

### A. 会静默出错或阻塞的

**A1. `src/sources/team.ts` 不在任何检查范围内。**
`tsconfig.json` 的 `exclude` 里有它（第 26 行），因为它 import 宿主才有的 `@deepseek-ai/cordis`。
后果：这个**唯一直接写宿主 API 的文件**（325 行）改名、改签名，本仓库全绿，宿主构建才红。
`docs/04` 那句「`tsc --noEmit` 0 错」实际不覆盖它。这是当前最大的可复现性缺口。

**A2. 游标无单调性校验。**
`pollQueue` 结尾是无条件覆盖：

```ts
ctx.state.set(CURSOR, Number(page.next))
```

若 `mobileq pull --after` 因重启、队列重建或 `--json` 里 `next` 类型变化而返回更小的值，游标会**倒退**，
同一批消息被重复 `ctx.receive()`。目前唯一防线是后台按 `team:<message-id>` 幂等——这一层没有本地断言，
也没有测试。一行 `Math.max(after, Number(page.next))` 加一个边界测试就能堵住。

**A3. `repliesTo` 依赖一个从不写入的字段。**

```ts
repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? ... : undefined
```

`teamTrigger()` 从不设置 `meta.parentId`，所以恒为 `undefined`。Bot 之间「回应某条具体消息」的关联
静默丢失。要么补写入，要么删掉这个钩子，别留一个看着能用实则空转的分支。

### B. 契约与实现不一致的

| # | 位置 | 不一致 |
| --- | --- | --- |
| B1 | `docs/00 §3` vs `team.ts:89` | 契约写「若 Bot 自身发言，`addressed` 省略」；实现是 `sender.id === me` 时**整条消息不上报**。处理方式没错，但「省略 addressed」那条分支走不到，照契约读代码会以为存在这条路径 |
| B2 | `docs/00 §5` | `/timeline` 只定义了 `items/tasks/status`，但 `doctor.sh` 和手机端实际读的是 `bots/default_bot_id`。契约缺这一段，而 `doctor.sh` 的核心校验恰恰依赖它 |
| B3 | `README.md:21` vs `docs/03` | README 写「两条文档测试」，`docs/03 §4` 标题写「三个」且表格三行 |
| B4 | 计数漂移 | `docs/04:7` 写「20 个测试」，现为 23；README:60 与 docs/04 对后端目录用了不同名字（`~/Code/dsh-superagent` vs 纯仓库名） |
| B5 | `README.md:53` 边界声明 | 自称「示例路径一律写成 `$DSH_HOME`」，但有 3 处本机绝对路径：`docs/02:68`、`docs/04:185`、`docs/05:117`（后者是 `JAVA_HOME`） |
| B6 | `namespaceOf` 定义两次 | `src/crew/directory.ts:55` 与 `src/memory/adapter.ts:106`，字面量 `bot/${botId}` 也重复两次。改名要记着改两处 |

### C. 设计层面的风险（不是缺陷，是需要拍板的）

**C1. 唯一「文档说危险、配置却全开」的地方。**
`README` 与 `docs/01` 都写明 worker 是**无审批裸跑**、接 IM/公网前必须先隔离。
但 `scripts/configure.py` 直接把 `blockedCommands` 写成 `[]`：

```python
save('executor', {'model': model, 'maxWorkers': 3, 'directory': '', 'prepare': '', 'blockedCommands': []})
```

`blockedCommands` 是现成的、不需要改宿主的缓解手段。哪怕只拦 `rm -rf`、`curl | sh`、`git push --force`，
也比空数组强。**这条我建议在接任何外部 IM 之前先做**，成本最低、收益最直接。

**C2. 分流规则只存在于文档。**
`MemoryRecord.toHub` 字段声明了但**没有任何代码读它**；`underDailyBudget` 只被测试调用。
「Bot 碎碎念留本地、只有 owner 偏好/决策上 Hub」这条规则，代码层没有强制点，全靠写的人自觉。
原型阶段可以接受，但要标记为「规则已声明、未执行」。

**C3. `policy.admission` 没有被真正设置。**
`configure.py:136` 只是把已有值原样透传，缺失时写空对象：

```python
sources['team'] = {**sources.get('team', {}), 'allowed': [allowed],
                   'admission': sources.get('team', {}).get('admission', {})}
```

而 `docs/00` 说「admission rows 管群/私聊的接收范围」。配置脚本里这一层是空的。

**C4. `botCards()` 无测试。** 它是前台拿名单的唯一出口，现在零覆盖。
**C5. 无 CI。** 没有 `.github/`，所有验证依赖人手跑。
**C6. 无 lockfile。** `package-lock.json` 从未提交，`@types/node`、`vitest` 的次要版本会漂。

### D. 叙事上最该修的一处

关于记忆，三份文档三种说法：

| 位置 | 说法 |
| --- | --- |
| `README.md:64` | 「记忆真正可用……已实测跨工单召回」 |
| `docs/04-verified.md:40` | 「记忆落盘与 Hub 上行……尚未接」 |
| `docs/02-memory-bridge.md:58` | 「骨架，尚未接线」 |

**三句都对，但没说清是两件事：**

- worker **自己**用 bash 读写 `~/.dsh/memory/bot/<id>/` → **已实测可用**（跨工单召回成立）
- 适配层的 `planWrite` / `recall` / Hub 上行 → **纯函数，未接线**

读者按顺序读会以为文档自相矛盾。建议在 `docs/02` 开头就把这两层拆开写，
而不是靠读者自己在 700 行后再拼出这个区别。

## 5. 本次评估没覆盖到的（诚实说明）

| 未覆盖 | 原因 |
| --- | --- |
| 宿主侧 10 个 `team.ts` 测试、1213 全量回归、`tsdown` 构建 | 宿主 checkout 不在本仓库，无法运行 |
| 端到端链路（队列 → Trigger → Eval → Ticket → worker → 回话） | 需要后端 + `mobileq` + 模型凭据 |
| 手机端（芯片、署名、重连） | Kotlin 客户端在另一个仓库 |
| `docs/04` 里所有「实测」结论 | 只能核对内部一致性，无法复现 |

所以上面 §1/§2 的肯定是**基于文档与代码的交叉核对**，不是基于重跑实验。
若 `docs/04` 的记录有误，本评估继承该误。

## 6. 建议的下一步（按性价比排序）

1. **给 `team.ts` 一个检查点**。最省事：在 CI 里 clone 宿主、把文件拷进去跑 `tsc`。次省事：为它建一个只检查
   import 形状的 stub 目录。当前状态等于「仓库里最重要的一百行无人看守」。
2. **游标单调性**（A2）+ 一个边界测试。一行代码。
3. **`configure.py` 别再写 `blockedCommands: []`**（C1）。这是接外部 IM 的前置条件。
4. **修 `repliesTo`**（A3）：补写入或删掉，别留空转分支。
5. **统一叙事**（D）：`docs/02` 开头拆成「worker 自读写（已可用）」与「适配层（未接线）」两节。
6. **契约补齐**（B1/B2）：`/timeline` 加 `bots/default_bot_id`；`addressed` 那条改为「Bot 自身消息不产生 Trigger」。
7. 补 `botCards()` 测试、上 CI、提交 lockfile —— 一次做完，之后每次改动都有网兜着。

前 3 条做完，这个仓库才算「换台机器也能证明自己是好的」。
