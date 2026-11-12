# Conversation

Bot 发言是「头像 + 无气泡正文」，自己发的话靠右、右下 4px 尖角。这两条沿用 `designs/personal-agent/README.md` 的画板口径，不动。

改动只在颜色与字号：正文 `message 14px` / `ink`，时间与署名 `secondary 12px` / `tertiary`。旧实现的时间戳走 `FontHairline 10.5` + `Hint`（2.41:1），既小又淡，是「灰、糊、碎」最集中的一处。

**静态参考**：Go (mygo) 与 Kotlin (Compose) 原生绘制，本卡片不挂载 bundle。

**别改坏的**：真机中栏空、卡片少是「如实不画」——契约要求 `empty` 不画假条目、没有改动就没有「采用」按钮。优化时不要加常驻占位卡片。消息里那些结构化卡片（代码卡、子代理卡、等你决定卡）在 `design-mock.py` 喂同样文字时全都画得出来，真机没出现是数据没触发，不是样式丢了。
