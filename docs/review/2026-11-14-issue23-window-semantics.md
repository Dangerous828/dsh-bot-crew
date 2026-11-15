# #23 报表窗口语义：停机错过的通知不补发，下一次实际报告不漏统计

> 日期：2026-11-14
> 范围：`backend/src/app/runtime.ts`、`notices-out.ts`、`backend/src/kv.ts`、
> `backend/tests/crew-morning.spec.ts`、`backend/tests/notices-morning.spec.ts`、`backend/docs/007-architecture.md`、本报告
> 不涉及：`environment` / `policy` / `client` / `http` / `app` / `desktop` / `开发进度.md` / `HANDOFF.md` /
> `scripts/crew-watch`；不动 `backend/lib` 构建产物、不碰 HMR 生产设置、不 commit / push。

---

## 一、两个真问题（审计给的那个不是最要命的）

### 1.1 `spoken` 分支不可达（审计发现）

`runMorning` 里：

```ts
if (said?.day === day) return undefined
const spoken = said?.day === day ? said.spoken : []   // ← 上一行已 return，条件恒假
```

`spoken` 恒为 `[]`。**这不是一个独立的 bug，是上一轮去重语义没落地留下的残骸**：
早报本来就要「同一天只说一次」，那条 return 已经把「今天说过了」挡住了，所以 `spoken`
在早报这一侧根本不需要承接昨天那本账。修法不是把 `return` 挪走（那会让早报一天发多遍），
而是删掉这个死分支：现在 `morningNotice` 交回的 `spoken` 原样落库，不再读旧值当输入。

### 1.2 停机窗口整段丢失（更要命，审计只看到一半）

审计提的是「08–21 进程完全不在线时，昨夜 21–24 结束的票不在早报（没跑）也不在日报（从今天零点算）」，
并建议把日报下界改成 `max(今天零点, 昨晚 21 点)`。

**这个建议仍然漏**：它只补回「昨晚 21–24」这三个小时。停机一整天（比如周末关机）时，
`max(今天零点, 昨晚21点)` 的下界还是今天零点，昨天全天的票照样丢；而水位在更早的时候，
那段更长的停机窗口也一样没人报。

真正的下界只能是**上一次报表真跑到的时刻** —— 那是一个持久化的事实，不是能现算的公式。
任何从 `now` 反推的公式（今天零点、昨晚 21 点、两者取大）都在假设「那些报告按时跑过」，
而停机正是这个假设不成立的情形。

---

## 二、定下的语义（按 lead 的取舍）

**不补发错过的通知；下一次实际报告统计覆盖所有尚未报告的有效窗口。**

- 「不补发」指**不伪造历史时点的通知**：不会在 08:00 醒来后补推一条「昨晚的日报」，
  也不会把已经过去的时点包装成当时发出的样子。人醒来看的是当下这份报告。
- 「不漏统计」指**下一次真跑到的报告，窗口从上次报完那一刻接上**：昨天 22:00 办完的票，
  会出现在今天早上那份早报里；如果连早报都没跑（整天关机），它出现在今晚那份日报里。
- 两份报告共用同一条水位线，所以它们天然首尾相接，不重不漏。

### 实现

`KV.notices.reported`（`notices-reported`）存一个 ISO 时刻：**报表已经统计到的那一刻**。

```ts
private reportedFrom(now: Date): Date {
  const reported = this.store.get(KV.notices.reported)
  const at = reported === undefined ? NaN : Date.parse(reported)
  return Number.isFinite(at) && at <= now.getTime() ? new Date(at) : startOfLocalDay(now)
}
```

- `runMorning` 与 `runDaily` 都用它当下界。
- 两者**只要真跑到就推进水位**（包括「安静得没内容可发」的那一拍）：那一段确实被统计过了，
  不推进会让下一份报告把它再数一遍。
- 缺水位（第一次启动、或从老版本升上来）时退回**今天零点**，不考古：从没报过的机器
  不该把库里所有结束过的票都算成「昨夜」。
- 水位在将来（时钟回拨过）时同样退回今天零点：宁可少报一段，也不能让窗口为负、数出 0 件。

### 被删掉的东西

