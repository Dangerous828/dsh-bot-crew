# Phase 4 收尾 · 归并可审候选报告（2026-11-15）

> 本文件是**收尾候选**的过程与证据记录，位于隔离候选副本内（`docs/review/phase4-closeout/`）。不改变原仓库任何 ref / index / 工作树；不 commit / push 任何地方。
> 当前口径入口：根目录 [`README.md`](../../../README.md) 与 [`开发进度.md`](../../../开发进度.md)。

## 〇、tree 定义（防自引用；详见 .meta 外部 manifest）

- **SOURCE_TREE = `a9ad1cb2de6f70fd46d02226ca132bca201eb220`**
  定义：`feat(3aa)` + 选入的源码/测试/文档/证据 + 治理（README 顶部块、`docs/review/README.md`），**明确排除本报告自身**（`docs/review/phase4-closeout/2026-11-15-phase4-closeout.md`）与所有 EXCLUDE。
  因不含本文件，**其 hash 稳定、可复跑**，作为「源码 cohort」口径。
- **FULL_TREE = SOURCE_TREE + 本报告自身**。这是最终将落到 commit 的完整候选 tree。
  **FULL_TREE 的 hex 不在本正文写死**（否则「把含报告的 tree 值写进报告」会改报告→改 tree，永远自引用漂移）。其值以候选工作树 `git write-tree` 实算为准，**权威单一来源写在外部 manifest** `/private/tmp/wb6-candidate/.meta/tree-manifest.txt`（字段 `FULL_TREE=`），由 root 从该处或实算读取单一值。
- 校验：`SOURCE_TREE` 由「干净 3aa + overlay（排除本报告）」独立 index 重算，多次均得 `a9ad1cb2…`（稳定可复现）；`FULL_TREE` = 该 SOURCE 树 + 本报告文件，随报告文本变动而变，故只外置不内嵌。
- 本报告 §五 diffstat：**以 SOURCE_TREE 相对 feat tip 计**（标「源码 cohort」）；凡涉及「含报告」处单独注明 FULL_TREE。

## 一、结论先行

- 远端关系是**干净快进**：`main`（`29de969`）是 `feat/four-blocks`（`3aa9766`）的祖先，feat **behind 0 / ahead 207**。用户新提交 `3aa9766` 只在 `b2f305e` 之上新增一份评估文档。
- 已在隔离候选把**远端新提交 `3aa9766`** 与**本地已验收工作树源码**拼合成可审文件树，保留新评估文档不覆盖。
- 候选回归全绿（本次候选实跑，非引用）：backend tsc 0 / 130 files / 2177 passed；desktop Go 全过 + race clean；app debug/release 各 429/429。
- 原仓库**零写**：未 commit / push / stash / checkout / reset / restore / clean，未 fetch 原仓库，未动 index。
- 用户已结构化明确批准『提交并推送 main 和开发分支』：先在**候选内**完成原子提交与 atomic push（§八），再按 §十一 把原共享工作区 CAS 归位。最终 commit/发布 SHA 与 receipt 见外部 `.meta`，不在本报告内嵌。

## 二、权威 ref（经 `gh api` 读取，非 ssh）

| ref | sha |
| --- | --- |
| 远端 `main` | `29de969c624a6c13aecd6b29983a2deafe147013` |
| 远端 `feat/four-blocks` | `3aa97664a245f00c44720258a30551cbb122f5db` |
| 本地 HEAD（= feat 父提交 `b2f305e`） | `b2f305e616f52fd19ca75bae3960d669e8aaa823` |
| 用户新提交 `3aa9766` 内容 | 仅 `docs/review/2026-11-15-completeness-assessment.md`（+59 行，父 `b2f305e`） |

祖先关系：`git merge-base --is-ancestor main feat` = **是**；`git rev-list --left-right --count main..feat` = **0 / 207**（behind / ahead）⇒ 合并 `feat → main` 为 **fast-forward**。

## 三、源码 freeze（从 dirty 工作树，非 HEAD）

原仓库工作树实测：**68 tracked-modified + 117 untracked（展开为 681 个文件）**。逐项分类：

| 类 | 文件数 | 含义 |
| --- | --- | --- |
| INCLUDE | 281 | 源码 / 测试 / 文档 / 脚本 |
| REVIEW→纳入为证据 | 59 | 验收截图（PNG，对应各报告结论）。**发布前逐张实读 59/59**：publish-audit 逐张 read 全部 59 张，0 真实凭据、无私人无关数据；其中 2 张为过期 fixture 短码（不阻断）。早期仅抽样 8 张，最终以 59/59 为准 |
| EXCLUDE | 341 | 见下，均**保留在原工作树不删**，不入源码候选 |

