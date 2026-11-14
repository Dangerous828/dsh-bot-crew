# 07 · 运行中加载新构建（#15 第 4 项）

结论先说：**DSH 支持在进程不重启的前提下换掉插件代码**，用的是 `@deepseek-ai/dsh-hmr`
的 profile 重组（recomposition）。对 dsh-superagent 来说触发方式不是「保存源码」，
而是 **`pnpm build` 之后再让 profile 重组一次**（写一次 profile patch 文件即可）。
实测换代码 2.2–2.6 秒，DSH 进程 PID 不变，API 全程 200。
但「不重启进程」不等于「没有中断」：插件的 `apply()` 会被卸载再挂载，
正在跑的工单与重启时一样被标记中断并带恢复说明重新排队。

本文件记录判据、实测步骤与数据，以及 `scripts/dsh-superagent restart` 的状态安全性。

## 一、DSH 这一侧：能力从哪来

| 事实 | 证据 |
| --- | --- |
| 基础 bundle 默认启用 HMR，条件是启动器提供了 `profileContext` | `dsh-base/cordis.patch.yml:28-32`（`- id: hmr` / `disabled: !!js "!ctx.get('profileContext')"` / `config: root: []`） |
| `dsh` 启动 profile 时确实注入 `profileContext` | `dsh/lib/profile-boot-C14i-8IN.js:290`（构造）→ `:304`（`hostCtx.provide("profileContext", …)`） |
| HMR 服务需要 Node 内部 loader | `dsh-hmr/lib/index.js:786`（`--expose-internals` 或 `node-addon-require-builtin` 兜底，见 `cordis-plugin-loader/lib/index.js:9-17`） |
| 监听的是 profile 的 patch 文件、home patch 文件与 `package.json` | `dsh-hmr/lib/index.js:849-851`、`:872` |
| 一次重组会比对「profile 目录 + 链接包目标」下已加载模块的文件身份 | `dsh-hmr/lib/index.js:1449`（`profileRoots`：profile 目录 + `node_modules` 里的符号链接目标）、`:1320`（`reconcileProfile`） |
| 文件变了的插件被替换（旧插件停下、按当前文件重新 import） | `dsh-hmr/lib/index.js:1320-1385`（`reconcileProfile`：比对 → `planReplacement` → `stopPlanned` → `recomposeProfile`）；`dsh-hmr/README.md:49`（"A package whose files changed in place … therefore takes effect without a restart at the next such recomposition; source watching through `root` is not required."） |
| 替换失败会回滚到旧实现 | `dsh-hmr/README.md:77`（"On replacement failure, HMR removes partially activated replacements and restores the previous modules and plugin implementations."） |
| 只有「配置值」变了、模块没变时，Loader 就地提交（volatile 字段连插件都不重启） | `dsh-hmr/README.md:61`（"Loader commits volatile-only changes in place"）；本仓的 `promptMaxChars` 等即 `.volatile()`，见 `backend/src/deployment.ts:17-22` |

关键推论：**profile 里 `root: []` 只是关掉「源码目录监听」，不影响这条替换路径。**
生产 profile（`~/.dsh/profiles/superagent/`）用的是默认 `root: []`，而 dsh-superagent 是以
`link:` 装进来的（`~/.dsh/profiles/superagent/node_modules/dsh-superagent → Code/dsh-bot-crew/backend`），
属于 `profileRoots` 里的「链接包目标」，所以 `backend/lib/` 一改就被纳入比对。

**别把「插件重启」当成「加载新构建」**。本仓自己有一条重启路径：`apply()` 里的
`restart = () => ctx.fiber.restart()`（`backend/src/index.ts:34`），账户类设置一改
（`backend/src/app/settings.ts:206`、`:223` → `setup.restart()`）就走它。实测：
构建出新版本后，用保存 `source:github` 触发这条路径，日志确实出现
`disposer ran` → `apply() mounted`，但**探针仍是旧值**——`fiber.restart()` 只是把插件
按当前已经 import 的模块重新挂一遍，不做模块淘汰；紧接着写一次 profile patch，
2.27 秒后探针才变成新版本。**要换代码只能走 HMR 重组那一条**。

没有的东西：`dsh` CLI 没有 `reload` 子命令（`dsh/lib/bin.js:116` 只有 `plugin`，
转发给 pnpm）；插件管理器的远程方法里也没有「重载」这一项（只有
`pluginManager/{installBundle,removeBundle,setBundleEnabled,setPluginEnabled,inspect,…}`），
它的重载入口是内部 `reload()` → `hmr.reconcileProfile()`
（`dsh-plugin-manager/lib/index.js:2360-2367`）。
所以触发面就两个：**profile/home patch 文件的写入**，和**插件管理器执行一次包变更**。

## 二、验证环境（不碰生产）

