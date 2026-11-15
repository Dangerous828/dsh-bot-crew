# #21 —— 本地 MCP 注册/权限验收台架（engineering bench）+ 可复用热注册 hunk（校订版）

日期：2026-11-14（校订 22:10） · 角色：`wb2-integration`（子委派 task-2）
性质校订：**本产物是工程台架，不是 #21 的真实集成收口。** 上一版报告里的「真实 provider / 真集成已通 / task-2 全部完成」等泛化表述**作废**，本版按 lead 验收打回意见重写。

---

## 一、一句话定性（别误读）

- 我交付的是一个**本地 JSON 信箱 MCP 服务器 + 4 例工程测试**，它验证了「MCP 客户端热注册机制 + `allowedTools`/`judgeCall` 读放行写审批闸门 + 持久化 + 拒绝不执行」这些**工程链路本身**。
- 它**没有外部消息账号、不做任何实际通信投递**。给本地 JSON store 取名 `messages` **不等于**满足 #21「真实 messages/shopping 服务器 + 真账号 + worker real read/write + 批准执行 + 拒后不执行」的条款。
- **#21 仍需一个真账号、真能收发的外部 connector**（由操作者提供平台与凭据引用后，另派 DS 接入）。本台架**不部署为最终消息服务**，其价值只在「可复用的注册/闸门验收集」。
- 保留台架代码（不扔），因为它把「注册 hunk 长什么样 + 闸门语义对不对」变成了可复跑的证据；但它在 #21 收口里只算前置工程件，不算集成完成。

## 二、关键架构核实：desktop 与 superagent **不是同一个 profile**（lead 让我必须核实的点）

| 项 | 实况（本次核验） |
|---|---|
| 我的当前会话 | 跑在 **`desktop`** profile 下（`~/.dsh/profiles/desktop/cordis.patch.yml`），该 profile **有** 5 条 `dsh-mcp-client` 行（concat / minimax-design / magpie_h3 / magpie_web_search / magpie）——我看到的 `mcp__*` 工具来自这里 |
| **真正的 worker 宿主** | 跑 `dsh --profile superagent`（`ps` 实证；`backend/scripts/dsh-superagent` 管的也是 `superagent`，stateDir=`/Users/cpuser/.dsh/state/superagent`）|
| superagent profile 的 MCP | **零条** `dsh-mcp-client` 行、无任何 MCP 服务器 → worker 宿主里 `agent.ctx.tools.get('mcp__…')` 恒为假 → `sessions.ts:workOnly` 的 `[WORK_TOOLS, ...configured].filter(tools.get)` 把这些全过滤掉 |
| 两个 profile 关系 | **各自独立的 `cordis.patch.yml` + 独立 bundle 列表**（desktop 含 media/writer/mobile；superagent 含 dsh-superagent）。**注册 hunk 是 per-profile 的，不是共享** |
| 唯一共享层 | `~/.dsh/cordis.patch.yml`（home 层，优先级高于 profile）——当前只有 figma 一块（861B，figma 托管自动生成），可作「一处注册、两个 profile 都吃」的备选面，但它被 figma 管理，不宜混写 |

**结论：真实 connector 要真正到达 worker，必须注册进 `superagent` profile（或 home 层），注册到 desktop 是无效的**——这条是上一版报告没搞清、本版补齐的核心事实。

## 三、台架产物（保持，归档为工程件）

| 文件 | 定性 |
|---|---|
| `backend/src/integrations/messages-mcp/server.ts` | 本地 JSON 信箱 MCP stdio 服务器（零依赖，JSON-RPC 2.0；`--self-check` 冒烟）。**台架，非真实 provider** |
| `backend/src/integrations/messages-mcp/messages-mcp` | 可执行入口（打包 node v24 原生跑 .ts） |
| `backend/tests/integrations/messages-mcp.spec.ts` | 4 例工程测试（真 spawn 子进程：本地写落盘/跨进程读回/`allowedTools`+`judgeCall` 读 allow·写 ask/拒绝不执行 store 不新增） |
| `backend/docs/007-architecture.md` | 补模块表 + 测试表两行（过仓内 `docs.spec`/`class-docs.spec`） |

## 四、测试到底证明了什么 / 没证明什么（lead 要求区分）

**实际跑绿的 4 个 test（`npx vitest run tests/integrations/messages-mcp.spec.ts` → 4 passed）证明：**
1. MCP JSON-RPC stdio 协议（initialize/tools/list/tools/call）能跑通、工具名可由宿主注册为 `mcp__messages__*`；
2. 本地 store 能真落盘、跨进程读回；
3. `allowedTools()`/`judgeCall()` 纯函数对读工具给 `allow`、对写工具在 readOnly 下给 `ask`；
4. 拟真「拒绝不执行」语义：没批准就不调 send_message，store 不新增。

