# dsh-bridge

这一块**不是插件工程**。它是 dsh 侧的装配说明：让一个 dsh profile 装得上 `backend/`，跑得起来，并且知道去哪儿看它。

为什么不把桥做成一个独立插件，见 [ADR-0001](../docs/adr/0001-backend-stays-in-dsh-process.md)。

## 这里有什么

| 文件 | 作用 |
| --- | --- |
| `profile.example.yml` | 拷进 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的样板 |
| `up.sh` | 一条命令：装 bundle、起 backend、起 gateway、报地址 |

## 这里没有什么

- 没有 worker / router 两个 preset 的定义。它们在 `backend/cordis.patch.yml` 里，是 bundle 的一部分——preset 是给 backend 的 Session 用的，搬走 backend 就找不到它们。
- 没有进程管理。起停在 `backend/scripts/dsh-superagent`，那是 backend 自己的事。
- 没有一行 TypeScript。

## 装一次

```sh
./up.sh --profile crew
```

它会做四件事，每一步失败都直接停下并说明原因：

1. 检查 `~/.dsh/profiles/crew` 是否存在，不存在就按 Web 模板建一个。
2. 把 `backend/` 以 `link:` 方式装进这个 profile。
3. 把 `profile.example.yml` 里填好绝对路径的配置写进 profile 的 `cordis.patch.yml`（已有内容不覆盖，冲突就报错）。
4. 起 backend，等它就绪，打印面板地址与 gateway token 的位置。

## No-Web profile

新建无 Web profile：

```sh
./dsh-bridge/up.sh --profile superagent --no-web
```

迁移现有 profile 时，先确认 worker/Executor 空闲并备份 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，再构建并优雅重启：

```sh
cd backend && pnpm build
cd .. && ./dsh-bridge/up.sh --profile superagent --no-web --restart
```

`up.sh` 保留 `dsh-web-app` 的 host 服务，在该 profile 里禁用 `webserver`、`web-runtime`、`modules`、`client-hmr`、`open-in-app`、`directory-picker` 和 `harness-dev-context`。`connection`、移动端 LAN API、provider/MCP、scheduler、session 与 worker 服务继续加载。无 Web health 地址写入该 profile 的 `stateDir/headless-health.json`，权限为 `0600`；`dsh-superagent status` 从描述文件验证 profile、PID 和 stateDir 后连接 loopback 地址，并报告 health、load 与 paused。setup 未完成时，脚本打印 health 地址并以状态码 3 返回。

旧 `tools/loopproxy` 不由 no-Web 停止逻辑接管；迁移后一次性检查 `127.0.0.1:3082`。只有 PID 的命令行同时指向本仓库的 `tools/loopproxy` 和当前 profile 原 LAN 地址时才向该 PID 发 `SIGTERM`，随后再次用 `lsof` 确认 3082 无监听：

```sh
lsof -nP -iTCP:3082 -sTCP:LISTEN
ps -p <PID> -o pid=,args=
kill -TERM <PID>
lsof -nP -iTCP:3082 -sTCP:LISTEN
```

先把 `<PID>` 替换为 `lsof` 输出的 PID，并核对 `ps` 命令行；其他监听进程保留。

检查启动结果：

```sh
backend/scripts/dsh-superagent --profile superagent status
```

无 Web 模式不提供面板与客户端热更新；修改 backend 后执行 `pnpm build` 并重启 profile。若状态显示 setup pending，在 profile/provider 配置中补全设置后重启。

## 起停

```sh
backend/scripts/dsh-superagent --profile crew start
backend/scripts/dsh-superagent --profile crew status
backend/scripts/dsh-superagent --profile crew stop
```

`status` 退出码：0 正常、1 需要重启、2 某个部件出错但重启无用、3 等人工配置。脚本原样透传，便于写进定时检查。

## 两个 preset 为什么在 backend 里

`dsh-superagent-worker` 和 `dsh-superagent-router` 定义在 `backend/cordis.patch.yml`。它们约束 backend 创建的 Session 能用哪些工具：worker 只干活的工具，router 只路由的工具。backend 在 `backend/src/app/sessions.ts` 里按 id 引用它们，preset 和代码必须同一个包，否则 backend 装上了、preset 不在，Session 就建不出来。
