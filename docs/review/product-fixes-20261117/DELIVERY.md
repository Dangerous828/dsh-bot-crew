# 本轮交付说明：0.2.1(4)

2026-11-17。八项产品问题修复的最终交付记录。结论先行：**已发布**。

| 项 | 状态 |
|---|---|
| 后台代码 | 已部署（独立 `superagent`，no-web，端口 62502，PID 36183） |
| Android | `0.2.1(4)` 已同签覆盖安装到真机 Redmi K80（`9f9cc3db`） |
| 线上 OTA | 已推广，`versionCode=4` / `versionName=0.2.1` / `buildId=product-ux-20261117-r3` |
| APK sha256 | `81166773c515cb473eddde85d0376a30e9c08cb8e78ff47a9020e0e5ef30edec`（12889245 字节） |
| 数据迁移 | `mobileq.replies.kind` 回填 65 条（ack 29 / notice 2 / reply 34），二次执行 0 写 |
| 真机验收 | 恢复旅程 6/6（`9f9cc3db`），主用户配对与业务数据全程未动 |
| 提交 | 未 push；代码与本文件在同一批次提交 |

## 一、八项问题与修法

编号沿用 `ANDROID.md` 的产品问题编号。

### P1-01 / P1-02 消息收据与执行活动分开
回执（`acknowledgement`）和执行状态是两条正交的线，以前混在一起，"接手了"被当成"已答复"，
而"在调模型/在跑工具"没有真实来源，只能靠最后一行日志猜。
- 出站类型落库：网关 agent 条目新增 `reply_kind: acknowledgement | notice | reply`，
  新写入从出站类型持久化，历史缺类型的**不按文字猜**（保持 NULL）。
- 活动投影：新增 `native-activity.ts` 从原生事件投影 `activity(kind/since/at/label)`，
  经 `GET /api/mobile/activity` 增量返回；没有原生事件证据时只给 `evaluating` / `unknown`，
  不伪造 `model` / `tool`。
- 用户 timeline 保留 `request_state`，可带 `ticket_ref`。

证据：`ACTIVITY.md`、`backend/tests/activity.spec.ts`、`native-activity.spec.ts`、
`sessions-activity.spec.ts`、`runtime-activity.spec.ts`。

### P1-03 草稿按会话恢复（含收件人）
草稿以前只有一个，切换会话就被覆盖。现在按「会话 + 收件人」持久化，发送返回不清用户随后输入的新内容。
证据：`app/.../DraftStore.kt`、`WorkspaceCopyTest`、`ReconciliationDraftTest`。

### P1-04 未确定发送（`request_id` 不丢）
发送前先把完整 envelope（正文 / mentions / 收件人 / `request_id` / session）落库，再 POST。
- 断网、503、回执丢失 → 显示"结果待确认"，保留原 `request_id` 与原文，可「用原内容重试」。
- 重启后用同 id 对账：已落库的不再重复写，未落库的重发同 id。
- 明确成功才清记录；迟到回调不会擦掉新草稿。
证据：`SendRecovery.kt`、`SendOwnership.kt`、`PairingStore`，真机旅程见下。

### P1-05 暂停范围
「全队暂停」与「当前票停止」分开：前者停整个队伍，后者沿用既有 stop/takeover 语义，并在文案里写清后果。

### P1-06 审批可读
以前问题卡直接把工具协议 `stringify(args)` 当正文。现在 `Ticket.attention` 增量带 `presentation`：

```
{ kind: "connection" | "task", action: "发送消息", target: "当前对话",
  preview: "真实换行的内容", details: "脱敏工具详情" }
```

正文按字段解码、不做全局反转义（`%2F` 保持字面）；旧卡仍然可用（旧 `question` 进 details，
不冒充 preview）；取消 connection 不再终止整票，并唤醒原 worker；同签重试不重复出卡。
证据：`APPROVAL.md`、`backend/src/app/approval.ts`、真机截图 `phone-after-install.png`。

