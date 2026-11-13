package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 当前会话要落盘、下次启动恢复（契约 §3）。
 *
 * SharedPreferences 在 JVM 单测里跑不了，所以这里仍测读写前后的纯映射：
 * 新键 SESSION 与老装机缺键回落 main 两条路各钉一遍。
 */
class SessionPairingTest {

    private val saved = PairedCrew(
        deviceId = "dev-1",
        token = "tok-1",
        base = "http://192.168.31.127:43499",
        session = "work",
    )

    @Test
    fun theCurrentSessionIsWrittenAndReadBack() {
        val values = PairingRecord.write(saved)
        assertEquals("work", values[PairingRecord.SESSION])
        assertEquals("work", PairingRecord.read(values)?.session)
    }

    @Test
    fun aRecordWithoutTheNewKeyFallsBackToMain() {
        val old = mapOf<String, Any?>(
            PairingRecord.DEVICE to "dev-1",
            PairingRecord.TOKEN to "tok-1",
            PairingRecord.BASE to "http://192.168.31.127:43499",
        )
        assertEquals("main", PairingRecord.read(old)?.session)
        // 老键读法逐字保持：整份 PairedCrew 与旧版构造出来的一模一样。
        assertEquals(PairedCrew("dev-1", "tok-1", "http://192.168.31.127:43499"), PairingRecord.read(old))
    }

    @Test
    fun aBlankOrWrongTypedSessionFallsBackToMain() {
        val base = mapOf<String, Any?>(
            PairingRecord.DEVICE to "dev-1",
            PairingRecord.TOKEN to "tok-1",
            PairingRecord.BASE to "http://192.168.31.127:43499",
        )
        assertEquals("main", PairingRecord.read(base + (PairingRecord.SESSION to ""))?.session)
        assertEquals("main", PairingRecord.read(base + (PairingRecord.SESSION to "  "))?.session)
        assertEquals("main", PairingRecord.read(base + (PairingRecord.SESSION to 42))?.session)
    }

    @Test
    fun aMissingPairingIsStillNotAPairing() {
        assertNull(PairingRecord.read(mapOf(PairingRecord.SESSION to "work")))
    }

    @Test
    fun aFullSaveKeepsTheSessionAlreadyOnDisk() {
        // 重新发现 / 换入口这类整份保存传的是启动那一刻的 PairedCrew（session 可能已过期）。
        // 机制本身保留盘上现值，不靠调用点记得补值。
        val values = PairingRecord.writeForSave(saved.copy(session = "main"), "work")
        assertEquals("work", values[PairingRecord.SESSION])
        assertEquals("work", PairingRecord.read(values)?.session)
        // 新配对（盘上还没有这一格）按 main 写。
        assertEquals("main", PairingRecord.writeForSave(saved, "main")[PairingRecord.SESSION])
    }
}
