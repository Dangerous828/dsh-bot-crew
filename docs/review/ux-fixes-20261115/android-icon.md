# Android Launcher 图标

- 图形：三位成员头像与三点对话气泡；按 adaptive safe zone 构图，适配 launcher 的 24dp 缩放尺寸。
- 配色：品牌绿 `#3E6B62`（与 `CrewUi.kt` 的浅色主题 accent 一致）和暖白 `#FBF9F6`。
- API 26+ 使用 adaptive icon；API 33+ 提供单色图层。基础 mipmap XML 提供 legacy 方形及圆形资源。Manifest 同时指定 `icon` 与 `roundIcon`。
- 语音清理：全量调用检索显示 `RECORD_AUDIO` 只供 `VoiceButton`；`.files` 的 `FileProvider` 只供 `SpeakButton` 播放 cache WAV，`file_paths.xml` 也只暴露 cache。对应 Manifest 权限与 Provider 已移除，专用路径 XML 已删除；Kotlin 语音路径由 `luna-app` 同步移除。
- 静态检查：解析 `app/src/main` 下 12 个 XML 文件，图标本地资源引用均通过。未运行 Gradle 或手机安装；APK 构建与 launcher 实机验收由 `luna-app` 统一执行。
