# 手机评审交接：花名册与暂停 / 继续执行

日期：2026-11-12。范围对应 `docs/review/2026-11-12-handoff.md` 的 M1 / M2。

## 已落地行为

- 队伍花名册可以横向滚动，保留头像、姓名、点开名片的入口与配色。成员点击布局最小 48 × 48dp，头像保持 32dp。
- 自定义紧凑按钮补齐 48dp 点击尺寸：页头入口、工作区返回 / 全屏 / 操作、名片、分段切换、后台页签、回答入口、代码卡、播报、模型条目和编辑操作。已有较大尺寸不缩小，保留颜色、圆角与功能。
- 工作区「让它停一下」收到有效暂停回执后，在原位置显示「继续执行」。暂停作用于全局执行器，有工单时暂停请求仍保留 ticket。
- 「继续执行」发送 `POST /api/mobile/resume`，body 为 `{}`。只有 JSON 中 `ok` 为布尔 `true`、`resumed` 为布尔 `true`、`scope` 为字符串 `executor` 时，才显示恢复成功并切回暂停按钮。
- 暂停接口按源码已有的 `{ok:true, scope:'executor'}` 校验，不要求其返回未定义的 `paused` 字段，也不替缺失字段补成功值。
- 失败回执、网络 / HTTP 错误沿用「没做成：…」结果行。失败本身不修改暂停状态，不提前显示恢复。
- 执行器暂停状态由根组件保存，切回队伍再进入工作区仍保留已确认状态。每次成功拉取时间线都按真实 `status.paused` 对齐，即使时间线内容与上次完全相同。动作确认之前发出的在途时间线不覆盖该动作回执；下一趟拉取继续以后端状态为准。
- 暂停时活动点也显示为停住。请求仍走已有 IO / Default 线程，两个工作区动作保留 busy 禁用，并在点击入口同步防重复。

## 本次文件

- `app/app/src/main/java/com/dsh/botcrew/CrewUi.kt`
- `app/app/src/main/java/com/dsh/botcrew/CrewClient.kt`
- `app/app/src/test/java/com/dsh/botcrew/CrewClientPauseTest.kt`
- 本文档。

Lead 所有的 `MainActivity.kt`、`TailcatP2p.kt`、`CrewRoute.kt`、`CrewRouteTest.kt` 未由本任务编辑。保留工作区原有修改，包括 UI 中已有的路由注释。

## 验证结果

使用 JDK 21.0.9、Android SDK `/Users/cpuser/Library/Android/sdk`，在 app 目录执行：

```sh
JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.9/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/Users/cpuser/Library/Android/sdk ./gradlew testDebugUnitTest
```

结果：`BUILD SUCCESSFUL`；XML 汇总 211 tests，0 failures，0 errors，0 skipped。主源码 Kotlin 编译已通过。

新增 6 个客户端测试，通过测试进程内临时 loopback socket 验证真实请求和回执：恢复 POST 路径 / 空对象、恢复缺失与负字段 / 字符串冒充布尔、HTTP 503、暂停现有契约及 ticket、无 ticket 暂停空对象、暂停缺少成功 / scope 的失败路径。测试 fixture 随用例关闭，无持久服务。

限定文件的 `git diff --check` 通过。未执行 clean、assemble、install、adb；未启停应用服务、修改运行态、commit 或 push。

## 待联合验收与范围外记录

- 本轮未安装或运行真机：10 个 Bot 横滚、最末成员名片、布局边界 48dp、暂停 → 继续执行 → 真实执行器恢复，仍待设备端验证；当前结论为源码编译和 JVM 单测通过。
- 恢复路由由后端另一任务提供，本轮没有请求运行中的后端，也没有端到端恢复票据。
- M3 的桌面亮色 Hint 对比度属于其它任务，未修改。
- `CrewWire.kt` 中 `WorkspaceCopy.pauseDone` 仍有去面板恢复的文案和对应测试；该 helper 已无本次 UI 调用。为遵守文件边界，本轮仅记录，工作区使用与手机继续按钮一致的结果文案。
- 模型页的全员 / 各 Bot 分段仍受一行可用宽度约束，大量成员的适配需要另立小票；本次花名册横滚指队伍页花名册。
