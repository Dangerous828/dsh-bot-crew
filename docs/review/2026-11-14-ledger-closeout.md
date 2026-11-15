# 工单收口与记账（2026-11-14 16:44–17:10）

- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`，HEAD `b2f305e`
- 写范围（实际改动）：`docs/00-contract.md`、`开发进度.md`（ds-17 释放后 append 一节）、本文件
- 未做：不 `git add` / `commit` / `push`、不 build、不重启、不向生产进程发信号、不抢焦点、
  未改任何源码 / 其他报告 / `HANDOFF.md` / `scripts/crew-watch`
- 允许并已使用：`gh issue comment` / `gh issue close` / `gh issue edit`

---

## 一、收口结果

| issue | 动作 | 结论 |
| --- | --- | --- |
| **#18** | **已关** | 三项证据全部独立复验通过，不留尾巴 |
| **#14** | **已关** | 收口项 1 早已结清；收口项 2 缺的 relay 门由 #18 补齐，「两道门」至此各走一次 |
| **#15** | **收窄**（未关） | 七项只剩第 3 项远程恢复；其余六项逐项写明证据 + 边界 |
| **#10** | **收窄**（未关） | 5 项里 3 项已完成，剩 #21（真账号）与 #22（worker 隔离）；转追踪单 |
| **#5** | **转索引**（未关） | 9 条 gap 逐条对账，剩余全部指向 #19/#20/#21/#22/#23/#24/#26 |

## 二、逐项证据

### #18 三项（关闭依据）

1. **手机经 relay 门切会话**：不带凭据 `401 {"error":"Not paired"}`；带真实设备凭据
   `200 {"sessions":["main","work"],"default_session_id":"main","session_api":1}`；
   带 `x-crew-session: work` 发一条 → `{"ok":true,"id":47,"request_id":"relay-1794636079","session_id":"work"}`。
   源地址 `2606:4700:3036::6815:5d88`（CF 边缘），3.8s vs LAN 的 10ms。
2. **真 GUI 切会话**：`open -g` 后台启动，`lsappinfo front` 全程 `loginwindow`（零桌面输入事件），
   经 unix socket 驱动 `session.set` / `send`，两段 timeline 68 / 4 条互不串。
   缺口如实保留：锁屏导致 `screencapture` 全黑，替代证据是 CGWindowList（layer 0、onscreen=1、
   1280×746、标题「Bot 队伍」）+ 结构化快照 + 队列计数。
3. **记忆编辑重启后仍在**：杀进程重启（84471 → 85051）后内容仍在，收尾回滚原文。

**本轮独立复验（不看评论，直接查运行态）**

```
$ sqlite3 ~/.dsh/state/superagent/mobileq.db \
    "select conversation,count(*) from messages group by conversation;"
main|50   team|1   work|4

$ sqlite3 ... "select id,conversation,substr(text,1,30),request_id from messages where id in (47,52,53);"
47|work|relay 门验收：手机经 relay 切到 work 发的…|relay-1794636079
52|main|真 GUI 验收 A：切到 main 之后发的一句…|f670db0938088339f448d916ce8f99d4
53|work|真 GUI 验收 B：切到 work 之后发的一句…|3ede4bfa9a85d86f3d40512acbe92a18

$ sqlite3 ... "select value from kv where key='memory:entry:bot-lead-person-以后都先说结论';"
{"description":"以后都先说结论","body":"主人原话：「以后都先说结论」\n\n记于 2026-11-12T06:45:34.000Z。",
 "updated":1794637152}
