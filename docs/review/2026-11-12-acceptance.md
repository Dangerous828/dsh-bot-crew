# 验收清单（2026-11-12 20:25）

给接手真机验收的人。只写当前需要做什么、判据是什么；已自动跑过的证据列在前面，避免把「测试全绿」当成「能用」。

## 一、已经自动验证过的

| 项 | 命令 | 结果 |
|---|---|---|
| 桌面编译 / 静态检查 | `cd desktop && go build ./... && go vet ./...` | 退出 0 |
| 桌面全量测试 | `go test ./... -count=1` | 全绿，含 `ui_errors_test.go`、`ui_copy_test.go` |
| 提交钩子 | pre-commit | 设计稿一致性、两端一致性、desktop vet + 测试全通过 |
| 后端类型检查 | `./node_modules/.bin/tsc --noEmit` | 退出 0 |
| 后端测试 | `./node_modules/.bin/vitest run --reporter=dot` | 102 文件 / 1729 例通过 |
| 画板检查 | `artifact.mjs check designs/personal-agent` | 由画板补齐那一批跑，结果记在 #7 |

`pnpm build`（tsdown）与 `./scripts/doctor.sh` 的状态见各自小节；`pnpm build` 会重写 `backend/lib/`，运行态宿主加载的是它，跑之前先确认没有别的会话在改同目录。

## 二、运行态自检：当前不绿

`./scripts/doctor.sh`（只读）默认探测与 `DSH_PROFILE=superagent` 均退出 1：

- `orchestrator health no answer`
- `eval` / `executor` model 未钉死（回落到宿主默认值）
- `crew roster` 缺 `DSH_DEVICE_CREDENTIAL`（跳过）

只读复核：`127.0.0.1:3082` 由 Python pid 95979 监听，同端口另一个 node pid 95986 绑在 `192.168.113.134`；`curl -m 3 http://127.0.0.1:3082/health` 超时、0 字节。脚本没有误报，是服务侧没有回 `/orchestrator/api/state`。

这一层归 #5 的 M1 第 0 步。按交接红线，本轮没有重启服务、没有动 launchd、没有 `pkill`。服务侧恢复正常后再重跑 doctor.sh，退出 0 才算这一格打勾。

## 三、需要真机 / 人工的清单

### 桌面（`.app`）

- [ ] 打包 `.app` 双击启动，手点「接手」与「记忆编辑」两个入口；语音两入口与 TCC 麦克风授权按 #5 计划停掉，保持已落代码不动
- [ ] 侧栏拖到 180 / 140 / 100px 三档不破版
- [ ] savebar 双层留白、Split 收缩各量一次
- [ ] 输入框下方小字只有一条（常态 / 错误 / 录音回执按优先级占位）
- [ ] 页头读得出「谁 + 干什么 + 现在什么状态」；界面上不出现「上下文」「宿主」「识别提供方」等实现词，也不出现英文原始错误
- [ ] 右栏四个面板与新增画板逐块对照（`render/` 的对照图可重做）

### 手机（APK）

- [ ] 真机装 APK（本机自述无连接设备，需找一台）
- [ ] Bot 加到 10 个，花名册能横向滚；用「显示布局边界」量点击区 ≥ 48dp
- [ ] 暂停 → 按钮变「继续执行」→ 点了之后执行器真的恢复派单（端到端，不是单测）
- [ ] 远程恢复 4 项联调、运行中 profile 加载新构建

### 判据

- 「能用」只认上述真机动作的记录（文案、截图、日志三选一即可，但要能复核）
- `go test` / `vitest` / `artifact check` 只证明代码写得对，不证明界面点得动
- doctor.sh 退出 0 是服务侧前置条件，不是 UI 验收的替代品

## 四、顺序与红线

1. 先让服务侧 health 回得来（#5 M1 第 0 步），再跑 doctor.sh
2. 再打 `.app` 做桌面人工点检，量三档宽度
3. 最后真机装 APK 走暂停 / 继续 / 花名册
4. 每步留一条证据到对应 issue（#5 定顺序、#6 管验收清单、#7 管 UI 收尾）

红线（照旧）：绝不 `pkill -f dsh`；不动 launchd `com.cpuser.dsh-mobilegw` 与 `com.cpuser.crew-mobile-tunnel`；crew 只在 `superagent` profile 跑；改 `backend/src` 后必须 `tsdown` 构建才能被运行态加载；改完提交后立刻 `git push origin feat/four-blocks`。
