# mDNS 睡眠唤醒异常退出：实现记录

## 根因（一句话）

真正的抛出点在 bonjour-service 的 `mdns-server`：`respondToQuery` 把 `mdns.respond` 的发送错误交给 `errorCallback`，而它的缺省值是 `err => { throw err }`；`Service` 从不 emit `'error'`，所以 `discovery.ts` 原先挂的 `service.on('error')` 是**从未触发过的死监听器**，一条晚到的 `EADDRNOTAVAIL` 就这样从异步回调里抛穿整个进程。

### 证据链

| 环节 | 事实 | 来源 |
|---|---|---|
| 事故现场 | 宿主睡眠 328635ms 醒来后 `fatal uncaught exception: send EADDRNOTAVAIL 224.0.0.251:5353`，栈为 `doSend → afterDns`；superagent 与手机 API 43499 一起退出 | `docs/review/ux-fixes-20261115/wake-runtime-incident.json`、`backend/.artifacts/dsh-superagent-superagent-20261116-033326-16523.log:38-49` |
| 公开错误入口 | `Bonjour` 构造函数第二参即 `errorCallback`，原样传给 `mdns-server` | `bonjour-service/dist/lib/bonjour.js:14-16` |
| 缺省即 throw | `this.errorCallback = errorCallback ?? function (err) { throw err }` | `bonjour-service/dist/lib/mdns-server.js:16` |
| 唯一的 throw 点 | 只有 `respondToQuery` 的发送回调判错后调 `this.errorCallback(err)` | `bonjour-service/dist/lib/mdns-server.js:84-88` |
| `Service` 不发错 | `grep -rn "emit('error'" bonjour-service/dist` → 零命中；全库仅 `emit('up')` | `dist/lib/registry.js:105` |
| **第二条错误通道** | `multicast-dns` 对 socket 级 `EACCES`/`EADDRINUSE` 会 `mdns.emit('error')`，而 `mdns-server` 只挂了 `'query'`——无人接手的 `'error'` 就是 throw | `multicast-dns/index.js:33-36`、`mdns-server.js:15` |
| 发送为什么失败 | `dgram` 的 `send` 失败以 `ExceptionWithHostPort(err,'send',address,port)` 走 callback，`errno -49` | Node 24 `lib/dgram.js` `doSend`/`afterSend` |
| 出错后实例不会自愈 | socket 仍绑在已消失的地址上，后续每次 send 继续 `EADDRNOTAVAIL` | 隔离复现（见下） |

### 一个反直觉的细节

开机自报那一包（`registry.announce`）的发送回调**不看错误**——源码是 `function () {…}`，所以广播从一开始失败也是静默的。会把错误交到 `errorCallback` 的只有「有人问了、我们回一条」这条路径。这意味着：**故障平时不显形，直到网上有手机来查询才炸**。这解释了为什么它总在睡眠唤醒后、手机重新扫网的时刻爆掉。

## 变更

### `backend/src/app/discovery.ts`

1. **接管两条真实错误通道**：
   - `new Bonjour({}, error => fail(error, instance))` —— 发送失败（EADDRNOTAVAIL 等）走 `errorCallback`。回调绑定的是**构造出来的那个实例**（闭包），不是当时的 `bonjour` 变量，否则旧实例晚到的错误会被记到新实例头上。
   - `sendsOf(instance).on('error', …)` —— bind 阶段 socket 级 `EACCES`/`EADDRINUSE` 走 EventEmitter 的 `'error'`。`mdns-server` 只挂了 `'query'`，这一条原本无人接收，5353 被占时开机即崩。
   - **`mdns.send` 单点归一化**：`respond` / `response` / `query` 三个公开方法全都动态转调 `that.send`（multicast-dns `index.js:93-110`），所以只包这一层就覆盖全部发送路径，无需逐个方法包也不会漏掉 `that.response = that.respond` 这种别名。包内「先 `fail()` 再原样调上游 cb」——上游 `registry.announce` / `registry.probe` 的回调**不判错误**，参数原样透传保证它们的合同不变。
   - 为什么必须包 send：`announce` 与 `probe` 的回调都是 `function () {}` 那种不判错的写法，所以「从启动起就发不出去」在高层完全静默 —— 没人来查询就永远假健康、永不重试。事故当天能炸只是因为恰好有手机来查询。
2. **失效即拆**：`fail()` 先清 `live`/`pending`（`published()` 立刻变 undefined，健康面板不再谎报在广播）、拆掉旧 Bonjour，再排重播。不重用坏实例：它的 socket 绑在失效地址上。`Session.dead` 标记让已废实例的任何后续回调都失去改状态的能力。
3. **ready 只认真实成功**：`published()` / `onState(true)` 在 `Service` 的 `'up'` 之后才置位 —— 那是库在公告包真发出去之后才发的事件（`registry.js:101-106`）。`publish()` 返回不代表播出去了，所以不再点灯。守卫三条：`from === session`、`up === service`、`!stopped`；旧实例晚到的 `'up'` 一律忽略。这样也把「撤旧记录的 TTL=0 包成功」「应答别人查询成功」与「我这条新记录播出去了」彻底分开。
4. **有界、可停止、不保活的恢复计时**：首轮 1s，翻倍封顶 30s（`RETRY_MAX_MS`）；`timer.unref()` 所以不会拖着进程不退。**确认成功后 `wait = 0`**，所以长期运行后再次坏掉仍从 1s 而不是 30s 起。
5. **网络恢复自动重播**：`wanted` 记住「想播哪个端口」，计时到点直接照它重建 socket 重新公告 —— 不必等 `p2pAddr` 恰好又变一次（原实现正是这个缺陷：地址不变就永不重播）。
6. **stop 取消恢复且关闭生命周期**：`stopped` 标志 + 清 timer；`stop()` 拆公告带 250ms 上限，socket 半死、回调永不回来也不会挂住停机；`destroy()` 不等待回调；**`stop()` 之后 `publish()` 是 no-op**（不许复活实例、不许把 `live` 写回），停机本身也发一次 `onState(false, undefined)`。
7. **旧实例迟到错误隔离**：`fail(error, from)` 中 `from.dead` 直接返回；`from !== session` 的只报错、不改状态。
8. **保留契约**：`crewFingerprint`、实例名、`dsh-crew` 类型、`pub`/`p2p`/`crew` TXT、同参幂等一字未改。

