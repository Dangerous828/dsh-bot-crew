# 单任务文档最终校正（2026-11-14 17:36–17:58）

执行人：`ds-doc-final-max`（lead 委派）。本文件是**独立集成审计后的文档校正报告**，
只记录「改了哪几处、依据是什么、还有什么不能说」。

- 仓库：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`，HEAD `b2f305e`
- 写范围（我实际碰的四个文件）：
  1. `开发进度.md`
  2. `docs/review/2026-11-14-ledger-closeout.md`
  3. `docs/review/2026-11-14-issue26-prepare-credential-deny.md`
  4. `docs/adr/0004-worker-isolation-os-user.md`
  5. `docs/00-contract.md` —— **只动一处**：§9.4 `TODO(gw, 2026-11-14)` 的「第二个 conversation
     真派单后 `/state` 与归档守卫未验」那条，按 lead 的验收结论划为完成并精确引用证据；
     顺带订正 §9.8 里同一事实的重复表述（同一句话在 §9.8 又写了一遍「仍未验」，不改会自相矛盾）。
     **其余章节一字未动**，尤其 §10 群组验收边界、§9.5–§9.7。
  6. 本文件（新增）
- **没碰**：任何源码 / 测试 / `HANDOFF.md` / 其他 agent 的报告 / `scripts/crew-watch/`
- **没做**：`git add` / `commit` / `push` / `stash` / `checkout` / `restore` / `reset`；没 build；
  没改生产设置；没重启任何进程；没向生产进程发信号；没抢焦点
- 允许并已用：`gh issue comment` / `gh issue close`

---

## 一、审计指出的五条，逐条处置

### 1.1 `sensitivePaths()` 是 24 条，不是 25 项

**审计结论**：`开发进度.md` 两处（原 325 行、372 行）与 `ledger-closeout` 一处（原 159 行）
写「25 项」，实际 24 条。

**复核方式（不引用行数、不引用任何报告里的数字，直接数代码）**：

```
$ node -e "读 backend/src/infra/environment.ts，取 'export function sensitivePaths' 之后
           'return [' 与 ']' 之间，匹配 at\('([^']+)'\) → 24 条"
$ sed -n '219,236p' backend/src/infra/environment.ts | grep -c "at('"   → 24
```

24 条按 6 个载体类别：VCS 5（`.ssh` `.gnupg` `.git-credentials` `.gitconfig` `.netrc`）、
云与集群 4（`.aws` `.azure` `.kube` `.config`）、容器 registry 1（`.docker`）、
包管理器 token 9（`.npmrc` `.npm/_authToken` `.yarnrc` `.yarnrc.yml` `.pypirc`
`.cargo/credentials` `.cargo/credentials.toml` `.gem/credentials` `.m2/settings.xml`）、
密码管理器 2（`.vault-token` `.password-store`）、shell 历史 3（`.zsh_history` `.bash_history` `.zsh_sessions`）。

**处置**：三处全部改成 **24 条**，并写明判据是「逐条 `at(...)` 计数」——
`#26` 报告正文与 ADR 里本来就是 24，所以这不是代码与文档不一致，是**转抄漂移**。
另在 `ledger-closeout` 新增 §6.1 把这件事记成「可复核判据」，避免下次又靠引用数字。

### 1.2 `ledger-closeout` 的「未知第三方 `git add`」是误归因

**审计结论**：index 被暂存不是任何一次 `git add`，而是 `git checkout stash@{0} -- <path>`
的副作用；17:02 撤回。

**复核到的事实链**（全部只读）：

| 时刻 | 证据来源 | 事实 |
|---|---|---|
| 16:57:48 | `git reflog --date=iso` 首行 `reset: moving to HEAD`；`.git/ORIG_HEAD` 的 mtime 也是 16:57:48 | `git stash` 执行，已跟踪改动进 `stash@{0}` |
| 16:58:58–16:59:11 | `ds-23-max` 自己的报告 §七（`2026-11-14-issue23-morning-report.md:221`） | `git checkout stash@{0} -- <23 路径>` 写回；**该命令同时写工作区与 index** |
| 17:02 前后 | 同报告 `:222`「之后 `git restore --staged` 撤回暂存」 | index 被撤回 |
| 17:02:20 | `.git/index` 的 mtime | 与「撤回暂存」吻合 |
| 17:45（本次） | `git diff --cached --stat` 空；`git stash list` 仍只有 `stash@{0}` | 现状：index 干净、stash 冻结 |

**处置**：`ledger-closeout` 那一节整段重写，改成上面这张带时刻的表；明确写
「index 短暂被暂存是 `git checkout stash@{0} -- <path>` 的副作用，不是独立的 `git add`，
撤回发生在 17:02 前后，现在 index 已空」，并**撤销**「并行会话里的另一次 `git add`」这句话。