**EXCLUDE 明细与理由**：

- `backend/.backup-publish-20261115-013720/`（**331 个实体文件**，untracked）：含 `superagent-profile/`（cordis/profile + node_modules）与 `lib/` 编译产物，**可能含凭据**——整目录排除。
- 安装包 / 构建产物（**5 个文件**，untracked）：`docs/review/final-android/deliver/*.apk`、`*.idsig`——交付物不入源码树。
- `HANDOFF.md`（**1 个 tracked 文件，显示为 dirty `M`，非 untracked**）：其工作树内容含**他人未提交改动**——归位时**保留其 dirty `M`**，不并入候选、不覆盖。
- `scripts/crew-watch/`（**2 个文件**，untracked）：操作者文件，不可动——排除。
- `nonexistent/`（**0 文件，纯空目录**）：误生成的 python 缓存空壳；git 不跟踪空目录，故从不出现在 status——无需处理。
- 附注：分类 aid 的 `manifest-classified.tsv` 把 `docs/review/**/*.log`（7 个运行时日志）按目录误归入 INCLUDE-In 计数；**候选源码 tree 内实际 0 个 `.log` 文件**（`git ls-files | grep '\.log$'` 为空），真正 excluded 实体即上述 331+5+2（untracked）+ HANDOFF(tracked-M)。

manifest：`manifest-classified.tsv` sha256 = `9c5e9d86399f696d10d6984c31892c2b0df373774b39e235063772cb489883fd`（列：class/status/path/reason/bytes）。include 文件逐个 sha256 冻结于 `include-freeze-hashes.tsv`（sha256 = `c8a437f0b343c8548355415797d5a275f6e62e41d747bbfd08bd61cfcaac72f7`）。

**敏感扫描**（只报 path:line:rule，不打印 token 值）：候选源码仅 1 命中 `backend/tests/environment-credentials.spec.ts:224`（`BASIC_AUTH_URL`）——经核为**凭据拒绝 canary 的假夹具**（假 `canary:token`），非真实凭据，保留。

## 四、隔离候选构建（可复跑）

全部在 `/private/tmp/wb6-candidate/` 自有目录完成；`git clone --shared` 借用原仓对象（只读），并 `git fetch <https> 3aa9766` 把新提交取进**候选**（不 fetch 原仓库）。

1. `git clone --shared <原仓> /private/tmp/wb6-candidate/repo`（得 main + b2 对象，工作树在 b2）。
2. `git fetch --no-tags https://github.com/Dangerous828/dsh-bot-crew.git 3aa9766` + `git checkout 3aa9766`（detached）。
3. 按 §三 的 INCLUDE+证据清单（`overlay-filelist.txt` sha256 = `93801fea…edec`，340 文件）从原工作树 `cp -p` 覆盖进候选。
4. `git add -A && git write-tree`（排除本报告一轮 ⇒ SOURCE_TREE；含报告一轮 ⇒ FULL_TREE）。

覆盖结果：340 overlay 文件 **0 missing**；`backend/.backup-publish*` / `scripts/crew-watch` / `nonexistent` / `*.apk` 在候选内**确认不存在**；新评测文档 **未被覆盖**。

## 五、候选 tree 与 diffstat（以 SOURCE_TREE 计）

- SOURCE_TREE（源码 cohort，不含本报告）：**`a9ad1cb2de6f70fd46d02226ca132bca201eb220`**
- FULL_TREE（含本报告）：= SOURCE_TREE + 本报告（hex 见外部 manifest `FULL_TREE=`，不内嵌）
- **SOURCE_TREE 相对 feat tip `3aa9766^{tree}`：335 files changed，+34613 / −599（267 新增 + 68 修改）**——即源码/测试/文档/治理的净变化。
- FULL_TREE = SOURCE_TREE + 1 个新增文件（本报告）⇒ 336 files changed（+34801 / −599，268 新增 + 68 修改）。
- 主要新增源码（均在候选内）：`backend/src/app/graph.ts`、`graph-watch.ts`、`backend/src/memory/author.ts`、`auth.ts`、`hub-retraction.ts`、`backend/src/executor/sandbox.ts`、`worker-fs*.ts`、`backend/src/integrations/messages-mcp/server.ts`、`desktop/mainthread.go`、`app/.../NoticeStore.kt` 等；测试新增 `backend/tests/integrations/**`、`worker-*`、`graph*.spec.ts`、`crew-memory-{author,auth,lifecycle,retraction}.spec.ts` 等。

