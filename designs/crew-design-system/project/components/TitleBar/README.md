# TitleBar

标题栏要一次给出「谁 + 干什么 + 现在什么状态」，不重复身份。

恢复设计稿 `designs/personal-agent/project/Desktop-dark.dc.html:101-104` 的口径：主标题「名字 · 职能」，副标题「实时状态 · 时长」。现状 `desktop/ui.go:1310-1321` 的 `subtitle()` 返回「和 X 说话」，是零信息的身份重复；`ui.go:1977-1979` 的注释自己就写过「头像本身已经说明了是谁」。

**静态参考**：实现是 Go (mygo) 原生绘制，本卡片不挂载 bundle，只用 `tokens.css` 变量判断视觉效果。对应 GitHub [#7 偏离 1 / C1](https://github.com/Dangerous828/dsh-bot-crew/issues/7)。

调用方提供：`name`、`role`、`state`、`elapsed`。状态取值与 `statusLine()`（`ui.go:2515-2527`）共用，不要另造一份口径 —— 「都在待命，发出去就会接上」这句该留，它回答的是「我现在发消息会怎样」。
