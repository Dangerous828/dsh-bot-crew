# 04 · 已经验证到什么程度

日期：2026-11-09

| 项 | 结果 |
| --- | --- |
| 契约纯逻辑（本仓库） | `tsc --noEmit` 0 错；20 个测试通过（Bot 目录校验、@ 路由、记忆渲染与路径、注入规则） |
| 宿主 `team.ts` 路由 | 10 个测试通过：成员 @ → 该成员、群里无人 @ → 大哥、私聊 → direct、未知 @ 记录后仍归大哥、Bot 回声丢弃、话题串 `conv:msg` / `conv:thread` |
| 环境注入 | `DSH_SUPERAGENT_CREW_{BOT,PERSONA,MEMORY,CONVERSATION}` 取值正确；非 team 来源的工单取空 |
| worker 提示词 | `## Bot you are` 只在 team 来源出现；无 crew 时提示词逐字节不变 |
| 宿主全量回归 | 1213 个测试通过，`tsdown` 构建通过 |
| `mobileq` | 新 `--mention` 与旧 `--mentions-me` 并存；`reply` 仍按 key 幂等；`thread` 含 Bot 回话 |

## 端到端（2026-11-09 实测）

| 步骤 | 证据 |
| --- | --- |
| 队列消息进来 | Source 统计 `received` 递增，游标推进 |
| 授权通过 | 线程 `evaluating.strength = explicit`，`actor = {source: team, id: owner}` |
| Eval 决策 | 主 Session 调 `orchestrator_route`，寒暄判 ignore、真活判 accept |
| 开单 | `GET /orchestrator/api/tickets` 出现 open 工单 |
| worker 执行 | 桌面真的出现 `crew-test.txt`，内容 `hello from crew` |
| 回话落队列 | 两段（acknowledgement + reply），`bot_id: lead` |
| worker 拿到 Bot 身份 | 提示词含 `## Bot you are`、人格、`bot/lead`；环境变量四个都对 |
| @ 路由 | `--mention scribbler` → 工单 `address.bot_id = scribbler`，回话 `bot_id = scribbler` |
| 手机 API | `GET /api/mobile/timeline` 返回 `bots` 三个、`default_bot_id = lead` |

## 一个真实踩到的坑（值得记）

宿主默认模型指向 `magpie/qoder-cn/dfmodel`，而该 profile 里定义的是 `qoder/dfmodel`。**症状不是报错，是 Eval 永远停在 `evaluating`**：消息进来了、游标走了、`evalId` 有了，但既不超时也不产出决策。根因在主 Session 的 `turn/end` 里：

```
{"kind": "error", "error": {"message": "pi-ai provider \"magpie\" has no configured model \"qoder-cn/dfmodel\"", "code": "UNKNOWN_MODEL"}}
```

必须同时做两件事才会好：把默认模型改成真实存在的，**并且**给 `eval.model` / `executor.model` 显式写死——因为旧 Session 会持久化 `request/header`，只改配置不换 Session 会继续用旧模型。

## 还没验证

- 记忆落盘与 Hub 上行：适配层是纯函数 + 计划对象，真正的原子写与 `recall` 由宿主实现，尚未接。
- 前台还没做 Tobs 那套多会话/群组视图；现在是「一个对话 + 一排 Bot 芯片」。
- 真机安装：本机没有连着的设备，APK 只做了构建验证。

## 手机走局域网（2026-11-09）

后端默认只绑 `127.0.0.1`，手机连不上。改成绑本机局域网地址后，手机可以直连：

| 项 | 结果 |
| --- | --- |
| 绑定 | `host: 192.168.31.127`，监听在该地址 |
| 登录 | `?token=` 换到的 cookie authority 是 `192.168.31.127:3082`，与访问地址一致 |
| `/api/mobile/timeline` | 返回三个 Bot 与 `default_bot_id` |
| `/api/mobile/send` + `mentions` | `@写手` → `scribbler`，`@码农` → `coder`，无人 @ → `lead` |
| 管理 API 从局域网 | **403**，`sameOrigin` 只认 `127.0.0.1` 的 Host |