## 六、文档治理（仅候选副本）

- **当前开发/交付单一入口 = `开发进度.md`**（进度唯一事实来源，含 2026-11-15 最终收口现状头）。
- `2026-11-15-completeness-assessment.md` 为**历史参考**（`feat/four-blocks @ b2f305e` 时点静态快照，其 `206`/`1927` 为该时点口径）；**逐字保留、不改正文**，README 中标注为历史参考，不称「当前唯一入口」。
- `README.md`「文档」节顶部：只把 `开发进度.md` 定为当前入口；评估文档列为历史参考；`HANDOFF.md` / `HANDOFF-NEXT.md` / `交接-剩余五项-20261110.md` 统一标历史交接。
- 新增归档索引 `docs/review/README.md`：说明三份历史交接定位、review 目录组织、候选 excluded 清单（不删任何有价值记录，不触原 `HANDOFF.md`/`crew-watch`）。
- 所有新治理 links 已按文件所在目录 resolve 校验（见 §十二）。

## 七、候选回归（本次候选实跑，非引用）

| 套件 | 结果 | 备注 |
| --- | --- | --- |
| backend `tsc --noEmit` | **0 errors** | |
| backend `vitest run` | **130 files / 2177 passed / 0 failed** | |
| desktop `go test ./...` | **356 个 `=== RUN` 全过** | 见下方计数口径说明 |
| desktop `go test -race` | **clean（exit 0）** | |
| app `testDebugUnitTest` | **429 / 429 passed**（xml 53 文件，0 fail） | |
| app `testReleaseUnitTest` | **429 / 429 passed** | |

**desktop 计数口径说明（实测拆解）**：`356` = `go test ./... -v` 的 `=== RUN` 行数 = **290 个顶层 `Test*` 函数 + 62 个 `t.Run` 子测试**，全部在**单一 package（desktop）**；`--- PASS` 亦为 290 顶层 + 62 子测试。历史报告的 **281/290** 是**顶层 Test 函数级**口径，故 **290 顶层 ≈ 历史基线同口径**；`356` 是「含子测试的 RUN 计数」，与 290 不同层、不可直接比大小。本条只陈述「本次全过、`-race` clean」，不主张基线变旧、不做新旧优劣判断。

**运行环境**：node v24.11.1（复用原 `backend/node_modules` 只读符号链接）；go 1.25.3（`GOTOOLCHAIN=auto`）；Android 用 **JDK 21**（`/opt/homebrew/opt/openjdk@21`，因 JDK 25 触发 Gradle 8.11.1 内嵌 Kotlin `JavaVersion.parse("25")` 解析崩溃，属环境问题非候选代码问题），复用原 `~/.gradle` 缓存，仅构建候选 `app/.../build`。live 写验收仅隔离 DB/tmp，未触生产 89699/67367，未重启服务，未做 adb / 屏幕操作。

## 八、具体提交 / 推送方案（已获用户批准）

前提：用户已结构化明确批准『提交并推送 main 和开发分支（推荐）』。候选内先建一个原子收尾提交，atomic 推送 GitHub main + feat/four-blocks；原仓库仅在发布成功后做 CAS 归位。建议**一个原子功能收口提交**（不拆源码/测试/文档多提交——中间态可能不可编译），治理（README 顶部块 + `docs/review/README.md` + 本报告）可作**同一次提交内的独立 doc 改动**或紧邻的第二个 doc-only 提交（doc-only 提交不改代码，编译不受影响）。默认**单提交**最省心。

**在候选仓库内完成（不碰原仓）**：

1. 在 `/private/tmp/wb6-candidate/repo` 用 **FULL_TREE**（= 候选工作树 `git write-tree` 实算值，或外部 manifest `FULL_TREE=`）生成提交：`git commit-tree $(git write-tree) -p 3aa9766 -m "<msg>"` ⇒ `PUB_SHA`（提交仅在候选对象库内，尚未对外）。
2. 候选内校验：`git rev-parse PUB_SHA^{tree}` = 上述 FULL_TREE 实算值、父 = `3aa9766`。
3. 候选内 atomic 推送（注意：候选 origin 指向本地原仓，**必须显式用 GitHub HTTPS URL**，勿盲 push origin）：`git push --atomic https://github.com/Dangerous828/dsh-bot-crew.git PUB_SHA:refs/heads/feat/four-blocks PUB_SHA:refs/heads/main`（二者皆 ff）。先 dryrun 确认同样 refs；任一 remote rejected / branch protection / non-ff ⇒ 停，不改原仓、置原仓数据完整。
   - 推送前复核远端仍 `main=29de969` / `feat=3aa9766`（`git ls-remote` 或 `gh api`）；**任一已变即停重核**。

