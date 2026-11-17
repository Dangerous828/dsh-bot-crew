# 域名端 App 故障上报 API — 实施与验证

日期：2026-11-15。范围：仅服务端（接收/落盘/查询/导出/隔离验证）。客户端埋点、手机安装/蜂窝实测、
后台新 UI 均不在本轮。用户最新指示：「先把像汽车音乐 APP 那样的上报 API 做好」。

## 1. 冻结点（契约）

见 `docs/00-contract.md` §5.9。要点：

- 端点 `POST /api/mobile/diagnostics`（上报）、`GET /api/mobile/diagnostics`（看自己那台）；
  管理面 `GET /orchestrator/api/diagnostics`（看所有设备）、`.../export`（NDJSON 下载）。
- 真公网主域名 `https://crew.kentonnie.top`（cloudflared `crew-mobile.yml` → `127.0.0.1:43499`
  即 lan-server），复用同 paired 设备凭据（`x-crew-device` + `x-crew-credential`）。
  **不是** NAS relay 子路径。relay `tunnels=0` 不是本批前置阻塞。
- device 只认入口验过的 principal（`x-crew-principal`，只由 index.ts 入口注入），body 不带 device、不可伪造。
- 上报批：JSON 对象（非双重字符串化）、≤50 条、≤64KiB；普通 event 单条 ≤1KiB、crash 单条 ≤16KiB。
- 白名单：token/query/headers/body/text/聊天正文一律不采；`err` 只收类别/码短词；`route` 去 query；
  crash 只收 `errorClass` + `stack`(≤8KiB) + `breadcrumbs`(≤50，逐项白名单)。
- 幂等：同 `id`（=reportId，客户端生成）重投 ACK 同 id、不重存。
- ACK 严格 `application/json` + `{ok:true, acceptedIds:[...]}`，**只在 durable 落库后**发出；
  坏记录 `rejectedIds`+`reasonCodes` 不 ACK；整批全坏 → 400。
- 有界：每设备 5000 行 / 2MiB / 7 天；全球 50000 行 / 24MiB。写路径淘汰（按设备 FIFO，超全球再削最旧设备段），
  行数与字节都封顶。
- 速率：每设备每窗口批次上限，超了 `429` + `Retry-After`。

## 2. 改动文件

| 文件 | 改动 |
| --- | --- |
| `backend/src/app/diagnostics.ts`（新） | 白名单解析 `parseBatch`/`sanitizeEvent`、`Diagnostics` 类（速率/幂等/有界/查询/导出） |
| `backend/src/app/mobile-http.ts` | PhoneHost 加 `diagnostics?`；OPERATIONS 加 `diagnostics`；`registerMobileHttp` 注册两条 exact route；handler |
| `backend/src/app/http.ts` | HttpHost 加 `diagnostics?`；判读面加 `GET diagnostics` / `GET diagnostics/export` |
| `backend/src/app/api.ts` | `Api` 加两条只读路由类型 |
| `backend/src/app/runtime.ts` | `Runtime.diagnostics` 随 store 构造；`httpHost()` 透出 |
| `backend/src/index.ts` | `phone = Object.assign(runtime, …)` 已继承 `runtime.diagnostics`，无新增行（见 §4） |
| `backend/tests/fixtures/panel-server.ts` | 面板 fixture 补两条只读路由占位 |
| `backend/tests/diagnostics.spec.ts`（新） | 单元：白名单/幂等/行数/字节/7 天/隔离/errorsOnly/导出/全球字节计数 |
| `backend/tests/diagnostics-http.spec.ts`（新） | HTTP+tiny tmp sqlite：401/exact/ACK durable/重投去重/全坏 4xx/413/429/GET 只本设备/重开库可查 |
| `backend/tests/mobile-http.spec.ts` | 路由清单断言补两条 diagnostics |
| `backend/docs/007-architecture.md` | 模块表 + 测试表补 diagnostics |
| `docs/00-contract.md` | §5.9 冻结契约 |

## 3. 验证证据（本机实跑）