### 绑定非 loopback 时的两处坑

1. **`host: 0.0.0.0` 会被拒绝。** DSH 的 webserver 明确不允许通配地址（`binding every interface would expose remote code execution to the network`），必须写一个具体的本机地址。
2. **原来的 `registerHttp` 断言绑定必须是 loopback**，一旦改绑定，整个 `dsh-superagent` 插件启动失败——连带 `team` / `github` 都 `pending`，而 `/api/mobile` 也一起没了（因为它在同一个插件的 `apply` 里注册）。那条断言已改为按请求校验：`sameOrigin` 只接受 `Host: 127.0.0.1:<port>`，所以绑定地址放宽不影响管理面的保护强度。

对应的测试也从「绑定必须是 loopback」改成「绑在局域网地址上时，局域网来的管理请求仍是 403，本机面板仍可用」——这才是真正要守的性质。

## 团队意识与署名（2026-11-09）

worker 现在知道自己在一个队伍里，而不只是一个孤立的人格：

```
The rest of the crew is scribbler=写手, coder=码农. Say plainly when something belongs
to one of them rather than answering as if it were yours; you cannot speak for them and
their memory is not yours to read.
```

实测问「队里还有谁」，大哥答「就两位：写手和码农」。这条信息来自新增的环境变量 `DSH_SUPERAGENT_CREW_TEAM`，内容是**除自己以外**的 `id=名字` 列表。

## 署名打通到手机

`mobilegw` 的 timeline 原来不带 `bot_id`（只有 `mobileq` 的 `thread`/`outbox` 带），所以手机拿到的时间线里所有回复都显示不出是谁说的。补上之后：

| 条目 | 内容 |
| --- | --- |
| `r24` | `bot_id=coder` — 码农说的 |
| `r25` | `bot_id=lead` — 大哥说的 |
| `m21` | `mentions=[scribbler]` — 发给了写手 |
| `m22` | `mentions=[]` — 没指名，大哥接 |

## 客户端契约对齐

用 Kotlin 客户端产出的精确请求体对运行中的后端做了验证：

| 请求体 | 结果 |
| --- | --- |
| `{text, request_id, mentions:["scribbler"]}` | 200，落库，工单归 `scribbler` |
| `{text, request_id}`（无 `mentions` 字段） | 200，工单归 `lead` |

手机端 `MuseClient.send` 只在有人被 @ 时才写 `mentions` 字段，与后端「缺省即无人被 @」的语义一致。

## 一条命令配好 / 一条命令自检（2026-11-09）

```sh
python3 scripts/configure.py   # 写名录、Policy、钉死角色模型；幂等
./scripts/doctor.sh            # 只读检查全链路
```

`doctor.sh` 的实际输出：

```
orchestrator :3082                         node pid 91664
mobile gateway :8788                       Python pid 9317
  crew Source  ready     0 messages, 0 unreadable
eval model                                 {"provider": "magpie", "model": "openconsole/deepseek-v4.1-flash"}
executor model                             {"provider": "magpie", "model": "openconsole/deepseek-v4.1-flash"}
crew roster                                3 bots (lead=大哥, scribbler=写手, coder=码农), default lead

crew path looks healthy
```

两个脚本都踩到同一个坑并已修好：**后端绑在局域网地址时，loopback 根本连不上**。所以脚本先探测本机所有 IPv4，选那个真正应答的。`doctor.sh` 读 roster 走的是手机时间线，因为它验证的是「手机实际拿到什么」，而不是「数据库里写了什么」。

## Bot 芯片能解释自己

名录现在带 `persona`，手机端长按芯片在下方显示这个 Bot 负责什么：

```
lead       大哥   [default] 简练，先应一声再决定。能转派就转派，拿不准就先问一句。
scribbler  写手   [member ] 中文文案。克制，不堆词，先给一版再改。
coder      码农   [member ] 写代码先看现有约定，改动小步、可回退，交付前自己跑一遍验证。
```

Material3 的 `Surface` 没有 `onLongClick`，用 `combinedClickable` 补的（需要 `@OptIn(ExperimentalFoundationApi)`）。