**方案 B（只推 feat，main 择期）**：仅 `git push origin PUB_SHA:refs/heads/feat/four-blocks`，`main` 暂不前进；后续再 ff。

> 均不产生 merge commit（祖先关系 0/207）。已选 A（main+feat 同推）。

## 九、口径说明（不改 3aa 评估正文）

- `3aa9766` 评估文档**逐字保留、未改一处**，作为 b2 历史静态评估。其 `206`（相对 b2、不含评估自身 doc）与本报告 `207`（remote feat tip 含评估自身 doc 相对 main）口径不同、不矛盾，**不据此改评估正文**。
- 评估 `1927/281/378` 明标「引用当日、未复跑」，属该日快照；本报告 §七 的当前实跑数字供收尾参考，**不覆盖也不否定**评估历史数字。
- 「隔离增强归档」与「Hub 留白」两件独立事项：评估 §六（`hub.ts` TODO 留白，维持不立项）与 §七（完整 OS 隔离/工具覆盖归档，不重开）各自成立，**不互套、不新增 Hub 架构决策**。
- 评估「四份交接文档需清理」：候选采纳**保留 + 归档标注**（不删）。

## 十、未纳入 / 未触碰清单（摘要）

- 未并入源码候选：`backend/.backup-publish-*`（潜在凭据）、安装包/idsig、`HANDOFF.md` 他人工作树改动（该文件 tracked，保原 dirty M）、`scripts/crew-watch/`、`nonexistent/` 缓存。
- 未触碰：原仓库所有 ref/index/工作树/未提交文件、`stash@{0}`（冻结）、生产进程 89699/89697/67367、Mac 鼠标焦点、Android 设备。
- 未做：#20 本轮不再测；不发新外部 GitHub 消息；不关 #20。

## 十一、原共享工作区如何归位（发布后执行）

> 前提：用户已批准 commit/push。发布成功后在原 repo 执行 CAS 归位（本文件只记录方案与 dryrun；实际执行结果见外部 `.meta` receipt）。目的：避免「只推隔离 clone、原工作区仍停 HEAD b2」导致下次重复/漂移。归位用 **CAS 回填 + materialize**，**不用 stash / reset / clean**。

### 11.1 冻结的原工作区基线

| 项 | 值 |
| --- | --- |
| original HEAD | `b2f305e616f52fd19ca75bae3960d669e8aaa823` |
| original branch | `feat/four-blocks` |
| original INDEX tree | `fc65e4cac77246e0161d58a803739aca7b5a7c47`（staged count **0**） |
| status porcelain 计数 | **185**（68 tracked-modified + 117 untracked） |
| stash | `stash@{0}`（基于 b2f305e）**冻结、未 pop/drop** |
| include 文件 freeze | 340 文件逐个 sha256，manifest sha256=`c8a437f0…ac72f7` |

### 11.2 关键认知：新增/变更文件必须先 materialize

原工作树**没有** remote `3aa9766` 的评估文档、也**没有**候选新增的 `docs/review/README.md`、本报告，且 `README.md` 工作树版本与候选治理版**不同**。因此**不能只 `update-ref` + `read-tree`**——否则工作树缺这些文件，`git status` 会冒出一堆 D/M。正确顺序：**先 materialize 新增/变更文件，再推进 index/ref**。

materialize 清单（before→after，逐文件；任一 before 不匹配 freeze 则整体停止，不推进）：

| 路径 | before（原工作树） | after（候选/已发布） |
| --- | --- | --- |
| `docs/review/2026-11-15-completeness-assessment.md` | 不存在 | 新增（3aa 提交内容） |
| `docs/review/README.md` | 不存在 | 新增（治理归档索引） |
| `docs/review/phase4-closeout/2026-11-15-phase4-closeout.md` | 不存在 | 新增（本报告） |
| `README.md` | tracked，原 HEAD 版（无治理块） | 治理版（顶部当前入口块） |
| 其余 337 个 include 文件 | tracked 原版 或 untracked | 候选版（内容 = 已发布 tree） |