`notices-out.ts` 里的 `overnightStart(now)`（「昨天 21:00」那个公式）已删除。它不只是没人用了 ——
它**就是**被否定的那个假设的化身（「昨晚日报跑过」）。留着它，下一个人会以为那是正确语义再拿回去用。
删除处留了一段注释说明为什么不能现算，指向 `KV.notices.reported`。

`KV.notices.morning` 的 `at` 字段也删了：它原本的用途是「日报的窗口从早报发出那一刻接上」，
现在由 `reported` 承担，`at` 成了一个没人读的字段。`morning` 现在只剩 `{ day, spoken }`。

### 关于 `spoken` 那个死分支

删掉它，并让 `runMorning` 把 `morningNotice` 交回的 `spoken` **原样落库**（不再读旧值当输入）：
早报当天只说一次由 `said?.day === day` 保证，所以当天的 `spoken` 必然是这一轮攒下来的，
不需要（也不可能）从昨天接着用。日报读同一本账时用 `morning?.day === day ? morning.spoken : []`，
这个条件是对的 —— 昨天那本账不该压今天的日报。

---

## 三、测试证据

### 3.1 新增/改写的用例（`backend/tests/crew-morning.spec.ts`，20 例）

| 用例 | 守的是什么 |
|---|---|
| **covers the window it was offline for, instead of dropping everything before midnight** | 整夜不在线：水位停在昨天 08:00，昨夜 22:00 办完的票**必须**出现在今早那份早报里。这是审计建议公式（`max(今天零点, 昨晚21点)`）恰好漏掉的位置 |
| **covers the night in the daily report when the morning never ran at all** | 更狠一档：早报整段（08–21）没跑，直到今晚 21:00 才第一次跑日报 —— 昨夜那件必须在日报里 |
| **does not dig up ancient history on a first start with no ledger at all** | 反向：没有水位线时不考古，十天前的票不算「昨夜」 |
| **picks up where the last report left off across a day boundary** | 跨日接续：昨天 08:00 报过、昨天 09:00 办完的活今天必须报 |
| **keeps the covered watermark across a restart** | 水位落库，进程重起不会重报已覆盖窗口 |
| **does not repeat the night the morning already covered, when only the morning ran that day** | 早报自己也要推进水位：昨天早报说过的昨夜，今天早报不能再说一遍 |
| **moves the watermark on a quiet morning too, even though nothing was sent** | 安静的一拍也推进水位：水位是「统计到哪」，不是「哪天发过」 |
| **names the real window instead of calling a multi-day backlog 昨夜** | 文案：跨多天水位不冒充「昨夜」，写出真实起点 |
| **says 今日 on a first start…** | 文案：首次启动窗口确实从今天零点起，说「今日」 |
| **names the day the window started when the last report was yesterday** | 文案：跨一日写「自 11 月 13 日 08:00 起」 |

既有 10 例中两例补了前置状态（`sends the morning report once…`、端到端那条）：它们的「昨夜 22:00 那件」
现在需要「昨天日报真报过」这个前提才在窗口里 —— 这正是新语义，测试跟着语义走。

`backend/tests/notices-morning.spec.ts`（28 例）：

- 删掉 `overnightStart` 的 2 例（函数已删）。
- `startOfLocalDay` 补一例说明它现在只是「从没报过」时的兜底，不是「昨夜」的定义。
- 新增 `the two windows never overlap`：遍历 24 小时 × 3 个分钟，断言 `morningDue && dailyDue` 永不同时成立 ——
  调度器每拍并发 `void runMorning()` / `void runDaily()`，两者窗口互斥，「同一拍都跑、抢写同一条水位线」从根上不会发生。

### 3.2 定向

```
npx vitest run tests/crew-morning.spec.ts tests/notices-morning.spec.ts \
                 tests/crew-notices-out.spec.ts tests/runtime.spec.ts
  Test Files  4 passed (4)
  Tests       173 passed (173)
```

连跑三次（三个报表 spec）：`47 passed` × 3，无抖动。补文案后同一组为 `56 passed`。

