# 待收通知跨热加载持久化（PushOutbox → Store/KV）：工程报告

- 时间：2026-11-14 23:0x+（Asia/Shanghai）
- 角色：wb2-notice-durable（WorkBuddy DS）。task-8。
- 结论：**新链（peek → 设备 commit → ACK）以前的持久缺口已堵**。`PushOutbox` 不再只有内存 `Map`，改为
  经注入的 `NoticeStore` 落项目既有 `Store`/SQLite（一桶一键 `KV.notice.pending:<deviceId>`）。入队成功才回
  `queued`、peek 不删、ACK 持久化成功后才移内存/回 2xx、写盘失败明确抛出、TTL/CAP/同 kind 合并语义按现口径恢复一致。
  用「同一临时 DB、换新 `Store`/新 `PushOutbox` 重建」验证 id/内容仍在、ACK 后确无件、deviceA ACK 不删 B、失败不假成功。
- 边界：**只保障新链以后入队的件**。旧进程只活在内存里的历史件没有恢复来源，不称「自动迁移/复原了旧内存」、
  不伪造旧数据（新字段读空即真空首次）。不生产重启、不 HMR、不配 FCM、不改认证/客户端协议。

## 一、这次堵的根因（工程事实）
- 旧 `Runtime` 字段 `private readonly pushOutbox = new PushOutbox()`：`PushOutbox` 只有 `boxes: Map`。
  设备 ACK 前的排队件只活在进程内存 → backend HMR / 实例重建即**全部丢失**（用户视角：手机离线期间「有事要说」的件断了）。
- 真机 peek→App commit→ACK 协议本身已过（wb2-receive 报告），断的不在协议，而在**队列本身的持久化**。

## 二、最小改动面（三文件 + 一测试 + 007）
- `src/app/push.ts`
  - 新增 `NoticeStore` 接口（`get/set/delete/devices`）—— `PushOutbox` 的持久化后端口子；`Queued` 导出为落盘形状。
  - `PushOutbox` 现在可接 `store`（缺省仍纯内存，供语义单测）。**盘是真相、内存只是 Cache**：每次改动先
    `load()`（读盘、滤过期、TTL 过期件**同步从盘真删**），改完先写盘成功、再更新内存；写盘抛则一路上抛。
  - `noticeId` 保持**纯内容**稳定 id（同设备+kind/title/body/at 同一条），与旧内存语义一致（同内容重投在 peek/ack
    按 id 去重、不复制成两条）。曾考虑掺入队时钟盐以让「不同时刻的同内容两条」各得其 id，但那是**改业务语义**、
    不在本项范围，已回退，既有 `tests/notices.spec.ts` 一行未动。
  - `deliver()` 文档明确：落件写盘失败抛出，**不把「没留住」说成 `queued`**（那是假承诺）。
  - `storeNoticeStore(store)`：把 `PushOutbox` 接到项目 `Store`/KV 的 adapter，`devices()` 走 `Store.keys` 族前缀
    —— 新进程靠它把上次写成孤键、已不记得 deviceId 的桶找回来。
- `src/kv.ts`
  - 仅 additive 扩 `notice` 族：新增 `notice.pending`（`notice-pending:<deviceId>`）。既有 `notice.seen` 等 families 不动。
- `src/app/runtime.ts`
  - 字段从「初始化即 `new PushOutbox()`」改为构造器内 `store` 就绪后再 `this.pushOutbox = new PushOutbox({}, storeNoticeStore(store))`。
    **明确依赖顺序**，不靠字段初始化在 TS 转译里偶然早于 constructor 的 store 赋值。
  - `pendingNotices/ackNotices/takePending` 全部经同一个持久 outbox；`noticeSeen/markNoticeSeen`（seen 账本）本就落库，未改。
- `backend/tests/notices-persistence.spec.ts`：新增 12 条（见下）。
- `docs/007-architecture.md`：push 模块行补持久化语义；测试表加 `notices-persistence` 行（只增自己这两类行）。

## 三、语义一致性（按现口径恢复，未改业务）
- 稳定 id：入队即生成随条目落盘，之后 peek 恒同 id（纯内容口径，与旧语义一致）。
- TTL：`load()` 过滤 `expiresAt <= now` 的件；有件过期时**同步写回/删盘**（不留只在内存里过期的假象）。
- CAP（`MAX_QUEUE_PER_DEVICE`）：超了从最旧丢；同 kind 只留最新（`deduped.slice(-cap)` 原语义）。
- ACK：只删点名 id，幂等空操作安全；写盘成功后才更新内存并返回删除数。
- peek：绝不删（除真实 TTL 清理）。
- 认证/principal/每 device 范围：`mobile-http.ts` 的 GET=peek（认入口注入的 principal）、POST=ack 形状不变，未触碰。

## 四、验证（临时 DB / 假 clock，全在 /tmp）
`npx vitest run tests/notices-persistence.spec.ts` → **12 passed**；`tests/crew-push.spec.ts` 11 条原样通过（内存默认路径不回归）。
覆盖：
1. 入队 → 同一 DB 新 `Store`+新 `PushOutbox` → id/内容仍在；
2. peek 反复重试不减、id 稳定（含换实例后）；
3. ACK 后再重建确无件、空桶不留孤键；
4. deviceA ACK 不删 B；
5. CAP 与同 kind 合并从盘恢复一致；
6. TTL 过期内存与盘同步删；
7. 满 CAP 从盘读回最新、挤掉最旧；
8. 写盘失败：`keep` / `deliver` / `ack` 均抛出（不假 queued、不假删）；内存不留假「已留」；
9. Runtime 接法演练：`Store` KV 上确落键且带稳定 id（证明不是只活在内存 Map）；
10. 真空新库读空、不伪造旧数据。

App 侧既有 7 tests（commit 前/后断点）未改动，本项不触碰 Android。

## 五、边界与不做
- 不做旧内存件「恢复/迁移」；只保新链以后入队。
- 不生产重启 / 不 HMR / 不配 FCM·语音·外平台 / 不建推送通知 / 不读真 secret / 不 git 写。
- 批量原子：按现 `Store` 能力（每桶一键 `set`，`database` 单条 UPSERT 原子；不引新数据库/大队列系统）。
