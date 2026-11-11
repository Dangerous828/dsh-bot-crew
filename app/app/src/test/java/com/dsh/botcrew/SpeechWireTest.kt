package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 播报：`POST /api/mobile/speak`。
 *
 * 钉住一条：**念不出来时说的是为什么**。三个原因（没这个声音、没内容可念、
 * 转换失败）的处置完全不同，统一回一句「播报不可用」等于什么也没说。
 */
class SpeechWireTest {

    @Test
    fun `a failure carries the backend's reason`() {
        val result = SpeechWire.parseFailure("""{"available": false, "status": "unavailable", "reason": "这台机器上没有「Tingting」这个声音"}""")
        assertFalse(result.available)
        assertNull(result.wav)
        assertEquals("这台机器上没有「Tingting」这个声音", result.reason)
    }

    @Test
    fun `a body that is not JSON still yields a sentence a person can read`() {
        val result = SpeechWire.parseFailure("<html>502</html>")
        assertFalse(result.available)
        // 不把一段 HTML 原样摔在界面上。
        assertTrue(result.reason.isNotBlank())
        assertFalse(result.reason.contains("<html>"))
    }

    @Test
    fun `done says how long it was`() {
        assertEquals("3 秒", SpeechCopy.done(3.4, false))
        assertEquals("不到 1 秒", SpeechCopy.done(0.4, false))
        assertEquals("", SpeechCopy.done(0.0, false))
    }

    @Test
    fun `done admits it only read part of a long text`() {
        assertEquals("3 秒 · 太长了，只念了前面一段", SpeechCopy.done(3.0, true))
        // 没有长度但有截断时也要说出来。
        assertEquals("太长了，只念了前面一段", SpeechCopy.done(0.0, true))
    }
}