- 临时 `DSH_HOME=/tmp/hot2/dsh-home`，profile `hot2`，webserver 绑 `127.0.0.1:3982`，
  `stateDir=/tmp/hot2/state`；后端用仓库副本 `/tmp/hot2/backend`（`link:` 进 profile）。
- 生产 `PID 70723` 全程只做只读查询，未发信号、未改文件。
- 探针：在副本的 `stateView()` 里加一个 `hotReloadProbe: 'BUILD-x'` 字段（只在副本里），
  并在 `apply()` 与 `ctx.effect()` 的 disposer 里各打一行时间戳，用来分辨
  「换了代码」和「插件被卸载/重挂」。

## 三、实测结果

### 3.1 换代码，进程不重启

| 动作 | 观察 |
| --- | --- |
| 只 `tsdown` 构建、不写配置 | 探针不变（生产同构 profile，`root: []`，没有源码监听） |
| 构建 + 写一次 profile patch（哪怕只加一行注释） | 探针 `BUILD-x → BUILD-y`，连续 5 轮全部命中，耗时 **2.19 / 2.20 / 2.21 / 2.22 / 2.69 秒**；日志出现 `disposer ran` → `apply() mounted` 成对，**PID 不变** |
| 构建 + 写一次 home patch（`$DSH_HOME/cordis.patch.yml`） | 同样生效，**2.32 秒** |
| 只写 patch、不构建（连续 3 次） | 重组发生但不重启插件：模块与配置都没变，Loader 就地提交 |
| 打开 `hmr.root: ["lib"]` 后只构建 | 构建完成 0.24 秒后新代码生效（纯模块监听路径，可作开发期加速手段） |
| 构建出一个 import 期就抛错的 `lib/` | 进程存活、API 全 200（97/97 采样），插件继续跑旧实现；把构建修好后下一次重组自动恢复到新代码 |

### 3.2 重组期间的服务可用性

一次重组的采样（50ms 一次，全程覆盖「写 patch → 新代码生效」的那一刻）：

- `GET /orchestrator/api/state`：**331/331 次 200**，无失败；新探针在 +2.18 秒出现。
- 手机那条 LAN 口（`lanPort(stateDir)`，本次 52654）：185/187 次可连，
  最长连续不可连 **0.2 秒**（旧的 LAN server 关掉、新的绑上之间）。
- 另一轮纯模块监听的重载（`root: ["lib"]`，构建即触发）：37/37 次 200，无失败。

也就是说：**HTTP 管理面不断，手机那条路有约 0.2 秒的窗口**。
另外日志里会出现 `Error: Service name is already in use on the network`
（bonjour 的 mDNS 名字还没释放就重新广播）——它是噪音，不影响服务，但每次重载都会出现。

### 3.3 「状态不丢」

夹具：一张 open 工单（含一条人类 trigger）+ 一个 `running` 的 assignment。

| 时机 | 工单 | assignment | 线程 | 库计数 |
| --- | --- | --- | --- | --- |
| 重载前 | `reload-fixture-ticket` open / working | `inflight-1 running` | `team:…` subscribed，1 订阅 | 1 票 / 1 线程 / 1 trigger / 9 kv |
| 重载后 | 同一张，仍 open | 旧 assignment `ended: hostRestarted`，新 assignment `pending` | 同上 | 同上（逐项相同） |
| `masterId` | `orchestrator-d13a…` 前后一致 | | | |
| 设置 | `executor.maxWorkers=2`、`paused=true` 前后一致 | | | |

结论：**持久状态（票、线程、消息、设置、masterId）一条不丢；正在跑的 assignment 被
标记为 `hostRestarted` 并自动重开一条新的**，与新进程启动时同一套逻辑：

- `backend/src/app/runtime.ts:1220`（启动收尾时 `this.executor.resume()`）
- `backend/src/executor/dsh.ts:599`（`resume()`：把中断的 running assignment 报给 Engine，pending 的重新排队）
- `backend/src/core/assignments.ts:85-92`（未结算的 running 被 `restart(..., 'hostRestarted', RECOVERY_NOTE)`）
- `backend/src/core/assignments.ts:23`（恢复说明原文：让 worker 先看 worktree / git / GitHub，别重复已完成的外部操作）

代价是**当前那一轮模型对话被切断**，worker 会带着恢复说明重新开始；票和消息不丢，
但「做到一半的那一步」要重来。

## 四、替代路径：`scripts/dsh-superagent restart`

`backend/scripts/dsh-superagent` 的 `restart` = 优雅 stop + start，外加把手机网关一起换掉：

