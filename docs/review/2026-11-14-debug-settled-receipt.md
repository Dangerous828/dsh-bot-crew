# 调试动作的落定回执（session.set / memory.save）

对应 lead 决议 A：**`session.set` 与 `memory.save` 把 `pumpResults` 的结果透传成 `settled`，不提高 3s 主线程等待上限。**

写范围：`desktop/debug.go`、新增 `desktop/debug_settled_test.go`、本文件。
未改 `desktop/ui.go`、`desktop/main.go`、`desktop/mainthread.go`（已冻结），未打包正式 `.app`，
未做任何 git 写操作，未抢焦点，未重启生产。

## 一、根因

`mainThreadSettleCap = 3s` 把 `pumpResults` 的等待封顶（动作体整段跑在主线程上，等待期间窗口不画）。
封顶本身是对的，但两个动作**把 `pumpResults` 的返回值丢掉了**：

```go
// 修前 session.set
s.pumpResults(10*time.Second, func() bool {          // ← 返回值无人接
    return s.conversation != nil && s.conversation.SessionID == want
})
return map[string]any{
    "session": s.currentSession, "loaded": s.conversation != nil,
    "messages": s.currentMessageCount(),
}, nil

// 修前 memory.save
s.pumpResults(15*time.Second, func() bool { return !s.loadingMemory })  // ← 同上
return map[string]any{"saved": name, ..., "count": s.memoryActiveCount()}, nil
```

后果（集成核查已复现）：慢 relay 3.8s 时，`pumpResults` 到 3s 返回 `false`，
但回包仍是 `ok:true` + **旧 `loaded` / 旧 `messages` / 旧 `count`**，且**没有任何字段说明没落定**。
外部脚本读到的是「切过去了 / 改完了并已刷新」——这是假完成，正是本次要修的那条。

同族里 `session.reload`、`memory.reload`、`refresh` 三处**本来就接了** `settled`，
只有这两个动作丢了返回值。所以修复面就是这两处，不是五处。

## 二、改法（4 行语义，2 个字段）

```go
// session.set
settled := s.pumpResults(10*time.Second, func() bool {
    return s.conversation != nil && s.conversation.SessionID == want
})
return map[string]any{
    "session": s.currentSession, "loaded": s.conversation != nil,
    "messages": s.currentMessageCount(), "settled": settled,
}, nil

// memory.save
settled := s.pumpResults(15*time.Second, func() bool { return !s.loadingMemory })
return map[string]any{"saved": name, "description": description, "body": body,
    "count": s.memoryActiveCount(), "settled": settled}, nil
```

- 只**加**一个字段，原有 `session` / `loaded` / `messages` / `saved` / `description` / `body` / `count`
  一个不动 —— 回包形状向后兼容，现有脚本照旧可用。
- `pumpResults` 实现、`mainThreadSettleCap` 的**值**（3s）、`debugActionTimeout`（20s）、
  `timedOutAction` 语义全部不变：**没有**把等待改成无限、**没有**加取消架构、**没有**自动重试。
- 唯一的非纯增量改动：`mainThreadSettleCap` 由 `const` 改为 `var`，**仅为让定向测试把上限调小**
  （慢后端用例不必真等 3s）。生产路径没有任何地方给它赋值。

语义（写进代码注释）：

| 动作 | `settled:true` | `settled:false` |
| --- | --- | --- |
| `session.set` | 切过去那段的时间线已落进缓存，`loaded`/`messages` 是那一段的真值 | 切换**已生效**（`session` 已是新值），但时间线还没回来：`loaded`/`messages` 是这一刻的真值（可能仍是上一段，或 `-1`） |
| `memory.save` | 写入成功**且**账本已重读，`count` 是新值 | 写入**成功**（`saved` 为真，编辑层已关），但重读没回来：`count` 是旧值 |

一句话：`settled:false` 说的是「回包里的**派生字段**还是旧的」，不是「这件事没发生」。
动作本身的成败仍由 `ok` / `error` 表达，两条轴分开，不混。

## 三、测试证据

```
$ cd desktop && go vet ./...
vet exit=0

$ go test -count=1 ./...
ok  	github.com/Dangerous828/dsh-bot-crew/desktop	2.111s      # 281 PASS / 0 FAIL

$ go test -count=1 -race ./...
ok  	github.com/Dangerous828/dsh-bot-crew/desktop	7.223s      # 0 DATA RACE

$ go test -count=1 -race -run 'TestDebugBusSessionSetReportsUnsettled|TestDebugBusMemorySaveReportsUnsettled|TestDebugBusSessionSetAndMemorySaveReportSettled' ./...
ok  	github.com/Dangerous828/dsh-bot-crew/desktop	1.634s

$ go test -count=3 -run 'TestDebugBusSessionSet|TestDebugBusMemorySave|TestDebugBusMemoryEditAndSave' ./...
ok  	github.com/Dangerous828/dsh-bot-crew/desktop	0.989s      # 连跑 3 次稳定
```

原有 278 例**一条未改**，全部仍绿（含 `debug_session_test.go` 里既有的
`TestDebugBusSessionSetSwitchesAndSendLandsInThatSession` /
`TestDebugBusMemoryEditAndSave` / `TestDebugBusMemorySaveReportsRefusalAndKeepsEditor`）。

### 新增 `debug_settled_test.go`（3 例）

