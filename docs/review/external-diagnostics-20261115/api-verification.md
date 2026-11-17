# App 故障上报 API · 独立验收报告（task-12 · 通过）

日期：2026-11-15（Asia/Shanghai）。执行：`wb-report-api-verify`（task-12 正式独立验收 owner）。
范围：独立 review 源码 + 隔离 fixture 单测 + 真实域名 live 复验。只服务端；不触手机 / ADB。

---

## 一、端点与鉴权

- `POST /api/mobile/diagnostics`、`GET /api/mobile/diagnostics`（exact route，宿主侧直答，不转发网关）。
- 鉴权复用配对设备凭据（`x-crew-device` + `x-crew-credential`）；handler 只认入口验过凭据后注入的内部 `x-crew-principal`（设备号绝不取 body / `query.device`）。无/错凭据 → `401 {"error":"Not paired"}`。
- 管理面 `GET /orchestrator/api/diagnostics` 与 `/orchestrator/api/diagnostics/export`：仅本机 admin（loopback Host + `x-orchestrator-request:1`），可跨设备只读全量；缺该头 → 403。

## 二、字段与边界

- 白名单落盘，只收：`id/kind/at/event/route/method/status/ms/err/session/appVersion/versionCode/extra`；crash 另收 `errorClass/stack(≤8KiB，只留结构帧)/breadcrumbs(≤50，逐项白名单)`。token / query / headers / body / text / 聊天正文一律不采；`err` 只收类别码短词。
- route 净化：一次有界 `decodeURIComponent`；解码后残留任何 `%HH`（多层编码/非法百分号）→ 拒 `route_bad_encoding`；解码后含 `?`/`#` 或命中敏感（`sk_live_` 等密钥、Bearer、`password=`）→ 拒 `route_sensitive`。
- 落盘行带 server 派生 `device / app / build`（批级元数据入每行）。
- 幂等：同 `id` 重投纳入 `acceptedIds` 不重存。ACK 只在 durable `store.set`（同步 sqlite）之后返回 `{ok:true, acceptedIds, rejectedIds, reasonCodes}`；坏记录进 `rejectedIds/reasonCodes` 不被 ACK；整批全坏 → 400。
- boundaries：单 event ≤1KiB / crash ≤16KiB / 批 ≤50 / body ≤64KiB；超 body 413；超限批 400；超速率 429 + `Retry-After`。
- 有界保留：每设备行数(5000)+字节(2MiB)、全球行数(50000)+字节(24MiB)、7 天；写路径淘汰 + 读侧 `cutoff` 兜底（沉默设备过期也不返回）；全局字节按实际扣减不高估。

## 三、自动化测试（真实计数）

- `tsc --noEmit` → **exit 0**。
- `vitest run tests/diagnostics.spec.ts tests/diagnostics-http.spec.ts tests/diagnostics-review.spec.ts` → **3 files / 53 passed / 0 failed**（owner 两 spec + 本差分 spec）。
- 全量 `vitest run` 133 files / 2228 passed 仅作 checkpoint（早于最后守卫）；最终以目标 3 spec 的 53 为验收计数。

## 四、真实域名 live 复验（独立）

- actual domain：`https://crew.kentonnie.top`（`mobile-public-url` 实值）；Mac 出站，非手机蜂窝。
- 方法：经 loopback 配对生成专用 selftest 设备凭据（token 仅程序内传 headers，不打印/不落 URL），真域名走一轮，收尾 `DELETE remote/devices` 吊销。
- 结果 **12/12 通过**：
  - 配对鉴权 `POST` → **200 `application/json` `{ok:true,acceptedIds:[…]}`**；同 id 重投 ok 且只存一份（幂等）。
  - own `GET` → `device`=本机、rows 全本机（foreign=0），build 带出；伪造 `?device=<他人>` 被忽略。
  - 错凭据 / 无凭据 → **401**；已鉴权打不存在路径 → **404**（落到 origin 路由，与无 auth 的 401 fence 区分——单看匿名 401 不能证明路由存在）。
  - admin `GET`/`export` loopback 同源 → 200、NDJSON 导出无 secret 泄漏；缺 `x-orchestrator-request` → 403。
- 未冒真实 Redmi/OPPO 数据；未发任务/审批。

## 五、部署与资源

- pid **89699 未变**（HMR，不重启）；`paused=false`、`running=0`、health **13/13 ready**。
- live `backend/lib/index.js` sha256 = `9d485c90e9878008699a4acfdd0510064f961b410de90636f2f16cf9dffa57f2`（含全部冻结 diagnostics 逻辑；lead 亦实算确认）。
- 真实设备凭据/数据（crew-desktop / Redmi / OPPO）未动；验证用 selftest 设备已吊销、其诊断键已清除。
- 发布动作归 owner / lead 批准执行；本成员不碰运行 profile。

## 六、结论

- 客户端未接入：全仓 `app/ desktop/ src/client` 无 `/api/mobile/diagnostics` 调用 —— 本期仅后端上报/查询/导出；客户端埋点与诊断页按 task-10 **延期**（手机未碰）。
- **task-12 独立验收通过**。代码门禁（tsc 0 + 53 spec）+ 真域名 live 12/12 + source/live 行为一致。

## 附：调用样例（已配对设备；不含真实 token）

```
# 用已配对设备的凭据头，真域名上报（event=api_selftest；正式客户端接入前仅作后端验证）
curl -s -X POST https://crew.kentonnie.top/api/mobile/diagnostics \
  -H 'x-crew-device: <DEVICE_ID>' -H 'x-crew-credential: <DEVICE_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"app":"BotCrew","build":"<ver>","batch":[{"id":"<id>","at":"<ISO8601>","event":"api_selftest","route":"/api/mobile/diagnostics","method":"POST","status":200,"ms":12}]}'
```
