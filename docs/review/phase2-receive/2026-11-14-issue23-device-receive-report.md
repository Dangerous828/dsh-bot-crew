# issue #23 设备接收链（真机闭环）：工程 + 真机验证报告

- 时间：2026-11-14 22:35+（Asia/Shanghai）
- 角色：wb2-receive（新 WorkBuddy DS）。task-4。
- 范围裁定（lead）：本轮**不接外部平台**（Graph/Telegram 等不索账号、不扩），不恢复 FCM/语音/系统推送；
  #23 本轮缺口专注**本人 desktop/mobile 内部消息的接收闭环**。Graph 工程保留未启用，只读核查可停。
- 结论：**设备接收闭环工程 + 真机双双跑通**。`queued → device-received → ack` 分层真实可核验，非「backend queued + 手机在线」冒充。
  #23 的「真实 Mail/Calendar 源」项仍不勾（无真实账号，且 lead 定本轮不做外部平台）。

## 一、这次补的真缺口（工程事实）
- 后端早有 `PushOutbox`（离线留件）+ `Runtime.takePending(deviceId)`，但 **takePending 全仓无人调用**：
  留件从创建到过期没有任何路由领取。Android 无任何 notices/receiver 入口。→ 接收链断在「无取件路由 + App 无取件」。

## 二、分层语义（不混，均可核验）
- `queued`：PushOutbox 里留着的条数（设备此刻没领）。**不是送达。**
- `delivered`：设备一次 `GET /api/mobile/notices`（peek）真拿到 → App **先落本地**（SharedPreferences `commit()` 确认）→
  **落盘成功之后**才 `POST` ACK 点名这些 id → 后端才把它们从留件移除。设备 persisted=真收到。
- `seen`：device-persisted 账本（`KV.notice.seen(deviceId)`，有界、幂等）。**不是「人眼读过」**——真实人眼 read 另证，不冒充。
- 三态在响应 `counts:{pending,seen}` 分开报，客户端不拿 queue 数当送达数。

## 三、lead 四条设计强化的落实
1. **GET 不 drain 即删**：`PushOutbox` 重构为 `peek()`（不删）+ `ack(deviceId, ids)`（只删点名、幂等）。
   `noticeId` 在**入队那一刻**生成并随条目保存，每次 peek 同 id，不在 GET 重造。GET 后崩溃重试不丢件。
2. **不用 rememberSaveable**：新增 `NoticeStore`（SharedPreferences，`commit()` 同步确认写盘）+ 纯函数 `NoticeRecord`。
   先 commit 成功才 ACK；UI 列表有界（CAP=100）且按稳定 id 去重持久。device-persisted ≠ 人眼 read。
3. **deviceId 来自验过的 principal**：入口（LAN `presentedDevice` / relay `phoneGate` 验凭据）后由 index `ask` 注入
   内部头 `x-crew-principal`，客户端自带同名头被剔除；消息面**只认这个头**，绝不读客户端 `x-crew-device`。无 principal → 401。
   坏凭据/撤销设备 → 上游 401（实测）。不跨设备取件/ACK（实测）。
4. **测试**：稳定 id、peek 不删、ack 幂等且只删点名、跨设备隔离、seen 账本幂等/有界、坏值不崩。

## 四、改动清单（精确）
| 文件 | 改法 |
|---|---|
| `backend/src/app/push.ts` | 新增 `noticeId/pendingFor/seenLedgerPatch`、`NoticeDelivery`；`PushOutbox` 加 `peek/ack`（`take` 保留兼容）；`Queued` 带稳定 id |
| `backend/src/app/mobile-http.ts` | 新 operation `notices`（GET peek / POST ack+seen）+ 注册两条 exact route；`PhoneHost` 四个可选方法；`PRINCIPAL_HEADER` + `principalOf` |
| `backend/src/index.ts` | `ask(...,principal)` 注入 `x-crew-principal`（剔客户端同名）；LAN/relay 两处 forward 传 `principalOf(headers)` |
| `backend/src/kv.ts` | additive 新增 `notice.seen(deviceId)` 一族（不改既有 families） |
| `backend/src/app/runtime.ts` | ≤10 行薄封装 `pendingNotices/ackNotices/noticeSeen/markNoticeSeen`（读现有 pushOutbox+store） |
| `backend/src/app/notices-out.ts` | `Notice.kind` union 加 `'internal'`（客户端内部消息横幅；供 wb2-client-messages 用） |
| `backend/docs/007-architecture.md` | Tests 表登记 `tests/notices.spec.ts` |
| `backend/tests/notices.spec.ts` | 新增 20 例（纯函数） |
| `backend/tests/mobile-http.spec.ts` | route 列表 +2、`noticesHost()`、3 组真机链路假宿主测试 |
| `backend/tests/index-forward-headers.spec.ts` | 更新：只许 session+principal 两头进重建 Request；客户端自带 principal 被弃 |
| `app/.../CrewWire.kt` | 新增 `CrewNotice/NoticesView/NoticesWire.parse/ackBody` |
| `app/.../CrewClient.kt` | `notices()` / `reportSeen()` |
| `app/.../NoticeStore.kt` | 新增：`NoticeRecord`（纯函数）+ `NoticeStore`（SharedPreferences commit-before-ack） |
| `app/.../CrewUi.kt` | 复用 6s 轮询接 notices：peek→merge(落盘)→ACK；列表区顶部紧凑提示条（不新开屏） |
| `app/build.gradle.kts` | `applicationId` 参数化 `crewAppId`（默认 `com.dsh.botcrew` 不变，仅用于装隔离副本验证） |
| `app/.../test/NoticeRecordTest.kt` | 新增 7 例（解析/去重/幂等/有界/坏值） |