同时补了 **owner 核对结论表**（六个 owner 各自怎么核的、结论是什么）与一条**收窄声明**：

> 这些核验是逐路径实证，能证明「这些路径在 stash 时刻与恢复后一致、没有丢失已落盘内容」；
> 它**不是**「所有潜在并发丢失在数学上已被证明不可能」。16:57:48–16:59:11 那 73 秒里
> 若有 agent 正在写某个已跟踪文件，理论上仍有被 stash 前版本覆盖的窗口。本轮没有发生，
> 但那是实证覆盖，不是形式化证明。

`stash@{0}` **保留冻结、不 drop**，处置权交 lead / 审计。

### 1.3 `contract diff` 的 `+60/−11` 需要时点限定

**事实**：`ledger-closeout` §四贴的是收尾那一刻（17:10）的 `git diff --stat`
（`docs/00-contract.md | 70 +++++…`）。17:45 重跑 `git diff --numstat docs/00-contract.md` 是
`60 11`，与「70 行」的口径已经不同。

**处置**：
- §四标题加「**时点：2026-11-14 17:10 收尾那一刻**」，正文加一段说明「这两个数字只在那一刻成立，
  不是本文件此刻的 diff」，并给出 17:45 的现场值做对照。
- 新增 §6.2 专门写这件事：**行数是易漂移的派生量，核验一律以现场 `git diff` 为准**；
  要定位「谁改了什么」，读 §四 的四条逐项说明（稳定），不要读行数。
- 本报告**故意少用行数**：只在 §1.3 与 §1.5 各给一次现场值，且都写明时刻；不作为结论依据。
  同一份文件在不同时点会有不同的数（17:10 / 17:45 / 18:05 各不同），这本身就是这条订正的证据。

### 1.4 证据必须分轮：#17 真机活 vs #26 临时 HOME canary

**审计结论**：早期 `#17` 的 worker 侧取证是**真实 HOME、只取文件长度**（未打印内容）；
`#26` 全部是**临时 HOME canary**。两批不能混着叙述。

**处置**：
- `#26` 报告新增 **§0「证据分两轮」**表：轮次 / 时间出处 / 介质 / 能说什么 / 不能说什么。
  第 1 轮（`#17`，06:07–06:11，三条真票）能说「prepare 真进沙箱 + worker 侧未覆盖」，
  **不能说**「内容被读过」（只读了 `stat` 级长度）、**不能说**「覆盖已全」（只覆盖当时 6 条）；
  第 2 轮（本轮 `#26`，15:00–17:10，11+1 例）能说「24 条逐条被拒 / 软链前缀 / 先建后读 /
  `.gitconfig` A-B / 调用点接线」，**不能说**「在真实 HOME 上验过」。
- 新增 **§9 两处口径限定**：①「本轮 #26」只指第 2 轮；②「24 条」的判据是代码里的
  `at(...)` 计数，报告与 ADR 的数字若与代码不一致以代码为准。
- `#26` 报告 §8（协作事故）补上 `git checkout stash@{0} --` 会写 index、17:02 撤回，
  并把原文「没有丢失 stash 之后的并发修改」**收窄**成逐路径实证 + 不能推广成证明。
- **ADR 0004 顶部**加「**证据分两批**」块（两批的出处 / 介质 / 只支持什么结论），
  并在两个受影响小节的标题下各加一句「本节是第 N 批证据」：
  「凭据 deny 的覆盖与残余边界（#26）」= 第 2 批；
  「真机活验收（#17 第 1 项）」= 第 1 批，且明写「只取字节长度、没有打印也没有保存任何内容」。
- 两批合起来只允许说一句：**prepare 阶段的 deny 对名单内路径真实生效（名单 5 → 24 条），
  worker 侧仍未覆盖（#22）。**

### 1.5 本轮源码任务的完成与部署状态（不虚报）

`开发进度.md` 原「三条必须一直挂着的边界」里有两条已经过期：
①「晨报尚缺运行接线」——`runMorning` 已接进 `startRoutines()` 的每分钟 tick
（`backend/src/app/runtime.ts:1481`），`countEnded` 的恒 0 bug 已修，「今天说过了」已落 KV；
②「`sensitivePaths()` 25 项」——24 条。

已整段重写为 **四条边界 + 一张「本轮完成的源码任务与部署状态」表 + 三条「正在做」**：

| issue | 源码 | 部署 | 结论 |
|---|---|---|---|
| #19 远程恢复 | `app/` 5 文件（`pause`/`resume` 调试动作、`pauseResult`） | APK 16:57:39 已装 | **OPEN**：第 1/2/4 项真机过，第 3 项按钮方向反了 |
| #23 晨报 | `runtime.ts`/`notices-out.ts`/`calendar.ts`/`followup.ts`/`kv.ts` | 未上线 | **OPEN**：缺真实邮箱/日历账号 |
| #26 凭据 deny | `environment.ts`/`dsh.ts`/`policy.ts` 注释 | 未上线 | 源码侧收口 |
| #27 桌面状态推进 | `ui.go`/`main.go`/`debug.go` + 新测试 | `.app` 未重打包 | **CLOSED**（真锁屏/App Nap 未实测） |
| #28 面板隔离三态 | `execution.tsx`/`locales.ts`/fixture | 未上线 | **OPEN 待部署** |

