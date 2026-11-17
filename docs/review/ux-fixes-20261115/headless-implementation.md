# dsh-superagent no-Web 实施与隔离验收

## 实施结果

`dsh-bridge/up.sh --no-web` 在保留 `dsh-web-app` 的 host 服务、`connection`、移动端 API、provider/MCP、scheduler、session 与 worker 的情况下，关闭 `webserver`、`web-runtime`、`modules`、`client-hmr`，以及依赖 Web 服务的三个插件：`open-in-app`、`directory-picker`、`harness-dev-context`。隔离启动显示的三项 pending 都来自上述 Web 依赖，因此直接关闭这三项纯 Web 插件；没有恢复 Web host 服务。

无 Web health listener 仅绑定 `127.0.0.1` 的临时端口，描述文件写入 profile 的 `stateDir/headless-health.json` 并设为 `0600`。CLI 校验 profile、PID、stateDir 与 endpoint 后访问该地址；状态保留 `load`、`paused`。服务启动脚本按 profile 的实际 bundle dependency 与 `dsh.profile.bundles` 判断是否安装，避免被 `dsh plugin why` 的全局成功结果误判。

## 隔离 profile 实测

测试环境：`DSH_HOME=/tmp/dsh-headless-profile-no-web-20261116`，profile `no-web-probe`。执行命令：

```sh
DSH_HOME=/tmp/dsh-headless-profile-no-web-20261116 \
DSH_SUPERAGENT_PROFILE=no-web-probe \
./dsh-bridge/up.sh --profile no-web-probe --no-web --restart
```

输出的 health 地址为 `http://127.0.0.1:58238/orchestrator/api/state`，PID 为 `7490`，mode 为 `no-web`。用下列请求读取状态，返回 HTTP 200：

```sh
curl -sS -H 'x-orchestrator-request: 1' \
  http://127.0.0.1:58238/orchestrator/api/state
```

实时状态：`relay`、`notice`、`memory`、`launch`、`delivery`、`assessment`、`reply`、`evals`、`p2p` 均为 `ready`；`runtime`、`github`、`team` 为 `paused`。唯一 setup 项是 GitHub Source 未配置仓库：`repositoryUnset` / `The GitHub Source names no repository.`；`errors={}`，`load={running:0, queued:0, maxWorkers:3}`，`paused=false`。因此启动命令以状态码 `3` 返回 setup pending，同时打印实际 health 地址；backend 仍在运行。该未配置项只存在于隔离 profile。

PID `7490` 的 TCP listener 快照包含 headless health `127.0.0.1:58238`，以及保留的 P2P host listener `:27625`（本机 LAN/VPN 接口）；该进程没有监听 Web 端口 `3082` 或 `9082`。隔离进程已通过 profile-aware `dsh-superagent stop` 停止。

此隔离 profile 因 `repositoryUnset` 返回状态码 3，因此本次没有触发仅在状态码 0 时运行的 `ensure_gateway`；本验收覆盖了 headless health 与 P2P listener，未启动一份新的 mobile gateway。生产 profile 的既有 gateway 未触碰，受控切换时需由 lead 核对其 LAN 端口仍可用。

首次 no-Web 探测曾观测到的三项 Web pending 及处理决定：

| 插件 | 观测到的依赖 | 决定 |
| --- | --- | --- |
| `open-in-app` | `webServer` | no-Web profile 禁用 |
| `directory-picker` | `webServer` | no-Web profile 禁用 |
| `harness-dev-context` | `webApp` | no-Web profile 禁用 |

隔离启动日志还记录一次 Bonjour service name 重复；该探测与现有 profile 共用 LAN multicast。P2P health 仍为 ready，health endpoint 可读。生产切换后由 lead 在旧 profile 停止后复核。

## 迁移命令

```sh
cd backend && pnpm build
cd .. && ./dsh-bridge/up.sh --profile superagent --no-web --restart
```

旧 `tools/loopproxy` 不由 no-Web stop 管理；迁移后需一次性检查 `127.0.0.1:3082`。先用 `lsof -nP -iTCP:3082 -sTCP:LISTEN` 找 PID，再用 `ps -p <PID> -o pid=,args=` 核对命令行确实包含本仓库 `tools/loopproxy` 与当前 profile 的原 LAN 地址；仅该 PID 可执行 `kill -TERM <PID>`，之后再次运行 `lsof` 确认 3082 无监听。其他 profile 或监听进程保持原样。

## 验收

- `pnpm build`：通过。
- `pnpm exec vitest run tests/docs.spec.ts`：6/6 通过。
- `pnpm exec vitest run tests/service-script.spec.ts`：15/15 通过。setup-pending 场景显式断言被识别的临时 PID 不会被 start 误停；afterEach 只清理本测试 `sleeper()` 创建并持有的子进程。
- `pnpm exec vitest run tests/headless-http.spec.ts`：2/2 通过，包含 loopback health、descriptor 权限/清理、保留字段与 listen 回调前 dispose。
- `bash -n dsh-bridge/up.sh` 与 `python3 -m py_compile backend/scripts/dsh-superagent`：通过。
