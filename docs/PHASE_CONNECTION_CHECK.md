# Android 连接条线实现与验证

2026-11-12。

## 当前实现

- 先创建 LAN / 公网客户端，UI 与普通请求不等待隧道首连。隧道句柄在一次配对期间复用。
- 只有 STARTED 前台状态才执行探测，失败按 1、2、4、8、16、30 秒退避，封顶 30 秒；成功后每 30 秒复查。回到前台重新开始退避，网络恢复后有后续探测机会。
- 成功探测后把已验证的本地代理提到请求入口队首。失败时 LAN / 公网仍保留为请求兜底。
- 配对变更与 Activity 销毁取消旧 Effect；finally 释放该 Effect 创建的端口。创建期间被取消也会收尾，旧协程只释放自己那一份代理，不关闭之后建立的代理。
- timeline 探测只接受 2xx，401、403、重定向与服务错误都不会升级为可用连接；延迟专用的不存在路径可以接受 404。
- 隧道文案只显示连接状态与测得的 RTT，不用延迟阈值推断直连或 DERP。已知的公网 fallback 地址即使填在 base 槽位也按公网显示，空地址不认作已有连接。

代码：`app/app/src/main/java/com/dsh/botcrew/MainActivity.kt`、`TailcatP2p.kt`、`CrewRoute.kt`；相关 `CrewUi.kt` 文案由手机交接小票保留并汇总。

## 自动验证

- `CrewRouteTest` 覆盖入口优先级、去重、空地址、fallback 归类、RTT 文案、退避封顶，以及 timeline / latency 状态码区别。
- JDK21 与本机 Android SDK 的 `./gradlew testDebugUnitTest` 已执行成功。手机入口的其它测试与证据见 `PHASE_PHONE_UX.md`。

## 待真机验收

本轮不安装 APK、不操作 ADB。真实 DERP 首连、切网络后恢复、前后台切换、旋转／重新配对后的原生句柄释放与手机耗电仍待设备端验证。HttpURLConnection 的在途读取受超时约束；协程取消会阻止后续升级与重试，但不声称每个阻塞 IO 都能即时中断。
