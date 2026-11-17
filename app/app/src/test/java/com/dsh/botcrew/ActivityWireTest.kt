package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 轻量活动协议（`GET /api/mobile/activity`）。
 *
 * 四件事必须钉住：
 * - 字段全可选：老后端缺字段不报错，只是没有那一层；
 * - 能力位三态：只有「路由根本不存在 / 501」才永久关掉，其它都是可恢复；
 * - 轮询节奏：活跃 1 秒、空闲 4 秒、后台与 unsupported 不发；
 * - 文案：活动与收据分开，unknown 单独 label 而不并入「已发送」。
 */
class ActivityWireTest {

    private val live = """
        {"session_id":"main","session_api":1,"state":"live","at":"2026-11-17T07:00:00Z",
         "items":[
           {"request_id":"req-a","request_state":"evaluating",
            "activity":{"kind":"model","since":"2026-11-17T06:59:50Z","at":"2026-11-17T06:59:58Z"}},
           {"request_id":"req-b","request_state":"waiting_for_person","ticket_ref":"tk1",
            "activity":{"kind":"tool","label":"读取文件","since":"2026-11-17T06:59:40Z"}},
           {"request_id":"req-c"}
         ]}
    """.trimIndent()

    @Test
    fun parsesTheLiveSnapshotIncludingTheOptionalLayer() {
        val snapshot = ActivityWire.parse(live)!!
        assertEquals("main", snapshot.sessionId)
        assertTrue(snapshot.live)
        assertEquals("2026-11-17T07:00:00Z", snapshot.at)
        assertEquals(3, snapshot.items.size)
        val a = snapshot.items.first { it.requestId == "req-a" }
        assertEquals("model", a.activity?.kind)
        assertEquals("2026-11-17T06:59:50Z", a.activity?.since)
        val b = snapshot.items.first { it.requestId == "req-b" }
        assertEquals("tk1", b.ticketRef)
        assertEquals("读取文件", b.activity?.label)
        // 没有 activity 的条目照常读出来：收据仍然有。
        assertNull(snapshot.items.first { it.requestId == "req-c" }.activity)
        assertEquals("waiting_for_person", snapshot.items.first { it.requestId == "req-b" }.requestState)
    }

    @Test
    fun aResponseWithoutTheCapabilityBitIsNotAnEmptyActivityList() {
        // 缺 session_api:1 → 不是本协议。当成「一份空活动」会让人以为队伍真的什么都没做。
        assertNull(ActivityWire.parse("""{"session_id":"main","items":[]}"""))
        assertNull(ActivityWire.parse("""{"session_id":"main","session_api":"1","items":[]}"""))
    }

    @Test
    fun onlyAReallyMissingRouteIsUnsupported() {
        // 501：宿主没接活动投影 / 老网关没有 /meta。
        assertTrue(ActivityWire.outcomeOf(501, """{"error":"Activity is unavailable","code":"activity_unsupported"}""")
            is ActivityResult.Unsupported)
        // 老后端根本没注册这条路由：lan-server 兜底 404 且无 code。
        assertTrue(ActivityWire.outcomeOf(404, """{"error":"Not found"}""") is ActivityResult.Unsupported)
        // 带 code 的 404 是合法业务错误：不能因此永久关掉这项能力。
        assertTrue(ActivityWire.outcomeOf(404, """{"error":"no_session","code":"no_session"}""")
            is ActivityResult.Unavailable)
    }

    @Test
    fun recoverableErrorsKeepTheLastKnownFacts() {
        for ((status, body) in listOf(
            409 to """{"error":"unsupported_session"}""",
            502 to """{"error":"Activity is temporarily unavailable","code":"session_mismatch"}""",
            502 to """{"error":"Activity is temporarily unavailable","code":"malformed_meta"}""",
            502 to """{"error":"Activity is temporarily unavailable"}""",
            503 to """{"error":"Mobile transport is not configured"}""",
        )) {
            val result = ActivityWire.outcomeOf(status, body)
            assertTrue("$status $body 应可恢复", result is ActivityResult.Unavailable)
        }
        // 会话非法：请求写错了，也不是「没有这项能力」。
        assertTrue(ActivityWire.outcomeOf(400, """{"error":"invalid_session"}""") is ActivityResult.Unavailable)
    }

