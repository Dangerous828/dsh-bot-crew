package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 单行顶栏 + 侧边栏的纯派生逻辑（[CrewNavigation]）：
 *  - 输入区收件人文案：显式 @ 优先；没点名走**后端默认角色真名**（不硬编码第一位）；读不到如实报「未指定」。
 *  - 顶栏中间标题：聊天页只写会话名，任务页「任务 · 会话名」。
 *  - 导航选中态：聊天 / 任务两格，分拣台归任务。
 */
class DrawerNavigationTest {

    private fun bot(id: String, name: String, role: String = "member") =
        BotCard(id = id, name = name, role = role, persona = "")

    private val lead = bot("lead", "大哥", role = "default")
    private val writer = bot("writer", "写手")
    private val coder = bot("coder", "码农")
    private val bots = listOf(lead, writer, coder)

    // ---- recipientLabel: 显式 @ 优先 ----

    @Test
    fun explicitMentionWins() {
        // 草稿 @写手：收件人就是写手，即便后端默认是大哥。
        assertEquals("发给 写手", CrewNavigation.recipientLabel("@写手 帮我润色", bots, "lead"))
    }

    @Test
    fun explicitMentionByIdAlsoWorks() {
        // @id 形式也算显式收件人（Recipient.primaryRecipient 的实算口径）。
        assertEquals("发给 码农", CrewNavigation.recipientLabel("@coder 跑一下", bots, "lead"))
    }

    // ---- recipientLabel: 没点名 → 后端默认角色真名（不硬编码第一位） ----

    @Test
    fun emptyDraftFallsBackToDefaultRealName() {
        // 空草稿、未点名：报后端 default_bot_id 的真名，注明「按队伍默认」。不报 id、不报第一位。
        assertEquals("发给 大哥（按队伍默认）", CrewNavigation.recipientLabel("", bots, "lead"))
    }

    @Test
    fun defaultIsNotHardcodedFirstWhenFirstIsNotDefault() {
        // 花名册第一位不是 default 角色时，仍按 defaultBotId 报，而不是 bots[0]。
        val reordered = listOf(writer, lead, coder) // 第一位是写手，但 default 是 lead
        assertEquals("发给 大哥（按队伍默认）", CrewNavigation.recipientLabel("", reordered, "lead"))
    }

    @Test
    fun unknownMentionsFallBackToDefault() {
        // @ 了不认识的名字：不算收件人，走默认。
        assertEquals("发给 大哥（按队伍默认）", CrewNavigation.recipientLabel("@路人甲 你好", bots, "lead"))
    }

    // ---- recipientLabel: 读不到默认 → 如实报「未指定」 ----

    @Test
    fun noDefaultIdReportsUnspecified() {
        assertEquals("发给 未指定", CrewNavigation.recipientLabel("", bots, ""))
    }

    @Test
    fun defaultIdNotInRosterReportsUnspecified() {
        // 后端给的 default id 不在花名册里：不编一个人，如实报未指定。
        assertEquals("发给 未指定", CrewNavigation.recipientLabel("", bots, "ghost"))
    }

    // ---- topBarTitle ----

    @Test
    fun chatTitleIsSessionName() {
        assertEquals("main", CrewNavigation.topBarTitle(Mode.Chat, "main"))
    }

    @Test
    fun triageTitlePrefixedToDistinguishPage() {
        assertEquals("任务 · main", CrewNavigation.topBarTitle(Mode.Triage, "main"))
    }

    @Test
    fun blankSessionLabelFallsBackToMain() {
        assertEquals("main", CrewNavigation.topBarTitle(Mode.Chat, "  "))
        assertEquals("任务 · main", CrewNavigation.topBarTitle(Mode.Triage, ""))
    }

    // ---- selectedNav ----

    @Test
    fun chatModeSelectsChatNav() {
        assertEquals(NavEntry.Chat, CrewNavigation.selectedNav(Mode.Chat))
    }

    @Test
    fun triageModeSelectsTasksNavWithShortLabel() {
        assertEquals(NavEntry.Tasks, CrewNavigation.selectedNav(Mode.Triage))
        assertEquals("任务", NavEntry.Tasks.label)
    }

    @Test
    fun drawerBackStaysEnabledAcrossOpenAndCloseTransitions() {
        assertEquals(true, CrewNavigation.shouldConsumeDrawerBack(currentOpen = false, targetOpen = true))
        assertEquals(true, CrewNavigation.shouldConsumeDrawerBack(currentOpen = true, targetOpen = true))
        assertEquals(true, CrewNavigation.shouldConsumeDrawerBack(currentOpen = true, targetOpen = false))
        assertEquals(false, CrewNavigation.shouldConsumeDrawerBack(currentOpen = false, targetOpen = false))
    }

    @Test
    fun aDelayedSendOnlyOwnsItsSessionDraftAndRequestId() {
        val first = SendOwner(sessionKey = "session-a", requestId = "req-1", text = "先发这句")
        val newerDraft = SendOwner(sessionKey = "session-a", requestId = "req-2", text = "后来改的句子")

        assertEquals(false, SendOwnership.shouldClearDraft("session-b", "另一会话的草稿", first))
        assertEquals(false, SendOwnership.shouldClearDraft("session-a", "后来改的句子", first))
        assertEquals(true, SendOwnership.shouldClearDraft("session-a", "先发这句", first))
        assertEquals(
            false,
            SendOwnership.shouldClearPending(mapOf("session-a" to PendingSend("req-2", "后来改的句子")), first),
        )
        assertEquals(
            true,
            SendOwnership.shouldClearPending(mapOf("session-a" to PendingSend("req-1", "先发这句")), first),
        )
        assertEquals("req-2", newerDraft.requestId)
        assertEquals(
            false,
            SendOwnership.shouldClearNote(mapOf("session-b" to SendNote("req-1", "other session")), first),
        )
        assertEquals(
            false,
            SendOwnership.shouldClearNote(mapOf("session-a" to SendNote("req-2", "newer status")), first),
        )
        assertEquals(
            true,
            SendOwnership.shouldClearNote(mapOf("session-a" to SendNote("req-1", "owned status")), first),
        )
    }

    // ---- roleLabel: 已知 role 中文映射，未知原样，空串不画 ----

    @Test
    fun defaultRoleMapsToChinese() {
        assertEquals("默认接话", CrewNavigation.roleLabel("default"))
    }

    @Test
    fun memberRoleMapsToChinese() {
        assertEquals("成员", CrewNavigation.roleLabel("member"))
    }

    @Test
    fun unknownRoleShownHonestly() {
        assertEquals("角色：admin", CrewNavigation.roleLabel("admin"))
    }

    @Test
    fun blankRoleYieldsBlank() {
        assertEquals("", CrewNavigation.roleLabel("  "))
    }

    // ---- noticeRowLabel / noticeItemIndex：通知行仅有通知时画，指数诚实在 0 ----

    @Test
    fun noticeRowHiddenWhenNoNotices() {
        assertEquals("", CrewNavigation.noticeRowLabel(0))
    }

    @Test
    fun noticeRowShowsRealCount() {
        assertEquals("通知 · 3", CrewNavigation.noticeRowLabel(3))
    }

    @Test
    fun noticeItemIndexIsFirstWhenPresent() {
        assertEquals(0, CrewNavigation.noticeItemIndex(true))
    }

    @Test
    fun noticeItemIndexMinusOneWhenAbsent() {
        assertEquals(-1, CrewNavigation.noticeItemIndex(false))
    }
}