| 用例 | 钉住什么 |
| --- | --- |
| `TestDebugBusSessionSetReportsUnsettledOnSlowTimeline` | 时间线挂住 → `settled:false`；`session` 仍是 `work`（切换真做了）；`loaded:false`、`messages:-1`（真值，不假称读完） |
| `TestDebugBusMemorySaveReportsUnsettledOnSlowReload` | 重读挂住 → `settled:false`；`saved` 为真、编辑层已关；`count` 报旧值 1；POST 恰好一次 |
| `TestDebugBusSessionSetAndMemorySaveReportSettledOnFastBackend` | 秒回 → 两个动作都 `settled:true`，`loaded:true`/`messages:1`，防「永远 false 也算修好」 |

**低成本、不复制实现**：不真等 3s —— `withSettleCap(t, 60ms)` 把 `mainThreadSettleCap` 临时调小、
`t.Cleanup` 恢复；假后端只 sleep 到「明显超过上限」；断言走真 `invokeRaw` → 真 `pumpResults`
→ 真 `drain`。测试里没有第二套 pump 逻辑。

## 四、反向验证（红）

**探针 1：把两处 `settled` 撤掉（回到修复前的形状）**

```
--- FAIL: TestDebugBusSessionSetReportsUnsettledOnSlowTimeline
    debug_settled_test.go:89: 回包没有 settled 字段：map[loaded:false messages:-1 session:work]
--- FAIL: TestDebugBusMemorySaveReportsUnsettledOnSlowReload
    debug_settled_test.go:155: 回包没有 settled 字段：map[body:新 count:1 description: saved:bot-lead-a]
--- FAIL: TestDebugBusSessionSetAndMemorySaveReportSettledOnFastBackend
    debug_settled_test.go:215: 回包没有 settled 字段：map[loaded:true messages:1 session:work]
```

注意第一条的旧回包：`loaded:false messages:-1` 而 `ok:true` —— 正是「丢了返回值」时的样子，
外部脚本无从分辨「没读到」和「读到了、是空的」。

**探针 2：字段存在但恒真（`settled || true`，即假称完成）**

```
--- FAIL: TestDebugBusSessionSetReportsUnsettledOnSlowTimeline
    debug_settled_test.go:90: 后端慢过主线程上限，却报 settled:true：这就是假称切过去那段已经读完
--- FAIL: TestDebugBusMemorySaveReportsUnsettledOnSlowReload
    debug_settled_test.go:156: 账本重读还没回来，却报 settled:true：这就是假称改完已刷新
```

两个探针都恢复原状后重跑全绿（`git diff` 已核对只剩 settled 透传 + `const`→`var`）。

## 五、settled 可信度分级（回应集成审查的四个同族点）

| 动作 | 有 `settled` | 被 3s cap 截断时的含义 | 可信 |
| --- | --- | --- | --- |
| `session.set` | **本次补上** | 切换已生效，`loaded`/`messages` 是旧真值 | 是（新增字段） |
| `memory.save` | **本次补上** | 写入已成功，`count` 是旧真值 | 是（新增字段） |
| `session.reload` | 原有 | 名单/能力位可能还没刷新 | 是（`settled` 本就接了） |
| `memory.reload` | 原有 | 账本可能还没回来 | 是（同上） |
| `refresh` | 原有 | 时间线可能还在路上；`refreshing` 另报在途 | 是（同上） |

**统一口径**：五个动作的 `settled` 都是「3s 内落定与否」，**没有**任何一个是「一直等到真落定」。
慢后端（>3s）时一律 `settled:false` —— 这不是缺陷，是主线程不能被冻住的有意取舍。

两条轴必须分开读，不许互相替代：

- `ok:true` 说的是**动作已受理 / 已执行并回了包**（切换生效、写入已提交）；
- `settled` 只说的是**在 cap 内派生结果已落定**（`loaded` / `messages` / `count` 是不是新值）。

所以外部脚本的正确写法是：`ok:true` 之后先看 `settled`；`settled:false` 时**用只读 dump 再查一次**
（`state.dump` / `memory.dump` / `session.list`），**不要**把 `ok:true` 读成「派生字段已刷新」，
**也不要**为了等落定而重发有副作用的动作（`session.set` / `memory.save` / `send` 再发一次，
就是第二次切换、第二次写账本、第二句话）。等落定只靠读，不靠重放。

`timedOutAction`（`debugActionTimeout` 20s 那条）语义未变：超时 = 调用方不再等，不是动作被撤销。
它与 `settled:false` 是两条不同的轴（前者是「我连结果都没拿到」，后者是「我拿到了结果，但派生字段还没刷新」）。

## 六、局限

1. **未在真窗口 + 真慢 relay 下复验。** 判据全部来自 `httptest` 假后端（挂住/秒回两种）。
   集成核查里那条 3.8s 慢 relay 场景是人工观察到的，本次没有把它做成自动化用例
   （要真 relay 才成立，属集成面）。
2. **`mainThreadSettleCap` 从 `const` 变成 `var`**，理论上任何包内代码都能改它。
   目前只有测试改（`withSettleCap` + `t.Cleanup` 恢复）。若将来有人图省事在生产路径调它，
   就会把「主线程不冻住」这条取舍破坏掉 —— 报告留在这里作为提示。
3. **手机端同名动作没有 `settled`。** `CrewDebug.kt` 的 `session.set` / `memory.save` 回包形状
   本次未动（不在写范围）。两端现在字段不完全对称，桌面多一个 `settled`。
4. **`settled:false` 之后没有「稍后补一次」的通道。** 外部脚本只能自己再问一次
   （`state.dump` / `memory.dump`）。这是「不加取消架构、不自动重试」的直接结果。