materialize 仅**写工作树文件内容使其等于已发布 tree**（新增文件落盘、`README.md` 覆盖为治理版、其余 include 覆盖为候选版），**不删任何 excluded、不动 `HANDOFF.md`/`crew-watch`/backup/apk/nonexistent**。

### 11.3 归位步骤（CAS + materialize，非 force；已 dryrun 验证）

> dryrun 见 §十三：在自有 disposable 副本里以「原 dirty 工作树 + 缺新文件 + HANDOFF protected」模拟，按下列步骤执行后，after-status 仅 `M HANDOFF.md` + 3 组 excluded untracked，无任何 include 源码 D/M，且 materialize 后工作树 == PUB tree（除 HANDOFF）。

0. **从候选导入对象**：原仓对象库没有 `PUB_SHA`（提交只在候选）。授权后 `git -C <原仓> fetch /private/tmp/wb6-candidate/repo PUB_SHA`（**fetch 只补对象，不改工作树/不 checkout**；不 --force）。`git -C <原仓> cat-file -t PUB_SHA` 确认=commit。
1. **备份 index**：`git -C <原仓> write-tree` 记 `IDX0`（应=`fc65e4ca…`）；`cp .git/index .git/index.bak-phase4`。
2. **CAS 前置校验（整体一次判定，任一不符整体停止，不跳过个别文件推进）**：HEAD=`b2f305e`；`git diff --cached` 空（staged=0）；`status --porcelain`=185；每个 include 文件工作树 sha256 仍匹配 freeze 清单；excluded 实物存在（仅核存在，不 hash 大目录）；`stash@{0}` 仍在。**注意：不是逐文件跳过仍推进 ref，而是任一 include 被改即整体停。**
3. **materialize（关键：写 PUB tree 全部文件，唯独不写 excluded-tracked 的 `HANDOFF.md`）**：遍历 `git ls-tree -r FB0 PUB_SHA` 的每个 path，若 path ∈ EXCLUDE_TRACKED(`HANDOFF.md`) 则**跳过不写**（保原 dirty M），其余用 `git -C <原仓> cat-file blob PUB_SHA:<path>` 落盘（新增评估/review-README/本报告落盘、`README.md` 覆盖为治理版、其余 include 覆盖为候选版）。落盘后逐路径复算 sha256 = PUB_SHA 中 blob sha。**不得用 `git archive|tar` 全量解包覆盖**（会连 HANDOFF 也覆盖，丢失他人改动）。
4. **推进 ref（CAS）**：`git -C <原仓> update-ref refs/heads/<branch> PUB_SHA b2f305e…`（old 必须=`b2f305e`）。
5. **index 对齐**：`git -C <原仓> read-tree PUB_SHA`（只重写 index 不动工作树）。
6. **校验 after-status（dryrun 实测预期）**：`rev-parse HEAD`=PUB_SHA；
   - `git status --porcelain` 恰为 **4 行**：` M HANDOFF.md` + 3 个 untracked 目录 `backend/.backup-publish-20261115-013720/`、`docs/review/final-android/deliver/`、`scripts/crew-watch/`。
   - **不应出现任何 include 源码文件的 D/M**（若出现 ⇒ 回滚：`cp index.bak-phase4 .git/index` + `update-ref` 回 `b2f305e`，回报，不损原数据）。
   - `nonexistent/` 是**空目录**（0 文件），git 不跟踪空目录，故**不出现**在 status，无需处理。
7. **事务失败回退**：step 2-6 任一异常 ⇒ 恢复 `index.bak-phase4`、`update-ref` 指回 `b2f305e`、materialize 落的新增文件按需移走（不删 tracked/excluded），原仓回 11.1 基线、数据完整。

### 11.4 远端推送（原理，未执行）

- 远端若已由**候选仓库内**的 `git push --atomic` 完成（§八 step 3），原仓无需再 push；若改从原仓推送：推送前 `git ls-remote`/`gh api` 复核远端仍 `main=29de969`/`feat=3aa9766`，任一已变即停重核、不覆盖别人提交；`git push --atomic origin PUB_SHA:refs/heads/feat/four-blocks PUB_SHA:refs/heads/main`（皆 ff）。任何 non-ff rejected ⇒ 停，原仓数据保留不损。
- **不要**在原仓 build 新 commit 再 push（对象已在候选建好导入）。

### 11.5 明确不做

