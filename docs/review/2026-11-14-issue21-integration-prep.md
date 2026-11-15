# #21 接一个真实集成并端到端走通 —— 工程前置收尾（只读核验 + 独立探针）

日期：2026-11-14 · 角色：`wb-integration21`（子委派，只读 + 独立路径产物）
承接：WorkBuddy DS 接回，前 session `780c3e2f…` 因 Trae QUOTA 结束；#21 此前状态为「未开始」，无半成品需复用或重设。

---

## 一、结论（一句话）

**#21 保持 OPEN。** 底座（7 种 kind、读放行/写审批、审批拒绝则不执行）已就绪且有 26 例绿测佐证；
但真实 messages / shopping 集成在本机**不具备任何真实实体**——WorkBuddy DS 宿主实际只注册了
`dsh-sessions / hub_memory / magpie-image / tavily` 四组 MCP 工具，**没有 messages / shopping 服务器**。
因此「worker 真读一次、真写一次、审批走通、拒绝路径」无法端到端演示。这不是代码没写，是缺一份外部输入。
Figma / 普通 HTTP / fixture 假购物都不算实集成，未采用，也不应作为关闭 #21 的依据。

## 二、已复核的事实与证据

| 事实 | 证据位置 |
|---|---|
| 7 种 kind 类型定义齐 | `backend/src/app/connections.ts:26`；`backend/src/policy.ts:110`（zod 同 7 种） |
| 读放行 / 写（readOnly）必 ask / 未知按写 | `connections.ts` `natureOf` / `judgeCall`；`backend/tests/crew-connections.spec.ts` |
| 审批拒绝则写不执行（grant 是「一次精确调用」） | `backend/src/app/runtime.ts:767` `guardConnection`；`sessions.ts:311-330` `workOnly` guard |
| worker 只拿「设置里的 connections ∩ 宿主真注册的工具」 | `backend/src/app/sessions.ts:318-320`：`.filter(name => agent.ctx.tools.get(name, parent))` |
| 当前 settings.connections 为空 | #10/#21 复核记录 `docs/review/2026-11-14-issue-inventory.md:112`：`{ connections: [], readOnly: true }` |
| **宿主无 messages/shopping MCP 工具** | `magpie find_tools` 全量清单：仅 dsh-sessions / hub_memory / magpie-image / tavily |

## 三、底座测试（只读复跑，不改共享文件）

```
cd backend && npx vitest run tests/crew-connections.spec.ts
→ 26 passed（26）
```

覆盖：natureOf 读写分类、judgeCall allow/ask/deny、readOnly 开关、allowedTools、connectionsOf 容错、
以及 Step-7 新增 kinds（messages/shopping/payments/tickets）读 allow / 写 ask。

## 四、独立探针（新增，独立路径，不改生产）

文件：`backend/tests/issue21-integration-readiness.spec.ts`（5 例全绿）

它不换假集成，而是把 `sessions.ts:320` 的真实闸门原样重演：
`reachable = allowedTools(connections) ∩ hostTools`。断言三件事：

1. **当前真实状态 = blocked**：即使把 messages/shopping 配到最全，宿主未注册 → 交集为空 → worker 拿不到任何真工具。
2. **正向对照（输入到位后即可走通）**：宿主真挂 messages/shopping 时，读 allow、写 ask，白名单能给出读写两类工具。
3. **两条真实配置约束（本次审查新发现的坑，写进注释与断言）：**
   - 只写 `{ kind, server }`（readTools 留空）→ `allowedTools` 只产出**内置读白名单**，写工具（send_message / place_order …）**不出现**。要做「真写一次」必须在条目里显式声明 `writeTools`。
   - 一旦显式声明**任一**工具（哪怕只声明 writeTools），内置读白名单**整批失效**（`connections.ts:140` `explicit` 分支）——读工具也得显式列出，否则读也没了。

> 这两条不是缺陷，是现有分类口径的必然结果；但接真实集成时若只声明一半，会表现为「配了却读不到/写不了」。
> 记录在此，供真正配 #21 的人照抄：**readTools 与 writeTools 两列都显式写全**。

## 五、唯一外部输入清单（缺这些，#21 无法推进；不是「等账号」这种空话）

1. **一个真实的 MCP 服务器**，二选一：
   - messages 类（如某个 IM 的 MCP server，暴露 `list_channels` / `get_message` / `send_message` 等）；或
   - shopping 类（暴露 `search_products` / `get_product` / `place_order` 等）。
   它必须被 **WorkBuddy DS 宿主**加载并注册成 `mcp__<server>__<tool>`（当前宿主里不存在）。
2. **该服务器的凭据引用**：以 MCP 服务器的 `credential reference`（环境变量名或宿主密钥引用键）形式给出，
   凭据本身留在宿主 MCP 配置，不进本仓、不进 connections 配置。
3. **一条 connections 配置**（面板「对外连接」block，`panelOnlyConnections`，只能从面板写）：
   ```jsonc
   { "kind": "messages", "server": "<server 名>",
     "readTools":  ["list_channels", "get_message"],
     "writeTools": ["send_message"] }   // 读写两列都要显式写全，见第四节约束
   ```
   `readOnly: true`（默认，写必过审批，勿关）。
4. **只读验收命令与失败边界**（供验收方原样跑）：
   - 前置：确认宿主真注册了工具 —— 工具名里能查到 `mcp__<server>__list_channels`（否则下面的都白搭）。
   - 读：worker 调 `mcp__<server>__list_channels` → 应 `allow` 直接返回，无审批。
   - 写-批准：worker 调 `mcp__<server>__send_message`（对自己的测试会话/自己的收件人）→ 应进入 `attention` 审批；
     批准后**只重试同一参数一次**，执行成功留审批记录 + 执行结果。
   - 写-拒绝：再发一条 → 审批点「拒绝」→ 必须**真不执行**（外部无副作用，ticket `pendingApproval` 清空）。
   - 失败边界：`tools.get` 为空（服务器没连上）→ worker 一个 connection 工具都拿不到，读也会失败；
     此情形先修宿主 MCP 挂载，不是改 connections。

## 六、边界声明（本次做了什么 / 没做什么）

- **做**：只读核验源码与宿主工具清单；新增一个独立 readiness 探针测试（独立路径）；本报告。
- **没做**：未改 shared/production MCP 插件；未重启；未改 backend runtime/memory/policy/config（那些归 wb-memory-config / wb-memory-sync）；
  未 git add/commit/stash/checkout；未抢焦点；未读私有账户文件/凭据；未用 Figma/HTTP/fixture 假集成偷换；未真实发消息/下单。
- 触及其他 reviewer 的既有修改（`git status` 里大量 M 文件）一律未动，只在本人独立文件 `backend/tests/issue21-integration-readiness.spec.ts` 落笔。

## 七、给 lead 的下一步

#21 要真关，需上面第五节的外部输入到位后在**真机**跑第四节验收四连。输入未到位前维持 OPEN，
不建议把本探针的「正向对照」当成已完成证据——它只证明「规则对了、缺口在宿主侧」。