## 五、测试证据
- 后端：`tsc --noEmit` 0 错。我的改动 spec 全绿：`notices.spec.ts` + `mobile-http.spec.ts` + `index-forward-headers.spec.ts` + `crew-push.spec.ts` + `crew-notices-out.spec.ts` = **120 passed**。
  全量 `vitest run`：**2147 passed / 3 failed**。3 个 failed 全是**他成员未登记/未加 JSDoc 的新文件**（`docs.spec.ts`←sandbox.ts/messages-mcp/worker-isolation.spec.ts/messages-mcp.spec.ts；`class-docs.spec.ts`←src/executor/sandbox.ts、worker-search-subprocess.ts），**非我范围**（我未动这些文件）。
- Android：`testDebugUnitTest` **417 passed / 0 failed**（原 410 + 新增 7）。`compileDebugKotlin` 通过。

## 六、真机端到端（OPPO 55c86317，主配对未动）
隔离验证台：/tmp 独立 harness（真 `PushOutbox` + 真 `phoneHandler` notices 路由 + 真 `DeviceStore` 鉴权 + 注入 principal），
adb reverse `tcp:43599`；装**隔离副本 APK**（applicationId `com.dsh.botcrew.recvtest`，内置测试设备 `testrecv01`）。
主包 `com.dsh.botcrew` 与主配对全程未动，验证后卸载副本。

实测链路（curl + 真机 UI + 私有存储三重证据）：
1. 注入受控 notice（`kind:internal`，**明确验证台来源，不伪称真 mail/calendar**）→ `{status:queued,depth:1}`。
2. 未认证 GET → 401；坏凭据/撤销 → 401；好凭据 → 200。
3. GET peek → 返回条目但 `queued/pending 不降`（**不 drain**）；重复 GET 同 id（崩溃重试不丢）。
4. App（真机）6s 轮询：peek→`NoticeStore.merge`（SharedPreferences `commit`）→ `reportSeen`（ACK）→ 后端 `queued 1→0, seen 0→1`。
5. 截图 `docs/review/phase2-receive/recv-ui.png`：屏幕**显示**「有事记得看一下 · N」+ 每条正文（复用消息列表区，未新开屏）。
6. **离线重连领取**：App force-stop 时注入 → 仍 `queued=1`（不假装送达）；relaunch 后 → `queued 1→0, seen 1→2`。
   `docs/review/phase2-receive/recv-final.png` 截图显示离线那条「离线时来的：重连后这条应被领取」已上屏。
7. **持久化跨重启**：`run-as … cat shared_prefs/crew-notices.xml` 读到 **两条不同稳定 id** 的条目（含 `install -r` 保留的旧条目）
   → 直接证明 force-stop/冷启动不丢（rememberSaveable 的失败模式被避开）。

## 七、与 wb2-client-messages 的接口（已冻结）
- 分两面：**会话面** mobileq `replies`（server→client reply，落 replies 表，pull 只读 messages→不触发 worker 自循环；用它既有 `mobileq reply`，
  不需我加 backend 入口）；**通知面** pushOutbox/`/api/mobile/notices`（peek+ack，device-persisted）。
- 我在 `Notice.kind` 加 `'internal'`：它若要横幅用 `pushNotice({kind:'internal',...})`，id 由 `noticeId` 生成、不自算。它本轮暂不发横幅，union 值已备。

## 八、纪律与未做
- 未重启生产 dsh 89699/mobilegw 67367/tailcat；未跑 start/restart/ensure_gateway；未 pkill/killall；未抢 mac 焦点；
  未动主配对；未 git add/commit/push；未自部署。副本测试仅改 applicationId。主 APK sha 仍 `6e16ae2d…fe6755`（未变）。
- 不恢复 FCM/语音/系统通知；不申请 POST_NOTIFICATIONS；不加 receiver/前台服务。
- **#23 的「真实 Mail/Calendar 源各触发一次」不勾**：无真实 GRAPH_TOKEN（未配、不输出值、不扫用户私有目录），且 lead 定本轮不接外部平台。
  #23 保持 OPEN（真实外部源未验），但「纯工程/接收真机缺口」本轮已真正补齐并附真机证据。
