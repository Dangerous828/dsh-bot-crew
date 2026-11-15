# 项目交付状态 · 2026-11-14

- 仓库 / 分支：`/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks`，HEAD `b2f305e`
- 计数时点：2026-11-14 21:44 CST（Asia/Shanghai），`gh issue list --state all --limit 200 --json number,state` 同一份返回机器计数
- 一句话：**项目当前交付状态快照，不是"全部关单"。** 未关的每条都注明外部条件，逐条给依赖清单，不假称完成。

---

## 一、issue 状态（同一 GH 快照自动计数）

- **TOTAL 32 / CLOSED 26 / OPEN 6**
- **OPEN(6)**：`#5 #10 #20 #21 #22 #23`
  - 真未决 4 条：`#20 #21 #22 #23`（缺外部输入，见 §四）
  - 收窄追踪单 2 条：`#5 #10`（索引单，其未决项指向 #20/#21/#22/#23）
- 已关闭不计入清单，不在此复述。

---

## 二、生产部署态

- **后端 `backend/lib/index.js`**：sha256 `2ade8753165c3a01f7320634ea8be382f8dd72951726b94d7fec02633fec6af7`，mtime 2026-11-14 21:37:48。
  - 含 **memory-sync 批次**（`retarget`/`ensureSettled` 命中 6/4，memory 配置生命周期热修复）+
    **Graph 批次**（`runGraphWatch`/`MicrosoftGraphPort`/`graphHealthOf`/`readGraphToken` 命中 2/2/3/2）。
  - 生产 PID 89699/89697（14:26:39）、mobilegw 67367（18:31:04）**本次 memory/Graph HMR 窗口内未重启**
    （HMR 为 chokidar watch patch→热 recompose）。早前 mobilegw 两次误停见 §六 incident，不混为"全会话无事件"。
- **测试口径**：memory 批次 2073 green；Graph 批次 **119 files / 2110 tests 全绿、tsc 0、新增 37 tests**、独立负对照 7/7。
  （两个批次各自口径，不用 2073 冒充含 Graph。）
- **Graph 未配置时**：`/state` 无 mail/calendar 健康条目（缺席、零外部请求、非 error、非 live）；核心 `memory=ready`。

---

## 三、可交付 artifact（均实测存在，hash 见括号）

- **手机最终 APK**：[`dsh-botcrew-final-2056.apk`](final-android/deliver/dsh-botcrew-final-2056.apk)
  （sha256 `6e16ae2d041e3e1f616b6bc3c742b4e6f0e58f1ca57cb986f8d9ae88a5fe6755`，16,421,767 B；已装、主配对指纹不变）
- **桌面最终 r2**：[`Bot-Crew-desktop-release-20261114-r2.zip`](../../desktop/build/release-20261114-r2/Bot-Crew-desktop-release-20261114-r2.zip)
  （zip sha256 `6532659ddae7bdae0218c6bb51576f1a2be0f0076390b4fb118452c7652f564c`）；
  二进制 `Bot Crew.app/Contents/MacOS/desktop` sha256 `f132d7fff2792f3dce92225bd923680d46ee692188ebfa3d36a6f548c3d54bc1`，
  `codesign --verify --deep --strict` exit 0。
- **生产后端**：[`backend/lib/`](../../backend/lib/)（`index.js` `2ade8753…`，见 §二）。

---

## 四、外部解锁条件（补齐对应 issue 才能真关）

