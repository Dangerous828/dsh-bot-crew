# #23 晨报：运行接线与持久化去重

> 日期：2026-11-14
> 范围：`backend/src/app/runtime.ts`、`notices-out.ts`、`calendar.ts`、`followup.ts`、`backend/src/kv.ts`、
> `backend/tests/crew-morning.spec.ts`、`backend/tests/notices-morning.spec.ts`、`backend/docs/007-architecture.md`
> 不涉及：真实邮箱 / 日历账号适配（`MailPort` / `CalendarPort` 实现）、`backend/lib` 构建产物、配置、生产服务重启。

---

## 一、根因（不是「没接线」，是三条一起）

审计给的起点是「`morningNotice` / `morningDue` 只在 `notices-out.ts` 与 tests 里，runtime tick 只跑
`runRoutines` / `runSelfHeal` / `runFollowups` / `runDaily`」。核实后确认属实，但只补一根线是不够的：

### 根因 1：晨报从来没有调用者

`startRoutines()` 的每分钟 tick（`runtime.ts` 原 1398–1406 行）里没有 `runMorning`，
`Runtime` 上也根本没有这个方法。内容层（`morningNotice`）写完了、单测 22 例全绿，但**生产路径上不存在这个调用**，
所以「晨报」这个功能一行都没跑过 —— 典型「纯函数全绿但功能是死的」。

### 根因 2：日报的「办完 / 失败」恒为 0，日报在真办成过事的晚上也不说话

原 `runDaily`：

```ts
const tickets = this.store.tickets.open()                      // open 的判定是 ended IS NULL
const finished = tickets.filter(ticket => ticket.ended && ...)  // 从「没结束的」里筛「结束的」
```

`store.tickets.open()` 的 SQL 是 `WHERE open = 1`，而 `open` 是生成列 `CASE WHEN value -> '$.ended' IS NULL THEN 1 END`。
从「没结束的票」里筛 `ticket.ended`，结果**恒为空**。于是 `finished` / `failed` 永远是 0；
`dailyNotice` 在「全是 0 且没有 highlights」时正确地返回 `undefined`（「一条『今天什么也没发生』只是在占人时间」），
**于是日报在真办成过事的晚上也从不发**。这不是 #23 引入的，但它让「日报在」这个前提本身站不住 ——
晨报的「昨夜动态」用的是同一套计数逻辑，不修就等于把同一个 bug 复制一份。

### 根因 3：两份报告的「今天说过了」记在进程内存里

原 `runDaily` 用 `private dailySaid = ''` 这个字段去重。进程重启就归零 ⇒ 同一天可能报两遍；
`routinesToday` 同样在内存里，重启后日报会说「到点派了 1 次」而实际派了 5 次。
AGENTS.md 那条「『重启又回到旧状态』是典型信号」正指这个。

---

## 二、改了什么

### 2.1 `runMorning`（新），接进 tick

```ts
void this.runFollowups().catch(...)
void this.runMorning().catch(error => { console.log('[morning] tick failed: %s', String(error)) })
void this.runDaily().catch(...)
```

**顺序有意**：早报在日报之前。日报的统计窗口从「早报真发出去的那一刻」接上，所以早报必须先跑。

`runMorning` 的三段口径与 `morningNotice` 一致：昨夜动态 / 今日日程 / 待处理。
窗口由 `morningDue` 卡在 `[MORNING_HOUR, DAILY_HOUR)`，过了日报的点就闭嘴。

### 2.2 时间口径改成「本地日」

原 `runDaily` 用 `now.toISOString().slice(0, 10)` —— 那是 **UTC 日**。北京早上八点是前一天 16:00Z，
按 UTC 取日会把早报算到昨天，「今天说过没有」这笔账天天错一天。新增：

- `localDay(now)`：本地 `YYYY-MM-DD`
- `dayLabel(now)`：抬头 `11 月 14 日`（日报原写法，两处统一）
- `startOfLocalDay(now)`：本地今天零点
- `overnightStart(now)`：**昨天日报那一刻**（不是今天零点）
- `clockOf(iso)`：本地钟点 `09:05`（给接上日历那天用）

`overnightStart` 用「昨天 21:00」而不是「今天 00:00」是 issue 里「与日报不重复轰炸」的第一层保证：
用零点当界的话，昨晚 21:00–24:00 那三个小时会被两份报告各说一遍。

### 2.3 三本账落库（`KV.notices.*`）

```ts
notices: {
  daily:    record<string>('notices-daily'),                            // 日报说过的本地日
  morning:  record<{ day: string; at: string; spoken: string[] }>('notices-morning'),
  routines: record<{ day: string; count: number }>('notices-routines'),
}
```

**三个键而不是一条记录**：挤在一条里时，白天每派一次常规任务就会把「今天日报说过了」那一位一起写掉，
当晚的日报被自己压掉。这是「一个字段装两件事」的老坑，特意分开。

