# 后端留在 dsh 进程里，不抽独立服务

backend 现在是一个 dsh bundle 插件：`backend/src/index.ts:9` 的 `inject` 里有 7 个它离不开的服务（agents、sessionController、sessionPersistence、workspaceRegistry、permissionPresets、webServer、llm），全部由 dsh 进程提供。要把它变成独立服务，就得在进程外重做「建 Session、投递 prompt、收事件、取消」这四件事——那等于重新实现一遍 dsh 的会话接口，而不是桥接它。

所以决定：**backend 继续跑在 dsh 进程里**，对外仍然通过 dsh 的 webServer 提供服务；`dsh-bridge/` 只承担配置职责（profile 补丁、worker/router preset、启动脚本），不承担协议职责。

## Consequences

- 想用队伍，必须先有一个跑起来的 dsh 进程。这不是缺陷，是这个系统的形状。
- 桥不能成为独立进程；任何「让 superagent 不依赖 dsh」的需求都要重新走一遍这个 ADR。
