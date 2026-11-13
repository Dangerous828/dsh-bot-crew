# 多会话的 seam 放在网关 / 消息面：masterId 保持单值

对应 #10 多会话大阶段 S1（2026-11-13）。状态：accepted（决策已定；S2–S4 为后续切片，本阶段不实现）。

## 背景

要开「多会话 / 群组视图」，最容易动错的是 `masterId`：它是 DSH 总路由 Session 的 id，全队伍单值
（`kv.ts` 的 `master-id`，`runtime.ts` 只算一次），归档守卫、模型路由、worker 派生全挂在它上面
（ADR 0005）。按「人开几个会话」把它拆成多值，等于重做 DSH 上游的会话模型，与 ADR 0001
「不重新实现 dsh 会话接口」相冲。

真正写死「只有一段」的是 `conversation` 这一层：网关进程常量 `CONV = 'main'`、
`GLOSSARY.md` 旧条目「id 恒为 main」。而队列层早就按 conversation 建了表
（`messages.conversation` 列、`(conversation, request_id)` 唯一索引、`mobileq --conversation`），
relay 也把 `url.search` 原样透传（`relay/src/server.ts:644`）。缺的只是线上协议、网关请求级选择、
后端按会话过滤与客户端状态。

## 决策

**seam 选在网关 / 消息面，不动 DSH 上游。** `masterId` 保持单值，`runtime.ts` /
`sessions.ts` / `http.ts` 零改动；给 `session_id` 做线上消息面字段（只走 query，默认 `main`），
与队列 `conversation` 列一一映射，网关把进程常量换成请求级选择。DSH 那边仍只有一支队伍、
一个总路由；多出来的是「消息流」的维度，不是 Session 的维度。

考虑过并否掉的两条：

- **改 `masterId` 为多值 / 每会话一个总路由**：要动 DSH 会话层与归档守卫，不可逆、影响面覆盖全部既有 Ticket，违背 ADR 0001 / 0005。
- **每段会话一套独立队列 / 库**：数据分裂，跨会话查询、迁移、幂等键都要重做；队列本就有 conversation 列，没必要。

**expand–contract 顺序**：先 expand，后 contract，中间不删任何老行为。

1. expand（S1）：只在响应**加**字段（`session_id`、`session_api: 1`、`sessions`、`default_session_id`），
   只**新增** `/api/mobile/sessions` 路由，只把 `CONV` 泛化成请求参数且缺省仍 `main`。
   老请求逐字不变，双版本可并存；能力位先落地，让「对端是否升级」变成可观测的事实。
   **能力位覆盖显式会话请求的所有响应**（含 send / withdraw / claim 及错误响应），
   不只 timeline —— 客户端可能不先探测就直发 `send?session_id=work`，那条路径也必须能被认出来。
2. 迁移（S2 / S3）：客户端先验 `session_api: 1` 再启用显式非 `main`；在此之前一律只发 `main`。
3. contract（S4 及以后）：各层都升级后，才收紧准入、去掉单会话兜底一类老假设。S1 不做任何删除或收紧。

## 四个垂直切片（S1–S4）

| 切片 | 内容 | 依赖 | 回退点 |
| --- | --- | --- | --- |
| **S1 协议 expand（本阶段）** | 网关请求级 `session_of`、SQL 全链路按会话、消息面 `/api/mobile/sessions` 与 timeline 能力位、READ_CURSOR / timeline 按会话分键、`invalid_session` / `unsupported_session`、后端测试与独立验收脚本。**后端闭环** | — | 停发 `session_id` 即全量回落 `main`；改动只在网关 + 消息面两处，回退这两处即可，无需数据迁移（队列仍是同一份 `mobileq.db`，`conversation` 列本就存在） |
| **S2 手机端切换 / 新建** | app 端读会话名单、切会话、先验能力位 | S1 | 客户端不发 `session_id` 即回落 S1 的 `main`；整批灰度可关停，后端零改动 |
| **S3 桌面端切换 / 新建** | desktop 端同上；header 形态的 `session_id` 在此开放 | S1（与 S2 并行） | 同 S2；header 未被识别时按 S1 只认 query / 缺省 `main` |
| **S4 隔离不变量收口 + 群组只读投影** | 把 Source 准入判定（`scope()` / `channel.allowed`）与会话名单对齐，「未登记会话不静默丢消息」落成机制；真机 / 人工验收窗口 | S2 / S3 | 准入是配置项：保持 `conversations` 名单为 `main` 全域即回到 S1 行为，不涉及数据 |