- `morning.at`：早报**真发出去的时刻**，日报的窗口从这里接上（`countEnded(from, now)`）。
  早报没发（三段全空，或那天进程没开）就退回今天零点。
- `morning.spoken`：`onceToday` 那本账原样落库，下次调用接着用。

### 2.4 两份报告共用一本「当天账」

`runDaily` 现在也读 `morning.spoken`，把早报已点名的事从 highlights 里剔掉：

```ts
highlights: onceToday(pending, morning?.day === day ? morning.spoken : []).items.map(item => item.text)
```

「N 件等你」这个**数**不缩水（它是此刻的真实积压），重复的只是同一条**明细**。
这是 `notices-out.ts` 里 `onceToday` 注释写的原意（「同一张等人的票会同时出现在两边的待处理里」），
但之前没有任何调用方 —— 补上调用方才算把这条约定变成机制。

### 2.5 「日历读不到」与「今天没会」分开

设计系统 §六：`live` / `empty` / `unavailable` 三态不许混着画。早报的日程栏没有接入源，
所以正文如实写 `今日日程读不到（还没有接入日历）`，不冒充「今天没会」。

但**「读不到」本身不单独推一条**：每天早上一句「还没接入日历」是纯噪音，人两天就会把早报静音，
那连该看的东西也一起错过。它只在早报本来就要说点别的时，作为那一栏的实话出现。
这条判断在 `morningNotice` 里（纯函数，有测试），常量 `CALENDAR_UNAVAILABLE` 在 `calendar.ts` ——
接上真实日历那天，删掉这一个引用就等于把「读不到」换成真日程，不会漏下某处还在说读不到。

### 2.6 顺手收口：「等你处理」的措辞抽成一处

`followup.ts` 里 `followupText` 内联的 `action → 一句话` 抽成 `waitingWhere(action)`，
跟进提醒与早报「待处理」共用。各写一份的结果是同一张票在两处被叫成两回事。

---

## 三、测试证据

### 3.1 新增 `backend/tests/crew-morning.spec.ts`（10 例，全走真 `Runtime`）

| 用例 | 守的是什么 |
|---|---|
| 早报窗口内发一次、同一天不再发 | 基本接线 + 去重 |
| 八点前与日报之后都不发 | 窗口边界 |
| 安静的早晨不发，且不每拍重算 | 三段全空 → 不发；但日子照样记下 |
| 待处理与日报共用一本账 | `onceToday` 的调用方真的存在 |
| 日报窗口从早报发出那一刻接上 | 不重复计数（夜间 3 点的票是关键判别点） |
| 日历读不到时如实写 | 三态不混 |
| 重启后同一天不再说 | **持久化**去重 |
| 常规任务次数跨重启不归零 | 持久化计数 |
| tick 里真被调到且排在日报之前 | **回归守门**：这根线断了就红 |
| 端到端：真调度器走一拍 → 真推送到推送出口 | 全链路，一处不替身 |

`notices-morning.spec.ts` 从 14 例增到 22 例：补 `localDay` / `dayLabel` / `startOfLocalDay` / `overnightStart` /
`clockOf`，以及「日历读不到不单独推一条」。

### 3.2 全量

```
npx vitest run --exclude tests/environment-credentials.spec.ts
  Test Files  111 passed (111)
  Tests       1948 passed (1948)
npx tsc --noEmit   → 0 错
```

`environment-credentials.spec.ts` 是**另一位 owner 的未跟踪新文件**（prepare 凭据路径，非本任务），
在本次改动前后都是同一个失败（`ENOENT .../creds-home-*/.npm/_authToken`，该文件不存在），与本改动无关，未代为修改。

---

## 四、反向验证（每条都真跑过，exit code 记录在案）

反向验证的意义是证明测试**不是**同义反复 —— 把实现改回错误的样子，测试必须红。

| # | 改回什么 | 结果 | 证明 |
|---|---|---|---|
| 1 | 从 tick 里删掉 `runMorning` 那一行 | **2 例红**（回归守门 + 端到端），`expected [ 'daily' ] to include 'morning'` / `expected [] to have a length of 1` | 新接线是**被测出来的**，不是被假装的 |
| 2 | `countEnded` 用回 `tickets.open()` | **2 例红**（早报发不出、日报窗口用例） | 根因 2 是真根因；`open()` 恒 0 |
| 3 | 不落 `KV.notices.morning`（退回内存去重） | **3 例红** | 持久化去重是真的 |
| 4 | 日报窗口退回 `startOfLocalDay` | **1 例红**（`办完 2 件`） | 窗口接续是真的；**这一条第一次写时是绿的 —— 测试不敏感，已修**（见 §五） |
| 5 | `runDaily` 不读 `morning.spoken` | **1 例红**（`'1 件等你\n「修卡顿」在等你回答' not to contain '修卡顿'`） | 共用账本是真的 |
| 6 | 去掉 `calendarNote` | **3 例红** | 三态不混是真的 |