```

`updated` 是验收后的时间戳，`description` / `body` 是原文 —— 「改过 → 重启后还在 → 已回滚」
三件事同时成立（没改过则 `updated` 不变；没落盘则重启回滚成旧时间戳）。

### #14 两道门

| 门 | 提交 | 判据 |
| --- | --- | --- |
| LAN | `8b2c436`（`c880aaa` 订正为「只走了 LAN 门」） | 经 LAN 新建 `work`、切过去发一条，`main` 37 / `work` 1 互不串 |
| relay | `33dd955` + `b2f305e`（即 #18） | 见上，`main\|43` 不变、`work\|1→2` |

收口项 1（三处兜底点）：`d0bec28`（逐项对账）/ `660bd6d`（能力位判据零例外 + 结构测试）/
`19d1f5f`（脚本判据同时认 response 与 reply）。

### #15 七项

| # | 状态 | 边界 |
| --- | --- | --- |
| 1 | ◐ 记忆编辑 ✅ / takeover 接口级 ✅ | **GUI 按钮没点过**，只有 httptest + 纯函数单测 |
| 2 | ✅ | 无 |
| 3 | ❌ 未做 | 已独立成 #19 |
| 4 | ✅ | **独立 `DSH_HOME` 实测通，生产 70723 未重启验证**；`ctx.fiber.restart()` 不加载新构建 |
| 5 | ✅ | 无 |
| 6 | ✅ 但换了口径 | 做到的是**真实用量源**（magpie `GET /v1/magpie/quotas`），不是计费源；**金额按设计留空** |
| 7 | ✅ | 含 `6b7ab31` 语音上限（500KB WAV 413→200） |

### #10 五项

第 1 项 ✅（`032dab7`，7 种 kind）、第 3 项 ✅（S1–S4 + #14 收口）、第 4 项 ✅（后端 + 桌面，
`groups.spec.ts` 15 例）、第 2 项 ❌ → #21、第 5 项 ◐（三端全绿 1851/246/362，隔离身份下未验 → #22）。

## 三、`ahead 5` 的订正（这是本轮唯一一处必须纠正的既有记录）

ds-17 的报告用 `git ls-remote origin HEAD` = `29de969` 断言「远端已往前走、本仓落后」。
**该结论证据不足**：`origin HEAD` 指向的是仓库默认分支，不是 `feat/four-blocks`。

精确比对：

```
$ git ls-remote origin HEAD refs/heads/main refs/heads/feat/four-blocks
29de969c624a6c13aecd6b29983a2deafe147013    HEAD
29de969c624a6c13aecd6b29983a2deafe147013    refs/heads/main          ← 默认分支，与本次无关
b2f305e616f52fd19ca75bae3960d669e8aaa823    refs/heads/feat/four-blocks

$ git rev-parse HEAD                    → b2f305e
$ git rev-parse origin/feat/four-blocks → c880aaa   ← 本地 tracking ref 陈旧
$ git status -sb                        → [ahead 5]  ← 假象来源
```

**结论**：远端 `feat/four-blocks` 就是 `b2f305e`，与本仓 HEAD 同一个尖。这 5 个提交早已在远端，
既不是「待推」也不是「落后」。已在 `开发进度.md` 的补记（二）里写成可复核的形式，
并把「`29de969` 是 main 的尖、不能当本分支证据」这一条一起写进去，避免下次再误读。

## 四、改动文件与 diff（**时点：2026-11-14 17:10 收尾那一刻**）

> 下面这两个数字**只在那一刻成立**，不是本文件此刻的 diff。`docs/00-contract.md` 之后又被并行
> 改动碰过（#28 的措辞对齐），17:45 实测 `git diff --numstat` 是 `60 11`。行数是易漂移的派生量，
> 核验一律以现场 `git diff` 为准；要看「我改了什么」，读本节四条逐项说明（那才稳定）。详见 §6.2。

```
$ git status --short docs/00-contract.md 开发进度.md docs/review/2026-11-14-ledger-closeout.md
 M docs/00-contract.md
 M 开发进度.md
?? docs/review/2026-11-14-ledger-closeout.md

$ git diff --stat docs/00-contract.md 开发进度.md
 docs/00-contract.md | 70 ++++++++++++++++++++++++++++++++++++++++++++-------
 开发进度.md         | 70 +++++++++++++++++++++++++++++++++++++++++++++++++
