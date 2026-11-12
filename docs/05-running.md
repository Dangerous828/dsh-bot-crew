# 05 · 跑起来

## 一、后端

```sh
cd backend
./node_modules/.bin/tsdown                 # 构建到 lib/
../dsh-bridge/up.sh --profile crew          # 装 + 起，报地址；等价于下面两条手工步骤
python3 backend/scripts/dsh-superagent start    # 起在 127.0.0.1:3082
python3 backend/scripts/dsh-superagent status   # 看健康
```

健康项里应出现 `"team": "ready"`。

## 二、网关

手机不直连 3082，走 `/api/mobile/*` → `mobilegw`（8788）→ `mobileq` 队列：

```sh
cd backend
nohup python3 tools/mobilegw > .artifacts/mobilegw.log 2>&1 &
curl -s http://127.0.0.1:8788/health    # {"ok": true}
```

## 三、Bot 名录（一条命令）

```sh
cd ~/Code/dsh-bot-crew && python3 scripts/configure.py
```

脚本会自己找到后端（loopback 或本机局域网地址都试）、写好名录与 Policy、把 `eval` / `executor`
的模型钉死，遇到 revision 冲突自动重试。改名册或改模型就改脚本里的常量再跑一遍——它是幂等的。

手动做的版本在下面，理解了再改脚本：

存在后端 settings 的 `source:team` 块里，通过管理 API 写入（要带同源头）：

```sh
H='-H Host:127.0.0.1:3082 -H x-orchestrator-request:1 -H Content-Type:application/json'
curl -s -X PUT $H http://127.0.0.1:3082/orchestrator/api/settings/source:team -d '{
  "value": {"enabled": true, "config": {
    "default_bot_id": "lead",
    "bots": [
      {"bot_id":"lead","name":"大哥","role":"default","persona":"…","memory_namespace":"bot/lead"},
      {"bot_id":"scribbler","name":"写手","role":"member","persona":"…","memory_namespace":"bot/scribbler"}
    ],
    "conversations": [{"id":"main","listen":"all","direct":false}],
    "pollSeconds": 3
  }},
  "revision": 0
}'
```

`revision` 要写当前值，改过之后从 `GET /orchestrator/api/settings/source:team` 重读，否则返回 `Settings changed`。

## 四、模型

`eval.model` 与 `executor.model` 决定主 Session 与 worker 用哪个模型。**留 `null` 就走宿主默认**，而宿主默认若指向一个不存在的模型，Eval 会永远卡在 `evaluating`（表现为「消息进来了但永不开工单」）。显式写死更稳：

```sh
curl -s -X PUT $H http://127.0.0.1:3082/orchestrator/api/settings/eval -d '{
  "value": {"mode":"observe","timeoutSeconds":180,
            "model":{"provider":"magpie","model":"openconsole/deepseek-v4.1-flash"}},
  "revision": 0
}'
```

**这个坑值得单独记**：模型的 `provider`/`model` 必须能在该 profile 的 `llm-pi-ai.providers` 里找到。写了一个不存在的组合，症状不是报错，而是 Eval 静默卡死。

## 四点半、先自检

```sh
cd ~/Code/dsh-bot-crew && ./scripts/doctor.sh
```

只读检查：两个端口在不在、各组件健康态、`eval`/`executor` 模型钉没钉、手机实际拿到的 Bot 名录对不对。
全对时最后一行是 `crew path looks healthy`，退出码 0。

## 四点七、手机连不上时

APK 在 `~/Desktop/dsh-crew/dsh-crew.apk`。装好后在连接页选 **Local network**，填：

| 字段 | 值 |
| --- | --- |
| Host address | 后端绑的那个地址，`ipconfig getifaddr en0` 可查 |
| Port | `3082` |

也可以直接把启动日志里那行 `http://<ip>:3082/?token=<...>` 整个粘进 Host address——它带 token，
会顺带完成登录。

连接页对几种失败给了具体原因，按提示处理即可：

- **「不在本机网段」**：手机和电脑不在同一个 Wi-Fi。
- **「refused」**：电脑上没有进程在听那个端口，或端口填错。
- **「unexpected end of stream」**：连上了但被挡回来，多半是 `--trusted-host` 没包含你访问的那个地址。

## 五、验证一条真消息

```sh
python3 tools/mobileq inject --conversation main --sender owner \
  --text "在桌面新建 crew-test.txt，写 hello" --mention lead
```

三处应依次出现：