恢复后每次都回到 `10 passed` / `TSC_OK`。

---

## 五、过程中自己抓到的一个测试缺陷（值得记）

反向验证 #4 第一次跑是**绿的** —— 说明那条用例根本没在测窗口。

原因：我用**同一张票**改 `ended` 时刻来模拟「昨夜办完」和「白天办完」。同一张票只有一条记录，
无论窗口从哪起算都得 1 件，所以两种实现都通过。

修法：用**两张不同的票**，且夜那张故意落在**今天凌晨 3 点** —— 这是唯一能区分两种窗口的位置
（既在「昨天 21:00 之后」的昨夜窗口里，又在「今天零点」之后）。改完后反向验证 #4 如期变红。

**这条记在这里的原因**：一个「绿」的反向验证比没有反向验证更危险 —— 它让人以为测过了。
以后写窗口/区间类断言，先问「这个输入能不能区分两种实现」，不能就先换输入。

---

## 六、issue #23 剩余项（保持 OPEN）

本任务只做「晨报」这一项（第 3 项）。issue 的三项收口线是「真实邮箱与日历各有一条事件端到端触发提醒、
晨报真出一份」，目前**只有晨报这半条**成立，另两项仍是缺口：

| #23 项 | 状态 | 缺什么 |
|---|---|---|
| 1. 收件箱监听源 | **未接入** | `inbox.ts` 的判定层在（17 例），但 `MailPort` 无实现；`sources/` 下没有 `mail` 源。真实账号未配置。 |
| 2. 日历监听源 | **未接入** | `calendar.ts` 的判定层在（14 例），但 `CalendarPort` 无实现；`sources/` 下没有 `calendar` 源。 |
| 3. 晨报 | **代码侧接通，端到端未验** | 见下 |

**第 3 项为什么还不能算收口**：issue 的收口线是「晨报真出一份」。本轮做到了「调度器真走一拍 → 真推送到推送出口」，
但那是在**隔离 fixture** 上（临时状态目录 + 内存宿主 + 收集器替身推送出口）。**没有往任何真实设备发过消息**，
因为本任务明确禁止向真实外部人发消息。所以准确表述是：**代码路径端到端通了，生产环境还没真发过一份**。
这一条要等一次真实运行窗口（真设备在线、真时钟走到 8 点）才能勾掉。

**保持诚实 unavailable 的部分**（没有为「宣称完整接入」造假）：

- 早报的日程栏：`今日日程读不到（还没有接入日历）`，不是空列表冒充「今天没会」。
- 没有造 no-op 的 `MailPort` / `CalendarPort` 实现来让 `state: live` 好看。
- 没有读取任何个人邮件目录或账户数据。

---

## 七、写范围与协作

- **我改的**：`backend/src/app/runtime.ts`、`notices-out.ts`、`calendar.ts`、`followup.ts`、`backend/src/kv.ts`、
  `backend/tests/crew-morning.spec.ts`（新）、`backend/tests/notices-morning.spec.ts`、`backend/docs/007-architecture.md`、本报告。
- **我没改**：`开发进度.md`、`HANDOFF.md`、`scripts/crew-watch/`、http / 客户端表单、`backend/lib`（构建产物归 #25）。
- **没做**：不 commit、不 push、不重启生产服务、不改配置。
- **`scripts/verify-morning.mts`** 写出来后发现 `scripts/` 不在写范围，已删除；生产路径验证改在
  `backend/tests/crew-morning.spec.ts` 的端到端用例里（假时钟 + 真调度器 + 真推送链）。

### 一次操作事故（如实记）

为确认「HEAD 上 tsc 的既有错误数」，我用了 `git stash` —— 共享工作树上有其他 agent 未提交的改动，被一起收走。
`stash pop` 因 `backend/src/client/execution.tsx` 冲突被拒，我随后 `git checkout stash@{0} -- <23 路径>` 写回
（这一步会写 index，等于 `git add`），之后 `git restore --staged` 撤回暂存。

**各 owner 已逐个只读核验，结论：无内容丢失。**

- `ds-19-max`：5 个 app 路径与 stash 逐字一致，mtime 16:58:17 早于写入，最终版标记全在；`./gradlew testDebugUnitTest` 369 通过。
- `ds-desktop-max`：`desktop/` 完全不在 stash 里，`git status` / `git diff stash@{0}` 皆空。
- `ds-isolation-ui-max`：`execution.tsx` / `locales.ts` 当前版是**终版**（stash 里是中间态），`panel-execution` 等 24 例通过。
- `ds-25-max`：19 一致 / 4 处是**工作区更新**（超集），无「只在 stash、工作区已丢」的行；`tsc` 0 错复核为真。

**教训**：看基线不要用 `git stash`，用 `git show HEAD:<file>` 或 `git worktree add` —— 不碰共享索引。
`stash@{0}` 保留未删（装的是多人中间态，谁 pop 谁覆盖已完成态），交由审计方处置。
