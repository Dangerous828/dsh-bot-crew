package com.dsh.botcrew

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 会话 id 与 query 的纯规则（契约 §1 / §2）。
 *
 * 只走 query：默认 main 与显式 main 都逐字走老路径，非 main 才追加。
 * 这段不碰网络，测试钉的是「拼出来的那一条路径」，真请求由
 * [SessionClientRouteTest] 用本地 socket 再验一遍。
 */
class SessionRouteTest {

    @Test
    fun aDefaultOrExplicitMainRequestKeepsTheOldPathVerbatim() {
        assertEquals("/api/mobile/timeline", SessionRoute.path("/api/mobile/timeline", null))
        assertEquals("/api/mobile/timeline", SessionRoute.path("/api/mobile/timeline", ""))
        assertEquals("/api/mobile/timeline", SessionRoute.path("/api/mobile/timeline", SessionRoute.MAIN))
        assertEquals("/api/mobile/send", SessionRoute.path("/api/mobile/send", SessionRoute.MAIN))
    }

    @Test
    fun onlyANonMainSessionAppendsAQueryParameter() {
        assertEquals("/api/mobile/timeline?session_id=work", SessionRoute.path("/api/mobile/timeline", "work"))
        assertEquals("/api/mobile/send?session_id=work-2", SessionRoute.path("/api/mobile/send", "work-2"))
        // 已经有别的 query 时接着拼，不覆盖原来的参数。
        assertEquals(
            "/api/mobile/timeline?ticket=t1&session_id=work",
            SessionRoute.path("/api/mobile/timeline?ticket=t1", "work"),
        )
    }

    @Test
    fun aSessionIdIsEncodedBeforeItEntersThePath() {
        // 形状校验会先挡住这种 id；这里钉的是万一传进来也不会拼出第二个参数。
        assertEquals("/api/mobile/timeline?session_id=a%26b", SessionRoute.path("/api/mobile/timeline", "a&b"))
    }

    @Test
    fun theIdShapeMatchesTheBackendWordForWord() {
        for (id in listOf("a", "main", "work-2", "trail-", "a" + "0".repeat(31))) {
            assertTrue(id, SessionRoute.validId(id))
        }
        for (id in listOf("", "-lead", "Work", "a_b", "a b", "a.b", "a" + "0".repeat(32), "ü")) {
            assertFalse(id, SessionRoute.validId(id))
        }
    }

    @Test
    fun theCreateBodyCarriesOnlyTheId() {
        val parsed = JSONObject(SessionRoute.body("work"))
        assertEquals("work", parsed.getString("id"))
        assertEquals(1, parsed.length())
    }
}

/** sessions 响应与老 timeline 的解析（S1 实际形状 + 老响应兼容）。 */
class SessionWireTest {

    @Test
    fun aGetSessionsResponseCarriesIdsDefaultAndCapability() {
        val view = CrewWire.parseSessions(
            """{"sessions":["main","work","trail-"],"default_session_id":"main","session_api":1}""",
        )
        assertEquals(listOf("main", "work", "trail-"), view.sessions.map { it.id })
        assertEquals("main", view.defaultSessionId)
        assertTrue(view.sessionApi)
        assertEquals("", view.createdId)
        // S1 的 sessions 是 id 数组，没有单独的名字；切换条显示 id 本身。
        assertEquals("work", view.sessions[1].name)
    }

    @Test
    fun aPostSessionsResponseHasNoDefaultFieldAndStillParses() {
        val view = CrewWire.parseSessions("""{"id":"work","sessions":["main","work"],"session_api":1}""")
        assertEquals(listOf("main", "work"), view.sessions.map { it.id })
        assertEquals("work", view.createdId)
        // POST 响应不带 default_session_id：按 main 回落，绝不按 GET 的形状硬读。
        assertEquals("main", view.defaultSessionId)
        assertTrue(view.sessionApi)
    }

    @Test
    fun aResponseWithoutTheCapabilityBitIsNotLive() {
        assertFalse(CrewWire.parseSessions("""{"sessions":["main"]}""").sessionApi)
        assertFalse(CrewWire.parseSessions("""{"sessions":["main"],"session_api":0}""").sessionApi)
        assertFalse(CrewWire.parseSessions("{}").sessionApi)
        // 缺字段一律回落 main，老后端不会读到空串或者 null。
        assertEquals("main", CrewWire.parseSessions("{}").defaultSessionId)
    }

    @Test
    fun objectShapedSessionsAlsoReadTheirNames() {
        val view = CrewWire.parseSessions(
            """{"sessions":[{"id":"main","name":"主会话"},"work"],"default_session_id":"main","session_api":1}""",
        )
        assertEquals(listOf("main", "work"), view.sessions.map { it.id })
        assertEquals("主会话", view.sessions[0].name)
        assertEquals("work", view.sessions[1].name)
    }

    @Test
    fun onlyTheIntegerOneIsTheCapabilityBit() {
        // org.json 的 optInt 会把字符串 "1" 也读成 1；能力位先验不能因此放行老响应。
        assertTrue(CrewWire.parseSessions("""{"sessions":["main"],"session_api":1}""").sessionApi)
        assertFalse(CrewWire.parseSessions("""{"sessions":["main"],"session_api":"1"}""").sessionApi)
        assertFalse(CrewWire.parseSessions("""{"sessions":["main"],"session_api":true}""").sessionApi)
    }

    @Test
    fun brokenSessionRowsAreSkippedInsteadOfInventingAnEntry() {
        val view = CrewWire.parseSessions(
            """{"sessions":["main","","Work",null,{"name":"no-id"}],"session_api":1}""",
        )
        assertEquals(listOf("main"), view.sessions.map { it.id })
    }

    @Test
    fun anOldTimelineWithoutSessionFieldsFallsBackToMain() {
        val conversation = CrewWire.parseTimeline("""{"items":[],"bots":[],"default_bot_id":"lead"}""")
        assertEquals("main", conversation.sessionId)
        assertEquals("main", conversation.name)
    }

    @Test
    fun aTimelineEchoesTheSessionItWasReadFrom() {
        val conversation = CrewWire.parseTimeline(
            """{"items":[],"bots":[],"default_bot_id":"lead","session_id":"work","session_api":1,
                "sessions":["main","work"],"default_session_id":"main","session_name":"工作"}""",
        )
        assertEquals("work", conversation.sessionId)
        assertEquals("工作", conversation.name)
    }
}