- 不对原 repo `stash` / `reset --hard` / `reset` / `checkout -f` / `clean`；不 `git add .`；不覆盖 excluded；不动 `stash@{0}`；不改 `HANDOFF.md`/`crew-watch` 内容。
- 全部在发布成功后执行；原仓零删除、可回退。

## 十二、验证记录（metadata / links / 局部 doc）

- 报告内所有非 http links resolve 校验：`../../../README.md`、`../../../开发进度.md` → 均存在（report 在 `docs/review/phase4-closeout/`，根为 `../../../`）。
- `docs/review/README.md` links：`../../README.md`、`../../开发进度.md`、`2026-11-15-completeness-assessment.md`、`../00-contract.md` → 均存在。
- 根 `README.md` 新 links：`开发进度.md`、`docs/review/2026-11-15-completeness-assessment.md`、`docs/review/README.md` → 均存在。
- 敏感扫描：候选源码 1 假命中（`backend/tests/environment-credentials.spec.ts:224`，生成式假 `canary:${token('wt')}@github.com`，凭据拒绝 canary 夹具），**0 真实凭据**。
- 截图：59 张 PNG **逐张实读 59/59**（发布前 publish-audit 逐张 read）：0 真实凭据、无私人无关数据；2 张为过期 fixture 短码、不阻断。早期抽样 8 张仅为阶段核查，最终口径 59/59。
- **测试证据来源（真实，分口）**：
  - **Android（唯一 on-fs 机器原件）**：`app/app/build/test-results/testDebugUnitTest/*.xml`（53 文件）与 `testReleaseUnitTest/*.xml`（53 文件），累加 tests=429/429、failures=0、errors=0、skipped=0；mtime 2026-11-15 13:41/13:42。fs 可随时复查。
  - **backend vitest（130 files / 2177 passed / 0 failed）**：来源为本 session 后台 job 的 stdout（job id `bash-5c2ea581ebac459f`，exit=0，报告行 `Test Files 130 passed (130) / Tests 2177 passed (2177) / Duration 46.06s`）。**未落盘到稳定文件路径，本次亦未复跑 2177**；非 echo 虚构，可由 root/审计在候选内重跑同命令复现。
  - **desktop Go**：job id `bash-a00be0ac3e2f40ef`（`go test ./...` exit=0 全过）+ `bash-709f469cf722417e`（`-race` exit=0 clean）；356 计数拆解见 §七。同样**未落盘**，job stdout 为凭。
  - 如需全部为机器可复核原件：须另跑一次并 `tee` 落盘（本轮未纳入源码树）。回归证据临时记录见 `.meta/regression-provenance.txt`。
- 本报告不复跑套件（见 §七）；仅核文档 metadata 与链接。

## 十三、归位 dryrun 结果（自有 disposable 副本，无 commit/push）

在 `/private/tmp/wb6-candidate/dryrun`（`git clone --shared` 原仓 → checkout `b2f305e` → 复制原工作树全部 dirty/untracked 680 文件 → HEAD=b2f305e、status=185，精确镜像原共享工作区含 HANDOFF 他人改动）上，按 §11.3 执行：

1. 创建 dryrun-only PUB commit（tree=**当时的 FULL 快照**、父=b2f305e；**仅 disposable 副本、非真发布**，其 commit/tree hex 为示例、不作权威；权威 tree 见外部 manifest）。
2. PRE-CHECK 通过：HEAD=`b2f305e`、staged=0、status=185、`index tree=fc65e4ca…`。
3. materialize：遍历 PUB tree 全文件，跳过 `HANDOFF.md`，写入 **876 files**；抽验 README/review-README/评估/报告 blobs 全部 = PUB。
4. `update-ref`→`pubtest`=PUB + `read-tree PUB`。
5. **after-status（最终）恰 4 行**：
   ```
    M HANDOFF.md                                  # 保护：他人 dirty 保留
   ?? backend/.backup-publish-20261115-013720/    # 331 files
   ?? docs/review/final-android/deliver/          # 5 files
   ?? scripts/crew-watch/                         # 2 files
   ```
   无任何 include 源码文件的 D/M；`nonexistent/` 空目录不出现。
6. 工作树 == PUB tree（`git diff --stat PUB -- . ':!HANDOFF.md'` 为空）。

结论：**CAS+materialize 步骤在模拟「原 dirty + 缺新文件 + HANDOFF protected」下产出预期 after-status，方案可执行**。dryrun 里 `git commit-tree`/`update-ref` 仅在本副本，**原仓库仍零写、未 push、无真实 PUB**。