每片可独立验证、单独回退；expand 阶段没删老行为，所以四片的回退都不需要回滚数据。

## 静默串线的四种组合与能力位防串

最大的向后兼容风险：**新客户端显式带 `session_id != main` 撞上老网关 / 老消息面，会全程 200 静默串线** ——
send body 重构丢未知字段、`CONV` 仍写 `main`、timeline 全量下发、`READ_CURSOR` 全局单键，
客户端以为在会话 X，实际读写的是 `main`，且没有任何一步报错。

按「客户端（老 = 不带 `session_id` / 新 = 会发显式非 `main`）× 后端（老 = 不回显 `session_api` /
新 = 回显 `session_api: 1`）」展开成四种组合：

| 组合 | 客户端 | 后端 | 结果 |
| --- | --- | --- | --- |
| C1 | 老 | 老 | 全落 `main`，200，逐字兼容，无串线（双方只认一段） |
| C2 | 老 | 新 | 缺省回落 `main`，200 + 回显 `session_id: "main"` / `session_api: 1`，老客户端忽略能力位，无串线 |
| C3 | 新 | 新 | 显式非 `main` 正确分片，200 + 回显 `session_id: X` / `session_api: 1`，无串线 |
| C4 | 新 | **老** | **全程 200 静默串线**（唯一危险组合） |

能力位防串（都指向同一条规矩：**显式非 `main` 遇未升级对端，宁可报错，也不静默当 `main`**）：

- **客户端侧**：新客户端只在确认 `session_api: 1` 后才发显式非 `main`；缺位即停止发送并明确报错，禁止静默降级。这是 C4 在后端全老时唯一的防线（老后端一路 200，拦不住自己）。
- **消息面侧**：显式 `session_id != main` 而网关**任一**响应缺 `session_api` → 409 `unsupported_session`；非法形状 → 400 `invalid_session`。滚动升级时（新消息面 + 老网关）由这一道把 C4 从「静默 200」翻成「响亮的 409」，且覆盖直发 send 的路径，不依赖客户端先取 timeline。
- **为什么 S1 先做能力位**：S1 交付时客户端还没接（下节），能力位是提前埋给 S2 / S3 的；等客户端真开始发显式非 `main`，后端已是新版本，C4 不再成立。

## 本阶段（S1）的边界

- **S1 是后端闭环**：手机 / 桌面客户端本阶段不改，老调用逐字不变（不带 `session_id` 的请求形状、状态码、响应其余内容；新增字段是增量的，按契约 §5「未知字段必须保留、不得丢弃」处理）。
- **不动 DSH 上游**：`runtime.ts` / `sessions.ts` / `http.ts` / `mobile-http.ts` 的 masterId 相关零改动，`masterId` 单值不动；不动运行中服务、不动生产 `<stateDir>/mobileq.db`。
- **不动 Source 准入判定**：`team.ts` / `mobile.ts` 的 `ConfigSchema.conversations` 名单、`scope()` / `channel.allowed` 本阶段只加说明性注释，不改判定逻辑。S1 只写文档契约与「未登记会话不静默丢消息」的说明 —— 消息仍按其 conversation 落队列、可在 `timeline?session_id=X` 读到，只是未列入名单就不派单，不凭空消失。**准入与会话名单的收口留给 S4**，见上表。
- S2 / S3 客户端接入、S4 准入收口与真机验收窗口都标在 `docs/00-contract.md` §9 的 `TODO(owner, 日期)` 里，本阶段未实现。

## 依据

- `开发进度.md` §十（#10 方案：expand–contract、四切片、`session_api:1` / 409 的由来）。
- `docs/00-contract.md` §9「会话」（字段形状、能力位、错误码、四种组合）、`GLOSSARY.md`（`masterId` / `conversation` / `session_id` 三词分工）。
- `relay/src/server.ts:644`（`rest + url.search` 原样透传）；`backend/src/kv.ts` / `runtime.ts`（`master-id` 单值）。
- ADR 0001（后端留在 dsh 进程）、ADR 0002（客户端只走消息面）、ADR 0005（主 Session 不归档）。
