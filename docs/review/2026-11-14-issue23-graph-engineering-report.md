# issue #23 第 1、2 项：真实只读 Graph 接入（独立 review 报告）

- 时间：2026-11-14
- 批次：**单独 Graph 批次**（不并入 memory 最终 e39f323c，也不是 2073 已验版本的延续——这是它之后的独立新增切片）
- 范围裁定：lead GO「target 落 Graph 只读 37 tests 范围」

## 一、结论

- **代码侧完成，稳定可 review**：全量 **119 files / 2110 tests 全绿**，`tsc --noEmit` 0 错。
- **#23 仍 OPEN**：真实 Mail/Calendar 账号 + 设备接收链缺（外部输入）。`pushNotice` 的 `queued` ≠ 已送达；未配真实账号时如实标 `paused`，不冒充送达。本报告不含真实账号触发证据。

## 二、落地清单（精确）

| 文件 | 类型 | 说明 |
|---|---|---|
| `backend/src/app/graph.ts` | 新增 | `MicrosoftGraphPort` 真实只读 HTTP，一份 token 同时实现 `MailPort` / `CalendarPort`；`readGraphToken`（env/file 独立引用、值现读不落库、绝不回退 Hub token）；`mailOf` / `eventOf` 映射；`GraphError` 分 401/403 与网络失败 |
| `backend/src/app/graph-watch.ts` | 新增 | `runMailRound` / `runCalendarRound`（拉→判→推→**先推后记账**→KV 落去重/游标）+ `todayEvents` + `configsFromEnv` |
| `backend/src/kv.ts` | 改 | `followup` 之后**新增** `mail` / `calendar` 两族；未改既有 families（含 memory.retractPending） |
| `backend/src/app/runtime.ts` | 改 | ≤20 行：import 2 行 + `graphHealthOf` 1 行 + `runGraphWatch` 方法 + tick 一行；**未触碰** memory retired/evict、retractPending/retry、sharing/retract 任何 hunk |
| `backend/docs/007-architecture.md` | 改 | Modules 表 +2 行、Tests 表 +2 行（否则 `tests/docs.spec.ts` 红） |
| `backend/tests/graph.spec.ts` | 新增 | 24 例 |
| `backend/tests/graph-watch.spec.ts` | 新增 | 13 例 |

合计**新增 Graph 37 例**（24 + 13）。

## 三、硬约束与负对照（均有测试，绿）

1. **独立 token 引用、绝不回退 Hub**：Graph 只认 `GRAPH_TOKEN`(env) / `GRAPH_TOKEN_FILE`(file)；两引用皆空 → **零外部请求**。负对照：只给 `HUB_TOKEN` → `graph` 请求 0 次，错误消息不含 hub token 值（`tests/graph.spec.ts`「越权约束（负对照）」）。
2. **固定官方 origin**：token 只允许送 `https://graph.microsoft.com/v1.0` 或回环测试服务器（localhost/127.x/::1），其它基址构造即拒；生产 `configsFromEnv` 从不传 base。
3. **不跟随跨 origin 重定向泄 token**：`redirect:'manual'`，3xx 到异 origin 直接拒；负对照：302→evil 只打本体 1 次、无第二次、错误不含 token。
4. **不日志正文/邮箱/密钥**：错误统一 `redactToken`；重定向目标 `redactLocation` 去 query；错误不含 user/mailbox。`$select` 只投影元数据字段（不拉 body 正文）。
5. **有界响应/分页、防重叠/重启去重**：`$top` 有界（≤1000，缺省 50）；单页拉取靠窗口回看重叠 + `mailDedupKey` / `eventSignature` 去重；游标与去重账本落 KV（`KV.mail` / `KV.calendar`），重启不重报；`runGraphWatch` 5 分钟节流，不让重叠 tick 重复/无限拉全邮箱。
6. **health 可见**：`mail` / `calendar` 两面板条目——未配 → `paused`、401/403 → `error`（分别提示 Mail.Read / Calendars.Read）、读过 → `ready`。
7. **未配置零请求**：`configsFromEnv` 返回空即 `runGraphWatch` 直接返回，且把两条 health 标 `paused`，不请求任何外部。
8. **不恢复 FCM/receiver/语音**：投递复用既有 `pushNotice`（在线直送 / 离线留件），`queued` 不叫送达。

## 四、回归

- 全量：`npx vitest run` → **119 files / 2110 passed**（含 `docs.spec.ts` 绿、Graph 37 例）。
- `tsc --noEmit` → 0 错。
- 未跑/未动：memory retired/retract sharing 相关 hunk（原样保留）、任何 build/HMR、真实 Graph 凭据。

## 五、仍缺（外部输入，非本仓工程）

- **真实 Mail/Calendar 账号**：需一份 Graph 只读 token（`Mail.Read` + `Calendars.Read`），本机未配、不假设管理员已授权。
- **设备接收链**：真机在线窗口才能验证「推一条真弹出」。#23 收口线（真实邮件与日历各触发一次提醒 + 晨报真出一份）在两者齐备前不达成。
- 面板可配置表单：`GRAPH_*` 走环境变量引用；若要 UI 可配属新 settings 设计，须另立 brief。

## 六、runbook（env 引用，不落值）

```bash
# 二选一：环境变量或 0600 凭据文件（值不进 settings、不进日志）
export GRAPH_TOKEN='<只读 token，含 Mail.Read + Calendars.Read>'
# 或
export GRAPH_TOKEN_FILE=/path/to/000600-graph-token   # 整份内容即 token，或配 GRAPH_TOKEN=KEY 走 KEY=VALUE
# 可选：读哪个邮箱 / 日历（缺省 me = token 本人）
export DSH_MAIL_USER=me
export DSH_CALENDAR_USER=me
# 可选：单独关闭某一条
export DSH_MAIL_OFF=1
```

---

## 七、勘误（2026-11-14 21:42，lead 裁定：只改文档、不改源码/HMR）

本节为对**上文第四节第 6 条 health 描述**的口径勘误，**保留历史报告原文不删**，仅补准确实测：

- 上文第 6 条写「未配 → `paused`、401/403 → `error`、读过 → `ready`」——**`paused` 那一层只成立于 pure `graphHealthOf` 单测层**。
- **Runtime 实测（wb-graph-review-release 独立核证）**：`graphHealth` 懒建，**未配置凭据时根本不创建 mail/calendar 条目
  → `/state.health` 里无这两条（缺席 / None），且零外部请求、非 error、非 live**。**不写「paused 可见」。**
- **配置后**：错误 health 才进入可见（401/403 → `error`）；正常读过 → `ready`。
- **两层保留**：`graphHealthOf` 纯函数返回 `paused` 的单测**保持通过**（占位层，逻辑正确）；Runtime 层缺席是入口未建条目，
  不是「显示 paused」。二者不是矛盾，是分层。
- 本勘误**不阻塞 #23**：#23 仍 OPEN，缺真实 Mail/Calendar 账号 + 设备送达；`queued ≠ 送达`。见
  `docs/review/2026-11-14-issue23-graph-independent-review-release.md`。