**这 4 个 test 没有、也不能证明：**
- ❌ 没有任何真实外部账号或第三方通信投递；
- ❌ **没有在 superagent worker 宿主里走一次真审批记录**——runtime 的 `guardConnection`（生成 `pendingApproval`、点了批准后只重试一次、拒绝清空）是**真机行为**，台架只复刻了它的判定口径，不是它的运行证据；
- ❌ 「临时 profile 真 boot 出子进程」只证明**宿主注册机制在场**（MCP client 会拉服务器），**不是**生产 worker 的审批记录。

## 五、可复用的热注册 hunk（给后续接真实 connector 的 DS；标清放哪个 profile）

### 5.1 desktop profile 的 hunk（仅供**在 desktop 会话里**演示台架；对 worker 无效）

追加到 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 insert 段（与 `mcp-magpie-web-search` 同段）：

```yaml
    - id: mcp-messages
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: messages
        command: /Users/cpuser/Code/dsh-bot-crew/backend/src/integrations/messages-mcp/messages-mcp
        args: []
        env:
          MESSAGES_MCP_DB: /Users/cpuser/.dsh/integrations/messages.json
        toolCallTimeoutMs: 60000
```

### 5.2 **worker 宿主（superagent profile）的 hunk —— 真实 connector 必须落在这里**

`~/.dsh/profiles/superagent/cordis.patch.yml` 是顶层 YAML 数组（无 insert 段，见文件头注释）。真实 connector 到时，追加一条顶层条目（示例包一层 `insert:`，与 desktop 同构；`<serverName>`、`<command|url>`、凭据引用 `<CRED_REF>` 由操作者提供，均不在此写死）：

```yaml
- insert:
    - id: mcp-<server>
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio            # 或 streamable-http + url/headers
        serverName: <serverName>    # 决定 mcp__<serverName>__<tool>
        command: <connector-bin>
        args: []
        env:
          <CRED_ENV>: !!js process.env.<CRED_ENV>   # 凭据只从宿主环境/凭据仓注入，不进本仓
        toolCallTimeoutMs: 60000
```

然后配一条 connections（面板写、`panelOnlyConnections`；读写两列都显式写全，readOnly 保持 true）语义同上；此时 `sessions.ts` 的 `filter(tools.get)` 才可能非空。

> HMR：两个 profile 的 `hmr` 都在（dsh-base 默认启），改 patch **热生效、不需重启 dsh**；但注意实际 reload 发生在对应 profile 的进程里，superagent 宿主进程才是真实 connector 生效处。

## 六、真实验收（#21 真正收口）依赖的唯一外部输入 —— 请你向用户只确认这一个

**需要的输入**：一个**真实 messages（或 shopping）平台的账号 + 该平台 connector（MCP 服务器）的凭据引用**（平台名 + 凭据在宿主哪个 env/凭据键，值不进本仓）。
- 拿到后，另派 DS 把真实 connector 按 5.2 注册进 **superagent** profile，再按上面的连接/审批语义跑：
  1. worker 调读工具 → allow 直接返回（真平台数据）；
  2. worker 调写工具（只对操作者自己的测试收件方/频道）→ 进 `attention` 审批，批准后只重试同一次 → 真投递成功、留审批记录 + 执行结果；
  3. 再发一条 → 拒绝 → 真不执行（外部无副作用、`pendingApproval` 清空）。
- 这三条在**真机 worker + 真账号**上过了，才是 #21 的端到端收口。本台架只把其中的「路由/白名单/审批判定/拒绝不执行」先在纯函数层验过。

## 七、边界（本版做了什么 / 没做什么）

- **做**：核实 desktop 与 superagent 是两个独立 profile、worker 宿主是 superagent 且无 MCP 行；把台架产物**诚实重新定性**为「本地 MCP 注册/权限验收台架」；提炼 desktop 与 **superagent** 两处可复用热注册 hunk；测试/文档/注释去泛化；跑绿 4 test + self-check + 我新增文件的 docs/class 守卫。
- **没做**：未在 desktop 或 superagent 的共享 patch 上启用任何行；未配生产 connections；未新增全局服务；未发任何消息；未 git add/commit；未重启生产 dsh/mobilegw；未改 runtime/index/KV/executor/sessions/mobile-http/push；未自建整套新 IM 只为关单。

## 八、当前状态一句话

**#21 仍 OPEN。** 台架（注册机制 + 闸门语义 + 持久化 + 拒绝不执行）已可复跑、待并入「真实 connector 到位后」的验收；真实账号/投递/真机审批记录均未发生，等你确认平台与凭据引用这一必需输入。
