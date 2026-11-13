package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 会话状态机：能力位先验三态、锁 main、缓存隔离、本地 id 校验（契约 §2 / §3 / §4）。
 *
 * 这一层是纯 Kotlin、不碰 Compose 与网络，所以「先验没回来前不发非 main 请求」
 * 「切回 A 不显示 B 的消息」这两条防线能在 JVM 单测里直接钉死。
 */
class SessionFlowTest {

    private fun message(id: String, text: String, requestId: String = "") =
        Message(id, false, null, text, "2026-11-13T10:00:00Z", requestId)

    private fun conversation(
        label: String,
        unread: Int? = 0,
        unreadReplies: Int? = 0,
    ) = Conversation(
        messages = listOf(message("m-$label", "只属于 $label 的一句话", "q-$label")),
        bots = emptyList(),
        defaultBotId = "lead",
        tickets = listOf(WorkTicket("t-$label", "票-$label", "work", "lin", "")),
        queued = listOf("q-$label"),
        declined = listOf(Declined("q-$label", "理由-$label")),
        unread = unread,
        unreadReplies = unreadReplies,
        sessionId = label,
        name = label,
    )

    private val listed = SessionsView(
        sessions = listOf(SessionInfo("main"), SessionInfo("work")),
        defaultSessionId = "main",
        sessionApi = true,
    )

    private fun live(current: String = "main"): SessionState =
        SessionFlow.accept(SessionState(current = current), listed)

    // ── 能力位先验三态 ──────────────────────────────────────────────────────

    @Test
    fun aLiveCapabilityEnablesSwitchingWithoutANote() {
        val state = live()
        assertEquals(SessionCapability.LIVE, state.capability)
        assertTrue(state.switchable)
        assertEquals("", state.note)
        assertEquals("main", state.requestSession)
    }

    @Test
    fun aResponseMissingTheCapabilityBitLocksToMainAndSaysSo() {
        val state = SessionFlow.accept(
            SessionState(current = "work"),
            SessionsView(listOf(SessionInfo("main")), "main", sessionApi = false),
        )
        assertEquals(SessionCapability.UNSUPPORTED, state.capability)
        assertFalse(state.switchable)
        assertEquals("main", state.current)
        assertEquals(SessionCopy.OLD_BACKEND, state.note)
        // 锁 main 时一个非 main 请求都不发：requestSession 是 null，路径逐字走老的那条。
        assertNull(state.requestSession)
    }

    @Test
    fun anUnreadableListLocksToMainAndSaysItCouldNotRead() {
        val state = SessionFlow.unreadable(SessionState(current = "work"))
        assertEquals(SessionCapability.UNREADABLE, state.capability)
        assertFalse(state.switchable)
        assertEquals("main", state.current)
        assertEquals(SessionCopy.UNREADABLE, state.note)
        assertNull(state.requestSession)
    }

    @Test
    fun beforeTheProbeReturnsNothingIsSwitchableAndNothingNonMainIsSent() {
        val state = SessionState(current = "work")
        assertEquals(SessionCapability.PENDING, state.capability)
        assertFalse(state.switchable)
        assertNull(state.requestSession)
        assertNull(state.shown)
    }

    @Test
    fun capabilityIsCheckedOnEverySessionsResponseNotOnlyOnTheFirst() {
        val state = SessionFlow.accept(live("work"), listed.copy(sessionApi = false))
        assertEquals(SessionCapability.UNSUPPORTED, state.capability)
        assertEquals("main", state.current)
    }

    // ── 老后端锁 main ──────────────────────────────────────────────────────

    @Test
    fun aLockedBackendRefusesEverySwitch() {
        for (locked in listOf(
            SessionFlow.unsupported(SessionState(current = "work")),
            SessionFlow.unreadable(SessionState(current = "work")),
        )) {
            assertEquals(locked, SessionFlow.switch(locked, "work"))
            assertEquals("main", SessionFlow.switch(locked, "main").current)
        }
        // 先验还没回来时连切回 main 都不动：那时要等名单回来统一裁决（可能回落 default）。
        val pending = SessionState(current = "work")
        assertEquals(pending, SessionFlow.switch(pending, "work"))
        assertEquals(pending, SessionFlow.switch(pending, "main"))
        // 名单里根本没有的 id 也切不过去，即便后端声称支持会话。
        assertEquals("main", SessionFlow.switch(live(), "ghost").current)
    }

    @Test
    fun aLockedBackendKeepsOnlyTheSingleMainConversation() {
        var state = live("work")
        state = SessionFlow.withConversation(state, "main", conversation("main"))
        state = SessionFlow.withConversation(state, "work", conversation("work"))
        val locked = SessionFlow.unsupported(state)
        assertEquals(setOf("main"), locked.conversations.keys)
        assertEquals("只属于 main 的一句话", locked.shown?.messages?.single()?.text)
    }

    // ── 缓存隔离 ──────────────────────────────────────────────────────────