| 位置 | 期望 |
| --- | --- |
| `GET /orchestrator/api/tickets` | 出现一条 open 工单 |
| 桌面 | 真的出现 `crew-test.txt` 且内容对 |
| `mobileq outbox --conversation main` | 两段回复，`bot_id: lead` |

worker 的提示词里还会有 `## Bot you are`、这个 Bot 的人格、以及 `bot/lead` 记忆命名空间。

## 六、手机

```sh
cd app
export JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.9/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug -PcrewToken=$(cat ~/.dsh/state/superagent-web/mobilegw.token)
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

App 连的是队伍自己的 gateway，不是后端面板：

- 模拟器：`http://10.0.2.2:<端口>`（`10.0.2.2` 是模拟器眼里的宿主机）
- 真机：`http://<Mac 局域网 IP>:<端口>`

端口由后端的状态目录推出来，不是固定值：默认目录 `~/.dsh/state/superagent` 是 8788，
其余目录按 `18800 + 路径字符和 % 100` 计算。`dsh-bridge/up.sh` 会直接把算好的值打出来，
别在这里猜。

token 在 `<stateDir>/mobilegw.token`，用 `-PcrewToken=` 传进构建，别写进仓库。

## 七、桌面端

```sh
cd desktop
go run .
```

同样认 `DSH_GW` 与 `DSH_TOKEN` 两个环境变量；不设就连 `http://127.0.0.1:8788`（默认队伍）。

### 全局调试态（`CREW_DEBUG=1`）

mygo 把控件都画成 `AXStaticText`，没有可寻址的 actionable 元素，裸鼠标坐标事件也不稳 ——
对 GUI 自动化来说几乎是黑盒。`CREW_DEBUG=1` 时桌面端换一条路：把左栏/对话/模型/记忆/常规任务
背后那一排 `app` 方法挂成一张**按名字调用**的动作表，并开一条本地 unix socket 供外部直接驱动，
另给一份结构化的 `state.dump` 用来断言「这一下到底改了什么」，不用再点像素。

```sh
CREW_DEBUG=1 ./desktop/build/"Bot Crew.app"/Contents/MacOS/desktop   # 或 go run .
# 控制口落点 $TMPDIR/crew-debug.sock（0600，只本用户）；可用 CREW_DEBUG_SOCK 覆盖
```

一行一个请求，一行一个回答（长连接可连发多条）：

```sh
echo '{"action":"nav.routines","args":{}}' | nc -U "$TMPDIR/crew-debug.sock"
# → {"ok":true,"result":{"ok":true,"nav":"routines","backendOpen":true}}
```

动作表（`actions.list` 可一次列出全部）：`nav.<backend|models|outputs|routines|memory>`、
`nav.selectBot`、`backend.tab`、`sidebar.toggle`、`sidebar.width`、`send`、`withdraw`、`adopt`、
`preview`、`answer`、`steer`、`pauseAll`、`screen.look`、`screen.fullscreen`、`work.open`、
`model.open|scope|switch|reload`、`memory.reload|forget`、`routines.reload`、`refresh`、
`state.dump`、`actions.list`。

- 未知动作、参数缺失或越界一律 `ok:false` + 一句人话 `error`，不静默成功。
- `CREW_DEBUG` 不设时**一个口都不开**，动作表也不建 —— 生产面零暴露。
- 进程内还可直接用 `DebugBus.invoke(name, args)`（`desktop/debug.go`），Go 单测走这条路，无需 socket。

## 八、出门（中转）

上面那些都是同一个 Wi-Fi 下的用法。不在家的时候，让宿主主动连一个中转：

```sh
export CREW_RELAY_URLS="wss://jarvis.kentonnie.top/crew-relay/tunnel"  # 逗号分隔：第一条自建，其余兜底
export CREW_RELAY_SECRET="<中转那边的 RELAY_REGISTER_SECRET>"
# 可选；不设则由状态目录算出来（同一个目录永远是同一个 id）
export CREW_RELAY_INSTANCE="kenton-mac"
```

然后重启 dsh。日志里会出现 `tunnel <id>: live`，中转那边 `GET /health?detail=1` 能看到这台。

手机改用 `https://jarvis.kentonnie.top/crew-relay/i/<instanceId>/api/mobile/...` —— 中转挂在
既有域名的子路径下（`relay.kentonnie.top` 属于 AI-HUB 的另一个中转，不要占用），路径多一段
`/i/<instanceId>`，因为一台中转服务多台宿主机。

中转本身怎么部署见 [`relay/docs/DEPLOY-NAS.md`](../relay/docs/DEPLOY-NAS.md)，
为什么是这几条路见 [`06-relay.md`](06-relay.md)。