**一次瞬时假红（如实记）**：同一时刻我并行发起了「定向测试」与「`git status`」两条命令，
那一次定向报 `143 failed / 30 passed`。紧接着用**完全相同的命令**重跑，`173 passed`。
原因是在同一台机器上并发跑 vitest 与其它 agent 的全量，`tests/fixtures/host.ts` 里的
`mkdtempSync` 临时目录 + 假时钟被两批进程争抢，不是代码问题。判定依据：同一命令重跑三次稳定全绿，
且失败数与用例总数（173）接近「几乎全部」，只有环境争抢才会这样，逻辑错误不会。
教训：在这台共享工作树上跑全量/定向不要与其它 agent 的 vitest 并发。

### 3.3 全量

```
npx tsc --noEmit                              → 0 错
npx vitest run --exclude tests/environment-credentials.spec.ts
  Test Files  112 passed (112)
  Tests       2006 passed (2006)   exit 0
```

**过程中的波动，如实记**：本次工作期间共享工作树上其他 owner 在陆续加文件/改字段，
所以中间几轮全量出现过 2–4 条红，全部落在 `docs.spec.ts`（未跟踪文件未登记进 007）与
`settings.spec.ts` / `policy.spec.ts`（`policy.ts` 新增 `memory.tokenEnv`，期望值没跟上）。
时间线：17:56 第一次全量 1953 例全绿 → 17:57 他人的 `src/memory/auth.ts`、`policy.ts` 改动落进工作树
→ 17:58 三例红 → 18:02 只剩 `docs.spec` 两条 → 最终全量 2006 例全绿（对方自己补齐了登记）。

判定「与我无关」的依据：`git cat-file -e HEAD:backend/src/memory/auth.ts` → `exists on disk, but not in 'HEAD'`，
`git status` 显示 `??`（我一行没碰，也不在写范围内）；`git show HEAD:backend/src/policy.ts | grep -c tokenEnv` → 0。
这几个 spec 都不 import `notices`。按写范围约定归各自 owner，未代改。

## 四、反向验证（每条真跑过，实现逐字恢复后复验）

反向验证证明测试不是同义反复。每次改完都 `diff` 确认 `runtime.ts` 恢复到与备份逐字一致。

| # | 改回什么 | 结果 | 证明 |
|---|---|---|---|
| 1 | 窗口下界改回审计建议的 `max(今天零点, 昨晚21点)` | **6 例红**，含 `covers the window it was offline for` | 审计那个公式确实漏；这条测试能分辨两种实现 |
| 2 | 报表跑完不推进水位（只靠「今天说过没有」去重） | **2 例红**（离线窗口、日报窗口接续） | 水位前进是真的 |
| 3 | 没有水位时考古（兜底改成 `new Date(0)`） | **1 例红**（首次启动不考古） | 「不考古」是被测出来的 |
| 4 | 日报退回 `startOfLocalDay(now)` | **2 例红**（早报接续 + 早报完全没跑时的日报） | 日报窗口不是今天零点 |
| 5 | 只有日报推进水位、早报不推进 | **3 例红**，含 `does not repeat the night the morning already covered` | 早报自己也必须推进，否则第二天重报 |
| 6 | 只有「真发出去」才推进水位（没内容时不推进） | **1 例红**（安静早晨的水位） | 「统计到哪」与「发过没有」是两件事 |

---

## 四·补 文案：抬头按真实窗口起算（不一律「昨夜」）

水位跨多天时，数是真的、但「昨夜」这个**时间范围**是假的。这是本次修复必须配套的最小文案，
不是新设计 —— 复用既有的 `dayLabel` / `clockOf`。

`notices-out.ts` 新增纯函数 `windowLabel(windowStart, day)`：

| 情形 | 抬头 |
|---|---|
| 窗口起于今天之内（含首次启动从今天零点） | `今日` |
| 窗口起于更早 | `自 11 月 12 日 08:00 起` |
| 没有水位线 / 时刻不可解析 | `上次汇报以来` |

`morningNotice` 的「昨夜」那一行改成 `${windowLabel(facts.windowStart, facts.day)} ${night}`。
`MorningFacts` 新增 `windowStart?: string`；`runMorning` 把 `reportedFrom(now)` 的 ISO 时刻传进去 ——
**只取一次**，既用来数票也用来写抬头，否则「自 X 起」与它后面那个数说的不是同一段。

日报的正文（`dailyNotice`）没动：它本来就只写「办完 N 件」不带时间范围，不存在误报。

