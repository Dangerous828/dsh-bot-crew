# #20 第 2 项修复：`probe()` 的整轮墙钟硬截止与真实连接收口

2026-11-14。修 #33（由 #20 第 2 项验出的缺陷）。**只修第 2 项**：`probeBudget()` 在真实超时下的行为。
第 1 项（跨 NAT 打洞成功率）仍按 #20 保持外部阻塞，本轮不动、也不拿同 LAN 数字收口。

本轮未改手机配对 UI / `CrewDebug` / `CrewWire` / `CrewUi` / `MainActivity`，未安装或操作手机，
未重启 dsh / mobilegw，未改系统网络 / 路由 / 防火墙 / VPN / 限速，未抢桌面焦点，
未做任何 `git add` / `commit` / `push` / `stash` / `checkout` / `restore` / `reset`。

## 一句话结论

预算原本只是**每次 `read` 的期限**（`HttpURLConnection.readTimeout`），慢滴对端可以让整步跑到
「字节数 × 每字节间隔」，实测 800ms/字节 拖到 81.64 秒且无上界。现在整轮有**墙钟硬截止**，
到点 `disconnect()` 关掉那条**真实连接**、打断在途 `read`、回收读线程：同一台架 800ms/字节
**1.509s 返回**，生产默认 20s 预算下 **20.08s**，各例对端 ESTABLISHED 连接数归零。

## 一、根因

`probeBudget(deadline, now, waitMs)` 算出「这一步还能等多久」，调用点把它当 `readTimeout` 传下去。
`readTimeout` 的语义是 **per-read**：只约束单次 `read()` 阻塞多久，不是整步的墙钟。对端只要在
期限内持续吐字节，每次 `read` 都合法返回，于是：

```
整步墙钟 ≈ 响应字节数 × 每字节间隔          （与 20s 预算无关）
```

`probe_server.py` 的 `drip` 模式把这条关系量得很干净：100ms/字节 → 22.52s，200ms → 21.07s，
300ms → 31.15s，400ms → 41.23s，800ms → 81.64s。间隔再放大，墙钟再线性放大。

这不是 `d0a0668` 修的那个坑（`readTimeout=0` = 永久挂住）的重复，而是**同性质的弱一档**：
长度由对端决定。弱网、限速、丢包重传、中间设备流量整形恰好都是慢滴形态 —— 也就是这个预算
唯一想防的那种链路。

顺带的语义错误：100ms / 200ms 两例 `ok=true`，一次实际花了 20 多秒的探测被记成成功，
`millis` 写成 11 715ms 这种值。界面于是把「慢到不可用」报成「通」。

## 二、修法（最小可靠实现，不迁 HTTP 库）

`app/app/src/main/java/com/dsh/botcrew/TailcatP2p.kt`：

1. **整轮墙钟**：`probe()` 增加 `budgetMs: Long = PROBE_BUDGET_MS`（默认仍 20 秒），
   `deadline` 由它算；`request()` 多收一个 `deadlineNanos`。预算可配置是为了测试能用短预算，
   不必把 20 秒每例跑满。
2. **正文读在独立守护线程上**（线程名 `tailcat-probe`），调用方按剩余预算 `join(leftMs)`。
3. **到点关真实连接**：`connection.disconnect()` → 阻塞中的 `read` 立刻抛 `IOException` →
   读线程退出；随后 `interrupt()` + `ABORT_GRACE_MS`（500ms）宽限 `join`。
   这一步是判据的核心：只 `join` 超时（或 `withTimeout` 包住阻塞 read）会留下一个永远在 read
   的线程和一条永远在传字节的连接，资源照漏。
4. **`join(0)` 绝不走进去**：预算已耗尽时 `leftMs <= 0`，直接跳过 `join` 进入收口 ——
   `join(0)` 是「等到天荒地老」，与原来 `readTimeout=0` 那个坑同形。
5. **`readTimeout` 语义不变**，仍是 `probeBudget()` 的返回值，永不传 0。
6. **顺利读完仍不 `disconnect()`**：保留 keep-alive，第二次计时请求复用同一条连接，
   量到的才是稳态往返；这也是原注释的取舍，没被这次改动破坏。
7. **`detail` 不再被两个线程争写**：读线程把「结果 + 说明」装进 `Outcome` 经 `AtomicReference`
   交回调用方，由调用方统一落 `detail`。否则先被 `disconnect()` 打断的那一方会把
   「为什么断」写歪成「Connection reset」。
8. **计时起点移进读线程**：线程创建与 `openConnection()` 不是一个来回，算进去会把 1.4ms 的
   直连报大。

