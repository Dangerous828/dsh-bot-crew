# 内部消息链 · 手机审批入口交付报告（2026-11-15）

> 范围：本人 desktop/mobile 内部消息链。只呈现当前版本；各环节事故与根因见对应 review 文档（下方链接），本文不复述。

## 一、交付能力

内部消息链已端到端上线并实测：

- **手机审批入口**：`POST /api/mobile/answer {ticket, text, attention_id}`。手机 timeline 的 `tasks[]` 对等待答复的票下发 `question` 与 `attention_id`，点选项（做吧/先别做/换个做法）即打到该路由。
- **同一套审批状态机**：答复经 `Runtime.answerTicket` 走与 feishu `approvalReply` 共用的 `applyApprovalAnswer`（不编第二套）。做吧→go、先别做→stop、换个做法→revise、认不出→409 不动。
- **旧卡防护**：`attention_id` 必须与票当前 `ticket.attention.id` 一致；不匹配（旧卡/已变）→ 409 零变更；同题双点在授权消费后再答 → 409。审计记 **真实设备 actor**（来自入口验过的 principal，绝不读 body 自报）。
- **自动执行**：批准后由**真 `DshExecutor.deliver`** 自动重投递同一 worker，经真 `workOnly` guard 放行 → 真 MCP stdio 执行一次；拒绝 → 零写。

## 二、验证（可复跑 spec + 真机实测）

后端 spec（隔离 canary DB，真 Runtime/DshExecutor/MCP）：
- [`internal-messages-executor-runtime.spec.ts`](</Users/cpuser/Code/dsh-bot-crew/backend/tests/integrations/internal-messages-executor-runtime.spec.ts>)：真 `executor.start`→真 launch→worker→真 guard 拦（零写）→手机做吧→**真 `executor.deliver` 自动重投递**→真 MCP stdio replies **+1** 正文真实；stop→零写。
- [`internal-messages-live-acceptance.spec.ts`](</Users/cpuser/Code/dsh-bot-crew/backend/tests/integrations/internal-messages-live-acceptance.spec.ts>)：answerTicket 全态 + 审批签名语义稳定（对象键递归排序、数组保序；同参不同键序=同一次，值变/数组换序重问）。
- [`internal-messages-real-executor.spec.ts`](</Users/cpuser/Code/dsh-bot-crew/backend/tests/integrations/internal-messages-real-executor.spec.ts>)：真 `Sessions.ensure` 自动装 workOnly guard。

真机实测（真身份，独立验证包 `com.dsh.botcrew.answerverify` 连隔离 canary，真机点击）：
- **做吧**：canary replies 0→1，reply 正文与审批 text 逐字一致，票 `pendingApproval` 清、executor 接手；审计 `actor=<真实 deviceId>`。
- **先别做**：票 ended、replies 零写。
- **notices 200**（真凭据 derived device）/ 错凭据 401 / 无凭据 401；**stale attention 409**、缺 attention_id 400，均零写。
- 真机解锁安装：PIN 正规输入解锁、`adb install` 成功、主包 firstInstallTime 未变。根因=AOD 秒级熄屏 + installer 按钮坐标（详见 [device review](</Users/cpuser/Code/dsh-bot-crew/docs/review/phase3-device/2026-11-15-device-unlock-install-answer-verify.md>)）。

## 三、部署（生产已上线）

- 后端 [`backend/lib/index.js`](</Users/cpuser/Code/dsh-bot-crew/backend/lib/index.js>) 已 `pnpm build` 重建并 HMR 上线（`f297c4d5e67c9edc`，含 `/api/mobile/answer`+answerTicket+attention_id）；touch 触 recompose，**主 dsh 89699 / gateway 67367 启动时刻不变**（无重启）。
- 生产零写 smoke：`/api/mobile/answer` 无/坏凭据、伪造 `x-crew-principal` → **401**（`phoneGate` 在 `/api/mobile/*` 前先拦）；新 bundle 已含该路由；生产真库 messages 68 / replies 49 / maxreply 52 / integrity ok 全程不变。400/409 handler 语义由**隔离 canary 真身份**实证（§二），prod 侧 smoke 只证「鉴权在前 + bundle 含路由 + 零写」，不互替。
- 回滚预案（未执行）：精确目录替换——按本次 build 产物清单删新增 chunk 后整目录换回 [`backend/.backup-publish-20261115-013720/lib`](</Users/cpuser/Code/dsh-bot-crew/backend/.backup-publish-20261115-013720/lib>)，profile 换回同备份 `superagent-profile`，再 `touch lib/index.js` 触 HMR（不运行 start/ensure_gateway、不广杀）。备份 dirhash `deeda4c0…`、profile patch `694d14fe…`。

## 四、本轮改动的源码（仅本批，非全仓 manifest）