### `backend/src/index.ts`

`claimHealth('discovery', …)` 新增一项，由 `onState(live, port)` 驱动：在播报 `ready`，掉线 `error: mDNS announce is down; retrying until the network is back`。`onError` 的原有告警保留。

没有全局 `uncaughtException`、没有永久关 mDNS、没有拿 try/catch 当完成、没有靠外部重启。

## 测试

### 红 → 绿（真实依赖，非 mock Service）

`backend/tests/discovery.spec.ts` 只替 `dgram` 的 socket（让 `send` 回 `EADDRNOTAVAIL`），multicast-dns → mdns-server → registry 全是生产那一份。因为错误只从查询应答路径出来，用例注入一条真 PTR 查询：

```ts
await vi.waitFor(() => expect(Object.keys(instance.server.registry).length).toBeGreaterThan(0))
mdns.emit('query', { type: 'query', questions: [{ name: `_${SERVICE_TYPE}._tcp.local`, type: 'PTR' }] }, {})
```

| 用例 | 覆盖 |
|---|---|
| survives the real announce path failing… | `errorCallback` 真的接住 EADDRNOTAVAIL，进程不死，`published()` 归 undefined |
| survives a socket-level EACCES on bind… | 5353 被占/无权限时 `mdns` 的 `'error'` 有人接，同样不崩、同样排重播 |
| notices from the very first announce… | **从启动起 send 全失败且零外部查询**也能发现、不报 ready、持续重试 → 网络回来后真成功（不靠 `askForUs` 触发） |
| goes ready only after the announce really goes out… | `publish()` 返回时不 ready，`'up'` 之后才 ready |
| drops readiness when the port changes… | 端口切换过程中不沿用旧端口的 ready |
| starts the backoff from the short interval again… | 连续两轮恢复都从短间隔起（退避真归零） |
| stays closed once stopped… | stop 后 publish 不开新实例、不写回 `live`、不再发状态 |
| does not mistake a successful answer… | 应答别人查询成功不被当成「我播出去了」 |
| rebuilds the socket and republishes once the network is back | 恢复后**换新 socket**并重播，`onState` 走 false → true |
| does not hammer the network while it stays broken | 退避有界，不做自杀式重试 |
| cancels the recovery timer on stop without waiting… | stop 不因半死 socket 挂住；stop 后不再新开实例 |
| ignores a late error from an instance it already replaced | 旧实例晚到错误不抹掉新实例状态 |
| keeps the identity and TXT fields stable… | 实例名/类型/端口/TXT 不变，同参幂等只播一次 |
| leaves the public entry out… / follows the P2P address… | 保留原有 `pub`/`p2p` 语义 |

同一个 spec 对 HEAD 快照（`BASELINE_DISCOVERY.ts`）跑：**11 失败 / 9 通过**；对修复后代码：**20/20 通过**。

基线对照在**隔离副本**里做（`/tmp/mdns-baseline`：复制 `src` + `tests` + `node_modules`，只把 `discovery.ts` 换成基线快照），跑完即删，不碰本工作树。

### 跑过的命令

```
pnpm typecheck                    # 通过
pnpm vitest run tests/discovery.spec.ts   # 20/20
pnpm vitest run tests/index.spec.ts tests/discovery.spec.ts  # 33/33
pnpm build                        # Build complete
```

### 独立探针（root 提供，未改）

```
node .artifacts/mdns-wake-20261116/TRANSPORT_PROBE.mjs "$PWD/src/app/discovery.ts"
{"passed":true,"faulted":1,"sends":7,"sockets":2,"closes":1,"errors":["Error: send EADDRNOTAVAIL 224.0.0.251:5353"]}
```

同一探针对基线快照：`returncode 1`，uncaught `EADDRNOTAVAIL`（见 `BASELINE_TRANSPORT.json`）。

## 剩余限制

1. **全量套件 9 项失败与本次无关**：`locales` / `p2p` / `service-script` / `environment` 在干净 HEAD 上同样失败（已用 `git checkout` 对照复跑确认），属既存问题。
2. **恢复靠定时重试，不靠事件**：Node 没有「网卡回来/地址变了」的可靠通知，所以网络恢复后最多等 30s 才重新公告。要更快只能监听系统网络变化，那是平台相关代码，不在这次范围。
3. **5353 持续被别的 mDNS 实现占着时不会恢复**：只会按封顶 30s 一直重试并在日志里留告警。这是故意可见的失败，不是自愈得了的事——需要人把占用者让开。
4. **`sendsOf` 依赖 bonjour-service 的内部结构**：`server` / `mdns` 在类型上是 private，结构在 1.4.4 里稳定（`bonjour.js` 里 `this.server = new Server(...)`，`mdns-server.js` 里 `this.mdns = multicastDns(opts)`）。升级该依赖时这一处要复查；这是「拿到真实发送结果 + socket 级 `'error'`」唯一的口子，没有公开 API。
5. **未做真机睡眠唤醒验收**：本成员不操作手机/生产，泊机部署由 root 集成后进行。