**上线判据是读 `backend/lib` 的内容，不是猜**：

```
$ grep -c sensitivePaths   backend/lib/index.js   → 0   #26 的名单不在
$ grep -c runMorning       backend/lib/index.js   → 0   #23 的 tick 接线不在
$ grep -c "isolation.unknown" backend/lib/client.js → 0 #28 的三态不在
$ grep -c isolationActive  backend/lib/index.js   → 1   2364d40 的字段在（#25 那次构建带的）
$ grep -c backupLabel      backend/lib/client.js  → 4   #25 的表单在
$ stat backend/lib/client.js backend/lib/index.js → 都是 11-14 16:32:54
$ ps -p 89699 → lstart Sat Nov 14 14:26:39 2026（全程未重启）
```

结论：**只有 #25 是基线上线的**，新源码目前未上线。

**三条「正在做，不写成完成」**：
1. **桌面 debug / 线程那一路**：`postMain` 主线程队列（#27）源码与 8 例测试已落、`-race` 由红转绿，
   但生产 `desktop/build/Bot Crew.app` 仍是 **11-12 16:13** 的构建，真锁屏与真 App Nap 未实测，
   `bindPost` 之前那段窗口期只有单测。**「桌面端已根治」现在只对源码成立。**
2. **离线报表**：本轮工作树里**找不到对应改动**（全仓 `grep 报表` 无命中；`push.ts` 的
   「离线留件」是另一件事）。按 lead 口径记为**进行中**，不写成已做，也不编未验证的细节。
3. **#19 第 3 项的按钮方向**：工作树里已有 `pausePress(paused, …)`
   （`app/app/src/main/java/com/dsh/botcrew/CrewUi.kt:1415`，`target = !paused`），
   旧写法 `val resuming = paused` 直接传当前值、方向反。**未提交、未装包、未复验**，
   所以 #19 不能按正文关单。

---

## 二、`开发进度.md` 的其它两处订正

1. **§二 顶部加「17:53 现状头」**：原文分支尖写 `2f1effc`（11-13）、完成度「约八成五」，
   都是 11-13 口径。现在明确写「下面正文是 11-13 的快照，不要当现状引用」，
   并把 HEAD / 工作树未提交 / 上线只有 #25 / issue 11 OPEN 14 CLOSED 写在最前面。
2. **§九 issue 表加时点声明**：原表是「2026-11-13 12:05 复核，共 10 条 6 OPEN / 4 CLOSED」。
   现在标明这是快照，并给出 17:53 实测的 **25 条 / 10 OPEN / 15 CLOSED**（#26 关闭后），
   逐条现状指向补记两节。
3. **§四 的三条 `[ ]` 勾成实际状态**：远程恢复（1/2/4 过、第 3 项不成立）、
   运行中加载新构建（`331371d` 已做，生产未验）、真实额度源（`6c12766` 已接，金额按设计留空）。

---

## 三、没有做的事（明确列出，避免被读成已做）

1. **`docs/00-contract.md` 只动了一条 TODO**（§9.4 的「第二个 conversation 真派单」）与其
   §9.8 的重复表述。其余章节（含 §10 群组验收边界、§9.5–§9.7）一个字节没改。
   这一点很重要：那个文件此刻还有别人的在途改动，我**没有**去整理它、没有重排、没有顺手改措辞。
2. **没有改任何源码 / 测试**。包括 #19 的按钮方向 —— 那是 `ds-phone-ui-max` 的写面，
   我只把「已修 + 已实屏复验」记进进度表。
3. **没有改其他 agent 的报告**：`issue19-remote-resume.md`、`issue23-morning-report.md`、
   `issue25-panel-build-and-acceptance.md`、`desktop-state-pump.md`、`isolation-row-active-state.md`、
   `work-conversation-ticket-acceptance.md` 一个字没动。
4. **没有 `git add` / `commit` / `push` / `stash` / `checkout` / `restore` / `reset`**，
   没有 drop `stash@{0}`，没有 build，没有重启，没有改 settings。
5. **没有进一步读真实凭据文件**。`sensitivePaths` 的 24 条是数代码里的 `at(...)`，
   不是去看那些路径下有什么。
6. **没有因表外 secret 扩任务**。#26 的残余边界（表外路径、软链目标、keychain、网络、worker 侧、
   非 macOS）写清即可，不新开扫描器式的活。
