# task-2 review-ready：内部 desktop/mobile 消息 adapter（wb2-client-messages）

日期：2026-11-14 · 角色：`wb2-client-messages`（子委派 task-2，claim rev6） · **全部改动未提交（无 git add/commit/push）**

---

## 一、结论一句话

把上一版「本地 JSON 信箱台架」重写为**接真实 `mobileq.db` 的产品 adapter**：worker/adapter 读真实客户端会话、写回复落 `replies` 表（server→client，桌面/手机聊天可见）、写不碰 `messages`（不触发 worker 自循环）；读放行/写审批仍走宿主真实 `connections.ts` + `runtime.guardConnection`。8 例新集成测试 + 53 例回归绿，全部跑在**真实 sqlite + 真 `mobileq` CLI** 上。生产 profile 注册/重启留 root。

## 二、改动清单（review diff 面）

| 文件 | 变更 | 归属 |
|---|---|---|
| `backend/src/integrations/messages-mcp/server.ts` | 重写：MCP stdio server，store = 真实 `mobileq.db`（`MESSAGES_MCP_DB`，无默认 JSON）；工具 `list_channels`/`list_messages`/`get_message`(读) + `send_message`(→`mobileq reply` 落 replies)。**非** JSON 台架 | 我的 writeScope `backend/src/integrations` |
| `backend/src/integrations/messages-mcp/messages-mcp` | 入口注释同步真实队列用法 | 同上 |
| `backend/tools/mobileq` | +`conversations`/`timeline` 两条子命令（只读/合并视图，同 `/api/mobile/timeline`）；**根治** subparser `--db` 覆盖 top-level 的老 bug（`argparse.SUPPRESS`）。既有 reply/pull/thread/outbox 行为不变 | 为真实读会话必需的**工具层**最小改动 |
| `backend/tests/integrations/messages-mcp.spec.ts` | 真实 mobileq.db e2e（6 例） | my scope `backend/tests/integrations` |
| `backend/tests/integrations/internal-messages-e2e.spec.ts` | 真 `Outbox→sendMobile→CLI→db` 投递链（2 例） | 同上 |
| `backend/docs/007-architecture.md` | 模块表/测试表两条改为真实 adapter | 文档守卫 |
| `docs/review/phase2-integration/2026-11-14-internal-messages-adapter-design.md` | 薄 Interface 设计 + 落地结果 | my scope `docs/review/phase2-integration` |

**未碰**：`runtime.ts`/`index.ts`/`kv.ts`/`mobile-http.ts`/`push.ts`（wb2-receive 独占）、`sources/*` 入队、生产 profile、生产进程。

## 三、真实产品存储验证（全部绿，本机 python3/sqlite3/真 CLI）

```
$ MESSAGES_MCP_DB=~/.dsh/state/superagent/mobileq.db node .../server.ts --self-check
initialize: OK ; tools: list_channels,list_messages,get_message,send_message ; list_channels: 3 conversations (main/work/team) ; PASS
```
- **读真实会话**：adapter 读真实状态库 `main(58)/work(9)/team(1)`；真 `inject` canary → `list_messages` 读回。
- **写回复落 replies + 客户端可见**：`send_message`/`Outbox→sendMobile` 落真 `replies` 行（= `/api/mobile/timeline` 那一条），receipt 结算 `sent`；同 `rkey` 幂等不重发。
- **拒后真不新增**：审批判 ask 且无批准不调 send_message → `replies` 条数不变；source off → 停 outbox、db 不写。
- **不触发 worker 自循环**：写 reply 前后 `messages WHERE read_at IS NULL` 条数不变（只写 replies，不写 messages）。
- **闸门**：`allowedTools/judgeCall` 对 `mcp__messages__*` 读 allow / 写 ask（readOnly）。
- 真实库无测试残留（replies 49 / max 52 / messages 68，与基线一致）。

## 四、复用既有生产逻辑（未重复实现，复跑绿）

审批「批准只执行一次 / 改参数重问 / 改配置吊销 / 子 agent 同闸」= 真 `Runtime.guardConnection`，由 `tests/runtime.spec.ts` 的 `live MCP connection gate`（4 例）覆盖并复跑绿；adapter 工具名走同一 `mcp__<server>__` 前缀匹配。

## 五、与 wb2-receive 冻结（已双向确认）

- 方向 = server→client reply；会话面 `replies`（写回复）vs 通知面 `pushOutbox/notices`（横幅），两面不互相冒充。
- 写会话面回复 = 既有 `sendMobile`/`mobileq reply`，**不需 receive 加 backend 入口**；我要横幅 → receive 已同意在 `Notice.kind` union 加 `'internal'`（它加，我可选调用）。
- 禁令遵守：不 import sources/team 入队、不写 messages（只 replies）、不产 Trigger。

## 六、未做 / 需 root（部署侧收口）

- 未注册进**生产 superagent profile**（当前零 `dsh-mcp-client` 行）：registration hunk（示例见 bench 文档 §5.2）待 root 统一 review 后落；未配生产 `connections`；未重启 dsh/mobilegw。
- 真实手机/桌面 GUI 人工点按验收需部署后进行。
- 未跑全量 `/build`/部署（root 统一）；未并发 vitest；未 git 提交。

## 七、测试命令与结果