| 事实 | 证据 |
| --- | --- |
| stop 发 `SIGINT`，等进程自己退（默认最多 300 秒，`--stop-timeout`） | `backend/scripts/dsh-superagent:252`、`:504` |
| `SIGINT` 之后 `apply()` 的 disposer 调 `Runtime.stop()` → `shutdown()` | `backend/src/index.ts:37`、`backend/src/app/runtime.ts:1433-1460` |
| shutdown 会取消各 Session、排空 effects、`executor.shutdown()`（内部 10 秒上限）、`sessionPersistence.flush()`、关库、放锁 | `backend/src/app/runtime.ts:1446`、`:1450`、`:1452-1462`；`backend/src/executor/dsh.ts:36`（`SHUTDOWN_STOP_MS = 10_000`） |
| start 之后重建 `mobilegw`（网关是独立长驻进程，不重启它就会继续跑旧代码） | `backend/scripts/dsh-superagent:354-362`、`:527-531` |

实测（同一台机器、同一份 stateDir，带一个 `running` assignment）：

| 指标 | 数值 |
| --- | --- |
| 优雅 stop（SIGINT → 进程消失） | 0.14 秒 |
| 启动 → API 可答 | 约 3.0 秒（`runtime=starting`），再过几秒 `ready` |
| 合计不可用窗口 | **约 3.1 秒** |
| 重启后状态 | 票/线程/trigger/kv 计数不变；旧 assignment `ended: hostRestarted` + 新 `pending` + 1 条未投递的恢复说明 |

与 HMR 的差别只有两点：**多约 3 秒不可用**，以及 **`mobilegw` 会被一并换新**（HMR 不会，
因为它管不到插件外面的进程）。两者对「正在跑的活」的处理是同一套。

生产当下的风险面（2026-11-14 11:26 只读查询）：`tickets?state=open` 为 0、`load.running` 为 0、
`paused=false`、`runtime/team` 均 `ready`。也就是说此刻 restart 不会切断任何在跑的活。

## 五、该怎么做

开发期想立刻看到改动：

```sh
cd backend && ./node_modules/.bin/tsdown          # 或 pnpm build
# 让 profile 重组一次：改一次 profile patch（哪怕只是加一行注释）
$EDITOR ~/.dsh/profiles/superagent/cordis.patch.yml
```

约 2.5 秒后新代码生效，DSH 进程不重启。不想动 profile 文件的话，也可以在
`~/.dsh/profiles/superagent/cordis.patch.yml` 里打开源码监听：

```yaml
- id: hmr
  disabled: false
  config:
    base: /Users/cpuser/Code/dsh-bot-crew/backend
    root: ["lib"]
```

之后每次 `tsdown` 完成约 0.3 秒就换上新代码，连 patch 都不用碰。

两种情况都请记住：

1. 这是**插件级重启**，不是「零中断」：`Runtime.stop()` 会跑，在跑的 assignment 会被中断重排，
   LAN 口有约 0.2 秒窗口，mDNS 会重播一次。
2. 改了 `mobilegw`（`backend/tools/`）或 `relay` 之类插件外面的进程，HMR 管不到，
   仍然要 `scripts/dsh-superagent restart`。

## 六、复现脚本骨架

```sh
# 1) 独立 home + 独立端口，绝不碰生产
export DSH_HOME=/tmp/hot2/dsh-home
mkdir -p $DSH_HOME/profiles/hot2
# package.json: bundles = [dsh-base, dsh-web-app, dsh-superagent]，dependencies 里 link: 到副本
# cordis.patch.yml: webserver.host=127.0.0.1 / port=3982, dsh-superagent.stateDir=/tmp/hot2/state
dsh --profile hot2 --no-open --trusted-host 127.0.0.1:3982

# 2) 探针：state 里带一个只在新构建里出现的字段
curl -s -H 'Host:127.0.0.1:3982' -H 'x-orchestrator-request:1' \
  http://127.0.0.1:3982/orchestrator/api/state | grep -o '"hotReloadProbe":"[^"]*"'

# 3) 改一行 → 构建 → 触发重组 → 再读探针（PID 应不变）
(cd /tmp/hot2/backend && ./node_modules/.bin/tsdown)
echo '# touch' >> $DSH_HOME/profiles/hot2/cordis.patch.yml

# 4) 状态对比：票/线程/trigger/kv 计数 + masterId + load
sqlite3 /tmp/hot2/state/orchestrator.sqlite \
  "select (select count(*) from ticket), (select count(*) from thread), (select count(*) from trigger), (select count(*) from kv)"
```

## 七、仍然没验的

- 生产 profile 上真的做一次（本轮刻意只在临时实例上验证；生产此刻没有在跑的活，但那是别人的机器）。
- `hmr/change`、`hmr/reload` 这两个事件被其它插件消费时的行为（本仓没有订阅者）。
- Windows / 打包成 worker loader 的宿主（没有 Node ESM cache 时 HMR 走 `restartReason:
  'module-comparison'`，只能重启，见 `dsh-hmr/README.md:69`）。
