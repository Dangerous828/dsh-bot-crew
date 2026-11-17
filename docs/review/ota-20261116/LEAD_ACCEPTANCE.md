# Android OTA 验收

2026-11-16，Asia/Shanghai。Android 与分发接口分别由真实 OpenConsole DeepSeek 成员实现，lead 收口协议边界、发布命令、弹层交互并集成验收。无 commit/push。

## 当前发布

- 公开版本：0.2.0，versionCode 3，buildId `ota-20261116-r1`。
- 手机入口：<https://crew.kentonnie.top/updates/android/latest.apk>。
- APK：12,852,381 字节；SHA-256 `17c9e3c30c06c9e94f99c031bdf7c1766488cfa2b93463d96dc9b9113e9cb679`。
- 与既有 BotCrew 相同的包名和证书。长期签名目录已固定为私有目录；APK 构建参数强制清空内置设备凭据和 gateway token。
- 分发复用现有 43499 与 HTTPS 隧道；独立后台保持 no-web、PID 12345，主 GUI 保留。

## 实际执行

1. `android-ota-release` 构建、签名、核对包名/版本/证书；不可变 APK 完成后才原子更新 manifest。
2. 从公网 latest 入口实际下载并核对完整 SHA、签名、包名与版本；真实 Range 字节一致。首次 curl 传输在 60 秒时限内收到 11,202,524 字节，随后按不可变 URL 续传完成，最终与发布包相同。详见 `PUBLIC_VERIFICATION.json`。
3. 独立无窗口 Android 35 AVD 从未配对界面进入更新页，实际读取公网清单并下载公开 APK。
4. 受控慢链路中取消下载，强制结束 App 进程后重新进入，磁盘残量恢复为「继续下载」并完成下载、长度/hash/包名/版本/签名校验。详见 `RECOVERY.json` 与 UI 记录。
5. 从 App 打开系统安装来源设置，允许后返回，按钮变为「安装」；进入真实系统更新确认。取消确认后可重试，确认后系统实际安装公开版本 3。安装过程没有用 adb 安装目标版本；adb 只用于隔离模拟器的初始基线和观测。
6. 安装后界面显示当前 0.2.0(3)，已是最新。全屏 Dialog 只暴露当前更新界面的读屏控件，系统返回键关闭更新页。App 私有文件标记在升级及 OTA 缓存清理后均保留。详见 `DATA_PRESERVE.json`。

## 回归与保留

- Android 全量 JVM 601 项通过，其中 OTA 策略 23 项；发布事务测试 8 项；backend 目标相关 63 项通过。类型检查和构建通过。记录为 `UNIT_RESULTS.json`、`ANDROID_TEST.log`、`BACKEND_BUILD.json`。
- 配对文件摘要保持，消息79、回复62、工单28，与发布前 SQLite 一致性备份相同。手机消息接口仍401鉴权，主GUI仍401登录门槛，后台 running/queued=0/0。详见 `FINAL_STATE.json`。
- 备份目录：`/Users/cpuser/.dsh/backups/botcrew-ota-20261116-214634`，0700，含运行包、profile、配对文件及 SQLite 快照。快照以 immutable 只读方式核对，未对快照创建 WAL/SHM。
- 分发区域仅允许 GET/HEAD，规范化 manifest、限定 APK 路径、越根软链、大小、范围请求、断连、旧不可变包均有真实 HTTP 回归。消息 API 的设备凭据门保留。

## 使用与边界

使用及维护命令见 `docs/android-ota.md`。现有手机首次通过网页同签覆盖安装启用，以后在侧栏「工具 → 检查更新」完成下载与系统安装确认；不以 USB 作为发布前提。

本轮没有操作任何实体手机，Redmi 和 Samsung 均未连接或改动；验收设备为本次创建的独立 AVD。首次网页安装以及各厂商的安装来源提示由用户在手机执行，系统安装确认保留。分发复用现有后台，下载时该后台需在线。

默认 Python urllib 在公网被 Cloudflare 返回1010；公网验收采用 curl 与实际 Android 客户端，均正常，未改 Cloudflare 策略。未声明 backend 全量套件通过，目标相关回归以上述记录为准。
