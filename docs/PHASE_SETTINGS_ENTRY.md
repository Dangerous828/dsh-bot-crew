# 审批与外部连接的设置入口

2026-11-12。审批档位与外部连接的执行闸门此前已接入运行时（见 `PHASE_APPROVAL_WIRING_CHECK.md`），但设置页只能改 policy/eval/executor，无法把 approval/connections 落盘。本票补齐版本化保存与可操作界面。

## 后端

- `policy.ts`：`SettingsBlock` 增加 `'approval' | 'connections'`，两者已纳入 `policyVersion`（前序改动）。
- `settings.ts`：`BLOCKS` 新增两块，各自 `ApprovalConfigSchema` / `ConnectionsConfigSchema` 校验与合并；`view()` 与 `block()` 下发/读取两块；非 `panel` 来源修改审批档位或连接配置被拒（`panelOnlyApproval` / `panelOnlyConnections`，新的 `UserError` 码，防止模型工具自行放宽授权范围）。
- `http.ts`：`SettingsBlockSchema` 接受 `approval`、`connections`。
- `views/settings.ts`：`blocks` 增加 `approval`、`connections` 的 `{ value, revision }`。
- `core/errors.ts`：新增两个拒绝码与英文文案。

## 前端

- `src/client/approval.tsx`（新）：`ApprovalSettings` 只暴露三档（自动/询问/关闭）；额度阈值 `askWhenBudgetUsed` 无真实数据源，已从界面撤下（schema 字段保留兼容历史配置，不再出现在 UI）。`ConnectionsSettings` 用只读开关加可增删的连接行（类别、服务器、读/写工具逗号列表、移除）。均复用现有 `Fields`/`Field`/`Input`/`SaveBar`/`useBlockDraft`，各自按自己的 block revision 保存，不把原始 JSON 丢给普通用户。
- `route.ts`、`settings.tsx`：新增 `approval` 设置分组（阶段组，执行后一项），渲染两个块。
- `locales.ts`：新增分组名、字段、错误与连接类别等中英键。

## 自动验证

- `tests/settings.spec.ts`：panel 保存 approval 提升策略版本；非 panel 改审批档位被拒；panel 保存 connections；非 panel 改连接被拒。
- `tests/panel-settings.spec.tsx`：在「审批与连接」组切到询问、设阈值并保存 approval；关只读、加 mail 连接并保存 connections；设置分组导航顺序含新组。
- `tests/fixtures/panel-server.ts`：`GET settings` 下发 approval/connections 块，`PUT settings/:block` 接受并校验两块。
- `backend/docs/007-architecture.md`：登记 `client/approval.tsx` 与 `tests/voice-carrier.spec.ts`，`docs.spec` 通过。

回归：后端全量 99 文件 / 1712 用例通过；`pnpm typecheck` 退出 0；隔离 `tsdown` 构建到 `.artifacts/final-build` 成功（未写 `backend/lib`）；`relay` 的 `tsc --noEmit` 退出 0。

## 待部署与范围

- 这些是源码与自动化测试修复；运行中的独立 crew profile 尚未加载新构建，真实管理页改动、含部署后生效仍待验证。
- 动态新增连接工具可能需要对已有 worker 会话重建才能获得新工具（现有 `restrict` 不会自动扩大）；撤销权限已由运行时逐调用 guard 实时生效。
- `askWhenBudgetUsed` 仍缺真实剩余额度数据源，阈值 UI 已如实标注不生效，未伪造。