保留的语义：短探测照样通、退避序列（`CrewRoute.retryDelay`）不变、失败仍写 `detail` 可观察、
`probeBudget()` 纯函数与它的 4 条边界单测原样不动。

## 三、测试（TDD：先红后绿，并做两次变异验证）

新增 `app/app/src/test/java/com/dsh/botcrew/TailcatProbeDeadlineTest.kt`（5 例，共 5.1s）。
台架是同进程的 `SlowPeer`：`FAST` / `DELAY` / `HANG` / `DRIP` 四种对端，与
`docs/review/i20/probe_server.py` 同构，另带连接计数与守护线程计数。每个响应都带
`Connection: close` 并在发完正文后立刻关（`probe()` 读到 EOF 才返回，keep-alive 会凭空造延迟）。

| 用例 | 判据 | 实测 |
|---|---|---|
| `aDrippingPeerCannotOutlastTheProbeBudget` | 慢滴（20ms/字节）+ 400ms 预算：墙钟 < 1200ms 且 `ok=false` | **0.409s** |
| `aSilentPeerIsCappedByTheBudgetToo` | 收下不回 + 400ms 预算：墙钟 < 1200ms 且 `ok=false` | **0.404s** |
| `aPeerSlowerThanOneReadButWithinBudgetStillCountsAsUp` | 150ms 慢但对端 + 5s 预算：必须仍算通 | 0.481s，`millis>=100` |
| `aFastPeerStillProbesThrough` | 快回 + 20s 预算：算通且 `millis>=0` | 0.003s |
| `repeatedTimeoutsReleaseTheConnectionAndTheGuardThread` | 6 轮超时（200ms/字节 ≈ 30s 才滴完）：每轮墙钟 < 800ms、**返回即对端连接数 0**、守护线程 ≤ 2 | 3.847s，全过 |

### 变异验证（证明测试真能抓这两个缺陷）

1. **撤掉墙钟收口**（回到「同步读 + `readTimeout=waitMs`」）：
   `aDrippingPeerCannotOutlastTheProbeBudget` 与 `repeatedTimeouts...` 双双变红 ——
   `墙钟 2695ms 越过了 400ms 预算（容差 800ms）`、`第 0 轮墙钟 2716ms 越过 300ms 预算`。
2. **只保留 `join` 超时、去掉 `disconnect()`**：`repeatedTimeouts...` 变红 ——
   `第 0 轮探测返回 1.5 秒后对端仍有 1 条连接在传字节`。

第 2 次变异一开始是**假绿**：那时对端用 20ms/字节，约 2 秒就滴完自己关连接，「最终关闭」
与「被我们关闭」混成了同一件事。改成 200ms/字节（约 30 秒才滴完，远长于 300ms 预算）后，
只有「我们主动关」能满足断言。这条写进用例注释，防止以后再把窗口放宽到失去分辨力。

`app/app/build.gradle.kts` 加了一行 `testOptions { unitTests.isReturnDefaultValues = true }`：
要测的失败/超时路径会走 `android.util.Log`，JVM 单测里它是「not mocked」直接抛。
让它返回默认值（`Log` 变空操作）比引 mock 框架小，且不影响任何既有用例（383 例全绿为证）。

## 四、进程外交叉验证（真产品代码，独立于 JUnit）

`docs/review/i20/run_probe_deadline.py`（新增）直接调产品 `TailcatP2p.probe()`（`ProbeHarness2.kt`
不复制、不改写探测逻辑），`probe_server.py` 当「隧道那头」：

| 用例 | 预算 | 墙钟 | `ok` | 对端 ESTABLISHED |
|---|---|---|---|---|
| 慢滴 800ms/字节（原 81.64s 那例） | 1500ms | **1.509s** | false | 0 |
| 慢滴 100ms/字节（原 22.52s 且误报 ok） | 1500ms | 1.519s | **false**（不再误报通） | 0 |
| 对端收下不回 | 1500ms | 1.510s | false | 0 |
| 慢滴连续 3 轮 | 1500ms/轮 | 4.59s（每轮 1.507–1.510s） | false | 0 |
| 快回 | 1500ms | 0.09s | **true**（millis=0） | 0 |
| 慢滴 800ms/字节，**生产默认 20s 预算** | 20000ms | **20.08s** | false | 0 |

最后一行是「真机上到底封在多少」的直接证据：20.08s ≈ 20s 预算，而不是 81.64s。
倒数第二行是反向证据：收口没把正常快探测误杀成失败。

## 五、回归与构建（exit code 与产物 hash）

```
:app:testDebugUnitTest      tests=383 failures=0 errors=0   EXIT=0
:app:testReleaseUnitTest    tests=383 failures=0 errors=0   EXIT=0
:app:assembleDebug          BUILD SUCCESSFUL               EXIT=0
:app:assembleRelease        BUILD SUCCESSFUL               EXIT=0   （-x lintVital*，见下）
```

