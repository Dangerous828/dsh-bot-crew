package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 语音输入的两处纯逻辑：后端的回答怎么读、录音时长怎么说。
 *
 * 钉住一条：**「没听出字」与「没跑起来」不能混**。
 * 混在一起时，人只会看到输入框里什么也没多，以为自己的话被吞了。
 */
class VoiceWireTest {

    @Test
    fun `reads a transcript the backend recognised`() {
        val result = VoiceWire.parse("""{"available": true, "text": "把卡顿修掉", "provider": "sensevoice", "language": "zh"}""")
        assertTrue(result.available)
        assertEquals("把卡顿修掉", result.text)
    }

    @Test
    fun `keeps the backend's reason when it could not run`() {
        val result = VoiceWire.parse("""{"available": false, "reason": "这台后端没有可用的语音识别"}""")
        assertFalse(result.available)
        assertEquals("这台后端没有可用的语音识别", result.reason)
    }

    @Test
    fun `an empty transcript is not a success`() {
        // 把空串当成功塞进输入框，用户会以为自己的话被吞了。
        val result = VoiceWire.parse("""{"available": true, "text": "   "}""")
        assertFalse(result.available)
        assertEquals("没听出字来", result.reason)
    }

    @Test
    fun `a body that is not JSON says so instead of crashing`() {
        assertFalse(VoiceWire.parse("<html>502</html>").available)
        assertFalse(VoiceWire.parse("").available)
    }

    @Test
    fun `duration rounds to the nearest second and stays silent for nothing`() {
        assertEquals("", VoiceCopy.duration(0))
        assertEquals("", VoiceCopy.duration(-1))
        assertEquals("1 秒", VoiceCopy.duration(600))
        assertEquals("12 秒", VoiceCopy.duration(12_400))
    }

    @Test
    fun `a tap shorter than half a second is treated as a mis-tap`() {
        assertTrue(VoiceCopy.tooShort(0))
        assertTrue(VoiceCopy.tooShort(499))
        assertFalse(VoiceCopy.tooShort(500))
        assertFalse(VoiceCopy.tooShort(5_000))
    }
}
