# 05 · 跑起来

## 一、后端

```sh
cd ~/Code/dsh-superagent
./node_modules/.bin/tsdown                 # 构建到 lib/
python3 scripts/dsh-superagent start       # 起在 127.0.0.1:3082
python3 scripts/dsh-superagent status      # 看健康
```

健康项里应出现 `"team": "ready"`。

## 二、网关

手机不直连 3082，走 `/api/mobile/*` → `mobilegw`（8788）→ `mobileq` 队列：

```sh
cd ~/Code/dsh-superagent
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
cd ~/Code/dsh-mobile-app
export JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.9/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

装好后在 App 里连到 `http://<Mac 局域网 IP>:3082`，用后端启动日志里的 `?token=` 登录。

界面上：输入框上方一排 Bot 芯片，点一下就是 @ 它（再点取消，回到大哥）；对方回话左上方会署名谁说的。

## 七、一处必须知道的互斥

`team` 与 `mobile` 两个 Source 读的是**同一条队列**。同时开会让每条消息被处理两次、回两遍。所以 `cordis.patch.yml` 里 mobile 是 `disabled: true`，只留 team。手机端的 `/api/mobile/*` 不受影响——它走的是网关，与 Source 开关无关。
