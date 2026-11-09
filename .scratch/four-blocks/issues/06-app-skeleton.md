# 06 · app 骨架：Kotlin + Compose 能装能开

**阻塞**：01。

## 要做什么

`app/` 建一个全新的 Android 工程，能编译、能装进模拟器、打开是一个空界面。旧的 `~/Code/dsh-mobile-app` 不参考任何代码（只在需要确认「线上协议怎么长」时看它的解析层）。

## 环境事实

本机有 `emulator-5554`，harness 通过 `10.0.2.2` 可达宿主机。

## 验收

1. `cd app && ./gradlew assembleDebug` 零错误。
2. `adb install` 成功，启动后是一个空界面，不崩。
3. 包名与旧 App 不同（避免与已装的混在一起）。

## 边界

不连后端。不做界面设计。
