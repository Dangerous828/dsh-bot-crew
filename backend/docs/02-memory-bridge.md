# 记忆桥：本地账本与中枢 Hub 的分流

`src/memory/adapter.ts` 的头注释指向这份文件。它要说清三件事：记忆存在哪、什么时候写、什么时候读；
以及**为什么本地不向 Hub 上行**。

## 一、两份记忆，各管一段

| | 本地记忆账本（本仓库） | 中枢 Hub（`local_dream`） |
|---|---|---|
| 谁写 | `MemoryLayer`（`src/app/memory-layer.ts`） | 用户的 `local_dream` 守护进程，扫会话 transcripts |
| 存哪 | `stateDir/orchestrator.sqlite` 的 KV，`memory:entry:` 一族 | 中枢向量库 |
| 粒度 | 一条 = 一句能被复述的事实 | 一整段会话摘要 |
| 谁读 | worker 开工时的 `DshExecutor.launch` | 用户的各个 Agent（`hub_memory_*` 工具） |
| 出本机吗 | **不出** | 出（上行到中枢） |

两者正交：本地账本给**这支队伍**在干活时补上下文，Hub 给**用户**跨工具找历史。同一件事不会被蒸馏两遍，
因为它们取的东西不同（本仓库取「定下来的事」，`local_dream` 取整段对话）。

## 二、写：只写记得住的

三个入口，都在 `src/app/memory-layer.ts`：

1. `hear(trigger)` —— 人说的话命中「定下来的规矩」句式时记一条（`src/memory/settle.ts` 的 `factOfPersonMessage`）。
2. `close(ticket)` —— 工单以 `ready` / `dropped` 收尾时记结论（`factOfFinishedTicket`）。
3. （预留）某个 Source 自己的结论。挂点只有一个：`Runtime` 里 `Engine.emit` 的那一处，不在别处再接。

**不写**：原始对话、`progress` / `waiting` 这类过程态、模型自己说的废话。
账本一脏，下次召回全是噪声，比没有记忆更糟。

去重：`dedupe_key` 是这件事的身份，同一键且正文没变就什么都不做（重试安全）。
同键正文变了 → 写新条，旧条翻 `superseded`。

## 三、读：一小片，不是一段历史

`recall(ticket, query)`：

1. 中文二元组相关度（`grams`）在 `name + description + body` 上打分；
2. 乘上新鲜度（`freshness`，30 天半衰）与 `importance` 的轻权重；
3. 只留 `state: active`；先在**这位 Bot** 的命名空间里找，不够再放宽到全队；
4. `compose` 按 `maxChars = 1200` 拼段，**放不下的整条丢掉，绝不截半句**；
5. `injectText` 包一句「这不是这次的要求，只用来补上下文」。

`DshExecutor.launch` 把这段接在开工那句话后面；召回抛错时返回空串，**不挡开工**。
每次召回打一行 `[memory] recall bot=… chars=… taken=[…]`，取舍可见。

## 四、为什么不上 Hub

用户已经有一份上行链路（`local_dream` 的 `dsh_memory` 直通源）。本地账本再上行一次 = 同一件事在中枢出现两条，
而且两条的写法还不一样，召回时互相顶。所以：**本地提炼的一条都 `to_hub: false`**，
`MemoryRecord.toHub` 这个字段留着，是为了将来真有需要时（比如某条用户明确要求跨工具可见）能单条打开，
而不是现在默认打开。

## 五、落盘格式

`src/memory/adapter.ts` 的 `renderMarkdown` 按插件 1.3.0 的 frontmatter 渲染，字段顺序固定便于 diff。
它拒绝多行 `description` 与空正文 —— 多行 YAML 曾在桥接解析里丢过。

路径：`<rootDir>/bot/<botId>/<name>.md`。`rootDir` 由运行时给（默认 `stateDir/memory`），
不写死任何本机绝对路径。

> 当前实现把账本存在 SQLite 的 KV 里，`plan` / `render` 是给「将来真要把 md 落盘」准备的路。
> 两者不冲突：KV 是读写的真相源，md 是给插件格式消费的导出。