```

### `docs/00-contract.md` 四处（全部在 §9.4 与 §9.8 / §10 的验收边界）

1. §9 引言：把「issue #15 七项仍属未做」改成逐项口径（第 2/5/7 齐、第 1 项记忆编辑齐但 takeover 只到接口级、
   第 4 项独立 HOME 实测通但生产未验、第 6 项前提被纠正且真实用量源已接、只剩第 3 项 → #19）。
2. §9.4 的 `TODO(gw, 2026-11-13)` **整条重写**：原来那句「均未做」已不成立。
   现在把四项已完成的用删除线 + ✅ 结清（relay 门 / lan-server 门 / `phone-gate` 401 / mygo GUI 切屏），
   另起 `TODO(gw, 2026-11-14)` 只保留**真的没做**的三条：
   - 桌面真 GUI 双徽标未看过（有代码 `desktop/ui.go:1666` 与单测，缺一次人眼看）
   - 第二个 conversation 真派单后 `/state` 与归档守卫未验（`work` 至今只有消息、没有票；
     `orchestrator.sqlite` 里所有票的 `mandate.basis.scope.conversation` 都是 `main`）
   - 配对屏真机三验未做
3. 新增 `TODO(desktop, 2026-11-14)`：GUI 上真点一次「接手 →」。接口级已验（真票 `20ec7f99` 真停），
   但 `ui_takeover.go` 的按钮路径只有单测。**接口通 ≠ 按钮通**，这条不能混进「已完成」。
4. §9.8 / §10 两处「仍属 §9.4 的真机欠账」改成指向新的 `TODO(gw, 2026-11-14)`，
   并把群组栏的验收边界写清（15 例 + 桌面接线由 `go test` 覆盖，但真 GUI 没打开看过）。

**没有划掉任何未完成的边界**：契约里现在 4 处 `TODO(`，全部是 2026-11-14 的、全部真的没做。

### `开发进度.md` 一节（ds-17 释放后 append，未动它的两处）

新增 `### 2026-11-14 补记（二）：交接缺漏五提交 / #25 上线 / 三条边界 / ahead 5 订正`，插在
ds-17 的 `### 2026-11-14 补记` 之后、`## 十、` 之前（未插入它的段落内部）：

- **五条漏记提交表**：`263712e`（晨报判定，#23 代码侧）、`2364d40`（`isolationActive`，#17 产物）、
  `33dd955`（桌面 session/memory 调试动作 + 三项验收，#18）、`549d4e8`（面板 backup 表单，#25）、
  `b2f305e`（relay 门真机截图，#18 证据）。
- **#25 上线证据**：lib 落后审计 → `pnpm build` exit 0 → HMR 2.48 秒生效 / 142 次 `/state` 全 200 /
  PID 不变 → 面板真验收（`revision 20→21`、两条负对照 400、正对照 `restarting: false`）→
  真票 `b50ed30f` 的 `request/header` 实际用备选 → 三处改动回滚。
- **三条边界**：晨报纯函数缺运行接线（#23 三条收口线一条未达成）、worker 侧隔离未覆盖（#22）、
  当前构建不含新任务改动（各 Max 的工作都在工作树、未提交未 build）。
- **`ahead 5` 订正**：见本文第三节。

## 五、未做的事（明确列出，避免被读成已做）

1. **没有 commit / push**。工作树里另有 `ds-prepare-max`、`ds-23-max`、`ds-desktop-max`、
   `ds-isolation-ui-max`、`ds-19-max` 的在途改动（`backend/src/executor/dsh.ts`、
   `backend/src/infra/environment.ts`、`backend/src/app/notices-out.ts` 等），
   我一个字没动、也没把它们写进任何「已完成」的句子。
2. **没有 build**。生产 `backend/lib/` 仍是 `b2f305e` 的构建，不含上述在途改动。
3. **没有重启、没有向生产进程发信号**。dsh PID 89699 / mobilegw PID 41418 全程未动。
4. **没有改其他源码 / 报告 / `HANDOFF.md` / `scripts/crew-watch`**。
5. **#26 没写成「尚未开工」**：按 ds-17 的口径写的是「补齐已在进行、`sensitivePaths()` 24 条
   在工作树未提交」——它是进行中，不是未开始。（原写「25 项」，见 §6.1 订正。）

### 一处非我所为、但要交代的状态变化（2026-11-14 17:55 按审计结论订正）

收尾时 `git status --short` 里 `docs/00-contract.md` 与 `开发进度.md` 由「未暂存」变成了
「已暂存」（`M ` 而非 ` M`），同时被暂存的还有 `backend/src/executor/dsh.ts`、
`backend/src/infra/environment.ts`、`app/` 等**其他 agent 的改动**。**这不是我做的**
（我全程未执行 `git add`）。

**原写「是并行会话里的另一次 `git add`」是误归因，现按可复核的操作链订正：**

| 时刻 | 操作（可复核来源） | 对 index 的影响 |
|---|---|---|
| 16:57:48 | `ds-23-max` 在共享工作树执行 `git stash`（未加 `-u`）；同一秒 `git reflog` 记下 `reset: moving to HEAD`，`.git/ORIG_HEAD` 也落在 16:57:48 | 已跟踪的未提交改动被收进 `stash@{0}`，工作区回到 HEAD |
| 16:58:58–16:59:11 | `ds-23-max` 用 `git checkout stash@{0} -- <23 路径>` 写回（`git checkout <tree> -- <path>` **会同时写工作区与 index**） | **这就是那批「已暂存」的来源** |
| 17:02 前后 | `ds-23-max` 用 `git restore --staged` 撤回暂存（见 `docs/review/2026-11-14-issue23-morning-report.md` §七） | index 清空，`git diff --cached` 回到空 |
| 17:02:20 | `.git/index` 的 mtime 落在这里，与「撤回暂存」这一步吻合 | — |
| 17:45（本次审计） | `git diff --cached --stat` **为空**，`git stash list` 仍只有 `stash@{0}` | 现状：index 干净，stash 冻结 |

所以准确表述是：**index 短暂被暂存，是 `git checkout stash@{0} -- <path>` 这条命令的副作用，
不是任何一次独立的 `git add`；撤回动作发生在 17:02 前后，现在 index 已是空。**
「未知的第三方 `git add`」这个说法不成立，撤销。

**owner 核对结论（各 owner 自己做的只读核验，不是我的推断）**：

| owner | 核验方式 | 结论 |
|---|---|---|
| `ds-23-max`（stash 发起者） | 按路径 `git diff stash@{0} -- <path>` 逐个比对 | 无「只在 stash、工作区已丢」的行；他的 23 路径写回成功 |
| `ds-19-max` | `git diff stash@{0} -- <5 个 app 路径>` 全空 + mtime 16:58:17 + 最终版标记在位 + `testDebugUnitTest` 369 通过 | 零丢失 |
| `ds-desktop-max` | `desktop/` 完全不在 stash 里，`git status` / `git diff stash@{0}` 皆空 | 零丢失 |
| `ds-isolation-ui-max` | `execution.tsx` / `locales.ts` 当前版是终版（stash 里是中间态），`panel-execution` 24 例通过 | 零丢失 |
| `ds-25-max` | 19 一致 / 4 处是工作区更新（超集），无丢失行；`tsc` 0 错复核为真 | 零丢失 |
| 我（ds-17 / 本文件） | `git show :docs/00-contract.md \| grep -c 'TODO(gw, 2026-11-14)'` → 2 处相关行；`git show :开发进度.md \| grep -c '补记（二）'` → 1 | 我的两处改动完整无损 |

**「不能说」的一条（审计指出，我接受）**：上述核验是**逐个 owner 按路径比对的实证**，
它能证明「这些路径在 stash 时刻与恢复后一致、没有丢失已落盘内容」。它**不是**
「所有潜在并发丢失在数学上已被证明不可能」。中间的窗口期（16:57:48–16:59:11）里，
任何 agent 若在这 73 秒内**正在写**某个已跟踪文件、且写的是 stash 之前的版本，理论上仍可能被覆盖；
本轮没有发生（每个 owner 的 mtime 与内容比对都指向「stash 之后没有丢失写」），
但这是**实证覆盖**，不是形式化证明。写这句话是为了不让后来人把「已核对」读成「已证明」。

**`stash@{0}` 保留冻结，不 drop。** 它装的是多人中间态，谁 `pop` 谁覆盖别人的已完成态；
处置权交给 lead / 审计，不在这份报告里动。

---

## 六、2026-11-14 17:50 审计后的三处订正（本文件自订）

### 6.1 `sensitivePaths()` 是 **24 条**，不是 25 项

本文件第五节第 5 条原写「`sensitivePaths()` 25 项」。**实际 24 条**，可复核：

```
$ node -e "…split('export function sensitivePaths')[1].split('return [')[1].split(']')[0]
           → 匹配 at('…') → 24"
$ sed -n '219,236p' backend/src/infra/environment.ts | grep -c "at('"  → 24
```

24 条按 6 个载体类别分组：VCS（`.ssh` `.gnupg` `.git-credentials` `.gitconfig` `.netrc`）、
云与集群（`.aws` `.azure` `.kube` `.config`）、容器 registry（`.docker`）、
包管理器 token（`.npmrc` `.npm/_authToken` `.yarnrc` `.yarnrc.yml` `.pypirc`
`.cargo/credentials` `.cargo/credentials.toml` `.gem/credentials` `.m2/settings.xml`）、
密码管理器（`.vault-token` `.password-store`）、shell 历史（`.zsh_history` `.bash_history` `.zsh_sessions`）。
「25」只出现在本文件与 `开发进度.md` 两处；`#26` 报告正文（§2、§5）与 ADR 0004（测试节）
从一开始写的就是 **24** —— 所以这是**转抄时的漂移**，不是代码与文档不一致。
两处都已订正为 24，并以「逐条 `at(...)` 计数」作为可复核判据（不引用行数、不引用报告里的数字）。

### 6.2 `docs/00-contract.md` 的 diff 统计必须带时点

本文件第四节原来贴的是**收尾那一刻**的统计：

```
$ git diff --stat docs/00-contract.md 开发进度.md
 docs/00-contract.md | 70 ++++++++++++++++++++++++++++++++++++++++++++-------
 开发进度.md         | 70 +++++++++++++++++++++++++++++++++++++++++++++++++
```

这个数**只在那一刻成立**。之后的并行改动又碰过 `docs/00-contract.md`（例如 #28 那一路对齐
`worker 未覆盖` 措辞），所以任何后来人重跑 `git diff --numstat docs/00-contract.md` 都会拿到不同的数：

```
$ git diff --numstat docs/00-contract.md          （2026-11-14 17:45 实测）
60	11	docs/00-contract.md                        ← +60 / −11，不是 70 行的口径
$ git diff --numstat 开发进度.md                  （17:10 → 17:45 → 18:05 三次都不同）
```

同一个文件三个时点三个数 —— 这正好说明「行数不能当断言」。本文件**不再写第三个具体数字**，
要看就以你现场的 `git diff` 为准。

**口径**：这份报告里凡是 diff 行数，都是「**2026-11-14 17:10 收尾时点**的 `git diff` 输出」，
不是「本文件此刻的 diff」。行数是易漂移的派生量，**核验请以 `git diff` 现场输出为准**，
不要拿本文的数字当断言。`+60/−11` 这个差值本身也不是我的改动量 —— 它包含并行 agent
对同一文件的追加。真要定位「我改了什么」，看本文件 §四 的四条逐项说明（那才是稳定的）。

### 6.3 本文的「未做」清单补一条时点限定

第五节列的是「**17:10 收尾时点**」的状态。17:00 之后陆续又有源码改动落进工作树
（#23 接线、#26 名单、#27 桌面推进、#28 面板三态、#19 手机调试动作），
它们**都不在**本文第五节的「在途改动」列举里 —— 那份列举只对 17:10 那一刻有效。
现状的完成/未上线对照表在 `开发进度.md` 的「本轮完成的源码任务与部署状态」一节。

