package com.dsh.botcrew

/**
 * 侧边栏 / 单行顶栏的纯派生逻辑：没有 Compose、没有网络、没有第二份会话/收件人真源。
 *
 * 只做三件界面要判断、但要能单测的事：
 *  1. 输入区该显示「发给谁」：[recipientLabel]。有被 @ 的已知成员就报他；**没点名时由
 *     后端该会话的 `default_bot_id`（role=default 的那位）决定**，真名从花名册取——
 *     不硬编码「第一位」。花名册/默认值都读不到时如实报「未指定」，不编一个人。
 *  2. 顶栏中间那行怎么写：[topBarTitle]。聊天页只写会话名，任务页写「任务 · 会话名」，
 *     两张页能区分；单行由调用方 ellipsis，这里只给字符串。
 *  3. 侧边栏「导航」里当前页对应哪一项：[selectedNav]。导航选中态与成员选中态是两回事，
 *     这里只回答导航该亮哪一格。
 */
object CrewNavigation {

    /**
     * 输入区可点 label 的收件人文案（已带「发给 」前缀）。
     *
     * @param draft 当前草稿正文。被 @ 的已知成员按 [Recipient.primaryRecipient] 的实算口径取第一位。
     * @param bots 花名册。
     * @param defaultBotId 后端该会话的 `default_bot_id`（全表唯一 role=default）。空串表示后端没给。
     * @return 形如「发给 大哥」「发给 大哥（按队伍默认）」「发给 未指定」。
     *   —— 没点名、但后端给了默认且该默认在花名册里时，报真名并注明「按队伍默认」，
     *      让人知道这句没写 @ 会落到谁手里，而不是看到一个凭空的默认。
     */
    fun recipientLabel(draft: String, bots: List<BotCard>, defaultBotId: String): String {
        // 1) 正文里显式 @ 了已知成员：这就是真正的收件人，最优先、最准确。
        Recipient.primaryRecipient(draft, bots)?.let { return "发给 $it" }
        // 2) 没点名：交给后端默认角色。默认 id 在花名册里才报真名 —— 报名字，不报 id。
        val fallback = bots.firstOrNull { it.id == defaultBotId.trim() && defaultBotId.isNotBlank() }
        if (fallback != null) {
            val name = Recipient.label(fallback)
            if (name.isNotEmpty()) return "发给 $name（按队伍默认）"
        }
        // 3) 读不出默认（后端没给 / 给的 id 不在花名册）：如实说没指定，不编一个人。
        return "发给 未指定"
    }

    /** Drawer 正在打开或关闭时仍消费系统 Back，避免动画期间退到 Activity 外。 */
    fun shouldConsumeDrawerBack(currentOpen: Boolean, targetOpen: Boolean): Boolean = currentOpen || targetOpen

    /** 顶栏中间：当前在哪张页 + 哪个会话。任务页加「任务 · 」前缀以区分所在页。 */
    fun topBarTitle(mode: Mode, sessionLabel: String): String {
        val name = sessionLabel.trim().ifEmpty { SessionRoute.MAIN }
        return if (mode == Mode.Triage) "任务 · $name" else name
    }

    /**
     * 侧边栏成员行副标的显示文案：把后端已知 role 映射成中文，未知 role 原样诚实展示。
     * **只改显示，不动 role 真值/路由**。空串返回空串（调用方据此不画副标）。
     */
    fun roleLabel(role: String): String {
        return when (role.trim()) {
            "" -> ""
            "default" -> "默认接话"
            "member" -> "成员"
            else -> "角色：${role.trim()}"
        }
    }

    /**
     * 导航里该选中哪一格。
     *
     * 侧边栏只有「聊天 / 任务」两项；事务板是聊天页里的一个抽屉，不当导航项，
     * 所以这两种页面都归到「聊天」这一格（打开抽屉时上下文仍在聊天）。
     */
    fun selectedNav(mode: Mode): NavEntry = when (mode) {
        Mode.Chat -> NavEntry.Chat
        Mode.Triage -> NavEntry.Tasks
    }

    /**
     * 侧边栏导航里「通知」这一行的文案：仅有通知时才画，计数是真实 noticeCount，不伪造。
     * @return 有通知时「通知 · N」，无通知时空串（调用方据此不画这一行）。
     */
    fun noticeRowLabel(noticeCount: Int): String = if (noticeCount > 0) "通知 · $noticeCount" else ""

    /**
     * 通知摘要（LazyColumn 首项）在列表里的目标 index。有通知时它恒为首项 0；
     * 无通知返回 -1（不跳）。抽成纯函数便于单测，调用方不用各自猜索引。
     */
    fun noticeItemIndex(hasNotices: Boolean): Int = if (hasNotices) 0 else -1
}

/** 侧边栏「导航」的两项。独立于 [Mode]（后者还有抽屉等界面态），只给选中态用。 */
enum class NavEntry(val label: String) {
    Chat("聊天"),
    Tasks("任务"),
}