    @Test
    fun pollIntervalFollowsActiveForegroundAndCapability() {
        // 有活跃活动：约 1 秒。
        assertEquals(ActivityPoll.ACTIVE_MS, ActivityPoll.intervalMs(ActivityCapability.SUPPORTED, true, true))
        // 没有活跃：降到 4 秒，而不是继续 1 秒打。
        assertEquals(ActivityPoll.IDLE_MS, ActivityPoll.intervalMs(ActivityCapability.SUPPORTED, true, false))
        // 后台：停。
        assertNull(ActivityPoll.intervalMs(ActivityCapability.SUPPORTED, false, true))
        // 后端没这项能力：停（退回旧时间线节奏，不刷错误）。
        assertNull(ActivityPoll.intervalMs(ActivityCapability.UNSUPPORTED, true, true))
        // 还不知道：按前台/活跃算，问过一次就知道。
        assertEquals(ActivityPoll.ACTIVE_MS, ActivityPoll.intervalMs(ActivityCapability.UNKNOWN, true, true))
    }

    @Test
    fun unknownCountsAsActiveButEndedDoesNot() {
        assertTrue(ActivityPoll.isActive(ExecutionActivity("unknown")))
        assertTrue(ActivityPoll.isActive(ExecutionActivity("model")))
        assertFalse(ActivityPoll.isActive(ExecutionActivity("ended")))
        assertFalse(ActivityPoll.isActive(ExecutionActivity("idle")))
        assertFalse(ActivityPoll.isActive(null))
    }

    @Test
    fun theActivityLineNeverMergesIntoTheReceipt() {
        assertEquals("评估中", ActivityCopy.line(ExecutionActivity("evaluating")))
        assertEquals("模型处理中", ActivityCopy.line(ExecutionActivity("model")))
        assertEquals("使用工具 · 读取文件", ActivityCopy.line(ExecutionActivity("tool", label = "读取文件")))
        assertEquals("使用工具", ActivityCopy.line(ExecutionActivity("tool")))
        assertEquals("正在重试模型请求", ActivityCopy.line(ExecutionActivity("retrying")))
        assertEquals("需要你处理", ActivityCopy.line(ExecutionActivity("waiting_for_person")))
        assertEquals("已结束", ActivityCopy.line(ExecutionActivity("ended")))
        // 未知值单独 label，绝不并入「已发送」。
        assertEquals("未知状态", ActivityCopy.line(ExecutionActivity("some-future-kind")))
        assertNull(ActivityCopy.line(null))
    }

    @Test
    fun timelineItemsReadTheOptionalActivityAndReplyKind() {
        val body = """
            {"items":[
              {"id":"m1","role":"user","text":"在吗","request_id":"req-a","request_state":"evaluating",
               "activity":{"kind":"model"}},
              {"id":"m2","role":"agent","text":"收到","reply_kind":"acknowledgement"},
              {"id":"m3","role":"agent","text":"做完了","reply_kind":"reply"},
              {"id":"m4","role":"agent","text":"历史行"}
            ],"bots":[]}
        """.trimIndent()
        val conversation = CrewWire.parseTimeline(body)
        assertEquals("model", conversation.messages[0].activity?.kind)
        // ack 不是最终答复；历史行缺类型也不猜成 reply。
        assertFalse(RequestStateCopy.isFinalReply(conversation.messages[1].replyKind))
        assertTrue(RequestStateCopy.isFinalReply(conversation.messages[2].replyKind))
        assertNull(conversation.messages[3].replyKind)
        assertNull(conversation.messages[3].activity)
    }
}
