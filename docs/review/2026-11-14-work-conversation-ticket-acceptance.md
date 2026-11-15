# 第二会话真派单：`work` 会话真票、`/state` 与主 Session 归档守卫验收

- 核验时间：2026-11-14 17:36–17:47（Asia/Shanghai）
- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`（HEAD `b2f305e`，本轮零提交）
- 对应欠账：`docs/00-contract.md:978` 的 `TODO(gw, 2026-11-14)` 第二条
  「**第二个 conversation 真派单后 `/state` 与归档守卫未验**」
- 可写范围：本文件（`docs/review/` 独立报告）+ 一条 issue 评论。源码 / 配置 / `开发进度.md` /
  `HANDOFF.md` / `scripts/crew-watch` 一个字节没动。

## 一、结论

**这一格验完，四项判据全绿。**

| # | 判据 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| 1 | `work` 会话里真派出一张票，`mandate.basis.scope.conversation = work` | 通 | 两张票：`9a0a8727`（completed）、`afdf7ef7`（completed） |
| 2 | 请求的会话归属正确（队列列 / trigger / 票 / 回话四处一致） | 通 | 消息 `m60`/`m61` 落 `work` 列，trigger `meta.conversation=work`，回执 `r33`/`r34`/`r35`/`r36` 落 `work` |
| 3 | `main` 不串线 | 通 | `main` 票数 15→15、队列 51→51、timeline 78 条不变；`m60`/`m61` 不在 `main` timeline 里 |
| 4 | `/state` 与主 Session 归档守卫正常 | 通 | `/state` 12 项 health 全 `ready`、`load` 归零、`masterId` 未变、无 `master_archived` 告警；主 Session 不在归档集合，两个新 worker Session 都已归档 |

自动化断言 **39 条全 PASS + 1 条信息型记录**（`FAILS: 0`，`EXIT=0`）。
复跑脚本 `docs/review/2026-11-14-work-conversation-verify.py`（与本报告同目录）。

那 1 条信息型记录是全局 `paused`：它是**别人也能操作的共享开关**（手机 owner 的按钮验收会按它），
所以脚本只打印值、不判 PASS/FAIL；本轮**派票窗口内**的 `paused=false` 由 §5.1 的六拍现场快照钉住。
17:50–17:51 期间 `paused` 短暂为 `true` 又自行回到 `false`（`settings-block-revision:pause` 已到 34，
即他人窗口里的一次 pause/resume 往返）——那是手机 owner 的按钮验收，发生在本轮两张票都已收口之后，
与本次验收无关；我既没有点 pause 也没有点 resume。

**没有发现产品 bug。** 两处「按字面验收会以为漏了」的边界写在 §六。

证据已补到 issue：#14 评论
<https://github.com/Dangerous828/dsh-bot-crew/issues/14#issuecomment-6875464854>
（#14 已是 `CLOSED`，按规约只评论、不重开）。

## 二、怎么派的（没有替身、没有手改库）

派单走的是**真实链路**，一处旁路都没有：

```
桌面凭据（已配对资产，只读使用）
  → POST http://127.0.0.1:43499/api/mobile/send?session_id=work
      {text, request_id, mentions:["lead"]}          ← lan-server 门 → phone-gate → 消息面
  → mobilegw /send（X-GW-Token）→ mobileq.db messages(conversation='work')
  → team Source 轮询 → Trigger(meta.conversation=work, registeredSessions=["work"])
  → Gate / Eval / 判官 → Decision(accept, explicitRouted) → Ticket
  → Executor 起 worker Session worker-<ticketId> → 报告 → ticket.ended
```

- 消息由 `POST /api/mobile/send` 写入，`sender` 由消息面按**已认证 owner** 填，不接受客户端自称；
  `request_id` 是幂等键，落库后逐字保持。
- **没有** `mobileq inject`、**没有** 手写 `orchestrator.sqlite`、**没有** 伪造 decision 或 ticket。
- 两条消息都带「测试」字样（`【测试票·可自动收口】` / `【测试票·运行窗口观测】`），票标题里也写着。

发送与回执：

```
POST /api/mobile/send?session_id=work
-> {"ok":true,"id":60,"request_id":"work-ticket-acceptance-20261114-174203","session_id":"work","session_api":1}
POST /api/mobile/send?session_id=work
-> {"ok":true,"id":61,"request_id":"work-ticket-running-20261114-174406","session_id":"work","session_api":1}
```

## 三、两张票

### 3.1 票 A：`9a0a8727ddecce7ce03d2030c0808dd8`（completed）

```
title     在 /tmp 指定目录创建 canary.txt 写入固定文本
createdAt 2026-11-14T09:42:08.771Z   ended 09:42:13.415Z  by=executor  outcome=completed
mandate.strength  explicit
mandate.basis     {source: team, via: addressed, addressed: mention, sender: owner,
                   scope: {conversation: work, messageId: "60", root: 60, bot_id: lead,
                           mentions: ["lead"], registeredSessions: ["work"]}}
