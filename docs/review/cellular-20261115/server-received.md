# 真机 CELLULAR 诊断上报 · 服务端只读核验（r2，按 capture at 严格分本轮/积压）

日期：2026-11-15 23:10–23:15 Asia/Shanghai（UTC 为原始值）。只读 admin diagnostics，按既有真实 Redmi
principal `device=d021988751fdd554`（真 SSAID，既有 Redmi 条目，设备数仍 3、OPPO/crew-desktop 未动；
server pairedAt 保持 14:02:48.425Z）。**未 POST、未造 selftest、未改 token。**
关键口径：**用 capture `at`（事件发生时间）分「本轮/live」与「积压」，不用 receivedAt 当发生时间**
（r2 装机到用户 23:09 解锁有约 53 分钟离线/Doze，旧队列会在蜂窝重连时补传，receivedAt 会远晚于 at）。

## 一、积压（离线/Doze，capture `at < 15:09Z` = < 23:09 本地）
- 共 914 行已补传；其中 **466 `UnknownHostException`**（status=null、routeKind=public、ms≈15000）。
- 这 466 条的 **capture at 范围 = 14:28:57Z … 15:08:57Z**（横跨解锁前约 40 分钟），末 8 条 at 在 15:09:08–15:09:39Z（仍离线期）。
- receivedAt 集中在 15:10:30–15:11:00Z（重连补传那一批）。
- **判定：这是「历史离线错误补传」，不是当前 WiFi 死局实测失败。** 18 秒 WiFi 窗口不可能常规轮询产生 466×15s；
  它们是 Doze/离线期间累积、蜂窝重连时批量冲刷上来的。**不拿它当本轮 WiFi 实测结论。**

## 二、本轮 LIVE（capture `at >= 15:09Z` = 23:09 本地之后，用户解锁+关 WiFi）
- 网络切换 `/app/network`：`6bed24c1…` at=15:10:25Z nk=wifi → `b169bac0…`/`b9e4523d…` at=15:10:43Z nk=none→**cellular**。
- **LIVE CELLULAR 业务：25 条，全部 status 200、routeKind=public（真域名 crew.kentonnie.top）**；
  capture **at 15:10:51Z … 15:12:15Z**，lag（recv−at）4–13s；ms min/med/max = 610 / 1186 / 6778（含真蜂窝 2–6.8s 延迟）。无 4xx/5xx、无 err。
  （逐条见本文件历史表；代表 id：`901ac77a…` at=15:10:51Z recv=15:11:02.323Z /timeline 200 2777；
   `cf763dcf…` /timeline 200 941；`e1beaf19…` /timeline 200 1583；最新 `a1849b10…` at=15:11:12Z … 后续 15:12:15Z `/timeline` 1959。）
- LIVE WIFI 阶段（转蜂窝前/后零星）：114 条 biz，其中 103 条 200 —— 但注意其中仍混有 `at≥15:09` 但实际仍离线（如 15:09:08）的少数 UnknownHost 补传；**WiFi 真实在线成功与离线补传需再以 at+status 双筛**，本轮不以 WiFi 段作结论。

## 三、结论（只读事实）
- 真实 Redmi 关闭 WiFi 后的 **LIVE CELLULAR（capture at ≥ 15:10:51Z）**：25 条 PUBLIC 真实业务全 200、routeKind=public、经真域名服务端 received，ms 610–6778 —— **真实 event 闭环成立（PUBLIC 业务 status200+请求ms+日志经域名 received，非仅 service 401/200）**。
- **466 UnknownHostException 是离线/Doze 积压补传（at 14:28–15:08Z），非本轮 WiFi 实测失败**；与本轮蜂窝成功分开记录，不混用 receivedAt 当发生时间。
- r1 历史 p2p 未拿来凑本轮。