| 文件 | sha256 前16 | 作用 |
|---|---|---|
| [`runtime.ts`](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/runtime.ts>) | `fcec5d3340e5f9be` | `applyApprovalAnswer` 唯一应用体；`answerTicket(ticketId,text,attentionId,actor)`（旧卡防护+审计）；guard 签名语义稳定 |
| [`mobile-http.ts`](</Users/cpuser/Code/dsh-bot-crew/backend/src/app/mobile-http.ts>) | `2c57d1d0bcc7e836` | `POST /api/mobile/answer`（三字段必填、actor 取 x-crew-principal）；timeline 下发 `attention_id` |
| [`index.ts`](</Users/cpuser/Code/dsh-bot-crew/backend/src/index.ts>) | `2d1cf7c80066e638` | phone.answer 接 `runtime.answerTicket` |
| [`00-contract.md`](</Users/cpuser/Code/dsh-bot-crew/docs/00-contract.md>) | `056e7a66b2d7a35a` | §3 `POST /api/mobile/answer` 契约 |
| [`007-architecture.md`](</Users/cpuser/Code/dsh-bot-crew/backend/docs/007-architecture.md>) | `3be29da421707e42` | Tests 表 + canary 夹具章节 |

验收夹具（非产品 API，不随交付上线）：[`canary-launcher.ts`](</Users/cpuser/Code/dsh-bot-crew/backend/scripts/canary-launcher.ts>)。

## 五、最终产物（当前版本）

- **Android 正式主 APK**：[`dsh-botcrew-internal-final-20261115-0133-answer.apk`](</Users/cpuser/Code/dsh-bot-crew/docs/review/final-android/deliver/dsh-botcrew-internal-final-20261115-0133-answer.apk>)
  sha256 `44d7799527bf3a39f41307b30a8242bf3f4a004cb915b872ad0ac4e7832d29fc`（package `com.dsh.botcrew` 0.1.0/1，release 非 debuggable，signer 29b26ea2）。install-r 已成功：base.apk 逐字节一致、firstInstallTime 2026-11-11 22:27:11 未变、权限 granted、session=main/work 主配对保留。
- **桌面 r3**：[`Bot-Crew-desktop-release-20261115-r3.zip`](</Users/cpuser/Code/dsh-bot-crew/desktop/build/release-20261115-r3/Bot-Crew-desktop-release-20261115-r3.zip>) sha256 `8765108fa93e08ed4a0436efe62a4365ae729ec66c40460029a404e4ed0ec625`；exe `04140927…b9f3df`（arm64，ad-hoc codesign 通过，[审核](</Users/cpuser/Code/dsh-bot-crew/docs/review/phase3-desktop/2026-11-15-desktop-r3-review-and-package.md>)）。
- **后端 lib**：[`backend/lib/index.js`](</Users/cpuser/Code/dsh-bot-crew/backend/lib/index.js>) = `f297c4d5e67c9edc`（HMR 上线版）。

**证据链接**：[内部消息 live+审批](</Users/cpuser/Code/dsh-bot-crew/docs/review/phase2-integration/2026-11-15-task11-internal-messages-live-and-approval.md>) · [手机隧道根因](</Users/cpuser/Code/dsh-bot-crew/docs/review/phase2-transport/2026-11-15-phone-tunnel-transport-root-cause-and-fix.md>) · [worker 隔离 ADR](</Users/cpuser/Code/dsh-bot-crew/docs/adr/0004-worker-isolation-os-user.md>) · [device 真机实测](</Users/cpuser/Code/dsh-bot-crew/docs/review/phase3-device/2026-11-15-device-unlock-install-answer-verify.md>)。

## 六、质量门与剩余事项

- 质量门（单一 gate 实跑）：`tsc -p tsconfig.json --noEmit` 0 错；`vitest run` **130 files / 2177 passed / 0 failed**；客户端 Android debug/release 各 429 pass，桌面 `go test -race` 290 pass。
- 生产：主 dsh 89699 / gateway 67367 启动时刻不变（运行就绪），真库 mobileq 68/49/52 integrity ok 全程零写。
- issue：**#5 CLOSED(completed，差距索引总账本轮清理完成——9 条 gap 均落到已完成/已归档/已转独立 issue 且独立 issue 已处置)；#10 CLOSED(completed，Step 7 追踪单按用户 scope「只做内部消息」达成，外部真账号集成撤出、不冒充)**；#21 CLOSED(not_planned，内部 messages 一类端到端走通、shopping/外部真账号撤出不冒充)；#23 CLOSED(not_planned，外部 mail/calendar 监听源撤出、内部通知/晨报已实测)；#22 CLOSED(completed，外包沙箱可行性结论——opt-in wrappers bash+文件读面 20 真工具实测，默认 none/root 保留、write/edit/patch host-fence、网络不过滤、不切 uid、多模态未测，非完整 OS 隔离)。**当前 open 仅剩 #20**（异网对端仍缺，工具就绪异网 peer 上线即收口，保留独立 OPEN，不测、不给假 close/假 success rate）。**关闭索引 ≠ 代码已上 GitHub**：本轮仅收敛 issue 入口与文档账，代码仍为本地工作树（HEAD `b2f305e` 之后未提交/未推送，运行证据取自已部署版本与本地实测，非远端 blob）。
