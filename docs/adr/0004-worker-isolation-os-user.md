# Worker 执行面用独立 OS 用户隔离（+ 最小权限工具）

## 背景

`backend/src/infra/environment.ts:4` 自己写着：worker 的护栏是「default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user」。`runAsWorker`（同文件 `:128`）走 `subprocess.spawn`，没有 uid/gid 切换、没有容器、没有 namespace —— worker 的 bash / git / 文件读写全部继承操作者的 OS 用户权限。

后果（gap 3）：agent 一旦被提示注入、或被上游原型牵着乱跑，就能 `cat ~/.ssh/id_ed25519`、读别的 ticket 目录、翻操作者 `~/.config`。审批闸只约束「经过工具层的外部写」，不防「worker 直接读文件」。

这是接真账号、扩行动面（第 7 步）之前的硬前提。看门狗（#8）已收口——隔离后出问题也有人报警；审批闸已接进执行路径，可复用。

## 决策

**采用 A（独立 OS 用户）为主，叠加 C（最小权限工具）为辅。** 具体：

1. worker 进程以专用低权限账号运行，而不是操作者账号。macOS 本机用 `sudo -u <worker-user>`（或 subprocess 层带 uid/gid）启动 worker 子进程，使其**只**对「本 ticket 执行目录」有读写，读不到宿主 `~/.ssh`、`~/.config`、别的 ticket 目录。
2. worker 拿到的工具集收到最小（C）：只读 git + 指定工作目录写入为主，任意 bash / 任意文件读默认关或经审批。
3. 记忆不走 worker 的文件系统：记忆账本已在 `host.store`（SQLite），worker 进程不持有明文记忆库路径。

## 为什么不选 B（容器 / sandbox-exec）打头

- **容器**（docker/nsjail）：隔离最强，但引入 daemon 依赖、镜像分发、卷挂载配置，代价与本机「给技术 owner 在 Mac 上自用」的定位不匹配；先做成一次性成本低、可逆的方案，容器作为将来「上公网多租户」时的升级路径。
- **`sandbox-exec` profile**：macOS 上可用，但 profile 语法脆弱、随系统版本漂移，且只限文件/网络白名单，不管进程身份。可作为 A 的补充（约束 worker 只能写执行目录），但不作为唯一的身份边界。

## 为什么 A+C 够用

- **够挡住 gap 3 描述的实测症状**：worker 读别的记忆文件、读操作者凭据——独立用户 + 目录权限就挡住。
- **可逆、零外部依赖**：建一个系统用户即可；不想要了删用户。不改进程模型（backend 仍在 dsh 进程里，见 ADR 0001）。
- **与审批闸叠加**：身份隔离挡「读」，审批闸挡「经过工具层的外部写」，两者互补不重叠。

## Consequences

- 需要一个 worker 系统用户，且 `stateDir` / 执行根目录 / git credential 的属主要让这个用户能读写——启动时要检查并（必要时）报错指引，不擅自改系统权限。
- `runAsWorker` 的调用点要统一带身份切换；不能在某个分支漏掉（漏一个就是裸奔）。
- 测试里要能造「恶意 worker」用例：`cat ~/.ssh/id_ed25519` 失败、读别的 ticket 目录失败、读自己目录成功。
- 将来要上公网多租户，这条 ADR 需重新审视——那时 B（容器）成为主方案。
- 跨平台：Linux 同理（独立用户 + 目录权限）；Windows 另议（本机是 macOS）。

## 落地顺序（对应 #9 五项）

1. 本 ADR（定方案）。
2. 执行面隔离落地：`runAsWorker` / subprocess 层带身份切换；恶意 worker 用例。
3. 记忆落盘收口：确认 worker 拿不到明文记忆库。
4. 审批闸与隔离衔接：隔离环境下外部写仍 ask。
5. 重验全部流程：三端测试 + 真机一条活 + `doctor.sh`。