### P1-07 失败提示按请求归属
失败提示挂在它自己的请求上，成功的那条不会被另一条的错误盖住。
证据：真机旅程 `failure-stays-with-original-request-after-edited-send-succeeds`。

### P2-08 多个待决定
不再平铺一长串审批：给「另有 N 项待决定」+「逐项看」入口，进事务板逐条处理。
证据：真机旅程 `multiple-attention-entry-opens-board`、`native/pending-board.png`。

## 二、顺带修掉的两个真问题

- **工具署名只放宽检查、没有真绑定**：SDK 把 tool `exec.arguments` 深冻结，原地改会失败。
  改成包一层 worker-scoped dispatch，实际发送者按本票 Bot 解析，显式 `bot_id` 原样保留。
  证据：`tests/sessions-message-dispatch.spec.ts`（5 项，含真实冻结参数与 MCP 重连）。
- **普通问答卡走错端点**：worker 的普通 `human_options` 也走 answer 端点，而 Runtime 没有
  pendingApproval 时会失败。现在普通答复走 `answer:'reply'`，只有真审批才读 `go/stop/revise`。

## 三、验证矩阵

| 验证 | 结果 | 证据 |
|---|---|---|
| 后台 typecheck | 0 错 | `BACKEND_TYPECHECK_FINAL.log` |
| 后台测试 | 143 files / 2378 tests | `BACKEND_TEST_FINAL.log`、`BACKEND_CHECK_CLOSEOUT.log` |
| 后台构建 | 成功 | `BACKEND_BUILD_FINAL.log` |
| Android 单元测试 | 通过 | `ANDROID_UNIT_FINAL.log` |
| Android 出包 | `0.2.1(4)`，同签 | `ANDROID_BUILD_FINAL_R3.log` |
| 真机状态链路 | evaluating / model / tool / retrying、ack 不算答复、typed reply 可见 | `NATIVE_CHECK.json` |
| 真机恢复旅程 | 6/6 | `NATIVE_RECOVERY_CHECK.json` |
| 线上 OTA | manifest 与 APK 字节一致，37 项校验 | `PUBLISH_R3.json` |
| 生产回填 | 65 条，幂等 | `BACKFILL_RUN.json` |

真机验收的路子值得记一句：用 Android 临时用户隔离（`pm create-user` → `pm install-existing`
→ `adb reverse` 连本机台架 → 跑完删用户），所以**主用户的生产配对与真实数据全程没被碰过**，
`remote-devices.json` 仍是 11-15 那份三条登记。

## 四、已知限制（不要当成已解决）

1. **真机读不到 `crew-sends.xml`**：release 包无 root/run-as，本地发送账本无法直接取证。
   恢复旅程改用 UI 证据（重试入口、carrier 是否重发、timeline 是否重复），
   这三条独立观测成立，但没有本地账本层面的证据。
2. **台架数据是合成的**：`product-ux-server.ts` 的凭据与设备都是 fixture-only，
   LLM 成本为 0，因此**不能**用它证明真实模型链路的耗时与失败分布。
3. **生产仍有 29 张票，b27 等人**：这是业务状态，不是缺陷。
4. **测试对机器负载敏感**：`mobileq` / `internal-messages-*` 这些要 spawn `python3` 的用例是 5s 超时，
   机器被别的任务跑满时会成片超时（表现为假失败）。跑回归前先确认负载。

## 五、回滚

- Android：`docs/review/product-fixes-20261117/phone-rollback/installed-0.2.0.apk`
  （sha256 `17c9e3c30c06c9e94f99c031bdf7c1766488cfa2b93463d96dc9b9113e9cb679`），同签可覆盖装回。
- 数据：部署前快照 `~/.dsh/backups/botcrew-product-deploy-20261117-095137`；
  回填前快照 `~/.dsh/backups/botcrew-reply-kinds-20261117-105747`。
- 后台：`backend/lib` 的回滚副本以最初 BASELINE 备份为准（后续 build 已改磁盘 lib，
  不要把新 lib 当作旧运行版本）。
- OTA：`publish` 不改旧路径，`/updates/android/3/...` 与旧 APK 仍在，改回 manifest 即可。
