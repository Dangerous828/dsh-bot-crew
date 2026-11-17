package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * DiagAck：ACK 判定必须窄——只有 2xx + JSON + ok===true + acceptedIds/rejectedIds 命中才算。
 * 只看 2xx、302 跟随后 SPA 200、body 非 JSON，一律不得当成功。退避有界。
 */
class DiagAckTest {

    private val sent = setOf("a", "b")

    @Test
    fun goodAck_parsesAcceptedAndRejected() {
        val body = """{"ok":true,"acceptedIds":["a"],"rejectedIds":["b"],"reasonCodes":["row_too_large"]}"""
        val r = DiagAck.parse(200, "application/json", body, sent)
        assertEquals(setOf("a"), r.ackedIds)
        assertEquals(setOf("b"), r.rejectedIds)
        assertFalse(r.nothingAcked)
        assertFalse(r.shouldBackoff)
    }

    @Test
    fun acceptedIdsNotInSent_ignored() {
        val body = """{"ok":true,"acceptedIds":["zzz"]}"""
        val r = DiagAck.parse(200, "application/json", body, sent)
        assertTrue(r.ackedIds.isEmpty())
        assertTrue(r.nothingAcked) // 交集的空 = 没有有效 ACK
    }

    @Test
    fun http200ButHtmlContentType_notAcked() {
        // 302 跟随后的 SPA 200：content-type text/html。
        val r = DiagAck.parse(200, "text/html", "<html>ok</html>", sent)
        assertTrue(r.nothingAcked)
        assertTrue(r.ackedIds.isEmpty())
    }

    @Test
    fun http200ButOkNotBooleanTrue_notAcked() {
        val r = DiagAck.parse(200, "application/json", """{"ok":"true","acceptedIds":["a"]}""", sent)
        assertTrue(r.nothingAcked) // 字符串 "true" 不算
    }

    @Test
    fun http200MalformedJson_notAcked() {
        val r = DiagAck.parse(200, "application/json", "not json", sent)
        assertTrue(r.nothingAcked)
    }

    @Test
    fun http500_shouldBackoff_nothingAcked() {
        val r = DiagAck.parse(500, "application/json", "{}", sent)
        assertTrue(r.nothingAcked)
        assertTrue(r.shouldBackoff)
    }

    @Test
    fun http429_readsBodyRetryAfter() {
        val r = DiagAck.parse(429, "application/json", """{"retryAfter":7}""", sent)
        assertTrue(r.shouldBackoff)
        assertEquals(7, r.retryAfterSeconds)
    }

    @Test
    fun http401_notBackoffJustNothing() {
        val r = DiagAck.parse(401, "application/json", """{"error":"Not paired"}""", sent)
        assertTrue(r.nothingAcked)
        assertFalse(r.shouldBackoff)
    }

    @Test
    fun backoffSequence_bounded() {
        assertEquals(1, DiagAck.backoffSeconds(0))
        assertEquals(2, DiagAck.backoffSeconds(1))
        assertEquals(4, DiagAck.backoffSeconds(2))
        assertEquals(8, DiagAck.backoffSeconds(3))
        assertEquals(16, DiagAck.backoffSeconds(4))
        assertEquals(32, DiagAck.backoffSeconds(5))
        assertEquals(60, DiagAck.backoffSeconds(6))
        assertEquals(60, DiagAck.backoffSeconds(10)) // 封顶
    }

    @Test
    fun backoffRespectsServerRetryAfterWhenLarger() {
        assertEquals(30, DiagAck.backoffSeconds(0, retryAfterSeconds = 30))
        // 服务端给的更小：用自己的下限
        assertEquals(8, DiagAck.backoffSeconds(3, retryAfterSeconds = 2))
    }
}
