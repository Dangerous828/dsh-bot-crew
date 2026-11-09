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

## APK 实跑：装上了，跑起来了，但模拟器连不上后端（2026-11-09）

APK 在 Android 15 模拟器（arm64-v8a）里**安装并运行成功**：

| 步骤 | 结果 |
| --- | --- |
| `adb install` | `Success`，包名 `com.labteto.dshmobile.debug` |
| 启动 | 正常，先弹通知权限，然后是连接页 |
| 界面渲染 | 连接页、网络提示、表单、错误诊断全部正常 |

连接页的**前置校验按设计工作**，值得记一笔：手机在 `10.0.2.x`，填 `192.168.31.127` 会被直接拒绝，
并说明「这地址不在本机网段，扫描也只会扫 10.0.2.x」。这不是 bug，是省掉一次四秒超时。

### 为什么模拟器当不了这个后端的客户端

后端必须绑**一个具体地址**（DSH 明确拒绝 `0.0.0.0`），生产时绑 `192.168.31.127`。
而模拟器到宿主的通路只有两条，都不通：

| 通路 | 结果 |
| --- | --- |
| `10.0.2.2:3082` | `Connection refused` — 它映射到宿主的 `127.0.0.1`，而后端不在那里监听 |
| `adb reverse` + `127.0.0.1:9082` | 隧道建成，信任围栏也放行了（补了 `--trusted-host 127.0.0.1:9082`，后端返回 401 而非断流），但长连接被断开：`unexpected end of stream` |

后端本身对 `Host: 127.0.0.1:9082` 的响应完全正常（`401` 未登录，正是应有行为），
所以这不是后端缺陷，是模拟器网络模型的限制。

**上面这个结论后来被推翻了**：模拟器其实连得上，见下一节。

## 手机 App 端到端跑通（2026-11-09 02:47）

上一条「模拟器连不上」的结论是错的。真正的障碍只有一个，而且是我自己填错了字段：

**连接页的地址框里，如果填的是完整 URL，URL 里的端口优先于右边那个 Port 字段。**
我填 `http://192.168.31.127` 时它去连 `:80`，所以一直 refused。填 `http://192.168.31.127:3082`
就对了。这条来自 `HostInput.kt` 的设计（「URL 里写的端口比残留的 Port 字段更明确」），是对的。

顺带确认了两件事：

- **带 scheme 的地址会跳过网段预检**（`input.useTls == null` 才检查），所以模拟器在 `10.0.2.x`
  也能连 `192.168.31.127`——它本来就 ping 得通，预检只是省掉一次超时，不是硬限制。
- 后端一直是对的：`192.168.31.127:3082 is a harness, but it has not signed this phone in`
  这句诊断准确指出了只差登录。

完整链路，全部在 Android 15 模拟器里用真实 APK 完成：

| 步骤 | 结果 |
| --- | --- |
| 连接 | `http://192.168.31.127:3082` + Port `3082` → 认出是 harness |
| 登录 | 粘 token → 进 App，直接看到主会话 |
| 进大臣 | 抽屉 → **Muse** → 标题 **`Bot crew · 3`**，绿点 Connected |
| Bot 芯片 | **大哥 Default**（选中）/ 写手 / 码农 |
| 换人 | 点「码农」→ 选中态从大哥移到码农 |
| 发消息 | 输入 → 发送 → 队列里出现这一条，`mentions=coder` |
| 署名 | 用户气泡右下 **`To 码农`**；回复上方 **`码农`**；背景任务 **Done** |
| 执行结果 | 码农回报「已建好：`/Users/cpuser/Desktop/crewphone`，内容 `hello`」 |
| 磁盘核对 | 文件真的存在，内容就是 `hello` |

芯片还有个长按：按住不放，下方显示这个 Bot 的职责——

> 写手：中文文案。克制，不堆词，先给一版再改。

截图在 `~/Desktop/dsh-crew/evidence/`。

### 断线与恢复

把后端停掉，App 标题下变成 **`Reconnecting…`**；`start` 回来之后自己回到 **`Connected`**，
不用手动重连、不用重登。

### 小插曲（不是缺陷）

用 `adb shell input text` 敲字时，空格、点号、斜杠会被吞，所以文件名从 `crew-phone.txt` 变成了
`crewphone`，Bot 照着它听到的做，这恰恰说明它是按真实输入干活的。

## 角色边界：提示词管不住，这一点得说清（2026-11-09）

试过让默认 Bot（大哥）遇到「写文案」这类活时退给写手。三轮实测：

| 提示词版本 | 结果 |
| --- | --- |
| 只说「说清楚归谁」 | 自己写了，没提写手 |
| 加「别自己做，指名让对方发过去」 | 一次说「这个得写手来写」，另一次仍自己写 |
| 再加「越界时必须自报身份」 | 仍然自己写，旁白却说「写手再给一句」——它以为在替写手说话 |

结论：**worker 的角色边界是提示词级的软约束，靠它保证不了。** 原因不难理解——每个 worker 都是一个
完整能力的会话，它确实**能**写文案，模型没有理由拒绝一个能做到的请求。

所以这一层不靠劝，靠两件已经成立的事：

1. **署名**：每条回复带 `bot_id`，界面上写明是谁说的（截图里 `码农` / `大哥` 就在气泡上方）。
   谁做的活一眼看得出来，不会被误认。
2. **换人权在人**：点一下芯片就换了收件人。这是这个设计里「转派」的正解——不是 AI 自己转，
   而是人看得见谁在答、随时指定。

## 自主转派：靠工具，不靠提示词

上面那条限制后来解决了，但解法不是把提示词写得更用力。试过三轮，每一轮的失败原因都不同，
值得记下来，因为下次很容易重蹈：

1. **写标记行**。约定 worker 在回复末尾写 `@handoff <bot>: <要做的事>`，宿主在正文发出前
   把它剥掉并开单。加了完整的中文示例、明确说了「不写这行就等于没人做」，模型仍然只顾着
   在正文里说「这句交给写手」，**没有一次真的写出那一行**。同一个模型能复述示例，但不会执行。
2. **改成工具**。给 worker 一个 `orchestrator_handoff({ bot_id, text })`，`bot_id` 用枚举
   限定只能选同队其他 Bot。这一次模型会调了。
3. **调了也开不出单**。连续踩两个坑，都只能从 decision 的 reason 代码看出来：
   - `not_human`：我把转派标成机器发言，引擎直接忽略；
   - `not_a_member`：`actor` 用了自己编的 `handoff`，不在 Policy 名单里。
   改成 `human: true` + 从原工单 `mandate.actor` 取人，才真正开单。
4. **开单了但署名错**。复用了原消息的 thread 和 message id，intake 把它并回原工单，
   回复仍签成第一个 Bot。改成独立 thread + 独立 message id。

**还有一个必须做对的收尾**：转派开的工单在另一个 Bot 名下、走私有线程，成品落在那儿，
提问的人只看到「已交给写手」。要在工单结束时把报告发回**人的原消息**上——注意不能取
`handoff_of`（那是 Bot 的回复 id），要一路回溯到人发的那条。

结论：**worker 能不能自主转派，取决于宿主给不给它工具，以及那条工单在账本里是否被当成人的请求**。
提示词只能影响它想不想转，决定不了转派是否成立。