| 需要的外部输入 | 解锁 | 具体 |
|---|---|---|
| 一台**不同 NAT 出口**的对端（非同一路由器）+ 手机蜂窝开通 | #20 | 确认 `win-laptop` 网络窗口或另一台不同公网出口机器；手机当前 `mobile_data=0`/`OUT_OF_SERVICE`/无 IPv4（只读核对，未开数据、未查套餐） |
| **真实 Graph 只读凭据及启用配置 + 设备接收链补齐/启用** | #23 | Graph 只读 token（`Mail.Read`+`Calendars.Read`，`GRAPH_TOKEN`/`GRAPH_TOKEN_FILE`，值不落库、不回退 Hub token）并启用配置；**接收链**：手机现已在线且已验，但 App **无 push receiver 入口**、FCM 此前被用户叫停，缺的是这一段接收链（不是等手机上线）。工程 Graph 已部署但未配置不发请求；`queued` 仍不是送达，**不声称仅给 token 即可原条款全过** |
| **真实 MCP 服务器**（messages 或 shopping）+ 凭据引用 | #21 | 宿主注册 `mcp__<server>__<tool>`，`readTools`+`writeTools`+connection+审批四连 |
| **DSH provider 级隔离能力** | #22 | provider 级 uid/gid 或外包沙箱；worker 会话不再钉死 `danger-full-access`（默认 `isolation=none` 不翻） |

- 追踪单 `#5`（差距评估战略清单）、`#10`（Step 7 行动面扩展）指向上述 4 条，不单独关。

---

## 五、真实证据与已验/未验边界

- **#24 记忆中枢（真实产品入口闭环）**：A=本 Mac 生产运行时 → 既有 `local_dream` pipeline → NAS 中枢 →
  B=**win-desktop 物理独立设备**（产品 `HubHttp`）。真 `send` 生成（默认 `toHub:false`）→ 认证 `edit{toHub:true}`
  → `author.publish` 落 md → 管道上行 NAS（live=1）→ B 召回命中 → 真 `forget`（disabled + 按 `source_file`
  撤全历史 + 原子 tombstone）→ live=0 → 不复活。**默认不分享，仅显式 edit 才上行；原 28 条私有 to_hub 全程 0。**
  范围：撤回凭 canonical `namespace + source_file`（非业务 dedupe_key）。详见
  [issue24 报告](2026-11-14-issue24-product-ledger-seam.md) §九。
- **已验（附 fixture 标签，不冒充 OS 截图）**：
  - 配对屏四路 **passed**（隔离 applicationId 测试包 + 真实 mDNS fixture 服务）：干净装弹权限框 / 拒绝后手输仍配对 / 同网段选第二行 / 手改不被抢。见 [配对四路径](2026-11-14-pairing-screen-four-paths.md)。
  - 桌面 takeover 按钮走真实产品处理器（mygo `act press`→真 `OnClick`→两真票 `5846d4f0`/`eb555457` 停止不复活）；
    双徽标同屏 / 群组三态为**真窗口 fixture 自渲染像素**。见 [desktop-gui 报告](2026-11-14-desktop-gui-remaining-acceptance.md)。
  - `#33` probe 墙钟硬截止为 **JVM 产品代码台架**证据（慢滴 81.64s→1.56s、生产默认 20s→20.09s）；真机慢滴未注真实隧道，边界如实标。
- **仍未覆盖（保 OPEN，真机人眼面）**：生产现场两徽标「自然同时>0」的 **OS 系统屏幕截图**、非 fixture 群组/真实可见屏幕采集、常规 `Regular` 启动聚焦。见 `docs/00-contract.md` §9.4。

---

## 六、交付约束与维护计划（不含任何密钥）

- **本轮未 commit / push；本收尾 agent 无任何 git 写操作。** 早前 ds23 全树 stash / checkout / restore 事故
  **已记录并已恢复**，`stash@{0}`（基于 `b2f305e`）**冻结、勿 pop/drop**；工作树 dirty + untracked 是本轮
  交付约束，不删除、不暂存他人文件。
- **mobilegw 维护 token 未轮换**：旧进程不热读，纳入维护窗口处理，不需设备重配。网关日志已 0600 等长脱敏、
  0 匹配，当前启动不打印。**本轮禁止跑 `ensure_gateway`。**
- 工程事故（stash、mobilegw 两次误停、网关日志脱敏）细节只链接：
  [mobilegw 误停 incident](incident/2026-11-14-mobilegw-restart-incident.md)；
  详细工程账与逐项核对轨迹见 [收尾审计账](2026-11-14-closeout-audit-ledger.md)。