```
cd backend
npx vitest run tests/integrations/ tests/team.spec.ts tests/source-session-admission.spec.ts tests/mobile-work.spec.ts tests/mobile-read.spec.ts
→ 6 files, 53 passed
npx vitest run tests/runtime.spec.ts -t "live MCP connection gate"   → 4 passed
python3 -m pytest backend/tools/test_mobile_transport.py             → 29 passed
npx tsc -p tsconfig.json --noEmit  （我新增文件无错误；剩余为 wb2-worker-files 未入 docs 表，非我范围）
```

---

# 冻结交接（给 review 成员 wb2-messages-review｜源码已冻结，不启生产）

**冻结状态**：以下文件源码冻结，本轮不再改（除 review 要求的修复）。**全部未提交**。

## 源码 SHA256（review 对照基线）

```
dc49de383448303b00df2c9dbe0c1412c84c270726f0e48ee5c926eae58b43fe  backend/src/integrations/messages-mcp/server.ts
5a3a62d0532a0d0eedfe08591b85328f98db5a4e44546b1498689f0c45df67ea  backend/src/integrations/messages-mcp/messages-mcp
d44e038d6c265070eb1608c41a3fdf7c5b8ec02e8f222c79f2b68495d94309ac  backend/tools/mobileq
233789215f01aeb5ca09d4a7c6f1715a680600980798ea4e2eedb7d2abb2b480  backend/tests/integrations/messages-mcp.spec.ts
137122fe25331b87a54667f517cdc31417abc28d6746e7a50f8888bb4a9478a5  backend/tests/integrations/internal-messages-e2e.spec.ts
```

## superagent 精确注册 hunk（待 review；**不直接写 desktop profile**）

superagent profile（`~/.dsh/profiles/superagent/cordis.patch.yml`，顶层 YAML 数组）追加的 **insert** 条目（示例，`MESSAGES_MCP_DB` 指向真实 superagent db）：

```yaml
- insert:
    - id: mcp-messages
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: messages                         # → 工具名 mcp__messages__<tool>
        command: /Users/cpuser/Code/dsh-bot-crew/backend/src/integrations/messages-mcp/messages-mcp
        args: []
        env:
          # = superagent stateDir 下的真实队列；必须与 backend config stateDir 同一库
          MESSAGES_MCP_DB: /Users/cpuser/.dsh/state/superagent/mobileq.db
          MESSAGES_MCP_CLI: /Users/cpuser/Code/dsh-bot-crew/backend/tools/mobileq
        toolCallTimeoutMs: 60000
```

- 注册落 **superagent** profile（当前零 `dsh-mcp-client` 行）；**不写 desktop profile**。
- `MESSAGES_MCP_DB` 必须等于 superagent `stateDir/superagent/mobileq.db`（`backend/scripts/dsh-superagent` 的 stateDir；见 `~/.dsh/profiles/superagent` 的 `dsh-superagent.config.stateDir=/Users/cpuser/.dsh/state/superagent`）。

## 生产 connections 精确示例（面板写入；readOnly 保持 true，读写两列显式写全）

```json
{
  "readOnly": true,
  "connections": [
    {
      "kind": "messages",
      "server": "messages",
      "readTools": ["list_channels", "list_messages", "get_message"],
      "writeTools": ["send_message"]
    }
  ]
}
```

> 注意（#21 前置文档已记）：**声明了任一工具后内置读白名单整批失效**——读三件也必须在 `readTools` 里显式列出，否则读工具反而拿不到；写工具必须显式进 `writeTools`，否则候选工具都生成不出。

## mobileq `--db` 修复的兼容性保证（已验证）

- `db_path(args)` 逻辑**一字未改**：优先级 `--db` 显式 > `$DSH_HOME/state/superagent/mobileq.db` > `~/.dsh/...`。
- 修复只把各 subparser 的 `--db` 默认值由 `None` 改为 `argparse.SUPPRESS`，使其不再覆盖 top-level `--db`；**两种位置**（`mobileq --db X <cmd>` 与 `mobileq <cmd> --db X`）都可用，语义一致。
- 只新增 `timeline`/`conversations` 两个**只读**子命令，**未新增任何任意 path/command/写工具**。
- 传输回归：`python3 -m pytest backend/tools/test_mobile_transport.py` 29 passed；`tests/team.spec.ts`、`source-session-admission.spec.ts` 绿。

## 只读 canary 脚本（已备，不触主 app/OS 焦点）

`docs/review/phase2-integration/messages-canary.sh`：
- 默认**只读**：读真实会话 + 打印 judgeCall（读 allow/写 ask）+ adapter self-check，**不写任何东西**。
- `--write --db <临时库>`：隔离库演练（0→1 replies），**拒绝以生产库为写目标**（rc=3）。
- 生产真写验证 = release 窗口由**人工在 app 点批准/拒绝**，本脚本只做前后只读比对。运行时不抢焦点、不发桌面输入。

## 仍需 release 窗口做（真实 worker 触发，本轮未做）

1. 真 worker 在 superagent 宿主里调用 `mcp__messages__send_message` → 触发 `connection` 审批；2. 人工批准 → 同一调用只执行一次 → 真 `replies` 行 + 客户端聊天可见；3. 再发一条 → 拒绝 → `replies` 零新增。这三条要在**真机 + 真连接 + 点按**上过，才是端到端收口。当前真实库自测只证明「存储/产品 library 层」。
