# paired timeline 可选 server 元数据（发布记录）

日期：2026-11-15 21:23（Asia/Shanghai）。任务：task-14。仅本文件，不改验证员 baseline/report。

## 功能
已配对 `GET /api/mobile/timeline` 顶层新增**可选只读**字段（无新路由、不改鉴权、旧 App 忽略兼容）：

```json
"server": { "crew": "<与 mDNS TXT 同源 crewFingerprint>", "public_base": "<publicEntry 真实 HTTPS base 或空>" }
```

- `crew`：复用 `crewFingerprint(stateDir)`（discovery.ts，与 mDNS 广播 TXT `crew` 同一实现同源），**不是** masterId/session id；服务端实际计算，绝不取 request host/body。
- `public_base`：复用 `publicEntry(stateDir)`，只放行 **HTTPS 无 userinfo/query/fragment**；**保留合法 base 子路径**（`https://host/prefix` 不退化成 `https://host`，去尾斜杠，root 仍 `https://host`）；无/不合格给 `""`，不推 LAN/明文。算不出整块不出现。
- 身份口径 = 「同实例指纹」非 crypto 证明。客户端硬规则：`saved crew === server.crew` 精确相等 + TLS 通过 + 结构合法才更新持久候选；空/新装拒绝任意 bootstrap 200。

## 改动 filescope
- `backend/src/app/mobile-http.ts`：`serverIdentity(stateDir)` 助手（复用现有导出）+ timeline 成功返回 `...(serverMeta?{server:serverMeta}:{})`；`url.origin` 改为 `origin + 去尾斜杠 pathname`（保子路径）。
- `backend/tests/server-identity.spec.ts`（新）：8 例（同源 crew、public_base 取 publicEntry、空/坏 pub 空、**prefix 保留**、root 无尾斜、老 App 兼容、gate 401）。
- `backend/tests/mobile-http.spec.ts`：老 timeline 逐字兼容断言把 `server` 列入剔除集。
- `backend/docs/007-architecture.md`：登记测试；`docs/00-contract.md` §5 写入字段+客户端硬规则。
- 未改 `discovery.ts`/`public-entry.ts`（函数本就 export）、`index.ts` 纯原样。

## 测试
- `tsc -p tsconfig.json --noEmit` → 0 错。
- `vitest run` → **134 files / 2238 passed / 0 failed**（含新 prefix 回归）。

## 发布（DSH profile 重组 HMR，pid 不变）
- 准入门：openTickets=0 / running=0 / paused=false；health 全 ready。
- 备份：`backend/.artifacts/diag-publish-servermeta-20261115-212251/`（700、gitignore、无秘密）——`lib.bak` + `cordis.patch.yml.bak`。
- **lib 单文件 hash**：`backend/lib/index.js` SHA256 = `9443dffb6225729ca5440ffe57a0deea4dd5804177ec07cae31fcf5f8a22ddf9`（发布前 = `9d485c90e9878008699a4acfdd0510064f961b410de90636f2f16cf9dffa57f2`）。
- **lib 全目录 tree-hash（勿与单文件混同）**：`lib/*.js` 所有 .js 的 sha256 行再 sha256 = `0835f61cace5278fa18ed1490dcce410a7c9dbfeeb6e4f4cde3f4252b92b753e`。
- build exit 0；build 后复核仍 idle；对 `~/.dsh/profiles/superagent/cordis.patch.yml` **只追加一次**明确发布注释（未改配置值、未起 watcher、未 restart 进程/8788）。
- 重组后：**pid 89699 不变**；health 13 项全 ready；paused=false/running=0。

## 真域名验收（内部测试身份，非手机、非真实凭据）
- 匿名 `GET https://crew.kentonnie.top/api/mobile/timeline` → **401**（not-paired）。
- 内部 selftest 设备 `selftest-srvmeta` 经既有设备库 API 建、真域名 `/api/mobile/pair` 兑换 → 真域名 paired timeline：
  - **`server.crew = "0kvcc5t"`**（= mDNS TXT 期望值）；
  - **`server.public_base = "https://crew.kentonnie.top"`**；
  - 旧字段完整（items/sessions/session_id/default_session_id/session_api/tasks/groups/status 均在）。
- 测试身份已 `DELETE` 吊销、其 diag 行已清；真实手机/配对（crew-desktop/d021…/66e7…）未动。未造手机日志。
- 回滚：还原 `lib.bak` + `cordis.patch.yml.bak` 再触发一次重组。