origin.triggerId  bb18e17f72a6ee206e8eb4edef3a16c0   → trigger_thread.thread = team:work:60
```

worker 报告（`assignments[0].report.summary`）：

> 已创建 `/tmp/work-ticket-canary-20261114-174203/canary.txt`，内容一行
> 「WORK-CONVERSATION-TICKET-CANARY 20261114-174203」（48 字节，含换行），已 cat 校验通过。
> 未改源码、未做 git 操作、未建 PR、未动配置与服务。

产物实测：

```
$ ls -l /tmp/work-ticket-canary-20261114-174203/canary.txt
-rw-r--r--@ 1 cpuser wheel 48 Nov 14 17:42 canary.txt
$ cat /tmp/work-ticket-canary-20261114-174203/canary.txt
WORK-CONVERSATION-TICKET-CANARY 20261114-174203
```

### 3.2 票 B：`afdf7ef7e63570ab546605028990c186`（completed，带运行窗口）

票 A 太快（5.6 秒），抓不到「运行中」的 `/state`。票 B 特意让它跑 25 秒，用来取运行期快照。

```
title     运行窗口观测：建 run.txt、等待后追加 done 并报告
createdAt 2026-11-14T09:44:11.541Z   ended 09:44:46.170Z  by=executor  outcome=completed
mandate.basis.scope  {conversation: work, messageId: "61", root: 61, bot_id: lead,
                      mentions: ["lead"], registeredSessions: ["work"]}
origin.triggerId     28f8ae8815304a398250fd44ea8f0fa6   → thread team:work:61
```

运行期（17:44:13–17:44:44，每 4 秒一拍，6 拍一致）：

```
/state  {"load":{"running":1,"queued":0,"maxWorkers":3},"paused":false,
         "runtime":"ready","team":"0 messages, 0 unreadable"}
ticket  afdf7ef7 running active=1
work timeline tasks: [["afdf7ef7","working"],["9a0a8727","completed"],["2c23257a","stopped"]]
```

产物实测：

```
$ cat /tmp/work-ticket-running-20261114-174406/run.txt
RUN-CONVERSATION 20261114-174406
done
```

## 四、会话归属：四处一致，`main` 一处没动

| 观测点 | 基线（17:41） | 结束（17:45） | 判据 |
| --- | --- | --- | --- |
| `mobileq.db` messages | main 51 / team 1 / work 5 | main 51 / team 1 / work 7 | `work` +2，`main` 不动 |
| 消息行的 `conversation` | — | `m60`→work、`m61`→work | 逐行核对，不是靠计数推断 |
| 消息行的 `request_id` | — | 与发出时逐字一致 | 幂等键没被改写 |
| 票的 `scope.conversation` | main 15 / work 1 | main 15 / work 3 | `work` +2，`main` 15→15 |
| `main` timeline items | 78 | 78 | 一条没多 |
| `main` timeline 消息 id 尾部 | `m57,r30,m58,r31` | `m57,r30,m58,r31` | 尾部逐字不变 |
| `m60`/`m61` 在 `main` timeline | — | 不在 | `m60 in main: False`、`m61 in main: False` |
| `work` timeline items | 6 条（`m40,m47,m51,m53,m59,r32`） | 12 条 | 新增 `m60,r33,r34,m61,r35,r36` 共 6 条 |
| `groups` 只读投影 | main 15 / work 1（按票数推，未单独采集） | main 15 / work 3（实测） | `ticket_count` 跟着真票走 |

回执侧（`replies` 表，`conversation='work'`）：

```
r33 work to=60  「好的：在 /tmp/work-ticket-canary-20261114-174203/ 下创建 canary.txt…」  bot=lead
r34 work to=60  「完成：已创建 /tmp/work-ticket-canary-20261114-174203/canary.txt…」      bot=lead
r35 work to=61  「好的：…」                                                              bot=lead
r36 work to=61  「完成：…」                                                              bot=lead
```

`main` 的 `replies` 没有一条挂到 `m60`/`m61`（`main` 回执最大 id 仍是 `r31`）。

## 五、`/state` 与主 Session 归档守卫

### 5.1 `/state`

```
GET http://127.0.0.1:3082/orchestrator/api/state   （Host + x-orchestrator-request: 1）
{"load":{"running":0,"queued":0,"maxWorkers":3},"paused":false,
 "masterId":"orchestrator-bbbb4bafe8b5e5afe49748149f93df3d",
 "isolation":"none","isolationActive":false,
 "health":{runtime,relay,notice,launch,delivery,assessment,reply,evals,models,p2p,github,team 全 "ready"},
 "watchdog":null}
