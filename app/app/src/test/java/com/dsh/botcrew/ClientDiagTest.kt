package com.dsh.botcrew

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ClientDiag 的纯逻辑：白名单序列化、route 去 query、脱敏断言、切批边界。
 *
 * 这些是「客户端一开始就不产生敏感字段」的硬约束，必须逐条钉住——服务端会再兜一层，
 * 但客户端不能指望它兜底。
 */
class ClientDiagTest {

    private fun event(route: String, err: String? = null, extra: Map<String, String> = emptyMap()) =
        ClientDiag.Event(
            id = "id1", at = "2026-11-15T21:00:00+08:00", event = "http_error",
            route = route, method = "GET", status = 200, ms = 12, err = err, session = "main", extra = extra,
        )

    @Test
    fun routeOf_stripsQueryAndHash() {
        assertEquals("/api/mobile/timeline", ClientDiag.routeOf("http://1.2.3.4:43499/api/mobile/timeline?token=abc#frag"))
        assertEquals("/api/mobile/timeline", ClientDiag.routeOf("https://crew.kentonnie.top/api/mobile/timeline"))
        assertEquals("/api/mobile/send", ClientDiag.routeOf("/api/mobile/send?session_id=work"))
    }

    @Test
    fun routeOf_rejectsMultiPercentEncoding() {
        // 多重/歧义百分号编码：宁可空（不记），也不上报一条会被服务端拒的。
        assertEquals("", ClientDiag.routeOf("/api/mobile/x%3Ftoken%3D1"))
        assertEquals("", ClientDiag.routeOf("/%253Fx"))
    }

    @Test
    fun toWire_dropsQueryAndKeepsWhitelistOnly() {
        val obj = ClientDiag.toWire(event("/api/mobile/timeline?token=secret"))
        assertNotNull(obj)
        assertEquals("/api/mobile/timeline", obj!!.getString("route"))
        // 白名单外不存在
        assertFalse(obj.has("text"))
        assertFalse(obj.has("body"))
        assertTrue(obj.getString("kind") == "event")
    }

    @Test
    fun toWire_rejectsSensitiveRoute() {
        // 路径里塞 Bearer 之类：整条不产生。
        assertNull(ClientDiag.toWire(event("/api/x/Bearer%20abc")))
        assertNull(ClientDiag.toWire(event("/sk_live_abcdef")))
    }

    @Test
    fun errOf_onlyClassName_noMessage() {
        val e = RuntimeException("token=abc123 boom")
        assertEquals("RuntimeException", ClientDiag.errOf(e))
        // 结果必是短词形态
        assertTrue(ClientDiag.isShortWord(ClientDiag.errOf(e)))
    }

    @Test
    fun errWithSpacesIsDropped() {
        // 带空格标点的 message 形态不合短词，不应进 err 字段。
        val obj = ClientDiag.toWire(event("/api/mobile/timeline", err = "boom: bad token=abc"))
        assertNotNull(obj)
        assertFalse(obj!!.has("err"))
    }

    @Test
    fun extra_whitelistOnly_dropsUnknownAndSensitive() {
        val obj = ClientDiag.toWire(event("/api/mobile/timeline", extra = mapOf(
            "phase" to "connect",
            "routeKind" to "public",
            "host" to "crew.kentonnie.top",       // 不在白名单 → 丢
            "device" to "abc",                      // 不在白名单 → 丢
            "model" to "bearer xyz12345",           // 敏感值 → 丢
        )))
        val extra = obj!!.getJSONObject("extra")
        assertEquals("connect", extra.getString("phase"))
        assertEquals("public", extra.getString("routeKind"))
        assertFalse(extra.has("host"))
        assertFalse(extra.has("device"))
        assertFalse(extra.has("model"))
    }

    @Test
    fun looksSensitive_detectsTokenForms() {
        assertTrue(ClientDiag.looksSensitive("Bearer abcdefgh12"))
        assertTrue(ClientDiag.looksSensitive("x-crew-credential: zzz"))
        assertTrue(ClientDiag.looksSensitive("password=hunter2"))
        assertTrue(ClientDiag.looksSensitive("sk_live_abcd1234"))
        assertFalse(ClientDiag.looksSensitive("/api/mobile/timeline"))
    }

    @Test
    fun sanitizeStack_keepsOnlyFrames() {
        val raw = """
            java.lang.NullPointerException: boom token=abc at http://x?t=1
                at pkg.C.m(File.java:123)
                at pkg.C.n(File.kt:12)
                at pkg.C.o(NativeMethod)
                ... 5 more
            Caused by: java.io.IOException: secret=x
        """.trimIndent()
        val out = ClientDiag.sanitizeStack(raw)
        assertTrue(out.contains("at pkg.C.m(File.java:123)"))
        assertTrue(out.contains("at pkg.C.n(File.kt:12)"))
        assertFalse(out.contains("token=abc"))
        assertFalse(out.contains("secret=x"))
        assertFalse(out.contains("http://x"))
    }

    @Test
    fun planBatches_respectsSizeAndCount() {
        // 造 60 条小记录：每批 ≤50。
        val rows = (1..60).map { i ->
            JSONObject().put("id", "id$i").put("kind", "event").put("event", "http_error")
                .put("route", "/api/mobile/timeline").put("at", "2026-11-15T21:00:00+08:00")
        }
        val plan = ClientDiag.planBatches(rows)
        assertTrue(plan.batches.all { it.size <= ClientDiag.MAX_BATCH })
        assertEquals(60, plan.batches.sumOf { it.size })
    }

    @Test
    fun planBatches_oversizeAsEventDroppedButCrashAllowedUpTo16k() {
        val bigEvent = JSONObject().put("id", "bigE").put("kind", "event")
            .put("x", "y".repeat(2000)) // > 1KiB
        val bigCrash = JSONObject().put("id", "bigC").put("kind", "crash")
            .put("stack", "z".repeat(4000)) // < 16KiB
        val plan = ClientDiag.planBatches(listOf(bigEvent, bigCrash))
        assertTrue(plan.oversizeIds.contains("bigE"))
        assertFalse(plan.oversizeIds.contains("bigC"))
        assertTrue(plan.batches.flatten().any { it.optString("id") == "bigC" })
    }

    @Test
    fun buildBody_hasAppBuildBatch() {
        val row = JSONObject().put("id", "1").put("kind", "event").put("route", "/x").put("at", "t")
        val body = JSONObject(ClientDiag.buildBody(listOf(row)))
        assertEquals("BotCrew", body.getString("app"))
        assertTrue(body.getString("build").contains("("))
        assertEquals(1, body.getJSONArray("batch").length())
    }
}
