# docs/review 归档索引

> 本文件只做**索引与定位**，不替代正文。当前口径入口见根目录 [`README.md`](../../README.md) 与 [`开发进度.md`](../../开发进度.md)。

## 一、当前口径（先读）

| 文档 | 定位 |
| --- | --- |
| [`../../开发进度.md`](../../开发进度.md) | 开发进度**唯一事实来源**，含 2026-11-15 最终收口现状头 |
| [`2026-11-15-completeness-assessment.md`](2026-11-15-completeness-assessment.md) | 完整性评估。评估对象为 `feat/four-blocks @ b2f305e` 的**历史静态快照**，代表该时点，不作最新源码断言 |
| [`../00-contract.md`](../00-contract.md) | 消息面契约（当前版本） |
| [`ux-mobile-20261115/`](ux-mobile-20261115/) | **2026-11-15 手机端 UX 优化（紧凑首屏）**：过程 review 与独立验收入口。最终（OPPO `55c86317`）：debug/release 各 458 全绿、assemble 通过、同签 install -r Success（sha256 `ed5972a3…5dc0`、firstInstallTime 保留），真机 UI 六项通过 + 健康点色修复。**148dp = 52+48+48 代码布局值，非容器精测**。报告 [`2026-11-15-ux-delivery.md`](ux-mobile-20261115/2026-11-15-ux-delivery.md) |
| [`ux-sidebar-20261115/`](ux-sidebar-20261115/) | **2026-11-15 本批手机端 UX · 单行顶栏 + 侧边栏（drawer）**：过程 review / 两轮独立源码 review / 真机验收。设计终稿同 [`../../designs/crew-mobile-ux/project`](../../designs/crew-mobile-ux/project)（Main/Drawer/Tasks 三画板 + IMPLEMENTATION.md）。最终（OPPO PEDM00/`55c86317`）：compileDebugKotlin + **DrawerNavigationTest 20/20** + assembleRelease 通过（472×2 为上一 checkpoint 全量，本批跑焦点/Back/通知/role 专项 20 不重跑全量），同签 install -r Success（**final sha256 `e6450ee3…822ed2`**、cert `ad0e4480…af7eb`、firstInstallTime 保留），真机全项通过（单行 56dp 代码值/系统栏另计、drawer 300dp、back/遮罩关、通知导航可展开、资料→名片、onTalk focused+IME、会话管理）。报告 [`2026-11-15-sidebar-delivery.md`](ux-sidebar-20261115/2026-11-15-sidebar-delivery.md) |
| [`cellular-20261115/`](cellular-20261115/) | **2026-11-15 客户端 r2 蜂窝真机验收（当前）**：交付包 `cellular-20261115-r2-signed.apk`（sha256 `0eb388ba…436569`，同签、firstInstall 保留）；debug/release 各 575/0/0/0；同签覆盖+force-stop+WiFi↔Cell 均免配自动回 main、server pairedAt 全程不变；CELLULAR VALIDATED+NOT_VPN 无 USB 代理、r2 **PUBLIC 业务 25 条全 200**（capture-at 15:10:43–15:12:15Z）；手动补传实际发送。验收报告 [`verification.md`](cellular-20261115/verification.md)，服务端同口径 [`server-received.md`](cellular-20261115/server-received.md)。（本目录早期 `device-baseline.md`/`01/04 等过程图` 为过程留痕，非当前口径） |
| [`external-diagnostics-20261115/`](external-diagnostics-20261115/) | **2026-11-15 域名端 App 故障上报 API（已发布 A）**：`POST/GET /api/mobile/diagnostics` + 管理面只读 `/orchestrator/api/diagnostics`、`/export`，真主域名 `crew.kentonnie.top` 同 paired 凭据；车 App 机制（reportId 幂等/typed crash/breadcrumbs/全白名单脱敏/行数+字节有界）。发布经 DSH profile 重组 HMR，pid 89699 不变、health ready、发布入口 `backend/lib/index.js` 文件 SHA256 `9d485c90…fa57f2`（整目录 tree-hash `32bb3987…e11c28` 另记勿混同）。实施+发布证据 [`api-implementation.md`](external-diagnostics-20261115/api-implementation.md)；外网链路只读根因 [`network-findings.md`](external-diagnostics-20261115/network-findings.md)。**客户端/红米重装/蜂窝外网复测延期未做；API 上线≠App 已自动上报**。最终独立验收（3 spec 53 + tsc）见验证员 task12 报告 |

## 二、历史交接文档定位（留档，不进现行口径）

仓库根目录并存三份早期交接类文档，只能靠日期分辨哪份现行，现统一在此标注为**历史档案**（保留其价值记录，不删除）：

| 文件 | 写于 | 定位 |
| --- | --- | --- |
| `HANDOFF.md` | 2026-11-10 | 项目结构 / 技能栈 / 验证门槛总述；后经他人在工作树追加 11-13 段。**历史背景**，部分结论已被 `开发进度.md` 与 ADR 取代 |
| `HANDOFF-NEXT.md` | 2026-11-12 | tailcat P2P 通道那一轮的交接。**历史快照**（当时后端 1667 tests，非当前数字） |
| `交接-剩余五项-20261110.md` | 2026-11-10 | 四期五项补齐的交接，五项均已完成。**历史快照** |

> 现行进度一律以 [`../../开发进度.md`](../../开发进度.md) 为准；上述三份仅作来源留痕。

## 三、本目录的组织

- `2026-11-1x-*.md`：分主题的过程 review 与验收报告（配对屏、桌面生命周期、issue19/20/21/23/24/25/26、workspace 等）。
- `ux-mobile-20261115/`：**2026-11-15 手机端 UX 优化（紧凑首屏）** 的独立 review / 验证准备 / 真机验收报告；设计终稿在 `designs/crew-mobile-ux/project`。
- `ux-sidebar-20261115/`：**2026-11-15 本批手机端 UX · 单行顶栏 + 侧边栏（drawer）** 的独立 review / 两轮源码 review / 真机验收报告与交付 APK；设计终稿在 `designs/crew-mobile-ux/project`（三画板 + IMPLEMENTATION.md）。
- `phase2-*/`、`phase3-*/`：按批次归档的证据（integration / network / receive / transport / worker / client-answer / desktop / device）。
- `shots-*/`、`desktop-gui-accept-*/`、`final-android/`：真机 / 桌面 / 配对的截图与 XML 证据（对应各报告结论）。
- `incident/`：工程事故记录（mobilegw 重启等）。
- `issue24-patch/`、`issue24-sync/`：issue24 记忆中枢的补丁与同步脚本留档。

## 四、不在本候选内的内容（excluded，非源码）

`HANDOFF.md` 的他人在工作树未提交改动、`scripts/crew-watch/`（操作者文件）不并入源码候选；安装包（`*.apk`/`*.zip`）与运行 state/DB/日志为交付物/运行时产物，不入源码树，保留在原工作树。