```

- 运行期 `load.running` 真的从 0 涨到 1、票收口后又落回 0：这是**第二会话的活被算进全局负载**的证据，
  不是「读了个常量」。
- `masterId` 全程未变；**派票窗口内** `paused` 全程 `false`（17:41 基线、17:44 运行期六拍、17:45 收口，
  三次快照一致）。17:50–17:51 的一次 pause/resume 往返属他人窗口（手机 owner 的按钮验收），
  发生在本轮两票都已收口之后，不在本轮观测区间内。
- `watchdog` 为 `null`：没有 `master_archived` 告警，也没有「超时未决定」。

### 5.2 主 Session 归档守卫

`~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`：

| Session | 基线（426 条） | 结束（428 条） | 期望 |
| --- | --- | --- | --- |
| 主 Session `orchestrator-bbbb4bafe8b5e5afe49748149f93df3d` | 不在 | **不在** | 在守卫下不该出现 |
| `worker-9a0a8727…`（票 A） | — | **在** | 票结束后归档 |
| `worker-afdf7ef7…`（票 B） | — | **在** | 票结束后归档 |
| `worker-2c23257a…`（他人票） | 在 | 在 | 不受影响 |

归档集合总数 426→428，正好是两张新票的两个 worker Session，**没有多出任何 `orchestrator-*`**。
集合里现存的三条 `orchestrator-70f05a0a…` / `orchestrator-79f2880b…` / `orchestrator-bbfea083…`
是历史遗留的其他 Session id，与本次 `masterId` 无关，本轮没有触碰。

配套：

- worker 会话目录真建起来了：`~/.dsh/sessions/--Users-cpuser-.dsh-state-superagent-work--/worker-9a0a8727…`
  （`session.v4.jsonl.zstd` 60 KB）与 `worker-afdf7ef7…`（203 KB），都落在 **work 执行根**下。
- 日志里没有一条 `could not archive worker Session`，也没有 `master_archived` 告警。
- `dsh`（PID 89699，起于 14:26:39，结束态 `etime` 3 小时 19 分）与 `mobilegw`（PID 41418，
  起于 00:01:07）**全程未重启**；两者的启动时间都早于本轮第一次发送（17:42:03），
  `mobilegw.token` 的 mtime 仍是 Nov 6 01:17（没有被重写）。

## 六、两处边界（实现如此，按字面验收会以为漏了）

1. **`/state` 没有「按会话分列」的负载字段**。`load.running` / `load.queued` 是全局的，
   `/state` 里也没有 `conversation` 维度。第二会话的归属证据只能从
   `timeline?session_id=work` 的 `tasks[]`、`groups.ticket_count` 与票本身的
   `mandate.basis.scope.conversation` 取。这不是缺字段，是这一格本来就没设计成按会话拆分负载；
   要在 `/state` 上直读第二会话的票，得另立一条产品决策。
2. **worker 的执行目录是空的，产物在 `/tmp`**。票 A / 票 B 的 `execution.directory` 分别是
   `…/work/create-canary-file-9a0a8727ddec` 与 `…/work/running-window-probe-afdf7ef7e635`，
   两个目录都存在但没文件——因为请求写的是 `/tmp` 下的绝对路径。这是按指令执行，不是丢了产物。

另记一条不影响结论的旁注：票 B 的 worker 报告里提到「`cat -A` 在 macOS 不支持该参数（报 illegal option，
不影响文件内容），已用 `cat` 正常读出两行」。这是 worker 自己的排障叙述，产物本身逐字正确。

## 七、复跑方式

```
python3 docs/review/2026-11-14-work-conversation-verify.py    # 39 断言 + 1 INFO，全 PASS 时 exit 0
```

脚本只读三处：`orchestrator.sqlite`、`mobileq.db`（`mode=ro`）、`workspace.json`，
另加一次 `/state` 与两次 timeline GET。断言分七组：A 票的 mandate、B 票数分布、C 队列列、
D 产物内容、E 归档集合、F `/state`、G timeline 分片。

## 八、约束遵守

- 没有重启 `dsh` / `mobilegw`，没有 `pkill`，没有发任何桌面输入事件，没有抢焦点。
- 没有 `git add` / `commit` / `push`，没有改源码 / 配置 / `开发进度.md` / `HANDOFF.md` / `scripts/crew-watch`。
- 没有改生产默认模型：`eval` 与 `executor` 的 `model` 全程是已配置的
  `magpie / workbuddy/deepseek-v4.1-flash-500k`，`settings` 各 block 与 source 的 `revision` 前后逐字相同
  （policy 2、eval 7、executor 25、github 2、team 12、mobile 1），`policyVersion` 未变。
  两个 worker 的会话记录里出现的 `model` / `provider` 也只有这一个组合。
- 没有删任何票或消息；他人的票 `2c23257a` 原样保留（`stopped`，仍在归档集合里）。
- 测试票自带「测试」标记，两条消息都留在了 `work` 队列里，可随时按 `request_id`
  （`work-ticket-acceptance-20261114-174203` / `work-ticket-running-20261114-174406`）追溯。
- 凭据只按需读取、只用于这两次请求，未出现在任何输出里；配对资产结构（字段名与长度）之外的
  内容没有写进本文件。
- 派单前与 `ds-phone-ui-max`、`ds-phone-pause-fix-max` 两位手机侧 owner 对过窗口，两边都回「空闲可并发」，
  且都承诺不在本轮暂停全局 executor；本轮全程 `paused=false` 与此一致。