    @Test
    fun switchingSessionsKeepsOneTimelineCachePerSession() {
        var state = live()
        state = SessionFlow.withConversation(state, "main", conversation("main"))
        state = SessionFlow.withConversation(state, "work", conversation("work"))
        assertEquals(2, state.conversations.size)
        state = SessionFlow.switch(state, "work")
        assertEquals("work", state.current)
        assertEquals("只属于 work 的一句话", state.shown?.messages?.single()?.text)
        // 切回 A：A 的六个字段全在，B 的一条都不在。
        state = SessionFlow.switch(state, "main")
        val shown = checkNotNull(state.shown)
        assertEquals("只属于 main 的一句话", shown.messages.single().text)
        assertEquals(listOf("q-main"), shown.queued)
        assertEquals(listOf(Declined("q-main", "理由-main")), shown.declined)
        assertEquals(0, shown.unread)
        assertEquals(0, shown.unreadReplies)
        assertEquals("t-main", shown.tickets.single().id)
        assertFalse(shown.messages.any { "work" in it.text })
        assertNotEquals(state.conversations["work"], state.conversations["main"])
    }

    @Test
    fun aSessionWithoutACacheShowsNothingInsteadOfThePreviousSession() {
        var state = live()
        state = SessionFlow.withConversation(state, "main", conversation("main", unread = 3, unreadReplies = 2))
        state = SessionFlow.withConversation(state, "work", conversation("work"))
        val switched = SessionFlow.switch(state, "backlog")
        // 名单里没有 backlog 时切不过去；用名单内的 work 切一次，再把它从缓存里拿掉。
        assertEquals(state, switched)
        val work = SessionFlow.switch(state, "work")
        val emptied = work.copy(conversations = work.conversations - "work")
        assertNull(emptied.shown)
    }

    @Test
    fun aLateAnswerFromThePreviousSessionIsWrittenToItsOwnCache() {
        var state = live()
        val arrived = state.requestSession
        state = SessionFlow.withConversation(state, checkNotNull(arrived), conversation("main"))
        state = SessionFlow.switch(state, "work")
        // 旧会话的在途刷新回来：按发起时的会话 id 入账，绝不写进当前显示的那一格。
        state = SessionFlow.withConversation(state, "main", conversation("main", unread = 7))
        assertNull(state.shown)
        assertEquals(7, state.conversations["main"]?.unread)
    }

    // ── 新建：本地校验、成功、失败 ────────────────────────────────────────

    @Test
    fun illegalIdsAreRejectedLocallyWithoutAddingAnEntry() {
        val state = live()
        for (id in listOf("", "Work", "a_b", "a b", "-lead", "a" + "0".repeat(32))) {
            val check = SessionFlow.create(state, id)
            assertFalse(id, check.accepted)
            assertEquals(SessionCopy.INVALID_ID, check.state.error)
            assertEquals(state.sessions, check.state.sessions)
            assertEquals(state.current, check.state.current)
        }
        // 合法形状才放行（trail- 与 32 位上限都在 S1 的正则里）。
        assertTrue(SessionFlow.create(state, "trail-").accepted)
        assertTrue(SessionFlow.create(state, "a" + "0".repeat(31)).accepted)
    }

    @Test
    fun aSuccessfulCreateRefreshesTheListAndSwitchesToTheNewSession() {
        val state = live()
        val created = SessionsView(
            sessions = listOf(SessionInfo("main"), SessionInfo("work")),
            defaultSessionId = "main",
            sessionApi = true,
            createdId = "work",
        )
        val next = SessionFlow.applyCreated(state, created, "work")
        assertEquals("work", next.current)
        assertEquals(listOf("main", "work"), next.sessions.map { it.id })
        assertEquals("", next.error)
        assertEquals("work", next.requestSession)
        assertEquals(SessionCapability.LIVE, next.capability)
    }

    @Test
    fun aCreateResponseWithoutTheNewIdIsAnHonestErrorNotASilentSwitch() {
        val state = live()
        val view = SessionsView(listOf(SessionInfo("main")), "main", sessionApi = true, createdId = "work")
        val next = SessionFlow.applyCreated(state, view, "work")
        assertEquals("main", next.current)
        assertTrue(next.error, next.error.contains("work"))
        assertEquals(state.sessions, next.sessions)
        assertEquals(SessionCapability.LIVE, next.capability)
    }

    @Test
    fun aPostResponseWithoutDefaultDoesNotOverwriteTheDefaultReadFromGet() {
        val state = SessionFlow.accept(SessionState(), listed.copy(defaultSessionId = "desk"))
        val view = SessionsView(
            listOf(SessionInfo("main"), SessionInfo("work")), SessionRoute.MAIN, true, createdId = "work",
        )
        val next = SessionFlow.applyCreated(state, view, "work")
        assertEquals("work", next.current)
        // POST 没有 default_session_id，解析回落 main；不能拿它盖掉 GET 读到的真源。
        assertEquals("desk", next.defaultSessionId)
    }

    @Test
    fun aFailedCreateShowsTheErrorAndAddsNoLocalEntry() {
        val state = live()
        val failed = SessionFlow.createFailed(state, """队伍返回 409：{"error":"unsupported_session"}""")
        assertEquals(listOf("main", "work"), failed.sessions.map { it.id })
        assertEquals("main", failed.current)
        assertTrue(failed.error.contains("409"))
        assertEquals("", state.error)
    }

    @Test
    fun aRestoredSessionMissingFromTheListFallsBackToTheDefault() {
        val state = SessionFlow.accept(SessionState(current = "gone"), listed)
        assertEquals("main", state.current)
        assertEquals("main", state.defaultSessionId)
    }

    @Test
    fun aLiveListWithoutMainStillListsMainFirst() {
        val view = SessionsView(listOf(SessionInfo("work")), "main", sessionApi = true)
        val state = SessionFlow.accept(SessionState(), view)
        assertEquals("main", state.sessions.first().id)
        assertEquals("main", state.current)
    }
}