- `npx tsc -p tsconfig.json --noEmit` → **0 错**。
- `npx vitest run` → **132 files / 2210 passed / 0 failed**。
- 新增：
  - `tests/diagnostics.spec.ts` 24 例全绿（含「全球淘汰后计数不偏高」回归、7 天保留、字节上限、按设备隔离）。
  - `tests/diagnostics-http.spec.ts` 9 例全绿（真实 tmp sqlite，不触生产 state 路径）。
- **无匿名** 已单测：无 `x-crew-principal` → 401（注意：phoneGate 对不存在的 mobile path 也 401，
  所以「公网匿名 401」不能证明 API 已注册——注册证据是 exact route 命中 + 带凭据 ACK 200）。

## 4. 部署状态（已发布 A，2026-11-15）

**状态：已发布上线（不再是「待批准」）。** 执行机制 = DSH profile 重组（recomposition）HMR，pid 不重启。
`ctx.fiber.restart()` 只重挂已 import 模块、不换代码，不能上新版 —— 真实触发是 `pnpm build` 后向
`~/.dsh/profiles/superagent/cordis.patch.yml` 追加一次明确发布注释行（只改注释、不改任何配置值、不启持久 hmr、不 restart 进程/8788）。

发布事实（本机实测）：
- 准入门（发布前复核）：`tickets open=0` / `load.running=0` / `paused=false`；health 全 ready。
- 备份：`backend/.artifacts/diag-publish-20261115-201952/`（700、`.artifacts` 已 gitignore 不进 git、无秘密）——
  `lib.bak`（完整旧 lib）+ `cordis.patch.yml.bak`（原样）；未读/未恢复他人旧 `backend/.backup-publish-20261115-013720`。
  **回滚**：还原 `lib.bak` + `cordis.patch.yml.bak` 再触发一次重组即可。
- 构建：`pnpm run build` exit 0；**发布运行入口 `backend/lib/index.js` 文件 SHA256 = `9d485c90e9878008699a4acfdd0510064f961b410de90636f2f16cf9dffa57f2`**（本次发布运行产物；lead 已独立 shasum 复核一致）。
  （另记整目录指纹：`lib/*.js` tree-style hash = `32bb39879bd42f216878fd24ee4c8fdfa7f9ed7326c26cd3fcfc20df55e11c28`，把所有 `.js` 的 sha256 行再 sha256 一遍所得，仅作整目录指纹，**勿与上面单文件 hash 混同**）；旧 `lib.bak` 无 `api/mobile/diagnostics`（0 处），新 `lib/index.js` 含（2 处）；
- 重组后：**pid 89699 不变**；health 13 项全 ready；paused=false / running=0 / openTickets=0。
- 真域名实测（隔离配对凭据，非真实手机）：`POST https://crew.kentonnie.top/api/mobile/diagnostics` → **200 `{"ok":true,"acceptedIds":[…]}`**；
  同 id 重投仍 ok、只存一份；`GET` 返回 `device=selftest-diag` 仅自己、build 带出、`?device=<别人>` 伪造被忽略；
  匿名 POST → `401` not-paired。「exact route 已注册」用「带凭据拿到 JSON ok」证明，不靠匿名 401（不存在的 mobile path 也 401）。
- 测试身份 `selftest-diag` 经既有设备库 API 创建并标明 selftest，测后已 `DELETE` 吊销、其 selftest 行已清；
  **真实手机/配对（crew-desktop/d021…/66e7…）未动**。event=`api_selftest`/session=`selftest` 少量，未假手机日志、未触任务/审批。mobilegw(Python) 未涉及、未 restart。
- 验证口径：**2228 全量是 checkpoint**；最终独立验收是 3 spec 53 例 + tsc（车 App 机制：ACK/去重/版本/typed crash/breadcrumbs/脱敏有界 API）。

**延期 / 不在本轮**：客户端埋点、红米重装、蜂窝现场外网复测按用户请求延期未做。
**不宣称**：API 上线 ≠ App 已自动上报，≠ 出门后整个 App 故障已修复。外网故障根因与客户端接线归其他 task/后续。