7. **没有把「`/state` 不按会话分负载」当缺口**。lead 已明确这是当前设计边界，不写进需求，
   只在 contract 的验收条里注明「从 `timeline tasks` / 票表读」。

---

## 三之二、contract 那一条 TODO 的处置（lead 指示，2026-11-14 17:52 收到）

**做了什么**：把 `docs/00-contract.md` §9.4 的 `TODO(gw, 2026-11-14)` 第二条
「**第二个 conversation 真派单后 `/state` 与归档守卫未验**」划为完成，
并把证据精确引用进去；同时把 §9.8 里同一事实的重复表述（原文「**仍未验**…这一格不是忘了写，
是真的没发生」）一并订正 —— 不改那一处，同一份契约里就会出现「已验」与「仍未验」并存。

**引用的是这些**（全部来自 `docs/review/2026-11-14-work-conversation-ticket-acceptance.md`）：

| 判据 | 证据 |
|---|---|
| `work` 真派出票 | `9a0a8727ddecce7ce03d2030c0808dd8`（completed 5.6s）、`afdf7ef7e63570ab546605028990c186`（completed 25s） |
| 会话归属 | 两票 `mandate.basis.scope.conversation = work`，`messageId` `"60"`/`"61"`，`origin.triggerId` → `thread team:work:60`/`team:work:61` |
| `main` 不串线 | 票 15→15、队列 51→51、timeline 78 条不变 |
| `/state` 与归档守卫 | 六拍（17:44:13–17:44:44）`load.running` 1→0、`paused: false`、`runtime: ready`、`masterId` 未变、12 项 health `ready`、无 `master_archived`；主 Session 未归档，两个 worker Session 已归档 |
| 可复跑 | `docs/review/2026-11-14-work-conversation-verify.py`，**39 PASS / 0 FAIL / EXIT=0** |

**同时写明「这是设计边界，不是缺口」**：`/state` 的 `load` 是全局的，不按会话分列负载；
「work 在跑几张票」从 `timeline tasks` / 票表读。按 lead 指示**不加需求**。

**没有连带勾掉的**：§9.4 那条 `TODO(gw, 2026-11-14)` 现在**只剩两条**——
桌面真 GUI 双徽标（`desktop/ui.go:1666` 有代码、`desktop/nav_test.go` 有单测，缺一次人眼看）、
配对屏四验（干净安装弹权限框 / 拒绝后手输仍能配对 / 同网段两台机器能选第二行 /
手改地址不被自动填抢走）。两处都补了「2026-11-14 17:47 复核：仍未覆盖」，
防止后来人看到「TODO 少了一条」就以为整条都清了。

`docs/00-contract.md` 的 diff 因此从 `60 11` 变成 `80 11` —— 多出的部分就是这一条 TODO 的
完成标记 + §9.8 那处订正，**没有别的改动**。

---

## 四、issue 动作

- **#26**：评论澄清「证据分两轮」+ 四条收口线逐条对账 + 明确未部署 + 软链/worker 剩余边界，
  然后**按源码侧收口线关闭**（原 issue 的四条收口线全部是源码 / 测试 / ADR / 注释层面的）。
  关闭评论里明确：**未上线**（`backend/lib` 里 `sensitivePaths` 命中 0），
  worker 侧归 #22，软链目标与表外 secret 是**明确不承诺**的残余边界。
  另需说明一处**对 issue 正文的偏离**：issue 第 1 项要求「把 `stateDir` 参数真正用上，
  挡 `worker-gitconfig` / `worker-gh`」，实际实现**刻意不挡**——那两个文件是本仓自己生成的，
  里面没有 token（token 在 keychain），deny 了会直接打断 `git` / `gh` 的凭据 helper。
  这是有理由的不做，已写在 `environment.ts:212-215` 与 ADR 0004，不是漏做。
- **#28 / #23 / #19**：**保持 OPEN**，理由已写进 `开发进度.md` 的状态表（待部署 / 缺账号 /
  第 3 项的报告与评论尚未同步复验）。
- **#27**：已由 owner 关闭，我不动。
- **#14**：lead 已在上面只做评论、未重开；我不动它的状态。
- **#19 第 3 项的一处事实更新（17:50–17:51 实屏）**：`ds-phone-ui-max` 已修 `pausePress`
  并重装 APK（`lastUpdateTime=17:49:09`），17:50 / 17:51 两次真实点击的双向截图都在
  `docs/review/shots-issue19-fix/`（`40-A0` → `41-A1`：按「让它停一下」后标签变「继续执行」；
  `42-B0` → `43-B1`：按「继续执行」后回执「已继续执行（全局执行器）」）。
  **但这轮复验还没写进 `issue19-real-button-acceptance.md` 的结论段，也没有 issue 评论**，
  所以我只把事实记进 `开发进度.md` 的状态表，**不替 owner 关单**。