产物：

| 产物 | SHA-256 |
|---|---|
| `app/app/build/outputs/apk/debug/app-debug.apk`（16 416 047 B） | `22e5e27fffdbba2913d9e2ea1bf607e5a283af62f0c51d00de44e127e58a67f4` |
| `app/app/build/outputs/apk/release/app-release-unsigned.apk`（12 667 134 B） | `1311cb0128d05faea3f2f73b5a480c677e8c0bc72d36811b9251075d3dc1d335` |
| `app/app/build/test-results/testDebugUnitTest/TEST-com.dsh.botcrew.TailcatProbeDeadlineTest.xml` | `5584355150ce04da9fe4449b5319f3f789c571db03f437ab55b5853f07007ea1` |

源码与台架产物的 hash：

| 文件 | SHA-256 |
|---|---|
| `app/app/src/main/java/com/dsh/botcrew/TailcatP2p.kt` | `112d3641d2e57edfe8e1d8f349b1d7368c7af9818049079f88989b8a5dc6b4b2` |
| `app/app/src/test/java/com/dsh/botcrew/TailcatProbeDeadlineTest.kt` | `781a52ecb05b363f42fd386a61aaf207673df990b3571744e0b7e55750274322` |
| `docs/review/i20/run_probe_deadline.py` | `21e603c887a3b350ddd5e57c0bbb49534f1f63beb5cb93d4d38fb435aa54f1a9` |
| `docs/review/i20/deadline.json` | `080127546905e72e10855596b8fca419cb6ae69d8723bed9cd63e089225b65db` |

release 构建跳过了 `lintVitalAnalyzeRelease`：离线模式下 `com.android.tools.lint:lint-gradle:31.7.0`
不在缓存里（`No cached version ... available for offline mode`），与本改动无关。
`:app:assembleDebug` 用 `--rerun-tasks` 强制重建后取 hash，避免拿到上一轮缓存产物。

## 六、写范围

改动文件（仅 app 相关 + 独立 review 产物）：

- `app/app/src/main/java/com/dsh/botcrew/TailcatP2p.kt`（产品修复）
- `app/app/src/test/java/com/dsh/botcrew/TailcatProbeDeadlineTest.kt`（新增测试）
- `app/app/build.gradle.kts`（一行 `testOptions`）
- `docs/review/i20/run_probe_deadline.py`、`deadline.json`、`deadline.log`（新增台架与产物）
- `docs/review/i20/ProbeHarness2.kt`（带预算参数的 harness）
- 本文

未碰：手机配对 UI、`CrewDebug.kt`、`CrewWire.kt`、`CrewUi.kt`、`MainActivity.kt`、`CrewClient.kt`。
工作区里其他已修改文件（backend / desktop / relay / 其他 review 文档）属于别人的在途工作，
本任务未触碰。

## 七、真机验证的状态（如实写）

本轮**只做了 JVM 产品代码验证**，没有安装到手机：

- `probe()` 的收口逻辑全在 JVM 侧（`HttpURLConnection` + `Thread`），隧道本身是 `libtailcat.so`，
  与这次改动无关；所以 JVM 台架能覆盖被测路径。
- 但**真机慢滴现场没复现**：要真机验收，需要在手机侧构造一个慢滴的对端（把电脑侧 serve 出来的
  端口换成一个慢滴服务），或者把手机接到一条被整形的链路上。这两样都超出本轮授权范围
  （安装/操作手机需先与 `ds-pairing-ui-max` 协调，且配对四验未结束）。
- 真机前该确认的一件事：`PROBE_BUDGET_MS` 仍是 20 秒，与 `DEFAULT_PROBE_WAIT_MS`（15 秒）
  的关系是「整轮 ≤ 20s，单步 ≤ 15s」。慢滴对端现在会在 20s 处返回 `ok=false`，
  界面那一行会走 `P2P_DOWN`，与「隧道不通」同一条文案 —— 这是有意的取舍（慢到不可用 = 不可用），
  但如果产品上想区分「超时」与「不通」，那是另一个决定，不在本单。

## 八、给 #20 的处置

- 第 2 项：**已收**。缺陷单 #33 已开并修复，证据见本文。
- 第 1 项：**仍 OPEN，外部阻塞不变**。缺一台与 Mac 不同 NAT 出口的对端；唯一候选 win-laptop
  三路（`192.168.0.109:22` / `10.10.10.1:22` / `win.kentonnie.top:22`）当前全超时，
  需要 owner 确认它的网络窗口。
- 120/120 那组数字继续**不**作为第 1 项的收口证据，也**不**拿它关整单。