### 文案的行为断言

`notices-morning.spec.ts` 新增 8 例：`windowLabel` 三分支各一（今日 / 自…起 / 上次汇报以来）、
「任何窗口都不含『昨夜』」、以及同一批数换窗口就换抬头（`自 11 月 12 日 08:00 起 办完 12 件`
vs `今日 办完 12 件`）、无水位时不编造具体时刻。

`crew-morning.spec.ts` 新增 3 例走真 `Runtime`：

| 用例 | 守的是什么 |
|---|---|
| **names the real window instead of calling a multi-day backlog 昨夜** | 水位停在 12 日 08:00、14 日才报：正文必须写 `自 11 月 12 日 08:00 起`，且**不含「昨夜」** |
| **says 今日 on a first start, because its window really does start at midnight** | 首次启动（无水位）→ 窗口确实从今天零点起 → 说 `今日`，不退回「上次汇报以来」 |
| **names the day the window started when the last report was yesterday** | 跨一日：水位在昨天 08:00 → `自 11 月 13 日 08:00 起 办完 1 件` |

### 文案的反向验证

| # | 改回什么 | 结果 |
|---|---|---|
| A | 抬头退回一律 `昨夜` | **10 例红**（含三条跨日行为断言） |
| B | `runMorning` 不传 `windowStart` | **5 例红**（全退回「上次汇报以来」） |
| C | `windowLabel` 恒返回 `今日`（忽略跨日） | **6 例红** |

每次改完都 `diff` 确认源码恢复到与备份逐字一致。

## 五、边界与取舍

**明确的取舍（lead 定的）**：不补发错过的通知，但下一次实际报告覆盖未报窗口。
代价是：停机很久后醒来，第一份报告会把很长一段的累计数一起统计。这是**如实**的 ——
那段确实发生了、确实没报过；把数藏起来才是撒谎。抬头按真实窗口起算（§四·补），
所以人看到的是「自 11 月 12 日 08:00 起 办完 12 件」，而不是「昨夜办完 12 件」这种假的时间范围。

**没做的事**：

- 没有为 `reported` 做清理/裁剪。它是一条单键，覆盖写，不增长。
- 没有改日报正文的措辞：它本来就只写「办完 N 件」不带时间范围，不存在误报。
- 没有动 `#23` 的另两项（真实邮箱 / 日历监听源），也没有造 no-op 账号适配、没读任何个人邮箱。
  真实设备晨报未送达这件事仍然成立，`#23` 保持 OPEN。

**同拍并发**：`startRoutines` 的 tick 里 `void this.runMorning()` 与 `void this.runDaily()` 并发发起。
两者窗口互斥（§3.1 的 24 小时遍历用例钉住），所以同一拍只可能有一个真跑；
`runDaily` 先读 `KV.notices.daily`、`runMorning` 先读 `KV.notices.morning`，各自有独立的「今天说过」判定。
同一进程内 `store.get` / `store.set` 是同步 SQLite 调用，不存在写一半被另一条读到的情况。

**日历 `unavailable`**：早报的日程栏仍如实写「今日日程读不到（还没有接入日历）」，
不冒充「今天没会」；且「读不到」本身不单独推一条。这部分语义未改，只是窗口下界换成了水位线。

**零内容**：三段全空时早报不发，但水位照样前进（反向验证 #6）。日报同理：`dailyNotice` 返回
`undefined` 时不推，但 `KV.notices.daily` 与 `reported` 都写。

---

## 六、写范围与协作

- **我改的**：`backend/src/app/runtime.ts`、`backend/src/app/notices-out.ts`、`backend/src/kv.ts`、
  `backend/tests/crew-morning.spec.ts`、`backend/tests/notices-morning.spec.ts`、
  `backend/docs/007-architecture.md`、本报告。
- **我没改的**：`environment` / `policy` / `client` / `http` / `app` / `desktop` / `开发进度.md` /
  `HANDOFF.md` / `scripts/crew-watch` / `backend/lib`。
- **没做**：不 commit、不 push、不 build `lib`、不改 HMR 生产设置、不 stash / checkout / restore / reset / add。
- 全量里那 3 个失败已定位到 memory-hub / policy 两个 owner 的未提交改动（§3.3），未代改。
